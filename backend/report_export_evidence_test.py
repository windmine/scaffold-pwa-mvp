"""Local HTTP regressions: form exports cannot turn answer text into media access."""
import asyncio
import base64
import json
from contextlib import contextmanager
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image
from pypdf import PdfReader
from fastapi import HTTPException

from app import upload_storage
from app.models import Department, User, WorkFormSubmission
from app.schemas import WorkFormSubmissionCreate
from app.use_cases.work_forms import create_work_form_submission
from app.use_cases.supervisor_review import export_form_submission_pdf
from report_export_test import report_fixture, request


def raster(width, height, color):
    buffer = BytesIO()
    Image.new("RGB", (width, height), color).save(buffer, format="PNG")
    return buffer.getvalue()


@contextmanager
def evidence_fixture(purpose):
    configuration = (
        upload_storage.PRODUCTION_LIKE, upload_storage.UPLOAD_STORAGE_BACKEND,
        upload_storage.UPLOAD_BUCKET, upload_storage.UPLOAD_DIR,
    )
    with TemporaryDirectory(prefix="export-evidence-") as directory, report_fixture() as values:
        session, supervisor, worker, form = values
        upload_storage.PRODUCTION_LIKE = False
        upload_storage.UPLOAD_STORAGE_BACKEND = "local"
        upload_storage.UPLOAD_BUCKET = ""
        upload_storage.UPLOAD_DIR = Path(directory)
        try:
            department = Department(name="Foreign evidence Department")
            session.add(department)
            session.flush()
            foreign = User(department_id=department.id, email="foreign-export@example.invalid",
                           name="Foreign", password_hash="unused")
            form.template_purpose = purpose
            session.add_all([foreign, form])
            session.commit()
            info = upload_storage.store_verified_raster(raster(37, 23, "orange"), foreign.id)
            foreign_url = f"/uploads/{info.filename}"
            foreign_content = upload_storage.load_upload(info.filename).content
            yield (*values, foreign_url, foreign_content)
        finally:
            (upload_storage.PRODUCTION_LIKE, upload_storage.UPLOAD_STORAGE_BACKEND,
             upload_storage.UPLOAD_BUCKET, upload_storage.UPLOAD_DIR) = configuration


def export_request(record_id, extension, *, collection=False, purpose="report"):
    path = "/supervisor/form-submissions/"
    path += f"export.{extension}" if collection else f"{record_id}/export.{extension}"
    return asyncio.run(request(path, {"purpose": purpose} if collection else None))


def embedded_dimensions(body):
    dimensions = []
    for page in PdfReader(BytesIO(body)).pages:
        objects = page["/Resources"].get("/XObject")
        for value in objects.get_object().values() if objects else ():
            image = value.get_object()
            if image.get("/Subtype") == "/Image":
                dimensions.append((int(image["/Width"]), int(image["/Height"])))
    return dimensions


def assert_no_foreign_bytes(extension, body, foreign_content):
    if extension == "pdf":
        assert (37, 23) not in embedded_dimensions(body), "Foreign original embedded in PDF"
    else:
        assert base64.b64encode(foreign_content) not in body, "Foreign original embedded in HTML"


def test_missing_or_malformed_snapshot_cannot_embed_foreign_evidence():
    for purpose in ("report", "daywork"):
        with evidence_fixture(purpose) as (session, supervisor, worker, form, foreign_url, _):
            record = WorkFormSubmission(
                department_id=worker.department_id, form_id=form.id, worker_id=worker.id,
                submission_purpose=purpose, work_date="2026-10-12",
                answers_json=json.dumps({"issue": foreign_url}), definition_snapshot_json=None,
            )
            session.add(record)
            session.commit()
            # A later editable Template must never reinterpret a historical text URL as evidence.
            form.fields_json = json.dumps([{"id": "issue", "type": "signature", "label": "Changed signature"}])
            session.add(form)
            session.commit()
            assert upload_storage.open_authorized_upload(foreign_url.rsplit("/", 1)[-1], supervisor, session) is None
            for snapshot in (None, "{", "[]", '{"fields":[null]}'):
                record.definition_snapshot_json = snapshot
                session.add(record)
                session.commit()
                before = (record.answers_json, record.photo_urls, record.definition_snapshot_json)
                for extension in ("html", "pdf"):
                    for collection in (False, True):
                        status, body = export_request(record.id, extension, collection=collection, purpose=purpose)
                        assert status == 409, (purpose, snapshot, extension, collection, status)
                        assert "evidence" in json.loads(body)["detail"].lower()
                        assert foreign_url.encode() not in body
                assert (record.answers_json, record.photo_urls, record.definition_snapshot_json) == before
    print("ok - missing/malformed frozen Definitions refuse unauthorized images in Report/Daywork single/collection HTML/PDF")


def test_ordinary_foreign_url_stays_literal_text():
    for purpose in ("report", "daywork"):
        with evidence_fixture(purpose) as (session, _, worker, form, foreign_url, foreign_content):
            item = create_work_form_submission(WorkFormSubmissionCreate(
                form_id=form.id, work_date="2026-10-12", answers={"issue": foreign_url},
            ), worker, session)
            form.fields_json = json.dumps([{"id": "issue", "type": "signature", "label": "Changed signature"}])
            session.add(form)
            session.commit()
            for extension in ("html", "pdf", "csv"):
                for collection in (False, True):
                    status, body = export_request(item["id"], extension, collection=collection, purpose=purpose)
                    assert status == 200, (purpose, extension, collection, status)
                    assert_no_foreign_bytes(extension, body, foreign_content)
                    text = ("".join(page.extract_text() or "" for page in PdfReader(BytesIO(body)).pages)
                            if extension == "pdf" else body.decode())
                    assert foreign_url in text, (purpose, extension, "ordinary answer changed")
    print("ok - frozen ordinary URL answers remain literal in all exports after a Template edit")


def test_real_typed_evidence_remains_exportable():
    for purpose in ("report", "daywork"):
        with evidence_fixture(purpose) as (session, _, worker, form, _, _):
            form.fields_json = json.dumps([
                {"id": "issue", "type": "text", "label": "Notes"},
                {"id": "signature", "type": "signature", "label": "Worker signature"},
                {"id": "rows", "type": "repeat", "label": "Team"},
                {"id": "nested_signature", "type": "signature", "repeat": "rows", "label": "Team signature"},
            ])
            session.add(form)
            session.commit()
            uploads = [upload_storage.store_verified_raster(raster(w, h, color), worker.id)
                       for w, h, color in ((41, 29, "blue"), (53, 17, "black"), (31, 19, "green"))]
            urls = [f"/uploads/{info.filename}" for info in uploads]
            item = create_work_form_submission(WorkFormSubmissionCreate(
                form_id=form.id, work_date="2026-10-12", photo_urls=[urls[0]],
                answers={"issue": "Genuine saved evidence", "signature": urls[1], "rows": [{"nested_signature": urls[2]}]},
            ), worker, session)
            # Historical evidence remains scoped to its record when the Template is changed.
            form.fields_json = "[]"
            session.add(form)
            session.commit()
            for extension in ("html", "pdf"):
                for collection in (False, True):
                    status, body = export_request(item["id"], extension, collection=collection, purpose=purpose)
                    assert status == 200, (purpose, extension, collection, status)
                    if extension == "pdf":
                        dimensions = embedded_dimensions(body)
                        assert (41, 29) in dimensions and (53, 17) in dimensions, dimensions
                        if purpose == "report":
                            assert (31, 19) in dimensions, dimensions
                    else:
                        for info in uploads[:2]:
                            original = upload_storage.load_upload(info.filename).content
                            assert base64.b64encode(original) in body
    print("ok - genuine saved photos/direct/repeating signatures remain accessible through scoped exports")


def test_untyped_daywork_signature_name_cannot_grant_pdf_access():
    with evidence_fixture("daywork") as (session, _, worker, form, foreign_url, foreign_content):
        form.fields_json = "[]"
        session.add(form)
        record = WorkFormSubmission(
            department_id=worker.department_id, form_id=form.id, worker_id=worker.id,
            submission_purpose="daywork", work_date="2026-10-12",
            answers_json=json.dumps({"old_signature": foreign_url}), definition_snapshot_json=None,
        )
        session.add(record)
        session.commit()
        for collection in (False, True):
            status, body = export_request(record.id, "pdf", collection=collection, purpose="daywork")
            assert status == 409, (collection, status)
            status, body = export_request(record.id, "html", collection=collection, purpose="daywork")
            assert status == 200 and foreign_url.encode() in body
            assert_no_foreign_bytes("html", body, foreign_content)
    print("ok - legacy Daywork signature-name heuristic cannot bypass frozen evidence authority")


def test_inline_saved_evidence_and_missing_upload_placeholders():
    inline = "data:image/png;base64," + base64.b64encode(raster(43, 31, "purple")).decode()
    for purpose in ("report", "daywork"):
        with evidence_fixture(purpose) as (session, _, worker, form, _, _):
            fields = [{"id": "signature", "label": "Saved signature", "type": "signature"}]
            record = WorkFormSubmission(
                department_id=worker.department_id, form_id=form.id, worker_id=worker.id,
                submission_purpose=purpose, work_date="2026-10-12",
                answers_json=json.dumps({"signature": inline}),
                photo_urls=json.dumps(["/uploads/no-longer-available.png"]),
                definition_snapshot_json=json.dumps({"fields": fields}),
            )
            session.add(record)
            session.commit()
            for extension in ("html", "pdf"):
                for collection in (False, True):
                    status, body = export_request(record.id, extension, collection=collection, purpose=purpose)
                    assert status == 200, (purpose, extension, collection, status)
                    if extension == "pdf":
                        assert (43, 31) in embedded_dimensions(body)
                        text = "".join(page.extract_text() or "" for page in PdfReader(BytesIO(body)).pages)
                        assert "unavailable" in text.lower(), text
                    else:
                        assert inline.encode() in body
    print("ok - exact frozen inline raster signatures survive and missing stored objects keep unavailable placeholders")


def test_owner_and_global_privileges_do_not_relabel_answers_as_evidence():
    with evidence_fixture("report") as (session, supervisor, worker, form, foreign_url, _):
        fields = [{"id": "issue", "label": "Changed signature", "type": "signature"}]
        form.fields_json = json.dumps(fields)
        session.add(form)
        record = WorkFormSubmission(
            department_id=worker.department_id, form_id=form.id, worker_id=worker.id,
            submission_purpose="report", work_date="2026-10-12",
            answers_json=json.dumps({"issue": foreign_url}), definition_snapshot_json=None,
        )
        session.add(record)
        session.commit()
        supervisor.is_global_admin = True
        session.add(supervisor)
        session.commit()
        assert upload_storage.open_authorized_upload(foreign_url.rsplit("/", 1)[-1], supervisor, session) is not None
        for collection in (False, True):
            for extension in ("html", "pdf"):
                status, _ = export_request(record.id, extension, collection=collection)
                assert status == 409, (extension, collection, status)
        owned = upload_storage.store_verified_raster(raster(61, 13, "navy"), supervisor.id)
        record.answers_json = json.dumps({"issue": f"/uploads/{owned.filename}"})
        supervisor.is_global_admin = False
        session.add_all([record, supervisor])
        session.commit()
        assert upload_storage.open_authorized_upload(owned.filename, supervisor, session) is not None
        try:
            export_form_submission_pdf(record.id, session, supervisor)
        except HTTPException as error:
            assert error.status_code == 409
            assert error.headers == {"Cache-Control": "private, no-store"}
        else:
            raise AssertionError("Upload ownership cannot invent a submitted signature")
    print("ok - owner/global direct-read exceptions cannot invent record evidence; export refusal stays private/no-store")


if __name__ == "__main__":
    test_missing_or_malformed_snapshot_cannot_embed_foreign_evidence()
    test_ordinary_foreign_url_stays_literal_text()
    test_real_typed_evidence_remains_exportable()
    test_untyped_daywork_signature_name_cannot_grant_pdf_access()
    test_inline_saved_evidence_and_missing_upload_placeholders()
    test_owner_and_global_privileges_do_not_relabel_answers_as_evidence()
