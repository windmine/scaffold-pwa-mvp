"""Publish release documentation only after every required proof has passed."""
from release_operator import *


def main():
    required=['ci-source.json','production-proof.json','backend-promotion.json','hosting-promotion.json',
        'preview-full-parity.json','preview-shell.json','preview-installer.json','live-full-parity.json',
        'live-shell.json','live-installer.json','live-waiting-update.json','neon-current-final.json',
        'hardening-current-final.json','live-backend-verification.json','post-release-proof.json',
        'scheduled-worker-verification.json','cleanup.json']
    for name in required:
        value=read(name)
        assert value.get('status')==('completed' if name=='ci-source.json' else 'passed'),name
    source_ci=read('ci-source.json')
    assert source_ci['headSha']==SOURCE and source_ci['conclusion']=='success'
    assert all(job['conclusion']=='success' for job in source_ci['jobs'])
    assert not (OUT/'release.json').exists()
    migration=read('production-proof.json'); final=read('post-release-proof.json')['before']
    assert migration['after']==final,'Final inventory changed; investigate rather than claiming exact preservation'
    assert final['outboxRows']==final['configuredTemplateRows']==0
    backend=read('backend-promotion.json'); hosting=read('hosting-promotion.json')
    pause=read('pause.json'); backup=read('backup.json')['branch']; retained=read('hosting-retention.json')['channel']
    manifest=read('build-manifest.json')
    record={'schemaVersion':1,'status':'passed','recordedAtUtc':now(),'sourceCommit':SOURCE,
        'sourceCi':{'id':read('source-ci-id.json')['id'],'url':read('ci-source.json')['url'],'jobsPassed':True},
        'imageBuild':read('images.json'),'backend':backend,'frontend':hosting,'cacheVersion':manifest['cacheVersion'],
        'migration':{'head':final['migrationHead'],'count':final['migrationCount'],'applied':migration['applied'],
            'businessDataPreserved':True,'oldMigrationChecksumsPreserved':True,'finalInventoryMatchesMigrationResult':True,
            'configuredTemplateRows':0,'outboxRows':0},
        'maintenance':{'confirmedAtUtc':pause['maintenanceConfirmedAtUtc'],'resumedAtUtc':backend['atUtc'],
            'durationSeconds':round((datetime.fromisoformat(backend['atUtc'])-datetime.fromisoformat(pause['maintenanceConfirmedAtUtc'])).total_seconds(),1),'drainSeconds':300},
        'worker':{'name':'reportflow-pdf-email','cadence':'*/5 * * * *','timeZone':'Etc/UTC','taskCount':1,
            'parallelism':1,'maxRetries':0,'batchLimit':10,'timeoutSeconds':600,'cpu':'1','memory':'512Mi',
            'verification':read('scheduled-worker-verification.json')},
        'iam':{'newProjectGrant':read('scheduler-service-agent.json')['addedBindings'],
            'jobOnlyInvoker':read('worker-invoker.json'),'existingServiceAndSecretIamPreserved':True},
        'rollback':{'compatibleBackendRevision':'geo-backend-report-pdf-fallback-20261021',
            'compatibleImage':read('images.json')['images']['fallback'],'overlays':['migration0024','models','outbox purge'],
            'pauseSchedulerAndDisableWorkerBeforeFallback':True,'original0023ImagesRejectLedger':True,
            'hosting':retained,'databaseBackup':backup,'neverDowngradeLedgerOrResetCredentialsOrClearDeviceStorage':True},
        'validation':{'localBackendSuites':25,'mockedPdfEmailTests':18,'supervisorHttpTests':8,
            'realBackendBrowserWorkflows':75,'nativePostgres17Checks':len(read('postgres17.json')['checks']),
            'nativePostgresVolume':'passed unchanged SQL budgets','fallbackLocalChecks':3,
            'providerSmokeChecks':read('stage-provider-proof.json')['api']['passingChecks'],
            'previewAndLiveFileCount':manifest['fileCount'],'waitingUpdateChecks':len(read('live-waiting-update.json')['checks']),
            'strictHardeningChecks':len(read('hardening-current-final.json')['passingChecks'])},
        'scope':{'realEmailsSent':False,'smtpAuthenticationAttempted':False,'productionFixturesCreated':False,
            'realRoutingEnabled':False,'smtpPasswordPayloadRead':False,'smtpSecretVersion':'reportflow-smtp-password:1',
            'publicRegistrationEmailEnabled':False,'webServicePdfWorkerEnabled':False},
        'earlierAttempts':[read('ci-export-fix.json'),read('ci-invitation-timeout.json'),read('image-test-harness-diagnosis.json'),read('worker-invoker-diagnosis.json'),
            {'stage':'pre-migration hardening','result':'Old Current/0023 recovery evidence did not match the new PreMigration/0024 contract; a fresh phase-bound proof was required. No gate weakened.'}],
        'warnings':read('hardening-current-final.json')['warnings']+['Existing frontend main bundle exceeds 500 kB.'],
        'limitations':['No real PDF email, authenticated production fixtures or physical-phone test performed.',
            'Supervisor cold-offline Template catalogs are not added; an already opened form can queue offline.',
            'Accepted means SMTP acceptance, not mailbox delivery. Accepted/uncertain attempts are never automatically retried.',
            'The first fixed-source CI invitation account-switch timeout remains unexplained despite isolated and complete rerun passes.',
            'Retained legacy HTML logo packaging is unchanged; staging smoke uses the existing repository-logo fixture.'],
        'costs':read('release-plan.json')['costs'],'cleanup':read('cleanup.json')}
    write('status.json',{'atUtc':now(),'status':'deployed_and_verified_release_record_ci_pending','sourceCommit':SOURCE,
        'backendRevision':backend['revision'],'hostingVersion':hosting['version'],'migration':final['migrationHead'],
        'normalServiceRestored':True,'schedulerEnabled':True,'allTemplatesOff':True,'outboxRows':0,'emailsSent':False})
    record['evidenceSha256']={p.relative_to(OUT).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(OUT.rglob('*')) if p.is_file() and '__pycache__' not in p.parts and p.name!='release.json'}
    write('release.json',record)
    paragraph=(f"Supervisor Submit form and optional per-template PDF email are live from `{SOURCE}`: backend `{backend['revision']}` serves 100% without tags; "
        f"Hosting `{hosting['version']}` uses cache `{manifest['cacheVersion']}`. Additive `0024_report_pdf_email` and the compatible backend preceded Hosting. "
        "Existing business rows and all prior migration checksums are preserved. Supervisors submit as themselves within their home Department. "
        "Every production Template remains off and the outbox is empty; no real Reports or emails were created by this release. "
        "The five-minute worker uses one task, batch 10, zero retries, the existing backend runtime and SMTP secret version 1. "
        "Only the standard Google Scheduler service-agent project role and the dedicated trigger's job-only invocation were added. "
        "Existing service/secret permissions and SMTP settings are preserved; public registration and web-process dispatch remain disabled.")
    validation=("Source CI passes both jobs and all 75 real-backend browser workflows. The export query regression was fixed without raising limits. "
        "The first fixed-source CI invitation account-switch timeout remains unconfirmed; three unchanged isolated checks and one complete frontend rerun passed. "
        "Native PostgreSQL, exact-image mocked SMTP/fallback, isolated provider staging, read-only live/offline parity, current recovery and strict hardening pass. "
        "The existing six-hour recovery warning and physical-phone/cold-offline Supervisor catalog limits remain. No real email or SMTP authentication was exercised.")
    rollback=(f"Retain fallback `geo-backend-report-pdf-fallback-20261021`, previous Hosting `4988eacbe73feaaf` in `rollback-report-pdf-20261021` until `{retained['expireTime']}`, "
        f"and backup `{backup['id']}` until `{backup['expires_at']}`. Pause Scheduler and disable the worker before fallback. The fallback retains migration 0024 and outbox purge protection. "
        "Original 0023-only images reject the ledger. Never downgrade migrations, reset credentials/auth generations or clear device storage; reverify retained resources before use.")
    link='[Release evidence](docs/evidence/report-submit-pdf-release-20261021/release.json).'
    updates={}
    for filename in ['README.md','AGENTS.md','CONTEXT.md','docs/production-db-runbook.md','docs/report-pdf-email.md','docs/supervisor-report-submission.md']:
        text=(ROOT/filename).read_text(encoding='utf-8')
        if filename=='README.md':
            text=text.replace('## Current Version\n','## Current Version\n\n'+paragraph+' '+link+'\n\n'+validation+'\n\n'+rollback+'\n\n### Earlier invitation release\n',1)
            text=text.replace('No extra IAM, mailbox access, bulk sending, password-recovery email or PDF emailing is introduced.','That earlier release introduced no mailbox access, bulk sending, password-recovery email or PDF emailing.',1)
        elif filename=='AGENTS.md':
            text=text.replace('## Current Implementation Notes\n','## Current Implementation Notes\n\n- **Current combined release (2026-10-21 UTC)**: '+paragraph+' '+validation+' '+rollback+' '+link+'\n',1)
            text=text.replace('**Local optional PDF email preparation (not deployed)**','**Historical local optional PDF email preparation (released above)**',1)
            text=text.replace('**Current invitation-email release (2026-10-21 UTC)**','**Earlier invitation-email release (superseded by the combined release above)**',1)
        elif filename=='CONTEXT.md':
            text=text.replace('Deployment truth was refreshed on 2026-10-12','Deployment truth was refreshed on 2026-10-21',1)
            text=text.replace('## People And Scope\n','## People And Scope\n\n'+paragraph+' '+link+'\n',1)
            text=text.replace('**Optional Report PDF email (local preparation, not deployed)**','**Optional Report PDF email (released 2026-10-21 UTC)**',1)
            text=text.replace('The local, unreleased Submit form section','The released Submit form section').replace('The local unreleased Supervisor section','The released Supervisor section')
            text=text.replace('and bounded worker require additive migration 0024 and a separately approved\nscheduled runtime before activation.',
                'and bounded worker use deployed additive migration 0024 and the approved five-minute\nscheduled runtime. Production routing remains off until recipients are chosen.')
        elif filename=='docs/production-db-runbook.md':
            text=text.replace('## Deployment Truth\n','## Deployment Truth\n\n### Current combined release - 2026-10-21 UTC\n\n'+paragraph+'\n\n'+validation+'\n\n'+rollback+'\n\n'+link.replace('(docs/','(')+'\n',1)
            text=text.replace('### Current invitation-email release -','### Historical invitation-email release -',1)
        else:
            title='Optional Report PDF email' if 'pdf-email' in filename else 'Supervisor Submit form'
            old_title,old_body=text.split('\n',1)
            text='# '+title+'\n\nDeployed 2026-10-21 UTC. '+paragraph+' '+link.replace('(docs/','(')+'\n\n## Historical local preparation\n\nThe preparation statements and release prerequisites below describe the pre-release checkpoint; the approved deployment above completed those infrastructure gates. Recipient activation still requires approval.\n'+old_body
        updates[filename]=text
    for filename,text in updates.items(): (ROOT/filename).write_bytes(text.encode('utf-8'))
    print(json.dumps({'status':'passed','backend':backend['revision'],'hosting':hosting['version'],'record':str(OUT/'release.json')}))


if __name__=='__main__': main()
