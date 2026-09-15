"""New-Worker password setup; manual private handoff, never account recovery."""
from datetime import datetime, timedelta, timezone
import secrets

from fastapi import HTTPException
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.auth import hash_password
from app.config import WORKER_INVITATION_TTL_HOURS
from app.models import Department, User, WorkerInvitation
from app.use_cases.audit import add_audit_event, model_snapshot
from app.use_cases.common import (
    can_access_department, department_id_for_new_record, ensure_department_exists,
    user_is_global_admin, user_response, validate_user_input,
)
from app.use_cases.registration import normalized_datetime, secret_hash
from app.use_cases.staff_site_admin import create_user_account


INVALID_INVITATION = "This invitation is invalid or expired. Ask your Supervisor for a new invitation."


def utc_now():
    return datetime.now(timezone.utc)


def _invalid():
    return HTTPException(status_code=400, detail=INVALID_INVITATION)


def invitation_metadata(user, session):
    if not getattr(user, "password_setup_required", False):
        return {"invitation_status": None, "invitation_expires_at": None}
    invitation = session.exec(select(WorkerInvitation).where(
        WorkerInvitation.worker_id == user.id,
    ).order_by(WorkerInvitation.id.desc())).first() if session else None
    if not invitation:
        return {"invitation_status": "none", "invitation_expires_at": None}
    expires_at = normalized_datetime(invitation.expires_at)
    status = "revoked" if invitation.revoked_at or invitation.generation != user.invitation_generation else (
        "expired" if expires_at <= utc_now() else "pending"
    )
    return {"invitation_status": status, "invitation_expires_at": expires_at.isoformat()}


def _new_invitation(user, supervisor, session):
    token = secrets.token_urlsafe(32)
    now = utc_now()
    invitation = WorkerInvitation(
        worker_id=user.id, department_id=user.department_id, email=user.email,
        generation=user.invitation_generation, token_hash=secret_hash("worker-invitation", token),
        issued_by=supervisor.id, created_at=now,
        expires_at=now + timedelta(hours=WORKER_INVITATION_TTL_HOURS),
    )
    session.add(invitation)
    session.flush()
    add_audit_event(
        session, supervisor, "worker_invitation_issue", "user", user.id,
        after={"invitation_id": invitation.id, "expires_at": invitation.expires_at.isoformat(), "delivery_method": "manual"},
        summary="Issued a Worker password-setup invitation for private handoff",
        department_id=user.department_id,
    )
    session.commit()
    session.refresh(user)
    return {
        "user": user_response(user, session), "token": token,
        "expires_at": normalized_datetime(invitation.expires_at).isoformat(), "delivery_method": "manual",
    }


def create_worker_invitation(data, supervisor: User, session: Session):
    department_id = department_id_for_new_record(supervisor, session)
    if data.department_id and not user_is_global_admin(supervisor) and data.department_id != department_id:
        raise HTTPException(status_code=403, detail="Only global admins can choose another department")
    department_id = data.department_id if user_is_global_admin(supervisor) and data.department_id else department_id
    try:
        user = create_user_account(
            session, data.email, data.name, secrets.token_urlsafe(32), "worker",
            worker_class=data.worker_class, department_id=department_id, commit=False,
        )
        user.password_setup_required = True
        user.invitation_generation = 1
        session.add(user)
        session.flush()
        add_audit_event(session, supervisor, "user_create", "user", user.id,
                        after=model_snapshot(user), summary="Created Worker awaiting password setup",
                        department_id=user.department_id)
        return _new_invitation(user, supervisor, session)
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(status_code=409, detail="A user with this email already exists") from error


def _pending_worker(user_id, supervisor, session, *, require_active=True):
    user = session.get(User, user_id)
    if not user or not can_access_department(supervisor, user.department_id):
        raise HTTPException(status_code=404, detail="Worker not found")
    if user.role != "worker" or not user.password_setup_required or (require_active and user.status != "active"):
        raise HTTPException(status_code=409, detail="Invitations are only available for active Workers awaiting password setup")
    return user


def invalidate_worker_invitations(user, session):
    """Serialize with acceptance; caller owns the surrounding staff-edit commit."""
    session.execute(update(User).where(User.id == user.id).values(
        invitation_generation=User.invitation_generation + 1,
    ).execution_options(synchronize_session=False))
    session.execute(update(WorkerInvitation).where(
        WorkerInvitation.worker_id == user.id, WorkerInvitation.consumed_at.is_(None),
        WorkerInvitation.revoked_at.is_(None),
    ).values(revoked_at=utc_now()).execution_options(synchronize_session=False))
    # Acceptance may have completed while this staff edit waited for the lock.
    # Refresh its setup state for accurate audits, preserving profile edits.
    session.refresh(user, ["invitation_generation", "password_setup_required"])


def reissue_worker_invitation(user_id, supervisor, session):
    user = _pending_worker(user_id, supervisor, session)
    ensure_department_exists(session, user.department_id)
    changed = session.execute(update(User).where(
        User.id == user.id, User.password_setup_required == True,  # noqa: E712
        User.status == "active", User.role == "worker", User.department_id == user.department_id,
        User.email == user.email, User.invitation_generation == user.invitation_generation,
    ).values(invitation_generation=User.invitation_generation + 1).execution_options(synchronize_session=False))
    if changed.rowcount != 1:
        session.rollback()
        raise HTTPException(status_code=409, detail="Worker changed. Refresh Staff and try again.")
    session.execute(update(WorkerInvitation).where(
        WorkerInvitation.worker_id == user.id, WorkerInvitation.consumed_at.is_(None),
        WorkerInvitation.revoked_at.is_(None),
    ).values(revoked_at=utc_now()).execution_options(synchronize_session=False))
    session.refresh(user)
    return _new_invitation(user, supervisor, session)


def revoke_worker_invitation(user_id, supervisor, session):
    user = _pending_worker(user_id, supervisor, session, require_active=False)
    changed = session.execute(update(User).where(
        User.id == user.id, User.password_setup_required == True,  # noqa: E712
        User.role == "worker", User.department_id == user.department_id,
        User.email == user.email, User.invitation_generation == user.invitation_generation,
    ).values(invitation_generation=User.invitation_generation + 1).execution_options(synchronize_session=False))
    if changed.rowcount != 1:
        session.rollback()
        raise HTTPException(status_code=409, detail="Worker changed. Refresh Staff and try again.")
    session.execute(update(WorkerInvitation).where(
        WorkerInvitation.worker_id == user.id, WorkerInvitation.consumed_at.is_(None),
        WorkerInvitation.revoked_at.is_(None),
    ).values(revoked_at=utc_now()).execution_options(synchronize_session=False))
    add_audit_event(session, supervisor, "worker_invitation_revoke", "user", user.id,
                    summary="Revoked Worker password-setup invitations", department_id=user.department_id)
    session.commit()
    session.refresh(user)
    return {"user": user_response(user, session), "message": "Invitation revoked. This Worker still needs to set a password."}


def _valid_invitation(token, session):
    invitation = session.exec(select(WorkerInvitation).where(
        WorkerInvitation.token_hash == secret_hash("worker-invitation", token),
    )).first()
    if not invitation or invitation.consumed_at or invitation.revoked_at or normalized_datetime(invitation.expires_at) <= utc_now():
        raise _invalid()
    user = session.get(User, invitation.worker_id)
    if not user or not user.password_setup_required or user.role != "worker" or user.status != "active" or (
        user.email != invitation.email or user.department_id != invitation.department_id
        or user.invitation_generation != invitation.generation
    ):
        raise _invalid()
    department = session.get(Department, user.department_id)
    if not department or department.status != "active":
        raise _invalid()
    return invitation, user, department


def inspect_worker_invitation(data, session: Session):
    invitation, user, department = _valid_invitation(data.token, session)
    return {"name": user.name, "email": user.email, "department_name": department.name,
            "expires_at": normalized_datetime(invitation.expires_at).isoformat()}


def accept_worker_invitation(data, session: Session):
    invitation, user, _ = _valid_invitation(data.token, session)
    validate_user_input(user.email, user.name, data.password, "worker")
    password_hash = hash_password(data.password)
    # The conditional user update serializes accept/reissue/revoke on SQLite and
    # PostgreSQL without relying on a read-then-write single-use check.
    claimed = session.execute(update(User).where(
        User.id == user.id, User.password_setup_required == True,  # noqa: E712
        User.invitation_generation == invitation.generation,
        User.status == "active", User.role == "worker",
        User.email == invitation.email, User.department_id == invitation.department_id,
        User.department_id.in_(select(Department.id).where(Department.status == "active")),
    ).values(password_hash=password_hash, password_setup_required=False,
             invitation_generation=User.invitation_generation + 1).execution_options(synchronize_session=False))
    # Lock acquisition may outlast the invitation. Check the current time only
    # after the serialized claim; rollback also restores the password on expiry.
    now = utc_now()
    consumed = session.execute(update(WorkerInvitation).where(
        WorkerInvitation.id == invitation.id, WorkerInvitation.consumed_at.is_(None),
        WorkerInvitation.revoked_at.is_(None), WorkerInvitation.expires_at > now,
    ).values(consumed_at=now).execution_options(synchronize_session=False)) if claimed.rowcount == 1 else None
    if claimed.rowcount != 1 or not consumed or consumed.rowcount != 1:
        session.rollback()
        raise _invalid()
    add_audit_event(session, user, "worker_invitation_accept", "user", user.id,
                    after={"invitation_id": invitation.id, "password_setup_required": False},
                    summary="Worker completed password setup", department_id=invitation.department_id)
    session.commit()
    return {"message": "Password set. Sign in with your email and new password."}
