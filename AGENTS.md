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
- During the invited-account pilot, the public registration panel is hidden and Supervisors create and activate Worker accounts from Staff users. The current Staff users flow still requires the Supervisor to choose and communicate each initial password; a single-use invitation and Worker-set-password flow is not implemented yet. The verified-registration API remains callable and regression-tested for a later re-enable, but it is not exposed in the UI or supported as the pilot onboarding path.
- Payroll/admin reporting is planned, not implemented yet. Keep it separate from the Review Queue: supervisors validate records, while accounting calculates/export payable hours from approved attendance.
- The Offline Submission module owns Worker identity, capture time, client idempotency key, replay state, and partial-upload state for queued attendance, task logs, and Work Forms; attendance maps capture time to its occurrence timestamp. Do not make those separate caller responsibilities.
- Work Form Definitions are versioned; each submission stores an immutable definition snapshot, and the backend is authoritative for time-range and formula results.
- The Review Queue is a cursor-paginated feed of durable attendance, task, weekly team-log, and form Review Records. Its explicit offline fallback is read-only; dashboard totals and Management Analytics use a complete overview rather than the current filtered page.
- Upload Storage owns decoded-raster verification/re-encoding, local/GCS adapter readiness, authorized streaming, and unreferenced-file cleanup.
- PWA pieces include `manifest.webmanifest`, generated `sw.js`, `offline.html`, HTTPS Vite development, IndexedDB drafts, and the hardened offline queue. The deployed shell cold-launches the cached production app offline, restores only the signed-in Worker/Department Site and attendance-context snapshots, clears those snapshots on logout or invalid authorization, and can queue new attendance without a live API. Local automation and the historical local real-phone pass are green; automated hosted passes completed on 2026-07-14, 2026-07-15, 2026-08-04, 2026-08-05, 2026-08-07, 2026-08-10, 2026-08-11, and 2026-08-13, while the full hosted real-phone/update/upload checklist still remains.
- Backend production helpers include `/health/ready`, SQLAlchemy `pool_pre_ping`, configurable in-process rate limiting, focused security/storage/database tests, and the read-only `npm run check:production-hardening` gate. The gate verifies the live GCP topology plus current Neon and upload recovery evidence; it does not replace Neon role/pooling controls, a longer recovery window, or an operator notification destination.
- The complete 2026-07-31 local gate passed at commit `b9aa05d`: lint, production build, Review Queue, 25 Playwright browser workflows, backend compile/database/security/upload/form/migration tests, and a disposable-database smoke test. Production npm dependencies and Python dependency consistency passed; the full development npm audit reports one high-severity `brace-expansion` advisory through ESLint/minimatch.
- The 2026-08-04 release deployed commit `38220e9` as Cloud Run revision `geo-backend-release-20260804152130` and Firebase Hosting version `6eea51a351ebab2b`. Candidate and post-promotion readiness, exact shell/service-worker/offline/manifest parity, invited-only login, hidden registration, anonymous Site isolation, Supervisor-only Global Admin controls, and logout passed; the full hosted real-phone/update/upload checklist remains.
- The 2026-08-05 frontend-only release deployed commit `9db3477` through Firebase preview `release-20260805155240` and cloned exact Hosting version `ba8c1689c2d0e121` live. Local, preview, and live shell hashes matched; five live readiness probes, invited-only/hidden-registration checks, cold-offline service-worker checks, and anonymous Site isolation passed. Cloud Run remained on `geo-backend-release-20260804152130`.
- The 2026-08-07 frontend-only release deployed commit `bbee643` through Firebase preview `release-20260807120117` at `https://geo-attendance-system-db9ca--release-20260807120117-texdr4u7.web.app`, then cloned exact Hosting version `1e831c0aa589a08d` live. The local gate passed lint, production build/static checks, 28 Playwright workflows, Review Queue checks, production npm audit with zero findings, Python dependency consistency, and the controlled production-hardening gate with its three known warnings. Local, preview, and live hashes matched for `index.html`, `sw.js`, `offline.html`, and `manifest.webmanifest`; five live readiness probes reported database and GCS readiness, anonymous Sites returned 401, invited-only/hidden-registration and login-before-install checks passed, and service-worker hashed entrypoints plus the scoped attendance snapshot were verified. Cloud Run remained on `geo-backend-release-20260804152130`; the full hosted real-phone/update/upload checklist remains pending.
- The 2026-08-10 frontend-only release deployed commit `b2dec22` through Firebase preview `release-20260810172537` at `https://geo-attendance-system-db9ca--release-20260810172537-uihkpz71.web.app`, then cloned exact Hosting version `6b499ef514142a09` live. The release gate passed lint, production build/static checks, all 28 Playwright workflows, Review Queue checks, production npm audit with zero findings, Python dependency consistency, and the controlled production-hardening gate with its three known warnings. Local, preview, and live hashes matched for `index.html`, `sw.js`, `offline.html`, and `manifest.webmanifest`; five preview and five live readiness probes reported database and GCS readiness, anonymous Sites returned 401, invited-only/hidden-registration and login-before-install checks passed, and the generated service worker contained its hashed entrypoints and scoped offline snapshots. Staff and Work Form creation now start list-first behind accessible Add actions, with cancel/reset, focus restoration, submit locking, and explicit post-create refresh-failure handling. Cloud Run remained on `geo-backend-release-20260804152130`; the full hosted real-phone/update/upload checklist remains pending.
- The 2026-08-11 frontend-only release deployed commit `9a6260e` through Firebase preview `release-20260811125326` at `https://geo-attendance-system-db9ca--release-20260811125326-agkq8qbo.web.app`, then cloned exact Hosting version `4766134daf955917` live. The release gate passed lint, production build/static checks, all 28 Playwright workflows, Review Queue checks, production npm audit with zero findings, Python dependency consistency, and the controlled production-hardening gate with its three known warnings; the full development npm audit separately reported two high and one moderate toolchain-only advisories. All 47 generated app-shell paths plus `sw.js` matched locally, on preview, and live; five preview and five live readiness probes reported database and GCS readiness, anonymous Sites returned 401, invited-only/hidden-registration and login-before-install checks passed, and PWA cache headers were correct. Consequential operations now use one accessible, cancel-first app dialog with focus restoration and single-flight guards, while pending-attendance/Work Form saves, rubbish-bin restores, and Work Form archive/activate actions avoid redundant confirmation. Cloud Run remained on `geo-backend-release-20260804152130`; the full hosted real-phone/update/upload checklist remains pending.
- The 2026-08-13 frontend-only release deployed commit `bcfb128` through Firebase preview `release-20260813120158` at `https://geo-attendance-system-db9ca--release-20260813120158-1krt9yox.web.app`, then cloned exact Hosting version `c761984b7353028a` live. The release gate passed lint, production build/static checks, all 28 Playwright workflows, Review Queue checks, production npm audit with zero findings, Python dependency consistency, and the controlled production-hardening gate with its three known warnings; the full development npm audit separately reported two high and one moderate toolchain-only advisories. All 47 generated app-shell paths plus `sw.js` matched locally, on preview, and live; five preview and five live readiness probes reported database and GCS readiness, anonymous Sites returned 401, invited-only/hidden-registration and login-before-install checks passed, and PWA cache headers were correct. Analytics exceptions now open the collision-safe related Review Record or valid attendance map point after clearing conflicting filters, while essential map and Analytics labels have a tested 14px readability floor at desktop and phone widths. Cloud Run remained on `geo-backend-release-20260804152130`; the full hosted real-phone/update/upload checklist remains pending.
- Runtime/generated paths such as `backend/geo_management.db`, `backend/uploads/`, `backend/app/__pycache__/`, `dist/`, and `node_modules/` are not source-of-truth code changes.

## MVP Scope

The MVP should include:

- User authentication.
- Role-based behaviour for workers and supervisors.
- Supervisor-provisioned invited Worker accounts and reliable login.
- Mobile-friendly check-in/check-out flow.
- Location capture using browser geolocation.
- Backend API endpoints for attendance, task logs, weekly team logs, Work Forms, Sites, uploads, review, and user data.
- Database storage for Departments, users, attendance records, task logs, weekly team logs/entries, Sites, versioned Work Forms, immutable submission snapshots, timestamps, coordinates, upload references, and audit events.
- Supervisor dashboard to view, search, approve, reject, and adjust records.
- Clear error handling for login, invited-account provisioning, location permission, API failures, photo upload failures, and form validation. Keep the dormant verified-registration API errors tested separately.
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
2. Make invited-account provisioning and login reliable; keep dormant verified registration safe for a later re-enable.
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
18. Public registration is hidden for the invited-account pilot, invited-account guidance is translated, and static/Playwright checks prevent the registration panel from reappearing.
19. The 2026-07-31 full local release gate passed on commit `b9aa05d`.
20. Commit `38220e9` passed the expanded 2026-08-04 local release gate and was deployed through a verified no-traffic Cloud Run candidate and exact Firebase Hosting preview-to-live clone.
21. Commit `9db3477` serves the cached application for cold offline `/` and `/index.html` launches, precaches production bundle entrypoints, restores a Worker/Department-scoped Site snapshot, passes a production-preview browser regression that queues attendance after the last app client is closed, and is deployed as Firebase Hosting version `ba8c1689c2d0e121`.
22. Commit `bbee643` puts login before installation promotion, compacts the Normal worker guide after first attendance use, defaults checkout to the open check-in Site, prioritizes open/recent/nearest Sites, and persists race-isolated Worker/Department attendance context for offline restoration. Its 2026-08-07 frontend-only release is deployed as Firebase Hosting version `1e831c0aa589a08d`; Cloud Run is unchanged.
23. Commit `b2dec22` makes Staff users and Work Forms list-first, reveals creation through accessible Add actions, preserves retry state on failed creates, and warns without discarding the prior list when a successful create cannot refresh. Its 2026-08-10 frontend-only release is deployed as Firebase Hosting version `6b499ef514142a09`; Cloud Run is unchanged.
24. Commit `9a6260e` replaces repeated native confirmation popups with one accessible app dialog for consequential operations, removes redundant confirmation from four routine/reversible action groups, and protects confirmed network mutations against duplicate submission. Its 2026-08-11 frontend-only release is deployed as Firebase Hosting version `4766134daf955917`; Cloud Run is unchanged.
25. Commit `bcfb128` makes Management Analytics exceptions actionable into their collision-safe Review Record or valid attendance map point, clears conflicting filters during navigation, and raises essential map/Analytics labels to a tested 14px minimum. Its 2026-08-13 frontend-only release is deployed as Firebase Hosting version `c761984b7353028a`; Cloud Run is unchanged.

Current next priorities:

1. Run the full manual phone/browser workflow checklist against the live hosted path, including killed/refreshed cold offline launch, queued attendance replay, actual photo/signature streaming, and the waiting-service-worker update flow.
2. Before broader onboarding, replace Supervisor-chosen initial passwords with an expiring, single-use invitation and Worker password-setup flow. Email delivery requires a transactional email provider; another authenticated private delivery channel may be used if it is designed and audited explicitly.
3. Add a verified Monitoring notification channel and billing budget, replace the Neon owner runtime credential, verify pooling limits, and choose recovery beyond the current six-hour history window.
4. Resolve the development-only `brace-expansion`, `nanoid`, and `postcss` audit advisories and expand automated frontend/backend tests around the highest-risk Worker and Supervisor workflows.
5. Add a desktop-first payroll/admin portal section for pay-period worker hour summaries, exception flags, and payroll CSV export.

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

- A Supervisor can create and activate an invited Worker, and that Worker can sign in without using public self-registration.
- Before invited accounts are used beyond a controlled pilot, a Worker can set their own password through an expiring, single-use invitation instead of receiving a Supervisor-chosen password.
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
- Consent-based geofence arrival/departure reminders. Do not promise reliable background automatic check-in/out from the browser PWA; true background automation requires native platform capability, explicit permissions, anti-spoofing controls, and real-device battery/OS validation.
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
npm audit --omit=dev
npm audit
python -m pip check
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
