"""Recovery credential races on the runner's owned native PostgreSQL only."""
from datetime import timedelta
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import event
from sqlmodel import Session, select

from app.auth import verify_password
from app.migrations import run_migrations
from app.models import AuditEvent, User, WorkerPasswordRecovery
from app.schemas import UserStatusRequest, UserUpdateRequest, WorkerPasswordRecoveryAcceptRequest, WorkerPasswordRecoveryTokenRequest
from app.use_cases.staff_site_admin import create_user_account, update_user, update_user_status
from app.use_cases import worker_password_recovery as recovery
from postgres_invitation_rehearsal import overlapping_operations, seed_supervisors
from postgres_review_rehearsal import is_statement, require


ORIGINAL_PASSWORD = "Original owned password 9!"
RESET_PASSWORD = "Reset owned password 9!"
ADMIN_PASSWORD = "Edited owned password 9!"


def issue_fixture(engine, supervisor_id, label):
    with Session(engine) as session:
        target = create_user_account(session, f"{label}@recovery-rehearsal.invalid", "Owned Worker",
                                     ORIGINAL_PASSWORD, "worker", department_id=1)
        return recovery.issue_worker_password_recovery(target.id, session.get(User, supervisor_id), session)


def assert_original_invalid(engine, token):
    with Session(engine) as session:
        try:
            recovery.inspect_worker_password_recovery(WorkerPasswordRecoveryTokenRequest(token=token), session)
        except HTTPException as error:
            require(error.status_code == 400 and error.detail == recovery.INVALID_RECOVERY,
                    "invalidated recovery returned an unexpected error")
        else:
            raise AssertionError("original recovery link remained usable")


def check_race(engine, supervisors, action, preferred, report):
    issued = issue_fixture(engine, supervisors[0], f"{action}-{preferred}")
    worker_id, token = issued["user"]["id"], issued["token"]

    def staff_action(session):
        supervisor = session.get(User, supervisors[1])
        if action == "reissue":
            return recovery.issue_worker_password_recovery(worker_id, supervisor, session)
        if action == "revoke":
            return recovery.revoke_worker_password_recovery(worker_id, supervisor, session)
        if action == "accept_again":
            return recovery.accept_worker_password_recovery(WorkerPasswordRecoveryAcceptRequest(token=token, password=ADMIN_PASSWORD), session)
        if action == "resign":
            return update_user_status(worker_id, UserStatusRequest(status="resigned", confirmed=True), supervisor, session)
        changes = {"password": {"password": ADMIN_PASSWORD}, "email": {"email": f"updated-{preferred}@recovery-rehearsal.invalid"},
                   "role": {"role": "supervisor"}, "name": {"name": "Renamed Worker"}}[action]
        return update_user(worker_id, UserUpdateRequest(confirmed=True, **changes), supervisor, session)

    outcomes, proof = overlapping_operations(engine, "user", {
        "accept": lambda session: recovery.accept_worker_password_recovery(
            WorkerPasswordRecoveryAcceptRequest(token=token, password=RESET_PASSWORD), session),
        action: staff_action,
    }, preferred)
    accepted = preferred == "accept"
    other_status = (400 if action == "accept_again" else 409) if accepted and action in ("reissue", "revoke", "accept_again") else 200
    require(outcomes["accept"]["status"] == (200 if accepted else 400)
            and outcomes[action]["status"] == other_status,
            f"recovery accept/{action} did not respect the first serialized operation")
    with Session(engine) as session:
        user = session.get(User, worker_id)
        rows = session.exec(select(WorkerPasswordRecovery).where(WorkerPasswordRecovery.worker_id == worker_id)).all()
        audits = session.exec(select(AuditEvent).where(AuditEvent.entity_type == "user", AuditEvent.entity_id == worker_id)).all()
        reset_count = int(accepted or action == "accept_again")
        require(sum(row.consumed_at is not None for row in rows) == reset_count, "incorrect recovery consumption count")
        require(sum(row.action == "worker_password_recovery_accept" for row in audits) == reset_count,
                "incorrect recovery acceptance audit count")
        expected_password = ADMIN_PASSWORD if action == "password" or (action == "accept_again" and not accepted) else (
            RESET_PASSWORD if accepted else ORIGINAL_PASSWORD)
        require(verify_password(expected_password, user.password_hash), "race persisted the wrong credential")
        require(user.auth_generation == reset_count + int(action == "password"), "session generation did not match credential rotations")
        if action == "resign":
            require(user.status == "resigned", "resignation did not persist")
        if action == "reissue" and not accepted:
            replacement = outcomes[action]["response"]["token"]
            recovery.inspect_worker_password_recovery(WorkerPasswordRecoveryTokenRequest(token=replacement), session)
    assert_original_invalid(engine, token)
    report(f"PostgreSQL recovery accept/{action}, {preferred} first: credential, generation, consumption and audit agree", proof)


def check_reissue_race(engine, supervisors, report):
    issued = issue_fixture(engine, supervisors[0], "competing-reissues")
    worker_id = issued["user"]["id"]
    operations = {label: (lambda session, actor=actor: recovery.issue_worker_password_recovery(
        worker_id, session.get(User, actor), session)) for label, actor in zip(("first", "second"), supervisors)}
    outcomes, proof = overlapping_operations(engine, "user", operations, "first")
    require(outcomes["first"]["status"] == 200 and outcomes["second"]["status"] == 409,
            "competing recovery issuance did not leave exactly one replacement")
    assert_original_invalid(engine, issued["token"])
    with Session(engine) as session:
        recovery.inspect_worker_password_recovery(WorkerPasswordRecoveryTokenRequest(token=outcomes["first"]["response"]["token"]), session)
        require(session.get(User, worker_id).auth_generation == 0, "issuance changed an established credential")
    report("PostgreSQL recovery reissue/reissue: one replacement, losing conflict, unchanged credential generation", proof)


def check_expiry_after_claim(engine, supervisor_id, report):
    issued = issue_fixture(engine, supervisor_id, "expiry-after-lock")
    worker_id, token = issued["user"]["id"], issued["token"]
    with Session(engine) as session:
        row = session.exec(select(WorkerPasswordRecovery).where(WorkerPasswordRecovery.worker_id == worker_id)).one()
        expired_now = recovery.normalized_datetime(row.expires_at) + timedelta(seconds=1)
    real_now = recovery.utc_now
    claimed = False
    def after_claim(_connection, _cursor, _statement, _parameters, context, _many):
        nonlocal claimed
        if is_statement(context, "update", "user"):
            claimed = True
    event.listen(engine, "after_cursor_execute", after_claim)
    try:
        with patch.object(recovery, "utc_now", side_effect=lambda: expired_now if claimed else real_now()):
            with Session(engine) as session:
                try:
                    recovery.accept_worker_password_recovery(WorkerPasswordRecoveryAcceptRequest(token=token, password=RESET_PASSWORD), session)
                except HTTPException as error:
                    require(error.status_code == 400, "post-lock expiry returned an unexpected error")
                else:
                    raise AssertionError("expired-after-claim recovery changed a password")
    finally:
        event.remove(engine, "after_cursor_execute", after_claim)
    with Session(engine) as session:
        user = session.get(User, worker_id)
        require(claimed and user.auth_generation == 0 and user.password_recovery_generation == 1
                and verify_password(ORIGINAL_PASSWORD, user.password_hash), "expiry rollback failed to restore credentials/generations")
        row = session.exec(select(WorkerPasswordRecovery).where(WorkerPasswordRecovery.worker_id == worker_id)).one()
        require(row.consumed_at is None, "expiry rollback consumed the recovery link")
    report("PostgreSQL recovery expiry rechecked after claim: password, generations and consumption rollback atomically")


def run_password_recovery_checks(database, report):
    with database("password_recovery") as engine:
        require(engine.dialect.name == "postgresql", "recovery rehearsal requires native PostgreSQL")
        run_migrations(engine)
        supervisors = seed_supervisors(engine)
        for action in ("accept_again", "reissue", "revoke", "resign", "password", "email", "role", "name"):
            for preferred in (action, "accept"):
                check_race(engine, supervisors, action, preferred, report)
        check_reissue_race(engine, supervisors, report)
        check_expiry_after_claim(engine, supervisors[0], report)
