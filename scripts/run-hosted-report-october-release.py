"""Run opt-in October hosted checks using only the private demo Supervisor.

The browser runner owns its nonce fixtures and exact-owned finally cleanup.
Existing identities are never reset or deactivated by this wrapper. Credentials
stay in memory and the child environment, never shell arguments or output.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
SAFE_FAILURES = frozenset({
    "https_origin_only_required", "exact_live_or_project_preview_required", "canonical_host_required",
    "repository_evidence_subdirectory_required", "evidence_directory_already_exists",
    "relative_evidence_subdirectory_required", "invalid_run_id", "node_runtime_required",
    "demo_handoff_scope_mismatch", "exact_demo_supervisor_required",
})


def module_at(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def child_environment(helper, origin, directory, manifest, handoff):
    helper.require(manifest["runId"] == handoff["runId"] == helper.DEMO_RUN_ID
                   and manifest["origin"] == handoff["origin"] == helper.LIVE
                   and manifest["departmentId"] == 2, "demo_handoff_scope_mismatch")
    # Do not call the three-account child_environment helper: this run only
    # needs Supervisor 16, and must never inspect or pass Worker credentials.
    expected = manifest["accounts"]["supervisor"]
    credentials = handoff["accounts"]["supervisor"]
    helper.require(expected["id"] == 16 and expected["departmentId"] == 2
                   and expected["role"] == "supervisor" and not expected.get("isGlobalAdmin")
                   and credentials["email"] == expected["email"]
                   and isinstance(credentials["password"], str) and len(credentials["password"]) >= 8,
                   "exact_demo_supervisor_required")
    env = {key: value for key, value in os.environ.items()
           if not key.upper().startswith(("HOSTED_", "PG"))
           and key.upper() not in ("NODE_OPTIONS", "NODE_DEBUG", "DEBUG", "PWDEBUG")}
    env.update({"DEBUG": "", "NODE_DEBUG": "", "PWDEBUG": "0",
                "HOSTED_OCTOBER_ORIGIN": origin,
                "HOSTED_OCTOBER_EVIDENCE_DIR": str(directory),
                "HOSTED_REPORT_ALLOWED_HOST": urlsplit(origin).netloc,
                "HOSTED_OCTOBER_SUPERVISOR_EMAIL": credentials["email"],
                "HOSTED_OCTOBER_SUPERVISOR_PASSWORD": credentials["password"]})
    return env


def runner_summary(result, directory, run_id, origin):
    proof_path = directory / "evidence.json"
    try:
        proof = json.loads(proof_path.read_text(encoding="utf-8")) if proof_path.exists() else {}
    except (ValueError, OSError):
        proof = {}
    if not isinstance(proof, dict):
        proof = {}
    checks = proof.get("checks")
    cleanup = proof.get("cleanup")
    failures = cleanup.get("failures") if isinstance(cleanup, dict) else None
    passed = (result.returncode == 0 and proof.get("schemaVersion") == 1
              and proof.get("runId") == run_id and proof.get("origin") == origin
              and proof.get("status") == "passed" and isinstance(checks, list)
              and isinstance(failures, list) and not failures)
    # Only bounded metadata/counts escape. Never echo raw child output, evidence
    # diagnostics, request bodies, page text, tokens or fixture credentials.
    return {"runId": run_id, "origin": origin, "status": "passed" if passed else "failed",
            "runnerExitCode": result.returncode,
            "checkpoints": len(checks) if isinstance(checks, list) else 0,
            "cleanupFailures": len(failures) if isinstance(failures, list) else None,
            "evidence": proof_path.relative_to(ROOT).as_posix(),
            "evidenceText": (directory / "evidence.txt").relative_to(ROOT).as_posix()}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--evidence-subdir", required=True, type=Path,
                        help="New relative directory beneath docs/evidence; nested paths are allowed")
    args = parser.parse_args(argv)
    helper = module_at("hosted_report_release", ROOT / "scripts/run-hosted-report-release.py")
    origin = helper.approved_origin(args.origin)
    helper.require(not args.evidence_subdir.is_absolute(), "relative_evidence_subdirectory_required")
    directory = helper.evidence_directory(ROOT / "docs/evidence" / args.evidence_subdir)
    helper.require(bool(re.fullmatch(r"[a-z0-9][a-z0-9_-]{3,39}", args.run_id)), "invalid_run_id")
    node = shutil.which("node")
    helper.require(node is not None, "node_runtime_required")
    manifest = json.loads((ROOT / f"docs/evidence/presentation-{helper.DEMO_RUN_ID}.json").read_text(encoding="utf-8"))
    demo = module_at("presentation_demo", ROOT / "scripts/presentation-demo-live.py")
    handoff = demo.read_private_handoff(helper.DEMO_RUN_ID)
    env = child_environment(helper, origin, directory, manifest, handoff)
    result = subprocess.run(
        [node, str(ROOT / "scripts/check-hosted-report-october-release.mjs"),
         "--allow-hosted-mutations", "--run-id", args.run_id],
        cwd=ROOT, env=env, stdin=subprocess.DEVNULL, capture_output=True,
        text=True, encoding="utf-8", errors="replace", check=False,
    )
    # No outer timeout: let the runner finish exact-owned finally cleanup and
    # publish its evidence even after an individual browser operation fails.
    summary = runner_summary(result, directory, args.run_id, origin)
    print(json.dumps(summary))
    return 0 if summary["status"] == "passed" else 1


def cli(argv=None):
    try:
        return main(argv)
    except Exception as error:
        # Arbitrary RuntimeError messages can also contain secrets. Only this
        # fixed allowlist of local validation codes may appear in the summary.
        code = str(error) if isinstance(error, RuntimeError) and str(error) in SAFE_FAILURES else "configuration_or_runner_failure"
        print(json.dumps({"status": "refused", "safeFailure": code}))
        return 1


if __name__ == "__main__":
    sys.exit(cli())
