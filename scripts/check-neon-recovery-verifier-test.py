"""Offline tests of the recovery verifier's PostgreSQL boundary; no provider access."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "recovery_verifier", Path(__file__).with_name("verify-neon-recovery.py")
)
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class RecoveryConnection:
    def __init__(self, *, read_only=True, ledger=None):
        self.read_only = read_only
        self.ledger = ledger if ledger is not None else [
            ("0001_initial_schema", "a" * 64), ("0002_example", "b" * 64)
        ]
        self.queries = []
        self.rows = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def cursor(self):
        return self

    def execute(self, query):
        query = query if isinstance(query, str) else query.as_string()
        query = " ".join(query.split())
        self.queries.append(query)
        if query.startswith("SET LOCAL lock_timeout") or query.startswith("SET LOCAL statement_timeout"):
            self.rows = []
        elif query == "SHOW transaction_read_only":
            self.rows = [("on" if self.read_only else "off",)]
        elif query == "SELECT version, checksum FROM public.schema_migrations ORDER BY version":
            self.rows = self.ledger
        elif "FROM information_schema.tables" in query:
            self.rows = [("department",), ("site",), ("user",)]
        elif "FROM information_schema.columns" in query:
            self.rows = [("user", "id", "integer", "NO", 1)]
        elif query.startswith("SELECT count(*)") or query.startswith("SELECT EXISTS"):
            self.rows = [(1,)]
        else:
            raise AssertionError("Unexpected query; verifier must remain read-only")

    def fetchone(self):
        return self.rows[0]

    def fetchall(self):
        return self.rows


class RecoveryVerifierTests(unittest.TestCase):
    def verify_connection(self, connection):
        with patch.dict("os.environ", {"NEON_RECOVERY_DATABASE_URL": "postgresql://synthetic.invalid/example"}), \
             patch.object(verifier.psycopg, "connect", return_value=connection):
            return verifier.verify()

    def test_returns_full_ordered_version_checksum_ledger(self):
        connection = RecoveryConnection()
        result = self.verify_connection(connection)
        self.assertEqual(result["migrationVersions"], [row[0] for row in connection.ledger])
        self.assertEqual(result["migrationChecksums"], dict(connection.ledger))
        self.assertEqual(result["migrationCount"], 2)
        self.assertEqual(result["migrationHead"], "0002_example")
        self.assertTrue(result["transactionReadOnly"])
        self.assertNotIn("postgresql://", json.dumps(result))

    def test_does_not_force_writable_endpoint_to_look_read_only(self):
        connection = RecoveryConnection(read_only=False)
        with self.assertRaises(RuntimeError):
            self.verify_connection(connection)
        self.assertFalse(any("SET" in query and "read_only" in query for query in connection.queries))

    def test_rejects_empty_malformed_or_duplicate_ledger(self):
        for ledger in ([], [("0001_initial_schema", "bad")], [("private value", "a" * 64)],
                       [("0001_initial_schema", "a" * 64), ("0001_initial_schema", "b" * 64)]):
            with self.subTest(ledger=ledger), self.assertRaises(RuntimeError):
                self.verify_connection(RecoveryConnection(ledger=ledger))

    def test_failure_output_does_not_expose_connection_or_provider_error(self):
        output = io.StringIO()
        with patch.object(verifier, "verify", side_effect=RuntimeError("private connection details")), \
             contextlib.redirect_stdout(output):
            self.assertEqual(verifier.main(), 1)
        self.assertEqual(json.loads(output.getvalue()), {
            "status": "failed", "failureCode": "database_verification_failed"
        })


if __name__ == "__main__":
    unittest.main()
