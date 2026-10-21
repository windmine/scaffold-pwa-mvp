# Supervisor Submit form

Deployed 2026-10-21 UTC. Supervisor Submit form and optional per-template PDF email are live from `80b4ea01a041a84bdcc0483f8e3d41a34d55f117`: backend `geo-backend-report-pdf-20261021` serves 100% without tags; Hosting `12a1d6dbf481ba3b` uses cache `leader-field-c878ffd1be3c`. Additive `0024_report_pdf_email` and the compatible backend preceded Hosting. Existing business rows and all prior migration checksums are preserved. Supervisors submit as themselves within their home Department. Every production Template remains off and the outbox is empty; no real Reports or emails were created by this release. The five-minute worker uses one task, batch 10, zero retries, the existing backend runtime and SMTP secret version 1. Only the standard Google Scheduler service-agent project role and the dedicated trigger's job-only invocation were added. Existing service/secret permissions and SMTP settings are preserved; public registration and web-process dispatch remain disabled. [Release evidence](evidence/report-submit-pdf-release-20261021/release.json).

## Historical local preparation

The preparation statements and release prerequisites below describe the pre-release checkpoint; the approved deployment above completed those infrastructure gates. Recipient activation still requires approval.

Prepared locally, not committed or deployed. The previous optional PDF-email
implementation remains in the working tree and is still awaiting release and
scheduled-worker approval. No real account, Report, email, routing setting,
cloud resource or IAM policy was created or changed.

## Behavior

Report-only Supervisors have a separate **Submit form** section beside Reports,
Report Templates and Staff. It contains the existing **New Report** editor and
**My Reports** history. The single editor is mounted in the appropriate signed-in
shell, so the Worker surface keeps its existing controls and behavior.

Supervisors submit as themselves, using active Report Templates and optional
Sites from their **home Department**. Global review focus never changes this
submission scope. The new API ignores any supplied Worker identity and takes
ownership from the authenticated Supervisor. This does not expose the legacy
on-behalf-of-Worker submission flow or allow Supervisor Daywork/attendance capture.

Required Report Date, answer/formula validation, photos, handwritten signatures,
review-before-submit, immutable Definition snapshots and Report workflow are
shared with the existing Report flow. New Reports start Submitted; existing
Department review permissions apply, including a Supervisor's ability to review
any Report in their authorized scope. No separate self-review prohibition was
introduced.

Private drafts and queued Reports preserve the Supervisor role, account and home
Department. Supervisor ordinary/recovery draft keys are separate from Worker
keys. Navigation keeps unfinished input, reload restores it after Templates load,
and app-controlled logout/update saves first or pauses. Forced session expiry
clears private UI with best-effort saving. Queued evidence keeps its existing
partial-upload and stable Client Submission ID behavior; actual upload and POST
requests bind captured role/account/Department as well as cookie authentication.

An already opened Supervisor form can be queued offline and sync after reconnect.
Supervisor management catalogs are **not** newly cached for cold offline return:
a fresh offline page needs connectivity to load Templates before editing a saved
draft. My Reports shows only the account's own current-Department durable Reports
and role-scoped local copies. A Department/role change cannot silently replay an
old Supervisor queue. Existing Worker offline Template downloads are unchanged.

## API and compatibility

- `POST /supervisor/my-report-submissions`: authenticated Supervisor only, explicit
  captured identity headers, normal CSRF protection, active home-Department Report
  Template/Site, existing validation and replay/purge protections.
- `GET /supervisor/my-report-submissions/by-client-id`: exact own-Report recovery
  lookup; no cross-account result or cross-Department disclosure.
- Existing `/form-submissions` remains Worker-only. Legacy Supervisor manual
  submission still rejects Reports. No role permission is changed globally.
- The existing Report record's `worker_id` column stores the authenticated author
  User ID; no new account, impersonation, table or migration is required for this
  section.
- The pending optional PDF outbox accepts these newly committed Reports too, with
  the same default-off routing, immutable snapshot and one-attempt policy. No SMTP
  runs during submission, and replay cannot add another outbox row.

The compatible backend must precede Hosting. A release of the combined working
tree also needs the pending additive migration 0024 and its backup/rollback gates.
Scheduled PDF dispatch and recipient activation remain separately unapproved.
An older backend rejects the new self-submission route; the client keeps its
queued copy rather than claiming success. Never clear device storage to roll back.

## Validation

All tests use isolated synthetic accounts/data; SMTP and external configuration
are disabled or mocked. Eight focused backend HTTP tests cover authentication,
CSRF/identity binding, self-attribution, global-admin home-Department boundaries,
Date/Definition validation, immutable replay, own history, Department transfer and
PDF-outbox compatibility. The full backend gate passed 25 suites plus its process
cleanup guard. Draft policy tests cover role/key/Department isolation.

New real-backend browser workflows cover navigation and reload, photos/signature,
offline/reconnect, idempotency, account switching, global review-focus isolation
and rejection of Supervisor legacy/cross-role queue records. The first global
scope test lacked a foreign Template fixture; this was corrected with an explicit
local fixture and the unchanged application then passed. The mobile gate also
exposed a stale Report-card action after an in-place role change; callbacks now
bind their rendered author role, and the unchanged regression passes. Supervisor
tabs use separate navigation attributes so existing Worker controls remain
unambiguous. Build, lint, all focused mobile checks, static shell checks and 11
installer checks passed. The first completed full browser portion passed 73/75
with the two navigation-expectation failures described below. After those
test-only corrections, a fresh isolated run passed all 75 workflows. The combined
mobile command was not repeated; the final browser portion was run separately
against unchanged application code. Exact results and prior failures are recorded
in `output/supervisor-submit-local-review.json`.

The real-backend shell assertion was updated to include **Submit form** in the
expected Supervisor navigation; its existing default Reports workspace and
report-only boundaries are still asserted. The retained-interface navigation
check counts visible links, excluding the intentionally hidden Report-only link.

Desktop (1440 px) and phone (390 px) screenshots are under
`output/supervisor-submit.local/`; English desktop/phone and Chinese phone were visually reviewed,
including visible controls, signature, photo, action and no horizontal overflow.
Physical-phone interaction and cold-offline Supervisor editing are not claimed.
