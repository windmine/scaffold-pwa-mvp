# Leader Field Operations Context

This file defines the product language for the geo-attendance and field-record MVP. Use these terms consistently in modules, routes, UI copy, tests, and documentation.

## People And Scope

**Worker**:
A field user who records attendance. A Worker may be a Normal worker or a Leader.
_Avoid_: Staff user when role-specific behaviour matters

**Normal worker**:
A Worker whose product surface is attendance and personal history only.
_Avoid_: Basic user

**Leader**:
A Worker class that also submits task logs, Work Forms, weekly Team Work Logs, and missing Sites. Leader is a worker class, not the Supervisor role.
_Avoid_: Supervisor when the person is still submitting field records

**Supervisor**:
An admin user who manages Sites, Workers, Work Form Definitions, and Review Records within one Department.
_Avoid_: Admin when the workflow is specifically record review

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
A job location with coordinates and an allowed attendance radius.
_Avoid_: Job or location when the stored Site entity is meant

## Field Records

**Review Record**:
The durable supervisor-facing representation of an Attendance Record, Task Log, Work Form Submission, or weekly Team Work Log. It may be pending, approved, or rejected.
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
A Worker-owned attendance, task-log, or Work Form submission captured on one device and synced to the backend when possible. The module owns the Worker identity, capture time, stable Client Submission ID, replay state, and partial-upload state; attendance maps capture time to its Occurrence time.
_Avoid_: Queue item when referring to the user-facing submission

**Occurrence time**:
The timezone-aware time a Worker performed an attendance action. Offline attendance sends it as `occurred_at`; it remains stable across delayed sync and is distinct from backend sync time. Task and form business timing continues to use their explicit work date and other form fields.
_Avoid_: Sync time

**Client Submission ID**:
A stable identifier created once for a Worker submission and reused on retry. Backend uniqueness is scoped to the owning Worker and record type so replay returns the existing durable record.
_Avoid_: Generating a new ID for each sync attempt

**Work Form**:
A reusable Supervisor-managed field form that a Leader can submit with typed values, photos, and signatures. A Work Form may be active or archived.
_Avoid_: Dynamic form

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

**Recommended Google deployment**:
Firebase Hosting, Cloud Run, Cloud SQL PostgreSQL, private Cloud Storage, and Secret Manager. This remains the preferred all-Google target; it is not the database currently serving live traffic.

**Readiness Check**:
`GET /health/ready`, which verifies database access and the selected upload adapter. It is stronger than the liveness-only `/health` route.

**Production Hardening Gate**:
The read-only `npm run check:production-hardening` GCP validation. It checks Cloud Run identity, legacy/recommended Cloud SQL state, upload-bucket IAM, monitoring, and optional budget configuration. Neon backup, restore, pooling, and access controls require their own provider checks.
_Avoid_: Calling the app production-ready based only on local tests or this GCP-only gate

**Session Refresh**:
`POST /auth/refresh`, which renews the HttpOnly `__session` cookie and CSRF cookie without browser bearer-token storage. Authentication restoration must finish before protected data such as Sites is loaded.
_Avoid_: Refresh token unless a separate revocable refresh-token store exists

## Relationships

- A **Worker** belongs to one **Department** and creates field records owned by that Worker.
- An **Offline Submission** keeps its owning Worker, capture time, and **Client Submission ID**; attendance also carries its **Occurrence time** into the durable **Review Record**.
- A **Supervisor** approves or rejects pending **Review Records** in the **Review Queue** within their Department scope.
- A **Global admin** may query the same records across one or all Departments.
- A **Work Form Definition** has versions; every Work Form Submission stores a **Definition snapshot**.
- The visible **Review Queue page**, dashboard totals, and **Management Analytics** are separate consumers of the same durable query boundary.
- **Accounting / Payroll** will use approved Attendance Records to create **Payroll Summaries**, not reuse Review Queue page totals.
- **Upload Storage** verifies and serves referenced files for field records without exposing the backing adapter directly.
- The **Current live deployment** uses Neon PostgreSQL; the **Recommended Google deployment** uses Cloud SQL PostgreSQL.
- A production release needs a passing **Readiness Check**, relevant provider hardening, and hosted phone/browser validation.

## Flagged Ambiguities

- "record" can mean any stored item; use **Review Record** only for the four supervisor-reviewable record kinds.
- "queue" can mean the worker's device queue or the Supervisor feed; use **Offline Submission** and **Review Queue** respectively.
- "reviewed" means approved plus rejected across the authorized durable data set, not only the current filtered page.
- "analytics" means implemented operational **Management Analytics** unless **Payroll Summary** is named explicitly.
- "admin" can mean Supervisor review or Accounting / Payroll; name the workflow.
- "timestamp" can mean occurrence, backend creation, or sync time; use the specific term.
- "production" must identify either the **Current live deployment** or the **Recommended Google deployment**.
- "production-ready" requires provider hardening and live phone/browser checks, not only build, smoke, or readiness success.
