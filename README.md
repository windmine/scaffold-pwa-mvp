# Leader Field Operations

Mobile-first Report submission and review MVP for Leader Scaffolding-style operations.

The production-default interface is intentionally narrow: every active Worker can submit a supervisor-defined Report from a phone, including photos and handwritten signatures, then follow it through **Submitted**, **In review**, and **Resolved**. Supervisors review Reports, manage Report Templates, and manage Staff from phone or desktop widths. The broader geo-attendance, Daywork, Site, analytics, and audit modules remain in the repository behind a reversible interface flag; payroll remains planned. None is part of the current visible product flow.

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

The app started as a frontend-only prototype. It now uses FastAPI for authentication, versioned Report Templates (`WorkForm` internally), immutable Report submissions, verified uploads, staff management, durable Supervisor review, and exports. Retained backend modules also cover Sites, attendance, Task Logs, weekly Team Work Logs, audit history, and cross-device history sync.

`src/App.jsx` is not the current production UI path. The active app is `index.html` plus the modules in `assets/js/`.

Documentation map:

- [CONTEXT.md](CONTEXT.md): authoritative product language and module invariants.
- [Mobile and browser workflow checks](docs/mobile-browser-workflow-checks.md): automated, hosted, and real-phone validation checklist.
- [Production database and deployment runbook](docs/production-db-runbook.md): current live topology, migration, release, hardening, and rollback procedure.
- [Production upload recovery policy](docs/upload-recovery-policy.md): 30-day GCS soft-delete contract, targeted/bulk restore procedure, and recovery drill.
- [Payroll admin portal plan](docs/payroll-admin-portal-plan.md): planned Payroll scope; it is separate from implemented Management Analytics.
- [AGENTS.md](AGENTS.md): repository direction and working rules for coding agents.

## Current Working Tree - Report-Only Release Candidate

The working tree defaults to a report-only shell at phone and desktop widths. It has not been promoted to the live Firebase URL. The currently hosted version and its historical checks are recorded below; do not treat those August results as validation of this release candidate. Stage the coupled backend, migrations, and frontend only in an isolated preview until the remaining live-promotion gates pass.

On 2026-09-01, the local in-app browser passed the report-only route at 390 × 844: Worker submission without a Site, **My Reports**, Supervisor structured filters, **Start review**, required resolution-note validation, **Resolve report**, the final note returning to **My Reports**, and phone-width **Report Templates / Staff** navigation without horizontal overflow. The complete local candidate gate is green, including 33 Playwright workflows, backend migration/security/storage/workflow suites, a disposable-database smoke pass, production dependency audit, and Python dependency consistency. The hosted real-phone/upload/update pass remains pending.

Current release-candidate contract:

- Workers see only **New Report** and **My Reports**. Normal Workers and Leaders use the same visible Report flow.
- A Report requires a Report Date, may omit Site, can include up to 8 photos and configured handwritten signatures, and keeps an immutable Definition snapshot after submission.
- A Report moves forward only through **Submitted → In review → Resolved**. Resolution requires a final Supervisor note; legacy approval statuses are not Report workflow actions.
- Supervisors see only **Reports**, **Report Templates**, and **Staff**. Durable `report` purpose separates Reports from retained `daywork` templates/submissions, so Daywork is excluded from New Report, My Reports, Supervisor Reports, and Report exports.
- Collection CSV/PDF exports follow the structured workflow, Template, Worker, Report Date, and Department filters. Report exports show the Report workflow plus the final Supervisor note, reviewer, review-started time, and resolved time. The free-text **Find** field filters the visible list only.
- An already-open Worker page with its Report Template loaded can queue a Report while offline. Photo and signature upload progress, Worker ownership, capture time, and the client submission id persist across retries, so reconnecting or retrying does not create a second Report.
- The generated PWA still cold-launches its cached application shell. Report Templates and backend Report history remain network-only, so a killed offline launch can show locally queued Reports but cannot start a new Report unless its Template is available again after reconnect.
- A waiting service worker exposes **Update App**. The app saves the active Report draft before reload and pauses with **Try saving again** / **Keep editing** if local draft storage fails.

## Latest Deployed Reset Status - 2026-08-13

The reset goal is a reliable phone-first PWA with durable, explainable sync and review behaviour. The current local gate, historical real-phone local-network pass, and 2026-08-13 automated hosted release pass are green. The invited-account and cold-offline frontend is deployed, while the full hosted real-phone pass is still pending and the remaining provider hardening must be closed or accepted before real staff data is trusted to the service.

Completed in this reset:

- `npm run build` produces a `dist/` that serves the service worker, offline page, manifest, and icon assets from the paths used by the app.
- The service worker never returns cached `/api`, `/auth`, `/photo-uploads`, or `/uploads` responses as if they were fresh backend data.
- Current source returns the verified cached application for cold offline `/` and `/index.html` launches while leaving protected/API navigations network-only. The production service worker also precaches Vite's hashed JavaScript and CSS entrypoints instead of relying on a prior controlled reload.
- Successful authenticated Worker Site and attendance loads write separate IndexedDB snapshots keyed to that Worker and Department. Cold offline startup can use the Site snapshot for a new queued check-in and the sanitized attendance snapshot to restore the open check-in Site, expected action, recent-Site order, and compact-guide state. Another Worker, a Worker without a Department, demo data, and Supervisor scope cannot supply them. Logout, invalid authorization, or an observed account/Department scope change removes the applicable snapshots, and the backend remains authoritative when queued attendance syncs.
- Workers can complete check-in/out, Daywork logs, and work forms with signatures/photos on a phone, including graceful geolocation-denied and offline/queued states.
- Supervisors can review the resulting attendance, task logs, form submissions, photos, and signatures from the unified Review Queue.
- A browser/mobile validation checklist or automated check covers the main worker and supervisor paths.
- Supervisor changes have an audit-history API and visible dashboard section.
- The full manual phone/browser workflow checklist passed on a real phone on the local network on 2026-06-04.
- Backend schema changes now use versioned migrations recorded in `schema_migrations` instead of inline SQLite startup `ALTER TABLE` checks.
- Cloud Run `geo-backend` currently uses Neon PostgreSQL through Secret Manager-backed `DATABASE_URL` and `GEO_SECRET_KEY`; Cloud SQL remains the recommended Google-native production direction.
- The earlier Cloud SQL validation path passed its hosted smoke test on 2026-06-05 and had backups/PITR enabled. Those historical checks do not establish recovery readiness for the current Neon database.
- Cloud Run revision `geo-backend-release-20260804152130` serves 100% of live traffic as the dedicated `geo-backend-runtime` service account and stores new photos/signatures in private Cloud Storage bucket `geo-attendance-system-db9ca-uploads`.
- The runtime identity has secret-level access to only the two backend secrets and a prefix-scoped three-permission upload role. The default Compute service account is no longer a runtime credential and retains only `roles/run.builder` for source builds.
- The backend exposes `/health/ready`, renews cookie sessions through `POST /auth/refresh`, and has configurable in-process rate limiting for production-like environments.
- `npm run check:production-hardening` verifies the live Neon/GCP topology without mutating cloud resources: runtime identity and IAM, secrets, upload recovery settings/exact generations, hosted readiness monitoring, Cloud Run 5xx alerting, and current Neon recovery/cleanup evidence. It explicitly permits Console-only incidents during controlled testing; `npm run check:production-hardening:strict` requires verified alert delivery.
- The Daywork team-member picker click target now passes the Playwright mobile/browser workflow check.
- The backend smoke test now checks the current Firebase-compatible `__session` cookie rather than the legacy `geo_access_token` cookie.
- Upload storage now owns raster verification, adapter readiness, authorized streaming, and detached-file cleanup for both local disk and Cloud Storage.
- Offline Submission now owns Worker identity, capture time, stable client idempotency, replay state, and persisted partial uploads; attendance maps capture time to its occurrence timestamp and shared-device account changes cannot reassign queued records.
- Work Form content edits create new definition versions, submissions freeze immutable snapshots, and the backend derives authoritative time ranges and formulas.
- Review Queue policy, cursor queries, offline/read-only fallback, and exports are separate test surfaces. Dashboard totals and Management Analytics load complete durable overview data instead of the current filtered page.
- SQLAlchemy connection checkout uses `pool_pre_ping`, and protected Sites load only after login or session restoration succeeds.
- Public registration remains hidden in deployed commit `bcfb128` for the invited-account pilot. Supervisors create and activate Workers from Staff users; the verified-registration API remains implemented and tested for a later re-enable.
- The current Staff users flow is account provisioning, not a complete invitation handoff: the Supervisor must choose and communicate each initial password. There is no expiring, single-use invitation or Worker-set-password flow yet.
- Global-admin access is Supervisor-only. The Staff UI clears and disables it for Workers, authorization ignores invalid Worker flags, the API validates the final role/access combination, and migration `0017_global_admin_supervisor_invariant` revokes invalid legacy flags before enforcing the database invariant.
- On 2026-08-05, commit `9db3477` passed lint, production build/static PWA checks, Review Queue checks, all 27 Playwright workflows, the production dependency audit, Python dependency consistency, and the controlled production-hardening gate. The production-preview cold offline launch and queued-attendance regression passed locally.
- Local validation on 2026-08-04 passed lint, production build/PWA generation, Review Queue, all static/mobile checks, 26 Playwright browser workflows, backend database/security/upload/review/form/migration tests, the full disposable-database smoke test, production dependency audit, and Python dependency consistency.
- Local validation on 2026-07-31 passed lint, production build/PWA generation, Review Queue, all static/mobile checks, 25 Playwright browser workflows, backend compile, database, security, upload storage, Work Form definition, migration, and the full disposable-database smoke test.
- On 2026-07-31, `npm audit --omit=dev` found zero production dependency vulnerabilities and `python -m pip check` found no broken requirements. The full development audit found one high-severity `brace-expansion` advisory through ESLint/minimatch; update the development toolchain before treating dependency checks as completely green.
- The 2026-07-14 hosted deployment passed anonymous, worker, restored-session, repeated `/api/sites`, logout, supervisor Review Queue, readiness, and new-revision error-log checks without a 5xx.
- On 2026-07-15, a no-traffic Cloud Run identity canary passed database/upload readiness, then passed five hosted readiness calls after promotion and removal of the old identity's runtime access.
- On 2026-07-15, current source revision `geo-backend-release-20260715213211` passed a zero-traffic canary, ten post-promotion database/upload readiness checks across Cloud Run and Firebase Hosting, anonymous access isolation, and revision-scoped ERROR/5xx checks. The tested Firebase Hosting preview was then cloned byte-for-byte to live.
- On 2026-08-04, commit `38220e9` was pushed and deployed as Cloud Run revision `geo-backend-release-20260804152130`. Five candidate readiness cycles and ten post-promotion database/GCS readiness probes passed, the new revision had no observed ERROR or HTTP 5xx logs, and all temporary traffic tags were removed after promotion to 100%.
- Firebase Hosting preview `release-20260804152130` was verified before its exact version `6eea51a351ebab2b` was cloned live. Local, preview, and live SHA-256 hashes match for `index.html`, `sw.js`, `offline.html`, and `manifest.webmanifest`; invited-only login, hidden registration, anonymous Site isolation, Supervisor-only Global Admin controls, and logout passed the controlled hosted browser check.
- Firebase Hosting preview `release-20260805155240` was verified before exact version `ba8c1689c2d0e121` was cloned live for commit `9db3477`. Local, preview, and live SHA-256 hashes match for `index.html`, `sw.js`, `offline.html`, and `manifest.webmanifest`; the hashed JS/CSS entrypoints are in the deployed service-worker shell, five live readiness probes passed, invited-only/hidden-registration state remained correct, and anonymous Sites returned 401. This was a frontend-only release; Cloud Run remained unchanged.
- On 2026-08-07, commit `bbee643` passed lint, production build/static PWA checks, and all 28 Playwright workflows. Firebase Hosting preview `release-20260807120117` was verified before exact version `1e831c0aa589a08d` was cloned live. Local, preview, and live SHA-256 hashes matched: `index.html` `a0c8c1c16cdfb58fb29c0ef976ba8d7c645ffee20de5f7bd3e85df7f3f1dc004`, `sw.js` `ab4fa2b49094970b26d8e7eb41fe63a42c8a303c8c330429ee68e588b2a9149e`, `offline.html` `5034e9dd2d5df27e72c356632a8e984fa0ea389adfcf1870dafe0b3d64837ff2`, and `manifest.webmanifest` `24b60cb58ae8a220b51b3e52cc16aa0360d87f0f63f4e9c713fab0d6b990d35e`.
- The 2026-08-07 hosted pass verified the service-worker entrypoints and offline attendance snapshot, invited-only login with registration hidden, login before the install promotion, anonymous Sites returning 401, and five healthy readiness probes. This was a frontend-only release; Cloud Run remained unchanged.
- On 2026-08-10, commit `b2dec22` passed lint, production build/static PWA checks, all 28 Playwright workflows, Review Queue checks, the production dependency audit, Python dependency consistency, and the controlled production-hardening gate. Firebase Hosting preview `release-20260810172537` was verified before exact version `6b499ef514142a09` was cloned live. Local, preview, and live SHA-256 hashes matched: `index.html` `ba207851e18aca98c38d65de58846000d66a67d8e966a903683af4f15a1c4b3a`, `sw.js` `416375288e8623f514eeeee833b17661a84dcbbd5543f09e3fdb590964339fac`, `offline.html` `5034e9dd2d5df27e72c356632a8e984fa0ea389adfcf1870dafe0b3d64837ff2`, and `manifest.webmanifest` `24b60cb58ae8a220b51b3e52cc16aa0360d87f0f63f4e9c713fab0d6b990d35e`.
- The 2026-08-10 hosted pass verified the generated service-worker entrypoints and scoped offline snapshots, invited-only login with registration hidden, login before the install promotion, hidden-by-default Staff and Work Form creation panels, anonymous Sites returning 401, correct PWA cache headers, and five healthy readiness probes on both preview and live. This was a frontend-only release; Cloud Run remained unchanged.
- On 2026-08-11, commit `9a6260e` passed lint, production build/static PWA checks, all 28 Playwright workflows, Review Queue checks, the production dependency audit, Python dependency consistency, and the controlled production-hardening gate. Firebase Hosting preview `release-20260811125326` at `https://geo-attendance-system-db9ca--release-20260811125326-agkq8qbo.web.app` was verified before exact version `4766134daf955917` was cloned live. Local, preview, and live SHA-256 hashes matched: `index.html` `20720598a574dd734e7465039cf393a7747298d1b96e2f8f43c2ff9c5b10558a`, `sw.js` `b95e22af6eb580c6ed52594215dd9ccda6647eae1c8da44f137ee269472a0bb1`, `offline.html` `5034e9dd2d5df27e72c356632a8e984fa0ea389adfcf1870dafe0b3d64837ff2`, `manifest.webmanifest` `24b60cb58ae8a220b51b3e52cc16aa0360d87f0f63f4e9c713fab0d6b990d35e`, and `assets/js/confirmation-dialog.js` `f488758b9ce098c263f4727b091a5772f4cdf5cdbf01f7b27772e234f0f68f58`.
- The 2026-08-11 hosted pass verified all 47 generated app-shell paths plus `sw.js`, cache `leader-field-eada87cecf8c`, the confirmation-dialog module and both scoped offline snapshots, invited-only login with registration hidden, login before installation, anonymous Sites returning 401, correct PWA cache headers, and five healthy readiness probes on both preview and live. The full development audit reported three toolchain-only vulnerabilities—high-severity `brace-expansion` and `nanoid`, plus moderate-severity `postcss`—while the production audit remained clean. This was a frontend-only release; Cloud Run remained unchanged.
- On 2026-08-13, commit `bcfb128` passed lint, production build/static PWA checks, all 28 Playwright workflows, Review Queue checks, the production dependency audit, Python dependency consistency, and the controlled production-hardening gate. Firebase Hosting preview `release-20260813120158` at `https://geo-attendance-system-db9ca--release-20260813120158-1krt9yox.web.app` was verified before exact version `c761984b7353028a` was cloned live. Local, preview, and live SHA-256 hashes matched: `index.html` `e3e0068a0d40e37d3f2c5ecad352be404a9cecc91c358f0d31c96cfdb1b6df82`, `sw.js` `8f3a391469c4124f6cd7f6e1d501481fb2e0361a7bea5cb409f0cb8ab0380265`, `offline.html` `5034e9dd2d5df27e72c356632a8e984fa0ea389adfcf1870dafe0b3d64837ff2`, `manifest.webmanifest` `24b60cb58ae8a220b51b3e52cc16aa0360d87f0f63f4e9c713fab0d6b990d35e`, `assets/js/supervisor-analytics.js` `057f834252ea774535e61ebcea8d9b8b8f37b258959a0ef794c953c4f8494e86`, and `assets/css/styles.css` `2a1ccef893ad2ad70d1330a079827b81f940c55b1d4a76380c4c9478c89efb89`.
- The 2026-08-13 hosted pass verified all 47 generated app-shell paths plus `sw.js`, cache `leader-field-e356b5a2b972`, both scoped offline snapshots, invited-only login with registration hidden, login before installation, anonymous Sites returning 401, correct PWA cache headers, and five healthy readiness probes on both preview and live. Analytics exceptions open the exact collision-safe Review Record or valid attendance map point after clearing conflicting filters, and essential map/Analytics labels have a tested 14px readability floor at desktop and phone widths. The full development audit reported three toolchain-only vulnerabilities—high-severity `brace-expansion` and `nanoid`, plus moderate-severity `postcss`—while the production audit remained clean. This was a frontend-only release; Cloud Run remained unchanged.
- Cloud Monitoring now checks the hosted `/api/health/ready` path and has enabled incident policies for readiness failures and Cloud Run 5xx responses. A verified notification channel is still required for email/chat delivery.
- A 2026-07-15 Neon drill created a temporary read-only branch from a five-minute-old production point, verified the migration/schema surface, and proved exact branch cleanup. The current Neon Free plan still limits history to six hours and has no scheduled snapshot backup.
- The 2026-08-04 Neon release checks applied migration head `0017_global_admin_supervisor_invariant` to a disposable PostgreSQL branch before production, retained an expiring read-only pre-release branch through the observation window, and generated a fresh sanitized point-in-time recovery proof with exact cleanup verification.
- The upload bucket enforces public-access prevention, uniform bucket-level IAM, and 30-day soft delete. A production-bucket drill proved content-preserving delete/restore and cleanup.
- The 2026-08-13 controlled-test hardening gate passed with three warnings: incident-only Monitoring, six-hour Neon retention, and the skipped billing-budget check. The strict gate remains unsuitable for sign-off because no enabled, verified notification destination is attached.
- The 2026-08-13 live readiness responses report both database and GCS Upload Storage as healthy. Cloud Run remains on revision `geo-backend-release-20260804152130`, and Firebase Hosting version `c761984b7353028a` exactly matches the verified commit `bcfb128` build.

Next step:

Stage and verify the exact coupled commit in an isolated Firebase / Cloud Run / PostgreSQL preview, then run the full hosted real-phone checklist. Do not promote it live until the production-hardening evidence is current. The device pass must cover both Worker classes, the complete Supervisor phone-width flow, optional Site, all three Report workflow states, an offline queued Report with real photo/signature evidence, one-only replay after reconnect, authorized `/uploads/...` streaming, a killed/refreshed cached-shell launch, and the waiting-service-worker **Update App** flow. Before broader onboarding, add an expiring, single-use invitation so each Worker sets their own password; email delivery needs a transactional email provider, while another authenticated private delivery channel is possible if designed explicitly. Also add a verified Monitoring notification channel and billing budget, choose longer Neon recovery or external logical backups, complete Neon least-privilege access work, resolve the development-only npm advisories, and remove controlled test data.

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

### Current report-only interface

- Workers see **New Report**, **My Reports**, and their account/logout controls. Attendance, Daywork, weekly team logs, and missing-site controls are hidden.
- Supervisors see **Reports**, **Report Templates**, and **Staff**. Maps, analytics, Sites, audit/recovery, manual attendance, task-log entry, and the unrelated export workspace are hidden.
- Worker history and the Supervisor report queue request `purpose=report`. Retained Legacy Daywork templates and submissions do not leak into New Report, My Reports, Supervisor Reports, or Report collection exports.
- Supervisor **Reports** can be filtered by workflow (**Submitted**, **In review**, or **Resolved**), Report Template, Worker, and Report Date. Report CSV/PDF exports use those structured filters and Department focus; the free-text **Find** field filters the visible list only. Attendance and task-log exports remain hidden.
- **New Report** keeps the existing template-driven submission engine: Report Date is required, Site is optional, configured fields/signatures remain enforceable, photos are supported, drafts autosave locally, and queued submissions retain their stable replay key.
- **My Reports** shows the report workflow status, labelled submission time, Report Date, Site, submitted details/evidence, and the final Supervisor note after resolution.
- **My Reports** also shows device-local queued Reports. **Retry sync** reuses completed photo/signature uploads and the stable client submission id; **Discard local copy** removes only the unsynced device record.
- The broader field-operations modules and markup remain in the codebase behind `REPORT_ONLY_MODE` for a reversible rollback and continued regression coverage; their APIs and stored records are not deleted by this interface change.
- User-facing language uses **Report**, **Report Template**, **Submit Report**, **My Reports**, and **Report Date**. Existing `WorkForm`, `form_id`, `/work-forms`, and `/form-submissions` internals remain; `template_purpose` and immutable `submission_purpose` distinguish Reports from retained Daywork without renaming the existing tables.

### Worker

Worker accounts have two field classes:

- **Normal worker:** submit active department report templates and review their own reports.
- **Leader:** currently receives the same report-only navigation; the broader Leader capabilities remain retained but hidden.

During the invited-account pilot, a supervisor opens **Staff**, searches the existing list, and chooses **Add staff** to create and activate a Worker account. New Workers start as normal workers. A supervisor can promote or return a worker between Normal worker and Leader without changing the account's department or historical records. The current form requires the supervisor to choose the initial password and communicate it securely; Workers cannot yet complete an expiring invitation and set their own password.

All workers receive the report-only screen with **New Report** and **My Reports** navigation. They choose an active Department Report Template (`template_purpose=report`), complete its fields and evidence, submit it for review, and see only their own Report history.

Current visible Worker flow:

- Sign in with an invited backend account created and activated by a Supervisor.
- Choose an active Department Report Template. Archived Templates and Legacy Daywork templates are not offered.
- Choose a required Report Date and, when relevant, an optional Site. A no-Site submission stores `site_id=null` and is shown as `Unassigned site` rather than being blocked.
- Complete configured text, choice, checkbox, date, number, section, conditional, time-range, formula, repeat, and handwritten-signature fields. Browser calculations are previews; the backend stores authoritative duration/formula results.
- Add up to 8 JPEG, PNG, or WebP photos of at most 5 MB each. Required signatures must contain handwriting before submission.
- Let the Worker/Report Template draft autosave on this device, including Site, Report Date, answers, signatures, and photos. After reload or sign-in, reselect that Template to restore its matching draft. Logout and **Update App** both wait for unsaved input; the update pauses instead of discarding work when local storage fails.
- Submit online or, from an already-open page with its Template loaded, queue the Report while offline. Queued evidence uploads resume from persisted partial progress, remain bound to the capturing Worker, and reuse one stable client submission id.
- Use **My Reports** to search by Template/answer/status, filter by **Submitted**, **In review**, **Resolved**, **Queued**, or local Report Date, open photo/signature evidence, retry a failed queue item, or discard only its unsynced local copy.
- After resolution, read the final Supervisor note. Submitted Report content is immutable and Workers cannot edit or delete the durable Report.

Retained full-interface capabilities, hidden in the current shell, include geolocation attendance, Daywork, weekly team logs, missing-Site creation, and their combined history. Their APIs and regression tests remain available for rollback; they are not steps in the current Worker phone flow.

Worker restrictions:

- Normal workers cannot create sites, task logs, or weekly team logs. They can submit active Department Reports from active Report Templates.
- Workers cannot edit or delete submitted task logs.
- Workers cannot edit or delete attendance after it is approved or rejected.
- Resigned workers cannot sign in.

### Supervisor

Current visible Supervisor flow:

- Sign in and land on **Reports**. At phone width, use the Workspace drawer to switch only among **Reports**, **Report Templates**, and **Staff**.
- Search the Report list by Worker, Template, or answer and filter the server result by **Submitted**, **In review**, or **Resolved**, Report Template, Worker, and exact Report Date. Department-scoped Supervisors stay fixed to their Department; Global Admins may change Department focus.
- Select a Report to inspect its immutable Site, Report Date, Definition snapshot, answers, photos, and handwritten signatures.
- Move a **Submitted** Report to **In review**, then resolve an **In review** Report with a required final Supervisor note. The workflow is forward-only and does not expose legacy Approve, Reject, Edit, or rubbish-bin actions while recovery is hidden.
- Export one selected Report as HTML, PDF, or a CSV row. Export the current structured Report collection as CSV or PDF; exports use the Report workflow and include the final review details. Free-text **Find** is list-only.
- Create, preview, edit, version, archive, and reactivate Report Templates. Existing Reports retain the exact Template snapshot used when they were submitted.
- Create Worker or Supervisor accounts, search/edit Staff, set Worker class, reset passwords, and resign/reactivate accounts within the signed-in Supervisor's access scope. Global-admin access remains Supervisor-only.

Retained full-interface capabilities, hidden in the current shell, include attendance/task/team-log approval, manual corrections, Sites, maps, Management Analytics, the general export workspace, Audit history, and rubbish-bin recovery. Their routes and regression coverage remain in the repository but are not part of the report-only Supervisor phone workflow.

### PWA / Mobile UX

- Vite HTTPS dev server for geolocation-friendly phone testing.
- Same-origin `/api` proxy to avoid iOS mixed-content blocking.
- Visible Download App button with browser install prompt or Add-to-Home-Screen fallback instructions.
- Service worker app shell cache generated from one shared asset manifest with a content-derived cache name.
- Cached production-app cold launch for installed Workers, with the static offline page reserved for an incomplete/corrupt shell cache. Protected Report Template/history/API/upload responses remain network-only.
- IndexedDB Report drafts and queued submissions, including photos, nested handwritten-signature data, partial-upload progress, Worker ownership, and replay idempotency. The retained interface also supports queued attendance and task logs.
- Mobile-first Worker tabs and a phone-width Supervisor Workspace drawer.
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
    upload-recovery-policy.md          GCS soft-delete and restore contract

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
      i18n.js                 English/Chinese UI catalogue and language switching
      mock-api.js             Offline/local fallback data
      offline-submissions.js  Offline submission queue and sync module
      photo-viewer.js         Photo thumbnail and zoom viewer module
      site-map-picker.js      Shared Site coordinate/radius map picker
      staff-sites.js          Supervisor staff, site, and form admin module
      supervisor-review.js    Supervisor Review Queue state and interaction module
      supervisor-review-utils.js Complete Review Queue overview and rendering helpers
      review-export-adapters.js Review Record export adapters
      supervisor-map.js       Supervisor map/location review module
      supervisor-analytics.js Management analytics module
      team-member-picker.js   Searchable team member selector for team logs and Daywork rows
      team-work-log.js        Weekly multi-member team log module
      ui-feedback.js          Local validation, busy, banner, and toast feedback
      utils.js
      worker-attendance.js    Worker attendance capture module
      worker-form.js          Worker dynamic form submission module
      worker-log.js           Worker Daywork log submission module
      worker-sites.js         Worker missing-site creation module
      work-form-builder.js    Accessible card-based Work Form Definition builder
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
        registration.py       Dormant verified-registration and activation flow
        staff_site_admin.py   Staff user and site admin use cases
    database_test.py          SQLAlchemy pool health regression script
    migration_test.py         Migration workflow regression script
    report_purpose_test.py    Report/Daywork API-boundary regression script
    report_workflow_test.py   Report review-state/ownership regression script
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

The SQLite database is local runtime data and must stay untracked. A fresh clone
creates its schema through the normal migration/startup flow.
The legacy `src/` React scaffold is not a build input, so React tooling is not
installed for the active application.

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
BUSINESS_TIMEZONE=Pacific/Auckland
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

`BUSINESS_TIMEZONE` must be an IANA timezone name. Attendance Review Queue and
export date filters interpret occurrence timestamps in this timezone.

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
3. Store `DATABASE_URL`, `GEO_SECRET_KEY`, and other runtime secrets in Secret Manager. SMTP is not needed only for the current Supervisor-set-password account flow. Verified email registration or a single-use email invitation requires a transactional email provider and protected credentials.
4. Configure Cloud Storage uploads, keep the bucket private, and grant the Cloud Run service account object create, read, and delete access for the configured prefix.
5. Deploy the FastAPI backend to Cloud Run and attach Cloud SQL.
6. Run migrations and the mutating backend smoke test against a disposable staging database/service; use controlled non-seeding checks against production.
7. Build and deploy Firebase Hosting.
8. Run `npm.cmd run check:mobile` locally and the manual phone checklist against the hosted URL.

Build and deploy the backend service first:

```powershell
gcloud config set project geo-attendance-system-db9ca
$stamp = Get-Date -Format "yyyyMMddHHmmss"
gcloud run deploy geo-backend --source . --region australia-southeast1 `
  --revision-suffix "release-$stamp" --no-traffic --tag "candidate-$stamp" `
  --service-account geo-backend-runtime@geo-attendance-system-db9ca.iam.gserviceaccount.com `
  --build-service-account projects/geo-attendance-system-db9ca/serviceAccounts/794826041820-compute@developer.gserviceaccount.com `
  --allow-unauthenticated
```

Before deploying, inspect `gcloud meta list-files-for-upload`; `.gcloudignore` and `.dockerignore` must keep local databases, uploads, environment files, and Python bytecode out of the build. Set Cloud Run environment variables from `.env.firebase.example`, preserve the Secret Manager bindings and resource limits, verify the tagged candidate, and then move 100% traffic to the exact verified revision. The current live service stores `DATABASE_URL` and `GEO_SECRET_KEY` in Secret Manager, points `DATABASE_URL` at Neon PostgreSQL, and uses Cloud Storage for uploaded photos/signatures.

The production Docker container starts Uvicorn only and keeps `AUTO_MIGRATE=false`; run `python -m app.migrations` explicitly against the verified database before deploying its compatible revision. This prevents a no-traffic Cloud Run candidate from changing production schema during startup. FastAPI readiness still verifies database access and the configured upload adapter lifecycle before the revision is accepted.

The shared SQLAlchemy engine enables `pool_pre_ping`, so each pooled database connection is checked when Cloud Run reuses it. If managed PostgreSQL or Neon has closed an idle SSL connection, SQLAlchemy discards that connection before the API query instead of returning a transient 500.

Use the production database runbook before changing the live managed-PostgreSQL target, Cloud Run revision, or traffic split:

```text
docs/production-db-runbook.md
```

Then build and deploy Hosting:

```powershell
npm.cmd run build
npx -y firebase-tools@latest hosting:channel:deploy release-YYYYMMDD-HHMMSS --expires 1d --project geo-attendance-system-db9ca
npx -y firebase-tools@latest hosting:clone geo-attendance-system-db9ca:release-YYYYMMDD-HHMMSS geo-attendance-system-db9ca:live --project geo-attendance-system-db9ca --non-interactive
```

`firebase.json` rewrites `/api/**` and `/uploads/**` to the `geo-backend` Cloud Run service. FastAPI strips the `/api` prefix at runtime so existing routes like `/auth/login`, `/attendance`, and `/supervisor/audit-events` continue to work behind Firebase Hosting. Uploaded files keep stable `/uploads/...` URLs; the backend authorizes the metadata before streaming private content from the selected adapter.

Firebase Hosting only forwards the special `__session` cookie to rewritten Cloud Run backends. Keep the HttpOnly auth cookie named `__session`; the readable CSRF cookie is only used by the browser to send the `X-CSRF-Token` header.

Production hardening checks are read-only and can be run from a machine authenticated with `gcloud`:

```powershell
npm run check:production-hardening
npm run check:production-hardening:strict
```

The first command carries the repository's explicit controlled-test exception for Console-only Monitoring incidents. Use the strict command before real production use; it fails until a verified notification channel is attached to both policies.

To include budget-alert verification, pass the billing account directly to the script:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\check-production-hardening.ps1 -BillingAccount 000000-000000-000000
```

The checks cover the live serving revision, identity/IAM, Secrets, upload recovery configuration and exact proof generations, recent hosted readiness, exact alert semantics, current Neon recovery evidence/branch absence, and optional budgets. They do not establish Neon least-privilege roles, pooling limits, or a recovery window longer than the provider currently supplies.

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

The current shell exposes Worker Reports, Supervisor Reports, Report Templates, and Staff. The attendance/Daywork/team sections below are retained reference workflows and require the full-interface test override.

### Retained Worker Attendance

1. Sign in as a worker.
2. Select a site.
3. Capture location.
4. Check the live site-radius preview before submitting.
5. Add optional notes/photo.
6. Check in or check out.
7. History shows the backend-synced record and whether it was inside the site radius.
8. Inside-site attendance is approved automatically.
9. Outside-site attendance stays pending and can be edited or deleted until supervisor approval/rejection.

### Retained Worker Daywork Log

1. Open the Log tab or the Daywork log quick action.
2. Select a site.
3. Set the work date.
4. Fill in the active Daywork log form fields.
5. Complete any required signature or time-range fields.
6. Select one or more progress photos from the phone photo picker.
7. Submit the Daywork log.
8. Daywork logs are saved as pending form submissions for supervisor approval.
9. Photos can be opened in the floating photo viewer with their recorded taken time when available.

### Retained Worker Missing Site

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

### Worker Reports

1. Open **New Report**.
2. Choose a **Report Template**.
3. Choose the required **Report Date** and, when relevant, an optional Site.
4. Fill in the Report fields.
5. Select optional photos from the phone photo picker.
6. Wait for the inline `Saved at...` receipt when you need confirmation that the current draft is protected on this device.
7. Choose **Submit Report**. A successful online or queued submission clears only this Worker/Report Template draft.
8. The Report starts as **Submitted** and appears in **My Reports** and Supervisor **Reports**. Its workflow can then move to **In review** and **Resolved**; a resolved Report shows the final Supervisor note.

For an offline replay check, load the Template while online, keep the page open, switch the device offline, and submit the Report. **My Reports** should show **Queued**. Reconnect as the same Worker and choose **Retry sync** if automatic sync does not run; completed photo/signature uploads and the original client submission id must be reused, producing exactly one durable Report. A killed offline launch restores the cached shell and local queue/history, but Report Templates are network-only and a new Report cannot begin until reconnect.

Built-in seeded examples:

```text
Daywork log form
Inspection form
Tool deduction form
```

### Retained Leader Weekly Team Log

1. A supervisor sets the staff account's Worker class to **Leader**.
2. The leader opens the Team tab and selects the Monday starting the work week.
3. Search and select one or more members in each row. The selected members share that row's date, site, start, finish, break minutes, and completed-work description.
4. Add another row whenever the selected group changes site, shift, or activity. Members are not permanently assigned to one leader and may appear in different Leaders' logs.
5. Submit the weekly log. The backend calculates row hours, supports overnight work periods, totals the log, and places it in the supervisor Review Queue.
6. A supervisor approves or rejects the team log like other review records.

Each weekly log accepts up to 150 work rows. The week must start on Monday and each row date must be inside that seven-day period.

### Supervisor Report Template Builder

1. Sign in as supervisor.
2. Open **Report Templates**.
3. Review the saved-template list, choose **Add Report Template**, then enter the Template name and optional description.
4. Choose **Add field**, then set the card's field type, worker-facing label, and required state. Choice fields expose their options; repeating groups expose row limits and nested field cards.
5. Turn on **Only show in some cases** to select an earlier field, comparison, and value. Conditions and formulas can reference only earlier fields in the same form or repeating group.
6. Drag a card by its handle, or use its Move up/down buttons. Preview the Report, then choose **Create Report Template**. Editing an existing Report Template opens the same card builder and preserves its stable field keys.

The routine workflow does not require syntax. For definitions that need direct source editing, open **Advanced: edit raw field syntax**. Raw changes are staged until **Apply syntax** is selected; preview and save remain blocked while unapplied raw changes exist. The compatibility format is:

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

Supported field types are `section`, `repeat`, `text`, `textarea`, `number`, `date`, `time_range`, `select`, `checkbox`, `formula`, and `signature`. Prefix repeat children with `>`. Later columns may contain `id=result`, `show_if=result=Fail`, `min=1`, or `max=12`. Labels cannot contain `|`, and choice options cannot contain commas or `|` because those characters delimit the raw compatibility format. A required signature uses a touch-friendly pad and uploads a PNG. The browser previews formulas, but the backend revalidates source answers and stores authoritative time-range durations and formula results. Content edits increment the Definition version; every submission retains an immutable Definition snapshot, so archive/reactivate or later edits cannot relabel history.

### Supervisor Report Review

1. Sign in as a Supervisor. At phone width, open **Workspaces** and confirm only **Reports**, **Report Templates**, and **Staff** are offered.
2. Open **Reports** and use **Find** for the visible list or the structured workflow, Report Template, Worker, and Report Date filters for the server result. **Find** is intentionally not an export filter.
3. Select a **Submitted** Report and inspect its optional Site, required Report Date, frozen Template fields, answers, photos, and signatures. Confirm Approve, Reject, and Edit are absent.
4. Choose **Start review**. The Report leaves a Submitted-only filter and appears under **In review**.
5. Choose **Resolve report**. An empty resolution note must be rejected and focused; a non-empty final note moves the Report to **Resolved**.
6. Sign in as the Worker and confirm **My Reports** shows the same status and final Supervisor note.
7. Export the selected Report as HTML, PDF, or CSV. Export the collection as Reports CSV/PDF and confirm the structured filters, including Department focus, are applied.
8. Open **Report Templates** to create, preview, edit/version, archive, and reactivate a Template. Reopen an older Report and confirm it still uses its submitted Definition snapshot.
9. Open **Staff** to search, add, edit, resign, and reactivate controlled accounts. The current provisioning form requires the Supervisor to set the initial password.

### Retained Full-Interface Supervisor Review

1. Sign in as supervisor.
2. On desktop, use the sticky Admin workspace navigation to jump between review, reporting, record-entry, and management sections. Selecting a folded section opens it automatically.
3. Use the Review Queue as the durable feed for outside-site attendance, Task Logs, weekly Team Work Logs, and Work Form Submissions. Pending is the decision workload; approved and rejected history remain queryable.
4. Filter by worker/site text, record type, status, or date.
5. Check worker, site, timestamp, location/site radius where applicable, notes, photos, and signatures.
6. If a worker forgot to check in or out but performed the work, open Add missed check in / check out, choose the worker/site/type/original time, enter the reason, and complete the in-app confirmation for creating an immediately approved record without Worker GPS evidence.
7. Open Submit approved log to enter a task log for yourself or another accessible user, complete the in-app confirmation, and confirm it appears immediately as approved.
8. Use Move to bin on an incorrect attendance, Task Log, Work Form Submission, or weekly Team Work Log, enter the reason, and complete the in-app data-loss confirmation.
9. Open Rubbish bin to restore a record within 30 days. Restore is immediate and does not ask for a redundant confirmation; expired records are permanently removed automatically.
10. Approve or reject pending review records.
11. Open Maps and location review, inspect site boundaries and outside-site points, and filter recorded location history by worker, site, status, or date.
12. Optionally connect recorded points to compare event order. These straight lines are not continuous travel tracking or road routes.
13. Open Management analytics and review trends, exceptions, site productivity, and form-response summaries for 7, 30, 90, or all available days. Open an exception in its exact Review Record; for attendance with valid coordinates, open its exact map point. These actions clear conflicting filters and still reach Analytics records outside the first Review Queue page. Confirm recent open check-ins are not marked missing until they are at least 12 hours old.
14. Export the management summary as CSV or print-ready HTML. Logged task hours remain separate from payroll-approved hours.
15. After filtering or paging Review Queue, confirm dashboard totals and Management Analytics still reflect the complete authorized data set.
16. Use edit controls for durable submitted records only after the in-app dialog explains their audit and reporting impact. Ordinary pending-attendance and reusable Work Form saves proceed directly from their explicit Save button.
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

Public self-registration is temporarily hidden during the invited-account pilot. Supervisors create and activate pilot users from Staff users. The registration endpoints remain callable for a later re-enable, but they are not exposed in the UI or supported as the current pilot onboarding path. They implement three API steps plus Supervisor activation:

1. `POST /auth/registration/start` sends a six-digit email verification code.
2. `POST /auth/registration/verify` verifies that code and returns a short-lived registration token plus the active department choices.
3. `POST /auth/register` accepts the registration token, password, and selected `department_id`, then creates the worker with `resigned` status.
4. A supervisor reviews and reactivates the worker before the worker can sign in.

Verification codes expire, are attempt-limited, and cannot be reused. In local development, `REGISTRATION_EXPOSE_CODE=true` returns `dev_verification_code` so the dormant flow can be tested without SMTP. Production never exposes the code; configure `SMTP_HOST` and `SMTP_FROM_EMAIL` before verified email registration is exposed again.

The active Staff users flow is not yet a true invitation handoff: the Supervisor supplies the initial password. To remove that manual password step, add expiring, single-use invitation records plus a Worker password-setup page and endpoint. Deliver the token through transactional email or another authenticated private channel; do not put reusable or long-lived credentials in the invitation.

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

- Leaders can create and view their task logs. Normal workers cannot create task logs; Work Form reporting remains available separately.
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

Attendance, Task Logs, Work Form Submissions, and weekly Team Work Logs require a deletion reason and an in-app confirmation before entering the rubbish bin. Deleted records are hidden from Worker history, Review Queue, maps, analytics, and exports. They remain directly restorable for 30 days; startup/hourly cleanup then permanently removes them and cleans up any newly unreferenced uploads.

### Worker Task Templates

```text
GET    /task-templates
POST   /task-templates
PATCH  /task-templates/{template_id}
DELETE /task-templates/{template_id}
```

### Worker Reports

```text
GET  /work-forms?purpose=report
POST /form-submissions
GET  /my-form-submissions?purpose=report
```

Rules:

- Every active Worker sees active `report` purpose Templates in their Department and can submit Reports from them. Archived Templates and Legacy Daywork remain hidden from the report-only query and cannot be transitioned as Reports.
- Reports support typed answers and up to 8 uploaded image URLs.
- `client_submission_id` is stable across replay and unique for that Worker; the submission also stores immutable `submission_purpose=report` plus the Definition version/snapshot used for server validation and derivation.
- New Reports require `work_date`, may omit `site_id`, and start with `workflow_status=submitted`. **My Reports** uses the report workflow (`submitted`, `in_review`, `resolved`) rather than the retained legacy approval status.

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

GET   /supervisor/review-queue?purpose=report&workflow_status=&kind=form&form_id=&worker_id=&record_date=&page_size=&cursor=
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
GET   /supervisor/form-submissions/export.csv?purpose=report
GET   /supervisor/form-submissions/export.html?purpose=report
GET   /supervisor/form-submissions/export.pdf?purpose=report&template=submitted-form
GET   /supervisor/form-submissions/export.pdf?template=daywork
GET   /supervisor/form-submissions/{submission_id}/export.csv
GET   /supervisor/form-submissions/{submission_id}/export.html
GET   /supervisor/form-submissions/{submission_id}/export.pdf?template=submitted-form
GET   /supervisor/form-submissions/{submission_id}/export.pdf?template=daywork
POST  /supervisor/form-submissions/{submission_id}/transition
POST  /supervisor/work-forms
PATCH /supervisor/work-forms/{form_id}
```

`/supervisor/review-queue` is the preferred cursor-paginated query endpoint. Report-only callers pass `purpose=report`, which filters both the visible page and its matching counts without changing the retained complete Review Queue used by the full-interface override. `/supervisor/review-records` remains the compatibility feed and legacy decision path, but legacy decisions reject `report` submissions and continue only for attendance, task, Legacy Daywork, and team-log records. `/supervisor/audit-events` returns recent change events with actor, access level, action, target, summary, and before/after snapshots. HTML exports are standalone print/save-as-PDF files; report exports use the Report workflow and final review details, while retained Daywork exports keep their legacy lifecycle.

Report submissions carry immutable `submission_purpose=report` and a forward-only `workflow_status`: `submitted`, `in_review`, then `resolved`. `POST /supervisor/form-submissions/{submission_id}/transition` is separate from the legacy Review Record approval policy and rejects Legacy Daywork. It permits only `submitted → in_review` and `in_review → resolved`; resolution requires a non-empty Supervisor note. Each transition is an atomic, department-authorized update with its own audit event, so a stale concurrent Supervisor action cannot overwrite the winning transition. Responses and exports include the reviewing Supervisor, review-started time, resolved time, and Supervisor note. Submitted purpose, Site, Report Date, answers, photos, and nested signatures are immutable. Legacy approval endpoints and Supervisor-created form-submission endpoints reject Reports instead of bypassing or impersonating the Worker workflow.

`POST /supervisor/task-logs` accepts a selected user, site, work date, task summary, optional hours, and optional safety notes. The selected user may be the signed-in supervisor or another department-accessible user. These records are created as `approved`, marked `supervisor_manual`, and do not require a review decision.

Supervisor edit/archive routes require `confirmed: true` in the request body.

`is_global_admin=true` is valid only when the account's final `role` is `supervisor`. Create/update requests that would leave a Worker with global access return `400`; non-global supervisors attempting to grant the flag return `403`. An authorized global admin may atomically change another global Supervisor to a Worker only by setting `is_global_admin=false` in the same update.

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

### Report Submission (`WorkFormSubmission` internally)

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

### Supervisor Report Template (`WorkForm` internally)

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

Dependency checks:

```powershell
npm.cmd audit --omit=dev
npm.cmd audit
python -m pip check
```

Production hardening gate:

```powershell
npm.cmd run check:production-hardening
npm.cmd run check:production-hardening:strict
```

The hardening commands are read-only and require authenticated `gcloud` and Neon CLI access. The normal command carries the controlled-test incident-only exception; the strict command requires verified alert delivery. Neither establishes Neon least-privilege roles, pooling limits, or longer backup retention.

Latest frontend release check on 2026-08-13:

- Commit `bcfb128` passed lint, production build/PWA generation, Review Queue checks, and all 28 Playwright workflows before deployment.
- Production npm dependencies reported zero vulnerabilities and Python dependencies were consistent. The full development audit reported three toolchain-only vulnerabilities: high-severity `brace-expansion` and `nanoid`, plus moderate-severity `postcss`.
- Firebase preview `release-20260813120158` and live Hosting version `c761984b7353028a` matched the verified local build across all 47 generated app-shell paths plus `sw.js`; the six named hashes are recorded in the current reset status above.
- Five preview and five live `/api/health/ready` probes reported database and GCS as healthy. Anonymous Sites returned 401, invited-only login remained visible with registration hidden, the login form preceded the install promotion, and the deployed service worker contained its hashed entrypoints and scoped offline snapshots. Local Playwright coverage verified exact Analytics-to-Review/map navigation after conflicting filters, collision-safe record identity, coordinate validity, and the 14px map/Analytics label floor at desktop and phone widths; no authenticated hosted mutation was performed.
- The controlled-test production-hardening gate passed with three warnings; the strict gate still fails because no enabled, verified Monitoring notification channel is attached. Cloud Run revision `geo-backend-release-20260804152130` remains unchanged at 100%.

Current report-only local validation on 2026-09-01:

- The in-app browser passed the production-default Worker/Supervisor route at 390 × 844, including no-Site submission, private **My Reports**, structured Supervisor filters, both workflow transitions with required final-note validation, final-note visibility for the Worker, and phone-width Report Template/Staff navigation without horizontal overflow.
- `npm.cmd run check:mobile` regenerated the production PWA and passed its static preflight plus all 33 Playwright Chromium workflows. New regressions prove offline **My Reports** excludes retained Daywork/stale synced copies, explicit durable Report purpose wins even when a Template name contains “Daywork”, and report-only automatic/manual replay leaves hidden attendance, task, and Daywork queue items untouched. The generated source cache is `leader-field-3cd03e38848b`.
- The complete local candidate gate passed: lint/build, Review Queue/Report purpose/workflow checks, database/security/upload/Definition/migration suites, backend compile, a disposable-database smoke pass, production npm audit with zero findings, and Python dependency consistency. The full development npm audit still reports the known toolchain-only `brace-expansion`, `nanoid`, and `postcss` advisories.
- The controlled production-hardening check is not green for live promotion: it reports insufficient recent multi-region uptime evidence, a migration-head mismatch in the Neon recovery proof, and stale/strictly invalid upload-recovery proof. It also warns that no verified notification destination exists and that the billing-budget check was skipped.


`npm.cmd run check:review-queue` verifies Review Record export dispatch, durable-only export guards, cursor pagination, query filters and snapshots, department scope, atomic pending-only decisions, audit comments, decision-bypass protection, and the focused Report submission/review contract. The Report checks cover normal-Worker submission, private My Reports history, optional Site, replay deduplication, archived templates, Department-scoped Supervisors, immutable content, required resolution notes, invalid transitions, audit history, and concurrent Supervisor actions.

`npm.cmd run check:mobile` first builds the production PWA, runs the static PWA/mobile preflight, and then runs 33 Playwright Chromium workflow checks at a default 390 × 844 mobile viewport. The report workflow verifies the production-default Worker and Supervisor navigation, report-only filters, required Report Date, optional Site, normal-Worker submission, private history, forward-only Supervisor transitions, final note, and phone-width Template/Staff access. Focused replay checks prove a Report with one photo and two nested signatures resumes after a partial upload failure, reuses completed uploads and its client submission id on a forced second replay, appears exactly once in **My Reports**, and does not replay hidden legacy record types in report-only mode. Additional boundaries cover offline private history and explicit Report purpose overriding legacy name heuristics. The retained full-interface checks use a test-only pre-load override so attendance, Daywork, weekly logs, maps, analytics, and other reversible modules keep regression coverage while remaining hidden in the shipped shell. The browser check starts a temporary backend, a lightweight Node source/proxy server, and a Vite production preview on `127.0.0.1:8765`, `127.0.0.1:5175`, and `127.0.0.1:4175`, with a throwaway SQLite database and upload folder. The source server preserves shared unbundled-module state without relying on Vite's development watcher, and the runner fails immediately with recent process output if a managed server exits. Override those ports with `BROWSER_WORKFLOW_BACKEND_PORT`, `BROWSER_WORKFLOW_FRONTEND_PORT`, or `BROWSER_WORKFLOW_PREVIEW_PORT` if needed.

`backend/database_test.py` poisons a returned pooled connection and proves the next query succeeds through `pool_pre_ping`. `backend/upload_storage_test.py`, `backend/work_form_definition_test.py`, `backend/report_purpose_test.py`, `backend/report_workflow_test.py`, and `backend/review_queue_test.py` are the focused local/GCS storage-contract, immutable Definition/server-formula, Report-versus-Daywork boundary, Report workflow, and Review Queue policy/query/export test surfaces.

PWA shell assets are maintained in `scripts/pwa-shell-assets.mjs`. `sw.js` is generated by `npm.cmd run generate:pwa`; do not edit its asset list or cache name by hand. `npm.cmd run build`, `npm.cmd run dev`, `npm.cmd run dev:phone`, and `npm.cmd run check:mobile` invoke the generator before using the service worker. When report UI, translation, JavaScript, CSS, icon, or other shell files change, keep the shared asset manifest current and regenerate before testing or deployment. The source cache name is derived from the listed app-shell contents; the production build then adds the hashed JavaScript/CSS entrypoints referenced by `dist/index.html` and derives the deployed cache name from the completed `dist/` shell.

Backend import check:

```powershell
python -m compileall backend\app backend\smoke_test.py backend\database_test.py backend\migration_test.py backend\report_purpose_test.py backend\report_workflow_test.py backend\review_queue_test.py backend\work_form_definition_test.py backend\upload_storage_test.py backend\security_test.py
python backend\database_test.py
python backend\security_test.py
python backend\upload_storage_test.py
python backend\review_queue_test.py
python backend\work_form_definition_test.py
python backend\report_purpose_test.py
python backend\report_workflow_test.py
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
- Invited-account guidance is visible and public registration remains hidden.
- Generated PWA app-shell manifest, copied build assets, and service-worker cache name stay in sync.
- Service worker network-only API/upload rules.
- Report-only Worker and Supervisor navigation at a 390 × 844 viewport, with hidden full-interface workspaces inaccessible.
- Required Report Date, optional Site, Report workflow filters/transitions, immutable evidence, and final Supervisor note.
- Report photo/nested-signature partial-upload resume and exactly-once replay.
- Production-preview cold offline launch, Worker/Department Site-snapshot isolation, and creation of a queued attendance record after closing the last app page.
- Visible service worker update-flow wiring.
- Mobile viewport, camera/photo inputs, and active worker/supervisor UI controls.
- Supervisor audit-history UI/API wiring.
- Retained full-interface behavior under an explicit test-only override.

Manual phone/browser checks are listed in `docs/mobile-browser-workflow-checks.md`.

## Offline Behavior

The frontend uses IndexedDB for Report drafts and queued Offline Submissions. Internally, the same module also owns the retained attendance and Task Log paths. It owns the capturing Worker, capture time, stable client submission id, photo/signature uploads, replay state, partial-upload state, and authentication-blocked state rather than asking each form to coordinate them separately.

```text
Online:
  Save the Report locally, upload photos/signatures, and send it to FastAPI.

Offline:
  From an already-open page with its Template loaded, save the Report with syncStatus=queued.

Back online:
  Resume unfinished evidence uploads, submit once to FastAPI, and update My Reports.
```

Report signatures, including signatures inside repeat rows, are stored locally as image data while queued, then uploaded as PNG during sync. A queued Report remains bound to the Worker account that captured it; switching accounts on a shared device cannot replay or display it as the new Worker. Capture time and client submission id survive delayed sync, the backend returns the existing Report on an idempotent retry, and each successful partial-upload URL is persisted so it is not uploaded again. If the session expires, sync pauses and keeps the queue item until its owning Worker signs in again. Failed items show their error in **My Reports** with **Retry sync** and **Discard local copy**.

The generated service worker can cold-launch the cached application shell, while API, auth, Template, Report-history, and upload routes stay network-only. With a saved Worker identity, a killed offline launch can show the report-only shell and that Worker's local queued Reports. Report Templates are not currently snapshotted for cold-start authoring, so load the Template before going offline and keep the page open if a new Report must be queued. Starting a new Report after a killed/refreshed offline launch waits for reconnect. The retained full-interface mode separately snapshots Worker/Department Sites and attendance context for its automated cold-offline attendance regression.

Current offline behavior is suitable for MVP testing, but production conflict handling still needs more work.

## Date Filtering

**My Reports** filters Report Date as the Worker's local calendar date. Retained Worker History uses the same local-calendar rule; retained Supervisor attendance Review Queue and export boundaries use `BUSINESS_TIMEZONE` (default `Pacific/Auckland`) so UTC storage does not shift morning New Zealand records onto the previous business day.

## Photo Behavior

- Attendance supports one optional photo.
- Task logs and Reports support up to 8 progress photos.
- Uploads are limited to 5 MB each. The Worker UI accepts JPEG, PNG, and WebP and validates type/size before queueing; the backend identifies decoded raster content rather than trusting the caller's filename or MIME type and re-encodes accepted images to remove metadata and trailing payloads.
- New attendance, Task Log, and Report evidence references must exist in Upload Storage and belong to the authenticated uploader. Supervisor corrections may retain evidence already attached to that record.
- Uploaded photos are served from `/uploads/...`.
- The backend checks ownership/record references before opening a local file or Cloud Storage stream and sends `X-Content-Type-Options: nosniff`.
- Thumbnails open in a floating photo viewer.
- Multi-photo task logs support previous/next navigation in the viewer.
- Local development stores uploads under `backend/uploads/`.
- Live Cloud Run stores new uploads in private Cloud Storage bucket `geo-attendance-system-db9ca-uploads` and serves them back through the backend.
- Files detached by record edits or hard deletion are deleted once no attendance, task-log, or Report submission references remain. Files in the rubbish bin remain available until the 30-day record purge.

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

- Replace Supervisor-chosen initial passwords with an expiring, single-use Worker password-setup invitation before onboarding beyond controlled pilot accounts.
- Deploy and complete the full report-only real-phone hosted checklist, including optional-Site submission, all three workflow states, actual photo/signature replay and streaming, cached-shell relaunch, and the waiting-service-worker update flow. The 2026-08-13 hosted automation predates this interface and does not replace the new device pass.
- Review and rotate any remaining production credentials in Secret Manager.
- For current-live Neon, replace the sole `neondb_owner` application credential with a least-privilege runtime role, protect the production branch, and verify connection/pooling limits.
- The current Neon Free history window is only six hours and has no scheduled snapshots. Upgrade the recovery window or add tested encrypted logical backups before treating it as production-grade recovery.
- Decide whether to migrate to the recommended Cloud SQL target or retire the legacy Cloud SQL resources. If migrating, settle HA and private-IP/VPC design before cutover.
- Decide whether the built-in cookie refresh endpoint and session lifetime are enough, or whether the business needs shorter idle timeouts/revocation tracking.
- Built-in in-process rate limiting is available; add Cloud Armor or another edge/distributed limiter if abuse protection must work consistently across many Cloud Run instances.
- Richer audit-history filtering/export and a dedicated audit detail view.
- Budget alerts based on the selected current provider and GCP resource configuration.
- More automated frontend and backend tests.
- Update the development toolchain to clear the high-severity `brace-expansion` and `nanoid` advisories plus the moderate-severity `postcss` advisory; production dependencies currently audit clean.
- Better offline conflict resolution.
- Add and verify at least one Monitoring notification channel; the current alert policies create Console incidents but cannot yet email or message an operator.

## Roadmap

Current next work:

- Run the release gate, preview, exact-clone deployment, and full real-phone checklist for the report-only candidate. Hosting version `c761984b7353028a` is the historical full-interface baseline, not the report-only release.
- If automatic attendance is pursued, start with consent-based foreground arrival/departure reminders and one-tap confirmation. Reliable background geofencing when the PWA is closed requires native platform capability plus permission, battery, anti-spoofing, and audit validation.
- Verify Worker and Supervisor portrait/landscape flows, offline Report replay, real `/uploads/...` evidence, and **Update App** against the live Firebase Hosting / Cloud Run / Neon / Cloud Storage path.
- Clean up controlled hosted-test data and remove or formalize unused database users.
- Close the remaining notification/budget findings and the Neon access/longer-retention checklist.
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
