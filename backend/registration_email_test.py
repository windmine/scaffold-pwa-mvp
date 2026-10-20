"""SMTP policy tests: synthetic credentials, mocked transport, no network."""

import asyncio
import os
from pathlib import Path
import runpy
import smtplib
import ssl
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi import HTTPException

from app import main as application
from app.use_cases import registration


class RegistrationEmailTests(unittest.TestCase):
    def setUp(self):
        settings = {
            "PRODUCTION_LIKE": True,
            "REGISTRATION_EMAIL_ENABLED": True,
            "SMTP_HOST": "mail.invalid", "SMTP_PORT": 587,
            "SMTP_USERNAME": "sender@example.invalid",
            "SMTP_PASSWORD": "synthetic-test-password",
            "SMTP_FROM_EMAIL": "sender@example.invalid",
            "SMTP_USE_SSL": False, "SMTP_USE_STARTTLS": True,
        }
        for name, value in settings.items():
            self.enterContext(patch.object(registration, name, value))
        self.enterContext(patch("socket.create_connection", side_effect=AssertionError("Network forbidden")))
        self.smtp = self.enterContext(patch.object(registration.smtplib, "SMTP"))
        self.smtp_ssl = self.enterContext(patch.object(registration.smtplib, "SMTP_SSL"))

    def assert_unavailable(self, callback):
        with self.assertRaises(HTTPException) as caught:
            callback()
        self.assertEqual(caught.exception.status_code, 503)
        self.assertNotIn("synthetic-test-password", str(caught.exception.detail))
        return caught.exception

    def send(self):
        registration.send_verification_email("worker@example.invalid", "123456")

    def assert_verified_context(self, context):
        self.assertIsInstance(context, ssl.SSLContext)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)

    def test_registration_email_defaults_off_in_all_environments(self):
        original_exists = Path.exists
        for environment in ({}, {"APP_ENV": "production"}, {"K_SERVICE": "synthetic-service"}):
            with self.subTest(environment=environment), patch.dict(os.environ, {
                "DATABASE_URL": "sqlite://", "GEO_SECRET_KEY": "synthetic-config-secret-for-local-tests-only",
                **environment,
            }, clear=True), patch.object(Path, "exists", lambda path: (
                path.name not in {".env", ".env.local"} and original_exists(path)
            )):
                config = runpy.run_path(str(Path(__file__).parent / "app/config.py"))
                self.assertFalse(config["REGISTRATION_EMAIL_ENABLED"])

    def test_disabled_production_rejects_before_database_or_smtp(self):
        registration.REGISTRATION_EMAIL_ENABLED = False
        session = MagicMock()
        self.assert_unavailable(lambda: registration.start_registration(
            SimpleNamespace(email="worker@example.invalid", name="Worker"), session,
        ))
        self.assertEqual(session.mock_calls, [])
        self.assert_unavailable(self.send)
        self.smtp.assert_not_called()
        self.smtp_ssl.assert_not_called()

    def test_public_http_registration_stays_disabled_with_credentials_configured(self):
        registration.REGISTRATION_EMAIL_ENABLED = False
        session = MagicMock()
        original = application.app.dependency_overrides.copy()
        application.app.dependency_overrides[application.get_session] = lambda: session
        try:
            async def request():
                # In-process ASGI call: no network or startup/storage probes.
                messages = []

                async def receive():
                    return {"type": "http.request", "more_body": False,
                            "body": b'{"email":"worker@example.invalid","name":"Worker"}'}

                async def send(message):
                    messages.append(message)

                await application.app({
                    "type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"},
                    "http_version": "1.1", "method": "POST", "scheme": "http",
                    "path": "/auth/registration/start", "raw_path": b"/auth/registration/start",
                    "query_string": b"", "root_path": "",
                    "headers": [(b"content-type", b"application/json")],
                    "client": ("127.0.0.1", 12345), "server": ("test.invalid", 80),
                }, receive, send)
                return next(message["status"] for message in messages if message["type"] == "http.response.start")
            status = asyncio.run(request())
        finally:
            application.app.dependency_overrides.clear()
            application.app.dependency_overrides.update(original)
        self.assertEqual(status, 503)
        self.assertEqual(session.mock_calls, [])
        self.smtp.assert_not_called()
        self.smtp_ssl.assert_not_called()

    def test_disabled_development_retains_no_send_code_flow(self):
        registration.PRODUCTION_LIKE = False
        registration.REGISTRATION_EMAIL_ENABLED = False
        self.assertFalse(registration.registration_email_ready())
        self.send()
        self.smtp.assert_not_called()
        self.smtp_ssl.assert_not_called()

    def test_missing_sender_configuration_never_connects(self):
        for name in ("SMTP_HOST", "SMTP_FROM_EMAIL"):
            with self.subTest(name=name), patch.object(registration, name, ""):
                self.assert_unavailable(self.send)
        self.smtp.assert_not_called()
        self.smtp_ssl.assert_not_called()

    def test_plaintext_configuration_rejected_before_database_or_authentication(self):
        registration.SMTP_USE_STARTTLS = False
        session = MagicMock()
        self.assert_unavailable(self.send)
        self.assert_unavailable(lambda: registration.start_registration(
            SimpleNamespace(email="worker@example.invalid", name="Worker"), session,
        ))
        self.assertEqual(session.mock_calls, [])
        self.smtp.assert_not_called()
        self.smtp_ssl.assert_not_called()

    def test_starttls_verifies_certificate_before_authentication_and_send(self):
        self.send()
        client = self.smtp.return_value.__enter__.return_value
        self.assert_verified_context(client.starttls.call_args.kwargs["context"])
        self.assertEqual([call[0] for call in client.method_calls], ["starttls", "login", "send_message"])
        client.login.assert_called_once_with("sender@example.invalid", "synthetic-test-password")
        message = client.send_message.call_args.args[0]
        self.assertEqual(message["To"], "worker@example.invalid")
        self.assertEqual(message["From"], "sender@example.invalid")
        self.assertIn("123456", message.get_content())
        self.smtp_ssl.assert_not_called()

    def test_implicit_tls_also_verifies_certificate(self):
        registration.SMTP_USE_SSL = True
        registration.SMTP_PORT = 465
        self.send()
        self.assert_verified_context(self.smtp_ssl.call_args.kwargs["context"])
        client = self.smtp_ssl.return_value.__enter__.return_value
        client.starttls.assert_not_called()
        client.login.assert_called_once()
        client.send_message.assert_called_once()
        self.smtp.assert_not_called()

    def test_starttls_failure_never_falls_back_to_authentication_or_send(self):
        for failure in (ssl.SSLCertVerificationError("synthetic invalid certificate"),
                        smtplib.SMTPNotSupportedError("synthetic missing STARTTLS")):
            with self.subTest(failure=type(failure).__name__):
                client = self.smtp.return_value.__enter__.return_value
                client.reset_mock()
                client.starttls.side_effect = failure
                self.assert_unavailable(self.send)
                client.login.assert_not_called()
                client.send_message.assert_not_called()
        self.smtp_ssl.assert_not_called()

    def test_implicit_tls_certificate_failure_never_falls_back(self):
        registration.SMTP_USE_SSL = True
        self.smtp_ssl.side_effect = ssl.SSLCertVerificationError("synthetic invalid certificate")
        self.assert_unavailable(self.send)
        self.smtp.assert_not_called()
        self.smtp_ssl.return_value.__enter__.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
