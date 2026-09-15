"""Native PostgreSQL invitation races, only on the runner's owned databases."""

import threading
import time
from concurrent.futures import ThreadPoolExecutor

from fastapi import HTTPException
from sqlalchemy import event, text
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session, select

from app.auth import verify_password
from app.migrations import run_migrations, verify_migrations
from app.models import User, WorkerInvitation
from app.schemas import UserStatusRequest, WorkerInvitationAcceptRequest, WorkerInvitationCreateRequest, WorkerInvitationTokenRequest
from app.use_cases.audit import list_audit_events
from app.use_cases.staff_site_admin import list_users, update_user_status
from app.use_cases.worker_invitations import (
    accept_worker_invitation, create_worker_invitation, inspect_worker_invitation,
    reissue_worker_invitation, revoke_worker_invitation,
)
from postgres_review_rehearsal import is_statement, require


def overlapping_operations(engine, table, operations, preferred):
    """Prove two public operations contend on independent PostgreSQL sessions."""
    token = object()
    arrivals = threading.Barrier(2, timeout=10)
    winner_updated, release_winner = threading.Event(), threading.Event()
    participant_lock = threading.Lock()
    participants = {}

    def before_update(connection, _cursor, _statement, _parameters, context, _many):
        info = connection.info
        if (info.get("owned_race_token") is not token or info.get("owned_race_seen")
                or not is_statement(context, "update", table)):
            return
        info["owned_race_seen"] = True
        context.owned_race_claim = True
        arrivals.wait()
        if info["owned_race_label"] != preferred:
            require(winner_updated.wait(12), "preferred operation did not acquire its PostgreSQL claim")

    def after_update(connection, cursor, _statement, _parameters, context, _many):
        if (connection.info.get("owned_race_token") is token
                and connection.info["owned_race_label"] == preferred
                and getattr(context, "owned_race_claim", False)):
            require(cursor.rowcount == 1, "preferred operation did not update exactly one fixture row")
            winner_updated.set()
            require(release_winner.wait(12), "observer did not release the preferred operation")

    def contender(label, operation):
        with Session(engine) as session:
            connection = session.connection()
            info = connection.info
            connection.execute(text("SET LOCAL lock_timeout = '15s'"))
            connection.execute(text("SET LOCAL statement_timeout = '20s'"))
            pid, transaction_id = connection.execute(text("SELECT pg_backend_pid(), txid_current()")).one()
            info.update(owned_race_token=token, owned_race_label=label, owned_race_seen=False)
            with participant_lock:
                participants[label] = {"pid": pid, "transaction_id": transaction_id}
            try:
                return {"label": label, "status": 200, "response": operation(session)}
            except HTTPException as error:
                session.rollback()
                return {"label": label, "status": error.status_code, "detail": error.detail}
            except SQLAlchemyError:
                # SQL parameters can contain password/token hashes. Never put
                # them into the runner's persisted diagnostic evidence.
                session.rollback()
                raise RuntimeError("Owned PostgreSQL operation failed; SQL parameters suppressed") from None
            finally:
                for key in ("owned_race_token", "owned_race_label", "owned_race_seen"):
                    info.pop(key, None)

    event.listen(engine, "before_cursor_execute", before_update)
    event.listen(engine, "after_cursor_execute", after_update)
    executor = ThreadPoolExecutor(max_workers=2)
    futures = [executor.submit(contender, label, operation) for label, operation in operations.items()]
    proof = None
    try:
        require(winner_updated.wait(12), "neither operation reached its PostgreSQL claim")
        with participant_lock:
            snapshot = dict(participants)
        require(len(snapshot) == 2 and len({item["pid"] for item in snapshot.values()}) == 2,
                "race did not use two independent PostgreSQL backends")
        require(len({item["transaction_id"] for item in snapshot.values()}) == 2,
                "race did not use independent PostgreSQL transactions")
        winning_pid = snapshot[preferred]["pid"]
        blocked_pid = next(item["pid"] for label, item in snapshot.items() if label != preferred)
        deadline = time.monotonic() + 8
        with engine.connect() as observer:
            observer_pid = observer.execute(text("SELECT pg_backend_pid()")).scalar_one()
            require(observer_pid not in {winning_pid, blocked_pid}, "observer reused an operation's backend")
            while time.monotonic() < deadline:
                blockers = observer.execute(text("SELECT pg_blocking_pids(:pid)"), {"pid": blocked_pid}).scalar_one()
                if winning_pid in blockers:
                    proof = {"winner_pid": winning_pid, "blocked_pid": blocked_pid, "observer_pid": observer_pid}
                    break
                time.sleep(0.02)
        require(proof is not None, "PostgreSQL did not observe the competing operation blocked on the winner")
        release_winner.set()
        outcomes = {result["label"]: result for result in (future.result(timeout=15) for future in futures)}
        return outcomes, {"backend_transactions": snapshot, "lock_contention": proof,
                          "preferred_operation": preferred,
                          "outcomes": {label: item["status"] for label, item in outcomes.items()}}
    finally:
        release_winner.set()
        arrivals.abort()
        executor.shutdown(wait=True, cancel_futures=True)
        event.remove(engine, "before_cursor_execute", before_update)
        event.remove(engine, "after_cursor_execute", after_update)


def seed_supervisors(engine):
    with Session(engine) as session:
        supervisors = [User(department_id=1, role="supervisor", name=f"Fixture Supervisor {number}",
                            email=f"supervisor-{number}@rehearsal.invalid", password_hash="not-a-login")
                       for number in (1, 2)]
        session.add_all(supervisors)
        session.commit()
        return [user.id for user in supervisors]


def issue_fixture(engine, supervisor_id, label):
    with Session(engine) as session:
        return create_worker_invitation(WorkerInvitationCreateRequest(
            name="Invitation fixture Worker", email=f"{label}@rehearsal.invalid", worker_class="normal",
        ), session.get(User, supervisor_id), session)


def worker_snapshot(engine, supervisor_id, worker_id):
    with Session(engine) as session:
        supervisor = session.get(User, supervisor_id)
        worker = next(item for item in list_users(session, supervisor) if item["id"] == worker_id)
        audits = [item for item in list_audit_events(session, supervisor)
                  if item["entity_type"] == "user" and item["entity_id"] == worker_id]
        invitations = session.exec(select(WorkerInvitation).where(
            WorkerInvitation.worker_id == worker_id,
        ).order_by(WorkerInvitation.id)).all()
        return worker, audits, [{"id": row.id, "consumed": row.consumed_at is not None,
                                "revoked": row.revoked_at is not None} for row in invitations]


def check_acceptance_race(engine, supervisors, report):
    issued = issue_fixture(engine, supervisors[0], "accept-accept")
    worker_id, token = issued["user"]["id"], issued["token"]
    passwords = {"first": "First owned password 9!", "second": "Second owned password 9!"}
    operations = {label: (lambda session, password=password: accept_worker_invitation(
        WorkerInvitationAcceptRequest(token=token, password=password), session))
        for label, password in passwords.items()}
    outcomes, proof = overlapping_operations(engine, "user", operations, "first")
    require(outcomes["first"]["status"] == 200 and outcomes["second"]["status"] == 400,
            "simultaneous invitation acceptance did not produce exactly one successful claim")
    worker, audits, invitations = worker_snapshot(engine, supervisors[0], worker_id)
    accepted = [item for item in audits if item["action"] == "worker_invitation_accept"]
    require(not worker["password_setup_required"] and worker["status"] == "active",
            "successful invitation did not establish the active Worker")
    require(len(accepted) == 1 and accepted[0]["actor_id"] == worker_id
            and sum(item["consumed"] for item in invitations) == 1,
            "invitation race did not persist exactly one consumption and Worker acceptance audit")
    with Session(engine) as session:
        password_hash = session.get(User, worker_id).password_hash
        require(verify_password(passwords["first"], password_hash)
                and not verify_password(passwords["second"], password_hash),
                "losing invitation claim replaced the winning Worker's password")
    report("PostgreSQL simultaneous invitation acceptance: one claim, one consumption, one audit, winning password", proof)


def check_acceptance_against_staff_action(engine, supervisors, action, preferred, report):
    issued = issue_fixture(engine, supervisors[0], f"accept-{action}-{preferred}")
    worker_id, token = issued["user"]["id"], issued["token"]
    password = "Owned acceptance password 9!"
    with Session(engine) as session:
        original_hash = session.get(User, worker_id).password_hash

    def staff_action(session):
        supervisor = session.get(User, supervisors[1])
        if action == "reissue":
            return reissue_worker_invitation(worker_id, supervisor, session)
        if action == "revoke":
            return revoke_worker_invitation(worker_id, supervisor, session)
        return update_user_status(worker_id, UserStatusRequest(status="resigned", confirmed=True), supervisor, session)

    outcomes, proof = overlapping_operations(engine, "user", {
        "accept": lambda session: accept_worker_invitation(
            WorkerInvitationAcceptRequest(token=token, password=password), session),
        action: staff_action,
    }, preferred)
    accepted = preferred == "accept"
    expected_staff = 200 if preferred == action or action == "resign" else 409
    require(outcomes["accept"]["status"] == (200 if accepted else 400)
            and outcomes[action]["status"] == expected_staff,
            f"accept/{action} did not preserve the serialized winning operation")
    worker, audits, invitations = worker_snapshot(engine, supervisors[0], worker_id)
    require(worker["password_setup_required"] == (not accepted)
            and worker["status"] == ("resigned" if action == "resign" else "active"),
            f"accept/{action} persisted an incorrect Worker setup or employment state")
    expected_actions = {"user_create": 1, "worker_invitation_issue": 1 + int(action == "reissue" and not accepted)}
    if accepted:
        expected_actions["worker_invitation_accept"] = 1
    if action == "revoke" and not accepted:
        expected_actions["worker_invitation_revoke"] = 1
    if action == "resign":
        expected_actions["user_status"] = 1
    actual_actions = {item["action"]: sum(row["action"] == item["action"] for row in audits) for item in audits}
    require(actual_actions == expected_actions, f"accept/{action} wrote missing or duplicate audits")
    require(sum(item["consumed"] for item in invitations) == int(accepted)
            and len(invitations) == 1 + int(action == "reissue" and not accepted),
            f"accept/{action} produced incorrect durable invitation effects")
    if not accepted:
        require(invitations[0]["revoked"], f"{action} did not invalidate the original invitation")
    with Session(engine) as session:
        current_hash = session.get(User, worker_id).password_hash
        require(verify_password(password, current_hash) if accepted else current_hash == original_hash,
                f"accept/{action} overwrote a password outside a successful claim")
        try:
            inspect_worker_invitation(WorkerInvitationTokenRequest(token=token), session)
        except HTTPException as error:
            require(error.status_code == 400, "old invitation failed for an unrelated reason")
        else:
            raise AssertionError(f"accept/{action} left the original invitation usable")
        if action == "reissue" and not accepted:
            replacement = outcomes[action]["response"]["token"]
            require(inspect_worker_invitation(WorkerInvitationTokenRequest(token=replacement), session)["email"] == worker["email"],
                    "winning reissue did not leave its replacement invitation valid")
    if action == "resign":
        status_audit = next(item for item in audits if item["action"] == "user_status")
        require(status_audit["after"]["status"] == "resigned"
                and status_audit["after"]["password_setup_required"] == worker["password_setup_required"],
                "resignation audit did not match the serialized Worker password-setup state")
    report(f"PostgreSQL invitation accept/{action}, {preferred} first: serialized claim, audit and invalidation effects", proof)


def check_reissue_race(engine, supervisors, report):
    issued = issue_fixture(engine, supervisors[0], "reissue-reissue")
    worker_id = issued["user"]["id"]
    operations = {label: (lambda session, actor=actor: reissue_worker_invitation(
        worker_id, session.get(User, actor), session,
    )) for label, actor in zip(("first", "second"), supervisors)}
    outcomes, proof = overlapping_operations(engine, "user", operations, "second")
    require(outcomes["second"]["status"] == 200 and outcomes["first"]["status"] == 409,
            "simultaneous invitation reissue did not produce exactly one new link")
    worker, audits, invitations = worker_snapshot(engine, supervisors[0], worker_id)
    issuance = [row for row in audits if row["action"] == "worker_invitation_issue"]
    require(worker["password_setup_required"] and len(invitations) == 2
            and invitations[0]["revoked"] and not invitations[1]["revoked"]
            and not any(row["consumed"] for row in invitations),
            "competing invitation reissue did not preserve one pending replacement")
    require(len(audits) == 3 and len(issuance) == 2 and issuance[0]["actor_id"] == supervisors[1],
            "competing invitation reissue created an extra or incorrectly attributed audit")
    with Session(engine) as session:
        replacement = outcomes["second"]["response"]["token"]
        require(inspect_worker_invitation(WorkerInvitationTokenRequest(token=replacement), session)["email"] == worker["email"],
                "winning replacement invitation is not usable")
        try:
            inspect_worker_invitation(WorkerInvitationTokenRequest(token=issued["token"]), session)
        except HTTPException as error:
            require(error.status_code == 400, "replaced invitation failed for an unrelated reason")
        else:
            raise AssertionError("simultaneous reissue revived the original invitation")
    report("PostgreSQL simultaneous invitation reissue: one replacement, one conflict, one new audit, old link invalid", proof)


def run_invitation_checks(database, report):
    with database("worker_invitations") as engine:
        require(engine.dialect.name == "postgresql", "invitation rehearsal requires native PostgreSQL")
        run_migrations(engine)
        with engine.connect() as connection:
            verify_migrations(connection)
        supervisors = seed_supervisors(engine)
        check_acceptance_race(engine, supervisors, report)
        for action in ("reissue", "revoke", "resign"):
            for preferred in (action, "accept"):
                check_acceptance_against_staff_action(engine, supervisors, action, preferred, report)
        check_reissue_race(engine, supervisors, report)
