"""No-network lifecycle checks for the disposable provider smoke harness."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("provider_smoke", Path(__file__).with_name("report-provider-smoke.py"))
smoke = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(smoke)


class Rows:
    def __init__(self, rows):
        self.rows = rows
    def fetchall(self):
        return self.rows
    def fetchone(self):
        return self.rows[0]


class Control:
    def __init__(self, fail_marker=False):
        self.database = None
        self.marker = None
        self.closed = False
        self.commands = []
        self.fail_marker = fail_marker
    def execute(self, query, parameters=None):
        value = query if isinstance(query, str) else query.as_string(None)
        self.commands.append((value, parameters))
        if value == "SELECT current_database()":
            return Rows([("neondb",)])
        if value == "SELECT current_user":
            return Rows([("fixture_owner",)])
        if value.startswith("CREATE DATABASE"):
            self.database = value.split('"')[1]
        elif value.startswith("COMMENT ON DATABASE"):
            if self.fail_marker:
                raise RuntimeError("fixture_marker_failed")
            self.marker = value.split(" IS '")[1][:-1]
        elif value.startswith("SELECT datname"):
            return Rows([(self.database, "fixture_owner", self.marker)])
        elif value.startswith("SELECT 1 FROM pg_database"):
            return Rows([(1,)] if self.database else [])
        elif value.startswith("DROP DATABASE"):
            if value.split('"')[1] != self.database:
                raise AssertionError("wrong database cleanup")
            self.database = None
        return Rows([])
    def close(self):
        self.closed = True


class Process:
    def __init__(self, *_, **__):
        self.running = True
    def poll(self):
        return None if self.running else 0
    def terminate(self):
        self.running = False
    def wait(self, **_):
        return 0


class SmokeTests(unittest.TestCase):
    def test_url_replaces_only_owned_database(self):
        original = "postgresql://u:p@stage.example/neondb?sslmode=require"
        self.assertEqual(smoke.fresh_database_url(original, "report_smoke_nonce"),
                         "postgresql://u:p@stage.example/report_smoke_nonce?sslmode=require")
        for value in ("neondb", "postgres", "report_smoke_bad/path", "report_smoke_x;DROP", "report_smoke_" + "x" * 70):
            with self.assertRaises(RuntimeError):
                smoke.fresh_database_url(original, value)

    def fixture(self, smoke_exit=0, fail_marker=False):
        control = Control(fail_marker)
        with tempfile.TemporaryDirectory(prefix="provider-smoke-contract-") as directory:
            args = SimpleNamespace(allow_stage_mutations=True, snapshot=Path(directory) / "snapshot.json",
                                   evidence=Path(directory) / "proof.json", run_id="20260929", source_commit="a" * 40, image="image")
            result = SimpleNamespace(returncode=smoke_exit, stdout="\n".join("ok - fixed checkpoint" for _ in range(214)), stderr="private credential")
            ready = json.dumps({"status": "ok", "checks": {k: "ok" for k in ("database", "migrations", "upload_storage")}}).encode()
            with patch.object(smoke.operator, "read_proof", return_value={}), patch.object(smoke.operator, "same_live"), \
                    patch.object(smoke.operator, "stage_target", return_value=("postgresql://u:p@stage.example/neondb?sslmode=require", {"id": "stage"})), \
                    patch.object(smoke.operator, "candidate", return_value={"sourceCommit": "a" * 40, "image": "image"}), \
                    patch.object(smoke.psycopg, "connect", return_value=control), patch.object(smoke.subprocess, "Popen", Process), \
                    patch.object(smoke.subprocess, "run", return_value=result), patch.object(smoke, "urlopen", side_effect=lambda *a, **k: io.BytesIO(ready)), \
                    patch.object(smoke.socket, "socket") as socket_mock, patch("sys.stdout", new_callable=io.StringIO) as output:
                socket_mock.return_value.__enter__.return_value.getsockname.return_value = ("127.0.0.1", 12345)
                code = smoke.run(args)
            proof = json.loads(args.evidence.read_text())
            self.assertNotIn("private credential", json.dumps(proof) + output.getvalue())
            return code, proof, control

    def test_success_cleans_exact_owned_database(self):
        code, proof, control = self.fixture()
        self.assertEqual(code, 0)
        self.assertEqual(len(proof["checks"]), 214)
        self.assertEqual(proof["baselineSha256"], smoke.operator.sha({}))
        self.assertTrue(proof["cleanupComplete"])
        self.assertIsNone(control.database)
        drops = [q for q, _ in control.commands if q.startswith("DROP DATABASE")]
        self.assertEqual(drops, ['DROP DATABASE "' + proof["database"] + '"'])
        terminations = [params for q, params in control.commands if "pg_terminate_backend" in q]
        self.assertEqual(terminations, [(proof["database"],)])

    def test_failed_smoke_still_cleans_owned_database_without_secret_logs(self):
        code, proof, control = self.fixture(smoke_exit=1)
        self.assertEqual(code, 1)
        self.assertTrue(proof["cleanupComplete"])
        self.assertEqual(proof["failureCode"], "provider_smoke_failed")
        self.assertIsNone(control.database)

    def test_uncertain_marker_keeps_database_for_operator_inspection(self):
        code, proof, control = self.fixture(fail_marker=True)
        self.assertEqual(code, 1)
        self.assertFalse(proof["cleanupComplete"])
        self.assertIsNotNone(control.database)
        self.assertFalse(any(q.startswith("DROP DATABASE") for q, _ in control.commands))


if __name__ == "__main__":
    unittest.main(verbosity=2)
