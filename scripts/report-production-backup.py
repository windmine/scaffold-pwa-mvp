"""Create one explicitly authorized seven-day backup after verified maintenance drain.

Only creates a new Neon branch/read-only compute; never changes production DB,
traffic, credentials or migrations. Never auto-retries creation or deletes a
branch. Raw Neon output and connection URLs stay captured in process memory.
"""
import argparse
import copy
import importlib.util
import json
from pathlib import Path
import re
import time
from datetime import datetime, timedelta, timezone

SPEC = importlib.util.spec_from_file_location("production_cutover", Path(__file__).with_name("report-production-cutover.py"))
cutover = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cutover)
operator = cutover.operator
NAME = "release-backup-20260929"


def neon(*args, json_output=True):
    return operator.command("npx", ["-y", "neon@2.32.0", *args, "--no-analytics",
                                   *(["-o", "json"] if json_output else [])], json_output=json_output, timeout=120)


def branch_value(value):
    return value.get("branch", value)


def failure_code(error):
    value = str(error)
    return value if isinstance(error, RuntimeError) and re.fullmatch(r"[a-z][a-z0-9_]{1,100}", value) else type(error).__name__


def assert_paused(prepared, baseline, artifact):
    service = operator.cloud("run", "services", "describe", operator.PRODUCTION, "--region", operator.REGION)
    cutover.assert_maintenance_traffic(service)
    operator.require(operator.sha(cutover.configuration_metadata(service)) == prepared.get("serviceMetadataSha256"), "maintenance_metadata_changed")
    iam = operator.cloud("run", "services", "get-iam-policy", operator.PRODUCTION, "--region", operator.REGION)
    operator.require(operator.sha(iam) == prepared["serviceIamSha256"], "maintenance_iam_changed")
    source = copy.deepcopy(service)
    source["spec"]["template"]["metadata"]["name"] = baseline["live"]["revision"]
    runtime = cutover.maintenance_document(baseline, artifact["image"], source)["spec"]["template"]["spec"]
    cutover.exact_revision(cutover.MAINTENANCE_REVISION, runtime, artifact["image"])
    cutover.exact_job(baseline, artifact)
    executions = operator.cloud("run", "jobs", "executions", "list", "--job", cutover.MIGRATION_JOB, "--region", operator.REGION)
    operator.require(not executions, "migration_executed_before_backup")


def assert_pre_migration(value):
    operator.require(value.get("status") == "passed" and value.get("transactionReadOnly") is True
                     and value.get("migrationHead") == "0021_worker_invitations" and value.get("migrationCount") == 21
                     and value.get("ledgerMatchesBundledPrefix") is True
                     and value.get("recoverySchema", {}).get("columnsPresent") == []
                     and value.get("recoverySchema", {}).get("tablePresent") is False, "backup_requires_exact_0021_schema")


def validate_branch(branch, branch_id, requested_at, expires_at, drain_until, *, ready=True):
    operator.require(re.fullmatch(r"br-[a-z0-9-]+", branch_id or "") and branch_id != operator.NEON_PARENT
                     and branch.get("id") == branch_id and branch.get("name") == NAME
                     and branch.get("project_id") == operator.NEON_PROJECT and branch.get("parent_id") == operator.NEON_PARENT
                     and branch.get("default") is False and branch.get("primary") is False,
                     "backup_branch_ownership_mismatch")
    created = cutover.utc(branch["created_at"])
    expiry = cutover.utc(branch["expires_at"])
    operator.require(created >= drain_until and created >= requested_at - timedelta(seconds=5)
                     and created <= datetime.now(timezone.utc) + timedelta(minutes=1)
                     and abs((expiry - expires_at).total_seconds()) <= 5
                     and expiry - created >= timedelta(days=6, hours=23), "backup_branch_time_or_expiry_mismatch")
    operator.require(branch.get("current_state") == "ready" if ready else branch.get("current_state") in {"ready", "init"},
                     "backup_branch_not_ready")


def validate_endpoint(endpoint, branch_id, url, baseline):
    host = operator.validate_url(url)
    operator.require(endpoint.get("project_id") == operator.NEON_PROJECT and endpoint.get("branch_id") == branch_id
                     and endpoint.get("type") == "read_only" and endpoint.get("id")
                     and host == endpoint.get("host", "").replace("-pooler.", ".")
                     and operator.sha(host) != baseline["databaseHostSha256"], "backup_endpoint_not_isolated_read_only")
    return {"id": endpoint["id"], "type": "read_only", "hostSha256": operator.sha(host)}


def run(args):
    operator.require(args.allow_backup_create, "explicit_backup_creation_flag_required")
    operator.require(not args.evidence.exists(), "new_evidence_required")
    baseline = cutover.passed_proof(args.snapshot, "snapshot")
    artifact = operator.candidate(args)
    prepared = cutover.phase_proof(args.prepare_proof, "prepare", artifact, baseline)
    operator.require(all(prepared.get(k) is True for k in ("productionTrafficUnchanged", "migrationJobUnexecuted",
                                                          "maintenanceReady", "productionLedgerUnchanged")), "prepare_did_not_finish")
    pause = cutover.phase_proof(args.pause_proof, "pause", artifact, baseline)
    cutover.validate_pause(pause, prepared)
    evidence = {"schemaVersion": 1, "phase": "production-backup", "status": "started", "runId": cutover.RUN_ID,
                "startedAtUtc": operator.now(), "artifact": artifact, "baselineSha256": operator.sha(baseline),
                "prepareProofSha256": operator.sha(prepared), "pauseProofSha256": operator.sha(pause),
                "databaseHostSha256": baseline["databaseHostSha256"], "attempts": [],
                "backupName": NAME, "productionDatabaseWrites": False, "branchDeletionAttempted": False}
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    with args.evidence.open("x", encoding="utf-8") as file:
        json.dump(evidence, file)
    def save():
        args.evidence.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    try:
        assert_paused(prepared, baseline, artifact)
        url = operator.read_secret("geo-backend-database-url", "2")
        operator.require(operator.sha(operator.validate_url(url)) == baseline["databaseHostSha256"], "production_database_target_changed")
        before = operator.inventory(url)
        assert_pre_migration(before)
        evidence["productionInventory"] = before
        production = branch_value(neon("branch", "get", operator.NEON_PARENT, "--project-id", operator.NEON_PROJECT))
        operator.require(production.get("id") == operator.NEON_PARENT and production.get("project_id") == operator.NEON_PROJECT
                         and production.get("default") is True and production.get("primary") is True
                         and production.get("current_state") == "ready", "production_neon_parent_changed")
        collection = neon("branch", "list", "--project-id", operator.NEON_PROJECT)
        branches = collection.get("branches") if isinstance(collection, dict) else collection
        operator.require(isinstance(branches, list) and all(branch.get("name") != NAME for branch in branches), "backup_name_already_exists")
        # Recheck pause and drained data immediately before the one allowed create.
        assert_paused(prepared, baseline, artifact)
        current = operator.inventory(url)
        assert_pre_migration(current)
        cutover.assert_inventory_equal(before, current)
        requested_at = datetime.now(timezone.utc)
        expires_at = (requested_at + timedelta(days=7)).replace(microsecond=0)
        evidence.update(createAttempted=True, requestedAtUtc=requested_at.isoformat(), requestedExpiresAtUtc=expires_at.isoformat())
        evidence["attempts"].append({"action": "create_new_read_only_backup_branch", "name": NAME,
                                     "parentId": operator.NEON_PARENT, "atUtc": requested_at.isoformat()})
        save()
        result = neon("branch", "create", "--parent", operator.NEON_PARENT, "--name", NAME, "--type", "read_only",
                      "--expires-at", expires_at.strftime("%Y-%m-%dT%H:%M:%SZ"), "--project-id", operator.NEON_PROJECT)
        created = branch_value(result)
        branch_id = created.get("id")
        validate_branch(created, branch_id, requested_at, expires_at, cutover.utc(pause["drainUntilUtc"]), ready=False)
        evidence["createdBranchId"] = branch_id
        save()
        deadline = time.monotonic() + 120
        while True:
            branch = branch_value(neon("branch", "get", branch_id, "--project-id", operator.NEON_PROJECT))
            validate_branch(branch, branch_id, requested_at, expires_at, cutover.utc(pause["drainUntilUtc"]), ready=False)
            if branch["current_state"] == "ready":
                break
            operator.require(time.monotonic() < deadline, "backup_branch_readiness_timeout")
            time.sleep(2)
        endpoints = neon("api", f"/projects/{operator.NEON_PROJECT}/endpoints").get("endpoints", [])
        owned = [endpoint for endpoint in endpoints if endpoint.get("branch_id") == branch_id]
        operator.require(len(owned) == 1, "backup_requires_one_read_only_endpoint")
        raw = neon("connection-string", branch_id, "--project-id", operator.NEON_PROJECT, "--database-name", "neondb",
                   "--role-name", "neondb_owner", "--endpoint-type", "read_only", "--ssl", "require", json_output=False)
        urls = [line.strip() for line in raw.splitlines() if line.strip().startswith("postgresql://")]
        operator.require(len(urls) == 1, "single_backup_connection_required")
        endpoint = validate_endpoint(owned[0], branch_id, urls[0], baseline)
        backup_inventory = operator.inventory(urls[0])
        assert_pre_migration(backup_inventory)
        cutover.assert_inventory_equal(before, backup_inventory)
        # Current-head branch creation time marks the snapshot operation. We do
        # not claim an older parent WAL commit timestamp as the backup time.
        evidence.update(backupBranch={"id": branch_id, "name": NAME, "projectId": operator.NEON_PROJECT,
                        "parentId": operator.NEON_PARENT, "createdAt": branch["created_at"], "expiresAt": branch["expires_at"],
                        "default": False, "primary": False, "endpoint": endpoint},
                        snapshotAtUtc=branch["created_at"], backupInventory=backup_inventory)
        raw, urls = None, None
        assert_paused(prepared, baseline, artifact)
        after = operator.inventory(url)
        assert_pre_migration(after)
        cutover.assert_inventory_equal(before, after)
        evidence.update(status="passed", verifiedAtUtc=operator.now(), currentInventory=after,
                        productionStillInMaintenance=True, productionInventoryUnchanged=True)
        cutover.validate_backup(evidence, pause, artifact, baseline, after)
        evidence["finishedAtUtc"] = operator.now()
        save()
        print(json.dumps({"status": "passed", "phase": "production-backup", "branchId": branch_id,
                          "expiresAt": branch["expires_at"], "evidence": str(args.evidence)}))
        return 0
    except Exception as error:
        code = failure_code(error)
        evidence.update(status="failed", finishedAtUtc=operator.now(), failureCode=code)
        save()
        print(json.dumps({"status": "failed", "phase": "production-backup", "code": code,
                          "evidence": str(args.evidence), "automaticRetryOrDeletion": False}))
        return 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-backup-create", action="store_true")
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--prepare-proof", type=Path, required=True)
    parser.add_argument("--pause-proof", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--image", required=True)
    try:
        raise SystemExit(run(parser.parse_args()))
    except Exception as error:
        print(json.dumps({"status": "refused", "code": failure_code(error)}))
        raise SystemExit(1)
