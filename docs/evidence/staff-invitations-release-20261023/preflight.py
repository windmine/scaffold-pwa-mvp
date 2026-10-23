"""Read-only release baseline. Never read secret payloads or print environment values."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
import copy
import hashlib
import json
import os
import shutil
import subprocess

OUT = Path(__file__).resolve().parent
PROJECT = 'geo-attendance-system-db9ca'
REGION = 'australia-southeast1'


def cloud(args):
    result = subprocess.run([shutil.which('gcloud.cmd'), *args, '--project', PROJECT,
        '--format=json', '--quiet'], capture_output=True, encoding='utf-8', errors='replace',
        timeout=120, env={**os.environ, 'CLOUDSDK_CORE_LOG_HTTP': 'false'})
    if result.returncode:
        raise RuntimeError('Read-only provider check failed: ' + ' '.join(args[:3]))
    return json.loads(result.stdout) if result.stdout.strip() else {}


def safe(value):
    value = copy.deepcopy(value)
    def visit(node):
        if isinstance(node, list):
            for item in node:
                visit(item)
        elif isinstance(node, dict):
            if isinstance(node.get('env'), list):
                for item in node['env']:
                    if 'value' in item:
                        item['valueSha256'] = hashlib.sha256(item.pop('value').encode()).hexdigest()
                node['env'].sort(key=lambda item: item['name'])
            for item in node.values():
                visit(item)
    visit(value)
    return value


def main():
    assert not (OUT / 'preflight.json').exists(), 'Preserve the initial baseline'
    requests = {
        'service': ['run', 'services', 'describe', 'geo-backend', '--region', REGION],
        'serviceIam': ['run', 'services', 'get-iam-policy', 'geo-backend', '--region', REGION],
        'worker': ['run', 'jobs', 'describe', 'reportflow-pdf-email', '--region', REGION],
        'workerIam': ['run', 'jobs', 'get-iam-policy', 'reportflow-pdf-email', '--region', REGION],
        'scheduler': ['scheduler', 'jobs', 'describe', 'reportflow-pdf-email', '--location', REGION],
        'smtpSecretIam': ['secrets', 'get-iam-policy', 'reportflow-smtp-password'],
        'smtpSecretVersion': ['secrets', 'versions', 'describe', '1', '--secret', 'reportflow-smtp-password'],
        'projectIam': ['projects', 'get-iam-policy', PROJECT],
    }
    with ThreadPoolExecutor(max_workers=4) as pool:
        values = dict(zip(requests, pool.map(cloud, requests.values())))
    live = values['service']
    runtime = live['spec']['template']['spec']
    assert runtime['serviceAccountName'] == 'geo-backend-runtime@' + PROJECT + '.iam.gserviceaccount.com'
    env = {item['name']: item for item in runtime['containers'][0]['env']}
    assert env['AUTO_MIGRATE']['value'] == 'false'
    assert env['REGISTRATION_EMAIL_ENABLED']['value'] == 'false'
    assert env['SMTP_PASSWORD']['valueFrom']['secretKeyRef'] == {'name': 'reportflow-smtp-password', 'key': '1'}
    assert values['smtpSecretVersion']['state'] == 'ENABLED'
    baseline = {'atUtc': datetime.now(timezone.utc).isoformat(), 'runtime': safe(runtime),
                'templateMetadata': live['spec']['template']['metadata'], 'status': live['status'],
                'serviceIam': values['serviceIam']}
    (OUT / 'baseline-service.json').write_text(json.dumps(baseline, indent=2) + '\n', encoding='utf-8')
    values['projectIamSha256'] = hashlib.sha256(json.dumps(values.pop('projectIam'), sort_keys=True).encode()).hexdigest()
    result = {'atUtc': baseline['atUtc'], 'status': 'read_only_complete',
              'productionChanged': False, 'secretPayloadRead': False, **safe(values)}
    (OUT / 'preflight.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': result['status'], 'traffic': live['status']['traffic'],
                      'schedulerState': values['scheduler']['state'],
                      'workerImage': values['worker']['spec']['template']['spec']['template']['spec']['containers'][0]['image']}))


if __name__ == '__main__':
    main()
