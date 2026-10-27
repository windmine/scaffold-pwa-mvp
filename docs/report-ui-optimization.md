# Report UI improvements — local preparation

Prepared on 2026-10-27. This work is local and is not committed, pushed or
deployed. It builds on the safe Refresh release, with no backend, migration,
dependency, access-policy or production-data change.

## Behavior

- The per-Report manual Site input is visible only for **Type a site name**.
  Switching to an existing Site or No site hides it; existing draft and
  submission handling still determines the selected value. Manual entry does
  not create a shared Site.
- Report forms with at least three sections or twenty definition entries have
  a sticky section selector, an explicit **Go** button and a **Review & submit**
  shortcut. Go moves keyboard focus to the section heading. Fields stay
  mounted, including photos, signatures and repeat rows. The shortcut invokes
  existing validation and the pre-submit review; it does not bypass final
  submission confirmation. Small forms retain their existing layout.
- **Find a template** filters the authorized active catalog by name, ignoring
  case and surrounding whitespace. The selected Template remains selected
  even when it does not match the filter, and its full title wraps below the
  selector. Searching does not replace the editor or save a different draft.
  Continuing a draft clears the search. Explicit access/session failures still
  clear unavailable choices; search retention cannot override that behavior.
- At desktop widths of 1100px or more, Supervisor Reports use one filter row,
  a smaller heading and compact author/date card metadata. The selected Report
  detail keeps full content. Smaller screens keep the existing stacked layout.
- **Refresh data** and **Refresh reports** have distinct labels. Routine
  successful data refresh says **Data refreshed. Updates checked.** Failures
  and offline messages retain recovery guidance. Update App and Retry sync
  remain separate actions; Refresh does not submit queued Reports.

The changes apply to the shared Worker/Supervisor self-submission editor.
Existing authorization, report corrections, Definition snapshots, evidence
quotas and email routing are unchanged.

## Verification

`npm run check:report-ui` adds six isolated browser groups, and is included in
the full mobile gate through `check:presentation`. They cover:

- Site mode transitions, draft reload and pre-submit Site summary.
- Template search, no matches, Enter handling, draft continuation and a selected
  Template removed during safe Refresh.
- Keyboard section jumps, required-field validation, retained DOM/evidence,
  return from review and no implicit submission.
- The actual 117-entry, fourteen-section blank Audit at 320, 390 and 768px,
  sticky navigation, visible jump targets and 44px minimum toolbar controls.
- Supervisor filter/card geometry at 1100, 1280 and 1440px, full detail,
  filter clearing and self-submission.
- Refresh scopes, concise success, prominent partial errors, offline search,
  Chinese layout and session reset.

The first full-gate attempt caught an over-broad selected-option retention
after an explicit 403. Retention is now limited to search interaction; the
existing offline/access-revocation suite passes unchanged. Earlier focused
layout checks caught the shell's horizontal scroll container preventing sticky
navigation and a Go button slightly below 44px; both were corrected.
The existing presentation test required Clear below the filters at every
width. It now checks non-overlapping, bottom-aligned controls on the new
desktop row and keeps the stacked-layout assertion below 1100px. The earlier
gate results are retained; subsequent stages are run in the same isolated
environment starting at presentation checks.
The full real-backend browser run then passed 74 of 75 workflows and found a
selected Report Date clipped by four pixels at 1280px. The desktop date column
was widened to a 180px minimum, and the focused UI suite now fills and checks
the date instead of measuring only an empty control. Final verification reruns
build/lint, presentation/UI, static/installer checks and the failed responsive
workflow; the earlier successful workflows are retained rather than claiming
the first full run passed.

Final results: build/lint, all six new UI groups, ten safe Refresh groups,
32 Clear layouts, Report correction/static checks and eleven installer checks
passed. The corrected real-backend responsive workflow passed; the other 74
workflows passed in the full run. All mobile-gate stages are covered by the
recorded runs, but there is no claim of one uninterrupted clean full-gate run.
The test-only filled-date fixture was also corrected to match its synthetic
Report before measuring the card. The final desktop screenshot was directly
reviewed with the complete selected date visible. Temporary browser/server
resources were closed, and their local listening ports are no longer active.
See `output/ui-optimization-local/verification.json` for log references and
file hashes. The existing bundle-size advisory remains.

Follow-up final aggregate verification: the complete, unfiltered
`node scripts/check-browser-workflows.mjs` run passed **75 of 75** workflows
against the final date-width correction, with exit code 0. This supersedes the
earlier split browser result above; that failed attempt remains recorded.
Build/lint inputs were byte-identical to their final passing checks, so those
checks did not need another repeat. See `browser-final-aggregate.log` and its
exit record in the same output directory. No implementation changes, commit,
push or deployment occurred during this follow-up.

Screenshots and local logs are under `output/ui-optimization-local/`. The local
fixture uses synthetic identities/Reports and blank Template definitions, with
all production writes and real email excluded. Browser dimensions are not
physical-phone or assistive-technology certification.

## Release prerequisites

Separate commit/push/deployment approval is required. This is a frontend-only
release: run exact-commit source CI, freeze/verify the Hosting build, validate
preview/live asset parity and existing waiting-update/offline behavior, and
record the retained prior Hosting version. No database migration, backend or
PDF-worker deployment, Scheduler change, IAM/secret update or real-data test
is required by these UI changes. Preserve unrelated checkout edits and local
device/auth state.
