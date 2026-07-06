# Payroll Admin Portal Plan

This plan describes the next business-facing admin area for payroll/accounting. It is not implemented yet.

## Goal

Give supervisors and accounting staff a desktop-first payroll review page that turns approved attendance records into pay-period timesheet summaries.

The worker app should remain phone-first. Payroll work should sit inside the existing supervisor/admin area first, not in a separate application.

## User Groups

**Supervisor**

- Reviews and approves attendance, task logs, and form submissions.
- Corrects attendance records with audit history.
- Resolves missing or suspicious field records before payroll uses them.

**Accounting / Payroll**

- Selects a pay period.
- Reviews approved hours by worker.
- Checks exceptions before wages are calculated.
- Exports a payroll-ready CSV or Excel-friendly file.

## Scope For First Version

- Desktop-first `Payroll` section in the existing supervisor dashboard.
- Pay period start/end filters.
- Worker filter with active, resigned, and all-worker options.
- Approved attendance records included by default.
- Worker/day summaries that pair check-in and check-out records.
- Total hours per worker for the selected pay period.
- Exception flags for:
  - Missing check-out.
  - Duplicate check-in or check-out.
  - Pending, rejected, or outside-site records.
  - Manual supervisor edits.
- CSV export for payroll/accounting review.

## Out Of Scope For First Version

- Automatic wage-rate calculation.
- Overtime rules.
- Allowances.
- Deductions.
- Public holiday logic.
- Leave requests.
- Direct integration with accounting or HR systems.

Those rules need clear business definitions before implementation.

## Deployment Notes

The payroll/admin portal should ship inside the existing Firebase Hosting and Cloud Run deployment:

- Frontend UI remains part of the Vite PWA served from Firebase Hosting.
- Payroll summary/export APIs run in the FastAPI Cloud Run service.
- Pay-period calculations read from Cloud SQL PostgreSQL.
- Export files should be generated on demand by Cloud Run. Store long-lived exports in Cloud Storage only if accounting needs persistent downloadable copies.
- Payroll logic must not change worker phone check-in/check-out behavior or offline submission sync.

At roughly 100 users, payroll queries should fit the existing small-production Cloud SQL starting size. Add indexes or summary tables only after measuring slow pay-period reports.

## Data Rules

- Payroll summaries should use approved records by default.
- Pending/rejected records should not count toward payable hours unless a supervisor explicitly resolves them.
- Adjusted records must show audit context so accounting can see that the time was changed.
- Resigned workers remain available in historical payroll periods.
- The export should include worker id/name, date, site, first check-in, last check-out, total hours, status, and exception notes.

## Suggested UI

- Add a folded `Payroll` section or desktop tab in the supervisor/admin dashboard.
- Keep the Review Queue as the record-validation workflow.
- Keep Payroll as the pay-period calculation/export workflow.
- Use a dense table layout on desktop and a simplified stacked layout on mobile.

## Suggested Endpoints

```text
GET /supervisor/payroll/summary?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
GET /supervisor/payroll/export.csv?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
```

Later, if real Excel output is required:

```text
GET /supervisor/payroll/export.xlsx?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
```

## Acceptance Criteria

- Accounting can choose a pay period and see every worker with approved payable hours.
- Missing check-outs and duplicate attendance records are visible before export.
- Resigned workers still appear when they worked during the selected period.
- Payroll export can be opened in Excel.
- The export does not include pending or rejected records as payable hours by default.
- The implementation does not change worker check-in/check-out behavior.
