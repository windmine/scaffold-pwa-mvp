# Leader Field Operations Context

This context defines the product language for the geo-attendance and field-record review MVP. Use these terms when naming modules, routes, UI sections, and tests.

## Language

**Worker**:
A field user who checks in or out and submits task logs or work forms.
_Avoid_: Staff user when the role-specific behaviour matters

**Supervisor**:
An admin user who manages sites, staff, work forms, and reviewable field records.
_Avoid_: Admin when the workflow is about record review

**Site**:
A job location with coordinates and an allowed attendance radius.
_Avoid_: Job, location

**Review Record**:
An attendance record, task log, or work form submission presented through one supervisor review feed.
_Avoid_: Approval when referring to the record itself

**Review Queue**:
The pending set of review records that need supervisor approval or rejection.
_Avoid_: Pending attendance when task logs and form submissions are included

**Work Form**:
A reusable supervisor-defined field form that workers can submit with typed fields, photos, and signatures.
_Avoid_: Dynamic form

**Offline Submission**:
A worker-created attendance record, task log, or work form submission saved on the device first and synced to the backend when possible.
_Avoid_: Queue item when referring to the user-facing submission

## Relationships

- A **Worker** submits many **Review Records**.
- A **Supervisor** approves or rejects **Review Records** in the **Review Queue**.
- A **Review Record** may belong to one **Site**.
- A **Work Form** produces many **Review Records** through worker submissions.
- An **Offline Submission** becomes a **Review Record** after it syncs to the backend.

## Example Dialogue

> **Dev:** "Should this new task-log item appear in pending attendance?"
> **Domain expert:** "No, call it the **Review Queue** because it includes outside-site attendance, task logs, and work form submissions."

## Flagged Ambiguities

- "record" can mean any stored item; use **Review Record** only for items that supervisors approve or reject.
- "queue" is an implementation detail; use **Offline Submission** when describing the worker-facing saved item.
