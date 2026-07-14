import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace


sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.rate_limit import InMemoryRateLimiter, RateLimitRule, client_ip  # noqa: E402
from app import upload_storage  # noqa: E402


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


def main():
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

    print("security test passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
