"""Expiring, single-use recovery for existing Workers; private manual handoff."""
from datetime import datetime, timedelta, timezone
import secrets

from fastapi import HTTPException
from sqlalchemy import update
from sqlmodel import Session, select

from app.auth import hash_password
from app.config import WORKER_PASSWORD_RECOVERY_TTL_MINUTES
from app.models import Department, User, WorkerPasswordRecovery
from app.use_cases.audit import add_audit_event
from app.use_cases.common import can_access_department, ensure_department_exists, user_response
from app.use_cases.registration import normalized_datetime, secret_hash


INVALID_RECOVERY = "This recovery link is invalid or expired. Ask your Supervisor for a new recovery link."


def utc_now():
    return datetime.now(timezone.utc)


def _invalid():
    return HTTPException(status_code=400, detail=INVALID_RECOVERY)


def password_recovery_metadata(user, session):
    recovery = session.exec(select(WorkerPasswordRecovery).where(
        WorkerPasswordRecovery.worker_id == user.id,
    ).order_by(WorkerPasswordRecovery.id.desc())).first() if session else None
    if not recovery:
        return {"password_recovery_status": None, "password_recovery_expires_at": None}
    expires_at = normalized_datetime(recovery.expires_at)
    status = "used" if recovery.consumed_at else (
        "revoked" if recovery.revoked_at or recovery.generation != user.password_recovery_generation else (
            "expired" if expires_at <= utc_now() else "pending"
        )
    )
    return {"password_recovery_status": status, "password_recovery_expires_at": expires_at.isoformat()}


def _eligible_worker(user_id, supervisor, session):
    user = session.get(User, user_id)
    if not user or not can_access_department(supervisor, user.department_id):
        raise HTTPException(status_code=404, detail="Worker not found")
    if user.role != "worker" or user.password_setup_required or user.status != "active":
        raise HTTPException(status_code=409, detail="Password recovery is only available for active Workers who have already set a password")
    ensure_department_exists(session, user.department_id)
    return user


def _advance_generation(user, session):
    # The single conditional UPDATE serializes issuance/revocation with reset.
    changed = session.execute(update(User).where(
        User.id == user.id, User.role == "worker", User.status == "active",
        User.password_setup_required == False,  # noqa: E712
        User.department_id == user.department_id, User.email == user.email,
        User.password_recovery_generation == user.password_recovery_generation,
        User.department_id.in_(select(Department.id).where(Department.status == "active")),
    ).values(password_recovery_generation=User.password_recovery_generation + 1)
        .execution_options(synchronize_session=False))
    if changed.rowcount != 1:
        session.rollback()
        raise HTTPException(status_code=409, detail="Worker changed. Refresh Staff and try again.")
    _revoke_pending(user.id, session)
    session.refresh(user)


def _revoke_pending(user_id, session):
    session.execute(update(WorkerPasswordRecovery).where(
        WorkerPasswordRecovery.worker_id == user_id,
        WorkerPasswordRecovery.consumed_at.is_(None), WorkerPasswordRecovery.revoked_at.is_(None),
    ).values(revoked_at=utc_now()).execution_options(synchronize_session=False))


def invalidate_worker_password_recovery(user, session, *, password_changed=False):
    """Staff edits serialize on the same User row; caller owns the commit."""
    values = {"password_recovery_generation": User.password_recovery_generation + 1}
    if password_changed:
        values["auth_generation"] = User.auth_generation + 1
        values["legacy_auth_allowed"] = False
    session.execute(update(User).where(User.id == user.id).values(**values)
                    .execution_options(synchronize_session=False))
    _revoke_pending(user.id, session)
    session.refresh(user, ["password_recovery_generation", "auth_generation", "legacy_auth_allowed"])


def issue_worker_password_recovery(user_id, supervisor: User, session: Session):
    user = _eligible_worker(user_id, supervisor, session)
    _advance_generation(user, session)
    token = secrets.token_urlsafe(32)
    now = utc_now()
    recovery = WorkerPasswordRecovery(
        worker_id=user.id, department_id=user.department_id, email=user.email,
        generation=user.password_recovery_generation,
        token_hash=secret_hash("worker-password-recovery", token), issued_by=supervisor.id,
        created_at=now, expires_at=now + timedelta(minutes=WORKER_PASSWORD_RECOVERY_TTL_MINUTES),
    )
    session.add(recovery)
    session.flush()
    add_audit_event(session, supervisor, "worker_password_recovery_issue", "user", user.id,
                    after={"recovery_id": recovery.id, "expires_at": recovery.expires_at.isoformat(), "delivery_method": "manual"},
                    summary="Issued a Worker password-recovery link for private handoff", department_id=user.department_id)
    session.commit()
    session.refresh(user)
    return {"user": user_response(user, session), "token": token,
            "expires_at": normalized_datetime(recovery.expires_at).isoformat(), "delivery_method": "manual"}


def revoke_worker_password_recovery(user_id, supervisor: User, session: Session):
    user = _eligible_worker(user_id, supervisor, session)
    _advance_generation(user, session)
    add_audit_event(session, supervisor, "worker_password_recovery_revoke", "user", user.id,
                    summary="Revoked Worker password-recovery links", department_id=user.department_id)
    session.commit()
    session.refresh(user)
    return {"user": user_response(user, session), "message": "Recovery link revoked. The current password is unchanged."}


def _valid_recovery(token, session):
    if not token.isascii():
        raise _invalid()
    recovery = session.exec(select(WorkerPasswordRecovery).where(
        WorkerPasswordRecovery.token_hash == secret_hash("worker-password-recovery", token),
    )).first()
    if not recovery or recovery.consumed_at or recovery.revoked_at or normalized_datetime(recovery.expires_at) <= utc_now():
        raise _invalid()
    user = session.get(User, recovery.worker_id)
    if not user or user.password_setup_required or user.role != "worker" or user.status != "active" or (
        user.email != recovery.email or user.department_id != recovery.department_id
        or user.password_recovery_generation != recovery.generation
    ):
        raise _invalid()
    department = session.get(Department, user.department_id)
    if not department or department.status != "active":
        raise _invalid()
    return recovery, user, department


def inspect_worker_password_recovery(data, session: Session):
    recovery, user, department = _valid_recovery(data.token, session)
    return {"name": user.name, "email": user.email, "department_name": department.name,
            "expires_at": normalized_datetime(recovery.expires_at).isoformat()}


def accept_worker_password_recovery(data, session: Session):
    recovery, user, _ = _valid_recovery(data.token, session)
    # bcrypt's limit is bytes, not Unicode codepoints. Do not echo input values.
    try:
        password_bytes = len(data.password.encode("utf-8"))
    except UnicodeEncodeError:
        password_bytes = 73
    if len(data.password) < 8 or password_bytes > 72:
        raise HTTPException(status_code=422, detail="Password must be at least 8 characters and no more than 72 UTF-8 bytes.")
    password_hash = hash_password(data.password)
    claimed = session.execute(update(User).where(
        User.id == user.id, User.role == "worker", User.status == "active",
        User.password_setup_required == False,  # noqa: E712
        User.password_recovery_generation == recovery.generation,
        User.email == recovery.email, User.department_id == recovery.department_id,
        User.department_id.in_(select(Department.id).where(Department.status == "active")),
    ).values(password_hash=password_hash, auth_generation=User.auth_generation + 1, legacy_auth_allowed=False,
             password_recovery_generation=User.password_recovery_generation + 1)
        .execution_options(synchronize_session=False))
    # Expiry must be checked after waiting for the serialized claim. If expired,
    # rollback restores the password and both generations atomically.
    now = utc_now()
    consumed = session.execute(update(WorkerPasswordRecovery).where(
        WorkerPasswordRecovery.id == recovery.id, WorkerPasswordRecovery.consumed_at.is_(None),
        WorkerPasswordRecovery.revoked_at.is_(None), WorkerPasswordRecovery.expires_at > now,
    ).values(consumed_at=now).execution_options(synchronize_session=False)) if claimed.rowcount == 1 else None
    if claimed.rowcount != 1 or not consumed or consumed.rowcount != 1:
        session.rollback()
        raise _invalid()
    add_audit_event(session, user, "worker_password_recovery_accept", "user", user.id,
                    after={"recovery_id": recovery.id, "previous_sessions_revoked": True},
                    summary="Worker reset their password and revoked prior sessions", department_id=recovery.department_id)
    session.commit()
    return {"message": "Password changed. Sign in with your email and new password."}
