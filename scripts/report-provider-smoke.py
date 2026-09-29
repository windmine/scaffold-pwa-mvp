"""Mutating smoke only in a new nonce-owned DB on an isolated Neon stage branch.

Uses release-operator stage metadata/URL environment validation. Never seeds the
cloned neondb, uses production credentials, or exposes captured child diagnostics.
The database name, comment nonce and owner are reverified before exact cleanup.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import urlopen

import psycopg
from psycopg import sql

SPEC = importlib.util.spec_from_file_location("release_operator", Path(__file__).with_name("report-release-operator.py"))
operator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(operator)
ROOT = operator.ROOT


def fresh_database_url(stage_url, database_name):
    value = urlsplit(stage_url.replace("postgresql+psycopg://", "postgresql://", 1))
    operator.require(database_name.startswith("report_smoke_") and database_name.replace("_", "").isalnum()
                     and len(database_name) <= 63 and database_name != "neondb", "invalid_owned_database_name")
    return urlunsplit(value._replace(path="/" + database_name))


def verify_owned_database(control, name, owner, marker):
    rows = control.execute("SELECT datname, pg_get_userbyid(datdba), shobj_description(oid, 'pg_database') "
                           "FROM pg_database WHERE datname = %s", (name,)).fetchall()
    operator.require(rows == [(name, owner, marker)], "database_cleanup_ownership_mismatch")


def run(args):
    operator.require(args.allow_stage_mutations, "explicit_staging_mutation_flag_required")
    operator.require(not args.evidence.exists(), "new_evidence_required")
    baseline = operator.read_proof(args.snapshot, "snapshot")
    operator.same_live(baseline)
    operator.names(args.run_id)
    stage_url, branch = operator.stage_target(baseline, args.run_id)
    artifact = operator.candidate(args)
    nonce = secrets.token_hex(6)
    database = "report_smoke_" + args.run_id.replace("-", "_") + "_" + nonce
    fixture_url = fresh_database_url(stage_url, database)
    marker = "report-release-owned-smoke:" + nonce + ":" + args.run_id
    proof = {"schemaVersion": 1, "status": "started", "startedAtUtc": operator.now(), "runId": args.run_id,
             "branch": branch, "artifact": artifact, "baselineSha256": operator.sha(baseline),
             "database": database, "isolation": "fresh database on isolated staging branch; loopback API; temporary local uploads",
             "databaseCreated": False, "ownershipMarked": False, "cleanupComplete": False, "checks": []}
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    with args.evidence.open("x", encoding="utf-8") as file:
        json.dump(proof, file)

    def save():
        args.evidence.write_text(json.dumps(proof, indent=2) + "\n", encoding="utf-8")

    control, process, owner = None, None, None
    failure = None
    # Parent libpq settings must not redirect even the initial control connection.
    pg_settings = {k: v for k, v in os.environ.items() if k.upper().startswith("PG")}
    for key in pg_settings:
        os.environ.pop(key)
    try:
        control = psycopg.connect(stage_url.replace("postgresql+psycopg://", "postgresql://", 1),
                                  connect_timeout=20, autocommit=True)
        operator.require(control.execute("SELECT current_database()").fetchone()[0] == "neondb", "stage_control_database_mismatch")
        owner = control.execute("SELECT current_user").fetchone()[0]
        operator.require(not control.execute("SELECT 1 FROM pg_database WHERE datname = %s", (database,)).fetchall(), "owned_database_name_exists")
        # Persist exact attempted name before CREATE; timeout is an uncertain
        # outcome and must never cause broad cleanup/retry with another target.
        proof["createAttemptedAtUtc"] = operator.now()
        save()
        control.execute(sql.SQL("CREATE DATABASE {} OWNER {}").format(sql.Identifier(database), sql.Identifier(owner)))
        proof["databaseCreated"] = True
        save()
        control.execute(sql.SQL("COMMENT ON DATABASE {} IS {}").format(sql.Identifier(database), sql.Literal(marker)))
        proof["ownershipMarked"] = True
        save()
        verify_owned_database(control, database, owner, marker)
        with tempfile.TemporaryDirectory(prefix="report-provider-smoke-") as directory:
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]
            environment = {**operator.environment(), "DATABASE_URL": fixture_url,
                           "APP_ENV": "development", "ENVIRONMENT": "development", "K_SERVICE": "",
                           "AUTO_MIGRATE": "true", "ENABLE_DEV_SEED": "true", "SQL_ECHO": "false",
                           "AUTH_COOKIE_SECURE": "false", "RATE_LIMIT_ENABLED": "false",
                           "UPLOAD_STORAGE_BACKEND": "local", "UPLOAD_BUCKET": "",
                           "UPLOAD_OBJECT_PREFIX": "uploads", "UPLOAD_DIR": str(Path(directory) / "uploads"),
                           "GEO_SECRET_KEY": secrets.token_urlsafe(48), "BUSINESS_TIMEZONE": "Pacific/Auckland",
                           "SMTP_HOST": "", "SMTP_FROM_EMAIL": "", "REGISTRATION_EXPOSE_CODE": "true",
                           "API_BASE_URL": f"http://127.0.0.1:{port}"}
            with tempfile.TemporaryFile(mode="w+", encoding="utf-8") as server_log:
                process = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port)],
                                           cwd=ROOT / "backend", env=environment, stdout=server_log, stderr=subprocess.STDOUT,
                                           creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
                try:
                    ready = False
                    for _ in range(90):
                        operator.require(process.poll() is None, "owned_provider_backend_stopped")
                        try:
                            with urlopen(environment["API_BASE_URL"] + "/health/ready", timeout=2) as response:
                                status = json.load(response)
                            ready = status.get("status") == "ok" and all(status.get("checks", {}).get(k) == "ok"
                                                                         for k in ("database", "migrations", "upload_storage"))
                            if ready:
                                break
                        except (URLError, TimeoutError):
                            pass
                        time.sleep(0.5)
                    operator.require(ready, "owned_provider_backend_not_ready")
                    result = subprocess.run([sys.executable, str(ROOT / "backend/smoke_test.py")], cwd=ROOT,
                                            env=environment, capture_output=True, encoding="utf-8", errors="replace", timeout=600)
                    proof["smokeExitCode"] = result.returncode
                    # Only fixed success labels are retained; failure response
                    # bodies can contain fixture credentials, so never print them.
                    proof["checks"] = [line[5:] for line in result.stdout.splitlines() if line.startswith("ok - ")]
                    operator.require(result.returncode == 0 and len(proof["checks"]) >= 214, "provider_smoke_failed")
                finally:
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=20)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=10)
                    process = None
            proof["localFixtureCleanupComplete"] = True
        operator.same_live(baseline)
        proof["productionUnchanged"] = True
    except Exception as error:
        failure = str(error) if isinstance(error, RuntimeError) else type(error).__name__
    finally:
        try:
            if proof["databaseCreated"]:
                operator.require(proof["ownershipMarked"] and control is not None and not control.closed,
                                 "database_retained_for_explicit_ownership_recovery")
                verify_owned_database(control, database, owner, marker)
                # Only the exact nonce-owned database's remaining pooled
                # sessions are terminated; production/cloned neondb excluded.
                control.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=%s AND pid<>pg_backend_pid()", (database,))
                control.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(database)))
                operator.require(not control.execute("SELECT 1 FROM pg_database WHERE datname=%s", (database,)).fetchall(), "owned_database_remains")
                proof["cleanupComplete"] = True
            elif "createAttemptedAtUtc" not in proof:
                proof["cleanupComplete"] = True
            else:
                # Never assume a failed/timeout CREATE means no DB was created.
                operator.require(control is not None and not control.closed
                                 and not control.execute("SELECT 1 FROM pg_database WHERE datname=%s", (database,)).fetchall(),
                                 "uncertain_owned_database_creation_requires_inspection")
                proof["cleanupComplete"] = True
        except Exception as error:
            proof["cleanupFailureCode"] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
            failure = failure or "owned_database_cleanup_failed"
        if control is not None:
            control.close()
        os.environ.update(pg_settings)
        proof.update(status="failed" if failure else "passed", finishedAtUtc=operator.now())
        if failure:
            proof["failureCode"] = failure
        save()
    print(json.dumps({"status": proof["status"], "checkpoints": len(proof["checks"]), "cleanupComplete": proof["cleanupComplete"],
                      "evidence": str(args.evidence), **({"failureCode": failure} if failure else {})}))
    return 1 if failure else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-stage-mutations", action="store_true")
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--image", required=True)
    try:
        raise SystemExit(run(parser.parse_args()))
    except Exception as error:
        print(json.dumps({"status": "refused", "code": str(error) if isinstance(error, RuntimeError) else type(error).__name__}))
        raise SystemExit(1)
