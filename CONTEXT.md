# Leader Field Reports Context

This file defines the product language for the report-only MVP. Use these terms consistently in modules, routes, UI copy, tests, and documentation. The broader geo-attendance, Daywork, task-log, weekly-log, map, analytics, export, and recovery code remains available only as a reversible legacy interface. Status reviewed on 2026-09-01.

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
A Worker account provisioned and activated by a Supervisor during the pilot. In the current implementation the Supervisor must also choose and communicate the initial password; a single-use invitation and Worker-set-password flow is not implemented. The public registration UI is hidden, while the dormant verified-registration API remains callable but is not supported as the pilot onboarding path.
_Avoid_: Self-registered account when describing current pilot access

**Global admin**:
A Supervisor who may focus the dashboard on any Department or all Departments. The saved dashboard focus does not change the account's home Department.
_Avoid_: Supervisor when cross-department authority is important

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
_Avoid_: Diary, Daywork, Work Form, or approval record in user-facing language

**Report Template**:
A reusable, versioned, Supervisor-managed definition with `template_purpose=report`. Every active Worker in its Department may submit it. Archived Report Templates cannot accept new Reports.
_Avoid_: Work Form in user-facing language

**Report workflow**:
The forward-only state machine **Submitted → In review → Resolved**. An authorised Department Supervisor starts review and resolves with a required final Supervisor note. Report transitions are separate from legacy approve/reject decisions, atomic, and audit-logged.
_Avoid_: Pending, approved, rejected, approval, or rejection when describing a Report state

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
_Avoid_: Queue item when referring to the user-facing submission

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

As checked on 2026-08-13, Cloud Run revision `geo-backend-release-20260804152130` still serves 100% and backend/Upload Storage readiness are healthy. Frontend commit `bcfb128` was verified through Firebase preview `release-20260813120158` at `https://geo-attendance-system-db9ca--release-20260813120158-1krt9yox.web.app`, then exact Hosting version `c761984b7353028a` was cloned live. The local gate passed lint, production build/static checks, 28 Playwright workflows, Review Queue checks, production npm audit with zero findings, Python dependency consistency, and the controlled production-hardening gate with its three known warnings; the full development audit separately reported three toolchain-only advisories. All 47 generated app-shell paths plus `sw.js` matched locally, on preview, and live; five preview and five live readiness probes reported database and GCS readiness, anonymous Sites returned 401, and invited-only/hidden-registration, login-before-install, cache-header, hashed-entrypoint, and scoped offline-snapshot checks passed. Management Analytics exceptions now carry their collision-safe Review Record key and can open the exact Review item or a valid attendance map point after conflicting filters are cleared; essential map and Analytics labels have a tested 14px readability floor at desktop and phone widths. The full hosted real-phone/update/upload checklist is still pending.

**Recommended Google deployment**:
Firebase Hosting, Cloud Run, Cloud SQL PostgreSQL, private Cloud Storage, and Secret Manager. This remains the preferred all-Google target; it is not the database currently serving live traffic.

**Readiness Check**:
`GET /health/ready`, which verifies database access and the selected upload adapter. It is stronger than the liveness-only `/health` route.

**Production Hardening Gate**:
The provider-aware, read-only `npm run check:production-hardening` validation. It checks Cloud Run identity, provider selection, upload-bucket IAM, monitoring, optional budget configuration, and exact sanitized Neon/GCS recovery evidence. It does not establish a least-privilege Neon runtime role, pooling limits, longer retention, or notification ownership.
_Avoid_: Calling the app production-ready based only on local tests or the controlled-test gate

**Session Refresh**:
`POST /auth/refresh`, which renews the HttpOnly `__session` cookie and CSRF cookie without browser bearer-token storage. Authentication restoration must finish before protected data such as Sites is loaded.
_Avoid_: Refresh token unless a separate revocable refresh-token store exists

## Relationships

- A **Worker** belongs to one **Department**, may submit any active Department **Report Template**, and sees only their own **Reports**.
- A **Supervisor** provisions and activates an **Invited account** during the pilot and currently sets its initial password; public self-registration is not exposed in the UI or supported as the pilot onboarding path, although its API remains callable.
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
