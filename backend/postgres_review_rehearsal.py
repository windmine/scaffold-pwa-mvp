"""Report correction checks for the runner's disposable, non-superuser PostgreSQL DB.

No connection URL is read here. ``database(label)`` supplies an owned Engine;
``report(label, details=None)`` records sanitized rehearsal evidence.
"""

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from fastapi import HTTPException
from sqlalchemy import event, text, update
from sqlalchemy.exc import DBAPIError
from sqlmodel import Session, select

from app.migrations import run_migrations, verify_migrations
from app.models import AuditEvent, Department, Site, User, WorkForm, WorkFormSubmission
from app.schemas import ReportTransitionRequest, SupervisorWorkFormSubmissionUpdate
from app.use_cases.common import work_form_definition_snapshot_json
from app.use_cases.work_forms import transition_report
from app.use_cases.supervisor_review import update_supervisor_form_submission


IMMUTABLE_FIELDS = (
    "department_id", "form_id", "worker_id", "site_id", "answers_json",
    "form_definition_version", "definition_snapshot_json", "photo_urls", "photo_metadata",
    "client_submission_id", "submission_purpose", "created_at", "status",
)
REVIEW_FIELDS = (
    "workflow_status", "supervisor_note", "reviewing_supervisor_id",
    "review_started_at", "resolved_at", "work_date", "revision", "edited_at", "edited_by_supervisor_id",
)


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def is_statement(context, kind, table):
    statement = getattr(getattr(context, "compiled", None), "statement", None)
    return bool(getattr(statement, f"is_{kind}", False)) and getattr(
        getattr(statement, "table", None), "name", None
    ) == table


def seed_fixture(engine):
    with Session(engine) as session:
        # The product's fixed Departments are inserted by real migrations.
        # Reuse them instead of relying on a create_all-style empty schema.
        home, other = session.get(Department, 1), session.get(Department, 2)
        require(home is not None and other is not None, "migrations did not create the fixed Department fixture")
        reviewers = [User(
            department_id=home.id, email=f"reviewer-{index}@rehearsal.invalid",
            name=f"Reviewer {index}", password_hash="not-a-login", role="supervisor",
        ) for index in (1, 2)]
        outside = User(department_id=other.id, email="outside@rehearsal.invalid",
                       name="Other Department", password_hash="not-a-login", role="supervisor")
        worker = User(department_id=home.id, email="worker@rehearsal.invalid",
                      name="Normal Worker", password_hash="not-a-login", role="worker", worker_class="normal")
        session.add_all([*reviewers, outside, worker])
        session.flush()
        site = Site(department_id=home.id, name="Review fixture Site", latitude=-36.8, longitude=174.7)
        form = WorkForm(
            department_id=home.id, name="Concurrent PPE Report", template_purpose="report",
            created_by=reviewers[0].id, fields_json=json.dumps([
                {"id": "issue", "label": "Issue", "type": "text", "required": True},
                {"id": "signature", "label": "Signature", "type": "signature"},
                {"id": "crew", "label": "Crew", "type": "repeat", "min_rows": 1},
                {"id": "crew_signature", "label": "Crew signature", "type": "signature", "repeat": "crew"},
            ]),
        )
        session.add_all([site, form])
        session.commit()
        return {"department": home.id, "reviewers": [row.id for row in reviewers],
                "outside": outside.id, "worker": worker.id, "site": site.id, "form": form.id}


def new_report(engine, fixture, label):
    with Session(engine) as session:
        form = session.get(WorkForm, fixture["form"])
        record = WorkFormSubmission(
            department_id=fixture["department"], form_id=form.id, worker_id=fixture["worker"],
            site_id=fixture["site"], work_date="2026-09-07", submission_purpose="report",
            workflow_status="submitted", status="pending", client_submission_id=f"pg-review-{label}",
            form_definition_version=form.definition_version,
            definition_snapshot_json=work_form_definition_snapshot_json(form),
            answers_json=json.dumps({"issue": "Missing PPE", "signature": "/uploads/fixture-signature.png",
                                     "crew": [{"crew_signature": "/uploads/fixture-crew-signature.png"}]}),
            photo_urls=json.dumps(["/uploads/fixture-photo.png"]),
            photo_metadata=json.dumps([{"name": "fixture-photo.png", "type": "image/png"}]),
        )
        session.add(record)
        session.commit()
        return record.id


def state_and_audits(engine, record_id):
    with Session(engine) as session:
        record = session.get(WorkFormSubmission, record_id)
        state = {field: getattr(record, field) for field in (*IMMUTABLE_FIELDS, *REVIEW_FIELDS)}
        audits = session.exec(select(AuditEvent).where(
            AuditEvent.entity_type == "form", AuditEvent.entity_id == record_id,
            AuditEvent.action == "form_submission_update",
        ).order_by(AuditEvent.id)).all()
        return state, [{"actor_id": row.actor_id, "before": json.loads(row.before_json),
                        "after": json.loads(row.after_json)} for row in audits]


def transition(engine, record_id, actor_id, target, note=None):
    with Session(engine) as session:
        return transition_report(record_id, ReportTransitionRequest(status=target, supervisor_note=note),
                                 session.get(User, actor_id), session)


def overlapping_correction(engine, record_id, reviewers, revision, round_number):
    """Hold the winning UPDATE open until PostgreSQL proves the loser is blocked."""
    token = object()
    preferred_actor = reviewers[(round_number + revision) % len(reviewers)]
    arrivals = threading.Barrier(2, timeout=10)
    winner_updated, release_winner = threading.Event(), threading.Event()
    lock = threading.Lock()
    participants, winner = {}, {}

    def before_update(connection, _cursor, statement, _parameters, context, _many):
        if (connection.info.get("review_rehearsal_token") is token
                and not connection.info.get("correction_claim_seen")
                and is_statement(context, "update", "workformsubmission")):
            require("revision" in statement, "race did not reach the conditional revision UPDATE")
            connection.info["correction_claim_seen"] = True
            connection.info["correction_claim_pending"] = True
            arrivals.wait()
            if connection.info["review_rehearsal_actor"] != preferred_actor:
                require(winner_updated.wait(12), "preferred contender did not reach its PostgreSQL UPDATE")

    def after_update(connection, cursor, _statement, _parameters, context, _many):
        if (connection.info.get("review_rehearsal_token") is token
                and connection.info.pop("correction_claim_pending", False)
                and is_statement(context, "update", "workformsubmission") and cursor.rowcount == 1):
            with lock:
                winner.update(pid=connection.info["review_rehearsal_pid"])
            winner_updated.set()
            require(release_winner.wait(12), "observer did not release the locked winning transaction")

    def contender(actor_id):
        with Session(engine) as session:
            connection = session.connection()
            info = connection.info
            connection.execute(text("SET LOCAL lock_timeout = '15s'"))
            connection.execute(text("SET LOCAL statement_timeout = '20s'"))
            pid, transaction_id = connection.execute(text("SELECT pg_backend_pid(), txid_current()")).one()
            info.update(review_rehearsal_token=token, review_rehearsal_pid=pid, review_rehearsal_actor=actor_id)
            with lock:
                participants[actor_id] = {"pid": pid, "transaction_id": transaction_id}
            note = f"2026-10-{21 + reviewers.index(actor_id):02d}"
            try:
                response = update_supervisor_form_submission(
                    record_id, SupervisorWorkFormSubmissionUpdate(confirmed=True, expected_revision=revision, work_date=note),
                    session.get(User, actor_id), session,
                )
                return {"status": 200, "actor": actor_id, "note": note, "response": response}
            except HTTPException as error:
                session.rollback()
                return {"status": error.status_code, "actor": actor_id, "note": note, "detail": error.detail}
            finally:
                info.pop("correction_claim_seen", None)
                info.pop("correction_claim_pending", None)
                info.pop("review_rehearsal_token", None)
                info.pop("review_rehearsal_pid", None)
                info.pop("review_rehearsal_actor", None)

    event.listen(engine, "before_cursor_execute", before_update)
    event.listen(engine, "after_cursor_execute", after_update)
    executor = ThreadPoolExecutor(max_workers=2)
    futures = [executor.submit(contender, actor) for actor in reviewers]
    blocked_proof = None
    try:
        require(winner_updated.wait(12), "neither independent transaction reached its winning UPDATE")
        with lock:
            snapshot = dict(participants)
            winner_pid = winner["pid"]
        require(len(snapshot) == 2 and len({row["pid"] for row in snapshot.values()}) == 2,
                "race did not use two independent PostgreSQL backend connections")
        require(len({row["transaction_id"] for row in snapshot.values()}) == 2,
                "race did not use independent PostgreSQL transactions")
        loser_pid = next(row["pid"] for row in snapshot.values() if row["pid"] != winner_pid)
        deadline = time.monotonic() + 8
        with engine.connect() as observer:
            observer_pid = observer.execute(text("SELECT pg_backend_pid()")).scalar_one()
            require(observer_pid not in {winner_pid, loser_pid}, "lock observer reused a race connection")
            while time.monotonic() < deadline:
                blockers = observer.execute(text("SELECT pg_blocking_pids(:pid)"), {"pid": loser_pid}).scalar_one()
                if winner_pid in blockers:
                    blocked_proof = {"winner_pid": winner_pid, "blocked_pid": loser_pid, "observer_pid": observer_pid}
                    break
                time.sleep(0.02)
        require(blocked_proof is not None, "PostgreSQL never observed simultaneous conflicting correction UPDATEs")
        release_winner.set()
        outcomes = [future.result(timeout=15) for future in futures]
        require(sorted(row["status"] for row in outcomes) == [200, 409],
                f"concurrent correction produced unexpected outcomes: {outcomes}")
        success = next(row for row in outcomes if row["status"] == 200)
        rejected = next(row for row in outcomes if row["status"] == 409)
        require(success["actor"] == preferred_actor, "preferred winner was not established before the competing UPDATE")
        require(rejected.get("detail", {}).get("code") == "report_revision_conflict", "loser was not rejected at the conditional database UPDATE")
        return success, {"backend_transactions": list(snapshot.values()), "lock_contention": blocked_proof,
                         "winning_supervisor_id": success["actor"], "conflicting_supervisor_id": rejected["actor"]}
    finally:
        release_winner.set()
        arrivals.abort()
        executor.shutdown(wait=True, cancel_futures=True)
        event.remove(engine, "before_cursor_execute", before_update)
        event.remove(engine, "after_cursor_execute", after_update)


def check_rejections_and_immutability(engine, fixture, report):
    record_id = new_report(engine, fixture, "validation")
    for actor, target, note, expected in (
        (fixture["worker"], "in_review", None, 403),
        (fixture["outside"], "in_review", None, 404),
        (fixture["reviewers"][0], "resolved", "Too soon", 409),
        (fixture["reviewers"][0], "submitted", None, 400),
    ):
        try:
            transition(engine, record_id, actor, target, note)
        except HTTPException as error:
            require(error.status_code == expected, f"Report authorization/transition returned {error.status_code}, expected {expected}")
        else:
            raise AssertionError("Report accepted an unauthorized or invalid transition")
    state, audits = state_and_audits(engine, record_id)
    require(state["workflow_status"] == "submitted" and not audits, "failed transitions changed workflow or wrote audits")
    try:
        transition(engine, record_id, fixture["reviewers"][0], "in_review")
    except HTTPException as error:
        require(error.status_code == 409, "retired review must reject old clients")
    else:
        raise AssertionError("Retired Report workflow remained available")
    before, audits_before = state_and_audits(engine, record_id)
    for actor, expected in ((fixture["worker"], 403), (fixture["outside"], 404)):
        with Session(engine) as session:
            try:
                update_supervisor_form_submission(record_id, SupervisorWorkFormSubmissionUpdate(
                    confirmed=True, expected_revision=1, work_date="2026-10-22"), session.get(User, actor), session)
            except HTTPException as error:
                require(error.status_code == expected, "correction authorization crossed role or Department")
            else:
                raise AssertionError("Unauthorized correction succeeded")
    report("PostgreSQL Supervisor correction permissions and retired review transitions remain enforced")
    for field, value in {"site_id": None, "work_date": "2026-10-11", "answers_json": "{}",
                         "photo_urls": "[]", "definition_snapshot_json": "{}", "submission_purpose": "daywork"}.items():
        try:
            with engine.begin() as connection:
                connection.execute(update(WorkFormSubmission).where(WorkFormSubmission.id == record_id).values(**{field: value}))
        except DBAPIError as error:
            require(getattr(error.orig, "sqlstate", None) == "23514", f"{field} mutation failed for a non-invariant reason")
        else:
            raise AssertionError(f"PostgreSQL allowed immutable Report {field} to change")
    require(state_and_audits(engine, record_id) == (before, audits_before), "rejected content mutations changed original evidence")
    report("PostgreSQL database guards reject unversioned content edits and all identity/Definition/purpose changes")


def check_audit_rollback(engine, fixture, report):
    record_id = new_report(engine, fixture, "audit-rollback")
    before = state_and_audits(engine, record_id)
    updated = []

    def observe_update(_connection, cursor, _statement, _parameters, context, _many):
        if is_statement(context, "update", "workformsubmission") and cursor.rowcount == 1:
            updated.append(True)

    def fail_audit(_connection, _cursor, _statement, _parameters, context, _many):
        if is_statement(context, "insert", "auditevent"):
            raise RuntimeError("isolated audit INSERT failure")

    event.listen(engine, "after_cursor_execute", observe_update)
    event.listen(engine, "before_cursor_execute", fail_audit)
    try:
        with Session(engine) as session:
            try:
                update_supervisor_form_submission(record_id, SupervisorWorkFormSubmissionUpdate(
                    confirmed=True, expected_revision=1, work_date="2026-10-22"),
                    session.get(User, fixture["reviewers"][0]), session)
            except RuntimeError as error:
                session.rollback()
                require(str(error) == "isolated audit INSERT failure", "audit rollback failed for an unrelated reason")
            else:
                raise AssertionError("correction succeeded despite forced audit INSERT failure")
    finally:
        event.remove(engine, "after_cursor_execute", observe_update)
        event.remove(engine, "before_cursor_execute", fail_audit)
    require(len(updated) == 2, "audit failure did not follow both the revision claim and actual content update")
    require(state_and_audits(engine, record_id) == before, "audit failure did not roll back content/revision atomically")
    report("PostgreSQL Report correction and revision roll back atomically when audit INSERT fails")


def run_review_checks(database, report):
    with database("concurrent_review") as engine:
        require(engine.dialect.name == "postgresql", "review rehearsal requires real PostgreSQL, never SQLite")
        with engine.connect() as connection:
            superuser, owner = connection.execute(text(
                "SELECT r.rolsuper, pg_get_userbyid(d.datdba) = current_user "
                "FROM pg_roles r JOIN pg_database d ON d.datname = current_database() WHERE r.rolname = current_user"
            )).one()
            require(not superuser and owner, "rehearsal must use its non-superuser database owner")
        run_migrations(engine)
        with engine.connect() as connection:
            verify_migrations(connection)
        report("PostgreSQL Report correction fixture bootstrapped through actual migrations as a non-superuser owner")
        fixture = seed_fixture(engine)
        for round_number in range(1, 6):
            record_id = new_report(engine, fixture, f"race-{round_number}")
            original, _ = state_and_audits(engine, record_id)
            for revision in (1, 2):
                winner, proof = overlapping_correction(engine, record_id, fixture["reviewers"], revision, round_number)
                current, audits = state_and_audits(engine, record_id)
                require(all(current[field] == original[field] for field in IMMUTABLE_FIELDS), "date correction changed unrelated evidence or identity")
                require(current["revision"] == revision + 1 and current["work_date"] == winner["note"], "stale correction overwrote winner")
                require(current["edited_by_supervisor_id"] == winner["actor"] and current["edited_at"] is not None, "editor attribution incorrect")
                require(current["workflow_status"] == "submitted", "correction resumed the retired workflow")
                require(len(audits) == revision and audits[-1]["actor_id"] == winner["actor"], "correction did not record exactly one winning audit")
                require(audits[-1]["before"]["revision"] == revision and audits[-1]["after"]["revision"] == revision + 1,
                        "audit revision snapshots do not match atomic correction")
                report(f"PostgreSQL concurrent correction: one success, one conflict, one audit (round {round_number}, revision {revision})", proof)
        check_rejections_and_immutability(engine, fixture, report)
        check_audit_rollback(engine, fixture, report)
