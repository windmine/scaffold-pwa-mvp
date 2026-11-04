import copy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
from datetime import datetime, timezone
from urllib.request import urlopen

OUT=Path(__file__).resolve().parent
PROJECT='geo-attendance-system-db9ca'
REGION='australia-southeast1'
REVISION='geo-backend-install-guide-20261104'
GCLOUD=shutil.which('gcloud.cmd')
def cloud(args, fmt='json'):
    p=subprocess.run([GCLOUD,*args,'--project',PROJECT,'--format='+fmt],capture_output=True,text=True)
    if p.returncode: raise RuntimeError('Cloud metadata check failed')
    return json.loads(p.stdout)
def digest(v): return hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':')).encode()).hexdigest()
before=json.loads((OUT/'infrastructure-before.json').read_text())
service=cloud(['run','services','describe','geo-backend','--region',REGION])
spec=copy.deepcopy(service['spec']['template']['spec'])
image=spec['containers'][0].pop('image')
spec['containers'][0]['env'].sort(key=lambda v:v['name'])
annotations={k:v for k,v in service['spec']['template']['metadata'].get('annotations',{}).items() if k not in ('run.googleapis.com/client-name','run.googleapis.com/client-version')}
assert digest(spec)==before['stable']['runtimeExceptImage'], 'Runtime configuration changed'
assert digest(annotations)==before['stable']['templatePolicy'], 'Template policy changed'
assert image.endswith('@sha256:7b4470d3ce362325366fb2a7dffc5747b0c8c95de31a034af24a6283883de725')
assert service['status']['latestReadyRevisionName']==REVISION
assert [v for v in service['status']['traffic'] if v.get('percent',0)]==before['traffic'], 'Production traffic changed'
candidate=next(v for v in service['status']['traffic'] if v.get('tag')=='install-guide-20261104')
checks={}
for path in ('/health','/health/ready'):
    with urlopen(candidate['url']+path,timeout=30) as response:
        body=json.load(response)
    assert body['status']=='ok', path
    checks[path]=body
assert all(checks['/health/ready']['checks'][key]=='ok' for key in ('database','migrations','upload_storage'))
query='resource.type="cloud_run_revision" AND resource.labels.service_name="geo-backend" AND resource.labels.revision_name="'+REVISION+'" AND (severity>=ERROR OR httpRequest.status>=500)'
errors=cloud(['logging','read',query,'--freshness=1h','--limit=50'],fmt='json(timestamp,severity,httpRequest.status)')
assert not errors, 'Candidate has ERROR/5xx observations; inspect safely before promotion'
record={'status':'passed','atUtc':datetime.now(timezone.utc).isoformat(),'revision':REVISION,'image':image,'candidateUrl':candidate['url'],'checks':checks,'runtimeAndPolicyUnchanged':True,'productionTrafficUnchanged':True,'observedErrorCount':len(errors),'traffic':service['status']['traffic'],'realEmailsOrProductionFixtures':False}
(OUT/'candidate-check-current.json').write_text(json.dumps(record,indent=2),encoding='utf-8')
print(json.dumps(record))

