# AGENTS.md

## Final Aim For Codex

Build a working mobile-first geo-attendance management MVP where staff can check in and out by phone with location data, submit field logs/forms with photos and signatures, and supervisors can review/manage those records through a simple admin interface.

The project should stay practical: reliable local testing first, then production PWA hardening, then advanced HR/workflow features.

## Product Vision

Create a practical geo-based field operations platform for three main user groups.

1. **Staff / field users**
   - Log in securely.
   - Check in and check out from a phone.
   - Allow browser geolocation capture.
   - Submit daily task logs with photos.
   - Choose supervisor-created work forms such as daywork, inspection, and tool deduction forms.
   - Complete handwritten signature fields when a form requires them.
   - View synced attendance, task log, and form history.
   - Use a simple interface that works well on mobile screens.

2. **Supervisors / admin users**
   - Log in securely.
   - View staff attendance records.
   - Review check-in and check-out location data.
   - View task logs, form submissions, photos, and handwritten signatures.
   - Manage sites and allowed site radius.
   - Manage staff users, including resigned/reactivated workers.
   - Create, edit, archive, and reactivate reusable work forms.
   - Use a folded/searchable dashboard layout from desktop, tablet, or phone.

3. **Accounting / payroll users**
   - Review approved attendance by pay period.
   - See worker/day hour totals for wage preparation.
   - Find missing check-outs, duplicate attendance events, pending/rejected records, outside-site records, and manual supervisor adjustments before payroll export.
   - Export payroll-ready CSV or Excel-friendly summaries.
   - Use a desktop-first admin section, while preserving the worker phone-first PWA.

## Current Implementation Notes

- The active frontend path is `index.html` with `assets/js/app.js`, `assets/js/app-shell-state.js`, `assets/js/api-client.js`, `assets/js/db.js`, `assets/js/mock-api.js`, feature modules under `assets/js/`, and `assets/css/styles.css`.
- `src/App.jsx` exists but is a legacy React path and is not the current production UI.
- The backend is FastAPI in `backend/app/main.py` using SQLModel models from `backend/app/models.py`.
- Local development uses SQLite at `backend/geo_management.db`.
- The current live deployment is Firebase Hosting, Cloud Run, Neon PostgreSQL supplied through Secret Manager, and a private Cloud Storage upload bucket. The recommended all-Google target remains Firebase Hosting, Cloud Run, Cloud SQL PostgreSQL, Cloud Storage, and Secret Manager.
- Production uploads must use Cloud Storage or another durable object store. Do not rely on local `backend/uploads/` for Cloud Run production storage.
- The app currently supports backend auth, HttpOnly `__session` cookies with CSRF, session refresh, normal-worker/leader classes, department-scoped supervisors/global admins, attendance, geolocation, site radius checks, task logs, weekly team logs, multiple photos, task templates, staff management, resigned workers, supervisor record edits, rubbish-bin restore/purge, audit history, CSV/PDF/HTML exports, versioned Work Forms, form submissions, handwritten signatures, maps, and Management Analytics.
- Payroll/admin reporting is planned, not implemented yet. Keep it separate from the Review Queue: supervisors validate records, while accounting calculates/export payable hours from approved attendance.
- The Offline Submission module owns Worker identity, capture time, client idempotency key, replay state, and partial-upload state for queued attendance, task logs, and Work Forms; attendance maps capture time to its occurrence timestamp. Do not make those separate caller responsibilities.
- Work Form Definitions are versioned; each submission stores an immutable definition snapshot, and the backend is authoritative for time-range and formula results.
- The Review Queue is a cursor-paginated feed of durable attendance, task, weekly team-log, and form Review Records. Its explicit offline fallback is read-only; dashboard totals and Management Analytics use a complete overview rather than the current filtered page.
- Upload Storage owns decoded-raster verification/re-encoding, local/GCS adapter readiness, authorized streaming, and unreferenced-file cleanup.
- PWA pieces include `manifest.webmanifest`, generated `sw.js`, `offline.html`, HTTPS Vite development, IndexedDB drafts, and the hardened offline queue. Local automated and real-phone checks are green; automated hosted passes completed on 2026-07-14 and 2026-07-15, while the full hosted real-phone/update/upload checklist still remains.
- Backend production helpers include `/health/ready`, SQLAlchemy `pool_pre_ping`, configurable in-process rate limiting, focused security/storage/database tests, and the read-only `npm run check:production-hardening` gate. The gate verifies the live GCP topology plus current Neon and upload recovery evidence; it does not replace Neon role/pooling controls, a longer recovery window, or an operator notification destination.
- Runtime/generated paths such as `backend/geo_management.db`, `backend/uploads/`, `backend/app/__pycache__/`, `dist/`, and `node_modules/` are not source-of-truth code changes.

## MVP Scope

The MVP should include:

- User authentication.
- Role-based behaviour for workers and supervisors.
- Staff registration and login.
- Mobile-friendly check-in/check-out flow.
- Location capture using browser geolocation.
- Backend API endpoints for attendance, task logs, weekly team logs, Work Forms, Sites, uploads, review, and user data.
- Database storage for Departments, users, attendance records, task logs, weekly team logs/entries, Sites, versioned Work Forms, immutable submission snapshots, timestamps, coordinates, upload references, and audit events.
- Supervisor dashboard to view, search, approve, reject, and adjust records.
- Clear error handling for login, registration, location permission, API failures, photo upload failures, and form validation.
- README instructions for setup, environment variables, backend startup, frontend startup, phone testing, and validation.

## Preferred Technical Direction

Use the existing project structure where possible.

Expected stack:

- **Frontend:** Vite-served PWA-style static app.
- **Backend:** Python FastAPI.
- **Database:** SQLModel / SQLAlchemy-compatible database. Use SQLite locally and Cloud SQL PostgreSQL for the Google-hosted path.
- **Production hosting:** Firebase Hosting rewrites `/api/**` and `/uploads/**` to Cloud Run so browser auth stays same-origin.
- **Upload storage:** local `backend/uploads/` only for development; Cloud Storage for production photos and signatures.
- **Testing target:** local desktop browser and phone browser on the same network.
- **Development startup example:**
  - Backend: `python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000`
  - Frontend: `npm run dev:phone`

Do not replace the whole stack unless the current implementation clearly requires it.

## Implementation Priorities

General MVP order:

1. Make the project run locally without errors.
2. Make login and registration reliable.
3. Make phone testing work on the same local network.
4. Stabilise geolocation check-in/check-out.
5. Store attendance and task/form records correctly in the backend database.
6. Display records clearly for supervisor users.
7. Improve UI clarity and mobile responsiveness.
8. Keep README/setup instructions current.
9. Add validation and focused tests where useful.
10. Only then add advanced reports, maps, exports, HR, or workflow features.

Current reset goal:

Keep the existing MVP reliable as an installable phone-first PWA locally and through the hosted path before adding more business features. The core Worker/Supervisor workflows are broad enough; current work should reduce sync, review, deployment, and recovery risk.

Current reset priorities completed:

1. Production PWA build output includes the service worker, offline page, manifest, and icon assets.
2. Service worker cache rules keep API, auth, upload, and supervisor data paths network-only.
3. A visible `Update App` flow appears when a new service worker is waiting.
4. Focused browser/mobile workflow checks cover worker, supervisor, PWA, offline, and update-flow basics.
5. Queued offline submissions are hardened for partial upload failures, expired sessions, and duplicate sync attempts.
6. Supervisor audit history records edits to attendance, sites, staff users, task logs, work forms, and review decisions.
7. The Daywork team-member picker passes the focused Playwright mobile/browser workflow checks.
8. Backend smoke testing uses the current Firebase-compatible `__session` cookie and covers readiness/session refresh.
9. App-level readiness, session refresh, and configurable rate limiting are implemented; live GCP resource hardening is checked by a read-only script.
10. Offline Submission ownership, capture time, attendance occurrence time, idempotency, replay state, and partial uploads are enforced behind one module interface.
11. Upload Storage presents one verified-raster, readiness, authorization, streaming, and lifecycle-cleanup test surface for local disk and GCS.
12. Work Form Definitions have immutable submission snapshots and server-authoritative validation, time ranges, conditions, repeats, formulas, and signatures.
13. Review Record policy, cursor queries, explicit offline/read-only state, and export adapters are separated; dashboard and Management Analytics totals no longer depend on the visible filtered page.
14. Database connection checkout uses `pool_pre_ping`, and authenticated Sites load only after login/session restoration succeeds.
15. The 2026-07-14 hosted automated pass verified anonymous/login isolation, restored-session ordering, repeated Sites requests, logout, Review Queue, readiness, and new-revision logs without an observed 5xx.
16. Cloud Run serves through a dedicated least-privilege runtime identity; the default Compute identity is build-only.
17. Hosted readiness and Cloud Run 5xx Monitoring policies are live, and current Neon PITR/upload soft-delete recovery drills are checked through sanitized evidence.

Current next priorities:

1. Run the full manual phone/browser workflow checklist against the live Firebase Hosting / Cloud Run path.
2. Add a verified Monitoring notification channel and billing budget, replace the Neon owner runtime credential, verify pooling limits, and choose recovery beyond the current six-hour history window.
3. Expand automated frontend/backend tests around the highest-risk worker and supervisor workflows.
4. Add a desktop-first payroll/admin portal section for pay-period worker hour summaries, exception flags, and payroll CSV export.

## Important Behaviour Rules

- Do not hardcode API secrets, database passwords, OAuth client secrets, or production credentials.
- Use `.env` files for local configuration.
- Keep sample environment values in `.env.example`.
- Do not break existing working routes or UI flows.
- Keep the UI simple, practical, and mobile-first.
- Prefer small, safe changes over large rewrites.
- After changing backend code, check that API routes still start correctly.
- After changing frontend code, check that the Vite app still builds.
- When adding a feature, update the README if setup, usage, API, or validation changes.
- When changing frontend assets used by the app shell, update `scripts/pwa-shell-assets.mjs` if the shell asset list changes and run `npm run generate:pwa`; `sw.js` and its cache name are generated.
- When changing production deployment behavior, update `README.md`, `docs/production-db-runbook.md`, and `docs/mobile-browser-workflow-checks.md`.
- When changing auth, CSRF, session refresh, readiness, rate limiting, or production hardening behavior, update `backend/smoke_test.py`, `backend/security_test.py`, README, and the production runbook.
- Use clear naming for files, functions, routes, and components.

## Suggested Core Data Model

The exact schema can follow the current project, but the MVP should support these concepts.

### Department / User

- id
- email
- name
- password hash
- role: worker or supervisor
- worker class: normal or leader
- department id
- optional global-admin access and saved dashboard focus
- status: active or resigned

### Attendance Record

- id
- worker id
- optional site id
- record type: check_in or check_out
- occurrence timestamp
- latitude
- longitude
- accuracy
- distance from site
- within site radius
- optional note
- optional photo URL
- status: pending, approved, or rejected
- client submission id for Worker replay idempotency
- entry source and optional Supervisor creator for manual corrections
- optional rubbish-bin metadata

### Task Log

- id
- worker id
- optional site id
- work date
- hours worked
- task description
- safety notes
- photo URLs
- created timestamp
- client submission id
- status, entry source, and optional rubbish-bin metadata

### Work Form

- id
- name
- description
- JSON field definition list
- current definition version
- status: active or archived
- created by
- created timestamp

Supported field types:

- text
- textarea
- number
- date
- select
- checkbox
- signature
- section
- time_range
- formula
- repeat

Signature fields should be handwritten by the worker using a signature pad and saved as uploaded image URLs, not typed names.

### Work Form Submission

- id
- form id
- worker id
- optional site id
- work date
- JSON answers
- photo URLs
- form definition version and immutable definition snapshot
- client submission id
- status and optional rubbish-bin metadata
- created timestamp

### Weekly Team Work Log

- leader / Worker id and Department
- week start
- client submission id
- status and optional rubbish-bin metadata
- many member/date/site/start/finish/break/work-detail entries

### Audit Event

- actor and access scope
- action and target entity
- summary and before/after snapshots
- created timestamp

### Site / Job Location

- id
- name
- address
- latitude
- longitude
- allowed radius

## Acceptance Criteria

The project can be considered successful when:

- A new user can register or be created.
- A staff user can log in from a phone.
- The phone can open the frontend using the local network IP.
- The staff user can check in with location permission enabled.
- The backend stores the check-in time and coordinates.
- The staff user can check out later.
- A worker can submit task logs with multiple photos.
- A supervisor can create, edit, archive, and reactivate work forms.
- A worker can submit a chosen work form.
- Required handwritten signature fields are enforced.
- A supervisor can view attendance, task logs, form submissions, photos, and signatures.
- A supervisor can review weekly Team Work Logs and query pending, approved, and rejected Review Records with stable pagination.
- Dashboard review totals and Management Analytics remain correct when the visible Review Queue is filtered or contains only one page.
- Delayed Offline Submissions preserve the original Worker and capture time; delayed attendance preserves its occurrence timestamp, and retries do not create duplicates or cross accounts on a shared device.
- Historical Work Form submissions retain their exact Definition snapshot after the reusable form changes.
- Local and GCS Upload Storage adapters enforce the same raster validation, authorization, readiness, and lifecycle rules.
- A supervisor can mark workers resigned and reactivate them without losing old records.
- The app does not crash when location permission is denied.
- Anonymous startup does not request protected Sites; restored sessions refresh before Sites load.
- `/health/ready` verifies database and Upload Storage, including recovery from stale pooled database connections.
- Setup instructions are clear enough for another developer to run the project.

## Future Features After MVP

Possible future features include:

- Desktop payroll/admin portal for approved-hour summaries and payroll CSV export.
- Payroll rules for overtime, allowances, deductions, public holidays, wage rates, and other business-specific wage calculations.
- Native Excel export for payroll/admin reports and submitted field records.
- Staff schedule or shift management.
- Leave request management.
- Photo requirement rules per site or form.
- Push notifications.
- Richer audit filtering, export, and detail view.
- Bulk staff import.
- Integration with external HR or form systems.
- Distributed/edge rate limiting if the service scales beyond one Cloud Run instance.
- Stronger cross-device offline conflict resolution beyond idempotent replay.

## Codex Working Style

When modifying this repository, Codex should:

- First inspect the existing files and structure.
- Explain the intended change briefly.
- Make the smallest reasonable code change.
- Preserve the current project style.
- Avoid unnecessary new dependencies.
- Run or suggest the most relevant validation command.
- Summarise what changed and what still needs testing.

Preferred validation commands:

```powershell
npm run lint
npm run build
npm run check:review-queue
npm run check:mobile
python -m compileall backend\app backend\smoke_test.py backend\database_test.py backend\migration_test.py backend\review_queue_test.py backend\work_form_definition_test.py backend\upload_storage_test.py backend\security_test.py
python backend\database_test.py
python backend\security_test.py
python backend\upload_storage_test.py
python backend\review_queue_test.py
python backend\work_form_definition_test.py
python backend\migration_test.py
python backend\smoke_test.py
```

The smoke test expects the backend to be running at `http://127.0.0.1:8000`.
`npm run check:production-hardening` requires authenticated `gcloud` access and current sanitized proof files. It validates the live GCP resource contract plus exact Neon/upload recovery evidence; it does not establish Neon least-privilege roles, pooling limits, longer backup retention, or notification ownership.
