import json
import mimetypes
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from app.config import (
    UPLOAD_BUCKET,
    UPLOAD_DIR,
    UPLOAD_OBJECT_PREFIX,
    UPLOAD_STORAGE_BACKEND,
)


@dataclass
class StoredUpload:
    content: bytes
    content_type: str
    uploaded_by: Optional[int] = None


def ensure_upload_storage_ready():
    if upload_storage_backend() == "local":
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def upload_storage_backend():
    if UPLOAD_STORAGE_BACKEND in {"gcs", "cloud-storage", "cloud_storage"}:
        return "gcs"
    if UPLOAD_BUCKET:
        return "gcs"
    return "local"


def validate_upload_filename(filename: str):
    if not filename or Path(filename).name != filename or "/" in filename or "\\" in filename:
        raise ValueError("Invalid upload filename")
    return filename


def upload_object_name(filename: str):
    filename = validate_upload_filename(filename)
    if UPLOAD_OBJECT_PREFIX:
        return f"{UPLOAD_OBJECT_PREFIX}/{filename}"
    return filename


def _local_path(filename: str):
    filename = validate_upload_filename(filename)
    path = (UPLOAD_DIR / filename).resolve()
    if UPLOAD_DIR.resolve() not in path.parents:
        raise ValueError("Invalid upload path")
    return path


def _local_metadata_path(filename: str):
    filename = validate_upload_filename(filename)
    return _local_path(f"{filename}.meta.json")


def _read_uploaded_by(value) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _gcs_bucket():
    if not UPLOAD_BUCKET:
        raise RuntimeError("UPLOAD_BUCKET is required for Cloud Storage uploads")

    from google.cloud import storage

    return storage.Client().bucket(UPLOAD_BUCKET)


def save_upload(filename: str, contents: bytes, content_type: str, uploaded_by: Optional[int] = None):
    if upload_storage_backend() == "gcs":
        blob = _gcs_bucket().blob(upload_object_name(filename))
        blob.cache_control = "private, max-age=3600"
        if uploaded_by is not None:
            blob.metadata = {"uploaded_by": str(uploaded_by)}
        blob.upload_from_string(contents, content_type=content_type)
        return

    ensure_upload_storage_ready()
    _local_path(filename).write_bytes(contents)
    if uploaded_by is not None:
        _local_metadata_path(filename).write_text(
            json.dumps({"uploaded_by": uploaded_by}),
            encoding="utf-8",
        )


def load_upload(filename: str) -> Optional[StoredUpload]:
    if upload_storage_backend() == "gcs":
        from google.api_core.exceptions import NotFound

        blob = _gcs_bucket().blob(upload_object_name(filename))
        try:
            blob.reload()
            content = blob.download_as_bytes()
        except NotFound:
            return None

        return StoredUpload(
            content=content,
            content_type=blob.content_type or guess_content_type(filename),
            uploaded_by=_read_uploaded_by((blob.metadata or {}).get("uploaded_by")),
        )

    path = _local_path(filename)
    if not path.exists() or not path.is_file():
        return None

    uploaded_by = None
    metadata_path = _local_metadata_path(filename)
    if metadata_path.exists() and metadata_path.is_file():
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            uploaded_by = _read_uploaded_by(metadata.get("uploaded_by"))
        except (OSError, json.JSONDecodeError):
            uploaded_by = None

    return StoredUpload(
        content=path.read_bytes(),
        content_type=guess_content_type(filename),
        uploaded_by=uploaded_by,
    )


def guess_content_type(filename: str):
    return mimetypes.guess_type(filename)[0] or "application/octet-stream"
