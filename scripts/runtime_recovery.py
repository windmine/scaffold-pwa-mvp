"""Version 4 runtime recovery contract. No provider calls or credential fetching.

The CLI validates read-only provider observations or prepares a deterministic payload.
It does not create branches, update/execute jobs, run migrations locally, or delete data.
"""
from __future__ import annotations

import argparse
import base64
import fnmatch
import gzip
import hashlib
import io
import json
import re
import subprocess
import sys
import tarfile
from datetime import datetime, timezone, timedelta
from pathlib import Path

from runtime_recovery_inventory import validate_inventory, validate_preservation, inventory_state_sha256
from runtime_recovery_build import validate_build_context

PREFIX = "RUNTIME_RECOVERY_V1 "
JOB = "geo-recovery-migrate-20260929"
HELPERS = (
    "scripts/verify-neon-recovery.py", "scripts/check-recovery-migration-contract.ps1",
    "scripts/runtime_recovery_inventory.py", "scripts/runtime-recovery-probe.py",
    "scripts/runtime_recovery.py", "scripts/check-runtime-recovery.ps1",
    "scripts/check-production-hardening.ps1",
    "scripts/runtime_recovery_build.py", "scripts/prepare-runtime-recovery.ps1",
)
ENV = {"AUTO_MIGRATE": "false", "REPORT_PDF_EMAIL_WORKER_ENABLED": "false",
       "REGISTRATION_EMAIL_ENABLED": "false", "SMTP_HOST": ""}


def require(value, code):
    if not value:
        raise ValueError(code)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def keys(value, names):
    require(type(value) is dict and set(value) == set(names.split()), "invalid_closed_schema")


def string(value, pattern):
    require(type(value) is str and re.fullmatch(pattern, value) is not None, "invalid_string")


def integer(value, minimum=0):
    require(type(value) is int and value >= minimum, "invalid_integer")


def hash_value(value):
    string(value, r"[0-9a-f]{64}")


def moment(value):
    string(value, r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)")
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def strict_loads(value):
    def unique(pairs):
        result = {}
        for name, item in pairs:
            require(name not in result, "duplicate_json_key")
            result[name] = item
        return result
    return json.loads(value, object_pairs_hook=unique, parse_constant=lambda _: require(False, "nonfinite_json"))


def ledger(value):
    require(type(value) is list and value, "missing_ledger")
    for row in value:
        keys(row, "version checksum")
        string(row["version"], r"\d{4}_[a-z0-9_]+")
        hash_value(row["checksum"])
    versions = [row["version"] for row in value]
    require(versions == sorted(set(versions)), "ledger_not_ordered_unique")


def contract(value):
    keys(value, "ReleasePhase CandidateHead ExpectedRecoveryHead CandidateLedger ExpectedLedger")
    ledger(value["CandidateLedger"])
    ledger(value["ExpectedLedger"])
    candidate, expected = value["CandidateLedger"], value["ExpectedLedger"]
    require(value["CandidateHead"] == candidate[-1]["version"] and
            value["ExpectedRecoveryHead"] == expected[-1]["version"], "ledger_head_mismatch")
    require(value["ReleasePhase"] in ("Current", "PreMigration"), "unknown_phase")
    require(candidate[:len(expected)] == expected, "ledger_not_source_prefix")
    require((candidate == expected) == (value["ReleasePhase"] == "Current"), "phase_ledger_mismatch")


def verification(value, expected):
    keys(value, "status connected transactionReadOnly migrationCount migrationHead migrationVersions migrationChecksums publicTableCount schemaSha256 rowCountSha256 businessDataPresent pythonVersion psycopgVersion")
    require(value["status"] == "passed" and value["connected"] is True and
            value["transactionReadOnly"] is True, "canonical_verification_failed")
    integer(value["migrationCount"], 1)
    integer(value["publicTableCount"], 1)
    require(value["migrationCount"] == len(expected) and value["migrationHead"] == expected[-1]["version"] and
            value["migrationVersions"] == [r["version"] for r in expected] and
            value["migrationChecksums"] == {r["version"]: r["checksum"] for r in expected}, "canonical_ledger_mismatch")
    hash_value(value["schemaSha256"])
    hash_value(value["rowCountSha256"])
    keys(value["businessDataPresent"], "department site user")
    require(all(v is True for v in value["businessDataPresent"].values()), "sentinel_missing")
    string(value["pythonVersion"], r"\d+\.\d+\.\d+")
    string(value["psycopgVersion"], r"\d+\.\d+(?:\.\d+)?")


def source_archive(root, commit):
    """Inspect exact Git archive bytes, not git-show or normalized checkout bytes."""
    string(commit, r"[0-9a-f]{40}")
    head = subprocess.run(["git", "-c", "core.bare=false", "rev-parse", "HEAD"], cwd=root,
                          capture_output=True, check=True, text=True).stdout.strip()
    require(head == commit, "runtime_source_not_current_release_head")
    result = subprocess.run(["git", "-c", "core.bare=false", "archive", "--format=tar", commit],
                            cwd=root, capture_output=True, check=True)
    archive = result.stdout
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as stream:
        files = {item.name: stream.extractfile(item).read() for item in stream.getmembers() if item.isfile()}
    for path in HELPERS:
        require(path in files and (root / path).read_bytes() == files[path], "helper_not_exact_source_archive")
    packages = [{"path": path, "sha256": sha(data)} for path, data in sorted(files.items())
                if path == "requirements.txt" or path.startswith("backend/")]
    for path in [item["path"] for item in packages] + ["Dockerfile", ".dockerignore", ".gcloudignore"]:
        require((root / path).read_bytes() == files[path], "checkout_not_exact_release_package")
    require(packages, "runtime_package_missing")
    return archive, files, packages


def config_check(config):
    keys(config, "mode runId sourceCommit image packageFiles contract productionHostSha256 target expectedBeforeSha256 pauseVerified")
    require(config["mode"] in ("recovery", "backup-inventory", "production-inventory", "production-migrate"), "unsupported_mode")
    string(config["runId"], r"[0-9a-f]{32}")
    string(config["sourceCommit"], r"[0-9a-f]{40}")
    string(config["image"], r"[a-z0-9.-]+-docker\.pkg\.dev/[a-z0-9-]+/[a-z0-9_/-]+@sha256:[0-9a-f]{64}")
    hash_value(config["productionHostSha256"])
    contract(config["contract"])
    require(type(config["packageFiles"]) is list and config["packageFiles"], "package_manifest_missing")
    for item in config["packageFiles"]:
        keys(item, "path sha256")
        string(item["path"], r"(?:requirements\.txt|backend/[a-zA-Z0-9_./-]+)")
        require(".." not in item["path"].split("/"), "unsafe_package_path")
        hash_value(item["sha256"])
    paths = [item["path"] for item in config["packageFiles"]]
    require(paths == sorted(set(paths)), "package_manifest_not_ordered_unique")
    if config["mode"] in ("recovery", "backup-inventory"):
        target = config["target"]
        keys(target, "branch endpoint request")
        branch, endpoint, request = target["branch"], target["endpoint"], target["request"]
        keys(branch, "id project_id parent_id name default primary parent_timestamp created_at expires_at current_state")
        keys(endpoint, "id project_id branch_id type host current_state")
        keys(request, "startedAtUtc restorePointUtc expiresAtUtc")
        string(branch["id"], r"br-[a-z0-9-]+")
        string(branch["parent_id"], r"br-[a-z0-9-]+")
        string(branch["project_id"], r"[a-z0-9-]+")
        string(endpoint["id"], r"ep-[a-z0-9-]+")
        string(endpoint["host"], r"ep-[a-z0-9-]+\.[a-z0-9-]+\.aws\.neon\.tech")
        expected_name = "recovery-proof-" + config["runId"] if config["mode"] == "recovery" else "reportflow-recipdir-backup-20261110"
        require(branch["name"] == expected_name and branch["default"] is False and
                branch["primary"] is False and branch["current_state"] == "ready" and
                branch["id"] != branch["parent_id"] and endpoint["project_id"] == branch["project_id"] and
                endpoint["branch_id"] == branch["id"] and endpoint["type"] == "read_only" and
                endpoint["current_state"] in ("active", "idle") and
                endpoint["host"].split(".")[0] == endpoint["id"] and
                sha(endpoint["host"].encode()) != config["productionHostSha256"], "isolated_endpoint_mismatch")
        for field in ("parent_timestamp", "created_at", "expires_at"):
            if field != "parent_timestamp" or branch[field] is not None or config["mode"] == "recovery":
                moment(branch[field])
        for field, value in request.items():
            if field != "restorePointUtc" or value is not None or config["mode"] == "recovery":
                moment(value)
        if config["mode"] == "recovery":
            require(config["expectedBeforeSha256"] is None and config["pauseVerified"] is False, "unexpected_recovery_mutation_options")
        else:
            require(config["pauseVerified"] is True and config["contract"]["ReleasePhase"] == "PreMigration" and
                    len(config["contract"]["ExpectedLedger"]) == 27, "unsupported_backup_inventory")
            hash_value(config["expectedBeforeSha256"])
    else:
        require(config["target"] is None and config["pauseVerified"] is True, "production_migration_not_gated")
        if config["mode"] == "production-inventory":
            require(config["expectedBeforeSha256"] is None and config["contract"]["ReleasePhase"] == "PreMigration" and
                    len(config["contract"]["ExpectedLedger"]) == 27, "unsupported_production_inventory")
        else:
            hash_value(config["expectedBeforeSha256"])
            require(config["contract"]["ReleasePhase"] == "Current" and
                    len(config["contract"]["CandidateLedger"]) == 28, "unsupported_migration")


def payload(config, files):
    config_check(config)
    bundle = {"config": config, "modules": {
        "canonical_verifier": base64.b64encode(files["scripts/verify-neon-recovery.py"]).decode(),
        "runtime_recovery_inventory": base64.b64encode(files["scripts/runtime_recovery_inventory.py"]).decode(),
        "runtime_probe": base64.b64encode(files["scripts/runtime-recovery-probe.py"]).decode(),
    }}
    compressed = bytearray(gzip.compress(json.dumps(bundle, sort_keys=True, separators=(",", ":")).encode(), compresslevel=9, mtime=0))
    # Python 3.11 delegates mtime=0 to zlib, whose OS header byte differs by OS;
    # later Python fixes it to255. Freeze that non-content byte across operators.
    compressed[9] = 255
    packed = base64.b64encode(compressed).decode()
    loader = ("try:\n"
              " for n in ('canonical_verifier','runtime_recovery_inventory','runtime_probe'):\n"
              "  s=b['modules'][n];m=types.ModuleType(n);sys.modules[n]=m;exec(compile(base64.b64decode(s),n,'exec'),m.__dict__)\n"
              " sys.exit(sys.modules['runtime_probe'].main(b['config']))\n"
              "except Exception:\n"
              " print('RUNTIME_RECOVERY_V1 {\"schemaVersion\":1,\"status\":\"failed\",\"failureCode\":\"runtime_verification_failed\"}',flush=True);sys.exit(1)")
    result = ("import base64,gzip,json,sys,types;"
              "b=json.loads(gzip.decompress(base64.b64decode(" + repr(packed) + ")));exec(" + repr(loader) + ")")
    require(len(result.encode()) <= 32768, "runtime_payload_too_large")
    return result


def expected_env(caller):
    return [{"name": name, "value": value} for name, value in sorted(ENV.items())] + [
        {"name": "DATABASE_URL", "valueFrom": {"secretKeyRef": {"name": caller["databaseSecret"], "key": "2"}}},
        {"name": "GEO_SECRET_KEY", "valueFrom": {"secretKeyRef": {"name": caller["jwtSecret"], "key": "1"}}},
    ]


def runtime_shape(runtime, caller, files, packages, archive_hash):
    keys(runtime, "job execution buildId image sourceCommit sourceArchiveSha256 sourceArchiveObject buildSourceCommit buildArchiveSha256 packageFiles helperHashes config payloadSha256 commandSha256")
    require(runtime["job"] == JOB, "unsupported_runner")
    string(runtime["execution"], re.escape(JOB) + r"-[a-z0-9]+")
    string(runtime["buildId"], r"[0-9a-f-]{36}")
    string(runtime["buildSourceCommit"], r"[0-9a-f]{40}")
    hash_value(runtime["buildArchiveSha256"])
    config_check(runtime["config"])
    for key in ("image", "sourceCommit", "packageFiles"):
        require(runtime[key] == runtime["config"][key], "runtime_config_mismatch")
    require(runtime["packageFiles"] == packages, "runtime_package_not_source_archive")
    require(runtime["sourceArchiveSha256"] == archive_hash, "source_archive_hash_mismatch")
    require(runtime["helperHashes"] == {path: sha(files[path]) for path in HELPERS}, "helper_hash_mismatch")
    keys(runtime["sourceArchiveObject"], "bucket object generation")
    string(runtime["sourceArchiveObject"]["bucket"], r"[a-z0-9._-]+")
    string(runtime["sourceArchiveObject"]["object"], r"[a-zA-Z0-9_./-]+")
    string(runtime["sourceArchiveObject"]["generation"], r"[0-9]+")
    command = ["python", "-c", payload(runtime["config"], files)]
    require(runtime["payloadSha256"] == sha(command[2].encode()) and runtime["commandSha256"] == digest(command), "runtime_command_hash_mismatch")
    return command


def execution_check(raw, runtime, caller, command):
    """Provider document is not accepted as a self-authored successful marker."""
    require(raw.get("apiVersion") == "run.googleapis.com/v1" and raw.get("kind") == "Execution", "unsupported_execution_document")
    meta, spec, status = raw["metadata"], raw["spec"], raw["status"]
    require(meta["name"] == runtime["execution"] and meta["labels"]["run.googleapis.com/job"] == runtime["job"] and
            meta["labels"]["cloud.googleapis.com/location"] == caller["region"], "execution_identity_mismatch")
    integer(spec["taskCount"], 1)
    integer(spec["parallelism"], 1)
    require(spec["taskCount"] == spec["parallelism"] == 1, "execution_task_shape")
    task = spec["template"]["spec"]
    integer(task["maxRetries"])
    require(task["maxRetries"] == 0 and task["serviceAccountName"] == caller["runtimeServiceAccount"], "execution_identity_or_retries")
    require(type(task["containers"]) is list and len(task["containers"]) == 1, "unexpected_containers")
    container = task["containers"][0]
    require(container["image"] == runtime["image"] and container["command"] == command[:1] and
            container["args"] == command[1:], "executed_code_mismatch")
    require(type(container["env"]) is list, "execution_environment_mismatch")
    # Cloud Run elides an explicitly empty literal value. Accept only the exact
    # empty SMTP_HOST object, never an omitted variable, secret ref or extra key.
    actual_env = [{"name": "SMTP_HOST", "value": ""} if item == {"name": "SMTP_HOST"} else item for item in container["env"]]
    require(sorted(actual_env, key=lambda x: x["name"]) ==
            sorted(expected_env(caller), key=lambda x: x["name"]), "execution_environment_mismatch")
    require(not task.get("volumes") and not container.get("volumeMounts"), "unexpected_credential_mount")
    integer(status["succeededCount"], 1)
    require(status["succeededCount"] == 1, "execution_success_count")
    for field in ("failedCount", "cancelledCount", "runningCount", "retriedCount"):
        integer(status.get(field, 0))
        require(status.get(field, 0) == 0, "execution_not_clean_success")
    completed = [c for c in status["conditions"] if c.get("type") == "Completed"]
    require(len(completed) == 1 and completed[0].get("status") == "True", "execution_not_completed")
    require(not any(c.get("status") == "False" for c in status["conditions"]), "execution_failure_condition")
    start, end = moment(status["startTime"]), moment(status["completionTime"])
    require(end >= start, "execution_timestamps")
    return start, end


def log_record(logs, runtime, caller, start, end):
    require(type(logs) is list and len(logs) < 1000, "missing_or_truncated_logs")
    found = []
    for row in logs:
        text = row.get("textPayload", "")
        json_payload = row.get("jsonPayload")
        if isinstance(json_payload, dict) and json_payload.get("kind") == "runtime-recovery-record":
            require(False, "unsupported_log_format")
        if type(text) is not str or not text.startswith(PREFIX):
            continue
        require(row["resource"]["type"] == "cloud_run_job" and
                row["resource"]["labels"]["project_id"] == caller["projectId"] and
                row["resource"]["labels"]["location"] == caller["region"] and
                row["resource"]["labels"]["job_name"] == runtime["job"] and
                row["labels"]["run.googleapis.com/execution_name"] == runtime["execution"] and
                row["logName"] == "projects/" + caller["projectId"] + "/logs/run.googleapis.com%2Fstdout", "log_identity_mismatch")
        require(start <= moment(row["timestamp"]) <= end, "log_outside_execution")
        string(row["insertId"], r"[a-zA-Z0-9_-]+")
        found.append(strict_loads(text[len(PREFIX):]))
    require(len(found) == 1, "missing_or_duplicate_proof_log")
    return found[0]


def record_check(record, runtime):
    keys(record, "schemaVersion kind status runId mode sourceCommit image configSha256 packageSha256 startedAtUtc completedAtUtc verification inventory before after preservation")
    require(type(record["schemaVersion"]) is int and record["schemaVersion"] == 1 and
            record["kind"] == "runtime-recovery-record" and record["status"] == "passed", "unsupported_runtime_record")
    config = runtime["config"]
    for key in ("mode", "runId", "sourceCommit", "image"):
        require(record[key] == config[key], "runtime_record_mismatch")
    require(record["configSha256"] == digest(config) and record["packageSha256"] == digest(config["packageFiles"]), "record_package_mismatch")
    require(moment(record["completedAtUtc"]) >= moment(record["startedAtUtc"]), "record_timestamps")
    expected = config["contract"]["ExpectedLedger"]
    if config["mode"] == "recovery":
        verification(record["verification"], expected)
        validate_inventory(record["inventory"], expected, natural_read_only=True)
        require(record["verification"]["publicTableCount"] == len(record["inventory"]["tables"]), "incomplete_table_inventory")
        require(record["before"] is None and record["after"] is None and record["preservation"] is None, "unexpected_recovery_migration")
    elif config["mode"] in ("production-inventory", "backup-inventory"):
        require(record["verification"] is None and record["before"] is None and record["after"] is None and
                record["preservation"] is None, "inventory_cannot_claim_migration")
        natural = config["mode"] == "backup-inventory"
        validate_inventory(record["inventory"], expected, natural_read_only=natural)
        if natural:
            require(inventory_state_sha256(record["inventory"], expected, True) == config["expectedBeforeSha256"], "backup_inventory_not_paused_production")
    else:
        require(record["verification"] is None and record["inventory"] is None, "unexpected_migration_recovery")
        result = validate_preservation(record["before"], record["after"], config["contract"]["CandidateLedger"])
        keys(record["preservation"], "status beforeSha256 afterSha256 preservedTableCount preservedLedgerRows preservedOutboxRows queueAttemptsUnchanged")
        for field in ("preservedTableCount", "preservedLedgerRows", "preservedOutboxRows"):
            integer(record["preservation"][field])
        require(record["preservation"]["queueAttemptsUnchanged"] is True, "queue_preservation_not_boolean")
        require(record["preservation"] == result and digest(record["before"]) == config["expectedBeforeSha256"], "migration_preservation_mismatch")


def build_check(build, runtime, caller, files, archive_path, root):
    require(build.get("id") == runtime["buildId"] and build.get("projectId") == caller["projectId"] and
            build.get("status") == "SUCCESS", "build_not_bound_success")
    original = subprocess.run(["git", "-c", "core.bare=false", "archive", "--format=tar", runtime["buildSourceCommit"]],
                              cwd=root, capture_output=True, check=True).stdout
    with tarfile.open(fileobj=io.BytesIO(original), mode="r:") as stream:
        original_files = {m.name: stream.extractfile(m).read() for m in stream.getmembers() if m.isfile()}
    paths = [p for p in files if p.startswith("backend/") or p in ("Dockerfile", "requirements.txt", ".dockerignore", ".gcloudignore")]
    require(all(original_files.get(p) == files[p] for p in paths) and
            {p for p in original_files if p.startswith("backend/")} == {p for p in files if p.startswith("backend/")}, "original_build_source_not_release_equivalent")
    blobs = {p: subprocess.run(["git", "-c", "core.bare=false", "show", runtime["buildSourceCommit"] + ":" + p],
                              cwd=root, capture_output=True, check=True).stdout
             for p in (".github/requirements-test.txt", "docs/templates/mutual-source-templates.json")}
    current_blobs = {p: subprocess.run(["git", "-c", "core.bare=false", "show", runtime["sourceCommit"] + ":" + p],
                                      cwd=root, capture_output=True, check=True).stdout for p in blobs}
    require(blobs == current_blobs, "build_auxiliary_source_changed")
    validate_build_context(build, runtime, caller, files, archive_path, git_blob_files=blobs)


def sanitize(value, candidate):
    """Only validated exact public migration tokens are exempt; inventories are hashes."""
    serialized = json.dumps(value, separators=(",", ":"))
    for item in candidate:
        serialized = serialized.replace(json.dumps(item["version"]), '"known_migration_identifier"')
    # Helper file paths are exact closed source keys, never free-text exemptions.
    for path in HELPERS:
        serialized = serialized.replace(json.dumps(path), '"known_source_path"')
    # These complete path tokens were matched to the exact source archive above.
    # No substring or free-text password exception is made.
    for item in value["runtime"]["packageFiles"]:
        serialized = serialized.replace(json.dumps(item["path"]), '"known_package_path"')
    require(re.search(r"postgres(?:ql)?://|connectionuri|password", serialized, re.I) is None, "unsanitized_evidence")


def validate(request, *, now=None):
    keys(request, "repoRoot evidencePath evidenceFile contract caller providers")
    caller = request["caller"]
    keys(caller, "projectId region runtimeServiceAccount databaseSecret jwtSecret minimumHistoryHours maximumAgeDays releasePhase preMigrationHead neonProjectId")
    for field in ("projectId", "region", "databaseSecret", "jwtSecret", "neonProjectId"):
        string(caller[field], r"[a-zA-Z0-9_-]+")
    string(caller["runtimeServiceAccount"], r"[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com")
    require(caller["runtimeServiceAccount"].endswith("@" + caller["projectId"] + ".iam.gserviceaccount.com"), "identity_project_mismatch")
    integer(caller["minimumHistoryHours"], 1)
    integer(caller["maximumAgeDays"], 1)
    root = Path(request["repoRoot"]).resolve()
    file = Path(request["evidenceFile"]).resolve()
    pattern = Path(request["evidencePath"])
    if not pattern.is_absolute():
        pattern = root / pattern
    require(fnmatch.fnmatch(str(file), str(pattern)), "evidence_path_outside_caller_constraint")
    evidence = strict_loads(file.read_text(encoding="utf-8-sig"))
    keys(evidence, "schemaVersion kind provider environment status failureStage releasePhase candidateHead expectedRecoveryHead expectedMigrationHead candidateMigrationLedger expectedRecoveryMigrationLedger startedAtUtc verificationCompletedAtUtc cleanupCompletedAtUtc completedAtUtc requestedRestorePointUtc requestedExpiresAtUtc projectId cloudProjectId region productionBranch proofBranch runtime record migration cleanup")
    require(type(evidence["schemaVersion"]) is int and evidence["schemaVersion"] == 4 and
            evidence["kind"] == "neon-runtime-recovery" and evidence["provider"] == "neon" and
            evidence["environment"] == "production" and evidence["status"] == "passed" and
            evidence["failureStage"] is None, "unsupported_or_failed_evidence")
    bound = request["contract"]
    contract(bound)
    require(evidence["releasePhase"] == caller["releasePhase"] == bound["ReleasePhase"] and
            evidence["candidateHead"] == bound["CandidateHead"] and
            evidence["expectedRecoveryHead"] == evidence["expectedMigrationHead"] == bound["ExpectedRecoveryHead"] and
            evidence["candidateMigrationLedger"] == bound["CandidateLedger"] and
            evidence["expectedRecoveryMigrationLedger"] == bound["ExpectedLedger"], "caller_migration_contract_mismatch")
    if caller["releasePhase"] == "Current":
        require(caller["preMigrationHead"] == "", "current_baseline_override")
    else:
        require(caller["preMigrationHead"] == bound["ExpectedRecoveryHead"], "explicit_baseline_required")
    require(evidence["projectId"] == caller["neonProjectId"] and evidence["cloudProjectId"] == caller["projectId"] and
            evidence["region"] == caller["region"], "caller_context_mismatch")
    p, b = evidence["productionBranch"], evidence["proofBranch"]
    keys(p, "id name historyRetentionSeconds hostSha256")
    keys(b, "id name parentId parentTimestampUtc createdAtUtc expiresAtUtc default primary endpointId endpointType host")
    string(p["id"], r"br-[a-z0-9-]+")
    require(p["name"] == "production" and b["parentId"] == p["id"] and b["id"] != p["id"] and
            b["default"] is False and b["primary"] is False and b["endpointType"] == "read_only", "proof_ownership_invalid")
    integer(p["historyRetentionSeconds"], caller["minimumHistoryHours"] * 3600)
    hash_value(p["hostSha256"])
    times = {key: moment(evidence[key]) for key in ("startedAtUtc", "verificationCompletedAtUtc", "cleanupCompletedAtUtc", "completedAtUtc", "requestedRestorePointUtc", "requestedExpiresAtUtc")}
    started, verified, cleaned, completed, restore, expiry = [times[key] for key in times]
    actual_restore, actual_expiry = moment(b["parentTimestampUtc"]), moment(b["expiresAtUtc"])
    require(started - timedelta(minutes=1) <= moment(b["createdAtUtc"]) <= verified < actual_expiry <= cleaned == completed and
            completed - started <= timedelta(minutes=15) and
            actual_restore < started - timedelta(minutes=1) and restore < started - timedelta(minutes=1) and
            abs((actual_restore - restore).total_seconds()) <= 120 and
            abs((actual_expiry - expiry).total_seconds()) <= 120 and
            expiry > started and actual_expiry - started <= timedelta(minutes=15) and
            started - actual_restore <= timedelta(seconds=p["historyRetentionSeconds"]), "proof_timing_or_cleanup_invalid")
    now = now or datetime.now(timezone.utc)
    require(timedelta(0) <= now - completed <= timedelta(days=caller["maximumAgeDays"]), "proof_age_invalid")
    keys(evidence["cleanup"], "method ownershipVerified branchAbsent endpointAbsent failureStage")
    require(all(evidence["cleanup"][field] is True for field in ("ownershipVerified", "branchAbsent", "endpointAbsent")), "cleanup_not_boolean")
    require(evidence["cleanup"] == {"method": "automatic-expiry", "ownershipVerified": True,
            "branchAbsent": True, "endpointAbsent": True, "failureStage": None}, "cleanup_incomplete")
    runtime = evidence["runtime"]
    archive, files, packages = source_archive(root, runtime["sourceCommit"])
    command = runtime_shape(runtime, caller, files, packages, sha(archive))
    target = runtime["config"]["target"]
    expected_branch = {"id": b["id"], "project_id": caller["neonProjectId"], "parent_id": b["parentId"],
                       "name": b["name"], "default": b["default"], "primary": b["primary"],
                       "parent_timestamp": b["parentTimestampUtc"], "created_at": b["createdAtUtc"],
                       "expires_at": b["expiresAtUtc"], "current_state": "ready"}
    require(runtime["config"]["mode"] == "recovery" and runtime["config"]["contract"] == bound and
            runtime["config"]["productionHostSha256"] == p["hostSha256"] and
            target["branch"] == expected_branch and target["endpoint"]["id"] == b["endpointId"] and
            target["endpoint"]["host"] == b["host"] and target["endpoint"]["type"] == b["endpointType"] and
            target["request"] == {"startedAtUtc": evidence["startedAtUtc"], "restorePointUtc": evidence["requestedRestorePointUtc"], "expiresAtUtc": evidence["requestedExpiresAtUtc"]} and
            b["name"] == "recovery-proof-" + runtime["config"]["runId"], "runtime_target_mismatch")
    # The canonical ledger is independently derived from exact archive bytes.
    archive_ledger = [{"version": Path(item["path"]).stem, "checksum": item["sha256"]} for item in packages
                      if re.fullmatch(r"backend/migrations/versions/\d{4}_[a-z0-9_]+\.py", item["path"])]
    require(archive_ledger == bound["CandidateLedger"], "archive_migration_bytes_mismatch")
    providers = request["providers"]
    keys(providers, "project branches endpoints execution logs build buildArchiveFile migrationExecution migrationLogs")
    project = providers["project"].get("project", providers["project"])
    require(project["id"] == caller["neonProjectId"] and type(project["history_retention_seconds"]) is int and
            project["history_retention_seconds"] == p["historyRetentionSeconds"], "provider_history_mismatch")
    branches = providers["branches"]
    if type(branches) is dict:
        keys(branches, "branches")
        branches = branches["branches"]
    require(type(branches) is list, "invalid_branch_list")
    production = [x for x in branches if x["id"] == p["id"]]
    require(len(production) == 1 and production[0]["name"] == "production" and
            production[0]["default"] is True and production[0]["primary"] is True and
            not any(x["id"] == b["id"] or x["name"] == b["name"] for x in branches), "provider_branch_not_absent")
    endpoints = providers["endpoints"]
    if type(endpoints) is dict:
        keys(endpoints, "endpoints")
        endpoints = endpoints["endpoints"]
    require(type(endpoints) is list and not any(x["id"] == b["endpointId"] or x["branch_id"] == b["id"] or
            x["host"] == b["host"] for x in endpoints), "provider_endpoint_not_absent")
    production_endpoints = [x for x in endpoints if x["branch_id"] == p["id"] and
                            sha(x["host"].encode()) == p["hostSha256"]]
    require(len(production_endpoints) == 1 and production_endpoints[0]["type"] == "read_write", "production_endpoint_identity_changed")
    start, end = execution_check(providers["execution"], runtime, caller, command)
    require(started <= start <= end <= verified, "execution_outside_proof")
    record = log_record(providers["logs"], runtime, caller, start, end)
    require(record == evidence["record"], "logged_record_mismatch")
    record_check(record, runtime)
    require(start <= moment(record["startedAtUtc"]) <= moment(record["completedAtUtc"]) <= end, "record_outside_execution")
    build_check(providers["build"], runtime, caller, files, providers["buildArchiveFile"], root)
    if caller["releasePhase"] == "PreMigration":
        require(evidence["migration"] is None and providers["migrationExecution"] is None and providers["migrationLogs"] is None, "premigration_is_not_current")
    else:
        migration = evidence["migration"]
        require(type(migration) is dict and "record" in migration, "current_migration_proof_required")
        migration_runtime = {k: v for k, v in migration.items() if k != "record"}
        migration_command = runtime_shape(migration_runtime, caller, files, packages, sha(archive))
        require(migration_runtime["sourceCommit"] == runtime["sourceCommit"] and migration_runtime["image"] == runtime["image"] and
                migration_runtime["buildId"] == runtime["buildId"] and migration_runtime["config"]["mode"] == "production-migrate" and
                migration_runtime["config"]["productionHostSha256"] == p["hostSha256"] and
                migration_runtime["config"]["contract"] == bound and migration_runtime["execution"] != runtime["execution"], "migration_not_same_source")
        for field in ("buildSourceCommit", "buildArchiveSha256", "sourceArchiveObject"):
            require(migration_runtime[field] == runtime[field], "migration_build_source_mismatch")
        migration_start, migration_end = execution_check(providers["migrationExecution"], migration_runtime, caller, migration_command)
        require(migration_end < actual_restore and migration_end < restore, "restore_not_after_real_migration_completion")
        migration_record = log_record(providers["migrationLogs"], migration_runtime, caller, migration_start, migration_end)
        require(migration_record == migration["record"], "migration_log_mismatch")
        record_check(migration_record, migration_runtime)
        require(migration_record["before"]["transactionReadOnly"] is False and
                migration_record["after"]["transactionReadOnly"] is False, "migration_not_production_writable")
        require(migration_start <= moment(migration_record["startedAtUtc"]) <= moment(migration_record["completedAtUtc"]) <= migration_end, "migration_record_outside_execution")
    sanitize(evidence, bound["CandidateLedger"])
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("validate", "prepare"))
    parser.add_argument("--request", required=True)
    args = parser.parse_args()
    try:
        request = strict_loads(sys.stdin.read() if args.request == "-" else Path(args.request).read_text(encoding="utf-8-sig"))
        if args.action == "validate":
            validate(request)
            print('{"passed":true}')
        else:
            keys(request, "repoRoot config sourceArchiveObject buildId buildSourceCommit buildArchiveSha256 caller")
            root = Path(request["repoRoot"]).resolve()
            archive, files, packages = source_archive(root, request["config"]["sourceCommit"])
            config = request["config"]
            require(config["packageFiles"] in ([], packages), "package_manifest_mismatch")
            config["packageFiles"] = packages
            command = ["python", "-c", payload(config, files)]
            # Preparation only. Explicitly no provider commands, mutation or execution.
            runtime = {"job": JOB, "execution": JOB + "-prepared", "buildId": request["buildId"], "image": config["image"],
                    "sourceCommit": config["sourceCommit"], "sourceArchiveSha256": sha(archive),
                    "buildSourceCommit": request["buildSourceCommit"], "buildArchiveSha256": request["buildArchiveSha256"],
                    "sourceArchiveObject": request["sourceArchiveObject"], "packageFiles": packages,
                    "helperHashes": {p: sha(files[p]) for p in HELPERS}, "config": config,
                    "payloadSha256": sha(command[2].encode()), "commandSha256": digest(command)}
            runtime_shape(runtime, request["caller"], files, packages, sha(archive))
            for field in ("databaseSecret", "jwtSecret"):
                string(request["caller"][field], r"[a-zA-Z0-9_-]+")
            sanitize({"runtime": runtime}, config["contract"]["CandidateLedger"])
            runtime["execution"] = ""
            print(json.dumps({"command": command[:1], "args": command[1:], "env": expected_env(request["caller"]), "runtime": runtime}))
        return 0
    except Exception:
        print('{"passed":false,"failureCode":"runtime_recovery_contract_rejected"}')
        return 1


if __name__ == "__main__":
    sys.exit(main())
