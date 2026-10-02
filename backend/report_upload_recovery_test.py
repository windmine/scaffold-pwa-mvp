"""Report upload recovery protocol checks against an owned disposable backend."""
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
import json
from io import BytesIO
from pathlib import Path
import sqlite3
from threading import Barrier
from urllib.parse import urlencode
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import jwt
from PIL import Image

from invitation_test import InvitationServer


def new_worker(server, label, **overrides):
    password = "RecoveryFixturePassword!"
    worker, _ = server.expect("POST", "/supervisor/users", {
        "email": f"{label}@report-recovery.invalid", "name": label,
        "password": password, "role": "worker", **overrides,
    }, 200, server.supervisor)
    signed_in, _ = server.expect("POST", "/auth/login", {
        "email": worker["email"], "password": password,
    }, 200)
    return worker, signed_in["access_token"]


def lookup(server, token, key, expected=200, **query):
    return server.expect("GET", "/my-form-submissions/by-client-id?" + urlencode({
        "client_submission_id": key, "purpose": "report", **query,
    }), None, expected, token)


def new_template(server, label):
    return server.expect("POST", "/supervisor/work-forms", {
        "name": label, "fields": [{"id": "detail", "label": "Detail", "type": "text"}],
    }, 200, server.supervisor)[0]


def report_payload(template, key, detail="Preserved original answer"):
    return {
        "form_id": template["id"], "work_date": "2026-10-01", "answers": {"detail": detail},
        "expected_definition_version": 1, "client_submission_id": key,
    }


def recovery_headers(worker):
    return {
        "X-Report-Recovery-Worker": str(worker["id"]),
        "X-Report-Recovery-Department": str(worker["department_id"]),
    }


def cookie_headers(server, token):
    claims = jwt.decode(token, server.environment["GEO_SECRET_KEY"], algorithms=["HS256"])
    csrf = claims["csrf"]
    return {"Cookie": f"__session={token}; geo_csrf_token={csrf}", "X-CSRF-Token": csrf}


def upload_photo(server, headers, token=None):
    content = BytesIO()
    Image.new("RGB", (2, 2), "blue").save(content, "PNG")
    boundary = "report-recovery-upload-boundary"
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"recovery.png\"\r\n"
            "Content-Type: image/png\r\n\r\n").encode() + content.getvalue() + f"\r\n--{boundary}--\r\n".encode()
    request = Request(server.base_url + "/photo-uploads", method="POST", data=body,
                      headers={"Content-Type": f"multipart/form-data; boundary={boundary}", **headers})
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        response = urlopen(request, timeout=10)
    except HTTPError as error:
        response = error
    with response:
        return response.status, json.loads(response.read())


def test_absence_is_explicit_read_only_and_uncached(server):
    worker, token = new_worker(server, "absent")
    result, headers = lookup(server, token, "never-submitted")
    assert result == {
        "status": "not_found", "client_submission_id": "never-submitted", "submission": None,
        "worker_id": worker["id"], "department_id": worker["department_id"],
    }
    assert headers.get("Cache-Control") == "private, no-store"
    history, _ = server.expect("GET", "/my-form-submissions?purpose=report", None, 200, token)
    assert history == [], "Checking upload recovery must never create a Report"
    print("ok - explicit uncached absence check is read-only")


def test_lookup_finds_only_exact_owner_including_deleted_reports(server):
    owner, token = new_worker(server, "exact-owner")
    other, other_token = new_worker(server, "other-owner")
    template = new_template(server, "Owner recovery fixture")
    report, _ = server.expect("POST", "/form-submissions", report_payload(template, "shared-key"), 200, token)
    found, _ = lookup(server, token, "shared-key")
    assert found["status"] == "submitted" and found["submission"]["id"] == report["id"]
    assert found["submission"]["worker_id"] == owner["id"]
    assert found["worker_id"] == owner["id"] and found["department_id"] == owner["department_id"]
    assert found["submission"]["answers"] == {"detail": "Preserved original answer"}
    assert lookup(server, other_token, "shared-key")[0]["status"] == "not_found"
    own_other, _ = server.expect("POST", "/form-submissions", report_payload(template, "shared-key"), 200, other_token)
    assert lookup(server, other_token, "shared-key")[0]["submission"]["worker_id"] == other["id"]
    assert own_other["id"] != report["id"]
    server.expect("POST", f'/supervisor/trash/form/{report["id"]}', {
        "confirmed": True, "reason": "Owned recovery fixture",
    }, 200, server.supervisor)
    assert lookup(server, token, "shared-key")[0] == {
        "status": "deleted", "client_submission_id": "shared-key", "submission": None,
        "worker_id": owner["id"], "department_id": owner["department_id"],
    }
    assert lookup(server, other_token, "shared-key")[0]["status"] == "submitted"
    print("ok - exact Worker key lookup finds durable and trashed Reports without exposing another Worker's Report")


def test_lookup_rejects_invalid_keys_and_non_report_access(server):
    worker, token = new_worker(server, "validation")
    for key in ("", " ", " padded", "trailing ", "x" * 121, "embedded\x00control", "newline\nkey"):
        _, headers = lookup(server, token, key, 400)
        assert headers.get("Cache-Control") == "private, no-store"
    for purpose in ("daywork", "REPORT", " report ", ""):
        lookup(server, token, "valid-key", 400, purpose=purpose)
    for path in ("/my-form-submissions/by-client-id?client_submission_id=valid-key",
                 "/my-form-submissions/by-client-id?purpose=report"):
        _, headers = server.expect("GET", path, None, 422, token)
        assert headers.get("Cache-Control") == "private, no-store"
    for rejected_token, status in ((None, 401), (server.supervisor, 403)):
        _, headers = lookup(server, rejected_token, "valid-key", status)
        assert headers.get("Cache-Control") == "private, no-store"
    prefixed, headers = server.expect("GET", "/api/my-form-submissions/by-client-id?" + urlencode({
        "client_submission_id": "valid-key", "purpose": "report",
    }), None, 200, token)
    assert prefixed["status"] == "not_found" and headers.get("Cache-Control") == "private, no-store"
    server.expect("POST", f'/supervisor/users/{worker["id"]}/status', {
        "confirmed": True, "status": "resigned",
    }, 200, server.supervisor)
    lookup(server, token, "valid-key", 403)
    print("ok - exact lookup validates Report purpose and stable key; auth, role and validation errors cannot cache")


def test_daywork_key_collision_fails_closed(server):
    _, token = new_worker(server, "daywork-leader", worker_class="leader")
    template = new_template(server, "Retained Daywork collision fixture")
    with closing(sqlite3.connect(server.database_path)) as connection:
        connection.execute("UPDATE workform SET template_purpose = 'daywork' WHERE id = ?", (template["id"],))
        connection.commit()
    report, _ = server.expect("POST", "/form-submissions", report_payload(template, "daywork-collision"), 200, token)
    assert report["submission_purpose"] == "daywork"
    result, headers = lookup(server, token, "daywork-collision", 409)
    assert result["detail"]["code"] == "report_recovery_key_conflict"
    assert "submission" not in result and headers.get("Cache-Control") == "private, no-store"
    print("ok - an exact Daywork key collision cannot authorize Report recovery or expose Daywork content")


def trash_and_expire(server, report):
    server.expect("POST", f'/supervisor/trash/form/{report["id"]}', {
        "confirmed": True, "reason": "Owned expired recovery fixture",
    }, 200, server.supervisor)
    # Expire only this owned fixture, then exercise the ordinary purge boundary.
    with closing(sqlite3.connect(server.database_path)) as connection:
        connection.execute("UPDATE workformsubmission SET deleted_at = '2000-01-01 00:00:00' WHERE id = ?",
                           (report["id"],))
        connection.commit()
    rows, _ = server.expect("GET", "/supervisor/trash", None, 200, server.supervisor)
    assert all(row["id"] != report["id"] or row["record_type"] != "form" for row in rows)


def test_purged_report_is_not_recovered_or_recreated(server):
    worker, token = new_worker(server, "purged-owner")
    _, other_token = new_worker(server, "purged-other")
    template = new_template(server, "Purged Report fixture")
    key = 'purged-"key\\with-percent%'
    payload = report_payload(template, key)
    report, _ = server.expect("POST", "/form-submissions", payload, 200, token)
    trash_and_expire(server, report)
    found, _ = lookup(server, token, key)
    assert found == {"status": "deleted", "client_submission_id": key, "submission": None,
                     "worker_id": worker["id"], "department_id": worker["department_id"]}
    assert lookup(server, other_token, key)[0]["status"] == "not_found"
    rejected, _ = server.expect("POST", "/form-submissions", payload, 409, token)
    assert rejected["detail"]["code"] == "report_previously_submitted"
    assert "submission" not in rejected and "worker_id" not in rejected["detail"]
    history, _ = server.expect("GET", "/my-form-submissions?purpose=report", None, 200, token)
    assert history == [], "An expired Report must not be recreated with its original key"
    server.expect("POST", "/form-submissions", payload, 200, other_token)
    server.expect("POST", "/form-submissions", report_payload(template, "different-key"), 200, token)
    print("ok - retained trash evidence blocks purged Report recovery and same-key recreation without blocking other Workers")


def test_idempotent_post_identifies_existing_immutable_winner(server):
    _, token = new_worker(server, "idempotent-owner")
    template = new_template(server, "Recovered same-key Report fixture")
    payload = report_payload(template, "retained-recovery-key")
    original, _ = server.expect("POST", "/form-submissions", payload, 200, token)
    assert original["idempotent_replay"] is False
    replay, _ = server.expect("POST", "/form-submissions", {
        **payload, "answers": {"detail": "Recovered edit must not overwrite an in-flight winner"},
    }, 200, token)
    assert replay["idempotent_replay"] is True and replay["id"] == original["id"]
    assert replay["answers"] == original["answers"]
    assert "idempotent_replay" not in lookup(server, token, payload["client_submission_id"])[0]["submission"]
    server.expect("PATCH", f'/supervisor/work-forms/{template["id"]}', {
        "confirmed": True, "status": "archived",
    }, 200, server.supervisor)
    archived_replay, _ = server.expect("POST", "/form-submissions", payload, 200, token)
    assert archived_replay == replay
    print("ok - POST identifies the existing immutable winner without persisting replay metadata or requiring an active Template")


def test_concurrent_recovered_posts_keep_one_report(server):
    _, token = new_worker(server, "concurrent-owner")
    template = new_template(server, "Concurrent recovered Report fixture")
    barrier = Barrier(2)

    def submit(detail):
        barrier.wait(timeout=10)
        return server.expect("POST", "/form-submissions", report_payload(template, "race-key", detail), 200, token)[0]

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(submit, ("Old in-flight contents", "Recovered draft contents")))
    assert results[0]["id"] == results[1]["id"] and results[0]["answers"] == results[1]["answers"]
    assert sorted(result["idempotent_replay"] for result in results) == [False, True]
    reports, _ = server.expect("GET", "/my-form-submissions?purpose=report", None, 200, token)
    assert len(reports) == 1 and reports[0]["client_submission_id"] == "race-key"
    assert "idempotent_replay" not in reports[0]
    print("ok - concurrent old/recovered payloads with the same key create one Report and identify the winning snapshot")


def test_retained_daywork_replay_and_purge_policy_are_unchanged(server):
    _, token = new_worker(server, "purged-daywork-owner", worker_class="leader")
    template = new_template(server, "Purged Daywork fixture")
    with closing(sqlite3.connect(server.database_path)) as connection:
        connection.execute("UPDATE workform SET template_purpose = 'daywork' WHERE id = ?", (template["id"],))
        connection.commit()
    payload = report_payload(template, "purged-daywork-key")
    original, _ = server.expect("POST", "/form-submissions", payload, 200, token)
    replay, _ = server.expect("POST", "/form-submissions", payload, 200, token)
    assert original == replay and "idempotent_replay" not in replay
    trash_and_expire(server, original)
    result, _ = lookup(server, token, "purged-daywork-key", 409)
    assert result["detail"]["code"] == "report_recovery_key_conflict"
    retained, _ = server.expect("POST", "/form-submissions", payload, 200, token)
    assert retained["submission_purpose"] == "daywork" and "idempotent_replay" not in retained
    print("ok - retained Daywork keeps its existing replay and post-purge policy while Report recovery rejects its key")


def test_retained_audit_before_snapshot_and_unknown_purpose_fail_closed(server):
    _, token = new_worker(server, "audit-owner")
    template = new_template(server, "Audit fallback fixture")
    for key in ("before-snapshot-key", "unknown-historical-purpose"):
        payload = report_payload(template, key)
        original, _ = server.expect("POST", "/form-submissions", payload, 200, token)
        trash_and_expire(server, original)
        with closing(sqlite3.connect(server.database_path)) as connection:
            event_id, raw = connection.execute(
                "SELECT id, before_json FROM auditevent WHERE entity_type = 'form' AND action = 'form_trash' "
                "AND entity_id = ? ORDER BY id DESC LIMIT 1", (original["id"],),
            ).fetchone()
            snapshot = json.loads(raw)
            if key == "unknown-historical-purpose":
                snapshot.pop("submission_purpose")
            connection.execute("UPDATE auditevent SET after_json = NULL, before_json = ? WHERE id = ?",
                               (json.dumps(snapshot), event_id))
            connection.commit()
        if key == "before-snapshot-key":
            assert lookup(server, token, key)[0]["status"] == "deleted"
            rejected, _ = server.expect("POST", "/form-submissions", payload, 409, token)
            assert rejected["detail"]["code"] == "report_previously_submitted"
        else:
            assert lookup(server, token, key, 409)[0]["detail"]["code"] == "report_recovery_key_conflict"
            assert server.expect("POST", "/form-submissions", payload, 409, token)[0]["detail"]["code"] == "report_recovery_key_conflict"
    print("ok - retained before snapshots prevent recreation; ambiguous historical purpose cannot authorize Report recovery")


def test_recovered_post_checks_cookie_identity_before_create_or_replay(server):
    owner, token = new_worker(server, "guarded-owner")
    other, other_token = new_worker(server, "guarded-other")
    template = new_template(server, "Cookie identity guard fixture")
    payload = report_payload(template, "guarded-key")
    # A shared browser cookie may have changed while local identity still says
    # owner. The lookup exposes who actually answered even when no key exists.
    found, _ = server.expect("GET", "/my-form-submissions/by-client-id?" + urlencode({
        "client_submission_id": payload["client_submission_id"], "purpose": "report",
    }), None, 200, headers=cookie_headers(server, other_token))
    assert found["worker_id"] == other["id"] and found["department_id"] == other["department_id"]
    for headers in (
        {**cookie_headers(server, other_token), **recovery_headers(owner)},
        {**cookie_headers(server, token), **recovery_headers(owner), "X-Report-Recovery-Department": "2"},
        {**cookie_headers(server, token), "X-Report-Recovery-Worker": str(owner["id"])},
        {**cookie_headers(server, token), "X-Report-Recovery-Department": str(owner["department_id"])},
    ):
        body, _ = server.expect("POST", "/form-submissions", payload, 409, headers=headers)
        assert body["detail"]["code"] == "report_recovery_identity_mismatch"
    for actor_token in (token, other_token):
        reports, _ = server.expect("GET", "/my-form-submissions?purpose=report", None, 200, actor_token)
        assert reports == [], "A recovery identity mismatch must not create a Report for either Worker"
    matched, _ = server.expect("POST", "/form-submissions", payload, 200,
                               headers={**cookie_headers(server, token), **recovery_headers(owner)})
    assert matched["worker_id"] == owner["id"] and matched["idempotent_replay"] is False
    rejected, _ = server.expect("POST", "/form-submissions", payload, 409, token,
                                headers={**recovery_headers(owner), "X-Report-Recovery-Worker": str(other["id"])})
    assert rejected["detail"]["code"] == "report_recovery_identity_mismatch"
    replay, _ = server.expect("POST", "/form-submissions", payload, 200, token, headers=recovery_headers(owner))
    assert replay["id"] == matched["id"] and replay["idempotent_replay"] is True
    print("ok - recovered POST binds actual cookie Worker and Department before creating or returning an idempotent Report")


def test_recovered_photo_checks_cookie_identity_before_storage(server):
    owner, token = new_worker(server, "upload-guarded-owner")
    other, other_token = new_worker(server, "upload-guarded-other")
    upload_dir = Path(server.environment["UPLOAD_DIR"])
    before = set(upload_dir.glob("*"))
    for headers in (
        {**cookie_headers(server, other_token), **recovery_headers(owner)},
        {**cookie_headers(server, token), **recovery_headers(owner), "X-Report-Recovery-Department": "2"},
        {**cookie_headers(server, token), "X-Report-Recovery-Worker": str(owner["id"])},
    ):
        status, body = upload_photo(server, headers)
        assert status == 409 and body["detail"]["code"] == "report_recovery_identity_mismatch"
        assert set(upload_dir.glob("*")) == before, "Mismatched recovery must not write image bytes or upload metadata"
    status, body = upload_photo(server, {**cookie_headers(server, token), **recovery_headers(owner)})
    assert status == 200 and body["uploaded_by"] == owner["id"]
    # Existing callers that do not opt into recovered scope are unchanged.
    status, body = upload_photo(server, {}, other_token)
    assert status == 200 and body["uploaded_by"] == other["id"]
    print("ok - recovered photo/signature upload binds actual cookie identity before storage; unscoped uploads remain compatible")


if __name__ == "__main__":
    with InvitationServer() as server:
        test_absence_is_explicit_read_only_and_uncached(server)
        test_lookup_finds_only_exact_owner_including_deleted_reports(server)
        test_lookup_rejects_invalid_keys_and_non_report_access(server)
        test_daywork_key_collision_fails_closed(server)
        test_purged_report_is_not_recovered_or_recreated(server)
        test_idempotent_post_identifies_existing_immutable_winner(server)
        test_concurrent_recovered_posts_keep_one_report(server)
        test_retained_daywork_replay_and_purge_policy_are_unchanged(server)
        test_retained_audit_before_snapshot_and_unknown_purpose_fail_closed(server)
        test_recovered_post_checks_cookie_identity_before_create_or_replay(server)
        test_recovered_photo_checks_cookie_identity_before_storage(server)
