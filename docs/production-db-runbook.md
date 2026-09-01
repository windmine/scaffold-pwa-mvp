# Production Database And Deployment Runbook

Use this runbook for managed PostgreSQL migrations, Cloud Run releases, durable uploads, verification, and rollback. Local SQLite and `backend/uploads/` are development-only.

## Deployment Truth

### Current live deployment

Backend topology last changed on 2026-08-04 and readiness was rechecked on 2026-08-13:

```text
Firebase Hosting
  /api/** and /uploads/**
            -> Cloud Run geo-backend (australia-southeast1)
                 -> Neon PostgreSQL via Secret Manager DATABASE_URL
                 -> private Cloud Storage bucket geo-attendance-system-db9ca-uploads
```

- Hosted PWA: `https://geo-attendance-system-db9ca.web.app`.
- Cloud Run revision `geo-backend-release-20260804152130` serves 100% of traffic as `geo-backend-runtime@geo-attendance-system-db9ca.iam.gserviceaccount.com`.
- Hosted `/api/health/ready` reports database and GCS as healthy. Firebase Hosting version `c761984b7353028a` matches the verified commit `bcfb128` build across all 47 generated app-shell paths plus `sw.js`, serves the invited-only login with public registration hidden and the login form before the install promotion, contains the cold-offline Worker shell, keeps Staff and Work Form creation behind Add actions, provides the consistent consequential-action dialog, links Analytics exceptions to their exact Review Record or valid map point, and keeps essential map/Analytics labels at a tested 14px minimum.
- The current working tree is a coupled backend/frontend report-only release candidate, not the live deployment described above. It adds migrations `0018_report_review_workflow` and `0019_report_daywork_purpose`, normal-Worker Report submission, durable Report-versus-Daywork separation, the forward-only Report transition endpoint, and the **Reports / Report Templates / Staff** shell. Do not deploy or clone the report-only frontend to live while Cloud Run still serves the August backend.
- On 2026-09-01, the local in-app browser passed the report-only Worker → Supervisor → Worker lifecycle at 390 × 844, including omitted Site, structured filters, required resolution note, final-note visibility, and Report Template/Staff navigation without horizontal overflow. The complete local candidate gate is green, including all 33 Playwright workflows, backend migration/security/storage/workflow suites, a disposable-database smoke pass, production dependency audit, and Python dependency consistency. Hosted device verification remains a release gate, and the current production-hardening evidence is not green for live promotion.
- `DATABASE_URL` and `GEO_SECRET_KEY` are injected from Secret Manager.
- The runtime identity has no project-level role. It has secret-level accessor bindings and a custom upload role containing only `storage.objects.create`, `storage.objects.get`, and `storage.objects.delete`, restricted to `uploads/`.
- The default Compute service account is no longer a runtime credential and retains only `roles/run.builder` for Cloud Run source builds.
- SQLAlchemy uses `pool_pre_ping` so a Neon/managed-PostgreSQL connection closed while idle is discarded before the route query.
- Upload startup performs create/read/delete lifecycle verification; readiness then reads a stable private marker.
- Uploaded JPEG, PNG, and WebP files are decoded and re-encoded before storage, served only after authorization, and deleted when detached and no durable reference remains.
- `/health/ready` verifies both database access and the selected upload adapter.
- Cloud Monitoring checks the hosted `/api/health/ready` path and has enabled incident policies for readiness failures and Cloud Run 5xx responses. No verified notification channel is configured yet.
- Neon PITR passed again on 2026-08-04 at migration head `0017_global_admin_supervisor_invariant`; the GCS soft-delete recovery proof remains current. Sanitized evidence is under `docs/evidence/` and is checked by the production-hardening gate.
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
npm.cmd audit --omit=dev
npm.cmd audit
python -m pip check
```

`npm.cmd run check:mobile` now builds and regenerates before checking and starts a lightweight Node source/proxy test server plus a `dist/` production preview. The source server avoids the Vite development watcher while preserving shared unbundled-module state for browser probes; the runner fails fast with recent output if a managed process exits. The 33 default 390 × 844 workflows cover the report-only Worker/Supervisor shell, required Report Date, optional Site, workflow transitions/final note, phone-width Template/Staff access, resumable exactly-once photo/nested-signature replay, offline Report-only history, explicit purpose overriding misleading names, and replay isolation from hidden legacy queue records. Retained full-interface checks use a test-only override. The production service worker must list the hashed JavaScript/CSS entrypoints referenced by `dist/index.html`, serve cached `index.html` only for `/` and `/index.html` navigation failures, and keep API/auth/Template/history/upload paths network-only. Default temporary ports are backend `8765`, source frontend `5175`, and preview `4175`.

Then start the backend against a disposable database and run:

```powershell
python backend\smoke_test.py
```

The database test specifically proves `pool_pre_ping` recovers a poisoned returned connection. The focused tests cover upload adapter parity, immutable Report Template snapshots/server-derived formulas, Report ownership/workflow/transition concurrency, cursor-paginated Review Queue policy/query/export separation, and migrations.

The 2026-07-31 local preflight passed all functional checks and the disposable-database smoke test. Production npm dependencies and Python requirements were clean; the full development npm audit reported one high-severity `brace-expansion` advisory through ESLint/minimatch.

## Database Migration Procedure

The current migration head is `0019_report_daywork_purpose`:

- `0014_client_submission_unique_indexes` enforces replay idempotency for Worker submissions.
- `0015_work_form_definition_snapshots` versions Work Form Definitions and backfills a best-available snapshot for old submissions. Post-migration submissions preserve their exact historical definition.
- `0016_review_queue_indexes` adds Department/status/deletion/time indexes for cursor-paginated Review Queue queries without changing Review Record values.
- `0017_global_admin_supervisor_invariant` revokes malformed legacy Global Admin flags from non-Supervisor accounts, then enforces the Supervisor-only invariant for future writes.
- `0018_report_review_workflow` adds the constrained `submitted` / `in_review` / `resolved` workflow, reviewing Supervisor/final note/timestamps, and Report workflow indexes. It preserves legacy approval outcomes, maps existing approved/rejected submissions to `resolved`, and backfills reviewer/time only from matching durable audit evidence.
- `0019_report_daywork_purpose` adds constrained `template_purpose` and immutable `submission_purpose` values, classifies historical Daywork from known Definition field signatures and each submission's frozen snapshot rather than mutable names, and indexes Report-only queries without rewriting submitted answers or evidence. SQLite and PostgreSQL guards derive inserted purpose from the parent Template, reject pre-reviewed/approved Report inserts, and block legacy Report status/content/purpose rewrites while retaining old-backend Daywork writes.

For every release:

1. Confirm the intended database provider and database name. Never infer them from an old Cloud Run revision.
2. Create a restorable backup, Neon branch, or Cloud SQL on-demand backup.
3. Create a disposable staging database/branch from production-like schema and sanitized data where possible.
4. Point a local/staging backend at that database through a temporary `DATABASE_URL` and run:

   ```powershell
   cd backend
   python -m app.migrations
   ```

5. Start the staging backend and run `python backend\smoke_test.py` from the repository root.
6. Inspect `schema_migrations`, row counts, constraint failures, and application logs.
7. Run the hosted browser workflow against a staging Cloud Run service if the migration changes data read by the UI.
8. Apply the same migration to production only after staging passes.
9. Keep the backup/branch until the post-release observation window finishes.

The production `Dockerfile` starts the API only. It must not run `python -m app.migrations` in `CMD`; otherwise creating a no-traffic Cloud Run revision could still mutate the database during container startup. `npm.cmd run check:production-hardening` enforces this deployment boundary. Run migrations explicitly against the verified target before deploying the compatible revision.

For Cloud SQL proxy-based staging, a typical local connection is:

```powershell
cloud-sql-proxy.exe --gcloud-auth --address 127.0.0.1 --port 55433 PROJECT:REGION:INSTANCE
$env:DATABASE_URL="postgresql+psycopg://USER:PASSWORD@127.0.0.1:55433/STAGING_DATABASE"
```

Do not copy that password into shell history on a shared machine; prefer a temporary secret injection method.

## Cloud Run And Hosting Deployment

The report-only candidate is a coupled release. Promote the backend containing migrations `0018_report_review_workflow` and `0019_report_daywork_purpose`, normal-Worker Report authorization, purpose/workflow filters, legacy-bypass guards, corrected Report exports, and the transition endpoint before cloning the report-only Hosting preview to live. Verify the previous live frontend against the candidate backend during the no-traffic/tagged phase so a frontend rollback remains available.

1. Run `gcloud meta list-files-for-upload` from the repository root. Confirm `.gcloudignore` and `.dockerignore` exclude local databases, uploads, environment files, `__pycache__`, and bytecode while retaining `Dockerfile`, `requirements.txt`, and `backend/app/main.py`.
2. Build/deploy the backend from the repository root with zero traffic and a temporary tag. Preserve the intended Secret Manager bindings, dedicated runtime/build service accounts, GCS adapter, resource limits, and managed PostgreSQL target.
3. Confirm the tagged revision is Ready, call both `/health` and `/health/ready`, and inspect its startup/migration and revision-scoped ERROR/5xx logs before moving traffic.
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
11. Run the installed-phone cold-shell and waiting-service-worker **Update App** checklist in `docs/mobile-browser-workflow-checks.md`, including Report draft protection and the honest network-only Template limitation.
12. Re-run readiness, scan the serving revision for errors/5xx, and record exact Hosting/shell hashes and device evidence. Dispose of controlled data through supported operator actions: archive test Templates, resign test accounts when they are no longer needed, and follow the approved Report-retention/deletion procedure rather than editing database rows directly.

## Hardening Gates

Run the read-only GCP check from an authenticated admin machine:

```powershell
npm.cmd run check:production-hardening
npm.cmd run check:production-hardening:strict
```

The checker is provider-aware. With its default `-DatabaseProvider neon`, it verifies the dedicated runtime identity and three-permission upload role, Secret bindings, removal of the old runtime grants, bucket privacy and 30-day soft delete, exact uptime/alert policies with recent observations, current Neon branch cleanup, and the exact GCS soft-deleted proof generations. It does not treat an absent legacy Cloud SQL instance as a live-database failure. Use `-DatabaseProvider cloudsql` only after an intentional database cutover.

The normal npm command explicitly allows Console-incident-only monitoring for the controlled-test phase. The `:strict` command is the real-production gate and fails until every required policy has an enabled, verified delivery channel.

On 2026-08-13, the controlled-test gate passed with three warnings (incident-only Monitoring, six-hour Neon retention, and skipped budget verification). The strict gate remains red for real production use because no verified notification channel is attached.

Current warnings are operational decisions rather than hidden green checks:

- The automated 2026-08-13 frontend release pass is green for the historical full-interface build. The report-only backend/frontend candidate is not yet live; after its focused 2026-09-01 local phone-width pass, it still needs the full local preflight, preview, exact-clone, and hosted real-phone gates. Those remaining gates must verify both Worker classes, Supervisor phone-width navigation, optional Site, all Report workflow states, offline photo/signature replay exactly once, authenticated GCS streaming, cached-shell relaunch with network-only Template limitations, translations, and the waiting-service-worker update flow on a real installed device.
- The current Supervisor provisioning form requires an initial password; implement a single-use Worker password-setup invitation before scaling beyond controlled accounts.
- The two Monitoring policies create Console incidents, but no verified email/chat notification channel is attached.
- Neon Free retains only six hours of history and has no scheduled snapshots. The drill proves current PITR mechanics, not a production-grade recovery window.
- The live database still uses the owner role; create a least-privilege application role, protect the production branch, and test credential rotation.
- Pass `-BillingAccount` to include the GCP budget check.

## Recovery Proofs

### Neon

Run the non-destructive proof from an authenticated, linked Neon CLI context:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prove-neon-recovery.ps1 `
  -EvidencePath docs/evidence/neon-recovery-proof-$(Get-Date -Format yyyy-MM-dd).json
```

The script uses the pinned `neon@2.32.0` CLI, selects a point five minutes inside the current history window, creates an expiring read-only branch from that historical production point, connects without printing its generated connection string, verifies read-only mode, every migration, public schema, hashed table counts, and non-empty Department/User/Site business sentinels, then deletes only the branch whose exact run ownership metadata is reverified. Store only the sanitized JSON result; never store CLI create output, debug transcripts, or a connection URI. The current proof is `docs/evidence/neon-recovery-proof-2026-08-04.json`; the 2026-07-15 file is retained as historical evidence.

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
- If production migration fails before traffic moves, keep the previous revision serving and restore/branch from the pre-migration recovery point if data changed.
- If report-only Hosting fails after the compatible backend/migrations are healthy, clone the exact previous Hosting version back to live first and leave the new compatible backend in place while investigating. Migrations `0018` and `0019` are additive; `0019` keeps old-backend Daywork inserts purpose-correct but deliberately makes legacy Report approval/manual-create/content-edit attempts fail closed at the database boundary. Do not route the August backend while an active Report interface expects transition support.
- If Report transitions or migrated workflow data are wrong, stop the frontend promotion or roll back application traffic. Do not manually rewrite `workflow_status`, reviewer, note, or timestamps; inspect the `report_transition`/legacy audit evidence on a recovery branch and use an audited repair plan.
- If the app fails after a backward-compatible migration, route traffic to the previous compatible revision and investigate without reverting data automatically.
- If the schema is not backward compatible, restore or clone the pre-migration database, update the Cloud Run `DATABASE_URL` secret binding to that database, deploy/route the compatible revision, and verify readiness before serving users.
- If uploads fail, do not switch production to local storage. Fix GCS IAM/configuration or roll back to a revision with the known-good adapter configuration.

Document the incident, revision, migration head, database recovery point, traffic change, and verification results. Never repair production tables manually without a fresh recovery point and an audited plan.
