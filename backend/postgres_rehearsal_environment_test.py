"""Verify native rehearsal connections ignore inherited and imported libpq services.

Uses only the rehearsal's owned, disposable loopback cluster. No database URL or
existing service is accepted, and the caller's full environment is restored.
"""

import argparse
import builtins
import hashlib
import json
import os
from pathlib import Path
import platform
import sys
from types import ModuleType
from unittest.mock import patch

import psycopg

from postgres_rehearsal import rehearsal


ROOT = Path(__file__).resolve().parent.parent
SERVICE_KEYS = ("PGSERVICE", "PGSERVICEFILE")


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def run_checks(pg_bin):
    observations = {}
    phase_module = ModuleType("postgres_review_rehearsal")
    real_import = builtins.__import__

    def inject_services():
        os.environ["PGSERVICE"] = "synthetic_nonexistent_service"
        os.environ["PGSERVICEFILE"] = "synthetic_nonexistent_service.conf"

    def import_with_settings(name, globals=None, locals=None, fromlist=(), level=0):
        result = real_import(name, globals, locals, fromlist, level)
        if name == phase_module.__name__:
            # Simulate settings loaded during a phase import, without reading or
            # changing any real dotenv file or PostgreSQL service configuration.
            observations["services_absent_before_phase_import"] = all(
                key not in os.environ for key in SERVICE_KEYS
            )
            observations["inherited_connection_settings_removed"] = all(
                key not in os.environ for key in ("PGHOST", "PGPORT", "PGOPTIONS")
            )
            inject_services()
            observations["phase_import_injected_services"] = True
        return result

    def connection_checks(database, report):
        require(observations.get("services_absent_before_phase_import"),
                "Service variables must be absent, not empty, before phase imports")
        report("Inherited service variables are removed, never replaced with empty strings")
        require(observations.get("inherited_connection_settings_removed"),
                "Inherited libpq connection settings leaked into the owned rehearsal")
        require(os.environ.get("PGHOSTADDR") == "127.0.0.1", "Loopback hostaddr was not retained")
        require(os.environ.get("PGGSSENCMODE") == "disable", "Owned connection GSS setting changed")
        require(os.environ.get("REPORT_REHEARSAL_TEST_MARKER") == "preserve-unrelated-setting",
                "Unrelated caller environment was lost")
        report("Unrelated settings survive while inherited connection overrides are removed")
        observations["services_absent_after_phase_import"] = all(key not in os.environ for key in SERVICE_KEYS)
        require(observations["services_absent_after_phase_import"],
                "Phase imports reintroduced PostgreSQL service configuration")
        report("Settings introduced during phase import cannot select a PostgreSQL service")

        # Also cover a callback that imports settings immediately before asking
        # for its owned database. This must not alter the connection destination.
        inject_services()
        with database("environment_guard") as engine:
            observations["services_absent_at_connection"] = all(key not in os.environ for key in SERVICE_KEYS)
            require(observations["services_absent_at_connection"],
                    "Callback settings reintroduced PostgreSQL service configuration")
            with engine.connect() as connection:
                name, superuser, address = connection.exec_driver_sql(
                    "SELECT current_database(), rolsuper, inet_server_addr() "
                    "FROM pg_roles WHERE rolname = current_user"
                ).one()
            require(name.startswith("rehearsal_environment_guard_"), "Unexpected database identity")
            require(not superuser and str(address) == "127.0.0.1", "Connection escaped owned loopback identity")
        observations["owned_database_connection_succeeded"] = True
        report("Callback service settings cannot prevent the owned non-superuser loopback connection")

    phase_module.run_review_checks = connection_checks
    original_environment = dict(os.environ)
    inherited = {
        "PGSERVICE": "synthetic_inherited_service",
        "PGSERVICEFILE": "synthetic_inherited_service.conf",
        "PGHOST": "synthetic.invalid",
        "PGPORT": "1",
        "PGOPTIONS": "-c synthetic.invalid_setting=1",
        "REPORT_REHEARSAL_TEST_MARKER": "preserve-unrelated-setting",
    }
    with patch.dict(os.environ, inherited):
        expected_environment = dict(os.environ)
        with patch.dict(sys.modules, {phase_module.__name__: phase_module}), patch(
            "builtins.__import__", side_effect=import_with_settings
        ):
            evidence = rehearsal(pg_bin, review_only=True)
        observations["caller_environment_restored"] = dict(os.environ) == expected_environment
    observations["outer_environment_restored"] = dict(os.environ) == original_environment
    for key in ("caller_environment_restored", "outer_environment_restored"):
        if not observations[key]:
            evidence["passed"] = False
            evidence["failures"].append({"phase": "environment_restoration", "error": key})
    evidence["environment_observations"] = observations
    evidence["runtime"] = {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "psycopg": psycopg.__version__,
        "libpq_version": psycopg.pq.version(),
    }
    evidence["source_sha256"] = {
        str(path.relative_to(ROOT)).replace("\\", "/"): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in (ROOT / "backend" / "postgres_rehearsal.py", Path(__file__).resolve())
    }
    return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pg-bin", type=Path, required=True)
    parser.add_argument("--output", type=Path, help="New sanitized evidence JSON; existing files are never overwritten")
    args = parser.parse_args()
    if args.output and args.output.exists():
        parser.error("--output already exists; choose a new evidence file")
    evidence = run_checks(args.pg_bin.resolve())
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("x", encoding="utf-8") as handle:
            json.dump(evidence, handle, indent=2)
            handle.write("\n")
        print(f"Evidence: {args.output}")
    if not evidence["passed"]:
        print(json.dumps(evidence, indent=2))
        return 1
    print(f"PostgreSQL environment regression passed: {len(evidence['checks'])} checkpoints; owned cluster removed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
