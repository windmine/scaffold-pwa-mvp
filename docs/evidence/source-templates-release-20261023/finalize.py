"""Aggregate completed release proofs; no network, app writes or deployment."""
from datetime import datetime, timezone
import json
from pathlib import Path

OUT=Path(__file__).resolve().parent

def read(name, status='passed'):
    value=json.loads((OUT/name).read_text(encoding='utf-8-sig'))
    if status is not None:
        assert value['status']==status, name
    return value

assert not (OUT/'release.json').exists()
ci=read('ci-source.json','completed')
assert ci['conclusion']=='success' and all(job['conclusion']=='success' for job in ci['jobs'])
local=read('local-gates.json')
images=read('images.json',None)
backend=read('backend-promotion.json')
live=read('live-backend-verification.json')
hosting=read('hosting-promotion.json')
manifest=read('build-manifest.json',None)
hardening=read('hardening-live.json')
scheduled=read('scheduled-worker-verification.json')
read('disabled-worker-proof.json')
read('live-waiting-update.json')
for phase in ('preview','live'):
    assert read(phase+'-full-parity.json')['fileCount']==manifest['fileCount']
    read(phase+'-shell.json'); read(phase+'-installer.json')
before=read('database-baseline.json')
after=read('database-final.json')
unchanged=all(before[key]==after[key] for key in ('migrations','users','templates','reports','outbox','configured_email_templates','pending_emails'))
assert unchanged, 'Inventory changed; investigate rather than claim preservation'
assert after['configured_email_templates']==0 and after['pending_emails']==0
assert len(after['migrations'])==25
assert all(sum(row['result']['counts'].values())==0 for row in scheduled['executions'])
assert ci['headSha']==images['sourceCommit']==manifest['sourceCommit']
retention=read('hosting-retention.json')
value={'schemaVersion':1,'status':'passed','recordedAtUtc':datetime.now(timezone.utc).isoformat(),
 'sourceCommit':ci['headSha'],'sourceCiUrl':ci['url'],'buildId':images['buildId'],'image':images['images']['candidate'],
 'revision':backend['revision'],'traffic':live['traffic'],'hostingVersion':hosting['version'],'cacheVersion':manifest['cacheVersion'],
 'scope':{'longTemplates':128,'staticSectionInstructions':500,'sectionPhotos':True,'explicitLocationCapture':True,
          'migrationRequired':False,'migrationHead':'0025_report_corrections','writePause':False,'iamChanged':False,
          'smtpSecretVersion':'1','publicRegistrationEmailEnabled':False,'routingEnabled':False,
          'productionTemplatesCreated':0,'ppePublished':False,'realEmailsSentByRelease':False,'realReportsCreated':False},
 'validation':{'localBackendSuites':local['backendSuites'],'newBackendTests':local['newBackendTests'],'browserWorkflows':local['browserWorkflows'],
               'sourceCiBothJobsPassed':True,'imageTestSuites':11,'frozenFiles':manifest['fileCount'],'strictHardeningChecks':len(hardening['passingChecks']),
               'inventoryUnchanged':unchanged,'scheduledResults':[row['result']['counts'] for row in scheduled['executions']],
               'candidateErrorOr5xxCount':live['errorOr5xxCount']},
 'rollback':{'previousBackend':'geo-backend-corrections-20261023','previousHosting':hosting['previousVersion'],
             'retainedChannel':retention['channel']['name'],'expiresAt':retention['channel']['expireTime'],
             'constraint':'Prior renderer is a rollback only before extended templates are published. After publication preserve compatible backend/worker and prefer a forward fix. Never downgrade migrations or clear device/auth state.'},
 'cleanup':{'candidateTagRemoved':True,'temporaryCloudJobsCreated':0,'temporaryDatabaseBranchesCreated':0,'existingSchedulerRestored':True},
 'publication':{'departmentId':2,'department':'Mutual','verifiedSupervisorId':28,'verifiedSupervisorName':'Ken Hu',
                'preparedNonPpeTemplates':5,'createdTemplateIds':[],'blocker':'No authenticated ReportFlow application session is available to this executor; use the normal Mutual Supervisor workflow. No impersonation, direct database import or account changes performed.'},
 'warnings':hardening['warnings'],
 'limits':local['limits']+['Source result fields remain text because full choice menus were not recoverable.','Location maps are external links, not embedded tiles.','No authenticated production form fixture was created.'],
 'preservedAttempts':local['preservedAttempts']}
(OUT/'release.json').write_text(json.dumps(value,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'status':'passed','revision':value['revision'],'hosting':value['hostingVersion'],'source':value['sourceCommit']}))
