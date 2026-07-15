# Mobile and Browser Workflow Checks

Use this checklist before calling the MVP ready for phone testing or production use. Local automation, hosted automation, and a hosted real-phone pass are separate gates.

## Latest Manual Pass

- 2026-06-04: Full real-phone workflow pass completed on the local network with no reported blocking issues.
- The equivalent real-phone pass against the hosted Firebase URL is still pending; the 2026-07-14 hosted result below was an automated browser/API pass.

## Latest Automated Pass

- 2026-07-14 hosted pass: Cloud Run revision `geo-backend-00018-jbz` at 100% traffic and Firebase Hosting passed anonymous/login site isolation, worker login, restored-session ordering, five repeated authenticated site requests, logout cleanup, supervisor Review Queue, readiness, and new-revision error-log checks without a 5xx.
- 2026-07-14: Review Queue module checks and the full Playwright workflow passed with explicit offline/read-only state, durable-only decisions/exports, and a two-source guard proving device-local Worker records never enter supervisor review.
- 2026-07-09: `npm run check:mobile` passed after the Daywork team-member picker click target was fixed. Backend compile, security, upload storage, migration, and full smoke checks also passed locally.

## Hosted Deployment Pass

Run this after deploying the hosted path:

```text
Firebase Hosting -> Cloud Run -> managed PostgreSQL (current live: Neon)
                              -> Cloud Storage uploads
                              -> Secret Manager secrets
```

Use the hosted Firebase URL, not the local Vite URL, when checking production behavior:

```text
https://geo-attendance-system-db9ca.web.app
```

Confirm `/api/health` and `/api/health/ready` work through Firebase Hosting before phone testing:

```powershell
curl.exe https://geo-attendance-system-db9ca.web.app/api/health
curl.exe https://geo-attendance-system-db9ca.web.app/api/health/ready
```

After signing in through the hosted URL, confirm authenticated `/api/**` calls keep returning 200. Firebase Hosting rewrites only forward the `__session` cookie to Cloud Run, so a login response that sets another auth cookie name can look like a session that expires immediately.

Before signing in, confirm the login screen does not request `/api/sites` or briefly populate Worker site controls with local demo sites. When restoring a saved session, `/api/auth/refresh` must complete before `/api/sites` is requested.

Before using real staff data, run the read-only GCP hardening gate from an authenticated admin machine:

```powershell
npm.cmd run check:production-hardening
```

Use controlled production test accounts. Do not use `/dev/seed` on production-like deployments.

Because the current live database is Neon, separately verify Neon least-privilege roles, pooling/compute limits, backup/PITR retention, monitoring, and a restore/branch drill. The GCP checker cannot establish those provider guarantees.

## Automated Preflight

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

With the backend running at `http://127.0.0.1:8000`:

```powershell
python backend\smoke_test.py
```

`npm.cmd run check:mobile` verifies the built PWA shell, generated service worker output, update-flow wiring, mobile controls, same-origin proxy setup, supervisor audit-history wiring, explicit offline/read-only Review Queue behaviour, offline work-form submission support, photo controls, signature enforcement, and Playwright browser workflows. It does not replace a real phone test.

## Setup For Manual Phone Test

1. Start the backend:

   ```powershell
   cd backend
   python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
   ```

2. Seed demo accounts from Swagger or another API client. This requires the local backend to be using `.env.example` values or equivalent `ENABLE_DEV_SEED=true`; the seed endpoint only accepts localhost requests and is disabled in production-like environments.

   ```text
   POST http://127.0.0.1:8000/dev/seed
   ```

3. Start the HTTPS phone frontend:

   ```powershell
   npm.cmd run dev:phone
   ```

4. Open the computer IP from the phone:

   ```text
   https://YOUR_COMPUTER_IP:5173
   ```

5. Accept the local certificate warning on the phone.

## Worker Phone Checks

- Login as `worker@example.com / Passw0rd!`.
- Confirm the seeded account shows a Leader badge and provides Team, Daywork, Form, and missing-site controls.
- Create a separate Normal worker from Staff users, sign in, and confirm only Check in / out and My history remain available.
- Confirm the normal-worker home screen shows the three-step site, location, and attendance-action guide.
- Confirm check-in/out buttons remain disabled until a site is selected and location is captured.
- Interrupt the Sites request and confirm authenticated workers see Sites unavailable rather than seeded demo Sites.
- Confirm Today’s attendance clearly shows current status and the next expected action.
- Confirm the normal worker can check in/out but cannot submit a site, task log, work form, or weekly team log through the API.
- As the leader, open Team, select a Monday, and add several work rows across different dates and sites.
- Search the member list by name, select multiple members in one row, remove one selected chip, and select it again.
- Confirm the row summary shows hours per member, selected member count, and multiplied worker-hours.
- Include a member who also works under another leader; no permanent crew assignment should block the row.
- Confirm start, finish, and break values calculate the expected hours, including an overnight row.
- Submit the weekly team log and confirm it appears pending in leader history and the supervisor Review Queue.
- Tap `Download App` on the sign-in screen and confirm it either opens the browser install prompt or shows Add-to-Home-Screen instructions.
- Deny geolocation once and confirm the app shows an error instead of crashing.
- Allow geolocation, capture location, and confirm the site-radius preview appears.
- Let a location capture age beyond five minutes, and switch Worker accounts on the same device, confirming neither stale nor differently-owned GPS can enable attendance.
- Submit a check-in with notes and an optional photo.
- Submit a check-out later and confirm both records appear in History.
- Submit a task log with work date, hours, safety notes, and at least two photos.
- Select an unsupported or over-5-MB image and confirm the UI rejects it before queueing or upload.
- Open a task-log photo thumbnail and confirm previous/next photo navigation works.
- Submit an active Work Form with a required handwritten signature and at least one photo.
- Try submitting a required-signature form without signing and confirm validation blocks it.
- Apply History filters by type, status, text, and local date.
- Turn off network, submit one attendance record or task log, and confirm it is queued locally.
- While editing Daywork or a Work Form, restore connectivity and confirm typed answers and signatures remain intact.
- While it is queued, switch to another Worker account on the same device and confirm the first Worker's record is not replayed, displayed, or reassigned as the second Worker.
- Restore network and confirm queued submissions sync and History updates.
- Force an upload failure and confirm History shows the sync error with Retry and Discard controls for the owning Worker.
- Delay one attendance replay and confirm the durable record retains its original occurrence time rather than the reconnect time; retry it and confirm the stable client submission id prevents a duplicate.

## Supervisor Browser Checks

- Login as `supervisor@example.com / Passw0rd!`.
- Confirm the department filter is fixed to Leader for the department-scoped supervisor.
- Confirm Review Queue shows attendance, task logs, weekly team logs, and form submissions together.
- Filter Review Queue by type, status, worker/site text, and date.
- For an attendance event around UTC midnight, confirm the Review Queue and attendance export assign it to the date configured by `BUSINESS_TIMEZONE` (default `Pacific/Auckland`).
- Make the filtered visible page exclude a known approved record; confirm dashboard `Reviewed` totals still include it and Management Analytics still reports the complete authorized record set.
- Double-tap a worker attendance action and confirm only one matching record is created.
- Move controlled attendance, Task Log, Work Form Submission, and weekly Team Work Log records to the rubbish bin; confirm they disappear from active review and show a deletion reason and automatic deletion date.
- Restore the records from the rubbish bin and confirm they return to active review.
- Open Add missed check in / check out, select a worker and matching site, enter a past date/time and reason, and confirm the approved record appears as a manual entry with no GPS.
- Confirm resigned workers remain selectable for historical corrections and that switching department focus updates the available workers and sites.
- Open Submit approved log, submit one log for the signed-in supervisor and one for another accessible user, and confirm both appear as approved without review actions.
- Switch department focus and confirm the approved-log person/site selectors follow the selected department.
- Open Maps and location review and confirm attendance points, site-radius circles, and the recorded location history appear.
- Filter the map by worker, site, status, date range, and outside-site-only.
- Toggle recorded-point connection lines and confirm they follow event timestamp order without being labelled as continuous GPS travel.
- Select a pending map point and approve or reject it from the map detail panel.
- Open Management analytics and switch between 7, 30, 90, and all-record periods.
- Confirm record trends, exception rows, site summaries, and supported form-response charts update without layout overflow.
- Confirm an open check-in under 12 hours old is not marked missing, while one at least 12 hours old is marked `Missing check-out`.
- Confirm a check-in before midnight followed by a check-out after midnight is paired and not marked missing.
- Export management CSV and printable HTML and confirm each contains the selected period, key metrics, site summaries, and exceptions.
- Login as `admin@example.com / Passw0rd!`, switch the department focus, and confirm review counts, maps, analytics, sites, staff, and work forms follow the selected department.
- Save a non-default department, sign out/in, and confirm it is restored without changing the account’s home department.
- Save `All departments` as the default, sign out/in, and confirm the all-department dashboard view is restored.
- Open submitted photos and signatures from review records.
- Approve one pending record and reject another pending record.
- Edit one attendance record after the double-check confirmation.
- Edit one task log after the double-check confirmation.
- Create a new Work Form with a required `signature` field.
- Include a time range, conditional field, repeatable section, and formula. Confirm the backend response contains authoritative derived values and a Definition version/snapshot.
- Edit the reusable Work Form, reopen the old submission/export, and confirm its historical labels, fields, formulas, and signatures still use the original snapshot.
- Archive and reactivate a Work Form.
- Create or edit a Site and confirm radius values remain valid.
- Mark a worker resigned, confirm they cannot sign in, then reactivate them.
- Confirm a department supervisor has no resign action for a global admin and both status-update API paths reject the attempt.
- Open Audit history and confirm recent changes show editor name, group, access level, action, and timestamp.

## PWA Checks

- Install the app from the browser prompt or browser install menu.
- Open the installed app and confirm login/history screens load.
- On the hosted Firebase URL, confirm the app stays same-origin for API calls through `/api/**`.
- Upload one photo and one signature and confirm their `/uploads/...` URLs still load after refresh, proving Cloud Run is serving Cloud Storage-backed files.
- Build and deploy a changed generated service worker, then reload an already-open app tab.
- Confirm the topbar shows `Update App` and the status banner says a new version is ready.
- Tap `Update App` and confirm the app reloads.
- Confirm backend data and uploaded photos do not appear stale after refresh or reinstall.

## Pass Criteria

- Worker and supervisor paths complete without console-breaking errors.
- Geolocation denial, offline state, backend outage, and photo/signature validation show clear messages.
- Queued worker submissions sync after reconnect.
- Queued submissions remain bound to the capturing Worker and capture time across shared-device account changes; delayed attendance retains its original occurrence time.
- Expired sessions pause queued sync, keep the queued record, and show a sign-in-again message.
- Retried queued submissions do not create duplicate backend Review Records.
- Supervisor review shows synced worker records, photos, and signatures.
- Supervisor Audit history shows recent admin/review changes and workers cannot access it.
- The app update flow is visible and reloads only after the user taps `Update App`.
- Anonymous startup makes no authenticated site request, and restored sessions load sites only after authentication refresh succeeds.
- `/api/health/ready` returns ok through Firebase Hosting and can be used for production uptime monitoring.
- The first authenticated API request after an idle period succeeds; a stale managed PostgreSQL/Neon SSL connection is recycled before the route query.
- Applicable `npm.cmd run check:production-hardening` findings and the separate Neon recovery/access checklist are closed or explicitly accepted before real staff data is used.
- Hosted Firebase/Cloud Run checks pass without direct phone access to the managed PostgreSQL provider or Cloud Storage.
