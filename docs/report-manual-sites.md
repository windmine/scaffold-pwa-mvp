# Report Site selection and manual names

Prepared for the user-approved release; live verification is still pending. The shared optional Site control
offers an authorized existing Site, **Type a site name**, or **No site** for both
Workers and Supervisors. A manual name belongs only to the Report. It does not
create, match by name, rename, or grant access to any shared Site.

Existing IDs and their department checks remain. Typed names are trimmed, limited
to 200 characters, and reject control characters. They are mutually exclusive
with `site_id`; empty API values normalize to no manual name. The browser requires
a name when its manual option is selected. Existing template questions labelled
Site remain ordinary answers; no definitions or historical snapshots are rewritten.
Retained Daywork and attendance Site behavior is unchanged.

Drafts, conflict copies, upload recovery and role-bound offline replay carry the
manual name. Review shows the exact name that will be submitted. Durable Reports,
Find text, CSV, HTML and PDF use the same resolved Site display. Manual names are
plain text, escaped by existing renderers. Reports retain their authenticated
author and department regardless of the label entered.

Supervisor corrections can switch between linked, manual and no Site using the
existing confirmation and expected revision. A stale correction cannot overwrite
a newer one. Old editors that send `site_id=null` but omit `manual_site_name`
preserve an existing manual label. Selecting a linked ID clears the label. The
explicit new field is required to clear a manual label to no Site.

Optional PDF email captures the original label in its existing immutable outbox
snapshot. Corrections update ordinary exports but neither change that snapshot
nor enqueue another message. This feature changes no routing or email settings.

## Compatibility and release

Additive `0027_report_manual_site` adds nullable `manual_site_name` and database
guards for exclusive Site choice, Report-only use and revision-controlled edits.
Existing rows receive NULL; all previous migration files/checksums stay unchanged.
Submission/update request feature version 3 is sent when a manual name is present:
older APIs reject it instead of silently discarding an unknown field. Linked and
empty Site requests keep version 2. Existing drafts/queues need no storage reset.

The approved release must run final source CI, verify recovery and a
schema-27-compatible fallback, apply the additive migration, then release compatible
backend and PDF worker before Hosting. Use the existing release procedure for
backup, write pause and draining the scheduled worker; restore its normal schedule
after verification. Old schema-26 images reject the new ledger;
do not roll back to them, downgrade migrations or clear client storage. Prefer a
forward fix; any fallback must retain manual-name reads, exports, snapshots and
pending replay. No new IAM, secrets, service or schedule is required.

## Local verification

- `backend/report_manual_site_test.py`: author/department boundaries, roundtrip,
  replay, validation, no shared Site creation, corrections/conflicts, old-client
  preservation, Find scope, CSV/HTML/PDF, frozen mock-email PDF and SQLite upgrade.
- `scripts/report-submit-review-test.mjs`: Worker/ Supervisor keyboard entry,
  real page reload/draft restore, mobile/desktop layouts, confirmation and offline
  replay without duplicate posts, plus existing review regression groups.
- `scripts/report-editor-test.mjs`: manual-name restoration and revisioned payload,
  plus existing evidence/authorization/concurrency regression groups.
- `scripts/report-upload-recovery-test.mjs`: a failed upload recovers the typed
  name into a draft/editor without creating a Site or submitting a Report.
- Native PostgreSQL rehearsal checks schema-26 row/checksum preservation, exclusive
  Site choice, revision guards and idempotent migration on an owned local cluster.

Only synthetic fixtures and mocked SMTP are used. Physical phones, authenticated
production forms and actual email delivery are outside this local task. Supervisor
cold-offline template availability retains its existing limits.

Final local result: all 29 backend suites, all 75 real-backend browser workflows
and the full mobile gate passed. Build, lint and Python compilation passed. Native
PostgreSQL 17 passed 30 migration and 14 correction/concurrency checkpoints; both
owned clusters were removed. The extra failed-upload manual Site recovery group
passed separately. The phone/desktop form and generated synthetic PDF were visually
reviewed. Initial sandbox/test-fixture failures were corrected and their logs
retained; the existing bundle-size advisory remains. See local
`output/manual-site-local/verification.json` for evidence paths.
