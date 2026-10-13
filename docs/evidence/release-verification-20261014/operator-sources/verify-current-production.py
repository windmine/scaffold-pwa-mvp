"""Read-only exact production/build verification; no deployment or fixture writes."""
import argparse
import concurrent.futures
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / 'docs/evidence/release-verification-20261014'
BASELINE = EVIDENCE / 'backend-baseline.json'
OLD_FRONTEND = ROOT / 'docs/evidence/frontend-release-20261012'
OLD_BACKEND = ROOT / 'docs/evidence/report-fixes-release-20261012'
SOURCE = 'e1501d4c91d567521c9dce4d112a0ef15f19c97b'
PROJECT = 'geo-attendance-system-db9ca'
DIRECT = 'https://geo-backend-eitdijn7cq-ts.a.run.app'
HOSTING = 'https://geo-attendance-system-db9ca.web.app'


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def digest(content):
    return hashlib.sha256(content).hexdigest()


def artifact(path):
    return {'path': path.relative_to(ROOT).as_posix(), 'sha256': digest(path.read_bytes()),
            'bytes': path.stat().st_size}


def safe_failure(error):
    return str(error) if isinstance(error, RuntimeError) and re.fullmatch(r'[a-z0-9_]+', str(error)) else type(error).__name__


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def anonymous_get(origin, path, maximum_bytes=131072):
    require(origin in {DIRECT, HOSTING}, 'http_origin_not_allowlisted')
    require(path.startswith('/') and not path.startswith('//'), 'invalid_http_path')
    request = Request(origin + path, method='GET', headers={'Cache-Control': 'no-cache'})
    try:
        response = build_opener(NoRedirect()).open(request, timeout=45)
    except HTTPError as error:
        response = error
    with response:
        require(response.geturl() == request.full_url, 'http_response_redirected')
        body = response.read(maximum_bytes + 1)
        require(len(body) <= maximum_bytes, 'http_response_too_large')
        return response.code, response.headers.get('Cache-Control'), body


def dist_files():
    return {path.relative_to(ROOT / 'dist').as_posix(): digest(path.read_bytes())
            for path in sorted((ROOT / 'dist').rglob('*')) if path.is_file()}


def channels(op):
    data = op.command('npx', ['-y', 'firebase-tools@latest', 'hosting:channel:list',
                             '--project', PROJECT, '--non-interactive', '--json'], timeout=300)
    require(data.get('status') == 'success', 'firebase_channel_listing_failed')
    result = data.get('result', {}).get('channels')
    require(isinstance(result, list), 'firebase_channel_listing_invalid')
    prefix = f'projects/{PROJECT}/sites/{PROJECT}/channels/'
    safe = []
    for channel in result:
        require(channel.get('name', '').startswith(prefix), 'unexpected_hosting_channel')
        release = channel.get('release', {})
        version = release.get('version', {})
        safe.append({'name': channel['name'], 'url': channel.get('url'),
                     'expireTime': channel.get('expireTime'), 'version': version.get('name'),
                     'versionStatus': version.get('status'), 'releaseTime': release.get('releaseTime')})
    live = [item for item in result if item.get('name') == prefix + 'live']
    require(len(live) == 1, 'hosting_live_channel_not_unique')
    return live[0], safe


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', type=Path, default=EVIDENCE / 'current-production.json')
    args = parser.parse_args()
    path = args.evidence.resolve()
    require(path.parent == EVIDENCE.resolve() and path.suffix == '.json', 'evidence_outside_release_directory')
    require(not path.exists(), 'new_evidence_file_required')
    spec = importlib.util.spec_from_file_location('release_operator', ROOT / 'scripts/report-release-operator.py')
    op = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(op)
    baseline = read(BASELINE)
    historical = read(OLD_FRONTEND / 'backend-baseline.json')
    backend = read(OLD_BACKEND / 'release.json')
    frontend = read(OLD_FRONTEND / 'release.json')
    old_manifest = read(OLD_FRONTEND / 'build-manifest.json')
    require(baseline.get('status') == 'passed' and baseline.get('phase') == 'snapshot'
            and baseline.get('migrationMode') == 'none', 'fresh_no_migration_snapshot_required')
    require(all(item.get('status') == 'passed' for item in (historical, backend, frontend)), 'historical_release_not_passed')
    require(op.command('git', ['-C', str(ROOT), 'rev-parse', 'HEAD'], json_output=False) == SOURCE, 'source_head_changed')
    runtime_paths = ['backend/app', 'backend/migrations', 'Dockerfile', 'requirements.txt']
    require(not op.command('git', ['-C', str(ROOT), 'diff', '--name-only', backend['sourceCommit'],
                                  SOURCE, '--', *runtime_paths], json_output=False), 'backend_runtime_source_changed')
    require(not op.command('git', ['-C', str(ROOT), 'status', '--porcelain', '--', *runtime_paths,
                                  'firebase.json', 'package.json', 'package-lock.json'], json_output=False), 'release_input_dirty')
    op.assert_full_candidate_inventory(baseline['inventory'])
    require(baseline['inventory']['migrationCount'] == 22
            and baseline['inventory']['migrationHead'] == '0022_worker_password_recovery', 'unexpected_migration_ledger')
    require(baseline['live'] == historical['live']
            and baseline['live']['revision'] == backend['revision'] == frontend['backendRevision']
            and baseline['live']['image'] == backend['image'] == frontend['backendImage']
            and historical['build']['id'] == backend['buildId'], 'backend_release_identity_mismatch')
    config = read(ROOT / 'firebase.json')
    committed_config = json.loads(op.command('git', ['-C', str(ROOT), 'show', SOURCE + ':firebase.json'], json_output=False))
    require(config == committed_config, 'firebase_config_not_committed')
    hosting = config['hosting']
    require(hosting['public'] == 'dist' and set(hosting) == {'public', 'ignore', 'headers', 'rewrites'}, 'unexpected_hosting_config')
    effective = {'headers': [{'glob': item['source'], 'headers': {header['key']: header['value'] for header in item['headers']}}
                             for item in hosting['headers']],
                 'rewrites': [{'glob': item['source'], 'run': item['run']} for item in hosting['rewrites']]}
    local = dist_files()
    require(len(local) == old_manifest['distFileCount'] == 85
            and local == old_manifest['distFileSha256'], 'fresh_dist_differs_from_released_manifest')
    bindings = [BASELINE, OLD_FRONTEND / 'backend-baseline.json', OLD_FRONTEND / 'release.json',
                OLD_FRONTEND / 'build-manifest.json', OLD_BACKEND / 'release.json',
                Path(__file__).resolve(), ROOT / 'scripts/report-release-operator.py',
                ROOT / 'scripts/report-release-inventory.py', ROOT / 'firebase.json',
                ROOT / 'package.json', ROOT / 'package-lock.json']
    bound = [artifact(item) for item in bindings]
    proof = {'schemaVersion': 1, 'status': 'running', 'startedAtUtc': op.now(),
             'sourceCommit': SOURCE, 'backendSourceCommit': backend['sourceCommit'],
             'scope': 'Read-only exact current production and fresh frontend build verification; no promotion is attempted.',
             'inputArtifacts': bound, 'backendRuntimeSourceUnchanged': True,
             'frontendMatchesReleased85FileManifest': True, 'distFileSha256': local,
             'anonymousHttpChecks': [], 'assets': [], 'hostedWritesPerformed': False,
             'deploymentPerformed': False, 'authenticatedUserRequests': False,
             'applicationFixturesCreated': False, 'migrationPerformed': False,
             'limitations': [
                 'Observed database fields compare only against this release attempt fresh baseline, not October 12; real activity between those dates is allowed.',
                 'A failed fresh inventory comparison can represent concurrent user activity; it does not authorize database changes or a claim of corruption.',
                 'The inventory is hashed/count-based coverage, not an exhaustive database backup. Cloud Run annotations use the existing selected-annotation coverage.',
                 'No new service-worker version is published, so a new old-to-new waiting-update result is neither attempted nor claimed.',
                 'Anonymous HTTP parity does not establish authenticated hosted workflows or physical-phone behavior.'
             ]}
    with path.open('x', encoding='utf-8') as file:
        json.dump(proof, file, indent=2)
        file.write('\n')

    def save():
        path.write_text(json.dumps(proof, indent=2) + '\n', encoding='utf-8', newline='\n')

    stage = 'runtime_and_iam_before'
    try:
        live_before = op.live_snapshot()
        require(live_before == baseline['live'], 'backend_changed_since_fresh_snapshot')
        iam_before = op.sha(op.cloud('run', 'services', 'get-iam-policy', op.PRODUCTION, '--region', op.REGION))
        require(iam_before == historical['iamSha256'], 'backend_iam_changed_from_released_baseline')
        proof.update(live=live_before, iamSha256=iam_before)
        stage = 'build_identity'
        build = op.cloud('builds', 'describe', backend['buildId'], '--region', op.REGION)
        require(build['status'] == 'SUCCESS' and build['id'] == historical['build']['id']
                and build['source'] == historical['build']['source']
                and any(item.get('digest') == live_before['image'].split('@', 1)[1]
                        for item in build['results']['images']), 'backend_build_identity_changed')
        proof['build'] = historical['build']
        stage = 'hosting_identity_before'
        live_channel, safe_channels = channels(op)
        expected_version = f'projects/{PROJECT}/sites/{PROJECT}/versions/' + frontend['hostingVersion']
        require(live_channel['url'] == HOSTING
                and live_channel['release']['version']['name'] == expected_version
                and live_channel['release']['version']['status'] == 'FINALIZED'
                and live_channel['release']['version']['config'] == effective, 'hosting_identity_or_config_changed')
        proof.update(hostingVersion=frontend['hostingVersion'], hostingEffectiveConfig=effective,
                     hostingChannels=safe_channels)
        save()
        stage = 'anonymous_backend_http'
        for origin, prefix in ((DIRECT, ''), (HOSTING, '/api')):
            for suffix, expected_status in (('/health', 200), ('/health/ready', 200), ('/sites', 401),
                                           ('/my-form-submissions?purpose=report', 401),
                                           ('/supervisor/form-submissions?purpose=report', 401),
                                           ('/supervisor/form-submissions/export.pdf?purpose=report', 401)):
                target = prefix + suffix
                status, cache_control, body = anonymous_get(origin, target)
                check = {'origin': origin, 'path': target, 'status': status, 'cacheControl': cache_control}
                proof['anonymousHttpChecks'].append(check)
                require(status == expected_status, 'anonymous_http_status_mismatch')
                if suffix in {'/health', '/health/ready'}:
                    payload = json.loads(body)
                    require(payload.get('status') == 'ok', 'health_not_ok')
                    if suffix == '/health/ready':
                        require(all(payload.get('checks', {}).get(key) == 'ok'
                                    for key in ('database', 'migrations', 'upload_storage'))
                                and payload.get('details', {}).get('upload_storage', {}).get('backend') == 'gcs', 'readiness_dependencies_not_ok')
                        check['readiness'] = {'status': 'ok', 'checks': {key: payload['checks'][key]
                                               for key in ('database', 'migrations', 'upload_storage')}, 'uploadStorageBackend': 'gcs'}
                save()
            target = '/uploads/release-verification-20261014-absent.png'
            status, cache_control, _body = anonymous_get(origin, target)
            proof['anonymousHttpChecks'].append({'origin': origin, 'path': target, 'status': status, 'cacheControl': cache_control})
            require(status == 401 and cache_control and 'private' in cache_control and 'no-store' in cache_control, 'anonymous_upload_privacy_mismatch')
            save()

        stage = 'all_dist_http_parity'
        def check_asset(name):
            content = (ROOT / 'dist' / name).read_bytes()
            require(digest(content) == local[name], 'dist_changed_during_http_parity')
            status, cache_control, remote = anonymous_get(HOSTING, '/' + quote(name, safe='/'), len(content))
            require(status == 200 and len(remote) == len(content) and digest(remote) == local[name], 'dist_http_asset_mismatch')
            return {'path': '/' + name, 'sha256': local[name], 'bytes': len(content), 'status': status, 'cacheControl': cache_control}
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            proof['assets'] = list(pool.map(check_asset, local))
        require(len(proof['assets']) == 85, 'incomplete_dist_http_parity')
        save()
        stage = 'fresh_database_inventory'
        database_url = op.read_secret('geo-backend-database-url', '2')
        try:
            require(op.sha(op.validate_url(database_url)) == baseline['databaseHostSha256'], 'production_database_target_changed')
            inventory = op.inventory(database_url)
        finally:
            database_url = None
        proof['inventory'] = inventory
        proof['inventoryChangedFields'] = sorted(key for key in set(baseline['inventory']) | set(inventory)
                                                if key != 'recordedAtUtc' and baseline['inventory'].get(key) != inventory.get(key))
        save()
        op.assert_no_migration_preserved(baseline['inventory'], inventory)
        stage = 'final_identity_and_input_stability'
        require(op.live_snapshot() == live_before, 'backend_changed_during_verification')
        require(op.sha(op.cloud('run', 'services', 'get-iam-policy', op.PRODUCTION, '--region', op.REGION)) == iam_before, 'iam_changed_during_verification')
        final_live, _safe_channels = channels(op)
        require(final_live['release']['version'] == live_channel['release']['version']
                and final_live['release']['name'] == live_channel['release']['name'], 'hosting_changed_during_verification')
        require(dist_files() == local and [artifact(item) for item in bindings] == bound, 'verification_input_changed')
        require(op.command('git', ['-C', str(ROOT), 'rev-parse', 'HEAD'], json_output=False) == SOURCE, 'source_head_changed_during_verification')
        require(not op.command('git', ['-C', str(ROOT), 'status', '--porcelain', '--', *runtime_paths,
                                      'firebase.json', 'package.json', 'package-lock.json'], json_output=False), 'release_input_changed_during_verification')
        proof.update(status='passed', runtimeTrafficIamAndBuildUnchanged=True,
                     full85FileHttpParity=True, observedInventoryUnchangedFromFreshBaseline=True,
                     inventoryExcludedFields=['recordedAtUtc'], all22MigrationChecksumsUnchanged=True,
                     anonymousDirectAndHostingCheckCount=len(proof['anonymousHttpChecks']),
                     sourceAndProofInputsUnchanged=True, productionIdentityUnchangedDuringRead=True)
    except Exception as error:
        proof.update(status='failed', failure={'stage': stage, 'code': safe_failure(error)})
    finally:
        proof['completedAtUtc'] = op.now()
        save()
    print(json.dumps({'status': proof['status'], 'evidence': path.relative_to(ROOT).as_posix(),
                      'httpChecks': len(proof['anonymousHttpChecks']), 'assetCount': len(proof['assets']),
                      'failure': proof.get('failure'), 'sha256': digest(path.read_bytes())}))
    return 0 if proof['status'] == 'passed' else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({'status': 'refused', 'code': safe_failure(error)}))
        sys.exit(1)
