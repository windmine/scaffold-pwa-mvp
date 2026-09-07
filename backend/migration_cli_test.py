"""Migration CLI process regressions; included in the main migration suite."""

import os
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

from sqlalchemy import create_engine


sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.migrations import run_migrations  # noqa: E402


def database_snapshot(engine):
    connection = engine.raw_connection()
    try:
        return tuple(connection.driver_connection.iterdump())
    finally:
        connection.close()


def run_migration_cli(db_path, uploads_path, *arguments):
    environment = os.environ.copy()
    environment.update({
        "APP_ENV": "production",
        "ENVIRONMENT": "production",
        "K_SERVICE": "isolated-migration-cli-test",
        # Even this unsafe API setting must never make --check apply migrations.
        "AUTO_MIGRATE": "true",
        "DATABASE_URL": f"sqlite:///{db_path.as_posix()}",
        "GEO_SECRET_KEY": "isolated-migration-cli-secret-never-used-outside-tests",
        "ENABLE_DEV_SEED": "false",
        "SQL_ECHO": "false",
        "UPLOAD_STORAGE_BACKEND": "local",
        "UPLOAD_DIR": str(uploads_path),
        "UPLOAD_BUCKET": "",
        "BUSINESS_TIMEZONE": "Pacific/Auckland",
        "PYTHONDONTWRITEBYTECODE": "1",
    })
    return subprocess.run(
        [sys.executable, "-m", "app.migrations", *arguments],
        cwd=Path(__file__).resolve().parent,
        env=environment,
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )


def test_migration_cli_process_exit_codes():
    cases = (
        ("missing", "Database migration history is missing"),
        ("pending", "Database migrations are pending"),
        ("checksum", "has changed since it was applied"),
        ("future", "Database has migrations not included in this release"),
        ("malformed", "no such column: checksum"),
        ("current", None),
    )
    with TemporaryDirectory() as directory:
        root = Path(directory)
        uploads_path = root / "uploads-must-stay-untouched"
        for label, expected_error in cases:
            db_path = root / f"cli-{label}.db"
            engine = create_engine(f"sqlite:///{db_path.as_posix()}")
            try:
                if label != "missing":
                    run_migrations(engine)
                with engine.begin() as connection:
                    # A non-ledger row also proves that --check preserves data.
                    connection.exec_driver_sql("CREATE TABLE regression_sentinel (value TEXT NOT NULL)")
                    connection.exec_driver_sql("INSERT INTO regression_sentinel VALUES ('keep this fixture')")
                    if label == "pending":
                        # Keep the newest version: checking only the head is unsafe.
                        connection.exec_driver_sql(
                            "DELETE FROM schema_migrations WHERE version = '0005_dashboard_department_preference'"
                        )
                    elif label == "checksum":
                        connection.exec_driver_sql(
                            "UPDATE schema_migrations SET checksum = 'changed-cli-checksum' "
                            "WHERE version = '0005_dashboard_department_preference'"
                        )
                    elif label == "future":
                        connection.exec_driver_sql(
                            "INSERT INTO schema_migrations (version, name, checksum, applied_at) "
                            "VALUES ('9999_future_schema', '9999_future_schema.py', 'future-checksum', '2026-09-07')"
                        )
                    elif label == "malformed":
                        connection.exec_driver_sql(
                            "ALTER TABLE schema_migrations RENAME COLUMN checksum TO missing_checksum"
                        )

                before = database_snapshot(engine)
                result = run_migration_cli(db_path, uploads_path, "--check")
                if database_snapshot(engine) != before:
                    raise AssertionError(f"{label}: migration --check changed database contents")
                if uploads_path.exists():
                    raise AssertionError(f"{label}: migration --check touched upload storage")
                output = result.stdout + result.stderr
                if expected_error is None:
                    if result.returncode != 0 or "Database migrations match this backend release" not in result.stdout:
                        raise AssertionError(f"current history: CLI verification failed: {output[-1200:]}")
                elif result.returncode == 0 or expected_error not in output:
                    raise AssertionError(f"{label}: CLI did not fail for the expected migration error: {output[-1200:]}")
                elif "Database migrations match this backend release" in output or "Applied migrations:" in output:
                    raise AssertionError(f"{label}: failed verification printed a success message")
                print(f"ok - migration CLI process {label} history: correct exit and unchanged database/uploads")
            finally:
                engine.dispose()


if __name__ == "__main__":
    test_migration_cli_process_exit_codes()
    print("migration CLI process test passed")
