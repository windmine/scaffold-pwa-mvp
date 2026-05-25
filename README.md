# Leader Field Operations

Mobile-first geo-attendance and field task logging MVP for Leader Scaffolding-style operations.

This project lets field workers check in/out from a phone with location data, submit daily task logs and custom work forms with progress photos, and review their own synced history. Supervisors can manage sites, staff, reusable work forms, attendance review, backend record adjustments with double-check confirmation, and CSV exports.

## Current Version

```text
Frontend: Vite-served PWA-style static app
Backend: FastAPI REST API
Database: SQLite for local development
Auth: JWT bearer tokens
Uploads: Local backend/uploads folder
Primary UI files: index.html, assets/css/styles.css, assets/js/app.js
```

The app started as a frontend-only prototype. It now uses the FastAPI backend for login, sites, attendance, task logs, task templates, dynamic work forms, photo uploads, staff users, supervisor review, and cross-device history sync.

`src/App.jsx` is not the current production UI path. The active app is `index.html` plus the modules in `assets/js/`.

## Features

### Worker

- Sign in with a backend account.
- Register a new staff account.
- Select a job/site.
- Capture browser geolocation.
- Check in and check out with GPS coordinates, accuracy, site radius result, notes, and optional attendance photo.
- Edit or delete own pending attendance before supervisor approval.
- Submit task logs with work date, hours, task summary, safety notes, and up to 8 progress photos.
- Save and apply reusable task-log templates for repetitive work.
- Choose supervisor-created work forms, such as daywork, inspection, and tool deduction forms.
- Submit work forms with typed fields, handwritten signatures, site/work date, and up to 8 photos.
- View local and backend-synced attendance/task history.
- Search/filter history by text, type, status, and local calendar date.
- Click any uploaded photo thumbnail to open a floating zoom viewer with previous/next controls.
- Save offline drafts and queue offline records for later sync.

Worker restrictions:

- Workers cannot edit or delete submitted task logs.
- Workers cannot edit or delete attendance after it is approved or rejected.
- Resigned workers cannot sign in.

### Supervisor

- Sign in with a supervisor account.
- View pending, approved, and rejected attendance.
- View worker task logs and attached photo galleries.
- Create, edit, and archive worker-facing work forms.
- View worker work-form submissions and attached photo galleries.
- Approve or reject pending attendance.
- Adjust attendance records with double-check confirmation.
- Adjust submitted task logs with double-check confirmation.
- Create and edit sites, including allowed check-in radius.
- Search sites.
- Create worker/supervisor users.
- Edit staff name, email, role, status, or reset password with double-check confirmation.
- View and search staff users.
- Mark workers resigned so they cannot sign in.
- Reactivate resigned workers without losing previous records.
- Export attendance records to CSV.
- Export task logs to CSV.

### PWA / Mobile UX

- Vite HTTPS dev server for geolocation-friendly phone testing.
- Same-origin `/api` proxy to avoid iOS mixed-content blocking.
- Service worker app shell cache.
- Offline page.
- IndexedDB drafts and queue.
- Mobile-first layout with folded supervisor sections.

## Demo Accounts

Seed demo data first with `POST /dev/seed`.

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

  assets/
    css/
      styles.css              Active UI styles
    js/
      app.js                  Active frontend app logic
      api-client.js           FastAPI client
      db.js                   IndexedDB wrapper
      mock-api.js             Offline/local fallback data
      utils.js
    icons/

  backend/
    app/
      main.py                 FastAPI routes
      models.py               SQLModel tables
      database.py             Engine and lightweight SQLite migrations
      auth.py                 Password/JWT helpers
      config.py               Environment loading
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
GEO_SECRET_KEY=change-this-dev-secret
DATABASE_URL=sqlite:///./geo_management.db
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

Seed demo accounts and demo sites:

```text
POST /dev/seed
```

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

## Key Workflows

### Worker Attendance

1. Sign in as a worker.
2. Select a site.
3. Capture location.
4. Check the live site-radius preview before submitting.
5. Add optional notes/photo.
6. Check in or check out.
7. History shows the backend-synced record and whether it was inside the site radius.
8. Pending attendance can be edited or deleted until supervisor approval/rejection.

### Worker Task Log

1. Select a site.
2. Set work date and hours.
3. Enter task summary and optional safety notes.
4. Select one or more progress photos from the phone photo picker.
5. Submit task log.
6. Task logs become locked for the worker after submission.
7. Photos can be opened in the floating photo viewer.

### Task Templates

1. Fill in common task log fields.
2. Enter a template name.
3. Save the current log as a template.
4. Reuse it later from the task template dropdown.

Templates store:

```text
name
site
description
hours
safety notes
```

Photos are not stored in templates.

### Worker Work Forms

1. Choose a work form from the task/log area.
2. Select a site and work date.
3. Fill in the form fields.
4. Select optional photos from the phone photo picker.
5. Submit the form.
6. The submission appears in worker history and the supervisor form-submissions section.

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
2. Review pending attendance.
3. Check worker, site, timestamp, location, site radius, notes, and photo.
4. Approve or reject.
5. Use edit controls only after double-check confirmation.
6. Export CSV when needed.

## API Summary

### General

```text
GET  /health
POST /dev/seed
GET  /sites
POST /photo-uploads
```

### Auth

```text
POST /auth/login
POST /auth/register
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
- Submitted forms are visible in worker history and supervisor review.

### Supervisor

```text
GET   /supervisor/users
POST  /supervisor/users
PATCH /supervisor/users/{user_id}
POST  /supervisor/users/{user_id}/status

POST  /supervisor/sites
PATCH /supervisor/sites/{site_id}

GET   /supervisor/pending-records
GET   /supervisor/records
GET   /supervisor/records?status=approved
GET   /supervisor/records?status=rejected
GET   /supervisor/records/export.csv
PATCH /supervisor/records/{record_id}
POST  /supervisor/records/{record_id}/decision

GET   /supervisor/task-logs
GET   /supervisor/task-logs/export.csv
PATCH /supervisor/task-logs/{log_id}

GET   /supervisor/form-submissions
POST  /supervisor/work-forms
PATCH /supervisor/work-forms/{form_id}
```

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
    { "id": "notes", "label": "Notes", "type": "textarea", "required": false },
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
npm run lint
npm run build
```

Backend import check:

```powershell
python -m compileall backend\app backend\smoke_test.py
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
- Supervisor task-log adjustment.
- CSV export.
- Task-log CSV export.

## Offline Behavior

The frontend uses IndexedDB for drafts and queued records.

```text
Online:
  Send attendance, task logs, and work forms to FastAPI.

Offline:
  Save drafts and queued records locally.

Back online:
  Flush queued records to FastAPI.
```

Current offline behavior is suitable for MVP testing, but production conflict handling still needs more work.

## Date Filtering

History date filters use the user's local calendar date. For example, in New Zealand time, searching `2026-05-20` returns records shown on 20 May 2026 locally, not a UTC noon-to-noon window.

## Photo Behavior

- Attendance supports one optional photo.
- Task logs and work forms support up to 8 progress photos.
- Uploaded photos are served from `/uploads/...`.
- Thumbnails open in a floating photo viewer.
- Multi-photo task logs support previous/next navigation in the viewer.
- Current storage is local filesystem storage under `backend/uploads/`.

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

- Real database migrations instead of lightweight SQLite `ALTER TABLE` startup checks.
- PostgreSQL or another managed production database.
- Production HTTPS deployment.
- Strong secret management.
- Refresh token/session strategy.
- Rate limiting.
- Audit log table for supervisor changes.
- Stronger file storage for photos, such as S3-compatible object storage.
- Backup and restore plan.
- More automated frontend and backend tests.
- Better offline conflict resolution.
- Production monitoring and error logging.

## Roadmap

Useful next features:

- Map view for attendance and sites.
- Geofence warning before submit.
- Shift/schedule module.
- Leave requests.
- Photo requirement rules per site/job.
- Excel export.
- Audit trail UI.
- Bulk staff import.
- Production deployment scripts.

## License

This project is currently an MVP/prototype. Add a license before public or production use.
