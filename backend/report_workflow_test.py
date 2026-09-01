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
    WorkFormSubmissionCreate,
)
from app.use_cases.supervisor_review import update_supervisor_form_submission  # noqa: E402
from app.use_cases.work_forms import (  # noqa: E402
    create_work_form_submission,
    list_my_form_submissions,
    list_supervisor_form_submissions,
    transition_report,
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
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    ids = seed_report_database(engine)
    with Session(engine) as session:
        first_supervisor = session.get(User, ids["first_supervisor_id"])
        second_supervisor = session.get(User, ids["second_supervisor_id"])
        other_supervisor = session.get(User, ids["other_supervisor_id"])
        report = session.get(WorkFormSubmission, ids["report_id"])
        original_content = {
            "site_id": report.site_id,
            "work_date": report.work_date,
            "answers_json": report.answers_json,
            "photo_urls": report.photo_urls,
        }

        assert_http_error(
            "submitted Report content is immutable",
            400,
            lambda: update_supervisor_form_submission(
                report.id,
                SupervisorWorkFormSubmissionUpdate(
                    site_id=999,
                    work_date="2026-09-03",
                    answers={"worker_signature": "/uploads/replacement-signature.png"},
                    photo_urls=["/uploads/replacement-photo.png"],
                    confirmed=True,
                ),
                first_supervisor,
                session,
            ),
        )
        session.refresh(report)
        if {
            "site_id": report.site_id,
            "work_date": report.work_date,
            "answers_json": report.answers_json,
            "photo_urls": report.photo_urls,
        } != original_content:
            raise AssertionError("immutable Report: submitted evidence changed after rejected edit")

        assert_http_error(
            "cross-department Supervisor cannot transition Report",
            404,
            lambda: transition_report(
                report.id,
                ReportTransitionRequest(status="in_review"),
                other_supervisor,
                session,
            ),
        )
        assert_http_error(
            "Report cannot transition to a legacy approval status",
            400,
            lambda: transition_report(
                report.id,
                ReportTransitionRequest(status="approved"),
                first_supervisor,
                session,
            ),
        )
        assert_http_error(
            "submitted Report cannot resolve directly",
            409,
            lambda: transition_report(
                report.id,
                ReportTransitionRequest(
                    status="resolved",
                    supervisor_note="Attempted direct resolution",
                ),
                first_supervisor,
                session,
            ),
        )

        started = transition_report(
            report.id,
            ReportTransitionRequest(
                status="in_review",
                supervisor_note="  Checking replacement PPE stock.  ",
            ),
            first_supervisor,
            session,
        )
        if started["workflow_status"] != "in_review" or started["status"] != "pending":
            raise AssertionError("start review: expected in_review workflow only")
        if started["reviewing_supervisor_id"] != first_supervisor.id:
            raise AssertionError("start review: expected the acting Supervisor as reviewer")
        if started["supervisor_note"] != "Checking replacement PPE stock.":
            raise AssertionError("start review: expected normalized Supervisor note")
        if not started["review_started_at"] or started["resolved_at"] is not None:
            raise AssertionError("start review: expected only the review-started timestamp")

        assert_http_error(
            "resolve requires Supervisor note",
            400,
            lambda: transition_report(
                report.id,
                ReportTransitionRequest(status="resolved", supervisor_note="   "),
                second_supervisor,
                session,
            ),
        )
        resolved = transition_report(
            report.id,
            ReportTransitionRequest(
                status="resolved",
                supervisor_note="  Replacement PPE issued.  ",
            ),
            second_supervisor,
            session,
        )
        if resolved["workflow_status"] != "resolved" or resolved["status"] != "pending":
            raise AssertionError("resolve review: legacy approval outcome must remain untouched")
        if resolved["supervisor_note"] != "Replacement PPE issued.":
            raise AssertionError("resolve review: expected required final Supervisor note")
        if not resolved["resolved_at"] or not resolved["review_started_at"]:
            raise AssertionError("resolve review: expected both durable timestamps")
        if resolved["review_started_at"] != started["review_started_at"]:
            raise AssertionError("resolve review: original review-started timestamp must be retained")
        if resolved["reviewing_supervisor_id"] != first_supervisor.id:
            raise AssertionError("resolve review: starting reviewer must remain durable")

        assert_http_error(
            "resolved Report cannot transition again",
            409,
            lambda: transition_report(
                report.id,
                ReportTransitionRequest(
                    status="resolved",
                    supervisor_note="Duplicate resolution",
                ),
                first_supervisor,
                session,
            ),
        )

        events = session.exec(
            select(AuditEvent)
            .where(
                AuditEvent.action == "report_transition",
                AuditEvent.entity_type == "form",
                AuditEvent.entity_id == report.id,
            )
            .order_by(AuditEvent.id)
        ).all()
        if len(events) != 2:
            raise AssertionError("audit trail: expected exactly one event per successful transition")
        expected_stages = [("submitted", "in_review"), ("in_review", "resolved")]
        for event, (before_stage, after_stage) in zip(events, expected_stages):
            before = json.loads(event.before_json)
            after = json.loads(event.after_json)
            if (
                before.get("submission_purpose") != "report"
                or after.get("submission_purpose") != "report"
            ):
                raise AssertionError(
                    "audit trail: durable Report purpose was not captured"
                )
            if before["workflow_status"] != before_stage or after["workflow_status"] != after_stage:
                raise AssertionError("audit trail: transition stages were not captured")
            for field in ("site_id", "work_date", "answers", "photo_urls"):
                if before[field] != after[field]:
                    raise AssertionError(f"audit trail: immutable {field} changed during transition")

    engine.dispose()
    print("ok - report transitions, authorization, notes, audit, and immutable content")


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


def test_stale_concurrent_transition_cannot_overwrite():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
        database_path = (Path(directory) / "report-concurrency.db").as_posix()
        engine = create_engine(
            f"sqlite:///{database_path}",
            connect_args={"check_same_thread": False},
        )
        ids = seed_report_database(engine)
        with Session(engine) as first_session, Session(engine) as stale_session:
            first_supervisor = first_session.get(User, ids["first_supervisor_id"])
            stale_supervisor = stale_session.get(User, ids["second_supervisor_id"])
            first_session.get(WorkFormSubmission, ids["report_id"])
            stale_report = stale_session.get(WorkFormSubmission, ids["report_id"])
            if stale_report.workflow_status != "submitted":
                raise AssertionError("concurrency setup: expected a stale submitted snapshot")

            transition_report(
                ids["report_id"],
                ReportTransitionRequest(status="in_review"),
                first_supervisor,
                first_session,
            )
            assert_http_error(
                "stale concurrent transition",
                409,
                lambda: transition_report(
                    ids["report_id"],
                    ReportTransitionRequest(status="in_review"),
                    stale_supervisor,
                    stale_session,
                ),
            )

        with Session(engine) as resolver_session, Session(engine) as stale_resolver_session:
            resolver = resolver_session.get(User, ids["second_supervisor_id"])
            stale_resolver = stale_resolver_session.get(User, ids["first_supervisor_id"])
            resolver_session.get(WorkFormSubmission, ids["report_id"])
            stale_resolution = stale_resolver_session.get(
                WorkFormSubmission,
                ids["report_id"],
            )
            if stale_resolution.workflow_status != "in_review":
                raise AssertionError("concurrency setup: expected a stale in_review snapshot")

            transition_report(
                ids["report_id"],
                ReportTransitionRequest(
                    status="resolved",
                    supervisor_note="Winning resolution note",
                ),
                resolver,
                resolver_session,
            )
            assert_http_error(
                "stale concurrent resolution",
                409,
                lambda: transition_report(
                    ids["report_id"],
                    ReportTransitionRequest(
                        status="resolved",
                        supervisor_note="Stale overwrite attempt",
                    ),
                    stale_resolver,
                    stale_resolver_session,
                ),
            )

        with Session(engine) as verification_session:
            report = verification_session.get(WorkFormSubmission, ids["report_id"])
            events = verification_session.exec(
                select(AuditEvent).where(
                    AuditEvent.action == "report_transition",
                    AuditEvent.entity_id == report.id,
                )
            ).all()
            if report.reviewing_supervisor_id != ids["first_supervisor_id"]:
                raise AssertionError("concurrency: stale Supervisor overwrote the first reviewer")
            if report.supervisor_note != "Winning resolution note":
                raise AssertionError("concurrency: stale Supervisor overwrote the resolution note")
            if len(events) != 2:
                raise AssertionError("concurrency: failed transition must not add an audit event")

        engine.dispose()

    print("ok - stale concurrent Supervisor transition cannot overwrite the winner")


def main():
    test_report_transitions_and_immutability()
    test_normal_worker_submission_is_private_optional_and_idempotent()
    test_archived_template_rejects_new_report()
    test_supervisor_report_visibility_is_department_scoped()
    test_stale_concurrent_transition_cannot_overwrite()
    print("report workflow test passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
