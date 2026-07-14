import json
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory

from google.api_core.exceptions import NotFound
from PIL import Image
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app import upload_storage
from app.models import AttendanceRecord, TaskLog, User, WorkFormSubmission
from app.use_cases.common import upload_url
from app.use_cases.record_trash import purge_expired_deleted_records


def assert_equal(label, actual, expected):
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")
    print(f"ok - {label}")


def assert_true(label, condition):
    if not condition:
        raise AssertionError(label)
    print(f"ok - {label}")


def assert_raises(label, exception_type, callback):
    try:
        callback()
    except exception_type:
        print(f"ok - {label}")
        return
    raise AssertionError(f"{label}: expected {exception_type.__name__}")


def raster_bytes(image_format, mode="RGB"):
    image = Image.new(mode, (3, 2), (20, 40, 60, 128) if "A" in mode else (20, 40, 60))
    output = BytesIO()
    image.save(output, format=image_format)
    return output.getvalue()


class FakeBlob:
    def __init__(self, bucket, name):
        self.bucket = bucket
        self.name = name
        self.cache_control = None
        self.metadata = None

    @property
    def content_type(self):
        return self.bucket.objects.get(self.name, {}).get("content_type")

    @property
    def size(self):
        content = self.bucket.objects.get(self.name, {}).get("content")
        return len(content) if content is not None else None

    def upload_from_string(self, content, content_type=None):
        self.bucket.objects[self.name] = {
            "content": bytes(content),
            "content_type": content_type,
            "metadata": dict(self.metadata or {}),
        }

    def reload(self):
        if self.name not in self.bucket.objects:
            raise NotFound("missing")
        self.metadata = dict(self.bucket.objects[self.name].get("metadata") or {})

    def download_as_bytes(self):
        if self.name not in self.bucket.objects:
            raise NotFound("missing")
        self.bucket.download_count += 1
        return self.bucket.objects[self.name]["content"]

    def open(self, mode):
        if mode != "rb" or self.name not in self.bucket.objects:
            raise NotFound("missing")
        self.bucket.open_count += 1
        return BytesIO(self.bucket.objects[self.name]["content"])

    def delete(self):
        if self.name not in self.bucket.objects:
            raise NotFound("missing")
        del self.bucket.objects[self.name]


class FakeBucket:
    def __init__(self):
        self.objects = {}
        self.reload_count = 0
        self.download_count = 0
        self.open_count = 0

    def reload(self):
        self.reload_count += 1

    def blob(self, name):
        return FakeBlob(self, name)


def make_session():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine, Session(engine)


def test_verified_local_adapter(tmp_dir):
    upload_storage.UPLOAD_STORAGE_BACKEND = "local"
    upload_storage.UPLOAD_BUCKET = ""
    upload_storage.UPLOAD_OBJECT_PREFIX = "uploads"
    upload_storage.UPLOAD_DIR = Path(tmp_dir)
    upload_storage.PRODUCTION_LIKE = False

    assert_equal("local readiness backend", upload_storage.ensure_upload_storage_ready(), "local")
    assert_true(
        "local readiness probe is removed",
        not list(Path(tmp_dir).glob(".readiness-*")),
    )

    for image_format, expected_suffix, expected_content_type in [
        ("JPEG", ".jpg", "image/jpeg"),
        ("PNG", ".png", "image/png"),
        ("WEBP", ".webp", "image/webp"),
    ]:
        source = raster_bytes(image_format) + b"<script>trailing payload</script>"
        info = upload_storage.store_verified_raster(source, uploaded_by=42)
        stored = upload_storage.load_upload(info.filename)
        assert_true(f"{image_format} canonical suffix", info.filename.endswith(expected_suffix))
        assert_equal(f"{image_format} canonical content type", info.content_type, expected_content_type)
        assert_equal(f"{image_format} owner metadata", stored.uploaded_by, 42)
        assert_true(f"{image_format} trailing payload stripped", b"<script>" not in stored.content)
        with Image.open(BytesIO(stored.content)) as verified:
            verified.verify()
        assert_equal(f"{image_format} dimensions", (info.width, info.height), (3, 2))

    transparent = upload_storage.store_verified_raster(raster_bytes("PNG", "RGBA"), uploaded_by=42)
    with Image.open(BytesIO(upload_storage.load_upload(transparent.filename).content)) as image:
        assert_true("PNG transparency is preserved", "A" in image.getbands())

    assert_raises(
        "reject SVG renamed as raster",
        upload_storage.UploadValidationError,
        lambda: upload_storage.store_verified_raster(b'<svg xmlns="http://www.w3.org/2000/svg"/>', 42),
    )
    assert_raises(
        "reject corrupt raster",
        upload_storage.UploadValidationError,
        lambda: upload_storage.store_verified_raster(b"not-an-image", 42),
    )
    assert_raises(
        "reject nominal HEIC without verified decoder",
        upload_storage.UploadValidationError,
        lambda: upload_storage.store_verified_raster(b"\x00\x00\x00\x18ftypheic" + (b"x" * 50), 42),
    )
    assert_raises(
        "reject upload byte limit",
        upload_storage.UploadTooLargeError,
        lambda: upload_storage.store_verified_raster(raster_bytes("PNG"), 42, max_bytes=10),
    )
    assert_equal("upload url format", upload_url(transparent.filename), f"/uploads/{transparent.filename}")
    assert_raises(
        "reject nested upload filename",
        ValueError,
        lambda: upload_storage.load_upload("../sample.png"),
    )
    assert_raises(
        "reject local upload metadata sidecar",
        ValueError,
        lambda: upload_storage.load_upload(f"{transparent.filename}.meta.json"),
    )


def test_configuration_and_gcs_contract():
    upload_storage.PRODUCTION_LIKE = False
    upload_storage.UPLOAD_STORAGE_BACKEND = "invalid"
    upload_storage.UPLOAD_BUCKET = ""
    assert_raises("reject unknown storage backend", RuntimeError, upload_storage.upload_storage_backend)

    upload_storage.UPLOAD_STORAGE_BACKEND = "gcs"
    assert_raises("require GCS bucket", RuntimeError, upload_storage.upload_storage_backend)

    upload_storage.UPLOAD_STORAGE_BACKEND = "local"
    upload_storage.UPLOAD_BUCKET = "configured-but-not-selected"
    assert_equal("explicit local backend does not silently switch", upload_storage.upload_storage_backend(), "local")

    upload_storage.PRODUCTION_LIKE = True
    assert_raises("reject production local storage", RuntimeError, upload_storage.upload_storage_backend)

    fake_bucket = FakeBucket()
    original_gcs_bucket = upload_storage._gcs_bucket
    try:
        upload_storage.PRODUCTION_LIKE = True
        upload_storage.UPLOAD_STORAGE_BACKEND = "gcs"
        upload_storage.UPLOAD_BUCKET = "fake-bucket"
        upload_storage.UPLOAD_OBJECT_PREFIX = "uploads"
        upload_storage._gcs_bucket = lambda: fake_bucket

        assert_equal(
            "GCS readiness backend",
            upload_storage.ensure_upload_storage_ready(verify_lifecycle=True),
            "gcs",
        )
        assert_equal("GCS readiness verifies readable objects", fake_bucket.download_count, 1)
        assert_equal(
            "GCS readiness keeps only its stable marker",
            set(fake_bucket.objects),
            {"uploads/.readiness"},
        )
        assert_equal("GCS live readiness is non-destructive", upload_storage.ensure_upload_storage_ready(), "gcs")

        info = upload_storage.store_verified_raster(raster_bytes("PNG"), uploaded_by=7)
        stored = upload_storage.load_upload(info.filename)
        assert_equal("GCS stored content type", stored.content_type, "image/png")
        assert_equal("GCS stored owner", stored.uploaded_by, 7)
        assert_true("GCS stream returns verified raster", bool(stored.content))
        assert_true("GCS delete removes object", upload_storage.delete_upload(info.filename))
        assert_true("GCS delete is idempotent", not upload_storage.delete_upload(info.filename))
    finally:
        upload_storage._gcs_bucket = original_gcs_bucket


def test_authorization_streaming_and_cleanup(tmp_dir):
    upload_storage.PRODUCTION_LIKE = False
    upload_storage.UPLOAD_STORAGE_BACKEND = "local"
    upload_storage.UPLOAD_BUCKET = ""
    upload_storage.UPLOAD_DIR = Path(tmp_dir)
    upload_storage.ensure_upload_storage_ready()
    engine, session = make_session()

    try:
        owner = User(department_id=1, email="owner@example.com", name="Owner", password_hash="x", role="worker")
        referenced_worker = User(department_id=1, email="referenced@example.com", name="Referenced", password_hash="x", role="worker")
        stranger = User(department_id=2, email="stranger@example.com", name="Stranger", password_hash="x", role="worker")
        supervisor = User(department_id=1, email="supervisor@example.com", name="Supervisor", password_hash="x", role="supervisor")
        other_supervisor = User(department_id=2, email="other-supervisor@example.com", name="Other", password_hash="x", role="supervisor")
        global_supervisor = User(department_id=2, email="global@example.com", name="Global", password_hash="x", role="supervisor", is_global_admin=True)
        session.add_all([owner, referenced_worker, stranger, supervisor, other_supervisor, global_supervisor])
        session.commit()
        for user in [owner, referenced_worker, stranger, supervisor, other_supervisor, global_supervisor]:
            session.refresh(user)

        shared = upload_storage.store_verified_raster(raster_bytes("PNG"), owner.id)
        orphan = upload_storage.store_verified_raster(raster_bytes("JPEG"), owner.id)
        shared_url = upload_url(shared.filename)
        orphan_url = upload_url(orphan.filename)

        assert_true(
            "uploader can stream own asset",
            bool(b"".join(upload_storage.open_authorized_upload(shared.filename, owner, session).chunks)),
        )
        assert_equal(
            "unrelated worker is denied before stream opens",
            upload_storage.open_authorized_upload(shared.filename, stranger, session),
            None,
        )
        assert_true(
            "same-department supervisor can stream",
            upload_storage.open_authorized_upload(shared.filename, supervisor, session) is not None,
        )
        assert_equal(
            "cross-department supervisor is denied",
            upload_storage.open_authorized_upload(shared.filename, other_supervisor, session),
            None,
        )
        assert_true(
            "global supervisor can stream",
            upload_storage.open_authorized_upload(shared.filename, global_supervisor, session) is not None,
        )

        nested_submission = WorkFormSubmission(
            department_id=1,
            form_id=1,
            worker_id=referenced_worker.id,
            answers_json=json.dumps({"rows": [{"signature": shared_url}]}),
        )
        session.add(nested_submission)
        session.commit()
        assert_true(
            "nested signature reference authorizes its Worker",
            upload_storage.open_authorized_upload(shared.filename, referenced_worker, session) is not None,
        )

        cleanup = upload_storage.cleanup_unreferenced_uploads([shared_url, orphan_url], session)
        assert_equal("referenced upload is retained", cleanup.retained, (shared.filename,))
        assert_equal("orphan upload is deleted", cleanup.deleted, (orphan.filename,))
        assert_equal("orphan content is gone", upload_storage.load_upload(orphan.filename), None)

        session.delete(nested_submission)
        session.commit()
        cleanup = upload_storage.cleanup_unreferenced_uploads([shared_url], session)
        assert_equal("detached upload is deleted", cleanup.deleted, (shared.filename,))
        assert_equal("detached metadata is deleted", list(Path(tmp_dir).glob(f"{shared.filename}*")), [])

        expired_upload = upload_storage.store_verified_raster(raster_bytes("PNG"), owner.id)
        expired_record = AttendanceRecord(
            department_id=owner.department_id,
            worker_id=owner.id,
            record_type="check_in",
            photo_url=upload_url(expired_upload.filename),
            deleted_at=datetime.now(timezone.utc) - timedelta(days=31),
        )
        session.add(expired_record)
        session.commit()
        deleted_counts = purge_expired_deleted_records(session)
        assert_equal("expired attendance is permanently purged", deleted_counts["attendance"], 1)
        assert_equal("purge removes its unreferenced upload", upload_storage.load_upload(expired_upload.filename), None)

        record = AttendanceRecord(worker_id=owner.id, record_type="check_in", photo_url="/uploads/example.png")
        task = TaskLog(worker_id=owner.id, description="x", photo_urls='["/uploads/task.png"]')
        assert_equal("attendance lifecycle URL extraction", upload_storage.record_upload_urls(record), {"/uploads/example.png"})
        assert_equal("task lifecycle URL extraction", upload_storage.record_upload_urls(task), {"/uploads/task.png"})
    finally:
        session.close()
        engine.dispose()


def main():
    original_backend = upload_storage.UPLOAD_STORAGE_BACKEND
    original_bucket = upload_storage.UPLOAD_BUCKET
    original_prefix = upload_storage.UPLOAD_OBJECT_PREFIX
    original_dir = upload_storage.UPLOAD_DIR
    original_production_like = upload_storage.PRODUCTION_LIKE

    try:
        with TemporaryDirectory() as local_dir, TemporaryDirectory() as lifecycle_dir:
            test_verified_local_adapter(local_dir)
            test_configuration_and_gcs_contract()
            test_authorization_streaming_and_cleanup(lifecycle_dir)
    finally:
        upload_storage.UPLOAD_STORAGE_BACKEND = original_backend
        upload_storage.UPLOAD_BUCKET = original_bucket
        upload_storage.UPLOAD_OBJECT_PREFIX = original_prefix
        upload_storage.UPLOAD_DIR = original_dir
        upload_storage.PRODUCTION_LIKE = original_production_like

    print("upload storage test passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
