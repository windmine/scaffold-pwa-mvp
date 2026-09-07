"""Rehearse migrations/review against an owned, disposable native PostgreSQL cluster.

No connection URL is accepted: existing databases and services are never targets.
"""

import argparse
import hashlib
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import psycopg
from psycopg import sql
from sqlalchemy import URL, create_engine


BACKEND = Path(__file__).resolve().parent
REPOSITORY = BACKEND.parent
PREFIX = "report-postgres-rehearsal-"


def postgres_tools(directory):
    suffix = ".exe" if os.name == "nt" else ""
    tools = {name: directory / f"{name}{suffix}" for name in ("initdb", "pg_ctl", "postgres")}
    if any(not path.is_file() for path in tools.values()):
        raise RuntimeError("--pg-bin must contain initdb, pg_ctl, and postgres")
    return tools


def command(arguments, environment, timeout=45):
    # pg_ctl's detached server may inherit pipe handles on Windows. A file keeps
    # waiting bounded by the launcher process rather than by a descendant's EOF.
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8") as output:
        result = subprocess.run(
            [str(argument) for argument in arguments],
            env=environment,
            stdout=output,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        output.seek(0)
        transcript = output.read()
    if result.returncode:
        raise RuntimeError(f"{Path(arguments[0]).name} failed: {transcript[-2500:]}")
    return transcript.strip()


def rehearsal(pg_bin, *, migrations_only=False, review_only=False):
    # Clear libpq settings in Python too, not just in initdb/pg_ctl children.
    # Explicit hostaddr below also defeats settings reintroduced by dotenv files.
    environment = {key: value for key, value in os.environ.items() if not key.upper().startswith("PG")}
    with patch.dict(os.environ, environment, clear=True):
        return _rehearsal(pg_bin, migrations_only=migrations_only, review_only=review_only)


def _rehearsal(pg_bin, *, migrations_only=False, review_only=False):
    tools = postgres_tools(pg_bin)
    root = Path(tempfile.mkdtemp(prefix=PREFIX)).resolve()
    owner = secrets.token_hex(16)
    marker = root / "rehearsal-owner"
    marker.write_text(owner, encoding="utf-8")
    data = root / "data"
    password_file = root / "bootstrap-password"
    bootstrap_password = secrets.token_urlsafe(32)
    app_password = secrets.token_urlsafe(32)
    password_file.write_text(bootstrap_password + "\n", encoding="utf-8")
    environment = {key: value for key, value in os.environ.items() if not key.upper().startswith("PG")}
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    evidence = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "isolation": "new local cluster, loopback only, synthetic data, non-superuser database owner",
        "checks": [],
        "failures": [],
        "scope": "migrations" if migrations_only else "review" if review_only else "migrations_and_review",
        "passed": False,
        "cleanup_complete": False,
    }
    started = False
    admin = None

    def report(label, details=None):
        evidence["checks"].append({"label": label, **({"details": details} if details is not None else {})})
        print(f"ok - {label}", flush=True)

    @contextmanager
    def database(label):
        if not label.replace("_", "").isalnum():
            raise ValueError("Rehearsal database labels must be alphanumeric/underscore")
        name = f"rehearsal_{label[:25]}_{secrets.token_hex(6)}"
        admin.execute(sql.SQL("CREATE DATABASE {} OWNER rehearsal_app").format(sql.Identifier(name)))
        engine = create_engine(
            URL.create("postgresql+psycopg", username="rehearsal_app", password=app_password,
                       host="127.0.0.1", port=port, database=name),
            pool_pre_ping=True,
            connect_args={"hostaddr": "127.0.0.1", "connect_timeout": 5, "sslmode": "disable", "gssencmode": "disable", "options":
                          "-c statement_timeout=15000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=20000"},
        )
        try:
            with engine.connect() as connection:
                actual_name, superuser = connection.exec_driver_sql(
                    "SELECT current_database(), rolsuper FROM pg_roles WHERE rolname = current_user"
                ).one()
                if actual_name != name or superuser:
                    raise AssertionError("Rehearsal engine is not the owned non-superuser fixture")
            yield engine
        finally:
            engine.dispose()

    try:
        evidence["binary_version"] = command([tools["postgres"], "--version"], environment)
        command([tools["initdb"], "-D", data, "-U", "rehearsal_bootstrap", "--encoding=UTF8",
                 "--locale=C", "--auth=scram-sha-256", f"--pwfile={password_file}"], environment)
        password_file.unlink()
        # Mark before invoking pg_ctl: a timeout may leave this owned server alive.
        started = True
        command([tools["pg_ctl"], "-D", data, "-l", root / "postgres.log", "-w", "-t", "30", "start",
                 "-o", f"-h 127.0.0.1 -p {port} -c max_connections=20 -c shared_buffers=32MB -c unix_socket_directories="], environment)
        admin = psycopg.connect(host="127.0.0.1", hostaddr="127.0.0.1", port=port, dbname="postgres", user="rehearsal_bootstrap",
                                password=bootstrap_password, autocommit=True, connect_timeout=5, sslmode="disable", gssencmode="disable")
        actual_data, actual_port, version = admin.execute(
            "SELECT current_setting('data_directory'), current_setting('port'), version()"
        ).fetchone()
        if Path(actual_data).resolve() != data.resolve() or int(actual_port) != port:
            raise AssertionError("PostgreSQL server identity does not match the owned cluster")
        evidence["server_version"] = version
        admin.execute(sql.SQL("CREATE ROLE rehearsal_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD {}")
                      .format(sql.Literal(app_password)))
        runtime = {
            "APP_ENV": "test", "ENVIRONMENT": "test", "K_SERVICE": "", "AUTO_MIGRATE": "false",
            "DATABASE_URL": URL.create("postgresql+psycopg", username="rehearsal_app", password=app_password,
                                        host="127.0.0.1", port=port, database="postgres").render_as_string(hide_password=False),
            "GEO_SECRET_KEY": secrets.token_urlsafe(32), "ENABLE_DEV_SEED": "false", "SQL_ECHO": "false",
            "UPLOAD_STORAGE_BACKEND": "local", "UPLOAD_DIR": str(root / "uploads"), "UPLOAD_BUCKET": "",
            "BUSINESS_TIMEZONE": "Pacific/Auckland",
            "PGHOSTADDR": "127.0.0.1", "PGSERVICE": "", "PGSERVICEFILE": "", "PGGSSENCMODE": "disable",
        }
        with patch.dict(os.environ, runtime):
            phases = []
            if not review_only:
                from postgres_migration_rehearsal import run_migration_checks
                phases.append(("migrations", run_migration_checks))
            if not migrations_only:
                from postgres_review_rehearsal import run_review_checks
                phases.append(("review", run_review_checks))
            for phase, run_checks in phases:
                try:
                    run_checks(database, report)
                except Exception as error:
                    message = f"{type(error).__name__}: {error}".replace(bootstrap_password, "[redacted]").replace(app_password, "[redacted]")
                    evidence["failures"].append({"phase": phase, "error": message})
                    print(f"not ok - {phase}: {message}", flush=True)
        evidence["passed"] = not evidence["failures"]
    except Exception as error:
        evidence["error"] = f"{type(error).__name__}: {error}".replace(bootstrap_password, "[redacted]").replace(app_password, "[redacted]")
        log = root / "postgres.log"
        if log.is_file():
            evidence["server_log_tail"] = log.read_text(encoding="utf-8", errors="replace")[-2500:].replace(bootstrap_password, "[redacted]").replace(app_password, "[redacted]")
    finally:
        if admin is not None:
            admin.close()
        try:
            if started and (data / "postmaster.pid").exists():
                command([tools["pg_ctl"], "-D", data, "-m", "fast", "-w", "-t", "30", "stop"], environment)
            if (data / "postmaster.pid").exists():
                raise RuntimeError("Owned cluster still running; refusing to delete its files")
            if (root.parent != Path(tempfile.gettempdir()).resolve() or not root.name.startswith(PREFIX)
                    or marker.read_text(encoding="utf-8") != owner or root.is_symlink()):
                raise RuntimeError("Temporary cluster ownership check failed; refusing cleanup")
            shutil.rmtree(root)
            evidence["cleanup_complete"] = True
        except Exception as error:
            evidence["passed"] = False
            evidence["cleanup_error"] = str(error)
            evidence["retained_temp_directory"] = str(root)
        evidence["finished_at"] = datetime.now(timezone.utc).isoformat()
    return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pg-bin", type=Path, required=True, help="Directory containing installed PostgreSQL server binaries")
    parser.add_argument("--output", type=Path, help="New sanitized JSON evidence file (never overwrites an existing file)")
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument("--migrations-only", action="store_true", help="Run migration rehearsal without concurrent review")
    scope.add_argument("--review-only", action="store_true", help="Run migrated concurrent-review fixtures without historical backfill checks")
    args = parser.parse_args()
    if args.output and args.output.exists():
        parser.error("--output already exists; choose a new evidence file")
    evidence = rehearsal(args.pg_bin.resolve(), migrations_only=args.migrations_only, review_only=args.review_only)
    evidence["source_commit"] = command(["git", "-C", REPOSITORY, "rev-parse", "HEAD"], os.environ.copy())
    evidence["source_dirty"] = bool(command(["git", "-C", REPOSITORY, "status", "--porcelain"], os.environ.copy()))
    evidence["source_sha256"] = {
        str(path.relative_to(REPOSITORY)).replace("\\", "/"): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted([*BACKEND.glob("postgres*_rehearsal.py"), BACKEND / "app" / "migrations.py",
                            BACKEND / "app" / "use_cases" / "work_forms.py", * (BACKEND / "migrations" / "versions").glob("*.py")])
    }
    serialized = json.dumps(evidence, indent=2)
    if args.output:
        with args.output.open("x", encoding="utf-8") as handle:
            handle.write(serialized + "\n")
        print(f"Evidence: {args.output}")
    if not evidence["passed"]:
        print(serialized)
        return 1
    print(f"PostgreSQL rehearsal passed: {len(evidence['checks'])} checkpoints; owned cluster removed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
