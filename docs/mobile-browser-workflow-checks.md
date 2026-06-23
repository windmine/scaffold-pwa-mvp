# Mobile and Browser Workflow Checks

Use this checklist before calling the MVP ready for phone testing or PWA hardening. Run the automated checks first, then do the manual phone/browser pass.

## Latest Manual Pass

- 2026-06-04: Full real-phone workflow pass completed on the local network with no reported blocking issues.

## Automated Preflight

From the project root:

```powershell
npm.cmd run lint
npm.cmd run build
npm.cmd run check:mobile
python -m compileall backend\app backend\smoke_test.py
```

With the backend running at `http://127.0.0.1:8000`:

```powershell
python backend\smoke_test.py
```

`npm.cmd run check:mobile` verifies the built PWA shell, service worker output, update-flow wiring, mobile controls, same-origin proxy setup, supervisor audit-history wiring, offline work-form submission support, photo controls, and signature enforcement. It does not replace a real phone test.

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
- Submit a check-in with notes and an optional photo.
- Submit a check-out later and confirm both records appear in History.
- Submit a task log with work date, hours, safety notes, and at least two photos.
- Open a task-log photo thumbnail and confirm previous/next photo navigation works.
- Submit an active Work Form with a required handwritten signature and at least one photo.
- Try submitting a required-signature form without signing and confirm validation blocks it.
- Apply History filters by type, status, text, and local date.
- Turn off network, submit one attendance record or task log, and confirm it is queued locally.
- Restore network and confirm queued submissions sync and History updates.

## Supervisor Browser Checks

- Login as `supervisor@example.com / Passw0rd!`.
- Confirm the department filter is fixed to Leader for the department-scoped supervisor.
- Confirm Review Queue shows attendance, task logs, weekly team logs, and form submissions together.
- Filter Review Queue by type, status, worker/site text, and date.
- Double-tap a worker attendance action and confirm only one matching record is created.
- Move one attendance record and one task log to the rubbish bin, confirm both disappear from active review, and verify the deletion reason and automatic deletion date.
- Restore both records from the rubbish bin and confirm they return to active review.
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
- Archive and reactivate a Work Form.
- Create or edit a Site and confirm radius values remain valid.
- Mark a worker resigned, confirm they cannot sign in, then reactivate them.
- Confirm a department supervisor has no resign action for a global admin and both status-update API paths reject the attempt.
- Open Audit history and confirm recent changes show editor name, group, access level, action, and timestamp.

## PWA Checks

- Install the app from the browser prompt or browser install menu.
- Open the installed app and confirm login/history screens load.
- Build and deploy a changed `sw.js` version, then reload an already-open app tab.
- Confirm the topbar shows `Update App` and the status banner says a new version is ready.
- Tap `Update App` and confirm the app reloads.
- Confirm backend data and uploaded photos do not appear stale after refresh or reinstall.

## Pass Criteria

- Worker and supervisor paths complete without console-breaking errors.
- Geolocation denial, offline state, backend outage, and photo/signature validation show clear messages.
- Queued worker submissions sync after reconnect.
- Expired sessions pause queued sync, keep the queued record, and show a sign-in-again message.
- Retried queued submissions do not create duplicate backend Review Records.
- Supervisor review shows synced worker records, photos, and signatures.
- Supervisor Audit history shows recent admin/review changes and workers cannot access it.
- The app update flow is visible and reloads only after the user taps `Update App`.
