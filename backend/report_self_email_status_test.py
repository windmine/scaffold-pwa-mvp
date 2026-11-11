"""Self-copy status contract: disposable SQLite only; SMTP and sockets mocked."""
import json
import unittest
from unittest.mock import Mock

import report_pdf_email_test as fixture
from sqlalchemy import event
from sqlmodel import Session, select
from app.models import ReportPdfEmail, User, WorkFormSubmission
from app.schemas import WorkFormSubmissionCreate
from app.use_cases import report_pdf_email as delivery
from app.use_cases.common import (
    review_record_response, work_form_definition_snapshot_json, work_form_submission_response,
)
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

    def synthetic_record(self, record_id, **options):
        return WorkFormSubmission(id=record_id, form_id=1, worker_id=options.pop("worker_id", 1),
            department_id=options.pop("department_id", 1), answers_json='{"issue":"synthetic"}',
            definition_snapshot_json=work_form_definition_snapshot_json(self.form), **options)

    def envelope(self, record_id, status="pending", role="submitter", suffix="own", department_id=1):
        address = f"private-{record_id}-{suffix}@example.invalid"
        return ReportPdfEmail(submission_id=record_id, department_id=department_id,
            recipient=address, recipient_key=address, recipient_role=role, status=status,
            template_email_version=1, snapshot_json='{"private":"frozen snapshot"}',
            failure_code="private transport detail", message_id=f"private-{record_id}-{suffix}")

    def test_history_status_queries_are_bounded_and_private(self):
        previous = 0
        expected = {}
        for count, query_count in ((25, 1), (100, 1), (501, 2), (1001, 3)):
            with self.subTest(reports=count):
                for record_id in range(previous + 1, count + 1):
                    status = ("pending", "accepted", "failed", "uncertain")[record_id % 4]
                    expected[record_id] = {"status": status}
                    self.session.add_all([self.synthetic_record(record_id),
                        self.envelope(record_id, status),
                        self.envelope(record_id, "failed", "selected", "other")])
                self.session.commit()
                previous = count
                statements = []

                def record_query(_connection, _cursor, statement, _parameters, _context, _many):
                    statements.append(statement)

                # Fresh sessions prevent an identity-map warmup from hiding queries.
                with Session(self.engine) as session:
                    worker = session.get(User, 1)
                    event.listen(self.engine, "before_cursor_execute", record_query)
                    try:
                        history = list_my_form_submissions(worker, session, "report")
                    finally:
                        event.remove(self.engine, "before_cursor_execute", record_query)
                email_queries = [statement for statement in statements if "FROM reportpdfemail" in statement]
                self.assertEqual(len(email_queries), query_count)
                self.assertLessEqual(len(statements), 3 * count + 8)
                for statement in email_queries:
                    projection = " ".join(statement.split("FROM")[0].split())
                    self.assertEqual(projection, "SELECT reportpdfemail.submission_id, reportpdfemail.status")
                self.assertEqual({item["id"]: item["pdf_email_self"] for item in history}, expected)
                self.assertTrue(all("pdf_email" not in item for item in history))
                self.assertNotIn("private-", json.dumps(history))
                self.assertNotIn("private transport detail", json.dumps(history))
                self.assertNotIn("frozen snapshot", json.dumps(history))
        self.smtp.assert_not_called()

    def test_batch_matches_single_status_with_legacy_ambiguity_and_scope(self):
        records = [self.synthetic_record(record_id) for record_id in range(1, 10)]
        records += [self.synthetic_record(10, worker_id=3),
                    self.synthetic_record(11, department_id=2),
                    self.synthetic_record(12, submission_purpose="daywork")]
        self.session.add_all(records)
        for record_id, status in enumerate(("pending", "accepted", "failed", "uncertain"), 1):
            self.session.add(self.envelope(record_id, status))
        # 5 has no envelope; 6 has only a legacy template/selected envelope.
        self.session.add_all([
            self.envelope(6, "accepted", "template"),
            self.envelope(6, "failed", "selected", "other"),
            self.envelope(7, "accepted"), self.envelope(7, "accepted", suffix="duplicate"),
            self.envelope(8, "pending"), self.envelope(8, "accepted", suffix="duplicate"),
            self.envelope(8, "uncertain", suffix="third"),
            self.envelope(9, "accepted", department_id=2),
            self.envelope(10, "accepted"), self.envelope(11, "accepted", department_id=2),
            self.envelope(12, "accepted"),
        ])
        # A newly matching selected address must not become the frozen self-copy.
        self.worker.email = "private-6-other@example.invalid"
        self.session.add(self.worker)
        self.session.commit()
        records = self.session.exec(select(WorkFormSubmission)).all()
        expected = {record.id: {"status": "unknown"} for record in records}
        expected.update({record_id: {"status": status}
            for record_id, status in enumerate(("pending", "accepted", "failed", "uncertain"), 1)})
        self.assertEqual(delivery.self_email_statuses(records, self.worker, self.session), expected)
        for record in records:
            self.assertEqual(delivery.self_email_status(record, self.worker, self.session), expected[record.id])
        history = list_my_form_submissions(self.worker, self.session)
        self.assertNotIn(10, {item["id"] for item in history})
        for item in history:
            if item["submission_purpose"] == "report":
                self.assertEqual(item["pdf_email_self"], expected[item["id"]])
            else:
                self.assertNotIn("pdf_email_self", item)
        self.smtp.assert_not_called()

    def test_empty_and_unauthorized_batches_do_not_query_outbox(self):
        session = Mock()
        self.assertEqual(delivery.self_email_statuses([], self.worker, session), {})
        records = [self.synthetic_record(1, worker_id=3),
                   self.synthetic_record(2, department_id=2),
                   self.synthetic_record(3, submission_purpose="daywork")]
        self.assertEqual(delivery.self_email_statuses(records, self.worker, session),
                         {record.id: {"status": "unknown"} for record in records})
        session.exec.assert_not_called()

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
        for rows in (["unexpected"], ["pending", "accepted"], ["accepted", "accepted"],
                     ["pending", "accepted", "uncertain"], []):
            session = Mock()
            session.exec.return_value.all.return_value = [(record.id, status) for status in rows]
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
        history = list_my_form_submissions(self.supervisor, self.session, "report")
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["pdf_email_self"], response["pdf_email_self"])
        self.worker.email = "invalid"
        self.session.add(self.worker)
        self.session.commit()
        self.assertEqual(self.submit()["pdf_email_self"], {"status": "failed"})
        self.smtp.assert_not_called()


if __name__ == "__main__":
    unittest.main()
