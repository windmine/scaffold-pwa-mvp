"""Record only a completed Clear-alignment frontend release; never deploys."""
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json

root = Path.cwd()
directory = root / 'docs/evidence/frontend-clear-release-20261014'

def read(name):
    return json.loads((directory / name).read_text(encoding='utf-8-sig'))

def write(name, data):
    (directory / name).write_bytes((json.dumps(data, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))

def sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()

assert not (directory / 'release.json').exists()
build = read('build-manifest.json')
promotion = read('hosting-promotion.json')
ci = read('ci-source.json')
assert ci['headSha'] == build['sourceCommit'] and ci['conclusion'] == 'success'
assert len(ci['jobs']) == 2 and all(job['conclusion'] == 'success' for job in ci['jobs'])
assert sum(' ok - ' in line for line in (directory / 'ci-workflows.txt').read_text(encoding='utf-8').splitlines()) == 73
for name in ['local-validation.json', 'local-visual-review.json', 'preview-full-parity.json',
             'preview-shell.json', 'preview-installer.json', 'preview-visual-review.json',
             'hardening-current.json', 'hosting-promotion.json', 'live-full-parity.json',
             'live-shell.json', 'live-installer.json', 'live-waiting-update.json', 'live-visual-review.json']:
    assert read(name)['status'] == 'passed', name
assert read('backend-before.json') == read('backend-after.json')
for name in ['preview-full-parity.json', 'live-full-parity.json']:
    assert {item['path']: item['sha256'] for item in read(name)['files']} == build['files']
assert len(build['files']) == 85 and len(read('live-waiting-update.json')['checks']) == 4
record = {
    'schemaVersion': 1, 'status': 'deployed-and-verified',
    'recordedAtUtc': datetime.now(timezone.utc).isoformat(), 'sourceCommit': build['sourceCommit'],
    'url': promotion['live']['url'], 'hostingVersion': promotion['expectedVersion'],
    'previousHostingVersion': promotion['previousVersion'], 'promotionsPerformed': 1,
    'requestedAtUtc': promotion['requestedAtUtc'], 'verifiedAtUtc': promotion['verifiedAtUtc'],
    'sourceCache': build['sourceCache'], 'builtCache': build['builtCache'],
    'change': 'One desktop Report-only CSS grid rule aligns Clear with the full filter group; handlers and clearing behavior are unchanged.',
    'validation': {'localAlignmentLayouts': 32, 'localKeyboardClearCases': 4,
                   'languages': ['English', 'Chinese'], 'themes': ['light', 'dark'],
                   'buildLintFilterExportStaticChecks': 'passed',
                   'ciRun': 38648634657, 'ciUrl': ci['url'], 'ciAttempt': ci['attempt'],
                   'ciConclusion': 'success', 'realBackendWorkflows': 73,
                   'previewAndLiveFileCountEach': 85, 'shellAssetCountEach': 75,
                   'installerArtifactCountEach': 7, 'liveWaitingUpdateChecks': 4,
                   'strictHardeningChecks': len(read('hardening-current.json')['passingChecks'])},
    'backend': {'revision': 'geo-backend-fixes-20261012', 'trafficPercent': 100,
                'beforeAfterServiceStatusEqual': True, 'deploymentOrMigrationPerformed': False,
                'databaseInventoryRepeated': False},
    'rollback': {'version': promotion['previousVersion'], 'channel': 'release-ux-20261014',
                 'expiresAtUtc': promotion['rollbackExpiresAt'],
                 'constraints': 'Reverify before use. Frontend only; preserve current backend, device storage, drafts and auth generations.'},
    'limits': ['No production application fixtures, existing-user login or authenticated hosted Clear test.',
               'Physical iOS/Android checks remain unverified.',
               'Existing six-hour Neon history warning remains.'],
    'followUpCi': 'Final documentation/evidence commit CI is reported in the task outcome; no extra metadata commit is needed.'
}
record['evidence'] = [{'path': file.relative_to(directory).as_posix(), 'sha256': sha(file)}
                      for file in sorted(directory.rglob('*')) if file.is_file() and file.name != 'release.json']
write('release.json', record)
source = build['sourceCommit']
summary = (f"Source `{source}` is live as exact Hosting `{promotion['expectedVersion']}`, promoted at "
           f"`{promotion['requestedAtUtc']}` and verified at `{promotion['verifiedAtUtc']}`. "
           f"Production cache is `{build['builtCache']}`. A single desktop Report-only grid rule aligns Clear "
           "with the full filter group instead of the first column. Clearing behavior, Report data and exports are unchanged.")
checks = ("Fresh local checks pass 32 desktop/tablet/phone layouts, four English/Chinese keyboard-clearing cases, "
          "filter/export regressions, build, lint and static shell checks. "
          "[Source CI](https://github.com/windmine/scaffold-pwa-mvp/actions/runs/38648634657) passes both jobs "
          "and all 73 real-backend workflows. Preview/live match 85 frozen files and pass 75 shell-asset and seven "
          "installer-artifact checks each; the new live waiting-update probe passes four checks. Strict hardening passes "
          "40 checks with the existing six-hour recovery-history warning.")
limits = ("Backend `geo-backend-fixes-20261012` remains at 100% without tags, with matching before/after service status. "
          "No backend deployment, migration, production fixture writes or existing-user login occurred; no new database "
          "inventory comparison is claimed. Authenticated production and physical-phone checks remain unverified. "
          f"Previous exact Hosting `{promotion['previousVersion']}` remains in `release-ux-20261014` until "
          f"`{promotion['rollbackExpiresAt']}`; reverify before use and preserve the current backend and device state.")

def edit(name, transform):
    file = root / name
    original = file.read_text(encoding='utf-8')
    updated = transform(original)
    assert original != updated, name
    file.write_bytes(updated.encode('utf-8'))

def historical(text):
    return text.replace('Current Frontend Release - Report UX, 2026-10-14',
                        'Earlier Frontend Release - Report UX, 2026-10-14', 1).replace(
        'Committed/pushed frontend source `133286659e7459e6d4c73b1b3ad5882c44ba2051` is live',
        'At the earlier UX cutover, committed/pushed frontend source `133286659e7459e6d4c73b1b3ad5882c44ba2051` was live', 1)

for name, prefix, link in [('README.md', '## ', 'docs/evidence/frontend-clear-release-20261014/release.json'),
                           ('docs/production-db-runbook.md', '### ', 'evidence/frontend-clear-release-20261014/release.json')]:
    heading = prefix + 'Current Frontend Release - Report UX, 2026-10-14'
    section = prefix + 'Current Frontend Release - Clear alignment, 2026-10-14\n\n' + summary + '\n\n' + checks + '\n\n' + limits + f' [Release evidence]({link}).\n\n'
    edit(name, lambda text: historical(text.replace(heading, section + heading, 1)))
edit('AGENTS.md', lambda text: text.replace('## Current Implementation Notes\n\n',
     '## Current Implementation Notes\n\n- **Current Clear-alignment frontend release (October 14 UTC)**: ' + summary + ' ' + checks + ' ' + limits + ' [Release evidence](docs/evidence/frontend-clear-release-20261014/release.json).\n\n', 1)
     .replace('**Current October 14 frontend UX release**', '**Earlier October 14 frontend UX release, superseded by Clear alignment above**', 1))
edit('CONTEXT.md', lambda text: historical(text.replace(
     'Browser traffic stays same-origin through `/api/**` and `/uploads/**` Hosting rewrites.\n\n',
     'Browser traffic stays same-origin through `/api/**` and `/uploads/**` Hosting rewrites.\n\n' + summary + ' [Clear release evidence](docs/evidence/frontend-clear-release-20261014/release.json).\n\n', 1)))
edit('docs/mobile-browser-workflow-checks.md', lambda text: text.replace(
     '## Report UX improvements — released 2026-10-14',
     '## Supervisor filter Clear alignment — released 2026-10-14 UTC\n\n' + summary + '\n\n' + checks + ' The regression first failed at desktop width 1280 (Clear right edge 618 versus filter-group edge 1222), then passed after the one-line CSS change. See the [release evidence](evidence/frontend-clear-release-20261014/release.json). Hosted checks remain anonymous; the actual filter interaction is verified with isolated local fixtures.\n\n## Report UX improvements — released 2026-10-14', 1))
print('Completed release evidence and five current-state documents; no provider mutation.')
