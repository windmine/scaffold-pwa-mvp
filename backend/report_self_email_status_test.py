"""Self-copy status contract: disposable SQLite only; SMTP and sockets mocked."""
import json
import unittest
from unittest.mock import Mock

import report_pdf_email_test as fixture
from app.models import ReportPdfEmail, User, WorkFormSubmission
from app.schemas import WorkFormSubmissionCreate
from app.use_cases import report_pdf_email as delivery
from app.use_cases.common import review_record_response, work_form_submission_response
from app.use_cases.work_forms import (
    create_work_form_submission, find_my_report_submission_by_client_id,
    list_my_form_submissions,
)


class ReportSelfEmailStatusTests(unittest.TestCase):
    setUp = fixture.ReportPdfEmailTests.setUp
    submit = fixture.ReportPdfEmailTests.submit
    row = fixture.ReportPdfEmailTests.row

    def record(self):
        return self.session.get(WorkFormSubmission, self.submit()["id"])

    def test_create_history_recovery_replay_have_only_self_status(self):
        first = self.submit()
        row = self.row()
        frozen = row.snapshot_json
        for status in ("pending", "accepted", "failed", "uncertain"):
            row.status = status
            row.failure_code = "private transport detail"
            self.session.add(row)
            self.session.commit()
            responses = [self.submit(), list_my_form_submissions(self.worker, self.session, "report")[0],
                         find_my_report_submission_by_client_id("stable-offline-id", self.worker,
                                                               self.session, "report")["submission"]]
            for response in responses:
                self.assertEqual(response["pdf_email_self"], {"status": status})
                self.assertNotIn("pdf_email", response)
                self.assertNotIn("private transport detail", json.dumps(response))
            self.assertTrue(responses[0]["idempotent_replay"])
        self.assertEqual(first["pdf_email_self"], {"status": "pending"})
        self.assertEqual(self.row().snapshot_json, frozen)
        self.assertNotIn("pdf_email_self", json.loads(frozen))
        self.smtp.assert_not_called()

    def test_other_envelopes_and_changed_account_email_do_not_change_self_status(self):
        record = self.record()
        own = self.row()
        self.session.add(ReportPdfEmail(submission_id=record.id, department_id=1,
            recipient="changed@example.invalid", recipient_key="changed@example.invalid", recipient_role="selected",
            template_email_version=1, snapshot_json=own.snapshot_json, status="failed",
            failure_code="private", message_id="private-id"))
        self.worker.email = "changed@example.invalid"
        self.session.add(self.worker)
        self.session.commit()
        self.assertEqual(delivery.self_email_status(record, self.worker, self.session), {"status": "pending"})
        supervisor = review_record_response("form", record, self.session)["pdf_email"]
        self.assertEqual(supervisor["count"], 2)
        self.assertEqual(len(supervisor["deliveries"]), 2)
        self.assertNotIn("pdf_email_self", work_form_submission_response(record, self.session))

    def test_missing_legacy_self_copy_is_unknown_not_inferred_from_template(self):
        record = self.record()
        row = self.row()
        row.recipient_role = "template"
        row.status = "accepted"
        self.session.add(row)
        self.session.commit()
        self.assertEqual(delivery.self_email_status(record, self.worker, self.session), {"status": "unknown"})
        self.session.delete(row)
        self.session.commit()
        self.assertEqual(delivery.self_email_status(record, self.worker, self.session), {"status": "unknown"})

    def test_invalid_or_ambiguous_status_fails_closed(self):
        record = self.record()
        for rows in (["unexpected"], ["pending", "accepted"], []):
            session = Mock()
            session.exec.return_value.all.return_value = rows
            self.assertEqual(delivery.self_email_status(record, self.worker, session), {"status": "unknown"})

    def test_worker_and_department_isolation(self):
        record = self.record()
        another = User(id=8, department_id=1, email="another@example.invalid", name="Another", password_hash="unused")
        self.session.add(another)
        self.session.commit()
        self.assertEqual(list_my_form_submissions(another, self.session, "report"), [])
        self.assertEqual(find_my_report_submission_by_client_id("stable-offline-id", another,
            self.session, "report")["status"], "not_found")
        self.assertEqual(delivery.self_email_status(record, another, self.session), {"status": "unknown"})
        self.worker.department_id = 2
        self.assertEqual(delivery.self_email_status(record, self.worker, self.session), {"status": "unknown"})
        self.worker.department_id = 1
        row = self.row()
        row.department_id = 2
        self.session.add(row)
        self.session.commit()
        self.assertEqual(delivery.self_email_status(record, self.worker, self.session), {"status": "unknown"})

    def test_supervisor_own_copy_and_invalid_legacy_address(self):
        data = WorkFormSubmissionCreate(form_id=1, expected_definition_version=1,
            work_date="2026-10-21", client_submission_id="supervisor-own", answers={"issue": "synthetic"})
        response = create_work_form_submission(data, self.supervisor, self.session, supervisor_self=True)
        self.assertEqual(response["pdf_email_self"], {"status": "pending"})
        self.assertNotIn("pdf_email", response)
        self.worker.email = "invalid"
        self.session.add(self.worker)
        self.session.commit()
        self.assertEqual(self.submit()["pdf_email_self"], {"status": "failed"})
        self.smtp.assert_not_called()


if __name__ == "__main__":
    unittest.main()
