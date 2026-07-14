import os
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parent.parent
ROOT_DIR = BACKEND_DIR.parent


def load_env_file(path: Path):
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()

        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")

        if key:
            os.environ.setdefault(key, value)


load_env_file(ROOT_DIR / ".env.local")
load_env_file(ROOT_DIR / ".env")
load_env_file(BACKEND_DIR / ".env.local")
load_env_file(BACKEND_DIR / ".env")


def csv_env(name: str, default: str):
    value = os.environ.get(name, default)
    return [
        item.strip()
        for item in value.split(",")
        if item.strip()
    ]


def int_env(name: str, default: int):
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


def bool_env(name: str, default: bool):
    value = os.environ.get(name)

    if value is None:
        return default

    return value.strip().lower() in {"1", "true", "yes", "on"}


def path_env(name: str, default: Path):
    value = os.environ.get(name)
    path = Path(value) if value else default

    if not path.is_absolute():
        path = BACKEND_DIR / path

    return path.resolve()


def database_url_env(name: str, default: str):
    value = os.environ.get(name, default)

    if value.startswith("postgresql://"):
        return value.replace("postgresql://", "postgresql+psycopg://", 1)

    if value.startswith("postgres://"):
        return value.replace("postgres://", "postgresql+psycopg://", 1)

    return value


DATABASE_URL = database_url_env("DATABASE_URL", "sqlite:///./geo_management.db")
AUTO_MIGRATE = bool_env("AUTO_MIGRATE", True)
SQL_ECHO = bool_env("SQL_ECHO", False)
APP_ENV = os.environ.get("APP_ENV", os.environ.get("ENVIRONMENT", "development")).strip().lower()
PRODUCTION_LIKE = APP_ENV in {"prod", "production"} or bool(os.environ.get("K_SERVICE"))

JWT_SECRET_KEY = os.environ.get("GEO_SECRET_KEY", "dev-only-change-me")
JWT_ALGORITHM = os.environ.get("GEO_JWT_ALGORITHM", "HS256")
ACCESS_TOKEN_EXPIRE_MINUTES = int_env("ACCESS_TOKEN_EXPIRE_MINUTES", 60 * 24)
ENABLE_DEV_SEED = bool_env("ENABLE_DEV_SEED", False)
AUTH_COOKIE_SECURE = bool_env("AUTH_COOKIE_SECURE", PRODUCTION_LIKE)
RATE_LIMIT_ENABLED = bool_env("RATE_LIMIT_ENABLED", PRODUCTION_LIKE)
RATE_LIMIT_GENERAL_REQUESTS = int_env("RATE_LIMIT_GENERAL_REQUESTS", 300)
RATE_LIMIT_GENERAL_WINDOW_SECONDS = int_env("RATE_LIMIT_GENERAL_WINDOW_SECONDS", 60)
RATE_LIMIT_AUTH_REQUESTS = int_env("RATE_LIMIT_AUTH_REQUESTS", 30)
RATE_LIMIT_AUTH_WINDOW_SECONDS = int_env("RATE_LIMIT_AUTH_WINDOW_SECONDS", 60)
RATE_LIMIT_UPLOAD_REQUESTS = int_env("RATE_LIMIT_UPLOAD_REQUESTS", 30)
RATE_LIMIT_UPLOAD_WINDOW_SECONDS = int_env("RATE_LIMIT_UPLOAD_WINDOW_SECONDS", 60)

WEAK_SECRET_VALUES = {
    "",
    "dev-only-change-me",
    "change-this-dev-secret",
    "replace-with-a-strong-production-secret",
}

if PRODUCTION_LIKE and JWT_SECRET_KEY in WEAK_SECRET_VALUES:
    raise RuntimeError(
        "Set GEO_SECRET_KEY to a strong production secret before starting the backend."
    )

CORS_ORIGINS = csv_env(
    "CORS_ORIGINS",
    ",".join([
        "http://localhost:5173",
        "https://localhost:5173",
        "http://127.0.0.1:5173",
        "https://127.0.0.1:5173",
    ])
)

UPLOAD_DIR = path_env("UPLOAD_DIR", BACKEND_DIR / "uploads")
MAX_UPLOAD_BYTES = int_env("MAX_UPLOAD_BYTES", 5 * 1024 * 1024)
UPLOAD_STORAGE_BACKEND = os.environ.get("UPLOAD_STORAGE_BACKEND", "local").strip().lower()
UPLOAD_BUCKET = os.environ.get("UPLOAD_BUCKET", "").strip().removeprefix("gs://").rstrip("/")
UPLOAD_OBJECT_PREFIX = os.environ.get("UPLOAD_OBJECT_PREFIX", "uploads").strip().strip("/")

REGISTRATION_CODE_TTL_MINUTES = int_env("REGISTRATION_CODE_TTL_MINUTES", 10)
REGISTRATION_COMPLETE_TTL_MINUTES = int_env("REGISTRATION_COMPLETE_TTL_MINUTES", 30)
REGISTRATION_RESEND_SECONDS = int_env("REGISTRATION_RESEND_SECONDS", 60)
REGISTRATION_MAX_ATTEMPTS = int_env("REGISTRATION_MAX_ATTEMPTS", 5)
REGISTRATION_EXPOSE_CODE = bool_env("REGISTRATION_EXPOSE_CODE", not PRODUCTION_LIKE) and not PRODUCTION_LIKE

SMTP_HOST = os.environ.get("SMTP_HOST", "").strip()
SMTP_PORT = int_env("SMTP_PORT", 587)
SMTP_USERNAME = os.environ.get("SMTP_USERNAME", "").strip()
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")
SMTP_FROM_EMAIL = os.environ.get("SMTP_FROM_EMAIL", SMTP_USERNAME).strip()
SMTP_USE_SSL = bool_env("SMTP_USE_SSL", False)
SMTP_USE_STARTTLS = bool_env("SMTP_USE_STARTTLS", not SMTP_USE_SSL)
