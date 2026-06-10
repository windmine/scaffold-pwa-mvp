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


load_env_file(ROOT_DIR / ".env")
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


DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./geo_management.db")
AUTO_MIGRATE = bool_env("AUTO_MIGRATE", True)
SQL_ECHO = bool_env("SQL_ECHO", False)
APP_ENV = os.environ.get("APP_ENV", os.environ.get("ENVIRONMENT", "development")).strip().lower()
PRODUCTION_LIKE = APP_ENV in {"prod", "production"} or bool(os.environ.get("K_SERVICE"))

JWT_SECRET_KEY = os.environ.get("GEO_SECRET_KEY", "dev-only-change-me")
JWT_ALGORITHM = os.environ.get("GEO_JWT_ALGORITHM", "HS256")
ACCESS_TOKEN_EXPIRE_MINUTES = int_env("ACCESS_TOKEN_EXPIRE_MINUTES", 60 * 24)
ENABLE_DEV_SEED = bool_env("ENABLE_DEV_SEED", False)
AUTH_COOKIE_SECURE = bool_env("AUTH_COOKIE_SECURE", PRODUCTION_LIKE)

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
