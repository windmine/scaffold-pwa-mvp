"""The opt-in migration pause neither initializes the database nor accepts writes."""
import asyncio
import json
import sys

from app.maintenance import app


assert "app.database" not in sys.modules
assert "app.config" not in sys.modules

async def request(method, path):
    messages = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        messages.append(message)

    await app({"type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"},
               "http_version": "1.1", "method": method, "scheme": "https",
               "path": path, "raw_path": path.encode(), "query_string": b"",
               "root_path": "", "headers": [], "client": ("127.0.0.1", 1),
               "server": ("test", 443)}, receive, send)
    start = next(message for message in messages if message["type"] == "http.response.start")
    body = b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body")
    headers = {name.decode(): value.decode() for name, value in start["headers"]}
    return start["status"], headers, json.loads(body)


async def check():
    for path in ("/health", "/api/health"):
        status, _, body = await request("GET", path)
        assert status == 200
        assert body == {"status": "maintenance"}
    for method, path in (
        ("GET", "/health/ready"), ("GET", "/api/health/ready"),
        ("GET", "/api/auth/me"), ("POST", "/api/work-form-submissions"),
        ("PATCH", "/api/supervisor/work-forms/1"), ("GET", "/uploads/photo.png"),
        ("DELETE", "/api/supervisor/staff/1"), ("OPTIONS", "/api/auth/login"),
        ("GET", "/openapi.json"),
    ):
        status, headers, _ = await request(method, path)
        assert status == 503, (method, path)
        assert headers["retry-after"] == "60"
        assert headers["cache-control"] == "no-store"
        assert "set-cookie" not in headers


asyncio.run(check())
print("ok - database-free maintenance liveness and nine fail-closed route checks")
