"""Read-only final verification and exact owned temporary-resource cleanup."""
from rollout import *


def verify():
    current = service()
    assert current['status']['traffic'] == [{'revisionName': CANDIDATE, 'percent': 100}]
    assert safe_runtime(current['spec']['template']['spec']) == read('candidate.json')['runtime']
    invariants()
    checks = health(current['status']['url']) + health(HOST+'/api')
    for origin in [current['status']['url'], HOST+'/api']:
        for path in ['/auth/me', '/supervisor/users', '/supervisor/form-submissions?purpose=report']:
            row = http(origin, path)
            assert row['status'] in [401, 403]
            checks.append({'origin': origin, **row})
    start = read('candidate-deployment-request.json')['atUtc']
    logs = cloud('logging', 'read', f'resource.type="cloud_run_revision" AND resource.labels.service_name="{SERVICE}" AND resource.labels.revision_name="{CANDIDATE}" AND timestamp>="{start}"', '--limit', '5000', '--freshness', '2h')
    errors = [x for x in logs if x.get('severity') in {'ERROR','CRITICAL','ALERT','EMERGENCY'} or x.get('httpRequest',{}).get('status',0) >= 500]
    assert not errors, 'Candidate ERROR or 5xx needs investigation'
    write('live-backend-verification.json', {'status':'passed','atUtc':now(),'revision':CANDIDATE,
          'traffic':current['status']['traffic'],'runtime':safe_runtime(current['spec']['template']['spec']),
          'checks':checks,'logCount':len(logs),'errorOr5xxCount':len(errors),'serviceAndSmtpSecretIamUnchanged':True,
          'secretReferencesUnchanged':True,'publicAppUrl':HOST,'smtpAuthenticationOrEmailAttempted':False})
    print(json.dumps({'operation':'verify','status':'passed','checks':len(checks),'logs':len(logs),'errorOr5xx':0}))


def cleanup():
    passed('backend-promotion.json')
    passed('hosting-promotion.json')
    request = OUT/'cleanup-request.json'
    assert not request.exists(), 'Inspect existing cleanup before repeating'
    jobs = []
    for path in sorted(OUT.glob('*-job-created.json')):
        value = json.loads(path.read_text())
        name = value['metadata']['name']
        assert name.startswith('rf-manual-site-') and name.endswith('-20261026')
        executions = cloud('run','jobs','executions','list','--job',name,'--region',REGION)
        for execution in executions:
            condition = next(x for x in execution['status']['conditions'] if x['type']=='Completed')
            assert condition['status'] in ['True','False'], 'Owned job still running'
        jobs.append(name)
    stage = read('stage-branch.json')['branch']
    assert stage['name']=='reportflow-manual-site-stage-20261026' and stage['parent_id']=='br-snowy-tree-a7hfuph6'
    backup = read('backup.json')['branch']['id']
    assert backup != stage['id']
    proof = {'status':'running','atUtc':now(),'jobs':jobs,'stageBranch':stage['id'],'retainedBackup':backup,'deleted':[]}
    write('cleanup-request.json',proof)
    for name in jobs:
        cloud('run','jobs','delete',name,'--region',REGION)
        proof['deleted'].append(name)
        write('cleanup.json',proof)
    result = subprocess.run([shutil.which('npx.cmd'),'--yes','neon@2.32.0','branches','delete',stage['id'],
                             '--project-id','plain-smoke-06194407','--no-analytics','-o','json'],
                             capture_output=True,encoding='utf-8',errors='replace',timeout=120)
    assert result.returncode==0,'Stage deletion unconfirmed; inspect before retry'
    proof['deleted'].append(stage['id'])
    write('cleanup.json',proof)
    branches = subprocess.run([shutil.which('npx.cmd'),'--yes','neon@2.32.0','branches','list',
                               '--project-id','plain-smoke-06194407','--no-analytics','-o','json'],
                               capture_output=True,encoding='utf-8',errors='replace',timeout=90,check=True)
    rows=json.loads(branches.stdout)
    ids={x['id'] for x in rows}
    assert stage['id'] not in ids and backup in ids and 'br-snowy-tree-a7hfuph6' in ids
    remaining={x['metadata']['name'] for x in cloud('run','jobs','list','--region',REGION)}
    assert not (set(jobs)&remaining)
    assert service()['status']['traffic']==[{'revisionName':CANDIDATE,'percent':100}]
    proof.update(status='passed',verifiedAtUtc=now(),absenceVerified=True,productionAndBackupPreserved=True)
    write('cleanup.json',proof)
    print(json.dumps({'operation':'cleanup','status':'passed','deletedJobs':len(jobs),'stageBranchDeleted':stage['id'],'retainedBackup':backup}))


if __name__=='__main__':
    if sys.argv[1]=='verify': verify()
    elif sys.argv[1]=='cleanup': cleanup()
    else: raise ValueError('Unsupported action')
