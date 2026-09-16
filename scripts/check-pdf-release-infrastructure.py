"""Capture sanitized, read-only infrastructure proof for the PDF-only release."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
from datetime import datetime, timezone
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "docs/evidence/report-pdf-release-20260916"
PROJECT = "geo-attendance-system-db9ca"
REGION = "australia-southeast1"
PREVIOUS = "geo-backend-report-20260915-0025"
REVISION = "geo-backend-pdf-20260916-0010"
BUILD = "50649bcc-9d50-455a-9df0-274bc296ab03"
IMAGE = "australia-southeast1-docker.pkg.dev/geo-attendance-system-db9ca/cloud-run-source-deploy/geo-backend@sha256:08edbc28d3dfca0922941619900c6c7102a7dd4dc825d56422a9437b7bfb82dc"
ENV = {**os.environ, "DEBUG": "", "CLOUDSDK_CORE_LOG_HTTP": "false"}


def require(value, code):
    if not value:
        raise RuntimeError(code)


def cloud(*args):
    result = subprocess.run([shutil.which("gcloud"), *args, "--project", PROJECT, "--format=json", "--quiet"],
        capture_output=True, encoding="utf-8", env=ENV, timeout=60)
    require(result.returncode == 0, "cloud_read_failed")
    return json.loads(result.stdout)


def config(spec):
    result = copy.deepcopy(spec)
    for container in result["containers"]:
        container.pop("image", None)
        container.pop("name", None)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", choices=("candidate", "live"), required=True)
    args = parser.parse_args()
    path = BASE / f"{args.phase}-infrastructure.json"
    require(not path.exists(), "evidence_exists")
    old = cloud("run", "revisions", "describe", PREVIOUS, "--region", REGION)
    candidate = cloud("run", "revisions", "describe", REVISION, "--region", REGION)
    service = cloud("run", "services", "describe", "geo-backend", "--region", REGION)
    build = cloud("builds", "describe", BUILD, "--region", REGION)
    require(config(old["spec"]) == config(candidate["spec"]), "runtime_configuration_changed")
    require(candidate["status"]["imageDigest"] == IMAGE and build["status"] == "SUCCESS", "artifact_mismatch")
    require(any(item["status"] == "True" and item["type"] == "Ready" for item in candidate["status"]["conditions"]),
            "candidate_not_ready")
    traffic = service["status"]["traffic"]
    serving = [item for item in traffic if item.get("percent", 0)]
    require(len(serving) == 1 and serving[0]["revisionName"] == (PREVIOUS if args.phase == "candidate" else REVISION)
        and serving[0]["percent"] == 100, "unexpected_serving_traffic")
    if args.phase == "live":
        require(not any(item.get("tag") for item in traffic), "temporary_tag_remaining")
    entries = cloud("logging", "read",
        f'resource.type="cloud_run_revision" AND resource.labels.service_name="geo-backend" AND resource.labels.revision_name="{REVISION}"',
        "--freshness=1d", "--limit=10000")
    require(len(entries) < 10000, "log_window_truncated")
    errors = [item for item in entries if item.get("severity") in ("ERROR", "CRITICAL", "ALERT", "EMERGENCY")
              or int(item.get("httpRequest", {}).get("status", 0)) >= 500]
    require(not errors, "revision_error_logs_present")
    shell = {}
    for asset in ("index.html", "sw.js", "manifest.webmanifest", "offline.html"):
        with urlopen(f"https://{PROJECT}.web.app/{asset}", timeout=30) as response:
            shell[asset] = hashlib.sha256(response.read()).hexdigest()
    if args.phase == "live":
        baseline = json.loads((BASE / "candidate-infrastructure.json").read_text())
        require(shell == baseline["hostedShellHashes"], "hosting_shell_changed")
    result = {"status": "passed", "phase": args.phase, "checkedAtUtc": datetime.now(timezone.utc).isoformat(),
        "backendSourceCommit": "7ad0f888ce3fc7a6fa5211044cdd9f14a4065661",
        "buildId": BUILD, "image": IMAGE, "revision": REVISION, "previousCompatibleRevision": PREVIOUS,
        "runtimeConfigurationUnchanged": True, "migrationRequired": False, "hostingPromotionPerformed": False,
        "traffic": traffic, "revisionLogEntries": len(entries), "errorOr5xxLogEntries": len(errors),
        "hostedShellHashes": shell, "buildSource": build["source"]["storageSource"],
        "candidateCreatedAtUtc": candidate["metadata"]["creationTimestamp"],
        "routesReadyAtUtc": next(item["lastTransitionTime"] for item in service["status"]["conditions"]
                                if item["type"] == "RoutesReady")}
    path.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"status": "passed", "phase": args.phase, "serving": serving,
                     "logEntries": len(entries), "errors": 0, "configurationUnchanged": True}))


if __name__ == "__main__":
    main()
