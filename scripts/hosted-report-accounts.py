"""Explicit, nonce-scoped account fixtures for an authorized hosted release test.

No existing account is reused or has its password changed. Credentials come only
from process environment; evidence contains synthetic IDs, never passwords.
Deactivation retains users so legitimate application audit references survive.
"""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

import bcrypt
import psycopg


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--allow-hosted-fixtures", action="store_true", required=True)
    parser.add_argument("--action", choices=("provision", "deactivate"), required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{3,39}", args.run_id):
        raise ValueError("invalid fixture run ID")
    url = os.environ["REPORT_RELEASE_DATABASE_URL"].strip().replace("postgresql+psycopg://", "postgresql://", 1)
    parsed = urlsplit(url)
    expected_host = os.environ.get("REPORT_TEST_EXPECTED_DATABASE_HOST", "").strip()
    expected_database = os.environ.get("REPORT_TEST_EXPECTED_DATABASE_NAME", "").strip()
    if (not expected_host or not expected_database or parsed.scheme not in {"postgres", "postgresql"}
            or not parsed.hostname or not parsed.username or not parsed.password or parsed.fragment
            or parsed.hostname != expected_host or unquote(parsed.path) != f"/{expected_database}"
            or set(parse_qs(parsed.query)) - {"sslmode", "channel_binding"}):
        raise ValueError("database URL differs from explicitly approved target")
    # Do not let inherited libpq service/hostaddr/options override the target.
    for key in list(os.environ):
        if key.upper().startswith("PG"):
            os.environ.pop(key)
    password = os.environ["REPORT_TEST_ACCOUNT_PASSWORD"]
    if len(password) < 32:
        raise ValueError("high-entropy temporary password required")
    accounts = {key: f"release-{args.run_id}-{key.lower()}@example.invalid"
                for key in ("SUPERVISOR", "WORKER", "SECOND_WORKER")}
    source = Path(__file__).resolve().parents[1] / "backend/migrations/versions"
    ledger = {p.stem: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(source.glob("[0-9]*.py"))}
    result = {}
    with psycopg.connect(url, connect_timeout=20) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SET LOCAL statement_timeout = '20s'")
            cursor.execute("SET LOCAL lock_timeout = '5s'")
            cursor.execute("SELECT version, checksum FROM schema_migrations ORDER BY version")
            if dict(cursor.fetchall()) != ledger:
                raise ValueError("fixture target does not match candidate migration ledger")
            cursor.execute("SELECT id FROM department WHERE status='active' ORDER BY id LIMIT 1")
            department = cursor.fetchone()[0]
            for key, email in accounts.items():
                role = "supervisor" if key == "SUPERVISOR" else "worker"
                name = f"TEST ONLY {args.run_id} {key}"
                cursor.execute('SELECT id, name, role, is_global_admin, department_id, password_hash FROM "user" WHERE email=%s FOR UPDATE', (email,))
                existing = cursor.fetchone()
                if args.action == "provision":
                    if existing:
                        raise ValueError("fixture email already exists; refusing reuse")
                    password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
                    cursor.execute('''INSERT INTO "user" (email, name, password_hash, role, worker_class, status,
                                       is_global_admin, department_id, dashboard_department_id)
                                      VALUES (%s,%s,%s,%s,'normal','active',false,%s,%s) RETURNING id''',
                                   (email, name, password_hash, role, department, department))
                    result[key] = cursor.fetchone()[0]
                else:
                    if not existing:
                        continue
                    if (existing[1:5] != (name, role, False, department)
                            or not bcrypt.checkpw(password.encode(), existing[5].encode())):
                        raise ValueError("fixture identity/ownership mismatch; no deactivation permitted")
                    cursor.execute('UPDATE "user" SET status=\'resigned\' WHERE id=%s AND email=%s', (existing[0], email))
                    if cursor.rowcount != 1:
                        raise ValueError("fixture changed during cleanup")
                    result[key] = existing[0]
    print(json.dumps({"status": "passed", "action": args.action, "runId": args.run_id,
                      "accountIds": result, "existingAccountsChanged": False,
                      "note": "Operator-controlled synthetic fixtures; application audit rows are retained."}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"status": "failed", "failureType": type(error).__name__,
                          "message": "Hosted fixture operation failed; transaction rolled back, credentials not printed."}))
        raise SystemExit(1)
