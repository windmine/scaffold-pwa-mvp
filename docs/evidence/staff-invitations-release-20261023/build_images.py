"""Build committed candidate plus a single-guard compatible fallback; no credentials."""
from datetime import datetime, timezone
import argparse
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

from fallback_overlay import apply as fallback_overlay

ROOT = Path.cwd()
OUT = Path(__file__).resolve().parent
PROJECT = 'geo-attendance-system-db9ca'
REGION = 'australia-southeast1'
BACKEND_JOB = 'Backend boundaries and native PostgreSQL volume'
FRONTEND_JOB = 'Frontend, audit and mobile workflows'


def write(name, value):
    mode = 'x' if name.endswith('-request.json') or name in ('source-packages.json', 'build-configuration.json') else 'w'
    with (OUT / name).open(mode, encoding='utf-8', newline='\n') as handle:
        handle.write(json.dumps(value, indent=2) + '\n')


def prepare(source, directory):
    images, manifests = {}, {}
    for kind in ('candidate', 'fallback'):
        target = directory / kind
        target.mkdir()
        archive = subprocess.check_output(['git', 'archive', source, 'Dockerfile', 'requirements.txt', '.dockerignore', '.gcloudignore', 'backend'], cwd=ROOT)
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(target, filter='data')
        overlay = fallback_overlay(target) if kind == 'fallback' else None
        files = {p.relative_to(target).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                 for p in sorted(target.rglob('*')) if p.is_file()}
        assert all(not p.endswith(('.db', '.sqlite', '.pyc')) and '/.env' not in p and '/uploads/' not in p for p in files)
        images[kind] = f'{REGION}-docker.pkg.dev/{PROJECT}/cloud-run-source-deploy/geo-backend:staff-invitations-{kind}-20261023-{source[:7]}'
        manifests[kind] = {'baseCommit': source, 'files': files, 'imageTag': images[kind], 'fallbackGuard': overlay}
    differences = [path for path, digest in manifests['candidate']['files'].items() if manifests['fallback']['files'].get(path) != digest]
    assert differences == ['backend/app/use_cases/worker_invitations.py']
    return images, manifests


def validate_build_ci(value, expected, allow_pending_frontend):
    """Permit artifact construction only; never produce deployment CI evidence."""
    assert value['databaseId'] == expected['id'], 'Unexpected source CI run'
    assert value['headSha'] == expected['sourceCommit'], 'Source CI commit does not match the image source'
    jobs = value['jobs']
    assert len(jobs) == 2 and {job['name'] for job in jobs} == {BACKEND_JOB, FRONTEND_JOB}, 'Expected exactly the two source CI jobs'
    backend = next(job for job in jobs if job['name'] == BACKEND_JOB)
    frontend = next(job for job in jobs if job['name'] == FRONTEND_JOB)
    assert backend['status'] == 'completed' and backend['conclusion'] == 'success', 'Exact-source backend CI must have completed successfully'
    full_ci = (value['status'] == 'completed' and value['conclusion'] == 'success'
               and frontend['status'] == 'completed' and frontend['conclusion'] == 'success')
    if not full_ci:
        assert allow_pending_frontend, 'Both source CI jobs must pass unless --allow-pending-frontend is explicitly supplied'
        assert value['status'] in ('queued', 'in_progress') and value['conclusion'] in (None, ''), 'Source CI must still be active without a terminal conclusion'
        assert frontend['status'] in ('queued', 'in_progress') and frontend['conclusion'] in (None, ''), 'Frontend CI must be pending; a failed, cancelled or other terminal result is not permitted'
    return full_ci


def check_build_ci(allow_pending_frontend):
    expected = json.loads((OUT / 'source-ci-id.json').read_text(encoding='utf-8-sig'))
    result = subprocess.run(['gh', 'run', 'view', str(expected['id']), '--json', 'databaseId,headSha,status,conclusion,jobs,url'],
                            capture_output=True, encoding='utf-8', check=True, timeout=60)
    observed = json.loads(result.stdout)
    evidence = {'observedAtUtc': datetime.now(timezone.utc).isoformat(), 'sourceCommit': expected['sourceCommit'],
                'runId': expected['id'], 'purpose': 'image-artifact-build-and-tests-only',
                'allowPendingFrontendRequested': allow_pending_frontend, 'fullCiPassed': False,
                'gateDecision': 'rejected', 'observedRun': observed}
    try:
        full_ci = validate_build_ci(observed, expected, allow_pending_frontend)
    except (AssertionError, KeyError, TypeError) as error:
        evidence['reason'] = str(error)
        write('build-source-ci.json', evidence)
        raise
    evidence.update(fullCiPassed=full_ci, gateDecision='image_build_allowed',
                    mode='full_ci' if full_ci else 'backend_passed_frontend_pending')
    write('build-source-ci.json', evidence)
    return expected['sourceCommit']


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-pending-frontend', action='store_true',
                        help='Build and test images with successful exact-source backend CI while frontend CI remains active. Does not authorize staging or deployment.')
    options = parser.parse_args(argv)
    assert not (OUT / 'build-request.json').exists(), 'Inspect previous build before repeating any uncertain action'
    assert not (OUT / 'build-preparation-request.json').exists(), 'Inspect previous preparation before repeating the build'
    source = check_build_ci(options.allow_pending_frontend)
    write('build-preparation-request.json', {'atUtc': datetime.now(timezone.utc).isoformat(), 'sourceCommit': source, 'providerActions': False})
    scratch = ROOT / 'output/browser-checks/staff-invitations-release'
    scratch.mkdir(parents=True, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix='build-', dir=scratch))
    images, manifests = prepare(source, directory)
    write('source-packages.json', {'directory': str(directory), 'sourceCommit': source, 'packages': manifests})
    catalog = subprocess.check_output(['git', 'show', source + ':docs/templates/mutual-source-templates.json'], cwd=ROOT)
    (directory / 'mutual-source-templates.json').write_bytes(catalog)
    (directory / 'Dockerfile.reader-test').write_text(
        'ARG RUNTIME_IMAGE\nFROM ${RUNTIME_IMAGE}\nRUN pip install --no-cache-dir --no-deps --target /test-deps pypdf==6.20.0\nCOPY mutual-source-templates.json /app/docs/templates/mutual-source-templates.json\nENV PYTHONPATH=/test-deps:/app/backend\n', encoding='utf-8')
    steps = []
    for kind in images:
        steps.append({'name': 'gcr.io/cloud-builders/docker', 'id': 'build-' + kind,
                      'args': ['build', '-t', images[kind], kind]})
        reader = images[kind] + '-reader-tests'
        steps.append({'name': 'gcr.io/cloud-builders/docker', 'id': 'prepare-' + kind + '-test-only-reader',
            'args': ['build', '-f', 'Dockerfile.reader-test', '--build-arg', 'RUNTIME_IMAGE=' + images[kind], '-t', reader, '.']})
        base = ['run', '--rm', '--network', 'none', '--read-only',
                '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m', '--tmpfs', '/app/output:rw,noexec,nosuid,size=32m',
                '-e', 'APP_ENV=test', '-e', 'AUTO_MIGRATE=false', '-e', 'DATABASE_URL=sqlite://',
                '-e', 'UPLOAD_DIR=/tmp/uploads', '-e', 'REGISTRATION_EMAIL_ENABLED=false',
                '-e', 'REPORT_PDF_EMAIL_WORKER_ENABLED=false', '--entrypoint', 'python']
        tests = ['registration_email_test.py', 'invitation_email_test.py', 'report_pdf_email_test.py', 'supervisor_report_submission_test.py', 'report_corrections_test.py', 'report_export_test.py', 'report_workflow_test.py', 'template_source_support_test.py', 'invitation_test.py']
        if kind == 'candidate': tests += ['staff_invitation_test.py']
        for test in tests:
            steps.append({'name': 'gcr.io/cloud-builders/docker', 'id': kind + '-' + test.replace('_', '-'),
                          'args': [*base, reader, '/app/backend/' + test]})
        if kind == 'fallback':
            steps.append({'name': 'gcr.io/cloud-builders/docker', 'id': 'fallback-staff-guard-and-existing-acceptance',
                          'args': [*base, images[kind], '-c', (OUT / 'fallback_compatibility_test.py').read_text(encoding='utf-8')]})
    config = {'steps': steps, 'images': list(images.values()), 'tags': ['reportflow-staff-invitations-20261023'],
              'options': {'logging': 'CLOUD_LOGGING_ONLY'}, 'timeout': '1800s'}
    (directory / 'cloudbuild.json').write_text(json.dumps(config, indent=2) + '\n', encoding='utf-8')
    write('build-configuration.json', config)
    write('build-request.json', {'requestedAtUtc': datetime.now(timezone.utc).isoformat(), 'sourceCommit': source,
                                'directory': str(directory), 'images': images, 'status': 'requested'})
    result = subprocess.run([shutil.which('gcloud.cmd'), 'builds', 'submit', str(directory), '--config', str(directory / 'cloudbuild.json'),
        '--project', PROJECT, '--region', REGION, '--async', '--format=json', '--quiet'],
        capture_output=True, encoding='utf-8', errors='replace', timeout=180)
    assert result.returncode == 0, 'Build result unconfirmed; inspect matching tagged build before retry'
    data = json.loads(result.stdout); write('build-submission.json', data)
    print(json.dumps({'buildId': data['id'], 'status': data['status'], 'logUrl': data.get('logUrl')}))


if __name__ == '__main__':
    main()
