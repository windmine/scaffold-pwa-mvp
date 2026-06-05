# Production DB Runbook

Use this to manage the live backend database after moving from demo SQLite to managed PostgreSQL.

## Target

- Database: Cloud SQL for PostgreSQL or another managed PostgreSQL-compatible service.
- App: Cloud Run service `geo-backend`.
- Frontend: Firebase Hosting at `https://geo-attendance-system-db9ca.web.app`.
- Migration command: `python -m app.migrations`.

Current checked status on 2026-06-05:

- Cloud SQL instance `geo-attendance-system` exists in `australia-southeast1`.
- App database `geo_management` exists.
- Staging validation database `geo_management_staging` exists.
- Cloud Run service `geo-backend` is attached to the instance.
- Cloud Run service account has `roles/cloudsql.client`.
- PostgreSQL driver `psycopg[binary]` is listed in `requirements.txt`.
- Staging migrations and backend smoke tests passed against Cloud SQL PostgreSQL through Cloud SQL Auth Proxy.
- Secret Manager is enabled.
- Cloud Run revision `geo-backend-00007-5fc` uses Secret Manager-backed `DATABASE_URL` and `GEO_SECRET_KEY`.
- Live Cloud SQL database `geo_management` has migration `0001_initial_schema` applied.
- Live backend smoke tests passed through Firebase Hosting at `https://geo-attendance-system-db9ca.web.app/api`.
- Automated Cloud SQL backups are enabled with a `15:00` UTC backup window.
- PITR is enabled with 7 days of transaction log retention.
- Cloud SQL keeps 15 retained backups, retains backups on delete, and has final backup on delete enabled for 30 days.
- Storage auto-increase is enabled.
- On-demand backup `1780636673411` was created after PITR was enabled.
- New photos/signatures are stored in private Cloud Storage bucket `geo-attendance-system-db9ca-uploads`.
- Cloud Run serves stable `/uploads/...` URLs by loading objects from the bucket.
- The upload bucket is in `australia-southeast1`, uses uniform bucket-level access, enforces public access prevention, and has 30-day soft delete.

Current remaining production hardening items:

- Cloud SQL is still `ZONAL`; use `REGIONAL` if the app needs automatic database failover.
- Cloud SQL still has public IPv4 assigned. No authorized networks are currently listed, but plan private IP/VPC access before disabling public IPv4.
- Cloud Run uses the default Compute Engine service account, which currently has broad project roles including `Editor`. Replace it with a dedicated least-privilege service account.
- Existing smoke-test records may still point at fake `/uploads/...` paths that were never uploaded as real files.
- The `geo_migration_runner` database user still exists. Rotate, remove, or formalize it before a real production launch.
- Add monitoring alerts and run a restore drill from backup/PITR.

Google references:

- Cloud Run to Cloud SQL for PostgreSQL: `https://docs.cloud.google.com/sql/docs/postgres/connect-run`
- Cloud SQL PostgreSQL backups: `https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/backups`
- Cloud SQL PostgreSQL point-in-time recovery: `https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/pitr`

## Preflight

1. Confirm local validation passes:

   ```powershell
   npm.cmd run lint
   npm.cmd run build
   npm.cmd run check:mobile
   python -m compileall backend\app backend\smoke_test.py backend\migration_test.py
   python backend\migration_test.py
   ```

2. Confirm `psycopg[binary]` is installed from `requirements.txt`.
3. For full production, create or select a non-free-trial staging Cloud SQL PostgreSQL instance in the same region as Cloud Run.
4. Enable automated backups and point-in-time recovery before storing irreplaceable data.
5. Create a least-privilege app database user.
6. Attach the Cloud SQL instance to Cloud Run and grant the Cloud Run service account `roles/cloudsql.client`.
7. Set staging Cloud Run environment variables:

   ```text
   DATABASE_URL=postgresql+psycopg://geo_app:URL_ENCODED_PASSWORD@/geo_management?host=/cloudsql/geo-attendance-system-db9ca:australia-southeast1:geo-attendance-system
   AUTO_MIGRATE=true
   SQL_ECHO=false
   GEO_SECRET_KEY=<secret-manager-or-strong-secret>
   CORS_ORIGINS=https://geo-attendance-system-db9ca.web.app,https://geo-attendance-system-db9ca.firebaseapp.com
   ```

## Migration

1. Take an on-demand backup before migrating any real data.
2. For local validation, start Cloud SQL Auth Proxy:

   ```powershell
   cloud-sql-proxy.exe --gcloud-auth --address 127.0.0.1 --port 55433 geo-attendance-system-db9ca:australia-southeast1:geo-attendance-system
   ```

3. Run migrations against staging:

   ```powershell
   cd backend
   $env:DATABASE_URL="postgresql+psycopg://USER:PASSWORD@127.0.0.1:55433/geo_management_staging"
   python -m app.migrations
   ```

4. Run the backend smoke test against staging:

   ```powershell
   $env:DATABASE_URL="postgresql+psycopg://USER:PASSWORD@127.0.0.1:55433/geo_management_staging"
   # In a second terminal, start the backend.
   python backend\smoke_test.py
   ```

5. Run the real-phone checklist after staging passes:

   ```text
   docs/mobile-browser-workflow-checks.md
   ```

6. Repeat the same backup, migration, deploy, and verification sequence for production.

## Verification

After production deploy:

1. Confirm Cloud Run is Ready.
2. Confirm Firebase Hosting returns the app shell.
3. Confirm the Hosting rewrite reaches the backend:

   ```powershell
   curl.exe https://geo-attendance-system-db9ca.web.app/api/health
   ```

4. For automated smoke testing, run:

   ```powershell
   $env:API_BASE_URL="https://geo-attendance-system-db9ca.web.app/api"
   python backend\smoke_test.py
   ```

5. Login with a controlled production test account, not `/dev/seed`, when doing a manual production pass.
6. Submit one worker attendance record, one task log, and one required-signature work form.
7. Confirm the supervisor Review Queue shows those records.
8. Approve one record, reject one record, and confirm Audit history records the decisions.

## Rollback

- If migration fails before traffic moves: keep the previous Cloud Run revision serving traffic, restore from the pre-migration backup if the DB was partially changed, fix the migration, and retry in staging first.
- If deploy fails after migration: roll traffic back only if the old revision is compatible with the migrated schema.
- If the schema is not backward compatible: restore or clone from the pre-migration backup, point Cloud Run back at the restored database, then roll back the service revision.

Do not manually edit production tables to repair a failed migration unless a fresh backup exists and the manual change is documented.
