"""No-network guards for proof-bound stage teardown across release runs."""
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


def proofs(run_id=teardown.RUN_ID, migration_mode=None):
    names = operator.names(run_id)
    baseline = {**fixtures.baseline(), "schemaVersion": 1, "phase": "snapshot", "status": "passed"}
    common = {"schemaVersion": 1, "status": "passed", "runId": run_id, "resources": names,
              "artifact": {"sourceCommit": "1" * 40, "image": f"{operator.REGION}-docker.pkg.dev/{operator.PROJECT}/cloud-run-source-deploy/geo-backend@sha256:" + "a" * 64},
              "branch": {"projectId": operator.NEON_PROJECT, "parentId": operator.NEON_PARENT,
                         "id": "br-fixture-isolated", "hostSha256": "different"},
              "baselineSha256": operator.sha(baseline), "productionUnchanged": True,
              "startedAtUtc": "2026-09-29T01:00:00Z", "finishedAtUtc": "2026-09-29T01:00:04Z"}
    if migration_mode is not None:
        common["migrationMode"] = migration_mode
    actions = [f"create_job:{names['job']}"]
    for key in ("databaseSecret", "jwtSecret"):
        actions += [f"create_secret:{names[key]}", f"add_secret_version:{names[key]}"]
    resources = {**common, "phase": "stage-resources", "attempts": [{"action": action, "atUtc": "2026-09-29T01:00:01Z"} for action in actions]}
    service = {**common, "phase": "stage-service", "stageRevision": f"{names['service']}-00001-abc",
               "stageUrl": "https://stage-fixture.example", "attempts": [{"action": f"create_service:{names['service']}", "atUtc": "2026-09-29T01:00:01Z"}]}
    if migration_mode == "none":
        service["resourcesProofSha256"] = operator.sha(resources)
    return baseline, resources, service


def objects(run_id=teardown.RUN_ID, migration_mode=None):
    names = operator.names(run_id)
    baseline, resources, proof = proofs(run_id, migration_mode)
    service = operator.service_document(baseline, names, resources["artifact"]["image"])
    service["metadata"].update(namespace=PROJECT_NUMBER, uid="service-fixture", creationTimestamp=CREATED)
    service["spec"]["template"]["metadata"]["name"] = proof["stageRevision"]
    service["status"] = {"latestCreatedRevisionName": proof["stageRevision"], "latestReadyRevisionName": proof["stageRevision"],
                         "url": proof["stageUrl"], "traffic": [{"revisionName": proof["stageRevision"], "percent": 100}]}
    job = operator.job_document(baseline, names, resources["artifact"]["image"], migration_mode=migration_mode or "required")
    job["metadata"].update(namespace=PROJECT_NUMBER, uid="job-fixture", creationTimestamp=CREATED)
    result = {"service": service, "job": job}
    for key in ("databaseSecret", "jwtSecret"):
        identity = f"projects/{PROJECT_NUMBER}/secrets/{names[key]}"
        result[key] = {"secret": {"name": identity, "labels": {"report-release": run_id},
                                  "replication": {"automatic": {}}, "createTime": CREATED},
                       "versions": [{"name": identity + "/versions/1", "state": "ENABLED", "createTime": CREATED}],
                       "policy": {"bindings": [{"role": "roles/secretmanager.secretAccessor", "members": [f"serviceAccount:{operator.RUNTIME}"]}]}}
    return result


def resumed_proofs(run_id=teardown.RUN_ID, migration_mode=None):
    names = operator.names(run_id)
    baseline, resources, service = proofs(run_id, migration_mode)
    original = copy.deepcopy(service)
    original.update(status="failed", failureCode="external_command_failed")
    original["attempts"].append({"action": f"copy_invoker_policy:{names['service']}", "atUtc": "2026-09-29T01:00:03Z"})
    original.pop("stageRevision")
    original.pop("stageUrl")
    service.update(startedAtUtc="2026-09-29T01:01:00Z", finishedAtUtc="2026-09-29T01:01:04Z",
                   resumedFailedProofSha256=operator.sha(original), exactInvokerPolicyVerified=True,
                   attempts=[{"action": f"grant_invoker_policy:{names['service']}", "atUtc": "2026-09-29T01:01:02Z"}])
    return baseline, resources, service, original


def stage_plan(baseline, resources):
    result = copy.deepcopy(resources)
    result.update(phase="stage-plan", startedAtUtc="2026-09-29T00:59:00Z", finishedAtUtc="2026-09-29T00:59:02Z", attempts=[],
                  service=operator.service_document(baseline, resources["resources"], resources["artifact"]["image"]))
    return result


class TeardownTests(unittest.TestCase):
    def setUp(self):
        # Every cloud path must receive an explicit local fixture. New test
        # coverage must not accidentally turn a missing mock into a real call.
        cloud = patch.object(operator, "cloud", side_effect=AssertionError("network_forbidden"))
        self.addCleanup(cloud.stop)
        cloud.start()

    def test_new_run_requires_exact_run_resources_revision_and_secret_labels(self):
        run_id = "20261005"
        baseline, resources, service = proofs(run_id, "none")
        owned = objects(run_id, "none")
        teardown.validate_proofs(baseline, resources, service, run_id=run_id)
        teardown.verify_service(owned["service"], baseline, resources, service, PROJECT_NUMBER, run_id=run_id)
        teardown.verify_job(owned["job"], baseline, resources, PROJECT_NUMBER, run_id=run_id)
        secret = owned["databaseSecret"]
        teardown.verify_secret(secret["secret"], secret["versions"], secret["policy"],
                               resources["resources"]["databaseSecret"], resources, PROJECT_NUMBER, run_id=run_id)
        with self.assertRaisesRegex(RuntimeError, "stage_creation_identity_mismatch"):
            teardown.validate_proofs(baseline, resources, service)
        with self.assertRaisesRegex(RuntimeError, "stage_creation_identity_mismatch"):
            teardown.preflight(baseline, resources, service, run_id="20261006")
        operator.cloud.assert_not_called()
        for key in ("service", "job", "databaseSecret", "jwtSecret", "uploadPrefix"):
            foreign = copy.deepcopy(resources)
            foreign["resources"][key] = operator.names("20261006")[key]
            with self.subTest(resource=key), self.assertRaisesRegex(RuntimeError, "stage_creation_identity_mismatch"):
                teardown.validate_proofs(baseline, foreign, service, run_id=run_id)
        for foreign_revision in ("geo-backend-20261005-00001-abc", "geo-report-stage-20260929-00001-abc"):
            with self.assertRaisesRegex(RuntimeError, "exact_owned_stage_revision_required"):
                teardown.validate_proofs(baseline, resources, {**service, "stageRevision": foreign_revision}, run_id=run_id)
        foreign_secret = copy.deepcopy(secret)
        foreign_secret["secret"]["labels"]["report-release"] = "20260929"
        with self.assertRaisesRegex(RuntimeError, "stage_secret_identity_mismatch"):
            teardown.verify_secret(foreign_secret["secret"], foreign_secret["versions"], foreign_secret["policy"],
                                   resources["resources"]["databaseSecret"], resources, PROJECT_NUMBER, run_id=run_id)

    def test_none_job_is_check_only_and_cannot_match_required_or_legacy_proof(self):
        run_id = "20261005"
        for mode in (None, "required", "none"):
            baseline, resources, _ = proofs(run_id, mode)
            value = objects(run_id, mode)["job"]
            args = value["spec"]["template"]["spec"]["template"]["spec"]["containers"][0]["args"]
            self.assertEqual(args, ["-m", "app.migrations"] + (["--check"] if mode == "none" else []))
            teardown.verify_job(value, baseline, resources, PROJECT_NUMBER, run_id=run_id)
            opposite = objects(run_id, "required" if mode == "none" else "none")["job"]
            with self.subTest(mode=mode), self.assertRaisesRegex(RuntimeError, "stage_job_configuration_drift"):
                teardown.verify_job(opposite, baseline, resources, PROJECT_NUMBER, run_id=run_id)

    def test_migration_mode_is_consistent_across_resources_service_plan_and_resume(self):
        run_id = "20261005"
        baseline, resources, service, original = resumed_proofs(run_id, "none")
        plan = stage_plan(baseline, resources)
        value = objects(run_id, "none")["service"]
        del value["spec"]["template"]["metadata"]["name"]
        teardown.verify_service(value, baseline, resources, service, PROJECT_NUMBER, original, plan, run_id=run_id)
        for mode in ("required", None):
            for index in (0, 1, 2, 3):
                changed = copy.deepcopy([resources, service, original, plan])
                if mode is None:
                    changed[index].pop("migrationMode")
                else:
                    changed[index]["migrationMode"] = mode
                if index == 2:
                    changed[1]["resumedFailedProofSha256"] = operator.sha(changed[2])
                with self.subTest(mode=mode, proof=index), self.assertRaisesRegex(RuntimeError, "stage_creation_migration_mode_mismatch"):
                    teardown.verify_service(value, baseline, changed[0], changed[1], PROJECT_NUMBER, changed[2], changed[3], run_id=run_id)
        for invalid in (None, "", "skip", False, {}, []):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(RuntimeError, "invalid_creation_migration_mode"):
                teardown.validate_proofs(baseline, {**resources, "migrationMode": invalid}, service, original, run_id=run_id)
        # Missing historical fields and explicit required describe the same
        # migration behavior, while neither may be used for a check-only run.
        baseline, resources, service = proofs()
        teardown.validate_proofs(baseline, resources, {**service, "migrationMode": "required"})

    def test_cli_requires_valid_explicit_run_before_reading_proofs(self):
        args = ["--snapshot", "snapshot.json", "--resources-proof", "resources.json",
                "--service-proof", "service.json", "--evidence", "unused.json"]
        with patch.object(operator, "read_proof") as read, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as stopped:
                teardown.main(args)
            self.assertEqual(stopped.exception.code, 2)
            for invalid in ("../prod", "UPPERCASE", "", "x"):
                with self.subTest(invalid=invalid), self.assertRaisesRegex(RuntimeError, "invalid_run_id"):
                    teardown.main(["--run-id", invalid, *args])
            read.assert_not_called()
        operator.cloud.assert_not_called()

    def test_none_service_and_resumed_original_require_exact_resources_proof_hash(self):
        run_id = "20261005"
        baseline, resources, service, original = resumed_proofs(run_id, "none")
        for target in ("service", "original"):
            for missing in (False, True):
                changed_service = copy.deepcopy(service)
                changed_original = copy.deepcopy(original)
                changed = changed_service if target == "service" else changed_original
                if missing:
                    changed.pop("resourcesProofSha256")
                else:
                    changed["resourcesProofSha256"] = "wrong"
                if target == "original":
                    changed_service["resumedFailedProofSha256"] = operator.sha(changed_original)
                with self.subTest(target=target, missing=missing), \
                     self.assertRaisesRegex(RuntimeError, "stage_creation_resources_proof_mismatch"):
                    teardown.validate_proofs(baseline, resources, changed_service, changed_original, run_id=run_id)

    def test_cli_wrong_run_is_refused_before_cloud_or_evidence(self):
        args = ["--run-id", "20261006", "--snapshot", "snapshot.json", "--resources-proof", "resources.json",
                "--service-proof", "service.json", "--evidence", "unused.json"]
        with patch.object(operator, "read_proof", side_effect=proofs("20261005", "none")), \
             self.assertRaisesRegex(RuntimeError, "stage_creation_identity_mismatch"):
            teardown.main(args)
        operator.cloud.assert_not_called()

    def test_none_cli_binds_new_run_through_metadata_checks_four_deletes_and_absence(self):
        run_id = "20261005"
        names = operator.names(run_id)
        owned = objects(run_id, "none")
        responses = [{"projectId": operator.PROJECT, "projectNumber": PROJECT_NUMBER}, owned["service"], owned["job"], []]
        for key in ("databaseSecret", "jwtSecret"):
            responses.extend(owned[key][field] for field in ("secret", "versions", "policy"))
        responses.extend([owned["service"], {}, owned["job"], [], {}])
        for key in ("databaseSecret", "jwtSecret"):
            responses.extend([*(owned[key][field] for field in ("secret", "versions", "policy")), {}])
        # Foreign/historical resources must remain untouched and do not prevent
        # confirming that this run's exact resources are absent.
        responses.extend([[{"metadata": {"name": teardown.NAMES["service"]}}],
                          [{"metadata": {"name": teardown.NAMES["job"]}}],
                          [{"name": f"projects/{PROJECT_NUMBER}/secrets/{teardown.NAMES['databaseSecret']}"}]])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            evidence = root / "docs/evidence/new-run.json"
            args = ["--run-id", run_id, "--snapshot", "snapshot.json", "--resources-proof", "resources.json",
                    "--service-proof", "service.json", "--evidence", str(evidence), "--allow-stage-deletion"]
            with patch.object(operator, "ROOT", root), patch.object(operator, "read_proof", side_effect=proofs(run_id, "none")), \
                 patch.object(operator, "live_snapshot", return_value={}), patch.object(operator, "same_live"), \
                 patch.object(operator, "cloud", side_effect=responses) as cloud, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(teardown.main(args), 0)
            proof = json.loads(evidence.read_text(encoding="utf-8"))
            self.assertEqual(proof["runId"], run_id)
            self.assertEqual(proof["resources"], names)
            self.assertEqual(proof["migrationMode"], "none")
            self.assertEqual([entry["action"] for entry in proof["attempts"]],
                             [f"delete:{names[key]}" for key in ("service", "job", "databaseSecret", "jwtSecret")])
            self.assertTrue(proof["deletionComplete"] and proof["uploadsUntouched"] and proof["neonUntouched"])
        self.assertEqual(cloud.call_count, len(responses))
        self.assertEqual([call.args for call in cloud.call_args_list if "delete" in call.args], [
            ("run", "services", "delete", names["service"], "--region", operator.REGION),
            ("run", "jobs", "delete", names["job"], "--region", operator.REGION),
            ("secrets", "delete", names["databaseSecret"]),
            ("secrets", "delete", names["jwtSecret"]),
        ])
        self.assertFalse(any("access" in call.args or any("20260929" in str(arg) for arg in call.args)
                             for call in cloud.call_args_list))

    def test_changed_owned_resource_after_preflight_blocks_deletion_and_journals_failure(self):
        run_id = "20261005"
        owned = objects(run_id, "none")
        changed = copy.deepcopy(owned["service"])
        changed["metadata"]["uid"] = "replaced-resource"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            evidence = root / "docs/evidence/changed.json"
            args = ["--run-id", run_id, "--snapshot", "snapshot.json", "--resources-proof", "resources.json",
                    "--service-proof", "service.json", "--evidence", str(evidence), "--allow-stage-deletion"]
            with patch.object(operator, "ROOT", root), patch.object(operator, "read_proof", side_effect=proofs(run_id, "none")), \
                 patch.object(operator, "live_snapshot", return_value={}), patch.object(operator, "same_live"), \
                 patch.object(teardown, "preflight", return_value=owned), patch.object(teardown, "read_service", return_value=changed), \
                 patch.object(teardown, "delete_exact") as delete, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(teardown.main(args), 1)
            delete.assert_not_called()
            proof = json.loads(evidence.read_text(encoding="utf-8"))
            self.assertEqual(proof["status"], "failed")
            self.assertEqual(proof["failureCode"], "stage_resource_changed_after_preflight")
            self.assertEqual(proof["attempts"], [])
        operator.cloud.assert_not_called()

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
                args = ["--run-id", teardown.RUN_ID, "--snapshot", "snapshot.json", "--resources-proof", "resources.json", "--service-proof", "service.json",
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
            args = ["--run-id", teardown.RUN_ID, "--snapshot", "snapshot.json", "--resources-proof", "resources.json", "--service-proof", "final.json",
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
