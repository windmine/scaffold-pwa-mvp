"""Run opt-in hosted Report checks with the existing private demo accounts.

Creates only the underlying runner's nonce-owned Report/Template/upload fixtures;
the runner records exact cleanup ownership and trashes/archives its own records.
Does not provision users, change infrastructure, or mutate presentation records.
DPAPI credentials stay in memory and the child environment, never shell arguments
or files. Child output is captured, not echoed; only sanitized evidence is shown.
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
PROJECT = "geo-attendance-system-db9ca"
LIVE = f"https://{PROJECT}.web.app"
DEMO_RUN_ID = "demo-20260916"
ACCOUNT_KEYS = {"SUPERVISOR": "supervisor", "WORKER": "alex", "SECOND_WORKER": "jamie"}


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def approved_origin(value):
    parsed = urlsplit(value)
    require(parsed.scheme == "https" and not parsed.username and not parsed.password
            and parsed.path in ("", "/") and not parsed.query and not parsed.fragment
            and parsed.port is None, "https_origin_only_required")
    host = parsed.hostname or ""
    require(host == f"{PROJECT}.web.app" or bool(re.fullmatch(
        rf"{re.escape(PROJECT)}--[a-z0-9](?:[a-z0-9-]{{0,100}}[a-z0-9])?\.web\.app", host)),
        "exact_live_or_project_preview_required")
    # Avoid URL normalization disguising an unexpected authority.
    require(parsed.netloc == host, "canonical_host_required")
    return f"https://{host}"


def evidence_directory(value):
    directory = Path(value).resolve()
    require(directory.is_relative_to(ROOT / "docs/evidence") and directory != ROOT / "docs/evidence",
            "repository_evidence_subdirectory_required")
    require(not directory.exists(), "evidence_directory_already_exists")
    return directory


def child_environment(origin, run_id, photo_count, evidence_dir, manifest, handoff):
    require(manifest["runId"] == handoff["runId"] == DEMO_RUN_ID
            and manifest["origin"] == handoff["origin"] == LIVE
            and manifest["departmentId"] == 2, "demo_handoff_scope_mismatch")
    env = {key: value for key, value in os.environ.items()
           if not key.upper().startswith(("HOSTED_REPORT_", "PG"))
           and key.upper() not in ("NODE_OPTIONS", "NODE_DEBUG", "DEBUG", "PWDEBUG")}
    env.update({"DEBUG": "", "NODE_DEBUG": "", "PWDEBUG": "0",
                "HOSTED_REPORT_BASE_URL": origin,
                "HOSTED_REPORT_ALLOWED_HOST": urlsplit(origin).netloc,
                "HOSTED_REPORT_ALLOW_EXISTING_HISTORY": "1",
                "HOSTED_REPORT_PHOTO_COUNT": str(photo_count),
                "HOSTED_REPORT_EVIDENCE_DIR": str(evidence_dir)})
    expected_ids = {"supervisor": 16, "alex": 13, "jamie": 14}
    for role, key in ACCOUNT_KEYS.items():
        expected, credentials = manifest["accounts"][key], handoff["accounts"][key]
        require(expected["id"] == expected_ids[key] and expected["departmentId"] == 2
                and expected["role"] == ("supervisor" if key == "supervisor" else "worker")
                and not expected.get("isGlobalAdmin")
                and credentials["email"] == expected["email"]
                and isinstance(credentials["password"], str) and len(credentials["password"]) >= 8,
                "exact_demo_account_required")
        env[f"HOSTED_REPORT_{role}_EMAIL"] = credentials["email"]
        env[f"HOSTED_REPORT_{role}_PASSWORD"] = credentials["password"]
    require(len({env[f"HOSTED_REPORT_{role}_EMAIL"] for role in ACCOUNT_KEYS}) == 3,
            "three_distinct_demo_accounts_required")
    require(bool(re.fullmatch(r"[a-z0-9][a-z0-9_-]{3,39}", run_id)), "invalid_run_id")
    return env


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--photo-count", type=int, choices=(1, 50), default=1)
    parser.add_argument("--evidence-dir", required=True, type=Path)
    args = parser.parse_args()
    origin = approved_origin(args.origin)
    directory = evidence_directory(args.evidence_dir)
    require(bool(re.fullmatch(r"[a-z0-9][a-z0-9_-]{3,39}", args.run_id)), "invalid_run_id")
    node = shutil.which("node")
    require(node is not None, "node_runtime_required")
    manifest = json.loads((ROOT / f"docs/evidence/presentation-{DEMO_RUN_ID}.json").read_text())
    spec = importlib.util.spec_from_file_location("presentation_demo", ROOT / "scripts/presentation-demo-live.py")
    demo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(demo)
    handoff = demo.read_private_handoff(DEMO_RUN_ID)
    env = child_environment(origin, args.run_id, args.photo_count, directory, manifest, handoff)
    result = subprocess.run(
        [node, str(ROOT / "scripts/check-hosted-report-workflow.mjs"),
         "--allow-hosted-mutations", "--run-id", args.run_id],
        cwd=ROOT, env=env, stdin=subprocess.DEVNULL, capture_output=True,
        text=True, encoding="utf-8", errors="replace", check=False,
    )
    # Do not impose an outer timeout: the runner must reach its exact-owned
    # cleanup/final-evidence block even when an individual browser step fails.
    proof_path = directory / "evidence.json"
    proof = json.loads(proof_path.read_text()) if proof_path.exists() else {}
    summary = {"runId": args.run_id, "origin": origin,
               "status": "passed" if result.returncode == 0 and proof.get("status") == "passed" else "failed",
               "runnerExitCode": result.returncode, "checkpoints": len(proof.get("checks", [])),
               "evidence": str(proof_path.relative_to(ROOT)).replace("\\", "/")}
    print(json.dumps(summary))
    return 0 if summary["status"] == "passed" else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        # Only our fixed codes are public. Third-party exceptions might contain
        # credentials or response content, so never print their message/traceback.
        code = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print(json.dumps({"status": "refused", "safeFailure": code}))
        sys.exit(1)
