import json
import logging
import mimetypes
import warnings
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Iterable, Optional, Protocol
from urllib.parse import urlparse
from uuid import uuid4

from PIL import Image, ImageOps, UnidentifiedImageError
from sqlmodel import Session, select

from app.config import (
    MAX_UPLOAD_BYTES,
    PRODUCTION_LIKE,
    UPLOAD_BUCKET,
    UPLOAD_DIR,
    UPLOAD_OBJECT_PREFIX,
    UPLOAD_STORAGE_BACKEND,
)
from app.models import AttendanceRecord, TaskLog, User, WorkFormSubmission


STREAM_CHUNK_BYTES = 64 * 1024
VERIFIED_RASTER_FORMATS = {
    "JPEG": (".jpg", "image/jpeg"),
    "PNG": (".png", "image/png"),
    "WEBP": (".webp", "image/webp"),
}
logger = logging.getLogger(__name__)


class UploadValidationError(ValueError):
    pass


class UploadTooLargeError(UploadValidationError):
    pass


@dataclass(frozen=True)
class UploadInfo:
    filename: str
    content_type: str
    size: int
    uploaded_by: Optional[int] = None
    width: Optional[int] = None
    height: Optional[int] = None


@dataclass(frozen=True)
class StoredUpload:
    content: bytes
    content_type: str
    uploaded_by: Optional[int] = None


@dataclass(frozen=True)
class AuthorizedUpload:
    info: UploadInfo
    chunks: Iterable[bytes]


@dataclass(frozen=True)
class UploadCleanupResult:
    deleted: tuple[str, ...]
    retained: tuple[str, ...]
    missing: tuple[str, ...]
    failed: dict[str, str]


class UploadAdapter(Protocol):
    name: str

    def readiness(self, verify_lifecycle: bool = False) -> None: ...

    def put(self, info: UploadInfo, content: bytes) -> None: ...

    def stat(self, filename: str) -> Optional[UploadInfo]: ...

    def iter_chunks(self, filename: str) -> Iterable[bytes]: ...

    def delete(self, filename: str) -> bool: ...


def _validate_storage_filename(filename: str):
    if not filename or Path(filename).name != filename or "/" in filename or "\\" in filename:
        raise ValueError("Invalid upload filename")
    return filename


def validate_upload_filename(filename: str):
    filename = _validate_storage_filename(filename)
    if filename.startswith(".") or filename.endswith(".meta.json"):
        raise ValueError("Invalid upload filename")
    return filename


def upload_object_name(filename: str):
    filename = _validate_storage_filename(filename)
    if UPLOAD_OBJECT_PREFIX:
        return f"{UPLOAD_OBJECT_PREFIX}/{filename}"
    return filename


def _read_optional_int(value) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _metadata_for(info: UploadInfo):
    metadata = {
        "content_type": info.content_type,
        "size": info.size,
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
    }
    if info.uploaded_by is not None:
        metadata["uploaded_by"] = info.uploaded_by
    if info.width is not None:
        metadata["width"] = info.width
    if info.height is not None:
        metadata["height"] = info.height
    return metadata


class LocalUploadAdapter:
    name = "local"

    def __init__(self, root: Path):
        self.root = root.resolve()

    def _path(self, filename: str):
        filename = _validate_storage_filename(filename)
        path = (self.root / filename).resolve()
        if self.root not in path.parents:
            raise ValueError("Invalid upload path")
        return path

    def _metadata_path(self, filename: str):
        filename = validate_upload_filename(filename)
        return self._path(f"{filename}.meta.json")

    def readiness(self, verify_lifecycle: bool = False):
        self.root.mkdir(parents=True, exist_ok=True)
        probe = self._path(f".readiness-{uuid4().hex}.tmp")
        try:
            probe.write_bytes(b"ready")
            if probe.read_bytes() != b"ready":
                raise RuntimeError("Local upload storage readiness read did not match its write")
        finally:
            probe.unlink(missing_ok=True)

    def put(self, info: UploadInfo, content: bytes):
        validate_upload_filename(info.filename)
        self.root.mkdir(parents=True, exist_ok=True)
        path = self._path(info.filename)
        metadata_path = self._metadata_path(info.filename)
        content_tmp = self._path(f".write-{uuid4().hex}.tmp")
        metadata_tmp = self._path(f".write-{uuid4().hex}.meta.tmp")

        try:
            content_tmp.write_bytes(content)
            metadata_tmp.write_text(json.dumps(_metadata_for(info)), encoding="utf-8")
            content_tmp.replace(path)
            metadata_tmp.replace(metadata_path)
        except Exception:
            content_tmp.unlink(missing_ok=True)
            metadata_tmp.unlink(missing_ok=True)
            path.unlink(missing_ok=True)
            metadata_path.unlink(missing_ok=True)
            raise

    def stat(self, filename: str):
        validate_upload_filename(filename)
        path = self._path(filename)
        if not path.exists() or not path.is_file():
            return None

        metadata = {}
        metadata_path = self._metadata_path(filename)
        if metadata_path.exists() and metadata_path.is_file():
            try:
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                metadata = {}

        return UploadInfo(
            filename=filename,
            content_type=metadata.get("content_type") or guess_content_type(filename),
            size=path.stat().st_size,
            uploaded_by=_read_optional_int(metadata.get("uploaded_by")),
            width=_read_optional_int(metadata.get("width")),
            height=_read_optional_int(metadata.get("height")),
        )

    def iter_chunks(self, filename: str):
        validate_upload_filename(filename)
        path = self._path(filename)

        def chunks():
            with path.open("rb") as stream:
                while True:
                    chunk = stream.read(STREAM_CHUNK_BYTES)
                    if not chunk:
                        break
                    yield chunk

        return chunks()

    def delete(self, filename: str):
        validate_upload_filename(filename)
        path = self._path(filename)
        metadata_path = self._metadata_path(filename)
        existed = path.exists()
        path.unlink(missing_ok=True)
        metadata_path.unlink(missing_ok=True)
        return existed


def _gcs_bucket():
    if not UPLOAD_BUCKET:
        raise RuntimeError("UPLOAD_BUCKET is required when UPLOAD_STORAGE_BACKEND=gcs")

    from google.cloud import storage

    return storage.Client().bucket(UPLOAD_BUCKET)


class GcsUploadAdapter:
    name = "gcs"

    def __init__(self, bucket):
        self.bucket = bucket

    def readiness(self, verify_lifecycle: bool = False):
        marker = self.bucket.blob(upload_object_name(".readiness"))
        if verify_lifecycle:
            marker.upload_from_string(b"ready", content_type="application/octet-stream")

        try:
            marker.reload()
            if marker.download_as_bytes() != b"ready":
                raise RuntimeError("Cloud Storage readiness read did not match its write")
        except Exception as error:
            raise RuntimeError("Cloud Storage readiness marker is unavailable") from error

        if verify_lifecycle:
            deletion_probe = self.bucket.blob(
                upload_object_name(f".readiness-delete-{uuid4().hex}.tmp")
            )
            deletion_probe.upload_from_string(b"delete", content_type="application/octet-stream")
            deletion_probe.delete()

    def put(self, info: UploadInfo, content: bytes):
        validate_upload_filename(info.filename)
        blob = self.bucket.blob(upload_object_name(info.filename))
        blob.cache_control = "private, max-age=3600"
        blob.metadata = {
            key: str(value)
            for key, value in _metadata_for(info).items()
        }
        blob.upload_from_string(content, content_type=info.content_type)

    def stat(self, filename: str):
        from google.api_core.exceptions import NotFound

        validate_upload_filename(filename)
        blob = self.bucket.blob(upload_object_name(filename))
        try:
            blob.reload()
        except NotFound:
            return None

        metadata = blob.metadata or {}
        return UploadInfo(
            filename=filename,
            content_type=blob.content_type or metadata.get("content_type") or guess_content_type(filename),
            size=int(blob.size or metadata.get("size") or 0),
            uploaded_by=_read_optional_int(metadata.get("uploaded_by")),
            width=_read_optional_int(metadata.get("width")),
            height=_read_optional_int(metadata.get("height")),
        )

    def iter_chunks(self, filename: str):
        validate_upload_filename(filename)
        blob = self.bucket.blob(upload_object_name(filename))

        def chunks():
            with blob.open("rb") as stream:
                while True:
                    chunk = stream.read(STREAM_CHUNK_BYTES)
                    if not chunk:
                        break
                    yield chunk

        return chunks()

    def delete(self, filename: str):
        from google.api_core.exceptions import NotFound

        validate_upload_filename(filename)
        blob = self.bucket.blob(upload_object_name(filename))
        try:
            blob.delete()
        except NotFound:
            return False
        return True


def upload_storage_backend():
    configured = (UPLOAD_STORAGE_BACKEND or "").strip().lower()
    if configured == "local":
        if PRODUCTION_LIKE:
            raise RuntimeError("Production deployments must use UPLOAD_STORAGE_BACKEND=gcs")
        return "local"
    if configured in {"gcs", "cloud-storage", "cloud_storage"}:
        if not UPLOAD_BUCKET:
            raise RuntimeError("UPLOAD_BUCKET is required when UPLOAD_STORAGE_BACKEND=gcs")
        return "gcs"
    raise RuntimeError("UPLOAD_STORAGE_BACKEND must be local or gcs")


def upload_adapter() -> UploadAdapter:
    backend = upload_storage_backend()
    if backend == "local":
        return LocalUploadAdapter(UPLOAD_DIR)
    return GcsUploadAdapter(_gcs_bucket())


def ensure_upload_storage_ready(verify_lifecycle: bool = False):
    adapter = upload_adapter()
    adapter.readiness(verify_lifecycle=verify_lifecycle)
    return adapter.name


def _verified_raster(contents: bytes, max_bytes: int):
    if not contents:
        raise UploadValidationError("Image file is empty")
    if len(contents) > max_bytes:
        raise UploadTooLargeError(f"Photo must be {max_bytes // (1024 * 1024)}MB or smaller")

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(contents)) as candidate:
                candidate.verify()
            with Image.open(BytesIO(contents)) as candidate:
                if getattr(candidate, "is_animated", False) or getattr(candidate, "n_frames", 1) != 1:
                    raise UploadValidationError("Animated images are not supported")
                image_format = (candidate.format or "").upper()
                if image_format not in VERIFIED_RASTER_FORMATS:
                    raise UploadValidationError("Use a JPEG, PNG, or WebP image")
                candidate.load()
                image = ImageOps.exif_transpose(candidate).copy()
    except UploadValidationError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise UploadValidationError("Image dimensions are too large")
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError):
        raise UploadValidationError("File is not a valid JPEG, PNG, or WebP image")

    suffix, content_type = VERIFIED_RASTER_FORMATS[image_format]
    output = BytesIO()
    try:
        if image_format == "JPEG":
            image.convert("RGB").save(output, format="JPEG", quality=90, optimize=True)
        elif image_format == "PNG":
            if image.mode not in {"1", "L", "LA", "P", "RGB", "RGBA"}:
                image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
            image.save(output, format="PNG", optimize=True)
        else:
            if image.mode not in {"RGB", "RGBA"}:
                image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
            image.save(output, format="WEBP", quality=90, method=4)
    except OSError:
        raise UploadValidationError("Image could not be converted to a safe raster format")

    verified_content = output.getvalue()
    if len(verified_content) > max_bytes:
        raise UploadTooLargeError(f"Verified photo must be {max_bytes // (1024 * 1024)}MB or smaller")
    return verified_content, suffix, content_type, image.width, image.height


def store_verified_raster(contents: bytes, uploaded_by: int, max_bytes: int = MAX_UPLOAD_BYTES):
    content, suffix, content_type, width, height = _verified_raster(contents, max_bytes)
    info = UploadInfo(
        filename=f"{uuid4().hex}{suffix}",
        content_type=content_type,
        size=len(content),
        uploaded_by=uploaded_by,
        width=width,
        height=height,
    )
    upload_adapter().put(info, content)
    return info


async def store_verified_raster_upload(file, uploaded_by: int):
    contents = await file.read(MAX_UPLOAD_BYTES + 1)
    return store_verified_raster(contents, uploaded_by)


def get_upload_info(filename: str):
    return upload_adapter().stat(validate_upload_filename(filename))


def load_upload(filename: str) -> Optional[StoredUpload]:
    adapter = upload_adapter()
    info = adapter.stat(validate_upload_filename(filename))
    if not info:
        return None
    return StoredUpload(
        content=b"".join(adapter.iter_chunks(filename)),
        content_type=info.content_type,
        uploaded_by=info.uploaded_by,
    )


def delete_upload(filename: str):
    return upload_adapter().delete(validate_upload_filename(filename))


def upload_filename_from_url(value):
    if not isinstance(value, str) or not value:
        return None
    parsed = urlparse(value)
    if parsed.scheme or parsed.netloc or not parsed.path.startswith("/uploads/"):
        return None
    filename = parsed.path.removeprefix("/uploads/")
    try:
        return validate_upload_filename(filename)
    except ValueError:
        return None


def _upload_filenames_in(value):
    filenames = set()
    if isinstance(value, str):
        filename = upload_filename_from_url(value)
        if filename:
            filenames.add(filename)
    elif isinstance(value, dict):
        for item in value.values():
            filenames.update(_upload_filenames_in(item))
    elif isinstance(value, (list, tuple, set)):
        for item in value:
            filenames.update(_upload_filenames_in(item))
    return filenames


def _json_value(value, fallback):
    if not value:
        return fallback
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return fallback


def record_upload_urls(record):
    filenames = set()
    filenames.update(_upload_filenames_in(getattr(record, "photo_url", None)))
    filenames.update(_upload_filenames_in(_json_value(getattr(record, "photo_urls", None), [])))
    filenames.update(_upload_filenames_in(_json_value(getattr(record, "answers_json", None), {})))
    return {f"/uploads/{filename}" for filename in filenames}


def _upload_is_referenced(filename: str, session: Session, worker_id: Optional[int] = None, department_id: Optional[int] = None):
    attendance_statement = select(AttendanceRecord)
    task_statement = select(TaskLog)
    form_statement = select(WorkFormSubmission)
    if worker_id is not None:
        attendance_statement = attendance_statement.where(AttendanceRecord.worker_id == worker_id)
        task_statement = task_statement.where(TaskLog.worker_id == worker_id)
        form_statement = form_statement.where(WorkFormSubmission.worker_id == worker_id)
    if department_id is not None:
        attendance_statement = attendance_statement.where(AttendanceRecord.department_id == department_id)
        task_statement = task_statement.where(TaskLog.department_id == department_id)
        form_statement = form_statement.where(WorkFormSubmission.department_id == department_id)

    for record in session.exec(attendance_statement).all():
        if filename in _upload_filenames_in(record.photo_url):
            return True
    for record in session.exec(task_statement).all():
        if filename in {
            *tuple(_upload_filenames_in(record.photo_url)),
            *tuple(_upload_filenames_in(_json_value(record.photo_urls, []))),
        }:
            return True
    for record in session.exec(form_statement).all():
        if filename in {
            *tuple(_upload_filenames_in(_json_value(record.photo_urls, []))),
            *tuple(_upload_filenames_in(_json_value(record.answers_json, {}))),
        }:
            return True
    return False


def can_access_upload(filename: str, info: UploadInfo, user: User, session: Session):
    if bool(getattr(user, "is_global_admin", False)):
        return True
    if user.role == "supervisor":
        if info.uploaded_by:
            uploader = session.get(User, info.uploaded_by)
            if uploader and uploader.department_id == user.department_id:
                return True
        return _upload_is_referenced(filename, session, department_id=user.department_id)
    if info.uploaded_by == user.id:
        return True
    return _upload_is_referenced(filename, session, worker_id=user.id)


def open_authorized_upload(filename: str, user: User, session: Session):
    try:
        filename = validate_upload_filename(filename)
    except ValueError:
        return None
    adapter = upload_adapter()
    info = adapter.stat(filename)
    if not info or not can_access_upload(filename, info, user, session):
        return None
    return AuthorizedUpload(info=info, chunks=adapter.iter_chunks(filename))


def cleanup_unreferenced_uploads(values, session: Session):
    filenames = sorted(_upload_filenames_in(values))
    if not filenames:
        return UploadCleanupResult(deleted=(), retained=(), missing=(), failed={})
    deleted = []
    retained = []
    missing = []
    failed = {}
    try:
        adapter = upload_adapter()
    except Exception as error:
        result = UploadCleanupResult(
            deleted=(),
            retained=(),
            missing=(),
            failed={filename: str(error) for filename in filenames},
        )
        logger.warning("Upload cleanup could not open its adapter: %s", result.failed)
        return result

    for filename in filenames:
        if _upload_is_referenced(filename, session):
            retained.append(filename)
            continue
        try:
            if adapter.delete(filename):
                deleted.append(filename)
            else:
                missing.append(filename)
        except Exception as error:
            failed[filename] = str(error)

    result = UploadCleanupResult(
        deleted=tuple(deleted),
        retained=tuple(retained),
        missing=tuple(missing),
        failed=failed,
    )
    if result.failed:
        logger.warning("Upload cleanup left objects undeleted: %s", result.failed)
    return result


def cleanup_detached_record_uploads(previous_urls, record, session: Session):
    detached_urls = set(previous_urls or ()) - record_upload_urls(record)
    return cleanup_unreferenced_uploads(detached_urls, session)


def guess_content_type(filename: str):
    return mimetypes.guess_type(filename)[0] or "application/octet-stream"
