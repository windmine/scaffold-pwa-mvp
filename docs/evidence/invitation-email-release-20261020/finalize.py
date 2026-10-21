"""Record only verified release outcomes and update current deployment guidance."""
from release_operator import *


def main():
    required = ['ci-source.json','production-proof.json','backend-promotion.json','hosting-promotion.json',
                'preview-shell.json','preview-installer.json','preview-full-parity.json','live-shell.json',
                'live-installer.json','live-full-parity.json','live-waiting-update.json','neon-current-final.json',
                'hardening-current-final.json','live-backend-verification.json','post-release-proof.json','cleanup.json']
    for name in required:
        value = read(name)
        assert value.get('status') == ('completed' if name=='ci-source.json' else 'passed'), name
    assert not (OUT/'release.json').exists()
    migration = read('production-proof.json')
    final = read('post-release-proof.json')['before']
    assert migration['after'] == final, 'Final inventory changed; investigate before claiming preservation'
    backend, frontend = read('backend-promotion.json'), read('hosting-promotion.json')
    manifest, backup = read('build-manifest.json'), read('backup.json')
    pause = read('pause.json')
    start = datetime.fromisoformat(pause['maintenanceConfirmedAtUtc'])
    resumed = datetime.fromisoformat(backend['atUtc'])
    failures = [
        {'stage':'local full mobile','result':'Initial unchanged Retry-After wall-clock assertion failed; isolated and complete reruns passed. Original cause remains unconfirmed.'},
        {'stage':'image verification','result':'Initial fallback harness passed Engine where Connection was required; corrected harness on unchanged image sources passed.'},
        {'stage':'runtime probe','result':'Initial host hash used raw text instead of historical canonical JSON. Read-only verification proved no migration occurred; corrected identity check passed.'},
        {'stage':'staging smoke','result':'Initial probe applied 0023 and passed before/after data assertions before smoke failed. Retrying against its used fixture database then hit an existing invitation. Fresh disposable databases now isolate provider smoke.'},
        {'stage':'runtime-image smoke','result':'Fresh run passed 199 checks before the unchanged legacy HTML export logo assertion. The normal repository logo fixture, identical to the image packaged Report logo, was supplied only in the disposable job; all 248 checks passed. Production image packaging was unchanged.'},
        {'stage':'first post-migration hardening','result':'38 checks passed; monitoring still included maintenance-period failures and the successful one-minute recovery proof did not satisfy the gate strict older-than-one-minute condition. A two-minute proof and refreshed monitoring were required; no safety gate was weakened.'},
    ]
    record = {'schemaVersion':1,'status':'passed','recordedAtUtc':now(),'sourceCommit':SOURCE,
              'sourceCiRun':39515236017,'sourceCiUrl':read('ci-source.json')['url'],
              'imageBuild':read('images.json'),'backend':backend,'frontend':frontend,
              'cacheVersion':manifest['cacheVersion'],'migration':{'head':final['migrationHead'],
              'count':final['migrationCount'],'applied':migration['applied'],'businessDataPreserved':True,
              'oldMigrationChecksumsPreserved':True,'finalInventoryMatchesMigrationResult':True,'emailAttemptRows':final['emailAttemptRows']},
              'maintenance':{'confirmedAtUtc':start.isoformat(),'resumedVerifiedAtUtc':resumed.isoformat(),
                             'durationSeconds':round((resumed-start).total_seconds(),1),'drainSeconds':300},
              'rollback':{'compatibleBackendRevision':'geo-backend-invite-fallback-20261020',
                         'compatibleImage':read('images.json')['images']['fallback'],
                         'oldOriginalBackendUnsafeAfter0023':True,'hosting':read('hosting-retention.json')['channel'],
                         'databaseBackup':backup['branch'],'backupReadOnlyInventoryMatchedProduction':True,
                         'preserveDeviceStorageAndAuthenticationGenerations':True},
              'validation':{'localBackendSuites':23,'invitationBackendTests':11,'smtpMockTests':10,
                            'invitationBrowserChecks':12,'realBackendBrowserWorkflows':73,
                            'postgres17FullChecks':82,'postgres18FullChecks':82,'providerSmokeChecks':248,
                            'previewAndLiveFiles':85,'previewAndLiveShellAssets':75,'installerArtifactsEach':7,
                            'waitingUpdateChecks':len(read('live-waiting-update.json')['checks']),
                            'strictHardeningChecks':len(read('hardening-current-final.json')['passingChecks'])},
              'scope':{'realEmailsSent':False,'smtpAuthenticationAttempted':False,'productionUsersOrInvitationsCreated':False,
                       'secretPayloadRead':False,'iamChanged':False,'smtpSecretVersion':'reportflow-smtp-password:1',
                       'publicAppUrl':HOST,'publicRegistrationEmailEnabled':False,'pdfEmailImplemented':False},
              'cleanup':read('cleanup.json'),'earlierAttempts':failures,
              'warnings':read('hardening-current-final.json')['warnings'] + ['Existing frontend main bundle exceeds 500 kB.'],
              'limitations':['No authenticated production fixture, intended-recipient invitation, real email or physical-phone workflow was exercised.',
                             'SMTP acceptance is not mailbox delivery; invitations are one explicit Supervisor attempt each.',
                             'Retained legacy HTML logo packaging limitation remains unchanged; provider smoke used the documented repository fixture.'],
              'evidenceSha256':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(OUT.iterdir()) if p.is_file() and p.name!='release.json'}}
    write('release.json',record)
    release_date = backend['atUtc'][:10]
    paragraph = (f"Invitation emails are live from source `{SOURCE}`: backend `{backend['revision']}` serves 100% without tags, "
                 f"and exact Hosting `{frontend['version']}` uses cache `{manifest['cacheVersion']}`. Additive `0023_worker_invitation_email` "
                 "and its compatible backend preceded Hosting. Paused migration and final read-only inventories preserve all existing business rows "
                 "and prior migration checksums. `PUBLIC_APP_URL` is `https://geo-attendance-system-db9ca.web.app`; SMTP secret version 1, other "
                 "secret references and IAM are unchanged. Supervisors explicitly send once to the saved invitee email; Copy/Share remains. "
                 "SMTP acceptance is not delivery. Public-registration email stays disabled; password recovery remains manual and PDFs remain downloads.")
    validation = ("Source CI passes both jobs, including all 73 real-backend browser workflows. Local 23 backend suites, 11 invitation tests, "
                  "10 mocked SMTP tests,12 invitation browser checks, native PostgreSQL 17.6/18.4 (82 each), provider 248, preview/live 85-file parity, "
                  "75 shell assets, seven installer artifacts and four waiting-update checks pass. Current recovery and strict hardening pass with "
                  "the existing six-hour recovery-history warning. No real emails, SMTP authentication, production users/invitations, authenticated "
                  "production fixtures or physical-phone checks were performed in this release.")
    rollback = (f"Retain compatible fallback `geo-backend-invite-fallback-20261020`, exact prior Hosting `61d90b34933c5079` in "
                f"`rollback-invite-20261020` until `{read('hosting-retention.json')['channel']['expireTime']}`, and backup "
                f"`{backup['branch']['id']}` until `{backup['branch']['expires_at']}`. Reverify before use. Original 0022-only backend revisions "
                "reject the new ledger; never downgrade the ledger, reset credentials/auth generations or clear device storage for rollback.")
    for filename in ['README.md','AGENTS.md','CONTEXT.md','docs/production-db-runbook.md']:
        path=ROOT/filename
        source=path.read_text(encoding='utf-8')
        if filename=='README.md':
            source=source.replace('Local invitation-email changes are prepared for review and are **not deployed**.',
                                  f'Invitation emails were deployed on {release_date} UTC. [Release evidence](docs/evidence/invitation-email-release-20261020/release.json).')
            source=source.replace('Future deployment requires additive migration `0023_worker_invitation_email` and the compatible backend before Hosting.',
                                  'The release applied additive migration `0023_worker_invitation_email` and deployed its compatible backend before Hosting.')
        elif filename=='AGENTS.md':
            source=source.replace('## Current Implementation Notes\n','## Current Implementation Notes\n\n- **Current invitation-email release ('+release_date+' UTC)**: '+paragraph+' '+validation+' '+rollback+' [Release evidence](docs/evidence/invitation-email-release-20261020/release.json).\n',1)
            source=source.replace('**Local invitation email preparation (not deployed)**','**Historical local invitation email preparation (subsequently released above)**',1)
            source=source.replace('**Current backend SMTP configuration (October 20 UTC)**','**Earlier backend SMTP configuration (superseded by the invitation release above)**',1)
            source=source.replace('**Current Clear-alignment frontend release (October 14 UTC)**','**Earlier Clear-alignment frontend release (superseded by the invitation release above)**',1)
        elif filename=='CONTEXT.md':
            source=source.replace('**Invitation email** (local preparation, not deployed):','**Invitation email** (released '+release_date+' UTC):',1)
            source=source.replace('No production migration, deployment or real invitation send is included in this preparation.',
                                  'Migration 0023, its compatible backend and the frontend are deployed; no real invitation was sent by the release. [Release evidence](docs/evidence/invitation-email-release-20261020/release.json).',1)
        else:
            source=source.replace('## Deployment Truth\n','## Deployment Truth\n\n### Current invitation-email release - '+release_date+' UTC\n\n'+paragraph+'\n\n'+validation+'\n\n'+rollback+'\n\nThe initial build/probe/smoke harness failures and supplemental legacy-logo fixture are retained in the [release record](evidence/invitation-email-release-20261020/release.json). Temporary staging jobs and branch were deleted and absence verified. This release used mocked/local invitation coverage and anonymous hosted checks; no production application fixtures were authorized.\n',1)
            source=source.replace('### Current Backend Release - SMTP configuration, 2026-10-20','### Historical Backend Release - SMTP configuration, 2026-10-20',1)
        path.write_bytes(source.encode('utf-8'))
    print(json.dumps({'status':'passed','releaseRecord':str(OUT/'release.json'),'backend':backend['revision'],'hosting':frontend['version']}))


if __name__=='__main__': main()
