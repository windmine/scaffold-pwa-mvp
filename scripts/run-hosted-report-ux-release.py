"""Opt-in combined UX verification; resets only a newly created nonce-owned Worker.

The existing demo Supervisor is read/used for scoped operations, never reset.
Credentials remain in process memory/child environment; raw output is not echoed.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def module_at(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-hosted-mutations", action="store_true", required=True)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--evidence-dir", required=True, type=Path)
    args = parser.parse_args()
    helper = module_at("hosted_report_release", ROOT / "scripts/run-hosted-report-release.py")
    origin = helper.approved_origin(args.origin)
    directory = helper.evidence_directory(args.evidence_dir)
    helper.require(bool(re.fullmatch(r"[a-z0-9][a-z0-9_-]{3,39}", args.run_id)), "invalid_run_id")
    node = shutil.which("node")
    helper.require(node is not None, "node_runtime_required")
    manifest = json.loads((ROOT / f"docs/evidence/presentation-{helper.DEMO_RUN_ID}.json").read_text())
    demo = module_at("presentation_demo", ROOT / "scripts/presentation-demo-live.py")
    handoff = demo.read_private_handoff(helper.DEMO_RUN_ID)
    env = helper.child_environment(origin, args.run_id, 1, directory, manifest, handoff)
    env = {key: value for key, value in env.items()
           if not key.startswith(("HOSTED_REPORT_WORKER_", "HOSTED_REPORT_SECOND_WORKER_", "HOSTED_UX_"))}
    env["HOSTED_UX_EVIDENCE_DIR"] = str(directory)
    result = subprocess.run(
        [node, str(ROOT / "scripts/check-hosted-report-ux-release.mjs"), "--allow-hosted-mutations", "--run-id", args.run_id],
        cwd=ROOT, env=env, stdin=subprocess.DEVNULL, capture_output=True,
        text=True, encoding="utf-8", errors="replace", check=False,
    )
    # No outer timeout: allow the runner's exact-owned finally cleanup to finish.
    # Never echo raw child output, page text, request/response bodies or tokens.
    proof_path = directory / "evidence.json"
    proof = json.loads(proof_path.read_text()) if proof_path.exists() else {}
    passed = result.returncode == 0 and proof.get("status") == "passed"
    print(json.dumps({"runId": args.run_id, "origin": origin, "status": "passed" if passed else "failed",
                      "runnerExitCode": result.returncode, "checkpoints": len(proof.get("checks", [])),
                      "cleanupFailures": len(proof.get("cleanup", {}).get("failures", [])),
                      "evidence": str(proof_path.relative_to(ROOT)).replace("\\", "/")}))
    return 0 if passed else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r"[a-z_]+", str(error)) else "configuration_or_runner_failure"
        print(json.dumps({"status": "refused", "safeFailure": code}))
        sys.exit(1)
