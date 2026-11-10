"""Department recipient regressions: disposable SQLite, mocked SMTP, no network."""
from concurrent.futures import ThreadPoolExecutor
import json
import smtplib
import unittest
from unittest.mock import patch

import report_pdf_email_test as fixture
from fastapi import HTTPException
from pydantic import ValidationError
from sqlmodel import Session, SQLModel, select
from sqlalchemy import text
from app.migrations import run_migrations
from app.models import Department, ReportPdfEmail, User, WorkFormSubmission
from app.schemas import WorkFormEmailSettings, WorkFormSubmissionCreate, SupervisorWorkFormSubmissionUpdate
from app.use_cases import report_pdf_email as delivery
from app.use_cases.work_forms import create_work_form_submission, list_work_forms
from app.use_cases.supervisor_review import update_supervisor_form_submission


class ReportPdfRecipientsTests(unittest.TestCase):
    submit = fixture.ReportPdfEmailTests.submit

    def setUp(self):
        # Use the real additive schema, including partial replay indexes and
        # outbox constraints which metadata.create_all alone does not install.
        def migrated_fixture(engine):
            run_migrations(engine)
            # Fresh migration seeds Departments only; replace them with this
            # suite's synthetic Department fixtures before inserting any users.
            with engine.begin() as connection:
                connection.execute(text("DELETE FROM department"))
        with patch.object(SQLModel.metadata, "create_all", side_effect=migrated_fixture):
            fixture.ReportPdfEmailTests.setUp(self)
        self.worker.email = "worker@example.invalid"
        self.session.add(self.worker)
        self.default = User(id=4, department_id=1, email="default@example.invalid", name="Default", password_hash="unused")
        self.optional = User(id=5, department_id=1, email="optional@example.invalid", name="Optional", password_hash="unused")
        self.session.add_all([self.default, self.optional])
        self.session.commit()

    def settings(self, *, enabled=True, recipient="default@example.invalid", actor=None):
        fields = dict(enabled=enabled, recipient=recipient,
                      expected_version=self.form.pdf_email_version, confirmed=True)
        return delivery.update_email_settings(1, WorkFormEmailSettings(**fields),
                                             actor or self.supervisor, self.session)

    def rows(self):
        self.session.expire_all()
        return self.session.exec(select(ReportPdfEmail).order_by(ReportPdfEmail.id)).all()

    def select_recipients(self, addresses, key="selected", version=None, bindings=None):
        if bindings is None:
            users = self.session.exec(select(User)).all()
            bindings = [{"user_id": user.id, "email": user.email} for user in users
                        if user.email.strip().casefold() in {value.strip().casefold() for value in addresses}]
        return self.submit(key, pdf_email_recipients=addresses,
                           pdf_email_recipient_users=bindings,
                           expected_pdf_email_version=self.form.pdf_email_version if version is None else version)

    def test_disabled_setting_still_sends_self_without_smtp_in_request(self):
        self.submit()
        rows = self.rows()
        self.assertEqual([(r.recipient, r.recipient_role) for r in rows], [(self.worker.email, "submitter")])
        self.assertEqual(rows[0].recipient_key, self.worker.email)
        self.smtp.assert_not_called()

    def test_legacy_default_and_explicit_empty_selection(self):
        self.settings()
        legacy = self.submit("legacy")
        self_only = self.select_recipients([], "self")
        self.assertEqual({r.recipient for r in self.rows() if r.submission_id == legacy["id"]},
                         {"worker@example.invalid", "default@example.invalid"})
        self.assertEqual({r.recipient for r in self.rows() if r.submission_id == self_only["id"]},
                         {"worker@example.invalid"})

    def test_explicit_empty_selection_needs_no_current_approval_version(self):
        self.settings()
        old_version = self.form.pdf_email_version
        self.settings(recipient="optional@example.invalid")
        self.assertNotEqual(self.form.pdf_email_version, old_version)
        for key, fields in (("empty-missing", {}),
                            ("empty-stale", {"expected_pdf_email_version": old_version})):
            report = self.submit(key, pdf_email_recipients=[], **fields)
            rows = [row for row in self.rows() if row.submission_id == report["id"]]
            self.assertEqual([(row.recipient, row.recipient_role) for row in rows],
                             [("worker@example.invalid", "submitter")])
        with self.assertRaises(HTTPException) as error:
            self.submit("nonempty-stale", pdf_email_recipients=["optional@example.invalid"],
                        expected_pdf_email_version=old_version)
        self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(len(self.rows()), 2)
        self.smtp.assert_not_called()

    def test_selected_department_addresses_dedupe_self_case_and_default(self):
        self.settings()
        self.select_recipients([" optional@EXAMPLE.invalid ", "OPTIONAL@example.invalid", "WORKER@example.invalid"])
        rows = self.rows()
        self.assertEqual({r.recipient_key for r in rows}, {"optional@example.invalid", "worker@example.invalid"})
        self.assertEqual(len(rows), 2)
        self.assertEqual({r.recipient_role for r in rows}, {"submitter", "selected"})
        self.assertEqual(len({r.message_id for r in rows}), 2)
        self.assertEqual(len({r.snapshot_json for r in rows}), 1)

    def test_directory_is_dynamic_and_independent_of_default_toggle(self):
        self.settings(enabled=False, recipient="")
        template = list_work_forms(self.worker, self.session)[0]
        self.assertNotIn("pdf_email", template)
        options = template["pdf_email_options"]
        self.assertFalse(options["enabled"])
        self.assertEqual(options["source"], "department_users")
        self.assertIn("optional@example.invalid", options["recipients"])
        self.assertIn("default@example.invalid", options["recipients"])
        self.assertEqual(options["default_recipients"], [])
        self.assertEqual(options["version"], self.form.pdf_email_version)
        self.assertEqual(options["max_selected_recipients"], 20)
        self.select_recipients([self.optional.email])
        self.assertEqual(len(self.rows()), 2)

    def test_unbound_missing_stale_and_resigned_selection_are_atomic(self):
        self.settings()
        version = self.form.pdf_email_version
        cases = [dict(pdf_email_recipients=["arbitrary@example.invalid"], expected_pdf_email_version=version),
                 dict(pdf_email_recipients=["optional@example.invalid"]),
                 dict(pdf_email_recipients=["optional@example.invalid"], expected_pdf_email_version=version - 1)]
        for fields in cases:
            with self.assertRaises(HTTPException) as error:
                self.submit(**fields)
            self.assertEqual(error.exception.status_code, 409)
            self.assertIn("report_email_recipients_conflict", str(error.exception.detail))
            self.assertEqual(self.rows(), [])
            self.assertEqual(self.session.exec(select(WorkFormSubmission)).all(), [])
        self.optional.status = "resigned"
        self.session.add(self.optional)
        self.session.commit()
        with self.assertRaises(HTTPException):
            self.select_recipients(["optional@example.invalid"])
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.session.exec(select(WorkFormSubmission)).all(), [])

    def test_default_settings_permissions_validation_and_selection_bounds(self):
        for actor, status in ((self.worker, 403), (self.foreign, 404)):
            with self.assertRaises(HTTPException) as error:
                self.settings(actor=actor)
            self.assertEqual(error.exception.status_code, status)
        for invalid in ["not-mail", "a@example.invalid\r\nBcc: b@example.invalid"]:
            with self.assertRaises((HTTPException, ValidationError)):
                self.settings(recipient=invalid)
        with self.assertRaises(ValidationError):
            WorkFormEmailSettings(enabled=True, expected_version=1, approved_recipients=[self.optional.email])
        with self.assertRaises(HTTPException):
            self.settings(recipient=self.foreign.email)
        with self.assertRaises(ValidationError):
            WorkFormSubmissionCreate(form_id=1, work_date="2026-10-21",
                                     pdf_email_recipients=[f"r{i}@example.invalid" for i in range(21)])
        self.assertEqual(self.rows(), [])

    def test_independent_envelopes_partial_failure_no_retry_or_recipient_disclosure(self):
        self.settings()
        report = self.select_recipients(["optional@example.invalid", "default@example.invalid"])
        def send(message, **kwargs):
            recipient = kwargs["to_addrs"]
            self.assertEqual(len(recipient), 1)
            self.assertEqual(str(message["To"]), recipient[0])
            self.assertIsNone(message["Cc"])
            self.assertIsNone(message["Bcc"])
            if recipient == ["optional@example.invalid"]:
                raise smtplib.SMTPRecipientsRefused({recipient[0]: (550, b"private detail")})
            return {}
        self.client.send_message.side_effect = send
        outcome = delivery.dispatch_pending(self.engine)
        self.assertEqual(outcome["accepted"], 2)
        self.assertEqual(outcome["failed"], 1)
        self.assertEqual(self.client.send_message.call_count, 3)
        status = delivery.email_status(report["id"], self.session)
        self.assertEqual(status["status"], "partial")
        self.assertEqual(status["count"], 3)
        self.assertEqual(len(status["deliveries"]), 3)
        self.assertNotIn("private detail", json.dumps(status))
        self.assertEqual(delivery.dispatch_pending(self.engine)["accepted"], 0)
        self.assertEqual(self.client.send_message.call_count, 3)
        self.assertEqual(len({call.args[0]["Message-ID"] for call in self.client.send_message.call_args_list}), 3)

    def test_replay_account_settings_changes_and_corrections_never_redirect_or_resend(self):
        self.settings()
        report = self.select_recipients(["optional@example.invalid"])
        before = [(r.id, r.recipient, r.message_id, r.snapshot_json) for r in self.rows()]
        self.worker.email = "changed@example.invalid"
        self.session.add(self.worker)
        self.session.commit()
        self.settings(recipient=self.supervisor.email)
        replay = self.select_recipients(["unapproved@example.invalid"], version=1)
        self.assertEqual(replay["id"], report["id"])
        self.assertTrue(replay["idempotent_replay"])
        update_supervisor_form_submission(report["id"], SupervisorWorkFormSubmissionUpdate(
            expected_revision=report["revision"], confirmed=True, answers={"issue": "Corrected"}),
            self.supervisor, self.session)
        self.assertEqual([(r.id, r.recipient, r.message_id, r.snapshot_json) for r in self.rows()], before)
        self.assertEqual(delivery.dispatch_pending(self.engine)["accepted"], 2)
        self.assertEqual({c.kwargs["to_addrs"][0] for c in self.client.send_message.call_args_list},
                         {"worker@example.invalid", "optional@example.invalid"})

    def test_concurrent_dispatch_each_recipient_claimed_once(self):
        self.settings()
        self.submit()
        ids = [r.id for r in self.rows()]
        self.session.rollback()
        with patch("app.use_cases.report_pdf.build_report_pdf", return_value=b"%PDF-synthetic"):
            with ThreadPoolExecutor(max_workers=4) as pool:
                outcomes = list(pool.map(lambda row_id: delivery.dispatch_one(self.engine, row_id), ids * 2))
        self.assertCountEqual(outcomes, ["accepted", "accepted", "skipped", "skipped"])
        self.assertEqual(self.client.send_message.call_count, 2)

    def test_aggregate_status_priority_and_legacy_keys(self):
        self.settings()
        report = self.submit()
        rows = self.rows()
        for states, expected in [(("accepted", "failed"), "partial"),
                                 (("failed", "pending"), "pending"),
                                 (("pending", "uncertain"), "uncertain"),
                                 (("accepted", "accepted"), "accepted"),
                                 (("failed", "failed"), "failed")]:
            for row, status in zip(rows, states):
                row.status = status
                self.session.add(row)
            self.session.commit()
            result = delivery.email_status(report["id"], self.session)
            self.assertEqual(result["status"], expected)
            self.assertTrue({"recipient", "failure_code", "attempted_at", "accepted_at"} <= result.keys())
            self.assertEqual(result["count"], 2)

    def test_concurrent_submission_replay_queues_one_set(self):
        self.settings()
        version = self.form.pdf_email_version
        worker_id = self.worker.id
        self.session.rollback()
        def submit_once(_):
            from app.models import User
            with Session(self.engine) as session:
                worker = session.get(User, worker_id)
                return create_work_form_submission(WorkFormSubmissionCreate(
                    form_id=1, expected_definition_version=1, work_date="2026-10-21",
                    client_submission_id="concurrent-key", answers={"issue": "Same report"},
                    pdf_email_recipients=["optional@example.invalid"], expected_pdf_email_version=version,
                    pdf_email_recipient_users=[{"user_id": 5, "email": "optional@example.invalid"}]),
                    worker, session, include_replay_marker=True)
        with ThreadPoolExecutor(max_workers=2) as pool:
            reports = list(pool.map(submit_once, range(2)))
        self.assertEqual(reports[0]["id"], reports[1]["id"])
        self.assertEqual(len(self.rows()), 2)
        self.assertEqual(len(self.session.exec(select(WorkFormSubmission)).all()), 1)
        self.smtp.assert_not_called()

    def test_directory_includes_all_activated_department_accounts_without_truncation(self):
        self.session.add_all([User(department_id=1, email=f"person{i}@example.invalid", name=f"Person {i}",
                                   password_hash="unused") for i in range(35)])
        self.session.add_all([
            User(department_id=1, email="invited@example.invalid", name="Invited", password_hash="unused", password_setup_required=True),
            User(department_id=1, email="resigned@example.invalid", name="Resigned", password_hash="unused", status="resigned"),
            User(department_id=None, email="unscoped@example.invalid", name="Unscoped", password_hash="unused"),
            User(department_id=1, email="malformed", name="Invalid", password_hash="unused"),
        ])
        self.session.commit()
        options = list_work_forms(self.worker, self.session)[0]["pdf_email_options"]
        self.assertEqual(len(options["recipient_users"]), 39)
        self.assertEqual(len(options["recipients"]), 39)
        self.assertEqual({row["user_id"] for row in options["recipient_users"]},
                         {row.id for row in self.session.exec(select(User)).all()
                          if row.department_id == 1 and row.status == "active" and not row.password_setup_required and "@" in row.email})
        for excluded in (self.foreign.email, "invited@example.invalid", "resigned@example.invalid", "unscoped@example.invalid"):
            self.assertNotIn(excluded, options["recipients"])
        self.assertEqual(set(options["recipient_users"][0]), {"user_id", "email", "name"})
        self.select_recipients([f"person{i}@example.invalid" for i in range(20)])
        self.assertEqual(len(self.rows()), 21)  # 20 optional destinations plus the mandatory account copy.

    def test_selected_user_changes_reject_stale_choices_atomically(self):
        for field, value in (("status", "resigned"), ("department_id", 2), ("department_id", None),
                             ("email", "new-address@example.invalid"), ("password_setup_required", True)):
            with self.subTest(field=field, value=value):
                previous = getattr(self.optional, field)
                bindings = [{"user_id": self.optional.id, "email": self.optional.email}]
                setattr(self.optional, field, value)
                self.session.add(self.optional)
                self.session.commit()
                with self.assertRaises(HTTPException) as error:
                    self.select_recipients(["optional@example.invalid"], bindings=bindings)
                self.assertEqual(error.exception.status_code, 409)
                self.assertEqual(self.rows(), [])
                self.assertEqual(self.session.exec(select(WorkFormSubmission)).all(), [])
                setattr(self.optional, field, previous)
                self.session.add(self.optional)
                self.session.commit()

    def test_same_email_reassignment_never_retargets_saved_user_binding(self):
        original_email = self.optional.email
        original_id = self.optional.id
        self.optional.email = "moved@example.invalid"
        self.session.add(self.optional)
        self.session.commit()
        replacement = User(department_id=1, email=original_email, name="Different person", password_hash="unused")
        self.session.add(replacement)
        self.session.commit()
        with self.assertRaises(HTTPException) as error:
            self.select_recipients([original_email], bindings=[{"user_id": original_id, "email": original_email}])
        self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(self.rows(), [])
        self.select_recipients([original_email], bindings=[{"user_id": replacement.id, "email": original_email}])
        self.assertEqual(len(self.rows()), 2)

    def test_cross_department_missing_extra_and_mismatched_bindings_rejected(self):
        cases = [([self.optional.email], []),
                 ([self.optional.email], [{"user_id": self.default.id, "email": self.optional.email}]),
                 ([self.optional.email], [{"user_id": self.optional.id, "email": self.default.email}]),
                 ([], [{"user_id": self.optional.id, "email": self.optional.email}]),
                 ([self.foreign.email], [{"user_id": self.foreign.id, "email": self.foreign.email}]),
                 ([self.optional.email, self.default.email], [{"user_id": self.optional.id, "email": self.optional.email},
                                                             {"user_id": self.optional.id, "email": self.default.email}]),
                 ([self.optional.email], [{"user_id": self.optional.id, "email": self.optional.email},
                                          {"user_id": self.default.id, "email": self.optional.email}])]
        for addresses, bindings in cases:
            with self.subTest(addresses=addresses, bindings=bindings):
                with self.assertRaises(HTTPException) as error:
                    self.select_recipients(addresses, bindings=bindings)
                self.assertEqual(error.exception.status_code, 409)
                self.assertEqual(self.rows(), [])
                self.assertEqual(self.session.exec(select(WorkFormSubmission)).all(), [])

    def test_options_refresh_account_changes_without_template_version_change(self):
        before = self.form.pdf_email_version
        original_options = list_work_forms(self.worker, self.session)[0]["pdf_email_options"]
        self.assertIn("optional@example.invalid", original_options["recipients"])
        self.optional.email = "updated@example.invalid"
        self.optional.name = "Updated person"
        self.session.add(self.optional)
        self.session.commit()
        options = list_work_forms(self.worker, self.session)[0]["pdf_email_options"]
        self.assertEqual(options["version"], before)
        self.assertNotIn("optional@example.invalid", options["recipients"])
        self.assertIn({"user_id": self.optional.id, "name": "Updated person", "email": "updated@example.invalid"},
                      options["recipient_users"])
        # Same Session, separate requests: directory reuse never survives a list
        # response or leaks into the post-mutation settings serializer.
        updated = self.settings(recipient="updated@example.invalid")
        self.assertEqual(updated["pdf_email_options"]["default_recipients"], ["updated@example.invalid"])
        self.assertNotIn("optional@example.invalid", updated["pdf_email_options"]["recipients"])
        self.assertIn("optional@example.invalid", original_options["recipients"])

    def test_obsolete_default_is_visible_and_not_silently_sent_or_cleared(self):
        self.settings()
        saved = self.form.pdf_email_recipient
        self.default.status = "resigned"
        self.session.add(self.default)
        self.session.commit()
        options = list_work_forms(self.worker, self.session)[0]["pdf_email_options"]
        self.assertTrue(options["default_recipient_unavailable"])
        self.assertEqual(options["default_recipients"], [])
        self.assertNotIn(saved, options["recipients"])
        with self.assertRaises(HTTPException) as error:
            self.submit()
        self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.form.pdf_email_recipient, saved)
        self.select_recipients([], key="deliberate-self")
        self.settings(enabled=False)  # Deliberate disable can retain the obsolete setting.
        self.assertEqual(self.form.pdf_email_recipient, saved)
        self.submit("disabled-legacy")
        self.assertEqual(len(self.rows()), 2)

    def test_no_session_or_no_department_never_returns_accounts(self):
        from app.use_cases.report_pdf_recipients import email_options
        self.assertEqual(email_options(self.form, None)["recipient_users"], [])
        self.form.department_id = None
        self.assertEqual(email_options(self.form, self.session)["recipient_users"], [])

    def test_stale_session_cannot_freeze_old_recipient_or_author_email(self):
        old_email = self.optional.email
        with Session(self.engine) as other:
            recipient = other.get(User, self.optional.id)
            recipient.email = "concurrent-change@example.invalid"
            author = other.get(User, self.worker.id)
            author.email = "current-author@example.invalid"
            other.add_all([recipient, author])
            other.commit()
        with self.assertRaises(HTTPException):
            self.select_recipients([old_email], bindings=[{"user_id": self.optional.id, "email": old_email}])
        self.select_recipients([], key="new-author-email")
        self.assertEqual(self.rows()[0].recipient, "current-author@example.invalid")

    def test_inactive_department_offers_no_directory_and_rejects_selected_accounts(self):
        department = self.session.get(Department, 1)
        department.status = "archived"
        self.session.add(department)
        self.session.commit()
        options = list_work_forms(self.worker, self.session)[0]["pdf_email_options"]
        self.assertEqual(options["recipient_users"], [])
        with self.assertRaises(HTTPException) as error:
            self.select_recipients([self.optional.email])
        self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(self.rows(), [])

    def test_orphan_binding_does_not_enable_implicit_default(self):
        with self.assertRaises(HTTPException) as error:
            self.submit(pdf_email_recipient_users=[{"user_id": self.optional.id, "email": self.optional.email}])
        self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(self.rows(), [])

    def test_blank_account_email_keeps_failed_delivery_on_migrated_schema(self):
        for index, address in enumerate(("", "   ")):
            self.worker.email = address
            self.session.add(self.worker)
            self.session.commit()
            report = self.submit(f"blank-{index}")
            row = next(r for r in self.rows() if r.submission_id == report["id"])
            self.assertEqual((row.status, row.failure_code), ("failed", "invalid_recipient"))
            self.assertTrue(row.recipient_key)
        self.assertEqual(len(self.session.exec(select(WorkFormSubmission)).all()), 2)
        self.assertEqual(delivery.dispatch_pending(self.engine)["accepted"], 0)
        self.smtp.assert_not_called()

    def test_invalid_account_email_keeps_report_and_failed_self_copy(self):
        self.worker.email = "invalid-account-address"
        self.session.add(self.worker)
        self.session.commit()
        report = self.submit()
        self.assertIsNotNone(self.session.get(WorkFormSubmission, report["id"]))
        self.assertEqual(len(self.rows()), 1)
        row = self.rows()[0]
        self.assertEqual((row.status, row.failure_code), ("failed", "invalid_recipient"))
        self.assertEqual(delivery.dispatch_pending(self.engine)["accepted"], 0)
        self.smtp.assert_not_called()


if __name__ == "__main__":
    unittest.main()
