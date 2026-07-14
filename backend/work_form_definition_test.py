import sys
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine


sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.models import Department, User  # noqa: E402
from app.schemas import (  # noqa: E402
    SupervisorWorkFormSubmissionUpdate,
    WorkFormCreate,
    WorkFormField,
    WorkFormSubmissionCreate,
    WorkFormUpdate,
)
from app.use_cases.common import normalize_work_form_fields, validate_work_form_answers  # noqa: E402
from app.use_cases.supervisor_review import update_supervisor_form_submission  # noqa: E402
from app.use_cases.work_forms import (  # noqa: E402
    create_work_form,
    create_work_form_submission,
    update_work_form,
)


def field(**values):
    return WorkFormField(**values)


def assert_http_400(label, callback):
    try:
        callback()
    except HTTPException as error:
        if error.status_code != 400:
            raise AssertionError(f"{label}: expected 400, got {error.status_code}") from error
    else:
        raise AssertionError(f"{label}: expected validation failure")


def test_server_derived_answers():
    fields = normalize_work_form_fields(
        [
            field(id="work_time", label="Work time", type="time_range", required=True),
            field(id="workers", label="Workers", type="number", required=True),
            field(
                id="worker_hours",
                label="Worker hours",
                type="formula",
                formula="work_time * workers",
            ),
            field(id="result", label="Result", type="select", required=True, options=["Pass", "Fail"]),
            field(
                id="failure_signature",
                label="Failure signature",
                type="signature",
                required=True,
                show_if="result=Fail",
            ),
            field(id="crews", label="Crews", type="repeat", min_rows=1, max_rows=3),
            field(id="crew_people", label="Crew people", type="number", required=True, repeat="crews"),
            field(id="crew_time", label="Crew time", type="time_range", required=True, repeat="crews"),
            field(
                id="crew_break",
                label="Crew break",
                type="select",
                required=True,
                options=["No break", "30 minutes"],
                repeat="crews",
            ),
            field(
                id="crew_hours",
                label="Crew hours",
                type="formula",
                formula="crew_people * (crew_time - crew_break) + workers",
                repeat="crews",
            ),
            field(
                id="crew_note",
                label="Crew note",
                type="text",
                required=True,
                show_if="crew_hours>9",
                repeat="crews",
            ),
            field(
                id="crew_signature",
                label="Crew signature",
                type="signature",
                required=True,
                repeat="crews",
            ),
        ]
    )
    definition = {"fields": fields}
    answers = validate_work_form_answers(
        definition,
        {
            "work_time": {"start": "22:00", "end": "02:00", "duration_hours": 99},
            "workers": 3,
            "worker_hours": 999,
            "result": "Pass",
            "failure_signature": "not-an-upload",
            "crews": [
                {
                    "crew_people": 2,
                    "crew_time": {"start": "07:00", "end": "11:00", "duration_hours": 99},
                    "crew_break": "30 minutes",
                    "crew_hours": 999,
                    "crew_note": "Server-derived condition is visible",
                    "crew_signature": "/uploads/crew-signature.png",
                }
            ],
        },
    )

    if answers["work_time"]["duration_hours"] != 4:
        raise AssertionError("time range: server must derive overnight duration from start/end")
    if answers["worker_hours"] != 12:
        raise AssertionError("formula: server must ignore a caller-supplied formula value")
    if answers["failure_signature"] != "":
        raise AssertionError("condition: hidden signature must not retain caller data")
    if answers["crews"][0]["crew_time"]["duration_hours"] != 4:
        raise AssertionError("repeat time range: server must derive row duration")
    if answers["crews"][0]["crew_hours"] != 10:
        raise AssertionError("repeat formula: expected trusted parent and row scope")
    if answers["crews"][0]["crew_note"] != "Server-derived condition is visible":
        raise AssertionError("repeat condition: expected condition to use the server-derived formula")
    if answers["crews"][0]["crew_signature"] != "/uploads/crew-signature.png":
        raise AssertionError("repeat signature: expected validated uploaded signature URL")

    assert_http_400(
        "visible required signature",
        lambda: validate_work_form_answers(
            definition,
            {
                "work_time": {"start": "08:00", "end": "08:00"},
                "workers": 1,
                "result": "Fail",
                "crews": [
                    {
                        "crew_people": 1,
                        "crew_time": {"start": "08:00", "end": "08:00"},
                        "crew_break": "No break",
                    }
                ],
            },
        ),
    )

    invalid_formula_fields = [
        field(id="total", label="Total", type="formula", formula="later * 2"),
        field(id="later", label="Later", type="number"),
    ]
    assert_http_400(
        "formula dependency order",
        lambda: normalize_work_form_fields(invalid_formula_fields),
    )

    print("ok - server-derived work form answers")


def test_submission_definition_snapshot():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    with Session(engine) as session:
        department = Department(name="Snapshot Department")
        session.add(department)
        session.flush()
        supervisor = User(
            department_id=department.id,
            email="snapshot-supervisor@example.com",
            name="Snapshot Supervisor",
            password_hash="test",
            role="supervisor",
        )
        worker = User(
            department_id=department.id,
            email="snapshot-worker@example.com",
            name="Snapshot Worker",
            password_hash="test",
            role="worker",
            worker_class="leader",
        )
        session.add(supervisor)
        session.add(worker)
        session.commit()
        session.refresh(supervisor)
        session.refresh(worker)

        created = create_work_form(
            WorkFormCreate(
                name="Original form",
                description="Original description",
                fields=[field(id="original_answer", label="Original answer", type="text", required=True)],
            ),
            supervisor,
            session,
        )
        submission = create_work_form_submission(
            WorkFormSubmissionCreate(
                form_id=created["id"],
                answers={"original_answer": "Captured value"},
                client_submission_id="snapshot-retry-key",
            ),
            worker,
            session,
        )

        updated = update_work_form(
            created["id"],
            WorkFormUpdate(
                name="Replacement form",
                description="Replacement description",
                fields=[field(id="replacement_answer", label="Replacement answer", type="text", required=True)],
                confirmed=True,
            ),
            supervisor,
            session,
        )
        if updated["definition_version"] != 2:
            raise AssertionError("definition version: content edits must increment exactly once")

        no_op = update_work_form(
            created["id"],
            WorkFormUpdate(name="Replacement form", confirmed=True),
            supervisor,
            session,
        )
        if no_op["definition_version"] != 2:
            raise AssertionError("definition version: a no-op content edit must not create a new version")

        archived = update_work_form(
            created["id"],
            WorkFormUpdate(status="archived", confirmed=True),
            supervisor,
            session,
        )
        if archived["definition_version"] != 2:
            raise AssertionError("definition version: lifecycle status must not change content version")

        retry = create_work_form_submission(
            WorkFormSubmissionCreate(
                form_id=created["id"],
                answers={},
                client_submission_id="snapshot-retry-key",
            ),
            worker,
            session,
        )
        if retry["id"] != submission["id"]:
            raise AssertionError("idempotent retry: expected original submission")
        if retry["form_name"] != "Original form" or retry["fields"][0]["id"] != "original_answer":
            raise AssertionError("historical response: expected original immutable definition")
        if retry["definition_version"] != 1:
            raise AssertionError("historical response: expected original definition version")

        corrected = update_supervisor_form_submission(
            submission["id"],
            SupervisorWorkFormSubmissionUpdate(
                answers={"original_answer": "Supervisor correction"},
                confirmed=True,
            ),
            supervisor,
            session,
        )
        if corrected["answers"]["original_answer"] != "Supervisor correction":
            raise AssertionError("historical edit: expected validation against the stored definition")
        if corrected["form_name"] != "Original form":
            raise AssertionError("historical edit: definition snapshot must remain unchanged")

    engine.dispose()
    print("ok - immutable work form definition snapshot")


def main():
    test_server_derived_answers()
    test_submission_definition_snapshot()
    print("work form definition test passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
