"""Publish documentation only after the verified release record exists."""
from pathlib import Path
import json

root = Path.cwd()
out = Path(__file__).resolve().parent
release = json.loads((out / 'release.json').read_text())
assert release['status'] == 'passed'
source = release['sourceCommit']
revision = release['revision']
hosting = release['hostingVersion']
cache = release['cacheVersion']
rollback = release['rollback']
summary = (
    f"Source `{source}` is live as backend `{revision}` at 100% without tags and exact Hosting "
    f"`{hosting}`, cache `{cache}`. Additive `0026_staff_invitations` and its compatible backend/worker "
    "preceded Hosting. Worker, Supervisor and authorized global-admin invitations preserve existing role/Department "
    "grant authority. Pending accounts cannot sign in before single-use expiring password setup. Creating an "
    "invitation and sending its email are separate explicit actions; immediate account creation is clearly labelled. "
    "Every invitation email includes the public Getting Started PDF, whose QR contains only the canonical app URL. "
    "The private activation link remains separately in the email body. SMTP acceptance is not mailbox delivery."
)
preservation = (
    "The paused backup/migration and final inventory preserve all existing business fingerprints and all 25 prior "
    "migration checksums, including existing account 29. No production account/invitation/report or real email was "
    "created by this release. All 13 templates retain disabled email routing; the outbox is empty. The existing "
    "five-minute worker is restored with one task, batch 10 and zero retries; its observed normal run returned zero "
    "accepted/failed/uncertain/skipped. Existing IAM, runtime settings and secret references, including SMTP version 1, "
    "are preserved. Public-registration email and web-process PDF dispatch remain disabled."
)
validation = (
    "Validation passed: 28 local backend suites, 75 real-backend browser workflows, 14 mocked invitation-email tests, "
    "build/lint, both source-CI jobs, 20 exact-image suites, 266 isolated provider HTTP checks, preview/live 88-file parity, "
    "78 shell-asset and seven installer checks per origin, four waiting-update checks, current recovery and 40 strict "
    "hardening checks. The guide was rendered and its QR decoded locally. Historical failed test attempts and the "
    "maintenance-tag length rejection remain recorded; the rejected operation created no revision, and one corrected "
    "attempt passed. Existing six-hour recovery-history and bundle-size warnings remain. No physical-phone, real SMTP "
    "or authenticated production-fixture test is claimed."
)
fallback = (
    f"Retain compatible fallback `{rollback['compatibleRevision']}`, previous Hosting `{rollback['previousHosting']}` "
    f"in `rollback-staff-invite-20261023` until `{rollback['hostingExpiresAt']}`, and backup "
    f"`{rollback['backupBranch']}` until `{rollback['backupExpiresAt']}`. Pause Scheduler, disable the worker and drain "
    "executions before fallback. The fallback retains schema 26, pending-role protections, existing Worker invitations "
    "and acceptance, Report corrections, extended template rendering/exports and frozen PDF outbox behavior, while "
    "disabling new staff-invitation creation. Old 0025-only images reject the ledger. Prefer a forward fix; never "
    "downgrade migrations, reset credentials/auth generations or invitation attempts, or clear device storage. "
    "Reverify retained resources before use."
)

def edit(name, transform):
    path = root / name
    old = path.read_text(encoding='utf-8')
    new = transform(old)
    assert new != old, name
    path.write_text(new, encoding='utf-8', newline='\n')

def replace_section(text, start, end, replacement):
    assert start in text and end in text
    first = text.index(start)
    last = text.index(end, first)
    return text[:first] + replacement + '\n\n' + text[last:]

edit('README.md', lambda s: replace_section(s,
    '## Local staff invitation extension (not deployed)', '## Current source-template support release',
    '## Current staff invitation release\n\n' + summary + '\n\n' + preservation + '\n\n' + validation +
    '\n\n[Behavior](docs/staff-invitations.md). [Release evidence](docs/evidence/staff-invitations-release-20261023/release.json).')
    .replace('## Current source-template support release', '## Earlier source-template support release', 1))
edit('AGENTS.md', lambda s: s.replace('## Current Implementation Notes\n',
    '## Current Implementation Notes\n\n- **Current staff invitations release (2026-10-23 UTC)**: ' + summary + ' ' +
    preservation + ' ' + validation + ' ' + fallback +
    ' [Release evidence](docs/evidence/staff-invitations-release-20261023/release.json), '
    '[behavior](docs/staff-invitations.md).\n', 1)
    .replace('**Current source-template support release', '**Earlier source-template support release', 1))
edit('CONTEXT.md', lambda s: s.replace('# Leader Field Reports Context\n',
    '# Leader Field Reports Context\n\n' + summary + ' ' + preservation +
    ' [Release evidence](docs/evidence/staff-invitations-release-20261023/release.json).\n', 1)
    .replace('Source-template support is live from', 'Earlier source-template support was released from', 1)
    .replace('**Staff invitation extension (local, not deployed)**:', '**Staff invitation extension (released 2026-10-23 UTC)**:', 1)
    .replace('Migration 0026 and compatible backend/worker must precede Hosting after separate release approval.',
             'Migration 0026 and its compatible backend/worker preceded Hosting. All explicit invitation emails include the public installation-guide PDF; the private setup link stays separately in the body.', 1)
    .replace('A new Worker account provisioned by a Supervisor and blocked from signing in until the Worker sets their own password',
             'A new Worker or Supervisor account provisioned by an actor with existing role-grant authority and blocked from signing in until the recipient sets their own password', 1))
edit('docs/production-db-runbook.md', lambda s: replace_section(s,
    '## Pending staff invitation extension', '## Source-template support release',
    '## Current staff invitation release\n\n' + summary + '\n\n' + preservation + '\n\n' + fallback +
    '\n\n[Evidence](evidence/staff-invitations-release-20261023/release.json). No real invitation is part of release verification.')
    .replace('## Source-template support release', '## Earlier source-template support release', 1))
edit('docs/staff-invitations.md', lambda s: replace_section(s.replace(s.splitlines()[0], '# Staff invitations', 1),
    '## Release boundary', '## Invitation getting-started guide',
    '## Released behavior and recovery\n\n' + summary + '\n\n' + preservation + '\n\n' + fallback +
    '\n\nExisting accounts are not invitation/reset targets. Account 29 remains unchanged. '
    '[Verified release](evidence/staff-invitations-release-20261023/release.json).')
    .replace('Final validation outcomes are recorded separately after the complete gates finish.', validation, 1))
print(json.dumps({'status': 'passed', 'updatedDocumentationFiles': 5, 'release': revision}))
