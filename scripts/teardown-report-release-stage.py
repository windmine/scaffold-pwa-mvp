"""Plan or explicitly delete only the four owned September 29 GCP stage resources.

Requires passed creation proofs and unchanged current resource identities/configs.
Does not read secret payloads, delete Neon branches or touch any upload objects.
Default is read-only planning; --allow-stage-deletion enables the four exact deletes.
Partial/uncertain outcomes are journaled and require operator review, not broad cleanup.
"""
import argparse
import copy
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import re

SPEC = importlib.util.spec_from_file_location("release_operator", Path(__file__).with_name("report-release-operator.py"))
operator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(operator)

RUN_ID = "20260929"
NAMES = operator.names(RUN_ID)
require = operator.require


def utc(value):
    require(isinstance(value, str) and re.search(r"(?:Z|[+-]\d{2}:\d{2})$", value), "explicit_utc_timestamp_required")
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def creation_window(proof, action, created):
    attempts = [item for item in proof.get("attempts", []) if item.get("action") == action]
    require(len(attempts) == 1, "exact_creation_attempt_required")
    require(utc(proof["startedAtUtc"]) <= utc(attempts[0]["atUtc"]) <= utc(created)
            <= utc(proof["finishedAtUtc"]), "resource_not_created_during_owned_attempt")


def validate_proofs(baseline, resources, service, original_service_creation=None):
    for value, phase in ((baseline, "snapshot"), (resources, "stage-resources"), (service, "stage-service")):
        require(value.get("schemaVersion") == 1 and value.get("status") == "passed" and value.get("phase") == phase,
                "passed_creation_proofs_required")
    operator.safe_spec(baseline["live"]["runtimeSpec"])
    artifact = resources.get("artifact", {})
    require(re.fullmatch(r"[0-9a-f]{40}", artifact.get("sourceCommit", ""))
            and re.fullmatch(rf"{operator.REGION}-docker\.pkg\.dev/{operator.PROJECT}/cloud-run-source-deploy/geo-backend@sha256:[0-9a-f]{{64}}",
                             artifact.get("image", "")), "immutable_stage_artifact_required")
    branch = resources.get("branch", {})
    require(branch.get("projectId") == operator.NEON_PROJECT and branch.get("parentId") == operator.NEON_PARENT
            and branch.get("id") and branch["id"] != operator.NEON_PARENT
            and branch.get("hostSha256") and branch["hostSha256"] != baseline.get("databaseHostSha256"),
            "isolated_stage_branch_required")
    for proof in (resources, service):
        require(proof.get("runId") == RUN_ID and proof.get("resources") == NAMES
                and proof.get("artifact") == artifact and proof.get("branch") == branch
                and proof.get("baselineSha256") == operator.sha(baseline)
                and proof.get("productionUnchanged") is True, "stage_creation_identity_mismatch")
    require(re.fullmatch(r"geo-report-stage-20260929-[a-z0-9-]+", service.get("stageRevision", "")),
            "exact_owned_stage_revision_required")
    resumed_hash = service.get("resumedFailedProofSha256")
    if resumed_hash is None:
        require(original_service_creation is None, "unbound_original_creation_proof_refused")
    else:
        original = original_service_creation
        require(isinstance(original, dict) and operator.sha(original) == resumed_hash,
                "resumed_creation_proof_hash_mismatch")
        require(original.get("schemaVersion") == 1 and original.get("phase") == "stage-service"
                and original.get("status") == "failed" and original.get("failureCode") == "external_command_failed",
                "invalid_original_service_creation_proof")
        require(all(original.get(key) == service.get(key)
                    for key in ("runId", "resources", "artifact", "branch", "baselineSha256")),
                "original_service_creation_identity_mismatch")
        require([item.get("action") for item in original.get("attempts", [])]
                == [f"create_service:{NAMES['service']}", f"copy_invoker_policy:{NAMES['service']}"],
                "original_service_not_at_known_iam_boundary")
        require(service.get("exactInvokerPolicyVerified") is True
                and all(item.get("action") == f"grant_invoker_policy:{NAMES['service']}"
                        for item in service.get("attempts", [])), "resumed_service_completion_not_verified")
        require(utc(original["startedAtUtc"]) <= utc(original["attempts"][0]["atUtc"])
                <= utc(original["attempts"][1]["atUtc"]) <= utc(original["finishedAtUtc"])
                <= utc(service["startedAtUtc"]) <= utc(service["finishedAtUtc"]), "invalid_service_resume_chronology")
    return artifact


def verify_run_object(value, kind, project_number, creation_proof):
    metadata = value.get("metadata", {})
    name = NAMES[kind]
    require(metadata.get("name") == name and str(metadata.get("namespace")) == project_number
            and metadata.get("uid"), "cloud_run_identity_mismatch")
    creation_window(creation_proof, f"create_{kind}:{name}", metadata.get("creationTimestamp"))


def verify_autogenerated_stage_plan(plan, baseline, resources, service_proof, original_service_creation=None):
    require(isinstance(plan, dict) and plan.get("schemaVersion") == 1
            and plan.get("phase") == "stage-plan" and plan.get("status") == "passed"
            and plan.get("productionUnchanged") is True, "passed_autogenerated_stage_plan_required")
    require(all(plan.get(key) == resources.get(key)
                for key in ("runId", "resources", "artifact", "branch", "baselineSha256")),
            "autogenerated_stage_plan_identity_mismatch")
    expected = operator.service_document(baseline, NAMES, resources["artifact"]["image"])
    require(plan.get("service") == expected
            and "name" not in expected["spec"]["template"]["metadata"], "autogenerated_stage_creation_document_required")
    creation = original_service_creation or service_proof
    require(utc(plan["startedAtUtc"]) <= utc(plan["finishedAtUtc"]) <= utc(creation["startedAtUtc"]),
            "stage_plan_does_not_precede_creation")


def verify_service(value, baseline, resources, service_proof, project_number, original_service_creation=None, stage_plan=None):
    validate_proofs(baseline, resources, service_proof, original_service_creation)
    verify_run_object(value, "service", project_number, original_service_creation or service_proof)
    template = value["spec"]["template"]
    actual_spec = copy.deepcopy(template["spec"])
    # Cloud Run adds a container name; all other runtime/secret fields stay exact.
    for container in actual_spec.get("containers", []):
        container.pop("name", None)
    require(actual_spec == operator.staging_spec(baseline, NAMES, resources["artifact"]["image"]),
            "stage_service_configuration_drift")
    require(operator.annotations(value["metadata"].get("annotations", {})) == baseline["live"]["serviceAnnotations"]
            and operator.annotations(template.get("metadata", {}).get("annotations", {})) == baseline["live"]["templateAnnotations"],
            "stage_service_annotations_drift")
    expected_revision = service_proof["stageRevision"]
    status = value["status"]
    traffic = status.get("traffic", [])
    metadata = template.get("metadata", {})
    if "name" not in metadata:
        # The creation plan deliberately omitted a revision name. Cloud Run
        # may continue omitting it here; final status/traffic still bind the
        # exact generated revision recorded by the passed service proof.
        verify_autogenerated_stage_plan(stage_plan, baseline, resources, service_proof, original_service_creation)
    else:
        require(metadata["name"] == expected_revision, "stage_service_revision_drift")
    require(status.get("latestCreatedRevisionName") == expected_revision
            and status.get("latestReadyRevisionName") == expected_revision
            and status.get("url") == service_proof.get("stageUrl")
            and len(traffic) == 1 and traffic[0].get("revisionName") == expected_revision
            and traffic[0].get("percent") == 100 and not traffic[0].get("tag"), "stage_service_revision_drift")


def verify_job(value, baseline, resources, project_number):
    verify_run_object(value, "job", project_number, resources)
    expected = operator.job_document(baseline, NAMES, resources["artifact"]["image"])
    require(value["spec"]["template"]["spec"] == expected["spec"]["template"]["spec"], "stage_job_configuration_drift")


def verify_secret(value, versions, policy, name, resources, project_number):
    identity = f"projects/{project_number}/secrets/{name}"
    require(name in (NAMES["databaseSecret"], NAMES["jwtSecret"]) and value.get("name") == identity
            and value.get("labels") == {"report-release": RUN_ID}
            and value.get("replication") == {"automatic": {}}, "stage_secret_identity_mismatch")
    creation_window(resources, f"create_secret:{name}", value.get("createTime"))
    require(len(versions) == 1 and versions[0].get("name") == f"{identity}/versions/1"
            and versions[0].get("state") == "ENABLED", "stage_secret_versions_changed")
    creation_window(resources, f"add_secret_version:{name}", versions[0].get("createTime"))
    require(policy.get("bindings") == [{"role": "roles/secretmanager.secretAccessor",
                                        "members": [f"serviceAccount:{operator.RUNTIME}"]}], "stage_secret_access_changed")


def read_service():
    return operator.cloud("run", "services", "describe", NAMES["service"], "--region", operator.REGION)


def read_job():
    return operator.cloud("run", "jobs", "describe", NAMES["job"], "--region", operator.REGION)


def read_secret_metadata(name):
    require(name in (NAMES["databaseSecret"], NAMES["jwtSecret"]), "unowned_secret_refused")
    return {"secret": operator.cloud("secrets", "describe", name),
            "versions": operator.cloud("secrets", "versions", "list", name, "--limit=3"),
            "policy": operator.cloud("secrets", "get-iam-policy", name)}


def require_no_running_job():
    executions = operator.cloud("run", "jobs", "executions", "list", "--job", NAMES["job"],
                                "--region", operator.REGION, "--limit=100")
    require(len(executions) < 100 and all(item.get("status", {}).get("completionTime") for item in executions),
            "stage_job_execution_running_or_unknown")


def preflight(baseline, resources, service_proof, original_service_creation=None, stage_plan=None):
    validate_proofs(baseline, resources, service_proof, original_service_creation)
    project = operator.cloud("projects", "describe", operator.PROJECT)
    number = str(project.get("projectNumber", ""))
    require(project.get("projectId") == operator.PROJECT and re.fullmatch(r"[0-9]+", number), "project_identity_mismatch")
    current = {"service": read_service(), "job": read_job()}
    verify_service(current["service"], baseline, resources, service_proof, number, original_service_creation, stage_plan)
    verify_job(current["job"], baseline, resources, number)
    require_no_running_job()
    for key in ("databaseSecret", "jwtSecret"):
        current[key] = read_secret_metadata(NAMES[key])
        verify_secret(current[key]["secret"], current[key]["versions"], current[key]["policy"], NAMES[key], resources, number)
    return current


def delete_exact(kind):
    require(kind in ("service", "job", "databaseSecret", "jwtSecret"), "unowned_delete_refused")
    name = NAMES[kind]
    if kind in ("service", "job"):
        operator.cloud("run", "services" if kind == "service" else "jobs", "delete", name, "--region", operator.REGION, json_output=False)
    else:
        operator.cloud("secrets", "delete", name, json_output=False)


def confirm_absent():
    services = operator.cloud("run", "services", "list", "--region", operator.REGION)
    jobs = operator.cloud("run", "jobs", "list", "--region", operator.REGION)
    secrets = operator.cloud("secrets", "list")
    require(all(value["metadata"]["name"] != NAMES["service"] for value in services)
            and all(value["metadata"]["name"] != NAMES["job"] for value in jobs)
            and not {NAMES["databaseSecret"], NAMES["jwtSecret"]}
            & {value["name"].rsplit("/", 1)[-1] for value in secrets}, "stage_resource_still_present")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--resources-proof", type=Path, required=True)
    parser.add_argument("--service-proof", type=Path, required=True)
    parser.add_argument("--original-service-creation-proof", type=Path,
                        help="Original failed post-create IAM proof, required only for a hash-bound resumed service proof")
    parser.add_argument("--stage-plan-proof", type=Path,
                        help="Passed original autogenerated-name creation plan; required when Cloud Run omits the template revision name")
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--allow-stage-deletion", action="store_true")
    args = parser.parse_args(argv)
    baseline = operator.read_proof(args.snapshot, "snapshot")
    resources = operator.read_proof(args.resources_proof, "stage-resources")
    service = operator.read_proof(args.service_proof, "stage-service")
    original = json.loads(args.original_service_creation_proof.read_text(encoding="utf-8")) if args.original_service_creation_proof else None
    validate_proofs(baseline, resources, service, original)
    plan = operator.read_proof(args.stage_plan_proof, "stage-plan") if args.stage_plan_proof else None
    if plan is not None:
        verify_autogenerated_stage_plan(plan, baseline, resources, service, original)
    evidence_path = args.evidence.resolve()
    require(evidence_path.is_relative_to((operator.ROOT / "docs/evidence").resolve()) and not evidence_path.exists(),
            "new_repository_evidence_required")
    evidence_path.parent.mkdir(parents=True, exist_ok=True)
    proof = {"schemaVersion": 1, "phase": "stage-teardown" if args.allow_stage_deletion else "stage-teardown-plan",
             "status": "started", "runId": RUN_ID, "resources": NAMES, "startedAtUtc": operator.now(), "attempts": [],
             "creationProofSha256": {"snapshot": operator.sha(baseline), "resources": operator.sha(resources), "service": operator.sha(service)},
             "neonUntouched": True, "uploadsUntouched": True}
    if original is not None:
        proof["creationProofSha256"]["originalServiceCreation"] = operator.sha(original)
    if plan is not None:
        proof["creationProofSha256"]["stagePlan"] = operator.sha(plan)
    with evidence_path.open("x", encoding="utf-8") as file:
        json.dump(proof, file)
    def save():
        evidence_path.write_text(json.dumps(proof, indent=2) + "\n", encoding="utf-8")
    try:
        # Compare against current live state, not the historical September 25
        # serving identity: teardown is also valid after the coupled cutover.
        live = {"live": operator.live_snapshot()}
        owned = preflight(baseline, resources, service, original, plan)
        operator.same_live(live)
        proof["verifiedResourceSha256"] = {key: operator.sha(value) for key, value in owned.items()}
        if args.allow_stage_deletion:
            for kind in ("service", "job", "databaseSecret", "jwtSecret"):
                operator.same_live(live)
                current = read_service() if kind == "service" else read_job() if kind == "job" else read_secret_metadata(NAMES[kind])
                require(current == owned[kind], "stage_resource_changed_after_preflight")
                if kind == "job":
                    require_no_running_job()
                proof["attempts"].append({"action": f"delete:{NAMES[kind]}", "atUtc": operator.now()})
                save()
                delete_exact(kind)
            confirm_absent()
        operator.same_live(live)
        proof.update(status="passed", productionUnchanged=True, deletionComplete=bool(args.allow_stage_deletion), finishedAtUtc=operator.now())
        save()
        print(json.dumps({"status": "passed", "phase": proof["phase"], "deletedResources": len(proof["attempts"]),
                          "neonUntouched": True, "uploadsUntouched": True, "evidence": str(evidence_path)}))
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r"[a-z_]+", str(error)) else type(error).__name__
        proof.update(status="failed", failureCode=code, finishedAtUtc=operator.now())
        save()
        print(json.dumps({"status": "failed", "code": code, "attempts": len(proof["attempts"]), "evidence": str(evidence_path)}))
        return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"status": "refused", "code": str(error) if isinstance(error, RuntimeError) else type(error).__name__}))
        raise SystemExit(1)
