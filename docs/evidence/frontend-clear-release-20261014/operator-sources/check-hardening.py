"""Read-only production gate using the existing still-current recovery proofs."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

root = Path.cwd()
directory = root / "docs/evidence/frontend-clear-release-20261014"
destination = directory / "hardening-current.json"
log = directory / "hardening-log.txt"
assert not destination.exists() and not log.exists(), "new_evidence_required"
def now():
    return datetime.now(timezone.utc).isoformat()
def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
proofs = {
    "AlertDeliveryEvidence": "docs/evidence/alert-delivery-diagnosis-2026-10-12.json",
    "NeonRecoveryEvidence": "docs/evidence/report-release-20261005/neon-current-final.json",
    "UploadRecoveryEvidence": "docs/evidence/report-fixes-release-20261012/upload-recovery.json",
}
command = [shutil.which("pwsh"), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
           "scripts/check-production-hardening.ps1"]
for name, path in proofs.items():
    command.extend(["-" + name, path])
command.extend(["-BillingAccount", "0123B1-051D70-935F73"])
proof = {"schemaVersion": 1, "status": "running", "strict": True,
         "startedAtUtc": now(), "command": command,
         "sourceCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
         "recoveryProofs": {name: {"path": path, "sha256": sha(root / path)} for name, path in proofs.items()},
         "gateScriptSha256": sha(root / "scripts/check-production-hardening.ps1"),
         "hostedWritesPerformed": False}
destination.write_text(json.dumps(proof, indent=2) + "\n", encoding="utf-8")
result = subprocess.run(command, cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
output = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", result.stdout + result.stderr)
output = re.sub(r"(?i)postgres(?:ql)?(?:\+psycopg)?://\S+", "[redacted-database-url]", output)
output = re.sub(r"(?i)(Bearer\s+)\S+", r"\1[redacted]", output)
log.write_text(output, encoding="utf-8")
lines = output.splitlines()
proof.update(status="passed" if result.returncode == 0 else "failed", exitCode=result.returncode,
             checkedAtUtc=now(), failures=[line for line in lines if line.startswith("not ok - ")],
             warnings=[line for line in lines if line.startswith("warn - ")],
             passingChecks=[line[5:] for line in lines if line.startswith("ok - ")],
             logSha256=sha(log))
destination.write_text(json.dumps(proof, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"status": proof["status"], "passingChecks": len(proof["passingChecks"]),
                  "warnings": proof["warnings"], "failures": proof["failures"]}))
raise SystemExit(result.returncode)
