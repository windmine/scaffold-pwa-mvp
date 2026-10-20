"""Narrow SMTP release operations. Never reads secret payloads or calls SMTP."""
from datetime import datetime, timezone
from pathlib import Path
import copy
import hashlib
import json
import shutil
import subprocess
import sys
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
PROJECT = "geo-attendance-system-db9ca"
REGION = "australia-southeast1"
SERVICE = "geo-backend"
REVISION = "geo-backend-smtp-20261020"
TAG = "smtp-20261020"
SECRET = "reportflow-smtp-password"
ACCOUNT = "geo-backend-runtime@geo-attendance-system-db9ca.iam.gserviceaccount.com"
SETTINGS = {
    "SMTP_HOST": "smtp.gmail.com", "SMTP_PORT": "587",
    "SMTP_USERNAME": "info@mutualconstruction.co.nz",
    "SMTP_FROM_EMAIL": "info@mutualconstruction.co.nz",
    "SMTP_USE_STARTTLS": "true", "SMTP_USE_SSL": "false",
    "REGISTRATION_EMAIL_ENABLED": "false",
}


def now():
    return datetime.now(timezone.utc).isoformat()


def read(name):
    return json.loads((OUT / name).read_text(encoding="utf-8"))


def write(name, data):
    (OUT / name).write_bytes((json.dumps(data, indent=2) + "\n").encode())


def cloud(*args):
    result = subprocess.run([shutil.which("gcloud.cmd") or "gcloud", *args,
                             "--project", PROJECT, "--format=json", "--quiet"],
                            capture_output=True, text=True, timeout=600)
    if result.returncode:
        # No secret payload is ever requested. Do not dump provider output.
        raise RuntimeError(f"gcloud {' '.join(args[:3])} failed (exit {result.returncode}); inspect actual state before retry")
    return json.loads(result.stdout) if result.stdout.strip() else {}


def service():
    return cloud("run", "services", "describe", SERVICE, "--region", REGION)


def safe_runtime(spec):
    result = copy.deepcopy(spec)
    for container in result["containers"]:
        for entry in container.get("env", []):
            if "value" in entry:
                entry["valueSha256"] = hashlib.sha256(entry.pop("value").encode()).hexdigest()
        container["env"] = sorted(container.get("env", []), key=lambda e: e["name"])
    return result


def policy_bindings(policy):
    return sorted(json.dumps(binding, sort_keys=True) for binding in policy.get("bindings", []))


def assert_service_iam():
    policy = cloud("run", "services", "get-iam-policy", SERVICE, "--region", REGION)
    assert policy_bindings(policy) == policy_bindings(read("baseline.json")["serviceIam"])


def assert_candidate(current):
    baseline = read("baseline.json")
    runtime = safe_runtime(current["spec"]["template"]["spec"])
    expected = copy.deepcopy(baseline["runtime"])
    assert expected["serviceAccountName"] == ACCOUNT and len(expected["containers"]) == 1
    container = expected["containers"][0]
    container["image"] = read("candidate-image.json")["image"]
    env = {item["name"]: item for item in container.get("env", [])}
    for key, value in SETTINGS.items():
        env[key] = {"name": key, "valueSha256": hashlib.sha256(value.encode()).hexdigest()}
    env["SMTP_PASSWORD"] = {"name": "SMTP_PASSWORD", "valueFrom": {
        "secretKeyRef": {"name": SECRET, "key": "1"},
    }}
    container["env"] = sorted(env.values(), key=lambda e: e["name"])
    assert runtime == expected, "Unexpected runtime configuration difference"
    before_annotations = baseline["templateMetadata"].get("annotations", {})
    after_annotations = current["spec"]["template"].get("metadata", {}).get("annotations", {})
    generated = {"run.googleapis.com/client-name", "run.googleapis.com/client-version", "client.knative.dev/user-image"}
    assert {k: v for k, v in before_annotations.items() if k not in generated} == {
        k: v for k, v in after_annotations.items() if k not in generated
    }, "Unexpected template annotation difference"
    for key in ("run.googleapis.com/ingress", "run.googleapis.com/ingress-status"):
        assert baseline["serviceAnnotations"].get(key) == current["metadata"].get("annotations", {}).get(key)
    assert current["status"]["latestReadyRevisionName"] == REVISION
    assert_service_iam()
    return runtime


def health(origin):
    results = []
    for path in ("/health", "/health/ready"):
        with urlopen(origin.rstrip("/") + path, timeout=30) as response:
            data = json.load(response)
            assert response.status == 200
        if path.endswith("/ready"):
            assert all(data["checks"][key] == "ok" for key in ("database", "migrations", "upload_storage"))
        results.append({"path": path, "status": 200, "body": data})
    return results


def main(action):
    baseline = read("baseline.json")
    if action == "grant":
        assert not (OUT / "secret-access.json").exists()
        version = cloud("secrets", "versions", "describe", "1", "--secret", SECRET)
        assert version["state"] == "ENABLED"
        before = cloud("secrets", "get-iam-policy", SECRET)
        assert policy_bindings(before) == policy_bindings(baseline["secretIam"]), "Secret IAM changed since baseline"
        member = "serviceAccount:" + ACCOUNT
        role = "roles/secretmanager.secretAccessor"
        exists = any(b.get("role") == role and not b.get("condition") and member in b.get("members", []) for b in before.get("bindings", []))
        if not exists:
            write("secret-access-request.json", {"requestedAtUtc": now(), "secret": SECRET, "member": member, "role": role})
            cloud("secrets", "add-iam-policy-binding", SECRET, "--member", member, "--role", role, "--condition=None")
        after = cloud("secrets", "get-iam-policy", SECRET)
        expected = copy.deepcopy(before)
        if not exists:
            binding = next((b for b in expected.setdefault("bindings", []) if b.get("role") == role and not b.get("condition")), None)
            if binding is None:
                expected["bindings"].append({"role": role, "members": [member]})
            else:
                binding["members"] = sorted([*binding["members"], member])
        assert policy_bindings(after) == policy_bindings(expected), "Unexpected secret IAM change"
        write("secret-access.json", {"status": "passed", "verifiedAtUtc": now(), "changed": not exists, "secret": SECRET, "member": member, "role": role, "before": before, "after": after, "secretValuesRead": False})
    elif action == "deploy":
        assert not (OUT / "deployment-request.json").exists()
        assert read("secret-access.json")["status"] == "passed"
        current = service()
        old_runtime = safe_runtime(current["spec"]["template"]["spec"])
        old_expected = copy.deepcopy(baseline["runtime"])
        for c in old_expected["containers"]: c["env"] = sorted(c.get("env", []), key=lambda e: e["name"])
        assert old_runtime == old_expected and current["status"]["traffic"] == baseline["status"]["traffic"]
        assert_service_iam()
        image = read("candidate-image.json")["image"]
        write("deployment-request.json", {"requestedAtUtc": now(), "revision": REVISION, "image": image, "traffic": "zero", "settings": SETTINGS, "secretReference": SECRET + ":1"})
        cloud("run", "deploy", SERVICE, "--region", REGION, "--image", image,
              "--no-traffic", "--tag", TAG, "--revision-suffix", "smtp-20261020",
              "--update-env-vars", ",".join(f"{k}={v}" for k, v in SETTINGS.items()),
              "--update-secrets", "SMTP_PASSWORD=" + SECRET + ":1")
        current = service()
        runtime = assert_candidate(current)
        traffic = current["status"]["traffic"]
        assert [(t["revisionName"], t["percent"]) for t in traffic if t.get("percent")] == [(baseline["status"]["latestReadyRevisionName"], 100)]
        url = next(t["url"] for t in traffic if t.get("tag") == TAG and t["revisionName"] == REVISION)
        write("candidate.json", {"status": "passed", "verifiedAtUtc": now(), "revision": REVISION, "url": url, "runtime": runtime, "traffic": traffic, "health": health(url), "onlyApprovedRuntimeChanges": True, "serviceIamUnchanged": True})
    elif action == "promote":
        assert not (OUT / "promotion-request.json").exists()
        for name in ("candidate.json", "hardening-current.json", "pre-promotion-readonly.json"):
            assert read(name)["status"] == "passed", name
        ci = read("ci-source.json")
        assert ci["headSha"] == read("candidate-source-parity.json")["ciSourceCommit"]
        assert ci["status"] == "completed" and ci["conclusion"] == "success"
        assert len(ci["jobs"]) == 2 and all(job["conclusion"] == "success" for job in ci["jobs"])
        unchanged = subprocess.run(["git", "diff", "--name-only", read("candidate-image.json")["sourceCommit"],
                                    "HEAD", "--", "Dockerfile", "requirements.txt", "backend", ".gcloudignore", ".dockerignore"],
                                   cwd=ROOT, capture_output=True, text=True, check=True)
        assert not unchanged.stdout, "Backend inputs changed since the tested image"
        assert cloud("secrets", "versions", "describe", "1", "--secret", SECRET)["state"] == "ENABLED"
        assert policy_bindings(cloud("secrets", "get-iam-policy", SECRET)) == policy_bindings(read("secret-access.json")["after"])
        current = service()
        assert_candidate(current)
        traffic = current["status"]["traffic"]
        assert {t["tag"] for t in traffic if t.get("tag")} == {TAG}
        assert [(t["revisionName"], t["percent"]) for t in traffic if t.get("percent")] == [(baseline["status"]["latestReadyRevisionName"], 100)]
        write("promotion-request.json", {"requestedAtUtc": now(), "revision": REVISION, "previousRevision": baseline["status"]["latestReadyRevisionName"], "ciRun": ci["databaseId"]})
        cloud("run", "services", "update-traffic", SERVICE, "--region", REGION, "--to-revisions", REVISION + "=100")
        current = service()
        assert_candidate(current)
        assert [(t["revisionName"], t["percent"]) for t in current["status"]["traffic"] if t.get("percent")] == [(REVISION, 100)]
        checks = health(current["status"]["url"])
        checks += health("https://geo-attendance-system-db9ca.web.app/api")
        assert {t["tag"] for t in current["status"]["traffic"] if t.get("tag")} == {TAG}
        cloud("run", "services", "update-traffic", SERVICE, "--region", REGION, "--clear-tags")
        current = service()
        runtime = assert_candidate(current)
        assert len(current["status"]["traffic"]) == 1
        assert current["status"]["traffic"][0]["revisionName"] == REVISION
        assert current["status"]["traffic"][0]["percent"] == 100
        assert not current["status"]["traffic"][0].get("tag")
        write("promotion.json", {"status": "passed", "verifiedAtUtc": now(), "revision": REVISION,
                                 "traffic": current["status"]["traffic"], "runtime": runtime,
                                 "health": checks, "serviceIamUnchanged": True,
                                 "secretValuesRead": False, "smtpAuthenticationOrEmailAttempted": False})
    else:
        raise ValueError("Unsupported operation")
    print(json.dumps({"operation": action, "status": "passed"}))


if __name__ == "__main__":
    main(sys.argv[1])
