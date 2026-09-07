import sys
import asyncio
import csv
import json
import os
import socket
import sqlite3
import subprocess
import time
from contextlib import closing
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import HTTPException
from sqlalchemy import create_engine, inspect, text
from sqlmodel import Session


sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.rate_limit import InMemoryRateLimiter, RateLimitRule, client_ip  # noqa: E402
from app import upload_storage  # noqa: E402
from app.auth import create_access_token, csrf_token_from_auth_cookie  # noqa: E402
from app.use_cases.common import (  # noqa: E402
    can_access_department,
    user_is_global_admin,
    user_response,
    validate_global_admin_role,
)
from app.use_cases.supervisor_review import task_logs_csv_response  # noqa: E402
from app.use_cases.supervisor_review_exports import (  # noqa: E402
    write_spreadsheet_safe_csv_row,
)


class FakeHeaders(dict):
    def get(self, key, default=None):
        return super().get(key.lower(), default)


class FakeRequest:
    def __init__(self, path, host="127.0.0.1", headers=None):
        self.scope = {"path": path}
        self.client = SimpleNamespace(host=host)
        self.headers = FakeHeaders({
            str(key).lower(): value
            for key, value in (headers or {}).items()
        })


def assert_ok(label, condition):
    if not condition:
        raise AssertionError(label)
    print(f"ok - {label}")


def assert_rejected(label, callback):
    try:
        callback()
    except upload_storage.UploadValidationError:
        print(f"ok - {label}")
        return
    raise AssertionError(label)


def assert_http_rejected(label, callback, expected_detail):
    try:
        callback()
    except HTTPException as error:
        assert_ok(
            label,
            error.status_code == 400 and error.detail == expected_detail,
        )
        return
    raise AssertionError(label)


def request_status(url, *, method="GET", headers=None):
    request = Request(url, method=method, headers=headers or {})
    try:
        response = urlopen(request, timeout=3)
    except HTTPError as error:
        return error.code, error.headers, error.read()
    with response:
        return response.status, response.headers, response.read()


def assert_private_no_store(label, headers):
    directives = {
        item.strip().lower()
        for item in headers.get("Cache-Control", "").split(",")
        if item.strip()
    }
    assert_ok(label, {"private", "no-store"}.issubset(directives))


def test_auto_migrate_environment_defaults():
    backend_dir = Path(__file__).resolve().parent
    script = """
import json
import runpy
from pathlib import Path
from unittest.mock import patch

original_exists = Path.exists
with patch.object(
    Path,
    "exists",
    lambda candidate: candidate.name not in {".env", ".env.local"} and original_exists(candidate),
):
    config = runpy.run_path("app/config.py")
print(json.dumps({
    "production_like": config["PRODUCTION_LIKE"],
    "auto_migrate": config["AUTO_MIGRATE"],
}))
"""
    cases = [
        ("development default retains automatic migrations", {}, False, True),
        ("production default disables automatic migrations", {"APP_ENV": "production"}, True, False),
        ("prod alias disables automatic migrations", {"APP_ENV": "prod"}, True, False),
        ("Cloud Run detection disables automatic migrations", {"K_SERVICE": "isolated-security-fixture"}, True, False),
        ("ENVIRONMENT fallback disables production automatic migrations", {"ENVIRONMENT": "production"}, True, False),
        ("explicit development false disables automatic migrations", {"AUTO_MIGRATE": "false"}, False, False),
        ("explicit production false remains disabled", {"APP_ENV": "production", "AUTO_MIGRATE": "false"}, True, False),
        ("explicit production true remains detectable for startup rejection", {"APP_ENV": "production", "AUTO_MIGRATE": "true"}, True, True),
    ]
    for label, overrides, production_like, auto_migrate in cases:
        environment = os.environ.copy()
        for key in ("APP_ENV", "ENVIRONMENT", "K_SERVICE", "AUTO_MIGRATE"):
            environment.pop(key, None)
        environment.update({
            "GEO_SECRET_KEY": "isolated-security-config-secret-never-used-outside-tests",
            "DATABASE_URL": "sqlite://",
            **overrides,
        })
        result = subprocess.run(
            [sys.executable, "-c", script],
            cwd=backend_dir,
            env=environment,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        assert_ok(f"{label}: configuration loads", result.returncode == 0)
        assert_ok(label, json.loads(result.stdout) == {
            "production_like": production_like,
            "auto_migrate": auto_migrate,
        })


def test_production_startup_rejects_automatic_migrations():
    from app import main as application

    isolated_engine = create_engine("sqlite://")
    try:
        with (
            patch.object(application, "PRODUCTION_LIKE", True),
            patch.object(application, "AUTO_MIGRATE", True),
            patch.object(application, "engine", isolated_engine, create=True),
            patch("app.database.engine", isolated_engine),
            patch.object(application, "migrate_database") as migrate,
            patch.object(application, "ensure_upload_storage_ready") as storage,
            patch.object(application.record_trash_use_cases, "purge_expired_deleted_records_with_new_session") as purge,
            patch.object(application.record_trash_use_cases, "run_periodic_trash_purge", new_callable=AsyncMock) as periodic_purge,
        ):
            try:
                asyncio.run(application.on_startup())
            except RuntimeError as error:
                assert_ok("production startup explains the forbidden automatic migration setting", "AUTO_MIGRATE" in str(error))
            else:
                raise AssertionError("production startup accepted AUTO_MIGRATE=true")
            assert_ok("production startup rejects automatic migrations before migration, storage, or purge", not migrate.called and not storage.called and not purge.called and not periodic_purge.called)
            assert_ok("rejected production startup does not create database tables", not inspect(isolated_engine).get_table_names())
    finally:
        isolated_engine.dispose()


def test_readiness_validates_migration_ledger_without_writes():
    from app import main as application
    from app.migrations import run_migrations

    isolated_engine = create_engine("sqlite://")
    try:
        run_migrations(isolated_engine)

        def readiness_snapshot():
            with isolated_engine.connect() as connection:
                before_changes = connection.connection.driver_connection.total_changes
                before_tables = inspect(connection).get_table_names()
            try:
                with Session(isolated_engine) as session:
                    body = application.readiness(session)
                status = 200
            except HTTPException as error:
                status, body = error.status_code, error.detail
            with isolated_engine.connect() as connection:
                after_changes = connection.connection.driver_connection.total_changes
                after_tables = inspect(connection).get_table_names()
            assert_ok("readiness leaves schema and row contents unchanged", before_changes == after_changes and before_tables == after_tables)
            return status, body

        def assert_migration_unready(label):
            status, body = readiness_snapshot()
            assert_ok(label, status == 503 and body.get("status") == "error" and body.get("checks") == {
                "database": "ok", "migrations": "error", "upload_storage": "ok",
            })
            serialized = json.dumps(body)
            assert_ok("migration readiness failures do not expose ledger or SQL diagnostics", all(
                marker not in serialized
                for marker in ("private-checksum-marker", "schema_migrations", "SELECT", "no such table", "Traceback")
            ))

        with patch.object(application, "ensure_upload_storage_ready", return_value="local"):
            status, body = readiness_snapshot()
            assert_ok("current migration ledger is ready", status == 200 and body.get("checks") == {
                "database": "ok", "migrations": "ok", "upload_storage": "ok",
            })
            with isolated_engine.begin() as connection:
                version, checksum = connection.execute(text(
                    "SELECT version, checksum FROM schema_migrations ORDER BY version LIMIT 1"
                )).one()
                connection.execute(text(
                    "UPDATE schema_migrations SET checksum = :checksum WHERE version = :version"
                ), {"checksum": "private-checksum-marker", "version": version})
            assert_migration_unready("tampered migration ledger fails readiness even while SELECT 1 works")
            with isolated_engine.begin() as connection:
                connection.execute(text(
                    "UPDATE schema_migrations SET checksum = :checksum WHERE version = :version"
                ), {"checksum": checksum, "version": version})
            status, body = readiness_snapshot()
            assert_ok("readiness observes a repaired migration ledger without restart", status == 200 and body["checks"]["migrations"] == "ok")
            with isolated_engine.begin() as connection:
                connection.exec_driver_sql("DROP TABLE schema_migrations")
            assert_migration_unready("missing migration ledger fails readiness without recreating it")
    finally:
        isolated_engine.dispose()


def check_http_migration_readiness(base_url, database_path):
    # This path belongs exclusively to the caller's temporary Uvicorn fixture.
    with closing(sqlite3.connect(database_path)) as connection:
        original_sql = connection.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
        ).fetchone()[0]
        original_rows = connection.execute(
            "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version"
        ).fetchall()
        if not original_rows:
            raise AssertionError("HTTP readiness fixture did not migrate its owned database")

        def ledger_snapshot():
            return (
                connection.execute("PRAGMA data_version").fetchone()[0],
                connection.execute("SELECT name, sql FROM sqlite_master ORDER BY name").fetchall(),
                connection.execute("SELECT * FROM schema_migrations ORDER BY version").fetchall(),
            )

        expected_error = {
            "detail": {
                "status": "error",
                "checks": {"database": "ok", "migrations": "error", "upload_storage": "ok"},
                "details": {"upload_storage": {"backend": "local"}},
            },
        }
        for case in ("pending", "unknown", "malformed"):
            try:
                if case == "pending":
                    connection.execute("DELETE FROM schema_migrations WHERE version = ?", (original_rows[-1][0],))
                elif case == "unknown":
                    connection.execute("INSERT INTO schema_migrations VALUES (?, ?, ?, ?)", (
                        "9999_private_http_readiness_marker", "private-fixture.py", "private-fixture-checksum", "private-fixture-time",
                    ))
                else:
                    connection.execute("DROP TABLE schema_migrations")
                    connection.execute("CREATE TABLE schema_migrations (version VARCHAR PRIMARY KEY)")
                    connection.execute("INSERT INTO schema_migrations VALUES (?)", ("private-malformed-marker",))
                connection.commit()
                before = ledger_snapshot()
                status, _, body = request_status(f"{base_url}/api/health/ready")
                assert_ok(
                    f"HTTP readiness rejects {case} migration history with sanitized 503 while the database remains reachable",
                    status == 503 and json.loads(body) == expected_error,
                )
                live_status, _, live_body = request_status(f"{base_url}/api/health")
                assert_ok(
                    f"{case} migration readiness failure preserves liveness and never repairs the ledger",
                    live_status == 200 and json.loads(live_body).get("status") == "ok" and ledger_snapshot() == before,
                )
            finally:
                connection.execute("DROP TABLE schema_migrations")
                connection.execute(original_sql)
                connection.executemany("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)", original_rows)
                connection.commit()
            recovered_before = ledger_snapshot()
            recovered_status, _, recovered_body = request_status(f"{base_url}/api/health/ready")
            assert_ok(
                f"HTTP readiness recovers from {case} history after restoring the exact original ledger without restart",
                recovered_status == 200
                and json.loads(recovered_body).get("checks") == {
                    "database": "ok", "migrations": "ok", "upload_storage": "ok",
                }
                and ledger_snapshot() == recovered_before,
            )


def test_upload_error_cache_middleware():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]

    backend_dir = Path(__file__).resolve().parent
    server_temp = TemporaryDirectory()
    server_temp_path = Path(server_temp.name)
    environment = os.environ.copy()
    environment.pop("K_SERVICE", None)
    environment.pop("ENVIRONMENT", None)
    environment.update({
        "APP_ENV": "test",
        "K_SERVICE": "",
        "AUTO_MIGRATE": "true",
        "DATABASE_URL": f"sqlite:///{(server_temp_path / 'security.db').as_posix()}",
        "ENABLE_DEV_SEED": "false",
        "RATE_LIMIT_ENABLED": "true",
        "RATE_LIMIT_GENERAL_REQUESTS": "1",
        "RATE_LIMIT_GENERAL_WINDOW_SECONDS": "600",
        "UPLOAD_STORAGE_BACKEND": "local",
        "UPLOAD_DIR": str(server_temp_path / "uploads"),
    })
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--log-level",
            "error",
        ],
        cwd=backend_dir,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    base_url = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + 15
        while True:
            if process.poll() is not None:
                output = process.stdout.read() if process.stdout else ""
                raise AssertionError(f"upload cache test server exited early: {output}")
            try:
                status, _, _ = request_status(f"{base_url}/health")
                if status == 200:
                    break
            except (URLError, TimeoutError):
                pass
            if time.monotonic() >= deadline:
                raise AssertionError("upload cache test server did not become ready")
            time.sleep(0.1)

        readiness_status, _, readiness_body = request_status(f"{base_url}/health/ready")
        assert_ok(
            "isolated HTTP readiness verifies the migrated database",
            readiness_status == 200
            and json.loads(readiness_body).get("checks") == {
                "database": "ok", "migrations": "ok", "upload_storage": "ok",
            },
        )
        check_http_migration_readiness(base_url, server_temp_path / "security.db")
        upload_url = f"{base_url}/api/uploads/missing.png"
        first_status, first_headers, _ = request_status(upload_url)
        assert_ok("anonymous upload request is denied", first_status == 401)
        assert_private_no_store(
            "anonymous upload denial bypasses shared edge caches",
            first_headers,
        )

        limited_status, limited_headers, _ = request_status(upload_url)
        assert_ok("upload request is rate limited", limited_status == 429)
        assert_private_no_store(
            "rate-limited upload denial bypasses shared edge caches",
            limited_headers,
        )

        cors_status, cors_headers, _ = request_status(
            upload_url,
            method="OPTIONS",
            headers={
                "Origin": "https://evil.invalid",
                "Access-Control-Request-Method": "GET",
                "X-Forwarded-For": "203.0.113.99",
            },
        )
        assert_ok("disallowed upload preflight is rejected", cors_status == 400)
        assert_private_no_store(
            "CORS upload denial bypasses shared edge caches",
            cors_headers,
        )
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        server_temp.cleanup()


def main():
    test_auto_migrate_environment_defaults()
    test_production_startup_rejects_automatic_migrations()
    test_readiness_validates_migration_ledger_without_writes()
    hybrid_worker = SimpleNamespace(
        id=1,
        role="worker",
        worker_class="normal",
        is_global_admin=True,
        department_id=1,
        dashboard_department_id=None,
        email="malformed-worker@example.com",
        name="Malformed Worker",
        status="active",
    )
    global_supervisor = SimpleNamespace(role="supervisor", is_global_admin=True, department_id=1)
    assert_ok(
        "Worker global-admin flags do not grant effective global access",
        not user_is_global_admin(hybrid_worker)
        and not can_access_department(hybrid_worker, 2)
        and not user_response(hybrid_worker)["is_global_admin"],
    )
    assert_ok(
        "Supervisor global-admin flags grant cross-department access",
        user_is_global_admin(global_supervisor)
        and can_access_department(global_supervisor, 2),
    )
    validate_global_admin_role("supervisor", True)
    validate_global_admin_role("worker", False)
    assert_http_rejected(
        "global admin access requires the Supervisor role",
        lambda: validate_global_admin_role("worker", True),
        "Global admin access requires the Supervisor role",
    )

    csrf_token = "dependency-cleanup-csrf"
    access_token = create_access_token({
        "sub": "dependency-test@example.com",
        "csrf": csrf_token,
    })
    assert_ok(
        "PyJWT access tokens preserve the CSRF claim",
        csrf_token_from_auth_cookie(access_token) == csrf_token,
    )
    assert_ok(
        "tampered PyJWT access tokens are rejected",
        csrf_token_from_auth_cookie(f"{access_token}tampered") is None,
    )

    limiter = InMemoryRateLimiter(
        enabled=True,
        default_rule=RateLimitRule("general", 2, 60),
        rules=[
            RateLimitRule("auth", 1, 60, ("/auth/login",)),
        ],
        exempt_paths={"/health", "/health/ready"},
    )

    assert_ok("health is rate-limit exempt", limiter.check(FakeRequest("/health")) is None)
    assert_ok("api prefix is normalized for auth limits", limiter.check(FakeRequest("/api/auth/login")) is None)
    auth_limited = limiter.check(FakeRequest("/auth/login"))
    assert_ok("auth limit returns 429", auth_limited is not None and auth_limited.status_code == 429)

    assert_ok("general request 1 is allowed", limiter.check(FakeRequest("/sites", host="10.0.0.1")) is None)
    assert_ok("general request 2 is allowed", limiter.check(FakeRequest("/sites", host="10.0.0.1")) is None)
    general_limited = limiter.check(FakeRequest("/sites", host="10.0.0.1"))
    assert_ok("general limit returns 429", general_limited is not None and general_limited.status_code == 429)

    forwarded_request = FakeRequest(
        "/sites",
        host="10.0.0.2",
        headers={"X-Forwarded-For": "203.0.113.5, 10.0.0.2"},
    )
    assert_ok("x-forwarded-for client ip is used", client_ip(forwarded_request) == "203.0.113.5")
    test_upload_error_cache_middleware()

    original_backend = upload_storage.UPLOAD_STORAGE_BACKEND
    original_bucket = upload_storage.UPLOAD_BUCKET
    original_dir = upload_storage.UPLOAD_DIR
    original_production_like = upload_storage.PRODUCTION_LIKE
    try:
        with TemporaryDirectory() as tmp_dir:
            upload_storage.UPLOAD_STORAGE_BACKEND = "local"
            upload_storage.UPLOAD_BUCKET = ""
            upload_storage.UPLOAD_DIR = Path(tmp_dir)
            upload_storage.PRODUCTION_LIKE = False
            assert_rejected(
                "active SVG content is rejected even with a raster filename",
                lambda: upload_storage.store_verified_raster(
                    b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
                    uploaded_by=1,
                ),
            )
            assert_ok(
                "external upload URLs cannot claim a local object",
                upload_storage.upload_filename_from_url(
                    "https://attacker.example/uploads/example.png"
                ) is None,
            )
    finally:
        upload_storage.UPLOAD_STORAGE_BACKEND = original_backend
        upload_storage.UPLOAD_BUCKET = original_bucket
        upload_storage.UPLOAD_DIR = original_dir
        upload_storage.PRODUCTION_LIKE = original_production_like

    csv_output = StringIO()
    csv_writer = csv.writer(csv_output)
    risky_values = ["=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1", "\n=1", "  =1", "Safe", -1]
    write_spreadsheet_safe_csv_row(csv_writer, risky_values)
    encoded_values = next(csv.reader(StringIO(csv_output.getvalue())))
    assert_ok(
        "spreadsheet formula and control prefixes are neutralized",
        encoded_values == [
            "'=1+1",
            "'+1",
            "'-1",
            "'@SUM(A1)",
            "'\t=1",
            "'\r=1",
            "'\n=1",
            "'  =1",
            "Safe",
            "-1",
        ],
    )

    task_export = task_logs_csv_response(
        [
            {
                "id": 1,
                "worker_id": 1,
                "worker_name": "+Injected worker",
                "site_id": None,
                "site_name": None,
                "work_date": "2026-07-15",
                "hours_worked": 8,
                "description": "=HYPERLINK(\"https://example.invalid\")",
                "safety_notes": "\t@unsafe",
                "photo_urls": [],
                "entry_source": "worker",
                "created_by_supervisor_id": None,
                "created_by_supervisor_name": None,
                "status": "pending",
                "created_at": "2026-07-15T00:00:00Z",
            }
        ],
        "task-log.csv",
    )
    task_rows = list(csv.reader(StringIO(task_export.body.decode("utf-8"))))
    assert_ok(
        "task CSV export applies spreadsheet-safe encoding to user text",
        task_rows[1][2] == "'+Injected worker"
        and task_rows[1][7].startswith("'=")
        and task_rows[1][8].startswith("'\t"),
    )

    print("security test passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
