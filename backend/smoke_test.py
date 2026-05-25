import json
import os
import sys
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


BASE_URL = os.environ.get("API_BASE_URL", "http://127.0.0.1:8000").rstrip("/")


def request(method, path, payload=None, token=None):
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request_obj = Request(f"{BASE_URL}{path}", data=body, method=method)
    request_obj.add_header("Accept", "application/json")

    if payload is not None:
        request_obj.add_header("Content-Type", "application/json")
    if token:
        request_obj.add_header("Authorization", f"Bearer {token}")

    try:
        with urlopen(request_obj, timeout=10) as response:
            raw = response.read().decode("utf-8")
            content_type = response.headers.get("Content-Type", "")
            body = json.loads(raw) if raw and "application/json" in content_type else raw
            return response.status, body
    except HTTPError as error:
        raw = error.read().decode("utf-8")
        return error.code, json.loads(raw) if raw else None


def assert_status(label, result, expected_status):
    status, body = result

    if status != expected_status:
        raise AssertionError(f"{label}: expected {expected_status}, got {status}: {body}")

    print(f"ok - {label}")
    return body


def main():
    try:
        assert_status("health", request("GET", "/health"), 200)
        assert_status("seed demo data", request("POST", "/dev/seed"), 200)

        worker_login = assert_status(
            "worker login",
            request(
                "POST",
                "/auth/login",
                {"email": "worker@example.com", "password": "Passw0rd!"},
            ),
            200,
        )
        supervisor_login = assert_status(
            "supervisor login",
            request(
                "POST",
                "/auth/login",
                {"email": "supervisor@example.com", "password": "Passw0rd!"},
            ),
            200,
        )

        worker_token = worker_login["access_token"]
        supervisor_token = supervisor_login["access_token"]
        now = datetime.now(timezone.utc)
        timestamp = now.strftime("%Y%m%d%H%M%S%f")

        smoke_user = assert_status(
            "create resignable worker",
            request(
                "POST",
                "/supervisor/users",
                {
                    "name": f"Smoke Worker {timestamp}",
                    "email": f"smoke-worker-{timestamp}@example.com",
                    "password": "Passw0rd!",
                    "role": "worker",
                },
                supervisor_token,
            ),
            200,
        )
        assert_status(
            "mark worker resigned",
            request(
                "POST",
                f"/supervisor/users/{smoke_user['id']}/status",
                {"status": "resigned", "confirmed": True},
                supervisor_token,
            ),
            200,
        )
        assert_status(
            "resigned worker cannot login",
            request(
                "POST",
                "/auth/login",
                {"email": smoke_user["email"], "password": "Passw0rd!"},
            ),
            403,
        )
        assert_status(
            "reactivate worker",
            request(
                "POST",
                f"/supervisor/users/{smoke_user['id']}/status",
                {"status": "active", "confirmed": True},
                supervisor_token,
            ),
            200,
        )
        assert_status(
            "reactivated worker can login",
            request(
                "POST",
                "/auth/login",
                {"email": smoke_user["email"], "password": "Passw0rd!"},
            ),
            200,
        )

        sites = assert_status("sites list", request("GET", "/sites"), 200)
        if not sites:
            raise AssertionError("sites list: expected at least one site")

        site = assert_status(
            "create supervisor site",
            request(
                "POST",
                "/supervisor/sites",
                {
                    "name": f"Smoke Site {timestamp}",
                    "address": "Smoke Test Address",
                    "latitude": sites[0]["latitude"],
                    "longitude": sites[0]["longitude"],
                    "allowed_radius_m": 100,
                },
                supervisor_token,
            ),
            200,
        )
        site = assert_status(
            "update supervisor site",
            request(
                "PATCH",
                f"/supervisor/sites/{site['id']}",
                {"allowed_radius_m": 120, "confirmed": True},
                supervisor_token,
            ),
            200,
        )
        template = assert_status(
            "create task template",
            request(
                "POST",
                "/task-templates",
                {
                    "name": f"Smoke Template {timestamp}",
                    "description": "Repeat scaffold bay install",
                    "site_id": site["id"],
                    "hours_worked": 1,
                    "safety_notes": "Check tags and exclusion zone",
                },
                worker_token,
            ),
            200,
        )
        templates = assert_status(
            "list task templates",
            request("GET", "/task-templates", token=worker_token),
            200,
        )
        if not any(item["id"] == template["id"] for item in templates):
            raise AssertionError("list task templates: created template not found")
        template = assert_status(
            "update task template",
            request(
                "PATCH",
                f"/task-templates/{template['id']}",
                {
                    "name": f"Updated Smoke Template {timestamp}",
                    "hours_worked": 1.5,
                },
                worker_token,
            ),
            200,
        )
        if template["hours_worked"] != 1.5:
            raise AssertionError("update task template: expected updated hours")
        attendance = assert_status(
            "create attendance",
            request(
                "POST",
                "/attendance",
                {
                    "record_type": "check_in",
                    "latitude": site["latitude"],
                    "longitude": site["longitude"],
                    "accuracy": 20,
                    "site_id": site["id"],
                    "note": f"smoke test {timestamp}",
                },
                worker_token,
            ),
            200,
        )
        if attendance["within_site_radius"] is not True:
            raise AssertionError("create attendance: expected location to be inside site radius")
        if attendance["distance_from_site_m"] is None:
            raise AssertionError("create attendance: expected distance from site")
        attendance = assert_status(
            "worker update pending attendance",
            request(
                "PATCH",
                f"/my-records/{attendance['id']}",
                {"note": f"worker updated smoke test {timestamp}", "accuracy": 15},
                worker_token,
            ),
            200,
        )
        if attendance["note"] != f"worker updated smoke test {timestamp}":
            raise AssertionError("worker update pending attendance: expected updated note")
        attendance = assert_status(
            "update attendance record",
            request(
                "PATCH",
                f"/supervisor/records/{attendance['id']}",
                {"note": f"updated smoke test {timestamp}", "confirmed": True},
                supervisor_token,
            ),
            200,
        )
        delete_attendance = assert_status(
            "create deletable attendance",
            request(
                "POST",
                "/attendance",
                {
                    "record_type": "check_out",
                    "latitude": site["latitude"],
                    "longitude": site["longitude"],
                    "accuracy": 20,
                    "site_id": site["id"],
                    "note": f"delete smoke test {timestamp}",
                },
                worker_token,
            ),
            200,
        )
        assert_status(
            "delete pending attendance",
            request("DELETE", f"/my-records/{delete_attendance['id']}", token=worker_token),
            200,
        )
        assert_status(
            "reject bad latitude",
            request(
                "POST",
                "/attendance",
                {"record_type": "check_in", "latitude": -136, "longitude": 174},
                worker_token,
            ),
            422,
        )
        assert_status(
            "reject missing site",
            request(
                "POST",
                "/attendance",
                {
                    "record_type": "check_in",
                    "latitude": site["latitude"],
                    "longitude": site["longitude"],
                    "site_id": 999999,
                },
                worker_token,
            ),
            400,
        )
        task_log = assert_status(
            "create task log",
            request(
                "POST",
                "/task-logs",
                {
                    "description": f"Smoke-tested task log {timestamp}",
                    "site_id": site["id"],
                    "hours_worked": 1,
                    "work_date": now.date().isoformat(),
                    "photo_urls": [
                        "/uploads/smoke-task-1.jpg",
                        "/uploads/smoke-task-2.jpg",
                    ],
                },
                worker_token,
            ),
            200,
        )
        if len(task_log["photo_urls"]) != 2:
            raise AssertionError("create task log: expected two task photos")
        assert_status(
            "worker cannot update task log",
            request(
                "PATCH",
                f"/my-task-logs/{task_log['id']}",
                {
                    "description": f"Worker-updated task log {timestamp}",
                    "hours_worked": 1.1,
                },
                worker_token,
            ),
            403,
        )
        assert_status(
            "update task log",
            request(
                "PATCH",
                f"/supervisor/task-logs/{task_log['id']}",
                {"hours_worked": 1.25, "confirmed": True},
                supervisor_token,
            ),
            200,
        )
        assert_status(
            "worker cannot delete task log",
            request("DELETE", f"/my-task-logs/{task_log['id']}", token=worker_token),
            403,
        )
        assert_status(
            "delete task template",
            request("DELETE", f"/task-templates/{template['id']}", token=worker_token),
            200,
        )
        assert_status(
            "reject impossible hours",
            request(
                "POST",
                "/task-logs",
                {"description": "too many hours", "hours_worked": 25},
                worker_token,
            ),
            422,
        )
        assert_status(
            "reject too many task photos",
            request(
                "POST",
                "/task-logs",
                {
                    "description": "too many photos",
                    "photo_urls": [f"/uploads/photo-{index}.jpg" for index in range(9)],
                },
                worker_token,
            ),
            400,
        )
        assert_status(
            "supervisor approve attendance",
            request(
                "POST",
                f"/supervisor/records/{attendance['id']}/decision",
                {"status": "approved"},
                supervisor_token,
            ),
            200,
        )
        assert_status(
            "worker cannot update approved attendance",
            request(
                "PATCH",
                f"/my-records/{attendance['id']}",
                {"note": "late worker edit should fail"},
                worker_token,
            ),
            400,
        )
        assert_status(
            "worker cannot delete approved attendance",
            request("DELETE", f"/my-records/{attendance['id']}", token=worker_token),
            400,
        )
        csv_body = assert_status(
            "export attendance csv",
            request("GET", "/supervisor/records/export.csv", token=supervisor_token),
            200,
        )
        if "record_type" not in csv_body or "worker_name" not in csv_body:
            raise AssertionError("export attendance csv: missing expected CSV headers")

    except URLError as error:
        print(f"Could not reach {BASE_URL}: {error}", file=sys.stderr)
        return 1
    except AssertionError as error:
        print(error, file=sys.stderr)
        return 1

    print("smoke test passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
