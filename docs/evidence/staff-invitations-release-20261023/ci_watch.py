"""Read-only bounded CI observer; no reruns or workflow changes."""
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import sys
import time

out=Path(__file__).resolve().parent
expected=json.loads((out/'source-ci-id.json').read_text(encoding='utf-8-sig'))
last=None
for _ in range(65):
    result=subprocess.run(['gh','run','view',str(expected['id']),'--json','databaseId,headSha,status,conclusion,jobs,url'],capture_output=True,encoding='utf-8',check=True,timeout=45)
    value=json.loads(result.stdout)
    assert value['headSha']==expected['sourceCommit']
    (out/'source-ci-observation.json').write_text(json.dumps({'observedAtUtc':datetime.now(timezone.utc).isoformat(),**value},indent=2)+'\n',encoding='utf-8')
    brief={'status':value['status'],'conclusion':value['conclusion'],'url':value['url'],'jobs':[{'name':job['name'],'status':job['status'],'conclusion':job['conclusion'],'current':[step['name'] for step in job['steps'] if step['status']=='in_progress']} for job in value['jobs']]}
    if brief!=last:
        print(json.dumps(brief),flush=True)
        last=brief
    if value['status']=='completed':
        sys.exit(0 if value['conclusion']=='success' else 1)
    time.sleep(30)
raise SystemExit('CI remains active; observer time limit reached, no workflow was cancelled')
