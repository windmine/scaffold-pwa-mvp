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
OUT = ROOT / "docs/evidence/report-submit-pdf-release-20261021"
PROJECT = "geo-attendance-system-db9ca"
REGION = "australia-southeast1"
SOURCE = "80b4ea01a041a84bdcc0483f8e3d41a34d55f117"
BASE = "35204d8884ce751ffed3deb67896e9e0139b6313"
MIGRATION = "backend/migrations/versions/0024_report_pdf_email.py"


def write(name, value):
    (OUT / name).write_bytes((json.dumps(value, indent=2) + "\n").encode())


def main():
    from rollout import ci
    ci()
    assert not (OUT / "build-request.json").exists(), "Inspect prior build outcome before any new request"
    directory = Path(tempfile.mkdtemp(prefix="reportflow-report-pdf-build-"))
    images = {}
    manifests = {}
    for kind, commit in [("candidate", SOURCE), ("fallback", BASE)]:
        target = directory / kind
        target.mkdir()
        archive = subprocess.check_output(["git", "archive", commit, "Dockerfile", "requirements.txt", ".dockerignore", ".gcloudignore", "backend"], cwd=ROOT)
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(target, filter="data")
        if kind == "fallback":
            for path in [MIGRATION, "backend/app/models.py", "backend/app/use_cases/record_trash.py"]:
                (target / path).write_bytes(subprocess.check_output(["git", "show", SOURCE + ":" + path], cwd=ROOT))
        files = {p.relative_to(target).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(target.rglob("*")) if p.is_file()}
        assert all(not p.endswith((".db", ".sqlite", ".pyc")) and "/.env" not in p and "/uploads/" not in p for p in files)
        images[kind] = f"{REGION}-docker.pkg.dev/{PROJECT}/cloud-run-source-deploy/geo-backend:report-pdf-{kind}-20261021-{SOURCE[:7]}-v3"
        manifests[kind] = {"baseCommit": commit, "migrationCommit": SOURCE, "files": files, "imageTag": images[kind],
                          "fallbackCompatibilityOverlays": [MIGRATION, "backend/app/models.py", "backend/app/use_cases/record_trash.py"] if kind == "fallback" else []}
    write("source-packages.json", {"directory": str(directory), "sourceCommit": SOURCE, "packages": manifests})
    steps = []
    (directory / 'Dockerfile.pdf-test').write_text('ARG RUNTIME_IMAGE\nFROM ${RUNTIME_IMAGE}\nRUN pip install --no-cache-dir --no-deps --target /test-deps pypdf==6.20.0\nENV PYTHONPATH=/test-deps:/app/backend\n', encoding='utf-8')
    for kind in images:
        steps.append({"name": "gcr.io/cloud-builders/docker", "id": "build-" + kind,
                      "args": ["build", "-t", images[kind], kind]})
        tests = ["registration_email_test.py"] + (["invitation_email_test.py", "report_pdf_email_test.py", "supervisor_report_submission_test.py"] if kind == "candidate" else ["invitation_email_test.py"])
        common = ["run", "--rm", "--network", "none", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
                  "-e", "APP_ENV=test", "-e", "AUTO_MIGRATE=false", "-e", "DATABASE_URL=sqlite://",
                  "-e", "UPLOAD_DIR=/tmp/uploads", "-e", "REGISTRATION_EMAIL_ENABLED=false", "--entrypoint", "python", images[kind]]
        for test in tests:
            test_command = list(common)
            if test == 'report_pdf_email_test.py':
                reader_image = images[kind] + '-reader-tests'
                steps.append({'name':'gcr.io/cloud-builders/docker','id':'prepare-test-only-pdf-reader',
                    'args':['build','-f','Dockerfile.pdf-test','--build-arg','RUNTIME_IMAGE='+images[kind],'-t',reader_image,'.']})
                test_command[-1:] = ['--tmpfs', '/app/output:rw,noexec,nosuid,size=32m', reader_image]
            steps.append({"name": "gcr.io/cloud-builders/docker", "id": kind + "-" + test.replace("_", "-"),
                          "args": [*test_command, "/app/backend/" + test]})
        if kind == "fallback":
            code = ("from sqlmodel import create_engine,Session,select; from app.migrations import run_migrations,verify_migrations; "
                    "from app.models import User,WorkerInvitation,WorkForm,ReportPdfEmail; e=create_engine('sqlite:////tmp/fallback.db'); "
                    "v=run_migrations(e); assert len(v)==24 and v[-1]=='0024_report_pdf_email'; c=e.connect(); verify_migrations(c); c.close(); "
                    "s=Session(e); s.exec(select(User)).all(); s.exec(select(WorkerInvitation)).all(); s.exec(select(WorkForm)).all(); s.exec(select(ReportPdfEmail)).all(); s.close(); "
                    "print('Fallback exact 24-migration schema and previous models verified')")
            steps.append({"name": "gcr.io/cloud-builders/docker", "id": "fallback-schema-compatibility", "args": [*common, "-c", code]})
            purge_code = '''from datetime import datetime, timezone, timedelta
from sqlmodel import create_engine, Session, select
from app.migrations import run_migrations
from app.models import WorkFormSubmission, ReportPdfEmail
from app.use_cases.record_trash import purge_expired_deleted_records
engine=create_engine('sqlite:////tmp/fallback-purge.db')
run_migrations(engine)
with Session(engine) as session:
    record=WorkFormSubmission(form_id=9001, worker_id=9001, department_id=1, answers_json='{}', deleted_at=datetime.now(timezone.utc)-timedelta(days=31))
    session.add(record); session.flush()
    session.add(ReportPdfEmail(submission_id=record.id, department_id=1, recipient='fixture@example.invalid', template_email_version=1, snapshot_json='{}', message_id='<synthetic@reportflow.invalid>', status='uncertain'))
    session.commit()
    purge_expired_deleted_records(session)
    assert session.exec(select(ReportPdfEmail)).all()==[]
    assert session.exec(select(WorkFormSubmission)).all()==[]
print('Fallback preserves outbox purge with no network or SMTP')
'''
            steps.append({"name": "gcr.io/cloud-builders/docker", "id": "fallback-outbox-purge", "args": [*common, "-c", purge_code]})
    config = {"steps": steps, "images": list(images.values()), "tags": ["reportflow-report-pdf-20261021"],
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
