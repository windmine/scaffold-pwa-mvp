from datetime import datetime, timedelta, timezone
import hmac
import secrets

from typing import Optional

from fastapi import Cookie, Depends, HTTPException, Response, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
from passlib.context import CryptContext
from sqlmodel import Session, select

from app.config import (
    ACCESS_TOKEN_EXPIRE_MINUTES,
    AUTH_COOKIE_SECURE,
    JWT_ALGORITHM,
    JWT_SECRET_KEY,
)
from app.database import get_session
from app.models import User


pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

AUTH_COOKIE_NAME = "__session"
LEGACY_AUTH_COOKIE_NAME = "geo_access_token"
CSRF_COOKIE_NAME = "geo_csrf_token"
CSRF_HEADER_NAME = "x-csrf-token"
bearer_scheme = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return pwd_context.verify(password, password_hash)


def create_access_token(data: dict) -> str:
    to_encode = data.copy()

    expire = datetime.now(timezone.utc) + timedelta(
        minutes=ACCESS_TOKEN_EXPIRE_MINUTES
    )

    to_encode.update({"exp": expire})

    return jwt.encode(to_encode, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


def create_csrf_token() -> str:
    return secrets.token_urlsafe(32)


def csrf_token_from_auth_cookie(token: str) -> Optional[str]:
    try:
        payload = jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
    except JWTError:
        return None

    token_value = payload.get("csrf")
    return token_value if isinstance(token_value, str) and token_value else None


def csrf_tokens_match(
    expected: str,
    cookie_value: Optional[str],
    header_value: Optional[str],
) -> bool:
    if not expected or not header_value:
        return False

    if not hmac.compare_digest(expected, header_value):
        return False

    return not cookie_value or hmac.compare_digest(expected, cookie_value)


def set_auth_cookie(response: Response, token: str, csrf_token: str):
    response.set_cookie(
        key=AUTH_COOKIE_NAME,
        value=token,
        max_age=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        httponly=True,
        secure=AUTH_COOKIE_SECURE,
        samesite="lax",
        path="/",
    )
    response.set_cookie(
        key=CSRF_COOKIE_NAME,
        value=csrf_token,
        max_age=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        httponly=False,
        secure=AUTH_COOKIE_SECURE,
        samesite="lax",
        path="/",
    )


def clear_auth_cookie(response: Response):
    response.delete_cookie(
        key=AUTH_COOKIE_NAME,
        path="/",
        secure=AUTH_COOKIE_SECURE,
        samesite="lax",
    )
    response.delete_cookie(
        key=LEGACY_AUTH_COOKIE_NAME,
        path="/",
        secure=AUTH_COOKIE_SECURE,
        samesite="lax",
    )
    response.delete_cookie(
        key=CSRF_COOKIE_NAME,
        path="/",
        secure=AUTH_COOKIE_SECURE,
        samesite="lax",
    )


def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    cookie_token: Optional[str] = Cookie(default=None, alias=AUTH_COOKIE_NAME),
    session: Session = Depends(get_session)
) -> User:
    token = credentials.credentials if credentials else cookie_token
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required"
        )

    try:
        payload = jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
        email = payload.get("sub")

        if email is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid token"
            )

    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token"
        )

    user = session.exec(
        select(User).where(User.email == email)
    ).first()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found"
        )

    if (user.status or "active") != "active":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This account is resigned and cannot sign in"
        )

    return user


def require_supervisor(user: User = Depends(get_current_user)) -> User:
    if user.role != "supervisor":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Supervisor only"
        )

    return user
