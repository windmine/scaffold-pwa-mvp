"""Guarded, resumable operations for the approved install-guide release."""
import hashlib
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path.cwd()
OUT = Path(__file__).resolve().parent
PROJECT = 'geo-attendance-system-db9ca'
REGION = 'australia-southeast1'
SOURCE = '6312d80ae6bd25c4e77dd44016dfd2a9543ab3ff'
REVISION = 'geo-backend-install-guide-20261104'
OLD_REVISION = 'geo-backend-invite-week-20261101'
OLD_VERSION = 'a443650ecd58e0f2'
PREVIEW = 'release-install-guide-20261104'
ROLLBACK = 'rollback-install-guide-20261104'

def now(): return datetime.now(timezone.utc).isoformat()
def read(name): return json.loads((OUT/name).read_text(encoding='utf-8-sig'))
def write(name, data): (OUT/name).write_text(json.dumps(data, indent=2)+'\n', encoding='utf-8')
def command(args):
    result = subprocess.run(args, capture_output=True, encoding='utf-8', errors='replace', timeout=360)
    if result.returncode: raise RuntimeError('Provider command failed; inspect observed state before retry: '+args[1])
    return json.loads(result.stdout)
def firebase(*args):
    return command([shutil.which('firebase.cmd'), *args, '--project', PROJECT, '--non-interactive', '--json'])
def cloud(*args):
    return command([shutil.which('gcloud.cmd'), *args, '--project', PROJECT, '--region', REGION, '--format=json'])
def channels():
    result = firebase('hosting:channel:list')
    assert result['status']=='success'
    return {v['name'].split('/')[-1]:v for v in result['result']['channels']}
def version(channel): return channel['release']['version']['name'].split('/')[-1]
def frozen():
    assert subprocess.check_output(['git','rev-parse','HEAD'], text=True).strip()==SOURCE
    ci=read('source-ci.json')
    assert ci['headSha']==SOURCE and ci['conclusion']=='success'
    assert all(v['conclusion']=='success' for v in ci['jobs'])
    manifest=read('build-manifest.json')
    assert manifest['sourceCommit']==SOURCE
    for name, expected in manifest['files'].items():
        assert hashlib.sha256((ROOT/'dist'/name).read_bytes()).hexdigest()==expected,name
    assert hashlib.sha256((ROOT/'firebase.json').read_bytes()).hexdigest()==manifest['firebaseConfigSha256']
def operation(name, action):
    target=name+'.json'
    assert not (OUT/target).exists(), 'An operation record already exists. Reconcile before proceeding.'
    record={'status':'requested','requestedAtUtc':now(),'sourceCommit':SOURCE}
    write(target,record)
    result=action()
    record.update(status='passed',verifiedAtUtc=now(),result=result)
    write(target,record)
    print(json.dumps({'operation':name,'status':'passed','result':result}))

phase=sys.argv[1]
frozen()
if phase=='preview':
    state=channels()
    assert version(state['live'])==OLD_VERSION and PREVIEW not in state
    def deploy():
        result=firebase('hosting:channel:deploy',PREVIEW,'--expires','7d','--no-authorized-domains')
        assert result['status']=='success'
        current=channels()
        assert version(current['live'])==OLD_VERSION
        assert current[PREVIEW]['release']['version']['config']==current['live']['release']['version']['config']
        return current[PREVIEW]
    operation('hosting-preview',deploy)
elif phase=='rollback':
    state=channels()
    assert version(state['live'])==OLD_VERSION and ROLLBACK not in state
    def retain():
        # channel:create and new-target clone sync Firebase Auth domains.
        # Deploy with the supported opt-out first; clone only to that existing channel.
        created=firebase('hosting:channel:deploy',ROLLBACK,'--expires','7d','--no-authorized-domains')
        assert created['status']=='success' and ROLLBACK in channels()
        result=firebase('hosting:clone',PROJECT+'@'+OLD_VERSION,PROJECT+':'+ROLLBACK)
        assert result['status']=='success'
        current=channels()
        assert version(current[ROLLBACK])==OLD_VERSION and version(current['live'])==OLD_VERSION
        return current[ROLLBACK]
    operation('hosting-rollback',retain)
elif phase=='backend':
    assert read('candidate-check-current.json')['status']=='passed'
    service=cloud('run','services','describe','geo-backend')
    assert [(v['revisionName'],v.get('percent',0)) for v in service['status']['traffic'] if v.get('percent')]==[(OLD_REVISION,100)]
    assert service['status']['latestReadyRevisionName']==REVISION
    for name in ('preview-full-parity.json','preview-shell.json','preview-installer.json','preview-visual-review.json'):
        assert read(name)['status']=='passed',name
    assert read('hosting-rollback.json')['status']=='passed'
    def promote():
        cloud('run','services','update-traffic','geo-backend','--to-revisions='+REVISION+'=100','--quiet')
        current=cloud('run','services','describe','geo-backend')
        assert [(v['revisionName'],v.get('percent',0)) for v in current['status']['traffic'] if v.get('percent')]==[(REVISION,100)]
        return {'traffic':current['status']['traffic'],'serviceUrl':current['status']['url']}
    operation('backend-promotion',promote)
elif phase=='hosting':
    assert read('backend-promotion.json')['status']=='passed'
    assert read('backend-live-health.json')['status']=='passed'
    assert read('live-waiting-update.json')['status']=='armed'
    state=channels()
    expected=version(read('hosting-preview.json')['result'])
    assert version(state['live'])==OLD_VERSION and version(state[ROLLBACK])==OLD_VERSION
    assert version(state[PREVIEW])==expected
    def promote():
        result=firebase('hosting:clone',PROJECT+'@'+expected,PROJECT+':live')
        assert result['status']=='success'
        current=channels()
        assert version(current['live'])==expected
        assert current['live']['release']['version']['config']==state['live']['release']['version']['config']
        return current['live']
    operation('hosting-promotion',promote)
elif phase=='tag-cleanup':
    assert read('hosting-promotion.json')['status']=='passed'
    def remove():
        cloud('run','services','update-traffic','geo-backend','--remove-tags=install-guide-20261104','--quiet')
        current=cloud('run','services','describe','geo-backend')
        assert not any(v.get('tag')=='install-guide-20261104' for v in current['status']['traffic'])
        assert [(v['revisionName'],v.get('percent',0)) for v in current['status']['traffic'] if v.get('percent')]==[(REVISION,100)]
        return {'traffic':current['status']['traffic']}
    operation('candidate-tag-cleanup',remove)
else: raise ValueError('Unknown phase')
