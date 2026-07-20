from __future__ import annotations

import hashlib
import json
import os
import platform
import sys

import psycopg
from psycopg import sql


def canonical_sha256(value) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def verify() -> dict:
    database_url = os.environ.get("NEON_RECOVERY_DATABASE_URL", "").strip()
    if not database_url:
        raise RuntimeError("missing recovery connection")

    with psycopg.connect(database_url, connect_timeout=20) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SET LOCAL lock_timeout = '5s'")
            cursor.execute("SET LOCAL statement_timeout = '15s'")
            cursor.execute("SHOW transaction_read_only")
            transaction_read_only = cursor.fetchone()[0] == "on"

            cursor.execute("SELECT version FROM public.schema_migrations ORDER BY version")
            migration_versions = [row[0] for row in cursor.fetchall()]

            cursor.execute(
                """
                SELECT table_name
                FROM information_schema.tables
                WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
                ORDER BY table_name
                """
            )
            table_names = [row[0] for row in cursor.fetchall()]
            if len(table_names) > 100:
                raise RuntimeError("recovery verification table limit exceeded")

            cursor.execute(
                """
                SELECT table_name, column_name, data_type, is_nullable, ordinal_position
                FROM information_schema.columns
                WHERE table_schema = 'public'
                ORDER BY table_name, ordinal_position
                """
            )
            schema_shape = [list(row) for row in cursor.fetchall()]

            row_counts = {}
            for table_name in table_names:
                cursor.execute(
                    sql.SQL("SELECT count(*) FROM {}.{}").format(
                        sql.Identifier("public"),
                        sql.Identifier(table_name),
                    )
                )
                row_counts[table_name] = cursor.fetchone()[0]

            required_business_tables = ("department", "site", "user")
            missing_business_tables = sorted(set(required_business_tables) - set(table_names))
            if missing_business_tables:
                raise RuntimeError("recovery verification business tables are missing")

            business_sentinels = {}
            for table_name in required_business_tables:
                cursor.execute(
                    sql.SQL("SELECT EXISTS (SELECT 1 FROM {}.{} LIMIT 1)").format(
                        sql.Identifier("public"),
                        sql.Identifier(table_name),
                    )
                )
                business_sentinels[table_name] = bool(cursor.fetchone()[0])

    if (
        not transaction_read_only
        or not migration_versions
        or not table_names
        or not all(business_sentinels.values())
    ):
        raise RuntimeError("recovery verification did not meet invariants")

    return {
        "status": "passed",
        "connected": True,
        "transactionReadOnly": transaction_read_only,
        "migrationCount": len(migration_versions),
        "migrationHead": migration_versions[-1],
        "publicTableCount": len(table_names),
        "schemaSha256": canonical_sha256(schema_shape),
        "rowCountSha256": canonical_sha256(row_counts),
        "businessDataPresent": business_sentinels,
        "pythonVersion": platform.python_version(),
        "psycopgVersion": psycopg.__version__,
    }


def main() -> int:
    try:
        result = verify()
    except Exception:
        print(json.dumps({"status": "failed", "failureCode": "database_verification_failed"}))
        return 1

    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
