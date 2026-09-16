# Mutual presentation demo

The sample data is **live and verified** in Mutual at [ReportFlow](https://geo-attendance-system-db9ca.web.app). Desktop and phone-sized Chromium checks passed on 16 September 2026 (New Zealand time). This was browser automation, not a physical-phone test. Existing records were unchanged, and no application deployment was performed.

The dataset is marked **DEMO** throughout: three fictional Workers, three Report Templates, two fictional Sites and nine Reports dated 14-16 September 2026. There are three Submitted, three In review and three Resolved Reports.

## Suggested walkthrough

1. Open the normal hosted app and sign in with your usual Supervisor account that can view Mutual. If using a Global Admin account, select Mutual. No new password is needed to show these Reports through an existing authorized account.
2. Open **Reports** and enter `demo-20260916` in **Find**. Clear unrelated filters first. Show all nine Reports, then select each workflow filter to demonstrate the three Reports in each state.
3. Replace Find with `walkway`, open the resolved Toolbox Talk, and show its meeting sections, attendee rows, synthetic evidence and final Supervisor note. These are fictional examples, not actual meeting attendance or safety records.
4. Replace Find with `cable` and open the In-review Site Observation. Show the recorded observation, illustration and review state without resolving it.
5. Replace Find with `inventory` and open the In-review Daily Progress Report. Show the repeated material quantities and evidence. Clear Find and select the Submitted filter to show work awaiting review. The `packaging` and `handover` examples have no Site selected, demonstrating that Site is optional.
6. Open **Report Templates** to show `DEMO - Toolbox Talk - demo-20260916`, `DEMO - Site Observation - demo-20260916` and `DEMO - Daily Progress - demo-20260916`. View them without publishing changes unless intentionally demonstrating Template editing.
7. The optional Worker-view demonstration needs one of the dedicated demo logins. All three accounts were verified to see only their own three Reports. Their credentials are held in the encrypted local handoff described below; ask the operator to open a demo Worker session before presenting. Return to the Supervisor account afterward.

Opening Reports, changing filters and downloading exports are read-only. **Start review**, **Resolve**, submission, Template publication and Staff changes alter live state. Leave the nine baseline Reports unchanged unless the presenter deliberately chooses a mutation; their starting three-per-state balance will then change.

## Evidence and export expectations

Photos are synthetic, visibly labelled demo illustrations. Signatures are generic demonstration marks, not anyone's actual signature or evidence of consent. Names, locations, observations and quantities are fictional; the Sites use deliberately synthetic coordinates. No real client records, work completion or safety certification is represented.

The new PDF formatting and supplied Mutual logo are now **live**, deployed separately on 16 September 2026. In a Report's export selector choose **Report PDF**, then **Export**; use **Export Reports PDF** above the inbox for the matching collection. The [PDF release checks](evidence/report-pdf-release-20260916/release.json) verified the two-page Toolbox Talk and all nine demo Reports in a 16-page collection, including signatures, photos, final notes and page numbering. Both live export buttons passed a phone-sized browser check. The deployment did not change or clean up these demo records.

## Verification and private access

The [browser evidence](evidence/presentation-demo-20260916-browser/evidence.json) records all nine exact Report IDs checked through their ownership manifest, three active Templates, six authenticated/decodable uploads, three Reports per workflow filter, the resolved Toolbox Talk detail, current CSV/PDF download responses and all three Workers' isolated histories. No browser JavaScript errors or HTTP 5xx responses were observed. Export checks verify download validity, not the newer PDF layout.

Dedicated operator-controlled account IDs are Workers **13–15** and Supervisor **16**. They are fictional demo accounts, not real invitation recipients. Credential storage is `output/presentation-demo-20260916.local/credentials.dpapi`, excluded from Git and encrypted for the same Windows user profile on this computer. It is not a portable login file. The local `read_private_handoff()` helper in `scripts/presentation-demo-live.py` decrypts only into process memory; the browser verifier uses it without traces, HAR, stored sessions or credential output. An operator can use this mechanism to prepare a demo session. Do not print credentials into terminal transcripts, share the handoff, or include decrypted credentials in slides, recordings or repository files.

## Cleanup later

No cleanup has been performed. Keep the exact ownership manifest at [presentation-demo-20260916.json](evidence/presentation-demo-20260916.json). It records created IDs and pending operations for this run; inspect its final status before presentation or cleanup.

When cleanup is requested, use only the manifest's owned IDs and verify their ownership/references first. Do not delete by a broad `DEMO` search or touch existing accounts or records. Archive the three demo Templates first to stop new submissions, then move owned Reports to trash and resign dedicated demo accounts. Use another authorized Supervisor/operator to resign demo Supervisor **16**; the API forbids resigning your own account. Do not delete later, unowned Reports that someone may create from the Templates.

Demo Sites require an exact-reference review because there is no Site archive API. Retain them if historical or trashed Reports still reference them; trashing a Report does not remove its Site reference. Keep upload and audit retention behavior intact. Cleanup is a separate, explicitly authorized step; no cleanup script has been run or scheduled.
