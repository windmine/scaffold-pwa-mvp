import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select


sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.models import (  # noqa: E402
    AttendanceRecord,
    AuditEvent,
    Department,
    TaskLog,
    TeamWorkLog,
    User,
    WorkForm,
    WorkFormSubmission,
)
from app.schemas import TaskLogUpdateRequest  # noqa: E402
from app.use_cases.review_queue import list_review_record_page  # noqa: E402
from app.use_cases.review_record_policy import apply_review_decision  # noqa: E402
from app.use_cases.supervisor_review import update_supervisor_task_log  # noqa: E402


def assert_http_error(label, status_code, callback):
    try:
        callback()
    except HTTPException as error:
        if error.status_code != status_code:
            raise AssertionError(f"{label}: expected {status_code}, got {error.status_code}") from error
    else:
        raise AssertionError(f"{label}: expected HTTP {status_code}")


def seeded_session():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    session = Session(engine)

    department = Department(name="Review Department")
    other_department = Department(name="Other Department")
    session.add(department)
    session.add(other_department)
    session.flush()
    supervisor = User(
        department_id=department.id,
        email="review-supervisor@example.com",
        name="Review Supervisor",
        password_hash="test",
        role="supervisor",
    )
    global_supervisor = User(
        department_id=department.id,
        email="review-global@example.com",
        name="Global Supervisor",
        password_hash="test",
        role="supervisor",
        is_global_admin=True,
    )
    worker = User(
        department_id=department.id,
        email="review-worker@example.com",
        name="Queue Worker",
        password_hash="test",
        role="worker",
        worker_class="leader",
    )
    other_worker = User(
        department_id=other_department.id,
        email="other-worker@example.com",
        name="Other Worker",
        password_hash="test",
        role="worker",
    )
    session.add(supervisor)
    session.add(global_supervisor)
    session.add(worker)
    session.add(other_worker)
    session.flush()

    created_at = datetime(2026, 7, 1, 8, 0, tzinfo=timezone.utc)
    form = WorkForm(
        department_id=department.id,
        name="Queue form",
        fields_json='[{"id":"answer","label":"Answer","type":"text","required":false,"options":[]}]',
        definition_version=1,
        status="active",
        created_by=supervisor.id,
    )
    session.add(form)
    session.flush()
    attendance = AttendanceRecord(
        department_id=department.id,
        worker_id=worker.id,
        record_type="check_in",
        status="pending",
        created_at=created_at,
    )
    task = TaskLog(
        department_id=department.id,
        worker_id=worker.id,
        description="Bridge inspection",
        work_date="2026-07-01",
        status="pending",
        created_at=created_at,
    )
    submission = WorkFormSubmission(
        department_id=department.id,
        form_id=form.id,
        worker_id=worker.id,
        work_date="2026-07-02",
        answers_json='{"answer":"Ready"}',
        status="approved",
        created_at=created_at,
    )
    team_log = TeamWorkLog(
        department_id=department.id,
        leader_id=worker.id,
        week_start="2026-07-03",
        status="rejected",
        created_at=created_at,
    )
    other_attendance = AttendanceRecord(
        department_id=other_department.id,
        worker_id=other_worker.id,
        record_type="check_in",
        status="pending",
        created_at=created_at + timedelta(hours=1),
    )
    session.add(attendance)
    session.add(task)
    session.add(submission)
    session.add(team_log)
    session.add(other_attendance)
    session.commit()
    for item in (supervisor, global_supervisor, worker, task):
        session.refresh(item)
    return engine, session, supervisor, global_supervisor, worker, task


def test_paged_review_record_query():
    engine, session, supervisor, global_supervisor, worker, _ = seeded_session()
    try:
        first = list_review_record_page(session, supervisor, page_size=2)
        if [item["kind"] for item in first["items"]] != ["attendance", "form"]:
            raise AssertionError("stable ordering: expected created_at, kind, id ordering")
        if first["counts"]["total"] != 4 or not first["has_more"] or not first["next_cursor"]:
            raise AssertionError("first page: expected scoped counts and continuation cursor")

        second = list_review_record_page(
            session,
            supervisor,
            page_size=2,
            cursor=first["next_cursor"],
        )
        keys = [item["review_key"] for item in first["items"] + second["items"]]
        if len(keys) != 4 or len(set(keys)) != 4:
            raise AssertionError("page traversal: records must not be duplicated or omitted")
        if [item["kind"] for item in second["items"]] != ["task", "team_log"]:
            raise AssertionError("second page: expected remaining stable kinds")

        task_page = list_review_record_page(
            session,
            supervisor,
            kind="task",
            record_date="2026-07-01",
            search="Bridge",
        )
        if len(task_page["items"]) != 1 or task_page["items"][0]["kind"] != "task":
            raise AssertionError("filters: expected kind/date/search to execute before paging")

        pending_page = list_review_record_page(
            session,
            supervisor,
            status="pending",
            page_size=1,
        )
        if pending_page["counts"]["total"] != 2:
            raise AssertionError("matching counts: expected only pending filter matches")
        if (
            pending_page["summary_counts"]["total"] != 4
            or pending_page["summary_counts"]["pending"] != 2
            or pending_page["summary_counts"]["reviewed"] != 2
        ):
            raise AssertionError("summary counts: expected department-wide totals independent of filters")

        global_page = list_review_record_page(session, global_supervisor)
        if global_page["counts"]["total"] != 5:
            raise AssertionError("global scope: expected both departments")
        assert_http_error(
            "department scope",
            404,
            lambda: list_review_record_page(
                session,
                supervisor,
                department_id=global_page["items"][0]["department_id"],
            ),
        )
        assert_http_error(
            "malformed cursor",
            400,
            lambda: list_review_record_page(session, supervisor, cursor="not-base64"),
        )
        assert_http_error(
            "filter-bound cursor",
            400,
            lambda: list_review_record_page(
                session,
                supervisor,
                status="pending",
                cursor=first["next_cursor"],
            ),
        )

        late_record = AttendanceRecord(
            department_id=supervisor.department_id,
            worker_id=worker.id,
            record_type="check_out",
            status="pending",
            created_at=datetime.now(timezone.utc) + timedelta(minutes=1),
        )
        session.add(late_record)
        session.commit()
        snapshot_second = list_review_record_page(
            session,
            supervisor,
            page_size=2,
            cursor=first["next_cursor"],
        )
        if any(item["id"] == late_record.id and item["kind"] == "attendance" for item in snapshot_second["items"]):
            raise AssertionError("snapshot paging: later records must not enter an active traversal")
    finally:
        session.close()
        engine.dispose()

    print("ok - paged Review Record query")


def test_review_record_decision_policy():
    engine, session, supervisor, _, _, task = seeded_session()
    try:
        assert_http_error(
            "general edit decision bypass",
            400,
            lambda: update_supervisor_task_log(
                task.id,
                TaskLogUpdateRequest(status="approved", confirmed=True),
                supervisor,
                session,
            ),
        )
        session.refresh(task)
        if task.status != "pending":
            raise AssertionError("general edit decision bypass: status must remain pending")

        decided = apply_review_decision(
            "task",
            task.id,
            "approved",
            supervisor,
            session,
            comment="Checked against the site diary",
        )
        if decided["status"] != "approved" or decided["durability"] != "durable":
            raise AssertionError("decision policy: expected durable approved Review Record")
        events = session.exec(
            select(AuditEvent).where(
                AuditEvent.action == "review_decision",
                AuditEvent.entity_type == "task",
                AuditEvent.entity_id == task.id,
            )
        ).all()
        if len(events) != 1 or "site diary" not in (events[0].summary or ""):
            raise AssertionError("decision policy: expected exactly one audit event with comment")
        assert_http_error(
            "second decision conflict",
            409,
            lambda: apply_review_decision(
                "task",
                task.id,
                "rejected",
                supervisor,
                session,
            ),
        )
    finally:
        session.close()
        engine.dispose()

    print("ok - Review Record decision policy")


def main():
    test_paged_review_record_query()
    test_review_record_decision_policy()
    print("review queue test passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
