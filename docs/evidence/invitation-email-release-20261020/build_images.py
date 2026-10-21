"""Build committed candidate and migration-compatible fallback; no credentials."""
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path.cwd()
OUT = ROOT / "docs/evidence/invitation-email-release-20261020"
PROJECT = "geo-attendance-system-db9ca"
REGION = "australia-southeast1"
SOURCE = "2f861c569949e5f91e29748d7ab47c672c7beef1"
BASE = "b32dc42785289c995ea53e2a60e3e1336ae9c75f"
MIGRATION = "backend/migrations/versions/0023_worker_invitation_email.py"


def write(name, value):
    (OUT / name).write_bytes((json.dumps(value, indent=2) + "\n").encode())


def main():
    assert not (OUT / "build-request.json").exists(), "Inspect prior build outcome before any new request"
    directory = Path(tempfile.mkdtemp(prefix="reportflow-invitation-build-"))
    images = {}
    manifests = {}
    for kind, commit in [("candidate", SOURCE), ("fallback", BASE)]:
        target = directory / kind
        target.mkdir()
        archive = subprocess.check_output(["git", "archive", commit, "Dockerfile", "requirements.txt", ".dockerignore", ".gcloudignore", "backend"], cwd=ROOT)
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(target, filter="data")
        if kind == "fallback":
            (target / MIGRATION).write_bytes(subprocess.check_output(["git", "show", SOURCE + ":" + MIGRATION], cwd=ROOT))
        files = {p.relative_to(target).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(target.rglob("*")) if p.is_file()}
        assert all(not p.endswith((".db", ".sqlite", ".pyc")) and "/.env" not in p and "/uploads/" not in p for p in files)
        images[kind] = f"{REGION}-docker.pkg.dev/{PROJECT}/cloud-run-source-deploy/geo-backend:invitation-{kind}-20261020-{SOURCE[:7]}"
        manifests[kind] = {"baseCommit": commit, "migrationCommit": SOURCE, "files": files, "imageTag": images[kind]}
    write("source-packages.json", {"directory": str(directory), "sourceCommit": SOURCE, "packages": manifests})
    steps = []
    for kind in images:
        steps.append({"name": "gcr.io/cloud-builders/docker", "id": "build-" + kind,
                      "args": ["build", "-t", images[kind], kind]})
        tests = ["registration_email_test.py"] + (["invitation_email_test.py"] if kind == "candidate" else [])
        common = ["run", "--rm", "--network", "none", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
                  "-e", "APP_ENV=test", "-e", "AUTO_MIGRATE=false", "-e", "DATABASE_URL=sqlite://",
                  "-e", "UPLOAD_DIR=/tmp/uploads", "-e", "REGISTRATION_EMAIL_ENABLED=false", "--entrypoint", "python", images[kind]]
        for test in tests:
            steps.append({"name": "gcr.io/cloud-builders/docker", "id": kind + "-" + test.replace("_", "-"),
                          "args": [*common, "/app/backend/" + test]})
        if kind == "fallback":
            code = ("from sqlmodel import create_engine,Session,select; from app.migrations import run_migrations,verify_migrations; "
                    "from app.models import User,WorkerInvitation; e=create_engine('sqlite:////tmp/fallback.db'); "
                    "v=run_migrations(e); assert len(v)==23 and v[-1]=='0023_worker_invitation_email'; c=e.connect(); verify_migrations(c); c.close(); "
                    "s=Session(e); s.exec(select(User)).all(); s.exec(select(WorkerInvitation)).all(); s.close(); "
                    "print('Fallback exact 23-migration schema and previous models verified')")
            steps.append({"name": "gcr.io/cloud-builders/docker", "id": "fallback-schema-compatibility", "args": [*common, "-c", code]})
    config = {"steps": steps, "images": list(images.values()), "tags": ["reportflow-invitation-20261020"],
              "options": {"logging": "CLOUD_LOGGING_ONLY"}, "timeout": "1200s"}
    (directory / "cloudbuild.json").write_bytes((json.dumps(config, indent=2) + "\n").encode())
    write("build-configuration.json", config)
    write("build-request.json", {"requestedAtUtc": datetime.now(timezone.utc).isoformat(), "sourceCommit": SOURCE,
                                "directory": str(directory), "images": images, "status": "requested"})
    result = subprocess.run([shutil.which("gcloud.cmd"), "builds", "submit", str(directory), "--config", str(directory / "cloudbuild.json"),
                             "--project", PROJECT, "--region", REGION, "--async", "--format=json", "--quiet"],
                            capture_output=True, encoding="utf-8", errors="replace", timeout=180)
    if result.returncode:
        raise RuntimeError("Build request did not confirm success; inspect matching tagged builds before retry")
    data = json.loads(result.stdout)
    write("build-submission.json", data)
    print(json.dumps({"buildId": data["id"], "status": data["status"], "logUrl": data.get("logUrl")}))


if __name__ == "__main__":
    main()
