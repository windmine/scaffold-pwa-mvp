"""Disposable PDF email tests: synthetic records only, SMTP mocked, sockets blocked."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from io import BytesIO
import json
import os
from pathlib import Path
import ssl
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

_environment = TemporaryDirectory(prefix="report-pdf-email-config-")
os.environ.update({
    "DATABASE_URL": "sqlite:///" + (Path(_environment.name) / "unused.db").as_posix(),
    "APP_ENV": "development", "K_SERVICE": "", "AUTO_MIGRATE": "false",
    "GEO_SECRET_KEY": "synthetic-report-pdf-email-test-key-only", "SQL_ECHO": "false",
    "SMTP_HOST": "", "SMTP_USERNAME": "", "SMTP_PASSWORD": "", "SMTP_FROM_EMAIL": "",
    "REGISTRATION_EMAIL_ENABLED": "false", "REPORT_PDF_EMAIL_WORKER_ENABLED": "false",
    "RATE_LIMIT_ENABLED": "false", "UPLOAD_STORAGE_BACKEND": "local", "UPLOAD_BUCKET": "",
    "UPLOAD_DIR": str(Path(_environment.name) / "uploads"),
})

from fastapi import HTTPException
from PIL import Image
from pypdf import PdfReader
from sqlalchemy import delete, event
from sqlmodel import Session, SQLModel, create_engine, select
from app import email_transport, upload_storage
from app.models import Department, ReportPdfEmail, User, WorkForm, WorkFormSubmission
from app.schemas import WorkFormEmailSettings, WorkFormSubmissionCreate
from app.use_cases import report_pdf_email as delivery
from app.use_cases.common import review_record_response
from app.use_cases.record_trash import purge_expired_deleted_records
from app.use_cases.work_forms import create_work_form_submission, list_work_forms


class ReportPdfEmailTests(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(TemporaryDirectory(prefix="report-pdf-email-db-"))
        self.engine = create_engine("sqlite:///" + (Path(directory) / "test.db").as_posix(),
                                    connect_args={"check_same_thread": False, "timeout": 10})
        self.addCleanup(self.engine.dispose)
        SQLModel.metadata.create_all(self.engine)
        self.session = Session(self.engine)
        self.addCleanup(self.session.close)
        self.worker = User(id=1, department_id=1, email="worker@example.invalid", name="Submitted Worker", password_hash="unused")
        self.supervisor = User(id=2, department_id=1, role="supervisor", email="supervisor@example.invalid", name="Supervisor", password_hash="unused")
        self.foreign = User(id=3, department_id=2, role="supervisor", email="other@example.invalid", name="Other", password_hash="unused")
        self.form = WorkForm(id=1, department_id=1, name="Submitted inspection 检查", fields_json=json.dumps([
            {"id": "issue", "type": "text", "label": "Inspection findings"},
            {"id": "signed", "type": "signature", "label": "Signed by Worker"},
        ]))
        self.session.add_all([Department(id=1, name="Mutual"), Department(id=2, name="Other"), self.worker,
                              self.supervisor, self.foreign, self.form])
        self.session.commit()
        self.enterContext(patch("socket.create_connection", side_effect=AssertionError("Network forbidden")))
        self.enterContext(patch.object(upload_storage, "UPLOAD_DIR", Path(directory) / "uploads"))
        for key, value in {"SMTP_HOST": "smtp.invalid", "SMTP_PORT": 587, "SMTP_USERNAME": "sender@example.invalid",
                "SMTP_PASSWORD": "synthetic-password", "SMTP_FROM_EMAIL": "sender@example.invalid",
                "SMTP_USE_STARTTLS": True, "SMTP_USE_SSL": False}.items():
            self.enterContext(patch.object(email_transport, key, value))
        self.smtp = self.enterContext(patch.object(email_transport.smtplib, "SMTP"))
        self.client = self.smtp.return_value
        self.client.send_message.return_value = {}

    def settings(self, enabled=True, recipient="reports@example.invalid", version=None, user=None):
        return delivery.update_email_settings(1, WorkFormEmailSettings(enabled=enabled, recipient=recipient,
            expected_version=version or self.form.pdf_email_version, confirmed=True), user or self.supervisor, self.session)

    def submit(self, key="stable-offline-id", **options):
        return create_work_form_submission(WorkFormSubmissionCreate(form_id=1, expected_definition_version=1,
            work_date="2026-10-21", client_submission_id=key, answers=options.pop("answers", {"issue": "Secure guardrail 安全护栏"}),
            **options), self.worker, self.session, include_replay_marker=True)

    def row(self):
        self.session.expire_all()
        return self.session.exec(select(ReportPdfEmail)).one()

    def raster(self, size, color):
        buffer = BytesIO()
        Image.new("RGB", size, color).save(buffer, format="PNG")
        stored = upload_storage.store_verified_raster(buffer.getvalue(), self.worker.id)
        return f"/uploads/{stored.filename}"

    def test_exports_skip_unused_email_status_but_review_keeps_it(self):
        from app.use_cases import supervisor_review as review
        self.settings()
        submitted = self.submit()
        with patch.object(delivery, "email_status", side_effect=AssertionError("Export queried unused email status")):
            for export in (review.export_form_submissions_csv, review.export_form_submissions_html,
                           review.export_form_submissions_pdf):
                response = export(session=self.session, supervisor=self.supervisor, purpose="report")
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.body)
            for export in (review.export_form_submission_csv, review.export_form_submission_html,
                           review.export_form_submission_pdf):
                response = export(submission_id=submitted["id"], session=self.session, supervisor=self.supervisor)
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.body)
        record = self.session.get(WorkFormSubmission, submitted["id"])
        self.assertEqual(review_record_response("form", record, self.session)["pdf_email"]["status"], "pending")
        self.client.send_message.assert_not_called()

    def test_default_off_no_retroactive_enqueue_and_worker_privacy(self):
        first = self.submit()
        self.assertEqual(self.session.exec(select(ReportPdfEmail)).all(), [])
        self.settings()
        replay = self.submit()
        self.assertTrue(replay["idempotent_replay"])
        self.assertEqual(replay["id"], first["id"])
        self.assertEqual(self.session.exec(select(ReportPdfEmail)).all(), [])
        self.assertNotIn("pdf_email", list_work_forms(self.worker, self.session)[0])
        self.assertNotIn("pdf_email", self.submit("new-id"))
        self.assertEqual(self.row().status, "pending")
        self.smtp.assert_not_called()

    def test_settings_permissions_validation_and_independent_stale_guard(self):
        for user, expected in ((self.worker, 403), (self.foreign, 404)):
            with self.assertRaises(HTTPException) as error:
                self.settings(user=user)
            self.assertEqual(error.exception.status_code, expected)
        for recipient in ("", "a@example.invalid,b@example.invalid", "a@example.invalid\r\nBcc: b@example.invalid", "no-domain"):
            with self.assertRaises(HTTPException):
                self.settings(recipient=recipient)
        updated = self.settings()
        self.assertEqual(updated["definition_version"], 1)
        self.assertEqual(updated["pdf_email"]["version"], 2)
        with self.assertRaises(HTTPException) as error:
            self.settings(version=1, recipient="wrong@example.invalid")
        self.assertEqual(error.exception.status_code, 409)
        self.settings(enabled=False, recipient="")
        self.assertFalse(self.form.pdf_email_enabled)

    def test_daywork_cannot_enable_or_queue(self):
        self.form.template_purpose = "daywork"
        self.worker.worker_class = "leader"
        self.session.add_all([self.form, self.worker])
        self.session.commit()
        with self.assertRaises(HTTPException):
            self.settings()
        # Even a pre-existing erroneous DB setting cannot cause Daywork mail.
        self.form.pdf_email_enabled = True
        self.session.add(self.form)
        self.session.commit()
        self.submit()
        self.assertEqual(self.session.exec(select(ReportPdfEmail)).all(), [])

    def test_atomic_enqueue_rolls_back_submission_on_queue_failure(self):
        self.settings()
        def fail(_connection, _cursor, statement, _parameters, _context, _many):
            if statement.lower().startswith("insert into reportpdfemail"):
                raise RuntimeError("Injected outbox write failure")
        event.listen(self.engine, "before_cursor_execute", fail)
        try:
            with self.assertRaises(RuntimeError):
                self.submit()
        finally:
            event.remove(self.engine, "before_cursor_execute", fail)
            self.session.rollback()
        self.assertEqual(self.session.exec(select(WorkFormSubmission)).all(), [])
        self.assertEqual(self.session.exec(select(ReportPdfEmail)).all(), [])
        self.submit()
        self.assertEqual(self.row().status, "pending")

    def test_committed_snapshot_photos_signature_and_mime_verified_tls(self):
        self.settings()
        photo = self.raster((91, 61), "orange")
        signature = self.raster((127, 43), "navy")
        submission = self.submit(answers={"issue": "Secure guardrail 安全护栏", "signed": signature}, photo_urls=[photo])
        self.settings(recipient="later@example.invalid")
        self.form.name = "Later template name"
        self.worker.name = "Later worker name"
        record = self.session.get(WorkFormSubmission, submission["id"])
        record.workflow_status = "resolved"
        record.supervisor_note = "Later review note"
        self.session.add_all([self.form, self.worker, record])
        self.session.commit()
        self.assertEqual(delivery.dispatch_pending(self.engine)["accepted"], 1)
        self.assertEqual(self.row().status, "accepted")
        message = self.client.send_message.call_args.args[0]
        self.assertEqual(message["To"], "reports@example.invalid")
        self.assertEqual(message["From"], "sender@example.invalid")
        self.assertEqual(message["Message-ID"], self.row().message_id)
        attachments = list(message.iter_attachments())
        self.assertEqual(len(attachments), 1)
        self.assertEqual(attachments[0].get_content_type(), "application/pdf")
        pdf = attachments[0].get_payload(decode=True)
        document = PdfReader(BytesIO(pdf))
        content = "\n".join(page.extract_text() for page in document.pages)
        self.assertIn("Submitted Worker", content)
        self.assertIn("安全护栏", content)
        self.assertNotIn("Later", content)
        dimensions = []
        for page in document.pages:
            for value in page["/Resources"].get("/XObject", {}).get_object().values():
                obj = value.get_object()
                if obj.get("/Subtype") == "/Image":
                    dimensions.append((obj["/Width"], obj["/Height"]))
        self.assertIn((91, 61), dimensions)
        self.assertIn((127, 43), dimensions)
        tls = self.client.starttls.call_args.kwargs["context"]
        self.assertEqual(tls.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(tls.check_hostname)
        self.assertEqual(delivery.dispatch_pending(self.engine)["accepted"], 0)
        self.client.send_message.assert_called_once()
        # Synthetic artifact only; useful for local visual review.
        target = Path(__file__).resolve().parents[1] / "output/report-pdf-email.local"
        target.mkdir(parents=True, exist_ok=True)
        (target / "submitted-report.pdf").write_bytes(pdf)

    def test_replay_and_concurrent_dispatch_never_duplicate(self):
        self.settings()
        self.submit()
        self.assertTrue(self.submit()["idempotent_replay"])
        row_id = self.row().id
        self.session.rollback()
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(lambda _: delivery.dispatch_one(self.engine, row_id), range(2)))
        self.assertCountEqual(outcomes, ["accepted", "skipped"])
        self.client.send_message.assert_called_once()

    def test_uncertain_smtp_is_never_retried_and_submission_stays_successful(self):
        self.settings()
        record = self.submit()
        self.client.send_message.side_effect = TimeoutError("private server text must not escape")
        self.assertEqual(delivery.dispatch_pending(self.engine)["uncertain"], 1)
        self.assertEqual(self.row().failure_code, "acceptance_unknown")
        self.assertEqual(delivery.dispatch_pending(self.engine)["uncertain"], 0)
        self.client.send_message.assert_called_once()
        replay = self.submit()
        self.assertEqual(replay["id"], record["id"])
        status = review_record_response("form", self.session.get(WorkFormSubmission, record["id"]), self.session)["pdf_email"]
        self.assertEqual(status["status"], "uncertain")
        self.assertEqual(status["recipient"], "reports@example.invalid")

    def test_tls_failure_fails_without_login_and_never_retries(self):
        self.settings()
        self.submit()
        self.client.starttls.side_effect = ssl.SSLCertVerificationError("bad certificate")
        self.assertEqual(delivery.dispatch_pending(self.engine)["failed"], 1)
        self.client.login.assert_not_called()
        self.client.send_message.assert_not_called()
        delivery.dispatch_pending(self.engine)
        self.smtp.assert_called_once()

    def test_missing_evidence_and_oversized_pdf_fail_before_smtp(self):
        self.settings()
        url = self.raster((21, 15), "red")
        self.submit(photo_urls=[url])
        with patch("app.use_cases.supervisor_review_exports.load_upload", return_value=None):
            self.assertEqual(delivery.dispatch_pending(self.engine)["failed"], 1)
        self.assertEqual(self.row().failure_code, "pdf_unavailable")
        self.smtp.assert_not_called()
        self.submit("large")
        with patch.object(email_transport, "MAX_PDF_ATTACHMENT_BYTES", 5):
            self.assertEqual(delivery.dispatch_pending(self.engine)["failed"], 1)
        self.smtp.assert_not_called()

    def test_crash_and_result_commit_failure_remain_uncertain(self):
        self.settings()
        self.submit()
        row_id = self.row().id
        with patch("app.use_cases.report_pdf.build_report_pdf", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                delivery.dispatch_one(self.engine, row_id)
        self.assertEqual(self.row().status, "uncertain")
        delivery.dispatch_pending(self.engine)
        self.smtp.assert_not_called()
        self.submit("second")
        def fail_result(_connection, _cursor, statement, _parameters, _context, _many):
            if statement.startswith("UPDATE reportpdfemail SET status=") and "failure_code=" in statement:
                raise RuntimeError("Injected result persistence failure")
        event.listen(self.engine, "before_cursor_execute", fail_result)
        try:
            with self.assertRaises(RuntimeError):
                delivery.dispatch_pending(self.engine)
        finally:
            event.remove(self.engine, "before_cursor_execute", fail_result)
        delivery.dispatch_pending(self.engine)
        self.client.send_message.assert_called_once()
        with Session(self.engine) as session:
            self.assertEqual([row.status for row in session.exec(select(ReportPdfEmail)).all()], ["uncertain", "uncertain"])

    def test_deleted_or_changed_scope_never_sends_and_purge_removes_snapshot(self):
        self.settings()
        submitted = self.submit()
        record = self.session.get(WorkFormSubmission, submitted["id"])
        record.deleted_at = datetime.now(timezone.utc) - timedelta(days=31)
        self.session.add(record)
        self.session.commit()
        self.assertEqual(delivery.dispatch_pending(self.engine)["failed"], 1)
        self.smtp.assert_not_called()
        purge_expired_deleted_records(self.session)
        self.assertEqual(self.session.exec(select(ReportPdfEmail)).all(), [])
        self.session.expunge(record)
        submitted = self.submit("other-scope")
        record = self.session.get(WorkFormSubmission, submitted["id"])
        record.department_id = 2
        self.session.add(record)
        self.session.commit()
        self.assertEqual(delivery.dispatch_pending(self.engine)["failed"], 1)
        self.smtp.assert_not_called()

    def test_unverified_snapshot_cannot_read_arbitrary_media(self):
        self.settings()
        self.submit()
        row = self.row()
        item = json.loads(row.snapshot_json)
        item["fields"] = [{"id": "issue", "type": "signature", "label": "Changed"}]
        item["answers"] = {"issue": "/uploads/unrelated.png"}
        row.snapshot_json = json.dumps(item)
        self.session.add(row)
        self.session.commit()
        with patch("app.use_cases.supervisor_review_exports.load_upload") as loader:
            self.assertEqual(delivery.dispatch_pending(self.engine)["failed"], 1)
            loader.assert_not_called()
        self.smtp.assert_not_called()

    def test_insecure_dispatch_configuration_leaves_queue_pending(self):
        self.settings()
        self.submit()
        with patch.object(email_transport, "SMTP_USE_STARTTLS", False):
            with self.assertRaises(email_transport.EmailSendError):
                delivery.dispatch_pending(self.engine)
        self.assertEqual(self.row().status, "pending")
        self.smtp.assert_not_called()

    def test_purged_reused_row_cannot_inherit_a_previous_claim(self):
        self.settings()
        self.submit()
        row_id = self.row().id
        self.session.rollback()
        def replace_during_render(*_args, **_kwargs):
            with Session(self.engine) as session:
                old = session.get(ReportPdfEmail, row_id)
                replacement = ReportPdfEmail(id=old.id, submission_id=old.submission_id,
                    department_id=old.department_id, recipient=old.recipient,
                    template_email_version=old.template_email_version, snapshot_json=old.snapshot_json,
                    message_id="<new-row-identity@reportflow.invalid>")
                session.execute(delete(ReportPdfEmail).where(ReportPdfEmail.id == old.id))
                session.flush()
                session.expunge(old)
                session.add(replacement)
                session.commit()
            return b"%PDF-synthetic-not-sent"
        with patch("app.use_cases.report_pdf.build_report_pdf", side_effect=replace_during_render):
            self.assertEqual(delivery.dispatch_one(self.engine, row_id), "failed")
        self.smtp.assert_not_called()
        self.assertEqual(self.row().status, "pending")

    def test_worker_cli_default_off_and_sanitized_failures(self):
        from app import config, database, report_pdf_email_worker
        with patch("sys.argv", ["report_pdf_email_worker"]), patch("builtins.print") as output:
            with patch.object(config, "REPORT_PDF_EMAIL_WORKER_ENABLED", False), patch.object(database, "verify_database_migrations") as verify:
                self.assertEqual(report_pdf_email_worker.main(), 0)
                verify.assert_not_called()
                self.assertEqual(json.loads(output.call_args.args[0]), {"status": "disabled"})
            with patch.object(config, "REPORT_PDF_EMAIL_WORKER_ENABLED", True), patch.object(database, "verify_database_migrations"), patch.object(delivery, "dispatch_pending", side_effect=RuntimeError("private payload must never print")):
                self.assertEqual(report_pdf_email_worker.main(), 1)
                self.assertNotIn("private payload", output.call_args.args[0])
                self.assertEqual(json.loads(output.call_args.args[0])["status"], "blocked")
        self.smtp.assert_not_called()

    def test_http_permission_csrf_and_worker_setting_privacy(self):
        from app import main as application
        from app.auth import create_access_token
        def http(actor=None, cookie=False, csrf=False, method="PUT", path="/supervisor/work-forms/1/pdf-email"):
            async def request():
                messages = []
                body = json.dumps({"enabled": True, "recipient": "reports@example.invalid", "expected_version": 1, "confirmed": True}).encode()
                async def receive():
                    return {"type": "http.request", "more_body": False, "body": body}
                async def send(message):
                    messages.append(message)
                headers = [(b"content-type", b"application/json")]
                if actor:
                    token = create_access_token({"sub": actor.email, "user_id": actor.id, "auth_generation": actor.auth_generation, "csrf": "synthetic-csrf"})
                    headers.append((b"cookie", ("__session=" + token).encode()) if cookie else (b"authorization", ("Bearer " + token).encode()))
                    if csrf:
                        headers.append((b"x-csrf-token", b"synthetic-csrf"))
                await application.app({"type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"},
                    "http_version": "1.1", "method": method, "scheme": "http", "path": path, "raw_path": path.encode(),
                    "query_string": b"", "root_path": "", "headers": headers,
                    "client": ("127.0.0.1", 12345), "server": ("test.invalid", 80)}, receive, send)
                start = next(item for item in messages if item["type"] == "http.response.start")
                content = b"".join(item.get("body", b"") for item in messages)
                return start["status"], dict(start["headers"]), content
            def session_provider():
                with Session(self.engine) as session:
                    yield session
            with patch.dict(application.app.dependency_overrides, {application.get_session: session_provider}):
                return asyncio.run(request())
        self.assertEqual(http()[0], 401)
        self.assertEqual(http(self.worker)[0], 403)
        self.assertEqual(http(self.foreign)[0], 404)
        self.assertEqual(http(self.supervisor, cookie=True)[0], 403)
        status, headers, _ = http(self.supervisor, cookie=True, csrf=True)
        self.assertEqual(status, 200)
        self.assertIn(b"no-store", headers[b"cache-control"])
        status, _, content = http(self.worker, method="GET", path="/work-forms")
        self.assertEqual(status, 200)
        self.assertNotIn(b"reports@example.invalid", content)
        self.assertNotIn(b"pdf_email", content)
        self.submit()
        status, _, content = http(self.worker, method="GET", path="/my-form-submissions")
        self.assertEqual(status, 200)
        self.assertNotIn(b"pdf_email", content)
        self.assertNotIn(b"reports@example.invalid", content)
        status, headers, content = http(self.supervisor, method="GET", path="/supervisor/review-queue")
        self.assertEqual(status, 200)
        self.assertIn(b"reports@example.invalid", content)
        self.assertIn(b"no-store", headers[b"cache-control"])
        status, _, content = http(self.foreign, method="GET", path="/supervisor/review-queue")
        self.assertEqual(status, 200)
        self.assertNotIn(b"reports@example.invalid", content)
        self.smtp.assert_not_called()


from report_pdf_email_migration_checks import check_additive_migration


class ReportPdfEmailMigrationTests(unittest.TestCase):
    def test_additive_migration_defaults_off_preserves_checksums_no_backfill(self):
        with TemporaryDirectory(prefix="pdf-email-migration-") as directory:
            engine = create_engine("sqlite:///" + (Path(directory) / "test.db").as_posix())
            try:
                check_additive_migration(engine)
            finally:
                engine.dispose()


if __name__ == "__main__":
    unittest.main()
