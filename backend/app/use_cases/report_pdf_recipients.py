"""Department account destinations; no network or independent commits."""

from fastapi import HTTPException
from sqlmodel import select

from app import email_transport
from app.models import Department, User

# Bound fan-out per Report, never the number of available Department accounts.
MAX_REPORT_PDF_RECIPIENTS = 20


def mailbox(value):
    if not isinstance(value, str):
        raise ValueError("Invalid mailbox")
    value = value.strip()
    try:
        if len(value) > 254:
            raise ValueError("Invalid mailbox")
        value.encode("ascii")
        email_transport.validate_mailbox(value)
    except (email_transport.EmailSendError, UnicodeError):
        raise ValueError("Invalid mailbox") from None
    return value


def recipient_key(value):
    return value.strip().casefold()


def department_recipients(form, session):
    """Offer activated accounts only, never another Department or arbitrary mail."""
    if session is None or not form.department_id:
        return []
    users = session.exec(select(User.id, User.name, User.email).where(
        User.department_id == form.department_id, User.status == "active",
        User.password_setup_required == False,  # noqa: E712
        User.department_id.in_(select(Department.id).where(Department.status == "active")),
    ).order_by(User.name, User.id)).all()
    recipients = []
    for user in users:
        try:
            address = mailbox(user.email)
        except ValueError:
            continue
        recipients.append({"user_id": user.id, "name": user.name, "email": address})
    return recipients


def email_options(form, session, recipient_users=None):
    users = department_recipients(form, session) if recipient_users is None else recipient_users
    choices = list(dict.fromkeys(user["email"] for user in users))
    default = next((value for value in choices
                    if recipient_key(value) == recipient_key(form.pdf_email_recipient or "")), None)
    return {"source": "department_users", "enabled": form.pdf_email_enabled,
            "version": form.pdf_email_version, "recipients": choices, "recipient_users": users,
            "max_selected_recipients": MAX_REPORT_PDF_RECIPIENTS,
            "default_recipients": [default] if form.pdf_email_enabled and default else [],
            "default_recipient_unavailable": bool(form.pdf_email_enabled and not default)}


def recipients_conflict():
    return HTTPException(status_code=409, detail={
        "code": "report_email_recipients_conflict",
        "message": "Department PDF recipients changed. Refresh the Template and review the recipients before submitting again.",
    })


def _locked_users(session, user_ids):
    # PostgreSQL row locks serialize membership/email changes with the submitted
    # snapshot. SQLite already has a write transaction after the Report insert.
    # Refresh the identity map: even the authenticated author may be stale.
    return {user.id: user for user in session.exec(select(User).where(
        User.id.in_(sorted(set(user_ids))),
    ).order_by(User.id).with_for_update().execution_options(populate_existing=True)).all()}


def resolve_recipients(form, author, session, selected=None, expected_version=None, selected_users=None):
    """Freeze the current account copy plus explicitly bound Department users."""
    if selected is None:
        if selected_users:
            raise recipients_conflict()
        options = email_options(form, session)
        if options["default_recipient_unavailable"]:
            raise recipients_conflict()
        selected = options["default_recipients"]
        selected_users = [user for user in options["recipient_users"] if user["email"] in selected]
        role = "template"
    else:
        # Explicit self-only remains valid across settings/directory changes.
        if selected and expected_version != form.pdf_email_version:
            raise recipients_conflict()
        role = "selected"
    if len(selected) > MAX_REPORT_PDF_RECIPIENTS:
        raise recipients_conflict()
    bindings = {}
    for item in selected_users or []:
        try:
            address = mailbox(item.email if hasattr(item, "email") else item["email"])
            user_id = item.user_id if hasattr(item, "user_id") else item["user_id"]
        except (ValueError, KeyError, TypeError):
            raise recipients_conflict() from None
        key = recipient_key(address)
        if key in bindings and bindings[key] != user_id:
            raise recipients_conflict()
        bindings[key] = user_id
    try:
        selected_keys = {recipient_key(mailbox(value)) for value in selected}
    except ValueError:
        raise recipients_conflict() from None
    if selected_keys != set(bindings):
        raise recipients_conflict()
    if selected_keys:
        department = session.exec(select(Department).where(Department.id == form.department_id)
                                  .with_for_update(read=True).execution_options(populate_existing=True)).first()
        if not department or department.status != "active":
            raise recipients_conflict()
    users = _locked_users(session, [author.id, *bindings.values()])
    current_author = users.get(author.id)
    if (not current_author or current_author.department_id != form.department_id
            or current_author.status != "active" or current_author.password_setup_required):
        raise recipients_conflict()
    own = (current_author.email or "").strip()
    own_valid = True
    try:
        own = mailbox(own)
    except ValueError:
        # A bad legacy account address must not lose a field Report.
        own_valid = False
    recipients = {recipient_key(own): (own, "submitter", own_valid)}
    for key, user_id in bindings.items():
        user = users.get(user_id)
        if (not user or user.department_id != form.department_id or user.status != "active"
                or user.password_setup_required or recipient_key(user.email) != key):
            raise recipients_conflict()
        recipients.setdefault(key, (mailbox(user.email), role, True))
    return list(recipients.values())
