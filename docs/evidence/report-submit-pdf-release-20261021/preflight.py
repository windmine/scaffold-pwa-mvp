"""Read-only release metadata: no secret payloads, SMTP or IAM writes."""
from pathlib import Path
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
import copy
import hashlib
import json
import os
import shutil
import subprocess

OUT = Path(__file__).resolve().parent
PROJECT = 'geo-attendance-system-db9ca'
REGION = 'australia-southeast1'
ACCOUNT = 'geo-backend-runtime@geo-attendance-system-db9ca.iam.gserviceaccount.com'
SCHEDULER = 'reportflow-pdf-scheduler@' + PROJECT + '.iam.gserviceaccount.com'
AGENT = 'service-794826041820@gcp-sa-cloudscheduler.iam.gserviceaccount.com'

def cloud(args):
    result = subprocess.run([shutil.which('gcloud.cmd'), *args, '--project', PROJECT,
        '--format=json', '--quiet'], capture_output=True, encoding='utf-8', errors='replace',
        timeout=120, env={**os.environ, 'CLOUDSDK_CORE_LOG_HTTP':'false'})
    if result.returncode:
        raise RuntimeError('Read-only provider check failed: ' + ' '.join(args[:3]))
    return json.loads(result.stdout) if result.stdout.strip() else {}

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()

def main():
    target = OUT / 'preflight.json'
    assert not target.exists(), 'Keep existing evidence; inspect before another read'
    requests = [
        ['run','services','describe','geo-backend','--region',REGION],
        ['run','services','get-iam-policy','geo-backend','--region',REGION],
        ['secrets','get-iam-policy','reportflow-smtp-password'],
        ['secrets','versions','describe','1','--secret','reportflow-smtp-password'],
        ['services','list','--enabled'],
        ['iam','service-accounts','list'],
        ['projects','get-iam-policy',PROJECT],
        ['run','jobs','list','--region',REGION],
    ]
    with ThreadPoolExecutor(max_workers=4) as pool:
        live, policy, secret_policy, secret, enabled, accounts, project_policy, jobs = list(pool.map(cloud,requests))
    runtime = copy.deepcopy(live['spec']['template']['spec'])
    assert runtime['serviceAccountName'] == ACCOUNT
    env = {row['name']:row for row in runtime['containers'][0]['env']}
    assert env['SMTP_PASSWORD']['valueFrom']['secretKeyRef'] == {'name':'reportflow-smtp-password','key':'1'}
    assert env['REGISTRATION_EMAIL_ENABLED']['value'] == 'false'
    assert secret['state'] == 'ENABLED'
    for container in runtime['containers']:
        for row in container.get('env',[]):
            if 'value' in row:
                row['valueSha256'] = hashlib.sha256(row.pop('value').encode()).hexdigest()
        container['env'].sort(key=lambda row:row['name'])
    api_enabled = any(row['config']['name']=='cloudscheduler.googleapis.com' for row in enabled)
    scheduler_accounts = [row for row in accounts if row['email'] in {SCHEDULER,AGENT}]
    relevant = [row for row in project_policy.get('bindings',[]) if any(
        member in {'serviceAccount:'+SCHEDULER,'serviceAccount:'+AGENT}
        for member in row.get('members',[]))]
    result = {'recordedAtUtc':datetime.now(timezone.utc).isoformat(),
        'status':'read_only_complete','sourceCommit':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),
        'runtime':runtime,'templateMetadata':live['spec']['template']['metadata'],
        'serviceStatus':live['status'],'serviceIam':policy,'smtpSecretIam':secret_policy,
        'smtpSecretVersion':{'name':secret['name'],'state':secret['state']},
        'projectIamSha256':digest(project_policy),'schedulerApiEnabled':api_enabled,
        'schedulerAccounts':scheduler_accounts,'schedulerProjectBindings':relevant,
        'jobNameCollision':any(row['metadata']['name']=='reportflow-pdf-email' for row in jobs),
        'existingJobNames':[row['metadata']['name'] for row in jobs],
        'productionChanged':False,'secretPayloadRead':False}
    target.write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'status':result['status'],'traffic':live['status']['traffic'],
        'schedulerApiEnabled':api_enabled,'schedulerAccounts':[row['email'] for row in scheduler_accounts],
        'schedulerProjectRoles':[row['role'] for row in relevant],
        'jobNameCollision':result['jobNameCollision'],'smtpSecretVersionEnabled':True,'productionChanged':False}))

if __name__=='__main__': main()
