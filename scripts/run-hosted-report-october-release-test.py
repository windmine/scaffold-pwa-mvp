"""Offline wrapper guards; only synthetic manifests, credentials and child output."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


wrapper = module("october_release", "run-hosted-report-october-release.py")
helper = module("report_release", "run-hosted-report-release.py")
RUN_ID = "october-local-guard"
PASSWORD = "synthetic-supervisor-secret"
EMAIL = "synthetic-supervisor@example.invalid"


def fixtures():
    manifest = {"runId": helper.DEMO_RUN_ID, "origin": helper.LIVE, "departmentId": 2,
                "accounts": {"supervisor": {"id": 16, "departmentId": 2, "role": "supervisor",
                                              "email": EMAIL, "isGlobalAdmin": False}}}
    # No Worker credentials exist in the fixture: the wrapper must not need or
    # inspect any existing Worker when preparing its child environment.
    handoff = {"runId": helper.DEMO_RUN_ID, "origin": helper.LIVE,
               "accounts": {"supervisor": {"email": EMAIL, "password": PASSWORD}}}
    return manifest, handoff


def proof():
    return {"schemaVersion": 1, "runId": RUN_ID, "origin": helper.LIVE,
            "status": "passed", "checks": ["synthetic-safe-check"], "cleanup": {"failures": []}}


class OctoberWrapperTests(unittest.TestCase):
    def setUp(self):
        blocked = patch.object(wrapper.subprocess, "run", side_effect=AssertionError("external_process_forbidden"))
        self.addCleanup(blocked.stop)
        blocked.start()

    def test_only_exact_supervisor_credentials_reach_sanitized_child_environment(self):
        manifest, handoff = fixtures()
        inherited = {"PATH": "synthetic-path", "HOSTED_REPORT_WORKER_PASSWORD": "worker-secret",
                     "hosted_october_supervisor_password": "inherited-secret", "HOSTED_UX_TOKEN": "token",
                     "PGPASSWORD": "database-secret", "NODE_OPTIONS": "--inspect",
                     "NODE_DEBUG": "*", "DEBUG": "*", "PWDEBUG": "1"}
        with patch.dict(wrapper.os.environ, inherited, clear=True):
            env = wrapper.child_environment(helper, helper.LIVE, Path("synthetic-evidence"), manifest, handoff)
        hosted = {key: value for key, value in env.items() if key.upper().startswith("HOSTED_")}
        self.assertEqual(hosted, {
            "HOSTED_OCTOBER_ORIGIN": helper.LIVE, "HOSTED_OCTOBER_EVIDENCE_DIR": "synthetic-evidence",
            "HOSTED_REPORT_ALLOWED_HOST": f"{helper.PROJECT}.web.app",
            "HOSTED_OCTOBER_SUPERVISOR_EMAIL": EMAIL, "HOSTED_OCTOBER_SUPERVISOR_PASSWORD": PASSWORD,
        })
        self.assertEqual(env["PATH"], "synthetic-path")
        self.assertEqual({key: env[key] for key in ("DEBUG", "NODE_DEBUG", "PWDEBUG")},
                         {"DEBUG": "", "NODE_DEBUG": "", "PWDEBUG": "0"})
        self.assertNotIn("NODE_OPTIONS", env)
        self.assertFalse(any(key.upper().startswith("PG") for key in env))
        self.assertNotIn("worker-secret", env.values())

    def test_foreign_manifest_handoff_or_supervisor_is_refused(self):
        mutations = (
            lambda m, h: m.update(runId="other"), lambda m, h: h.update(origin="https://other.example"),
            lambda m, h: m.update(departmentId=1), lambda m, h: m["accounts"]["supervisor"].update(id=13),
            lambda m, h: m["accounts"]["supervisor"].update(departmentId=1),
            lambda m, h: m["accounts"]["supervisor"].update(role="worker"),
            lambda m, h: m["accounts"]["supervisor"].update(isGlobalAdmin=True),
            lambda m, h: h["accounts"]["supervisor"].update(email="foreign@example.invalid"),
            lambda m, h: h["accounts"]["supervisor"].update(password="short"),
            lambda m, h: h["accounts"]["supervisor"].update(password=123456789),
        )
        for mutate in mutations:
            manifest, handoff = fixtures()
            mutate(manifest, handoff)
            with self.subTest(mutation=mutate), self.assertRaises(RuntimeError):
                wrapper.child_environment(helper, helper.LIVE, Path("unused"), manifest, handoff)

    def test_invalid_configuration_is_refused_before_private_handoff_or_runner(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            existing = root / "docs/evidence/existing"
            existing.mkdir(parents=True)
            base = ["--origin", helper.LIVE, "--run-id", RUN_ID, "--evidence-subdir", "new-run"]
            variants = [
                ["--origin", "https://foreign.example", *base[2:]],
                ["--origin", "http://geo-attendance-system-db9ca.web.app", *base[2:]],
                [*base[:2], "--run-id", "../bad", *base[4:]],
                [*base[:4], "--evidence-subdir", "existing"],
                [*base[:4], "--evidence-subdir", "."],
                [*base[:4], "--evidence-subdir", "../../outside"],
                [*base[:4], "--evidence-subdir", str(root / "absolute")],
            ]
            with patch.object(wrapper, "ROOT", root), patch.object(helper, "ROOT", root), \
                 patch.object(wrapper, "module_at", return_value=helper) as load:
                for args in variants:
                    with self.subTest(args=args), self.assertRaises(RuntimeError):
                        wrapper.main(args)
                self.assertEqual(load.call_count, len(variants))
                self.assertTrue(all(call.args[0] == "hosted_report_release" for call in load.call_args_list))
        wrapper.subprocess.run.assert_not_called()

    def test_missing_node_does_not_decrypt_handoff_or_start_runner(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(wrapper, "ROOT", root), patch.object(helper, "ROOT", root), \
                 patch.object(wrapper, "module_at", return_value=helper) as load, patch.object(wrapper.shutil, "which", return_value=None):
                with self.assertRaisesRegex(RuntimeError, "node_runtime_required"):
                    wrapper.main(["--origin", helper.LIVE, "--run-id", RUN_ID, "--evidence-subdir", "new-run"])
            load.assert_called_once()
        wrapper.subprocess.run.assert_not_called()

    def test_runner_is_opted_in_without_timeout_and_only_scrubbed_summary_is_printed(self):
        manifest, handoff = fixtures()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = root / f"docs/evidence/presentation-{helper.DEMO_RUN_ID}.json"
            manifest_path.parent.mkdir(parents=True)
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            evidence = root / "docs/evidence/october/hosted"
            demo = SimpleNamespace(read_private_handoff=Mock(return_value=handoff))
            def child(command, **options):
                self.assertEqual(command, ["synthetic-node", str(root / "scripts/check-hosted-report-october-release.mjs"),
                                           "--allow-hosted-mutations", "--run-id", RUN_ID])
                self.assertNotIn(PASSWORD, command)
                self.assertNotIn("timeout", options)
                self.assertEqual(options["stdin"], subprocess.DEVNULL)
                self.assertTrue(options["capture_output"])
                self.assertFalse(options["check"])
                self.assertEqual(options["env"]["HOSTED_OCTOBER_SUPERVISOR_PASSWORD"], PASSWORD)
                self.assertEqual(options["env"]["HOSTED_OCTOBER_EVIDENCE_DIR"], str(evidence))
                evidence.mkdir(parents=True)
                data = {**proof(), "sensitiveDiagnostic": PASSWORD}
                (evidence / "evidence.json").write_text(json.dumps(data), encoding="utf-8")
                (evidence / "evidence.txt").write_text("synthetic summary", encoding="utf-8")
                return subprocess.CompletedProcess(command, 0, stdout=PASSWORD, stderr="hidden-worker-secret")
            output = io.StringIO()
            with patch.object(wrapper, "ROOT", root), patch.object(helper, "ROOT", root), \
                 patch.object(wrapper, "module_at", side_effect=[helper, demo]), patch.object(wrapper.shutil, "which", return_value="synthetic-node"), \
                 patch.object(wrapper.subprocess, "run", side_effect=child) as run, contextlib.redirect_stdout(output):
                self.assertEqual(wrapper.main(["--origin", helper.LIVE + "/", "--run-id", RUN_ID,
                                               "--evidence-subdir", "october/hosted"]), 0)
            run.assert_called_once()
            demo.read_private_handoff.assert_called_once_with(helper.DEMO_RUN_ID)
            summary = json.loads(output.getvalue())
            self.assertEqual(summary["status"], "passed")
            self.assertEqual(summary["runnerExitCode"], 0)
            self.assertEqual(summary["checkpoints"], 1)
            self.assertEqual(summary["cleanupFailures"], 0)
            self.assertEqual(summary["evidence"], "docs/evidence/october/hosted/evidence.json")
            self.assertEqual(summary["evidenceText"], "docs/evidence/october/hosted/evidence.txt")
            self.assertNotIn(PASSWORD, output.getvalue())
            self.assertNotIn("hidden-worker-secret", output.getvalue())

    def test_pass_requires_exact_evidence_identity_schema_exit_and_clean_cleanup(self):
        mutations = (
            lambda d: d.update(schemaVersion=2), lambda d: d.update(runId="other"),
            lambda d: d.update(origin="https://other.example"), lambda d: d.update(status="failed"),
            lambda d: d.update(checks="sensitive-diagnostics"), lambda d: d.update(cleanup={}),
            lambda d: d.update(cleanup={"failures": [PASSWORD]}), lambda d: d.update(cleanup="sensitive-diagnostics"),
        )
        with tempfile.TemporaryDirectory() as directory, patch.object(wrapper, "ROOT", Path(directory)):
            target = Path(directory) / "docs/evidence/guard"
            target.mkdir(parents=True)
            for mutate in mutations:
                data = copy.deepcopy(proof())
                mutate(data)
                (target / "evidence.json").write_text(json.dumps(data), encoding="utf-8")
                with self.subTest(mutation=mutate):
                    summary = wrapper.runner_summary(SimpleNamespace(returncode=0), target, RUN_ID, helper.LIVE)
                    self.assertEqual(summary["status"], "failed")
                    self.assertNotIn(PASSWORD, json.dumps(summary))
            (target / "evidence.json").write_text(json.dumps(proof()), encoding="utf-8")
            summary = wrapper.runner_summary(SimpleNamespace(returncode=9), target, RUN_ID, helper.LIVE)
            self.assertEqual(summary["status"], "failed")
            self.assertEqual(summary["runnerExitCode"], 9)

    def test_missing_or_malformed_evidence_fails_without_exposing_contents(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(wrapper, "ROOT", Path(directory)):
            target = Path(directory) / "docs/evidence/guard"
            target.mkdir(parents=True)
            for contents in (None, "invalid " + PASSWORD, "null", '"sensitive"', "[]"):
                if contents is not None:
                    (target / "evidence.json").write_text(contents, encoding="utf-8")
                summary = wrapper.runner_summary(SimpleNamespace(returncode=0), target, RUN_ID, helper.LIVE)
                self.assertEqual(summary["status"], "failed")
                self.assertNotIn(PASSWORD, json.dumps(summary))

    def test_third_party_exceptions_including_lowercase_runtime_secrets_are_scrubbed(self):
        for error in (RuntimeError(PASSWORD), RuntimeError("synthetic_secret_lowercase"),
                      ValueError(PASSWORD), OSError(PASSWORD)):
            output = io.StringIO()
            with patch.object(wrapper, "main", side_effect=error), contextlib.redirect_stdout(output):
                self.assertEqual(wrapper.cli([]), 1)
            self.assertEqual(json.loads(output.getvalue()),
                             {"status": "refused", "safeFailure": "configuration_or_runner_failure"})
        output = io.StringIO()
        with patch.object(wrapper, "main", side_effect=RuntimeError("invalid_run_id")), contextlib.redirect_stdout(output):
            self.assertEqual(wrapper.cli([]), 1)
        self.assertEqual(json.loads(output.getvalue())["safeFailure"], "invalid_run_id")


if __name__ == "__main__":
    unittest.main(verbosity=2)
