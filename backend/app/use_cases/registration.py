import hashlib
import hmac
import secrets
import smtplib
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

from fastapi import HTTPException
from sqlmodel import Session, select

from app.config import (
    JWT_SECRET_KEY,
    PRODUCTION_LIKE,
    REGISTRATION_CODE_TTL_MINUTES,
    REGISTRATION_COMPLETE_TTL_MINUTES,
    REGISTRATION_EXPOSE_CODE,
    REGISTRATION_MAX_ATTEMPTS,
    REGISTRATION_RESEND_SECONDS,
    SMTP_FROM_EMAIL,
    SMTP_HOST,
    SMTP_PASSWORD,
    SMTP_PORT,
    SMTP_USERNAME,
    SMTP_USE_SSL,
    SMTP_USE_STARTTLS,
)
from app.models import RegistrationVerification, User
from app.use_cases.common import ensure_department_exists, list_departments
from app.use_cases.staff_site_admin import create_user_account


def utc_now():
    return datetime.now(timezone.utc)


def normalized_datetime(value: datetime):
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def secret_hash(kind: str, value: str):
    payload = f"{kind}:{JWT_SECRET_KEY}:{value}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def normalize_identity(email: str, name: str):
    normalized_email = email.strip().lower()
    normalized_name = name.strip()

    if "@" not in normalized_email or "." not in normalized_email:
        raise HTTPException(status_code=400, detail="Enter a valid email address")
    if not normalized_name:
        raise HTTPException(status_code=400, detail="Name is required")

    return normalized_email, normalized_name


def smtp_is_configured():
    return bool(SMTP_HOST and SMTP_FROM_EMAIL)


def send_verification_email(email: str, code: str):
    if not smtp_is_configured():
        if PRODUCTION_LIKE:
            raise HTTPException(
                status_code=503,
                detail="Registration email service is not configured",
            )
        return

    message = EmailMessage()
    message["Subject"] = "Leader Field Operations verification code"
    message["From"] = SMTP_FROM_EMAIL
    message["To"] = email
    message.set_content(
        "Your Leader Field Operations verification code is "
        f"{code}. It expires in {REGISTRATION_CODE_TTL_MINUTES} minutes."
    )

    smtp_class = smtplib.SMTP_SSL if SMTP_USE_SSL else smtplib.SMTP
    try:
        with smtp_class(SMTP_HOST, SMTP_PORT, timeout=15) as smtp:
            if SMTP_USE_STARTTLS and not SMTP_USE_SSL:
                smtp.starttls()
            if SMTP_USERNAME:
                smtp.login(SMTP_USERNAME, SMTP_PASSWORD)
            smtp.send_message(message)
    except (OSError, smtplib.SMTPException) as error:
        raise HTTPException(
            status_code=503,
            detail="Could not send verification email",
        ) from error


def start_registration(data, session: Session):
    email, name = normalize_identity(data.email, data.name)
    existing_user = session.exec(
        select(User).where(User.email == email)
    ).first()
    if existing_user:
        raise HTTPException(status_code=409, detail="A user with this email already exists")

    now = utc_now()
    recent = session.exec(
        select(RegistrationVerification)
        .where(RegistrationVerification.email == email)
        .order_by(RegistrationVerification.created_at.desc())
    ).first()
    if recent:
        seconds_since_created = (now - normalized_datetime(recent.created_at)).total_seconds()
        if seconds_since_created < REGISTRATION_RESEND_SECONDS:
            raise HTTPException(
                status_code=429,
                detail="Please wait before requesting another verification code",
            )

    code = f"{secrets.randbelow(1_000_000):06d}"
    verification = RegistrationVerification(
        email=email,
        name=name,
        code_hash=secret_hash("registration-code", code),
        expires_at=now + timedelta(minutes=REGISTRATION_CODE_TTL_MINUTES),
    )
    session.add(verification)
    session.flush()

    try:
        send_verification_email(email, code)
    except HTTPException:
        session.rollback()
        raise

    session.commit()
    session.refresh(verification)

    response = {
        "verification_id": verification.id,
        "email": verification.email,
        "message": "Verification code sent",
        "expires_in_seconds": REGISTRATION_CODE_TTL_MINUTES * 60,
    }
    if REGISTRATION_EXPOSE_CODE:
        response["dev_verification_code"] = code
    return response


def verify_registration(data, session: Session):
    verification = session.get(RegistrationVerification, data.verification_id)
    if not verification or verification.consumed_at:
        raise HTTPException(status_code=400, detail="Verification request is invalid")
    if verification.verified_at:
        raise HTTPException(status_code=400, detail="Verification request is already verified")

    now = utc_now()
    if normalized_datetime(verification.expires_at) <= now:
        raise HTTPException(status_code=400, detail="Verification code has expired")
    if verification.attempts >= REGISTRATION_MAX_ATTEMPTS:
        raise HTTPException(status_code=429, detail="Too many verification attempts")

    expected_hash = secret_hash("registration-code", data.code)
    if not hmac.compare_digest(verification.code_hash, expected_hash):
        verification.attempts += 1
        session.add(verification)
        session.commit()
        if verification.attempts >= REGISTRATION_MAX_ATTEMPTS:
            raise HTTPException(status_code=429, detail="Too many verification attempts")
        raise HTTPException(status_code=400, detail="Verification code is incorrect")

    token = secrets.token_urlsafe(32)
    verification.token_hash = secret_hash("registration-token", token)
    verification.verified_at = now
    verification.expires_at = now + timedelta(minutes=REGISTRATION_COMPLETE_TTL_MINUTES)
    session.add(verification)
    session.commit()

    return {
        "verification_token": token,
        "email": verification.email,
        "name": verification.name,
        "departments": list_departments(session),
        "expires_in_seconds": REGISTRATION_COMPLETE_TTL_MINUTES * 60,
    }


def complete_registration(data, session: Session):
    token_hash = secret_hash("registration-token", data.verification_token)
    verification = session.exec(
        select(RegistrationVerification).where(
            RegistrationVerification.token_hash == token_hash
        )
    ).first()

    now = utc_now()
    if (
        not verification
        or not verification.verified_at
        or verification.consumed_at
        or normalized_datetime(verification.expires_at) <= now
    ):
        raise HTTPException(status_code=400, detail="Verified registration has expired")

    department = ensure_department_exists(session, data.department_id)
    user = create_user_account(
        session=session,
        email=verification.email,
        name=verification.name,
        password=data.password,
        role="worker",
        worker_class="normal",
        department_id=department.id,
        status="resigned",
        commit=False,
    )
    verification.consumed_at = now
    session.add(verification)
    session.commit()
    session.refresh(user)
    return user
