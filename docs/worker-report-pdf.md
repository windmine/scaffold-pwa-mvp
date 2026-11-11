# Worker Report PDF download and sharing

Local implementation, not deployed.

In My Reports, open a submitted Report's details to use **Download PDF** or **Share PDF**. These actions are available only to the owning Worker in the current Department. Saved drafts, waiting/syncing device copies and retained Daywork do not expose them. Supervisor export behavior is unchanged.

- Download fetches a fresh PDF of the saved Report, including current Supervisor corrections, using the existing branded renderer and evidence checks.
- Share prepares the same PDF file and invokes the device share menu when file sharing is supported. The user chooses the app and recipient. It never shares a private URL or sends a Report automatically.
- If preparation outlasts the browser's user gesture, the status asks the user to tap Share PDF again. Prepared files expire after one minute, including after suspended-phone time.
- Browsers without native file sharing download the PDF instead. Cancelling or failing an opened share menu never triggers an automatic download. Sharing completion is not proof of recipient delivery.
- An online connection is required. Network loss, expired login, unavailable Reports and evidence-validation errors have recoverable messages. Pending work is single-flight and is invalidated by closing details, history refresh, logout, account/Department changes, and cross-tab authentication changes.
- Prepared PDFs stay in card memory only. They are not added to device drafts, queues, IndexedDB or service-worker caches. Temporary download URLs are revoked on card cleanup or after one minute.

## API and data boundaries

`GET /my-form-submissions/{submission_id}/export.pdf` uses the normal authenticated active/setup-complete Worker dependency. It additionally requires exact Worker ownership, the Worker's current Department, Report purpose and a nondeleted row. Unknown, malformed and inaccessible IDs all return generic 404 responses. Authentication retains 401/403 behavior. The application and API-prefixed endpoint return private, no-store responses, including errors.

The response is an attachment named `report-{id}.pdf`. Frozen-definition photo/signature validation runs before PDF rendering. Neither this endpoint nor either button changes Reports, corrections, email queues, delivery status or recipient selections. The frontend validates MIME and PDF header before saving/sharing a response. There is no database migration, new dependency or change to Supervisor permissions.

## Validation

- `node scripts/report-own-pdf-test.mjs`: isolated Playwright browser fixtures for download, share files, a second user gesture, native cancellation/failure, unsupported fallback, invalid response content, offline/errors, repeated clicks, cleanup, session switches across tabs, suspended-tab expiry, accessibility and English/Chinese layouts at 320/390/1200 px.
- `python backend/report_self_pdf_test.py`: authenticated HTTP/PDF fixtures for ownership and Department IDOR, invalid/deleted/Daywork records, account eligibility, API prefix/private caching, current corrected content, signatures/photos, unsafe evidence and unchanged email rows.
- These suites are registered in the full isolated backend/mobile CI runners. `npm run check:worker-pdf` also runs the two focused suites; use the isolated runner for backend configuration safety.

Native OS chooser outcomes are mocked in automated browser tests. Physical Android/iPhone sharing and authenticated live Reports are not claimed tested. Publication requires separate approval; deploy the compatible backend before Hosting. Integrate with the already-uncommitted offline-readiness/report-status work without dropping its changes, and retain all device drafts/queues.
