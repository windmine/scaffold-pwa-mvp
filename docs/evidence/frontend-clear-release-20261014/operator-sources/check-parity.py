"""Read-only exact parity against the frozen build; never authenticates."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import sys
import urllib.parse
import urllib.request

root = Path.cwd()
directory = root / 'docs/evidence/frontend-clear-release-20261014'
origin, basename = sys.argv[1:]
url = urllib.parse.urlparse(origin)
assert url.scheme == 'https' and not url.username and not url.password
assert not url.query and not url.fragment and url.path in ('', '/')
assert url.hostname == 'geo-attendance-system-db9ca.web.app' or url.hostname.startswith('geo-attendance-system-db9ca--release-clear-20261014-') and url.hostname.endswith('.web.app')
assert basename in ('preview-full-parity.json', 'live-full-parity.json')
destination = directory / basename
assert not destination.exists()
manifest = json.loads((directory / 'build-manifest.json').read_text(encoding='utf-8'))
proof = {'status': 'running', 'origin': origin, 'sourceCommit': manifest['sourceCommit'],
         'startedAtUtc': datetime.now(timezone.utc).isoformat(), 'files': []}

def check(item):
    name, expected = item
    assert hashlib.sha256((root / 'dist' / name).read_bytes()).hexdigest() == expected
    request = urllib.request.Request(origin + '/' + name, headers={'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(request, timeout=30) as response:
        assert response.status == 200 and response.url == origin + '/' + name
        data = response.read()
    assert hashlib.sha256(data).hexdigest() == expected, name
    return {'path': name, 'sha256': expected, 'bytes': len(data)}

try:
    with ThreadPoolExecutor(max_workers=5) as pool:
        proof['files'] = list(pool.map(check, manifest['files'].items()))
    proof.update(status='passed', fileCount=len(proof['files']))
except Exception as error:
    proof.update(status='failed', failure=str(error)[:500])
finally:
    proof['completedAtUtc'] = datetime.now(timezone.utc).isoformat()
    destination.write_bytes((json.dumps(proof, indent=2) + '\n').encode('utf-8'))
print(json.dumps({'status': proof['status'], 'files': len(proof['files'])}))
raise SystemExit(0 if proof['status'] == 'passed' else 1)
