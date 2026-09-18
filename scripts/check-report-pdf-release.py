"""Read-only PDF deployment checks against exact owned presentation Reports.

Only login/logout write requests are allowed. No database or fixture mutations.
Credentials are decrypted in memory, never persisted or printed.
"""
import argparse
import hashlib
import http.cookiejar
import importlib.util
import io
import json
from pathlib import Path
import re
import sys
from datetime import datetime, timezone
from urllib.error import HTTPError
from urllib.parse import unquote, urlsplit
from urllib.request import Request, build_opener, HTTPCookieProcessor

from PIL import Image
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
LIVE = "https://geo-attendance-system-db9ca.web.app"
CANDIDATE = "https://pdf-20260916-0010---geo-backend-eitdijn7cq-ts.a.run.app"
BASE = ROOT / "docs/evidence/report-pdf-release-20260916"
spec = importlib.util.spec_from_file_location("demo", ROOT / "scripts/presentation-demo-live.py")
demo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo)


def require(value, code):
    if not value:
        raise RuntimeError(code)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def json_digest(value):
    return digest(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())


def candidate_origin(value):
    require(bool(re.fullmatch(r"https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?---geo-backend-eitdijn7cq-ts\.a\.run\.app", value)),
            "exact_geo_backend_candidate_origin_required")
    return value


def owned_rows(rows, expected_ids, code):
    owned = {item["id"]: item for item in rows if item["id"] in expected_ids}
    require(set(owned) == set(expected_ids), code)
    return [owned[key] for key in sorted(owned)]


class Reader:
    def __init__(self, origin, candidate=CANDIDATE):
        require(origin in (LIVE, candidate_origin(candidate)), "exact_origin_required")
        self.origin = origin
        self.cookies = http.cookiejar.CookieJar()
        self.opener = build_opener(HTTPCookieProcessor(self.cookies), demo.NoRedirect())

    def request(self, path, body=None):
        require(path.startswith(("/api/", "/uploads/")) and ".." not in path, "safe_path_required")
        require(body is None or path in ("/api/auth/login", "/api/auth/logout"), "read_only_check_required")
        headers = {"Origin": self.origin, "Cache-Control": "no-store"}
        csrf = next((cookie.value for cookie in self.cookies if cookie.name == "geo_csrf_token"), None)
        if body is not None:
            headers["Content-Type"] = "application/json"
            if csrf:
                headers["X-CSRF-Token"] = unquote(csrf)
        try:
            with self.opener.open(Request(self.origin + path,
                    data=None if body is None else json.dumps(body).encode(), headers=headers), timeout=60) as response:
                return response.status, response.read(), {key.lower(): value for key, value in response.headers.items()}
        except HTTPError as error:
            return error.code, b"", {key.lower(): value for key, value in error.headers.items()}

    def get(self, path):
        status, content, headers = self.request(path)
        require(status == 200, "read_request_failed_" + path.split("?")[0])
        return content, headers

    def json(self, path):
        return json.loads(self.get(path)[0])

    def login(self, credentials, expected):
        require(self.request("/api/auth/login", {"email": credentials["email"], "password": credentials["password"]})[0] == 200,
                "login_failed")
        me = self.json("/api/auth/me")
        require(me["id"] == expected["id"] and me["department_id"] == 2
                and me["role"] == expected["role"] and not me.get("is_global_admin"), "identity_scope_mismatch")

    def logout(self):
        self.request("/api/auth/logout", {})


def pixel_digest(image):
    image = image.convert("RGB")
    return digest(str(image.size).encode() + image.tobytes())


def expected_evidence_hashes(uploads, manifest):
    # Match actual source pixels or the exact bounded printable copy. Merely
    # counting image widths would miss swapped/missing photos after resizing.
    sys.path.insert(0, str(ROOT / "backend"))
    from app.use_cases.report_pdf import VALUE_WIDTH, _printable_raster
    expected = {}
    for item in manifest["uploads"]:
        original = uploads[item["path"]]
        signature = item["kind"] == "signature"
        printable, _, _ = _printable_raster(original, VALUE_WIDTH - 16,
                                            94 if signature else 215, lossless=signature)
        expected[item["path"]] = {pixel_digest(Image.open(io.BytesIO(value)))
                                  for value in (original, printable)}
    return expected


def evidence_paths(value):
    if isinstance(value, str):
        return {value} if value.startswith("/uploads/") else set()
    if isinstance(value, dict):
        return set().union(*(evidence_paths(item) for item in value.values()))
    if isinstance(value, list):
        return set().union(*(evidence_paths(item) for item in value))
    return set()


def embedded_image(asset):
    # pypdf's convenience image property saves JPEGs again, changing pixels.
    # Decode the PDF's actual DCT stream for exact exported-photo comparison.
    reference = asset.indirect_reference
    obj = reference.get_object() if reference is not None else None
    if obj is not None and "/DCTDecode" in str(obj.get("/Filter", "")):
        return Image.open(io.BytesIO(obj.get_data()))
    return asset.image


def check_pdf(content, reports, output, expected_images):
    require(content.startswith(b"%PDF-"), "invalid_pdf")
    reader = PdfReader(io.BytesIO(content))
    require(len(reader.pages) > 0, "empty_pdf")
    brand_hash = pixel_digest(Image.open(ROOT / "backend/app/assets/report-logos/mutual.png"))
    ids = set()
    evidence_images = 0
    report_images = {key: set() for key in reports}
    for index, page in enumerate(reader.pages, 1):
        text = page.extract_text()
        matches = set(map(int, re.findall(r"Report #(\d+)", text)))
        require(len(matches) == 1 and matches.issubset(reports), "incorrect_page_report_header")
        report_id = next(iter(matches))
        item = reports[report_id]
        ids.add(report_id)
        require("Mutual" in text and item["worker_email"] in text and item["form_name"] in text,
                "incorrect_brand_submitter_template")
        require(f"Version {item['definition_version']}" in text
                and f"Report Date {item['work_date']}" in text
                and f"Page {index} of {len(reader.pages)}" in text, "incorrect_footer")
        require("unavailable" not in text.lower(), "missing_evidence")
        images = [embedded_image(image) for image in page.images]
        image_hashes = {pixel_digest(image) for image in images}
        require(brand_hash in image_hashes, "mutual_logo_pixels_mismatch")
        report_images[report_id].update(image_hashes - {brand_hash})
        evidence_images += sum(pixel_digest(image) != brand_hash for image in images)
        require(abs(float(page.mediabox.width) - 595.276) < 1 and abs(float(page.mediabox.height) - 841.89) < 1,
                "not_a4")
    require(ids == set(reports), "pdf_report_collection_mismatch")
    text = "\n".join(page.extract_text() for page in reader.pages)
    for item in reports.values():
        if item.get("supervisor_note"):
            require(" ".join(item["supervisor_note"].split()) in " ".join(text.split()), "final_note_missing")
        paths = evidence_paths(item.get("answers", {})) | set(item.get("photo_urls", []))
        require(bool(paths), "expected_report_evidence_missing")
        for path in paths:
            require(path in expected_images and bool(report_images[item["id"]] & expected_images[path]),
                    "photo_or_signature_pixels_missing")
    require(not output.exists(), "pdf_exists_do_not_overwrite")
    output.write_bytes(content)
    return {"path": str(output.relative_to(ROOT)).replace("\\", "/"), "sha256": digest(content),
            "pages": len(reader.pages), "reportIds": sorted(ids), "mutualLogoVerifiedEveryPage": True,
            "evidenceImageOccurrences": evidence_images, "eachPhotoAndSignaturePixelsVerified": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", choices=("baseline", "candidate", "live"), required=True)
    parser.add_argument("--candidate-origin", default=CANDIDATE)
    parser.add_argument("--evidence-dir", type=Path, default=BASE)
    args = parser.parse_args()
    candidate = candidate_origin(args.candidate_origin)
    base = args.evidence_dir.resolve()
    require(base.is_relative_to(ROOT / "docs/evidence"), "repository_evidence_directory_required")
    base.mkdir(parents=True, exist_ok=True)
    evidence_path = base / f"{args.phase}.json"
    require(not evidence_path.exists(), "evidence_exists_do_not_overwrite")
    manifest = json.loads((ROOT / "docs/evidence/presentation-demo-20260916.json").read_text())
    handoff = demo.read_private_handoff("demo-20260916")
    require(handoff["origin"] == LIVE and handoff["runId"] == manifest["runId"] == "demo-20260916",
            "private_handoff_scope_mismatch")
    origin = candidate if args.phase == "candidate" else LIVE
    evidence = {"phase": args.phase, "origin": origin, "status": "running", "startedAtUtc": datetime.now(timezone.utc).isoformat()}
    supervisor, worker, anonymous = (Reader(origin, candidate) for _ in range(3))
    try:
        for _ in range(3):
            ready = anonymous.json("/api/health/ready")
            require(ready["status"] == "ok" and all(ready["checks"][key] == "ok"
                for key in ("database", "migrations", "upload_storage")), "readiness_failed")
        evidence["readiness"] = ready
        for path in ("/api/sites", "/api/supervisor/form-submissions/5/export.pdf"):
            require(anonymous.request(path)[0] in (401, 403), "anonymous_not_denied")
        supervisor.login(handoff["accounts"]["supervisor"], manifest["accounts"]["supervisor"])
        reports = supervisor.json("/api/supervisor/form-submissions?purpose=report")
        reports = owned_rows(reports, {item["id"] for item in manifest["reports"].values()}, "owned_reports_changed")
        own = {item["id"]: item for item in reports}
        evidence["reportDataSha256"] = json_digest(reports)
        templates = owned_rows(supervisor.json("/api/work-forms?purpose=report"),
                               {item["id"] for item in manifest["templates"].values()}, "owned_templates_changed")
        evidence["templateDataSha256"] = json_digest(templates)
        evidence["exactOwnedIds"] = {"reports": sorted(own), "templates": [item["id"] for item in templates]}
        evidence["nonPdfExportHashes"] = {}
        evidence["exportCacheControls"] = {}
        for extension in ("csv", "html"):
            for key, path in (("collection", f"/api/supervisor/form-submissions/export.{extension}?purpose=report&search=demo-20260916"),
                              ("single", f"/api/supervisor/form-submissions/5/export.{extension}")):
                content, headers = supervisor.get(path)
                evidence["nonPdfExportHashes"][key + "_" + extension] = digest(content)
                cache_policy = headers.get("cache-control", "")
                evidence["exportCacheControls"][key + "_" + extension] = cache_policy
                # Existing backend has no export cache header; Hosting adds private.
                # Preserve that contract rather than inventing a no-store requirement.
                require(cache_policy == ("" if args.phase == "candidate" else "private"), "export_cache_policy_changed")
        uploads = {item["path"]: supervisor.get(item["path"])[0] for item in manifest["uploads"]}
        evidence["uploadHashes"] = {path: digest(content) for path, content in uploads.items()}
        worker.login(handoff["accounts"]["alex"], manifest["accounts"]["alex"])
        history = worker.json("/api/my-form-submissions?purpose=report")
        worker_id = manifest["accounts"]["alex"]["id"]
        require(all(item["worker_id"] == worker_id for item in history), "worker_isolation_failed")
        owned_rows(history, {item["id"] for item in manifest["reports"].values() if item["workerKey"] == "alex"},
                   "owned_worker_reports_missing")
        require(worker.request("/api/supervisor/form-submissions/5/export.pdf")[0] in (401, 403), "worker_export_not_denied")
        evidence["accessScopeAndExistingCachePolicy"] = "passed"
        if args.phase != "baseline":
            baseline = json.loads((base / "baseline.json").read_text())
            for key in ("reportDataSha256", "templateDataSha256", "nonPdfExportHashes", "uploadHashes"):
                require(evidence[key] == baseline[key], "baseline_changed_" + key)
            if args.phase == "live":
                require(evidence["exportCacheControls"] == baseline["exportCacheControls"], "hosted_cache_policy_changed")
            evidence["existingDemoDataAndCsvHtmlUnchanged"] = True
            output = ROOT / "output/pdf" / f"{base.name}-{args.phase}.local"
            require(not output.exists(), "pdf_directory_exists_do_not_overwrite")
            output.mkdir(parents=True, exist_ok=True)
            expected_images = expected_evidence_hashes(uploads, manifest)
            evidence["pdfs"] = []
            for name, path, expected in (
                ("mutual-toolbox-talk", "/api/supervisor/form-submissions/5/export.pdf", {5: own[5]}),
                ("mutual-demo-collection", "/api/supervisor/form-submissions/export.pdf?purpose=report&search=demo-20260916", own),
            ):
                content, headers = supervisor.get(path)
                require("application/pdf" in headers.get("content-type", "")
                    and headers.get("cache-control", "") == ("" if args.phase == "candidate" else "private"),
                    "pdf_headers_invalid")
                evidence["pdfs"].append(check_pdf(content, expected, output / f"{name}.pdf", expected_images))
        evidence["status"] = "passed"
    except Exception as error:
        evidence["status"] = "failed"
        evidence["safeFailure"] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        raise
    finally:
        for client in (supervisor, worker):
            try:
                client.logout()
            except Exception:
                pass
        evidence["completedAtUtc"] = datetime.now(timezone.utc).isoformat()
        evidence_path.write_text(json.dumps(evidence, indent=2) + "\n")
        print(json.dumps({"phase": args.phase, "status": evidence["status"], "failure": evidence.get("safeFailure"),
                          "pdfs": evidence.get("pdfs")}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(1)
