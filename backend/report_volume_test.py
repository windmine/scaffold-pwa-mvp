"""Bounded, disposable PostgreSQL volume checks for Report history and exports.

Reuses the owned-cluster rehearsal lifecycle; never accepts a database URL.
The actual ASGI GET routes run with dependency-overridden synthetic identities.
No browser, socket server, provider account, or hosted application fixture is used.
"""

import argparse
import asyncio
import base64
import csv
import gc
import hashlib
from io import BytesIO, StringIO
import json
import os
from pathlib import Path
import platform
import random
import re
import shutil
import subprocess
import threading
import time
import tracemalloc
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent.parent
MAX_RESPONSE_BYTES = 32 * 1024 * 1024
MAX_PYTHON_PEAK_BYTES = 256 * 1024 * 1024
MAX_PROBE_SECONDS = 120
PROFILES = {"ci": (25, 100), "representative": (100, 1000)}
MARKER = re.compile(r"VOLUME_REPORT_(\d{6})")
FINAL_NOTE = "Synthetic final review note 处理完成／覆核完成"


def require(value, message):
    if not value:
        raise AssertionError(message)


def file_sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pixel_sha(image):
    rgb = image.convert("RGB")
    try:
        return hashlib.sha256(f"{rgb.width}x{rgb.height}:".encode() + rgb.tobytes()).hexdigest()
    finally:
        rgb.close()


def process_rss():
    """Current process working set, without an optional psutil dependency."""
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        class Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                        ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                        ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]

        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
        if psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
            return counters.WorkingSetSize
        return None
    statm = Path("/proc/self/statm")
    if statm.exists():
        return int(statm.read_text().split()[1]) * os.sysconf("SC_PAGE_SIZE")
    return None


async def asgi_get(app, path, params):
    messages = []
    body_bytes = 0

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        nonlocal body_bytes
        body_bytes += len(message.get("body", b""))
        require(body_bytes <= MAX_RESPONSE_BYTES, "Response exceeded the bounded fixture output budget")
        messages.append(message)

    await app({
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"},
        "http_version": "1.1", "method": "GET", "scheme": "http",
        "path": path, "raw_path": path.encode(), "query_string": urlencode(params).encode(),
        "root_path": "", "headers": [], "client": ("127.0.0.1", 1), "server": ("localhost", 80),
    }, receive, send)
    start = next(item for item in messages if item["type"] == "http.response.start")
    content = b"".join(item.get("body", b"") for item in messages if item["type"] == "http.response.body")
    return start["status"], content


def fixture_raster(seed, *, large=False, signature=False):
    from PIL import Image, ImageDraw

    output = BytesIO()
    if signature:
        image = Image.new("RGB", (240, 90), "white")
        draw = ImageDraw.Draw(image)
        rng = random.Random(seed)
        points = [(10 + index * 12, 25 + rng.randrange(40)) for index in range(19)]
        draw.line(points, fill="black", width=3)
        image.save(output, format="PNG")
    else:
        size = (384, 256) if large else (64, 48)
        image = Image.frombytes("RGB", size, random.Random(seed).randbytes(size[0] * size[1] * 3))
        image.save(output, format="JPEG", quality=80)
    return output.getvalue()


def seed_fixture(engine, count, *, large_images=False):
    from PIL import Image
    from sqlmodel import Session
    from app import upload_storage
    from app.models import Site, User, WorkForm, WorkFormSubmission
    from app.use_cases.common import work_form_definition_snapshot_json

    fields = [
        {"id": "issue", "label": "Issue / 检查事项", "type": "text", "required": True},
        {"id": "observation", "label": "Observation / 現場備註", "type": "textarea"},
        {"id": "hours", "label": "Hours", "type": "number"},
        {"id": "safe", "label": "Safe", "type": "checkbox"},
        {"id": "signature", "label": "Worker signature", "type": "signature"},
        {"id": "crew", "label": "Crew", "type": "repeat"},
        {"id": "crew_name", "label": "Crew member", "type": "text", "repeat": "crew"},
        {"id": "crew_signature", "label": "Crew signature", "type": "signature", "repeat": "crew"},
    ]
    fixture = {"expected": {}, "evidence": {}, "evidence_pixels": {}, "upload_bytes": 0, "upload_count": 0}
    with Session(engine) as session:
        worker = User(department_id=1, email="volume-worker@fixture.invalid", name="Volume Worker 工人", password_hash="not-a-login")
        peer = User(department_id=1, email="volume-peer@fixture.invalid", name="Peer Worker", password_hash="not-a-login")
        foreign = User(department_id=2, email="volume-foreign@fixture.invalid", name="Other Worker", password_hash="not-a-login")
        supervisor = User(department_id=1, email="volume-supervisor@fixture.invalid", name="Volume Supervisor", role="supervisor", password_hash="not-a-login")
        global_admin = User(department_id=1, email="volume-global@fixture.invalid", name="Volume Global", role="supervisor", is_global_admin=True, password_hash="not-a-login")
        site = Site(department_id=1, name="Synthetic Site 現場", latitude=-36.8, longitude=174.7)
        other_site = Site(department_id=2, name="Other Synthetic Site", latitude=-36.7, longitude=174.6)
        session.add_all([worker, peer, foreign, supervisor, global_admin, site, other_site])
        session.flush()
        forms = [WorkForm(department_id=department, name=name, template_purpose=purpose,
                          fields_json=json.dumps(fields), created_by=supervisor.id)
                 for department, name, purpose in [(1, "Volume Report", "report"),
                                                   (2, "Other Department Report", "report"),
                                                   (1, "Retained Daywork", "daywork")]]
        session.add_all(forms)
        session.flush()
        fixture.update(worker_id=worker.id, peer_id=peer.id, foreign_id=foreign.id,
                       supervisor_id=supervisor.id, global_id=global_admin.id, form_id=forms[0].id)
        actors = {"own": (worker, forms[0], site, count),
                  "peer": (peer, forms[0], site, max(3, count // 10)),
                  "foreign": (foreign, forms[1], other_site, max(3, count // 10)),
                  "daywork": (worker, forms[2], site, 3),
                  "deleted": (worker, forms[0], site, 3)}
        now = datetime(2026, 10, 1, 0, 0, tzinfo=timezone.utc)
        serial = 0
        for category, (actor, form, row_site, size) in actors.items():
            fixture["expected"][category] = []
            for index in range(size):
                serial += 1
                # Every Report has independently named and independently drawn original evidence.
                uploads = [upload_storage.store_verified_raster(
                    fixture_raster(serial * 4 + part, large=large_images, signature=part >= 2), actor.id)
                    for part in range(4)]
                urls = [f"/uploads/{item.filename}" for item in uploads]
                contents = [upload_storage.load_upload(item.filename).content for item in uploads]
                fixture["upload_bytes"] += sum(map(len, contents))
                fixture["upload_count"] += 4
                marker = f"VOLUME_REPORT_{serial:06d}"
                workflow = ("submitted", "in_review", "resolved")[index % 3]
                review_at = now + timedelta(minutes=serial + 1)
                record = WorkFormSubmission(
                    department_id=actor.department_id, form_id=form.id, worker_id=actor.id, site_id=row_site.id,
                    submission_purpose=form.template_purpose,
                    work_date=("2026-10-01" if index < min(count, max(25, count // 10))
                               else f"2026-10-{2 + index % 9:02d}"),
                    answers_json=json.dumps({"issue": marker, "observation": "Synthetic inspection detail. " * 24,
                                             "hours": 7.5, "safe": True, "signature": urls[2],
                                             "crew": [{"crew_name": "Synthetic crew", "crew_signature": urls[3]}]}),
                    definition_snapshot_json=work_form_definition_snapshot_json(form), form_definition_version=1,
                    photo_urls=json.dumps(urls[:2]),
                    photo_metadata=json.dumps([{"name": f"photo-{part}.jpg", "type": "image/jpeg"} for part in (1, 2)]),
                    client_submission_id=f"volume-{count}-{large_images}-{category}-{index}",
                    workflow_status="submitted", status="pending", created_at=now + timedelta(minutes=serial),
                    deleted_at=now if category == "deleted" else None,
                )
                session.add(record)
                session.flush()
                # Real PostgreSQL boundaries require Reports to be inserted as
                # Submitted, then progress forward without changing content.
                if workflow != "submitted":
                    record.workflow_status = "in_review"
                    record.reviewing_supervisor_id = supervisor.id
                    record.review_started_at = review_at
                    session.add(record)
                    session.flush()
                if workflow == "resolved":
                    record.workflow_status = "resolved"
                    record.resolved_at = review_at + timedelta(minutes=1)
                    record.supervisor_note = FINAL_NOTE
                    session.add(record)
                    session.flush()
                fixture["expected"][category].append({"id": record.id, "marker": marker, "date": record.work_date,
                                                         "workflow": workflow, "worker_id": actor.id})
                # Keep hashes, not original fixture bytes, outside the request probes.
                fixture["evidence"][record.id] = [hashlib.sha256(content).hexdigest() for content in contents]
                hashes = []
                for content in contents:
                    with Image.open(BytesIO(content)) as image:
                        hashes.append(pixel_sha(image))
                fixture["evidence_pixels"][record.id] = hashes
        session.commit()
    return fixture


def immutable_inventory(engine):
    from sqlalchemy import text

    digest = hashlib.sha256()
    count = 0
    with engine.connect() as connection:
        for row in connection.execute(text("SELECT row_to_json(r)::text FROM workformsubmission r ORDER BY id")):
            digest.update(row[0].encode())
            count += 1
    return {"reports_and_controls": count, "sha256": digest.hexdigest()}


def validate_response(kind, content, expected, fixture):
    expected_ids = {item["id"] for item in expected}
    expected_markers = {item["marker"] for item in expected}
    if kind == "history":
        rows = json.loads(content)
        require({row["id"] for row in rows} == expected_ids and len(rows) == len(expected_ids), "History lost or leaked Report identities")
        require(all(row["worker_id"] == fixture["worker_id"] and row["submission_purpose"] == "report" for row in rows), "History escaped Worker/purpose scope")
        require(all(len(row["photo_urls"]) == 2 and row["answers"]["signature"] and row["answers"]["crew"][0]["crew_signature"] for row in rows), "History evidence/answers were truncated")
        return {"records": len(rows), "evidence_references_per_record": 4}
    if kind == "csv":
        rows = list(csv.DictReader(StringIO(content.decode())))
        require({int(row["id"]) for row in rows} == expected_ids and len(rows) == len(expected_ids), "CSV lost or leaked Report identities")
        require({row["answer_issue"] for row in rows} == expected_markers, "CSV answers changed")
        require(all(row["submission_purpose"] == "report" and row["status"] == row["workflow_status"] for row in rows), "CSV purpose/workflow changed")
        require(all(row["supervisor_note"] == FINAL_NOTE and row["reviewing_supervisor_id"] and row["review_started_at"] and row["resolved_at"] for row in rows if row["workflow_status"] == "resolved"), "CSV lost final review metadata")
        return {"records": len(rows)}
    if kind == "html":
        text = content.decode()
        markers = {"VOLUME_REPORT_" + value for value in MARKER.findall(text)}
        require(markers == expected_markers, "HTML lost or leaked Report answers")
        embedded = {hashlib.sha256(base64.b64decode(value)).hexdigest()
                    for value in re.findall(r'data:image/[^;]+;base64,([^"\s<>]+)', text)}
        for record_id in expected_ids:
            require(set(fixture["evidence"][record_id][:3]) <= embedded, "HTML lost photos or direct signature")
        excluded = set(fixture["evidence"]) - expected_ids
        require(not any(set(fixture["evidence"][record_id]) & embedded for record_id in excluded), "HTML embedded out-of-scope evidence")
        repeated = sum(fixture["evidence"][record_id][3] in embedded for record_id in expected_ids)
        return {"records": len(markers), "unique_embedded_images": len(embedded),
                "photos_and_direct_signatures_verified": 3 * len(expected_ids),
                "repeating_signatures_embedded": repeated,
                "repeating_signatures_not_embedded": len(expected_ids) - repeated,
                "out_of_scope_fixture_images": 0}
    from PIL import Image
    from pypdf import PdfReader

    reader = PdfReader(BytesIO(content))
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    require({"VOLUME_REPORT_" + value for value in MARKER.findall(text)} == expected_markers, "PDF lost or leaked Report answers")
    require(all(value in text for value in ("检查事项", "現場備註", "工人", "現場", "处理完成", "覆核完成")),
            "PDF lost mixed Simplified/Traditional Chinese labels, identity or final review text")
    image_dimensions = set()
    image_count = 0
    embedded_pixels = set()
    for page in reader.pages:
        for embedded in page.images:
            image = embedded.image
            image_count += 1
            image_dimensions.add(image.size)
            obj = embedded.indirect_reference.get_object()
            filters = obj.get("/Filter", [])
            filters = [filters] if isinstance(filters, str) else filters
            if "/DCTDecode" in filters:
                # pypdf's .image convenience extraction recompresses JPEGs.
                # Decode the original PDF DCT stream instead; it retains the
                # submitted JPEG bytes and avoids a false pixel mismatch.
                with Image.open(BytesIO(obj.get_data())) as original:
                    embedded_pixels.add(pixel_sha(original))
            else:
                embedded_pixels.add(pixel_sha(image))
    require((240, 90) in image_dimensions, "PDF lost handwritten signature images")
    require((64, 48) in image_dimensions or (384, 256) in image_dimensions, "PDF lost photo images")
    # These fixture dimensions are below the print-resize threshold, so exact
    # decoded pixel identity verifies all four images, not just their dimensions.
    for record_id in expected_ids:
        require(set(fixture["evidence_pixels"][record_id]) <= embedded_pixels,
                "PDF lost or changed an expected original photo/direct/repeating signature")
    excluded = set(fixture["evidence_pixels"]) - expected_ids
    require(not any(set(fixture["evidence_pixels"][record_id]) & embedded_pixels for record_id in excluded),
            "PDF embedded out-of-scope evidence")
    return {"records": len(expected_ids), "pages": len(reader.pages), "image_occurrences": image_count,
            "original_evidence_images_pixel_verified": 4 * len(expected_ids), "out_of_scope_fixture_images": 0,
            "simplified_and_traditional_chinese_excerpts_verified": True}


def probe(engine, fixture, name, kind, path, params, expected, *, actor="worker", repetition="first"):
    from sqlalchemy import event
    from sqlmodel import Session
    from app.main import app, get_current_user, get_session, require_supervisor
    from app.models import User

    gc.collect()
    metrics = {"case": name, "format": kind, "request": repetition, "expected_records": len(expected),
               "sql_statements": 0, "sql_seconds": 0.0, "submission_rows_returned": 0,
               "orm_objects_loaded": {}, "response_bytes": 0}
    rss_start = process_rss()
    rss_peak = [rss_start or 0]
    stop = threading.Event()

    def sample():
        while not stop.wait(0.01):
            rss_peak[0] = max(rss_peak[0], process_rss() or 0)

    def before(_connection, _cursor, _statement, _parameters, context, _many):
        context._report_volume_started = time.perf_counter()

    def after(_connection, cursor, statement, _parameters, context, _many):
        metrics["sql_statements"] += 1
        metrics["sql_seconds"] += time.perf_counter() - context._report_volume_started
        if statement.lstrip().upper().startswith("SELECT") and "FROM workformsubmission" in statement:
            metrics["submission_rows_returned"] += max(0, cursor.rowcount)

    def loaded(_session, instance):
        name = type(instance).__name__
        metrics["orm_objects_loaded"][name] = metrics["orm_objects_loaded"].get(name, 0) + 1

    previous = app.dependency_overrides.copy()
    with Session(engine) as session:
        user = session.get(User, fixture[{"worker": "worker_id", "supervisor": "supervisor_id", "global": "global_id"}[actor]])
        app.dependency_overrides[get_session] = lambda: session
        app.dependency_overrides[get_current_user] = lambda: user
        app.dependency_overrides[require_supervisor] = lambda: user
        event.listen(engine, "before_cursor_execute", before)
        event.listen(engine, "after_cursor_execute", after)
        event.listen(session, "loaded_as_persistent", loaded)
        sampler = threading.Thread(target=sample, daemon=True)
        sampler.start()
        tracemalloc.start()
        started = time.perf_counter()
        cpu_started = time.process_time()
        try:
            status, content = asyncio.run(asgi_get(app, path, params))
            metrics["elapsed_seconds_profiled"] = time.perf_counter() - started
            metrics["process_cpu_seconds_profiled"] = round(time.process_time() - cpu_started, 6)
            metrics["python_allocation_peak_bytes"] = tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()
            stop.set()
            sampler.join(timeout=2)
            event.remove(engine, "before_cursor_execute", before)
            event.remove(engine, "after_cursor_execute", after)
            event.remove(session, "loaded_as_persistent", loaded)
            app.dependency_overrides.clear()
            app.dependency_overrides.update(previous)
    metrics.update(status=status, response_bytes=len(content), process_rss_start_bytes=rss_start,
                   process_rss_sampled_peak_bytes=max(rss_peak[0], process_rss() or 0),
                   process_rss_sample_interval_ms=10)
    require(status == 200, f"{name} returned HTTP {status}")
    require(metrics["elapsed_seconds_profiled"] < MAX_PROBE_SECONDS, f"{name} exceeded bounded probe runtime")
    require(metrics["python_allocation_peak_bytes"] < MAX_PYTHON_PEAK_BYTES, f"{name} exceeded bounded Python allocation budget")
    # These ceilings detect new per-row queries while explicitly preserving the
    # current measured N+1 behavior. They are not an efficiency endorsement.
    query_factor = 4 if actor == "global" or kind in ("html", "pdf") else 3
    metrics["sql_statement_budget"] = query_factor * len(expected) + 8
    require(metrics["sql_statements"] <= metrics["sql_statement_budget"], f"{name} added per-record SQL beyond its measured regression budget")
    metrics["verified_output"] = validate_response(kind, content, expected, fixture)
    metrics["sql_seconds"] = round(metrics["sql_seconds"], 6)
    metrics["elapsed_seconds_profiled"] = round(metrics["elapsed_seconds_profiled"], 6)
    return metrics


def run_volume_checks(database, report, profile):
    from app.migrations import run_migrations, verify_migrations

    datasets = [(count, False) for count in PROFILES[profile]]
    if profile == "representative":
        datasets.append((100, True))
    results = []
    for count, large in datasets:
        with database(f"volume_{count}_{int(large)}") as engine:
            run_migrations(engine)
            with engine.connect() as connection:
                verify_migrations(connection)
            fixture = seed_fixture(engine, count, large_images=large)
            before = immutable_inventory(engine)
            own = fixture["expected"]["own"]
            all_home = own + fixture["expected"]["peer"]
            chosen_date = [item for item in own if item["date"] == "2026-10-01"]
            common = {"purpose": "report"}
            dated = {**common, "worker_id": fixture["worker_id"], "date_from": "2026-10-01", "date_to": "2026-10-01"}
            cases = [
                ("worker_history", "history", "/my-form-submissions", common, own, "worker"),
                ("department_csv_all", "csv", "/supervisor/form-submissions/export.csv", common, all_home, "supervisor"),
                ("worker_date_csv", "csv", "/supervisor/form-submissions/export.csv", dated, chosen_date, "supervisor"),
                ("global_department_csv", "csv", "/supervisor/form-submissions/export.csv", {**common, "department_id": 1}, all_home, "global"),
                ("worker_date_html", "html", "/supervisor/form-submissions/export.html", dated, chosen_date, "supervisor"),
                ("worker_date_pdf", "pdf", "/supervisor/form-submissions/export.pdf", dated, chosen_date, "supervisor"),
            ]
            probes = []
            for name, kind, path, params, expected, actor in cases:
                for repetition in ("first", "repeat"):
                    result = probe(engine, fixture, name, kind, path, params, expected, actor=actor, repetition=repetition)
                    probes.append(result)
                    print(f"measure - {count} Reports/{'large' if large else 'small'} images/{name}/{repetition}: "
                          f"{result['sql_statements']} SQL, {result['elapsed_seconds_profiled']:.3f}s, "
                          f"{result['response_bytes']} response bytes", flush=True)
            require(immutable_inventory(engine) == before, "Read-only volume probes changed immutable Report data")
            detail = {"owned_worker_reports": count, "large_images": large,
                      "rows_by_category": {key: len(value) for key, value in fixture["expected"].items()},
                      "stored_upload_count": fixture["upload_count"], "stored_upload_bytes": fixture["upload_bytes"],
                      "photos_per_report": 2, "direct_signatures_per_report": 1, "repeating_signatures_per_report": 1,
                      "photo_dimensions": [384, 256] if large else [64, 48], "signature_dimensions": [240, 90],
                      "text_fixture": "English plus Simplified/Traditional Chinese field labels, Worker/Site names and final notes",
                      "all_observed_report_fields_unchanged": True, "probes": probes}
            report(f"Report volume {count}, {'larger' if large else 'small'} originals: scoped answers/evidence checks and unchanged records", detail)
            results.append(detail)
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pg-bin", type=Path, help="Directory with initdb, pg_ctl and postgres; otherwise REPORT_VOLUME_PG_BIN or initdb on PATH")
    parser.add_argument("--profile", choices=PROFILES, default="ci")
    parser.add_argument("--output", type=Path, help="New sanitized aggregate JSON file; existing files are never overwritten")
    parser.add_argument("--contention-note", default="Concurrent load was not controlled or recorded; timings are descriptive correctness-run observations.",
                        help="Operator-supplied description of concurrent test load; not independently verified")
    args = parser.parse_args()
    pg_bin = args.pg_bin
    if pg_bin is None and os.environ.get("REPORT_VOLUME_PG_BIN"):
        pg_bin = Path(os.environ["REPORT_VOLUME_PG_BIN"])
    if pg_bin is None and shutil.which("initdb"):
        pg_bin = Path(shutil.which("initdb")).parent
    if pg_bin is None:
        parser.error("PostgreSQL server binaries are required. Pass --pg-bin, set REPORT_VOLUME_PG_BIN, or put initdb/pg_ctl/postgres on PATH. Existing services are never used.")
    if args.output and args.output.exists():
        parser.error("--output already exists; choose a new evidence path")
    # Import application modules only with a harmless default database. Every
    # measured request then overrides the session with the owned native DB.
    with patch.dict(os.environ, {"APP_ENV": "test", "ENVIRONMENT": "test", "K_SERVICE": "", "AUTO_MIGRATE": "false",
                                 "DATABASE_URL": "sqlite://", "GEO_SECRET_KEY": "synthetic-volume-test-key",
                                 "ENABLE_DEV_SEED": "false", "UPLOAD_STORAGE_BACKEND": "local", "UPLOAD_BUCKET": ""}):
        from postgres_rehearsal import rehearsal

        def volume_phase(database, report):
            from app import upload_storage

            # The existing runner creates and owns this upload directory along
            # with its local cluster and verifies both before removing them.
            with patch.object(upload_storage, "UPLOAD_DIR", Path(os.environ["UPLOAD_DIR"])):
                run_volume_checks(database, report, args.profile)

        # The existing runner's review callback is a test seam, not an app patch.
        # All cluster/auth/cleanup guards remain in the unchanged lifecycle.
        with patch("postgres_review_rehearsal.run_review_checks", volume_phase):
            evidence = rehearsal(pg_bin.resolve(), review_only=True)
    evidence["scope"] = "representative_report_volume"
    evidence["profile"] = args.profile
    evidence["schema_version"] = 1
    evidence["environment"] = {"platform": platform.platform(), "python": platform.python_version(),
                               "logical_cpu_count": os.cpu_count(), "contention_note": args.contention_note,
                               "contention_note_source": "operator; no OS workload isolation is claimed"}
    evidence["source_commit"] = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    evidence["source_sha256"] = {path.relative_to(ROOT).as_posix(): file_sha(path) for path in [
        Path(__file__), ROOT / "backend/postgres_rehearsal.py", ROOT / "backend/app/use_cases/work_forms.py",
        ROOT / "backend/app/use_cases/common.py", ROOT / "backend/app/use_cases/supervisor_review.py",
        ROOT / "backend/app/use_cases/supervisor_review_exports.py", ROOT / "backend/app/use_cases/report_pdf.py"]}
    evidence["guardrails"] = {"maximum_response_bytes": MAX_RESPONSE_BYTES,
                              "maximum_python_allocation_peak_bytes": MAX_PYTHON_PEAK_BYTES,
                              "maximum_profiled_probe_seconds": MAX_PROBE_SECONDS}
    evidence["measurement_notes"] = [
        "Sequential requests against native local PostgreSQL and the real ASGI endpoints; authentication is dependency-overridden with synthetic scoped identities.",
        "First/repeat each uses a fresh ORM session. First is not an OS/disk-cold guarantee; PostgreSQL caches are not flushed and Python/font caches may be warm from earlier probes.",
        "Wall and SQL timings include tracemalloc/event instrumentation overhead. RSS samples the Python process every 10ms; PostgreSQL memory and browser memory are excluded.",
        "Responses are fully captured, matching current buffered endpoint semantics. Output verification occurs after the measured request and is excluded from request timing/allocation peak.",
        "Synthetic small originals and one bounded larger-original comparison are not 50-photo/5MB evidence capacity, concurrent load, provider latency or physical-phone certification.",
        "Absolute resource bounds are generous runaway guards for this fixed fixture, not production latency/memory service-level objectives.",
        "Query ceilings allow the measured current N+1 behavior and prevent an additional per-record lookup; they do not claim query counts are constant or suitable for unbounded growth.",
        "HTML verifies every selected photo/direct signature and records repeating-signature embedding separately. PDF compares all four selected evidence images by decoded pixels and excludes all out-of-scope fixture evidence.",
    ]
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("x", encoding="utf-8") as handle:
            json.dump(evidence, handle, indent=2)
            handle.write("\n")
        print(f"Evidence: {args.output}")
    print(json.dumps({"passed": evidence["passed"], "cleanup_complete": evidence["cleanup_complete"],
                      "datasets": len(evidence["checks"]), "failures": evidence.get("failures", []),
                      **({"error": evidence["error"]} if evidence.get("error") else {})}))
    return 0 if evidence["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
