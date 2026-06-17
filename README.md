# Leader Field Operations

Mobile-first geo-attendance and field daywork logging MVP for Leader Scaffolding-style operations.

This project lets field workers check in/out from a phone with location data, submit Daywork logs and custom work forms with progress photos, and review their own synced history. Supervisors can manage sites, staff, reusable work forms, attendance review, backend record adjustments with double-check confirmation, audit history, CSV exports, and print-ready HTML exports for logs and submitted forms. The next business-facing direction is a desktop payroll/admin section that helps accounting calculate approved worker hours by pay period.

## Current Version

```text
Frontend: Vite-served PWA-style static app
Backend: FastAPI REST API
Database: SQLite for local development; Cloud SQL PostgreSQL for the live Cloud Run test backend
Auth: JWT bearer tokens
Uploads: Local backend/uploads folder for development; private Cloud Storage bucket for live Cloud Run
Primary UI files: index.html, assets/css/styles.css, assets/js/app.js
```

The app started as a frontend-only prototype. It now uses the FastAPI backend for login, sites, attendance, task logs, task templates, dynamic work forms, photo uploads, staff users, supervisor review, and cross-device history sync.

`src/App.jsx` is not the current production UI path. The active app is `index.html` plus the modules in `assets/js/`.

## Current Reset Status - 2026-06-05

The reset goal is still a reliable local MVP that can be installed and tested from a phone without stale data or broken offline behavior. The build, cache, update-flow, offline-sync, audit-history, real-device workflow pass, and versioned database migration workflow are now in place, so the project can move from PWA validation into deployment hardening before more business features are added.

Completed in this reset:

- `npm run build` produces a `dist/` that serves the service worker, offline page, manifest, and icon assets from the paths used by the app.
- The service worker never returns cached `/api`, `/auth`, `/photo-uploads`, or `/uploads` responses as if they were fresh backend data.
- Workers can complete check-in/out, Daywork logs, and work forms with signatures/photos on a phone, including graceful geolocation-denied and offline/queued states.
- Supervisors can review the resulting attendance, task logs, form submissions, photos, and signatures from the unified Review Queue.
- A browser/mobile validation checklist or automated check covers the main worker and supervisor paths.
- Supervisor changes have an audit-history API and visible dashboard section.
- The full manual phone/browser workflow checklist passed on a real phone on the local network on 2026-06-04.
- Backend schema changes now use versioned migrations recorded in `schema_migrations` instead of inline SQLite startup `ALTER TABLE` checks.
- Cloud Run `geo-backend` now uses Cloud SQL PostgreSQL through Secret Manager-backed `DATABASE_URL` and `GEO_SECRET_KEY`.
- The live backend smoke test passed through Firebase Hosting `/api` on 2026-06-05.
- Cloud SQL backups and PITR are enabled, and an on-demand backup was created after enabling PITR.
- Cloud Run revision `geo-backend-00007-5fc` stores new photos/signatures in private Cloud Storage bucket `geo-attendance-system-db9ca-uploads`.

Next step:

Run the real-phone checklist against the live Firebase Hosting / Cloud Run path, then clean up test data and finish the remaining production hardening items.

## Features

### Worker

- Sign in with a backend account.
- Register a new staff account.
- Select a job/site.
- Capture browser geolocation.
- Check in and check out with GPS coordinates, accuracy, site radius result, notes, and optional attendance photo.
- Inside-site attendance is approved automatically; outside-site attendance stays pending for supervisor review.
- Edit or delete own pending outside-site attendance before supervisor approval.
- Submit Daywork logs through the active Daywork log form, including work date, site, dynamic fields, signatures, time ranges, and up to 8 progress photos.
- Complete advanced work forms with conditional fields, calculated formula fields, and repeatable sections for row-based data such as labour, materials, or equipment.
- Add a missing site from the worker dashboard when today's job is not listed yet.
- Choose supervisor-created work forms, such as daywork, inspection, and tool deduction forms.
- Submit work forms for approval with typed fields, handwritten signatures, site/work date, and up to 8 photos.
- View local and backend-synced attendance, Daywork, and form history.
- Search/filter history by text, type, status, and local calendar date.
- Click any uploaded photo thumbnail to open a floating zoom viewer with previous/next controls.
- Save offline drafts and queue offline records for later sync.

Worker restrictions:

- Workers cannot edit or delete submitted task logs.
- Workers cannot edit or delete attendance after it is approved or rejected.
- Resigned workers cannot sign in.

### Supervisor

- Sign in with a supervisor account.
- View pending, approved, and rejected attendance, task logs, and form submissions.
- View worker task logs and attached photo galleries.
- Create, edit, and archive worker-facing work forms.
- Build worker-facing forms with sections, conditional logic, formulas, and repeatable row sections.
- Preview worker-facing forms from the supervisor Work Forms builder before saving, and from the saved Work Forms list before editing or activating them.
- View worker work-form submissions and attached photo galleries.
- Approve or reject pending outside-site attendance, task logs, and form submissions.
- Adjust attendance records with double-check confirmation.
- Adjust submitted task logs with double-check confirmation.
- Create and edit sites, including allowed check-in radius.
- Search sites.
- Create worker/supervisor users.
- Edit staff name, email, role, status, or reset password with double-check confirmation.
- View and search staff users.
- Mark workers resigned so they cannot sign in.
- Reactivate resigned workers without losing previous records.
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
- Service worker app shell cache.
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

Supervisor
Email: supervisor@example.com
Password: Passw0rd!
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
    check-mobile-browser-workflows.mjs  Dependency-free PWA/mobile preflight check

  assets/
    css/
      styles.css              Active UI styles
    js/
      app.js                  Active frontend shell and module wiring
      api-client.js           FastAPI client
      db.js                   IndexedDB wrapper
      history.js              Worker history and shared record rendering module
      mock-api.js             Offline/local fallback data
      offline-submissions.js  Offline submission queue and sync module
      photo-viewer.js         Photo thumbnail and zoom viewer module
      staff-sites.js          Supervisor staff, site, and form admin module
      supervisor-review.js    Supervisor review queue and export module
      utils.js
      worker-attendance.js    Worker attendance capture module
      worker-form.js          Worker dynamic form submission module
      worker-log.js           Worker Daywork log submission module
      worker-sites.js         Worker missing-site creation module
      work-form-fields.js     Work form field rendering and signature module
    icons/

  backend/
    migrations/
      versions/
        0001_initial_schema.py  Versioned database migration
    app/
      main.py                 FastAPI routes
      schemas.py              FastAPI request schemas
      models.py               SQLModel tables
      database.py             Engine and migration startup hook
      migrations.py           Dependency-free versioned migration runner
      auth.py                 Password/JWT helpers
      config.py               Environment loading
      use_cases/
        audit.py              Supervisor audit-event helpers
        common.py             Shared serializers, validation, and review helpers
        attendance.py         Worker attendance use cases
        task_logs.py          Worker task-log and template use cases
        work_forms.py         Work-form definition and submission use cases
        supervisor_review.py  Supervisor review, edit, decision, and export use cases
        staff_site_admin.py   Staff user and site admin use cases
    migration_test.py         Migration workflow regression script
    smoke_test.py             Backend smoke/regression script
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
CORS_ORIGINS=http://localhost:5173,https://localhost:5173,http://127.0.0.1:5173,https://127.0.0.1:5173
UPLOAD_DIR=uploads
MAX_UPLOAD_BYTES=5242880
```

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
```

Run on the computer:

```powershell
npm run dev
```

Run for phone testing:

```powershell
npm run dev:phone
```

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

Build and deploy the backend service first:

```powershell
gcloud config set project geo-attendance-system-db9ca
gcloud run deploy geo-backend --source . --region australia-southeast1 --allow-unauthenticated
```

Set Cloud Run environment variables from `.env.firebase.example`. The current live service stores `DATABASE_URL` and `GEO_SECRET_KEY` in Secret Manager, points `DATABASE_URL` at Cloud SQL PostgreSQL, and uses Cloud Storage for uploaded photos/signatures.

The Docker container runs `python -m app.migrations` before starting Uvicorn, so Cloud Run startup fails fast if the database schema cannot be migrated.

Use the production database runbook before changing the live Cloud SQL/PostgreSQL setup:

```text
docs/production-db-runbook.md
```

Then build and deploy Hosting:

```powershell
npm.cmd run build
firebase deploy --only hosting
```

`firebase.json` rewrites `/api/**` and `/uploads/**` to the `geo-backend` Cloud Run service. FastAPI strips the `/api` prefix at runtime so existing routes like `/auth/login`, `/attendance`, and `/supervisor/audit-events` continue to work behind Firebase Hosting. Uploaded files keep stable `/uploads/...` URLs; in production the backend loads those objects from Cloud Storage.

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

### Supervisor Form Builder

1. Sign in as supervisor.
2. Open the Work forms section.
3. Enter the form name and optional description.
4. Add one field per line in this format:

```text
type|Label|required|Option A,Option B
```

Examples:

```text
text|Work area|required
select|Result|required|Pass,Fail,N/A
textarea|Notes
checkbox|Follow up required
number|Quantity|required
date|Inspection date
signature|Worker signature|required
```

Supported field types are `text`, `textarea`, `number`, `date`, `select`, `checkbox`, and `signature`. A required `signature` field shows a touch-friendly signature pad and stores the handwritten signature as an uploaded PNG. Supervisors can edit form definitions or archive forms to remove them from the worker form chooser without deleting historical submissions.

### Supervisor Review

1. Sign in as supervisor.
2. Use the Review Queue as the single inbox for outside-site attendance, task logs, and form submissions.
3. Filter by worker/site text, record type, status, or date.
4. Check worker, site, timestamp, location/site radius where applicable, notes, photos, and signatures.
5. Approve or reject pending review records.
6. Use edit controls only after double-check confirmation.
7. Open Audit history and confirm recent review/edit/admin changes appear.
8. Export CSV, daily task-log sheets, task photo reports, or submitted work-form sheets when needed.

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
POST /dev/seed       local development only, disabled unless ENABLE_DEV_SEED=true
GET  /sites          authenticated
POST /sites          authenticated; workers and supervisors can add a missing site
POST /photo-uploads  authenticated
GET  /uploads/{file} authenticated; workers can access their own uploaded/referenced files, supervisors can access uploaded files
```

### Auth

```text
POST /auth/login
POST /auth/register
POST /auth/logout
GET  /auth/me
```

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
- Approved/rejected attendance is locked for workers.

### Worker Task Logs

```text
POST   /task-logs
GET    /my-task-logs
PATCH  /my-task-logs/{log_id}
DELETE /my-task-logs/{log_id}
```

Rules:

- Workers can create and view their task logs.
- Task logs are created as `pending` for supervisor approval.
- Worker update/delete endpoints intentionally return `403` for submitted logs.
- Task logs support `photo_urls` with up to 8 uploaded image URLs.
- `photo_url` remains for compatibility and points to the first task photo when present.

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

- Workers only see active work forms.
- Form submissions support typed answers and up to 8 uploaded image URLs.
- Submitted forms start as `pending` and are visible in worker history and supervisor review.

### Supervisor

```text
GET   /supervisor/users
POST  /supervisor/users
PATCH /supervisor/users/{user_id}
POST  /supervisor/users/{user_id}/status
GET   /supervisor/audit-events

POST  /supervisor/sites
PATCH /supervisor/sites/{site_id}

GET   /supervisor/review-records
GET   /supervisor/review-records?status=pending
GET   /supervisor/review-records?status=approved
POST  /supervisor/review-records/{kind}/{record_id}/decision

GET   /supervisor/pending-records
GET   /supervisor/records
GET   /supervisor/records?status=approved
GET   /supervisor/records?status=rejected
GET   /supervisor/records/export.csv
PATCH /supervisor/records/{record_id}
POST  /supervisor/records/{record_id}/decision

GET   /supervisor/task-logs
GET   /supervisor/task-logs?status=pending
GET   /supervisor/task-logs/export.csv
GET   /supervisor/task-logs/export.html?layout=daily-log
GET   /supervisor/task-logs/export.html?layout=photo-report
GET   /supervisor/task-logs/{log_id}/export.csv
GET   /supervisor/task-logs/{log_id}/export.html?layout=daily-log
GET   /supervisor/task-logs/{log_id}/export.html?layout=photo-report
PATCH /supervisor/task-logs/{log_id}

GET   /supervisor/form-submissions
GET   /supervisor/form-submissions?status=pending
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

`/supervisor/review-records` is the unified supervisor review feed for attendance, task logs, and form submissions. `/supervisor/audit-events` returns recent supervisor change events with actor, action, target entity, summary, and before/after snapshots. The older attendance/task/form list routes remain available for export and compatibility. HTML exports are standalone files intended for opening in a browser and printing or saving as PDF. PDF exports are generated server-side for submitted work forms and Daywork form submissions. Single-record CSV exports are Excel-friendly rows for the selected review card.

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

```json
{
  "record_type": "check_in",
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

```json
{
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
npm.cmd run check:mobile
```

Backend import check:

```powershell
python -m compileall backend\app backend\smoke_test.py backend\migration_test.py backend\upload_storage_test.py
python backend\upload_storage_test.py
```

Migration workflow check:

```powershell
python backend\migration_test.py
```

The smoke test covers:

- Health and seed data.
- Worker/supervisor login.
- Resigned worker cannot login.
- Reactivation keeps the user usable.
- Staff user editing and self-demotion protections.
- Site create/update.
- Work form create/list/archive.
- Work form submission and validation.
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

The mobile/browser workflow check covers:

- Production PWA app-shell files and stable manifest/icon paths.
- Service worker network-only API/upload rules.
- Visible service worker update-flow wiring.
- Mobile viewport, camera/photo inputs, and active worker/supervisor UI controls.
- Supervisor audit-history UI/API wiring.
- Offline form submission support for photos and handwritten signatures.

Manual phone/browser checks are listed in `docs/mobile-browser-workflow-checks.md`.

## Offline Behavior

The frontend uses IndexedDB for drafts and queued offline submissions. The Offline Submission module owns the submit/sync path for attendance, task logs, and work forms, including photo uploads and handwritten signature uploads.

```text
Online:
  Save the submission locally, upload photos/signatures, and send attendance, task logs, or work forms to FastAPI.

Offline:
  Save the submission locally with syncStatus=queued.

Back online:
  Flush queued submissions to FastAPI and update the local history record.
```

Work-form signatures are stored locally as image data while queued, then uploaded as PNG files during sync. Queued submissions keep a stable client submission id so a retry can return the existing backend record instead of creating a duplicate. Partial photo/signature uploads are saved onto the queued record as they succeed, so later retries reuse uploaded files. If the saved session expires, syncing pauses, the record remains queued, and the worker must sign in again before retrying.

Current offline behavior is suitable for MVP testing, but production conflict handling still needs more work.

## Date Filtering

History date filters use the user's local calendar date. For example, in New Zealand time, searching `2026-05-20` returns records shown on 20 May 2026 locally, not a UTC noon-to-noon window.

## Photo Behavior

- Attendance supports one optional photo.
- Task logs and work forms support up to 8 progress photos.
- Uploaded photos are served from `/uploads/...`.
- Thumbnails open in a floating photo viewer.
- Multi-photo task logs support previous/next navigation in the viewer.
- Local development stores uploads under `backend/uploads/`.
- Live Cloud Run stores new uploads in private Cloud Storage bucket `geo-attendance-system-db9ca-uploads` and serves them back through the backend.

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

Before real production use, improve:

- Production Firebase Hosting / Cloud Run validation with HTTPS, domain, CORS, upload paths, and app update behavior.
- Strong secret management for any remaining production credentials.
- Dedicated least-privilege Cloud Run service account instead of the default compute service account.
- Cloud SQL HA decision: keep zonal for cost or move to regional for automatic failover.
- Private IP/VPC plan before disabling Cloud SQL public IPv4.
- Refresh token/session strategy.
- Rate limiting.
- Richer audit-history filtering/export and a dedicated audit detail view.
- Backup and restore plan.
- More automated frontend and backend tests.
- Better offline conflict resolution.
- Production monitoring and error logging.

## Roadmap

Current next work:

- Run the real-phone checklist against the live Firebase Hosting / Cloud Run / Cloud SQL path.
- Clean up live smoke-test data and decide how to handle the `geo_migration_runner` database user.
- Expand automated frontend coverage beyond static workflow checks.
- Add a desktop-first payroll/admin portal section for pay-period worker hour summaries and payroll CSV export.

Useful later features:

- Map view for attendance and sites.
- Geofence warning before submit.
- Payroll rule hardening for overtime, allowances, deductions, public holidays, and wage-rate calculations.
- Shift/schedule module.
- Leave requests.
- Photo requirement rules per site/job.
- Native Excel export for payroll/admin reports.
- Bulk staff import.
- Production deployment scripts.

## License

This project is currently an MVP/prototype. Add a license before public or production use.
