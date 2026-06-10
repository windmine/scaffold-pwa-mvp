# AGENTS.md

## Final Aim For Codex

Build a working mobile-first geo-attendance management MVP where staff can check in and out by phone with location data, submit field logs/forms with photos and signatures, and supervisors can review/manage those records through a simple admin interface.

The project should stay practical: reliable local testing first, then production PWA hardening, then advanced HR/workflow features.

## Product Vision

Create a practical geo-based field operations platform for two main user groups.

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

- The active frontend path is `index.html` with `assets/js/app.js`, `assets/js/api-client.js`, `assets/js/db.js`, `assets/js/mock-api.js`, and `assets/css/styles.css`.
- `src/App.jsx` exists but is a legacy React path and is not the current production UI.
- The backend is FastAPI in `backend/app/main.py` using SQLModel models from `backend/app/models.py`.
- Local development uses SQLite at `backend/geo_management.db`.
- The app currently supports backend auth, worker/supervisor roles, attendance, geolocation, site radius checks, task logs, multiple photos, task templates, staff management, resigned workers, supervisor record edits, CSV exports, dynamic work forms, form submissions, and handwritten signature fields.
- Payroll/admin reporting is planned, not implemented yet. Keep it separate from the Review Queue: supervisors validate records, while accounting calculates/export payable hours from approved attendance.
- PWA pieces exist: `manifest.webmanifest`, `sw.js`, `offline.html`, HTTPS Vite dev server, IndexedDB drafts, and an offline queue for attendance, task logs, and work forms with photos/signatures. Treat it as PWA-shaped but not fully production PWA-ready yet.
- Runtime/generated paths such as `backend/geo_management.db`, `backend/uploads/`, `backend/app/__pycache__/`, `dist/`, and `node_modules/` are not source-of-truth code changes.

## MVP Scope

The MVP should include:

- User authentication.
- Role-based behaviour for workers and supervisors.
- Staff registration and login.
- Mobile-friendly check-in/check-out flow.
- Location capture using browser geolocation.
- Backend API endpoints for attendance, task logs, forms, sites, and user data.
- Database storage for users, attendance records, task logs, sites, work forms, form submissions, timestamps, coordinates, photos, and signature URLs.
- Supervisor dashboard to view, search, approve, reject, and adjust records.
- Clear error handling for login, registration, location permission, API failures, photo upload failures, and form validation.
- README instructions for setup, environment variables, backend startup, frontend startup, phone testing, and validation.

## Preferred Technical Direction

Use the existing project structure where possible.

Expected stack:

- **Frontend:** Vite-served PWA-style static app.
- **Backend:** Python FastAPI.
- **Database:** SQLModel / SQLAlchemy-compatible database.
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

Make the existing local MVP reliable as an installable phone-first PWA before adding more business features. The core worker/supervisor workflows are broad enough; the next work should reduce build, cache, sync, and review-risk.

Current reset priorities completed:

1. Production PWA build output includes the service worker, offline page, manifest, and icon assets.
2. Service worker cache rules keep API, auth, upload, and supervisor data paths network-only.
3. A visible `Update App` flow appears when a new service worker is waiting.
4. Focused browser/mobile workflow checks cover worker, supervisor, PWA, offline, and update-flow basics.
5. Queued offline submissions are hardened for partial upload failures, expired sessions, and duplicate sync attempts.
6. Supervisor audit history records edits to attendance, sites, staff users, task logs, work forms, and review decisions.

Current next priorities:

1. Run the full manual phone/browser workflow checklist against a real phone on the local network.
2. Replace lightweight SQLite startup migrations with a real migration workflow before production.
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
- When changing frontend assets used by the app shell, bump the service worker cache version in `sw.js`.
- Use clear naming for files, functions, routes, and components.

## Suggested Core Data Model

The exact schema can follow the current project, but the MVP should support these concepts.

### User

- id
- email
- name
- password hash
- role: worker or supervisor
- status: active or resigned

### Attendance Record

- id
- worker id
- optional site id
- record type: check_in or check_out
- timestamp
- latitude
- longitude
- accuracy
- distance from site
- within site radius
- optional note
- optional photo URL
- status: pending, approved, or rejected

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

### Work Form

- id
- name
- description
- JSON field definition list
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

Signature fields should be handwritten by the worker using a signature pad and saved as uploaded image URLs, not typed names.

### Work Form Submission

- id
- form id
- worker id
- optional site id
- work date
- JSON answers
- photo URLs
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
- A supervisor can mark workers resigned and reactivate them without losing old records.
- The app does not crash when location permission is denied.
- Setup instructions are clear enough for another developer to run the project.

## Future Features After MVP

Possible future features include:

- Desktop payroll/admin portal for approved-hour summaries and payroll CSV export.
- Payroll rules for overtime, allowances, deductions, public holidays, wage rates, and other business-specific wage calculations.
- Production-ready PWA packaging.
- Offline-first work-form submissions with signatures and photos.
- Map view for attendance locations and sites.
- Site geofencing with stricter allowed check-in radius rules.
- Native Excel export for payroll/admin reports and submitted field records.
- Manager approval workflows for task logs and form submissions.
- Staff schedule or shift management.
- Leave request management.
- Photo requirement rules per site or form.
- Push notifications.
- Richer audit filtering, export, and detail view.
- Bulk staff import.
- Integration with external HR or form systems.

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
python -m compileall backend\app backend\smoke_test.py
python backend\smoke_test.py
```

The smoke test expects the backend to be running at `http://127.0.0.1:8000`.
