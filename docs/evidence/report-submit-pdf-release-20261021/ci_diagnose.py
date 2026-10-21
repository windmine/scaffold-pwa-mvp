"""Read a failed CI job log, with token redaction and no runtime access."""
from release_operator import *
import re

value=read(sys.argv[1])
job=next(x for x in value['jobs'] if x['conclusion']=='failure')
result=subprocess.run(['gh','api',f'repos/windmine/scaffold-pwa-mvp/actions/jobs/{job["databaseId"]}/logs','--allow-escape-sequences'],
    capture_output=True,encoding='utf-8',errors='replace',timeout=90,check=True)
output=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',result.stdout)
output=re.sub(r'(?i)(Bearer\s+)\S+',r'\1[redacted]',output)
output=re.sub(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+','[redacted-token]',output)
path=ROOT/'output'/f'report-submit-pdf-ci-{job["databaseId"]}.txt'
path.write_text(output,encoding='utf-8')
print('\n'.join(output.splitlines()[-100:]))
print(json.dumps({'job':job['databaseId'],'failedSteps':[s['name'] for s in job['steps'] if s['conclusion']=='failure']}))
