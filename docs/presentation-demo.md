# Historical Mutual presentation demo

The September 16 presentation dataset is **no longer available in the live app**. The separately approved [October 5 permanent cleanup](evidence/test-cleanup-20261005.json) deleted its accounts, Templates, Reports, demo Sites and active upload objects, together with the other starter/test data. Old demo logins and Report IDs cannot be used for a walkthrough. Existing backups, object soft-delete retention, historical audit snapshots and device-local copies were not erased.

The current [ReportFlow app](https://geo-attendance-system-db9ca.web.app) runs the October 12 release. See the [current release record](evidence/frontend-release-20261012/release.json) and [production runbook](production-db-runbook.md#deployment-truth). New hosted demonstrations or authenticated tests require separately approved fixtures with fresh identities and an exact ownership record; this document does not authorize recreating the deleted dataset.

## September 16 snapshot

The historical Mutual dataset was marked **DEMO** throughout: three fictional Workers, three Report Templates, two fictional Sites and nine Reports dated September 14–16, 2026. It contained three Submitted, three In review and three Resolved Reports. Workers were User IDs **13–15**, and the dedicated Supervisor was User **16**. The exact created IDs and ownership are preserved in [presentation-demo-20260916.json](evidence/presentation-demo-20260916.json).

Desktop and phone-sized Chromium checks passed on September 16, 2026 (New Zealand time). These were browser checks, not physical-phone tests. Provisioning did not deploy application code or modify previously existing records. Each dedicated Worker was checked against their own three Reports.

## Historical walkthrough and evidence

The walkthrough used `demo-20260916` in Supervisor **Reports → Find** to locate the nine Reports and compare their three workflow states. `walkway` identified the resolved Toolbox Talk with meeting sections, attendee rows, illustrations and a final note; `cable` identified an In-review Site Observation; `inventory` identified an In-review Daily Progress Report with repeated material quantities. The `packaging` and `handover` examples omitted Site. The three Templates were Toolbox Talk, Site Observation and Daily Progress, each prefixed with `DEMO` and the run marker.

These names and searches describe the archived demonstration only; they should now return no such production dataset. Use the saved [browser evidence](evidence/presentation-demo-20260916-browser/evidence.json) to review that check. It recorded exact Report ownership, active Templates, six authenticated/decodable uploads, workflow filters, the resolved Toolbox Talk, CSV/PDF responses and isolated Worker histories, with no observed browser JavaScript errors or HTTP 5xx responses.

Photos were visibly labelled synthetic illustrations. Signatures were generic demonstration marks, not actual signatures or evidence of consent. Names, locations, quantities and Site coordinates were fictional; the examples did not certify actual work, attendance or safety conditions.

The [September 16 PDF release checks](evidence/report-pdf-release-20260916/release.json) verified a two-page Toolbox Talk and all nine demo Reports in a 16-page collection, including photos, signatures, final notes and page numbering. Both export buttons passed a phone-sized browser check. That release preserved the dataset at the time; the later October 5 cleanup removed it. October 12 added Chinese PDF font support as recorded in the [backend release](evidence/report-fixes-release-20261012/release.json).

## Retired access and cleanup procedures

The old operator handoff at `output/presentation-demo-20260916.local/credentials.dpapi` and `scripts/presentation-demo-live.py` belong to the historical setup. They do not provide usable live logins after deletion. Do not decrypt or reuse old credentials to prepare a current presentation, print them into transcripts, or attempt to restore old authentication state.

The original proposal to archive Templates, trash Reports and resign demo accounts was superseded by the explicitly approved **permanent deletion** on October 5. The [cleanup proof](evidence/test-cleanup-20261005.json) verifies exact IDs, retained real configuration and post-resume state. Keep the ownership manifest and release evidence unchanged as historical records; do not rerun their old mutation or cleanup steps. Any future fixture lifecycle must use its own approved scope and [owned-fixture procedure](production-db-runbook.md#owned-hosted-report-fixtures), without broad deletion by a `DEMO` name search.
