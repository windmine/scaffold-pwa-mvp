"""Disposable invitation email tests. All SMTP is mocked; sockets are forbidden."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from io import BytesIO
import json
import os
from pathlib import Path
import smtplib
import ssl
from tempfile import TemporaryDirectory
from threading import Event
import unittest
from unittest.mock import patch
from pypdf import PdfReader

_environment = TemporaryDirectory(prefix="invitation-email-config-")
os.environ.update({
    "DATABASE_URL": "sqlite:///" + (Path(_environment.name) / "unused.db").as_posix(),
    "APP_ENV": "development", "K_SERVICE": "", "AUTO_MIGRATE": "false",
    "GEO_SECRET_KEY": "synthetic-invitation-email-local-test-key-only",
    "SMTP_HOST": "", "SMTP_PASSWORD": "", "SMTP_USERNAME": "", "SMTP_FROM_EMAIL": "",
    "REGISTRATION_EMAIL_ENABLED": "false", "SQL_ECHO": "false", "RATE_LIMIT_ENABLED": "false",
    "UPLOAD_STORAGE_BACKEND": "local", "UPLOAD_DIR": str(Path(_environment.name) / "uploads"),
})

from fastapi import HTTPException
from sqlalchemy.exc import OperationalError
from sqlmodel import Session, SQLModel, create_engine, select
from app import email_transport, main as application
from app.auth import create_access_token
from app.models import AuditEvent, Department, User, WorkerInvitation
from app.schemas import WorkerInvitationEmailRequest, WorkerInvitationAcceptRequest
from app.use_cases import worker_invitation_email as delivery, worker_invitations as invitations
from app.use_cases.registration import secret_hash
from app.use_cases import invitation_guide


class InvitationEmailTests(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(TemporaryDirectory(prefix="invitation-email-db-"))
        self.engine = create_engine("sqlite:///" + (Path(directory) / "test.db").as_posix(),
                                    connect_args={"check_same_thread": False, "timeout": 10})
        self.addCleanup(self.engine.dispose)
        SQLModel.metadata.create_all(self.engine)
        self.session = Session(self.engine)
        self.addCleanup(self.session.close)
        self.supervisor = User(id=1, email="supervisor@example.invalid", name="Supervisor", role="supervisor",
                               department_id=1, password_hash="unused")
        self.worker = User(id=2, email="worker@example.invalid", name="Worker", department_id=1,
                           password_hash="unchanged", password_setup_required=True, invitation_generation=1)
        self.other = User(id=3, email="other@example.invalid", name="Other", role="supervisor",
                          department_id=2, password_hash="unused")
        self.token = "synthetic_invitation_token_12345678901234567890"
        self.invitation = WorkerInvitation(id=1, worker_id=2, department_id=1, email=self.worker.email,
            generation=1, token_hash=secret_hash("worker-invitation", self.token), issued_by=1,
            expires_at=invitations.utc_now() + timedelta(hours=48))
        self.session.add_all([Department(id=1, name="One"), Department(id=2, name="Two"),
                              self.supervisor, self.worker, self.other, self.invitation])
        self.session.commit()
        self.enterContext(patch("socket.create_connection", side_effect=AssertionError("Network forbidden")))
        for name, value in {"SMTP_HOST": "smtp.invalid", "SMTP_PORT": 587,
                            "SMTP_USERNAME": "sender@example.invalid", "SMTP_PASSWORD": "synthetic-password",
                            "SMTP_FROM_EMAIL": "sender@example.invalid", "SMTP_USE_SSL": False,
                            "SMTP_USE_STARTTLS": True}.items():
            self.enterContext(patch.object(email_transport, name, value))
        self.enterContext(patch.object(delivery, "PUBLIC_APP_URL", "https://reports.example.invalid"))
        self.enterContext(patch.object(delivery, "PRODUCTION_LIKE", True))
        self.smtp = self.enterContext(patch.object(email_transport.smtplib, "SMTP"))
        self.smtp_ssl = self.enterContext(patch.object(email_transport.smtplib, "SMTP_SSL"))
        self.client = self.smtp.return_value
        self.client.send_message.return_value = {}

    def send(self, session=None, supervisor=None, token=None):
        return delivery.send_worker_invitation_email(2, WorkerInvitationEmailRequest(token=token or self.token),
            supervisor or self.supervisor, session or self.session)

    def test_explicit_send_uses_saved_recipient_verified_tls_and_private_canonical_link(self):
        self.smtp.assert_not_called()
        result = self.send()
        self.assertEqual(result["email_status"], "accepted")
        self.assertIsNotNone(result["email_accepted_at"])
        context = self.client.starttls.call_args.kwargs["context"]
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        self.assertEqual([c[0] for c in self.client.method_calls],
                         ["set_debuglevel", "starttls", "login", "send_message", "close"])
        message = self.client.send_message.call_args.args[0]
        self.assertEqual(message["To"], self.worker.email)
        self.assertEqual(message["From"], "sender@example.invalid")
        self.assertEqual(message["Subject"], "Your ReportFlow invitation")
        self.assertIn("https://reports.example.invalid/setup-password.html#token=" + self.token, message.get_body(preferencelist=('plain',)).get_content())
        self.assertTrue(message.is_multipart())
        self.assert_guide(message)
        for event in self.session.exec(select(AuditEvent)).all():
            self.assertNotIn(self.token, event.model_dump_json())
            self.assertNotIn("synthetic-password", event.model_dump_json())
        self.assertNotIn(self.token, json.dumps(result))
        self.assertEqual(self.session.get(User, 2).password_hash, "unchanged")
        self.assertEqual(self.send(), result)
        self.client.send_message.assert_called_once()

    def test_supervisor_and_global_admin_sends_keep_tls_scope_and_one_attempt(self):
        for global_admin in (False, True):
            with self.subTest(global_admin=global_admin):
                self.worker.role = "supervisor"
                self.worker.is_global_admin = global_admin
                self.supervisor.is_global_admin = global_admin
                self.session.add_all([self.worker, self.supervisor])
                self.session.commit()
                for error, expected in ((None, "accepted"),
                        (smtplib.SMTPRecipientsRefused({self.worker.email: (550, b"no")}), "failed"),
                        (smtplib.SMTPServerDisconnected("lost acknowledgment"), "unknown")):
                    issued = invitations.reissue_worker_invitation(2, self.supervisor, self.session)
                    self.client.send_message.side_effect = error
                    calls = self.client.send_message.call_count
                    result = self.send(token=issued["token"])
                    self.assertEqual(result["email_status"], expected)
                    self.assertEqual(self.send(token=issued["token"]), result)
                    self.assertEqual(self.client.send_message.call_count, calls + 1)
                    message = self.client.send_message.call_args.args[0]
                    self.assertEqual(message["To"], self.worker.email)
                    self.assertIn("Supervisor / global admin" if global_admin else "Supervisor", message.get_body(preferencelist=('plain',)).get_content())
                    self.assert_guide(message)
                    context = self.client.starttls.call_args.kwargs["context"]
                    self.assertTrue(context.check_hostname)
                    self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
                if global_admin:
                    self.supervisor.is_global_admin = False
                    self.session.add(self.supervisor)
                    self.session.commit()
                    with self.assertRaises(HTTPException) as caught:
                        self.send(token=issued["token"])
                    self.assertEqual(caught.exception.status_code, 403)

    def assert_guide(self, message):
        attachments = list(message.iter_attachments())
        self.assertEqual(len(attachments), 1)
        self.assertEqual(attachments[0].get_content_type(), "application/pdf")
        self.assertEqual(attachments[0].get_filename(), "ReportFlow-Getting-Started.pdf")
        payload = attachments[0].get_payload(decode=True)
        self.assertEqual(payload, invitation_guide.getting_started_pdf())
        self.assertLess(len(payload), invitation_guide.MAX_GUIDE_BYTES)
        self.assertLess(len(message.as_bytes()), email_transport.MAX_EMAIL_BYTES)
        reader = PdfReader(BytesIO(payload))
        self.assertEqual(len(reader.pages), 1)
        text = reader.pages[0].extract_text()
        for expected in (invitation_guide.PUBLIC_APP_URL, "Safari", "Chrome", "expires", "My Reports", "queued", "password"):
            self.assertIn(expected, text)
        for private in (self.token, self.worker.email, self.worker.name, "setup-password.html#token=", "synthetic-password"):
            self.assertNotIn(private, text)
        plain = message.get_body(preferencelist=('plain',)).get_content()
        self.assertIn("Getting started:", plain)
        self.assertIn(invitation_guide.PUBLIC_APP_URL, plain)
        latest = self.session.exec(select(WorkerInvitation).where(WorkerInvitation.worker_id == self.worker.id)
                                   .order_by(WorkerInvitation.id.desc())).first()
        self.assertIn(latest.expires_at.isoformat(), plain)

    def test_guide_failure_leaves_no_attempt_and_private_link_usable(self):
        with patch.object(invitation_guide, "getting_started_pdf", side_effect=OSError("private local path")):
            with self.assertRaises(HTTPException) as caught:
                self.send()
        self.assertEqual(caught.exception.status_code, 503)
        self.assertNotIn("private local path", str(caught.exception.detail))
        self.session.refresh(self.invitation)
        self.assertIsNone(self.invitation.email_attempted_at)
        self.smtp.assert_not_called()
        invitations._valid_invitation(self.token, self.session)

    def test_changed_invited_permissions_fail_before_smtp(self):
        self.worker.role = "supervisor"
        self.session.add(self.worker)
        self.session.commit()
        # Existing Worker link cannot silently become a Supervisor link.
        with self.assertRaises(HTTPException):
            self.send()
        self.smtp.assert_not_called()
        issued = invitations.reissue_worker_invitation(2, self.supervisor, self.session)
        self.worker.is_global_admin = True
        self.supervisor.is_global_admin = True
        self.session.add_all([self.worker, self.supervisor])
        self.session.commit()
        with self.assertRaises(HTTPException):
            self.send(token=issued["token"])
        self.smtp.assert_not_called()

    def test_tls_failure_is_sanitized_and_durable_without_plaintext_fallback(self):
        self.client.starttls.side_effect = ssl.SSLCertVerificationError("private server text " + self.token)
        result = self.send()
        self.assertEqual(result["email_status"], "failed")
        self.assertNotIn(self.token, json.dumps(result))
        self.client.login.assert_not_called()
        self.client.send_message.assert_not_called()
        self.smtp_ssl.assert_not_called()
        self.assertEqual(self.send()["email_status"], "failed")
        self.smtp.assert_called_once()

    def test_rejected_recipient_is_failed_but_lost_data_response_is_unknown(self):
        for error, expected in [(smtplib.SMTPRecipientsRefused({"worker@example.invalid": (550, b"no")}), "failed"),
                                (smtplib.SMTPDataError(550, b"no"), "failed"),
                                (smtplib.SMTPServerDisconnected("lost response"), "unknown")]:
            with self.subTest(outcome=expected):
                self.client.send_message.side_effect = error
                self.invitation.email_attempted_at = None
                self.invitation.email_status = "not_sent"
                self.session.add(self.invitation)
                self.session.commit()
                self.assertEqual(self.send()["email_status"], expected)
                calls = self.client.send_message.call_count
                self.assertEqual(self.send()["email_status"], expected)
                self.assertEqual(self.client.send_message.call_count, calls)

    def test_close_failure_does_not_erase_acknowledged_acceptance(self):
        self.client.close.side_effect = OSError("disconnect")
        self.assertEqual(self.send()["email_status"], "accepted")

    def test_configuration_failure_leaves_invitation_unclaimed_and_manual_link_valid(self):
        for url in ("", "http://reports.example.invalid", "https://reports.example.invalid/evil", "https://a@b.invalid", "https://a.invalid?evil=1"):
            with self.subTest(url=url), patch.object(delivery, "PUBLIC_APP_URL", url):
                with self.assertRaises(HTTPException) as caught:
                    self.send()
                self.assertEqual(caught.exception.detail["code"], "INVITATION_EMAIL_UNAVAILABLE")
                self.assertIsNone(self.invitation.email_attempted_at)
                invitations._valid_invitation(self.token, self.session)
        with patch.object(email_transport, "SMTP_USE_STARTTLS", False):
            with self.assertRaises(HTTPException):
                self.send()
        self.smtp.assert_not_called()
        self.assertEqual(self.send()["email_status"], "accepted")

    def test_scope_role_status_expiry_generation_and_token_must_match(self):
        with self.assertRaises(HTTPException) as caught:
            self.send(supervisor=self.other)
        self.assertEqual(caught.exception.status_code, 404)
        changes = [(self.worker, "status", "resigned"), (self.worker, "role", "supervisor"),
                   (self.worker, "email", "changed@example.invalid"), (self.worker, "department_id", 2),
                   (self.worker, "invitation_generation", 2), (self.worker, "password_setup_required", False),
                   (self.invitation, "expires_at", invitations.utc_now() - timedelta(seconds=1)),
                   (self.invitation, "revoked_at", invitations.utc_now()),
                   (self.invitation, "consumed_at", invitations.utc_now()),
                   (self.session.get(Department, 1), "status", "archived")]
        for target, attribute, value in changes:
            with self.subTest(attribute=attribute):
                original = getattr(target, attribute)
                setattr(target, attribute, value)
                self.session.add(target)
                self.session.commit()
                with self.assertRaises(HTTPException):
                    self.send()
                setattr(target, attribute, original)
                self.session.add(target)
                self.session.commit()
        with self.assertRaises(HTTPException):
            self.send(token="wrong_synthetic_token_1234567890")
        self.smtp.assert_not_called()

    def test_global_supervisor_can_send_across_departments(self):
        self.other.is_global_admin = True
        self.session.add(self.other)
        self.session.commit()
        self.assertEqual(self.send(supervisor=self.other)["email_status"], "accepted")

    def test_in_progress_claim_blocks_concurrent_send(self):
        started, release = Event(), Event()
        def smtp_send(*args, **kwargs):
            started.set()
            if not release.wait(10):
                raise AssertionError("Concurrent test timed out")
            return {}
        self.client.send_message.side_effect = smtp_send
        def first():
            with Session(self.engine) as session:
                return self.send(session=session, supervisor=session.get(User, 1))
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(first)
            try:
                self.assertTrue(started.wait(10))
                with Session(self.engine) as session:
                    self.assertEqual(self.send(session=session, supervisor=session.get(User, 1))["email_status"], "unknown")
            finally:
                release.set()
            self.assertEqual(future.result(timeout=10)["email_status"], "accepted")
        self.client.send_message.assert_called_once()

    def test_failed_result_commit_cannot_cause_duplicate_on_replay(self):
        commit = self.session.commit
        calls = 0
        def commit_once():
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OperationalError("synthetic", {}, Exception("synthetic"))
            commit()
        with patch.object(self.session, "commit", side_effect=commit_once):
            with self.assertRaises(HTTPException) as caught:
                self.send()
            self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(self.send()["email_status"], "unknown")
        self.client.send_message.assert_called_once()

    def test_email_does_not_change_single_use_acceptance_or_replacement(self):
        self.send()
        new = invitations.reissue_worker_invitation(2, self.supervisor, self.session)
        with self.assertRaises(HTTPException):
            self.send()
        self.assertEqual(self.send(token=new["token"])["email_status"], "accepted")
        data = WorkerInvitationAcceptRequest(token=new["token"], password="Synthetic-local-password-44")
        invitations.accept_worker_invitation(data, self.session)
        with self.assertRaises(HTTPException):
            invitations.accept_worker_invitation(data, self.session)
        with self.assertRaises(HTTPException):
            self.send(token=new["token"])
        self.assertEqual(self.client.send_message.call_count, 2)

    def http(self, payload=None, actor=None, cookie=False, csrf=False):
        async def request():
            messages = []
            body = json.dumps(payload or {"token": self.token}).encode()
            body_sent = False
            async def receive():
                nonlocal body_sent
                if body_sent:
                    await asyncio.Event().wait()  # No disconnect while the response is in flight.
                body_sent = True
                await asyncio.sleep(0)
                return {"type": "http.request", "more_body": False, "body": body}
            async def send(message):
                messages.append(message)
            headers = [(b"content-type", b"application/json")]
            if actor:
                token = create_access_token({"sub": actor.email, "user_id": actor.id, "auth_generation": actor.auth_generation, "csrf": "synthetic-csrf"})
                headers.append((b"cookie", ("__session=" + token).encode()) if cookie else (b"authorization", ("Bearer " + token).encode()))
                if csrf:
                    headers.append((b"x-csrf-token", b"synthetic-csrf"))
            path = "/supervisor/users/2/invitation/email"
            await application.app({"type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"},
                "http_version": "1.1", "method": "POST", "scheme": "http", "path": path, "raw_path": path.encode(),
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

    def test_http_auth_csrf_redaction_cache_and_fixed_recipient_contract(self):
        self.assertEqual(self.http()[0], 401)
        self.worker.password_setup_required = False
        self.session.add(self.worker)
        self.session.commit()
        self.assertEqual(self.http(actor=self.worker)[0], 403)
        self.worker.password_setup_required = True
        self.session.add(self.worker)
        self.session.commit()
        self.assertEqual(self.http(actor=self.other)[0], 404)
        self.assertEqual(self.http(actor=self.supervisor, cookie=True)[0], 403)
        status, headers, body = self.http({"token": self.token, "recipient": "attacker@example.invalid"}, self.supervisor)
        self.assertEqual(status, 422)
        self.assertNotIn(self.token.encode(), body)
        self.assertIn(b"no-store", headers[b"cache-control"])
        self.smtp.assert_not_called()
        status, headers, body = self.http(actor=self.supervisor, cookie=True, csrf=True)
        self.assertEqual(status, 200)
        self.assertIn(b"no-store", headers[b"cache-control"])
        self.assertEqual(headers[b"referrer-policy"], b"no-referrer")
        self.assertNotIn(self.token.encode(), body)
        self.assertEqual(json.loads(body)["email_status"], "accepted")


if __name__ == "__main__":
    try:
        unittest.main(verbosity=2)
    finally:
        _environment.cleanup()
