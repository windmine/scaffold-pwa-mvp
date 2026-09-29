"""No-network tests for one explicitly authorized post-drain Neon backup."""
import copy
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


backup = load("production_backup", "report-production-backup.py")
fixtures = load("cutover_fixtures", "report-production-cutover-test.py")
operator, cutover = backup.operator, backup.cutover
ARTIFACT = fixtures.ARTIFACT
PROD_URL = "postgresql://user:private-password@ep-production.example.neon.tech/neondb?sslmode=require"
BACKUP_URL = "postgresql://user:backup-private-password@ep-backup.example.neon.tech/neondb?sslmode=require"


def branch(at=None):
    at = at or datetime.now(timezone.utc)
    return {"id": "br-owned-backup", "name": backup.NAME, "project_id": operator.NEON_PROJECT,
            "parent_id": operator.NEON_PARENT, "default": False, "primary": False,
            "created_at": at.isoformat(), "expires_at": (at + timedelta(days=7)).replace(microsecond=0).isoformat(),
            "current_state": "ready"}


def endpoint():
    return {"id": "ep-backup", "project_id": operator.NEON_PROJECT, "branch_id": "br-owned-backup",
            "host": "ep-backup.example.neon.tech", "type": "read_only"}


class BackupTests(unittest.TestCase):
    def test_explicit_authority_precedes_any_read_or_write(self):
        with patch.object(operator, "command") as command, patch.object(operator, "candidate") as candidate:
            with self.assertRaisesRegex(RuntimeError, "explicit_backup_creation_flag_required"):
                backup.run(SimpleNamespace(allow_backup_create=False))
            command.assert_not_called()
            candidate.assert_not_called()

    def test_branch_is_exact_new_owned_after_drain_with_seven_day_expiry(self):
        at = datetime.now(timezone.utc)
        valid = branch(at)
        expiry = cutover.utc(valid["expires_at"])
        backup.validate_branch(valid, valid["id"], at, expiry, at - timedelta(seconds=1))
        for key, value in (("id", operator.NEON_PARENT), ("name", "other"), ("parent_id", "br-wrong"),
                           ("project_id", "other"), ("default", True), ("primary", True),
                           ("created_at", (at - timedelta(seconds=10)).isoformat()),
                           ("expires_at", (at + timedelta(days=1)).isoformat()), ("current_state", "failed")):
            bad = {**valid, key: value}
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                backup.validate_branch(bad, bad["id"], at, expiry, at - timedelta(seconds=1))

    def test_backup_endpoint_is_read_only_on_exact_separate_host(self):
        baseline = fixtures.inputs()[0]
        proof = backup.validate_endpoint(endpoint(), "br-owned-backup", BACKUP_URL, baseline)
        self.assertEqual(proof, {"id": "ep-backup", "type": "read_only", "hostSha256": operator.sha("ep-backup.example.neon.tech")})
        for key, value in (("branch_id", operator.NEON_PARENT), ("project_id", "wrong"),
                           ("type", "read_write"), ("host", "other.example.neon.tech"), ("id", "")):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                backup.validate_endpoint({**endpoint(), key: value}, "br-owned-backup", BACKUP_URL, baseline)
        with self.assertRaises(RuntimeError):
            backup.validate_endpoint({**endpoint(), "host": "ep-production.example.neon.tech"}, "br-owned-backup", PROD_URL, baseline)

    def test_exact_readonly_0021_schema_is_required(self):
        valid = {"status": "passed", "transactionReadOnly": True, "migrationHead": "0021_worker_invitations",
                 "migrationCount": 21, "ledgerMatchesBundledPrefix": True,
                 "recoverySchema": {"columnsPresent": [], "tablePresent": False}}
        backup.assert_pre_migration(valid)
        for key, value in (("status", "failed"), ("transactionReadOnly", False), ("migrationCount", 22),
                           ("migrationHead", "0022_worker_password_recovery"), ("ledgerMatchesBundledPrefix", False),
                           ("recoverySchema", {"columnsPresent": ["auth_generation"], "tablePresent": False}),
                           ("recoverySchema", {"columnsPresent": [], "tablePresent": True})):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                backup.assert_pre_migration({**valid, key: value})

    def exercise(self, directory, *, fail_create=False, collision=False, inventory_drift=False,
                 short_drain=False, maintenance_drift=False, malformed_list=False):
        fixture = fixtures.CutoverTests().phase_fixture(directory, "migrate")
        args = fixture.args
        args.allow_backup_create = True
        args.evidence = directory / "new-backup.json"
        fixture.before["recoverySchema"] = {"columnsPresent": [], "tablePresent": False}
        if short_drain:
            fixture.pause["drainUntilUtc"] = (datetime.now(timezone.utc) + timedelta(seconds=300)).isoformat()
            args.pause_proof.write_text(json.dumps(fixture.pause), encoding="utf-8")
        calls, created = [], {}
        inventories = 0

        def inventory(url):
            nonlocal inventories
            inventories += 1
            self.assertIn(url, (PROD_URL, BACKUP_URL))
            value = copy.deepcopy(fixture.before)
            if inventory_drift and url == BACKUP_URL:
                value["accountCredentialsSha256"] = "changed"
            return value

        def cloud(*args, **kwargs):
            calls.append(args)
            self.assertNotIn(args[2], ("replace", "execute", "update-traffic", "delete", "add-iam-policy-binding"))
            if args[1:3] == ("services", "describe"):
                service = copy.deepcopy(fixture.maintenance_service)
                if maintenance_drift:
                    service["status"]["traffic"][0]["tag"] = "unapproved"
                return service
            if args[1:3] == ("services", "get-iam-policy"):
                return fixture.iam
            if args[1:3] == ("revisions", "describe"):
                return {"metadata": {"name": cutover.MAINTENANCE_REVISION},
                        "spec": fixture.prepared_service["spec"]["template"]["spec"],
                        "status": {"imageDigest": ARTIFACT["image"], "conditions": [{"type": "Ready", "status": "True"}]}}
            if args[1:3] == ("jobs", "describe"):
                return cutover.migration_job_document(fixture.baseline, ARTIFACT["image"])
            if args[1:3] == ("jobs", "executions"):
                return []
            self.fail(f"Unexpected cloud command: {args}")

        def neon(*args, **kwargs):
            calls.append(args)
            if args[:3] == ("branch", "get", operator.NEON_PARENT):
                return {"id": operator.NEON_PARENT, "project_id": operator.NEON_PROJECT,
                        "default": True, "primary": True, "current_state": "ready"}
            if args[:2] == ("branch", "list"):
                return {} if malformed_list else [{"name": backup.NAME}] if collision else []
            if args[:2] == ("branch", "create"):
                journal = json.loads(args_path.read_text())
                self.assertTrue(journal["createAttempted"])
                self.assertEqual(len(journal["attempts"]), 1)
                self.assertEqual(args[args.index("--parent") + 1], operator.NEON_PARENT)
                self.assertEqual(args[args.index("--name") + 1], backup.NAME)
                self.assertEqual(args[args.index("--type") + 1], "read_only")
                if fail_create:
                    raise RuntimeError("private-password postgres://secret raw failure")
                created.update(branch())
                created["expires_at"] = args[args.index("--expires-at") + 1]
                return {"branch": created}
            if args[:2] == ("branch", "get"):
                return created
            if args[:1] == ("api",):
                return {"endpoints": [endpoint()]}
            if args[:1] == ("connection-string",):
                self.assertEqual(args[args.index("--endpoint-type") + 1], "read_only")
                self.assertFalse(kwargs["json_output"])
                return BACKUP_URL
            self.fail(f"Unexpected Neon command: {args}")

        args_path = args.evidence
        output = io.StringIO()
        with patch.object(operator, "cloud", side_effect=cloud), patch.object(operator, "candidate", return_value=ARTIFACT), \
                patch.object(operator, "inventory", side_effect=inventory), patch.object(operator, "read_secret", return_value=PROD_URL), \
                patch.object(backup, "neon", side_effect=neon), redirect_stdout(output):
            if short_drain:
                with self.assertRaisesRegex(RuntimeError, "drain_deadline_not_reached"):
                    backup.run(args)
                self.assertFalse(args_path.exists())
                self.assertEqual(calls, [])
                return
            result = backup.run(args)
        proof = json.loads(args_path.read_text())
        self.assertNotIn("private-password", output.getvalue() + json.dumps(proof))
        self.assertFalse(any("delete" in call for call in calls))
        return result, proof, calls, inventories, fixture

    def test_success_contract_one_journaled_create_and_four_readonly_inventory_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            result, proof, calls, inventories, fixture = self.exercise(Path(directory))
        self.assertEqual(result, 0)
        self.assertEqual(proof["status"], "passed")
        self.assertEqual(len([call for call in calls if call[:2] == ("branch", "create")]), 1)
        self.assertEqual(inventories, 4)
        self.assertFalse(proof["productionDatabaseWrites"])
        self.assertFalse(proof["branchDeletionAttempted"])
        cutover.validate_backup(proof, fixture.pause, ARTIFACT, fixture.baseline, fixture.before)

    def test_uncertain_create_is_journaled_once_without_retry_or_secret_echo(self):
        with tempfile.TemporaryDirectory() as directory:
            result, proof, calls, _, _ = self.exercise(Path(directory), fail_create=True)
        self.assertEqual(result, 1)
        self.assertEqual(proof["failureCode"], "RuntimeError")
        self.assertEqual(len(proof["attempts"]), 1)
        self.assertEqual(len([call for call in calls if call[:2] == ("branch", "create")]), 1)

    def test_name_collision_malformed_list_and_live_tag_prevent_create(self):
        for option in ("collision", "malformed_list", "maintenance_drift"):
            with self.subTest(option=option), tempfile.TemporaryDirectory() as directory:
                result, proof, calls, _, _ = self.exercise(Path(directory), **{option: True})
            self.assertEqual(result, 1)
            self.assertEqual(proof["attempts"], [])
            self.assertFalse(any(call[:2] == ("branch", "create") for call in calls))

    def test_drain_refuses_before_resource_access(self):
        with tempfile.TemporaryDirectory() as directory:
            self.exercise(Path(directory), short_drain=True)

    def test_inventory_drift_fails_and_retains_new_branch_without_deletion(self):
        with tempfile.TemporaryDirectory() as directory:
            result, proof, _, _, _ = self.exercise(Path(directory), inventory_drift=True)
        self.assertEqual(result, 1)
        self.assertEqual(proof["failureCode"], "drained_inventory_changed")
        self.assertEqual(proof["createdBranchId"], "br-owned-backup")
        self.assertFalse(proof["branchDeletionAttempted"])

    def test_neon_cli_is_pinned_and_captures_output(self):
        with patch.object(operator, "command", return_value={}) as command:
            backup.neon("branch", "list", "--project-id", operator.NEON_PROJECT)
        command.assert_called_once_with("npx", ["-y", "neon@2.32.0", "branch", "list", "--project-id", operator.NEON_PROJECT,
                                               "--no-analytics", "-o", "json"], json_output=True, timeout=120)


if __name__ == "__main__":
    unittest.main(verbosity=2)
