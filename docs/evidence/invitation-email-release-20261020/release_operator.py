"""Journaled release helpers. No SMTP calls, secret-payload reads or IAM writes."""
from datetime import datetime, timezone
from pathlib import Path
import copy
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = Path.cwd()
OUT = ROOT / 'docs/evidence/invitation-email-release-20261020'
PROJECT = 'geo-attendance-system-db9ca'
REGION = 'australia-southeast1'
SERVICE = 'geo-backend'
SOURCE = '2f861c569949e5f91e29748d7ab47c672c7beef1'
HOST = 'https://geo-attendance-system-db9ca.web.app'
BUILD = '04840382-49f1-49bb-8e4c-15a958822bae'
ACCOUNT = 'geo-backend-runtime@geo-attendance-system-db9ca.iam.gserviceaccount.com'


def now():
    return datetime.now(timezone.utc).isoformat()


def read(name):
    return json.loads((OUT / name).read_text(encoding='utf-8-sig'))


def write(name, value):
    (OUT / name).write_bytes((json.dumps(value, indent=2) + '\n').encode())


def cloud(*args):
    result = subprocess.run([shutil.which('gcloud.cmd'), *args, '--project', PROJECT, '--format=json', '--quiet'],
                            capture_output=True, encoding='utf-8', errors='replace', timeout=180,
                            env={**os.environ, 'CLOUDSDK_CORE_LOG_HTTP': 'false'})
    if result.returncode:
        raise RuntimeError('Provider operation did not confirm success: ' + ' '.join(args[:3]) + '; inspect state before retry')
    return json.loads(result.stdout) if result.stdout.strip() else {}


def service():
    return cloud('run', 'services', 'describe', SERVICE, '--region', REGION)


def safe_runtime(spec):
    result = copy.deepcopy(spec)
    for container in result['containers']:
        for item in container.get('env', []):
            if 'value' in item:
                item['valueSha256'] = hashlib.sha256(item.pop('value').encode()).hexdigest()
        container['env'] = sorted(container.get('env', []), key=lambda e: e['name'])
    return result


def assert_baseline():
    live = service()
    baseline = read('baseline-service.json')
    assert safe_runtime(live['spec']['template']['spec']) == baseline['runtime']
    assert live['status']['traffic'] == baseline['status']['traffic']
    assert cloud('run', 'services', 'get-iam-policy', SERVICE, '--region', REGION) == baseline['serviceIam']
    return live


def record_build():
    build = cloud('builds', 'describe', BUILD, '--region', REGION)
    write('build-final.json', build)
    assert build['status'] == 'SUCCESS', build['status']
    assert all(step['status'] == 'SUCCESS' for step in build['steps'])
    assert build['serviceAccount'].endswith('/794826041820-compute@developer.gserviceaccount.com')
    images = {}
    for kind, package in read('source-packages.json')['packages'].items():
        row = next(r for r in build['results']['images'] if r['name'] == package['imageTag'])
        images[kind] = row['name'].rsplit(':', 1)[0] + '@' + row['digest']
    write('images.json', {'sourceCommit': SOURCE, 'buildId': BUILD, 'images': images, 'mockedTestsPassed': True})
    print(json.dumps({'status': 'passed', 'build': BUILD, 'images': images}))


def launch_job(mode, suffix, kind='candidate'):
    assert mode in {'inventory', 'stage-inspect', 'stage-migrate', 'stage-check', 'stage-fallback', 'stage-smoke', 'backup-verify', 'production-migrate'}
    name = 'rf-invite-' + suffix + '-20261020'
    record = suffix + '-job-request.json'
    assert not (OUT / record).exists(), 'Inspect existing job/execution outcome; do not repeat'
    existing = cloud('run', 'jobs', 'list', '--region', REGION)
    assert not any(row['metadata']['name'] == name for row in existing)
    if mode == 'production-migrate':
        pause = read('pause.json')
        assert pause['status'] == 'passed' and datetime.now(timezone.utc) >= datetime.fromisoformat(pause['drainUntilUtc'])
        assert read('backup.json')['status'] == 'passed'
        assert read('backup-verified-proof.json')['backupMatchesProduction'] is True
        assert service()['status']['traffic'] == [{'revisionName': 'geo-backend-invite-maint-20261020', 'percent': 100}]
    live = service()
    runtime = copy.deepcopy(live['spec']['template']['spec'])
    assert runtime['serviceAccountName'] == ACCOUNT and len(runtime['containers']) == 1
    container = runtime['containers'][0]
    database = next(e for e in container['env'] if e['name'] == 'DATABASE_URL')
    assert database['valueFrom']['secretKeyRef'] == {'name': 'geo-backend-database-url', 'key': '2'}
    historical = json.loads((ROOT / 'docs/evidence/report-release-20261005/snapshot.json').read_text(encoding='utf-8-sig'))
    env = [database, {'name': 'PROBE_MODE', 'value': mode},
           {'name': 'PRODUCTION_DB_HOST_SHA256', 'value': historical['databaseHostSha256']},
           {'name': 'AUTO_MIGRATE', 'value': 'false'}, {'name': 'REGISTRATION_EMAIL_ENABLED', 'value': 'false'},
           {'name': 'SMTP_HOST', 'value': ''}, {'name': 'SMTP_FROM_EMAIL', 'value': ''}]
    if mode == 'production-migrate':
        snapshot = read('backup-verified-proof.json')['before']
        env.append({'name': 'EXPECTED_BEFORE_SHA256', 'value': hashlib.sha256(json.dumps(snapshot, sort_keys=True, separators=(',', ':')).encode()).hexdigest()})
    if mode.startswith('stage-'):
        stage = read('stage-branch.json')
        assert stage['branch']['parent_id'] == 'br-snowy-tree-a7hfuph6'
        endpoint = stage['endpoints'][0]
        assert endpoint['branch_id'] == stage['branch']['id'] and endpoint['type'] == 'read_write'
        env += [{'name': 'STAGE_DB_HOST', 'value': endpoint['host']}, {'name': 'STAGE_BRANCH_ID', 'value': stage['branch']['id']}]
    if mode == 'backup-verify':
        backup = read('backup-created.json')
        assert backup['branch']['parent_id'] == 'br-snowy-tree-a7hfuph6'
        endpoint = backup['endpoints'][0]
        assert endpoint['branch_id'] == backup['branch']['id'] and endpoint['type'] == 'read_only'
        env += [{'name': 'BACKUP_DB_HOST', 'value': endpoint['host']}, {'name': 'BACKUP_BRANCH_ID', 'value': backup['branch']['id']}]
    code = (OUT / 'runtime_probe.py').read_text(encoding='utf-8')
    for field in ('ports', 'startupProbe', 'livenessProbe', 'readinessProbe'):
        container.pop(field, None)
    container.update(image=read('images.json')['images'][kind], env=env, command=['python'], args=['-c', code])
    runtime.pop('containerConcurrency', None)
    runtime.update(maxRetries=0, timeoutSeconds='600')
    annotations = {k: v for k, v in live['spec']['template']['metadata'].get('annotations', {}).items()
                   if k in {'run.googleapis.com/vpc-access-connector', 'run.googleapis.com/vpc-access-egress',
                            'run.googleapis.com/network-interfaces', 'run.googleapis.com/encryption-key'}}
    document = {'apiVersion': 'run.googleapis.com/v1', 'kind': 'Job', 'metadata': {'name': name},
                'spec': {'template': {'metadata': {'annotations': annotations}, 'spec': {
                    'parallelism': 1, 'taskCount': 1, 'template': {'spec': runtime}}}}}
    write(record, {'atUtc': now(), 'job': name, 'mode': mode, 'image': container['image'],
                   'codeSha256': hashlib.sha256(code.encode()).hexdigest(), 'document': document,
                   'taskCount': 1, 'maxRetries': 0, 'smtpSecretBound': False})
    with tempfile.TemporaryDirectory(prefix='rf-invite-job-') as temporary:
        path = Path(temporary) / 'job.json'
        path.write_bytes((json.dumps(document) + '\n').encode())
        created = cloud('run', 'jobs', 'replace', str(path), '--region', REGION)
    write(suffix + '-job-created.json', created)
    write(suffix + '-execution-request.json', {'atUtc': now(), 'job': name})
    result = cloud('run', 'jobs', 'execute', name, '--region', REGION, '--async')
    write(suffix + '-execution.json', result)
    print(json.dumps({'job': name, 'execution': result['metadata']['name'], 'mode': mode, 'status': 'started'}))


def check_job(suffix):
    request = read(suffix + '-job-request.json')
    execution = read(suffix + '-execution.json')['metadata']['name']
    result = cloud('run', 'jobs', 'executions', 'describe', execution, '--region', REGION)
    write(suffix + '-execution-status.json', result)
    condition = next((x for x in result.get('status', {}).get('conditions', []) if x['type'] == 'Completed'), {})
    logs = cloud('logging', 'read', f'resource.type="cloud_run_job" AND resource.labels.job_name="{request["job"]}" AND labels."run.googleapis.com/execution_name"="{execution}"', '--limit', '100', '--freshness', '2h')
    proofs = []
    for entry in logs:
        value = entry.get('textPayload', '')
        if 'REPORTFLOW_RELEASE_MIGRATION ' in value:
            write(suffix + '-migration-proof.json', json.loads(value.split('REPORTFLOW_RELEASE_MIGRATION ', 1)[1]))
        if 'REPORTFLOW_SMOKE_DIAGNOSIS ' in value:
            diagnosis = json.loads(value.split('REPORTFLOW_SMOKE_DIAGNOSIS ', 1)[1])
            write(suffix + '-smoke-diagnosis.json', diagnosis)
            print(json.dumps({'smokeDiagnosis': diagnosis}))
        for marker in ['REPORTFLOW_RELEASE_PROOF ', 'REPORTFLOW_RELEASE_FAILURE ']:
            if marker in value:
                proofs.append(json.loads(value.split(marker, 1)[1]))
    if proofs:
        assert len(proofs) == 1, 'Unexpected multiple results; do not repeat execution'
        proof = proofs[0]
        write(suffix + '-proof.json', proof)
        if proof['status'] == 'passed' and proof.get('mode') == 'backup-verify':
            backup = read('backup.json')
            backup.update(status='passed', inventoryVerifiedAtUtc=now(), backupMatchesProduction=True)
            write('backup.json', backup)
        print(json.dumps({'job': request['job'], 'completed': condition.get('status'), 'proofStatus': proof['status'],
                          'mode': proof.get('mode'), 'error': proof.get('code'), 'afterHead': proof.get('after', {}).get('migrationHead'),
                          'smoke': proof.get('api', {}).get('passingChecks')}))
    else:
        print(json.dumps({'job': request['job'], 'completed': condition.get('status'), 'reason': condition.get('reason'), 'proof': 'pending'}))


if __name__ == '__main__':
    if sys.argv[1] == 'record-build':
        record_build()
    elif sys.argv[1] == 'launch':
        launch_job(*sys.argv[2:])
    elif sys.argv[1] == 'check':
        check_job(sys.argv[2])
    else:
        raise ValueError('Unsupported action')
