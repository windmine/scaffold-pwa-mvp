# Production Database And Deployment Runbook

Use this runbook for managed PostgreSQL migrations, Cloud Run releases, durable uploads, verification, and rollback. Local SQLite and `backend/uploads/` are development-only.

## Deployment Truth

### Current live deployment

Checked on 2026-07-14:

```text
Firebase Hosting
  /api/** and /uploads/**
            -> Cloud Run geo-backend (australia-southeast1)
                 -> Neon PostgreSQL via Secret Manager DATABASE_URL
                 -> private Cloud Storage bucket geo-attendance-system-db9ca-uploads
```

- Hosted PWA: `https://geo-attendance-system-db9ca.web.app`.
- Cloud Run revision `geo-backend-00018-jbz` serves 100% of traffic.
- `DATABASE_URL` and `GEO_SECRET_KEY` are injected from Secret Manager.
- SQLAlchemy uses `pool_pre_ping` so a Neon/managed-PostgreSQL connection closed while idle is discarded before the route query.
- Upload startup performs create/read/delete lifecycle verification; readiness then reads a stable private marker.
- Uploaded JPEG, PNG, and WebP files are decoded and re-encoded before storage, served only after authorization, and deleted when detached and no durable reference remains.
- `/health/ready` verifies both database access and the selected upload adapter.
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

1. Build/deploy the backend with the intended Secret Manager bindings, dedicated service account, GCS adapter, and managed PostgreSQL target.
2. Confirm the new revision is Ready and inspect its startup/migration logs before moving traffic.
3. Move traffic to the intended revision and verify it, for example:

   ```powershell
   gcloud run services describe geo-backend --region australia-southeast1 --format="yaml(status.latestCreatedRevisionName,status.latestReadyRevisionName,status.traffic)"
   ```

   If an old tagged revision remains pinned and the release policy is latest-only:

   ```powershell
   gcloud run services update-traffic geo-backend --region australia-southeast1 --to-latest
   ```

4. Build and deploy the generated PWA shell:

   ```powershell
   npm.cmd run build
   npx -y firebase-tools@latest deploy --only hosting
   ```

5. Recheck Cloud Run traffic and retain the previous compatible revision for rollback.

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
```

It checks GCP-side concerns such as Cloud Run identity/roles, the known Cloud SQL resource, upload-bucket IAM, monitoring, and optional budget alerts. Because the current live database is Neon, also verify separately:

- Neon role and connection-string least privilege.
- Backup/PITR retention and a documented restore/branch drill.
- Compute/pooling limits, region, scale-to-zero behaviour, and operational alerts.
- Secret rotation and removal of unused database users.

Remaining known GCP concerns include replacing the broad default Compute Engine service account, adding monitoring/budget alerts, and deciding whether to harden/migrate to or retire the legacy Cloud SQL resources. Do not treat a Cloud SQL warning as proof that live Neon is unhealthy, or a passing GCP check as proof that Neon recovery is ready.

## Rollback

- If staging migration fails, discard the staging database/branch, fix the migration, and repeat the full staging sequence.
- If production migration fails before traffic moves, keep the previous revision serving and restore/branch from the pre-migration recovery point if data changed.
- If the app fails after a backward-compatible migration, route traffic to the previous compatible revision and investigate without reverting data automatically.
- If the schema is not backward compatible, restore or clone the pre-migration database, update the Cloud Run `DATABASE_URL` secret binding to that database, deploy/route the compatible revision, and verify readiness before serving users.
- If uploads fail, do not switch production to local storage. Fix GCS IAM/configuration or roll back to a revision with the known-good adapter configuration.

Document the incident, revision, migration head, database recovery point, traffic change, and verification results. Never repair production tables manually without a fresh recovery point and an audited plan.
