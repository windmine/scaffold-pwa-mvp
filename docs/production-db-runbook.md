# Production Database And Deployment Runbook

Use this runbook for managed PostgreSQL migrations, Cloud Run releases, durable uploads, verification, and rollback. Local SQLite and `backend/uploads/` are development-only.

## Deployment Truth

### Current live deployment

The report-only coupled release completed on 2026-09-07: production migrations and the compatible backend were released before the exact verified frontend version. The temporary maintenance/drain window has ended; [production release evidence](evidence/report-release-2026-09-07.json) and the [sequence below](#2026-09-07-coupled-production-release) record the cutover. Physical-phone validation remains pending. The topology is:

```text
Firebase Hosting
  /api/** and /uploads/**
            -> Cloud Run geo-backend (australia-southeast1)
                 -> Neon PostgreSQL via Secret Manager DATABASE_URL
                 -> private Cloud Storage bucket geo-attendance-system-db9ca-uploads
```

- Hosted PWA: `https://geo-attendance-system-db9ca.web.app`.
- The live application revision is `geo-backend-report-release-202609070416`, using `geo-backend-runtime@geo-attendance-system-db9ca.iam.gserviceaccount.com` and the exact staged image digest `sha256:a5e218a2bdb3c8d81ea1da4bc616cfa78b2cc28ad9786d953b015886ffeac9a9`. It replaced the temporary database-free maintenance revision at 04:17:15 UTC; verify current traffic before any later cutover.
- Live Firebase Hosting is `549d17a081d3e606`, the frontend-only ReportFlow branding release from source commit `81a8820`, cloned from `reportflow-20260910-0312` at **2026-09-10 03:14:00.197 UTC**. Backend, ledger, uploads and production rewrites are unchanged. [Release evidence](evidence/reportflow-release-2026-09-10.json) records 44 local browser workflows, strict hardening, 53 exact preview/live shell assets, readiness, anonymous isolation, hosted branding/install metadata, cold-offline launch, and the real old-to-new Update App transition. Authenticated hosted Report/evidence checks remain the September 7 results; they were not rerun with production accounts for this branding release. Physical-phone testing remains pending.
- The new preview expires **2026-09-17 03:11:53 UTC**. For frontend-only rollback, reverify that retained channel `mutual-ui-20260910-0120` still contains `964d7c266db0dd2d` (recorded expiry **2026-09-17 01:20:57 UTC**), then clone that exact channel to live without touching Cloud Run or the database. Never use the older SQLite demo channel for live rollback.
- ReportFlow changes the PWA name and install artwork only; manifest URL, `start_url`, `scope`, service-worker registration and persisted storage keys remain unchanged. Home-screen metadata updates depend on the browser/OS. Do not recommend uninstalling or clearing site data with unsynced Reports. Backend export branding remains outside this release.
- The live release includes migrations `0018_report_review_workflow`, `0019_report_daywork_purpose`, and additive correction `0020_missing_snapshot_daywork_correction`, normal-Worker Report submission, durable Report-versus-Daywork separation, the forward-only Report transition endpoint, and the **Reports / Report Templates / Staff** shell. The previous Hosting `c761984b7353028a` and August backend are historical, not the serving pair.
- Historical 2026-09-01 local checks passed the Worker → Supervisor → Worker lifecycle at 390 × 844, 33 Playwright workflows, backend suites, disposable smoke, and dependency checks. The final 2026-09-07 checkpoint now records 42 browser workflows and the full `0020` local/recovery-baseline results below. Neither historical nor current local checks establish online release or hosted-device completion.
- `DATABASE_URL` and `GEO_SECRET_KEY` are injected from Secret Manager.
- The runtime identity has no project-level role. It has secret-level accessor bindings and a custom upload role containing only `storage.objects.create`, `storage.objects.get`, and `storage.objects.delete`, restricted to `uploads/`.
- The default Compute service account is no longer a runtime credential and retains only `roles/run.builder` for Cloud Run source builds.
- SQLAlchemy uses `pool_pre_ping` so a Neon/managed-PostgreSQL connection closed while idle is discarded before the route query.
- Upload startup performs create/read/delete lifecycle verification; readiness then reads a stable private marker.
- Uploaded JPEG, PNG, and WebP files are decoded and re-encoded before storage, served only after authorization, and deleted when detached and no durable reference remains.
- Live `/health/ready` verifies database access, exact migration history, and the selected upload adapter; historical deployed versions predate the migration readiness check.
- Cloud Monitoring checks the hosted `/api/health/ready` path and has enabled incident policies for readiness failures and Cloud Run 5xx responses. On 2026-09-07 both policies were attached to the selected email channel without changing their conditions. A separate metric-based test opened incident `0.occahjgb1yjd` and the operator confirmed receipt; exact test-policy deletion/absence were verified. The corrected strict gate requires recent, recipient-hash-bound receipt for enabled `VERIFIED` or verification-exempt email channels; provider omission alone never passes and `UNVERIFIED` always fails. See [delivery diagnosis](#2026-09-07-email-delivery-diagnosis).
- Both 2026-09-07 Neon phases passed separately: the [PreMigration baseline](evidence/neon-recovery-proof-2026-09-07-baseline.json) recovered then-live `0017`, bound to candidate `0020`; the [post-migration Current proof](evidence/neon-recovery-proof-2026-09-07-current.json) recovered the complete exact `0020` ledger from a post-migration historical point. Each verified read-only access and owned-branch cleanup/404. GCS exact-generation recovery and the strict `Current` hardening gate also passed; the latter retains one warning for the temporary six-hour Free-plan history. Earlier failed evidence remains historical.
- The [read-only capacity snapshot](evidence/neon-runtime-capacity-2026-09-07.json) confirms a pooled runtime hostname and 106 non-reserved PostgreSQL connection slots. Current defaults at 20 Cloud Run instances and one Uvicorn process each allow 100 retained or 300 peak application-to-pooler client sockets; transaction pooling means those are not physical backend counts. This is not a load test or verified live PgBouncer configuration. The non-superuser runtime still owns the database/tables and has broad role flags; least-privilege credentials and measured pool/scale sizing remain pre-onboarding work.
- The 2026-08-04 release created a one-day read-only Neon backup branch, proved migration `0017` on a disposable PostgreSQL branch, and then deployed commit `38220e9` as a no-traffic Cloud Run candidate. Five candidate readiness cycles and ten post-promotion direct/hosted readiness probes passed, no revision-scoped ERROR or HTTP 5xx logs were observed, and all temporary traffic tags were removed after promotion. Firebase preview `release-20260804152130` was verified for asset hashes and invited-account behavior before its exact version was cloned live.
- The 2026-08-07 frontend-only release deployed commit `bbee643` through Firebase preview `release-20260807120117` at `https://geo-attendance-system-db9ca--release-20260807120117-texdr4u7.web.app`, then cloned exact Hosting version `1e831c0aa589a08d` live. Local, preview, and live SHA-256 hashes matched for `index.html` (`a0c8c1c16cdfb58fb29c0ef976ba8d7c645ffee20de5f7bd3e85df7f3f1dc004`), `sw.js` (`ab4fa2b49094970b26d8e7eb41fe63a42c8a303c8c330429ee68e588b2a9149e`), `offline.html` (`5034e9dd2d5df27e72c356632a8e984fa0ea389adfcf1870dafe0b3d64837ff2`), and `manifest.webmanifest` (`24b60cb58ae8a220b51b3e52cc16aa0360d87f0f63f4e9c713fab0d6b990d35e`). Five live readiness probes reported database and GCS healthy; anonymous Sites returned 401; invited-only/hidden-registration state, login-before-install ordering, and generated service-worker assets passed. The release compacts the Normal Worker guide after first use, defaults checkout to the open check-in's Site, prioritizes recent/nearest Sites, and restores only Worker/Department-scoped attendance context with account-switch race protection. Cloud Run remained unchanged at `geo-backend-release-20260804152130`.
- The 2026-08-10 frontend-only release deployed commit `b2dec22` through Firebase preview `release-20260810172537` at `https://geo-attendance-system-db9ca--release-20260810172537-uihkpz71.web.app`, then cloned exact Hosting version `6b499ef514142a09` live. Local, preview, and live SHA-256 hashes matched for `index.html` (`ba207851e18aca98c38d65de58846000d66a67d8e966a903683af4f15a1c4b3a`), `sw.js` (`416375288e8623f514eeeee833b17661a84dcbbd5543f09e3fdb590964339fac`), `offline.html` (`5034e9dd2d5df27e72c356632a8e984fa0ea389adfcf1870dafe0b3d64837ff2`), and `manifest.webmanifest` (`24b60cb58ae8a220b51b3e52cc16aa0360d87f0f63f4e9c713fab0d6b990d35e`). Five preview and five live readiness probes reported database and GCS healthy; anonymous Sites returned 401; invited-only/hidden-registration state, login-before-install ordering, PWA cache headers, generated service-worker assets, and hidden-by-default Staff/Work Form creation panels passed. The release makes those Supervisor areas list-first and adds cancel/reset, focus restoration, submit locking, and explicit post-create refresh-failure handling. Cloud Run remained unchanged at `geo-backend-release-20260804152130`.
- The 2026-08-11 frontend-only release deployed commit `9a6260e` through Firebase preview `release-20260811125326` at `https://geo-attendance-system-db9ca--release-20260811125326-agkq8qbo.web.app`, then cloned exact Hosting version `4766134daf955917` live. Local, preview, and live SHA-256 hashes matched for `index.html` (`20720598a574dd734e7465039cf393a7747298d1b96e2f8f43c2ff9c5b10558a`), `sw.js` (`b95e22af6eb580c6ed52594215dd9ccda6647eae1c8da44f137ee269472a0bb1`), `offline.html` (`5034e9dd2d5df27e72c356632a8e984fa0ea389adfcf1870dafe0b3d64837ff2`), `manifest.webmanifest` (`24b60cb58ae8a220b51b3e52cc16aa0360d87f0f63f4e9c713fab0d6b990d35e`), and `assets/js/confirmation-dialog.js` (`f488758b9ce098c263f4727b091a5772f4cdf5cdbf01f7b27772e234f0f68f58`). All 47 generated app-shell paths plus `sw.js` matched on preview and live; five preview and five live readiness probes reported database and GCS healthy; anonymous Sites returned 401; invited-only/hidden-registration state, login-before-install ordering, PWA cache headers, hashed entrypoints, scoped offline snapshots, and confirmation-dialog markup passed. Local Playwright coverage verified cancel-first focus, Escape and Cancel handling, focus restoration, single-flight protection, and one intercepted mutation only after confirmation. The full development audit reported two high and one moderate development-toolchain advisories while the production audit remained clean. Cloud Run remained unchanged at `geo-backend-release-20260804152130`.
- The 2026-08-13 frontend-only release deployed commit `bcfb128` through Firebase preview `release-20260813120158` at `https://geo-attendance-system-db9ca--release-20260813120158-1krt9yox.web.app`, then cloned exact Hosting version `c761984b7353028a` live. Local, preview, and live SHA-256 hashes matched for `index.html` (`e3e0068a0d40e37d3f2c5ecad352be404a9cecc91c358f0d31c96cfdb1b6df82`), `sw.js` (`8f3a391469c4124f6cd7f6e1d501481fb2e0361a7bea5cb409f0cb8ab0380265`), `offline.html` (`5034e9dd2d5df27e72c356632a8e984fa0ea389adfcf1870dafe0b3d64837ff2`), `manifest.webmanifest` (`24b60cb58ae8a220b51b3e52cc16aa0360d87f0f63f4e9c713fab0d6b990d35e`), `assets/js/supervisor-analytics.js` (`057f834252ea774535e61ebcea8d9b8b8f37b258959a0ef794c953c4f8494e86`), and `assets/css/styles.css` (`2a1ccef893ad2ad70d1330a079827b81f940c55b1d4a76380c4c9478c89efb89`). All 47 generated app-shell paths plus `sw.js` matched on preview and live; five preview and five live readiness probes reported database and GCS healthy; anonymous Sites returned 401; invited-only/hidden-registration state, login-before-install ordering, PWA cache headers, hashed entrypoints, and scoped offline snapshots passed. Local Playwright coverage verified exact Analytics-to-Review/map navigation, filter clearing, collision-safe record identity, coordinate validity, and the 14px map/Analytics label floor at desktop and phone widths. The full development audit reported two high and one moderate development-toolchain advisories while the production audit remained clean. Cloud Run remained unchanged at `geo-backend-release-20260804152130`.
- The 2026-08-05 frontend-only release deployed commit `9db3477` through Firebase preview `release-20260805155240`, verified local/preview SHA-256 parity and the hashed app-shell entrypoints, then cloned exact Hosting version `ba8c1689c2d0e121` live. Local/preview/live hashes matched for the shell, service worker, offline page, and manifest; five live readiness probes, invited-only/hidden-registration checks, cold-offline shell rules, and anonymous Site isolation passed. Cloud Run and its database/upload configuration were unchanged.
- The 2026-07-15 release check made five candidate readiness calls and ten post-promotion readiness calls across Cloud Run and Firebase Hosting, confirmed 100% traffic on `geo-backend-release-20260715213211`, verified anonymous protected-Site rejection, and found zero serving-revision ERROR or HTTP 5xx logs. The Hosting preview shell, service worker, offline page, and manifest matched the local build byte-for-byte before promotion.
- Hosted anonymous/login Site ordering, Worker login, restored session, repeated authenticated Site requests, logout cleanup, Supervisor Review Queue, readiness, and new-revision error logs passed on 2026-07-14 without an observed 5xx.

### Recommended all-Google target

The preferred long-term Google-native shape replaces Neon with Cloud SQL PostgreSQL:

```text
Firebase Hosting -> Cloud Run -> Cloud SQL PostgreSQL
                              -> private Cloud Storage
                              -> Secret Manager
```

The project has an earlier validated Cloud SQL instance and database, but they are not the current live database. Treat migration to Cloud SQL or retirement of those resources as an explicit infrastructure decision; do not assume the GCP resource is the data source serving production traffic.

## Release Invariants

- Run `python -m app.migrations` against a staging database/branch before production.
- Require the isolated PostgreSQL migration/concurrent-review rehearsal below as well as SQLite-based application checks. Final 2026-09-07 PostgreSQL 17.6/18.4 runs pass 53 checkpoints each through additive `0020`; retain the earlier failing `0019` evidence as history. Neither local SQLite nor PostgreSQL tests replace current-image/provider staging and hosted verification.
- Keep `AUTO_MIGRATE=false` in production. It is the default for `APP_ENV=prod`/`production` (or the `ENVIRONMENT` fallback) and any Cloud Run `K_SERVICE`; explicit `true` is rejected before migrations, upload probes, or purge work. API startup verifies exact migration versions/checksums without creating or modifying the ledger. Development may still auto-migrate.
- Run explicit migrations and `python -m app.migrations --check` from the same immutable migration artifact as the candidate image. Checksums cover exact file bytes; never normalize during verification or accept alternate checksums. On 2026-09-07, historical `0001`–`0017` were restored to canonical LF bytes independently matching every deployed checksum, and `.gitattributes` pins migration files to LF. This is source-byte alignment with the original release, not a ledger rewrite or edited migration logic. Any new mismatch blocks release and needs comparison with the original artifact.
- Back up or create a restorable provider snapshot before every production migration.
- Keep uploads in the private GCS adapter for every production-like Cloud Run revision.
- Keep browser auth cookie name `__session`; Firebase Hosting does not forward arbitrary cookies to rewritten Cloud Run services.
- Keep `ENABLE_DEV_SEED=false`, `AUTH_COOKIE_SECURE=true`, CSRF protection, and rate limiting enabled in production.
- Do not run the full destructive `backend/smoke_test.py` against production. It seeds and mutates data; use it only with a disposable local/staging database.
- Use controlled test accounts for hosted workflow checks and clean up their records afterward.
- During the invited-account pilot, require the tested login shell to show `Invited accounts only` and keep the public registration panel hidden. Verify preview/local shell parity before promotion. The current Staff users flow still makes the Supervisor set each initial password; do not describe it as a complete invitation handoff.
- Keep global-admin access Supervisor-only. Migration `0017_global_admin_supervisor_invariant` revokes `is_global_admin` from any legacy non-Supervisor row, then installs a database invariant; the application also ignores such invalid flags before the migration runs.
- The production-default navigation must contain only **New Report / My Reports** for Workers and **Reports / Report Templates / Staff** for Supervisors. Retained attendance, Daywork, Site, map, analytics, audit/recovery, and general export interfaces must stay unreachable without the explicit test override.
- New Reports require Report Date and may store `site_id=null`. Every active Worker may use active Templates in their Department; archived or cross-Department Templates remain unavailable.
- The Report Date API guard checks the actual calendar, not just `YYYY-MM-DD` shape. Verify impossible dates return HTTP 400 without inserting a Report, valid leap days remain exact, and rejected offline submissions retain local content. The guard runs after durable idempotency lookup; it does not repair historical dates, restrict past/future dates, change Daywork validation, or need a migration. Never guess a replacement date for an existing invalid record.
- Report replay must send the captured `expected_definition_version`. The backend returns structured HTTP 409 for changed Templates before normalizing answers, while already-durable idempotent retries still succeed. Deploy this backend guard before the updated frontend; refresh/Update App on controlled devices before use. Older cached clients can submit unversioned Reports only to unedited version 1 Templates, and must keep their local queue when an edited Template conflicts. Do not clear app storage or stamp old queue items with the latest version. This API/queue fix needs no additional migration; all existing report-only migration gates still apply.
- Verify stale saved drafts become read-only before autosave can reinterpret them. **Keep draft and start new report** must preserve an original local **Saved draft** in **My Reports** before clearing the input draft. Recovery copies remain private/device-local, are excluded from upload and replay, and cannot be mistaken for submitted Reports. If local storage fails, keep the original draft and retry; do not clear browser storage.
- Keep Report content immutable after submission. Workflow transitions are separate, atomic, Department-authorized actions: **Submitted → In review → Resolved**, with a required final Supervisor note for resolution and one audit event per successful transition.
- Keep collection Report exports aligned with Department focus plus workflow, Report Template, Worker, and Report Date. The free-text **Find** field is list-only and must not be represented as an export filter.
- Keep Report Template/history/API/upload paths network-only. The cached PWA shell and local queued Reports may cold-launch offline, but the release must not claim that a killed offline app can fetch Templates or start a new Report.
- Generate `sw.js` from `scripts/pwa-shell-assets.mjs`; never hand-edit its cache name or copied asset list. Re-run generation/build after UI, JavaScript, CSS, translation, icon, or other shell changes.
- Verify actual Cloud Run traffic after deploy. A tagged old revision can remain pinned even when a newer revision is ready.
- Keep the runtime identity separate from the source-build identity. Do not restore Editor or database/upload access to the default Compute service account.
- An application rollback and a database rollback are separate decisions; the previous app revision must be compatible with the migrated schema.

## Configuration

Production-like Cloud Run configuration should include:

```text
APP_ENV=production
DATABASE_URL=<secret-manager managed PostgreSQL URL>
GEO_SECRET_KEY=<secret-manager strong secret>
BUSINESS_TIMEZONE=Pacific/Auckland
AUTO_MIGRATE=false
SQL_ECHO=false
ENABLE_DEV_SEED=false
AUTH_COOKIE_SECURE=true
CORS_ORIGINS=https://geo-attendance-system-db9ca.web.app,https://geo-attendance-system-db9ca.firebaseapp.com
RATE_LIMIT_ENABLED=true
RATE_LIMIT_GENERAL_REQUESTS=300
RATE_LIMIT_GENERAL_WINDOW_SECONDS=60
RATE_LIMIT_AUTH_REQUESTS=30
RATE_LIMIT_AUTH_WINDOW_SECONDS=60
RATE_LIMIT_UPLOAD_REQUESTS=30
RATE_LIMIT_UPLOAD_WINDOW_SECONDS=60
UPLOAD_STORAGE_BACKEND=gcs
UPLOAD_BUCKET=geo-attendance-system-db9ca-uploads
UPLOAD_OBJECT_PREFIX=uploads
MAX_UPLOAD_BYTES=5242880
```

Provider notes:

- SMTP configuration is not required only for the current Supervisor-set-password account flow. Add a transactional email provider and protected credentials before enabling verified email registration or single-use email invitations. If invitation tokens use another delivery channel, require authenticated private delivery, expiry, one-time use, and auditability.
- `BUSINESS_TIMEZONE` must be an IANA timezone name and controls attendance business-date filters in the Review Queue and exports.
- For Neon, use a TLS-enabled application connection string appropriate to the selected compute/pooling mode and verify backup/PITR or branch-restore capability in Neon itself.
- For Cloud SQL, prefer a private-IP/VPC or Cloud SQL connector design, a least-privilege database user, and a dedicated Cloud Run service account with `roles/cloudsql.client`.
- Never put a database password or application secret in a checked-in command, Markdown file, image, or plain Cloud Run environment value when Secret Manager can supply it.

## Runtime Identity Contract

The live Cloud Run service uses a dedicated runtime service account:

```text
geo-backend-runtime@geo-attendance-system-db9ca.iam.gserviceaccount.com
```

Its allowed access is intentionally resource-scoped:

- `roles/secretmanager.secretAccessor` on `geo-backend-database-url` and `geo-backend-jwt-secret`, granted on each Secret rather than the project.
- `projects/geo-attendance-system-db9ca/roles/geoBackendUploadObjects` on the upload bucket, conditioned to `uploads/`.
- The custom role definition is `ops/iam/geo-backend-upload-objects.yaml` and contains only object create, get, and delete.
- No project Editor, Cloud SQL, Artifact Registry, logging, object-list, or object-restore role belongs to the runtime identity.

Change identity through a no-traffic revision first. Verify `/health` and `/health/ready` on its tagged URL, inspect that revision's error logs, then move traffic. Only after hosted readiness passes should the old runtime identity lose Secret and bucket access. Keep `roles/run.builder` on the configured source-build identity; it is not a runtime permission.

## Local Release Preflight

From the project root:

```powershell
npm.cmd run lint
npm.cmd run build
npm.cmd run check:review-queue
npm.cmd run check:mobile
python -m compileall backend\app backend\smoke_test.py backend\database_test.py backend\migration_test.py backend\report_purpose_test.py backend\report_workflow_test.py backend\review_queue_test.py backend\work_form_definition_test.py backend\upload_storage_test.py backend\security_test.py
python backend\database_test.py
python backend\security_test.py
python backend\upload_storage_test.py
python backend\review_queue_test.py
python backend\work_form_definition_test.py
python backend\report_purpose_test.py
python backend\report_workflow_test.py
python backend\migration_test.py
python backend\report_purpose_correction_test.py
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-alert-delivery-test.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-alert-delivery-gate-test.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-recovery-migration-contract-test.ps1
python scripts/check-neon-recovery-verifier-test.py
npm.cmd audit --omit=dev
npm.cmd audit
python -m pip check
```

`npm.cmd run check:mobile` builds and regenerates before checking and starts a lightweight Node source/proxy server plus a `dist/` preview. It preserves shared unbundled-module state without Vite's watcher and fails fast if a managed process exits. The 42 workflows at 390 × 844 cover the Report shell, calendar-valid Report Date, optional Site, transitions/final note, Template/Staff navigation, exactly-once photo/signature replay, private history, shared-device session races, lossless Template-conflict recovery, and isolation from retained legacy queues. Full-interface checks use a test-only override. The service worker must include production entrypoints, serve cached `index.html` only for `/` and `/index.html` navigation failures, and keep API/auth/Template/history/uploads network-only. Temporary ports default to `8765`, `5175`, and `4175`.

Then start the backend against a disposable database and run:

```powershell
python backend\smoke_test.py
```

The database test specifically proves `pool_pre_ping` recovers a poisoned returned connection. The focused tests cover upload adapter parity, immutable Report Template snapshots/server-derived formulas, Report ownership/workflow/transition concurrency, cursor-paginated Review Queue policy/query/export separation, and migrations.

The final 2026-09-07 local preflight passed 208 backend checkpoints, 42 Chromium workflows, 207 static checks, and 45 Review Queue checks. Separately, 42 delivery-helper, 3 actual Monitoring-section integration, and 27 recovery-contract checks passed in PowerShell 5.1/7; 4 Python verifier tests passed. These do not run cloud mutations or prove candidate online/phone behavior. Historical 2026-07-31 evidence includes a disposable smoke pass; do not claim that old smoke result was repeated for this checkpoint.

## Isolated PostgreSQL Rehearsal

Run against a freshly initialized native PostgreSQL cluster, not an existing service or a copied production database:

```powershell
python backend/postgres_rehearsal.py --pg-bin "C:/Program Files/PostgreSQL/17/bin" --output docs/evidence/postgres-rehearsal-new-run.json
```

The runner uses the chosen installed binaries, an owned temporary directory, generated SCRAM passwords, a random loopback port, and a non-superuser database-owner role. It never consumes `DATABASE_URL`, accepts no remote target, isolates inherited libpq configuration, verifies the server's data-directory/port identity, and validates ownership before stopping/removing its temporary cluster. Existing Windows PostgreSQL services and cloud resources are untouched. Failed phases remain failures, but a migration assertion does not prevent independent review fixtures from running. Exit code 1 means the full gate is not clear; `--migrations-only`/`--review-only` are diagnostic subsets. Evidence files are never silently overwritten and contain source hashes, version, pass/failure records, lock proofs, and cleanup status, not connection credentials.

Final runs: [PostgreSQL 17.6](evidence/postgres-rehearsal-17-2026-09-07-release.json) and [PostgreSQL 18.4](evidence/postgres-rehearsal-18-2026-09-07-release.json), 2026-09-07. Each passes 53 checkpoints: fresh 20-migration application/idempotence, exact read-only history verification, `0017`→`0020` evidence-preserving upgrades, positive missing-snapshot correction and ambiguous-case refusal, native immutability/purpose/replay guards, transactional rollback/retry, and 20 genuinely blocking review races. Each race requires one winner, one 409, one audit, unchanged evidence, and rollback if audit insertion fails. Both owned clusters were removed.

The earlier [17.6](evidence/postgres-rehearsal-17-2026-09-07-isolated.json)/[18.4](evidence/postgres-rehearsal-18-2026-09-07-isolated.json) runs remain failed historical evidence: unchanged `0019` misclassifies NULL/empty-snapshot Daywork. Additive `0020` corrects only positively identified pre-`0019` Daywork and records provenance, refusing ambiguity instead of fabricating a snapshot. Applied `0019`, stored checksums, and submitted answers/photos/signatures/dates/Site remain unchanged. The later read-only production inventory found no submissions; the snapshot/ledger findings at that time are preserved in [preflight evidence](evidence/report-release-preflight-2026-09-07.json), including the source-line-ending mismatch subsequently resolved by restoring canonical source bytes.

This local rehearsal does not replace the candidate-image/provider staging pass, pooled-runtime-role validation, GCS streaming, hosted HTTP/phone testing, or production recovery evidence. It also does not convert the normal SQLite browser harness into a hosted PostgreSQL staging environment.

## Database Migration Procedure

The current source and production migration head is `0020_missing_snapshot_daywork_correction`; the explicit 2026-09-07 migration job applied `0018`–`0020` after draining production requests:

- `0014_client_submission_unique_indexes` enforces replay idempotency for Worker submissions.
- `0015_work_form_definition_snapshots` versions Work Form Definitions and backfills a best-available snapshot for old submissions. Post-migration submissions preserve their exact historical definition.
- `0016_review_queue_indexes` adds Department/status/deletion/time indexes for cursor-paginated Review Queue queries without changing Review Record values.
- `0017_global_admin_supervisor_invariant` revokes malformed legacy Global Admin flags from non-Supervisor accounts, then enforces the Supervisor-only invariant for future writes.
- `0018_report_review_workflow` adds the constrained `submitted` / `in_review` / `resolved` workflow, reviewing Supervisor/final note/timestamps, and Report workflow indexes. It preserves legacy approval outcomes, maps existing approved/rejected submissions to `resolved`, and backfills reviewer/time only from matching durable audit evidence.
- `0019_report_daywork_purpose` adds constrained `template_purpose` and immutable `submission_purpose` values, classifies historical Daywork from known Definition field signatures and each submission's frozen snapshot rather than mutable names, and indexes Report-only queries without rewriting submitted answers or evidence. SQLite and PostgreSQL guards derive inserted purpose from the parent Template, reject pre-reviewed/approved Report inserts, and block legacy Report status/content/purpose rewrites while retaining old-backend Daywork writes.
- `0020_missing_snapshot_daywork_correction` is an additive correction for positively evidenced, pre-`0019` Daywork with NULL/empty snapshots. It preserves submitted content and genuine Reports, records provenance, reinstates guards, and fails atomically on ambiguous evidence. Do not edit `0019` or repair ledger checksums to bypass the correction.

For every release:

1. Confirm the intended database provider and database name. Never infer them from an old Cloud Run revision.
2. Create a restorable backup, Neon branch, or Cloud SQL on-demand backup.
3. Create a disposable staging database/branch from production-like schema and sanitized data where possible.
4. Point a local/staging backend at that database through a temporary `DATABASE_URL` and run:

   ```powershell
   cd backend
   python -m app.migrations
   python -m app.migrations --check
   ```

5. Start the staging backend with `AUTO_MIGRATE=false`, require all three `/health/ready` checks (`database`, `migrations`, `upload_storage`) to be `ok`, and run `python backend\smoke_test.py` from the repository root against that disposable backend only.
6. Inspect `schema_migrations`, row counts, constraint failures, and application logs.
7. Run the hosted browser workflow against a staging Cloud Run service if the migration changes data read by the UI.
8. Apply the same migration artifact to production only after staging passes, with one explicit migration runner at a time. Coordinate migration and cutover in an approved maintenance/drain window when the ledger changes: the previous guarded image will return readiness 503 once an unknown newer version is recorded. Run `--check` from the candidate artifact against the verified target before starting the candidate. Do not assume additive migrations alone permit old/new guarded revisions to overlap without a readiness gap.
9. Keep the backup/branch until the post-release observation window finishes.

The production `Dockerfile` starts the API only. It must not run `python -m app.migrations` in `CMD`; otherwise creating a no-traffic Cloud Run revision could still mutate the database during container startup. `npm.cmd run check:production-hardening` enforces this deployment boundary. Production API startup independently rejects automatic migrations and performs a read-only ledger verification before storage lifecycle probes or purge tasks. An absent/empty ledger, pending version, changed checksum, unknown newer version, or missing/empty bundled manifest fails startup. `--check` uses the same verifier and exits unsuccessfully on failure; it never bootstraps or repairs history. This check does not inspect every physical table/column or prove recovery readiness. After verification succeeds, the existing upload probe and purge tasks still run.

For Cloud SQL proxy-based staging, a typical local connection is:

```powershell
cloud-sql-proxy.exe --gcloud-auth --address 127.0.0.1 --port 55433 PROJECT:REGION:INSTANCE
$env:DATABASE_URL="postgresql+psycopg://USER:PASSWORD@127.0.0.1:55433/STAGING_DATABASE"
```

Do not copy that password into shell history on a shared machine; prefer a temporary secret injection method.

## 2026-09-07 Coupled Production Release

The release completed in backend-before-frontend order. [Release record](evidence/report-release-2026-09-07.json):

1. The exact candidate passed the [isolated authenticated staging checks](#2026-09-07-authenticated-staging-checkpoint), explicit `PreMigration` recovery, upload recovery, receipt-bound Monitoring, and project-budget checks.
2. Production entered database-free maintenance at 04:10:14 UTC and drained old requests for 300 seconds. Execution `geo-report-migrate-20260907-wdbbn` completed at 04:15:30.833 UTC, applying only `0018`, `0019`, and `0020`. The [post-migration read-only inventory](evidence/report-release-postmigration-2026-09-07.json) matched all 20 exact source checksums and the original immutable-submission hash. There were **zero pre-existing submissions**, so this production comparison is not populated historical-data migration coverage; the isolated PostgreSQL rehearsals supply that coverage.
3. Revision `geo-backend-report-release-202609070416`, using the same staged image digest above, passed readiness and served normal live traffic at 04:17:15 UTC. Maintenance ended.
4. [Current recovery](evidence/neon-recovery-proof-2026-09-07-current.json) passed at 04:19:02 UTC from historical point 04:16:16 UTC, after migration. It recovered the exact full `0020` ledger, observed read-only access, and verified owned-branch deletion/404. The strict `Current` gate passed with one six-hour Neon Free-plan warning.
5. [Production-backend preview](https://geo-attendance-system-db9ca--report-release-20260907-1nwspqig.web.app), expiring **2026-09-14 04:17:47 UTC**, used verified `firebase.json` rewrites to live `geo-backend`. Exact Hosting version `f27b6a46dae98c71` was cloned live at 04:20:33.408 UTC. [Preview](evidence/hosted-production-preview-2026-09-07.json) and [live](evidence/hosted-live-release-2026-09-07.json) each passed 48 asset hashes, five database/migration/GCS readiness probes, anonymous isolation, and cold-offline shell launch.
6. [Ten live authenticated Report checks](evidence/hosted-report-live-20260907a/evidence.json) passed at 390 × 844 with real photo/signature streaming, normal-Worker offline capture/replay exactly once, second-Worker privacy, Supervisor review/resolution note, and Worker final note. Cleanup soft-deleted only owned Report `1`, archived Template `4`, and resigned synthetic users `6`/`7`/`8`; existing users and passwords were unchanged. The [waiting-update pass](evidence/hosted-waiting-update-2026-09-07.json) kept the old live client controlling until the new worker waited, used **Update App**, then verified the new cached shell cold-launched offline after the last page closed.

These hosted results are Chromium automation, not physical-phone testing. The six-hour Free-plan recovery window, owner-level runtime privileges, unproven loaded pooling capacity, and missing single-use Worker password-setup invitation remain controlled-pilot limitations, not a claim of broader-onboarding readiness. Cleanup completed at 04:25:41 UTC: the owned verification branch, service, secrets, and `report-verify-20260907` preview are absent; its two owned staging images are soft-deleted and recoverable under the 30-day policy. Production is 100% on the new revision without temporary traffic tags. The seven-day production-backend preview, production image/migration job, and audit-linked live test evidence are retained; the older SQLite demo is unchanged.

### Historical release blockers and safeguards

The earlier local/baseline checkpoint still had Hosting `c761984b7353028a`, August backend, and database head `0017`. The [initial operational evidence](evidence/operational-safeguards-2026-09-07.json) remains the earlier failed inspection, not current safeguard state. The following records explain the fixes without relabelling historical failures:

- [Upload recovery](evidence/upload-recovery-proof-2026-09-07.json): passed, including exact original/restored generations, content hash, no remaining live probe, and an independent GCS metadata recheck. Only the owned tiny test fixture was changed; its soft-deleted copies expire under the 30-day policy.
- [Neon recovery](evidence/neon-recovery-proof-2026-09-07.json): the verifier connected read-only, found 17 migrations and 14 public tables, and verified Department/Site/User data presence without exporting records. The full proof failed its source-head check (`0017` recovered versus `0019` expected), and the disposable branch was deleted with absence confirmed. Preserve that failed result; do not relabel it as a current candidate recovery pass or bypass the gate. Pre-release recovery evidence for the deployed baseline and post-migration candidate evidence must be distinguished explicitly.
- Initial alert-delivery finding: both policies were enabled but had no channels. This historical finding is superseded by the setup and exact incident/recipient-confirmed receipt below; neither channel status nor empty logs alone proves delivery.
- Initial billing finding: project billing was enabled, but budget reads returned `SERVICE_DISABLED`. This access blocker is now resolved with operator approval, as recorded below. Missing read access was not evidence of no existing budget. Budget alerts are notifications, not an automatic spending cap; Cloud Run instance/resource bounds are also not a project-wide spend cap.
- Migration: the old `0019` failures remain valid historical results, now addressed by additive `0020` and green full PostgreSQL 17.6/18.4 rehearsals. Canonical LF source bytes match all 17 deployed checksums; stored history was not rewritten. The new [schema 3 baseline proof](evidence/neon-recovery-proof-2026-09-07-baseline.json) is explicitly `PreMigration` for that exact deployed prefix, bound to the complete `0020` candidate artifact. It is not post-migration candidate approval.

Resume only after the operational choices and migration gates are cleared. Preserve the release order: verified recovery and staged candidate → coordinated explicit migrations from the exact candidate artifact → read-only migration check → candidate readiness and backward-compatibility checks → backend promotion/observation → verified frontend preview with **live-backend rewrites** → exact frontend promotion. The report demo preview configuration must never be cloned live. The August backend lacks the newer exact-ledger guard and may remain nominally ready while new triggers reject its legacy Report mutations; avoid an untested overlapping write window. Current guarded images cannot be rolled back across a newer ledger without a compatible release plan.

## 2026-09-07 Alert And Budget Setup

The operator selected an email destination, authorized enabling the Budget API and a $10 monthly budget, and elected to keep Neon on the free plan temporarily. No Neon plan, retention, compute, or billing setting was changed. The observed six-hour database history remains a documented temporary limitation; it does not waive the migration or candidate recovery gates.

- Created one enabled email channel, `projects/geo-attendance-system-db9ca/notificationChannels/68405221878559872`, after checking for an existing matching recipient. Added it to the readiness and Cloud Run 5xx policies using a `notificationChannels`-only update mask; existing conditions, enabled state, and combiner were verified unchanged.
- Email verification status is omitted by the provider. [Google's channel status semantics](https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.notificationChannels) allow verification-exempt channels, but omission does not prove receipt. The corrected gate accepts enabled email channels with `VERIFIED`, omitted, or `VERIFICATION_STATUS_UNSPECIFIED` status only with recent matching recipient-confirmed delivery evidence; `UNVERIFIED` and unsupported statuses fail. The recipient's normalized-address SHA-256 binds evidence to the current destination without storing its plaintext address.
- A separate, uniquely labelled **TEST ONLY** log-match policy was used for the delivery attempt, targeting only this channel and a unique test nonce. Two matching log entries were accepted and read back (one initial entry and one bounded propagation retry). No matching incident was observed by 03:14 UTC and recipient receipt was not confirmed. No concrete filter, sink, or caller-permission error was found. The exact owned temporary policy was then deleted and HTTP 404 confirmed; both production policies and their email channel remain configured. Production thresholds and application traffic were not disturbed. API acceptance is not evidence that email arrived: [alert setup/test evidence](evidence/alert-channel-setup-2026-09-07.json).
- Enabled only `billingbudgets.googleapis.com` with operator approval. Paginated budget inventory found an existing matching project-only calendar-month budget, so no duplicate was created. The billing account currency is NZD: the budget remains **NZ$10/month**, with actual-spend alerts at 50%, 80%, and 100%, plus a 100% forecast alert. The email channel is attached and default Billing IAM recipients remain enabled. An etag-guarded patch preserved scope, amount, display name, and applicable-credit treatment. A separate GET verified the result: [billing evidence](evidence/billing-budget-2026-09-07.json).
- Budget configuration is verified, not delivery of a future threshold email. The budget covers this Google Cloud project after applicable credits; it does not include a separate Neon bill. [Budget alerts do not cap spending](https://docs.cloud.google.com/billing/docs/how-to/budgets); no billing shutdown or automatic spending cap was configured.

Historical post-setup rechecking exited 1 for exact `VERIFIED` status and the `0017`-versus-`0019` recovery mismatch. The receipt-bound gate and explicit recovery phases now address those gate defects, while additive `0020` clears the local migration failure. Preserve the original results rather than relabelling them. Budget configuration and upload recovery pass; six-hour Neon retention remains only the operator's temporary Free-plan choice. These changes do not promote the application or replace post-migration `Current` and hosted checks.

## 2026-09-07 Email Delivery Diagnosis

The operator reported no email from the earlier log-match test. Read-only checks confirmed the selected recipient, enabled channel, no snoozes, two matching stored test logs, no observed test incident, and no notification-channel error events. Empty metric/error-log results do not prove dispatch or delivery. The cause of that log-trigger failure remains unexplained; do not attribute it to Spam or repair it by forcing a channel verification status.

A single separate **TEST ONLY - Report MVP email metric delivery - 91b40ca9** policy used the existing healthy hosted-readiness telemetry, without creating a VM, custom metric, or additional uptime check. Its intentionally true condition counted successful checkers (`ALIGN_NEXT_OLDER`, 300 seconds, `REDUCE_COUNT_TRUE`, count greater than zero, zero retest duration); an exact aggregated read returned six. Monitoring opened incident `0.occahjgb1yjd` at **2026-09-07 03:28:35 UTC**, and the operator answered **Received** to a question naming that exact test and destination. This confirms end-to-end Monitoring email delivery, not future budget-threshold delivery or a production outage test.

The exact owned policy `7969176239109369834` was deleted at 03:31:37 UTC and GET returned 404. Both real policies remained enabled with the channel attached and unchanged mutation timestamps/conditions. No production outage was induced. [Sanitized diagnosis and receipt evidence](evidence/alert-delivery-diagnosis-2026-09-07.json) supersedes the earlier delivery-unproven result; its limitations describe the pre-fix state at recording time. The later receipt-bound gate, additive `0020`, and completed online release are documented above. No application release or Neon plan change occurred during the diagnosis itself.

For a future authorized channel check, follow [Google's temporary-policy test procedure](https://docs.cloud.google.com/monitoring/support/notification-options): use an isolated labelled policy on existing harmless telemetry, verify its condition using the same aggregation, allow evaluation time, correlate the exact incident with recipient confirmation, then verify ownership before deleting only the temporary policy. Do not change real alert thresholds, induce an outage, repeatedly send test logs without new evidence, or treat API acceptance as mailbox receipt. Use bounded API timeouts; one incident-list read stalled during this diagnosis, while a later paginated read succeeded.

## Refreshing The Isolated Report Preview Only

Verified preview: [report-mvp-20260907](https://geo-attendance-system-db9ca--report-mvp-20260907-t6pfoqxe.web.app), Hosting version `dc163aa882f5c247`, expires 2026-10-07 02:40 UTC. [Verification evidence](evidence/report-preview-2026-09-07.json) records the current frontend, older staging backend, local and hosted checks, and unchanged live Hosting/Cloud Run state.

Use `firebase.report-preview.json` for the isolated report preview. Its `/api/**` and `/uploads/**` rewrites target `geo-backend-report-stage-20260901173452`, not the live `geo-backend`. Keep the production `firebase.json` unchanged. This configuration is for `hosting:channel:deploy` only: never use it for a live deploy or clone its staging rewrites to `live`.

```powershell
npm.cmd run lint
npm.cmd run check:mobile
npx -y firebase-tools@latest hosting:channel:deploy report-mvp-20260907 --config firebase.report-preview.json --project geo-attendance-system-db9ca --expires 30d --no-authorized-domains --non-interactive
```

The command creates or refreshes the preview channel without changing Firebase Auth authorized domains, Cloud Run revisions/traffic, databases, or the live Hosting release. Repeat it before expiry to refresh the channel; after expiry Firebase may assign a different URL, so use the returned URL. Check the deployed channel's rewrites, all generated shell asset hashes, anonymous phone-width login/PWA behavior, and same-origin `/api/health/ready` and protected-route authorization. Record the actual expiry, Hosting version, and staging revision with the verification results.

At the earlier recorded 2026-09-07 demo-preview refresh, staging was `geo-backend-report-stage-20260901173452-r3-365fa4f`, using SQLite/GCS with frontend `0fccbe0`, without the later replay/date/startup/`0020` backend fixes. That preview remains a separate disposable demo; do not overwrite or clone its staging rewrites into production. The later current-candidate online pass is recorded below against a different verification preview.

## 2026-09-07 Authenticated Staging Checkpoint

The separate temporary `report-verify-20260907` stage used Firebase Hosting version `dbd9b11da35f1a0b`; it did not replace or authorize changing the older report-demo preview configuration. Its branch/service/secrets/preview were removed after the successful production release, with absence verified. [Hosted workflow evidence](evidence/hosted-report-stage-20260907a/evidence.json) records ten passing checkpoints at 390 × 844: database/migration/GCS readiness, three dedicated Department accounts, nonce-owned Template creation, normal-Worker required-date/optional-Site/photo/signature entry, offline preservation, exactly-once online replay with real GCS image streaming, second-Worker denial, Supervisor filters/start-review, required-note resolution, and Worker final-note/idempotent replay. Cleanup soft-deleted only the owned Report and archived only the owned Template; no cleanup failures or browser page errors were observed.

The separate [read-only shell/PWA pass](evidence/hosted-stage-release-2026-09-07.json) matched all 48 recorded shell paths/hashes, made five healthy database/migration/GCS probes, rejected anonymous protected requests, and cold-launched the cached login shell after the last page was closed. This is hosted Chromium automation, not a physical-phone, waiting-service-worker update, or final production pass.

## Temporary Database-Free Maintenance

`backend/app/maintenance.py` is an explicit opt-in ASGI entrypoint for a temporary, coordinated Cloud Run revision. It never imports database/configuration code, runs migrations, or bypasses the normal API's startup guard. The normal image entrypoint remains `app.main:app`; do not replace it permanently. To verify the pause locally:

```powershell
python backend/maintenance_test.py
cd backend
python -m uvicorn app.maintenance:app --host 127.0.0.1 --port 8081
```

For an approved Cloud Run cutover, use the exact candidate image with an explicit temporary command/argument override equivalent to `python -m uvicorn app.maintenance:app --host 0.0.0.0 --port 8080`, preserving identity, IAM, resource limits, and secrets. Route traffic deliberately, verify the pause through direct and Hosting paths, and drain old in-flight requests before the separately coordinated migration job. Do not apply a migration merely because the temporary revision's liveness passes.

Only `GET /health` and `/api/health` return 200 with `status=maintenance`. Readiness, auth/API methods, uploads, and documentation routes return 503 with `Retry-After: 60` and `Cache-Control: no-store`; no session cookie is set. Preserve those headers and the instruction to keep drafts; do not cache the pause or clear device queues. Readiness monitoring is expected to detect this pause—do not disable alerts or mistake liveness for database readiness. Return traffic to the normal candidate only after the explicit migration and exact-ledger/readiness checks pass. If the job fails, follow the ledger-compatible rollback/recovery procedure rather than forcing old startup.

## Owned Hosted Report Fixtures

These commands are opt-in mutations for an authorized target, not read-only diagnostics. First inject process-only variables through the operator's protected secret mechanism; do not put values in Markdown, shell history, logs, or checked-in `.env` files:

- Provisioner: `REPORT_RELEASE_DATABASE_URL`, `REPORT_TEST_EXPECTED_DATABASE_HOST`, `REPORT_TEST_EXPECTED_DATABASE_NAME`, and a fresh high-entropy `REPORT_TEST_ACCOUNT_PASSWORD` of at least 32 characters.
- Browser runner: `HOSTED_REPORT_BASE_URL` (HTTPS origin only), `HOSTED_REPORT_ALLOWED_HOST` (exact matching host), and `HOSTED_REPORT_{SUPERVISOR,WORKER,SECOND_WORKER}_{EMAIL,PASSWORD}` for the three newly provisioned accounts. Optional `HOSTED_REPORT_EVIDENCE_DIR` must be a new directory.

Choose a fresh lowercase run ID (`[a-z0-9][a-z0-9_-]{3,39}`), use it consistently, and substitute it for `new-run-id`:

```powershell
python scripts/hosted-report-accounts.py --allow-hosted-fixtures --action provision --run-id new-run-id
node scripts/check-hosted-report-workflow.mjs --allow-hosted-mutations --run-id new-run-id
python scripts/hosted-report-accounts.py --allow-hosted-fixtures --action deactivate --run-id new-run-id
```

The provisioner requires exact approved database host/name, isolates inherited `PG*` overrides, verifies the full candidate ledger, and creates three nonce-named `example.invalid` accounts in one active Department with no Global Admin privileges. Emails are `release-<run-id>-supervisor@example.invalid`, `release-<run-id>-worker@example.invalid`, and `release-<run-id>-second_worker@example.invalid`; supply those and the injected temporary password to the browser variables without printing them. It refuses existing email reuse and never resets an existing user's password. Deactivation checks the exact name, role, Department, non-admin flag, and temporary password under row locks, then marks only owned synthetic users resigned; audit references remain intact.

The browser runner mutates only its nonce- and identity-bound Template/Report: it creates synthetic evidence, queues/replays, transitions and resolves, then uses supported soft-delete and archive APIs. It does not seed/reset databases, bulk-delete records, directly delete upload objects, purge the rubbish bin, or change existing users/passwords. Run account deactivation after browser cleanup, including on failure. Review `cleanup.failures` and `submissionOutcomeUnknown`; a cancelled browser request is not proof of server rollback. Preserve evidence and inspect any uncertain owned submission before cleanup—never broaden deletion scope or force an offline fixture online. Clear injected secrets from the process afterward.

The small runner regression suite is safe offline and does not invoke the hosted flow:

```powershell
node scripts/check-hosted-report-workflow-test.mjs
```

It checks actual labelled resolution-note markup, aborts stalled API requests, and preserves same-origin cookies/CSRF/JSON; all page traffic is intercepted locally and no network request reaches a server. The hosted runner itself blocks service workers, so its workflow result must be paired with the separate shell/PWA and physical-phone/update checks.

## Cloud Run And Hosting Deployment

Report-only changes require a coupled release. Promote the backend containing migrations through `0020_missing_snapshot_daywork_correction`, normal-Worker Report authorization, purpose/workflow filters, legacy-bypass guards, corrected Report exports, and the transition endpoint before cloning the report-only Hosting preview to live. Verify the previous live frontend against the candidate backend during the no-traffic/tagged phase so a frontend rollback remains available. The completed 2026-09-07 sequence above records this release; repeat the relevant gates for later changes rather than reusing historical approval.

1. Run `gcloud meta list-files-for-upload` from the repository root. Confirm `.gcloudignore` and `.dockerignore` exclude local databases, uploads, environment files, `__pycache__`, and bytecode while retaining `Dockerfile`, `requirements.txt`, and `backend/app/main.py`.
2. Build/deploy the backend from the repository root with zero traffic and a temporary tag. Preserve the intended Secret Manager bindings, dedicated runtime/build service accounts, GCS adapter, resource limits, and managed PostgreSQL target.
3. Confirm the tagged revision is Ready, call both `/health` and `/health/ready`, require `checks.database`, `checks.migrations`, and `checks.upload_storage` to be `ok`, and inspect its startup/migration and revision-scoped ERROR/5xx logs before moving traffic. `/health` alone is not a schema gate. Readiness reports sanitized check states; investigate detailed failures through protected operator logs and the read-only CLI, not by bypassing the guard.
4. Move traffic to the exact verified revision and verify it, for example:

   ```powershell
   gcloud run services describe geo-backend --region australia-southeast1 --format="yaml(status.latestCreatedRevisionName,status.latestReadyRevisionName,status.traffic)"
   ```

   Promote the exact revision that passed the tagged checks, then remove temporary tags after hosted verification:

   ```powershell
   gcloud run services update-traffic geo-backend --region australia-southeast1 --to-revisions="VERIFIED_REVISION=100"
   gcloud run services update-traffic geo-backend --region australia-southeast1 --clear-tags
   ```

5. Build the generated PWA shell, deploy it to a short-lived preview, verify the preview against the promoted compatible backend, and clone that exact Hosting version to live. `npm.cmd run build` invokes `generate:pwa`; do not edit `sw.js` after this build.

   ```powershell
   npm.cmd run build
   npx -y firebase-tools@latest hosting:channel:deploy release-YYYYMMDD-HHMMSS --expires 1d --project geo-attendance-system-db9ca
   npx -y firebase-tools@latest hosting:clone geo-attendance-system-db9ca:release-YYYYMMDD-HHMMSS geo-attendance-system-db9ca:live --project geo-attendance-system-db9ca --non-interactive
   ```

   Before cloning, hash every generated shell path plus `sw.js`, exercise the report-only Worker/Supervisor flow at phone width, verify the manifest/cache headers and network-only protected routes, and confirm the preview uses the expected transition endpoint. Clone only the exact version that passed.

6. Recheck Cloud Run traffic, remove the temporary candidate tag, and retain the previous compatible revision for rollback. Keep an installed/open baseline app client available for the post-promotion waiting-service-worker test.

## Hosted Verification

Start with read-only checks through Firebase Hosting:

```powershell
curl.exe https://geo-attendance-system-db9ca.web.app/api/health
curl.exe https://geo-attendance-system-db9ca.web.app/api/health/ready
```

Then use controlled accounts:

1. Before login, confirm the app says `Invited accounts only`, hides public registration, does not request protected `/api/sites`, `/api/work-forms`, or Report-history data, and does not display demo Sites.
2. On a restored session, confirm `/api/auth/refresh` finishes before protected `/api/sites`, `/api/work-forms`, or Report-history data is trusted.
3. Repeat an authenticated request after an idle period; the first request must succeed because `pool_pre_ping` recycles stale connections.
4. At phone width, sign in as both a Normal Worker and Leader. Confirm each sees only **New Report / My Reports**, then submit controlled Reports with required Report Date, one omitted Site, one selected Site, real photo evidence, and required touch signatures.
5. With a Template already loaded on the open Worker page, go offline and queue another photo/signature Report. Confirm it is private to the owner, reconnect as that Worker, retry if necessary, and verify exactly one durable submission with reused partial uploads/client submission id.
6. Sign in as a Supervisor at phone width. Confirm only **Reports / Report Templates / Staff**, filter by workflow/Template/Worker/Report Date, move the marker **Submitted → In review → Resolved**, require a final note, and confirm legacy approval/edit actions are absent.
7. Confirm the selected Report is immutable and exports as HTML/PDF/CSV. Confirm collection CSV/PDF uses Department plus workflow/Template/Worker/Report Date; free-text **Find** remains list-only.
8. Refresh the real photo/signature `/uploads/...` URLs as the Worker and authorized Supervisor to verify GCS-backed streaming and access control.
9. Create/edit/archive/reactivate one controlled Report Template and exercise Staff create/edit/resign/reactivate without exposing Sites. Reopen the older Report and confirm its frozen Definition snapshot is unchanged.
10. Remove the network from the loaded Supervisor list and confirm only the last durable Reports appear in explicit read-only mode.
    Also switch controlled Worker and Department Supervisor accounts on the same page without reloading. With the new account's history/queue delayed or unavailable, the previous account's details, evidence viewer, editor, private lists, and pending exports must not appear. Repeat session expiry and same-account re-login; old responses must not refill cleared views or expire the new session. This client-side cleanup preserves owner-scoped drafts/queued submissions and does not change API authorization or cookie policy.
11. Run the installed-phone cold-shell and waiting-service-worker **Update App** checklist in `docs/mobile-browser-workflow-checks.md`, including Report draft protection and the honest network-only Template limitation.
12. Re-run readiness, scan the serving revision for errors/5xx, and record exact Hosting/shell hashes and device evidence. Dispose of controlled data through supported operator actions: archive test Templates, resign test accounts when they are no longer needed, and follow the approved Report-retention/deletion procedure rather than editing database rows directly.

## Hardening Gates

Run the read-only GCP check from an authenticated admin machine:

```powershell
npm.cmd run check:production-hardening
npm.cmd run check:production-hardening:strict
```

The checker is provider-aware. With its default `-DatabaseProvider neon`, it verifies the dedicated runtime identity and three-permission upload role, Secret bindings, removal of the old runtime grants, bucket privacy and 30-day soft delete, exact uptime/alert policies with recent observations, current Neon branch cleanup, and the exact GCS soft-deleted proof generations. It does not treat an absent legacy Cloud SQL instance as a live-database failure. Use `-DatabaseProvider cloudsql` only after an intentional database cutover.

The normal npm command explicitly allows Console-incident-only monitoring for controlled testing; missing delivery remains a visible warning, never a delivery pass. The `:strict` command requires every policy to reference an enabled email channel whose verification status is `VERIFIED` or omitted/`VERIFICATION_STATUS_UNSPECIFIED`, plus recent recipient-confirmed delivery proof. `UNVERIFIED` always fails. `-AlertDeliveryEvidence` defaults to `docs/evidence/alert-delivery-diagnosis-*.json`; `-MaximumAlertDeliveryEvidenceAgeDays` defaults to 30. Proof binds the project, current channel and normalized-recipient hash, exact test policy/incident, ordered non-future timestamps, actual Boolean receipt confirmation, and exact owned-policy cleanup/404. Changed recipients, stale/malformed proof, or empty logs cannot satisfy it. This evidence schema is email-only; other channel types require an appropriate destination-bound proof contract.

On 2026-08-13 the controlled-test gate passed with incident-only, six-hour retention, and skipped-budget warnings. September receipt and budget configuration supersede the missing-channel/budget findings. Both commands still default to `-ReleasePhase Current`, requiring recovery for the full candidate ledger. Explicit `PreMigration` accepts only the declared known deployed prefix and prints that this is not current-candidate approval; it retains all other hardening checks.

Current warnings are operational decisions rather than hidden green checks:

- The coupled production release, post-migration recovery, preview/live parity, live authenticated Report workflow, and real waiting-service-worker update have green automated results. The **physical-phone gate remains pending**: verify both Worker classes, Supervisor navigation, optional Site, all Report states, exactly-once offline photo/signature replay, authenticated GCS streaming, cached-shell/network-only Template limits, translations, and updates on an installed device.
- The current Supervisor provisioning form requires an initial password; implement a single-use Worker password-setup invitation before scaling beyond controlled accounts.
- Monitoring email receipt is confirmed for the current destination; keep that evidence current and retest after destination changes. It does not prove real-outage detection or budget-threshold email receipt.
- Neon Free retains only six hours of history and has no scheduled snapshots. The drill proves current PITR mechanics, not a production-grade recovery window.
- The live database still uses a non-superuser owner role with broad privileges; create a least-privilege application role, protect the production branch, and test credential rotation. The read-only [capacity snapshot](evidence/neon-runtime-capacity-2026-09-07.json) verifies the pooled hostname, not production load safety. Set and load-test explicit application pool/scale bounds with headroom for operators and migrations; 300 possible app-to-pooler clients at 20 instances do not equal 300 physical PostgreSQL connections.
- Pass `-BillingAccount 0123B1-051D70-935F73` to include the GCP budget check. The project-only NZ$10/month configuration is verified; budgets and Cloud Run instance limits are not hard spending caps, and the GCP budget excludes separate Neon costs.

## Recovery Proofs

### Neon

Use a fresh evidence filename for every proof; the script refuses to overwrite existing results. The following is the **historical pre-migration command** for the completed `0017`→`0020` release; it cannot approve today's full-`0020` production state. For a future migration, independently verify and declare that release's actual deployed prefix:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prove-neon-recovery.ps1 `
  -ReleasePhase PreMigration `
  -PreMigrationRecoveryHead 0017_global_admin_supervisor_invariant `
  -EvidencePath docs/evidence/neon-recovery-proof-YYYYMMDD-HHMMSS-baseline.json
powershell -ExecutionPolicy Bypass -File scripts/check-production-hardening.ps1 `
  -ReleasePhase PreMigration `
  -PreMigrationRecoveryHead 0017_global_admin_supervisor_invariant `
  -NeonRecoveryEvidence docs/evidence/neon-recovery-proof-YYYYMMDD-HHMMSS-baseline.json `
  -BillingAccount 0123B1-051D70-935F73
```

The schema 3 proof records `releasePhase`, `candidateHead`, `expectedRecoveryHead`, the full candidate/source-prefix ledgers, and the verifier's complete ordered version/checksum map. `PreMigrationRecoveryHead` is permitted only in `PreMigration` and must exactly identify a known source prefix strictly before the candidate head. Unknown, abbreviated, future, missing-middle, duplicate, or checksum-mismatched ledgers fail. Exact source bytes are hashed without normalization; candidate changes invalidate the proof. The 2026-09-07 [baseline result](evidence/neon-recovery-proof-2026-09-07-baseline.json) completed at 03:56:08 UTC and passes for deployed `0017`, bound to candidate `0020`. The [original failed result](evidence/neon-recovery-proof-2026-09-07.json) remains unchanged as history.

After migration, select a historical recovery point **after the migration committed**, then run the default full-candidate proof and strict gate. The 2026-09-07 [Current result](evidence/neon-recovery-proof-2026-09-07-current.json) passed at 04:19:02 UTC using the post-migration 04:16:16 UTC point. The default restore offset is five minutes, so wait sufficiently or explicitly select a valid post-migration point for a new proof; an older recovery point correctly fails `Current`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prove-neon-recovery.ps1 `
  -ReleasePhase Current `
  -EvidencePath docs/evidence/neon-recovery-proof-YYYYMMDD-HHMMSS-current.json
powershell -ExecutionPolicy Bypass -File scripts/check-production-hardening.ps1 `
  -NeonRecoveryEvidence docs/evidence/neon-recovery-proof-YYYYMMDD-HHMMSS-current.json `
  -BillingAccount 0123B1-051D70-935F73
```

`Current` cannot reuse the baseline, even if it is recent; it requires all 20 current candidate migrations and exact checksums. The pinned `neon@2.32.0` proof creates an expiring read-only branch, observes rather than forces transaction read-only mode, verifies public schema, hashed counts and non-empty Department/User/Site sentinels, and deletes only the exact reverified owned branch. Artifact hashes bind the proof script, Python verifier, and shared migration-contract helper. Store only sanitized JSON; never persist connection URIs, CLI create output, or debug transcripts. These proofs test temporary recovery branches, not a reset of production.

For an actual incident, create and inspect a recovery branch before changing production. Point a no-traffic Cloud Run revision at a separately stored recovery connection Secret, verify data and readiness, and move traffic only under an incident plan. Do not reset the production branch merely to test restore mechanics.

### Uploads

The production upload contract and operator restore commands are in `docs/upload-recovery-policy.md`. Run its content-preserving soft-delete proof with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prove-upload-recovery.ps1 `
  -EvidencePath docs/evidence/upload-recovery-proof-$(Get-Date -Format yyyy-MM-dd).json
```

The proof uses a non-sensitive, run-marked fixture under `recovery-probes/`; every upload/delete has a generation precondition. It verifies the exact original soft-deleted generation, restores only that generation, downloads and SHA-256 matches the result, deletes only the owned restored generation, and proves both exact generations are soft-deleted with no live probe. The small soft-deleted generations remain until the bucket's normal 30-day hard-delete time. The 2026-07-15 proof is `docs/evidence/upload-recovery-proof-2026-07-15.json`.

## Rollback

- If staging migration fails, discard the staging database/branch, fix the migration, and repeat the full staging sequence.
- If production migration fails before traffic moves, keep or resume the previous revision only if its exact migration artifact still matches the database and readiness passes. Otherwise stay in maintenance while investigating and use an approved recovery/repair plan; do not assume failure left the database unchanged.
- If report-only Hosting fails after the compatible backend/migrations are healthy, clone the exact previous Hosting version back to live first and leave the new compatible backend in place while investigating. The `0018`–`0020` chain is additive, but compatibility still requires the exact ledger; `0019` makes legacy Report approval/manual-create/content-edit attempts fail closed and `0020` has audited corrective effects. Do not route the August backend while an active Report interface expects transitions, or undo correction provenance manually.
- If Report transitions or migrated workflow data are wrong, stop the frontend promotion or roll back to a ledger-compatible application revision. Do not manually rewrite `workflow_status`, reviewer, note, or timestamps; inspect the `report_transition`/legacy audit evidence on a recovery branch and use an audited repair plan.
- If the app fails after a backward-compatible migration, a previous image is usable only if it also contains the exact applied migration history. Additive schema compatibility alone does not satisfy the guard. Prefer a verified fix-forward image with the current migration artifact; never remove ledger entries or enable automatic migrations to force an old image to start.
- If a compatible image is unavailable, obtain approval for database recovery, restore or clone the pre-migration database, update the Cloud Run `DATABASE_URL` secret binding to that database, deploy/route the matching revision, and verify all readiness checks before serving users. Account for writes since the recovery point; recovery is not an automatic response to a startup failure.
- If uploads fail, do not switch production to local storage. Fix GCS IAM/configuration or roll back to a revision with the known-good adapter configuration.

Document the incident, revision, migration head, database recovery point, traffic change, and verification results. Never repair production tables manually without a fresh recovery point and an audited plan.
