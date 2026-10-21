"""Freeze, preview, verify and promote an exact Hosting version; no Auth writes."""
from release_operator import *
from concurrent.futures import ThreadPoolExecutor
from urllib.request import Request, urlopen
import re

PREVIEW = 'release-report-pdf-20261021'
ROLLBACK = 'rollback-report-pdf-20261021'
PREVIOUS = '4988eacbe73feaaf'


def firebase(*args):
    result = subprocess.run([shutil.which('firebase.cmd'), *args, '--project', PROJECT, '--non-interactive', '--json'],
                            capture_output=True, encoding='utf-8', errors='replace', timeout=300)
    if result.returncode: raise RuntimeError('Hosting operation unconfirmed; inspect state before retry')
    value = json.loads(result.stdout)
    assert value['status'] == 'success'
    return value


def channels():
    return {x['name'].split('/')[-1]: x for x in firebase('hosting:channel:list')['result']['channels']}


def version(channel):
    return channel['release']['version']['name'].split('/')[-1]


def freeze():
    assert not (OUT / 'build-manifest.json').exists()
    assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip() == SOURCE
    assert not subprocess.check_output(['git', 'diff', '--name-only', 'HEAD', '--', 'backend', 'assets', 'index.html', 'sw.js', 'firebase.json'], text=True).strip()
    files = {p.relative_to(ROOT/'dist').as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
             for p in sorted((ROOT/'dist').rglob('*')) if p.is_file()}
    assert len(files) >= 85
    manifest = {'sourceCommit': SOURCE, 'atUtc': now(), 'fileCount': len(files), 'files': files,
                'firebaseConfigSha256': hashlib.sha256((ROOT/'firebase.json').read_bytes()).hexdigest(),
                'cacheVersion': re.search(r'const CACHE_VERSION = [\"\x27]([^\"\x27]+)', (ROOT/'dist/sw.js').read_text()).group(1)}
    write('build-manifest.json', manifest)
    before = channels()
    assert version(before['live']) == PREVIOUS and PREVIEW not in before and ROLLBACK not in before
    write('hosting-baseline.json', before)
    print(json.dumps({'operation': 'freeze', 'files': len(files), 'cache': manifest['cacheVersion']}))


def assert_frozen():
    manifest = read('build-manifest.json')
    for path, digest in manifest['files'].items():
        assert hashlib.sha256((ROOT/'dist'/path).read_bytes()).hexdigest() == digest
    assert hashlib.sha256((ROOT/'firebase.json').read_bytes()).hexdigest() == manifest['firebaseConfigSha256']


def retain():
    assert not (OUT / 'hosting-retention-request.json').exists()
    before = channels()
    assert version(before['live']) == PREVIOUS and ROLLBACK not in before
    write('hosting-retention-request.json', {'atUtc': now(), 'version': PREVIOUS, 'channel': ROLLBACK, 'retentionDays': 7})
    # Use the CLI's authenticated Hosting API without invoking its Auth-domain synchronization.
    root = str(Path(shutil.which('firebase.cmd')).parent / 'node_modules/firebase-tools/lib')
    code = "const root=" + json.dumps(root) + "; (async()=>{await require(root+'/requireAuth').requireAuth({project:" + json.dumps(PROJECT) + ",nonInteractive:true}); const r=await require(root+'/hosting/api').createChannel(" + ','.join(map(json.dumps, [PROJECT, PROJECT, ROLLBACK])) + ",604800000); console.log(JSON.stringify({name:r.name,expireTime:r.expireTime}));})().catch(()=>{process.exitCode=1});"
    result = subprocess.run(['node', '-e', code], capture_output=True, encoding='utf-8', errors='replace', timeout=90)
    assert result.returncode == 0, 'Channel creation unconfirmed; inspect state before retry'
    created = channels()
    assert ROLLBACK in created
    write('hosting-retention-channel.json', created[ROLLBACK])
    firebase('hosting:clone', PROJECT+'@'+PREVIOUS, PROJECT+':'+ROLLBACK)
    after = channels()
    assert version(after[ROLLBACK]) == PREVIOUS and version(after['live']) == PREVIOUS
    write('hosting-retention.json', {'status': 'passed', 'atUtc': now(), 'channel': after[ROLLBACK], 'authDomainsChanged': False})
    print(json.dumps({'operation': 'retain', 'status': 'passed', 'version': PREVIOUS, 'expiresAt': after[ROLLBACK]['expireTime']}))


def preview():
    assert not (OUT / 'hosting-preview-request.json').exists()
    assert_frozen()
    before = channels()
    assert version(before['live']) == PREVIOUS and PREVIEW not in before
    write('hosting-preview-request.json', {'atUtc': now(), 'source': SOURCE, 'channel': PREVIEW})
    result = firebase('hosting:channel:deploy', PREVIEW, '--expires', '7d', '--no-authorized-domains')
    write('hosting-preview-result.json', result)
    after = channels()
    assert version(after['live']) == PREVIOUS
    assert after[PREVIEW]['release']['version']['config'] == after['live']['release']['version']['config']
    write('hosting-preview.json', {'status': 'passed', 'atUtc': now(), 'version': version(after[PREVIEW]),
                                  'url': after[PREVIEW]['url'], 'channel': after[PREVIEW], 'authDomainsChanged': False})
    print(json.dumps({'operation': 'preview', 'status': 'passed', 'version': version(after[PREVIEW]), 'url': after[PREVIEW]['url']}))


def parity(phase):
    assert phase in ['preview', 'live']
    name = phase + '-full-parity.json'
    assert not (OUT/name).exists()
    assert_frozen()
    origin = HOST if phase == 'live' else read('hosting-preview.json')['url']
    def one(item):
        path, digest = item
        with urlopen(Request(origin+'/'+path, headers={'Cache-Control': 'no-cache'}), timeout=30) as response:
            data = response.read()
            assert response.status == 200 and response.url == origin+'/'+path
        assert hashlib.sha256(data).hexdigest() == digest, path
        return {'path': path, 'sha256': digest, 'bytes': len(data)}
    with ThreadPoolExecutor(max_workers=5) as pool:
        rows = list(pool.map(one, read('build-manifest.json')['files'].items()))
    write(name, {'status': 'passed', 'atUtc': now(), 'origin': origin, 'sourceCommit': SOURCE, 'files': rows, 'fileCount': len(rows)})
    print(json.dumps({'operation': 'parity', 'phase': phase, 'status': 'passed', 'files': len(rows)}))


def promote():
    from rollout import ci, invariants, CANDIDATE, health
    assert not (OUT/'hosting-promotion-request.json').exists()
    assert_frozen()
    for name in ['backend-promotion.json','preview-full-parity.json','preview-shell.json','preview-installer.json','hardening-current-final.json','hosting-retention.json']:
        assert read(name)['status'] == 'passed', name
    assert read('live-waiting-update.json')['status'] == 'armed'
    ci()
    invariants()
    current = service()
    assert current['status']['traffic'] == [{'revisionName': CANDIDATE, 'percent': 100}]
    health(HOST+'/api')
    before = channels()
    target = read('hosting-preview.json')['version']
    assert version(before['live']) == PREVIOUS and version(before[PREVIEW]) == target and version(before[ROLLBACK]) == PREVIOUS
    write('hosting-promotion-request.json', {'atUtc': now(), 'version': target, 'previousVersion': PREVIOUS, 'backendRevision': CANDIDATE})
    firebase('hosting:clone', PROJECT+'@'+target, PROJECT+':live')
    after = channels()
    assert version(after['live']) == target
    assert after['live']['release']['version']['config'] == before['live']['release']['version']['config']
    write('hosting-promotion.json', {'status': 'passed', 'atUtc': now(), 'version': target, 'previousVersion': PREVIOUS, 'live': after['live']})
    print(json.dumps({'operation': 'hosting-promotion', 'status': 'passed', 'version': target}))


if __name__ == '__main__':
    action = sys.argv[1]
    if action == 'freeze': freeze()
    elif action == 'retain': retain()
    elif action == 'preview': preview()
    elif action == 'parity': parity(sys.argv[2])
    elif action == 'promote': promote()
    else: raise ValueError('Unsupported action')
