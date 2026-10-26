"""Update deployment truth only after all release verification has passed."""
from pathlib import Path
import json
out=Path(__file__).resolve().parent
root=Path.cwd()
v=json.loads((out/'release.json').read_text())
assert v['status']=='passed'
r=v['rollback']; t=v['validation']
paragraph=(f"Source `{v['sourceCommit']}` is live as backend `{v['revision']}` at 100% without tags and exact Hosting "
    f"`{v['hostingVersion']}`, cache `{v['cacheVersion']}`. Workers and Supervisors can select an authorized Site, "
    "type a per-Report Site name, or leave Site blank. Manual names create no shared Site and remain scoped to the Report. "
    "Drafts, offline replay, correction conflicts, Find and exports preserve the choice; frozen original PDF-email snapshots remain unchanged. "
    "Additive `0027_report_manual_site` and compatible backend/worker preceded Hosting. Paused backup/migration and final inventory preserve "
    "existing business fingerprints and all 26 prior migration checksums. No production Reports, Sites, accounts, invitations or emails were created by the release. "
    "All 13 templates retain disabled routing and the outbox remains empty. Existing IAM, settings and secret references, including SMTP version 1, remain unchanged. "
    "Public-registration email and web-process PDF dispatch remain disabled. The existing five-minute worker is restored with one task, batch 10 and zero retries; "
    "its observed normal run returned zero accepted/failed/uncertain/skipped.")
validation=(f"Validation passed: 29 local backend suites, 75 real-backend browser workflows, build/lint, exact-source CI, {t['imageSuites']} image suites, "
    f"{t['providerHttpChecks']} isolated provider HTTP checks, {t['frozenFiles']}-file preview/live parity, 79 shell assets and seven installer checks per origin, "
    "four waiting-update checks, current recovery and 40 strict hardening checks. The first frontend CI failure and its test-only completion-wait correction remain recorded; "
    "the transient empty storage snapshot was not reproduced locally. All 128 packaged backend files are byte-identical across the implementation and test-only commits. "
    "Existing six-hour recovery-history and bundle-size warnings remain. No physical-phone, authenticated production-fixture or real SMTP test is claimed.")
rollback=(f"Retain schema-27-compatible fallback `{r['compatibleRevision']}`, previous Hosting `{r['previousHosting']}` in "
    f"`{r['hostingChannel'].split('/')[-1]}` until `{r['hostingExpiresAt']}`, and backup `{r['backupBranch']}` until `{r['backupExpiresAt']}`. "
    "Pause Scheduler, disable and drain the worker before fallback. The fallback blocks new nonempty manual Site writes while retaining stored labels, reads/exports, "
    "committed replay, existing-ID/no-Site submissions, existing invitation support and frozen snapshots. Old schema-26 images reject the ledger. Prefer a forward fix; "
    "never downgrade migrations, reset credentials/auth generations or outbox attempts, or clear device storage. Reverify retained resources before use.")
link='[Release evidence](docs/evidence/manual-site-release-20261026/release.json)'
context=root/'CONTEXT.md'; text=context.read_text(encoding='utf-8')
start=text.index('**Local Site entry change (2026-10-26; not deployed):**')
end=text.index('\n\n',start)
text=text[:start]+'**Current Site choice release (2026-10-26 UTC):** '+paragraph+' '+link+'.\n\n'+validation+' '+rollback+text[end:]
text=text.replace('Source `fc9e17b4f0814587a4cf0f471d607f361f109adc` is live as backend', 'Earlier staff invitation release source `fc9e17b4f0814587a4cf0f471d607f361f109adc` served backend',1)
text=text.replace('Deployment truth was refreshed on 2026-10-22 UTC','Deployment truth was refreshed on 2026-10-26 UTC',1)
context.write_text(text,encoding='utf-8',newline='\n')
agents=root/'AGENTS.md'; text=agents.read_text(encoding='utf-8')
anchor='## Current Implementation Notes\n'
assert text.count(anchor)==1
text=text.replace(anchor,anchor+'\n- **Current Site choice release (2026-10-26 UTC)**: '+paragraph+' '+validation+' '+rollback+' '+link+', [behavior](docs/report-manual-sites.md).\n',1)
text=text.replace('**Current staff invitations release (2026-10-23 UTC)**','**Earlier staff invitations release (2026-10-23 UTC; superseded by the Site release above)**',1)
agents.write_text(text,encoding='utf-8',newline='\n')
runbook=root/'docs/production-db-runbook.md'; text=runbook.read_text(encoding='utf-8')
anchor='# Production Database And Deployment Runbook\n'
text=text.replace(anchor,anchor+'\n## Current Site choice release\n\n'+paragraph+'\n\n'+validation+'\n\n'+rollback+'\n\n[Evidence](evidence/manual-site-release-20261026/release.json).\n',1)
text=text.replace('## Current staff invitation release','## Earlier staff invitation release',1)
runbook.write_text(text,encoding='utf-8',newline='\n')
behavior=root/'docs/report-manual-sites.md'; text=behavior.read_text(encoding='utf-8')
text=text.replace('Prepared for the user-approved release; live verification is still pending.', 'Released and verified on 2026-10-26 UTC. [Release evidence](evidence/manual-site-release-20261026/release.json).',1)
text=text.replace('The approved release must run final source CI, verify recovery and a','The completed release ran final source CI, verified recovery and a',1)
text=text.replace('schema-27-compatible fallback, apply the additive migration, then release compatible','schema-27-compatible fallback, applied the additive migration, then released compatible',1)
behavior.write_text(text,encoding='utf-8',newline='\n')
print(json.dumps({'status':'passed','documents':['AGENTS.md','CONTEXT.md','docs/production-db-runbook.md','docs/report-manual-sites.md']}))
