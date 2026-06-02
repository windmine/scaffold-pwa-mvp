# Mobile and Browser Workflow Checks

Use this checklist before calling the MVP ready for phone testing or PWA hardening. Run the automated checks first, then do the manual phone/browser pass.

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

2. Seed demo accounts from Swagger or another API client:

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
- Confirm Review Queue shows attendance, task logs, and form submissions together.
- Filter Review Queue by type, status, worker/site text, and date.
- Open submitted photos and signatures from review records.
- Approve one pending record and reject another pending record.
- Edit one attendance record after the double-check confirmation.
- Edit one task log after the double-check confirmation.
- Create a new Work Form with a required `signature` field.
- Archive and reactivate a Work Form.
- Create or edit a Site and confirm radius values remain valid.
- Mark a worker resigned, confirm they cannot sign in, then reactivate them.
- Open Audit history and confirm the recent review, site, staff, and work-form changes appear with actor and timestamp.

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
