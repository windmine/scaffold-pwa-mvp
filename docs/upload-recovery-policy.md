# Production Upload Recovery Policy

This policy applies to production photos, handwritten signatures, and other evidence stored in `gs://geo-attendance-system-db9ca-uploads`. Local `backend/uploads/` is development-only and is not a recovery source.

## Protection Contract

- Cloud Storage soft delete stays enabled for at least 30 days (`2592000` seconds).
- Public access prevention stays `enforced` and uniform bucket-level access stays enabled.
- The Cloud Run runtime identity is `geo-backend-runtime@geo-attendance-system-db9ca.iam.gserviceaccount.com`.
- Runtime bucket access is restricted to `uploads/` and to `storage.objects.create`, `storage.objects.get`, and `storage.objects.delete`. The application cannot list or restore soft-deleted objects.
- Recovery is an operator action. For a targeted restore, grant a time-bound recovery operator only `storage.objects.list`, `storage.objects.get`, `storage.objects.restore`, and `storage.objects.create`; `storage.objects.delete` is required only when an approved incident plan intentionally overwrites a live object.
- Bulk restore additionally requires `storage.buckets.restore`. Operators who must list or cancel long-running restore jobs also need the corresponding `storage.bucketOperations.list`, `storage.bucketOperations.get`, or `storage.bucketOperations.cancel` permissions. Keep these recovery permissions off the Cloud Run runtime identity.
- Object Versioning remains disabled. Upload names are unique and application cleanup relies on normal delete semantics; 30-day soft delete is the bounded recovery mechanism. Do not add an immutable bucket-retention lock because it would break supported cleanup and purge workflows.
- Soft delete protects the object bytes, not the database reference or its ownership metadata. Database recovery and upload recovery must be coordinated when both changed.

The live policy and a content-preserving delete/restore drill are checked by:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prove-upload-recovery.ps1 `
  -EvidencePath docs/evidence/upload-recovery-proof-2026-07-15.json
npm.cmd run check:production-hardening
```

The latest non-secret drill result is stored in `docs/evidence/upload-recovery-proof-2026-07-15.json`.

## Targeted Restore

Prefer an exact object restore. It is easier to verify and does not overwrite unrelated uploads.

1. Record the incident start/end time and stop the application or operator action that is still deleting evidence.
2. Establish the expected `uploads/<filename>` from the durable database record and Audit history. Do not infer record ownership from an object name alone.
3. List only that soft-deleted object and capture its generation:

   ```powershell
   gcloud storage ls "gs://geo-attendance-system-db9ca-uploads/uploads/FILE" --soft-deleted
   ```

4. Restore the selected generation without overwriting a live object:

   ```powershell
   gcloud storage restore "gs://geo-attendance-system-db9ca-uploads/uploads/FILE#GENERATION"
   ```

5. Verify size, content hash, content type, uploader metadata, and authorized `/uploads/FILE` streaming through Firebase Hosting.
6. Verify that the restored object is referenced by the intended durable record. If the reference was also deleted, recover or repair the database through an audited database-recovery procedure before reopening the workflow.
7. Record the operator, object generation, related record, incident time range, and verification result.

Do not use `--allow-overwrite` unless an incident plan explicitly identifies the current live generation as incorrect and preserves its details first.

## Bulk Restore

Use bulk restore only when the deletion window and object prefix are known. Start without overwrite:

```powershell
gcloud storage restore "gs://geo-attendance-system-db9ca-uploads/uploads/**" `
  --async `
  --deleted-after-time="INCIDENT_START_UTC" `
  --deleted-before-time="INCIDENT_END_UTC"
```

Track the returned long-running operation and reconcile restored objects against database references before declaring recovery complete. The initiating operator can read its operation; grant `storage.bucketOperations.get`/`list` only when another operator or automation must inspect it, and `storage.bucketOperations.cancel` only to the incident commander. Bulk restoration can take substantially longer than a targeted restore.

## Limits And Review

- The recovery window is 30 days from deletion. After hard-delete time, Cloud Storage cannot restore the object.
- Soft delete is not an off-provider archive and does not replace Neon PITR, logical database backups, or incident audit records.
- Soft-deleted objects incur storage charges during retention. Recovery probes deliberately leave only tiny soft-deleted fixtures that expire under the same policy.
- Run the proof after bucket/IAM changes and at least monthly so the default 30-day hardening gate always has current evidence. Keep the latest successful result and review failed probes immediately.
