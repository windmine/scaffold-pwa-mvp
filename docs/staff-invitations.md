# Staff invitations — local preparation

The Report-only Staff form now invites Workers and Supervisors, including global admins when the actor already has permission to grant that access. A Department Supervisor may invite a Supervisor only in their own Department, matching existing direct creation. Only global admins may grant global-admin access or select another Department. Existing active accounts cannot be invited or converted by this flow.

For Supervisors, **Account setup** defaults to **Invitation — recipient sets password**. **Create immediately — no invitation email** retains direct creation with an entered password. Workers retain their existing invitation flow; the retained full-interface direct-creation behavior is unchanged. Creating an invitation never sends email automatically: the private dialog has an explicit **Send invitation email** action and Copy/Share fallback. The recipient and intended role are visible. SMTP acceptance is displayed separately from unverified mailbox delivery.

The pending User stores the authorized role, but both login and authenticated requests reject all pending accounts until password setup succeeds. Migration `0026_staff_invitations` adds `invited_role` and `invited_is_global_admin` to the existing invitation table. Historical invitations default to Worker/non-admin; existing Users, passwords, sessions, invitation tokens, send-attempt states and prior migration checksums are preserved. Legacy table names, audit action names, token namespace and Worker setup URLs remain compatible. New privileged creation uses `/supervisor/staff-invitations`; the legacy Worker creation route stays Worker-only and rejects extra role/grant fields.

Inspection, sending and acceptance require the saved role/grant, Department, email and generation to match. Pending role and global-admin edits are rejected. Contact/Department/status edits retain existing invitation invalidation. Reissue, revoke and send require authority over the target, including a global-admin actor for a global-admin target. Acceptance is atomic, expiring, single-use, and cannot choose or alter a role/Department/grant. Validation responses omit submitted tokens and passwords. Setup does not replace an existing browser session.

Sending retains the existing durable one-attempt claim, fixed recipient, certificate-verified SMTP and uncertain-result protections. No retry occurs for accepted or uncertain attempts. Public-registration email, Worker password recovery, PDF routing and existing SMTP configuration are unchanged. This feature introduces no cloud resources, IAM grants or new persistent credentials.

## Release boundary

This preparation is local only. It does not authorize a deployment or any real invitation/email/account change. Production account 29 (`admin@mutualconstruction.co.nz`) is unchanged and is not a migration target.

After separate release approval: verify current recovery/backup prerequisites, preserve inventory and all prior checksums, apply additive migration 0026, deploy its compatible backend (and keep the existing PDF worker compatible with the new ledger), then promote Hosting. Preserve existing runtime identities, secrets/settings, public-registration disablement and template email settings. Test with isolated synthetic fixtures; do not send a real invitation as a release check.

An older image whose manifest ends at 0025 rejects the new ledger. Use a migration-compatible fallback or forward fix; never remove the new ledger entry, reset credentials/auth generations, change a pending role/grant to make a link work, or clear device storage. Existing accounts stay as they are; this feature is onboarding, not password recovery for an existing Supervisor/admin.

## Invitation getting-started guide

Every explicit Worker, Supervisor and global-admin invitation send includes the same public `ReportFlow-Getting-Started.pdf`. It is a single-page, bounded 512 KiB attachment generated with the existing ReportLab dependency and packaged ReportFlow logo, cached in process without account data. Its QR encodes only `https://geo-attendance-system-db9ca.web.app`. The private single-use setup link and actual expiry remain separately in the plain-text email body. PDF preparation happens before the durable send claim; preparation failure leaves Copy/Share available and performs no SMTP attempt. SMTP acceptance still does not prove inbox delivery.

The guide explains invitation acceptance, signing in, PWA installation, first submission and queued/offline limits. Installation wording was checked on 2026-10-23 against [Apple Safari guidance](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios), [Chrome Android guidance](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid&hl=en), [Chrome desktop guidance](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DDesktop&hl=en), and the existing app installer. Browser menu labels vary by version. No App Store binary, automatic install, support email, or cold-offline first-use guarantee is claimed.

## Validation coverage

Focused coverage is in `backend/staff_invitation_test.py`, `backend/invitation_email_test.py`, `backend/migration_test.py`, `backend/postgres_invitation_rehearsal.py`, `backend/security_test.py`, `backend/smoke_test.py`, and `scripts/report-staff-simplicity-test.mjs`. These use disposable local data and mocked SMTP. Final validation outcomes are recorded separately after the complete gates finish.
