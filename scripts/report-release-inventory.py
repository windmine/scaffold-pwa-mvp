"""Read-only, credential-redacted inventory for a coupled Report release.

Connection is supplied only through REPORT_RELEASE_DATABASE_URL. Never prints
answers, upload references, account details, or the connection string.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import psycopg
from psycopg import sql


ROOT = Path(__file__).resolve().parents[1]
IMMUTABLE_COLUMNS = (
    "id", "department_id", "form_id", "worker_id", "site_id", "work_date",
    "answers_json", "form_definition_version", "definition_snapshot_json",
    "photo_urls", "photo_metadata", "client_submission_id", "status", "created_at",
)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()


def inventory():
    url = os.environ.get("REPORT_RELEASE_DATABASE_URL", "").strip()
    if not url:
        raise RuntimeError("missing connection")
    url = url.replace("postgresql+psycopg://", "postgresql://", 1)
    migration_path = ROOT / "backend/migrations/versions/0019_report_daywork_purpose.py"
    spec = importlib.util.spec_from_file_location("inventory_purpose", migration_path)
    purpose = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(purpose)
    with psycopg.connect(url, connect_timeout=20) as connection:
        # PgBouncer rejects this setting in startup options. Psycopg emits
        # BEGIN READ ONLY before the first query instead, for pooled/direct URLs.
        connection.read_only = True
        with connection.cursor() as cursor:
            cursor.execute("SET LOCAL statement_timeout = '20s'")
            cursor.execute("SET LOCAL lock_timeout = '5s'")
            cursor.execute("SHOW transaction_read_only")
            if cursor.fetchone()[0] != "on":
                raise RuntimeError("read-only transaction required")
            cursor.execute("SELECT version, checksum FROM public.schema_migrations ORDER BY version")
            ledger = dict(cursor.fetchall())
            bundled = {p.stem: hashlib.sha256(p.read_bytes()).hexdigest() for p in (ROOT / "backend/migrations/versions").glob("[0-9]*.py")}
            prefix_matches = list(ledger) == sorted(bundled)[:len(ledger)]
            checksum_mismatches = [k for k, v in ledger.items() if bundled.get(k) != v]
            cursor.execute("SELECT id, fields_json, definition_version FROM public.workform")
            forms = {row[0]: row[1:] for row in cursor.fetchall()}
            cursor.execute(sql.SQL("SELECT {} FROM public.workformsubmission ORDER BY id").format(sql.SQL(", ").join(map(sql.Identifier, IMMUTABLE_COLUMNS))))
            submissions = [dict(zip(IMMUTABLE_COLUMNS, row)) for row in cursor.fetchall()]
            missing = []
            for row in submissions:
                if row["definition_snapshot_json"] not in (None, ""):
                    continue
                parent = forms.get(row["form_id"])
                try:
                    answers = json.loads(row["answers_json"] or "{}")
                    answer_keys = set(answers) if isinstance(answers, dict) else set()
                except (TypeError, ValueError):
                    answer_keys = set()
                missing.append({
                    "submissionId": row["id"],
                    "parentExists": parent is not None,
                    "parentHasDayworkFields": bool(parent and purpose.has_historical_daywork_evidence(parent[0])),
                    "capturedVersionMatchesParent": bool(parent and row["form_definition_version"] == parent[1]),
                    "answersHaveCompleteOriginalOrPdfDayworkKeys": any(keys.issubset(answer_keys) for keys in (purpose.DAYWORK_ORIGINAL_FIELD_SIGNATURE, purpose.DAYWORK_PDF_FIELD_SIGNATURE)),
                })
            cursor.execute('SELECT role, status, count(*) FROM public."user" GROUP BY role, status ORDER BY role, status')
            user_counts = [dict(zip(("role", "status", "count"), row)) for row in cursor.fetchall()]
            cursor.execute("SELECT count(*) FROM public.auditevent")
            audit_count = cursor.fetchone()[0]
    return {
        "schemaVersion": 1,
        "status": "passed",
        "recordedAtUtc": datetime.now(timezone.utc).isoformat(),
        "transactionReadOnly": True,
        "migrationHead": next(reversed(ledger)),
        "migrationCount": len(ledger),
        "ledgerMatchesBundledPrefix": prefix_matches and not checksum_mismatches,
        "ledgerVersionPrefixMatches": prefix_matches,
        "ledgerChecksumMismatches": checksum_mismatches,
        "migrationChecksums": ledger,
        "templateCount": len(forms),
        "submissionCount": len(submissions),
        "immutableSubmissionColumns": IMMUTABLE_COLUMNS,
        "immutableSubmissionsSha256": digest(submissions),
        "missingSnapshots": missing,
        "userCounts": user_counts,
        "auditCount": audit_count,
    }


if __name__ == "__main__":
    try:
        print(json.dumps(inventory(), sort_keys=True))
    except Exception as error:
        print(json.dumps({"status": "failed", "failureType": type(error).__name__, "message": "Read-only release inventory failed; no credentials or record content printed."}))
        raise SystemExit(1)
