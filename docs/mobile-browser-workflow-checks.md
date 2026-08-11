# Mobile and Browser Workflow Checks

Use this checklist before calling the MVP ready for phone testing or production use. Local automation, hosted automation, and a hosted real-phone pass are separate gates.

## Latest Manual Pass

- 2026-06-04: Full real-phone workflow pass completed on the local network with no reported blocking issues.
- The equivalent real-phone pass against the hosted Firebase URL is still pending; the 2026-08-11 release result below is an automated local-browser and hosted HTTP/API pass.

## Latest Automated Pass

- 2026-08-11 frontend release pass at commit `9a6260e`: lint, production build/static PWA checks, Review Queue checks, all 28 Playwright Chromium workflows, production dependency audit with zero findings, Python dependency consistency, and the controlled production-hardening gate passed with the three known warnings for incident-only Monitoring, six-hour Neon retention, and skipped budget verification. The full development audit separately reported high-severity `brace-expansion` and `nanoid` plus moderate-severity `postcss`, all in the development toolchain. Firebase preview `release-20260811125326` at `https://geo-attendance-system-db9ca--release-20260811125326-agkq8qbo.web.app` was verified before exact Hosting version `4766134daf955917` was cloned live. Local, preview, and live SHA-256 hashes matched for `index.html` (`20720598a574dd734e7465039cf393a7747298d1b96e2f8f43c2ff9c5b10558a`), `sw.js` (`b95e22af6eb580c6ed52594215dd9ccda6647eae1c8da44f137ee269472a0bb1`), `offline.html` (`5034e9dd2d5df27e72c356632a8e984fa0ea389adfcf1870dafe0b3d64837ff2`), `manifest.webmanifest` (`24b60cb58ae8a220b51b3e52cc16aa0360d87f0f63f4e9c713fab0d6b990d35e`), and `assets/js/confirmation-dialog.js` (`f488758b9ce098c263f4727b091a5772f4cdf5cdbf01f7b27772e234f0f68f58`). All 47 generated app-shell paths plus `sw.js` matched on preview and live; five preview and five live readiness probes reported database and GCS healthy; anonymous Sites returned 401; invited-only/hidden-registration state, login-before-install ordering, cache headers, hashed entrypoints, both scoped offline snapshots, and confirmation-dialog markup passed. Local browser coverage verified cancel-first focus, Escape and Cancel behavior, focus restoration, single-flight guards, and exactly one intercepted mutation only after confirmation. No authenticated hosted mutation was performed; the full hosted real-phone checklist remains pending. Cloud Run remained unchanged at `geo-backend-release-20260804152130`.
- 2026-08-10 frontend release pass at commit `b2dec22`: lint, production build/static PWA checks, Review Queue checks, all 28 Playwright Chromium workflows, production dependency audit with zero findings, Python dependency consistency, and the controlled production-hardening gate passed with the three known warnings for incident-only Monitoring, six-hour Neon retention, and skipped budget verification. Firebase preview `release-20260810172537` at `https://geo-attendance-system-db9ca--release-20260810172537-uihkpz71.web.app` was verified before exact Hosting version `6b499ef514142a09` was cloned live. Local, preview, and live SHA-256 hashes matched for `index.html` (`ba207851e18aca98c38d65de58846000d66a67d8e966a903683af4f15a1c4b3a`), `sw.js` (`416375288e8623f514eeeee833b17661a84dcbbd5543f09e3fdb590964339fac`), `offline.html` (`5034e9dd2d5df27e72c356632a8e984fa0ea389adfcf1870dafe0b3d64837ff2`), and `manifest.webmanifest` (`24b60cb58ae8a220b51b3e52cc16aa0360d87f0f63f4e9c713fab0d6b990d35e`). Five preview and five live readiness probes reported database and GCS healthy; anonymous Sites returned 401; invited-only/hidden-registration state, login-before-install ordering, cache headers, generated service-worker assets, and hidden-by-default Staff/Work Form creation panels passed. Local browser coverage verified Add/Cancel focus and reset behavior, submit locking, failed-create retry state, successful creation, and list preservation with an explicit warning after a post-create refresh failure. Cloud Run remained unchanged at `geo-backend-release-20260804152130`; the full hosted real-phone checklist remains pending.
- 2026-08-07 frontend release pass at commit `bbee643`: lint, production build/static PWA checks, Review Queue checks, all 28 Playwright Chromium workflows, production dependency audit with zero findings, Python dependency consistency, and the controlled production-hardening gate passed with the three known warnings for incident-only Monitoring, six-hour Neon retention, and skipped budget verification. Firebase preview `release-20260807120117` at `https://geo-attendance-system-db9ca--release-20260807120117-texdr4u7.web.app` was verified before exact Hosting version `1e831c0aa589a08d` was cloned live. Local, preview, and live SHA-256 hashes matched for `index.html` (`a0c8c1c16cdfb58fb29c0ef976ba8d7c645ffee20de5f7bd3e85df7f3f1dc004`), `sw.js` (`ab4fa2b49094970b26d8e7eb41fe63a42c8a303c8c330429ee68e588b2a9149e`), `offline.html` (`5034e9dd2d5df27e72c356632a8e984fa0ea389adfcf1870dafe0b3d64837ff2`), and `manifest.webmanifest` (`24b60cb58ae8a220b51b3e52cc16aa0360d87f0f63f4e9c713fab0d6b990d35e`). Five live readiness probes reported database and GCS healthy; anonymous Sites returned 401; invited-only/hidden-registration state, login-before-install ordering, and generated service-worker assets passed. Normal Workers now get a compact guide after first use, checkout defaults to the open check-in's Site, Sites prioritize recent/nearest choices, and scoped attendance snapshots resist account-switch races. Cloud Run remained unchanged at `geo-backend-release-20260804152130`; the full hosted real-phone checklist remains pending.
- 2026-08-05 frontend release pass at commit `9db3477`: lint, production build/static PWA checks, Review Queue checks, all 27 Playwright Chromium workflows, production dependency audit, Python dependency consistency, and the controlled production-hardening gate passed. The production-preview workflow installed the built service worker, verified hashed JS/CSS entrypoints in Cache Storage, closed the last page, reopened offline, restored the matching Worker/Department Site snapshot, captured location, and created a queued attendance record. Firebase preview `release-20260805155240` matched local hashes before exact Hosting version `ba8c1689c2d0e121` was cloned live; live hashes, five readiness probes, invited-only/hidden-registration state, cold-offline shell rules, and anonymous Site isolation passed afterward.
- 2026-08-04 production release pass at commit `38220e9`: the current source passed lint, production build/PWA generation, Review Queue, all static/mobile checks, 26 Playwright Chromium workflows, backend database/security/upload/review/form/migration tests, and a disposable-database smoke test. Migration `0017_global_admin_supervisor_invariant` passed on a disposable Neon branch before release. Cloud Run revision `geo-backend-release-20260804152130` passed five candidate readiness cycles and ten post-promotion database/GCS readiness probes with no observed revision-scoped ERROR or HTTP 5xx logs. Firebase Hosting version `6eea51a351ebab2b` exactly matched the verified preview and local build for the shell, service worker, offline page, and manifest; invited-only login, hidden registration, anonymous Site isolation, Supervisor-only Global Admin controls, and logout passed the hosted browser check.
- 2026-07-31 committed-source local pass at `b9aa05d`: lint, production build/PWA generation, Review Queue, all static/mobile checks, 25 Playwright Chromium workflows, backend compile/database/security/upload/form/migration tests, and the full disposable-database smoke test passed. The invited-account notice was visible and the public registration panel stayed hidden. Production npm dependencies and Python consistency checks passed; the full development npm audit reported one high-severity `brace-expansion` advisory through ESLint/minimatch.
- 2026-07-31 historical live read-only pass: Firebase Hosting returned 200 and `/api/health/ready` reported database and GCS as healthy. The controlled-test hardening gate passed with incident-only Monitoring, six-hour Neon retention, and skipped-budget warnings; the strict gate failed because no verified notification channel was attached. Live `index.html` and `sw.js` did not match that current build, and the live page still exposed public registration. The 2026-08-04 release above resolved this deployment mismatch.
- 2026-07-15 current-source release pass: Cloud Run revision `geo-backend-release-20260715213211` passed zero-traffic candidate checks, moved to 100%, and passed ten post-promotion database/GCS readiness probes across direct Cloud Run and Firebase Hosting. Anonymous protected Sites returned 401 and the revision had zero ERROR/5xx logs. The Firebase preview's shell, service worker, offline page, and manifest matched the tested local build byte-for-byte before the exact preview version was cloned live.
- 2026-07-15 operational pass: dedicated-identity Cloud Run canary passed database/upload readiness, revision `geo-backend-runtime-identity` moved to 100%, five hosted readiness calls passed after the old identity's runtime grants were removed, and the serving revision had zero observed ERROR/5xx logs in the final two-hour query. Hardened Neon PITR and exact-generation GCS soft-delete recovery drills passed; the controlled-test hardening gate passed, while the strict gate failed only for the intentionally missing notification destination.
- 2026-07-15 local regression pass: lint, build/PWA generation, Review Queue, all static/mobile and 16 Playwright browser workflows, backend compile/database/security/upload/review/form/migration tests, dependency checks, and the full disposable-database smoke test passed.
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

Before signing in, confirm the login screen says `Invited accounts only`, the public registration panel is absent, and the page does not request `/api/sites` or briefly populate Worker site controls with local demo Sites. When restoring a saved session, `/api/auth/refresh` must complete before `/api/sites` is requested.

The invited-only shell, login-before-install ordering, list-first Staff/Work Form administration, scoped cold-offline update, and consistent consequential-action dialog are live in Firebase Hosting version `4766134daf955917`. Local, preview, and live shell hashes match. Complete the manual installed-phone cold-launch, replay, photo/signature, dialog, and update-flow steps below before treating the hosted device gate as complete.

Before using real staff data, run the read-only GCP hardening gate from an authenticated admin machine:

```powershell
npm.cmd run check:production-hardening
npm.cmd run check:production-hardening:strict
```

The normal command carries the controlled-test Console-incident exception. The strict command must pass before real production use and therefore requires a verified alert notification channel.

Use controlled production test accounts. The current Staff users flow requires a Supervisor to set the initial password; communicate controlled-test credentials through a secure private channel. A single-use Worker password-setup invitation is not implemented or covered by this checklist. Do not use `/dev/seed` on production-like deployments.

The hardening checker now validates current Neon recovery evidence, but provider access and commercial guarantees still require an operator review. Before real data, replace the owner application credential, verify pooling/compute limits, protect production, and choose recovery beyond the current six-hour Free-plan history window.

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

`npm.cmd run check:mobile` builds the production PWA, verifies its generated shell/cache, and runs 28 Playwright Chromium workflows. Coverage includes invited-only login, update-flow wiring, mobile controls, same-origin proxy setup, Supervisor audit history, explicit offline/read-only Review Queue behaviour, offline Work Form support, photo controls, signature enforcement, Normal Worker guide/Site priority/default-checkout behavior, scoped attendance-context restoration, and a production-preview cold launch that creates queued attendance after the final page is closed. The workflow uses temporary backend, development frontend, and production-preview ports `8765`, `5175`, and `4175`; override them with `BROWSER_WORKFLOW_BACKEND_PORT`, `BROWSER_WORKFLOW_FRONTEND_PORT`, and `BROWSER_WORKFLOW_PREVIEW_PORT`. It does not replace a real phone test.

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

- Confirm the sign-in screen says `Invited accounts only` and does not show public registration controls.
- Login as `worker@example.com / Passw0rd!`.
- Confirm the seeded account shows a Leader badge and provides Team, Daywork, Form, and missing-site controls.
- Create a separate Normal worker from Staff users, sign in, and confirm only Check in / out and My history remain available.
- Confirm the normal-worker home screen shows the full three-step Site, Location, and attendance-action guide before first use, then compacts it after the Worker's first attendance event so the controls appear sooner.
- Confirm checkout defaults to the open check-in's Site. Without a fresh location, confirm recently used Sites rank first; after location capture, confirm nearer Sites rank first without replacing an explicit current selection.
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
- Enter different values in two Work Forms, wait for each `Saved at...` receipt, switch between them, reload, and confirm each Worker/Form draft restores its own site, date, answers, signatures, and photos.
- Make a final Work Form edit and immediately log out; sign the same Worker back in and confirm the latest draft restores. Sign in as a different Worker and confirm that draft is never shown.
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
- Move controlled attendance, Task Log, Work Form Submission, and weekly Team Work Log records to the rubbish bin. Confirm the app dialog focuses Cancel first, Escape/Cancel sends no request and restores focus to the trigger, and the destructive action button sends one request. Confirm the records then disappear from active review and show a deletion reason and automatic deletion date.
- Restore the records from the rubbish bin and confirm they return to active review without a redundant confirmation dialog.
- Open Add missed check in / check out, select a worker and matching site, enter a past date/time and reason, complete the app confirmation dialog, and confirm the approved record appears as a manual entry with no GPS.
- Confirm resigned workers remain selectable for historical corrections and that switching department focus updates the available workers and sites.
- Open Submit approved log, complete the app confirmation dialog, submit one log for the signed-in supervisor and one for another accessible user, and confirm both appear as approved without review actions.
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
- Edit one durable attendance record after the app dialog explains that the audited change can affect reporting.
- Edit one durable task log after the same app confirmation.
- Create a new Work Form with field cards and a required `signature` field. Confirm type, label, required state, choice options, conditions, and repeat row controls remain usable at phone width without horizontal overflow.
- Reorder cards with a drag handle and with Move up/down. Confirm the worker preview and saved API field order match, the move is announced, and a move that places a condition/formula before its source is rejected locally.
- Open **Advanced: edit raw field syntax**, confirm the generated syntax retains stable `id=` metadata, and verify preview/save asks you to apply or discard staged raw edits. Apply valid syntax and confirm the cards rebuild; enter invalid syntax and confirm the previous cards remain intact with local feedback.
- Include a time range, conditional field, repeatable section, and formula. Confirm the backend response contains authoritative derived values and a Definition version/snapshot.
- Change a choice/formula/repeating-group field type in the Work Form builder. Confirm Cancel preserves its options/formula/children and Confirm applies the lossy draft change. Confirm the dialog copy is fully translated when Chinese is selected.
- Edit and save the reusable Work Form without a redundant confirmation, reopen the old submission/export, and confirm its historical labels, fields, formulas, and signatures still use the original snapshot.
- Archive and reactivate a Work Form without a redundant confirmation dialog.
- Create or edit a Site, complete the geofence-impact app confirmation, and confirm radius values remain valid.
- Mark a worker resigned through the access-impact app confirmation, confirm they cannot sign in, then reactivate them through the matching confirmation.
- Confirm a department supervisor has no resign action for a global admin and both status-update API paths reject the attempt.
- Open Audit history and confirm recent changes show editor name, group, access level, action, and timestamp.

## PWA Checks

- Install the app from the browser prompt or browser install menu.
- Open the installed app and confirm login/history screens load.
- While online, sign in as a Worker and confirm the current Site list has loaded. Fully close the installed app, enable airplane mode, and reopen it. Confirm the Worker application opens instead of the static offline page and only that Worker's saved Sites are selectable.
- Capture location and submit attendance while still offline. Confirm History shows the record as queued, then fully close/reopen or refresh once more offline and confirm the Worker app and queued record remain available.
- Reconnect, reopen the app, and confirm the queued attendance syncs once without changing its capture/occurrence time. Confirm the backend applies current Site authorization and radius rather than trusting the saved snapshot.
- On the hosted Firebase URL, confirm the app stays same-origin for API calls through `/api/**`.
- Upload one photo and one signature and confirm their `/uploads/...` URLs still load after refresh, proving Cloud Run is serving Cloud Storage-backed files.
- Build and deploy a changed generated service worker, then reload an already-open app tab.
- Confirm the topbar shows `Update App` and the status banner says a new version is ready.
- With an unsaved Work Form edit, tap `Update App` and confirm the latest revision reaches `Saved at...` before the app reloads.
- Simulate local draft-storage failure and confirm the update pauses without reloading, offers `Try saving again` and `Keep editing`, then proceeds only after retry succeeds.
- Confirm backend data and uploaded photos do not appear stale after refresh or reinstall.

## Pass Criteria

- The sign-in screen identifies invited-account access and public registration controls are not visible.
- Worker and supervisor paths complete without console-breaking errors.
- Geolocation denial, offline state, backend outage, and photo/signature validation show clear messages.
- Queued worker submissions sync after reconnect.
- A killed or refreshed installed PWA cold-launches the Worker application offline, restores only the matching Worker/Department Site and attendance snapshots, and can create a queued attendance record; protected API/upload paths never receive cached application content. Logout, invalid authorization, account switches, and Department-scope changes cannot expose another Worker's saved context and remove matching saved data where required.
- Queued submissions remain bound to the capturing Worker and capture time across shared-device account changes; delayed attendance retains its original occurrence time.
- Expired sessions pause queued sync, keep the queued record, and show a sign-in-again message.
- Retried queued submissions do not create duplicate backend Review Records.
- Supervisor review shows synced worker records, photos, and signatures.
- Supervisor Audit history shows recent admin/review changes and workers cannot access it.
- The app update flow is visible and reloads only after the user taps `Update App`.
- Anonymous startup makes no authenticated site request, and restored sessions load sites only after authentication refresh succeeds.
- `/api/health/ready` returns ok through Firebase Hosting and can be used for production uptime monitoring.
- The first authenticated API request after an idle period succeeds; a stale managed PostgreSQL/Neon SSL connection is recycled before the route query.
- Applicable `npm.cmd run check:production-hardening` findings and the remaining Neon access/retention warnings are closed or explicitly accepted before real staff data is used.
- Hosted Firebase/Cloud Run checks pass without direct phone access to the managed PostgreSQL provider or Cloud Storage.
- The deployed `index.html` and `sw.js` match the tested release build, and the full hosted real-phone/photo/signature/update-flow checklist is completed rather than inferred from automation.
