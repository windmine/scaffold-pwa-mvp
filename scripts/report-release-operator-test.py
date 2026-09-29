"""No-network guard/plan regressions for the staging-only release operator."""
import copy
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
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
