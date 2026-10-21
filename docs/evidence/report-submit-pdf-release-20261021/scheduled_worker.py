"""Approved bounded job and job-only trigger. Never reset an outbox attempt."""
from rollout import *

JOB='reportflow-pdf-email'
TRIGGER='reportflow-pdf-scheduler@'+PROJECT+'.iam.gserviceaccount.com'
URI=f'https://run.googleapis.com/v2/projects/{PROJECT}/locations/{REGION}/jobs/{JOB}:run'


def job(): return cloud('run','jobs','describe',JOB,'--region',REGION)
def scheduler(): return cloud('scheduler','jobs','describe',JOB,'--location',REGION)


def validate_job(value, enabled):
    spec=value['spec']['template']['spec']
    runtime=spec['template']['spec']
    assert spec['taskCount']==1 and spec['parallelism']==1
    assert runtime.get('maxRetries',0)==0 and str(runtime['timeoutSeconds'])=='600'
    assert runtime['serviceAccountName']==ACCOUNT
    container=runtime['containers'][0]
    assert container['image']==read('images.json')['images']['candidate']
    assert container['command']==['python'] and container['args']==['-m','app.report_pdf_email_worker','--limit','10']
    env={e['name']:e for e in container['env']}
    assert env['REPORT_PDF_EMAIL_WORKER_ENABLED']['value']==str(enabled).lower()
    assert env['REGISTRATION_EMAIL_ENABLED']['value']=='false'
    assert env['SMTP_PASSWORD']['valueFrom']['secretKeyRef']=={'name':'reportflow-smtp-password','key':'1'}
    expected=cloud('run','revisions','describe',CANDIDATE,'--region',REGION)['spec']['containers'][0]
    expected_env={e['name']:e for e in expected['env']}
    assert {k:v for k,v in env.items() if k!='REPORT_PDF_EMAIL_WORKER_ENABLED'}=={
        k:v for k,v in expected_env.items() if k!='REPORT_PDF_EMAIL_WORKER_ENABLED'}
    assert container['resources']==expected['resources']
    return runtime


def identity_scope():
    policy=cloud('projects','get-iam-policy',PROJECT)
    assert not any('serviceAccount:'+TRIGGER in x.get('members',[]) for x in policy.get('bindings',[]))
    assert hashlib.sha256(json.dumps(policy,sort_keys=True).encode()).hexdigest()==read('scheduler-service-agent.json')['afterProjectPolicySha256']
    keys=cloud('iam','service-accounts','keys','list','--iam-account',TRIGGER,'--managed-by','user')
    assert not keys
    return {'projectRoles':[],'userManagedKeys':[]}


def create():
    assert not (OUT/'worker-create-request.json').exists()
    passed('backend-promotion.json'); passed('production-proof.json'); ci(); invariants()
    identity_scope()
    assert not any(x['metadata']['name']==JOB for x in cloud('run','jobs','list','--region',REGION))
    live=service()
    assert live['status']['traffic']==[{'revisionName':CANDIDATE,'percent':100}]
    runtime=copy.deepcopy(live['spec']['template']['spec'])
    container=runtime['containers'][0]
    for key in ['ports','startupProbe','livenessProbe','readinessProbe']: container.pop(key,None)
    container.update(command=['python'],args=['-m','app.report_pdf_email_worker','--limit','10'])
    runtime.pop('containerConcurrency',None)
    runtime.update(maxRetries=0,timeoutSeconds='600')
    annotations={k:v for k,v in live['spec']['template']['metadata'].get('annotations',{}).items()
        if k in {'run.googleapis.com/vpc-access-connector','run.googleapis.com/vpc-access-egress','run.googleapis.com/network-interfaces','run.googleapis.com/encryption-key'}}
    document={'apiVersion':'run.googleapis.com/v1','kind':'Job','metadata':{'name':JOB},
        'spec':{'template':{'metadata':{'annotations':annotations},'spec':{'parallelism':1,'taskCount':1,'template':{'spec':runtime}}}}}
    write('worker-create-request.json',{'atUtc':now(),'name':JOB,'runtime':safe_runtime(runtime),'enabled':False})
    with tempfile.TemporaryDirectory(prefix='rf-pdf-worker-') as temporary:
        path=Path(temporary)/'job.json'; path.write_text(json.dumps(document),encoding='utf-8')
        cloud('run','jobs','replace',str(path),'--region',REGION)
    value=job(); validate_job(value,False)
    write('worker-created.json',{'status':'passed','atUtc':now(),'name':JOB,'runtime':safe_runtime(runtime),'enabled':False})
    print(json.dumps({'status':'passed','job':JOB,'enabled':False,'executed':False}))


def bind():
    assert not (OUT/'worker-invoker-request.json').exists()
    validate_job(job(),False); identity_scope(); invariants()
    before=cloud('run','jobs','get-iam-policy',JOB,'--region',REGION)
    bindings=before.get('bindings',[])
    assert not bindings,'New job has unexpected existing grants'
    write('worker-invoker-request.json',{'atUtc':now(),'principal':TRIGGER,'role':'roles/run.invoker','resource':JOB})
    cloud('run','jobs','add-iam-policy-binding',JOB,'--region',REGION,'--member','serviceAccount:'+TRIGGER,'--role','roles/run.invoker')
    actual=cloud('run','jobs','get-iam-policy',JOB,'--region',REGION)
    assert actual['bindings']==[{'members':['serviceAccount:'+TRIGGER],'role':'roles/run.invoker'}]
    identity_scope(); invariants()
    write('worker-invoker.json',{'status':'passed','atUtc':now(),'policy':actual,'scope':JOB,'projectRoles':[]})
    print(json.dumps({'status':'passed','jobInvokerOnly':True}))


def create_schedule():
    assert not (OUT/'schedule-create-request.json').exists()
    passed('worker-invoker.json'); validate_job(job(),False); identity_scope()
    rows=cloud('scheduler','jobs','list','--location',REGION)
    assert not any(x['name'].split('/')[-1]==JOB for x in rows)
    write('schedule-create-request.json',{'atUtc':now(),'name':JOB,'cron':'*/5 * * * *','uri':URI,'identity':TRIGGER,
        'workerDisabled':True,'pauseImmediately':True,'retries':0})
    cloud('scheduler','jobs','create','http',JOB,'--location',REGION,'--schedule','*/5 * * * *','--time-zone','Etc/UTC',
        '--uri',URI,'--http-method','POST','--headers','Content-Type=application/json','--message-body','{}',
        '--oauth-service-account-email',TRIGGER,'--oauth-token-scope','https://www.googleapis.com/auth/cloud-platform',
        '--max-retry-attempts','0','--max-retry-duration','0s','--attempt-deadline','60s',
        '--description','ReportFlow bounded PDF-email queue; one task, batch 10, zero retries')
    cloud('scheduler','jobs','pause',JOB,'--location',REGION)
    value=scheduler(); validate_schedule(value,'PAUSED')
    write('schedule-created.json',{'status':'passed','atUtc':now(),'scheduler':value,'workerDisabled':True})
    print(json.dumps({'status':'passed','scheduleState':'PAUSED','workerDisabled':True}))


def validate_schedule(value,state):
    assert value['state']==state and value['schedule']=='*/5 * * * *' and value['timeZone']=='Etc/UTC'
    target=value['httpTarget']
    assert target['uri']==URI and target['httpMethod']=='POST'
    assert target['oauthToken']=={'serviceAccountEmail':TRIGGER,'scope':'https://www.googleapis.com/auth/cloud-platform'}
    assert value.get('retryConfig',{}).get('retryCount',0)==0
    assert value.get('retryConfig',{}).get('maxRetryDuration','0s')=='0s'


def execute(label,enabled):
    assert label in ['disabled','empty']
    assert not (OUT/(label+'-worker-execution-request.json')).exists()
    validate_job(job(),enabled); validate_schedule(scheduler(),'PAUSED')
    if enabled:
        fresh=passed('pre-worker-proof.json')['before']
        assert fresh['outboxRows']==fresh['configuredTemplateRows']==0
    write(label+'-worker-execution-request.json',{'atUtc':now(),'job':JOB,'enabled':enabled,'oneExecution':True})
    result=cloud('run','jobs','execute',JOB,'--region',REGION,'--async')
    write(label+'-worker-execution.json',result)
    print(json.dumps({'execution':result['metadata']['name'],'mode':label,'status':'started'}))


def check(label):
    execution=read(label+'-worker-execution.json')['metadata']['name']
    value=cloud('run','jobs','executions','describe',execution,'--region',REGION)
    write(label+'-worker-execution-status.json',value)
    condition=next((x for x in value.get('status',{}).get('conditions',[]) if x['type']=='Completed'),{})
    if condition.get('status')!='True':
        print(json.dumps({'execution':execution,'completed':condition.get('status'),'reason':condition.get('reason')})); return
    logs=cloud('logging','read',f'resource.type="cloud_run_job" AND resource.labels.job_name="{JOB}" AND labels."run.googleapis.com/execution_name"="{execution}"','--limit','50','--freshness','2h')
    aggregate=[]
    for row in logs:
        data=row.get('jsonPayload')
        if data is None:
            try: data=json.loads(row.get('textPayload',''))
            except (ValueError,TypeError): continue
        if isinstance(data,dict) and data.get('status') in ['disabled','completed','blocked']: aggregate.append(data)
    expected={'status':'disabled'} if label=='disabled' else {'status':'completed','counts':{'accepted':0,'failed':0,'uncertain':0,'skipped':0}}
    assert aggregate==[expected],'Unexpected worker result; do not repeat'
    write(label+'-worker-proof.json',{'status':'passed','atUtc':now(),'execution':execution,'result':expected,'smtpAuthenticationOrEmailAttempted':False})
    print(json.dumps({'status':'passed','execution':execution,'result':expected}))


def enable():
    assert not (OUT/'worker-enable-request.json').exists()
    passed('disabled-worker-proof.json'); validate_schedule(scheduler(),'PAUSED')
    proof=passed('pre-worker-proof.json')['before']
    assert proof['outboxRows']==proof['configuredTemplateRows']==0
    validate_job(job(),False); invariants()
    write('worker-enable-request.json',{'atUtc':now(),'job':JOB,'outboxEmpty':True,'allTemplatesOff':True,'schedulerPaused':True})
    cloud('run','jobs','update',JOB,'--region',REGION,'--update-env-vars','REPORT_PDF_EMAIL_WORKER_ENABLED=true')
    value=job(); runtime=validate_job(value,True)
    write('worker-enabled.json',{'status':'passed','atUtc':now(),'runtime':safe_runtime(runtime),'schedulerPaused':True})
    print(json.dumps({'status':'passed','workerEnabled':True,'schedulerPaused':True}))


def activate():
    assert not (OUT/'scheduler-activation-request.json').exists()
    passed('empty-worker-proof.json'); passed('hosting-promotion.json')
    proof=passed('pre-activation-proof.json')['before']
    assert proof['outboxRows']==proof['configuredTemplateRows']==0
    validate_job(job(),True); validate_schedule(scheduler(),'PAUSED'); identity_scope(); invariants()
    write('scheduler-activation-request.json',{'atUtc':now(),'job':JOB,'allTemplatesOff':True,'outboxEmpty':True})
    cloud('scheduler','jobs','resume',JOB,'--location',REGION)
    value=scheduler(); validate_schedule(value,'ENABLED')
    write('scheduler-active.json',{'status':'passed','atUtc':now(),'scheduler':value,'allTemplatesOffAtActivation':True,'outboxEmptyAtActivation':True})
    print(json.dumps({'status':'passed','scheduler':'ENABLED','cadence':'every five minutes','emailsSent':False}))


def verify_scheduled():
    active=passed('scheduler-active.json')
    value=scheduler(); validate_schedule(value,'ENABLED')
    runtime=validate_job(job(),True); identity_scope(); invariants()
    rows=cloud('run','jobs','executions','list','--job',JOB,'--region',REGION)
    after=datetime.fromisoformat(active['atUtc'])
    matches=[row for row in rows if datetime.fromisoformat(row['metadata']['creationTimestamp'].replace('Z','+00:00'))>=after]
    if not matches:
        print(json.dumps({'status':'waiting_for_next_scheduled_tick','scheduleTime':value.get('scheduleTime')})); return
    completed=[]
    for row in matches:
        name=row['metadata']['name']
        condition=next((x for x in row.get('status',{}).get('conditions',[]) if x['type']=='Completed'),{})
        if condition.get('status')=='Unknown': continue
        assert condition.get('status')=='True','Scheduled execution failed; inspect sanitized result'
        logs=cloud('logging','read',f'resource.type="cloud_run_job" AND resource.labels.job_name="{JOB}" AND labels."run.googleapis.com/execution_name"="{name}"','--limit','50','--freshness','2h')
        outcomes=[]
        for entry in logs:
            data=entry.get('jsonPayload')
            if data is None:
                try: data=json.loads(entry.get('textPayload',''))
                except (ValueError,TypeError): continue
            if isinstance(data,dict) and data.get('status') in ['completed','disabled','blocked']: outcomes.append(data)
        expected={'status':'completed','counts':{'accepted':0,'failed':0,'uncertain':0,'skipped':0}}
        assert outcomes==[expected],'Unexpected scheduled result; never resend'
        completed.append({'execution':name,'result':expected,'completedAt':row['status'].get('completionTime')})
    if not completed:
        print(json.dumps({'status':'scheduled_execution_running','count':len(matches)})); return
    assert value.get('lastAttemptTime') and datetime.fromisoformat(value['lastAttemptTime'].replace('Z','+00:00'))>=after
    assert value.get('status',{}).get('code',0)==0
    write('scheduled-worker-verification.json',{'status':'passed','atUtc':now(),'scheduler':value,'executions':completed,
        'runtime':safe_runtime(runtime),'invokerPolicy':cloud('run','jobs','get-iam-policy',JOB,'--region',REGION),
        'triggerProjectRoles':[],'smtpAuthenticationOrEmailAttempted':False})
    print(json.dumps({'status':'passed','scheduledEmptyExecutions':len(completed),'emailsSent':False}))


if __name__=='__main__':
    action=sys.argv[1]
    if action=='create': create()
    elif action=='bind': bind()
    elif action=='schedule': create_schedule()
    elif action=='execute': execute(sys.argv[2],sys.argv[2]=='empty')
    elif action=='check': check(sys.argv[2])
    elif action=='enable': enable()
    elif action=='activate': activate()
    elif action=='verify-scheduled': verify_scheduled()
    else: raise ValueError('Unsupported action')
