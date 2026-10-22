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
OUT = ROOT / 'docs/evidence/source-templates-release-20261023'
PROJECT = 'geo-attendance-system-db9ca'
REGION = 'australia-southeast1'
SERVICE = 'geo-backend'
SOURCE = json.loads((OUT / 'source-ci-id.json').read_text(encoding='utf-8-sig'))['sourceCommit']
HOST = 'https://geo-attendance-system-db9ca.web.app'
BUILD = None
ACCOUNT = 'geo-backend-runtime@geo-attendance-system-db9ca.iam.gserviceaccount.com'
SCRATCH = ROOT / 'output/browser-checks/source-templates-release'
SCRATCH.mkdir(parents=True, exist_ok=True)
tempfile.tempdir = str(SCRATCH)


def now():
    return datetime.now(timezone.utc).isoformat()


def read(name):
    return json.loads((OUT / name).read_text(encoding='utf-8-sig'))


def write(name, value):
    # Acquire one-attempt operation journals atomically, including if a second
    # operator is accidentally started between the earlier guard and this write.
    mode = 'x' if name.endswith('-request.json') else 'w'
    with (OUT / name).open(mode, encoding='utf-8', newline='\n') as handle:
        handle.write(json.dumps(value, indent=2) + '\n')


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
    build_id = read('build-submission.json')['id']
    build = cloud('builds', 'describe', build_id, '--region', REGION)
    write('build-final.json', build)
    assert build['status'] == 'SUCCESS', build['status']
    assert all(step['status'] == 'SUCCESS' for step in build['steps'])
    assert build['serviceAccount'].endswith('/794826041820-compute@developer.gserviceaccount.com')
    images = {}
    for kind, package in read('source-packages.json')['packages'].items():
        row = next(r for r in build['results']['images'] if r['name'] == package['imageTag'])
        images[kind] = row['name'].rsplit(':', 1)[0] + '@' + row['digest']
    write('images.json', {'sourceCommit': SOURCE, 'buildId': build_id, 'images': images, 'mockedTestsPassed': True})
    print(json.dumps({'status': 'passed', 'build': build_id, 'images': images}))

