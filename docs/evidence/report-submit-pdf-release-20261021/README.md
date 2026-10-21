# Combined ReportFlow release — 2026-10-21 UTC

`release.json` is the final release record. Application source is
`80b4ea01a041a84bdcc0483f8e3d41a34d55f117`; the later documentation commit does
not require another deployment.

- `production-proof.json` and `post-release-proof.json` establish migration 0024,
  preservation of existing business rows and prior checksums, default-off routing
  and an empty outbox.
- `backend-promotion.json`, `hosting-promotion.json`, the preview/live checks and
  `scheduled-worker-verification.json` identify the deployed backend, exact
  Hosting version and successful automatic empty-queue execution.
- `backup.json`, `hosting-retention.json`, `fallback.json` and current recovery
  proofs document retained recovery options. Pause dispatch before fallback;
  retain migration 0024 and outbox claims. Never restore old credentials or clear
  device storage to roll back.
- `cleanup.json` records deletion of this release's temporary jobs and staging
  branch. The persistent worker, Scheduler, backup and fallback are retained.
- Initial failures remain in the CI diagnosis and image-attempt files. The export
  query regression was fixed; an isolated CI invitation account-switch timeout
  remains unexplained despite unchanged isolated and complete rerun passes.

Requests and early plans are historical checkpoints, not current-state claims.
In particular, `release-plan.json` precedes the separately approved Scheduler API
and standard service-agent grant; `scheduler-prerequisite-completion.json` records
its completion. The separate trigger identity has invocation on this job only.

No real reports, invitations, emails or SMTP authentication were exercised by
this release. Secret references are metadata only. All production template
routing remains off; enabling recipients requires the user's choice and approval.
The six-hour recovery-history warning and physical-phone/cold-offline Supervisor
catalog limitations remain. Costs and retained-resource expiry are in the release
record; reverify resources before using a fallback.

The scripts are journals for this specific release, with one-attempt guards.
Do not reuse them to repeat a migration, deployment or worker execution.
