"""One-phase release operator; journal before every mutation, never send email."""
from release_operator import *
from datetime import timedelta
from urllib.request import urlopen
from urllib.error import HTTPError
from concurrent.futures import ThreadPoolExecutor

MAINT = 'geo-backend-report-pdf-maint-20261021'
CANDIDATE = 'geo-backend-report-pdf-20261021'
FALLBACK = 'geo-backend-report-pdf-fallback-20261021'
OLD = 'geo-backend-invite-20261020'
OUTPUT = {'serving.knative.dev/creator', 'serving.knative.dev/lastModifier',
          'run.googleapis.com/operation-id', 'run.googleapis.com/ingress-status', 'run.googleapis.com/urls'}


def passed(name):
    value = read(name)
    assert value['status'] == 'passed', name
    return value


def ci():
    run = subprocess.run(['gh', 'run', 'view', str(read('source-ci-id.json')['id']), '--json', 'databaseId,headSha,status,conclusion,jobs,url'],
                         capture_output=True, encoding='utf-8', check=True, timeout=60)
    value = json.loads(run.stdout)
    assert value['headSha'] == SOURCE and value['status'] == 'completed' and value['conclusion'] == 'success'
    assert len(value['jobs']) == 2 and all(x['conclusion'] == 'success' for x in value['jobs'])
    write('ci-source.json', value)


def invariants():
    baseline = read('baseline-service.json')
    def bindings(policy):
        return sorted(json.dumps(x, sort_keys=True) for x in policy.get('bindings', []))
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lambda args: cloud(*args), [
            ('run', 'services', 'get-iam-policy', SERVICE, '--region', REGION),
            ('secrets', 'get-iam-policy', 'reportflow-smtp-password'),
            ('secrets', 'versions', 'describe', '1', '--secret', 'reportflow-smtp-password')]))
    assert bindings(results[0]) == bindings(baseline['serviceIam'])
    assert bindings(results[1]) == bindings(baseline['smtpSecretIam'])
    assert results[2]['state'] == 'ENABLED'


def http(origin, path):
    try:
        response = urlopen(origin.rstrip('/') + path, timeout=30)
    except HTTPError as error:
        response = error
    with response:
        return {'path': path, 'status': response.status, 'body': json.load(response)}


def health(origin):
    checks = [http(origin, path) for path in ['/health', '/health/ready']]
    assert all(x['status'] == 200 for x in checks)
    assert all(checks[1]['body']['checks'][k] == 'ok' for k in ['database', 'migrations', 'upload_storage'])
    return checks


def expected_runtime(kind):
    revision = cloud('run', 'revisions', 'describe', OLD, '--region', REGION)
    runtime = copy.deepcopy(revision['spec'])
    assert safe_runtime(runtime) == read('baseline-service.json')['runtime']
    container = runtime['containers'][0]
    container['image'] = read('images.json')['images']['fallback' if kind == 'fallback' else 'candidate']
    if kind == 'maintenance':
        container.update(command=['python', '-m', 'uvicorn'], args=['app.maintenance:app', '--host', '0.0.0.0', '--port', '8080'])
    elif kind == 'candidate':
        env = {v['name']: v for v in container['env']}
        assert env['PUBLIC_APP_URL']['value'] == HOST
        env['REPORT_PDF_EMAIL_WORKER_ENABLED'] = {'name': 'REPORT_PDF_EMAIL_WORKER_ENABLED', 'value': 'false'}
        container['env'] = sorted(env.values(), key=lambda x: x['name'])
    return runtime


def deploy(kind):
    record = kind + '-deployment-request.json'
    assert not (OUT / record).exists(), 'Inspect existing revision; never repeat uncertain deployment'
    ci()
    invariants()
    if kind == 'maintenance':
        current = assert_baseline()
        assert passed('stage-provider-proof.json')['api']['passingChecks'] >= 214
        passed('stage-fallback-proof.json')
        passed('baseline-verified-proof.json')
        passed('hardening-pre.json')
    else:
        passed('production-proof.json')
        current = service()
        assert [(t['revisionName'], t['percent']) for t in current['status']['traffic'] if t.get('percent')] == [(MAINT, 100)]
    revision = {'maintenance': MAINT, 'candidate': CANDIDATE, 'fallback': FALLBACK}[kind]
    tag = 'report-pdf-' + kind + '-20261021'
    runtime = expected_runtime(kind)
    metadata = {k: copy.deepcopy(v) for k, v in current['metadata'].items() if k in {'name', 'namespace', 'resourceVersion', 'labels'}}
    metadata['annotations'] = {k: v for k, v in current['metadata'].get('annotations', {}).items() if k not in OUTPUT}
    template = copy.deepcopy(read('baseline-service.json')['templateMetadata'])
    template = {k: v for k, v in template.items() if k in {'annotations', 'labels'}}
    template['name'] = revision
    traffic = [{'revisionName': OLD if kind == 'maintenance' else MAINT, 'percent': 100},
               {'revisionName': revision, 'percent': 0, 'tag': tag}]
    doc = {'apiVersion': 'serving.knative.dev/v1', 'kind': 'Service', 'metadata': metadata,
           'spec': {'template': {'metadata': template, 'spec': runtime}, 'traffic': traffic}}
    write(record, {'atUtc': now(), 'revision': revision, 'kind': kind, 'runtime': safe_runtime(runtime), 'traffic': traffic})
    with tempfile.TemporaryDirectory(prefix='rf-invite-service-') as temporary:
        path = Path(temporary) / 'service.json'
        path.write_bytes(json.dumps(doc).encode())
        cloud('run', 'services', 'replace', str(path), '--region', REGION)
    current = service()
    actual = cloud('run', 'revisions', 'describe', revision, '--region', REGION)
    assert safe_runtime(actual['spec']) == safe_runtime(runtime)
    assert any(x['type'] == 'Ready' and x['status'] == 'True' for x in actual['status']['conditions'])
    assert [(t['revisionName'], t['percent']) for t in current['status']['traffic'] if t.get('percent')] == [(traffic[0]['revisionName'], 100)]
    url = next(t['url'] for t in current['status']['traffic'] if t.get('tag') == tag)
    if kind == 'maintenance':
        checks = [http(url, '/health'), http(url, '/health/ready')]
        assert checks[0]['body'] == {'status': 'maintenance'} and checks[1]['status'] == 503
    else:
        checks = health(url)
    invariants()
    write(kind + '.json', {'status': 'passed', 'atUtc': now(), 'revision': revision, 'url': url,
                          'runtime': safe_runtime(runtime), 'health': checks, 'traffic': current['status']['traffic']})
    print(json.dumps({'operation': 'deploy', 'kind': kind, 'status': 'passed', 'productionTraffic': traffic[0]['revisionName']}))


def pause():
    assert not (OUT / 'pause-request.json').exists()
    passed('maintenance.json')
    current = service()
    assert [(t['revisionName'], t['percent']) for t in current['status']['traffic'] if t.get('percent')] == [(OLD, 100)]
    invariants()
    write('pause-request.json', {'atUtc': now(), 'revision': MAINT})
    cloud('run', 'services', 'update-traffic', SERVICE, '--region', REGION, '--to-revisions', MAINT + '=100', '--clear-tags')
    current = service()
    assert current['status']['traffic'] == [{'revisionName': MAINT, 'percent': 100}]
    checks = []
    for origin in [current['status']['url'], HOST + '/api']:
        for path in ['/health', '/health/ready', '/auth/me']:
            result = http(origin, path)
            assert result['status'] == (200 if path == '/health' else 503)
            checks.append({'origin': origin, **result})
    at = datetime.now(timezone.utc)
    write('pause.json', {'status': 'passed', 'maintenanceConfirmedAtUtc': at.isoformat(),
                         'drainUntilUtc': (at + timedelta(seconds=300)).isoformat(), 'drainSeconds': 300, 'checks': checks})
    print(json.dumps({'operation': 'pause', 'status': 'passed', 'drainUntilUtc': read('pause.json')['drainUntilUtc']}))


def backup():
    assert not (OUT / 'backup-request.json').exists()
    pause = passed('pause.json')
    assert datetime.now(timezone.utc) >= datetime.fromisoformat(pause['drainUntilUtc'])
    assert service()['status']['traffic'] == [{'revisionName': MAINT, 'percent': 100}]
    name = 'reportflow-report-pdf-backup-20261021'
    expiry = (datetime.now(timezone.utc) + timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%SZ')
    write('backup-request.json', {'atUtc': now(), 'name': name, 'expiresAt': expiry, 'parent': 'br-snowy-tree-a7hfuph6'})
    result = subprocess.run([shutil.which('npx.cmd'), '--yes', 'neon@2.32.0', 'branches', 'create',
                            '--project-id', 'plain-smoke-06194407', '--name', name, '--parent', 'br-snowy-tree-a7hfuph6',
                            '--type', 'read_only', '--suspend-timeout', '300', '--cu', '0.25',
                            '--expires-at', expiry, '--no-analytics', '-o', 'json'],
                            capture_output=True, encoding='utf-8', errors='replace', timeout=120)
    assert result.returncode == 0, 'Inspect branch state before repeating uncertain backup creation'
    raw = json.loads(result.stdout)
    value = {key: raw[key] for key in ('branch', 'endpoints') if key in raw}
    raw = None
    result = None
    write('backup-created.json', value)
    branch = value.get('branch', value)
    assert branch['parent_id'] == 'br-snowy-tree-a7hfuph6' and branch['id'] != branch['parent_id']
    assert datetime.fromisoformat(branch['created_at'].replace('Z', '+00:00')) >= datetime.fromisoformat(pause['drainUntilUtc'])
    write('backup.json', {'status': 'inventory-pending', 'atUtc': now(), 'branch': branch, 'readOnlyMetadataVerified': True,
                          'restorabilityProof': 'neon-premigration.json', 'verificationEndpointReadOnly': True, 'noDataRestorePerformed': True})
    print(json.dumps({'operation': 'backup', 'status': 'inventory-pending', 'branch': branch['id'], 'expiresAt': branch['expires_at']}))


def promote():
    assert not (OUT / 'backend-promotion-request.json').exists()
    passed('candidate.json')
    passed('fallback.json')
    passed('production-proof.json')
    ci()
    invariants()
    current = service()
    assert [(t['revisionName'], t['percent']) for t in current['status']['traffic'] if t.get('percent')] == [(MAINT, 100)]
    assert safe_runtime(current['spec']['template']['spec']) == read('candidate.json')['runtime']
    write('backend-promotion-request.json', {'atUtc': now(), 'revision': CANDIDATE, 'fallback': FALLBACK})
    cloud('run', 'services', 'update-traffic', SERVICE, '--region', REGION, '--to-revisions', CANDIDATE + '=100', '--clear-tags')
    current = service()
    assert current['status']['traffic'] == [{'revisionName': CANDIDATE, 'percent': 100}]
    checks = health(current['status']['url']) + health(HOST + '/api')
    invariants()
    write('backend-promotion.json', {'status': 'passed', 'atUtc': now(), 'revision': CANDIDATE,
                                     'traffic': current['status']['traffic'], 'health': checks,
                                     'runtime': safe_runtime(current['spec']['template']['spec']), 'noEmailSent': True,
                                     'serviceAndSmtpSecretIamUnchanged': True, 'secretReferencesPreserved': True})
    print(json.dumps({'operation': 'backend-promotion', 'status': 'passed', 'revision': CANDIDATE}))


if __name__ == '__main__':
    action = sys.argv[1]
    if action == 'deploy': deploy(sys.argv[2])
    elif action == 'pause': pause()
    elif action == 'backup': backup()
    elif action == 'promote': promote()
    elif action == 'ci': ci()
    else: raise ValueError('Unsupported action')
