"""Assemble the verified SMTP release record without cloud access."""
import hashlib
import json
from pathlib import Path

import smtp_release_operator as release

assert not (release.OUT / "release.json").exists()
required = ["candidate.json", "promotion.json", "live-verification.json",
            "hardening-current.json", "hardening-post-promotion.json",
            "backend-source-comparison.json", "candidate-source-parity.json"]
for name in required:
    assert release.read(name)["status"] == "passed", name
ci = release.read("ci-source.json")
assert ci["conclusion"] == "success" and ci["browserWorkflowCount"] == 73
assert len(ci["jobs"]) == 2 and all(job["conclusion"] == "success" for job in ci["jobs"])
image = release.read("candidate-image.json")
promotion = release.read("promotion.json")
local_log = (release.OUT / "backend-local.txt").read_text(encoding="utf-8")
assert "backend local checks passed; temporary default storage removed" in local_log
assert "Ran 10 tests" in local_log
record = {
    "schemaVersion": 1, "status": "deployed-and-verified", "recordedAtUtc": release.now(),
    "scope": "Gmail SMTP configuration and minimal verified-TLS/disabled-registration prerequisite only",
    "project": release.PROJECT, "region": release.REGION, "service": release.SERVICE,
    "revision": release.REVISION, "traffic": promotion["traffic"],
    "imageSourceCommit": image["sourceCommit"], "ciSourceCommit": ci["headSha"],
    "backendAndBuildInputsIdenticalBetweenImageAndCiSource": True,
    "buildId": image["buildId"], "image": image["image"],
    "promotionRequestedAtUtc": release.read("promotion-request.json")["requestedAtUtc"],
    "promotionVerifiedAtUtc": promotion["verifiedAtUtc"],
    "previousRevision": release.read("promotion-request.json")["previousRevision"],
    "settings": release.SETTINGS,
    "passwordReference": {"environmentVariable": "SMTP_PASSWORD", "secret": release.SECRET, "version": "1", "state": "ENABLED"},
    "iamChange": {"scope": "this secret only", "role": "roles/secretmanager.secretAccessor", "member": "serviceAccount:" + release.ACCOUNT},
    "securityBehavior": [
        "SMTP STARTTLS and implicit TLS use ssl.create_default_context with certificate and hostname verification.",
        "Plaintext SMTP configuration is rejected; TLS failures do not proceed to authentication or sending.",
        "Public-registration email defaults off and is explicitly disabled in production; the disabled path rejects before identity lookup or database writes.",
    ],
    "validation": {
        "mockedSmtpTests": 10, "exactImageMockedSmtpTests": 10,
        "exactImageTestNetwork": "disabled", "localBackendSuites": 22,
        "localCleanupRegressionRunner": "passed", "sourceCi": ci["url"],
        "sourceCiConclusion": "success", "realBackendBrowserWorkflows": 73,
        "nativePostgresIsolationAndVolumeCi": "passed",
        "prePromotionHardeningChecks": len(release.read("hardening-current.json")["passingChecks"]),
        "postPromotionHardeningChecks": len(release.read("hardening-post-promotion.json")["passingChecks"]),
        "liveHealth": "direct and Firebase Hosting health/readiness passed",
        "runtimeComparison": "Only the approved image, SMTP settings, disabled-registration flag and version-1 secret reference changed.",
        "existingSecretReferencesAndServiceIam": "preserved", "candidateAndLiveErrorOr5xxCount": 0,
        "hostingIndexAndServiceWorkerHashes": "unchanged",
    },
    "ciGateRepair": release.read("preparation.json")["ciAuditDiagnosis"],
    "limitations": [
        "No real SMTP authentication or email delivery was attempted; Gmail acceptance and delivery are unverified.",
        "Worker invitations remain manual private links; Report PDFs remain downloads. No invitation or PDF email feature was added.",
        "The existing six-hour Neon recovery-history warning remains; no backup-policy change was made.",
        "No migrations, hosted application fixtures, existing-user login or new database inventory comparison were performed.",
        "No Firebase Hosting deployment or physical-phone testing was performed.",
        "Initial local ASGI test sandbox stall remains unexplained; successful permitted-local, CI and exact-image tests are recorded separately.",
    ],
    "secretValuesRead": False, "smtpAuthenticationOrEmailAttempted": False,
    "evidence": {},
}
for path in sorted(release.OUT.iterdir()):
    if path.is_file() and path.name != "release.json":
        record["evidence"][path.name] = {"sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "bytes": path.stat().st_size}
release.write("release.json", record)
print(json.dumps({"status": record["status"], "revision": record["revision"], "evidenceFiles": len(record["evidence"])}))
