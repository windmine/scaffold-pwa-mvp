import base64
import json
import os
import sys
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


BASE_URL = os.environ.get("API_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
SMOKE_IMAGE_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


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


def app_origin():
    if BASE_URL.endswith("/api"):
        return BASE_URL[:-4]
    return BASE_URL


def upload_test_image(label, token, filename):
    boundary = f"----geoSmokeBoundary{datetime.now(timezone.utc).timestamp()}"
    body = b"".join([
        f"--{boundary}\r\n".encode("utf-8"),
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'.encode("utf-8"),
        b"Content-Type: image/png\r\n\r\n",
        SMOKE_IMAGE_BYTES,
        b"\r\n",
        f"--{boundary}--\r\n".encode("utf-8"),
    ])
    request_obj = Request(f"{BASE_URL}/photo-uploads", data=body, method="POST")
    request_obj.add_header("Accept", "application/json")
    request_obj.add_header("Authorization", f"Bearer {token}")
    request_obj.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    request_obj.add_header("Content-Length", str(len(body)))

    with urlopen(request_obj, timeout=10) as response:
        upload = json.loads(response.read().decode("utf-8"))

    try:
        with urlopen(Request(f"{app_origin()}{upload['url']}", method="GET"), timeout=10):
            raise AssertionError(f"{label}: unauthenticated upload fetch should fail")
    except HTTPError as error:
        if error.code != 401:
            raise AssertionError(f"{label}: expected unauthenticated fetch to return 401, got {error.code}")

    fetch_request = Request(f"{app_origin()}{upload['url']}", method="GET")
    fetch_request.add_header("Authorization", f"Bearer {token}")
    with urlopen(fetch_request, timeout=10) as response:
        fetched = response.read()

    if fetched != SMOKE_IMAGE_BYTES:
        raise AssertionError(f"{label}: fetched upload did not match uploaded bytes")

    print(f"ok - {label}")
    return upload["url"]


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
        signature_smoke_url = upload_test_image("upload smoke signature", worker_token, f"signature-smoke-{timestamp}.png")
        form_smoke_photo_url = upload_test_image("upload smoke form photo", worker_token, f"form-smoke-{timestamp}.png")
        signature_reject_url = upload_test_image("upload rejectable smoke signature", worker_token, f"signature-smoke-reject-{timestamp}.png")
        form_reject_photo_url = upload_test_image("upload rejectable smoke form photo", worker_token, f"form-smoke-reject-{timestamp}.png")
        task_photo_1_url = upload_test_image("upload smoke task photo 1", worker_token, f"smoke-task-1-{timestamp}.png")
        task_photo_2_url = upload_test_image("upload smoke task photo 2", worker_token, f"smoke-task-2-{timestamp}.png")
        task_reject_photo_url = upload_test_image("upload rejectable smoke task photo", worker_token, f"smoke-task-reject-{timestamp}.png")

        assert_status(
            "worker cannot list supervisor users",
            request("GET", "/supervisor/users", token=worker_token),
            403,
        )
        assert_status(
            "worker cannot list supervisor audit events",
            request("GET", "/supervisor/audit-events", token=worker_token),
            403,
        )
        assert_status(
            "supervisor cannot create attendance",
            request(
                "POST",
                "/attendance",
                {
                    "record_type": "check_in",
                    "latitude": -36.8485,
                    "longitude": 174.7633,
                },
                supervisor_token,
            ),
            403,
        )
        assert_status(
            "supervisor cannot remove own role",
            request(
                "PATCH",
                f"/supervisor/users/{supervisor_login['user']['id']}",
                {"role": "worker", "confirmed": True},
                supervisor_token,
            ),
            400,
        )

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
        smoke_user = assert_status(
            "update staff user",
            request(
                "PATCH",
                f"/supervisor/users/{smoke_user['id']}",
                {
                    "name": f"Smoke Worker Updated {timestamp}",
                    "role": "worker",
                    "status": "active",
                    "confirmed": True,
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
        smoke_user_login = assert_status(
            "reactivated worker can login",
            request(
                "POST",
                "/auth/login",
                {"email": smoke_user["email"], "password": "Passw0rd!"},
            ),
            200,
        )
        smoke_worker_token = smoke_user_login["access_token"]

        assert_status("anonymous cannot list sites", request("GET", "/sites"), 401)
        sites = assert_status("sites list", request("GET", "/sites", token=worker_token), 200)
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
        forms = assert_status(
            "list worker work forms",
            request("GET", "/work-forms", token=worker_token),
            200,
        )
        if not any(form["name"] == "Inspection form" for form in forms):
            raise AssertionError("list worker work forms: expected seeded inspection form")
        smoke_form = assert_status(
            "create supervisor work form",
            request(
                "POST",
                "/supervisor/work-forms",
                {
                    "name": f"Smoke Form {timestamp}",
                    "description": "Smoke-test dynamic form",
                    "fields": [
                        {"id": "area", "label": "Area", "type": "text", "required": True},
                        {"id": "result", "label": "Result", "type": "select", "required": True, "options": ["Pass", "Fail"]},
                        {"id": "notes", "label": "Notes", "type": "textarea", "required": False},
                        {"id": "worker_signature", "label": "Worker signature", "type": "signature", "required": True},
                    ],
                },
                supervisor_token,
            ),
            200,
        )
        form_submission = assert_status(
            "submit work form",
            request(
                "POST",
                "/form-submissions",
                {
                    "form_id": smoke_form["id"],
                    "site_id": site["id"],
                    "work_date": now.date().isoformat(),
                    "answers": {
                        "area": "North bay",
                        "result": "Pass",
                        "notes": "All clear",
                        "worker_signature": signature_smoke_url,
                    },
                    "photo_urls": [form_smoke_photo_url],
                    "client_submission_id": f"smoke-form-{timestamp}",
                },
                worker_token,
            ),
            200,
        )
        if form_submission["answers"]["result"] != "Pass":
            raise AssertionError("submit work form: expected saved answer")
        if form_submission["status"] != "pending":
            raise AssertionError("submit work form: expected pending approval status")
        duplicate_form_submission = assert_status(
            "dedupe duplicate form submission retry",
            request(
                "POST",
                "/form-submissions",
                {
                    "form_id": smoke_form["id"],
                    "site_id": site["id"],
                    "work_date": now.date().isoformat(),
                    "answers": {
                        "area": "North bay",
                        "result": "Pass",
                        "notes": "All clear",
                        "worker_signature": signature_smoke_url,
                    },
                    "photo_urls": [form_smoke_photo_url],
                    "client_submission_id": f"smoke-form-{timestamp}",
                },
                worker_token,
            ),
            200,
        )
        if duplicate_form_submission["id"] != form_submission["id"]:
            raise AssertionError("dedupe duplicate form submission retry: expected original form submission")
        supervisor_form_submissions = assert_status(
            "list supervisor form submissions",
            request("GET", "/supervisor/form-submissions", token=supervisor_token),
            200,
        )
        if not any(item["id"] == form_submission["id"] for item in supervisor_form_submissions):
            raise AssertionError("list supervisor form submissions: created submission not found")
        approved_form_submission = assert_status(
            "supervisor approve form submission",
            request(
                "POST",
                f"/supervisor/review-records/form/{form_submission['id']}/decision",
                {"status": "approved"},
                supervisor_token,
            ),
            200,
        )
        if approved_form_submission["status"] != "approved":
            raise AssertionError("supervisor approve form submission: expected approved status")
        approved_review_records = assert_status(
            "list approved review records",
            request("GET", "/supervisor/review-records?status=approved", token=supervisor_token),
            200,
        )
        if not any(
            item["kind"] == "form" and item["id"] == form_submission["id"]
            for item in approved_review_records
        ):
            raise AssertionError("list approved review records: expected approved form submission")
        rejected_form_submission = assert_status(
            "submit rejectable work form",
            request(
                "POST",
                "/form-submissions",
                {
                    "form_id": smoke_form["id"],
                    "site_id": site["id"],
                    "work_date": now.date().isoformat(),
                    "answers": {
                        "area": "South bay",
                        "result": "Fail",
                        "notes": "Needs recheck",
                        "worker_signature": signature_reject_url,
                    },
                    "photo_urls": [form_reject_photo_url],
                    "client_submission_id": f"smoke-form-reject-{timestamp}",
                },
                worker_token,
            ),
            200,
        )
        rejected_form_submission = assert_status(
            "supervisor reject form submission",
            request(
                "POST",
                f"/supervisor/review-records/form/{rejected_form_submission['id']}/decision",
                {"status": "rejected"},
                supervisor_token,
            ),
            200,
        )
        if rejected_form_submission["status"] != "rejected":
            raise AssertionError("supervisor reject form submission: expected rejected status")
        rejected_review_records = assert_status(
            "list rejected review records",
            request("GET", "/supervisor/review-records?status=rejected", token=supervisor_token),
            200,
        )
        if not any(
            item["kind"] == "form" and item["id"] == rejected_form_submission["id"]
            for item in rejected_review_records
        ):
            raise AssertionError("list rejected review records: expected rejected form submission")
        worker_form_submissions = assert_status(
            "worker sees rejected form submission",
            request("GET", "/my-form-submissions", token=worker_token),
            200,
        )
        if not any(
            item["id"] == rejected_form_submission["id"] and item["status"] == "rejected"
            for item in worker_form_submissions
        ):
            raise AssertionError("worker sees rejected form submission: expected rejected status")
        assert_status(
            "reject required form answer missing",
            request(
                "POST",
                "/form-submissions",
                {
                    "form_id": smoke_form["id"],
                    "answers": {"result": "Pass"},
                },
                worker_token,
            ),
            400,
        )
        assert_status(
            "reject invalid form signature",
            request(
                "POST",
                "/form-submissions",
                {
                    "form_id": smoke_form["id"],
                    "answers": {
                        "area": "North bay",
                        "result": "Pass",
                        "worker_signature": "Someone Else",
                    },
                },
                worker_token,
            ),
            400,
        )
        assert_status(
            "archive work form",
            request(
                "PATCH",
                f"/supervisor/work-forms/{smoke_form['id']}",
                {"status": "archived", "confirmed": True},
                supervisor_token,
            ),
            200,
        )
        assert_status(
            "worker cannot submit archived form",
            request(
                "POST",
                "/form-submissions",
                {
                    "form_id": smoke_form["id"],
                    "answers": {"area": "North bay", "result": "Pass"},
                },
                worker_token,
            ),
            404,
        )
        other_worker_attendance = assert_status(
            "create other worker attendance",
            request(
                "POST",
                "/attendance",
                {
                    "record_type": "check_in",
                    "latitude": site["latitude"],
                    "longitude": site["longitude"],
                    "accuracy": 20,
                    "site_id": site["id"],
                    "note": f"other worker smoke test {timestamp}",
                },
                smoke_worker_token,
            ),
            200,
        )
        assert_status(
            "worker cannot delete another worker attendance",
            request("DELETE", f"/my-records/{other_worker_attendance['id']}", token=worker_token),
            404,
        )
        other_worker_template = assert_status(
            "create other worker template",
            request(
                "POST",
                "/task-templates",
                {
                    "name": f"Other Smoke Template {timestamp}",
                    "description": "Private worker template",
                    "site_id": site["id"],
                },
                smoke_worker_token,
            ),
            200,
        )
        assert_status(
            "worker cannot delete another worker template",
            request("DELETE", f"/task-templates/{other_worker_template['id']}", token=worker_token),
            404,
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
            "create inside-site attendance",
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
                    "client_submission_id": f"smoke-attendance-{timestamp}",
                },
                worker_token,
            ),
            200,
        )
        if attendance["within_site_radius"] is not True:
            raise AssertionError("create attendance: expected location to be inside site radius")
        if attendance["distance_from_site_m"] is None:
            raise AssertionError("create attendance: expected distance from site")
        if attendance["status"] != "approved":
            raise AssertionError("create attendance: expected inside-site attendance to auto-approve")
        duplicate_attendance = assert_status(
            "dedupe duplicate attendance retry",
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
                    "client_submission_id": f"smoke-attendance-{timestamp}",
                },
                worker_token,
            ),
            200,
        )
        if duplicate_attendance["id"] != attendance["id"]:
            raise AssertionError("dedupe duplicate attendance retry: expected original attendance record")
        assert_status(
            "worker cannot update auto-approved attendance",
            request(
                "PATCH",
                f"/my-records/{attendance['id']}",
                {"note": "late worker edit should fail"},
                worker_token,
            ),
            400,
        )
        pending_attendance = assert_status(
            "create outside-site attendance",
            request(
                "POST",
                "/attendance",
                {
                    "record_type": "check_in",
                    "latitude": site["latitude"] + 0.02,
                    "longitude": site["longitude"],
                    "accuracy": 20,
                    "site_id": site["id"],
                    "note": f"outside smoke test {timestamp}",
                },
                worker_token,
            ),
            200,
        )
        if pending_attendance["within_site_radius"] is not False:
            raise AssertionError("create outside-site attendance: expected location outside site radius")
        if pending_attendance["status"] != "pending":
            raise AssertionError("create outside-site attendance: expected pending status")
        pending_attendance = assert_status(
            "worker update pending attendance",
            request(
                "PATCH",
                f"/my-records/{pending_attendance['id']}",
                {"note": f"worker updated smoke test {timestamp}", "accuracy": 15},
                worker_token,
            ),
            200,
        )
        if pending_attendance["note"] != f"worker updated smoke test {timestamp}":
            raise AssertionError("worker update pending attendance: expected updated note")
        pending_attendance = assert_status(
            "update attendance record",
            request(
                "PATCH",
                f"/supervisor/records/{pending_attendance['id']}",
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
                    "latitude": site["latitude"] + 0.02,
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
                        task_photo_1_url,
                        task_photo_2_url,
                    ],
                    "client_submission_id": f"smoke-task-{timestamp}",
                },
                worker_token,
            ),
            200,
        )
        if len(task_log["photo_urls"]) != 2:
            raise AssertionError("create task log: expected two task photos")
        if task_log["status"] != "pending":
            raise AssertionError("create task log: expected pending approval status")
        duplicate_task_log = assert_status(
            "dedupe duplicate task log retry",
            request(
                "POST",
                "/task-logs",
                {
                    "description": f"Smoke-tested task log {timestamp}",
                    "site_id": site["id"],
                    "hours_worked": 1,
                    "work_date": now.date().isoformat(),
                    "photo_urls": [
                        task_photo_1_url,
                        task_photo_2_url,
                    ],
                    "client_submission_id": f"smoke-task-{timestamp}",
                },
                worker_token,
            ),
            200,
        )
        if duplicate_task_log["id"] != task_log["id"]:
            raise AssertionError("dedupe duplicate task log retry: expected original task log")
        pending_review_records = assert_status(
            "list pending review records",
            request("GET", "/supervisor/review-records?status=pending", token=supervisor_token),
            200,
        )
        if not any(
            item["kind"] == "attendance" and item["id"] == pending_attendance["id"]
            for item in pending_review_records
        ):
            raise AssertionError("list pending review records: expected pending outside-site attendance")
        if not any(
            item["kind"] == "task" and item["id"] == task_log["id"]
            for item in pending_review_records
        ):
            raise AssertionError("list pending review records: expected pending task log")
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
        approved_task_log = assert_status(
            "supervisor approve task log",
            request(
                "POST",
                f"/supervisor/review-records/task/{task_log['id']}/decision",
                {"status": "approved"},
                supervisor_token,
            ),
            200,
        )
        if approved_task_log["status"] != "approved":
            raise AssertionError("supervisor approve task log: expected approved status")
        assert_status(
            "worker cannot delete task log",
            request("DELETE", f"/my-task-logs/{task_log['id']}", token=worker_token),
            403,
        )
        rejected_task_log = assert_status(
            "create rejectable task log",
            request(
                "POST",
                "/task-logs",
                {
                    "description": f"Rejectable task log {timestamp}",
                    "site_id": site["id"],
                    "hours_worked": 2,
                    "work_date": now.date().isoformat(),
                    "photo_urls": [task_reject_photo_url],
                    "client_submission_id": f"smoke-task-reject-{timestamp}",
                },
                worker_token,
            ),
            200,
        )
        rejected_task_log = assert_status(
            "supervisor reject task log",
            request(
                "POST",
                f"/supervisor/review-records/task/{rejected_task_log['id']}/decision",
                {"status": "rejected"},
                supervisor_token,
            ),
            200,
        )
        if rejected_task_log["status"] != "rejected":
            raise AssertionError("supervisor reject task log: expected rejected status")
        rejected_review_records = assert_status(
            "list rejected task review records",
            request("GET", "/supervisor/review-records?status=rejected", token=supervisor_token),
            200,
        )
        if not any(
            item["kind"] == "task" and item["id"] == rejected_task_log["id"]
            for item in rejected_review_records
        ):
            raise AssertionError("list rejected task review records: expected rejected task log")
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
                f"/supervisor/review-records/attendance/{pending_attendance['id']}/decision",
                {"status": "approved"},
                supervisor_token,
            ),
            200,
        )
        assert_status(
            "worker cannot update approved attendance",
            request(
                "PATCH",
                f"/my-records/{pending_attendance['id']}",
                {"note": "late worker edit should fail"},
                worker_token,
            ),
            400,
        )
        assert_status(
            "worker cannot delete approved attendance",
            request("DELETE", f"/my-records/{pending_attendance['id']}", token=worker_token),
            400,
        )
        rejected_attendance = assert_status(
            "create rejectable attendance",
            request(
                "POST",
                "/attendance",
                {
                    "record_type": "check_out",
                    "latitude": site["latitude"] + 0.02,
                    "longitude": site["longitude"],
                    "accuracy": 20,
                    "site_id": site["id"],
                    "note": f"reject smoke test {timestamp}",
                    "client_submission_id": f"smoke-attendance-reject-{timestamp}",
                },
                worker_token,
            ),
            200,
        )
        rejected_attendance = assert_status(
            "supervisor reject attendance",
            request(
                "POST",
                f"/supervisor/review-records/attendance/{rejected_attendance['id']}/decision",
                {"status": "rejected"},
                supervisor_token,
            ),
            200,
        )
        if rejected_attendance["status"] != "rejected":
            raise AssertionError("supervisor reject attendance: expected rejected status")
        assert_status(
            "worker cannot update rejected attendance",
            request(
                "PATCH",
                f"/my-records/{rejected_attendance['id']}",
                {"note": "late rejected edit should fail"},
                worker_token,
            ),
            400,
        )
        assert_status(
            "worker cannot delete rejected attendance",
            request("DELETE", f"/my-records/{rejected_attendance['id']}", token=worker_token),
            400,
        )
        rejected_review_records = assert_status(
            "list rejected attendance review records",
            request("GET", "/supervisor/review-records?status=rejected", token=supervisor_token),
            200,
        )
        if not any(
            item["kind"] == "attendance" and item["id"] == rejected_attendance["id"]
            for item in rejected_review_records
        ):
            raise AssertionError("list rejected attendance review records: expected rejected attendance")
        csv_body = assert_status(
            "export attendance csv",
            request("GET", "/supervisor/records/export.csv", token=supervisor_token),
            200,
        )
        if "record_type" not in csv_body or "worker_name" not in csv_body:
            raise AssertionError("export attendance csv: missing expected CSV headers")
        task_csv_body = assert_status(
            "export task logs csv",
            request("GET", "/supervisor/task-logs/export.csv", token=supervisor_token),
            200,
        )
        if "hours_worked" not in task_csv_body or "photo_urls" not in task_csv_body:
            raise AssertionError("export task logs csv: missing expected CSV headers")
        task_log_html = assert_status(
            "export task logs html",
            request("GET", "/supervisor/task-logs/export.html?layout=daily-log", token=supervisor_token),
            200,
        )
        if "Daily Task Log Export" not in task_log_html or "Smoke-tested task log" not in task_log_html:
            raise AssertionError("export task logs html: missing expected task-log content")
        task_photo_html = assert_status(
            "export task photo report html",
            request("GET", "/supervisor/task-logs/export.html?layout=photo-report", token=supervisor_token),
            200,
        )
        if "Task Log Photo Report" not in task_photo_html or "data:image/png;base64" not in task_photo_html:
            raise AssertionError("export task photo report html: missing expected embedded photo content")
        form_html = assert_status(
            "export form submissions html",
            request("GET", "/supervisor/form-submissions/export.html", token=supervisor_token),
            200,
        )
        if "Work Form Submission Export" not in form_html or "Worker signature" not in form_html:
            raise AssertionError("export form submissions html: missing expected form content")
        single_task_csv_body = assert_status(
            "export single task log csv",
            request("GET", f"/supervisor/task-logs/{task_log['id']}/export.csv", token=supervisor_token),
            200,
        )
        if "Smoke-tested task log" not in single_task_csv_body or "photo_urls" not in single_task_csv_body:
            raise AssertionError("export single task log csv: missing expected task-log content")
        single_task_html = assert_status(
            "export single task log html",
            request("GET", f"/supervisor/task-logs/{task_log['id']}/export.html?layout=photo-report", token=supervisor_token),
            200,
        )
        if "Task Log Photo Report" not in single_task_html or f"Task log #{task_log['id']}" not in single_task_html:
            raise AssertionError("export single task log html: missing expected single-record content")
        single_form_csv_body = assert_status(
            "export single form submission csv",
            request("GET", f"/supervisor/form-submissions/{form_submission['id']}/export.csv", token=supervisor_token),
            200,
        )
        if "answer_worker_signature" not in single_form_csv_body or "North bay" not in single_form_csv_body:
            raise AssertionError("export single form submission csv: missing expected form answer content")
        single_form_html = assert_status(
            "export single form submission html",
            request("GET", f"/supervisor/form-submissions/{form_submission['id']}/export.html", token=supervisor_token),
            200,
        )
        if f"Form submission #{form_submission['id']}" not in single_form_html or "Worker signature" not in single_form_html:
            raise AssertionError("export single form submission html: missing expected single-record content")
        audit_events = assert_status(
            "list supervisor audit events",
            request("GET", "/supervisor/audit-events?limit=100", token=supervisor_token),
            200,
        )
        audit_actions = {event["action"] for event in audit_events}
        expected_audit_actions = {
            "user_create",
            "user_update",
            "user_status",
            "site_create",
            "site_update",
            "work_form_create",
            "work_form_archive",
            "attendance_update",
            "task_log_update",
            "review_decision",
        }
        missing_audit_actions = expected_audit_actions - audit_actions
        if missing_audit_actions:
            raise AssertionError(f"list supervisor audit events: missing actions {sorted(missing_audit_actions)}")
        if not any(
            event["entity_type"] == "attendance" and event["entity_id"] == pending_attendance["id"]
            for event in audit_events
        ):
            raise AssertionError("list supervisor audit events: expected attendance audit event")
        if not any(event.get("actor_name") == "Demo Supervisor" for event in audit_events):
            raise AssertionError("list supervisor audit events: expected actor details")
        work_form_audit_events = assert_status(
            "filter supervisor audit events by work form",
            request("GET", "/supervisor/audit-events?entity_type=work_form&limit=100", token=supervisor_token),
            200,
        )
        if not work_form_audit_events:
            raise AssertionError("filter supervisor audit events by work form: expected events")
        if any(event["entity_type"] != "work_form" for event in work_form_audit_events):
            raise AssertionError("filter supervisor audit events by work form: expected only work_form events")

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
