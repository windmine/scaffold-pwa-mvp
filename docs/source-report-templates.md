# Source report templates

Support is deployed from source `f82d5860202c13df0967535b2f1d48d66019ab98` as backend `geo-backend-templates-20261023` and Hosting `e827de152baed084`. [Release evidence](evidence/source-templates-release-20261023/release.json). The user signed in as Ken Hu (active Supervisor 28, home Department Mutual 2), and the normal Report Templates editor published the five non-PPE definitions once each. Authenticated rereads verified all fields and default-off email settings with no recipient. No Reports or emails were created; no credentials were exported. The temporary browser was closed. [Publication evidence](evidence/source-templates-release-20261023/template-import.json). PPE remains a local draft.

The blank definitions in `templates/mutual-source-templates.json` represent six distinct forms from eight supplied PDF examples. Their intended destination is the existing Mutual Department (ID 2). They contain no completed answers, photographs, signatures, locations or example personal details. Requiredness and full choice menus cannot be inferred from completed PDFs, so imported answer fields are optional and ambiguous results remain blank text. ReportFlow's Report Date remains required.

| Template | Entries including headings | Publication |
| --- | ---: | --- |
| FM-15 Site Health Safety & Environment Audit | 117 | Active in Mutual, ID 27; email off |
| Fall Arrest Lanyard / harness examination | 26 | Active in Mutual, ID 28; email off |
| QA – James Hardies Axon | 21 | Active in Mutual, ID 29; email off |
| QA SVS Ecoply+Cavity | 26 | Active in Mutual, ID 30; email off |
| Excavator Pre-start Checklist | 24 | Active in Mutual, ID 31; email off |
| PPE ISSUE/ TOOL DEDUCTION FORM | 26 | Local draft only |

PPE retains the supplied incomplete deduction wording without repairing it or asserting legal validity. Equipment receipt and deduction authority have separate optional signatures. Publishing this form awaits the owner's complete approved wording. Every definition has automatic email disabled and no recipient.

## Compatible template support

Templates support up to 128 entries. Section headings can carry up to 500 characters of non-editable instruction text, preserved in the form and exports. The source Axon disclaimer and PPE acknowledgments are retained as static text.

Photo fields use the existing authorized upload path and shared limit of 50 photographs of up to 5 MiB each. Field IDs retain section associations through drafts, submission, corrections, exports and frozen original PDF-email snapshots. Legacy unassigned photographs remain supported. Signature fields retain their existing handwritten behavior.

Location fields capture structured coordinates only after an explicit button press and browser permission. They retain accuracy and capture time, support clearing and offline draft restoration, and include a map link in the form and PDF. No map tiles are embedded; opening the link needs connectivity. Tests use synthetic coordinates and mocked permission results.

New clients send template feature version 2. Older clients cannot create or edit extended templates or submit/correct reports against them; they receive an update-required response. Existing accepted replay IDs remain idempotent. Ordinary definitions keep their original serialized shape. These changes use existing JSON columns and require no database migration.

## Release and publication boundaries

Deploy the compatible backend and PDF worker before Hosting. Preserve SMTP secret version 1, runtime identities, IAM, public-registration disabled state, existing worker limits and routing. No email or real submission is needed to verify this release. Before publication, verify the normal authenticated template-creation workflow belongs to Mutual and check for duplicates. Global-admin dashboard focus alone does not change the creation Department. Do not change accounts or introduce a department selector as part of this support release.

Once extended templates are published, keep a compatible backend and worker for reads, evidence and exports; prefer a forward fix over an older renderer. Do not downgrade migrations, clear device storage or reset authentication generations. Before publication, the prior corrections release remains the compatible rollback baseline.

## Verification limits

Synthetic tests cover every source label/static paragraph in generated PDF/HTML, blank form defaults, long-form phone rendering, signatures, section photographs, structured location guards, replay, corrections and frozen email snapshots. Local SMTP is mocked. Original PDFs were visually reviewed in the source-extraction environment; Windows Library materialization failed in its supported metadata helper, so no desktop source-pixel comparison is claimed. Physical phones and real location capture are not tested.
