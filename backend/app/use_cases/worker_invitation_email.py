"""Explicit Supervisor delivery of one existing Worker invitation."""
from urllib.parse import quote, urlsplit

from fastapi import HTTPException
from sqlalchemy import update
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import select

from app import email_transport
from app.config import PRODUCTION_LIKE, PUBLIC_APP_URL
from app.models import Department, User, WorkerInvitation
from app.use_cases.audit import add_audit_event
from app.use_cases.registration import normalized_datetime
from app.use_cases.worker_invitations import _invalid, _pending_worker, _valid_invitation, utc_now


def setup_url(token):
    try:
        url = urlsplit(PUBLIC_APP_URL)
        if (not url.hostname or url.username or url.password or url.query or url.fragment
                or url.path not in ("", "/") or "\\" in PUBLIC_APP_URL
                or any(character.isspace() for character in PUBLIC_APP_URL)
                or (url.scheme != "https" and not (
                    not PRODUCTION_LIKE and url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1", "::1"}
                ))):
            raise ValueError()
        _ = url.port
        return f"{url.scheme}://{url.netloc}/setup-password.html#token={quote(token, safe='')}"
    except ValueError:
        raise email_transport.EmailSendError() from None


def email_result(invitation):
    # A committed claim with no final result may be running or have lost its
    # acknowledgment. Neither case permits another send for this invitation.
    status = invitation.email_status
    if status == "requested":
        status = "unknown"
    return {
        "user_id": invitation.worker_id, "invitation_id": invitation.id,
        "recipient": invitation.email, "email_status": status,
        "email_attempted_at": normalized_datetime(invitation.email_attempted_at).isoformat() if invitation.email_attempted_at else None,
        "email_accepted_at": normalized_datetime(invitation.email_accepted_at).isoformat() if invitation.email_accepted_at else None,
    }


def send_worker_invitation_email(user_id, data, supervisor, session):
    user = _pending_worker(user_id, supervisor, session)
    invitation, _, _ = _valid_invitation(data.token, session)
    if invitation.worker_id != user.id:
        raise _invalid()
    if invitation.email_attempted_at is not None:
        return email_result(invitation)
    try:
        link = setup_url(data.token)
        email_transport.require_smtp_configuration()
        email_transport.validate_mailbox(user.email)
    except email_transport.EmailSendError:
        raise HTTPException(status_code=503, detail={
            "code": "INVITATION_EMAIL_UNAVAILABLE",
            "message": "Invitation email is unavailable. Copy or share the private link.",
        }) from None
    recipient = invitation.email
    body = (f"Hello {user.name},\n\nYour Supervisor has invited you to ReportFlow.\n\n"
            f"Set your password using this private link:\n{link}\n\n"
            f"The link expires at {normalized_datetime(invitation.expires_at).isoformat()} and can be used once.\n"
            "Do not forward it. If you were not expecting this invitation, contact your Supervisor.\n")
    # Acquire the same User lock/order as acceptance, reissue and revocation.
    # The no-op conditional update also works on SQLite, unlike SELECT FOR UPDATE.
    locked = session.execute(update(User).where(
        User.id == user.id, User.password_setup_required == True,  # noqa: E712
        User.invitation_generation == invitation.generation,
        User.status == "active", User.role == "worker", User.email == invitation.email,
        User.department_id == invitation.department_id,
        User.department_id.in_(select(Department.id).where(Department.status == "active")),
    ).values(invitation_generation=User.invitation_generation).execution_options(synchronize_session=False))
    if locked.rowcount != 1:
        session.rollback()
        raise _invalid()
    now = utc_now()
    claimed = session.execute(update(WorkerInvitation).where(
        WorkerInvitation.id == invitation.id, WorkerInvitation.email_attempted_at.is_(None),
        WorkerInvitation.revoked_at.is_(None), WorkerInvitation.consumed_at.is_(None),
        WorkerInvitation.expires_at > now,
    ).values(email_status="requested", email_attempted_at=now).execution_options(synchronize_session=False))
    if claimed.rowcount != 1:
        session.rollback()
        session.refresh(invitation)
        if invitation.email_attempted_at is not None:
            return email_result(invitation)
        raise _invalid()
    add_audit_event(session, supervisor, "worker_invitation_email_request", "user", user.id,
                    after={"invitation_id": invitation.id, "email_status": "requested"},
                    summary="Requested a Worker invitation email", department_id=invitation.department_id)
    # Commit before any SMTP activity. A crash, timeout or failed result commit
    # leaves a durable claim and cannot cause a duplicate email on replay.
    session.commit()
    invitation_id = invitation.id
    status = "accepted"
    try:
        _valid_invitation(data.token, session)
        email_transport.send_email(recipient, "Your ReportFlow invitation", body)
    except HTTPException:
        status = "failed"
    except email_transport.EmailSendError as error:
        status = error.outcome
    accepted_at = utc_now() if status == "accepted" else None
    try:
        session.execute(update(WorkerInvitation).where(WorkerInvitation.id == invitation_id).values(
            email_status=status, email_accepted_at=accepted_at,
        ).execution_options(synchronize_session=False))
        add_audit_event(session, supervisor, "worker_invitation_email_result", "user", user_id,
                        after={"invitation_id": invitation_id, "email_status": status},
                        summary="Recorded Worker invitation SMTP outcome; inbox delivery unverified",
                        department_id=invitation.department_id)
        session.commit()
    except SQLAlchemyError:
        session.rollback()
        raise HTTPException(status_code=503, detail="Email acceptance could not be confirmed. Do not resend; refresh Staff or share the private link.") from None
    session.refresh(invitation)
    return email_result(invitation)
