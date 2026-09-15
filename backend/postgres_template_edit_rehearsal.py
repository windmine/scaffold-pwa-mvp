"""Versioned Template-edit races on the release runner's owned PostgreSQL DB."""

from sqlmodel import Session

from app.migrations import run_migrations, verify_migrations
from app.models import User
from app.schemas import WorkFormCreate, WorkFormField, WorkFormSubmissionCreate, WorkFormUpdate
from app.use_cases.audit import list_audit_events
from app.use_cases.work_forms import (
    create_work_form, create_work_form_submission, list_my_form_submissions,
    list_work_forms, update_work_form,
)
from postgres_invitation_rehearsal import overlapping_operations, seed_supervisors
from postgres_review_rehearsal import require


def seed_template(engine, supervisor_id, label):
    with Session(engine) as session:
        supervisor = session.get(User, supervisor_id)
        template = create_work_form(WorkFormCreate(
            name=f"Original {label}", description="Original description",
            fields=[WorkFormField(id="note", label="Note", type="text", required=True)],
        ), supervisor, session)
        worker = User(department_id=1, role="worker", worker_class="normal", name="Report fixture Worker",
                      email=f"{label}@rehearsal.invalid", password_hash="not-a-login")
        session.add(worker)
        session.commit()
        original_report = create_work_form_submission(WorkFormSubmissionCreate(
            form_id=template["id"], expected_definition_version=1, work_date="2026-09-15",
            answers={"note": "Original submitted evidence"}, client_submission_id=f"pg-template-{label}",
        ), worker, session)
        return template, worker.id, original_report


def current_template_and_audits(engine, supervisor_id, form_id):
    with Session(engine) as session:
        supervisor = session.get(User, supervisor_id)
        current = next(row for row in list_work_forms(supervisor, session, purpose="report") if row["id"] == form_id)
        audits = sorted((row for row in list_audit_events(session, supervisor, entity_type="work_form")
                         if row["entity_id"] == form_id and row["action"] == "work_form_update"), key=lambda row: row["id"])
        return current, audits


def assert_original_report(engine, worker_id, original):
    with Session(engine) as session:
        require(list_my_form_submissions(session.get(User, worker_id), session, purpose="report") == [original],
                "Template contention changed an immutable submitted Report or its Definition snapshot")


def check_checked_edits(engine, supervisors, report):
    original, worker_id, original_report = seed_template(engine, supervisors[0], "checked-checked")
    operations = {label: (lambda session, actor=actor, label=label: update_work_form(
        original["id"], WorkFormUpdate(name=f"Winning candidate {label}", expected_definition_version=1, confirmed=True),
        session.get(User, actor), session,
    )) for label, actor in zip(("first", "second"), supervisors)}
    outcomes, proof = overlapping_operations(engine, "workform", operations, "first")
    require(outcomes["first"]["status"] == 200 and outcomes["second"]["status"] == 409,
            "concurrent checked Template edits did not produce exactly one winner and conflict")
    detail = outcomes["second"]["detail"]
    require(detail["code"] == "report_template_edit_version_conflict"
            and detail["expected_definition_version"] == 1 and detail["current_definition_version"] == 2,
            "stale Template conflict did not identify the actual current Definition version")
    current, audits = current_template_and_audits(engine, supervisors[0], original["id"])
    require(current == outcomes["first"]["response"] and current["definition_version"] == 2,
            "the stale Template contender overwrote its winner")
    require(len(audits) == 1 and audits[0]["actor_id"] == supervisors[0]
            and audits[0]["before"]["definition_version"] == 1
            and audits[0]["after"]["definition_version"] == 2
            and audits[0]["after"]["name"] == current["name"],
            "checked Template contention did not persist exactly one accurate audit")
    assert_original_report(engine, worker_id, original_report)
    report("PostgreSQL checked/checked Template edits: one winner, current-version conflict, one audit, immutable Report", proof)


def check_legacy_contention(engine, supervisors, preferred, report):
    original, worker_id, original_report = seed_template(engine, supervisors[0], f"legacy-{preferred}")
    operations = {
        "checked": lambda session: update_work_form(original["id"], WorkFormUpdate(
            name=f"Checked name {preferred}", expected_definition_version=1, confirmed=True,
        ), session.get(User, supervisors[0]), session),
        "legacy": lambda session: update_work_form(original["id"], WorkFormUpdate(
            description="Legacy description", confirmed=True,
        ), session.get(User, supervisors[1]), session),
    }
    outcomes, proof = overlapping_operations(engine, "workform", operations, preferred)
    checked_succeeded = preferred == "checked"
    require(outcomes["legacy"]["status"] == 200
            and outcomes["checked"]["status"] == (200 if checked_succeeded else 409),
            "legacy and checked Template writers did not respect serialized Definition versions")
    current, audits = current_template_and_audits(engine, supervisors[0], original["id"])
    require(current["definition_version"] == 2 + int(checked_succeeded)
            and current["description"] == "Legacy description"
            and current["name"] == (f"Checked name {preferred}" if checked_succeeded else original["name"]),
            "legacy Template writer lost successful content or reused a stale Definition version")
    require(len(audits) == 1 + int(checked_succeeded)
            and [row["before"]["definition_version"] for row in audits] == list(range(1, len(audits) + 1))
            and [row["after"]["definition_version"] for row in audits] == list(range(2, len(audits) + 2))
            and audits[-1]["actor_id"] == supervisors[1]
            and audits[-1]["after"]["name"] == current["name"]
            and audits[-1]["after"]["description"] == current["description"],
            "legacy Template audits do not reflect the serialized successful content versions")
    if not checked_succeeded:
        require(outcomes["checked"]["detail"]["code"] == "report_template_edit_version_conflict"
                and outcomes["checked"]["detail"]["current_definition_version"] == 2,
                "checked edit did not identify the newer legacy Definition")
    assert_original_report(engine, worker_id, original_report)
    report(f"PostgreSQL checked/legacy Template edits, {preferred} first: no lost content, ordered versions/audits, immutable Report", proof)


def run_template_edit_checks(database, report):
    with database("template_edit") as engine:
        require(engine.dialect.name == "postgresql", "Template-edit rehearsal requires native PostgreSQL")
        run_migrations(engine)
        with engine.connect() as connection:
            verify_migrations(connection)
        supervisors = seed_supervisors(engine)
        check_checked_edits(engine, supervisors, report)
        for preferred in ("checked", "legacy"):
            check_legacy_contention(engine, supervisors, preferred, report)
