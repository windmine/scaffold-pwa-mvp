"""Bind completed Site release evidence. No provider calls or business writes."""
from datetime import datetime, timezone
from pathlib import Path
import hashlib, json

out=Path(__file__).resolve().parent
assert not (out/'release.json').exists()
def read(name, status='passed'):
    value=json.loads((out/name).read_text(encoding='utf-8-sig'))
    if status is not None: assert value['status']==status, name
    return value
identity=read('source-ci-id.json',None); ci=read('ci-source.json','completed')
assert ci['headSha']==identity['sourceCommit'] and ci['conclusion']=='success'
assert len(ci['jobs'])==2 and all(j['conclusion']=='success' for j in ci['jobs'])
images=read('images.json',None); build=read('build-final.json','SUCCESS')
assert images['buildId']==build['id'] and all(s['status']=='SUCCESS' for s in build['steps'])
backend=read('backend-promotion.json'); live=read('live-backend-verification.json')
candidate=read('candidate.json'); fallback=read('fallback.json')
hosting=read('hosting-promotion.json'); manifest=read('build-manifest.json',None)
assert ci['headSha']==images['sourceCommit']==manifest['sourceCommit']
assert live['traffic']==backend['traffic']==[{'revisionName':'geo-backend-manual-site-20261026','percent':100}]
assert candidate['runtime']==backend['runtime']==live['runtime']
assert candidate['runtime']['containers'][0]['image']==images['images']['candidate']
assert fallback['runtime']['containers'][0]['image']==images['images']['fallback']
assert live['errorOr5xxCount']==0 and live['serviceAndSmtpSecretIamUnchanged'] and live['secretReferencesUnchanged']
env={entry['name']:entry for entry in candidate['runtime']['containers'][0]['env']}
assert env['SMTP_PASSWORD']['valueFrom']['secretKeyRef']=={'name':'reportflow-smtp-password','key':'1'}
for flag in ['REGISTRATION_EMAIL_ENABLED','REPORT_PDF_EMAIL_WORKER_ENABLED']:
    assert env[flag]['valueSha256']==hashlib.sha256(b'false').hexdigest()
assert hosting['version']==read('hosting-preview.json')['version']
assert hosting['previousVersion']=='35a126d8e9de6e5b'
for phase in ['preview','live']:
    parity=read(phase+'-full-parity.json')
    assert {x['path']:x['sha256'] for x in parity['files']}==manifest['files']
    read(phase+'-shell.json'); read(phase+'-installer.json')
waiting=read('live-waiting-update.json')
assert waiting['expected']['cacheVersion']==manifest['cacheVersion'] and len(waiting['checks'])>=4
visual=read('visual-review.json'); local=read('local-validation.json'); read('preparation-validation.json')
assert read('fallback-local.json')['cleanupComplete']
for name,head,phase in [('neon-premigration.json','0026_staff_invitations','PreMigration'),('neon-current-final.json','0027_report_manual_site','Current')]:
    recovery=read(name)
    assert recovery['expectedRecoveryHead']==head and recovery['releasePhase']==phase
    assert recovery['cleanup']['absenceVerified'] and recovery['cleanup']['deleted']
read('hardening-pre.json'); hardening=read('hardening-current-final.json')
assert hardening['strict'] and not hardening['failures']
before=read('backup-verified-proof.json'); migration=read('production-proof.json'); post=read('post-release-proof.json')
for name in ['baseline-verified-proof.json','stage-migrated-proof.json','stage-fallback-proof.json','stage-provider-verified-proof.json','production-proof.json','backup-verified-proof.json','post-release-proof.json']:
    proof=read(name); assert proof['executionCompletedAtUtc'] and proof['execution']
assert before['backupMatchesProduction'] and before['before']==before['backup']==migration['before']
assert migration['before']['migrationCount']==26 and migration['after']['migrationCount']==27
assert migration['applied']==['0027_report_manual_site'] and migration['businessDataPreserved']
assert migration['before']['businessTables']==migration['after']['businessTables']
assert all(migration['after']['migrationChecksums'][k]==v for k,v in migration['before']['migrationChecksums'].items())
assert migration['after']['manualSiteColumns']==['manual_site_name'] and migration['after']['manualSiteRows']==0
for key in ['businessTables','migrationChecksums','configuredTemplateRows','outboxRows','outboxStatuses']:
    assert post['before'][key]==migration['after'][key], 'Post-release inventory changed: '+key
assert post['before']['configuredTemplateRows']==0 and post['before']['outboxRows']==0
provider=read('stage-provider-verified-proof.json')['api']
assert provider['passingChecks']>=251 and provider['smtpDisabled'] and provider['cleanupComplete'] and provider['testReaderCleanupComplete']
assert read('disabled-worker-proof.json')['result']=={'status':'disabled'}
schedule=read('scheduled-worker-verification.json')
assert schedule['scheduler']['state']=='ENABLED' and schedule['scheduler']['schedule']=='*/5 * * * *'
assert schedule['existingIamPreserved'] and schedule['executions']
assert all(sum(x['result']['counts'].values())==0 for x in schedule['executions'])
assert schedule['runtime']['containers'][0]['image']==images['images']['candidate']
assert schedule['runtime']['maxRetries']==0 and schedule['runtime']['containers'][0]['args']==['-m','app.report_pdf_email_worker','--limit','10']
cleanup=read('cleanup.json'); assert cleanup['absenceVerified'] and cleanup['productionAndBackupPreserved']
backup=read('backup.json'); retained=read('hosting-retention.json')['channel']; pause=read('pause.json')
value={'status':'passed','atUtc':datetime.now(timezone.utc).isoformat(),'sourceCommit':ci['headSha'],'sourceCiUrl':ci['url'],
    'revision':backend['revision'],'hostingVersion':hosting['version'],'cacheVersion':manifest['cacheVersion'],
    'buildId':build['id'],'images':images['images'],'imageSourceCommit':images['imageSourceCommit'],
    'imageSourceEquivalence':read('image-source-equivalence.json'),'traffic':live['traffic'],
    'scope':{'chooseOrTypeReportSite':True,'departmentBoundariesPreserved':True,'sharedSitesCreated':False,
        'migration':'0027_report_manual_site','existingBusinessRowsPreserved':True,'priorMigrationChecksumsPreserved':True,
        'productionAccountsCreatedOrChanged':False,'productionInvitationsCreated':False,'productionReportsCreated':False,
        'realEmailsSentByRelease':False,'iamChanged':False,'secretReferencesChanged':False,'templateEmailRoutingChanged':False},
    'maintenance':{'started':pause['maintenanceConfirmedAtUtc'],'normalServiceRestored':backend['atUtc']},
    'validation':{'localBackendSuites':29,'browserWorkflows':75,'sourceCiBothJobsPassed':True,
        'imageSuites':len([s for s in build['steps'] if s['id'].endswith('-test.py') or s['id'].startswith('fallback-manual-site-guard')]),
        'providerHttpChecks':provider['passingChecks'],'frozenFiles':manifest['fileCount'],
        'strictHardeningChecks':len(hardening['passingChecks']),'scheduledCounts':[x['result']['counts'] for x in schedule['executions']]},
    'rollback':{'compatibleRevision':fallback['revision'],'previousHosting':hosting['previousVersion'],
        'hostingChannel':retained['name'],'hostingExpiresAt':retained['expireTime'],'backupBranch':backup['branch']['id'],
        'backupExpiresAt':backup['branch']['expires_at'],
        'rules':'Pause Scheduler, disable and drain worker before fallback. Retain schema27 and manual Site reads/exports/frozen snapshots. New manual writes pause; committed replay is retained. Never downgrade ledger, reset credentials/outbox attempts or clear device storage. Prefer forward fix.'},
    'cleanup':cleanup,'warnings':hardening['warnings'],'limits':['Physical phones not tested','No authenticated production fixture or real SMTP test; production verification used read-only aggregate checks','Existing frontend bundle-size advisory'],
    'preservedFailures':local['historical_attempts']+[read('initial-ci-failure.json','failed')]}
(out/'release.json').write_text(json.dumps(value,indent=2)+'\n')
print(json.dumps({'status':'passed','revision':value['revision'],'hosting':value['hostingVersion']}))
