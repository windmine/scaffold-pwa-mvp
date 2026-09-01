# Mobile and Browser Workflow Checks

Use this checklist before calling the MVP ready for phone testing or production use. Local automation, hosted automation, and a hosted real-phone pass are separate gates.

## Latest Manual Pass

- 2026-06-04: Full real-phone workflow pass completed on the local network with no reported blocking issues.
- That pass covered the retained full field-operations interface. The current report-only release candidate has not yet completed a hosted real-phone pass.
- The equivalent real-phone pass against the hosted Firebase URL is still pending; the 2026-08-13 release result below is an automated local-browser and hosted HTTP/API pass for the currently deployed historical build.

## Latest Automated Pass

- 2026-09-01 local report-only pass: the in-app browser at 390 × 844 completed Worker submission without a Site → **My Reports** → Supervisor structured filters / **Start review** / required resolution-note validation / **Resolve report** → final note back in **My Reports**. **Report Templates** and **Staff** navigation had no horizontal overflow. `npm.cmd run check:mobile` then regenerated the PWA and passed the static preflight plus all 33 Playwright Chromium workflows, including production-mode Report draft/update, report-only waiting-service-worker, offline-history isolation, explicit-purpose, and replay-scope checks.
- This completed the local mobile/browser gate. No live promotion, real-phone, cold installed-PWA Report, or two-deployment update pass has been recorded yet; isolated staging evidence does not replace those device checks.

- 2026-08-13 frontend release pass at commit `bcfb128`: lint, production build/static PWA checks, Review Queue checks, all 28 Playwright Chromium workflows, production dependency audit with zero findings, Python dependency consistency, and the controlled production-hardening gate passed with the three known warnings for incident-only Monitoring, six-hour Neon retention, and skipped budget verification. The full development audit separately reported high-severity `brace-expansion` and `nanoid` plus moderate-severity `postcss`, all in the development toolchain. Firebase preview `release-20260813120158` at `https://geo-attendance-system-db9ca--release-20260813120158-1krt9yox.web.app` was verified before exact Hosting version `c761984b7353028a` was cloned live. Local, preview, and live SHA-256 hashes matched for `index.html` (`e3e0068a0d40e37d3f2c5ecad352be404a9cecc91c358f0d31c96cfdb1b6df82`), `sw.js` (`8f3a391469c4124f6cd7f6e1d501481fb2e0361a7bea5cb409f0cb8ab0380265`), `offline.html` (`5034e9dd2d5df27e72c356632a8e984fa0ea389adfcf1870dafe0b3d64837ff2`), `manifest.webmanifest` (`24b60cb58ae8a220b51b3e52cc16aa0360d87f0f63f4e9c713fab0d6b990d35e`), `assets/js/supervisor-analytics.js` (`057f834252ea774535e61ebcea8d9b8b8f37b258959a0ef794c953c4f8494e86`), and `assets/css/styles.css` (`2a1ccef893ad2ad70d1330a079827b81f940c55b1d4a76380c4c9478c89efb89`). All 47 generated app-shell paths plus `sw.js` matched on preview and live; five preview and five live readiness probes reported database and GCS healthy; anonymous Sites returned 401; invited-only/hidden-registration state, login-before-install ordering, cache headers, hashed entrypoints, and both scoped offline snapshots passed. Local browser coverage verified Analytics exceptions open the exact collision-safe Review Record or valid attendance map point after conflicting filters, and essential map/Analytics labels render at least 14px at desktop and phone widths without page overflow. No authenticated hosted mutation was performed; the full hosted real-phone checklist remains pending. Cloud Run remained unchanged at `geo-backend-release-20260804152130`.
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

Before signing in, confirm the login screen says `Invited accounts only`, the public registration panel is absent, and the page does not request protected `/api/sites`, `/api/work-forms`, or Report-history data or briefly populate Worker site controls with local demo Sites. When restoring a saved session, `/api/auth/refresh` must complete before those protected resources are trusted.

Firebase Hosting version `c761984b7353028a` is the verified historical full-interface build. Its invited-only shell, login-before-install ordering, list-first Staff/Work Form administration, scoped cold-offline update, consequential-action dialog, actionable Analytics exceptions, and 14px essential map/Analytics labels are live and hash-matched. The report-only working tree is not live until a new preview is verified and its exact Hosting version is cloned. Complete the report-only Worker, Supervisor, installed-PWA, replay, evidence-streaming, translation, and update-flow steps below against that new version before treating the hosted device gate as complete.

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

With the backend running at `http://127.0.0.1:8000`:

```powershell
python backend\smoke_test.py
```

`npm.cmd run check:mobile` builds and regenerates the production PWA, verifies its shell/cache, and runs 33 Playwright Chromium workflows at a default 390 × 844 viewport. The production-default workflow checks the two-item Worker Report navigation, three-item Supervisor Report navigation, hidden full-interface modules, required Report Date, optional Site, report-only filtering, normal-Worker submission, private history, forward-only transitions, and the final Supervisor note. Focused replay checks prove one Report photo and two nested signatures resume after a partial upload failure, reuse completed uploads and their client submission id on a forced second replay, produce exactly one durable Report, and leave hidden attendance/task/Daywork queue records untouched in report-only mode. Additional checks cover offline **My Reports** isolation and explicit Report purpose overriding misleading Daywork wording. Retained attendance, Daywork, weekly-log, map, analytics, and offline workflows run with a test-only pre-load override so the hidden interface remains reversible and regression-tested. The workflow uses temporary backend, lightweight Node source/proxy, and production-preview ports `8765`, `5175`, and `4175`; override them with `BROWSER_WORKFLOW_BACKEND_PORT`, `BROWSER_WORKFLOW_FRONTEND_PORT`, and `BROWSER_WORKFLOW_PREVIEW_PORT`. The source server keeps the app and test probes on the same unbundled module instances without Vite's development watcher; unexpected managed-process exits fail fast with recent output instead of cascading into unrelated connection errors. It does not replace a real phone test.

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

## Report-Only Worker Phone Checks

- Confirm the sign-in screen says `Invited accounts only` and does not show public registration controls.
- Use portrait at roughly 390 × 844 first, then landscape. Confirm there is no page-level horizontal overflow, fixed control covering content, clipped field/action, or touch target that requires hover.
- Sign in as a Normal Worker and as the seeded Leader. Confirm both see only **New Report** and **My Reports**, plus account details and **Log out**.
- Confirm attendance, Daywork, weekly team logs, missing-site controls, and the attendance summary are absent.
- Open **New Report** and confirm only active `report` purpose Templates from the Worker's Department are offered. Archived, other-Department, and Legacy Daywork Templates must not appear.
- Submit one Report without a Site and one with a Site. Confirm **Report Date** is required, **Site (optional)** is not required, and the no-Site Report is shown as `Unassigned site`.
- Complete representative text/choice/conditional/time-range/formula/repeat fields. Confirm required fields and an empty required signature block submission, focus the invalid control, and show a useful message.
- Draw required signatures with touch, including a signature inside a repeat row when available. Add a real camera/gallery JPEG, PNG, or WebP; confirm over-5-MB or unsupported evidence is rejected before queue/upload.
- Make edits, wait for `Saved at...`, reload, reselect the same Template, and confirm the Worker/Report Template draft restores its Site, Report Date, answers, signatures, and photos. Make another edit and immediately log out; logout must wait for the save or refuse to discard unsaved input. Sign the same Worker back in, reselect the Template, and confirm the latest saved draft; another Worker must not see it.
- Submit online and confirm **My Reports** shows only that Worker's Report, **Submitted**, labelled submission time, Report Date, optional Site, submitted answers/evidence, and no final Supervisor note yet. Attendance, task, weekly-log, and Legacy Daywork records must not appear.
- Verify **Find**, **Submitted**, **In review**, **Resolved**, **Queued**, and local Report Date filters, then clear them. Open photo/signature thumbnails in the viewer.
- For the offline pass, load a Template while online and keep the page open, then switch the phone offline. Complete and submit a Report with a photo and required signature; confirm **My Reports** shows **Queued** and offers **Retry sync** / **Discard local copy**.
- While it is queued, sign in as another Worker on the same device and confirm the first Worker's Report is neither shown nor replayed. Sign the owning Worker back in, reconnect, and retry if automatic sync does not run.
- Interrupt one evidence upload if browser tooling permits, then retry. Confirm already completed photo/signature uploads are reused, the stable client submission id creates exactly one durable Report, and all durable images use authenticated `/uploads/...` URLs.
- After the Supervisor completes review, refresh **My Reports** and confirm **In review**, then **Resolved**, including the final Supervisor note.
- Toggle Simplified Chinese and repeat the key navigation, validation, queue, status, Supervisor-note, and update messages. Confirm the report workflow does not leave mixed English labels in the active UI.

## Report-Only Supervisor Phone-Width Checks

- Sign in at portrait phone width. Open **Workspaces** and confirm the drawer contains exactly **Reports**, **Report Templates**, and **Staff**, with **Reports** selected after sign-in; confirm focus reaches the drawer close control and returns sensibly after navigation.
- Confirm **Reports** contains only `report` purpose submissions; Legacy Daywork is absent and the fixed report-type filter is not exposed.
- Search with **Find**, then filter Reports by **Submitted**, **In review**, and **Resolved** and combine workflow with Report Template, Worker, and Report Date. Confirm pagination and empty states reflect the server result. **Find** is list-only; it is not included in collection exports.
- Select a **Submitted** Report. Confirm the detail contains Worker, Template, optional Site, Report Date, submitted time, immutable answers/photos/signatures, and **Start review**; legacy **Approve**, **Reject**, **Edit**, and **Move to bin** actions must be absent while Audit/recovery is hidden.
- Choose **Start review** and confirm the Report appears under **In review**. Choose **Resolve report**, submit an empty note to confirm validation/focus, then enter a final note and confirm the Report appears under **Resolved** with that note and no further transition action.
- Open all photo/signature evidence. Confirm a selected Report can export as HTML, PDF, and CSV and that the visible collection exports are **Export Reports CSV** and **Export Reports PDF**. Resolved exports must say **Resolved** and include the final note, reviewing Supervisor, review-started time, and resolved time rather than the retained legacy `pending` status.
- Confirm collection exports follow Department focus plus workflow, Report Template, Worker, and Report Date and contain no Legacy Daywork rows. Confirm attendance/task-log exports remain hidden.
- Remove the network after a successful list load. Confirm the last durable Reports are explicitly read-only and no transition or export is presented as a successful live action.
- Confirm maps, analytics, attendance/task entry, Sites, audit/recovery, and the unrelated export workspace are absent.
- Under **Report Templates**, confirm the list-first view, **Add Report Template**, Cancel/reset/focus restoration, field-card controls, touch signature preview, create single-flight protection, edit/version, archive, and reactivate flows all fit without horizontal overflow.
- Reopen a Report submitted before a Template edit and confirm its frozen labels, fields, formulas, photos, and signatures are unchanged.
- Under **Staff**, confirm the list-first view, **Add staff**, Cancel/reset/focus restoration, create single-flight protection, search, edit, resign, and reactivate. Confirm Sites remain hidden and Global Admin remains Supervisor-only.
- Toggle Simplified Chinese and repeat navigation, workflow actions, resolution validation, Report export labels, Template actions, Staff actions, and empty/error states. Confirm the active report-only UI is not mixed-language.

## Retained Full-Interface Worker Regression Checks

These checks apply to the retained interface when `REPORT_ONLY_MODE` is disabled. The automated browser suite uses its test-only override for this coverage.

- Confirm the sign-in screen says `Invited accounts only` and does not show public registration controls.
- Login as `worker@example.com / Passw0rd!`.
- Confirm the seeded account shows a Leader badge and provides Team, Daywork, Form, and missing-site controls.
- Create a separate Normal worker from Staff users, sign in, and confirm Check in / out, Form, and My history are available while Team, Daywork, and missing-site controls remain hidden.
- Confirm the normal-worker home screen shows the full three-step Site, Location, and attendance-action guide before first use, then compacts it after the Worker's first attendance event so the controls appear sooner.
- Confirm checkout defaults to the open check-in's Site. Without a fresh location, confirm recently used Sites rank first; after location capture, confirm nearer Sites rank first without replacing an explicit current selection.
- Confirm check-in/out buttons remain disabled until a site is selected and location is captured.
- Interrupt the Sites request and confirm authenticated workers see Sites unavailable rather than seeded demo Sites.
- Confirm Today’s attendance clearly shows current status and the next expected action.
- Confirm the normal worker can list active Department Report Templates, choose **Submit Report**, and find the result in **My Reports**. Confirm they still cannot create a Site, task log, or weekly team log through the API.
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
- Submit a Report from an active Report Template with a required handwritten signature and at least one photo.
- Try submitting a required-signature form without signing and confirm validation blocks it.
- Enter different values using two Report Templates, wait for each `Saved at...` receipt, switch between them, reload, and confirm each Worker/Report Template draft restores its own Site, Report Date, answers, signatures, and photos.
- Make a final Report edit and immediately log out; sign the same Worker back in and confirm the latest draft restores. Sign in as a different Worker and confirm that draft is never shown.
- Apply History filters by type, status, text, and local date.
- Turn off network, submit one attendance record or task log, and confirm it is queued locally.
- While editing Daywork or a Report, restore connectivity and confirm typed answers and signatures remain intact.
- While it is queued, switch to another Worker account on the same device and confirm the first Worker's record is not replayed, displayed, or reassigned as the second Worker.
- Restore network and confirm queued submissions sync and History updates.
- Force an upload failure and confirm History shows the sync error with Retry and Discard controls for the owning Worker.
- For a queued Report with a photo and required signatures, fail one upload, replay after reconnect, then force a second replay with the same client submission id. Confirm completed uploads are not repeated and My Reports contains exactly one durable Report with every photo and signature.
- Delay one attendance replay and confirm the durable record retains its original occurrence time rather than the reconnect time; retry it and confirm the stable client submission id prevents a duplicate.

## Retained Full-Interface Supervisor Regression Checks

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
- At normal browser text scale, confirm SITE/IN/OUT markers, map tooltips/history, trend dates, exception chips/actions, and site-summary headers remain readable outdoors without causing horizontal page overflow.
- Set Review Queue and map filters that exclude a known exception, preferably one outside the first Review Queue page. From Management analytics, open that exception's Review Record and confirm the conflicting Review filters clear and the exact record is selected. For an attendance exception with valid coordinates, use its map action and confirm the conflicting map filters clear and the exact point/history row is highlighted.
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
- Create a new Report Template with field cards and a required `signature` field. Confirm type, label, required state, choice options, conditions, and repeat row controls remain usable at phone width without horizontal overflow.
- Reorder cards with a drag handle and with Move up/down. Confirm the worker preview and saved API field order match, the move is announced, and a move that places a condition/formula before its source is rejected locally.
- Open **Advanced: edit raw field syntax**, confirm the generated syntax retains stable `id=` metadata, and verify preview/save asks you to apply or discard staged raw edits. Apply valid syntax and confirm the cards rebuild; enter invalid syntax and confirm the previous cards remain intact with local feedback.
- Include a time range, conditional field, repeatable section, and formula. Confirm the backend response contains authoritative derived values and a Definition version/snapshot.
- Change a choice/formula/repeating-group field type in the Report Template builder. Confirm Cancel preserves its options/formula/children and Confirm applies the lossy draft change. Confirm the dialog copy is fully translated when Chinese is selected.
- Edit and save the reusable Report Template without a redundant confirmation, reopen the old Report/export, and confirm its historical labels, fields, formulas, and signatures still use the original snapshot.
- Archive and reactivate a Report Template without a redundant confirmation dialog.
- Create or edit a Site, complete the geofence-impact app confirmation, and confirm radius values remain valid.
- Mark a worker resigned through the access-impact app confirmation, confirm they cannot sign in, then reactivate them through the matching confirmation.
- Confirm a department supervisor has no resign action for a global admin and both status-update API paths reject the attempt.
- Open Audit history and confirm recent changes show editor name, group, access level, action, and timestamp.

## Hosted Installed-PWA Checks

Use controlled hosted accounts and a disposable Report marker. Record the tested commit, Firebase preview/live Hosting version, Cloud Run revision, phone model/OS, browser/PWA mode, language, network transitions, and cleanup result.

- Install the app from the hosted Firebase URL using the browser prompt or browser install menu. Confirm the installed app stays same-origin for `/api/**`, `/photo-uploads`, and `/uploads/...` requests.
- Open the installed app in portrait and landscape. Confirm invited-only login, **New Report** / **My Reports**, and the Supervisor Workspace drawer match the browser checks above without overflow.
- While online, sign in as a Worker, load a Report Template, start a Report with a real photo and required handwritten signature, wait for `Saved at...`, then enable airplane mode without closing the app.
- Submit while offline and confirm the Report is **Queued**. Fully close and reopen the installed app while still offline. Confirm the cached report-only application shell opens instead of the static offline page and **My Reports** can show the owning Worker's local queued Report.
- Confirm the cold-offline limitation is honest: backend Report history and Report Templates are unavailable, and a new Report cannot begin until a Template can be fetched after reconnect. Protected API/upload navigation must never receive cached application HTML.
- Reconnect as the owning Worker. Confirm the queued Report syncs once, keeps its original capture/submission identity, and includes every photo/signature. Refresh each authenticated `/uploads/...` URL and reopen the evidence as the authorized Supervisor.
- Sign out and sign in as another Worker. Confirm the first Worker's draft and queue record are not exposed or replayed. An expired session must keep the queue item and request that the owner sign in again.
- For the update pass, keep the installed baseline app open, deploy a deliberately changed generated service worker through the verified preview/live process, and return to the existing app client. Do not infer this step from a fresh install.
- Confirm the topbar shows **Update App** and the status banner says a new version is ready. The app must not reload until the user chooses the action.
- Make an unsaved Report edit, choose **Update App**, and confirm the latest revision reaches `Saved at...` or **Draft saved. Updating app...** before reload. After reload, confirm the new version is active; reselect the same Report Template and confirm its matching draft restores.
- Simulate local draft-storage failure where browser tooling permits. Confirm the update pauses without reloading, focuses a safe choice, offers **Try saving again** and **Keep editing**, and proceeds only after a successful retry.
- Toggle Simplified Chinese before a second update attempt and confirm all waiting, saving, paused, retry, and reload messages are translated.
- Confirm backend Reports and uploaded evidence do not appear stale after refresh or reinstall. Record controlled-data disposition: archive test Templates, resign test accounts when no longer needed, and use the approved Report-retention/deletion procedure rather than direct database edits.

### Retained Full-Interface PWA Regression

Run this separately with the test-only full-interface override; it is not a visible report-only product promise.

- While online, sign in as a Worker and load the current Site list. Fully close the installed production preview, enable offline mode, and reopen it. Confirm the cached application restores only that Worker/Department Site and attendance snapshots.
- Capture location and queue attendance offline, close/reopen once more, reconnect, and confirm exactly-once replay with the original occurrence time and current backend Site/radius authorization.

## Pass Criteria

- The sign-in screen identifies invited-account access and public registration controls are not visible.
- At phone width, Workers expose exactly **New Report** and **My Reports**; Supervisors expose exactly **Reports**, **Report Templates**, and **Staff**. Hidden retained modules cannot be reached from production navigation.
- Normal Workers and Leaders can submit active Department Report Templates. Legacy Daywork is excluded. Report Date is required, Site is optional, required signatures are enforced, and unsupported/oversized photos show clear errors.
- **My Reports** is private to the signed-in Worker and uses **Queued**, **Submitted**, **In review**, and **Resolved** correctly. Resolved Reports show the final Supervisor note.
- Supervisor Report review is forward-only: **Submitted → In review → Resolved** with a required resolution note. Legacy Approve, Reject, Edit, and Supervisor-create APIs reject Reports, and submitted purpose/Site/Report Date/answers/photos/signatures remain immutable.
- Report list search, structured filters, pagination, selected detail, Template management, Staff management, and structured-filter CSV/PDF exports complete at phone width without console-breaking errors or horizontal page overflow. Free-text **Find** is list-only.
- Offline/backend-outage/photo/signature errors are explicit. A queued Report stays bound to its Worker and stable client submission id; partial evidence uploads resume, retries create one durable Report, and an expired session preserves the queue until the owner signs in.
- A killed/refreshed installed PWA cold-launches the cached report-only shell and can display its owning Worker's local queued Report. It does not claim that network-only Report Templates or backend history are available, and protected API/upload paths never receive cached application content.
- Real hosted photo and signature URLs stream through authenticated `/uploads/...` after refresh for the Worker and authorized Supervisor.
- **Update App** appears only for a waiting service worker, reloads only after the user chooses it, protects the active Report draft, and pauses safely when draft storage fails.
- English and Simplified Chinese Worker/Supervisor/report/update paths are complete enough to avoid mixed high-value labels or untranslated validation/actions.
- Anonymous startup makes no authenticated Site request, and restored sessions refresh authentication before Sites or Report Templates are trusted.
- `/api/health/ready` returns ok through Firebase Hosting and can be used for production uptime monitoring.
- The first authenticated API request after an idle period succeeds; a stale managed PostgreSQL/Neon SSL connection is recycled before the route query.
- Applicable `npm.cmd run check:production-hardening` findings and the remaining Neon access/retention warnings are closed or explicitly accepted before real staff data is used.
- Hosted Firebase/Cloud Run checks pass without direct phone access to the managed PostgreSQL provider or Cloud Storage.
- The deployed generated shell and `sw.js` match the tested release build, and the full hosted real-phone/report-replay/photo/signature/update-flow checklist is completed rather than inferred from automation or the 2026-08-13 historical release.

For the retained full-interface regression only, geolocation denial, scoped Site/attendance cold launch, queued attendance occurrence time, Supervisor mixed-record Review Queue, Audit history, maps, analytics, and recovery flows must continue to pass under the explicit test override.

## Manual Hosted Pass Record

Copy this block into the release evidence or pull-request notes after the pass:

```text
Date/time and timezone:
Tester:
Commit:
Firebase preview URL/version:
Firebase live Hosting version:
Cloud Run revision:
Phone model / OS:
Browser and installed-PWA mode:
English result:
Simplified Chinese result:
Worker Report marker(s):
Supervisor transition/export result:
Offline photo/signature replay backend record id:
Waiting-service-worker update result:
Readiness/log result:
Controlled-data cleanup result:
Overall PASS / FAIL and defects:
```
