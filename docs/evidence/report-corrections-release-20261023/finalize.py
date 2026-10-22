"""Aggregate completed local proofs; write only release.json, never deploy or edit docs.

Run only after the operator has completed every release phase:
    python docs/evidence/report-corrections-release-20261023/finalize.py --write

This helper performs no subprocess, network, provider, database, or dist operation.
Missing/failed proofs refuse publication. Existing release.json is never replaced.
The output describes the recorded observations, not a fresh live-state inspection.
"""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys


OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[2]
LOCAL = ROOT / "docs/evidence/report-corrections-local-20261023"
HEAD = "0025_report_corrections"
PREVIOUS_HEAD = "0024_report_pdf_email"
PROJECT = "geo-attendance-system-db9ca"
HOST = f"https://{PROJECT}.web.app"
CANDIDATE = "geo-backend-corrections-20261023"
FALLBACK = "geo-backend-corrections-fallback-20261023"
PREVIOUS_HOSTING = "12a1d6dbf481ba3b"
JOB = "reportflow-pdf-email"
FIRST_CI = 39855289104
COUNTS = {"accepted", "failed", "uncertain", "skipped"}


class EvidenceError(Exception):
    """A fixed, credential-free refusal code."""


def require(condition, code):
    if not condition:
        raise EvidenceError(code)


def timestamp(value):
    require(isinstance(value, str), "required_timestamp_missing")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise EvidenceError("invalid_evidence_timestamp") from None
    require(result.tzinfo is not None, "evidence_timestamp_requires_timezone")
    return result


def load(name, status="passed", directory=OUT):
    path = directory / name
    require(path.is_file(), "required_evidence_missing:" + name)
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (ValueError, OSError):
        raise EvidenceError("required_evidence_unreadable:" + name) from None
    require(isinstance(value, dict), "required_evidence_not_object:" + name)
    if status is not None:
        require(value.get("status") == status, "required_evidence_not_passed:" + name)
    return value


def artifact(path):
    return {"path": path.relative_to(ROOT).as_posix(),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def environment(runtime):
    containers = runtime.get("containers", [])
    require(len(containers) == 1, "single_runtime_container_required")
    return {item["name"]: item for item in containers[0].get("env", [])}


def flag(runtime, name, enabled):
    expected = hashlib.sha256(str(enabled).lower().encode()).hexdigest()
    require(environment(runtime).get(name, {}).get("valueSha256") == expected,
            "runtime_flag_mismatch:" + name)


def channel_version(channel):
    return channel["release"]["version"]["name"].rsplit("/", 1)[-1]


def snapshot(value, count, head):
    require(value.get("transactionReadOnly") is True, "inventory_not_read_only")
    require(value.get("migrationCount") == count and value.get("migrationHead") == head,
            "inventory_ledger_mismatch")
    ledger = value.get("migrationChecksums", {})
    require(len(ledger) == count and all(re.fullmatch(r"[a-f0-9]{64}", digest or "")
                                       for digest in ledger.values()), "inventory_ledger_hashes_invalid")
    require(isinstance(value.get("businessTables"), dict), "business_inventory_missing")
    for key in ("configuredTemplateRows", "outboxRows", "pendingOutboxRows"):
        require(type(value.get(key)) is int and value[key] >= 0, "inventory_count_invalid:" + key)
    statuses = value.get("outboxStatuses", {})
    require(isinstance(statuses, dict) and all(type(count) is int and count >= 0 for count in statuses.values()),
            "outbox_status_counts_invalid")
    require(sum(statuses.values()) == value["outboxRows"]
            and statuses.get("pending", 0) == value["pendingOutboxRows"], "outbox_status_counts_inconsistent")
    return value


def completed_probe(name, mode):
    value = load(name)
    require(value.get("mode") == mode and value.get("execution")
            and value.get("executionCompletedAtUtc"), "probe_execution_not_confirmed:" + name)
    timestamp(value["executionCompletedAtUtc"])
    return value


def assemble():
    identity = load("source-ci-id.json", None)
    source = identity.get("sourceCommit", "")
    require(re.fullmatch(r"[a-f0-9]{40}", source) is not None, "invalid_source_commit")
    ci = load("ci-source.json", "completed")
    require(ci.get("databaseId") == identity["id"] and ci.get("headSha") == source
            and ci.get("conclusion") == "success", "source_ci_identity_or_result_mismatch")
    require(len(ci.get("jobs", [])) == 2 and all(job.get("conclusion") == "success" for job in ci["jobs"]),
            "both_source_ci_jobs_must_pass")

    # These proofs are phase-bound and must all complete before release publication.
    names = ["backend-promotion.json", "hosting-promotion.json", "candidate.json", "fallback.json",
             "maintenance.json", "pause.json", "backup.json", "hosting-preview.json", "hosting-retention.json",
             "preview-full-parity.json", "preview-shell.json", "preview-installer.json",
             "live-full-parity.json", "live-shell.json", "live-installer.json", "live-waiting-update.json",
             "neon-premigration.json", "neon-current-final.json", "hardening-pre.json", "hardening-current-final.json",
             "live-backend-verification.json", "worker-paused.json", "worker-quiesced.json", "worker-updated.json",
             "disabled-worker-proof.json", "worker-enabled.json", "scheduler-active.json",
             "scheduled-worker-verification.json", "cleanup.json", "fallback-local.json", "preparation-validation.json"]
    proofs = {name: load(name) for name in names}
    baseline = completed_probe("baseline-verified-proof.json", "inventory")
    staging = completed_probe("stage-migrated-proof.json", "stage-migrate")
    provider = completed_probe("stage-provider-verified-proof.json", "stage-smoke")
    stage_fallback = completed_probe("stage-fallback-proof.json", "stage-fallback")
    saved = completed_probe("backup-verified-proof.json", "backup-verify")
    migration = completed_probe("production-proof.json", "production-migrate")
    post = completed_probe("post-release-proof.json", "inventory")

    images = load("images.json", None)
    packages = load("source-packages.json", None)
    build = load("build-final.json", "SUCCESS")
    manifest = load("build-manifest.json", None)
    require(all(value.get("sourceCommit") == source for value in [images, packages, manifest]),
            "source_build_identity_mismatch")
    require(images.get("buildId") == build.get("id") and images.get("mockedTestsPassed") is True,
            "image_build_result_mismatch")
    require(build.get("steps") and all(step.get("status") == "SUCCESS" for step in build["steps"]),
            "image_build_step_failed")
    for kind in ("candidate", "fallback"):
        package = packages["packages"][kind]
        require(package.get("baseCommit") == source, "image_package_source_mismatch")
        matches = [row for row in build["results"]["images"] if row["name"] == package["imageTag"]]
        require(len(matches) == 1 and images["images"][kind] == matches[0]["name"].rsplit(":", 1)[0] + "@" + matches[0]["digest"],
                "image_digest_mismatch:" + kind)
    candidate_files = packages["packages"]["candidate"]["files"]
    fallback_files = packages["packages"]["fallback"]["files"]
    changed = sorted(path for path in set(candidate_files) | set(fallback_files)
                     if candidate_files.get(path) != fallback_files.get(path))
    require(changed == ["backend/app/use_cases/report_corrections.py"], "fallback_changed_more_than_correction_guard")
    fallback_local = proofs["fallback-local.json"]
    require(fallback_local["overlay"]["beforeSha256"] == candidate_files[changed[0]]
            and fallback_local["overlay"]["afterSha256"] == fallback_files[changed[0]]
            and fallback_local.get("cleanupComplete") is True, "local_fallback_guard_does_not_match_built_images")

    before = snapshot(migration["before"], 24, PREVIOUS_HEAD)
    after = snapshot(migration["after"], 25, HEAD)
    final = snapshot(post["before"], 25, HEAD)
    snapshot(baseline["before"], 24, PREVIOUS_HEAD)
    require(migration.get("businessDataPreserved") is True and migration.get("applied") == [HEAD]
            and before["businessTables"] == after["businessTables"], "migration_changed_preexisting_business_data")
    require(all(after["migrationChecksums"].get(key) == digest for key, digest in before["migrationChecksums"].items())
            and final["migrationChecksums"] == after["migrationChecksums"], "prior_or_current_migration_checksums_changed")
    require(after["correctionColumns"] == ["edited_at", "edited_by_supervisor_id", "revision"]
            and after.get("correctedRows") == 0, "migration_correction_defaults_not_verified")
    require(all(before[key] == after[key] for key in
                ("configuredTemplateRows", "outboxRows", "pendingOutboxRows", "outboxStatuses")),
            "migration_changed_existing_routing_or_outbox")
    require(saved.get("backupMatchesProduction") is True and saved["before"] == saved["backup"] == before,
            "backup_does_not_match_paused_premigration_inventory")
    require(staging.get("businessDataPreserved") is True and staging.get("applied") == [HEAD]
            and stage_fallback["before"]["migrationHead"] == HEAD, "staging_schema_or_fallback_not_verified")
    api = provider.get("api", {})
    require(api.get("smokeExitCode") == 0 and api.get("passingChecks", 0) >= 251
            and api.get("cleanupComplete") is True and api.get("freshDisposableDatabase") is True
            and api.get("smtpDisabled") is True, "isolated_provider_http_smoke_not_complete")
    original_provider_failure = load("stage-provider-proof.json", "failed")
    original_provider_observation = load("stage-provider-smoke-diagnosis.json", None)
    provider_diagnosis = load("stage-provider-verified-dependency-diagnosis.json", "confirmed")
    provider_cleanup = load("stage-provider-verified-fixture-cleanup.json")
    reader = api.get("testReader", {})
    require(original_provider_failure.get("mode") == "stage-smoke"
            and original_provider_observation.get("passingChecks") == 0,
            "original_provider_smoke_failure_not_preserved")
    require(provider_diagnosis.get("exception") == "ModuleNotFoundError"
            and provider_diagnosis.get("missingModule") == "pypdf"
            and provider_diagnosis.get("smokeSourceSha256") == candidate_files["backend/smoke_test.py"]
            and provider_diagnosis.get("originalImageUnchanged") is True
            and provider_diagnosis.get("importOnlyNoApiRequests") is True,
            "provider_smoke_dependency_diagnosis_unverified")
    require(reader.get("version") == "6.20.0"
            and reader.get("wheelSha256") == "f003fc2014814d264fe7dd3f9d435c158e23e1a85a2233f87a0a2d6d21c914ad"
            and reader.get("wheelBytes") == 401710
            and all(reader.get(key) is True for key in
                    ("smokeSubprocessOnly", "originalMissingModuleReproduced", "productionImageUnchanged"))
            and api.get("testReaderCleanupComplete") is True
            and all(provider_cleanup.get(key) is True for key in
                    ("databaseDropped", "databaseAbsenceVerified", "supplementalLogoRemoved")),
            "provider_smoke_test_reader_or_fixture_cleanup_unverified")

    backend = proofs["backend-promotion.json"]
    live_backend = proofs["live-backend-verification.json"]
    hosting = proofs["hosting-promotion.json"]
    candidate = proofs["candidate.json"]
    fallback = proofs["fallback.json"]
    traffic = [{"revisionName": CANDIDATE, "percent": 100}]
    require(backend.get("revision") == live_backend.get("revision") == candidate.get("revision") == CANDIDATE
            and backend.get("traffic") == live_backend.get("traffic") == traffic, "live_candidate_traffic_mismatch")
    require(backend["runtime"] == candidate["runtime"] == live_backend["runtime"]
            and backend["runtime"]["containers"][0]["image"] == images["images"]["candidate"],
            "live_candidate_runtime_or_image_mismatch")
    require(fallback.get("revision") == FALLBACK
            and fallback["runtime"]["containers"][0]["image"] == images["images"]["fallback"], "compatible_fallback_identity_mismatch")
    flag(backend["runtime"], "REGISTRATION_EMAIL_ENABLED", False)
    flag(backend["runtime"], "REPORT_PDF_EMAIL_WORKER_ENABLED", False)
    require(environment(backend["runtime"]).get("SMTP_PASSWORD", {}).get("valueFrom", {}).get("secretKeyRef")
            == {"name": "reportflow-smtp-password", "key": "1"}, "smtp_secret_reference_changed")
    require(live_backend.get("errorOr5xxCount") == 0 and live_backend.get("serviceAndSmtpSecretIamUnchanged") is True
            and live_backend.get("secretReferencesUnchanged") is True, "live_backend_verification_failed")
    require(hosting.get("version") == proofs["hosting-preview.json"]["version"] == channel_version(hosting["live"])
            and hosting.get("previousVersion") == PREVIOUS_HOSTING, "hosting_promotion_identity_mismatch")
    require(manifest.get("fileCount") == len(manifest.get("files", {})) and manifest["fileCount"] >= 85,
            "frozen_manifest_incomplete")
    for phase in ("preview", "live"):
        parity = proofs[phase + "-full-parity.json"]
        expected_origin = HOST if phase == "live" else proofs["hosting-preview.json"]["url"]
        require(parity.get("sourceCommit") == source and parity.get("origin") == expected_origin
                and parity.get("fileCount") == manifest["fileCount"]
                and {row["path"]: row["sha256"] for row in parity["files"]} == manifest["files"],
                "hosting_exact_file_parity_mismatch:" + phase)
        require(all(proofs[phase + suffix].get("origin") == expected_origin for suffix in ("-shell.json", "-installer.json")),
                "hosted_browser_probe_origin_mismatch:" + phase)
    waiting = proofs["live-waiting-update.json"]
    require(waiting.get("origin") == HOST and len(waiting.get("checks", [])) >= 4
            and waiting["expected"]["cacheVersion"] == manifest["cacheVersion"]
            and waiting["expected"]["swSha256"] == manifest["files"]["sw.js"]
            and waiting["expected"]["indexSha256"] == manifest["files"]["index.html"], "live_waiting_update_wrong_build")

    pause = proofs["pause.json"]
    require(timestamp(migration["executionCompletedAtUtc"]) <= timestamp(backend["atUtc"])
            <= timestamp(hosting["atUtc"]) <= timestamp(live_backend["atUtc"]), "backend_database_frontend_release_order_unverified")
    require(pause.get("drainSeconds") == 300
            and timestamp(pause["maintenanceConfirmedAtUtc"]) < timestamp(pause["drainUntilUtc"])
            <= timestamp(migration["atUtc"]), "maintenance_and_drain_order_invalid")
    for name, head, phase in (("neon-premigration.json", PREVIOUS_HEAD, "PreMigration"),
                              ("neon-current-final.json", HEAD, "Current")):
        recovery = proofs[name]
        require(recovery.get("expectedRecoveryHead") == head and recovery.get("releasePhase") == phase
                and recovery.get("cleanup", {}).get("absenceVerified") is True
                and recovery.get("cleanup", {}).get("deleted") is True, "recovery_phase_or_cleanup_invalid:" + name)
    hardening = proofs["hardening-current-final.json"]
    require(hardening.get("strict") is True and hardening.get("exitCode") == 0
            and not hardening.get("failures") and hardening.get("sourceCommit") == source, "strict_final_hardening_incomplete")

    quiesced = proofs["worker-quiesced.json"]
    require(quiesced.get("schedulerPaused") is True and quiesced.get("workerDisabled") is True
            and quiesced.get("activeExecutions") == [] and quiesced.get("executionsCancelled") is False
            and timestamp(quiesced["atUtc"]) <= timestamp(pause["maintenanceConfirmedAtUtc"]), "worker_not_drained_before_migration")
    disabled = proofs["disabled-worker-proof.json"]
    require(disabled.get("result") == {"status": "disabled"}
            and disabled.get("smtpAuthenticationOrEmailAttempted") is False, "disabled_worker_proof_invalid")
    worker = proofs["scheduled-worker-verification.json"]
    schedule = worker["scheduler"]
    runtime = worker["runtime"]
    require(schedule.get("state") == "ENABLED" and schedule.get("schedule") == "*/5 * * * *"
            and schedule.get("timeZone") == "Etc/UTC" and worker.get("existingIamPreserved") is True,
            "existing_worker_schedule_or_iam_not_restored")
    flag(runtime, "REPORT_PDF_EMAIL_WORKER_ENABLED", True)
    require(runtime["containers"][0]["image"] == images["images"]["candidate"]
            and runtime["containers"][0].get("args") == ["-m", "app.report_pdf_email_worker", "--limit", "10"]
            and runtime.get("maxRetries", 0) == 0 and str(runtime.get("timeoutSeconds")) == "600",
            "scheduled_worker_image_or_limits_mismatch")
    activated_at = timestamp(proofs["scheduler-active.json"]["atUtc"])
    require(timestamp(hosting["atUtc"]) <= timestamp(proofs["worker-enabled.json"]["atUtc"]) <= activated_at,
            "worker_resumed_before_coupled_release")
    executions = worker.get("executions", [])
    require(executions and len({row["execution"] for row in executions}) == len(executions), "scheduled_execution_proof_missing_or_duplicate")
    totals = dict.fromkeys(sorted(COUNTS), 0)
    for execution in executions:
        result = execution.get("result", {})
        counts = result.get("counts", {})
        require(result.get("status") == "completed" and set(counts) == COUNTS
                and all(type(count) is int and count >= 0 for count in counts.values())
                and timestamp(execution["completedAt"]) >= activated_at, "scheduled_execution_outcome_invalid")
        for name, count in counts.items():
            totals[name] += count
    processed = sum(totals.values()) > 0
    require(worker.get("normalScheduledWorkProcessed") is processed, "scheduled_work_summary_inconsistent")
    require(timestamp(post["atUtc"]) >= max(timestamp(row["completedAt"]) for row in executions),
            "final_inventory_predates_verified_scheduled_execution")

    backup = proofs["backup.json"]
    branch = backup["branch"]
    retained = proofs["hosting-retention.json"]["channel"]
    require(backup.get("backupMatchesProduction") is True and backup.get("readOnlyMetadataVerified") is True
            and saved.get("backupBranchId") == branch["id"]
            and timestamp(branch["created_at"]) >= timestamp(pause["drainUntilUtc"]), "retained_backup_not_verified")
    require(channel_version(retained) == PREVIOUS_HOSTING and retained["name"].endswith("/rollback-corrections-20261023"),
            "retained_hosting_version_mismatch")
    now = datetime.now(timezone.utc)
    require(timestamp(branch["expires_at"]) > now and timestamp(retained["expireTime"]) > now,
            "retained_rollback_resource_expired")
    cleanup = proofs["cleanup.json"]
    require(cleanup.get("absenceVerified") is True and cleanup.get("productionAndBackupPreserved") is True
            and cleanup.get("retainedBackup") == branch["id"]
            and set(cleanup.get("jobs", [])) | {cleanup.get("stageBranch")} == set(cleanup.get("deleted", [])),
            "owned_temporary_resource_cleanup_incomplete")

    local = load("validation.json", "local_validation_passed_not_deployed", LOCAL)
    pg = [load(name, None, LOCAL) for name in ("postgres-full.json", "postgres-final-validator.json")]
    require(all(value.get("passed") is True and value.get("cleanup_complete") is True and not value.get("failures") for value in pg),
            "local_postgres_evidence_not_passed")
    require([len(value["checks"]) for value in pg] == [78, 14], "local_postgres_checkpoint_count_unexpected")
    local_validation = local["validation"]
    require(local_validation["backend_gate"].get("passed") is True and local_validation["backend_gate"]["suites"] == 26
            and local_validation["mobile_gate"].get("passed") is True
            and local_validation["mobile_gate"]["real_backend_browser_workflows"] == 75, "local_release_gates_incomplete")
    source_ci = {"id": identity["id"], "url": ci["url"], "jobsPassed": True, "jobCount": len(ci["jobs"]),
                 "expectedRealBackendBrowserWorkflows": 75, "observedRealBackendBrowserWorkflows": None}
    if (OUT / "ci-check-counts.json").exists():
        counts = load("ci-check-counts.json")
        frontend_counts = counts.get("frontend", {})
        backend_counts = counts.get("backend", {})
        require(counts.get("sourceCommit") == source and counts.get("runId") == identity["id"]
                and counts.get("sourceVerifiedInBothExecutedJobLogs") is True
                and frontend_counts.get("conclusion") == backend_counts.get("conclusion") == "success"
                and frontend_counts.get("completeMobileGate") == "passed"
                and frontend_counts.get("realBackendBrowserWorkflowsPassed") == 75,
                "recorded_ci_counts_not_bound_to_source")
        source_ci["observedRealBackendBrowserWorkflows"] = frontend_counts["realBackendBrowserWorkflowsPassed"]
        source_ci["successfulRunAttempt"] = counts["successfulRunAttempt"]
        source_ci["frontendExecutedAttempt"] = frontend_counts["executedAttempt"]
        source_ci["backendExecutedAttempt"] = backend_counts["executedAttempt"]
        source_ci["countEvidence"] = artifact(OUT / "ci-check-counts.json")

    changed_tables = sorted(name for name in set(after["businessTables"]) | set(final["businessTables"])
                            if after["businessTables"].get(name) != final["businessTables"].get(name))
    inventory_counts = lambda value: {key: value.get(key) for key in
        ("configuredTemplateRows", "outboxRows", "pendingOutboxRows", "outboxStatuses", "correctedRows")}
    prior_release = ROOT / "docs/evidence/report-submit-pdf-release-20261021/release.json"
    historical = [
        {"stage": "first source CI", "runId": FIRST_CI,
         "url": f"https://github.com/windmine/scaffold-pwa-mvp/actions/runs/{FIRST_CI}",
         "originalSourceCommit": "41a3f2f9fccf9fbee75450070362cd4cfeed5134", "result": "failed",
         "diagnosis": "Native PostgreSQL volume fixture still used the retired Report workflow; migration 0025 rejected it.",
         "subsequentPassingSourceCi": identity["id"]},
        {"stage": "local hosted-verifier preparation", "diagnosis": proofs["preparation-validation.json"]["diagnosis"],
         "evidence": artifact(OUT / "preparation-validation.json")},
        {"stage": "historical combined-release CI", "result": "unconfirmed intermittent retained",
         "detail": "The previous release's first fixed-source invitation account-switch timeout remains unexplained despite three isolated passes and a complete frontend rerun.",
         "evidence": artifact(prior_release)}]
    if (OUT / "ci-volume-fixture-failure.json").exists():
        historical[0]["evidence"] = artifact(OUT / "ci-volume-fixture-failure.json")
    historical.append({
        "stage": "first isolated provider HTTP smoke", "result": "failed", "passingChecks": 0,
        "diagnosis": "The unchanged runtime image lacked the smoke harness's test-only pypdf reader; the import failure occurred before HTTP checks. A distinct verified job reproduced the missing module, supplied a size/hash-pinned wheel only to the smoke subprocess, and verified disposable fixture cleanup without changing the image.",
        "originalFailure": artifact(OUT / "stage-provider-proof.json"),
        "originalObservation": artifact(OUT / "stage-provider-smoke-diagnosis.json"),
        "confirmedDiagnosis": artifact(OUT / "stage-provider-verified-dependency-diagnosis.json"),
        "subsequentVerifiedProof": artifact(OUT / "stage-provider-verified-proof.json"),
        "fixtureCleanup": artifact(OUT / "stage-provider-verified-fixture-cleanup.json")})
    if (OUT / "ci-playwright-install-cancelled.json").exists():
        cancelled = load("ci-playwright-install-cancelled.json", "cancelled")
        require(cancelled.get("sourceCommit") == source and cancelled.get("runId") == identity["id"]
                and cancelled.get("runAttempt") == 1, "cancelled_ci_attempt_identity_mismatch")
        historical.insert(1, {
            "stage": "final-source frontend CI first attempt", "result": "cancelled",
            "sourceCommit": source, "runId": cancelled["runId"], "runAttempt": cancelled["runAttempt"],
            "jobId": cancelled["jobId"], "url": cancelled["url"], "step": cancelled["step"],
            "cancelledAtUtc": cancelled["cancelledAtUtc"], "observed": cancelled["observed"],
            "diagnosis": cancelled["diagnosis"], "backendJob": cancelled["backendJob"],
            "sourceChangedForRetry": cancelled["sourceChangedForRetry"],
            "evidence": artifact(OUT / "ci-playwright-install-cancelled.json")})
    attempt_artifacts = [artifact(path) for path in sorted(OUT.glob("*.json"))
                         if any(word in path.name for word in ("diagnosis", "failure", "attempt", "cancelled", "reconciliation"))]

    record = {
        "schemaVersion": 1, "status": "passed", "recordedAtUtc": now.isoformat(), "sourceCommit": source,
        "scope": "Release evidence assembled from completed recorded proofs; no live checks or mutations performed by this finalizer.",
        "sourceCi": source_ci, "imageBuild": images,
        # The promotion proof's noEmailSent flag covers its quiesced phase only.
        # Do not carry it into a release-level claim after scheduling resumes.
        "backend": {key: value for key, value in backend.items() if key != "noEmailSent"},
        "backendFinalVerification": live_backend,
        "frontend": hosting, "cacheVersion": manifest["cacheVersion"],
        "migration": {"head": HEAD, "count": 25, "applied": migration["applied"],
                      "businessDataPreservedDuringMigration": True, "priorMigrationChecksumsPreserved": 24,
                      "existingRoutingAndOutboxPreservedDuringMigration": True, "correctionDefaultsVerified": True,
                      "before": inventory_counts(before), "after": inventory_counts(after),
                      "postResume": inventory_counts(final), "finalInventoryMatchesMigrationResult": final == after,
                      "postResumeChangedBusinessTables": changed_tables,
                      "postResumeAttribution": "No attribution inferred from aggregate hashes. Normal users and the restored scheduled worker may change data after service resumes.",
                      "evidence": [artifact(OUT / name) for name in ("production-proof.json", "post-release-proof.json")]},
        "maintenance": {"confirmedAtUtc": pause["maintenanceConfirmedAtUtc"], "drainSeconds": pause["drainSeconds"],
                        "resumeVerifiedAtUtc": backend["atUtc"],
                        "secondsUntilVerifiedResume": round((timestamp(backend["atUtc"]) - timestamp(pause["maintenanceConfirmedAtUtc"])).total_seconds(), 1)},
        "worker": {"name": JOB, "schedule": schedule["schedule"], "timeZone": schedule["timeZone"],
                   "existingScheduleRestored": True, "existingIamPreserved": True, "image": images["images"]["candidate"],
                   "taskCount": 1, "parallelism": 1, "maxRetries": runtime.get("maxRetries", 0), "batchLimit": 10,
                   "disabledExecutionPerformedNoSmtp": True, "schedulerEnabled": True,
                   "normalScheduledWorkProcessed": processed, "observedAggregateCounts": totals,
                   "observedExecutionCount": len(executions), "executions": executions,
                   "mailboxDeliveryVerified": False, "dedicatedRealSmtpTestPerformed": False,
                   "scope": "Counts describe the recorded normal scheduled executions only. Accepted is SMTP acceptance; failed/uncertain/skipped counts do not establish whether authentication or delivery occurred.",
                   "verification": artifact(OUT / "scheduled-worker-verification.json")},
        "iam": {"existingServiceAndSmtpSecretIamPreserved": True, "existingWorkerAndProjectIamPreserved": True,
                "secretReferencesPreserved": True, "newGrantsByThisRelease": False},
        "rollback": {"compatibleBackendRevision": FALLBACK, "compatibleImage": images["images"]["fallback"],
                     "fallbackVerifiedAtUtc": fallback["atUtc"], "fallbackOverlayFiles": changed,
                     "limitedService": "Report correction saves disabled; schema25, latest corrected reads/exports/evidence, submissions and frozen original outbox retained.",
                     "pauseSchedulerDisableWorkerAndDrainBeforeFallback": True,
                     "original0024OnlyImagesRejectLedger": True,
                     "hosting": {"version": channel_version(retained), "channel": retained["name"].rsplit("/", 1)[-1],
                                 "url": retained["url"], "expiresAtUtc": retained["expireTime"]},
                     "databaseBackup": {key: branch[key] for key in ("id", "name", "parent_id", "created_at", "expires_at")},
                     "backupInventoryMatchesPausedProduction": True,
                     "reverifyAvailabilityBeforeUse": True,
                     "neverDowngradeLedgerResetCredentialsAuthGenerationsClearDeviceStorageOrResetOutboxAttempts": True},
        "validation": {"localBackendSuites": 26, "localRealBackendBrowserWorkflows": 75,
                       "localNativePostgresFullChecks": len(pg[0]["checks"]), "localNativePostgresFinalValidatorChecks": len(pg[1]["checks"]),
                       "providerSmokeChecks": api["passingChecks"], "providerFreshOwnedDatabaseCleanup": api["cleanupComplete"],
                       "providerSmokeEvidence": artifact(OUT / "stage-provider-verified-proof.json"),
                       "fallbackLocalChecks": len(fallback_local["checks"]), "previewAndLiveFileCount": manifest["fileCount"],
                       "previewShellAssets": len(proofs["preview-shell.json"].get("assets", [])),
                       "liveShellAssets": len(proofs["live-shell.json"].get("assets", [])),
                       "previewInstallerArtifacts": len(proofs["preview-installer.json"].get("assets", [])),
                       "liveInstallerArtifacts": len(proofs["live-installer.json"].get("assets", [])),
                       "waitingUpdateChecks": len(waiting["checks"]), "strictHardeningChecks": len(hardening["passingChecks"]),
                       "genericHostedVerifierLocalChecks": proofs["preparation-validation.json"]["generic_hosted_verifier_regressions"],
                       "octoberVerifierLocalChecks": proofs["preparation-validation.json"]["october_runner_local_checkpoints"]},
        "operationalScope": {"productionTestFixturesCreated": False, "existingUserCredentialsReset": False,
                             "deviceStorageCleared": False, "manualRealTestEmailSent": False,
                             "normalScheduledEmailOutcomes": totals, "smtpPasswordPayloadRead": False,
                             "smtpSecretVersion": "reportflow-smtp-password:1", "publicRegistrationEmailEnabled": False,
                             "webServicePdfWorkerEnabled": False, "existingTemplateRoutingChangedByRelease": False},
        "earlierAttempts": historical, "additionalAttemptEvidence": attempt_artifacts,
        "warnings": hardening.get("warnings", []) + ["Existing frontend main-bundle size advisory remains."],
        "limitations": [
            "No authenticated production fixture or physical iOS/Android test was performed for this release.",
            "Hosted browser verification is anonymous shell/install/update/offline verification. Correction and evidence workflows were exercised locally and by isolated provider HTTP staging.",
            "Report corrections require connectivity and have no persistent offline correction draft; invalid or missing original Definition snapshots block saving.",
            "Supervisor cold-offline Template catalogs remain unchanged; an already opened form can queue offline.",
            "Previously queued or emailed PDFs retain their original submission and recipient snapshots. Corrections do not resend them.",
            "Normal scheduled work may send existing pending email. No dedicated real SMTP or mailbox-delivery test was run; accepted/uncertain attempts are never automatically retried.",
            "The historical invitation account-switch CI timeout remains unconfirmed.",
            "Legacy HTML logo packaging remains unchanged; isolated provider smoke supplies the existing repository-logo fixture in its disposable runtime.",
            "Rollback identities and expiry values reflect recorded provider observations and must be reverified before use."],
        "cleanup": cleanup,
    }
    # Hash every journal artifact, including failed attempts, without embedding raw logs.
    paths = [path for path in OUT.rglob("*") if path.is_file() and "__pycache__" not in path.parts
             and path.name != "release.json"]
    paths += [LOCAL / name for name in ("validation.json", "postgres-full.json", "postgres-final-validator.json",
                                      "mobile-gate-results.txt", "backend-gate-results.txt", "local-smoke.json")]
    record["evidenceSha256"] = {path.relative_to(ROOT).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                                 for path in sorted(paths)}
    return record


def main():
    require(sys.argv[1:] == ["--write"], "explicit_write_flag_required")
    require(not (OUT / "release.json").exists(), "release_record_already_exists")
    record = assemble()
    # Exclusive creation avoids overwriting another operator's completed record.
    with (OUT / "release.json").open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(record, indent=2) + "\n")
    print(json.dumps({"status": "passed", "record": "docs/evidence/report-corrections-release-20261023/release.json",
                      "sourceCommit": record["sourceCommit"], "backend": record["backend"]["revision"],
                      "hosting": record["frontend"]["version"],
                      "normalScheduledWorkProcessed": record["worker"]["normalScheduledWorkProcessed"],
                      "observedWorkerCounts": record["worker"]["observedAggregateCounts"]}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Provider-shaped or malformed evidence can contain private data. Only
        # explicit fixed refusal codes are printed, never raw exceptions/bodies.
        code = str(error) if isinstance(error, EvidenceError) else "evidence_schema_or_file_operation_failed"
        print(json.dumps({"status": "refused", "code": code}))
        sys.exit(1)
