import copy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from urllib.request import Request, urlopen

OUT = Path(__file__).resolve().parent
PROJECT = 'geo-attendance-system-db9ca'
REGION = 'australia-southeast1'
GCLOUD = shutil.which('gcloud.cmd')
phase = sys.argv[1]
assert phase in ('before', 'after')
target = OUT / ('infrastructure-' + phase + '.json')
assert not target.exists(), 'Choose a new observation rather than overwriting evidence'
def cloud(*args):
    result = subprocess.run([GCLOUD, *args, '--project', PROJECT, '--format=json'], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('Metadata command failed: ' + ' '.join(args[:4]))
    return json.loads(result.stdout)
def digest(data):
    return hashlib.sha256(json.dumps(data, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
service = cloud('run', 'services', 'describe', 'geo-backend', '--region', REGION)
worker = cloud('run', 'jobs', 'describe', 'reportflow-pdf-email', '--region', REGION)
scheduler = cloud('scheduler', 'jobs', 'describe', 'reportflow-pdf-email', '--location', REGION)
runtime = copy.deepcopy(service['spec']['template']['spec'])
image = runtime['containers'][0].pop('image')
env = {v['name']: v for v in runtime['containers'][0]['env']}
runtime['containers'][0]['env'] = sorted(env.values(), key=lambda v: v['name'])
annotations = {k:v for k,v in service['spec']['template']['metadata'].get('annotations', {}).items() if k not in ('run.googleapis.com/client-name', 'run.googleapis.com/client-version')}
stable = {
    'runtimeExceptImage': digest(runtime), 'templatePolicy': digest(annotations),
    'workerSpec': digest(worker['spec']),
    'scheduler': digest({k:scheduler.get(k) for k in ('name','schedule','timeZone','state','attemptDeadline','retryConfig','httpTarget')}),
    'serviceIam': digest(cloud('run','services','get-iam-policy','geo-backend','--region',REGION)),
    'workerIam': digest(cloud('run','jobs','get-iam-policy','reportflow-pdf-email','--region',REGION)),
    'smtpSecretIam': digest(cloud('secrets','get-iam-policy','reportflow-smtp-password')),
    'smtpVersion': digest(cloud('secrets','versions','describe','1','--secret','reportflow-smtp-password')),
    'projectIam': digest(cloud('projects','get-iam-policy',PROJECT)),
}
allowed = ('WORKER_INVITATION_TTL_HOURS','PUBLIC_APP_URL','REGISTRATION_EMAIL_ENABLED','REPORT_PDF_EMAIL_WORKER_ENABLED','APP_ENV','AUTO_MIGRATE')
settings = {k:env[k].get('value') for k in allowed if k in env}
secret_refs = {k:v['valueFrom'] for k,v in env.items() if 'valueFrom' in v}
hosting = {}
for path in ('/index.html','/sw.js','/install.html','/assets/js/install.js','/manifest.webmanifest'):
    with urlopen(Request('https://' + PROJECT + '.web.app' + path, headers={'Cache-Control':'no-cache'}), timeout=30) as response:
        hosting[path] = hashlib.sha256(response.read()).hexdigest()
hosting_result = json.loads((OUT / ('hosting-' + phase + '.json')).read_text(encoding='utf-8-sig'))
channel = next((v for v in hosting_result.get('result', {}).get('channels', []) if v['name'].endswith('/live')), None)
record = {'atUtc':datetime.now(timezone.utc).isoformat(), 'phase':phase, 'stable':stable,
          'traffic':service['status']['traffic'], 'serviceUrl':service['status']['url'], 'image':image,
          'runtimeIdentity':runtime['serviceAccountName'], 'settings':settings, 'secretReferences':secret_refs,
          'schedulerState':scheduler['state'], 'serviceReady':any(v['type']=='Ready' and v['status']=='True' for v in service['status']['conditions']),
          'hostingHashes':hosting, 'hostingVersion':channel['release']['version']['name'] if channel else None, 'hostingMetadataAuthenticated':channel is not None, 'secretPayloadsRead':False}
if phase == 'after':
    before = json.loads((OUT / 'infrastructure-before.json').read_text())
    record['stableUnchanged'] = before['stable'] == stable
    record['changedStableKeys'] = [k for k in stable if stable[k] != before['stable'][k]]
    record['manifestIdentityBytesUnchanged'] = before['hostingHashes']['/manifest.webmanifest'] == hosting['/manifest.webmanifest']
target.write_text(json.dumps(record, indent=2), encoding='utf-8')
print(json.dumps({k:record[k] for k in ('phase','traffic','settings','schedulerState','serviceReady','hostingVersion')}))
if phase == 'after':
    assert record['stableUnchanged'], record['changedStableKeys']
    assert record['manifestIdentityBytesUnchanged']
