"""Staff password setup; legacy Worker names/URLs remain compatible."""
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
    email = {"invitation_id": None, "invitation_email_status": "not_sent",
             "invitation_email_attempted_at": None, "invitation_email_accepted_at": None}
    if not getattr(user, "password_setup_required", False):
        return {"invitation_status": None, "invitation_expires_at": None, **email}
    invitation = session.exec(select(WorkerInvitation).where(
        WorkerInvitation.worker_id == user.id,
    ).order_by(WorkerInvitation.id.desc())).first() if session else None
    if not invitation:
        return {"invitation_status": "none", "invitation_expires_at": None, **email}
    expires_at = normalized_datetime(invitation.expires_at)
    status = "revoked" if invitation.revoked_at or invitation.generation != user.invitation_generation or (
        invitation.invited_role != user.role or invitation.invited_is_global_admin != user.is_global_admin
    ) else (
        "expired" if expires_at <= utc_now() else "pending"
    )
    return {"invitation_status": status, "invitation_expires_at": expires_at.isoformat(),
            "invitation_id": invitation.id,
            "invitation_email_status": "unknown" if invitation.email_status == "requested" else invitation.email_status,
            "invitation_email_attempted_at": normalized_datetime(invitation.email_attempted_at).isoformat() if invitation.email_attempted_at else None,
            "invitation_email_accepted_at": normalized_datetime(invitation.email_accepted_at).isoformat() if invitation.email_accepted_at else None}


def _new_invitation(user, supervisor, session):
    token = secrets.token_urlsafe(32)
    now = utc_now()
    invitation = WorkerInvitation(
        worker_id=user.id, department_id=user.department_id, email=user.email,
        invited_role=user.role, invited_is_global_admin=user.is_global_admin,
        generation=user.invitation_generation, token_hash=secret_hash("worker-invitation", token),
        issued_by=supervisor.id, created_at=now,
        expires_at=now + timedelta(hours=WORKER_INVITATION_TTL_HOURS),
    )
    session.add(invitation)
    session.flush()
    add_audit_event(
        session, supervisor, "worker_invitation_issue", "user", user.id,
        after={"invitation_id": invitation.id, "expires_at": invitation.expires_at.isoformat(), "delivery_method": "manual"},
        summary="Issued a staff password-setup invitation for private handoff",
        department_id=user.department_id,
    )
    session.commit()
    session.refresh(user)
    return {
        "user": user_response(user, session), "token": token,
        "expires_at": normalized_datetime(invitation.expires_at).isoformat(), "delivery_method": "manual",
    }


def create_worker_invitation(data, supervisor: User, session: Session):
    # This legacy route remains Worker-only, even for old clients.
    return _create_invitation(data, supervisor, session, role="worker", is_global_admin=False)


def create_staff_invitation(data, supervisor: User, session: Session):
    return _create_invitation(data, supervisor, session, role=data.role, is_global_admin=data.is_global_admin)


def _create_invitation(data, supervisor, session, *, role, is_global_admin):
    if is_global_admin and not user_is_global_admin(supervisor):
        raise HTTPException(status_code=403, detail="Only global admins can grant global admin access")
    department_id = department_id_for_new_record(supervisor, session)
    if data.department_id and not user_is_global_admin(supervisor) and data.department_id != department_id:
        raise HTTPException(status_code=403, detail="Only global admins can choose another department")
    department_id = data.department_id if user_is_global_admin(supervisor) and data.department_id else department_id
    try:
        user = create_user_account(
            session, data.email, data.name, secrets.token_urlsafe(32), role,
            worker_class=data.worker_class, department_id=department_id, commit=False,
            is_global_admin=is_global_admin,
        )
        user.password_setup_required = True
        user.invitation_generation = 1
        session.add(user)
        session.flush()
        add_audit_event(session, supervisor, "user_create", "user", user.id,
                        after=model_snapshot(user), summary="Created staff user awaiting password setup",
                        department_id=user.department_id)
        return _new_invitation(user, supervisor, session)
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(status_code=409, detail="A user with this email already exists") from error


def _pending_worker(user_id, supervisor, session, *, require_active=True):
    user = session.get(User, user_id)
    if not user or not can_access_department(supervisor, user.department_id):
        raise HTTPException(status_code=404, detail="User not found")
    if user.is_global_admin and not user_is_global_admin(supervisor):
        raise HTTPException(status_code=403, detail="Only global admins can manage global admin invitations")
    if user.role not in {"worker", "supervisor"} or not user.password_setup_required or (require_active and user.status != "active"):
        raise HTTPException(status_code=409, detail="Invitations are only available for active users awaiting password setup")
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
        User.status == "active", User.role == user.role, User.is_global_admin == user.is_global_admin,
        User.department_id == user.department_id,
        User.email == user.email, User.invitation_generation == user.invitation_generation,
    ).values(invitation_generation=User.invitation_generation + 1).execution_options(synchronize_session=False))
    if changed.rowcount != 1:
        session.rollback()
        raise HTTPException(status_code=409, detail="User changed. Refresh Staff and try again.")
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
        User.role == user.role, User.is_global_admin == user.is_global_admin, User.department_id == user.department_id,
        User.email == user.email, User.invitation_generation == user.invitation_generation,
    ).values(invitation_generation=User.invitation_generation + 1).execution_options(synchronize_session=False))
    if changed.rowcount != 1:
        session.rollback()
        raise HTTPException(status_code=409, detail="User changed. Refresh Staff and try again.")
    session.execute(update(WorkerInvitation).where(
        WorkerInvitation.worker_id == user.id, WorkerInvitation.consumed_at.is_(None),
        WorkerInvitation.revoked_at.is_(None),
    ).values(revoked_at=utc_now()).execution_options(synchronize_session=False))
    add_audit_event(session, supervisor, "worker_invitation_revoke", "user", user.id,
                    summary="Revoked staff password-setup invitations", department_id=user.department_id)
    session.commit()
    session.refresh(user)
    return {"user": user_response(user, session), "message": "Invitation revoked. This user still needs to set a password."}


def _valid_invitation(token, session):
    invitation = session.exec(select(WorkerInvitation).where(
        WorkerInvitation.token_hash == secret_hash("worker-invitation", token),
    )).first()
    if not invitation or invitation.consumed_at or invitation.revoked_at or normalized_datetime(invitation.expires_at) <= utc_now():
        raise _invalid()
    user = session.get(User, invitation.worker_id)
    if not user or not user.password_setup_required or user.role not in {"worker", "supervisor"} or user.status != "active" or (
        user.email != invitation.email or user.department_id != invitation.department_id
        or user.invitation_generation != invitation.generation
        or user.role != invitation.invited_role or user.is_global_admin != invitation.invited_is_global_admin
        or (user.is_global_admin and user.role != "supervisor")
    ):
        raise _invalid()
    department = session.get(Department, user.department_id)
    if not department or department.status != "active":
        raise _invalid()
    return invitation, user, department


def inspect_worker_invitation(data, session: Session):
    invitation, user, department = _valid_invitation(data.token, session)
    return {"name": user.name, "email": user.email, "department_name": department.name,
            "role": invitation.invited_role, "is_global_admin": invitation.invited_is_global_admin,
            "expires_at": normalized_datetime(invitation.expires_at).isoformat()}


def accept_worker_invitation(data, session: Session):
    invitation, user, _ = _valid_invitation(data.token, session)
    validate_user_input(user.email, user.name, data.password, invitation.invited_role)
    password_hash = hash_password(data.password)
    # The conditional user update serializes accept/reissue/revoke on SQLite and
    # PostgreSQL without relying on a read-then-write single-use check.
    claimed = session.execute(update(User).where(
        User.id == user.id, User.password_setup_required == True,  # noqa: E712
        User.invitation_generation == invitation.generation,
        User.status == "active", User.role == invitation.invited_role,
        User.is_global_admin == invitation.invited_is_global_admin,
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
                    summary="Staff user completed password setup", department_id=invitation.department_id)
    session.commit()
    return {"message": "Password set. Sign in with your email and new password."}
