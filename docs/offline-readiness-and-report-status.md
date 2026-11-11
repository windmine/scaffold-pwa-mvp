# Offline readiness and Report receipts

Local implementation only. Nothing in this change commits, pushes, publishes, deploys, sends real email or creates a production Report. No migration or new package dependency is required.

## Before going offline

Workers see **Before going offline** in New Report. **Check this device** verifies:

- The current active Worker and home Department match the identity saved in this browser. This is a local identity check, not proof that an offline session remains valid on the server.
- A readable, exact Worker/Department snapshot contains active Report Template Definitions. Details show the saved count and time.
- Small Blob add/read/delete transactions succeed in the existing base, evidence, recovery and recipient-aware IndexedDB namespaces. Collision-resistant probe keys are added and removed atomically. Business records, queues, drafts and their original evidence are unchanged.
- The controlling service worker confirms every asset in its current app-shell cache exists with a successful, non-opaque response and the expected content type. A missing/old worker, incomplete cache or timed-out check is not reported as ready.

Checks are bounded and fenced against sign-out, account/Department changes and stale responses. They rerun after relevant session/template/connectivity/controller events and can be repeated manually. Supervisors do not receive a false offline authoring promise; their existing online-only Template behavior is unchanged.

This is a point-in-time check. It cannot reserve storage, guarantee capacity for a photo batch, prevent browser eviction, guarantee future credentials, or promise operating-system background sync. Keep original photos, do not clear site data, keep the app open when reconnecting, and confirm Submitted in My Reports. No persistent-storage permission is requested.

## Report receipts

- **Saved on this device** means a local saved/recovery copy. It is not proof of server submission.
- **Waiting to sync** and **Syncing** state that server submission and email are not yet confirmed. A request can reach the server before its response is lost.
- **Submitted** requires a server Report identity and confirmed synchronized/backend state. The compact receipt and More details show the Report number. The existing immutable server submission time remains distinct from Report Date and local capture time.
- Workers see only their own automatic PDF copy's outcome: pending, accepted, failed, uncertain or unavailable. Accepted means the mail server accepted it, not that the inbox received it. Uncertain outcomes instruct the Worker not to submit again.

Use Refresh reports to fetch the latest email outcome. Pending can remain pending while the configured worker is disabled or has not run; the UI does not infer success from elapsed time. Email failure does not undo a submitted Report. Older Reports/backends with no verifiable own-copy status display unavailable rather than claiming delivery or failure.

The additive `pdf_email_self: {status}` field is attached only to authorized own-Report create/replay/history/recovery responses. It exposes no address, other recipient, recipient count, raw error or SMTP details. The frozen submitter envelope supplies the status; missing or ambiguous data is unknown. Supervisor detailed email views, exports and frozen payloads are unchanged.

After a lost POST response, history prefers the durable Report with the same author/Client Submission ID without deleting or modifying the pending local retry. Existing idempotent replay reconciles that retry. An immediate successful replay is re-read through the original identity scope before displaying the post-submit receipt, avoiding a stale Waiting to sync banner.

## Compatibility and verification

Keep all existing database namespaces, definitions, original Blob evidence, retry ownership and authentication controls. Deploy a compatible backend before a future frontend promotion for the new status field; old backends safely show status unavailable. Regenerate the service worker after app-shell source changes. No deployment is authorized by this local implementation.

Focused checks:

- `npm run check:offline-readiness`: actual IndexedDB probes, snapshot/identity isolation, timeout/late-result/logout races and controlling-worker cache validation.
- `npm run check:report-status`: email-state privacy, mobile/desktop rendering, offline document restart, lost-response reconciliation and backend status serialization/authorization.
- `node scripts/report-submit-review-test.mjs`: review/back/cancel/evidence flows and lost response followed by immediate successful same-key replay.
- `python .github/scripts/run_local_checks.py mobile` and `python .github/scripts/run_local_checks.py backend`: isolated complete gates, with real SMTP disabled and disposable databases.

The readiness/status UI includes English and Chinese and is checked at narrow phone and desktop widths. Headless browser checks are not physical-phone tests. Production sign-in, live Report submission, real mailbox delivery, full OS/process-killed recovery and browser-eviction behavior are not claimed. Cache readiness is validated from the active worker and existing offline/reconnect workflow checks, not inferred from `navigator.onLine`.

## Local validation result (2026-11-11)

Final lint/build, all 31 disposable backend suites, the backend cleanup contract, and the complete mobile gate pass. The gate includes 75 real-backend browser workflows and the strengthened built-app cold-offline/readiness/receipt flow. Readiness and receipt layouts were visually reviewed at 320/390px and desktop widths in English/Chinese and light/dark themes. The existing build chunk-size warning remains. [Local evidence and retained earlier test failures](evidence/offline-readiness-status-local-20261111.json). No commit, push, deployment, migration, production Report or real email was performed.
