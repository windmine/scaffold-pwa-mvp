# Leader Field Reports Context

This file defines the product language for the report-only MVP. Use these terms consistently in modules, routes, UI copy, tests, and documentation. The broader geo-attendance, Daywork, task-log, weekly-log, map, analytics, export, and recovery code remains available only as a reversible legacy interface. Deployment truth was refreshed on 2026-10-05; preserve dated evidence as historical rather than treating older serving identities as current.

## People And Scope

**Worker**:
A field user who submits Reports from active Department Report Templates and sees only their own Report history. A Worker may be a Normal worker or a Leader; both classes have the same report-only product surface.
_Avoid_: Staff user when role-specific behaviour matters

**Normal worker**:
A Worker who can submit Reports and view My Reports. Normal workers cannot use retained Site-creation, task-log, or weekly Team Work Log APIs.
_Avoid_: Basic user

**Leader**:
A retained Worker class with broader legacy field-operation privileges. In the report-only product a Leader sees the same New Report and My Reports surface as every other Worker. Leader is not the Supervisor role.
_Avoid_: Treating Leader as a Report approval role

**Supervisor**:
An admin user who reviews Department Reports, manages Report Templates, and manages Staff. A Department Supervisor may not read or transition another Department's Reports.
_Avoid_: Approver when describing the Report workflow

**Invited account**:
A new Worker account provisioned by a Supervisor and blocked from signing in until the Worker sets their own password through a private, expiring, single-use invitation. Released `0021` provides authenticated Supervisor issuance/reissue/revocation and explicit private handoff; it does not send email automatically. The report-only Staff flow uses invitations, while established accounts and retained/Supervisor provisioning remain compatible. Employment status remains separate from password-setup status. Established accounts cannot be invitation reset targets. The public registration UI is hidden, while the dormant verified-registration API remains callable but is not supported as the pilot onboarding path.
_Avoid_: Self-registered account when describing current pilot access

The invitation migration and compatible backend were deployed before the coupled frontend on 2026-09-15. Native PostgreSQL contention, provider staging and hosted automated checks passed. Physical-phone setup and verified intended-recipient private handoff remain pre-broader-onboarding gates; deployment does not prove delivery or email ownership.

Released 2026-09-25 improvements preserve manual handoff but add a user-triggered native Share option with Copy fallback. A clean browser can **Set password and continue** through ordinary password authentication at a distinct, mandatory-guard `/auth/login/after-setup` endpoint. Acceptance itself remains cookie-free. Existing browser credentials or saved identities block continuation without logout or draft removal; old backends lacking the route fall back to normal sign-in. The visible **Forgot password?** route explains supervisor-assisted recovery, not self-service reset. Established-account reset credentials and session revocation are not implemented by this change. Generation guards protect local identity/UI changes, but cannot cancel an in-flight server cookie response; independent simultaneous sign-ins are not globally atomic.

**Private password recovery** (released 2026-09-29):
Distinct from an invitation: an authorized Supervisor verifies an established Worker's identity and privately shares a one-hour, single-use recovery link. Only active Workers who have completed setup qualify; no email service or public account-lookup/reset request is exposed. Creating/replacing/revoking a link leaves the current password and sessions unchanged. Acceptance rotates the password and authentication generation atomically; old bearer/cookie sessions are rejected. Hashed tokens are purpose-separated from invitations and bound to the Worker, Department, email and recovery generation. Replacement, revocation and relevant Staff edits invalidate outstanding links.

The standalone recovery page keeps its URL-fragment token only in memory, makes cookie-free requests and never logs in automatically or modifies another account's saved identity/drafts. The Worker signs in normally after reset. A recovery link proves possession of the capability, not email ownership or verified delivery. Additive `0022_worker_password_recovery` and its compatible backend preceded the September 29 Hosting promotion; once credentials have rotated, an older backend that ignores authentication generations is not a safe rollback. September 25 deployment statements are historical.

**Global admin**:
A Supervisor who may focus the dashboard on any Department or all Departments. The saved dashboard focus does not change the account's home Department.
_Avoid_: Supervisor when cross-department authority is important

**Remembered review filters** (released 2026-09-29):
Device-local, structured Supervisor Report preferences: Workflow, Template ID, Worker ID and Report Date. Keys bind Supervisor identity, home Department, global-admin capability and effective focused Department; All departments is its own global scope. Find text, names, Report content and authentication data are excluded. These preferences do not grant access, cache protected Reports, or change the backend saved default Department. Current authorized catalogs validate stored IDs before querying. Workflow shortcuts preserve other filters, and Clear resets only the current scope.

**Oldest waiting** (released 2026-10-05; locally prepared 2026-10-02):
A Supervisor Report inbox ordering, distinct from Workflow filtering. Submitted Reports rank first, In review second and Resolved last; each rank uses ascending immutable server submission time and durable ID. Newest first remains the default. The backend sorts the complete authorized query before pagination. Oldest-waiting cursors bind filters/order and reconstruct workflow rank at the first page's snapshot from forward-only transition timestamps; current serialized workflow remains authoritative. Because a transition timestamp can precede its commit, an exact fixed-size digest of matching IDs, submission times and snapshot ranks guards traversal and concurrent page reads. Changed keys require an explicit Refresh, retaining loaded results read-only and preserving notes. The guard streams all matching keys twice per page (linear read cost, bounded working memory); it does not put a growing ID list in the cursor. This is not a full historical Report snapshot. Refresh starts a current view.

Sort order joins device-local, exact-scope review preferences. Workflow shortcuts retain it; Clear resets it. Changed order invalidates loaded pages, cursors and late responses. Only same-query durable results may remain in an explicitly read-only offline fallback. Submitted Reports show elapsed waiting time since server submission (minutes/hours/24-hour days), not Report Date or offline capture time. Future clock skew is clamped to zero, invalid timestamps show no age, and labels update without remounting notes. No SLA, overdue threshold, Worker change, export ordering change or workflow mutation is implied. This requires the compatible backend before Hosting but no migration; unsupported servers cannot silently present newest results as oldest waiting.

**Accounting / Payroll**:
The future office workflow that reviews approved attendance by pay period and exports payroll-ready hour summaries.
_Avoid_: Supervisor when the workflow is wage/hour calculation rather than record approval

**Department**:
The ownership and authorization boundary for Workers, Supervisors, Sites, and Review Records. Current fixed values are Leader, Mutual, MC, Stech, and BOP.
_Avoid_: Group when authorization scope is meant

**Site**:
A retained job-location entity. Site is optional on a Report; report submission does not require geolocation or radius validation.
_Avoid_: Job or location when the stored Site entity is meant

## Field Records

**Report**:
An immutable Worker submission created from an active Report Template. It contains a required Report Date, optional Site, answers, photos, signatures, an exact Definition snapshot, submission time, and Report workflow state. A Worker can read only their own Reports.
The released limit is 50 JPEG/PNG/WebP photos at most 5 MB each; configured handwritten signatures are additional. Retained Daywork/Task Logs keep their eight-photo limit. These limits do not certify physical-phone capacity for maximum-size batches.
Report Date must be a real calendar date in `YYYY-MM-DD` format, not merely a string matching that shape. Calendar validation introduces no additional past/future date restriction and never rewrites the original date on duplicate replay.
_Avoid_: Diary, Daywork, Work Form, or approval record in user-facing language

**Report Template**:
A reusable, versioned, Supervisor-managed definition with `template_purpose=report`. Every active Worker in its Department may submit it. Archived Report Templates cannot accept new Reports.
_Avoid_: Work Form in user-facing language

The Template library released September 29 defaults to Active and filters published Templates by lifecycle state and name/description search. Its compact field/signature/group counts describe the Definition, not completed answers or submitted Reports. Private unfinished Template drafts remain separate and are never hidden or discarded by library filtering. Full Definitions remain available through Preview and Edit; filtering does not change Worker availability, versions or Report snapshots. A known minor first-load limitation can clear a query entered before identity-scoped initialization finishes.

**Review & submit** (released 2026-09-29):
The Worker's final read-only summary of Template, Report Date, optional Site, answers, photo count and signatures. Opening review saves the draft when possible but does not upload or queue evidence. Back to edit preserves the originals; only explicit final confirmation submits or queues the reviewed snapshot. Submitted Reports remain immutable.

**Photo selection** (released 2026-09-29):
Mixed batches retain valid files in order and name rejected files with type, size or capacity reasons. Serial, maximum-320-pixel editor thumbnails are disposable display copies; drafts, the original viewer and upload requests retain original File/Blob bytes. This does not certify physical-phone capacity for 50 near-5-MB originals.

**Photo gallery** (released 2026-10-05; locally prepared 2026-09-30):
The read-only evidence view in an expanded Worker Report or Supervisor Report detail. At most six previews are shown; View all opens the full original sequence with Report-mode swipe/zoom controls. Gallery state and Blob URLs are temporary and belong to the current rendered record/session. Closing, replacing or clearing that record releases its URLs and viewer. It does not alter evidence, metadata, signatures, photo selection, replay or exports, and does not apply to retained Daywork.

**Photo storage warning** (released 2026-10-05; locally prepared 2026-10-02):
A read-only, bounded browser-quota estimate before validated Report photo originals enter the editor, previews or draft. Low estimated headroom or a large batch asks the Worker to choose fewer photos (initial focus) or explicitly add them anyway. The estimate describes origin storage, not actual free device space; even apparently ample quota cannot certify saving. Missing, rejected, malformed or timed-out estimates remain unknown, with a caution for large batches. Existing photos and local signatures count toward conservative headroom. No files are silently removed, compressed or uploaded; Report/Daywork limits are unchanged.

Drafts and queued Reports are device-local, evictable copies, not backups. Keep original photos, do not clear this app's site data, and keep the page open if saving fails. Free space elsewhere or reduce selected photos before retrying the draft save. Submission itself needs local storage first; confirm server submission in My Reports. A quota failure during submission can follow server acceptance, so the warning requires checking My Reports rather than claiming the Report was not submitted. These advisories do not reserve storage, prevent eviction or certify phone memory/capacity. No persistence permission, automatic cleanup or new backend/migration is included.

**Report workflow**:
The forward-only state machine **Submitted → In review → Resolved**. An authorised Department Supervisor starts review and resolves with a required final Supervisor note. Report transitions are separate from legacy approve/reject decisions, atomic, and audit-logged.
_Avoid_: Pending, approved, rejected, approval, or rejection when describing a Report state

**Resolution-note draft** (released 2026-10-05; locally prepared 2026-10-01):
A Supervisor's private unfinished text for one durable Report, saved only in this browser's IndexedDB. The key binds Supervisor identity, home Department, global capability, actual Report Department and Report ID. It is not a Report field, a shared reviewer note, an export, or an offline mutation. Close keeps it; Continue note restores it; explicit Discard removes only that draft. Raw whitespace is preserved up to the existing 1,000-character limit; only explicit Resolve trims the final note and sends it to the existing workflow endpoint after fresh authorization/workflow validation.

Saved notes survive ordinary reload/logout and workspace/Report switching. Failed saves block app-controlled departure, and cross-tab revisions prevent stale overwrite/deletion. Failed or uncertain resolution keeps the draft for explicit refresh/retry; confirmed success cannot submit again, even if draft cleanup fails. A saved copy for an already-resolved Report is read-only and cannot replace its final note. Device storage can be evicted or cleared, is not encrypted or cross-device backup, and cannot guarantee the last write survives browser/OS termination. Forced authorization expiry prioritizes clearing private UI and only attempts a best-effort save.

**Legacy Daywork**:
A retained Work Form and submission with purpose `daywork`. It is excluded from New Report, My Reports, Supervisor Reports, and Report exports. Its code and legacy approval behaviour remain available only through the reversible full-interface path.
_Avoid_: Calling Daywork a Report

**Review Record**:
The durable supervisor-facing representation used by the retained full interface for Attendance, Task Log, Legacy Daywork, or weekly Team Work Log records. It may be pending, approved, or rejected. Reports use the separate Report workflow even though the shared query adapter remains internal.
_Avoid_: Approval when referring to the record itself

**Review Queue**:
The searchable, filterable, cursor-paginated feed of durable Review Records. Pending is its default decision workload, but approved and rejected records are also queryable.
_Avoid_: Pending attendance, or treating the currently visible page as the complete data set

**Review Queue page**:
One filtered page of Review Records used by the visible queue. It is not authoritative for dashboard totals or Management Analytics.
Report collection exports apply the same Find and structured filters as the Report inbox to every matching durable Report, not just this page. Local drafts, recovery copies and unsynced submissions never enter those exports.
_Avoid_: Review Queue total

**Management Analytics**:
The implemented supervisor report over a complete, unfiltered Review Queue snapshot for the selected Department and time period. It reports operational trends and exceptions; it does not calculate payable hours.
_Avoid_: Payroll Summary

**Payroll Summary**:
A planned pay-period view that pairs approved attendance into worker/day totals for accounting review.
_Avoid_: Management Analytics or Review Queue

**Payroll Exception**:
A record or day requiring resolution before payroll export, such as a missing check-out, duplicate event, pending/rejected or outside-site event, or manual Supervisor adjustment.
_Avoid_: Error when the item may be legitimate but unresolved

## Module Invariants

**Offline Submission**:
A Worker-owned Report or retained field record captured on one device and synced to the backend when possible. The module owns Worker identity, capture time, stable Client Submission ID, replay state, and partial-upload state. Report photo/signature upload progress is durable across retries and replay creates at most one Report.
Reports capture the completed Definition version and preserve original answers independently of upload-progress URLs. A changed Template blocks first replay before normalization; the original queued copy remains for explicit recovery, never silently upgraded. Older unversioned queues are accepted only against an unedited version 1 Template. Idempotent replay of an already-durable Report still returns its immutable snapshot after Template edits or archival.
Saved drafts whose Template changed are read-only. Explicit recovery persists the original answers/evidence as a private local **Saved draft** before opening the current Template blank. A recovery copy may be incomplete and is never uploaded or replayed; it is not a submitted Report. Autosave must not reinterpret old drafts using current fields or a newly fetched version.
Ordinary autosaved Report drafts are separate from Offline Submissions and recovery copies. **Drafts on this device** exposes only Template, Report Date, save time, and availability for the signed-in Worker and Department; it never contributes to Report counts, filters, exports, or replay. New snapshots include explicit Department and Report purpose. Legacy snapshots require a scoped Report Template authenticated online before discovery or restore; a matching downloaded Template can supply that context on an offline return. Continue uses the existing Definition-version guard; unavailable Templates cannot be opened. Draft photo selections append in order, removal preserves evidence/metadata alignment, and neither operation changes submitted Reports.

**Failed upload recovery** (released 2026-10-05 with recovery-isolation compatibility fix; locally prepared 2026-10-01):
Rollback boundary: a September 29 shell cannot display the new recovery namespace or Supervisor note drafts. Preserve those bytes, prefer a compatible forward fix while unfinished work exists, and keep the October-compatible backend in any emergency shell rollback. Its exact lookup, identity binding and purged-key guard are required independently of the unchanged migration ledger.

An explicit Worker **Recover as draft** action on a failed queued Report. Before editing, an uncached exact Client Submission ID lookup proves the authenticated Worker and Department and checks durable, trashed and purged Reports. Only an explicit `not_found` result permits a draft; offline, old-backend, malformed or uncertain results leave the queue unchanged. Recovery has its own Worker/Department/source-record draft slot and never overwrites the ordinary same-Template draft. Current-page and cross-tab locks prevent recovery/replay/discard races in compatible clients. A single transaction in `scaffold-pwa-report-recovery-v1` publishes the recovered draft, shadows the immutable original as a read-only saved copy, and retires its queue entry for compatible clients. Edited recovery records, queues, drafts and tombstones stay in this namespace, invisible to a still-open September 29 client. The original v0/v1 bytes remain untouched: this is not cross-database atomicity or exclusion of an old client's original replay. The unchanged submission identity and new client's exact lookup preserve edits if that old original wins. Pre-release recovery artifacts found in older namespaces are quarantined read-only without rewriting their bytes; explicit discard only adds a new-namespace tombstone. Storage-open failures fail closed rather than falling back to replayable old storage.

Captured answers, signatures, Report Date, Site and Definition remain intact. Valid original photos retain their bytes/order/metadata; invalid, definitely missing or server-rejected photos are omitted with a persistent historical notice, while uncertain downloads or unreadable signatures block recovery. Unknown/changed Definitions stay read-only. Resubmission retains the original Client Submission ID, rechecks durable existence and binds every upload/final POST to the expected authenticated Worker and Department. If an older request wins, recovered edits are preserved read-only before reconciliation; no second Report or immutable edit is made. An unrelated auth expiry clears the recovery UI immediately and invalidates late work, with best-effort saving of captured editor drafts. The backend update must precede any future Hosting deployment. No migration is needed; purge safety relies on the retained `form_trash` audit snapshots, so deleting those audits invalidates that protection.
New Report photo evidence retains original Blob bytes in isolated `scaffold-pwa-report-evidence-v1` IndexedDB storage. Already-open pre-Blob clients cannot see/replay those new records; current clients read legacy base64 queues without moving them. Legacy draft replacement commits the new copy before conditionally deleting only the unchanged original, preserving concurrent old edits. Preview object URLs are temporary, never persisted. Do not roll back to an incompatible frontend or clear device storage while unfinished Reports remain. The released September 25 non-blocking startup renders the Worker screen after session/draft restoration, then replays with session-scoped progress. Completion refreshes history, not the active Report editor. Active replay cannot be discarded. Keep the page open; replay does not promise operating-system background execution. The earlier September 18 delay while awaiting replay is fixed in the current serving frontend.
_Avoid_: Queue item when referring to the user-facing submission

**Offline Report Template snapshot**:
The last successfully authenticated active `report` Template Definitions downloaded to IndexedDB for one exact Worker and Department. With a saved identity and cached app shell, it enables cold offline New Report, ordinary-draft Continue and queueing; it does not cache durable Report history or Supervisor lists. It is cleared on logout, explicit authorization denial or observed scope change. An HTTP 401/403 remains authoritative even when the browser reports offline; a refresh 403 is not overturned by a failed `/auth/me` request. Reconnect preserves current answers/evidence before replacing Templates, then applies the existing Definition-conflict guard. The backend rechecks current scope, availability and captured Definition version at replay. Missing or cleared downloads cannot enable cold offline authoring.
_Avoid_: A global Template cache, offline authorization authority, or a service-worker cache of protected API responses

**Supervisor Template editing draft**:
A private device-only unfinished create/edit copy containing name, description, field cards and exact unapplied raw syntax. Its ownership includes Supervisor ID, home Department, target Department and create/edit Template identity. **Continue Template draft** and **Discard Template draft** are explicit; **Close and keep draft** preserves it. Workspace navigation retains the live editor; Close/logout/Update App save first or pause on storage failure. Current published Definitions are rechecked before an existing edit is restored; stale, archived/unavailable and uncertain-publication copies are recovery-only, never automatic publishes. Storage revisions/tombstones prevent late editors from resurrecting discarded or published drafts. These copies do not enter Worker drafts, Reports, exports or Offline Submission replay.
Template content updates send `expected_definition_version`; the backend row-lock/version guard returns `report_template_edit_version_conflict` (HTTP 409) rather than overwriting a newer Definition. This added no migration. The invitation `0021` and compatible backend preceded the September 15 frontend release; private Template editing and offline Report return are deployed. Local, native PostgreSQL and hosted automated checks are recorded separately from the still-pending physical-phone checks in the mobile checklist.
_Avoid_: A published Template, a Supervisor Report cache, or a Worker Report draft

**Offline Site snapshot**:
The last successfully authenticated Site list stored in IndexedDB for one Worker and Department. It allows that Worker to select a Site after a cold offline PWA launch; it never comes from demo data, is not available without an exact Worker/Department scope, and is cleared on logout, invalid authorization, or an observed scope change. It remains non-authoritative because the backend rechecks Site access and radius when the queued attendance syncs.
_Avoid_: A global Site cache or treating saved coordinates/radius as approval authority

**Offline Attendance snapshot**:
The last successfully authenticated backend attendance context stored in IndexedDB for one Worker and Department. It contains the minimal attendance fields needed to restore the open check-in, recent Site ordering, expected action, and first-use guide state after a cold offline launch; it excludes notes, photos, and coordinates. Writes are ordered and scope-checked so an older response or previous account cannot replace the active Worker's context. It is cleared with the Offline Site snapshot on logout, invalid authorization, or an observed scope change, and remains non-authoritative because the backend owns durable attendance.
_Avoid_: A cross-account attendance cache or a replacement for backend attendance history

**Occurrence time**:
The timezone-aware time a Worker performed an attendance action. Offline attendance sends it as `occurred_at`; it remains stable across delayed sync and is distinct from backend sync time. Task and form business timing continues to use their explicit work date and other form fields.
_Avoid_: Sync time

**Client Submission ID**:
A stable identifier created once for a Worker submission and reused on retry. Backend uniqueness is scoped to the owning Worker and record type so replay returns the existing durable record.
_Avoid_: Generating a new ID for each sync attempt

**Work Form**:
The retained internal model for both Report Templates and Legacy Daywork. `template_purpose` separates `report` from `daywork`; `submission_purpose` preserves that meaning on every historical submission.
_Avoid_: Work Form in the report-only UI

**Work Form Definition**:
The versioned name, description, and field schema of a Work Form. Supported fields are text, textarea, number, date, select, checkbox, signature, section, time range, formula, and repeatable section fields, with conditional rules where supported.
_Avoid_: Treating status or the current mutable row as historical submission meaning

**Definition version**:
The monotonic version of a Work Form Definition. Content edits increment it; status-only archive/reactivate changes do not rewrite historical submissions.

**Definition snapshot**:
The immutable form name, description, fields, schema version, and definition version stored with each Work Form Submission. The backend validates source answers and derives time ranges and formula results from this snapshot.
_Avoid_: Looking up the mutable current form to interpret history

**Upload Storage**:
The module boundary shared by local disk and Cloud Storage adapters. It owns raster verification and re-encoding, adapter readiness, authorized streaming, and cleanup after references are detached or permanently deleted.
_Avoid_: Treating `/uploads/...` as a public static directory

**Read-only Review state**:
The explicit Supervisor state used when the backend is unavailable. It may show the last durable records, but local Worker submissions must never enter the Review Queue and decisions/exports stay disabled.
_Avoid_: Offline review with mutable decisions

## Runtime And Deployment

**Current live deployment**:
Firebase Hosting for the PWA, Cloud Run for FastAPI, Neon PostgreSQL supplied through Secret Manager, and a private Cloud Storage upload bucket. Browser traffic stays same-origin through `/api/**` and `/uploads/**` Hosting rewrites.

The October 5 release serves committed/pushed application source `c024fa61f05880e13357eb253b67f00b571254d2`: backend `geo-backend-october-20261005`, whose promotion was requested at `2026-10-04T22:27:39Z` and subsequently verified at 100% with no tags; build `8e582ff0-b88a-49a8-a09e-6d53b694383e`, immutable image `sha256:7fcefe3787cf173fe998a420f76a3393ebb8a07577617d68cb88376e9dde8224`. Exact Hosting `ba2962f66af41dcb` was cloned from `release-20261005` at `2026-10-04T22:39:52.855Z`; production cache `leader-field-7a709da8321a`, source cache `leader-field-cd739c204f2c`. Gallery, note protection, failed-upload recovery, Oldest waiting and storage warnings are live. The compatible backend preceded Hosting without migration, maintenance or runtime configuration change; all 22 migration checksums and every observed before/after inventory field except the read timestamp were preserved. The [October release record](docs/evidence/report-release-20261005/release.json) binds deployment, verification and cleanup. [September 29](docs/evidence/report-release-20260929/release.json), [September 25](docs/evidence/report-release-20260925/release.json) and [September 18](docs/evidence/report-release-20260918/release.json) serving identities are historical.

The complete local 72-workflow gate/lint, stage/preview/live October 14 / UX nine / 50-photo 13 checks with owned fixture cleanup, live 75-asset shell/seven-artifact installer/four waiting-update checks, and 18-page PDF pixel parity/visual review passed. Fresh Current recovery passed at `2026-10-04T22:31:37Z`, after backend promotion and before Hosting; final strict hardening passed with the existing six-hour history warning. Final infrastructure verified unchanged runtime, single 100% traffic with no tags and 3,368 logs without ERROR-or-higher/5xx. Four owned GCP staging resources and the exact staging branch/endpoint were deleted with absence verified, preserving production, the September 29 backup and synthetic upload objects. Historical invitation timeouts remain unexplained; the first preview UX failed on a late generic request error despite nine passed checks and API-verified fixture cleanup. The separate unchanged-verifier rerun passed, but its [diagnosis](docs/evidence/report-release-20261005/hosted-ux-boundary-diagnosis.json) leaves the original cause UNCONFIRMED.

Preserve Blob/50-photo compatibility, `0022` authentication-generation semantics and the October recovery backend. Exact previous Hosting `adb5a717d76f2644` is retained in `rollback-20261005` until recorded `2026-10-11T21:32:24.529551417Z`, but that September 29 shell cannot display new recovery or Supervisor note drafts. Prefer a compatible forward fix; any emergency shell rollback must retain the October backend and all device bytes. September 25 or older backends remain unsafe after password rotation. Also preserve historical `rollback-20260929` Hosting `d492562f1d2bdb50` until `2026-10-06T00:43:06.261854919Z` and pre-migration backup `br-young-sunset-a7x36uiu` until `2026-10-06T01:13:32Z`. Reverify identity/availability before use; a historical database restore is not a routine password-recovery rollback. Never clear device storage or reset auth generations. Physical iOS/Android, low-disk, native-sharing handoff, full-resolution-gallery, 50 near-5-MB photo batches and phone PDF viewers remain unverified. Private recovery remains Supervisor-issued/manual; no email provider or public self-service reset request was added.

**Recommended Google deployment**:
Firebase Hosting, Cloud Run, Cloud SQL PostgreSQL, private Cloud Storage, and Secret Manager. This remains the preferred all-Google target; it is not the database currently serving live traffic.

**Readiness Check**:
`GET /health/ready`, which verifies database access, exact migration-ledger versions/checksums for the running image, and the selected upload adapter. It is stronger than the liveness-only `/health` route. Production startup rejects automatic migrations and verifies the ledger before upload checks or purge tasks; migrations are an explicit release step. A mismatch fails startup or returns readiness 503 without repairing history. This is a ledger check, not an inspection of every physical table or column. An older guarded image is not a rollback target after a newer migration is recorded unless its migration artifact matches that database.

**Production Hardening Gate**:
The provider-aware, read-only `npm run check:production-hardening` validation. It checks Cloud Run identity, provider selection, upload-bucket IAM, monitoring, optional budget configuration, and exact sanitized Neon/GCS recovery evidence. It does not establish a least-privilege Neon runtime role, pooling limits, longer retention, or notification ownership.
_Avoid_: Calling the app production-ready based only on local tests or the controlled-test gate

**Session Refresh**:
`POST /auth/refresh`, which renews the HttpOnly `__session` cookie and CSRF cookie without browser bearer-token storage. Authentication restoration must finish before protected data such as Sites is loaded.
_Avoid_: Refresh token unless a separate revocable refresh-token store exists

## Relationships

- A **Worker** belongs to one **Department**, may submit any active Department **Report Template**, and sees only their own **Reports**.
- An **Offline Report Template snapshot** enables that Worker's cold offline return; it does not grant new access and never substitutes for backend validation when the Report syncs.
- A **Supervisor Template editing draft** protects unfinished private editing without changing the published Definition; publication remains explicit and version-guarded.
- A **Supervisor** provisions an **Invited account** and privately hands off a setup link; the **Worker** chooses their own password before normal sign-in. Issuance is audited but does not prove delivery or email ownership. This flow was released on September 15. Public self-registration remains hidden and unsupported for the pilot, although its API remains callable.
- An **Offline Submission** keeps its owning Worker, capture time, and **Client Submission ID**; attendance also carries its **Occurrence time** into the durable **Review Record**.
- An **Offline Site snapshot** may guide a new offline attendance capture, but the backend remains authoritative for Site access, current radius, distance, and durable acceptance when the **Offline Submission** syncs.
- An **Offline Attendance snapshot** may restore open-shift and Site-priority context for the same Worker and Department, but the backend remains authoritative for durable attendance history.
- A **Supervisor** moves a Department **Report** through **Submitted → In review → Resolved** and must provide the final note. Legacy approve/reject routes reject Reports.
- A **Supervisor** may still approve or reject retained non-Report **Review Records** within their Department scope when the reversible full interface is explicitly enabled.
- A **Global admin** may query the same records across one or all Departments.
- A **Report Template** has versions; every **Report** stores a **Definition snapshot** and immutable `submission_purpose=report`.
- The visible **Review Queue page**, dashboard totals, and **Management Analytics** are separate consumers of the same durable query boundary.
- **Accounting / Payroll** will use approved Attendance Records to create **Payroll Summaries**, not reuse Review Queue page totals.
- **Upload Storage** verifies and serves referenced files for field records without exposing the backing adapter directly.
- The **Current live deployment** uses Neon PostgreSQL; the **Recommended Google deployment** uses Cloud SQL PostgreSQL.
- A production release needs a passing **Readiness Check**, relevant provider hardening, and hosted phone/browser validation.

## Flagged Ambiguities

- "record" can mean any stored item; use **Review Record** only for the four supervisor-reviewable record kinds.
- "queue" can mean the worker's device queue or the Supervisor feed; use **Offline Submission** and **Review Queue** respectively.
- "reviewed" is legacy Review Queue vocabulary. For Reports, name **In review** or **Resolved** explicitly.
- "analytics" means implemented operational **Management Analytics** unless **Payroll Summary** is named explicitly.
- "admin" can mean Supervisor review or Accounting / Payroll; name the workflow.
- "timestamp" can mean occurrence, backend creation, or sync time; use the specific term.
- "production" must identify either the **Current live deployment** or the **Recommended Google deployment**.
- "registration" must distinguish the hidden, dormant verified-registration API from active **Invited account** provisioning.
- "geolocation" currently means a Worker-triggered attendance capture, not continuous background tracking or automatic geofence check-in/out.
- "production-ready" requires provider hardening and live phone/browser checks, not only build, smoke, or readiness success.
