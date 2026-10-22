import json
import sys
import tempfile
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select


sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.models import (  # noqa: E402
    AuditEvent,
    Department,
    Site,
    User,
    WorkForm,
    WorkFormSubmission,
)
from app.schemas import (  # noqa: E402
    ReportTransitionRequest,
    SupervisorWorkFormSubmissionUpdate,
    WorkFormCreate,
    WorkFormField,
    WorkFormSubmissionCreate,
    WorkFormUpdate,
)
from app.use_cases.supervisor_review import update_supervisor_form_submission  # noqa: E402
from app.use_cases.work_forms import (  # noqa: E402
    create_work_form,
    create_work_form_submission,
    list_my_form_submissions,
    list_supervisor_form_submissions,
    transition_report,
    update_work_form,
)


def assert_http_error(label, status_code, callback):
    try:
        callback()
    except HTTPException as error:
        if error.status_code != status_code:
            raise AssertionError(
                f"{label}: expected {status_code}, got {error.status_code}"
            ) from error
    else:
        raise AssertionError(f"{label}: expected HTTP {status_code}")


def seed_report_database(engine):
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        department = Department(name="Report Department")
        other_department = Department(name="Other Department")
        session.add(department)
        session.add(other_department)
        session.flush()
        first_supervisor = User(
            department_id=department.id,
            email="first-reviewer@example.com",
            name="First Reviewer",
            password_hash="test",
            role="supervisor",
        )
        second_supervisor = User(
            department_id=department.id,
            email="second-reviewer@example.com",
            name="Second Reviewer",
            password_hash="test",
            role="supervisor",
        )
        other_supervisor = User(
            department_id=other_department.id,
            email="other-reviewer@example.com",
            name="Other Reviewer",
            password_hash="test",
            role="supervisor",
        )
        worker = User(
            department_id=department.id,
            email="report-worker@example.com",
            name="Report Worker",
            password_hash="test",
            role="worker",
        )
        session.add(first_supervisor)
        session.add(second_supervisor)
        session.add(other_supervisor)
        session.add(worker)
        session.flush()
        site = Site(
            department_id=department.id,
            name="North Yard",
            latitude=-36.8,
            longitude=174.7,
        )
        form = WorkForm(
            department_id=department.id,
            name="PPE Issue Report",
            fields_json="[]",
            status="active",
            created_by=first_supervisor.id,
        )
        session.add(site)
        session.add(form)
        session.flush()
        report = WorkFormSubmission(
            department_id=department.id,
            form_id=form.id,
            worker_id=worker.id,
            site_id=site.id,
            work_date="2026-09-01",
            answers_json=json.dumps(
                {
                    "issue": "Missing helmet",
                    "worker_signature": "/uploads/worker-signature.png",
                }
            ),
            photo_urls=json.dumps(["/uploads/ppe-evidence.png"]),
            workflow_status="submitted",
            status="pending",
        )
        session.add(report)
        session.commit()
        return {
            "department_id": department.id,
            "first_supervisor_id": first_supervisor.id,
            "second_supervisor_id": second_supervisor.id,
            "other_supervisor_id": other_supervisor.id,
            "report_id": report.id,
        }


def seed_report_access_database(engine):
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        home_department = Department(name="Home Reports")
        other_department = Department(name="Other Reports")
        session.add(home_department)
        session.add(other_department)
        session.flush()
        home_supervisor = User(
            department_id=home_department.id,
            email="home-supervisor@example.com",
            name="Home Supervisor",
            password_hash="test",
            role="supervisor",
        )
        other_supervisor = User(
            department_id=other_department.id,
            email="other-scope-supervisor@example.com",
            name="Other Scope Supervisor",
            password_hash="test",
            role="supervisor",
        )
        worker = User(
            department_id=home_department.id,
            email="normal-report-worker@example.com",
            name="Normal Report Worker",
            password_hash="test",
            role="worker",
            worker_class="normal",
        )
        colleague = User(
            department_id=home_department.id,
            email="report-colleague@example.com",
            name="Report Colleague",
            password_hash="test",
            role="worker",
            worker_class="normal",
        )
        outside_worker = User(
            department_id=other_department.id,
            email="outside-report-worker@example.com",
            name="Outside Report Worker",
            password_hash="test",
            role="worker",
            worker_class="normal",
        )
        session.add(home_supervisor)
        session.add(other_supervisor)
        session.add(worker)
        session.add(colleague)
        session.add(outside_worker)
        session.flush()
        active_form = WorkForm(
            department_id=home_department.id,
            name="Active PPE Report",
            fields_json="[]",
            status="active",
            created_by=home_supervisor.id,
        )
        archived_form = WorkForm(
            department_id=home_department.id,
            name="Archived PPE Report",
            fields_json="[]",
            status="archived",
            created_by=home_supervisor.id,
        )
        outside_form = WorkForm(
            department_id=other_department.id,
            name="Outside Report",
            fields_json="[]",
            status="active",
            created_by=other_supervisor.id,
        )
        session.add(active_form)
        session.add(archived_form)
        session.add(outside_form)
        session.flush()
        colleague_report = WorkFormSubmission(
            department_id=home_department.id,
            form_id=active_form.id,
            worker_id=colleague.id,
            work_date="2026-09-01",
            answers_json="{}",
            workflow_status="submitted",
            status="pending",
        )
        outside_report = WorkFormSubmission(
            department_id=other_department.id,
            form_id=outside_form.id,
            worker_id=outside_worker.id,
            work_date="2026-09-01",
            answers_json="{}",
            workflow_status="submitted",
            status="pending",
        )
        session.add(colleague_report)
        session.add(outside_report)
        session.commit()
        return {
            "home_supervisor_id": home_supervisor.id,
            "other_supervisor_id": other_supervisor.id,
            "worker_id": worker.id,
            "colleague_id": colleague.id,
            "outside_worker_id": outside_worker.id,
            "active_form_id": active_form.id,
            "archived_form_id": archived_form.id,
            "colleague_report_id": colleague_report.id,
            "outside_report_id": outside_report.id,
        }


def test_report_transitions_and_immutability():
    """Old clients cannot advance the retired review workflow or edit unversioned."""
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    ids = seed_report_database(engine)
    with Session(engine) as session:
        supervisor = session.get(User, ids["first_supervisor_id"])
        outside = session.get(User, ids["other_supervisor_id"])
        record = session.get(WorkFormSubmission, ids["report_id"])
        before = record.model_dump()
        for target in ("in_review", "resolved"):
            assert_http_error("retired Report transition", 409, lambda: transition_report(
                record.id, ReportTransitionRequest(status=target, supervisor_note="Old client"), supervisor, session))
            assert_http_error("foreign Department transition", 404, lambda: transition_report(
                record.id, ReportTransitionRequest(status=target), outside, session))
        assert_http_error("unversioned Report correction", 409, lambda: update_supervisor_form_submission(
            record.id, SupervisorWorkFormSubmissionUpdate(confirmed=True, work_date="2026-10-22"), supervisor, session))
        session.refresh(record)
        assert record.model_dump() == before
        assert session.exec(select(AuditEvent).where(AuditEvent.action == "report_transition")).all() == []
    engine.dispose()
    print("ok - retired transitions and unversioned edits reject without changing Report content or history")


def test_normal_worker_submission_is_private_optional_and_idempotent():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    ids = seed_report_access_database(engine)
    with Session(engine) as session:
        worker = session.get(User, ids["worker_id"])
        colleague = session.get(User, ids["colleague_id"])
        report = create_work_form_submission(
            WorkFormSubmissionCreate(
                form_id=ids["active_form_id"],
                work_date="2026-09-02",
                answers={},
                client_submission_id="offline-report-replay-key",
            ),
            worker,
            session,
        )
        if report["worker_id"] != worker.id or report["site_id"] is not None:
            raise AssertionError("normal Worker submission: expected Worker ownership and optional Site")
        if report["workflow_status"] != "submitted":
            raise AssertionError("normal Worker submission: expected submitted workflow")

        replay = create_work_form_submission(
            WorkFormSubmissionCreate(
                form_id=ids["active_form_id"],
                work_date="2026-09-03",
                answers={},
                client_submission_id="offline-report-replay-key",
            ),
            worker,
            session,
        )
        if replay["id"] != report["id"] or replay["work_date"] != "2026-09-02":
            raise AssertionError("duplicate replay: expected the original Report without overwritten content")

        worker_report_ids = {item["id"] for item in list_my_form_submissions(worker, session)}
        colleague_report_ids = {item["id"] for item in list_my_form_submissions(colleague, session)}
        if worker_report_ids != {report["id"]}:
            raise AssertionError("My Reports: Worker saw a Report owned by another Worker")
        if colleague_report_ids != {ids["colleague_report_id"]}:
            raise AssertionError("My Reports: colleague saw a Report owned by another Worker")

    engine.dispose()
    print("ok - normal Worker Report is private, Site-optional, and idempotent")


def test_queued_report_rejects_changed_template_without_losing_answers():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    ids = seed_report_access_database(engine)
    with Session(engine) as session:
        worker = session.get(User, ids["worker_id"])
        supervisor = session.get(User, ids["home_supervisor_id"])
        template = create_work_form(
            WorkFormCreate(
                name="Offline PPE Report",
                fields=[
                    WorkFormField(id="issue", label="Issue", type="text"),
                    WorkFormField(id="details", label="Details", type="textarea"),
                    WorkFormField(id="signature", label="Signature", type="signature"),
                ],
            ),
            supervisor,
            session,
        )
        captured_answers = {
            "issue": "Helmet broken",
            "details": "Crack on left side",
            "signature": "/uploads/captured-worker-signature.png",
        }
        queued = WorkFormSubmissionCreate(
            form_id=template["id"],
            work_date="2026-09-02",
            answers=captured_answers,
            photo_urls=["/uploads/captured-evidence-photo.png"],
            expected_definition_version=template["definition_version"],
            client_submission_id="offline-before-template-edit",
        )
        update_work_form(
            template["id"],
            WorkFormUpdate(
                fields=[WorkFormField(id="details", label="Details", type="textarea")],
                confirmed=True,
            ),
            supervisor,
            session,
        )
        assert_http_error(
            "queued Report must conflict instead of discarding the removed Issue answer",
            409,
            lambda: create_work_form_submission(queued, worker, session),
        )
        if list_my_form_submissions(worker, session):
            raise AssertionError("template conflict must not create a partial Report")
        if queued.answers != captured_answers:
            raise AssertionError("template conflict must leave captured answers unchanged")
        if queued.photo_urls != ["/uploads/captured-evidence-photo.png"]:
            raise AssertionError("template conflict must leave captured photo references unchanged")

    engine.dispose()
    print("ok - queued Report rejects a changed Template without losing captured answers")


def test_report_template_version_compatibility_and_idempotent_replay():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    ids = seed_report_access_database(engine)
    with Session(engine) as session:
        worker = session.get(User, ids["worker_id"])
        supervisor = session.get(User, ids["home_supervisor_id"])
        template = create_work_form(
            WorkFormCreate(
                name="Replay version compatibility",
                fields=[WorkFormField(id="issue", label="Issue", type="text")],
            ),
            supervisor,
            session,
        )
        original_payload = WorkFormSubmissionCreate(
            form_id=template["id"],
            work_date="2026-09-02",
            answers={"issue": "Captured original answer"},
            expected_definition_version=1,
            client_submission_id="versioned-report-idempotent-key",
        )
        original = create_work_form_submission(original_payload, worker, session)
        legacy_payload = WorkFormSubmissionCreate(
            form_id=template["id"],
            work_date="2026-09-02",
            answers={"issue": "Legacy queue without a captured version"},
            client_submission_id="unedited-legacy-report-key",
        )
        legacy = create_work_form_submission(legacy_payload, worker, session)
        if legacy["answers"] != legacy_payload.answers or legacy["definition_version"] != 1:
            raise AssertionError("unedited v1 Template must preserve old unversioned queues")

        update_work_form(
            template["id"],
            WorkFormUpdate(status="archived", confirmed=True),
            supervisor,
            session,
        )
        reactivated = update_work_form(
            template["id"],
            WorkFormUpdate(status="active", confirmed=True),
            supervisor,
            session,
        )
        if reactivated["definition_version"] != 1:
            raise AssertionError("archive/reactivate must not invalidate captured definitions")
        after_reactivation = create_work_form_submission(
            original_payload.model_copy(update={"client_submission_id": "after-reactivation-key"}),
            worker,
            session,
        )
        if after_reactivation["answers"] != original_payload.answers:
            raise AssertionError("unchanged reactivated Template must accept captured answers")

        updated = update_work_form(
            template["id"],
            WorkFormUpdate(
                fields=[WorkFormField(id="issue", label="Issue count", type="number", required=True)],
                confirmed=True,
            ),
            supervisor,
            session,
        )
        for label, expected in (("stale version", 1), ("missing version", None), ("future version", 3)):
            queued = original_payload.model_copy(
                update={
                    "expected_definition_version": expected,
                    "client_submission_id": f"changed-template-{label}",
                },
            )
            try:
                create_work_form_submission(queued, worker, session)
            except HTTPException as error:
                if error.status_code != 409 or error.detail != {
                    "code": "report_template_version_conflict",
                    "message": (
                        "Report Template changed. Review the saved report and submit "
                        "a new report with the current template."
                    ),
                    "expected_definition_version": expected,
                    "current_definition_version": 2,
                }:
                    raise AssertionError(f"{label}: expected structured recoverable conflict") from error
            else:
                raise AssertionError(f"{label}: edited Template must reject without normalizing answers")

        current = create_work_form_submission(
            WorkFormSubmissionCreate(
                form_id=template["id"],
                work_date="2026-09-03",
                answers={"issue": 2},
                expected_definition_version=updated["definition_version"],
                client_submission_id="reviewed-current-template-key",
            ),
            worker,
            session,
        )
        if current["definition_version"] != 2 or current["answers"] != {"issue": 2}:
            raise AssertionError("reviewed current Template must accept answers against its own version")

        update_work_form(
            template["id"],
            WorkFormUpdate(status="archived", confirmed=True),
            supervisor,
            session,
        )
        for payload, durable in ((original_payload, original), (legacy_payload, legacy)):
            replay = create_work_form_submission(payload, worker, session)
            if replay != durable:
                raise AssertionError("idempotent replay after edit/archive must return the exact original Report")
        if len(list_my_form_submissions(worker, session)) != 4:
            raise AssertionError("conflicts and duplicate replays must not create extra Reports")

    engine.dispose()
    print("ok - Report version compatibility, explicit conflict recovery, and post-edit idempotent replay")


def test_impossible_report_dates_reject_without_persisting():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    ids = seed_report_access_database(engine)
    with Session(engine) as session:
        worker = session.get(User, ids["worker_id"])
        for report_date in (
            "2026-02-30",
            "2025-02-29",
            "1900-02-29",
            "2026-04-31",
            "2026-13-01",
            "2026-00-01",
            "2026-01-00",
            "0000-01-01",
        ):
            assert_http_error(
                f"impossible Report Date {report_date} must be rejected",
                400,
                lambda: create_work_form_submission(
                    WorkFormSubmissionCreate(
                        form_id=ids["active_form_id"],
                        expected_definition_version=1,
                        work_date=report_date,
                        answers={},
                        client_submission_id=f"invalid-report-date-{report_date}",
                    ),
                    worker,
                    session,
                ),
            )
            if list_my_form_submissions(worker, session):
                raise AssertionError(f"impossible Report Date {report_date} persisted a Report")

    engine.dispose()
    print("ok - impossible calendar Report Dates are rejected without persisting Reports")


def test_valid_report_dates_and_invalid_date_duplicate_replay():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    ids = seed_report_access_database(engine)
    with Session(engine) as session:
        worker = session.get(User, ids["worker_id"])
        valid_dates = (
            "2024-02-29",
            "2000-02-29",
            "2026-02-28",
            "2026-04-30",
            "2026-01-01",
            "2026-12-31",
            "0001-01-01",
            "9999-12-31",
        )
        for report_date in valid_dates:
            payload = WorkFormSubmissionCreate(
                form_id=ids["active_form_id"],
                expected_definition_version=1,
                work_date=report_date,
                answers={},
                client_submission_id=f"valid-report-date-{report_date}",
            )
            created = create_work_form_submission(payload, worker, session)
            if created["work_date"] != report_date:
                raise AssertionError(f"valid Report Date {report_date} was not preserved exactly")
            replay = create_work_form_submission(
                payload.model_copy(update={"work_date": "2026-02-30"}),
                worker,
                session,
            )
            if replay != created:
                raise AssertionError("invalid altered replay date must return the original durable Report")
        durable = list_my_form_submissions(worker, session)
        if len(durable) != len(valid_dates) or {report["work_date"] for report in durable} != set(valid_dates):
            raise AssertionError("valid Report Dates or duplicate replay changed durable Report history")

    engine.dispose()
    print("ok - leap days and calendar boundaries remain valid; duplicate replay preserves original Report Date")


def test_archived_template_rejects_new_report():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    ids = seed_report_access_database(engine)
    with Session(engine) as session:
        worker = session.get(User, ids["worker_id"])
        assert_http_error(
            "archived Report Template rejects a new submission",
            404,
            lambda: create_work_form_submission(
                WorkFormSubmissionCreate(
                    form_id=ids["archived_form_id"],
                    work_date="2026-09-02",
                    answers={},
                    client_submission_id="archived-template-attempt",
                ),
                worker,
                session,
            ),
        )
        if list_my_form_submissions(worker, session):
            raise AssertionError("archived Report Template created a Report despite rejection")

    engine.dispose()
    print("ok - archived Report Template rejects new Reports")


def test_daywork_replay_retains_legacy_version_compatibility():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    ids = seed_report_access_database(engine)
    with Session(engine) as session:
        worker = session.get(User, ids["worker_id"])
        worker.worker_class = "leader"
        session.add(worker)
        template = WorkForm(
            department_id=worker.department_id,
            name="Retained Daywork version two",
            template_purpose="daywork",
            definition_version=2,
            fields_json=json.dumps([{"id": "details", "label": "Details", "type": "text"}]),
            status="active",
            created_by=ids["home_supervisor_id"],
        )
        session.add(template)
        session.commit()
        for expected_version in (None, 1):
            created = create_work_form_submission(
                WorkFormSubmissionCreate(
                    form_id=template.id,
                    answers={"details": "Retained Daywork answer"},
                    expected_definition_version=expected_version,
                    client_submission_id=f"daywork-version-compatibility-{expected_version}",
                ),
                worker,
                session,
            )
            if (
                created["submission_purpose"] != "daywork"
                or created["definition_version"] != 2
                or created["answers"] != {"details": "Retained Daywork answer"}
            ):
                raise AssertionError("Report version guard must not change legacy Daywork submission")

    engine.dispose()
    print("ok - Report version conflicts do not change retained Daywork replay")


def test_supervisor_report_visibility_is_department_scoped():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    ids = seed_report_access_database(engine)
    with Session(engine) as session:
        home_supervisor = session.get(User, ids["home_supervisor_id"])
        other_supervisor = session.get(User, ids["other_supervisor_id"])
        home_report_ids = {
            item["id"]
            for item in list_supervisor_form_submissions(None, home_supervisor, session)
        }
        other_report_ids = {
            item["id"]
            for item in list_supervisor_form_submissions(None, other_supervisor, session)
        }
        if home_report_ids != {ids["colleague_report_id"]}:
            raise AssertionError("home Supervisor Report list crossed Department scope")
        if other_report_ids != {ids["outside_report_id"]}:
            raise AssertionError("other Supervisor Report list crossed Department scope")

    engine.dispose()
    print("ok - Supervisor Report visibility is Department-scoped")



def main():
    test_report_transitions_and_immutability()
    test_normal_worker_submission_is_private_optional_and_idempotent()
    test_queued_report_rejects_changed_template_without_losing_answers()
    test_report_template_version_compatibility_and_idempotent_replay()
    test_impossible_report_dates_reject_without_persisting()
    test_valid_report_dates_and_invalid_date_duplicate_replay()
    test_archived_template_rejects_new_report()
    test_daywork_replay_retains_legacy_version_compatibility()
    test_supervisor_report_visibility_is_department_scoped()
    print("report submission and retired-workflow boundary tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
