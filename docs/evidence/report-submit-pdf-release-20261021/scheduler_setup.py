"""Approved Scheduler prerequisite only; no job execution or email."""
from preflight import *

def write(name,value):
    (OUT/name).write_text(json.dumps(value,indent=2)+'\n',encoding='utf-8')

def members(policy):
    return {(row['role'],member,json.dumps(row.get('condition'),sort_keys=True))
        for row in policy.get('bindings',[]) for member in row.get('members',[])}

def main():
    assert not (OUT/'scheduler-enable-request.json').exists(), 'Inspect prior outcome before retry'
    project=cloud(['projects','describe',PROJECT])
    assert str(project['projectNumber'])=='794826041820'
    before=cloud(['projects','get-iam-policy',PROJECT])
    enabled=cloud(['services','list','--enabled'])
    expected=('roles/cloudscheduler.serviceAgent','serviceAccount:'+AGENT,'null')
    write('scheduler-enable-request.json',{'atUtc':datetime.now(timezone.utc).isoformat(),
        'api':'cloudscheduler.googleapis.com','project':PROJECT,'allowedProjectGrant':list(expected),
        'beforeProjectPolicySha256':digest(before),'productionServiceChanged':False})
    if not any(row['config']['name']=='cloudscheduler.googleapis.com' for row in enabled):
        cloud(['services','enable','cloudscheduler.googleapis.com'])
    enabled=cloud(['services','list','--enabled'])
    assert any(row['config']['name']=='cloudscheduler.googleapis.com' for row in enabled)
    after=cloud(['projects','get-iam-policy',PROJECT])
    if expected not in members(after):
        identity=cloud(['beta','services','identity','create','--service','cloudscheduler.googleapis.com'])
        assert identity['email']==AGENT
        after=cloud(['projects','get-iam-policy',PROJECT])
        if expected not in members(after):
            write('scheduler-agent-grant-request.json',{'atUtc':datetime.now(timezone.utc).isoformat(),
                'principal':AGENT,'role':expected[0],'scope':PROJECT})
            cloud(['projects','add-iam-policy-binding',PROJECT,'--member',expected[1],'--role',expected[0],'--condition=None'])
            after=cloud(['projects','get-iam-policy',PROJECT])
    assert expected in members(after)
    added=members(after)-members(before)
    removed=members(before)-members(after)
    assert added <= {expected} and not removed, 'Project IAM changed beyond the approved service-agent grant'
    write('scheduler-service-agent.json',{'status':'passed','atUtc':datetime.now(timezone.utc).isoformat(),
        'apiEnabled':True,'agent':AGENT,'role':expected[0],'project':PROJECT,
        'addedBindings':[list(x) for x in sorted(added)],'removedBindings':[],
        'afterProjectPolicySha256':digest(after),'productionServiceChanged':False,'jobsExecuted':False})
    accounts=cloud(['iam','service-accounts','list'])
    existing=next((row for row in accounts if row['email']==SCHEDULER),None)
    assert existing is None, 'Existing trigger identity needs separate permission review'
    write('scheduler-identity-request.json',{'atUtc':datetime.now(timezone.utc).isoformat(),'email':SCHEDULER,
        'projectRoles':[],'futureResourceGrant':'roles/run.invoker on reportflow-pdf-email job only'})
    account=cloud(['iam','service-accounts','create','reportflow-pdf-scheduler',
        '--display-name','ReportFlow PDF job scheduler'])
    assert account['email']==SCHEDULER and not account.get('disabled',False)
    project_policy=cloud(['projects','get-iam-policy',PROJECT])
    assert not any(member=='serviceAccount:'+SCHEDULER for _,member,_ in members(project_policy))
    write('scheduler-identity.json',{'status':'passed','atUtc':datetime.now(timezone.utc).isoformat(),
        'email':account['email'],'uniqueId':account['uniqueId'],'projectRoles':[],
        'jobInvokerNotYetBound':True,'noKeysCreated':True})
    print(json.dumps({'status':'passed','apiEnabled':True,'approvedAgentRoleVerified':True,
        'triggerIdentity':SCHEDULER,'triggerProjectRoles':[],'jobsExecuted':False,'productionChanged':False}))

if __name__=='__main__': main()
