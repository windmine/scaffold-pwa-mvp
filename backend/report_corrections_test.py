"""Disposable Report correction contracts; SMTP is mocked and network blocked."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import report_pdf_email_test as email_fixture
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, create_engine, select
from app import upload_storage
from app.migrations import run_migrations
from app.models import AuditEvent, ReportPdfEmail, Site, User, WorkFormSubmission
from app.schemas import ReportTransitionRequest, SupervisorWorkFormSubmissionUpdate
from app.use_cases import report_pdf_email as delivery
from app.use_cases.common import work_form_submission_response
from app.use_cases.record_trash import purge_expired_deleted_records
from app.use_cases.supervisor_review import update_supervisor_form_submission
from app.use_cases.work_forms import transition_report


class ReportCorrectionsTests(unittest.TestCase):
    setUp = email_fixture.ReportPdfEmailTests.setUp
    settings = email_fixture.ReportPdfEmailTests.settings
    submit = email_fixture.ReportPdfEmailTests.submit
    raster = email_fixture.ReportPdfEmailTests.raster
    row = email_fixture.ReportPdfEmailTests.row

    def edit(self, submitted, *, actor=None, revision=None, **fields):
        return update_supervisor_form_submission(submitted["id"], SupervisorWorkFormSubmissionUpdate(
            confirmed=True, expected_revision=revision or submitted["revision"], **fields),
            actor or self.supervisor, self.session)

    def refused(self, code, callback):
        with self.assertRaises(HTTPException) as caught:
            callback()
        self.assertEqual(caught.exception.status_code, code)
        self.session.rollback()

    def test_correction_keeps_identity_definition_and_unedited_evidence(self):
        photo, signature = self.raster((9, 9), "red"), self.raster((9, 9), "blue")
        submitted = self.submit(answers={"issue": "Original", "signed": signature}, photo_urls=[photo])
        record = self.session.get(WorkFormSubmission, submitted["id"])
        original = (record.worker_id, record.form_id, record.client_submission_id, record.definition_snapshot_json, record.created_at)
        result = self.edit(submitted, work_date="2026-10-22")
        self.assertEqual(result["revision"], 2)
        self.assertEqual(result["work_date"], "2026-10-22")
        self.assertEqual(result["edited_by_supervisor_id"], self.supervisor.id)
        self.assertTrue(result["edited_at"])
        self.assertEqual(result["answers"], submitted["answers"])
        self.assertEqual(result["photo_urls"], submitted["photo_urls"])
        self.assertEqual((record.worker_id, record.form_id, record.client_submission_id, record.definition_snapshot_json, record.created_at), original)
        self.assertEqual(result["status"], "submitted")
        self.assertEqual(self.session.exec(select(AuditEvent).where(AuditEvent.action == "form_submission_update")).one().actor_id,
                         self.supervisor.id)
        self.refused(409, lambda: self.edit(submitted, answers={"issue": "Stale overwrite"}))
        self.assertEqual(self.session.get(WorkFormSubmission, submitted["id"]).revision, 2)
        self.refused(409, lambda: transition_report(submitted["id"], ReportTransitionRequest(status="in_review"), self.supervisor, self.session))
        self.assertEqual(self.submit()["revision"], 2)

    def test_scope_required_date_and_upload_ownership(self):
        submitted = self.submit()
        self.refused(404, lambda: self.edit(submitted, actor=self.foreign, work_date="2026-10-22"))
        self.refused(403, lambda: self.edit(submitted, actor=self.worker, work_date="2026-10-22"))
        self.refused(400, lambda: self.edit(submitted, work_date=None))
        self.refused(400, lambda: self.edit(submitted, work_date="2026-02-30"))
        self.session.add(Site(id=30, department_id=2, name="Foreign", latitude=0, longitude=0))
        self.session.commit()
        self.refused(400, lambda: self.edit(submitted, site_id=30))
        unsubmitted_worker_photo = self.raster((10, 10), "green")
        self.refused(400, lambda: self.edit(submitted, photo_urls=[unsubmitted_worker_photo]))
        self.refused(409, lambda: update_supervisor_form_submission(submitted["id"],
            SupervisorWorkFormSubmissionUpdate(confirmed=True, work_date="2026-10-22"), self.supervisor, self.session))

    def test_photo_replacement_keeps_original_email_bytes_and_does_not_resend(self):
        self.settings()
        original_photo = self.raster((15, 15), "red")
        signature = self.raster((9, 9), "blue")
        submitted = self.submit(answers={"issue": "Original", "signed": signature}, photo_urls=[original_photo])
        frozen = self.row().snapshot_json
        replacement_bytes = email_fixture.BytesIO()
        email_fixture.Image.new("RGB", (11, 11), "green").save(replacement_bytes, format="PNG")
        replacement = "/uploads/" + upload_storage.store_verified_raster(replacement_bytes.getvalue(), self.supervisor.id).filename
        corrected = self.edit(submitted, answers={"issue": "Corrected", "signed": signature},
                              photo_urls=[replacement], work_date="2026-10-23")
        self.assertEqual(corrected["answers"]["signed"], signature)
        self.assertEqual(self.row().snapshot_json, frozen)
        self.assertEqual(len(self.session.exec(select(ReportPdfEmail)).all()), 1)
        self.assertIsNotNone(upload_storage.upload_adapter().stat(original_photo.split("/")[-1]))
        with Session(self.engine) as session:
            item = delivery._snapshot_for_delivery(session.get(ReportPdfEmail, self.row().id), session)
            self.assertEqual(item["answers"]["issue"], "Original")
            self.assertEqual(item["photo_urls"], [original_photo])
            self.assertEqual(item["work_date"], submitted["work_date"])
        self.assertEqual(delivery.dispatch_pending(self.engine)["accepted"], 1)
        self.edit(corrected, answers={"issue": "Corrected again", "signed": signature})
        self.assertEqual(delivery.dispatch_pending(self.engine)["accepted"], 0)
        self.client.send_message.assert_called_once()
        record = self.session.get(WorkFormSubmission, submitted["id"])
        record.deleted_at = datetime.now(timezone.utc) - timedelta(days=31)
        self.session.add(record)
        self.session.commit()
        purge_expired_deleted_records(self.session)
        self.assertIsNone(upload_storage.upload_adapter().stat(original_photo.split("/")[-1]))
        self.assertEqual(self.session.exec(select(ReportPdfEmail)).all(), [])

    def test_simultaneous_corrections_have_one_winner(self):
        submitted = self.submit()
        self.session.close()
        def edit(label):
            with Session(self.engine) as session:
                supervisor = session.get(User, 2)
                try:
                    result = update_supervisor_form_submission(submitted["id"], SupervisorWorkFormSubmissionUpdate(
                        confirmed=True, expected_revision=1, answers={"issue": label}), supervisor, session)
                    return result["revision"]
                except HTTPException as error:
                    return error.status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(edit, ["First", "Second"]))
        self.assertCountEqual(outcomes, [2, 409])

    def test_route_binds_identity_after_department_and_deleted_scope(self):
        from app.main import update_supervisor_form_submission as route
        from starlette.requests import Request
        submitted = self.submit()
        payload = SupervisorWorkFormSubmissionUpdate(confirmed=True, expected_revision=1, work_date="2026-10-22")
        missing = Request({"type": "http", "headers": []})
        self.refused(404, lambda: route(submitted["id"], payload, missing, self.foreign, self.session))
        self.refused(404, lambda: route(987654, payload, missing, self.supervisor, self.session))
        self.refused(409, lambda: route(submitted["id"], payload, missing, self.supervisor, self.session))
        wrong = Request({"type": "http", "headers": [(b"x-report-recovery-worker", b"1"),
            (b"x-report-recovery-department", b"1"), (b"x-report-recovery-role", b"supervisor")]})
        self.refused(409, lambda: route(submitted["id"], payload, wrong, self.supervisor, self.session))
        correct = Request({"type": "http", "headers": [(b"x-report-recovery-worker", b"2"),
            (b"x-report-recovery-department", b"1"), (b"x-report-recovery-role", b"supervisor")]})
        self.assertEqual(route(submitted["id"], payload, correct, self.supervisor, self.session)["revision"], 2)
        record = self.session.get(WorkFormSubmission, submitted["id"])
        record.deleted_at = datetime.now(timezone.utc)
        self.session.add(record)
        self.session.commit()
        self.refused(404, lambda: route(submitted["id"], payload, missing, self.supervisor, self.session))

    def test_historical_workflow_is_preserved_but_not_exposed(self):
        submitted = self.submit()
        record = self.session.get(WorkFormSubmission, submitted["id"])
        record.workflow_status = "resolved"
        record.supervisor_note = "Historical final note"
        record.reviewing_supervisor_id = 2
        record.resolved_at = datetime.now(timezone.utc)
        self.session.add(record)
        self.session.commit()
        result = self.edit(submitted, work_date="2026-10-22")
        self.assertEqual(result["workflow_status"], "submitted")
        self.assertIsNone(result["supervisor_note"])
        self.assertIsNone(result["resolved_at"])
        self.assertEqual(record.workflow_status, "resolved")
        self.assertEqual(record.supervisor_note, "Historical final note")

    def test_missing_or_malformed_original_definition_never_uses_current_template(self):
        submitted = self.submit()
        self.form.fields_json = json.dumps([{"id": "changed", "type": "text", "label": "Changed Template"}])
        self.session.add(self.form)
        self.session.commit()
        record = self.session.get(WorkFormSubmission, submitted["id"])
        original = record.answers_json
        invalid_type = json.dumps({"schema_version": 1, "version": 1,
            "fields": [{"id": "changed", "label": "Invalid", "type": "unsupported"}]})
        duplicate_id = json.dumps({"schema_version": 1, "version": 1,
            "fields": [{"id": "changed", "label": "Duplicate", "type": "text"}] * 2})
        for malformed in (None, "not-json", "[]", "{}", '{"fields":[]}', invalid_type, duplicate_id):
            record.definition_snapshot_json = malformed
            self.session.add(record)
            self.session.commit()
            with self.assertRaises(HTTPException) as caught:
                self.edit(submitted, answers={"changed": ""}, work_date="2026-10-22")
            self.assertEqual(caught.exception.status_code, 409)
            self.assertEqual(caught.exception.detail["code"], "report_definition_unavailable")
            self.session.rollback()
            self.session.refresh(record)
            self.assertEqual(record.answers_json, original)
            self.assertEqual(record.revision, 1)
            self.assertEqual(record.work_date, submitted["work_date"])

    def test_corrupt_same_definition_outbox_cannot_authorize_foreign_photos_or_signatures(self):
        self.settings()
        image = email_fixture.BytesIO()
        email_fixture.Image.new("RGB", (17, 19), "red").save(image, format="PNG")
        foreign = "/uploads/" + upload_storage.store_verified_raster(image.getvalue(), self.foreign.id).filename
        for key in ("photo", "signature"):
            submitted = self.submit(key)
            row = self.session.exec(select(ReportPdfEmail).where(ReportPdfEmail.submission_id == submitted["id"])).one()
            snapshot = json.loads(row.snapshot_json)
            if key == "photo":
                snapshot["photo_urls"] = [foreign]
            else:
                snapshot["answers"]["signed"] = foreign
            # create_all fixtures deliberately omit DB triggers, exercising the
            # independent dispatcher validation after simulated stored corruption.
            row.snapshot_json = json.dumps(snapshot)
            self.session.add(row)
            self.session.commit()
            self.assertEqual(delivery.dispatch_pending(self.engine)["failed"], 1)
        self.client.send_message.assert_not_called()


class ReportCorrectionsMigrationTests(unittest.TestCase):
    def test_upgrade_keeps_history_and_requires_revision_for_content(self):
        with TemporaryDirectory(prefix="report-corrections-migration-") as directory:
            root = Path(directory)
            old = root / "old"
            old.mkdir()
            for migration in (Path(__file__).parent / "migrations/versions").glob("*.py"):
                if migration.stem != "__init__" and migration.stem < "0025":
                    shutil.copy2(migration, old / migration.name)
            engine = create_engine("sqlite:///" + (root / "db.sqlite").as_posix())
            try:
                run_migrations(engine, old)
                with engine.begin() as connection:
                    connection.execute(text("INSERT INTO workform (id, name, fields_json, template_purpose, created_at) VALUES (100, 'Report', '[]', 'report', '2026-10-01')"))
                    connection.execute(text("INSERT INTO workformsubmission (id, form_id, worker_id, answers_json, submission_purpose, created_at) VALUES (100,100,1,'{}','report','2026-10-01')"))
                    connection.execute(text("UPDATE workformsubmission SET workflow_status='resolved', supervisor_note='Historical note' WHERE id=100"))
                    before = connection.execute(text("SELECT version, checksum FROM schema_migrations ORDER BY version")).all()
                self.assertEqual(run_migrations(engine), ["0025_report_corrections", "0026_staff_invitations"])
                self.assertEqual(run_migrations(engine), [])
                with engine.connect() as connection:
                    self.assertEqual(connection.execute(text("SELECT version, checksum FROM schema_migrations WHERE version < '0025' ORDER BY version")).all(), before)
                    self.assertEqual(connection.execute(text("SELECT workflow_status, supervisor_note, revision FROM workformsubmission WHERE id=100")).one(), ("resolved", "Historical note", 1))
                for statement in ("UPDATE workformsubmission SET answers_json='{} ' WHERE id=100",
                                  "UPDATE workformsubmission SET worker_id=2, revision=2, edited_at='2026-10-22', edited_by_supervisor_id=2 WHERE id=100",
                                  "UPDATE workformsubmission SET workflow_status='in_review' WHERE id=100"):
                    with self.assertRaises(IntegrityError):
                        with engine.begin() as connection:
                            connection.execute(text(statement))
                with engine.begin() as connection:
                    connection.execute(text("UPDATE workformsubmission SET work_date='2026-10-22', revision=2, edited_at='2026-10-22', edited_by_supervisor_id=2 WHERE id=100"))
                    connection.execute(text("INSERT INTO workform (id, name, fields_json, template_purpose, created_at) VALUES (101, 'Daywork', '[]', 'daywork', '2026-10-01')"))
                    connection.execute(text("INSERT INTO workformsubmission (id, form_id, worker_id, answers_json, created_at) VALUES (101,101,1,'{}','2026-10-01')"))
                    connection.execute(text("UPDATE workformsubmission SET answers_json='{\"work\":\"Corrected\"}', status='approved' WHERE id=101"))
                with engine.connect() as connection:
                    self.assertEqual(connection.execute(text("SELECT revision, work_date, workflow_status FROM workformsubmission WHERE id=100")).one(), (2, "2026-10-22", "resolved"))
                    self.assertEqual(connection.execute(text("SELECT submission_purpose, status FROM workformsubmission WHERE id=101")).one(), ("daywork", "approved"))
            finally:
                engine.dispose()


if __name__ == "__main__":
    unittest.main()
