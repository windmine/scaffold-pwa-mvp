"""Read-only, sanitized Cloud Run proof for an explicitly named Report release."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
PROJECT = "geo-attendance-system-db9ca"
REGION = "australia-southeast1"


def require(value, code):
    if not value:
        raise RuntimeError(code)


def cloud(*args):
    result = subprocess.run([shutil.which("gcloud"), *args, "--project", PROJECT,
        "--format=json", "--quiet"], capture_output=True, encoding="utf-8",
        env={**os.environ, "DEBUG": "", "CLOUDSDK_CORE_LOG_HTTP": "false"}, timeout=90)
    require(result.returncode == 0, "cloud_read_failed")
    return json.loads(result.stdout)


def runtime_config(spec):
    result = copy.deepcopy(spec)
    for container in result["containers"]:
        container.pop("image", None)
        container.pop("name", None)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", choices=("candidate", "live"), required=True)
    parser.add_argument("--previous", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--build", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    require(not args.evidence.exists(), "new_evidence_required")
    require(all(re.fullmatch(r"geo-backend-[a-z0-9-]+", value)
        for value in (args.previous, args.revision)), "exact_revision_names_required")
    require(re.fullmatch(r"[0-9a-f]{40}", args.source_commit), "full_source_commit_required")
    old = cloud("run", "revisions", "describe", args.previous, "--region", REGION)
    new = cloud("run", "revisions", "describe", args.revision, "--region", REGION)
    service = cloud("run", "services", "describe", "geo-backend", "--region", REGION)
    build = cloud("builds", "describe", args.build, "--region", REGION)
    require(runtime_config(old["spec"]) == runtime_config(new["spec"]), "runtime_configuration_changed")
    require(build["status"] == "SUCCESS", "build_not_successful")
    image = new["status"]["imageDigest"]
    require(image.startswith(f"{REGION}-docker.pkg.dev/{PROJECT}/cloud-run-source-deploy/geo-backend@sha256:"),
        "unexpected_image_repository")
    require(any(item["digest"] == image.split("@", 1)[1]
        for item in build["results"]["images"]), "build_revision_image_mismatch")
    require(any(item["type"] == "Ready" and item["status"] == "True"
        for item in new["status"]["conditions"]), "revision_not_ready")
    traffic = service["status"]["traffic"]
    serving = [item for item in traffic if item.get("percent", 0)]
    expected = args.previous if args.phase == "candidate" else args.revision
    require(len(serving) == 1 and serving[0]["revisionName"] == expected
        and serving[0]["percent"] == 100, "unexpected_serving_traffic")
    require(args.phase != "live" or not any(item.get("tag") for item in traffic), "temporary_tag_remaining")
    entries = cloud("logging", "read",
        f'resource.type="cloud_run_revision" AND resource.labels.service_name="geo-backend" '
        f'AND resource.labels.revision_name="{args.revision}"', "--freshness=1d", "--limit=10000")
    require(len(entries) < 10000, "log_window_truncated")
    errors = [item for item in entries if item.get("severity") in ("ERROR", "CRITICAL", "ALERT", "EMERGENCY")
        or int(item.get("httpRequest", {}).get("status", 0)) >= 500]
    require(not errors, "revision_error_or_5xx_logs_present")
    ledger = {path.stem: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted((ROOT / "backend/migrations/versions").glob("[0-9]*.py"))}
    proof = {"status": "passed", "phase": args.phase, "checkedAtUtc": datetime.now(timezone.utc).isoformat(),
        "sourceCommit": args.source_commit, "buildId": args.build, "image": image, "revision": args.revision,
        "previousRevision": args.previous, "runtimeConfigurationUnchanged": True, "migrationRequired": False,
        "localMigrationLedger": ledger, "traffic": traffic, "revisionLogEntries": len(entries),
        "errorOr5xxLogEntries": len(errors), "buildSource": build["source"]["storageSource"],
        "createdAtUtc": new["metadata"]["creationTimestamp"]}
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    with args.evidence.open("x", encoding="utf-8") as target:
        json.dump(proof, target, indent=2)
        target.write("\n")
    print(json.dumps({"status": "passed", "phase": args.phase, "revision": args.revision,
        "logEntries": len(entries), "errors": 0, "configurationUnchanged": True, "image": image}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"status": "failed", "code": str(error) if isinstance(error, RuntimeError)
            else type(error).__name__}))
        raise SystemExit(1)
