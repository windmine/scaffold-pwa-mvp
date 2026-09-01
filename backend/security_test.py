import sys
import csv
import os
import socket
import subprocess
import time
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import HTTPException


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


def test_upload_error_cache_middleware():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]

    backend_dir = Path(__file__).resolve().parent
    server_temp = TemporaryDirectory()
    server_temp_path = Path(server_temp.name)
    environment = os.environ.copy()
    environment.update({
        "APP_ENV": "test",
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
