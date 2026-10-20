"""Read-only post-promotion verification; no secret payloads or SMTP calls."""
import hashlib
import json
import shutil
import subprocess
from urllib.request import urlopen

import smtp_release_operator as release

assert not (release.OUT / "live-verification.json").exists()
assert release.read("promotion.json")["status"] == "passed"
current = release.service()
runtime = release.assert_candidate(current)
traffic = current["status"]["traffic"]
assert len(traffic) == 1 and traffic[0]["revisionName"] == release.REVISION
assert traffic[0]["percent"] == 100 and not traffic[0].get("tag")
version = release.cloud("secrets", "versions", "describe", "1", "--secret", release.SECRET)
assert version["state"] == "ENABLED"
assert release.policy_bindings(release.cloud("secrets", "get-iam-policy", release.SECRET)) == release.policy_bindings(release.read("secret-access.json")["after"])

hosting_files = []
for expected in release.read("pre-promotion-readonly.json")["hostingFiles"]:
    with urlopen("https://geo-attendance-system-db9ca.web.app/" + expected["path"], timeout=30) as response:
        digest = hashlib.sha256(response.read()).hexdigest()
        assert response.status == 200 and digest == expected["sha256"]
    hosting_files.append({"path": expected["path"], "sha256": digest})

log_filter = (
    'resource.type="cloud_run_revision" '
    f'AND resource.labels.service_name="{release.SERVICE}" '
    f'AND resource.labels.revision_name="{release.REVISION}" '
    'AND (severity>=ERROR OR httpRequest.status>=500)'
)
result = subprocess.run([
    shutil.which("gcloud.cmd") or "gcloud", "logging", "read", log_filter,
    "--project", release.PROJECT, "--freshness=2h", "--limit=100",
    "--format=json(timestamp,severity,httpRequest.status)", "--quiet",
], capture_output=True, text=True, timeout=120, check=True)
logs = json.loads(result.stdout)
assert not logs, "Candidate has error/5xx metadata; inspect before declaring success"
checks = release.health(current["status"]["url"])
checks += release.health("https://geo-attendance-system-db9ca.web.app/api")
proof = {
    "status": "passed", "verifiedAtUtc": release.now(),
    "revision": release.REVISION, "traffic": traffic, "runtime": runtime,
    "onlyApprovedRuntimeChanges": True, "existingSecretReferencesPreserved": True,
    "serviceIamUnchanged": True, "smtpSecretIamMatchesApprovedGrant": True,
    "smtpSecretVersion": {"name": version["name"], "state": version["state"]},
    "hostingFilesUnchanged": hosting_files, "health": checks,
    "errorOr5xxCount": len(logs), "errorLogWindow": "last two hours for this revision",
    "secretValuesRead": False, "smtpAuthenticationOrEmailAttempted": False,
    "hostedApplicationFixturesCreated": False,
}
release.write("live-verification.json", proof)
print(json.dumps({"status": "passed", "revision": release.REVISION, "healthChecks": len(checks), "errorOr5xxCount": len(logs)}))
