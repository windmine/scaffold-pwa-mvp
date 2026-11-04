import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
CONTEXT = OUT / 'build-context'
assert not CONTEXT.exists(), 'Refusing to replace an existing build context'
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
assert commit == '6312d80ae6bd25c4e77dd44016dfd2a9543ab3ff'
candidate = CONTEXT / 'candidate'
candidate.mkdir(parents=True)
archive = subprocess.check_output(['git', 'archive', '--format=tar', commit, 'Dockerfile', 'requirements.txt', '.dockerignore', '.gcloudignore', 'backend'], cwd=ROOT)
with tarfile.open(fileobj=io.BytesIO(archive)) as package:
    package.extractall(candidate, filter='data')
files = {p.relative_to(candidate).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(candidate.rglob('*')) if p.is_file()}
assert not any(p.endswith(('.db', '.sqlite', '.pyc')) or p.endswith('/.env') or '/uploads/' in p for p in files)
(OUT / 'build-inputs.json').write_text(json.dumps({'commit': commit, 'files': files}, indent=2), encoding='utf-8')
image = 'australia-southeast1-docker.pkg.dev/geo-attendance-system-db9ca/cloud-run-source-deploy/geo-backend:install-guide-20261104-6312d80'
tests_image = image + '-tests'
(CONTEXT / 'test-requirements.txt').write_bytes(subprocess.check_output(['git', 'show', commit + ':.github/requirements-test.txt'], cwd=ROOT))
(CONTEXT / 'Dockerfile.tests').write_text('ARG RUNTIME_IMAGE\nFROM ${RUNTIME_IMAGE}\nCOPY test-requirements.txt /tmp/test-requirements.txt\nRUN python -m pip install --no-cache-dir -r /tmp/test-requirements.txt\n', encoding='utf-8')
suites = ['registration_email_test.py', 'invitation_email_test.py', 'security_test.py', 'migration_test.py', 'invitation_test.py', 'staff_invitation_test.py', 'password_recovery_test.py']
steps = [
    {'id': 'build-candidate', 'name': 'gcr.io/cloud-builders/docker', 'args': ['build', '-t', image, 'candidate']},
    {'id': 'prepare-test-reader', 'name': 'gcr.io/cloud-builders/docker', 'args': ['build', '-f', 'Dockerfile.tests', '--build-arg', 'RUNTIME_IMAGE=' + image, '-t', tests_image, '.']},
]
for suite in suites:
    args = ['run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=512m', '--tmpfs', '/app/output:rw,noexec,nosuid,size=32m']
    for setting in ['APP_ENV=test', 'AUTO_MIGRATE=false', 'DATABASE_URL=sqlite://', 'UPLOAD_DIR=/tmp/uploads', 'REGISTRATION_EMAIL_ENABLED=false', 'REPORT_PDF_EMAIL_WORKER_ENABLED=false', 'WORKER_INVITATION_TTL_HOURS=168']:
        args.extend(['-e', setting])
    args.extend(['--entrypoint', 'python', tests_image, '/app/backend/' + suite])
    steps.append({'id': suite.removesuffix('.py').replace('_', '-'), 'name': 'gcr.io/cloud-builders/docker', 'args': args})
config = {'steps': steps, 'images': [image], 'timeout': '1200s', 'serviceAccount': 'projects/geo-attendance-system-db9ca/serviceAccounts/794826041820-compute@developer.gserviceaccount.com', 'options': {'logging': 'CLOUD_LOGGING_ONLY'}}
(CONTEXT / 'cloudbuild.json').write_text(json.dumps(config, indent=2), encoding='utf-8')
(OUT / 'build-request.json').write_text(json.dumps({'sourceCommit': commit, 'imageTag': image, 'packagedFileCount': len(files), 'exactImageTestSuites': suites, 'testNetwork': 'none'}, indent=2), encoding='utf-8')
print(json.dumps({'commit': commit, 'packagedFiles': len(files), 'image': image}))
