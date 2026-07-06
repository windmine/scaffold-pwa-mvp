# Leader Field Operations Context

This context defines the product language for the geo-attendance and field-record review MVP. Use these terms when naming modules, routes, UI sections, and tests.

## Language

**Worker**:
A field user who checks in or out and submits task logs or work forms.
_Avoid_: Staff user when the role-specific behaviour matters

**Supervisor**:
An admin user who manages sites, staff, work forms, and reviewable field records.
_Avoid_: Admin when the workflow is about record review

**Accounting / Payroll**:
An office user or group that reviews approved attendance by pay period and exports payroll-ready hour summaries.
_Avoid_: Supervisor when the workflow is wage/hour calculation rather than record approval

**Site**:
A job location with coordinates and an allowed attendance radius.
_Avoid_: Job, location

**Review Record**:
An attendance record, task log, or work form submission presented through one supervisor review feed.
_Avoid_: Approval when referring to the record itself

**Review Queue**:
The pending set of review records that need supervisor approval or rejection.
_Avoid_: Pending attendance when task logs and form submissions are included

**Payroll Summary**:
A pay-period view that groups approved attendance into worker/day totals for accounting review.
_Avoid_: Review Queue when the workflow is payroll calculation

**Payroll Exception**:
A record or day that needs review before payroll export, such as a missing check-out, duplicate attendance event, pending/rejected record, outside-site record, or manual supervisor adjustment.
_Avoid_: Error when the item may be legitimate but unresolved

**Work Form**:
A reusable supervisor-defined field form that workers can submit with typed fields, photos, and signatures.
_Avoid_: Dynamic form

**Offline Submission**:
A worker-created attendance record, task log, or work form submission saved on the device first and synced to the backend when possible.
_Avoid_: Queue item when referring to the user-facing submission

**Production Deployment**:
The preferred hosted shape for this MVP: Firebase Hosting for the PWA, Cloud Run for the FastAPI API, Cloud SQL PostgreSQL for relational data, Cloud Storage for photos/signatures, and Secret Manager for secrets.
_Avoid_: Treating SQLite, local `backend/uploads/`, or a single VM as the recommended production target

## Relationships

- A **Worker** submits many **Review Records**.
- A **Supervisor** approves or rejects **Review Records** in the **Review Queue**.
- **Accounting / Payroll** uses approved **Review Records** to create **Payroll Summaries**.
- A **Payroll Summary** may contain **Payroll Exceptions** that must be resolved before wage export.
- A **Review Record** may belong to one **Site**.
- A **Work Form** produces many **Review Records** through worker submissions.
- An **Offline Submission** becomes a **Review Record** after it syncs to the backend.
- A **Production Deployment** stores field data in Cloud SQL PostgreSQL and uploaded files in Cloud Storage.

## Example Dialogue

> **Dev:** "Should this new task-log item appear in pending attendance?"
> **Domain expert:** "No, call it the **Review Queue** because it includes outside-site attendance, task logs, and work form submissions."

> **Dev:** "Should payroll use all attendance records?"
> **Domain expert:** "No, the **Payroll Summary** should default to approved records and flag unresolved **Payroll Exceptions**."

## Flagged Ambiguities

- "record" can mean any stored item; use **Review Record** only for items that supervisors approve or reject.
- "queue" is an implementation detail; use **Offline Submission** when describing the worker-facing saved item.
- "admin" can mean supervisor review or accounting payroll; use **Supervisor** for review/admin changes and **Accounting / Payroll** for wage-hour workflows.
- "production" should not mean local SQLite with uploaded files on disk. Use **Production Deployment** when describing the Firebase Hosting / Cloud Run / Cloud SQL / Cloud Storage target.
