# Production Database And Deployment Runbook

Use this runbook for managed PostgreSQL migrations, Cloud Run releases, durable uploads, verification, and rollback. Local SQLite and `backend/uploads/` are development-only.

## Deployment Truth

### Current live deployment

Checked on 2026-07-15:

```text
Firebase Hosting
  /api/** and /uploads/**
            -> Cloud Run geo-backend (australia-southeast1)
                 -> Neon PostgreSQL via Secret Manager DATABASE_URL
                 -> private Cloud Storage bucket geo-attendance-system-db9ca-uploads
```

- Hosted PWA: `https://geo-attendance-system-db9ca.web.app`.
- Cloud Run revision `geo-backend-release-20260715213211` serves 100% of traffic as `geo-backend-runtime@geo-attendance-system-db9ca.iam.gserviceaccount.com`.
- `DATABASE_URL` and `GEO_SECRET_KEY` are injected from Secret Manager.
- The runtime identity has no project-level role. It has secret-level accessor bindings and a custom upload role containing only `storage.objects.create`, `storage.objects.get`, and `storage.objects.delete`, restricted to `uploads/`.
- The default Compute service account is no longer a runtime credential and retains only `roles/run.builder` for Cloud Run source builds.
- SQLAlchemy uses `pool_pre_ping` so a Neon/managed-PostgreSQL connection closed while idle is discarded before the route query.
- Upload startup performs create/read/delete lifecycle verification; readiness then reads a stable private marker.
- Uploaded JPEG, PNG, and WebP files are decoded and re-encoded before storage, served only after authorization, and deleted when detached and no durable reference remains.
- `/health/ready` verifies both database access and the selected upload adapter.
- Cloud Monitoring checks the hosted `/api/health/ready` path and has enabled incident policies for readiness failures and Cloud Run 5xx responses. No verified notification channel is configured yet.
- Neon PITR and GCS soft-delete recovery proofs passed on 2026-07-15. The evidence is under `docs/evidence/` and is checked by the production-hardening gate.
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
AUTO_MIGRATE=true
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
python -m compileall backend\app backend\smoke_test.py backend\database_test.py backend\migration_test.py backend\review_queue_test.py backend\work_form_definition_test.py backend\upload_storage_test.py backend\security_test.py
python backend\database_test.py
python backend\security_test.py
python backend\upload_storage_test.py
python backend\review_queue_test.py
python backend\work_form_definition_test.py
python backend\migration_test.py
```

Then start the backend against a disposable database and run:

```powershell
python backend\smoke_test.py
```

The database test specifically proves `pool_pre_ping` recovers a poisoned returned connection. The focused tests cover upload adapter parity, Work Form snapshots/server-derived formulas, cursor-paginated Review Queue policy/query/export separation, and migrations.

## Database Migration Procedure

The current migration head is `0016_review_queue_indexes`:

- `0014_client_submission_unique_indexes` enforces replay idempotency for Worker submissions.
- `0015_work_form_definition_snapshots` versions Work Form Definitions and backfills a best-available snapshot for old submissions. Post-migration submissions preserve their exact historical definition.
- `0016_review_queue_indexes` adds Department/status/deletion/time indexes for cursor-paginated Review Queue queries without changing Review Record values.

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

For Cloud SQL proxy-based staging, a typical local connection is:

```powershell
cloud-sql-proxy.exe --gcloud-auth --address 127.0.0.1 --port 55433 PROJECT:REGION:INSTANCE
$env:DATABASE_URL="postgresql+psycopg://USER:PASSWORD@127.0.0.1:55433/STAGING_DATABASE"
```

Do not copy that password into shell history on a shared machine; prefer a temporary secret injection method.

## Cloud Run And Hosting Deployment

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

5. Build the generated PWA shell, deploy it to a short-lived preview, verify the preview, and clone that exact Hosting version to live:

   ```powershell
   npm.cmd run build
   npx -y firebase-tools@latest hosting:channel:deploy release-YYYYMMDD-HHMMSS --expires 1d --project geo-attendance-system-db9ca
   npx -y firebase-tools@latest hosting:clone geo-attendance-system-db9ca:release-YYYYMMDD-HHMMSS geo-attendance-system-db9ca:live --project geo-attendance-system-db9ca --non-interactive
   ```

6. Recheck Cloud Run traffic, remove the temporary candidate tag, and retain the previous compatible revision for rollback.

## Hosted Verification

Start with read-only checks through Firebase Hosting:

```powershell
curl.exe https://geo-attendance-system-db9ca.web.app/api/health
curl.exe https://geo-attendance-system-db9ca.web.app/api/health/ready
```

Then use controlled accounts:

1. Before login, confirm the app does not request `/api/sites` or display demo Sites.
2. On a restored session, confirm `/api/auth/refresh` finishes before `/api/sites`.
3. Repeat an authenticated `/api/sites` request after an idle period; the first request must succeed because `pool_pre_ping` recycles stale connections.
4. Submit a Worker attendance event, Task Log, and required-signature Work Form with known test markers.
5. Confirm the Supervisor Review Queue sees only durable records and enters explicit read-only mode if the network is removed.
6. Approve and reject controlled pending records; verify dashboard totals and Management Analytics from the complete overview, not only the visible filtered page.
7. Upload a photo/signature and refresh its `/uploads/...` URL to verify authorized GCS streaming.
8. Confirm Audit history contains the controlled changes.
9. Run the real-phone and PWA update-flow checklist in `docs/mobile-browser-workflow-checks.md`.
10. Scan the new revision for error logs and remove controlled test data through supported application actions.

## Hardening Gates

Run the read-only GCP check from an authenticated admin machine:

```powershell
npm.cmd run check:production-hardening
npm.cmd run check:production-hardening:strict
```

The checker is provider-aware. With its default `-DatabaseProvider neon`, it verifies the dedicated runtime identity and three-permission upload role, Secret bindings, removal of the old runtime grants, bucket privacy and 30-day soft delete, exact uptime/alert policies with recent observations, current Neon branch cleanup, and the exact GCS soft-deleted proof generations. It does not treat an absent legacy Cloud SQL instance as a live-database failure. Use `-DatabaseProvider cloudsql` only after an intentional database cutover.

The normal npm command explicitly allows Console-incident-only monitoring for the controlled-test phase. The `:strict` command is the real-production gate and fails until every required policy has an enabled, verified delivery channel.

Current warnings are operational decisions rather than hidden green checks:

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

The script uses the pinned `neon@2.32.0` CLI, selects a point five minutes inside the current history window, creates an expiring read-only branch from that historical production point, connects without printing its generated connection string, verifies read-only mode, every migration, public schema, hashed table counts, and non-empty Department/User/Site business sentinels, then deletes only the branch whose exact run ownership metadata is reverified. Store only the sanitized JSON result; never store CLI create output, debug transcripts, or a connection URI. The 2026-07-15 proof is `docs/evidence/neon-recovery-proof-2026-07-15.json`.

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
- If the app fails after a backward-compatible migration, route traffic to the previous compatible revision and investigate without reverting data automatically.
- If the schema is not backward compatible, restore or clone the pre-migration database, update the Cloud Run `DATABASE_URL` secret binding to that database, deploy/route the compatible revision, and verify readiness before serving users.
- If uploads fail, do not switch production to local storage. Fix GCS IAM/configuration or roll back to a revision with the known-good adapter configuration.

Document the incident, revision, migration head, database recovery point, traffic change, and verification results. Never repair production tables manually without a fresh recovery point and an audited plan.
