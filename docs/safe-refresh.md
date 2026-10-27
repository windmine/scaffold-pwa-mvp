# Safe Refresh

Released 2026-10-27 UTC from `88c4635044e2bb283688990bfc26fdda7368a7ec` as Hosting `d06166d2b8bd70d4`.
See [release evidence](evidence/safe-refresh-release-20261027/release.json).

The report-only top bar has a Refresh action for signed-in Workers and Supervisors.
It reads authorized Sites, Report Templates and My Reports; Supervisors also refresh
the Department-scoped Reports list. It checks the registered service worker for a
new version. Installing a waiting version still requires the separate Update App
action and its existing draft/correction safeguards. Refresh never reloads the page,
clears device storage, uploads evidence or syncs queued submissions. Retry sync and
the existing startup/reconnect sync behavior remain separate.

The open submission editor retains its exact rendered fields, answers, photos,
signatures, date, selected/manual Site and draft state. New Template definitions are
available in the catalog without replacing that editor. If its Template changes or
is unavailable, submission is blocked with guidance to choose a Template again;
existing draft/version-conflict recovery remains in place. A selected Site removed
from the refreshed catalog remains selected as a disabled option; backend access
checks still apply. Changing a selection remains an explicit user action.

Template email-setting editors retain their DOM and saved version guard while other
cards refresh, including collapsed settings with unsaved input. Report corrections
retain their original revision and unsaved edits. Refresh does not save either.

Each fetch can fail independently. Failed reads retain the corresponding current
list and the status reports partial failure. Offline Refresh makes no requests.
Repeated clicks coalesce; navigation, logout, Department changes and app-update
preparation invalidate pending results. A 30-second deadline releases the control
and invalidates late results. A browser without service-worker support reports an
incomplete update check while permitting successful data refreshes.

Validation: `npm run check:safe-refresh` uses intercepted local-only browser requests,
synthetic users/data and a mocked service worker. It is included in the full mobile
gate through `check:startup-sync`. No production data, emails or deployment is needed.
Local verification on 2026-10-27 passed all ten focused Refresh groups, all 75
real-backend browser workflows, every mobile-gate stage, build and lint. Worker,
desktop Supervisor and 320px Chinese Supervisor screenshots were reviewed. The
initial mobile attempt stopped at disposable-backend readiness/cleanup; that
unchanged stage passed outside the sandbox, then the remaining stages passed.
The original failure is retained; its root cause is not established. Evidence is
in `output/safe-refresh-local/verification.json` and the adjacent logs/screenshots.
Physical installed iOS/Android testing remains a separate release verification limit;
the existing bundle-size advisory remains. No production fixtures were used.

The approved frontend release passed source CI, preview/live file parity, anonymous
installer/offline checks and the waiting-update probe. Backend, database, IAM, secret
and Scheduler configuration remain unchanged. Future releases still require the
normal frontend gates and approval.
