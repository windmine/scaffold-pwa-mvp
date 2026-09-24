# AGENTS.md

## Final Aim For Codex

Build and release a mobile-first report-only MVP. Every active Worker can submit a Supervisor-defined Report with a required Report Date, optional Site, answers, photos, and handwritten signatures; Workers see only their own Reports. Supervisors review Department-scoped Reports through **Submitted → In review → Resolved**, resolve with a required final note, manage Report Templates, and manage Staff.

The broader geo-attendance, Daywork, weekly-log, map, analytics, unrelated export, audit, and recovery implementation remains in the repository behind a reversible full-interface test override. Do not expose it in the production-default report-only shell or mix its approve/reject lifecycle into Reports.

## Product Vision

Create a practical report-submission product for two active user groups. Accounting/payroll and the broader field-operations platform remain future or retained scopes.

1. **Staff / field users**
   - Log in securely.
   - Choose an active Department Report Template from a phone.
   - Submit a Report with a required Report Date and optional Site.
   - Complete required answers and attach photos when needed.
   - Complete handwritten signature fields when a form requires them.
   - View only their own queued and durable Reports, workflow state, evidence, and final Supervisor note.
   - Use a simple interface that works well on mobile screens.

2. **Supervisors / admin users**
   - Log in securely.
   - View Department-scoped Reports, answers, photos, and handwritten signatures.
   - Start review on Submitted Reports.
   - Resolve In-review Reports with a required final note.
   - Filter and export Reports by workflow, Template, Worker, and Report Date.
   - Manage staff users, including resigned/reactivated workers.
   - Create, edit, archive, and reactivate reusable Report Templates.
   - Use a focused **Reports / Report Templates / Staff** interface on phone or desktop.

3. **Accounting / payroll users**
   - Not part of the report-only MVP.
   - Retain the existing payroll plan without exposing its unfinished UI.

## Active Report Boundaries

- `WorkForm` and `WorkFormSubmission` remain internal names. `template_purpose` and `submission_purpose` distinguish `report` from retained `daywork` records.
- Report-only frontend calls must request `purpose=report`; Legacy Daywork must not appear in New Report, My Reports, Supervisor Reports, or Report collection exports.
- Legacy approve/reject endpoints must reject Reports without changing the shared attendance/task/team-log decision policy. Reports transition only through their dedicated endpoint.
- Supervisor-created legacy form submissions must not create or impersonate Worker Reports.
- Submitted Report Site, Report Date, answers, photos, signatures, Definition snapshot, and purpose are immutable.
- Report exports use the Report workflow state and include the final note, reviewer, review-started timestamp, and resolved timestamp.
- Deploy the coupled backend/migration before any report-only Hosting promotion. A Firebase preview is not live approval.

## Current Implementation Notes

- The 2026-09-25 startup/presentation/private-onboarding release is **deployed and verified** from committed source `eb249ef1ee8b966a4149b15cfe092e3c0c3d10fc`. Backend `geo-backend-onboarding-20260925` serves 100% with no tags: build `858d7332-3923-457d-aebc-d58fe0176bb8`, image `sha256:c9c33ea6bd75f68e87ad44ddc81bf514c77fedddfda0dbe7252a642665ad40cf`, promoted `2026-09-24T23:08:09.118786Z`. Hosting `d492562f1d2bdb50` was cloned exactly from `release-20260925` at `2026-09-24T23:13:21.309Z`; production cache `leader-field-0643513b54a8`, source cache `leader-field-16d27ec7cb96`. No migration, maintenance pause or runtime configuration change; 21 migrations through `0021` remain current. [Release proof](docs/evidence/report-release-20260925/release.json) binds 69 browser workflows, 214 disposable-backend smoke checkpoints and PostgreSQL 17.6/18.4 at 64 checkpoints each. Preview/live each passed 13 authenticated 50-photo checkpoints (owned Reports `16`/`17` trashed, Templates `14`/`15` archived); preview/live onboarding passed five checks each (owned Workers `17`–`20` resigned). Live 64-asset shell, installer and four waiting-update checks passed; final infrastructure/log verification found no ERROR-or-higher/5xx entries and unchanged configuration. Exact rollback snapshot `rollback-20260925` holds previous Hosting `3e7a08c85e6ca5e5` until recorded `2026-10-01T23:03:40.749687450Z` expiry; reverify before use and never clear device storage.
- Released 2026-09-25 onboarding: manual private handoff remains selected. Supported browsers offer user-triggered Share with Copy fallback. Clean-browser **Set password and continue** uses mandatory-guard `/auth/login/after-setup`; existing credentials/saved identities prevent replacement, and old backends fail safely to normal sign-in. Acceptance stays cookie-free. Visible Forgot password guidance is supervisor assistance, not self-service recovery; no email provider/reset feature was added. Eight sharing/17 setup groups and invitation/security checks passed. Physical native sharing/phone checks remain; see the runbook for in-flight-cookie/concurrent-auth limitations. The compatible backend preceded Hosting.
- Released 2026-09-25 presentation: sign-in/install guidance is expandable below the primary form, the QR link stays visible, and direct language/theme/logout/install controls are quieter with 44px targets. Repeated report-only Supervisor introductions and routine Report hints are shortened; safety, draft, offline and sync cues remain visible. `npm run check:presentation` is included in `check:mobile` and passes 64 responsive/language/theme combinations plus interaction/state checks. The pre-onboarding local preparation cache `leader-field-8b27cad43a09` is historical, not the serving cache.
- Released 2026-09-25 startup: startup and sign-in render the Worker screen before queued replay. A session-scoped status panel shows evidence checkpoints, cooldown, final submission and outcome without replacing the active editor. `npm run check:startup-sync` covers eight real-app mocked-transport scenarios and four replay/discard lock groups; keep it in `check:mobile`. Same-page replay/discard reserves an ID before storage reads, with the existing durable lease for other tabs. The startup scenarios also passed ten consecutive local runs. Keep the page open; this is not an operating-system background-upload guarantee or physical-phone capacity certification.
- Historical 2026-09-18 50-photo/compact-review/PDF-primary release: backend `geo-backend-report50-20260918` served 100% with no tags at that cutover: source `d840fbf`, build `0220c539-b6e9-4026-83cd-37f02053df6e`, image `sha256:c9d87fd9afd9428767d65d719f990df6facabe31bdd6d6e2ecf1e1fda4609444`. Exact Hosting `3e7a08c85e6ca5e5` was cloned from `release-20260918` at `2026-09-18T06:00:16.936Z`, frontend `44e04c3`, production cache `leader-field-ed9e6cddf6aa`. No migration, maintenance pause or runtime configuration change; exact ledger remained 21 entries through `0021`. [Release proof](docs/evidence/report-release-20260918/release.json) binds the complete 68-workflow local gate, preview/live 12-checkpoint authenticated 50-photo runs, 64-asset live shell, installer and four waiting-update checks, and 18 pixel-identical candidate/live PDF pages. Owned preview/live Reports `14`/`15` were soft-deleted, Templates `12`/`13` archived; earlier failed verifier attempts archived Templates `10`/`11` without creating Reports. Existing presentation Reports `5`–`13`, Templates `7`–`9`, accounts `13`–`16`, Sites `5`–`6` and six uploads remain retained under their exact manifest; never broad-delete by DEMO name. Older release bullets below are historical cutovers, not current serving or rollback identities.
- Released Report limits are 50 JPEG/PNG/WebP photos at 5 MB each, plus handwritten signatures; retained Daywork/Task Logs remain eight. New Report drafts/records use isolated IndexedDB `scaffold-pwa-report-evidence-v1` so already-open old clients cannot replay Blob-only photos as empty evidence. New clients retain legacy base64 reads/replay; conditional old-draft cleanup preserves concurrent edits. Seven regressions use exact deployed old code. Compact Worker cards lazily expand evidence; phone/tablet review below 1100px uses collapsible filters and inbox/detail navigation with actions before evidence. PDF is the primary single/collection download; HTML/CSV and filter semantics remain. Keep a Blob-compatible frontend and 50-photo-compatible backend: do not roll back to September 15/16 artifacts while unfinished Blob Reports or incompatible replay remain, and never clear device storage to permit rollback.
- The operator explicitly approved the controlled September 18 pilot despite pending physical iOS/Android, full-resolution-gallery and 50 near-5-MB photo checks. Hosted runs use small synthetic images; final mocked-transport isolated-storage volume testing preserved 50 originals (64.56 MiB), two cold reloads and 25+25 replay with one Report and a 482,914,304-byte sampled working-set peak. This is not phone-capacity certification. The September 18 startup delay while awaiting queued replay is historical: the September 25 release reveals the Worker screen before replay and shows progress. Actual-phone checks remain follow-up work; keep the app open until uploads finish.
- Historical 2026-09-16 PDF-only release: source `7ad0f88`, build `50649bcc-9d50-455a-9df0-274bc296ab03`, image digest `sha256:08edbc28d3dfca0922941619900c6c7102a7dd4dc825d56422a9437b7bfb82dc`, revision `geo-backend-pdf-20260916-0010`. It was promoted at 100% without tags, migration, maintenance or Hosting changes, introducing department-branded A4 PDFs with the supplied Mutual logo. [Release proof](docs/evidence/report-pdf-release-20260916/release.json) records its local/candidate/live checks, 18 reviewed/pixel-matched pages, actual phone-sized export-button downloads, unchanged demo hashes and 196 clean log entries. The September 18 release supersedes that serving revision and its then-compatible September 15 rollback recommendation; use the current Blob/50-photo compatibility rules above. Physical-phone PDF viewers remain unverified. Presentation fixtures remain retained under [exact cleanup ownership](docs/evidence/presentation-demo-20260916.json).
- The 2026-09-15 coupled release is **deployed and verified**. Healthy backend `geo-backend-report-20260915-0025` serves 100% with no temporary tags; approved maintenance ran `01:10:22.871295Z`→`01:17:26.168054Z` (about 7m03s). Migration `geo-report-migrate-20260915-c595l` succeeded at `01:15:55Z`; read-only check `geo-report-migrate-20260915-j95p4` succeeded at `01:16:19Z`. [Post-migration evidence](docs/evidence/production-postmigration-20260915.json) confirms exact 21-entry `0021` history and unchanged existing Report evidence. The [final Current recovery proof](docs/evidence/neon-recovery-proof-20260915-current-final.json) completed at `01:21:48Z`, and strict hardening passed with only the six-hour retention warning. Hosting `23c1ee5e712da7d7` was cloned from `release-20260915` at `01:23:23.272Z`: frontend `921be2d`, production cache `leader-field-57d5f43f282c`; `750298f` is hosted-test-only. Backend source `8e33d21` built as `bd2c07c2-2d49-4e24-9594-9acfa256ed76`, image `sha256:6692dac1a643e772c12383dff764de2e89bcdfb8fc9a85f3631344230a72fb4d`. Live shell63/installer/waiting-update4 and authenticated baseline10/improvements7 passed; owned Report/Template/invited-Worker fixtures were cleaned and test accounts `9`/`10`/`11` deactivated. The [release record](docs/evidence/report-improvements-release-20260915.json) records 533 checked log entries with no ERROR-or-higher/5xx. Retain backup `br-misty-wildflower-a7vty6d9` / `release-backup-20260915-0025` until recorded `2026-09-22T01:15:39Z` expiry; see the runbook for resource-cleanup state and the `0020` backend rollback prohibition. Physical-phone/real-recipient handoff remain pending; no automatic invitation email is sent.
- The active frontend path is `index.html` with `assets/js/app.js`, `assets/js/app-shell-state.js`, `assets/js/api-client.js`, `assets/js/db.js`, `assets/js/mock-api.js`, feature modules under `assets/js/`, and `assets/css/styles.css`.
- `src/App.jsx` exists but is a legacy React path and is not the current production UI.
- The backend is FastAPI in `backend/app/main.py` using SQLModel models from `backend/app/models.py`.
- Local development uses SQLite at `backend/geo_management.db`.
- The current live deployment is Firebase Hosting, Cloud Run, Neon PostgreSQL supplied through Secret Manager, and a private Cloud Storage upload bucket. The recommended all-Google target remains Firebase Hosting, Cloud Run, Cloud SQL PostgreSQL, Cloud Storage, and Secret Manager.
- Production uploads must use Cloud Storage or another durable object store. Do not rely on local `backend/uploads/` for Cloud Run production storage.
- The app currently supports backend auth, HttpOnly `__session` cookies with CSRF, session refresh, normal-worker/leader classes, department-scoped supervisors/global admins, attendance, geolocation, site radius checks, task logs, weekly team logs, multiple photos, task templates, staff management, resigned workers, supervisor record edits, rubbish-bin restore/purge, audit history, CSV/PDF/HTML exports, versioned Work Forms, form submissions, handwritten signatures, maps, and Management Analytics.
- During the invited-account pilot, public registration remains hidden. Deployed `0021_worker_invitations` makes report-only Staff create pending Workers with private, expiring, single-use password-setup links; no email is sent automatically. Existing accounts and retained/Supervisor provisioning remain compatible. Supervisors must verify the intended recipient and share links through an authenticated private channel. The verified-registration API remains callable and regression-tested, but is not exposed or supported as the pilot onboarding path. The invitation migration/backend were released before the coupled frontend.
- Payroll/admin reporting is planned, not implemented yet. Keep it separate from the Review Queue: supervisors validate records, while accounting calculates/export payable hours from approved attendance.
- The Offline Submission module owns Worker identity, capture time, client idempotency key, replay state, and partial-upload state for queued attendance, task logs, and Work Forms; attendance maps capture time to its occurrence timestamp. Do not make those separate caller responsibilities.
- Work Form Definitions are versioned; each submission stores an immutable definition snapshot, and the backend is authoritative for time-range and formula results.
- Released 2026-09-15 offline-return update: authenticated Worker loads download only active Report Template Definitions to exact Worker/Department-scoped IndexedDB snapshots. A saved identity, shell and Templates enable cold offline start/Continue/queue. Protected API responses, durable Report history and Supervisor lists remain network-only. Logout, explicit 401/403 and observed scope changes clear downloads; reconnect saves current answers/evidence before revalidation and retains existing Definition-conflict/replay guards.
- Released 2026-09-15 Supervisor Template editing update: private create/edit drafts save name, description, cards and exact unapplied raw syntax; Continue/Discard are visible and Close keeps work. Workspace navigation retains the live editor; Close/logout/update pause if saving fails. Stale, archived/unavailable or uncertain-publication copies remain read-only. Content edits send `expected_definition_version`; the backend rejects stale updates with HTTP 409 without a new migration. These changes are deployed; invitation migration `0021` and the compatible backend preceded the frontend.
- The [final 2026-09-15 local rerun](docs/evidence/local-final-release-20260915.json) passed all 67 app workflows and 11 installer checks after the final Template action-lock fix at `921be2d` / production cache `leader-field-57d5f43f282c`. Native PostgreSQL 17.6/18.4 each passed 64 checkpoints with owned-cluster cleanup; [provider smoke](docs/evidence/neon-provider-smoke-20260915.json) passed 209 checks. Final hosted staging passed [baseline h](docs/evidence/hosted-report-stage-20260915-h/evidence.json) (10 Chromium/GCS Report checks), [improvements i](docs/evidence/hosted-improvements-stage-20260915-i/evidence.json) (seven draft/invitation/offline/export checks with owned cleanup), [63 exact shell assets/PWA checks](docs/evidence/hosted-stage-final-shell-20260915.json), and [installer verification](docs/evidence/hosted-stage-final-installer-20260915.json). The corresponding live shell/installer/update and authenticated baseline10/improvements7 checks passed as recorded above; physical-phone validation is not claimed. Invitations send no automatic email and require verified private recipient handoff. See `docs/mobile-browser-workflow-checks.md` for the checkpoint and limits.
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
2. Before broader onboarding, verify private intended-recipient handoff and the released Worker-invitation flow on physical phones. Native PostgreSQL contention, `0021` migration and the coupled release are complete. No invitation email is sent; automatic delivery remains a separate transactional-provider integration.
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
npm run check:invitations
npm run check:offline-report-templates
npm run check:report-template-drafts
node scripts/work-form-builder-test.mjs
npm run check:mobile
npm audit --omit=dev
npm audit
python -m pip check
python -m compileall backend\app backend\smoke_test.py backend\database_test.py backend\migration_test.py backend\report_purpose_test.py backend\report_workflow_test.py backend\review_queue_test.py backend\work_form_definition_test.py backend\upload_storage_test.py backend\security_test.py
python backend\database_test.py
python backend\security_test.py
python backend\upload_storage_test.py
python backend\review_queue_test.py
python backend\work_form_definition_test.py
python backend\report_purpose_test.py
python backend\report_workflow_test.py
python backend\migration_test.py
python backend\smoke_test.py
```

The smoke test expects the backend to be running at `http://127.0.0.1:8000`.
`npm run check:production-hardening` requires authenticated `gcloud` access and current sanitized proof files. It validates the live GCP resource contract plus exact Neon/upload recovery evidence; it does not establish Neon least-privilege roles, pooling limits, longer backup retention, or notification ownership.
