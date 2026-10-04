"""No-network guard/plan regressions for the staging-only release operator."""
import copy
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("release_operator", Path(__file__).with_name("report-release-operator.py"))
operator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(operator)


def baseline():
    env = [{"name": key, "valueFrom": {"secretKeyRef": value}} for key, value in operator.SECRET_REFS.items()]
    env += [{"name": key, "value": value} for key, value in {
        "AUTO_MIGRATE": "false", "UPLOAD_STORAGE_BACKEND": "gcs", "UPLOAD_BUCKET": "fixture-uploads",
        "UPLOAD_OBJECT_PREFIX": "uploads", "BUSINESS_TIMEZONE": "Pacific/Auckland"}.items()]
    spec = {"serviceAccountName": operator.RUNTIME, "timeoutSeconds": 300, "containerConcurrency": 80,
            "containers": [{"name": "previous-1", "image": "old", "env": env,
                            "ports": [{"containerPort": 8080}], "startupProbe": {"tcpSocket": {"port": 8080}},
                            "resources": {"limits": {"cpu": "1", "memory": "512Mi"}}}]}
    return {"live": {"runtimeSpec": spec, "serviceAnnotations": {"run.googleapis.com/ingress": "all"},
                     "templateAnnotations": {"autoscaling.knative.dev/maxScale": "20"}},
            "databaseHostSha256": operator.sha("ep-production.example.neon.tech")}


def metadata():
    return {"branch": {"id": "br-isolated", "name": "release-stage-20260929", "project_id": operator.NEON_PROJECT,
                       "parent_id": operator.NEON_PARENT, "default": False, "primary": False, "current_state": "ready",
                       "expires_at": "2099-01-01T00:00:00Z"},
            "endpoint": {"id": "ep-isolated", "host": "ep-isolated.example.neon.tech", "branch_id": "br-isolated",
                         "project_id": operator.NEON_PROJECT, "type": "read_write"}}


def full_inventory():
    ledger = operator.candidate_ledger()
    return {"schemaVersion": 1, "status": "passed", "recordedAtUtc": "2026-10-05T00:00:00Z",
            "transactionReadOnly": True, "migrationHead": next(reversed(ledger)), "migrationCount": len(ledger),
            "migrationChecksums": ledger, "ledgerMatchesBundledPrefix": True,
            "ledgerVersionPrefixMatches": True, "ledgerChecksumMismatches": [],
            "immutableSubmissionsSha256": "a" * 64, "accountCredentialsSha256": "b" * 64,
            "immutableSubmissionColumns": ["id", "answers_json"], "missingSnapshots": [],
            "submissionCount": 17, "templateCount": 15, "userCounts": [{"role": "worker", "count": 3}],
            "auditCount": 90, "recoverySchema": {"tablePresent": True, "recoveryRowCount": 2,
                "accountCount": 3, "zeroAuthGenerationCount": 1, "zeroRecoveryGenerationCount": 1,
                "legacyAllowedCount": 1, "nullSecurityStateCount": 0}}


class OperatorTests(unittest.TestCase):
    def test_no_network_in_contract_tests(self):
        self.assertEqual(operator.names("20260929")["uploadPrefix"], "uploads/release-stage-20260929")
        for value in ("../production", "UPPER", "ab", "x" * 50, "production;echo"):
            with self.assertRaises(RuntimeError):
                operator.names(value)

    def test_snapshot_rejects_plaintext_and_unknown_credentials(self):
        safe = baseline()["live"]["runtimeSpec"]
        self.assertEqual(operator.safe_spec(safe), safe)
        for item in ({"name": "DATABASE_URL", "value": "postgresql://secret"},
                     {"name": "UNKNOWN_PASSWORD", "value": "sensitive"},
                     {"name": "GEO_SECRET_KEY", "valueFrom": {"secretKeyRef": {"name": "other", "key": "1"}}}):
            bad = copy.deepcopy(safe)
            bad["containers"][0]["env"].append(item)
            with self.assertRaises(RuntimeError):
                operator.safe_spec(bad)

    def test_stage_service_changes_only_exact_isolation_fields(self):
        before = baseline()
        original = copy.deepcopy(before)
        names = operator.names("20260929")
        stage = operator.staging_spec(before, names, "new-image")
        self.assertEqual(before, original)
        for key in ("serviceAccountName", "timeoutSeconds", "containerConcurrency"):
            self.assertEqual(stage[key], before["live"]["runtimeSpec"][key])
        env = {e["name"]: e for e in stage["containers"][0]["env"]}
        self.assertEqual(env["DATABASE_URL"]["valueFrom"]["secretKeyRef"], {"name": names["databaseSecret"], "key": "1"})
        self.assertEqual(env["GEO_SECRET_KEY"]["valueFrom"]["secretKeyRef"], {"name": names["jwtSecret"], "key": "1"})
        self.assertEqual(env["UPLOAD_OBJECT_PREFIX"]["value"], names["uploadPrefix"])
        self.assertEqual(stage["containers"][0]["resources"], before["live"]["runtimeSpec"]["containers"][0]["resources"])

    def test_migration_job_is_separate_single_task_no_retry(self):
        doc = operator.job_document(baseline(), operator.names("20260929"), "image")
        spec = doc["spec"]["template"]["spec"]
        runtime = spec["template"]["spec"]
        self.assertEqual((spec["parallelism"], spec["taskCount"], runtime["maxRetries"]), (1, 1, 0))
        self.assertEqual(runtime["containers"][0]["args"], ["-m", "app.migrations"])
        self.assertNotIn("startupProbe", runtime["containers"][0])
        self.assertNotIn("containerConcurrency", runtime)

    def test_no_migration_job_is_read_only_by_default_without_argument_override(self):
        doc = operator.job_document(baseline(), operator.names("20261005"), "image", "none")
        runtime = doc["spec"]["template"]["spec"]["template"]["spec"]
        self.assertEqual(runtime["containers"][0]["args"], ["-m", "app.migrations", "--check"])
        self.assertEqual(runtime["maxRetries"], 0)
        with self.assertRaisesRegex(RuntimeError, "invalid_migration_mode"):
            operator.job_document(baseline(), operator.names("20261005"), "image", "optional")

    def test_none_requires_exact_full_ledger_not_a_valid_prefix_or_forged_head(self):
        value = full_inventory()
        self.assertEqual((value["migrationCount"], value["migrationHead"]), (22, "0022_worker_password_recovery"))
        operator.assert_full_candidate_inventory(value)
        for mutate in (lambda d: d.update(migrationCount=21), lambda d: d.update(migrationHead="0021_worker_invitations"),
                       lambda d: d["migrationChecksums"].pop(next(iter(d["migrationChecksums"]))),
                       lambda d: d["migrationChecksums"].update(extra="c" * 64),
                       lambda d: d["migrationChecksums"].update({next(iter(d["migrationChecksums"])): "d" * 64}),
                       lambda d: d.update(transactionReadOnly=False), lambda d: d.update(status="failed"),
                       lambda d: d.update(ledgerChecksumMismatches=["bad"]),
                       lambda d: d.pop("accountCredentialsSha256"), lambda d: d.pop("recoverySchema")):
            bad = copy.deepcopy(value)
            mutate(bad)
            with self.subTest(mutation=mutate), self.assertRaises(RuntimeError):
                operator.assert_full_candidate_inventory(bad)

    def test_none_preserves_all_observed_fields_and_accepts_existing_rotations(self):
        before = full_inventory()
        after = copy.deepcopy(before)
        after["recordedAtUtc"] = "2026-10-05T00:01:00Z"
        operator.assert_no_migration_preserved(before, after)
        for mutate in (lambda d: d.update(accountCredentialsSha256="c" * 64),
                       lambda d: d.update(immutableSubmissionsSha256="d" * 64), lambda d: d.update(auditCount=91),
                       lambda d: d.update(templateCount=16), lambda d: d["userCounts"][0].update(count=4),
                       lambda d: d["recoverySchema"].update(zeroAuthGenerationCount=2),
                       lambda d: d.update(missingSnapshots=[{"submissionId": 1}]),
                       lambda d: d.update(unexpectedField=True)):
            bad = copy.deepcopy(after)
            mutate(bad)
            with self.subTest(mutation=mutate), self.assertRaisesRegex(RuntimeError, "stage_check_changed_existing_data"):
                operator.assert_no_migration_preserved(before, bad)
        # A required migration still uses the exact backfill rules, not the
        # no-change path, even though these already-rotated accounts are valid.
        with self.assertRaises(RuntimeError):
            operator.assert_stage_preserved(before, after, "required")

    def test_mode_binds_every_prerequisite_and_missing_means_legacy_required(self):
        artifact, branch, names = {"image": "image"}, {"id": "branch"}, operator.names("20261005")
        proof = {"runId": "20261005", "artifact": artifact, "branch": branch, "resources": names}
        operator.verify_resources(proof, SimpleNamespace(run_id="20261005"), artifact, branch, names)
        none = SimpleNamespace(run_id="20261005", migration_mode="none")
        with self.assertRaisesRegex(RuntimeError, "stage_proof_migration_mode_mismatch"):
            operator.verify_resources(proof, none, artifact, branch, names)
        operator.verify_resources({**proof, "migrationMode": "none"}, none, artifact, branch, names)
        with self.assertRaisesRegex(RuntimeError, "stage_proof_migration_mode_mismatch"):
            operator.verify_resources({**proof, "migrationMode": "none"}, SimpleNamespace(run_id="20261005"), artifact, branch, names)
        with self.assertRaisesRegex(RuntimeError, "invalid_proof_migration_mode"):
            operator.proof_migration_mode({"migrationMode": None})

    def test_none_refuses_migration_phase_and_proof_before_any_remote_or_file_action(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "proof.json"
            for phase, extras, code in (("stage-migrate", [], "no_migration_mode_refuses_stage_migrate"),
                    ("stage-check", ["--migration-proof", "old.json"], "no_migration_mode_refuses_migration_proof")):
                with patch.object(operator, "cloud", side_effect=AssertionError("network_forbidden")), \
                     patch.object(operator, "read_proof", side_effect=AssertionError("read_forbidden")), \
                     self.assertRaisesRegex(RuntimeError, code):
                    operator.main([phase, "--migration-mode", "none", "--evidence", str(path), *extras])
                self.assertFalse(path.exists())

    def test_none_stage_check_chain_without_migration_only_executes_check_job(self):
        before = {**baseline(), "inventory": full_inventory()}
        names = operator.names("20261005")
        artifact, branch = {"sourceCommit": "a" * 40, "image": "image"}, {"id": "branch"}
        resources = {"migrationMode": "none", "runId": "20261005", "resources": names,
                     "artifact": artifact, "branch": branch, "baselineSha256": operator.sha(before),
                     "beforeInventory": full_inventory()}
        check_job = operator.job_document(before, names, "image", "none")
        for failure in (None, "baseline", "stage", "mode", "job", "after"):
            snapshot, prerequisite, described_job = copy.deepcopy(before), copy.deepcopy(resources), copy.deepcopy(check_job)
            after = full_inventory()
            if failure == "baseline": snapshot["inventory"]["migrationCount"] = 21
            if failure == "stage": prerequisite["beforeInventory"]["migrationCount"] = 21
            if failure == "mode": prerequisite["migrationMode"] = "required"
            if failure == "job": described_job["spec"]["template"]["spec"]["template"]["spec"]["containers"][0]["args"].pop()
            if failure == "after": after["immutableSubmissionsSha256"] = "e" * 64
            calls = []
            def cloud(*args, **kwargs):
                calls.append(args)
                if args[:3] == ("run", "jobs", "describe"): return described_job
                if args[:3] == ("run", "jobs", "execute"):
                    return {"metadata": {"name": "check-execution"}, "status": {"conditions": [{"type": "Completed", "status": "True"}]}}
                raise AssertionError("unexpected_remote_call")
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "proof.json"
                with patch.object(operator, "read_proof", side_effect=[snapshot, prerequisite]), \
                     patch.object(operator, "same_live"), patch.object(operator, "stage_identity", return_value=(names, artifact, "private-url", branch)), \
                     patch.object(operator, "inventory", side_effect=[full_inventory(), after]), \
                     patch.object(operator, "cloud", side_effect=cloud), contextlib.redirect_stdout(io.StringIO()):
                    result = operator.main(["stage-check", "--migration-mode", "none", "--allow-stage-mutations",
                        "--snapshot", "snapshot.json", "--resources-proof", "resources.json", "--run-id", "20261005", "--evidence", str(path)])
                self.assertEqual(result, 0 if failure is None else 1)
                executions = [args for args in calls if args[:3] == ("run", "jobs", "execute")]
                self.assertEqual(len(executions), 1 if failure in (None, "after") else 0)
                self.assertTrue(all(not any(str(arg).startswith("--args") for arg in args) for args in executions))
                proof = json.loads(path.read_text())
                self.assertEqual(proof["migrationMode"], "none")
                if failure is None:
                    self.assertEqual(proof["resourcesProofSha256"], operator.sha(resources))
                    self.assertEqual(proof["status"], "passed")

    def test_cli_default_required_plan_retains_migrating_job_and_legacy_baseline(self):
        before, names = baseline(), operator.names("20260929")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "proof.json"
            with patch.object(operator, "read_proof", return_value=before), patch.object(operator, "same_live"), \
                 patch.object(operator, "stage_identity", return_value=(names, {"image": "image"}, "private-url", {})), \
                 patch.object(operator, "cloud", side_effect=AssertionError("network_forbidden")), \
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(operator.main(["stage-plan", "--snapshot", "snapshot.json", "--evidence", str(path)]), 0)
            proof = json.loads(path.read_text())
            self.assertEqual(proof["migrationMode"], "required")
            self.assertEqual(proof["job"]["spec"]["template"]["spec"]["template"]["spec"]["containers"][0]["args"],
                             ["-m", "app.migrations"])

    def test_none_resources_create_only_isolated_check_job_after_stage_ledger_gate(self):
        before = {**baseline(), "inventory": full_inventory()}
        names, artifact, branch = operator.names("20261005"), {"image": "image"}, {"id": "branch"}
        for invalid_stage in (False, True):
            current = full_inventory()
            if invalid_stage: current["migrationCount"] = 21
            calls = []
            def cloud(*args, **kwargs):
                calls.append((args, kwargs))
                if args[:3] == ("secrets", "versions", "add"):
                    return {"name": "projects/fixture/secrets/" + args[3] + "/versions/1"}
                return {}
            with self.subTest(invalid_stage=invalid_stage), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "proof.json"
                with patch.object(operator, "read_proof", return_value=before), patch.object(operator, "same_live"), \
                     patch.object(operator, "stage_identity", return_value=(names, artifact, "private-url", branch)), \
                     patch.object(operator, "assert_new_resources"), patch.object(operator, "inventory", return_value=current), \
                     patch.object(operator, "cloud", side_effect=cloud), contextlib.redirect_stdout(io.StringIO()):
                    result = operator.main(["stage-resources", "--migration-mode", "none", "--allow-stage-mutations",
                        "--snapshot", "snapshot.json", "--run-id", "20261005", "--evidence", str(path)])
                self.assertEqual(result, 1 if invalid_stage else 0)
                if invalid_stage:
                    self.assertEqual(calls, [])
                else:
                    self.assertEqual(len(calls), 7)
                    self.assertFalse(any("execute" in args for args, _ in calls))
                    jobs = [kwargs for args, kwargs in calls if args[:3] == ("run", "jobs", "replace")]
                    self.assertEqual(len(jobs), 1)
                    job = json.loads(jobs[0]["input_text"])
                    self.assertEqual(job["spec"]["template"]["spec"]["template"]["spec"]["containers"][0]["args"],
                                     ["-m", "app.migrations", "--check"])

    def test_none_stage_service_requires_matching_successful_check_and_unchanged_data(self):
        before = {**baseline(), "inventory": full_inventory()}
        names, artifact, branch = operator.names("20261005"), {"image": "image"}, {"id": "branch"}
        resources = {"migrationMode": "none", "runId": "20261005", "resources": names, "artifact": artifact,
                     "branch": branch, "baselineSha256": operator.sha(before), "beforeInventory": full_inventory()}
        checked = {**resources, "resourcesProofSha256": operator.sha(resources), "afterInventory": full_inventory()}
        job = operator.job_document(before, names, "image", "none")
        stage = {"status": {"url": "https://stage.example", "latestReadyRevisionName": names["service"] + "-00001"}}
        for failure in (None, "mode", "hash", "baseline", "check-data", "current-data"):
            prerequisite, current = copy.deepcopy(checked), full_inventory()
            if failure == "mode": prerequisite["migrationMode"] = "required"
            if failure == "hash": prerequisite["resourcesProofSha256"] = "bad"
            if failure == "baseline": prerequisite["baselineSha256"] = "bad"
            if failure == "check-data": prerequisite["afterInventory"]["accountCredentialsSha256"] = "e" * 64
            if failure == "current-data": current["auditCount"] += 1
            calls = []
            def cloud(*args, **kwargs):
                calls.append(args)
                if args[:3] == ("run", "jobs", "describe"): return job
                if args[:3] == ("run", "services", "list"): return []
                if args[:3] == ("run", "services", "replace"): return {}
                if args[:3] == ("run", "services", "describe"): return stage
                raise AssertionError("unexpected_remote_call")
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "proof.json"
                with patch.object(operator, "read_proof", side_effect=[before, resources, prerequisite]), \
                     patch.object(operator, "same_live"), patch.object(operator, "stage_identity", return_value=(names, artifact, "private-url", branch)), \
                     patch.object(operator, "inventory", return_value=current), patch.object(operator, "cloud", side_effect=cloud), \
                     patch.object(operator, "verify_stage_service"), patch.object(operator, "copy_stage_invoker_policy", return_value={}), \
                     contextlib.redirect_stdout(io.StringIO()):
                    result = operator.main(["stage-service", "--migration-mode", "none", "--allow-stage-mutations",
                        "--snapshot", "snapshot.json", "--resources-proof", "resources.json", "--check-proof", "checked.json",
                        "--run-id", "20261005", "--evidence", str(path)])
                self.assertEqual(result, 0 if failure is None else 1)
                self.assertEqual(sum(args[:3] == ("run", "services", "replace") for args in calls), 1 if failure is None else 0)
                self.assertFalse(any(args[:3] == ("run", "jobs", "execute") for args in calls))
                if failure is None:
                    proof = json.loads(path.read_text())
                    self.assertEqual(proof["checkProofSha256"], operator.sha(checked))
                    self.assertEqual(proof["hostingConfiguration"]["hosting"]["rewrites"][0]["run"]["serviceId"], names["service"])

    def test_target_matches_neon_endpoint_and_never_production(self):
        env = {"REPORT_RELEASE_STAGE_METADATA": json.dumps(metadata()),
               "REPORT_RELEASE_STAGE_DATABASE_URL": "postgresql://test:fixture@ep-isolated-pooler.example.neon.tech/neondb?sslmode=require"}
        with patch.dict(os.environ, env):
            url, branch = operator.stage_target(baseline(), "20260929")
        self.assertNotIn("fixture", json.dumps(branch))
        self.assertTrue(url.startswith("postgresql:"))
        for mutate in (lambda d: d["branch"].update(default=True), lambda d: d["branch"].update(primary=True),
                       lambda d: d["branch"].update(parent_id="wrong"), lambda d: d["endpoint"].update(branch_id="wrong"),
                       lambda d: d["endpoint"].update(type="read_only"), lambda d: d["branch"].update(name="unowned")):
            data = metadata()
            mutate(data)
            with patch.dict(os.environ, {**env, "REPORT_RELEASE_STAGE_METADATA": json.dumps(data)}), self.assertRaises(RuntimeError):
                operator.stage_target(baseline(), "20260929")
        bad = baseline()
        bad["databaseHostSha256"] = operator.sha("ep-isolated.example.neon.tech")
        with patch.dict(os.environ, env), self.assertRaises(RuntimeError):
            operator.stage_target(bad, "20260929")

    def test_url_rejects_different_database_or_transport_overrides(self):
        for value in ("postgresql://u:p@x/other?sslmode=require", "postgresql://u:p@x/neondb",
                      "postgresql://u:p@x/neondb?sslmode=require&hostaddr=1.2.3.4", "postgresql://u:p@x:9999/neondb?sslmode=require"):
            with self.assertRaises(RuntimeError):
                operator.validate_url(value)

    def test_migration_preserves_credentials_and_exact_recovery_backfill(self):
        before = {"migrationCount": 21, "immutableSubmissionsSha256": "reports", "accountCredentialsSha256": "passwords",
                  "submissionCount": 17, "templateCount": 15, "userCounts": [3], "auditCount": 90}
        after = {**before, "migrationCount": 22, "migrationHead": "0022_worker_password_recovery", "recoverySchema": {
            "columnsPresent": ["auth_generation", "legacy_auth_allowed", "password_recovery_generation"],
            "tablePresent": True, "recoveryRowCount": 0, "nullSecurityStateCount": 0,
            "accountCount": 3, "zeroAuthGenerationCount": 3, "zeroRecoveryGenerationCount": 3, "legacyAllowedCount": 3}}
        operator.assert_preserved(before, after)
        for mutate in (lambda d: d.update(accountCredentialsSha256="changed"), lambda d: d.update(immutableSubmissionsSha256="changed"),
                       lambda d: d["recoverySchema"].update(recoveryRowCount=1), lambda d: d["recoverySchema"].update(legacyAllowedCount=2),
                       lambda d: d["recoverySchema"].update(zeroAuthGenerationCount=2)):
            bad = copy.deepcopy(after)
            mutate(bad)
            with self.assertRaises(RuntimeError):
                operator.assert_preserved(before, bad)

    def test_command_failure_redacts_external_output(self):
        result = SimpleNamespace(returncode=1, stdout="postgresql://secret", stderr="password private")
        with patch.object(operator.shutil, "which", return_value="gcloud"), patch.object(operator.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(RuntimeError, "^external_command_failed$"):
                operator.command("gcloud", ["anything"])

    def test_child_environment_removes_libpq_and_stage_secrets(self):
        with patch.dict(os.environ, {"PGHOSTADDR": "host", "PGSERVICE": "foreign", "REPORT_RELEASE_STAGE_DATABASE_URL": "secret"}):
            result = operator.environment()
        self.assertNotIn("PGHOSTADDR", result)
        self.assertNotIn("PGSERVICE", result)
        self.assertNotIn("REPORT_RELEASE_STAGE_DATABASE_URL", result)

    def test_iam_copy_uses_exact_binding_arguments_not_policy_stdin(self):
        calls = []
        policies = iter(({"bindings": [{"role": "roles/run.invoker", "members": ["allUsers"]}]},
                         {"etag": "empty"}, {"bindings": [{"role": "roles/run.invoker", "members": ["allUsers"]}]}))
        def cloud(*args, **kwargs):
            calls.append((args, kwargs))
            return next(policies) if "get-iam-policy" in args else {}
        with patch.object(operator, "cloud", side_effect=cloud):
            proof = operator.copy_stage_invoker_policy(operator.names("20260929"), lambda _: None)
        mutations = [args for args, _ in calls if "add-iam-policy-binding" in args]
        self.assertEqual(len(mutations), 1)
        self.assertEqual(mutations[0][3], "geo-report-stage-20260929")
        self.assertIn("allUsers", mutations[0])
        self.assertIn("--condition=None", mutations[0])
        self.assertFalse(any("set-iam-policy" in args for args, _ in calls))
        self.assertTrue(proof["exactInvokerPolicyVerified"])

    def test_iam_copy_refuses_unexpected_existing_permissions(self):
        policies = iter(({"bindings": [{"role": "roles/run.invoker", "members": ["allUsers"]}]},
                         {"bindings": [{"role": "roles/run.admin", "members": ["allUsers"]}]}))
        with patch.object(operator, "cloud", side_effect=lambda *a, **k: next(policies)), self.assertRaises(RuntimeError):
            operator.copy_stage_invoker_policy(operator.names("20260929"), lambda _: None)

    def test_resume_requires_exact_failed_boundary_and_owned_creation(self):
        before, resources = baseline(), operator.names("20260929")
        artifact, branch = {"image": "image", "sourceCommit": "a" * 40}, {"id": "stage"}
        args = SimpleNamespace(run_id="20260929")
        failed = {"schemaVersion": 1, "phase": "stage-service", "status": "failed", "failureCode": "external_command_failed",
                  "baselineSha256": operator.sha(before), "runId": args.run_id, "artifact": artifact, "branch": branch,
                  "resources": resources, "startedAtUtc": "2026-09-29T00:00:00Z", "finishedAtUtc": "2026-09-29T00:01:00Z",
                  "attempts": [{"action": "create_service:" + resources["service"]}, {"action": "copy_invoker_policy:" + resources["service"]}]}
        stage = {"metadata": {"creationTimestamp": "2026-09-29T00:00:30Z"}}
        operator.verify_failed_service_resume(failed, args, before, artifact, branch, resources, stage)
        for mutate in (lambda d: d.update(status="passed"), lambda d: d.update(baselineSha256="other"),
                       lambda d: d.update(branch={"id": "other"}), lambda d: d.update(attempts=[]),
                       lambda d: d.update(startedAtUtc="2026-09-29T00:00:40Z")):
            bad = copy.deepcopy(failed)
            mutate(bad)
            with self.assertRaises(RuntimeError):
                operator.verify_failed_service_resume(bad, args, before, artifact, branch, resources, stage)

    def test_verified_service_rejects_runtime_and_image_drift(self):
        before, resources = baseline(), operator.names("20260929")
        stage = operator.service_document(before, resources, "image")
        stage["status"] = {"conditions": [{"type": "Ready", "status": "True"}], "latestReadyRevisionName": "stage-00001",
                           "latestCreatedRevisionName": "stage-00001", "traffic": [{"revisionName": "stage-00001", "percent": 100}]}
        with patch.object(operator, "cloud", return_value={"status": {"imageDigest": "image"}}):
            operator.verify_stage_service(stage, before, resources, "image")
            bad = copy.deepcopy(stage)
            bad["spec"]["template"]["spec"]["containers"][0]["env"][0]["valueFrom"]["secretKeyRef"]["name"] = "production-db"
            with self.assertRaises(RuntimeError):
                operator.verify_stage_service(bad, before, resources, "image")
        with patch.object(operator, "cloud", return_value={"status": {"imageDigest": "other"}}), self.assertRaises(RuntimeError):
            operator.verify_stage_service(stage, before, resources, "image")


if __name__ == "__main__":
    unittest.main(verbosity=2)
