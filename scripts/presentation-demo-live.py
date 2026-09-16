"""Create explicitly authorized, owned presentation records on the live app.

No deployment, migrations, existing-account reuse or bulk seed. Only the new
operator-controlled demo accounts are bootstrapped in SQL; Reports, Sites,
Templates, uploads and review transitions use their authenticated public APIs.
Credentials are never logged; the local handoff is Windows-user DPAPI encrypted.
"""
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import http.cookiejar
import io
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from urllib.parse import parse_qs, unquote, urlsplit
from urllib.request import Request, build_opener, HTTPCookieProcessor, HTTPRedirectHandler
from urllib.error import HTTPError
from zoneinfo import ZoneInfo

import bcrypt
import psycopg
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
PROJECT = "geo-attendance-system-db9ca"
ORIGIN = f"https://{PROJECT}.web.app"
REGION = "australia-southeast1"
REVISION = "geo-backend-report-20260915-0025"
ENV = {key: value for key, value in os.environ.items() if not key.upper().startswith("PG")}
ENV["DEBUG"] = ""
ENV["CLOUDSDK_CORE_LOG_HTTP"] = "false"
for inherited_key in list(os.environ):
    if inherited_key.upper().startswith("PG"):
        os.environ.pop(inherited_key)


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def command(args, data=None):
    result = subprocess.run([shutil.which(args[0]) or args[0], *args[1:]],
                            input=data, text=True, capture_output=True, cwd=ROOT,
                            env=ENV, encoding="utf-8", errors="replace", timeout=60)
    require(result.returncode == 0, "protected_command_failed")
    return result.stdout.strip()


def live_connection():
    result = json.loads(command([
        "gcloud", "run", "services", "describe", "geo-backend", "--project", PROJECT,
        "--region", REGION, "--format=json", "--quiet",
    ]))
    traffic = result["status"]["traffic"]
    require(len(traffic) == 1 and traffic[0].get("revisionName") == REVISION
            and traffic[0].get("percent") == 100, "serving_revision_changed")
    variables = result["spec"]["template"]["spec"]["containers"][0]["env"]
    reference = next(value for value in variables if value["name"] == "DATABASE_URL")["valueFrom"]["secretKeyRef"]
    require(reference == {"name": "geo-backend-database-url", "key": "2"}, "database_binding_changed")
    url = command(["gcloud", "secrets", "versions", "access", "2", "--secret",
                   "geo-backend-database-url", "--project", PROJECT, "--quiet"])
    url = url.replace("postgresql+psycopg://", "postgresql://", 1)
    parsed = urlsplit(url)
    require(parsed.scheme == "postgresql" and parsed.hostname.endswith(".neon.tech")
            and unquote(parsed.path) == "/neondb" and parsed.username and parsed.password
            and not parsed.fragment and not (set(parse_qs(parsed.query)) - {"sslmode", "channel_binding"}),
            "unexpected_bound_database")
    return url


def verify_ledger(cursor):
    expected = {path.stem: hashlib.sha256(path.read_bytes()).hexdigest()
                for path in sorted((ROOT / "backend/migrations/versions").glob("[0-9]*.py"))}
    cursor.execute("SELECT version, checksum FROM schema_migrations ORDER BY version")
    require(dict(cursor.fetchall()) == expected, "exact_migration_ledger_required")
    cursor.execute("SET LOCAL statement_timeout = '20s'")
    cursor.execute("SET LOCAL lock_timeout = '5s'")


def existing_fingerprint(cursor, exclude_users=(), exclude_forms=(), exclude_reports=(), exclude_sites=()):
    """Hash existing data without persisting or printing its private contents."""
    result = {}
    for table, excluded in (("user", exclude_users), ("workform", exclude_forms),
                            ("workformsubmission", exclude_reports), ("site", exclude_sites)):
        cursor.execute(f'SELECT row_to_json(t) FROM "{table}" t WHERE NOT (id = ANY(%s)) ORDER BY id',
                       (list(excluded),))
        rows = [row[0] for row in cursor.fetchall()]
        result[table] = {"count": len(rows), "sha256": hashlib.sha256(
            json.dumps(rows, sort_keys=True, default=str).encode()).hexdigest()}
    return result


def inspect_database(url):
    with psycopg.connect(url, connect_timeout=20) as connection:
        connection.read_only = True
        with connection.cursor() as cursor:
            verify_ledger(cursor)
            cursor.execute("SELECT id FROM department WHERE name='Mutual' AND status='active'")
            departments = cursor.fetchall()
            require(len(departments) == 1, "one_active_mutual_department_required")
            department_id = departments[0][0]
            cursor.execute("SELECT count(*) FROM workformsubmission WHERE department_id=%s AND deleted_at IS NULL", (department_id,))
            count = cursor.fetchone()[0]
            return {"departmentId": department_id, "departmentName": "Mutual", "existingMutualReports": count,
                    "existing": existing_fingerprint(cursor)}


def encrypted_handoff(directory, value):
    require(os.name == "nt", "windows_private_handoff_required")
    require(not directory.exists() or not any(directory.iterdir()), "private_handoff_already_exists")
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / "credentials.dpapi"
    target.write_bytes(protect_private_bytes(json.dumps(value).encode()))
    require(target.stat().st_size > 100, "encrypted_handoff_failed")


def protect_private_bytes(value, decrypt=False):
    """Windows CurrentUser DPAPI, with no plaintext temp file or shell argument."""
    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]
    source = ctypes.create_string_buffer(value)
    blob = Blob(len(value), ctypes.cast(source, ctypes.POINTER(ctypes.c_ubyte)))
    result = Blob()
    crypt = ctypes.windll.crypt32
    if decrypt:
        success = crypt.CryptUnprotectData(ctypes.byref(blob), None, None, None, None, 1, ctypes.byref(result))
    else:
        success = crypt.CryptProtectData(ctypes.byref(blob), "ReportFlow presentation", None, None, None, 1, ctypes.byref(result))
    require(success, "windows_private_handoff_failed")
    try:
        return ctypes.string_at(result.data, result.size)
    finally:
        ctypes.windll.kernel32.LocalFree(ctypes.cast(result.data, ctypes.c_void_p))


def read_private_handoff(run_id):
    path = ROOT / f"output/presentation-{run_id}.local/credentials.dpapi"
    return json.loads(protect_private_bytes(path.read_bytes(), decrypt=True))


def provision_accounts(url, run_id, department_id, credentials):
    result = {}
    with psycopg.connect(url, connect_timeout=20) as connection:
        with connection.cursor() as cursor:
            verify_ledger(cursor)
            cursor.execute("SELECT name, status FROM department WHERE id=%s FOR SHARE", (department_id,))
            require(cursor.fetchone() == ("Mutual", "active"), "department_changed")
            for key, item in credentials.items():
                cursor.execute('SELECT id FROM "user" WHERE email=%s', (item["email"],))
                require(cursor.fetchone() is None, "demo_identity_already_exists_no_reuse")
                role = "supervisor" if key == "supervisor" else "worker"
                password_hash = bcrypt.hashpw(item["password"].encode(), bcrypt.gensalt()).decode()
                cursor.execute('''INSERT INTO "user" (department_id, dashboard_department_id,
                    email, name, password_hash, role, worker_class, status, is_global_admin,
                    password_setup_required, invitation_generation)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,'active',false,false,0) RETURNING id''',
                    (department_id, department_id, item["email"], item["name"], password_hash,
                     role, None if role == "supervisor" else "normal"))
                result[key] = {"id": cursor.fetchone()[0], "email": item["email"],
                               "name": item["name"], "role": role, "departmentId": department_id,
                               "isGlobalAdmin": False}
    return result


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("unexpected_api_redirect_refused")


class Client:
    def __init__(self):
        self.cookies = http.cookiejar.CookieJar()
        self.opener = build_opener(HTTPCookieProcessor(self.cookies), NoRedirect())

    def raw(self, path, method="GET", body=None, content_type="application/json"):
        require(path.startswith("/api/") or path.startswith("/uploads/"), "same_origin_path_required")
        headers = {"Accept": "application/json", "Origin": ORIGIN, "Cache-Control": "no-store"}
        if body is not None:
            headers["Content-Type"] = content_type
        csrf = next((cookie.value for cookie in self.cookies if cookie.name == "geo_csrf_token"), None)
        if csrf and method != "GET":
            headers["X-CSRF-Token"] = unquote(csrf)
        try:
            with self.opener.open(Request(ORIGIN + path, data=body, headers=headers, method=method), timeout=40) as response:
                require(urlsplit(response.url).netloc == urlsplit(ORIGIN).netloc, "redirect_left_host")
                return response.read(), response.headers.get("Content-Type", "")
        except HTTPError as error:
            # Response bodies can contain private capabilities; never echo them.
            raise RuntimeError(f"api_{method}_{path.split('?')[0]}_status_{error.code}") from None

    def api(self, path, method="GET", body=None):
        data, _ = self.raw(path, method, None if body is None else json.dumps(body).encode())
        return json.loads(data)

    def login(self, credentials, expected):
        self.api("/api/auth/login", "POST", {"email": credentials["email"], "password": credentials["password"]})
        me = self.api("/api/auth/me")
        require(me["id"] == expected["id"] and me["department_id"] == expected["departmentId"]
                and me["role"] == expected["role"] and not me.get("is_global_admin"), "demo_identity_mismatch")

    def upload(self, content, filename):
        boundary = "presentation" + secrets.token_hex(20)
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
                'Content-Type: image/png\r\n\r\n').encode() + content + f"\r\n--{boundary}--\r\n".encode()
        data, _ = self.raw("/api/photo-uploads", "POST", body, "multipart/form-data; boundary=" + boundary)
        return json.loads(data)


def demo_image(label, signature=False):
    image = Image.new("RGB", (960, 240 if signature else 540), "white" if signature else "#eef3f8")
    draw = ImageDraw.Draw(image)
    if signature:
        draw.line([(55, 130), (110, 70), (145, 165), (220, 100), (330, 130), (480, 85)], fill="#1955a0", width=5)
        draw.text((540, 75), "DEMO SIGNATURE", fill="#1955a0", font_size=29)
        draw.text((540, 128), "Presentation only", fill="#3c5267", font_size=24)
    else:
        draw.text((32, 25), "DEMO - SYNTHETIC PRESENTATION EVIDENCE", fill="#1955a0", font_size=30)
        for index, x in enumerate((95, 360, 625), start=1):
            draw.rounded_rectangle((x, 145, x + 205, 365), radius=12, fill="#d6e2ed", outline="#6d8499", width=5)
            draw.text((x + 24, 230), f"DEMO {index}", fill="#1955a0", font_size=26)
        draw.text((32, 435), label, fill="#3c5267", font_size=28)
        draw.text((32, 482), "Illustration only - not a real site photograph or safety certification.", fill="#3c5267", font_size=22)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def substitute(value, signature):
    if value == "__DEMO_SIGNATURE__":
        return signature
    if isinstance(value, list):
        return [substitute(item, signature) for item in value]
    if isinstance(value, dict):
        return {key: substitute(item, signature) for key, item in value.items()}
    return value


def dataset(run_id, day):
    code = "import {presentationDataset,WORKERS} from './scripts/presentation-demo-data.mjs'; console.log(JSON.stringify({...presentationDataset(process.argv[1],process.argv[2]),workers:WORKERS}));"
    return json.loads(command(["node", "--input-type=module", "-e", code, run_id, day]))


def create(run_id, url):
    evidence_path = ROOT / f"docs/evidence/presentation-{run_id}.json"
    private_dir = ROOT / f"output/presentation-{run_id}.local"
    require(not evidence_path.exists() and (not private_dir.exists() or not any(private_dir.iterdir())),
            "new_run_required_inspect_existing_instead")
    baseline = inspect_database(url)
    day = datetime.now(ZoneInfo("Pacific/Auckland")).date().isoformat()
    data = dataset(run_id, day)
    credentials = {item["key"]: {"name": item["name"], "email": f"{run_id}-{item['key']}@example.invalid",
                                "password": secrets.token_urlsafe(32)} for item in data["workers"]}
    credentials["supervisor"] = {"name": f"DEMO Presenter {run_id}", "email": f"{run_id}-supervisor@example.invalid",
                                 "password": secrets.token_urlsafe(32)}
    encrypted_handoff(private_dir, {"origin": ORIGIN, "runId": run_id, "accounts": credentials})
    evidence = {"schemaVersion": 1, "runId": run_id, "origin": ORIGIN, "status": "preparing",
                "anchorDate": day, "revisionUnchanged": REVISION, "departmentId": baseline["departmentId"],
                "baseline": baseline, "accounts": {}, "templates": {}, "sites": {}, "reports": {}, "uploads": [],
                "createdAtUtc": datetime.now(timezone.utc).isoformat(),
                "cleanup": "Not requested yet. Exact owned IDs only; trash Reports, archive Templates, resign accounts. Retain uploads/audit under normal retention. Demo Sites have no archive API; review their exact references before approved operator cleanup."}
    def save():
        temporary = evidence_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
        temporary.replace(evidence_path)
    save()
    clients = {}
    try:
        evidence["pending"] = {"kind": "account_batch", "planned": [
            {"key": key, "name": value["name"], "email": value["email"],
             "role": "supervisor" if key == "supervisor" else "worker", "departmentId": baseline["departmentId"]}
            for key, value in credentials.items()]}
        save()
        evidence["accounts"] = provision_accounts(url, run_id, baseline["departmentId"], credentials)
        evidence.pop("pending", None)
        save()
        for key, expected in evidence["accounts"].items():
            client = Client()
            client.login(credentials[key], expected)
            clients[key] = client
        supervisor = clients["supervisor"]
        require(supervisor.api("/api/health/ready")["status"] == "ok", "live_readiness_failed")
        for template in data["templates"]:
            evidence["pending"] = {"kind": "template", "name": template["name"]}
            save()
            created = supervisor.api("/api/supervisor/work-forms", "POST", {key: template[key] for key in ("name", "description", "fields")})
            require(created["template_purpose"] == "report", "wrong_template_purpose")
            evidence["templates"][template["key"]] = {"id": created["id"], "name": created["name"], "version": created["definition_version"]}
            evidence.pop("pending", None)
            save()
        for site in data["sites"]:
            evidence["pending"] = {"kind": "site", "name": site["name"]}
            save()
            created = supervisor.api("/api/supervisor/sites", "POST", {key: value for key, value in site.items() if key != "key"})
            evidence["sites"][site["key"]] = {"id": created["id"], "name": created["name"]}
            evidence.pop("pending", None)
            save()
        worker_uploads = {}
        for worker in data["workers"]:
            key = worker["key"]
            worker_uploads[key] = {}
            for kind in ("signature", "photo"):
                evidence["pending"] = {"kind": "upload", "workerId": evidence["accounts"][key]["id"],
                                       "evidenceKind": kind, "sourceFilename": f"{run_id}-{key}-{kind}.png",
                                       "startedAtUtc": datetime.now(timezone.utc).isoformat()}
                save()
                result = clients[key].upload(demo_image(worker["name"], kind == "signature"), f"{run_id}-{key}-{kind}.png")
                require(result["uploaded_by"] == evidence["accounts"][key]["id"], "upload_owner_mismatch")
                worker_uploads[key][kind] = result["url"]
                evidence["uploads"].append({"workerKey": key, "kind": kind, "path": result["url"]})
                evidence.pop("pending", None)
                save()
        for report in data["reports"]:
            worker_key = report["workerKey"]
            template = evidence["templates"][report["templateKey"]]
            client_id = f"{run_id}-{report['key']}"
            evidence["pending"] = {"kind": "report", "key": report["key"], "clientSubmissionId": client_id,
                                   "workerId": evidence["accounts"][worker_key]["id"]}
            save()
            body = {"form_id": template["id"], "expected_definition_version": template["version"],
                    "site_id": evidence["sites"][report["siteKey"]]["id"] if report["siteKey"] else None,
                    "work_date": report["workDate"], "client_submission_id": client_id,
                    "answers": substitute(report["answers"], worker_uploads[worker_key]["signature"]),
                    "photo_urls": [worker_uploads[worker_key]["photo"]] if report["includePhoto"] else [],
                    "photo_metadata": [{"name": "DEMO illustration - not a real site photo"}] if report["includePhoto"] else []}
            created = clients[worker_key].api("/api/form-submissions", "POST", body)
            require(created["worker_id"] == evidence["accounts"][worker_key]["id"]
                    and created["submission_purpose"] == "report" and created["workflow_status"] == "submitted", "report_owner_or_workflow_mismatch")
            owned = {"id": created["id"], "clientSubmissionId": client_id, "templateKey": report["templateKey"],
                     "workerKey": worker_key, "workDate": report["workDate"], "workflow": "submitted"}
            evidence["reports"][report["key"]] = owned
            evidence.pop("pending", None)
            save()
            if report["workflow"] != "submitted":
                supervisor.api(f"/api/supervisor/form-submissions/{created['id']}/transition", "POST", {"status": "in_review"})
                owned["workflow"] = "in_review"
                save()
            if report["workflow"] == "resolved":
                supervisor.api(f"/api/supervisor/form-submissions/{created['id']}/transition", "POST", {
                    "status": "resolved", "supervisor_note": report["finalNote"]})
                owned["workflow"] = "resolved"
                save()
        with psycopg.connect(url, connect_timeout=20) as connection:
            connection.read_only = True
            with connection.cursor() as cursor:
                verify_ledger(cursor)
                after = existing_fingerprint(cursor,
                    [value["id"] for value in evidence["accounts"].values()],
                    [value["id"] for value in evidence["templates"].values()],
                    [value["id"] for value in evidence["reports"].values()],
                    [value["id"] for value in evidence["sites"].values()])
                evidence["existingRecordsUnchanged"] = baseline["existing"] == after
                evidence["existingAfter"] = after
        require(evidence["existingRecordsUnchanged"], "existing_records_changed_review_concurrent_activity")
        ready = supervisor.api("/api/health/ready")
        require(ready["status"] == "ok", "post_create_readiness_failed")
        evidence["status"] = "created_awaiting_browser_verification"
        evidence["completedAtUtc"] = datetime.now(timezone.utc).isoformat()
        save()
        print(json.dumps({"status": evidence["status"], "department": "Mutual", "runId": run_id,
                          "reports": len(evidence["reports"]), "templates": len(evidence["templates"]),
                          "existingRecordsUnchanged": True, "evidence": str(evidence_path.relative_to(ROOT))}))
    except Exception as error:
        evidence["status"] = "incomplete_do_not_rerun"
        evidence["safeFailure"] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        save()
        raise
    finally:
        for client in clients.values():
            try:
                client.api("/api/auth/logout", "POST", {})
            except Exception:
                pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--action", choices=("inspect", "create"), default="inspect")
    parser.add_argument("--run-id", default="demo-20260916")
    parser.add_argument("--allow-live-presentation", action="store_true")
    args = parser.parse_args()
    require(re.fullmatch(r"demo-[0-9]{8}(?:-[a-z0-9]{1,10})?", args.run_id), "invalid_demo_run_id")
    require(args.action == "inspect" or args.allow_live_presentation, "explicit_live_write_flag_required")
    url = live_connection()
    if args.action == "inspect":
        result = inspect_database(url)
        print(json.dumps({"status": "ready", **result, "revision": REVISION}))
    else:
        create(args.run_id, url)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"status": "failed", "safeCode": str(error) if isinstance(error, RuntimeError) else type(error).__name__,
                          "note": "Credentials and private response bodies suppressed; inspect manifest before any retry."}))
        sys.exit(1)
