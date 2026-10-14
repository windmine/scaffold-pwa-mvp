"""Promote only the frozen, verified frontend version on the existing site."""
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import subprocess

ROOT = Path.cwd()
OUT = ROOT / 'docs/evidence/frontend-ux-release-20261014'
PROJECT = 'geo-attendance-system-db9ca'
SOURCE = '133286659e7459e6d4c73b1b3ad5882c44ba2051'
VERSION = '3de58c285d322d0f'
PREVIOUS = '7d52593100c9f3a2'
FIREBASE = r'C:\Users\12273\AppData\Roaming\npm\firebase.cmd'
GH = r'C:\Program Files\GitHub CLI\gh.exe'


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def now():
    return datetime.now(timezone.utc).isoformat()


def command(arguments):
    result = subprocess.run(arguments, cwd=ROOT, capture_output=True,
                            encoding='utf-8', errors='replace', timeout=240)
    if result.returncode:
        raise RuntimeError('provider_command_failed_without_printing_credentials')
    return json.loads(result.stdout)


def firebase(*arguments):
    return command(['cmd.exe', '/d', '/c', FIREBASE, *arguments,
                    '--project', PROJECT, '--non-interactive', '--json'])


def channels():
    data = firebase('hosting:channel:list')
    assert data['status'] == 'success'
    return {item['name'].split('/')[-1]: item for item in data['result']['channels']}


def version(channel):
    return channel['release']['version']['name'].split('/')[-1]


def main():
    destination = OUT / 'hosting-promotion.json'
    assert not destination.exists(), 'promotion_attempt_already_recorded'
    assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip() == SOURCE
    assert not subprocess.check_output(['git', 'diff', '--name-only', 'HEAD', '--',
        'index.html', 'install.html', 'assets', 'sw.js', 'firebase.json'], cwd=ROOT, text=True).strip()
    manifest = read(OUT / 'build-manifest.json')
    assert manifest['sourceCommit'] == SOURCE
    for path, expected in manifest['files'].items():
        assert hashlib.sha256((ROOT / 'dist' / path).read_bytes()).hexdigest() == expected, path
    assert hashlib.sha256((ROOT / 'firebase.json').read_bytes()).hexdigest() == manifest['firebaseConfigSha256']
    for name in ('preview-shell.json', 'preview-installer-verified.json', 'preview-ux.json',
                 'preview-full-parity.json', 'hardening-current.json'):
        assert read(OUT / name)['status'] == 'passed', name
    assert read(OUT / 'live-waiting-update-after-ci.json')['status'] == 'armed'
    ci = command([GH, 'run', 'view', '38491025490', '--repo', 'windmine/scaffold-pwa-mvp',
                  '--json', 'headSha,status,conclusion,url,jobs,attempt'])
    assert ci['headSha'] == SOURCE and ci['conclusion'] == 'success' and ci['status'] == 'completed'
    assert len(ci['jobs']) == 2 and all(job['conclusion'] == 'success' for job in ci['jobs'])
    (OUT / 'ci-source.json').write_bytes((json.dumps(ci, indent=2) + '\n').encode())
    before = channels()
    assert version(before['live']) == PREVIOUS
    assert version(before['release-ui-20261012']) == PREVIOUS
    assert version(before['release-ux-20261014']) == VERSION
    assert before['live']['release']['version']['config'] == before['release-ux-20261014']['release']['version']['config']
    proof = {'status': 'promotion-requested', 'sourceCommit': SOURCE, 'projectId': PROJECT,
             'previousVersion': PREVIOUS, 'expectedVersion': VERSION, 'requestedAtUtc': now(),
             'frontendOnly': True, 'backendChangeRequested': False, 'fixtureWritesRequested': False,
             'rollbackChannel': before['release-ui-20261012']['name'],
             'rollbackExpiresAt': before['release-ui-20261012']['expireTime']}
    destination.write_bytes((json.dumps(proof, indent=2) + '\n').encode())
    # The target live channel already exists, so CLI cloning never creates a
    # channel or invokes its new-channel Firebase Auth domain synchronization.
    result = firebase('hosting:clone', PROJECT + '@' + VERSION, PROJECT + ':live')
    assert result['status'] == 'success'
    after = channels()
    assert version(after['live']) == VERSION
    assert after['live']['release']['version']['config'] == before['live']['release']['version']['config']
    proof.update(status='passed', verifiedAtUtc=now(), live=after['live'])
    destination.write_bytes((json.dumps(proof, indent=2) + '\n').encode())
    print(json.dumps({'status': proof['status'], 'version': VERSION, 'url': after['live']['url']}))


if __name__ == '__main__':
    main()
