"""Explicit, phase-gated Report release preparation; no production mutations.

snapshot reads live metadata and a read-only DB inventory. Other phases operate
only on separately owned staging resources. Root/operator owns Neon lifecycle.
No URL/password/token is written, printed or passed in command-line arguments.
Stage environment: REPORT_RELEASE_STAGE_DATABASE_URL and
REPORT_RELEASE_STAGE_METADATA JSON {branch: {...}, endpoint: {...}} from Neon.
This does not authorize a production migration, maintenance or Hosting promotion.

The default required mode retains the September 29 0021-to-0022/backfill gate.
Explicit --migration-mode none requires the full exact candidate ledger, creates
a check-only job, and uses stage-resources -> stage-check -> stage-service with
no stage-migrate phase. Its before/after checks compare all observed inventory
fields except the read timestamp, without assuming untouched auth generations.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from urllib.parse import parse_qs, unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
PROJECT = "geo-attendance-system-db9ca"
REGION = "australia-southeast1"
PRODUCTION = "geo-backend"
NEON_PROJECT = "plain-smoke-06194407"
NEON_PARENT = "br-snowy-tree-a7hfuph6"
RUNTIME = f"geo-backend-runtime@{PROJECT}.iam.gserviceaccount.com"
SECRET_REFS = {"DATABASE_URL": {"key": "2", "name": "geo-backend-database-url"},
               "GEO_SECRET_KEY": {"key": "1", "name": "geo-backend-jwt-secret"}}
SAFE_ENV = {"CORS_ORIGINS", "AUTO_MIGRATE", "SQL_ECHO", "UPLOAD_STORAGE_BACKEND", "UPLOAD_BUCKET",
            "UPLOAD_OBJECT_PREFIX", "ACCESS_TOKEN_EXPIRE_MINUTES", "BUSINESS_TIMEZONE", "MAX_UPLOAD_BYTES",
            "APP_ENV", "ENABLE_DEV_SEED", "WORKER_INVITATION_TTL_HOURS", "WORKER_PASSWORD_RECOVERY_TTL_MINUTES"}
SAFE_ANNOTATIONS = {"run.googleapis.com/ingress", "run.googleapis.com/launch-stage", "run.googleapis.com/maxScale",
                    "run.googleapis.com/minScale", "autoscaling.knative.dev/maxScale", "autoscaling.knative.dev/minScale",
                    "run.googleapis.com/startup-cpu-boost", "run.googleapis.com/cloudsql-instances",
                    "run.googleapis.com/execution-environment", "run.googleapis.com/cpu-throttling"}


def require(value, code):
    if not value:
        raise RuntimeError(code)


def now():
    return datetime.now(timezone.utc).isoformat()


def sha(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def environment():
    return {**{k: v for k, v in os.environ.items() if not k.upper().startswith(("PG", "REPORT_RELEASE_STAGE_"))},
            "DEBUG": "", "CLOUDSDK_CORE_LOG_HTTP": "false"}


def command(executable, args, *, input_text=None, env=None, json_output=True, timeout=600):
    binary = shutil.which(executable)
    require(binary, "command_unavailable")
    result = subprocess.run([binary, *args], input=input_text, capture_output=True, encoding="utf-8",
                            errors="replace", env=env or environment(), timeout=timeout)
    # Never echo stderr/stdout on failure: secret-manager/driver errors can leak.
    require(result.returncode == 0, "external_command_failed")
    return json.loads(result.stdout) if json_output else result.stdout.strip()


def cloud(*args, input_text=None, json_output=True):
    return command("gcloud", [*args, "--project", PROJECT, "--quiet", *(["--format=json"] if json_output else [])],
                   input_text=input_text, json_output=json_output)


def read_secret(name, version):
    require(re.fullmatch(r"[a-z][a-z0-9-]+", name) and re.fullmatch(r"[1-9][0-9]*", version), "invalid_secret_reference")
    return cloud("secrets", "versions", "access", version, "--secret", name, json_output=False)


def validate_url(url):
    value = urlsplit(url.replace("postgresql+psycopg://", "postgresql://", 1))
    require(value.scheme == "postgresql" and value.hostname and value.username and value.password
            and value.port in (None, 5432) and unquote(value.path) == "/neondb" and not value.fragment
            and set(parse_qs(value.query)) <= {"sslmode", "channel_binding"}
            and parse_qs(value.query).get("sslmode", [""])[0] in {"require", "verify-full"}, "invalid_database_target")
    return value.hostname.replace("-pooler.", ".")


def inventory(url):
    validate_url(url)
    result = command(sys.executable, [str(ROOT / "scripts/report-release-inventory.py")],
                     env={**environment(), "REPORT_RELEASE_DATABASE_URL": url}, timeout=90)
    require(result.get("status") == "passed" and result.get("transactionReadOnly") is True
            and result.get("ledgerMatchesBundledPrefix") is True, "inventory_not_verified")
    return result


def safe_spec(spec):
    require(spec.get("serviceAccountName") == RUNTIME and len(spec.get("containers", [])) == 1, "unexpected_runtime")
    result = copy.deepcopy(spec)
    for item in result["containers"][0].get("env", []):
        if "valueFrom" in item:
            require(item["name"] in SECRET_REFS and item["valueFrom"].get("secretKeyRef") == SECRET_REFS[item["name"]],
                    "unexpected_production_secret_binding")
        else:
            require(item["name"] in SAFE_ENV and isinstance(item.get("value"), str), "unrecognized_environment_value")
    env = {item["name"]: item for item in result["containers"][0].get("env", [])}
    require(set(SECRET_REFS) <= set(env) and env.get("AUTO_MIGRATE", {}).get("value") == "false"
            and env.get("UPLOAD_STORAGE_BACKEND", {}).get("value") == "gcs"
            and env.get("UPLOAD_OBJECT_PREFIX", {}).get("value") == "uploads", "unsafe_production_configuration")
    require(len(env) == len(result["containers"][0].get("env", [])), "duplicate_environment_names")
    return result


def annotations(value):
    return {k: v for k, v in value.items() if k in SAFE_ANNOTATIONS}


def live_snapshot():
    service = cloud("run", "services", "describe", PRODUCTION, "--region", REGION)
    traffic = service["status"]["traffic"]
    require(len(traffic) == 1 and traffic[0].get("percent") == 100 and not traffic[0].get("tag"), "unexpected_live_traffic")
    revision = cloud("run", "revisions", "describe", traffic[0]["revisionName"], "--region", REGION)
    require(service["spec"]["template"]["metadata"].get("name") == revision["metadata"]["name"], "live_template_not_serving")
    spec = safe_spec(revision["spec"])
    return {"revision": revision["metadata"]["name"], "image": revision["status"]["imageDigest"],
            "traffic": traffic, "runtimeSpec": spec, "runtimeSha256": sha(spec),
            "serviceAnnotations": annotations(service["metadata"].get("annotations", {})),
            "templateAnnotations": annotations(service["spec"]["template"]["metadata"].get("annotations", {}))}


def same_live(baseline):
    current = live_snapshot()
    require(current == baseline["live"], "production_changed_since_snapshot")
    return current


def read_proof(path, phase):
    data = json.loads(path.read_text(encoding="utf-8"))
    require(data.get("phase") == phase and data.get("status") == "passed" and data.get("schemaVersion") == 1,
            "invalid_prerequisite_proof")
    return data


def names(run_id):
    require(re.fullmatch(r"[a-z0-9][a-z0-9-]{3,25}", run_id), "invalid_run_id")
    return {"service": f"geo-report-stage-{run_id}", "job": f"geo-report-migrate-stage-{run_id}",
            "databaseSecret": f"report-stage-db-{run_id}", "jwtSecret": f"report-stage-jwt-{run_id}",
            "uploadPrefix": f"uploads/release-stage-{run_id}"}


def stage_target(baseline, run_id):
    data = json.loads(os.environ.get("REPORT_RELEASE_STAGE_METADATA", "{}"))
    branch, endpoint = data.get("branch", {}), data.get("endpoint", {})
    require(branch.get("project_id") == NEON_PROJECT and branch.get("parent_id") == NEON_PARENT
            and branch.get("id") != NEON_PARENT and branch.get("default") is False and branch.get("primary") is False
            and branch.get("current_state") == "ready" and run_id in branch.get("name", ""), "stage_branch_not_owned")
    require(endpoint.get("branch_id") == branch.get("id") and endpoint.get("project_id") == NEON_PROJECT
            and endpoint.get("type") == "read_write" and endpoint.get("host"), "stage_endpoint_not_owned")
    require(datetime.fromisoformat(branch["expires_at"].replace("Z", "+00:00")) > datetime.now(timezone.utc), "stage_branch_expired")
    url = os.environ.get("REPORT_RELEASE_STAGE_DATABASE_URL", "")
    host = validate_url(url)
    require(host == endpoint["host"].replace("-pooler.", ".") and sha(host) != baseline["databaseHostSha256"],
            "stage_url_does_not_match_isolated_endpoint")
    return url, {"id": branch["id"], "name": branch["name"], "parentId": branch["parent_id"],
                 "projectId": NEON_PROJECT, "endpointId": endpoint["id"], "hostSha256": sha(host), "expiresAt": branch["expires_at"]}


def candidate(args):
    require(re.fullmatch(r"[0-9a-f]{40}", args.source_commit or ""), "full_source_commit_required")
    require(re.fullmatch(rf"{REGION}-docker\.pkg\.dev/{PROJECT}/cloud-run-source-deploy/[a-z0-9-]+@sha256:[0-9a-f]{{64}}",
                         args.image or ""), "immutable_candidate_image_required")
    head = command("git", ["-C", str(ROOT), "rev-parse", "HEAD"], json_output=False)
    require(head == args.source_commit, "candidate_source_not_checked_out")
    # A dirty operator/evidence file is harmless; candidate backend must be exact.
    dirty = command("git", ["-C", str(ROOT), "status", "--porcelain", "--", "backend", "requirements.txt", "Dockerfile"], json_output=False)
    require(not dirty, "candidate_backend_is_dirty")
    return {"sourceCommit": args.source_commit, "image": args.image}


def staging_spec(baseline, resource_names, image):
    result = copy.deepcopy(baseline["live"]["runtimeSpec"])
    container = result["containers"][0]
    container["image"] = image
    container.pop("name", None)
    for item in container["env"]:
        if item["name"] == "DATABASE_URL":
            item["valueFrom"] = {"secretKeyRef": {"name": resource_names["databaseSecret"], "key": "1"}}
        elif item["name"] == "GEO_SECRET_KEY":
            item["valueFrom"] = {"secretKeyRef": {"name": resource_names["jwtSecret"], "key": "1"}}
        elif item["name"] == "UPLOAD_OBJECT_PREFIX":
            item["value"] = resource_names["uploadPrefix"]
    env = {item["name"]: item for item in container["env"]}
    require(env.get("UPLOAD_OBJECT_PREFIX", {}).get("value") == resource_names["uploadPrefix"]
            and resource_names["uploadPrefix"].startswith("uploads/release-stage-"), "stage_upload_prefix_missing")
    return result


def job_document(baseline, resource_names, image, migration_mode="required"):
    require(migration_mode in {"required", "none"}, "invalid_migration_mode")
    runtime = staging_spec(baseline, resource_names, image)
    container = runtime["containers"][0]
    for field in ("ports", "startupProbe", "livenessProbe"):
        container.pop(field, None)
    container.update(command=["python"], args=["-m", "app.migrations", *(["--check"] if migration_mode == "none" else [])])
    runtime.pop("containerConcurrency", None)
    runtime.update(maxRetries=0, timeoutSeconds="300")
    return {"apiVersion": "run.googleapis.com/v1", "kind": "Job", "metadata": {"name": resource_names["job"]},
            "spec": {"template": {"spec": {"parallelism": 1, "taskCount": 1, "template": {"spec": runtime}}}}}


def service_document(baseline, resource_names, image):
    return {"apiVersion": "serving.knative.dev/v1", "kind": "Service",
            "metadata": {"name": resource_names["service"], "annotations": baseline["live"]["serviceAnnotations"]},
            "spec": {"template": {"metadata": {"annotations": baseline["live"]["templateAnnotations"]},
                                     "spec": staging_spec(baseline, resource_names, image)},
                     "traffic": [{"latestRevision": True, "percent": 100}]}}


def verify_stage_service(stage, baseline, resource_names, image):
    """Ignore only generated container name; never ignore runtime/secret drift."""
    require(stage.get("metadata", {}).get("name") == resource_names["service"], "stage_service_identity_mismatch")
    expected = service_document(baseline, resource_names, image)
    actual_spec = copy.deepcopy(stage["spec"]["template"]["spec"])
    for container in actual_spec.get("containers", []):
        container.pop("name", None)
    require(actual_spec == expected["spec"]["template"]["spec"], "stage_service_configuration_drift")
    require(annotations(stage["metadata"].get("annotations", {})) == expected["metadata"]["annotations"]
            and annotations(stage["spec"]["template"]["metadata"].get("annotations", {}))
            == expected["spec"]["template"]["metadata"]["annotations"], "stage_service_annotation_drift")
    status = stage["status"]
    require(any(c.get("type") == "Ready" and c.get("status") == "True" for c in status.get("conditions", []))
            and status.get("latestReadyRevisionName") == status.get("latestCreatedRevisionName"), "stage_service_not_ready")
    traffic = status.get("traffic", [])
    require(len(traffic) == 1 and traffic[0].get("percent") == 100 and not traffic[0].get("tag")
            and traffic[0].get("revisionName") == status["latestReadyRevisionName"], "stage_traffic_not_exact")
    revision = cloud("run", "revisions", "describe", status["latestReadyRevisionName"], "--region", REGION)
    require(revision.get("status", {}).get("imageDigest") == image, "stage_ready_image_mismatch")


def verify_failed_service_resume(failed, args, baseline, artifact, branch, resource_names, stage):
    require(failed.get("schemaVersion") == 1 and failed.get("phase") == "stage-service"
            and failed.get("status") == "failed" and failed.get("failureCode") == "external_command_failed"
            and failed.get("baselineSha256") == sha(baseline), "invalid_failed_stage_service_proof")
    verify_resources(failed, args, artifact, branch, resource_names)
    actions = [entry.get("action") for entry in failed.get("attempts", [])]
    require(actions == [f"create_service:{resource_names['service']}", f"copy_invoker_policy:{resource_names['service']}"],
            "failed_service_not_at_known_iam_boundary")
    started = datetime.fromisoformat(failed["startedAtUtc"].replace("Z", "+00:00"))
    finished = datetime.fromisoformat(failed["finishedAtUtc"].replace("Z", "+00:00"))
    created = datetime.fromisoformat(stage["metadata"]["creationTimestamp"].replace("Z", "+00:00"))
    require(started <= created <= finished, "existing_stage_service_creation_not_owned")


def copy_stage_invoker_policy(resource_names, attempt):
    """Use member arguments: gcloud set-iam-policy does not read '-' as stdin."""
    source = cloud("run", "services", "get-iam-policy", PRODUCTION, "--region", REGION)
    bindings = [b for b in source.get("bindings", []) if b.get("role") == "roles/run.invoker"]
    require(len(bindings) == 1 and set(bindings[0]) <= {"role", "members"}
            and isinstance(bindings[0].get("members"), list) and bindings[0]["members"], "unsupported_source_invoker_policy")
    expected = set(bindings[0]["members"])
    require(all(isinstance(member, str) and re.fullmatch(r"allUsers|allAuthenticatedUsers|(?:user|group|serviceAccount|domain):[A-Za-z0-9@._+-]+", member)
                for member in expected), "invalid_invoker_member")
    current = cloud("run", "services", "get-iam-policy", resource_names["service"], "--region", REGION)
    existing = set()
    for binding in current.get("bindings", []):
        require(set(binding) <= {"role", "members"} and binding.get("role") == "roles/run.invoker"
                and isinstance(binding.get("members"), list), "unexpected_stage_iam_binding")
        existing.update(binding["members"])
    require(not current.get("auditConfigs") and existing <= expected, "unexpected_stage_iam_permissions")
    for member in sorted(expected - existing):
        attempt(f"grant_invoker_policy:{resource_names['service']}")
        cloud("run", "services", "add-iam-policy-binding", resource_names["service"], "--region", REGION,
              "--member", member, "--role", "roles/run.invoker", "--condition=None")
    final = cloud("run", "services", "get-iam-policy", resource_names["service"], "--region", REGION)
    final_bindings = final.get("bindings", [])
    require(len(final_bindings) == 1 and set(final_bindings[0]) <= {"role", "members"}
            and final_bindings[0].get("role") == "roles/run.invoker"
            and set(final_bindings[0].get("members", [])) == expected and not final.get("auditConfigs"), "stage_iam_not_exact")
    return {"exactInvokerPolicyVerified": True, "invokerMemberCount": len(expected), "invokerMembersSha256": sha(sorted(expected))}


def assert_new_resources(resource_names):
    services = cloud("run", "services", "list", "--region", REGION)
    jobs = cloud("run", "jobs", "list", "--region", REGION)
    existing_secrets = cloud("secrets", "list")
    require(all(item["metadata"]["name"] != resource_names["service"] for item in services), "stage_service_exists")
    require(all(item["metadata"]["name"] != resource_names["job"] for item in jobs), "stage_job_exists")
    require(not {resource_names["databaseSecret"], resource_names["jwtSecret"]}
            & {item["name"].rsplit("/", 1)[-1] for item in existing_secrets}, "stage_secret_exists")


def stage_identity(args, baseline):
    resource_names = names(args.run_id)
    artifact = candidate(args)
    url, branch = stage_target(baseline, args.run_id)
    return resource_names, artifact, url, branch


def verify_resources(proof, args, artifact, branch, resource_names):
    require(proof.get("runId") == args.run_id and proof.get("artifact") == artifact
            and proof.get("branch") == branch and proof.get("resources") == resource_names, "stage_proof_identity_mismatch")
    require(proof_migration_mode(proof) == getattr(args, "migration_mode", "required"), "stage_proof_migration_mode_mismatch")


def proof_migration_mode(proof):
    # Existing September 29 proofs predate this field and remain required-mode
    # proofs. Omission must never authorize the new check-only path.
    mode = proof.get("migrationMode", "required")
    require(mode in {"required", "none"}, "invalid_proof_migration_mode")
    return mode


def candidate_ledger():
    return {path.stem: hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted((ROOT / "backend/migrations/versions").glob("[0-9]*.py"))}


def assert_full_candidate_inventory(value):
    ledger = candidate_ledger()
    require(bool(ledger) and value.get("schemaVersion") == 1 and value.get("status") == "passed"
            and value.get("transactionReadOnly") is True and value.get("ledgerMatchesBundledPrefix") is True
            and value.get("ledgerVersionPrefixMatches") is True and value.get("ledgerChecksumMismatches") == []
            and value.get("migrationChecksums") == ledger and value.get("migrationCount") == len(ledger)
            and value.get("migrationHead") == next(reversed(ledger)), "no_migration_requires_exact_full_candidate_ledger")
    require(all(re.fullmatch(r"[0-9a-f]{64}", value.get(key, ""))
                for key in ("immutableSubmissionsSha256", "accountCredentialsSha256"))
            and all(type(value.get(key)) is int and value[key] >= 0
                    for key in ("submissionCount", "templateCount", "auditCount"))
            and isinstance(value.get("userCounts"), list) and isinstance(value.get("missingSnapshots"), list)
            and bool(value.get("immutableSubmissionColumns")) and isinstance(value.get("recoverySchema"), dict),
            "complete_no_migration_inventory_required")


def assert_no_migration_preserved(before, after):
    assert_full_candidate_inventory(before)
    assert_full_candidate_inventory(after)
    # Compare every observed field, including credentials, evidence, recovery
    # generations/counts and audit counts. Only the read timestamp may differ.
    stable = lambda value: {key: item for key, item in value.items() if key != "recordedAtUtc"}
    require(stable(before) == stable(after), "stage_check_changed_existing_data")


def assert_stage_preserved(before, after, migration_mode):
    if migration_mode == "none":
        assert_no_migration_preserved(before, after)
    else:
        require(migration_mode == "required", "invalid_migration_mode")
        assert_preserved(before, after)


def assert_preserved(before, after):
    require(all(before.get(k) == after.get(k) for k in ("immutableSubmissionsSha256", "accountCredentialsSha256",
            "submissionCount", "templateCount", "userCounts", "auditCount")), "staged_migration_changed_existing_data")
    schema = after["recoverySchema"]
    require(schema.get("columnsPresent") == ["auth_generation", "legacy_auth_allowed", "password_recovery_generation"]
            and schema.get("tablePresent") and schema.get("recoveryRowCount") == 0
            and schema.get("nullSecurityStateCount") == 0
            and schema.get("zeroAuthGenerationCount") == schema.get("zeroRecoveryGenerationCount")
            == schema.get("legacyAllowedCount") == schema.get("accountCount"), "recovery_backfill_not_exact")
    require(after["migrationCount"] == before["migrationCount"] + 1
            and after["migrationHead"] == "0022_worker_password_recovery", "unexpected_stage_migration_result")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("snapshot", "stage-plan", "stage-resources", "stage-migrate", "stage-check", "stage-service"))
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--snapshot", type=Path)
    parser.add_argument("--resources-proof", type=Path)
    parser.add_argument("--migration-proof", type=Path)
    parser.add_argument("--check-proof", type=Path)
    parser.add_argument("--resume-service-proof", type=Path,
                        help="Only resume a failed stage-service at the verified post-create IAM boundary; never recreates it")
    parser.add_argument("--run-id")
    parser.add_argument("--source-commit")
    parser.add_argument("--image")
    parser.add_argument("--allow-stage-mutations", action="store_true")
    parser.add_argument("--migration-mode", choices=("required", "none"), default="required",
                        help="required preserves the September 29 migration/backfill gate; none requires the exact full ledger and a check-only job")
    args = parser.parse_args(argv)
    require(not (args.migration_mode == "none" and args.phase == "stage-migrate"), "no_migration_mode_refuses_stage_migrate")
    require(not (args.migration_mode == "none" and args.migration_proof), "no_migration_mode_refuses_migration_proof")
    require(not args.resume_service_proof or args.phase == "stage-service", "resume_only_for_stage_service")
    require(not args.evidence.exists(), "new_evidence_required")
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    # Reserve one new evidence file before any remote action; update only our own
    # file, preserving attempted resources even on uncertain command outcomes.
    evidence = {"schemaVersion": 1, "phase": args.phase, "migrationMode": args.migration_mode,
                "status": "started", "startedAtUtc": now(), "attempts": []}
    with args.evidence.open("x", encoding="utf-8") as file:
        json.dump(evidence, file)
    def save():
        args.evidence.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    def attempt(label):
        evidence["attempts"].append({"action": label, "atUtc": now()})
        save()
    try:
        if args.phase == "snapshot":
            live = live_snapshot()
            url = read_secret("geo-backend-database-url", "2")
            evidence.update(live=live, databaseHostSha256=sha(validate_url(url)), inventory=inventory(url))
            if args.migration_mode == "none":
                assert_full_candidate_inventory(evidence["inventory"])
            same_live(evidence)
        else:
            require(args.snapshot, "snapshot_required")
            baseline = read_proof(args.snapshot, "snapshot")
            if args.migration_mode == "none":
                assert_full_candidate_inventory(baseline.get("inventory", {}))
            same_live(baseline)
            resource_names, artifact, url, branch = stage_identity(args, baseline)
            evidence.update(runId=args.run_id, resources=resource_names, artifact=artifact, branch=branch,
                            baselineSha256=sha(baseline))
            if args.phase == "stage-plan":
                evidence.update(job=job_document(baseline, resource_names, artifact["image"], args.migration_mode),
                                service=service_document(baseline, resource_names, artifact["image"]))
            else:
                require(args.allow_stage_mutations, "explicit_staging_mutation_flag_required")
                if args.phase == "stage-resources":
                    assert_new_resources(resource_names)
                    evidence["beforeInventory"] = inventory(url)
                    if args.migration_mode == "none":
                        assert_full_candidate_inventory(evidence["beforeInventory"])
                    else:
                        require(evidence["beforeInventory"]["migrationHead"] == "0021_worker_invitations", "stage_not_at_production_baseline")
                    for key, secret_value in (("databaseSecret", url), ("jwtSecret", secrets.token_urlsafe(48))):
                        secret_name = resource_names[key]
                        attempt(f"create_secret:{secret_name}")
                        cloud("secrets", "create", secret_name, "--replication-policy=automatic", "--labels", f"report-release={args.run_id}")
                        attempt(f"add_secret_version:{secret_name}")
                        created = cloud("secrets", "versions", "add", secret_name, "--data-file=-", input_text=secret_value)
                        require(created["name"].endswith("/versions/1"), "unexpected_stage_secret_version")
                        attempt(f"grant_runtime_secret_access:{secret_name}")
                        cloud("secrets", "add-iam-policy-binding", secret_name, "--member", f"serviceAccount:{RUNTIME}",
                              "--role", "roles/secretmanager.secretAccessor")
                    attempt(f"create_job:{resource_names['job']}")
                    cloud("run", "jobs", "replace", "-", "--region", REGION,
                          input_text=json.dumps(job_document(baseline, resource_names, artifact["image"], args.migration_mode)))
                else:
                    require(args.resources_proof, "resources_proof_required")
                    resources = read_proof(args.resources_proof, "stage-resources")
                    verify_resources(resources, args, artifact, branch, resource_names)
                    require(resources.get("baselineSha256") == sha(baseline), "stage_resource_baseline_mismatch")
                    evidence["resourcesProofSha256"] = sha(resources)
                    if args.migration_mode == "none":
                        assert_full_candidate_inventory(resources.get("beforeInventory", {}))
                    current_job = cloud("run", "jobs", "describe", resource_names["job"], "--region", REGION)
                    expected_job = job_document(baseline, resource_names, artifact["image"], args.migration_mode)["spec"]["template"]["spec"]
                    actual = current_job["spec"]["template"]["spec"]
                    require(actual == expected_job, "stage_job_configuration_drift")
                    if args.phase in {"stage-migrate", "stage-check"}:
                        if args.phase == "stage-check" and args.migration_mode == "required":
                            require(args.migration_proof, "migration_proof_required")
                            migrated = read_proof(args.migration_proof, "stage-migrate")
                            verify_resources(migrated, args, artifact, branch, resource_names)
                        if args.migration_mode == "none":
                            assert_no_migration_preserved(resources["beforeInventory"], inventory(url))
                        attempt(f"execute_job:{args.phase}")
                        extra = ["--args=-m,app.migrations,--check"] if args.phase == "stage-check" and args.migration_mode == "required" else []
                        result = cloud("run", "jobs", "execute", resource_names["job"], "--region", REGION, "--wait", *extra)
                        require(any(item.get("type") == "Completed" and item.get("status") == "True"
                                    for item in result.get("status", {}).get("conditions", [])), "stage_execution_not_successful")
                        evidence["execution"] = result["metadata"]["name"]
                        evidence["afterInventory"] = inventory(url)
                        assert_stage_preserved(resources["beforeInventory"], evidence["afterInventory"], args.migration_mode)
                    else:
                        require(args.check_proof, "migration_check_proof_required")
                        checked = read_proof(args.check_proof, "stage-check")
                        verify_resources(checked, args, artifact, branch, resource_names)
                        if args.migration_mode == "none":
                            require(checked.get("resourcesProofSha256") == sha(resources)
                                    and checked.get("baselineSha256") == sha(baseline), "stage_check_prerequisite_mismatch")
                            assert_no_migration_preserved(resources["beforeInventory"], checked.get("afterInventory", {}))
                        evidence["checkProofSha256"] = sha(checked)
                        assert_stage_preserved(resources["beforeInventory"], inventory(url), args.migration_mode)
                        if args.resume_service_proof:
                            failed = json.loads(args.resume_service_proof.read_text(encoding="utf-8"))
                            stage = cloud("run", "services", "describe", resource_names["service"], "--region", REGION)
                            verify_failed_service_resume(failed, args, baseline, artifact, branch, resource_names, stage)
                            evidence["resumedFailedProofSha256"] = sha(failed)
                        else:
                            services = cloud("run", "services", "list", "--region", REGION)
                            require(all(s["metadata"]["name"] != resource_names["service"] for s in services), "stage_service_exists")
                            attempt(f"create_service:{resource_names['service']}")
                            cloud("run", "services", "replace", "-", "--region", REGION,
                                  input_text=json.dumps(service_document(baseline, resource_names, artifact["image"])))
                            stage = cloud("run", "services", "describe", resource_names["service"], "--region", REGION)
                        verify_stage_service(stage, baseline, resource_names, artifact["image"])
                        evidence.update(copy_stage_invoker_policy(resource_names, attempt))
                        stage = cloud("run", "services", "describe", resource_names["service"], "--region", REGION)
                        verify_stage_service(stage, baseline, resource_names, artifact["image"])
                        evidence.update(stageUrl=stage["status"]["url"], stageRevision=stage["status"]["latestReadyRevisionName"])
                        hosting = copy.deepcopy(json.loads((ROOT / "firebase.json").read_text())["hosting"])
                        for rule in hosting["rewrites"]:
                            require(rule.get("run", {}).get("serviceId") == PRODUCTION, "unexpected_hosting_rewrite")
                            rule["run"]["serviceId"] = resource_names["service"]
                        evidence["hostingConfiguration"] = {"hosting": hosting}
            same_live(baseline)
            evidence["productionUnchanged"] = True
        evidence.update(status="passed", finishedAtUtc=now())
        save()
        print(json.dumps({"status": "passed", "phase": args.phase, "evidence": str(args.evidence)}))
        return 0
    except Exception as error:
        evidence.update(status="failed", finishedAtUtc=now(), failureCode=str(error) if isinstance(error, RuntimeError) else type(error).__name__)
        save()
        print(json.dumps({"status": "failed", "phase": args.phase, "code": evidence["failureCode"], "evidence": str(args.evidence)}))
        return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"status": "refused", "code": str(error) if isinstance(error, RuntimeError) else type(error).__name__}))
        raise SystemExit(1)
