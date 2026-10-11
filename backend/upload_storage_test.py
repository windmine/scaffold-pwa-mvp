import json
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

from google.api_core.exceptions import NotFound
from fastapi import HTTPException, Response
from PIL import Image
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app import upload_storage
from app.main import apply_upload_cache_policy, get_upload
from app.models import AttendanceRecord, Department, TaskLog, User, WorkForm, WorkFormSubmission
from app.schemas import (
    AttendanceCreate,
    SupervisorWorkFormSubmissionCreate,
    SupervisorWorkFormSubmissionUpdate,
    TaskLogCreate,
    UserUpdateRequest,
    WorkFormSubmissionCreate,
)
from app.use_cases.common import upload_url
from app.use_cases.attendance import create_attendance
from app.use_cases.record_trash import purge_expired_deleted_records
from app.use_cases.task_logs import create_task_log
from app.use_cases.staff_site_admin import update_user
from app.use_cases.supervisor_review import create_supervisor_work_form_submission, update_supervisor_form_submission
from app.use_cases.work_forms import create_work_form_submission


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
    for status_code, path in [
        (401, "/uploads/missing.png"),
        (403, "/uploads/missing.png"),
        (404, "/api/uploads/missing.png"),
    ]:
        denial_response = apply_upload_cache_policy(
            path,
            Response(status_code=status_code),
        )
        assert_equal(
            f"upload {status_code} cannot be shared by an edge cache",
            denial_response.headers.get("cache-control"),
            "private, no-store",
        )
    ordinary_response = apply_upload_cache_policy(
        "/sites",
        Response(status_code=404, headers={"Cache-Control": "public, max-age=60"}),
    )
    assert_equal(
        "unrelated response cache policy is untouched",
        ordinary_response.headers.get("cache-control"),
        "public, max-age=60",
    )

    upload_storage.PRODUCTION_LIKE = False
    upload_storage.UPLOAD_STORAGE_BACKEND = "local"
    upload_storage.UPLOAD_BUCKET = ""
    upload_storage.UPLOAD_DIR = Path(tmp_dir)
    upload_storage.ensure_upload_storage_ready()
    engine, session = make_session()

    try:
        owner = User(department_id=1, email="owner@example.com", name="Owner", password_hash="x", role="worker", worker_class="leader")
        referenced_worker = User(department_id=1, email="referenced@example.com", name="Referenced", password_hash="x", role="worker")
        stranger = User(department_id=2, email="stranger@example.com", name="Stranger", password_hash="x", role="worker", worker_class="leader")
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

        assert_raises(
            "submission rejects a missing upload reference",
            upload_storage.UploadReferenceValidationError,
            lambda: upload_storage.validate_submission_upload_references(
                "/uploads/missing.png",
                owner,
                session,
            ),
        )
        assert_raises(
            "submission rejects another user's upload",
            upload_storage.UploadReferenceValidationError,
            lambda: upload_storage.validate_submission_upload_references(
                {"rows": [{"signature": shared_url}]},
                stranger,
                session,
            ),
        )
        assert_equal(
            "submission accepts nested uploads owned by its authenticated uploader",
            upload_storage.validate_submission_upload_references(
                {"rows": [{"signature": shared_url}]},
                owner,
                session,
            ),
            (shared.filename,),
        )
        assert_raises(
            "attendance rejects a nonexistent photo object",
            HTTPException,
            lambda: create_attendance(
                AttendanceCreate(
                    record_type="check_in",
                    latitude=-36.85,
                    longitude=174.76,
                    photo_url="/uploads/missing.png",
                ),
                owner,
                session,
            ),
        )
        assert_raises(
            "task log rejects a photo owned by another Worker",
            HTTPException,
            lambda: create_task_log(
                TaskLogCreate(
                    description="Unowned evidence",
                    photo_urls=[shared_url],
                ),
                stranger,
                session,
            ),
        )

        form = WorkForm(
            department_id=stranger.department_id,
            name="Upload evidence form",
            fields_json=json.dumps([
                {
                    "id": "note",
                    "label": "Note",
                    "type": "text",
                    "required": False,
                },
                {
                    "id": "crews",
                    "label": "Crews",
                    "type": "repeat",
                    "required": False,
                    "min_rows": 1,
                    "max_rows": 2,
                },
                {
                    "id": "crew_signature",
                    "label": "Crew signature",
                    "type": "signature",
                    "required": True,
                    "repeat": "crews",
                },
            ]),
            status="active",
        )
        session.add(form)
        session.commit()
        session.refresh(form)
        assert_raises(
            "nested Work Form signature rejects another Worker's object",
            HTTPException,
            lambda: create_work_form_submission(
                WorkFormSubmissionCreate(
                    form_id=form.id,
                    work_date="2026-09-01",
                    answers={"crews": [{"crew_signature": shared_url}]},
                ),
                stranger,
                session,
            ),
        )

        stranger_signature = upload_storage.store_verified_raster(raster_bytes("PNG"), stranger.id)
        assert_raises(
            "Work Form rejects a missing top-level photo object",
            HTTPException,
            lambda: create_work_form_submission(
                WorkFormSubmissionCreate(
                    form_id=form.id,
                    work_date="2026-09-01",
                    answers={
                        "crews": [{"crew_signature": upload_url(stranger_signature.filename)}],
                    },
                    photo_urls=["/uploads/missing-form-photo.png"],
                ),
                stranger,
                session,
            ),
        )
        valid_submission = create_work_form_submission(
            WorkFormSubmissionCreate(
                form_id=form.id,
                work_date="2026-09-01",
                answers={
                    "note": "/uploads/not-evidence.png",
                    "crews": [{"crew_signature": upload_url(stranger_signature.filename)}],
                },
            ),
            stranger,
            session,
        )
        assert_equal(
            "submitted Worker signature remains attached as immutable evidence",
            valid_submission["answers"]["crews"][0]["crew_signature"],
            upload_url(stranger_signature.filename),
        )
        assert_equal(
            "ordinary Work Form text is not mistaken for upload evidence",
            valid_submission["answers"]["note"],
            "/uploads/not-evidence.png",
        )

        assert_true(
            "uploader can stream own asset",
            bool(b"".join(upload_storage.open_authorized_upload(shared.filename, owner, session).chunks)),
        )
        assert_equal(
            "unrelated worker is denied before stream opens",
            upload_storage.open_authorized_upload(shared.filename, stranger, session),
            None,
        )
        try:
            get_upload(shared.filename, stranger, session)
        except HTTPException as error:
            assert_equal("denied upload route stays concealed", error.status_code, 404)
            assert_equal(
                "denied upload response cannot be shared by an edge cache",
                error.headers,
                {"Cache-Control": "private, no-store"},
            )
        else:
            raise AssertionError("denied upload route must reject an unrelated Worker")
        nested_submission = WorkFormSubmission(
            department_id=1,
            form_id=1,
            worker_id=referenced_worker.id,
            answers_json=json.dumps({"rows": [{"signature": shared_url}]}),
            definition_snapshot_json=json.dumps({"fields": [
                {"id": "rows", "type": "repeat"},
                {"id": "signature", "type": "signature", "repeat": "rows"},
            ]}),
        )
        session.add(nested_submission)
        session.commit()
        supervisor_response = get_upload(shared.filename, supervisor, session)
        assert_equal(
            "same-department supervisor receives the private upload stream",
            supervisor_response.headers.get("cache-control"),
            "private, max-age=3600",
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
        malformed_global_worker = SimpleNamespace(
            id=stranger.id,
            department_id=stranger.department_id,
            role="worker",
            is_global_admin=True,
        )
        assert_true(
            "malformed Worker global-admin flag cannot bypass upload scope",
            not upload_storage.can_access_upload(shared.filename, shared, malformed_global_worker, session),
        )

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


def test_department_scoped_evidence_authorization(tmp_dir):
    original_configuration = (
        upload_storage.PRODUCTION_LIKE, upload_storage.UPLOAD_STORAGE_BACKEND,
        upload_storage.UPLOAD_BUCKET, upload_storage.UPLOAD_DIR,
    )
    upload_storage.PRODUCTION_LIKE = False
    upload_storage.UPLOAD_STORAGE_BACKEND = "local"
    upload_storage.UPLOAD_BUCKET = ""
    upload_storage.UPLOAD_DIR = Path(tmp_dir)
    engine, session = make_session()

    def allowed(label, info, user):
        opened = upload_storage.open_authorized_upload(info.filename, user, session)
        assert_true(label, opened is not None and bool(b"".join(opened.chunks)))

    def denied(label, info, user):
        assert_equal(label, upload_storage.open_authorized_upload(info.filename, user, session), None)
        try:
            get_upload(info.filename, user, session)
        except HTTPException as error:
            assert_equal(f"{label}: route conceals evidence", error.status_code, 404)
            assert_equal(f"{label}: denial is never shared", error.headers, {"Cache-Control": "private, no-store"})
        else:
            raise AssertionError(f"{label}: upload route must deny access")

    try:
        session.add_all([Department(id=1, name="Leader"), Department(id=2, name="Mutual")])
        owner = User(department_id=1, email="transfer-owner@example.invalid", name="Owner", password_hash="unused")
        other_worker = User(department_id=2, email="other-worker@example.invalid", name="Other", password_hash="unused", worker_class="leader")
        old_supervisor = User(department_id=1, email="old-supervisor@example.invalid", name="Old", password_hash="unused", role="supervisor")
        new_supervisor = User(department_id=2, email="new-supervisor@example.invalid", name="New", password_hash="unused", role="supervisor")
        global_supervisor = User(department_id=2, email="global-supervisor@example.invalid", name="Global", password_hash="unused", role="supervisor", is_global_admin=True)
        session.add_all([owner, other_worker, old_supervisor, new_supervisor, global_supervisor])
        fields = [
            {"id": "note", "type": "text", "label": "Note"},
            {"id": "signature", "type": "signature", "label": "Signature"},
            {"id": "crews", "type": "repeat", "label": "Crews"},
            {"id": "crew_signature", "repeat": "crews", "type": "signature", "label": "Crew signature"},
            {"id": "crew_note", "repeat": "crews", "type": "text", "label": "Crew note"},
        ]
        old_form = WorkForm(department_id=1, name="Old Department Report", fields_json=json.dumps(fields))
        new_form = WorkForm(department_id=2, name="New Department Report", fields_json=json.dumps(fields))
        session.add_all([old_form, new_form])
        session.commit()
        photo, signature, nested_signature, orphan = [
            upload_storage.store_verified_raster(raster_bytes("PNG"), owner.id) for _ in range(4)
        ]
        report = create_work_form_submission(WorkFormSubmissionCreate(
            form_id=old_form.id, work_date="2026-10-12", photo_urls=[upload_url(photo.filename)],
            answers={"signature": upload_url(signature.filename), "crews": [{"crew_signature": upload_url(nested_signature.filename)}]},
        ), owner, session)
        record = session.get(WorkFormSubmission, report["id"])
        captured = (record.department_id, record.photo_urls, record.answers_json, record.definition_snapshot_json)
        for name, info in (("photo", photo), ("signature", signature), ("repeating signature", nested_signature)):
            allowed(f"original Department reads submitted {name}", info, old_supervisor)
            denied(f"other Department cannot read submitted {name}", info, new_supervisor)

        update_user(owner.id, UserUpdateRequest(department_id=2, confirmed=True), global_supervisor, session)
        for name, info in (("photo", photo), ("signature", signature), ("repeating signature", nested_signature)):
            denied(f"Worker transfer never grants new Department old {name}", info, new_supervisor)
            allowed(f"original Department keeps old {name} after transfer", info, old_supervisor)
            allowed(f"transferred owner keeps their {name}", info, owner)
            allowed(f"global Supervisor keeps access to {name}", info, global_supervisor)
        assert_equal("transfer leaves Report evidence and owning Department unchanged", (
            record.department_id, record.photo_urls, record.answers_json, record.definition_snapshot_json,
        ), captured)

        # Editing the published Template cannot reinterpret the frozen signature fields.
        old_form.fields_json = "[]"
        session.add(old_form)
        record.deleted_at = datetime.now(timezone.utc)
        session.add(record)
        session.commit()
        allowed("trash keeps original Department signature access from frozen Definition", nested_signature, old_supervisor)
        denied("trash does not grant new Department signature access", nested_signature, new_supervisor)

        # URL text is valid ordinary content, never authority to read someone else's evidence.
        create_work_form_submission(WorkFormSubmissionCreate(
            form_id=new_form.id, work_date="2026-10-12",
            answers={"note": upload_url(photo.filename), "crews": [{"crew_note": upload_url(signature.filename)}]},
        ), other_worker, session)
        for name, info in (("text answer", photo), ("nested text answer", signature)):
            denied(f"foreign URL in {name} cannot authorize Worker", info, other_worker)
            denied(f"foreign URL in {name} cannot authorize Department Supervisor", info, new_supervisor)

        daywork_form = WorkForm(department_id=2, name="Retained evidence edit", template_purpose="daywork", fields_json=json.dumps(fields))
        session.add(daywork_form)
        session.commit()
        plain_answers = {"note": upload_url(photo.filename), "crews": [{"crew_note": upload_url(signature.filename)}]}
        text_only = create_supervisor_work_form_submission(SupervisorWorkFormSubmissionCreate(
            user_id=other_worker.id, form_id=daywork_form.id, answers=plain_answers, confirmed=True,
        ), new_supervisor, session)
        for name, edit in (
            ("photo", {"photo_urls": [upload_url(photo.filename)]}),
            ("direct signature", {"answers": {**plain_answers, "signature": upload_url(photo.filename)}}),
            ("repeating signature", {"answers": {"crews": [{"crew_signature": upload_url(signature.filename)}]}}),
        ):
            try:
                update_supervisor_form_submission(text_only["id"], SupervisorWorkFormSubmissionUpdate(
                    confirmed=True, **edit,
                ), new_supervisor, session)
            except HTTPException as error:
                assert_equal(f"retained edit cannot launder ordinary URL text into {name}", error.status_code, 400)
                session.rollback()
            else:
                raise AssertionError(f"retained edit laundered ordinary URL text into {name}")
            unchanged = session.get(WorkFormSubmission, text_only["id"])
            assert_equal(f"rejected {name} edit preserves answers", json.loads(unchanged.answers_json), text_only["answers"])
            assert_equal(f"rejected {name} edit attaches no photos", unchanged.photo_urls, None)
        denied("rejected retained edits never grant foreign photo access", photo, new_supervisor)
        denied("rejected retained edits never grant foreign signature access", signature, new_supervisor)

        genuine = upload_storage.store_verified_raster(raster_bytes("PNG"), other_worker.id)
        genuine_url = upload_url(genuine.filename)
        attached = create_work_form_submission(WorkFormSubmissionCreate(
            form_id=daywork_form.id, photo_urls=[genuine_url], answers={"signature": genuine_url},
        ), other_worker, session)
        revised = update_supervisor_form_submission(attached["id"], SupervisorWorkFormSubmissionUpdate(
            confirmed=True, photo_urls=[genuine_url], answers={"note": "Retained correction", "signature": genuine_url},
        ), new_supervisor, session)
        assert_equal("retained Supervisor correction keeps true Worker-owned photo", revised["photo_urls"], [genuine_url])
        assert_equal("retained Supervisor correction keeps true frozen signature", revised["answers"]["signature"], genuine_url)

        denied("unsubmitted Worker upload is private from current Department Supervisor", orphan, new_supervisor)
        denied("unsubmitted Worker upload is private from former Department Supervisor", orphan, old_supervisor)
        allowed("unsubmitted upload remains available to owner", orphan, owner)
        allowed("global Supervisor retains explicit orphan access", orphan, global_supervisor)
        supervisor_draft = upload_storage.store_verified_raster(raster_bytes("PNG"), new_supervisor.id)
        allowed("Supervisor can read their own unsubmitted upload", supervisor_draft, new_supervisor)

        # An intentionally shared original can belong to real records in both Departments.
        create_work_form_submission(WorkFormSubmissionCreate(
            form_id=new_form.id, work_date="2026-10-12", photo_urls=[upload_url(photo.filename)],
            answers={"signature": upload_url(signature.filename)},
        ), owner, session)
        for info in (photo, signature):
            allowed("new Department gains access only after its own real attachment", info, new_supervisor)
            allowed("shared evidence remains available to original Department", info, old_supervisor)

        legacy = upload_storage.UploadInfo(filename="legacy-signature.png", content_type="image/png", size=len(raster_bytes("PNG")))
        upload_storage.upload_adapter().put(legacy, raster_bytes("PNG"))
        legacy_form = WorkForm(department_id=1, name="Legacy Daywork", template_purpose="daywork", fields_json=json.dumps(fields))
        session.add(legacy_form)
        session.commit()
        legacy_record = WorkFormSubmission(
            department_id=1, form_id=legacy_form.id, worker_id=owner.id, submission_purpose="daywork",
            answers_json=json.dumps({"signature": upload_url(legacy.filename)}),
        )
        session.add(legacy_record)
        session.commit()
        denied("missing frozen Definition cannot authorize a signature from mutable Template", legacy, old_supervisor)
        for malformed in ("{", "[]", '{"fields":[null]}', '{"fields":[{"id":"signature"}]}'):
            legacy_record.definition_snapshot_json = malformed
            session.add(legacy_record)
            session.commit()
            denied("malformed or untyped frozen Definition cannot authorize signature", legacy, old_supervisor)
        legacy_record.definition_snapshot_json = json.dumps({"schema_version": 1, "version": 1, "fields": fields})
        session.add(legacy_record)
        session.commit()
        allowed("legacy typed signature with no owner metadata remains Department accessible", legacy, old_supervisor)
        allowed("legacy typed signature remains accessible to its record Worker", legacy, owner)
        denied("legacy signature remains hidden across Departments", legacy, new_supervisor)
        unknown_department = SimpleNamespace(id=999, role="supervisor", department_id=None, is_global_admin=False)
        denied("Supervisor without Department cannot obtain unscoped evidence", legacy, unknown_department)
        legacy_record.answers_json = json.dumps({"crews": 12})
        session.add(legacy_record)
        session.commit()
        denied("malformed repeating answers fail closed without an upload error", legacy, old_supervisor)
        legacy_record.answers_json = json.dumps({"signature": upload_url(legacy.filename), "crews": 12})
        session.add(legacy_record)
        session.commit()
        allowed("malformed repeat does not hide valid frozen direct signature", legacy, old_supervisor)

        for model, values in ((AttendanceRecord, {"record_type": "check_in"}), (TaskLog, {"description": "Retained task"})):
            retained = upload_storage.store_verified_raster(raster_bytes("PNG"), owner.id)
            session.add(model(department_id=1, worker_id=owner.id, photo_url=upload_url(retained.filename), **values))
            session.commit()
            allowed(f"retained {model.__name__} follows record Department", retained, old_supervisor)
            denied(f"retained {model.__name__} ignores uploader's new Department", retained, new_supervisor)

        # Cleanup remains conservative even where an ambiguous old signature grants no read access.
        legacy_record.definition_snapshot_json = None
        session.add(legacy_record)
        session.commit()
        cleanup = upload_storage.cleanup_unreferenced_uploads([upload_url(legacy.filename)], session)
        assert_equal("ambiguous old signature is retained by cleanup", cleanup.retained, (legacy.filename,))
    finally:
        session.close()
        engine.dispose()
        (upload_storage.PRODUCTION_LIKE, upload_storage.UPLOAD_STORAGE_BACKEND,
         upload_storage.UPLOAD_BUCKET, upload_storage.UPLOAD_DIR) = original_configuration


def main():
    original_backend = upload_storage.UPLOAD_STORAGE_BACKEND
    original_bucket = upload_storage.UPLOAD_BUCKET
    original_prefix = upload_storage.UPLOAD_OBJECT_PREFIX
    original_dir = upload_storage.UPLOAD_DIR
    original_production_like = upload_storage.PRODUCTION_LIKE

    try:
        with TemporaryDirectory() as local_dir, TemporaryDirectory() as lifecycle_dir, TemporaryDirectory() as authorization_dir:
            test_department_scoped_evidence_authorization(authorization_dir)
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
