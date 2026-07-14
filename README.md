# Leader Field Operations

Mobile-first geo-attendance and field daywork logging MVP for Leader Scaffolding-style operations.

This project lets field workers check in/out from a phone with location data, submit Daywork logs and custom work forms with progress photos, and review their own synced history. Supervisors can manage sites, staff, reusable work forms, attendance review, backend record adjustments with double-check confirmation, audit history, CSV exports, and print-ready HTML exports for logs and submitted forms. The next business-facing direction is a desktop payroll/admin section that helps accounting calculate approved worker hours by pay period.

## Current Version

```text
Frontend: Vite-served PWA-style static app
Backend: FastAPI REST API
Database: SQLite for local development; Neon PostgreSQL for the current live Cloud Run backend
Auth: HttpOnly JWT session cookie for the browser app; bearer token response remains available for scripts/API clients
Uploads: Local backend/uploads folder for development; private Cloud Storage bucket for live Cloud Run
Recommended deployment: Firebase Hosting + Cloud Run + Cloud SQL PostgreSQL + Cloud Storage + Secret Manager
Primary UI files: index.html, assets/css/styles.css, assets/js/app.js
```

The app started as a frontend-only prototype. It now uses FastAPI for authentication, Sites, attendance, Task Logs, weekly Team Work Logs, versioned Work Forms, verified uploads, staff management, durable Supervisor review, exports, audit history, and cross-device history sync.

`src/App.jsx` is not the current production UI path. The active app is `index.html` plus the modules in `assets/js/`.

Documentation map:

- [CONTEXT.md](CONTEXT.md): authoritative product language and module invariants.
- [Mobile and browser workflow checks](docs/mobile-browser-workflow-checks.md): automated, hosted, and real-phone validation checklist.
- [Production database and deployment runbook](docs/production-db-runbook.md): current live topology, migration, release, hardening, and rollback procedure.
- [Payroll admin portal plan](docs/payroll-admin-portal-plan.md): planned Payroll scope; it is separate from implemented Management Analytics.
- [AGENTS.md](AGENTS.md): repository direction and working rules for coding agents.

## Current Reset Status - 2026-07-14

The reset goal is a reliable phone-first PWA with durable, explainable sync and review behaviour. The local gate, real-phone local-network pass, and automated hosted pass are green. A full real-phone pass against the hosted URL and provider hardening are still required before real staff data is trusted to the service.

Completed in this reset:

- `npm run build` produces a `dist/` that serves the service worker, offline page, manifest, and icon assets from the paths used by the app.
- The service worker never returns cached `/api`, `/auth`, `/photo-uploads`, or `/uploads` responses as if they were fresh backend data.
- Workers can complete check-in/out, Daywork logs, and work forms with signatures/photos on a phone, including graceful geolocation-denied and offline/queued states.
- Supervisors can review the resulting attendance, task logs, form submissions, photos, and signatures from the unified Review Queue.
- A browser/mobile validation checklist or automated check covers the main worker and supervisor paths.
- Supervisor changes have an audit-history API and visible dashboard section.
- The full manual phone/browser workflow checklist passed on a real phone on the local network on 2026-06-04.
- Backend schema changes now use versioned migrations recorded in `schema_migrations` instead of inline SQLite startup `ALTER TABLE` checks.
- Cloud Run `geo-backend` currently uses Neon PostgreSQL through Secret Manager-backed `DATABASE_URL` and `GEO_SECRET_KEY`; Cloud SQL remains the recommended Google-native production direction.
- The earlier Cloud SQL validation path passed its hosted smoke test on 2026-06-05 and had backups/PITR enabled. Those historical checks do not establish recovery readiness for the current Neon database.
- Cloud Run revision `geo-backend-00018-jbz` serves 100% of live traffic and stores new photos/signatures in private Cloud Storage bucket `geo-attendance-system-db9ca-uploads`.
- The backend exposes `/health/ready`, renews cookie sessions through `POST /auth/refresh`, and has configurable in-process rate limiting for production-like environments.
- `npm run check:production-hardening` verifies the remaining GCP launch blockers without mutating cloud resources.
- The Daywork team-member picker click target now passes the Playwright mobile/browser workflow check.
- The backend smoke test now checks the current Firebase-compatible `__session` cookie rather than the legacy `geo_access_token` cookie.
- Upload storage now owns raster verification, adapter readiness, authorized streaming, and detached-file cleanup for both local disk and Cloud Storage.
- Offline Submission now owns Worker identity, capture time, stable client idempotency, replay state, and persisted partial uploads; attendance maps capture time to its occurrence timestamp and shared-device account changes cannot reassign queued records.
- Work Form content edits create new definition versions, submissions freeze immutable snapshots, and the backend derives authoritative time ranges and formulas.
- Review Queue policy, cursor queries, offline/read-only fallback, and exports are separate test surfaces. Dashboard totals and Management Analytics load complete durable overview data instead of the current filtered page.
- SQLAlchemy connection checkout uses `pool_pre_ping`, and protected Sites load only after login or session restoration succeeds.
- Local validation on 2026-07-14 passed lint, build, Review Queue, mobile/browser workflow, backend compile, database, security, upload storage, Work Form definition, migration, and full smoke tests.
- The 2026-07-14 hosted deployment passed anonymous, worker, restored-session, repeated `/api/sites`, logout, supervisor Review Queue, readiness, and new-revision error-log checks without a 5xx.

Next step:

Run the real-phone checklist against the live Firebase Hosting / Cloud Run path, close applicable GCP findings, complete a Neon access/backup/restore review, and remove controlled test data.

## Recommended Production Deployment

Use the Google-native deployment path for this project:

```text
PWA frontend: Firebase Hosting serving dist/
API backend: FastAPI container on Cloud Run
Database: Cloud SQL for PostgreSQL
Uploads: private Cloud Storage bucket for photos and signatures
Secrets: Secret Manager
Routing: Firebase Hosting rewrites /api/** and /uploads/** to Cloud Run
```

Keep the browser app same-origin through Firebase Hosting rewrites. This avoids extra CORS, cookie, and CSRF complexity for the PWA while still letting Cloud Run serve the API.

For around 100 users, start with a single-zone Cloud SQL PostgreSQL instance, Cloud Run min instances `0`, and a private Cloud Storage bucket. Turn Cloud Run min instances to `1` only if cold starts are unacceptable. Move Cloud SQL to regional HA only when downtime risk is worth the extra cost.

Estimate the selected Cloud SQL/Cloud Run configuration with the current Google Cloud pricing calculator and set budget alerts before launch; regional HA materially changes the database cost.

Do not store uploaded photos or signatures in Cloud SQL. Store files in Cloud Storage and store only URLs/metadata in PostgreSQL.

## Features

- App UI defaults to English and includes a prominent top-bar language toggle for Simplified Chinese.
- Users belong to one department: Leader, Mutual, MC, Stech, BOP.
- The signed-in header shows the user's group and highlights super-admin access.
- Department supervisors see and manage only their own department data; global admins can manage all departments.
- Global admins can focus the supervisor dashboard on one department or all departments and save either view as their dashboard default. This preference is separate from the account's home department, which continues to control ownership of newly created department records.

### Worker

Worker accounts have two field classes:

- **Normal worker:** check in, check out, and review their attendance history.
- **Leader:** all normal-worker attendance functions plus weekly team logs, Daywork logs, reusable work forms, and missing-site creation.

New self-registered accounts start as normal workers. A supervisor can promote or return a worker between Normal worker and Leader from Staff users without changing the account's department or historical records.

Normal workers receive a simplified attendance screen with only **Check in / out** and **My history** navigation. The attendance card guides them through site, location, and action steps, and prevents submission until the required site and location are ready.

- Sign in with a backend account.
- Register a new staff account for supervisor activation.
- Select a job/site.
- Capture browser geolocation.
- Check in and check out with GPS coordinates, accuracy, site radius result, notes, and optional attendance photo.
- Inside-site attendance is approved automatically; outside-site attendance stays pending for supervisor review.
- Edit or delete own pending outside-site attendance before supervisor approval.
- Leaders submit Daywork logs through the active Daywork log form, including work date, site, dynamic fields, signatures, time ranges, and up to 8 progress photos.
- Leaders complete advanced work forms with conditional fields, calculated formula fields, and repeatable sections for row-based data such as labour, materials, or equipment.
- Work-form time ranges and formulas are previews in the browser; the backend derives and stores the authoritative durations and formula results.
- Leaders add a missing site from the worker dashboard when today's job is not listed yet.
- Leaders choose supervisor-created work forms, such as daywork, inspection, and tool deduction forms.
- Leaders submit work forms for approval with typed fields, handwritten signatures, site/work date, and up to 8 photos.
- View local and backend-synced attendance, Daywork, and form history.
- Search/filter history by text, type, status, and local calendar date.
- Click any uploaded photo thumbnail to open a floating zoom viewer with previous/next controls.
- Save offline drafts and queue offline records for later sync.
- Keep queued records bound to the Worker who captured them, with capture time and stable client submission id retained across retries; delayed attendance also preserves its original occurrence timestamp.

Worker restrictions:

- Normal workers cannot create sites, task logs, weekly team logs, or work-form submissions.
- Workers cannot edit or delete submitted task logs.
- Workers cannot edit or delete attendance after it is approved or rejected.
- Resigned workers cannot sign in.

### Supervisor

- Sign in with a supervisor account.
- View pending, approved, and rejected attendance, Task Logs, weekly Team Work Logs, and Work Form Submissions.
- View worker task logs and attached photo galleries.
- Create, edit, and archive worker-facing work forms.
- Build worker-facing forms with sections, conditional logic, formulas, and repeatable row sections.
- Content edits increment the definition version. Every submission freezes the exact form name, description, fields, and version used for its validation, so later edits do not relabel historical records or exports.
- Preview worker-facing forms from the supervisor Work Forms builder before saving, and from the saved Work Forms list before editing or activating them.
- View worker work-form submissions and attached photo galleries.
- Approve or reject pending outside-site attendance, Task Logs, weekly Team Work Logs, and Work Form Submissions.
- Adjust attendance records with double-check confirmation.
- Add a missed worker check-in or check-out with the original date/time and a required reason. Manual entries are approved, audit-logged, visibly marked, and do not claim a GPS result.
- Submit an approved task log for themselves or another accessible user. Admin-entered logs are visibly marked and audit-logged, with no separate approval step.
- Set a worker's field class to Normal worker or Leader.
- Review and approve weekly team logs containing many member/date/site/time/work rows.
- Move attendance, Task Logs, Work Form Submissions, or weekly Team Work Logs to a Department-scoped rubbish bin after entering a reason and confirming the action. Records can be restored for 30 days before automatic permanent deletion.
- Adjust submitted task logs with double-check confirmation.
- Create and edit sites, including allowed check-in radius.
- Review attendance on a map with site-radius boundaries, inside/outside markers, worker/site/date/status filters, and map-based approve/reject controls.
- View each worker's recorded attendance-point history and connect those events as straight reference lines; the app does not collect continuous background routes.
- View management analytics for record trends, pending/rejected/outside-site and attendance-pairing exceptions, site activity, logged task hours, approval rates, and structured form responses. Open check-ins are only marked as missing after 12 hours.
- Keep dashboard Review totals and Management Analytics independent from the visible Review Queue filters/page; both use the complete authorized durable overview.
- Filter review records, maps, analytics, sites, staff, and work forms by department. Department-scoped supervisors remain fixed to their assigned department.
- Export the selected management period as CSV or a print-ready HTML management report.
- Search sites.
- Create worker/supervisor users in the supervisor's own department, or in any department when signed in as a global admin.
- Edit staff name, email, role, status, department, global-admin access, or reset password with double-check confirmation.
- View and search staff users.
- Mark workers resigned so they cannot sign in.
- Reactivate resigned workers without losing previous records.
- Department supervisors cannot resign or reactivate global-admin accounts; only another global admin can change a global admin account status.
- View recent supervisor audit history for staff, site, work-form, review, attendance, and task-log changes.
- Export attendance records to CSV.
- Export task logs to CSV.
- Export task logs as daily log sheets or photo reports in print-ready HTML.
- Export Daywork logs and submitted work forms as PDF templates with form answers, photos, and signature images.
- Export submitted work forms in print-ready HTML with form answers, photos, and signature images.
- Export a single selected task log or submitted work form from its review card as HTML or a CSV row.

### PWA / Mobile UX

- Vite HTTPS dev server for geolocation-friendly phone testing.
- Same-origin `/api` proxy to avoid iOS mixed-content blocking.
- Visible Download App button with browser install prompt or Add-to-Home-Screen fallback instructions.
- Service worker app shell cache generated from one shared asset manifest with a content-derived cache name.
- Offline page.
- IndexedDB drafts and queued attendance, task-log, and work-form submissions, including photos and handwritten signature data.
- Mobile-first layout with folded supervisor sections.
- Black default theme with a persistent light/dark mode toggle.

## Demo Accounts

For local development only, copy `.env.example` to `.env`, keep `ENABLE_DEV_SEED=true`, start the backend from the backend folder, then seed demo data with `POST http://127.0.0.1:8000/dev/seed`. The endpoint is disabled by default unless explicitly enabled and is blocked in production-like environments.

```text
Worker
Email: worker@example.com
Password: Passw0rd!
Department: Leader

Supervisor
Email: supervisor@example.com
Password: Passw0rd!
Department: Leader
Global admin: no

Super Admin
Email: admin@example.com
Password: Passw0rd!
Department: Leader
Global admin: yes
```

## Project Structure

```text
scaffold-pwa-mvp/
  index.html                  Active frontend shell
  offline.html
  manifest.webmanifest
  sw.js
  vite.config.js
  package.json
  README.md
  .env.example

  docs/
    mobile-browser-workflow-checks.md  Focused manual phone/browser workflow checks
    payroll-admin-portal-plan.md       Planned desktop payroll/admin workflow
    production-db-runbook.md           Managed database migration and rollback runbook

  scripts/
    pwa-shell-assets.mjs              Shared PWA app-shell manifest and cache-name generator
    generate-pwa-service-worker.mjs   Writes generated sw.js from the shared manifest
    sw-runtime.js                     Service-worker runtime logic used by the generator
    check-mobile-browser-workflows.mjs  Dependency-free PWA/mobile preflight check
    check-browser-workflows.mjs         Playwright Chromium worker/supervisor workflow check
    check-production-hardening.ps1      Read-only GCP production hardening gate

  assets/
    css/
      styles.css              Active UI styles
    js/
      app.js                  Active frontend shell and module wiring
      app-shell-state.js      Shared DOM references and app state
      api-client.js           FastAPI client
      db.js                   IndexedDB wrapper
      date-inputs.js          Local date input helpers
      history.js              Worker history and shared record rendering module
      mock-api.js             Offline/local fallback data
      offline-submissions.js  Offline submission queue and sync module
      photo-viewer.js         Photo thumbnail and zoom viewer module
      staff-sites.js          Supervisor staff, site, and form admin module
      supervisor-review.js    Supervisor Review Queue state and interaction module
      supervisor-review-utils.js Complete Review Queue overview and rendering helpers
      review-export-adapters.js Review Record export adapters
      supervisor-map.js       Supervisor map/location review module
      supervisor-analytics.js Management analytics module
      team-member-picker.js   Searchable team member selector for team logs and Daywork rows
      team-work-log.js        Weekly multi-member team log module
      utils.js
      worker-attendance.js    Worker attendance capture module
      worker-form.js          Worker dynamic form submission module
      worker-log.js           Worker Daywork log submission module
      worker-sites.js         Worker missing-site creation module
      work-form-fields.js     Work form field rendering and signature module
    icons/

  backend/
    migrations/
      versions/                Versioned database migrations
    app/
      main.py                 FastAPI routes
      schemas.py              FastAPI request schemas
      models.py               SQLModel tables
      database.py             Engine and migration startup hook
      upload_storage.py       Verified local/GCS storage, readiness, streaming, and cleanup
      migrations.py           Dependency-free versioned migration runner
      rate_limit.py           In-process rate limiter used by production-like deployments
      auth.py                 Password/JWT helpers
      config.py               Environment loading
      use_cases/
        audit.py              Supervisor audit-event helpers
        common.py             Shared serializers, validation, and review helpers
        attendance.py         Worker attendance use cases
        task_logs.py          Worker task-log and template use cases
        team_work_logs.py     Weekly team-log use cases
        work_forms.py         Work-form definition and submission use cases
        review_queue.py       Cursor-paginated Review Record query use case
        review_record_policy.py Review decision and authorization policy
        review_record_adapters.py Review Record serialization adapters
        supervisor_review.py  Compatibility review, edit, and document rendering use cases
        supervisor_review_exports.py Export adapter dispatch and guards
        record_trash.py       Rubbish-bin lifecycle and purge use cases
        staff_site_admin.py   Staff user and site admin use cases
    database_test.py          SQLAlchemy pool health regression script
    migration_test.py         Migration workflow regression script
    review_queue_test.py      Review policy/query/export regression script
    smoke_test.py             Backend smoke/regression script
    security_test.py          Backend security/rate-limit regression script
    upload_storage_test.py    Upload storage regression script
    work_form_definition_test.py Work Form snapshot/formula regression script
    uploads/                  Runtime uploaded files
    geo_management.db         Runtime SQLite DB

  src/
    App.jsx                   Legacy React path, not current active UI
    main.jsx
```

Runtime/generated paths:

```text
backend/geo_management.db
backend/uploads/
backend/app/__pycache__/
dist/
node_modules/
```

## Requirements

- Node.js and npm
- Python 3.11 recommended
- FastAPI backend dependencies from `requirements.txt`
- A phone and development computer on the same Wi-Fi for real mobile testing

## Environment

Copy the sample environment file:

```powershell
copy .env.example .env
```

Important values:

```text
APP_ENV=development
GEO_SECRET_KEY=change-this-dev-secret
DATABASE_URL=sqlite:///./geo_management.db
AUTO_MIGRATE=true
SQL_ECHO=false
ENABLE_DEV_SEED=true
AUTH_COOKIE_SECURE=false
RATE_LIMIT_ENABLED=false
RATE_LIMIT_GENERAL_REQUESTS=300
RATE_LIMIT_GENERAL_WINDOW_SECONDS=60
RATE_LIMIT_AUTH_REQUESTS=30
RATE_LIMIT_AUTH_WINDOW_SECONDS=60
RATE_LIMIT_UPLOAD_REQUESTS=30
RATE_LIMIT_UPLOAD_WINDOW_SECONDS=60
CORS_ORIGINS=http://localhost:5173,https://localhost:5173,http://127.0.0.1:5173,https://127.0.0.1:5173
UPLOAD_DIR=uploads
UPLOAD_STORAGE_BACKEND=local
UPLOAD_BUCKET=
UPLOAD_OBJECT_PREFIX=uploads
MAX_UPLOAD_BYTES=5242880
```

`UPLOAD_STORAGE_BACKEND` is explicit: use `local` only for development and `gcs` for production-like environments. The backend does not silently switch adapters when a bucket happens to be configured.

For phone testing, add your computer IP frontend URL to `CORS_ORIGINS` if you call FastAPI directly:

```text
CORS_ORIGINS=https://localhost:5173,https://127.0.0.1:5173,https://192.168.1.25:5173
```

When using the Vite `/api` proxy, the frontend usually stays same-origin and does not need direct phone-to-FastAPI CORS.

## Backend Setup

From the project root:

```powershell
cd C:\Users\12273\Documents\GitHub\scaffold-pwa-mvp
```

Create and activate a Python environment:

```powershell
conda create -n geo-backend python=3.11
conda activate geo-backend
```

Install dependencies:

```powershell
pip install -r requirements.txt
```

If bcrypt/passlib gives login errors, use the known compatible bcrypt pin:

```powershell
python -m pip uninstall -y bcrypt passlib
python -m pip install "passlib[bcrypt]==1.7.4" "bcrypt==4.0.1"
```

Run database migrations:

```powershell
cd backend
python -m app.migrations
```

The backend also runs pending migrations on startup when `AUTO_MIGRATE=true`, which keeps local development and the current Cloud Run demo path simple. For a managed production database, run migrations as an explicit deployment step before shifting traffic.

Run the backend:

```powershell
cd backend
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Health check:

```text
http://127.0.0.1:8000/health
```

Swagger docs:

```text
http://127.0.0.1:8000/docs
```

Seed demo accounts and demo sites for local development only:

```text
POST /dev/seed
```

This requires `ENABLE_DEV_SEED=true`, must be called from localhost, and is unavailable when `APP_ENV=production` or Cloud Run production metadata is present.

## Frontend Setup

From the project root:

```powershell
npm install
npx playwright install chromium
```

Run on the computer:

```powershell
npm run dev
```

Run for phone testing:

```powershell
npm run dev:phone
```

If the backend is running on a non-default local port, set `VITE_API_PROXY_TARGET` before starting Vite, for example `VITE_API_PROXY_TARGET=http://127.0.0.1:8765 npm run dev:phone` on Bash or `$env:VITE_API_PROXY_TARGET='http://127.0.0.1:8765'; npm run dev:phone` on PowerShell.

For local browser automation that cannot accept the dev HTTPS certificate, set `VITE_DISABLE_HTTPS=true`; keep the default HTTPS server for phone geolocation and PWA testing.

The frontend uses a local HTTPS dev certificate:

```text
https://127.0.0.1:5173
```

The browser may warn about the local certificate. Accept it for local testing so geolocation and PWA behavior work.

## Firebase Deployment Files

This repo includes Firebase Hosting and Cloud Run deployment scaffolding:

```text
.firebaserc              Firebase project id: geo-attendance-system-db9ca
firebase.json            Hosting config for dist/ plus /api and /uploads Cloud Run rewrites
Dockerfile               FastAPI Cloud Run container
.dockerignore            Small Docker build context
.gcloudignore            Small Cloud Run source upload
.env.firebase.example    Cloud Run environment variable template
firestore.rules          Deny-all until the app intentionally uses client Firestore
storage.rules            Deny-all for direct browser Firebase Storage access
```

Recommended deployment order:

1. Create or confirm the Cloud SQL PostgreSQL instance and database.
2. Create a dedicated Cloud Run service account with least-privilege roles.
3. Store `DATABASE_URL`, `GEO_SECRET_KEY`, SMTP credentials, and other secrets in Secret Manager.
4. Configure Cloud Storage uploads, keep the bucket private, and grant the Cloud Run service account object create, read, and delete access for the configured prefix.
5. Deploy the FastAPI backend to Cloud Run and attach Cloud SQL.
6. Run migrations and the mutating backend smoke test against a disposable staging database/service; use controlled non-seeding checks against production.
7. Build and deploy Firebase Hosting.
8. Run `npm.cmd run check:mobile` locally and the manual phone checklist against the hosted URL.

Build and deploy the backend service first:

```powershell
gcloud config set project geo-attendance-system-db9ca
gcloud run deploy geo-backend --source . --region australia-southeast1 --allow-unauthenticated
```

Set Cloud Run environment variables from `.env.firebase.example`. The current live service stores `DATABASE_URL` and `GEO_SECRET_KEY` in Secret Manager, points `DATABASE_URL` at Neon PostgreSQL, and uses Cloud Storage for uploaded photos/signatures.

The Docker container runs `python -m app.migrations` before starting Uvicorn. FastAPI startup also verifies the configured upload adapter's create/read/delete lifecycle, so a revision fails fast when either database migration or upload storage configuration is unusable.

The shared SQLAlchemy engine enables `pool_pre_ping`, so each pooled database connection is checked when Cloud Run reuses it. If managed PostgreSQL or Neon has closed an idle SSL connection, SQLAlchemy discards that connection before the API query instead of returning a transient 500.

Use the production database runbook before changing the live managed-PostgreSQL target, Cloud Run revision, or traffic split:

```text
docs/production-db-runbook.md
```

Then build and deploy Hosting:

```powershell
npm.cmd run build
npx -y firebase-tools@latest deploy --only hosting
```

`firebase.json` rewrites `/api/**` and `/uploads/**` to the `geo-backend` Cloud Run service. FastAPI strips the `/api` prefix at runtime so existing routes like `/auth/login`, `/attendance`, and `/supervisor/audit-events` continue to work behind Firebase Hosting. Uploaded files keep stable `/uploads/...` URLs; the backend authorizes the metadata before streaming private content from the selected adapter.

Firebase Hosting only forwards the special `__session` cookie to rewritten Cloud Run backends. Keep the HttpOnly auth cookie named `__session`; the readable CSRF cookie is only used by the browser to send the `X-CSRF-Token` header.

Production hardening checks are read-only and can be run from a machine authenticated with `gcloud`:

```powershell
npm run check:production-hardening
```

To include budget-alert verification, pass the billing account directly to the script:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\check-production-hardening.ps1 -BillingAccount 000000-000000-000000
```

This check covers GCP state: Cloud Run identity/roles, the known Cloud SQL resource, upload-bucket IAM, monitoring, migration-user state, and optional budgets. The current live database is Neon, so its roles, connection/pooling limits, backups/PITR, and restore drill must be verified separately.

## Phone Testing

Run two terminals.

Terminal 1:

```powershell
cd C:\Users\12273\Documents\GitHub\scaffold-pwa-mvp\backend
conda activate geo-backend
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Terminal 2:

```powershell
cd C:\Users\12273\Documents\GitHub\scaffold-pwa-mvp
npm run dev:phone
```

Find your computer IP:

```powershell
ipconfig
```

Open this on the phone:

```text
https://YOUR_COMPUTER_IP:5173
```

Example:

```text
https://192.168.1.25:5173
```

Phone checklist:

- Phone and computer are on the same Wi-Fi.
- Backend is running with `--host 0.0.0.0`.
- Frontend is running with `npm run dev:phone`.
- Windows Firewall allows Node.js and Python.
- Open the computer IP address, not `localhost`.
- Accept the local HTTPS certificate warning.

Use the focused workflow checklist for the full worker, supervisor, offline, and update-flow pass:

```text
docs/mobile-browser-workflow-checks.md
```

## Key Workflows

### Worker Attendance

1. Sign in as a worker.
2. Select a site.
3. Capture location.
4. Check the live site-radius preview before submitting.
5. Add optional notes/photo.
6. Check in or check out.
7. History shows the backend-synced record and whether it was inside the site radius.
8. Inside-site attendance is approved automatically.
9. Outside-site attendance stays pending and can be edited or deleted until supervisor approval/rejection.

### Worker Daywork Log

1. Open the Log tab or the Daywork log quick action.
2. Select a site.
3. Set the work date.
4. Fill in the active Daywork log form fields.
5. Complete any required signature or time-range fields.
6. Select one or more progress photos from the phone photo picker.
7. Submit the Daywork log.
8. Daywork logs are saved as pending form submissions for supervisor approval.
9. Photos can be opened in the floating photo viewer with their recorded taken time when available.

### Worker Missing Site

1. Open **Add missing site** on the worker dashboard.
2. Enter the site name and optional address.
3. Use current location or enter latitude/longitude manually.
4. Keep or adjust the allowed radius.
5. Add the site.
6. The new site is added to check-in, Daywork log, and work-form selectors.

### Legacy Task Logs

The backend task-log and task-template routes remain available for older records and integrations. New worker-facing daywork records should use the Daywork log form.

Legacy task logs store:

```text
site
work date
hours
task summary
safety notes
photos
```

### Worker Work Forms

1. Open the Form tab or the work-form quick action.
2. Choose a work form.
3. Select a site and work date.
4. Fill in the form fields.
5. Select optional photos from the phone photo picker.
6. Submit the form.
7. The submission is saved as pending approval and appears in worker history and supervisor review.

Built-in seeded examples:

```text
Daywork log form
Inspection form
Tool deduction form
```

### Leader Weekly Team Log

1. A supervisor sets the staff account's Worker class to **Leader**.
2. The leader opens the Team tab and selects the Monday starting the work week.
3. Search and select one or more members in each row. The selected members share that row's date, site, start, finish, break minutes, and completed-work description.
4. Add another row whenever the selected group changes site, shift, or activity. Members are not permanently assigned to one leader and may appear in different Leaders' logs.
5. Submit the weekly log. The backend calculates row hours, supports overnight work periods, totals the log, and places it in the supervisor Review Queue.
6. A supervisor approves or rejects the team log like other review records.

Each weekly log accepts up to 150 work rows. The week must start on Monday and each row date must be inside that seven-day period.

### Supervisor Form Builder

1. Sign in as supervisor.
2. Open the Work forms section.
3. Enter the form name and optional description.
4. Add one field per line in this format:

```text
type|Label|required|options-or-formula|rules
```

Examples:

```text
text|Work area|required
section|Pre-start checks
time_range|Work time|required
select|Result|required|Pass,Fail,N/A
textarea|Fail notes|required||show_if=result=Fail
checkbox|Follow up required
number|Quantity|required
date|Inspection date
formula|Worker hours||work_time * workers
repeat|Materials|||min=0|max=12
>text|Material|required
>number|Quantity|required
signature|Worker signature|required
```

Supported field types are `section`, `repeat`, `text`, `textarea`, `number`, `date`, `time_range`, `select`, `checkbox`, `formula`, and `signature`. Prefix repeat children with `>`. Later columns may contain `show_if=result=Fail`, `min=1`, or `max=12`. A required signature uses a touch-friendly pad and uploads a PNG. The browser previews formulas, but the backend revalidates source answers and stores authoritative time-range durations and formula results. Content edits increment the Definition version; every submission retains an immutable Definition snapshot, so archive/reactivate or later edits cannot relabel history.

### Supervisor Review

1. Sign in as supervisor.
2. On desktop, use the sticky Admin workspace navigation to jump between review, reporting, record-entry, and management sections. Selecting a folded section opens it automatically.
3. Use the Review Queue as the durable feed for outside-site attendance, Task Logs, weekly Team Work Logs, and Work Form Submissions. Pending is the decision workload; approved and rejected history remain queryable.
4. Filter by worker/site text, record type, status, or date.
5. Check worker, site, timestamp, location/site radius where applicable, notes, photos, and signatures.
6. If a worker forgot to check in or out but performed the work, open Add missed check in / check out, choose the worker/site/type/original time, enter the reason, and confirm the manual entry.
7. Open Submit approved log to enter a task log for yourself or another accessible user. Confirm it appears immediately as approved.
8. Use Move to bin on an incorrect attendance, Task Log, Work Form Submission, or weekly Team Work Log, enter the reason, and complete the double-check confirmation.
9. Open Rubbish bin to restore a record within 30 days. Expired records are permanently removed automatically.
10. Approve or reject pending review records.
11. Open Maps and location review, inspect site boundaries and outside-site points, and filter recorded location history by worker, site, status, or date.
12. Optionally connect recorded points to compare event order. These straight lines are not continuous travel tracking or road routes.
13. Open Management analytics and review trends, exceptions, site productivity, and form-response summaries for 7, 30, 90, or all available days. Confirm recent open check-ins are not marked missing until they are at least 12 hours old.
14. Export the management summary as CSV or print-ready HTML. Logged task hours remain separate from payroll-approved hours.
15. After filtering or paging Review Queue, confirm dashboard totals and Management Analytics still reflect the complete authorized data set.
16. Use edit controls only after double-check confirmation.
17. Open Audit history and confirm recent review/edit/admin changes appear.
18. Export attendance CSV, task logs, daily sheets, photo reports, or submitted work-form sheets when needed.

### Planned Payroll Admin Portal

Payroll/accounting should use a separate desktop-first section inside the supervisor/admin dashboard, not the worker phone flow. The first version should summarise approved attendance by pay period, group hours by worker, flag exceptions such as missing check-outs or duplicate records, and export an Excel-friendly payroll CSV.

Keep these workflows separate:

```text
Supervisor Review: validate field records.
Payroll Admin: calculate/export payable hours.
```

The detailed plan is in:

```text
docs/payroll-admin-portal-plan.md
```

## API Summary

### General

```text
GET  /health
GET  /health/ready  checks the database and selected upload adapter
POST /dev/seed       local development only, disabled unless ENABLE_DEV_SEED=true
GET  /sites          authenticated
POST /sites          authenticated; workers and supervisors can add a missing site
POST /photo-uploads  authenticated; verifies and re-encodes single-frame JPEG, PNG, or WebP
GET  /uploads/{file} authenticated; workers can access owned/referenced files, supervisors are department-scoped unless global admin
```

### Auth

```text
POST /auth/login
POST /auth/registration/start
POST /auth/registration/verify
POST /auth/register
POST /auth/logout
POST /auth/refresh
GET  /auth/me
GET  /departments
```

`GET /departments` returns the fixed active department list: Leader, Mutual, MC, Stech, BOP.
`POST /auth/refresh` renews the HttpOnly `__session` cookie and readable CSRF cookie for an authenticated browser session.

Worker self-registration is a three-step flow:

1. `POST /auth/registration/start` sends a six-digit email verification code.
2. `POST /auth/registration/verify` verifies that code and returns a short-lived registration token plus the active department choices.
3. `POST /auth/register` accepts the registration token, password, and selected `department_id`, then creates the worker with `resigned` status.
4. A supervisor reviews and reactivates the worker before the worker can sign in.

Verification codes expire, are attempt-limited, and cannot be reused. In local development, `REGISTRATION_EXPOSE_CODE=true` returns `dev_verification_code` so the flow can be tested without SMTP. Production never exposes the code and requires `SMTP_HOST` and `SMTP_FROM_EMAIL`.

### Worker Attendance

```text
POST   /attendance
GET    /my-records
PATCH  /my-records/{record_id}
DELETE /my-records/{record_id}
```

Rules:

- `PATCH /my-records/{record_id}` and `DELETE /my-records/{record_id}` only work for the owning worker.
- Worker edits/deletes only work while attendance status is `pending`.
- Attendance submitted inside the selected site radius is created as `approved`; attendance outside the radius remains `pending`.
- Offline attendance supplies `worker_id`, timezone-aware `occurred_at`, and `client_submission_id` together. The backend requires the Worker to match the authenticated account and stores `occurred_at` as the attendance timestamp.
- Matching attendance payloads submitted within 10 seconds are treated as an accidental repeat and return the original record.
- Approved/rejected attendance is locked for workers.

### Worker Task Logs

```text
POST   /task-logs
GET    /my-task-logs
PATCH  /my-task-logs/{log_id}
DELETE /my-task-logs/{log_id}
```

Rules:

- Leaders can create and view their task logs. Normal workers are attendance-only.
- Task logs are created as `pending` for supervisor approval.
- Worker update/delete endpoints intentionally return `403` for submitted logs.
- Task logs support `photo_urls` with up to 8 uploaded image URLs.
- `client_submission_id` is stable across replay and unique for that Worker, so retry returns the existing Task Log.
- Matching task-log payloads submitted within 10 seconds return the original record.
- `photo_url` remains for compatibility and points to the first task photo when present.

### Supervisor Rubbish Bin

```text
GET  /supervisor/trash
POST /supervisor/trash/{record_type}/{record_id}
POST /supervisor/trash/{record_type}/{record_id}/restore
```

Attendance, Task Logs, Work Form Submissions, and weekly Team Work Logs require a deletion reason and confirmation before entering the rubbish bin. Deleted records are hidden from Worker history, Review Queue, maps, analytics, and exports. They remain restorable for 30 days; startup/hourly cleanup then permanently removes them and cleans up any newly unreferenced uploads.

### Worker Task Templates

```text
GET    /task-templates
POST   /task-templates
PATCH  /task-templates/{template_id}
DELETE /task-templates/{template_id}
```

### Worker Work Forms

```text
GET  /work-forms
POST /form-submissions
GET  /my-form-submissions
```

Rules:

- Leaders only see active work forms. Normal workers receive an empty form list and cannot submit forms.
- Form submissions support typed answers and up to 8 uploaded image URLs.
- `client_submission_id` is stable across replay and unique for that Worker; the submission also stores the immutable Definition version/snapshot used for server validation and derivation.
- Submitted forms start as `pending` and are visible in worker history and supervisor review.

### Leader Team Work Logs

```text
GET  /team-work-log-members
POST /team-work-logs
GET  /my-team-work-logs
```

Team members are selected through a searchable multi-member checklist containing active Workers in the Leader's Department. One visible row expands into an audited entry for each selected member, so hours remain attributable per Worker. Membership is chosen per row, allowing a Worker to work with different Leaders without changing account ownership.

The module supplies a stable `client_submission_id` for replay. The backend validates Department/member/Site access, calculates row durations including overnight work, and stores one pending weekly log with attributable entries.

### Supervisor

```text
GET   /supervisor/users
POST  /supervisor/users
PATCH /supervisor/users/{user_id}
POST  /supervisor/users/{user_id}/status
GET   /supervisor/audit-events

POST  /supervisor/sites
PATCH /supervisor/sites/{site_id}

GET   /supervisor/review-queue?status=&record_type=&search=&start_date=&end_date=&page_size=&cursor=
GET   /supervisor/review-records
GET   /supervisor/review-records?status=pending
POST  /supervisor/review-records/{kind}/{record_id}/decision

GET   /supervisor/pending-records
GET   /supervisor/records
GET   /supervisor/records?status=approved
GET   /supervisor/records?status=rejected
GET   /supervisor/records/export.csv
PATCH /supervisor/records/{record_id}
POST  /supervisor/records/{record_id}/decision

GET   /supervisor/task-logs
POST  /supervisor/task-logs
GET   /supervisor/team-work-logs
PATCH /supervisor/team-work-logs/{log_id}
GET   /supervisor/task-logs?status=pending
GET   /supervisor/task-logs/export.csv
GET   /supervisor/task-logs/export.html?layout=daily-log
GET   /supervisor/task-logs/export.html?layout=photo-report
GET   /supervisor/task-logs/{log_id}/export.csv
GET   /supervisor/task-logs/{log_id}/export.html?layout=daily-log
GET   /supervisor/task-logs/{log_id}/export.html?layout=photo-report
PATCH /supervisor/task-logs/{log_id}

GET   /supervisor/form-submissions
POST  /supervisor/form-submissions
GET   /supervisor/form-submissions?status=pending
GET   /supervisor/form-submissions/export.csv
GET   /supervisor/form-submissions/export.html
GET   /supervisor/form-submissions/export.pdf?template=submitted-form
GET   /supervisor/form-submissions/export.pdf?template=daywork
GET   /supervisor/form-submissions/{submission_id}/export.csv
GET   /supervisor/form-submissions/{submission_id}/export.html
GET   /supervisor/form-submissions/{submission_id}/export.pdf?template=submitted-form
GET   /supervisor/form-submissions/{submission_id}/export.pdf?template=daywork
POST  /supervisor/work-forms
PATCH /supervisor/work-forms/{form_id}
```

`/supervisor/review-queue` is the preferred cursor-paginated query endpoint. It returns matching-filter `counts`, filter-independent authorized `summary_counts`, a stable snapshot timestamp, and an opaque continuation cursor. The visible page uses the matching records; dashboard totals use `summary_counts`; Management Analytics walks the complete unfiltered snapshot. `/supervisor/review-records` remains the compatibility feed and decision path. `/supervisor/audit-events` returns recent change events with actor, access level, action, target, summary, and before/after snapshots. HTML exports are standalone print/save-as-PDF files; PDF exports are generated server-side for submitted Work Forms and Daywork submissions.

`POST /supervisor/task-logs` accepts a selected user, site, work date, task summary, optional hours, and optional safety notes. The selected user may be the signed-in supervisor or another department-accessible user. These records are created as `approved`, marked `supervisor_manual`, and do not require a review decision.

Supervisor edit/archive routes require `confirmed: true` in the request body.

## Example Requests

### Login

```json
{
  "email": "worker@example.com",
  "password": "Passw0rd!"
}
```

### Attendance

The active Offline Submission interface derives `worker_id`, `occurred_at`, and `client_submission_id` from the authenticated Worker and captured record rather than asking the attendance UI to coordinate them separately:

```json
{
  "worker_id": 1,
  "record_type": "check_in",
  "occurred_at": "2026-05-25T07:28:14+12:00",
  "client_submission_id": "attendance-1-20260525T072814",
  "latitude": -36.8485,
  "longitude": 174.7633,
  "accuracy": 12,
  "site_id": 1,
  "note": "Arrived on site",
  "photo_url": null
}
```

### Task Log With Multiple Photos

```json
{
  "client_submission_id": "task-1-20260525-001",
  "description": "Installed scaffold bay and checked tags.",
  "site_id": 1,
  "work_date": "2026-05-25",
  "hours_worked": 7.5,
  "safety_notes": "Exclusion zone kept clear.",
  "photo_urls": [
    "/uploads/task-photo-1.jpg",
    "/uploads/task-photo-2.jpg"
  ]
}
```

### Work Form Submission

Only source answers need to be sent. Omit formula outputs and `duration_hours`; the backend derives them from the saved definition and time-range start/end values. Submission responses include the authoritative answers plus `definition_version`, `definition_schema_version`, and the frozen `fields` snapshot.

```json
{
  "client_submission_id": "form-1-20260525-001",
  "form_id": 1,
  "site_id": 1,
  "work_date": "2026-05-25",
  "answers": {
    "inspection_area": "North bay",
    "inspection_result": "Pass",
    "issues_found": "",
    "follow_up_required": false,
    "worker_signature": "/uploads/signature-demo-worker.png"
  },
  "photo_urls": [
    "/uploads/form-photo-1.jpg"
  ]
}
```

### Supervisor Work Form

```json
{
  "name": "Site inspection",
  "description": "Daily scaffold inspection checklist",
  "fields": [
    { "id": "area", "label": "Area", "type": "text", "required": true },
    { "id": "result", "label": "Result", "type": "select", "required": true, "options": ["Pass", "Fail"] },
    { "id": "hours", "label": "Hours", "type": "number", "required": true },
    { "id": "workers", "label": "Workers", "type": "number", "required": true },
    { "id": "total_worker_hours", "label": "Total worker hours", "type": "formula", "formula": "hours * workers" },
    { "id": "fail_notes", "label": "Fail notes", "type": "textarea", "required": true, "show_if": "result=Fail" },
    { "id": "materials", "label": "Materials", "type": "repeat", "min_rows": 0, "max_rows": 12 },
    { "id": "material", "label": "Material", "type": "text", "required": true, "repeat": "materials" },
    { "id": "quantity", "label": "Quantity", "type": "number", "required": true, "repeat": "materials" },
    { "id": "worker_signature", "label": "Worker signature", "type": "signature", "required": true }
  ]
}
```

### Supervisor Attendance Edit

```json
{
  "note": "Corrected after review",
  "status": "approved",
  "confirmed": true
}
```

### User Resign / Reactivate

```json
{
  "status": "resigned",
  "confirmed": true
}
```

```json
{
  "status": "active",
  "confirmed": true
}
```

## Validation

With backend running:

```powershell
python backend\smoke_test.py
```

Frontend checks:

```powershell
npm.cmd run lint
npm.cmd run build
npm.cmd run check:review-queue
npm.cmd run check:mobile
```

Production hardening gate:

```powershell
npm.cmd run check:production-hardening
```

This command is read-only and requires authenticated `gcloud` access. It reports Cloud Run, the known Cloud SQL resource, IAM, storage, monitoring, migration-user, and optional budget state. It does not validate current-live Neon recovery, roles, or pooling configuration.


`npm.cmd run check:review-queue` verifies Review Record export dispatch, durable-only export guards, cursor pagination, query filters and snapshots, department scope, atomic pending-only decisions, audit comments, and decision-bypass protection.

`npm.cmd run check:mobile` runs the static PWA/mobile preflight and then a Playwright Chromium workflow check for login, geolocation allow/deny, service-worker update prompt, IndexedDB offline queue replay, and supervisor review. Login coverage verifies that an anonymous startup neither requests authenticated sites nor exposes demo site options, and that a saved session refreshes before sites are loaded. Its Review Queue scenario verifies that a disconnected supervisor sees only the last durable records in explicit read-only mode; device-local Worker records never become reviewable. The browser check starts its own temporary backend and Vite server on `127.0.0.1:8765` and `127.0.0.1:5175`, with a throwaway SQLite database and upload folder. Override those ports with `BROWSER_WORKFLOW_BACKEND_PORT` or `BROWSER_WORKFLOW_FRONTEND_PORT` if needed.

`backend/database_test.py` poisons a returned pooled connection and proves the next query succeeds through `pool_pre_ping`. `backend/upload_storage_test.py`, `backend/work_form_definition_test.py`, and `backend/review_queue_test.py` are the focused local/GCS storage-contract, immutable Definition/server-formula, and Review Queue policy/query/export test surfaces.

PWA shell assets are maintained in `scripts/pwa-shell-assets.mjs`. `sw.js` is generated by `npm.cmd run generate:pwa`, and `npm.cmd run build`, `npm.cmd run dev`, `npm.cmd run dev:phone`, and `npm.cmd run check:mobile` run that generator before using the service worker. The service-worker cache name is derived from the app-shell file contents, so changing a listed shell asset automatically creates a new cache name.

Backend import check:

```powershell
python -m compileall backend\app backend\smoke_test.py backend\database_test.py backend\migration_test.py backend\review_queue_test.py backend\work_form_definition_test.py backend\upload_storage_test.py backend\security_test.py
python backend\database_test.py
python backend\security_test.py
python backend\upload_storage_test.py
python backend\review_queue_test.py
python backend\work_form_definition_test.py
python backend\migration_test.py
```

The smoke test covers:

- Health and seed data.
- Readiness health checks.
- Worker/supervisor login.
- Cookie session CSRF protection and session refresh.
- Fixed department list, one-department user assignment, department-scoped staff lists, and global-admin-only cross-department access.
- Resigned worker cannot login.
- Reactivation keeps the user usable.
- Staff user editing and self-demotion protections.
- Site create/update.
- Work form create/list/archive.
- Work form submission, immutable historical definition snapshots, and server-derived formulas/time ranges.
- Stable offline ownership/capture/idempotency behaviour, including delayed attendance occurrence time, through the browser workflow and backend client-submission constraints.
- Task template create/list/update/delete.
- Attendance create/update/delete while pending.
- Attendance lock after approval.
- Site distance/radius calculation.
- Task log create with multiple photos.
- Worker cannot update/delete submitted task logs.
- Worker/supervisor role boundaries.
- Cross-worker ownership boundaries.
- Validation failures.
- Rejected attendance, task-log, and work-form review records.
- Worker lockout after attendance approval/rejection.
- Supervisor task-log adjustment.
- Supervisor audit-history access, filtering, and expected event types.
- CSV export.
- Task-log CSV export.
- Bulk and single-record task-log/work-form HTML exports.
- Bulk and single-record Daywork/work-form PDF exports.
- Single-record task-log/work-form CSV exports.
- Complete Review Queue overview counts remain separate from visible page filters and pagination.

The mobile/browser workflow check covers:

- Production PWA app-shell files and stable manifest/icon paths.
- Generated PWA app-shell manifest, copied build assets, and service-worker cache name stay in sync.
- Service worker network-only API/upload rules.
- Visible service worker update-flow wiring.
- Mobile viewport, camera/photo inputs, and active worker/supervisor UI controls.
- Supervisor audit-history UI/API wiring.
- Offline form submission support for photos and handwritten signatures.

Manual phone/browser checks are listed in `docs/mobile-browser-workflow-checks.md`.

## Offline Behavior

The frontend uses IndexedDB for drafts and queued Offline Submissions. The module owns the submit/sync path for attendance, Task Logs, and Work Forms, including the capturing Worker, capture time, stable client submission id, photo/signature uploads, replay state, and authentication-blocked state. Attendance maps capture time to `occurred_at`; callers do not supply these invariants independently.

```text
Online:
  Save the submission locally, upload photos/signatures, and send attendance, task logs, or work forms to FastAPI.

Offline:
  Save the submission locally with syncStatus=queued.

Back online:
  Flush queued submissions to FastAPI and update the local history record.
```

Work Form signatures are stored locally as image data while queued, then uploaded as PNG during sync. A queued record remains bound to the Worker account that captured it; switching accounts on a shared device cannot replay it as the new Worker. Capture time and client submission id survive delayed sync, and attendance sends its timezone-aware `occurred_at` so its durable timestamp is not replaced by reconnect time. The backend can return the existing record on retry. Partial upload URLs are persisted as each upload succeeds. If the session expires, sync pauses in an explicit blocked state and the record remains queued until its owning Worker signs in again.

Current offline behavior is suitable for MVP testing, but production conflict handling still needs more work.

## Date Filtering

History date filters use the user's local calendar date. For example, in New Zealand time, searching `2026-05-20` returns records shown on 20 May 2026 locally, not a UTC noon-to-noon window.

## Photo Behavior

- Attendance supports one optional photo.
- Task logs and work forms support up to 8 progress photos.
- Uploads are identified by decoded raster content, not by the caller's filename or MIME type. Accepted inputs are single-frame JPEG, PNG, and WebP, which are re-encoded before storage to remove metadata and trailing payloads.
- Uploaded photos are served from `/uploads/...`.
- The backend checks ownership/record references before opening a local file or Cloud Storage stream and sends `X-Content-Type-Options: nosniff`.
- Thumbnails open in a floating photo viewer.
- Multi-photo task logs support previous/next navigation in the viewer.
- Local development stores uploads under `backend/uploads/`.
- Live Cloud Run stores new uploads in private Cloud Storage bucket `geo-attendance-system-db9ca-uploads` and serves them back through the backend.
- Files detached by record edits or hard deletion are deleted once no attendance, task-log, or work-form submission references remain. Files in the rubbish bin remain available until the 30-day record purge.

## Common Problems

### `vite` is not recognized

```powershell
npm install
npm run dev:phone
```

### Backend uses the wrong Python

```powershell
where python
python --version
python -m pip -V
```

Activate the environment:

```powershell
conda activate geo-backend
```

### bcrypt / passlib login error

If password verification fails with bcrypt/passlib errors:

```powershell
python -m pip uninstall -y bcrypt passlib
python -m pip install "passlib[bcrypt]==1.7.4" "bcrypt==4.0.1"
```

Restart the backend after changing packages.

### iPhone cannot login or call backend

Use the HTTPS Vite URL and same-origin proxy:

```text
https://YOUR_COMPUTER_IP:5173
```

Do not hardcode the phone frontend to:

```text
http://127.0.0.1:8000
```

On a phone, `127.0.0.1` means the phone itself, not your computer. The current frontend chooses `/api` on HTTPS so Vite can proxy requests to FastAPI.

### Phone cannot open the app

Check:

- Same Wi-Fi.
- Correct computer IP.
- `npm run dev:phone` is running.
- Backend uses `--host 0.0.0.0`.
- Firewall allows Node.js and Python.
- Local certificate warning has been accepted.

## Production Gaps

Before real staff use, close or explicitly accept these remaining items:

- Complete the full real-phone hosted checklist, including actual photo/signature streaming and the waiting-service-worker update flow. The automated hosted pass is green but does not replace this device pass.
- Use a dedicated least-privilege Cloud Run service account instead of the broad default compute service account.
- Review and rotate any remaining production credentials in Secret Manager.
- For current-live Neon, verify least-privilege roles, connection/pooling limits, backups/PITR, monitoring, and a restore/branch drill.
- Decide whether to migrate to the recommended Cloud SQL target or retire the legacy Cloud SQL resources. If migrating, settle HA and private-IP/VPC design before cutover.
- Decide whether the built-in cookie refresh endpoint and session lifetime are enough, or whether the business needs shorter idle timeouts/revocation tracking.
- Built-in in-process rate limiting is available; add Cloud Armor or another edge/distributed limiter if abuse protection must work consistently across many Cloud Run instances.
- Richer audit-history filtering/export and a dedicated audit detail view.
- Documented database backup and restore drill for the provider actually serving live traffic.
- Budget alerts based on the selected current provider and GCP resource configuration.
- More automated frontend and backend tests.
- Better offline conflict resolution.
- Production monitoring alert policies, uptime checks against `/api/health/ready`, and error logging review.

## Roadmap

Current next work:

- Run the real-phone checklist against the live Firebase Hosting / Cloud Run / Neon / Cloud Storage path.
- Clean up controlled hosted-test data and remove or formalize unused database users.
- Close applicable GCP hardening findings and the separate Neon recovery/access checklist.
- Expand automated frontend coverage beyond static workflow checks.
- Add a desktop-first payroll/admin portal section for pay-period worker hour summaries and payroll CSV export.

Useful later features:

- Payroll rule hardening for overtime, allowances, deductions, public holidays, and wage-rate calculations.
- Shift/schedule module.
- Leave requests.
- Photo requirement rules per site/job.
- Native Excel export for payroll/admin reports.
- Bulk staff import.
- Production deployment scripts.

## License

This project is currently an MVP/prototype. Add a license before public or production use.
