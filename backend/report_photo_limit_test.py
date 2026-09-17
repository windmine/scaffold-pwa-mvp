"""Isolated Report photo-batch boundaries using real local upload ownership."""

import json
import unittest
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi import HTTPException
from PIL import Image
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app import upload_storage
from app.models import Department, TaskLog, User, WorkForm, WorkFormSubmission
from app.schemas import (
    SupervisorWorkFormSubmissionUpdate,
    TaskLogCreate,
    WorkFormSubmissionCreate,
)
from app.use_cases.supervisor_review import update_supervisor_form_submission
from app.use_cases.task_logs import create_task_log
from app.use_cases.work_forms import create_work_form_submission


class ReportPhotoLimitTests(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory(prefix="report-photo-limit-")
        self.addCleanup(temp.cleanup)
        storage_patch = patch.multiple(
            upload_storage,
            UPLOAD_STORAGE_BACKEND="local",
            UPLOAD_DIR=Path(temp.name),
            UPLOAD_BUCKET="",
            PRODUCTION_LIKE=False,
        )
        storage_patch.start()
        self.addCleanup(storage_patch.stop)
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        self.addCleanup(engine.dispose)
        SQLModel.metadata.create_all(engine)
        self.session = Session(engine)
        self.addCleanup(self.session.close)
        department = Department(name="Isolated photo-limit checks")
        self.session.add(department)
        self.session.flush()
        self.worker = User(
            department_id=department.id,
            email="photo-worker@example.invalid",
            name="Photo Worker",
            password_hash="unused",
            role="worker",
            worker_class="leader",
        )
        self.supervisor = User(
            department_id=department.id,
            email="photo-supervisor@example.invalid",
            name="Photo Supervisor",
            password_hash="unused",
            role="supervisor",
        )
        self.other_worker = User(
            department_id=department.id,
            email="other-photo-worker@example.invalid",
            name="Other Photo Worker",
            password_hash="unused",
            role="worker",
        )
        self.session.add_all([self.worker, self.supervisor, self.other_worker])
        self.session.flush()
        fields = json.dumps([{
            "id": "signature", "label": "Worker signature",
            "type": "signature", "required": True,
        }])
        self.report = WorkForm(
            department_id=department.id,
            name="Photo batch Report",
            fields_json=fields,
            template_purpose="report",
            created_by=self.supervisor.id,
        )
        self.daywork = WorkForm(
            department_id=department.id,
            name="Retained Daywork",
            fields_json=fields,
            template_purpose="daywork",
            created_by=self.supervisor.id,
        )
        self.session.add_all([self.report, self.daywork])
        self.session.commit()
        content = BytesIO()
        Image.new("RGB", (4, 3), (80, 120, 160)).save(content, format="PNG")
        self.raster = content.getvalue()
        self.photos = [self.upload(self.worker) for _ in range(51)]
        self.signature = self.upload(self.worker)
        self.foreign_upload = self.upload(self.other_worker)

    def upload(self, owner):
        info = upload_storage.store_verified_raster(self.raster, uploaded_by=owner.id)
        return f"/uploads/{info.filename}"

    def payload(self, count, *, form=None, client_id="photo-limit-report"):
        return WorkFormSubmissionCreate(
            form_id=(form or self.report).id,
            work_date="2026-09-16",
            expected_definition_version=1,
            answers={"signature": self.signature},
            photo_urls=self.photos[:count],
            photo_metadata=[{
                "url": url, "name": f"Photo {index + 1:02}.png", "type": "image/png",
            } for index, url in enumerate(self.photos[:count])],
            client_submission_id=client_id,
        )

    def assert_rejected_without_insert(self, data, expected_detail):
        previous_ids = list(self.session.exec(select(WorkFormSubmission.id)).all())
        with self.assertRaises(HTTPException) as caught:
            create_work_form_submission(data, self.worker, self.session)
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn(expected_detail, str(caught.exception.detail))
        self.assertEqual(
            list(self.session.exec(select(WorkFormSubmission.id)).all()), previous_ids,
        )

    def test_fifty_photos_preserve_order_metadata_signature_snapshot_and_replay(self):
        self.worker.worker_class = "normal"
        self.session.add(self.worker)
        self.session.commit()
        payload = self.payload(50)
        result = create_work_form_submission(payload, self.worker, self.session)
        stored = self.session.get(WorkFormSubmission, result["id"])
        self.assertEqual(result["submission_purpose"], "report")
        self.assertEqual(result["workflow_status"], "submitted")
        self.assertEqual(result["worker_id"], self.worker.id)
        self.assertEqual(result["photo_urls"], self.photos[:50])
        self.assertEqual(json.loads(stored.photo_urls), self.photos[:50])
        self.assertEqual(len(result["photo_metadata"]), 50)
        self.assertEqual(result["photo_metadata"][-1]["name"], "Photo 50.png")
        self.assertEqual(json.loads(stored.answers_json)["signature"], self.signature)
        self.assertEqual(json.loads(stored.definition_snapshot_json)["fields"][0]["type"], "signature")
        repeated = create_work_form_submission(payload, self.worker, self.session)
        self.assertEqual(repeated["id"], result["id"])
        self.assertEqual(len(self.session.exec(select(WorkFormSubmission)).all()), 1)

    def test_fifty_first_photo_rejected_without_insert(self):
        self.assert_rejected_without_insert(self.payload(51), "up to 50 photos")

    def test_fiftieth_photo_ownership_is_checked(self):
        payload = self.payload(50)
        payload.photo_urls[-1] = self.foreign_upload
        self.assert_rejected_without_insert(payload, "unavailable for the authenticated user")

    def test_signature_ownership_still_checked_after_fifty_photos(self):
        payload = self.payload(50)
        payload.answers["signature"] = self.foreign_upload
        self.assert_rejected_without_insert(payload, "unavailable for the authenticated user")

    def test_daywork_submit_and_supervisor_edit_remain_eight_photos(self):
        payload = self.payload(8, form=self.daywork, client_id="legacy-eight")
        result = create_work_form_submission(payload, self.worker, self.session)
        self.assertEqual(result["submission_purpose"], "daywork")
        self.assertEqual(result["photo_urls"], self.photos[:8])
        ninth = self.payload(9, form=self.daywork, client_id="legacy-nine")
        ninth = WorkFormSubmissionCreate.model_validate({
            **ninth.model_dump(), "purpose": "report", "submission_purpose": "report",
        })
        self.assert_rejected_without_insert(ninth, "Daywork forms can include up to 8 photos")
        with self.assertRaises(HTTPException) as caught:
            update_supervisor_form_submission(
                result["id"],
                SupervisorWorkFormSubmissionUpdate(photo_urls=self.photos[:9], confirmed=True),
                self.supervisor,
                self.session,
            )
        self.assertEqual(caught.exception.status_code, 400)
        self.session.expire_all()
        self.assertEqual(
            json.loads(self.session.get(WorkFormSubmission, result["id"]).photo_urls),
            self.photos[:8],
        )

    def test_task_logs_remain_eight_photos(self):
        data = TaskLogCreate(description="Legacy photo limit", photo_urls=self.photos[:8])
        result = create_task_log(data, self.worker, self.session)
        self.assertEqual(result["photo_urls"], self.photos[:8])
        data.photo_urls = self.photos[:9]
        with self.assertRaises(HTTPException) as caught:
            create_task_log(data, self.worker, self.session)
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("up to 8 photos", caught.exception.detail)
        self.assertEqual(len(self.session.exec(select(TaskLog)).all()), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
