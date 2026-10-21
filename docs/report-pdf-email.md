# Optional Report PDF email — local preparation

This feature is prepared locally, not deployed or activated. Production remains
the invitation-email release with migration 0023. No real recipient, Report,
email, credential, cloud resource or IAM policy was changed for this work.

## Supervisor behavior

Each saved Report Template has an **Email PDF after submission** section, off by
default. A Supervisor with the existing Department/global-admin scope can save
one recipient and enable or disable it. These settings save separately from the
Template questions, use their own concurrency version, and do not invalidate
Worker offline drafts or Supervisor question drafts. Creation alone leaves it off.

Changes apply to future durable submissions only. A Report still queued on a
phone has not yet reached the server: its routing is captured when sync commits.
Already queued emails keep their original recipient even if settings change or
are disabled. There is no backfill, bulk-send endpoint, automatic resend or retry
button. Template settings are excluded from Worker API responses and snapshots.

Supervisor Report details show the captured recipient and pending, accepted,
failed or uncertain status. Workers do not receive these private routing fields.
Refresh Reports to obtain the latest status. Accepted means SMTP server acceptance,
not mailbox delivery. For an uncertain attempt, check with the captured recipient
before any separate manual handoff. Existing PDF download remains available.

## Transaction and dispatcher

`0024_report_pdf_email` adds three default-off WorkForm settings and the
`reportpdfemail` table. A unique submission ID permits one outbox row per Report.
The Report and its outbox row commit together. Existing client-submission-ID replay
and recovery/tombstone guards return the original Report without another row.
Daywork and Supervisor-created legacy submissions never enqueue email. The later
local Supervisor Submit form path queues its own authenticated Reports using the
same rules; this does not activate routing or authorize dispatch.

The outbox freezes recipient, routing version, original display labels, answers,
Definition, Date, Site, photos, signatures and Submitted workflow. The worker
revalidates actual record scope, existence and exact frozen evidence before loading
media, then checks again after rendering. Subsequent review notes and Template or
Worker name changes do not rewrite the submitted version. Deleted/unavailable
Reports and unverifiable or missing evidence fail safely without sending.
Deletion after the final check cannot recall an email already entering SMTP.

The worker reuses the branded A4 Report PDF renderer, including Chinese fonts,
all submitted photos, and handwritten/repeating signatures. Its existing 200-DPI
print copies do not change original uploaded evidence. Email rendering is strict:
unavailable evidence fails the email rather than mailing a partial PDF. The PDF
attachment is limited to **10 MiB**, and the complete MIME message to **15 MiB**.
Oversized/rendering failures leave the submitted Report intact.

From `backend/`, the worker entry point is:

```text
python -m app.report_pdf_email_worker --limit 10
```

It is disabled unless `REPORT_PDF_EMAIL_WORKER_ENABLED=true` in that runtime.
The API never calls it, runs SMTP in a request, or starts an in-memory email task.
Each invocation reads up to 1–50 pending rows. A conditional database claim commits
an uncertain attempt **before** rendering or SMTP. Competing invocations skip it.
Success/failure is saved after the attempt. Process termination or a lost commit/
SMTP response leaves it uncertain and cannot trigger an automatic retry. This is
at most one attempt, not a promise of exactly-once delivery; even a crash before
SMTP may conservatively require manual investigation.

Configuration errors detected before claims leave work pending. A normal run logs
only aggregate outcomes; a blocked run prints a sanitized message and exits
nonzero. No password, authentication transcript, recipient, PDF or raw exception
is logged by this worker. SMTP retains certificate verification, STARTTLS/SSL
requirements, sanitized errors and no retries. Public registration stays disabled.
Outbox snapshots are removed with the existing permanent Report purge, including
pending records; they do not grant access to or retain purged upload evidence.

## Deployment prerequisites — separate approval required

1. Review and commit these local changes, pass source CI/release checks, and verify
   the normal current backup/recovery prerequisites. Preserve existing records,
   upload evidence, device storage, secrets and invitation behavior.
2. Prepare a backend fallback compatible with migration 0024. Older images reject
   a migration ledger they do not recognize. Never remove/downgrade ledger entries,
   reset credentials, or restore old credentials for rollback.
3. Apply additive 0024 using the normal safe migration procedure, then deploy its
   compatible backend before promoting Hosting. Routing remains off everywhere.
   Compare existing business rows/prior ledger checksums, verify every Template is
   off and the new outbox is empty, and include the outbox in future recovery proof.
4. Approve and provision a durable scheduled dispatcher. A bounded Cloud Run Job
   using the backend image and existing runtime identity is the minimal proposed
   route; it needs its existing database/upload access and fixed SMTP password
   secret version 1. Review the actual resource configuration before creating it.
   A scheduler trigger needs permission to execute that job; inspect available
   identities and grant only required job-level execution access if necessary.
   No scheduler/job/invoker grant has been created or approved by this local task.
5. Enable the worker flag only in the approved dispatcher, with one task, bounded
   batch/timeout and no task retries. Overlapping executions are still protected
   by database claims. Choose cadence/capacity and monitor pending age plus failed/
   uncertain counts. Do not repurpose the web service's periodic trash task.
6. Have the user approve the intended recipient and data scope for each enabled
   Template. Any real email or end-to-end delivery test needs separate approval.
   Keep registration disabled and preserve the current sender/secret bindings/IAM.

Proposed initial configuration for later approval: one `reportflow-pdf-email` job
in `geo-attendance-system-db9ca` / `australia-southeast1`, invoked **every five
minutes**, one task with zero task retries, `--limit 10`, and a bounded ten-minute
task timeout. Delivery can take the polling interval plus startup/rendering time;
backlogs take longer. Use the verified backend image and existing
`geo-backend-runtime@geo-attendance-system-db9ca.iam.gserviceaccount.com` identity,
with its current database/upload configuration and secret references (including
`reportflow-smtp-password:1`). Keep the web service worker flag false. Recheck
CPU/memory against the existing backend sizing and test fixtures before activation.

Use a dedicated trigger identity (reuse a suitable existing one or separately
approve its creation) with `roles/run.invoker` on **this job only**. It needs no
SMTP secret, database or upload access. Verify Cloud Scheduler API/service-agent
availability and deployer permissions before creating resources; no project-wide
runtime grant is proposed. Google's current documentation supports scheduled jobs
and job-scoped invocation: [schedule a job](https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule)
and [Cloud Run Invoker](https://docs.cloud.google.com/run/docs/reference/iam/roles#run.invoker).

To pause dispatch, disable its schedule/worker flag. Disabling a Template stops
new queue entries only; pending rows remain. Never reset accepted or uncertain
rows to pending. A compatible rollback must preserve all outbox rows and claims.

## Local verification

All email tests use synthetic records and mocked SMTP; no real authentication or
delivery is established. Relevant commands:

```text
python .github/scripts/run_local_checks.py backend
npm run check:report-pdf-email
npm run check:report-template-drafts
npm run check:report-detail-ux
npm run check:mobile
npm run lint
python backend/postgres_rehearsal.py --pg-bin <owned-local-PostgreSQL-bin> --output <new-local-proof.json>
```

The focused backend tests cover default-off/no-backfill, permissions/CSRF/privacy,
atomic rollback, replay/concurrent claims, submitted-version PDF media and TLS,
failed/uncertain results, interruption, result-persistence failure, attachment
limits and purge. Native PostgreSQL checks add concurrent POST convergence,
observed routing row-lock contention and claim-before-send visibility. Browser
checks cover optional settings, one recipient, independent versions, duplicate
actions, stale/uncertain replies, scope changes, offline behavior, English/Chinese
UI, captured recipient privacy and filtering while saving.

Final local results (2026-10-21 UTC): 24 backend suites plus the process-cleanup
check passed; the final focused suite passed 17 tests, and the new settings
browser suite passed 12 checks. Build, lint, workflow validation, all mobile
subchecks and all 73 real-backend browser workflows passed. The combined mobile
run ended after 69 workflows without a terminal result; the final browser suite
was rerun separately and completed with exit 0. The interrupted run's cause is
unconfirmed and its log is retained. Native PostgreSQL 17.6/18.4 full rehearsals
passed 87/88 checks; the final outbox claim-identity guard was rechecked with six
native PostgreSQL checks. Owned clusters were cleaned up. The synthetic two-page
PDF and English/Chinese phone settings were visually reviewed.

The local evidence index is `output/report-pdf-email-local-review.json`, with
source hashes and exact logs. No source CI run, commit, real mail or deployment is
claimed. Existing unrelated invitation/test outputs remain untouched.
