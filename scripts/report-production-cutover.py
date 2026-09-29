"""Explicitly gated, one-phase-at-a-time production cutover.

``prepare`` creates an unexecuted migration Job and a zero-traffic maintenance
revision. Every later phase requires its predecessor's proof and the explicit
cutover flag; phases never auto-chain. Pause returns a drain deadline rather
than sleeping. Every attempted write is journaled before dispatch.
Proof hashes use release_operator.sha(parsed JSON), not file-byte hashes.
"""
import argparse
import copy
import importlib.util
import json
from pathlib import Path
import re
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

SPEC = importlib.util.spec_from_file_location("release_operator", Path(__file__).with_name("report-release-operator.py"))
operator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(operator)

RUN_ID = "20260929"
MAINTENANCE_REVISION = "geo-backend-maintenance-20260929"
MAINTENANCE_TAG = "maintenance-20260929"
MIGRATION_JOB = "geo-recovery-migrate-20260929"
CANDIDATE_REVISION = "geo-backend-recovery-20260929"
CANDIDATE_TAG = "recovery-20260929"
HOSTING_ORIGIN = f"https://{operator.PROJECT}.web.app"
OUTPUT_ANNOTATIONS = {"serving.knative.dev/creator", "serving.knative.dev/lastModifier",
                      "run.googleapis.com/operation-id", "run.googleapis.com/ingress-status", "run.googleapis.com/urls"}
UX_CHECKS = {
    "hosted_readiness_and_exact_demo_supervisor", "new_nonce_owned_worker_and_template",
    "template_library_search_lifecycle_and_preview", "mixed_photo_selection_lightweight_preview_and_original_draft",
    "compact_review_back_and_explicit_submission_boundary", "structured_review_filters_reload_and_workflow_shortcuts",
    "private_recovery_replace_revoke_and_expiry", "cookie_free_reset_preserves_supervisor_and_worker_draft",
    "phone_layout_and_clean_browser_errors",
}


def passed_proof(path, phase=None):
    if phase:
        return operator.read_proof(path, phase)
    value = json.loads(path.read_text(encoding="utf-8"))
    operator.require(value.get("schemaVersion") == 1 and value.get("status") == "passed", "invalid_prerequisite_proof")
    return value


def validate_prerequisites(baseline, checked, service, ux, provider, validation, artifact):
    operator.require(baseline.get("inventory", {}).get("migrationHead") == "0021_worker_invitations"
                     and baseline["inventory"].get("migrationCount") == 21, "unexpected_production_baseline_ledger")
    for proof in (checked, service):
        operator.require(proof.get("artifact") == artifact and proof.get("runId") == RUN_ID
                         and proof.get("baselineSha256") == operator.sha(baseline)
                         and proof.get("productionUnchanged") is True
                         and proof.get("resources") == operator.names(RUN_ID), "staging_proof_identity_mismatch")
    branch = checked.get("branch", {})
    operator.require(re.fullmatch(r"br-[a-z0-9-]+", branch.get("id", ""))
                     and branch.get("projectId") == operator.NEON_PROJECT and branch.get("parentId") == operator.NEON_PARENT
                     and branch.get("id") != operator.NEON_PARENT and branch.get("hostSha256")
                     and branch["hostSha256"] != baseline.get("databaseHostSha256")
                     and service.get("branch") == branch, "stage_branch_identity_mismatch")
    operator.require(checked.get("afterInventory", {}).get("migrationHead") == "0022_worker_password_recovery"
                     and checked["afterInventory"].get("migrationCount") == 22
                     and checked["afterInventory"].get("ledgerMatchesBundledPrefix") is True,
                     "staged_migration_not_verified")
    operator.require(provider.get("artifact") == artifact and provider.get("runId") == RUN_ID
                     and provider.get("baselineSha256") == operator.sha(baseline)
                     and provider.get("branch") == branch and provider.get("smokeExitCode") == 0
                     and isinstance(provider.get("checks"), list) and len(provider["checks"]) >= 214
                     and all(isinstance(value, str) and value for value in provider["checks"])
                     and all(provider.get(key) is True for key in ("cleanupComplete", "localFixtureCleanupComplete", "productionUnchanged")),
                     "provider_smoke_not_verified")
    checks = ux.get("checks", [])
    operator.require(isinstance(checks, list) and {value.get("name") for value in checks} == UX_CHECKS
                     and len(checks) == len(UX_CHECKS) and all(value.get("status") == "passed" for value in checks)
                     and ux.get("browserPageErrors") == 0 and RUN_ID in ux.get("runId", ""), "stage_ux_not_verified")
    cleanup = ux.get("cleanup", {})
    operator.require(cleanup.get("failures") == [] and all(cleanup.get(key) is True for key in
                     ("reportTrashed", "templateArchived", "workerResigned")), "stage_ux_cleanup_incomplete")
    origin = validation.get("origin", "")
    operator.require(re.fullmatch(rf"https://{operator.PROJECT}--[a-z0-9-]+\.web\.app", origin)
                     and ux.get("origin") == origin and validation.get("artifact") == artifact
                     and validation.get("baselineSha256") == operator.sha(baseline)
                     and validation.get("stageServiceProofSha256") == operator.sha(service)
                     and validation.get("stageUxProofSha256") == operator.sha(ux)
                     and validation.get("stageServiceName") == operator.names(RUN_ID)["service"]
                     and re.fullmatch(r"[0-9a-f]{16}", validation.get("hostingVersion", "")),
                     "stage_validation_binding_mismatch")


def retained_annotations(metadata):
    return {key: value for key, value in metadata.get("annotations", {}).items() if key not in OUTPUT_ANNOTATIONS}


def configuration_metadata(service):
    template = service["spec"]["template"]["metadata"]
    return {"serviceAnnotations": retained_annotations(service["metadata"]), "serviceLabels": service["metadata"].get("labels", {}),
            "templateAnnotations": template.get("annotations", {}), "templateLabels": template.get("labels", {})}


def candidate_runtime(baseline, image):
    runtime = operator.safe_spec(baseline["live"]["runtimeSpec"])
    runtime["containers"][0]["image"] = image
    return runtime


def migration_job_document(baseline, image):
    runtime = candidate_runtime(baseline, image)
    container = runtime["containers"][0]
    for field in ("ports", "startupProbe", "livenessProbe", "readinessProbe"):
        container.pop(field, None)
    container.update(command=["python"], args=["-m", "app.migrations"])
    runtime.pop("containerConcurrency", None)
    runtime.update(maxRetries=0, timeoutSeconds="300")
    network_annotations = {key: value for key, value in baseline["live"]["templateAnnotations"].items()
                           if key in {"run.googleapis.com/cloudsql-instances", "run.googleapis.com/vpc-access-connector",
                                      "run.googleapis.com/vpc-access-egress", "run.googleapis.com/network-interfaces",
                                      "run.googleapis.com/encryption-key"}}
    return {"apiVersion": "run.googleapis.com/v1", "kind": "Job", "metadata": {"name": MIGRATION_JOB},
            "spec": {"template": {"metadata": {"annotations": network_annotations},
                                  "spec": {"parallelism": 1, "taskCount": 1, "template": {"spec": runtime}}}}}


def maintenance_document(baseline, image, current_service):
    operator.require(current_service["metadata"]["name"] == operator.PRODUCTION
                     and current_service["spec"]["template"]["metadata"].get("name") == baseline["live"]["revision"],
                     "live_service_identity_changed")
    runtime = candidate_runtime(baseline, image)
    container = runtime["containers"][0]
    ports = container.get("ports", [])
    operator.require(len(ports) == 1 and isinstance(ports[0].get("containerPort"), int), "unexpected_service_port")
    container.update(command=["python", "-m", "uvicorn"],
                     args=["app.maintenance:app", "--host", "0.0.0.0", "--port", str(ports[0]["containerPort"])])
    metadata = {key: copy.deepcopy(value) for key, value in current_service["metadata"].items()
                if key in {"name", "namespace", "resourceVersion", "labels"}}
    metadata["annotations"] = retained_annotations(current_service["metadata"])
    template_metadata = {key: copy.deepcopy(value) for key, value in current_service["spec"]["template"]["metadata"].items()
                         if key in {"labels", "annotations"}}
    template_metadata["name"] = MAINTENANCE_REVISION
    return {"apiVersion": "serving.knative.dev/v1", "kind": "Service", "metadata": metadata,
            "spec": {"template": {"metadata": template_metadata, "spec": runtime},
                     "traffic": [{"revisionName": baseline["live"]["revision"], "percent": 100},
                                 {"revisionName": MAINTENANCE_REVISION, "percent": 0, "tag": MAINTENANCE_TAG}]}}


def assert_new_resources():
    revisions = operator.cloud("run", "revisions", "list", "--service", operator.PRODUCTION, "--region", operator.REGION)
    jobs = operator.cloud("run", "jobs", "list", "--region", operator.REGION)
    operator.require(all(row["metadata"]["name"] != MAINTENANCE_REVISION for row in revisions), "maintenance_revision_already_exists")
    operator.require(all(row["metadata"]["name"] != MIGRATION_JOB for row in jobs), "production_migration_job_already_exists")


def assert_prepared(baseline, artifact, service_doc, job_doc, service, revision, job, iam_before, iam_after, executions):
    traffic = {(row.get("revisionName"), row.get("percent", 0), row.get("tag", "")) for row in service["status"].get("traffic", [])}
    operator.require(traffic == {(baseline["live"]["revision"], 100, ""), (MAINTENANCE_REVISION, 0, MAINTENANCE_TAG)}
                     and len(service["status"]["traffic"]) == 2, "production_traffic_changed")
    operator.require(service["spec"]["template"]["metadata"].get("name") == MAINTENANCE_REVISION
                     and revision["metadata"]["name"] == MAINTENANCE_REVISION
                     and revision["status"].get("imageDigest") == artifact["image"]
                     and any(row.get("type") == "Ready" and row.get("status") == "True" for row in revision["status"].get("conditions", []))
                     and operator.safe_spec(revision["spec"]) == service_doc["spec"]["template"]["spec"], "maintenance_revision_not_exact")
    operator.require(retained_annotations(service["metadata"]) == service_doc["metadata"]["annotations"]
                     and service["spec"]["template"]["metadata"].get("annotations", {}) == service_doc["spec"]["template"]["metadata"].get("annotations", {})
                     and service["metadata"].get("labels", {}) == service_doc["metadata"].get("labels", {}), "service_metadata_changed")
    operator.require(iam_after == iam_before, "service_iam_changed")
    operator.require(job["metadata"]["name"] == MIGRATION_JOB
                     and job["spec"]["template"]["spec"] == job_doc["spec"]["template"]["spec"]
                     and not executions and not job.get("status", {}).get("executionCount", 0), "migration_job_not_unexecuted")


def run_prepare(args):
    operator.require(args.phase == "prepare" and args.allow_production_cutover, "explicit_prepare_authorization_required")
    operator.require(not args.evidence.exists(), "new_evidence_required")
    evidence = {"schemaVersion": 1, "phase": "prepare", "status": "started", "startedAtUtc": operator.now(),
                "runId": RUN_ID, "attempts": [], "maintenancePaused": False, "migrationExecuted": False,
                "resources": {"service": operator.PRODUCTION, "maintenanceRevision": MAINTENANCE_REVISION,
                              "maintenanceTag": MAINTENANCE_TAG, "migrationJob": MIGRATION_JOB}}
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    with args.evidence.open("x", encoding="utf-8") as file:
        json.dump(evidence, file)

    def save():
        args.evidence.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")

    def attempt(action):
        evidence["attempts"].append({"action": action, "atUtc": operator.now()})
        save()

    try:
        operator.require(all(getattr(args, key, None) for key in ("stage_check_proof", "stage_service_proof", "stage_ux_proof",
                         "provider_smoke_proof", "stage_validation_proof")), "staging_prerequisite_proofs_required")
        baseline = passed_proof(args.snapshot, "snapshot")
        checked = passed_proof(args.stage_check_proof, "stage-check")
        stage_service = passed_proof(args.stage_service_proof, "stage-service")
        ux = passed_proof(args.stage_ux_proof)
        provider = passed_proof(args.provider_smoke_proof)
        validation = passed_proof(args.stage_validation_proof)
        artifact = operator.candidate(args)
        validate_prerequisites(baseline, checked, stage_service, ux, provider, validation, artifact)
        evidence.update(artifact=artifact, baselineSha256=operator.sha(baseline), prerequisiteSha256={
            "stageCheck": operator.sha(checked), "stageService": operator.sha(stage_service), "stageUx": operator.sha(ux),
            "providerSmoke": operator.sha(provider), "stageValidation": operator.sha(validation)})
        operator.same_live(baseline)
        assert_new_resources()
        service = operator.cloud("run", "services", "describe", operator.PRODUCTION, "--region", operator.REGION)
        iam = operator.cloud("run", "services", "get-iam-policy", operator.PRODUCTION, "--region", operator.REGION)
        url = operator.read_secret("geo-backend-database-url", "2")
        operator.require(operator.sha(operator.validate_url(url)) == baseline["databaseHostSha256"], "production_database_target_changed")
        before = operator.inventory(url)
        operator.require(before["migrationHead"] == "0021_worker_invitations" and before["migrationCount"] == 21,
                         "production_already_migrated_or_changed")
        service_doc = maintenance_document(baseline, artifact["image"], service)
        job_doc = migration_job_document(baseline, artifact["image"])
        evidence.update(beforeInventory=before, serviceDocumentSha256=operator.sha(service_doc),
                        serviceMetadataSha256=operator.sha(configuration_metadata(service_doc)),
                        jobDocumentSha256=operator.sha(job_doc), serviceIamSha256=operator.sha(iam))
        save()
        operator.same_live(baseline)
        # Recheck exact names immediately before create/replace; never reuse or
        # silently repair a resource left by an earlier uncertain attempt.
        assert_new_resources()
        attempt("create_unexecuted_job:" + MIGRATION_JOB)
        operator.cloud("run", "jobs", "replace", "-", "--region", operator.REGION, input_text=json.dumps(job_doc))
        operator.same_live(baseline)
        attempt("create_zero_traffic_maintenance_revision:" + MAINTENANCE_REVISION)
        operator.cloud("run", "services", "replace", "-", "--region", operator.REGION, input_text=json.dumps(service_doc))
        after_service = operator.cloud("run", "services", "describe", operator.PRODUCTION, "--region", operator.REGION)
        revision = operator.cloud("run", "revisions", "describe", MAINTENANCE_REVISION, "--region", operator.REGION)
        job = operator.cloud("run", "jobs", "describe", MIGRATION_JOB, "--region", operator.REGION)
        executions = operator.cloud("run", "jobs", "executions", "list", "--job", MIGRATION_JOB, "--region", operator.REGION)
        after_iam = operator.cloud("run", "services", "get-iam-policy", operator.PRODUCTION, "--region", operator.REGION)
        assert_prepared(baseline, artifact, service_doc, job_doc, after_service, revision, job, iam, after_iam, executions)
        old_revision = operator.cloud("run", "revisions", "describe", baseline["live"]["revision"], "--region", operator.REGION)
        operator.require(operator.safe_spec(old_revision["spec"]) == baseline["live"]["runtimeSpec"], "serving_revision_changed")
        after = operator.inventory(url)
        operator.require(after["migrationChecksums"] == before["migrationChecksums"] and after["migrationCount"] == 21,
                         "production_ledger_changed_during_prepare")
        evidence.update(status="passed", finishedAtUtc=operator.now(), afterInventory=after,
                        productionTrafficUnchanged=True, serviceIamUnchanged=True, migrationJobUnexecuted=True,
                        productionLedgerUnchanged=True, maintenanceReady=True, servingRevision=baseline["live"]["revision"])
        save()
        print(json.dumps({"status": "passed", "phase": "prepare", "maintenancePaused": False,
                          "migrationExecuted": False, "evidence": str(args.evidence)}))
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r"[a-z_]+", str(error)) else type(error).__name__
        evidence.update(status="failed", failureCode=code, finishedAtUtc=operator.now())
        save()
        print(json.dumps({"status": "failed", "phase": "prepare", "code": code, "evidence": str(args.evidence)}))
        return 1


def utc(value):
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    operator.require(result.tzinfo is not None, "timezone_required")
    return result.astimezone(timezone.utc)


def phase_proof(path, phase, artifact, baseline):
    operator.require(path, "phase_prerequisite_proof_required")
    proof = passed_proof(path, phase)
    operator.require(proof.get("artifact") == artifact and proof.get("baselineSha256") == operator.sha(baseline)
                     and proof.get("runId") == RUN_ID, "phase_proof_identity_mismatch")
    return proof


def validate_pause(pause, prepared, at=None):
    at = at or datetime.now(timezone.utc)
    operator.require(pause.get("maintenancePaused") is True and pause.get("prepareProofSha256") == operator.sha(prepared)
                     and pause.get("drainSeconds", 0) >= 300
                     and utc(pause["drainUntilUtc"]) >= utc(pause["maintenanceConfirmedAtUtc"]) + timedelta(seconds=300),
                     "pause_proof_not_verified")
    operator.require(at >= utc(pause["drainUntilUtc"]), "drain_deadline_not_reached")


def assert_traffic(service, revision, tag=None):
    rows = service.get("status", {}).get("traffic", [])
    operator.require(rows and sum(row.get("percent", 0) for row in rows) == 100
                     and all(row.get("revisionName") == revision for row in rows)
                     and all(row.get("tag", "") in ("", tag or "") for row in rows)
                     and (sum(row.get("tag") == tag for row in rows) == 1 if tag else not any(row.get("tag") for row in rows)),
                     "unexpected_phase_traffic")


def assert_maintenance_traffic(service):
    assert_traffic(service, MAINTENANCE_REVISION)


def exact_revision(name, expected_runtime, image):
    revision = operator.cloud("run", "revisions", "describe", name, "--region", operator.REGION)
    operator.require(revision["metadata"]["name"] == name and operator.safe_spec(revision["spec"]) == expected_runtime
                     and revision["status"].get("imageDigest") == image
                     and any(row.get("type") == "Ready" and row.get("status") == "True" for row in revision["status"].get("conditions", [])),
                     "phase_revision_not_exact_or_ready")
    return revision


def exact_job(baseline, artifact):
    job = operator.cloud("run", "jobs", "describe", MIGRATION_JOB, "--region", operator.REGION)
    expected = migration_job_document(baseline, artifact["image"])
    operator.require(job["metadata"]["name"] == MIGRATION_JOB
                     and job["spec"]["template"]["spec"] == expected["spec"]["template"]["spec"], "production_job_configuration_drift")
    return job


def assert_inventory_equal(before, after):
    keys = ("migrationChecksums", "migrationCount", "migrationHead", "immutableSubmissionsSha256",
            "accountCredentialsSha256", "submissionCount", "templateCount", "userCounts", "auditCount")
    operator.require(all(key in before and before[key] == after.get(key) for key in keys), "drained_inventory_changed")


def validate_backup(proof, pause, artifact, baseline, current, at=None):
    at = at or datetime.now(timezone.utc)
    branch = proof.get("backupBranch", {})
    operator.require(proof.get("schemaVersion") == 1 and proof.get("phase") == "production-backup"
                     and proof.get("status") == "passed" and proof.get("artifact") == artifact
                     and proof.get("baselineSha256") == operator.sha(baseline)
                     and proof.get("pauseProofSha256") == operator.sha(pause)
                     and proof.get("databaseHostSha256") == baseline["databaseHostSha256"], "backup_proof_identity_mismatch")
    operator.require(re.fullmatch(r"br-[a-z0-9-]+", branch.get("id", "")) and branch.get("id") != operator.NEON_PARENT
                     and branch.get("parentId") == operator.NEON_PARENT and branch.get("projectId") == operator.NEON_PROJECT
                     and RUN_ID in branch.get("name", "") and utc(branch.get("expiresAt", "")) > at
                     and utc(proof.get("snapshotAtUtc", "")) >= utc(pause["drainUntilUtc"])
                     and utc(proof.get("verifiedAtUtc", "")) >= utc(proof["snapshotAtUtc"])
                     and utc(proof["verifiedAtUtc"]) <= at, "backup_not_current_after_drain")
    for inventory in (proof.get("productionInventory", {}), proof.get("backupInventory", {}), current):
        operator.require(inventory.get("status") == "passed" and inventory.get("transactionReadOnly") is True
                         and inventory.get("migrationCount") == 21 and inventory.get("migrationHead") == "0021_worker_invitations"
                         and inventory.get("ledgerMatchesBundledPrefix") is True, "backup_inventory_not_verified")
    assert_inventory_equal(proof["productionInventory"], proof["backupInventory"])
    assert_inventory_equal(proof["productionInventory"], current)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http_probe(origin, path):
    target = urlsplit(origin)
    operator.require(target.scheme == "https" and target.netloc == target.hostname and not target.path
                     and not target.query and not target.fragment
                     and (origin == HOSTING_ORIGIN or (target.hostname.startswith(("geo-backend-", CANDIDATE_TAG + "---geo-backend-"))
                                                        and target.hostname.endswith(".run.app"))),
                     "unapproved_probe_origin")
    operator.require(path == "/health/ready" or path == "/api/health/ready", "unapproved_probe_path")
    request = Request(origin + path, headers={"Cache-Control": "no-cache"}, method="GET")
    try:
        response = build_opener(NoRedirect()).open(request, timeout=5)
    except HTTPError as error:
        response = error
    with response:
        body = response.read(65537)
        operator.require(len(body) <= 65536, "probe_body_too_large")
        return response.status, dict(response.headers), json.loads(body)


def maintenance_probes(service):
    for origin, path in ((service["status"]["url"], "/health/ready"), (HOSTING_ORIGIN, "/api/health/ready")):
        status, headers, body = http_probe(origin, path)
        headers = {key.lower(): value for key, value in headers.items()}
        operator.require(status == 503 and headers.get("retry-after") == "60" and headers.get("cache-control") == "no-store"
                         and body.get("detail") == "Service update in progress. Please keep your draft and try again shortly.",
                         "maintenance_probe_not_confirmed")
    return {"direct": True, "hosting": True, "status": 503, "retryAfterSeconds": 60, "noStore": True}


def readiness_probes(origin, path="/health/ready"):
    # Five bounded requests, no sleeps or unbounded polling; max network wait25s.
    for _ in range(5):
        status, _headers, body = http_probe(origin, path)
        operator.require(status == 200 and body.get("status") == "ok"
                         and all(body.get("checks", {}).get(key) == "ok" for key in ("database", "migrations", "upload_storage")),
                         "candidate_readiness_not_ready")
    return {"consecutivePassed": 5, "database": True, "migrations": True, "uploadStorage": True}


def candidate_document(baseline, artifact, service):
    metadata = {key: copy.deepcopy(value) for key, value in service["metadata"].items()
                if key in {"name", "namespace", "resourceVersion", "labels"}}
    metadata["annotations"] = retained_annotations(service["metadata"])
    template_metadata = {key: copy.deepcopy(value) for key, value in service["spec"]["template"]["metadata"].items()
                         if key in {"labels", "annotations"}}
    template_metadata["name"] = CANDIDATE_REVISION
    return {"apiVersion": "serving.knative.dev/v1", "kind": "Service", "metadata": metadata,
            "spec": {"template": {"metadata": template_metadata, "spec": candidate_runtime(baseline, artifact["image"])},
                     "traffic": [{"revisionName": MAINTENANCE_REVISION, "percent": 100},
                                 {"revisionName": CANDIDATE_REVISION, "percent": 0, "tag": CANDIDATE_TAG}]}}


def candidate_tag_url(service):
    rows = service.get("status", {}).get("traffic", [])
    operator.require(len(rows) == 2 and {(row.get("revisionName"), row.get("percent", 0), row.get("tag", "")) for row in rows}
                     == {(MAINTENANCE_REVISION, 100, ""), (CANDIDATE_REVISION, 0, CANDIDATE_TAG)}, "candidate_received_early_traffic")
    return next(row["url"] for row in rows if row.get("tag") == CANDIDATE_TAG)


def run_phase(args):
    operator.require(args.phase in {"pause", "migrate", "check", "candidate", "resume"} and args.allow_production_cutover,
                     "explicit_phase_authorization_required")
    operator.require(not args.evidence.exists(), "new_evidence_required")
    evidence = {"schemaVersion": 1, "phase": args.phase, "runId": RUN_ID, "status": "started",
                "startedAtUtc": operator.now(), "attempts": []}
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    with args.evidence.open("x", encoding="utf-8") as file:
        json.dump(evidence, file)

    def save():
        args.evidence.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")

    def attempt(action):
        evidence["attempts"].append({"action": action, "atUtc": operator.now()})
        save()

    def service_now():
        return operator.cloud("run", "services", "describe", operator.PRODUCTION, "--region", operator.REGION)

    try:
        baseline = passed_proof(args.snapshot, "snapshot")
        artifact = operator.candidate(args)
        prepared = phase_proof(args.prepare_proof, "prepare", artifact, baseline)
        operator.require(prepared.get("productionTrafficUnchanged") is True and prepared.get("migrationJobUnexecuted") is True
                         and prepared.get("maintenanceReady") is True and prepared.get("productionLedgerUnchanged") is True,
                         "prepare_did_not_finish")
        evidence.update(artifact=artifact, baselineSha256=operator.sha(baseline), prepareProofSha256=operator.sha(prepared))
        service = service_now()
        operator.require(operator.sha(configuration_metadata(service)) == prepared.get("serviceMetadataSha256"), "service_metadata_changed")
        iam = operator.cloud("run", "services", "get-iam-policy", operator.PRODUCTION, "--region", operator.REGION)
        operator.require(operator.sha(iam) == prepared["serviceIamSha256"], "service_iam_changed")
        # Build the exact maintenance runtime without assuming it is the latest
        # template after the separate candidate phase.
        baseline_service = copy.deepcopy(service)
        baseline_service["spec"]["template"]["metadata"]["name"] = baseline["live"]["revision"]
        maintenance_runtime = maintenance_document(baseline, artifact["image"], baseline_service)["spec"]["template"]["spec"]
        exact_revision(MAINTENANCE_REVISION, maintenance_runtime, artifact["image"])
        exact_job(baseline, artifact)
        if args.phase == "pause":
            rows = service["status"].get("traffic", [])
            operator.require(len(rows) == 2 and {(row.get("revisionName"), row.get("percent", 0), row.get("tag", "")) for row in rows}
                             == {(baseline["live"]["revision"], 100, ""), (MAINTENANCE_REVISION, 0, MAINTENANCE_TAG)},
                             "prepare_traffic_no_longer_current")
            attempt("route_maintenance_100_and_clear_tags")
            operator.cloud("run", "services", "update-traffic", operator.PRODUCTION, "--region", operator.REGION,
                           "--to-revisions", MAINTENANCE_REVISION + "=100", "--clear-tags")
            service = service_now()
            assert_maintenance_traffic(service)
            evidence["maintenanceProbes"] = maintenance_probes(service)
            paused_at = datetime.now(timezone.utc)
            drain_seconds = max(300, int(baseline["live"]["runtimeSpec"].get("timeoutSeconds", 300)))
            evidence.update(maintenancePaused=True, maintenanceConfirmedAtUtc=paused_at.isoformat(), drainSeconds=drain_seconds,
                            drainUntilUtc=(paused_at + timedelta(seconds=drain_seconds)).isoformat(), migrationExecuted=False)
        else:
            pause = phase_proof(args.pause_proof, "pause", artifact, baseline)
            validate_pause(pause, prepared)
            evidence["pauseProofSha256"] = operator.sha(pause)
            if args.phase != "resume":
                assert_maintenance_traffic(service)
                evidence["maintenanceProbes"] = maintenance_probes(service)
            url = operator.read_secret("geo-backend-database-url", "2")
            operator.require(operator.sha(operator.validate_url(url)) == baseline["databaseHostSha256"], "production_database_target_changed")
            before = operator.inventory(url)
            evidence["beforeInventory"] = before
            if args.phase == "migrate":
                operator.require(args.backup_proof, "after_drain_backup_proof_required")
                backup = passed_proof(args.backup_proof, "production-backup")
                validate_backup(backup, pause, artifact, baseline, before)
                evidence["backupProofSha256"] = operator.sha(backup)
                executions = operator.cloud("run", "jobs", "executions", "list", "--job", MIGRATION_JOB, "--region", operator.REGION)
                operator.require(not executions, "migration_job_already_executed")
                attempt("execute_exact_production_migration_job")
                result = operator.cloud("run", "jobs", "execute", MIGRATION_JOB, "--region", operator.REGION, "--wait")
                operator.require(any(row.get("type") == "Completed" and row.get("status") == "True"
                                     for row in result.get("status", {}).get("conditions", [])), "production_migration_execution_failed")
                after = operator.inventory(url)
                operator.assert_preserved(before, after)
                evidence.update(execution=result["metadata"]["name"], afterInventory=after, migrationExecuted=True)
            else:
                migrated = phase_proof(args.migration_proof, "migrate", artifact, baseline)
                operator.require(migrated.get("pauseProofSha256") == operator.sha(pause) and migrated.get("migrationExecuted") is True,
                                 "migration_proof_not_verified")
                assert_inventory_equal(migrated["afterInventory"], before)
                operator.require(before.get("migrationCount") == 22 and before.get("migrationHead") == "0022_worker_password_recovery",
                                 "production_migration_missing")
                evidence["migrationProofSha256"] = operator.sha(migrated)
                if args.phase == "check":
                    attempt("execute_read_only_migration_check")
                    result = operator.cloud("run", "jobs", "execute", MIGRATION_JOB, "--region", operator.REGION,
                                            "--wait", "--args=-m,app.migrations,--check")
                    operator.require(any(row.get("type") == "Completed" and row.get("status") == "True"
                                         for row in result.get("status", {}).get("conditions", [])), "production_migration_check_failed")
                    after = operator.inventory(url)
                    assert_inventory_equal(before, after)
                    evidence.update(execution=result["metadata"]["name"], afterInventory=after, migrationCheckPassed=True)
                else:
                    checked = phase_proof(args.check_proof, "check", artifact, baseline)
                    operator.require(checked.get("migrationProofSha256") == operator.sha(migrated) and checked.get("migrationCheckPassed") is True,
                                     "migration_check_proof_not_verified")
                    evidence["checkProofSha256"] = operator.sha(checked)
                    if args.phase == "candidate":
                        revisions = operator.cloud("run", "revisions", "list", "--service", operator.PRODUCTION, "--region", operator.REGION)
                        operator.require(all(row["metadata"]["name"] != CANDIDATE_REVISION for row in revisions), "candidate_revision_already_exists")
                        document = candidate_document(baseline, artifact, service)
                        attempt("create_zero_traffic_normal_candidate:" + CANDIDATE_REVISION)
                        operator.cloud("run", "services", "replace", "-", "--region", operator.REGION, input_text=json.dumps(document))
                        service = service_now()
                        candidate_url = candidate_tag_url(service)
                        exact_revision(CANDIDATE_REVISION, document["spec"]["template"]["spec"], artifact["image"])
                        evidence.update(candidateRevision=CANDIDATE_REVISION, candidateUrl=candidate_url,
                                        candidateReady=True, candidateTrafficPercent=0, readiness=readiness_probes(candidate_url))
                    else:
                        candidate = phase_proof(args.candidate_proof, "candidate", artifact, baseline)
                        operator.require(candidate.get("checkProofSha256") == operator.sha(checked)
                                         and candidate.get("candidateRevision") == CANDIDATE_REVISION
                                         and candidate.get("readiness", {}).get("consecutivePassed") == 5, "candidate_proof_not_verified")
                        candidate_url = candidate_tag_url(service)
                        operator.require(candidate_url == candidate.get("candidateUrl"), "candidate_tag_url_changed")
                        exact_revision(CANDIDATE_REVISION, candidate_runtime(baseline, artifact["image"]), artifact["image"])
                        readiness_probes(candidate_url)
                        evidence["candidateProofSha256"] = operator.sha(candidate)
                        attempt("route_verified_candidate_100_preserving_only_candidate_tag")
                        operator.cloud("run", "services", "update-traffic", operator.PRODUCTION, "--region", operator.REGION,
                                       "--to-revisions", CANDIDATE_REVISION + "=100", "--set-tags", CANDIDATE_TAG + "=" + CANDIDATE_REVISION)
                        service = service_now()
                        assert_traffic(service, CANDIDATE_REVISION, CANDIDATE_TAG)
                        evidence.update(maintenancePaused=False, servingRevision=CANDIDATE_REVISION,
                                        directReadiness=readiness_probes(service["status"]["url"]),
                                        hostingReadiness=readiness_probes(HOSTING_ORIGIN, "/api/health/ready"))
            if args.phase in {"migrate", "check"}:
                assert_maintenance_traffic(service_now())
        final_iam = operator.cloud("run", "services", "get-iam-policy", operator.PRODUCTION, "--region", operator.REGION)
        operator.require(final_iam == iam, "service_iam_changed")
        operator.require(operator.sha(configuration_metadata(service_now())) == prepared["serviceMetadataSha256"], "service_metadata_changed")
        evidence.update(status="passed", finishedAtUtc=operator.now(), serviceIamUnchanged=True)
        save()
        print(json.dumps({"status": "passed", "phase": args.phase, "evidence": str(args.evidence),
                          **({"drainUntilUtc": evidence["drainUntilUtc"]} if args.phase == "pause" else {})}))
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r"[a-z_]+", str(error)) else type(error).__name__
        evidence.update(status="failed", failureCode=code, finishedAtUtc=operator.now(),
                        safeAction="Inspect the exact journaled resources; do not blindly repeat writes or roll back to the old backend after migration.")
        save()
        print(json.dumps({"status": "failed", "phase": args.phase, "code": code, "evidence": str(args.evidence)}))
        return 1


def run(args):
    if args.phase == "prepare":
        return run_prepare(args)
    return run_phase(args)


def parser():
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("phase", choices=("prepare", "pause", "migrate", "check", "candidate", "resume"))
    value.add_argument("--allow-production-cutover", action="store_true")
    for option in ("evidence", "snapshot"):
        value.add_argument("--" + option, required=True, type=Path)
    value.add_argument("--source-commit", required=True)
    value.add_argument("--image", required=True)
    for option in ("stage-check-proof", "stage-service-proof", "stage-ux-proof", "provider-smoke-proof", "stage-validation-proof",
                   "prepare-proof", "pause-proof", "backup-proof", "migration-proof", "check-proof", "candidate-proof"):
        value.add_argument("--" + option, type=Path)
    return value


if __name__ == "__main__":
    try:
        raise SystemExit(run(parser().parse_args()))
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r"[a-z_]+", str(error)) else type(error).__name__
        print(json.dumps({"status": "refused", "code": code}))
        raise SystemExit(1)
