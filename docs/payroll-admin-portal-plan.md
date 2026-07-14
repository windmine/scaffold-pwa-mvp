# Payroll Admin Portal Plan

This document defines the next business-facing admin area. The Payroll portal is not implemented; the existing Management Analytics section is operational reporting and must not be presented as payroll.

## Goal

Add a desktop-first workflow that turns approved Attendance Records into explainable pay-period worker/day summaries and Excel-friendly exports without changing the phone-first Worker experience.

Keep the responsibilities separate:

```text
Review Queue        validates durable field records
Management Analytics reports operational activity and exceptions
Payroll             pairs approved attendance and exports payable-hour inputs
```

## Users And Authorization

The current data model has Worker and Supervisor roles; it does not yet have a distinct Accounting role. The first implementation must make an explicit product decision before exposing routes:

- Initially permit Department-scoped Supervisors and Global admins, or add a dedicated Accounting permission.
- Apply the same Department boundary as Review Queue queries unless a dedicated cross-department payroll grant is introduced.
- Include resigned Workers in historical periods without reactivating their accounts.
- Audit payroll exports and any future manual payroll adjustment.

Do not infer payroll access merely from the ability to view one Review Queue page.

## First-Version Scope

- A folded `Payroll` section or desktop tab in the existing Supervisor workspace.
- Inclusive pay-period start/end dates interpreted in an explicit business timezone.
- Worker and Department filters, including active, resigned, and all authorized Workers.
- Approved Attendance Records as the payable source by default.
- Deterministic check-in/check-out pairing per Worker in occurrence-time order, including overnight pairs.
- Worker/day rows with first check-in, last check-out, paired duration, Site context, source, and exception notes.
- Pay-period total hours per Worker.
- Exception flags for missing check-outs, duplicate or out-of-order events, overlapping pairs, pending/rejected or outside-site events, and manual Supervisor entries/edits.
- CSV export generated from the same authoritative query and calculation used by the UI.

## Explicitly Out Of Scope

- Wage rates or gross/net pay.
- Overtime, allowances, deductions, public holidays, leave, and rounding rules.
- Inferring unpaid breaks that were not recorded by an agreed business rule.
- Editing Review Records from the Payroll screen.
- Direct accounting/HR integration or a persistent export archive.
- Native XLSX until CSV behaviour and business rules are accepted.

These rules need signed-off business definitions before implementation.

## Data Contract

- Use `AttendanceRecord.timestamp` as occurrence time. Do not use API creation or offline sync time to calculate hours.
- Only approved `check_in`/`check_out` pairs count as payable by default.
- Pending and rejected events remain visible as exceptions but contribute zero payable hours.
- Preserve manual-entry and audit context so Accounting can explain adjusted time.
- Do not derive payroll from Task Log hours, Work Form formula outputs, Team Work Log worker-hours, Review Queue counts, or the currently visible Review Queue page.
- Use a stable snapshot or transaction boundary so pagination and export cannot mix records changed halfway through a calculation.
- Return calculation metadata: timezone, inclusive period, generated time, filter scope, rule version, and source-record IDs.
- Keep raw durations separate from any future payable rounding or break policy.

Before implementation, decide and document:

1. The payroll timezone and pay-period cutoff time.
2. Whether pairs may cross the pay-period boundary and how they are allocated.
3. Whether multiple valid pairs on one day are summed.
4. How daylight-saving transitions are displayed and calculated.
5. Whether a manual approved record needs a second payroll acknowledgement.

## Suggested Interface

- Summary cards: Workers, payable hours, complete days, and unresolved exceptions.
- Dense desktop table grouped by Worker and local work date; stacked read-only rows on mobile.
- A visible `Export blocked` or warning state when unresolved exceptions exist, based on the chosen business policy.
- Drill-through links to the source Attendance Records and their audit history.
- Clear labels separating raw paired hours from future rounded/payable hours.

## Suggested Endpoints

```text
GET /supervisor/payroll/summary?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&worker_id=...
GET /supervisor/payroll/export.csv?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&worker_id=...
```

The response should include rows, totals, exceptions, calculation metadata, and an opaque snapshot identifier. If exports become asynchronous or retained, design that lifecycle separately rather than returning public object URLs.

## Deployment And Operations

- Keep the UI in the Vite PWA on Firebase Hosting and APIs in the FastAPI Cloud Run service.
- Read from managed PostgreSQL through SQLModel/SQLAlchemy. The current live provider is Neon; Cloud SQL is the recommended all-Google target.
- Preserve same-origin `/api/**` routing, HttpOnly `__session` authentication, CSRF protection, and `POST /auth/refresh` behaviour.
- Generate CSV on demand. Use private Upload Storage only if retained exports become a requirement.
- Measure the summary query before adding indexes, materialized summaries, or background jobs. Never compute totals from a paginated browser page.
- Include expensive exports in rate-limit and timeout planning.
- Validate the selected database provider's backups/restore path in addition to the GCP production-hardening checker.

## Test Strategy

- Unit-test pairing for empty days, one pair, multiple pairs, duplicates, missing endpoints, overnight work, period boundaries, overlaps, and daylight-saving transitions.
- Test pending/rejected/outside-site/manual records independently from payable inclusion.
- Test Department and Global admin authorization on summary, drill-through, and export.
- Prove UI totals and CSV totals use the same complete snapshot with more records than one page.
- Prove resigned Workers remain visible historically.
- Add an integration fixture with delayed Offline Submissions whose occurrence time differs from sync time.
- Run regression checks for Review Queue, Management Analytics, Worker attendance, and offline replay.

## Acceptance Criteria

- An authorized user can choose a pay period and see every in-scope Worker with approved paired hours.
- Missing, duplicate, overlapping, pending, rejected, outside-site, and manual events are explainable before export.
- Overnight and delayed-sync records are assigned by occurrence time under the documented timezone rule.
- Resigned Workers appear for periods in which they worked.
- CSV opens in Excel and matches the complete UI snapshot and totals.
- Pending and rejected records contribute zero payable hours by default.
- Source Attendance Records and audit context are traceable from every calculated row.
- Worker check-in/out, offline replay, Review Queue, and Management Analytics behaviour remain unchanged.
