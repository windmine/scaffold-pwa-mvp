"""Private own-Report PDF contract. Synthetic SQLite; network and SMTP blocked."""
import asyncio
from datetime import datetime, timezone
from io import BytesIO
import json
import unittest
from unittest.mock import patch

import report_pdf_email_test as fixture
from pypdf import PdfReader
from sqlmodel import select
from app.auth import create_access_token
from app.main import app, get_session
from app.models import ReportPdfEmail, User, WorkFormSubmission
from app.use_cases import report_pdf_email as delivery


class ReportSelfPdfTests(unittest.TestCase):
    submit = fixture.ReportPdfEmailTests.submit
    raster = fixture.ReportPdfEmailTests.raster

    def setUp(self):
        fixture.ReportPdfEmailTests.setUp(self)
        self.overrides = app.dependency_overrides.copy()
        app.dependency_overrides[get_session] = lambda: self.session
        self.addCleanup(self.restore_overrides)
        self.record = self.session.get(WorkFormSubmission, self.submit()["id"])
        self.other = User(id=8, department_id=1, email="another@example.invalid",
                          name="Another worker", password_hash="unused")
        self.session.add(self.other)
        self.session.commit()
        self.before_mail = self.mail_rows()
        self.enterContext(patch.object(delivery, "email_status", side_effect=AssertionError("No email query")))

    def restore_overrides(self):
        app.dependency_overrides.clear()
        app.dependency_overrides.update(self.overrides)

    def mail_rows(self):
        return [row.model_dump() for row in self.session.exec(select(ReportPdfEmail)).all()]

    def request(self, identifier=None, user="owner", prefix="", cookie=False):
        if user == "owner":
            user = self.worker
        headers = []
        if user is not None:
            token = create_access_token({"sub": user.email, "user_id": user.id,
                                         "auth_generation": user.auth_generation})
            headers = [(b"cookie", ("__session=" + token).encode())] if cookie else [
                (b"authorization", ("Bearer " + token).encode())]
        path = f"{prefix}/my-form-submissions/{self.record.id if identifier is None else identifier}/export.pdf"
        messages = []

        async def run():
            async def receive():
                return {"type": "http.request", "body": b"", "more_body": False}
            async def send(message):
                messages.append(message)
            await app({"type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"},
                "http_version": "1.1", "method": "GET", "scheme": "http", "path": path,
                "raw_path": path.encode(), "query_string": b"", "root_path": "",
                "headers": headers, "client": ("127.0.0.1", 1), "server": ("localhost", 80)}, receive, send)
        asyncio.run(run())
        start = next(message for message in messages if message["type"] == "http.response.start")
        response_headers = dict(start["headers"])
        body = b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body")
        self.assertEqual(response_headers[b"cache-control"], b"private, no-store")
        self.assertEqual(self.mail_rows(), self.before_mail)
        self.smtp.assert_not_called()
        return start["status"], response_headers, body

    def test_owner_bearer_cookie_api_prefix_and_current_saved_correction(self):
        self.record.answers_json = json.dumps({"issue": "Current corrected finding"})
        self.session.add(self.record)
        self.session.commit()
        for prefix, cookie in (("", False), ("/api", True)):
            status, headers, body = self.request(prefix=prefix, cookie=cookie)
            self.assertEqual(status, 200)
            self.assertEqual(headers[b"content-type"], b"application/pdf")
            self.assertEqual(headers[b"content-disposition"], f'attachment; filename="report-{self.record.id}.pdf"'.encode())
            text = "".join(page.extract_text() or "" for page in PdfReader(BytesIO(body)).pages)
            self.assertIn("Current corrected finding", text)
            self.assertNotIn("Secure guardrail", text)

    def test_missing_foreign_same_department_and_cross_department_are_indistinguishable(self):
        baseline = self.request(999999)
        self.assertEqual(baseline[0], 404)
        for user in (self.other, self.foreign):
            # A cross-department worker must be rejected without revealing the row.
            user.role = "worker"
            self.session.add(user)
            self.session.commit()
            response = self.request(user=user)
            self.assertEqual((response[0], response[2]), (404, baseline[2]))
        for identifier in ("invalid", "-1", "0", "1.0", "99999999999999999999999999"):
            response = self.request(identifier)
            self.assertEqual((response[0], response[2]), (404, baseline[2]))

    def test_own_old_department_deleted_and_daywork_are_hidden(self):
        for attribute, value in (("department_id", 2), ("deleted_at", datetime.now(timezone.utc)),
                                 ("submission_purpose", "daywork")):
            previous = getattr(self.record, attribute)
            setattr(self.record, attribute, value)
            self.session.add(self.record)
            self.session.commit()
            status, _, body = self.request()
            self.assertEqual((status, json.loads(body)), (404, {"detail": "Report not found"}))
            setattr(self.record, attribute, previous)
            self.session.add(self.record)
            self.session.commit()

    def test_anonymous_resigned_setup_and_supervisor_are_denied(self):
        self.assertEqual(self.request(user=None)[0], 401)
        self.assertEqual(self.request(user=self.supervisor)[0], 403)
        for attribute, value in (("status", "resigned"), ("password_setup_required", True)):
            previous = getattr(self.worker, attribute)
            setattr(self.worker, attribute, value)
            self.session.add(self.worker)
            self.session.commit()
            self.assertEqual(self.request()[0], 403)
            setattr(self.worker, attribute, previous)
            self.session.add(self.worker)
            self.session.commit()

    def test_saved_photo_and_signature_are_embedded_with_frozen_definition(self):
        photo = self.raster((41, 29), "blue")
        signature = self.raster((53, 17), "black")
        self.record.photo_urls = json.dumps([photo])
        self.record.answers_json = json.dumps({"issue": "Evidence", "signed": signature})
        self.form.fields_json = "[]"
        self.session.add_all([self.record, self.form])
        self.session.commit()
        status, _, body = self.request()
        self.assertEqual(status, 200)
        dimensions = []
        for page in PdfReader(BytesIO(body)).pages:
            objects = page["/Resources"].get("/XObject")
            for value in objects.get_object().values() if objects else ():
                image = value.get_object()
                if image.get("/Subtype") == "/Image":
                    dimensions.append((int(image["/Width"]), int(image["/Height"])))
        self.assertIn((41, 29), dimensions)
        self.assertIn((53, 17), dimensions)

    def test_foreign_upload_in_ordinary_answer_stays_text_after_template_edit(self):
        from PIL import Image
        from app import upload_storage
        buffer = BytesIO()
        Image.new("RGB", (37, 23), "orange").save(buffer, format="PNG")
        stored = upload_storage.store_verified_raster(buffer.getvalue(), self.other.id)
        url = f"/uploads/{stored.filename}"
        self.record.answers_json = json.dumps({"issue": url})
        self.form.fields_json = json.dumps([{"id": "issue", "type": "signature", "label": "Changed"}])
        self.session.add_all([self.record, self.form])
        self.session.commit()
        status, _, body = self.request()
        self.assertEqual(status, 200)
        reader = PdfReader(BytesIO(body))
        self.assertIn(url, "".join(page.extract_text() or "" for page in reader.pages))
        for page in reader.pages:
            objects = page["/Resources"].get("/XObject")
            for value in objects.get_object().values() if objects else ():
                image = value.get_object()
                if image.get("/Subtype") == "/Image":
                    self.assertNotEqual((int(image["/Width"]), int(image["/Height"])), (37, 23))

    def test_unverified_fallback_signature_refused_before_rendering(self):
        self.form.fields_json = json.dumps([{"id": "issue", "type": "signature", "label": "Changed"}])
        self.record.answers_json = json.dumps({"issue": self.raster((37, 23), "orange")})
        self.session.add(self.form)
        for snapshot in (None, "{", "[]", '{"fields":[null]}'):
            self.record.definition_snapshot_json = snapshot
            self.session.add(self.record)
            self.session.commit()
            with patch("app.use_cases.report_self_pdf.build_report_pdf", side_effect=AssertionError("Must not render")):
                status, _, body = self.request()
            self.assertEqual(status, 409)
            self.assertIn("evidence", json.loads(body)["detail"])


if __name__ == "__main__":
    unittest.main()
