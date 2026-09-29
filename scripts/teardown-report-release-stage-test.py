"""No-network guards for the exact September 29 stage teardown."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


teardown = module("stage_teardown", "teardown-report-release-stage.py")
fixtures = module("operator_fixtures", "report-release-operator-test.py")
operator = teardown.operator
PROJECT_NUMBER = "123456789012"
CREATED = "2026-09-29T01:00:02Z"


def proofs():
    baseline = {**fixtures.baseline(), "schemaVersion": 1, "phase": "snapshot", "status": "passed"}
    common = {"schemaVersion": 1, "status": "passed", "runId": teardown.RUN_ID, "resources": teardown.NAMES,
              "artifact": {"sourceCommit": "1" * 40, "image": f"{operator.REGION}-docker.pkg.dev/{operator.PROJECT}/cloud-run-source-deploy/geo-backend@sha256:" + "a" * 64},
              "branch": {"projectId": operator.NEON_PROJECT, "parentId": operator.NEON_PARENT,
                         "id": "br-fixture-isolated", "hostSha256": "different"},
              "baselineSha256": operator.sha(baseline), "productionUnchanged": True,
              "startedAtUtc": "2026-09-29T01:00:00Z", "finishedAtUtc": "2026-09-29T01:00:04Z"}
    actions = [f"create_job:{teardown.NAMES['job']}"]
    for key in ("databaseSecret", "jwtSecret"):
        actions += [f"create_secret:{teardown.NAMES[key]}", f"add_secret_version:{teardown.NAMES[key]}"]
    resources = {**common, "phase": "stage-resources", "attempts": [{"action": action, "atUtc": "2026-09-29T01:00:01Z"} for action in actions]}
    service = {**common, "phase": "stage-service", "stageRevision": "geo-report-stage-20260929-00001-abc",
               "stageUrl": "https://stage-fixture.example", "attempts": [{"action": f"create_service:{teardown.NAMES['service']}", "atUtc": "2026-09-29T01:00:01Z"}]}
    return baseline, resources, service


def objects():
    baseline, resources, proof = proofs()
    service = operator.service_document(baseline, teardown.NAMES, resources["artifact"]["image"])
    service["metadata"].update(namespace=PROJECT_NUMBER, uid="service-fixture", creationTimestamp=CREATED)
    service["spec"]["template"]["metadata"]["name"] = proof["stageRevision"]
    service["status"] = {"latestCreatedRevisionName": proof["stageRevision"], "latestReadyRevisionName": proof["stageRevision"],
                         "url": proof["stageUrl"], "traffic": [{"revisionName": proof["stageRevision"], "percent": 100}]}
    job = operator.job_document(baseline, teardown.NAMES, resources["artifact"]["image"])
    job["metadata"].update(namespace=PROJECT_NUMBER, uid="job-fixture", creationTimestamp=CREATED)
    result = {"service": service, "job": job}
    for key in ("databaseSecret", "jwtSecret"):
        identity = f"projects/{PROJECT_NUMBER}/secrets/{teardown.NAMES[key]}"
        result[key] = {"secret": {"name": identity, "labels": {"report-release": teardown.RUN_ID},
                                  "replication": {"automatic": {}}, "createTime": CREATED},
                       "versions": [{"name": identity + "/versions/1", "state": "ENABLED", "createTime": CREATED}],
                       "policy": {"bindings": [{"role": "roles/secretmanager.secretAccessor", "members": [f"serviceAccount:{operator.RUNTIME}"]}]}}
    return result


def resumed_proofs():
    baseline, resources, service = proofs()
    original = copy.deepcopy(service)
    original.update(status="failed", failureCode="external_command_failed")
    original["attempts"].append({"action": f"copy_invoker_policy:{teardown.NAMES['service']}", "atUtc": "2026-09-29T01:00:03Z"})
    original.pop("stageRevision")
    original.pop("stageUrl")
    service.update(startedAtUtc="2026-09-29T01:01:00Z", finishedAtUtc="2026-09-29T01:01:04Z",
                   resumedFailedProofSha256=operator.sha(original), exactInvokerPolicyVerified=True,
                   attempts=[{"action": f"grant_invoker_policy:{teardown.NAMES['service']}", "atUtc": "2026-09-29T01:01:02Z"}])
    return baseline, resources, service, original


def stage_plan(baseline, resources):
    result = copy.deepcopy(resources)
    result.update(phase="stage-plan", startedAtUtc="2026-09-29T00:59:00Z", finishedAtUtc="2026-09-29T00:59:02Z", attempts=[],
                  service=operator.service_document(baseline, teardown.NAMES, resources["artifact"]["image"]))
    return result


class TeardownTests(unittest.TestCase):
    def test_creation_proofs_are_passed_consistent_and_exact_owned(self):
        baseline, resources, service = proofs()
        teardown.validate_proofs(baseline, resources, service)
        for mutate in (lambda d: d.update(status="failed"), lambda d: d.update(runId="production"),
                       lambda d: d.update(baselineSha256="wrong"), lambda d: d.update(productionUnchanged=False),
                       lambda d: d["resources"].update(service="geo-backend"),
                       lambda d: d["artifact"].update(image="mutable:latest"),
                       lambda d: d["branch"].update(id=operator.NEON_PARENT)):
            bad = copy.deepcopy(resources)
            mutate(bad)
            with self.subTest(mutation=mutate), self.assertRaises(RuntimeError):
                teardown.validate_proofs(baseline, bad, service)

    def test_service_full_runtime_identity_revision_and_time_are_bound(self):
        baseline, resources, proof = proofs()
        service = objects()["service"]
        teardown.verify_service(service, baseline, resources, proof, PROJECT_NUMBER)
        for mutate in (lambda d: d["metadata"].update(name="geo-backend"), lambda d: d["metadata"].update(namespace="other"),
                       lambda d: d["metadata"].update(uid=""), lambda d: d["metadata"].update(creationTimestamp="2026-09-28T01:00:02Z"),
                       lambda d: d["status"].update(latestCreatedRevisionName="other"),
                       lambda d: d["spec"]["template"]["spec"]["containers"][0].update(image="different"),
                       lambda d: d["status"]["traffic"][0].update(tag="other")):
            bad = copy.deepcopy(service)
            mutate(bad)
            with self.assertRaises(RuntimeError):
                teardown.verify_service(bad, baseline, resources, proof, PROJECT_NUMBER)

    def test_job_must_match_owned_migration_configuration(self):
        baseline, resources, _ = proofs()
        job = objects()["job"]
        teardown.verify_job(job, baseline, resources, PROJECT_NUMBER)
        for mutate in (lambda d: d["metadata"].update(name="geo-recovery-migrate-20260929"),
                       lambda d: d["spec"]["template"]["spec"].update(taskCount=2),
                       lambda d: d["spec"]["template"]["spec"]["template"]["spec"]["containers"][0].update(args=["other"])):
            bad = copy.deepcopy(job)
            mutate(bad)
            with self.assertRaises(RuntimeError):
                teardown.verify_job(bad, baseline, resources, PROJECT_NUMBER)

    def test_generated_container_name_only_is_ignored_without_mutating_input(self):
        baseline, resources, service = proofs()
        value = objects()["service"]
        container = value["spec"]["template"]["spec"]["containers"][0]
        container["name"] = "geo-backend-generated-1"
        original = copy.deepcopy(value)
        teardown.verify_service(value, baseline, resources, service, PROJECT_NUMBER)
        self.assertEqual(value, original)
        container["env"][0]["valueFrom"]["secretKeyRef"]["name"] = "geo-backend-database-url"
        with self.assertRaisesRegex(RuntimeError, "stage_service_configuration_drift"):
            teardown.verify_service(value, baseline, resources, service, PROJECT_NUMBER)

    def test_missing_template_name_requires_exact_original_autogenerated_plan(self):
        baseline, resources, service, original = resumed_proofs()
        value = objects()["service"]
        del value["spec"]["template"]["metadata"]["name"]
        value["status"]["traffic"][0]["latestRevision"] = True
        plan = stage_plan(baseline, resources)
        teardown.verify_service(value, baseline, resources, service, PROJECT_NUMBER, original, plan)
        with self.assertRaises(RuntimeError):
            teardown.verify_service(value, baseline, resources, service, PROJECT_NUMBER, original)
        for name in (None, "", "geo-report-stage-20260929-00002-other"):
            explicit = copy.deepcopy(value)
            explicit["spec"]["template"]["metadata"]["name"] = name
            with self.assertRaises(RuntimeError):
                teardown.verify_service(explicit, baseline, resources, service, PROJECT_NUMBER, original, plan)
        for mutate in (lambda d: d["status"].update(latestCreatedRevisionName="different"),
                       lambda d: d["status"].update(latestReadyRevisionName="different"),
                       lambda d: d["status"]["traffic"][0].update(revisionName="different"),
                       lambda d: d["status"]["traffic"][0].update(percent=0)):
            changed = copy.deepcopy(value)
            mutate(changed)
            with self.assertRaises(RuntimeError):
                teardown.verify_service(changed, baseline, resources, service, PROJECT_NUMBER, original, plan)

    def test_missing_name_does_not_accept_foreign_or_explicitly_named_creation_plan(self):
        baseline, resources, service, original = resumed_proofs()
        value = objects()["service"]
        del value["spec"]["template"]["metadata"]["name"]
        for mutate in (lambda d: d.update(status="failed"), lambda d: d.update(baselineSha256="other"),
                       lambda d: d["artifact"].update(sourceCommit="2" * 40),
                       lambda d: d["resources"].update(service="geo-backend"),
                       lambda d: d["service"]["spec"]["template"]["metadata"].update(name=service["stageRevision"]),
                       lambda d: d.update(finishedAtUtc="2026-09-29T01:00:01Z")):
            bad = stage_plan(baseline, resources)
            mutate(bad)
            with self.assertRaises(RuntimeError):
                teardown.verify_service(value, baseline, resources, service, PROJECT_NUMBER, original, bad)

    def test_resumed_completion_requires_hash_bound_exact_original_creation(self):
        baseline, resources, service, original = resumed_proofs()
        teardown.validate_proofs(baseline, resources, service, original)
        teardown.verify_service(objects()["service"], baseline, resources, service, PROJECT_NUMBER, original)
        with self.assertRaisesRegex(RuntimeError, "resumed_creation_proof_hash_mismatch"):
            teardown.validate_proofs(baseline, resources, service)
        changed = copy.deepcopy(original)
        changed["failureCode"] = "changed"
        with self.assertRaisesRegex(RuntimeError, "resumed_creation_proof_hash_mismatch"):
            teardown.validate_proofs(baseline, resources, service, changed)
        normal = proofs()[2]
        with self.assertRaisesRegex(RuntimeError, "unbound_original_creation_proof_refused"):
            teardown.validate_proofs(baseline, resources, normal, original)

    def test_resumed_original_boundary_identity_and_chronology_cannot_be_relaxed(self):
        baseline, resources, service, original = resumed_proofs()
        for mutate in (lambda d: d.update(status="passed"), lambda d: d.update(failureCode="other"),
                       lambda d: d["attempts"].pop(), lambda d: d["attempts"].reverse(),
                       lambda d: d["artifact"].update(sourceCommit="2" * 40),
                       lambda d: d.update(finishedAtUtc="2026-09-29T01:02:00Z")):
            bad = copy.deepcopy(original)
            mutate(bad)
            bound = {**service, "resumedFailedProofSha256": operator.sha(bad)}
            with self.subTest(mutation=mutate), self.assertRaises(RuntimeError):
                teardown.validate_proofs(baseline, resources, bound, bad)
        with self.assertRaises(RuntimeError):
            teardown.validate_proofs(baseline, resources, {**service, "exactInvokerPolicyVerified": False}, original)
        outside = objects()["service"]
        outside["metadata"]["creationTimestamp"] = "2026-09-29T01:01:02Z"
        with self.assertRaisesRegex(RuntimeError, "resource_not_created_during_owned_attempt"):
            teardown.verify_service(outside, baseline, resources, service, PROJECT_NUMBER, original)

    def test_secret_metadata_versions_and_access_must_be_unchanged(self):
        _, resources, _ = proofs()
        owned = objects()["databaseSecret"]
        def verify(data):
            teardown.verify_secret(data["secret"], data["versions"], data["policy"], teardown.NAMES["databaseSecret"], resources, PROJECT_NUMBER)
        verify(owned)
        for mutate in (lambda d: d["secret"].update(name=f"projects/{PROJECT_NUMBER}/secrets/geo-backend-database-url"),
                       lambda d: d["secret"]["labels"].update(**{"report-release": "wrong"}),
                       lambda d: d["secret"].update(createTime="2026-09-28T01:00:02Z"),
                       lambda d: d["versions"].append({"name": "extra"}),
                       lambda d: d["policy"]["bindings"][0]["members"].append("allUsers")):
            bad = copy.deepcopy(owned)
            mutate(bad)
            with self.assertRaises(RuntimeError):
                verify(bad)

    def test_running_or_unknown_job_and_ambiguous_creation_refused(self):
        with patch.object(operator, "cloud", return_value=[{"status": {"completionTime": CREATED}}]):
            teardown.require_no_running_job()
        for value in ([{"status": {}}], [{}] * 100):
            with patch.object(operator, "cloud", return_value=value), self.assertRaises(RuntimeError):
                teardown.require_no_running_job()
        _, resources, _ = proofs()
        bad = copy.deepcopy(resources)
        bad["attempts"].append(bad["attempts"][0])
        with self.assertRaises(RuntimeError):
            teardown.creation_window(bad, bad["attempts"][0]["action"], CREATED)

    def test_preflight_reads_only_metadata_and_no_secret_payload(self):
        baseline, resources, service = proofs()
        owned = objects()
        responses = [{"projectId": operator.PROJECT, "projectNumber": PROJECT_NUMBER}, owned["service"], owned["job"], []]
        for key in ("databaseSecret", "jwtSecret"):
            responses.extend(owned[key][field] for field in ("secret", "versions", "policy"))
        with patch.object(operator, "cloud", side_effect=responses) as cloud:
            self.assertEqual(teardown.preflight(baseline, resources, service), owned)
        self.assertFalse(any("access" in call.args or "delete" in call.args for call in cloud.call_args_list))
        self.assertEqual([call.args for call in cloud.call_args_list if call.args[:3] == ("secrets", "versions", "list")], [
            ("secrets", "versions", "list", teardown.NAMES["databaseSecret"], "--limit=3"),
            ("secrets", "versions", "list", teardown.NAMES["jwtSecret"], "--limit=3"),
        ])

    def test_only_four_exact_delete_commands_possible(self):
        with patch.object(operator, "cloud", return_value={}) as cloud:
            for kind in ("service", "job", "databaseSecret", "jwtSecret"):
                teardown.delete_exact(kind)
            for kind in ("geo-backend", "production", "uploads", "branch", "other"):
                with self.assertRaises(RuntimeError):
                    teardown.delete_exact(kind)
        self.assertEqual([call.args for call in cloud.call_args_list], [
            ("run", "services", "delete", teardown.NAMES["service"], "--region", operator.REGION),
            ("run", "jobs", "delete", teardown.NAMES["job"], "--region", operator.REGION),
            ("secrets", "delete", teardown.NAMES["databaseSecret"]),
            ("secrets", "delete", teardown.NAMES["jwtSecret"]),
        ])
        # Delete commands may successfully return no JSON document. Exit code
        # and the independent absence checks are the authoritative outcomes.
        self.assertTrue(all(call.kwargs == {"json_output": False} for call in cloud.call_args_list))

    def test_default_plan_never_deletes_and_opt_in_journals_exact_deletes(self):
        for execute in (False, True):
            with self.subTest(execute=execute), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                evidence = root / "docs/evidence/teardown.json"
                owned = objects()
                args = ["--snapshot", "snapshot.json", "--resources-proof", "resources.json", "--service-proof", "service.json",
                        "--evidence", str(evidence)] + (["--allow-stage-deletion"] if execute else [])
                with patch.object(operator, "ROOT", root), patch.object(operator, "read_proof", side_effect=proofs()), \
                     patch.object(operator, "live_snapshot", return_value={"revision": "current-post-cutover"}), \
                     patch.object(operator, "same_live") as same_live, patch.object(teardown, "preflight", return_value=owned), \
                     patch.object(teardown, "read_service", return_value=owned["service"]), \
                     patch.object(teardown, "read_job", return_value=owned["job"]), \
                     patch.object(teardown, "read_secret_metadata", side_effect=[owned["databaseSecret"], owned["jwtSecret"]]), \
                     patch.object(teardown, "require_no_running_job"), patch.object(teardown, "confirm_absent"), \
                     patch.object(teardown, "delete_exact") as delete, patch.object(operator, "cloud", side_effect=AssertionError("network_forbidden")), \
                     contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(teardown.main(args), 0)
                self.assertEqual(delete.call_count, 4 if execute else 0)
                proof = json.loads(evidence.read_text())
                self.assertEqual(len(proof["attempts"]), 4 if execute else 0)
                self.assertTrue(proof["uploadsUntouched"] and proof["neonUntouched"])
                self.assertEqual(same_live.call_args.args[0], {"live": {"revision": "current-post-cutover"}})

    def test_explicit_original_creation_and_plan_arguments_are_bound_in_evidence(self):
        baseline, resources, service, original = resumed_proofs()
        plan = stage_plan(baseline, resources)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original_path = root / "original.json"
            original_path.write_text(json.dumps(original), encoding="utf-8")
            evidence = root / "docs/evidence/plan.json"
            args = ["--snapshot", "snapshot.json", "--resources-proof", "resources.json", "--service-proof", "final.json",
                    "--original-service-creation-proof", str(original_path), "--stage-plan-proof", "plan.json", "--evidence", str(evidence)]
            with patch.object(operator, "ROOT", root), patch.object(operator, "read_proof", side_effect=(baseline, resources, service, plan)), \
                 patch.object(operator, "live_snapshot", return_value={}), patch.object(operator, "same_live"), \
                 patch.object(teardown, "preflight", return_value=objects()) as preflight, \
                 patch.object(teardown, "delete_exact") as delete, \
                 patch.object(operator, "cloud", side_effect=AssertionError("network_forbidden")), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(teardown.main(args), 0)
            self.assertEqual(preflight.call_args.args[3], original)
            self.assertEqual(preflight.call_args.args[4], plan)
            delete.assert_not_called()
            proof = json.loads(evidence.read_text())
            self.assertEqual(proof["creationProofSha256"]["originalServiceCreation"], service["resumedFailedProofSha256"])
            self.assertEqual(proof["creationProofSha256"]["stagePlan"], operator.sha(plan))


if __name__ == "__main__":
    unittest.main(verbosity=2)
