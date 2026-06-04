import sys
import tempfile
from pathlib import Path

from sqlalchemy import create_engine, inspect


sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.migrations import run_migrations  # noqa: E402


EXPECTED_TABLES = {
    "user",
    "site",
    "attendancerecord",
    "tasklog",
    "tasktemplate",
    "workform",
    "workformsubmission",
    "auditevent",
    "schema_migrations",
}


def make_engine(db_path: Path):
    return create_engine(
        f"sqlite:///{db_path.as_posix()}",
        connect_args={"check_same_thread": False},
    )


def columns(engine, table_name: str):
    return {
        column["name"]
        for column in inspect(engine).get_columns(table_name)
    }


def assert_contains(label: str, actual, expected):
    missing = set(expected) - set(actual)

    if missing:
        raise AssertionError(f"{label}: missing {sorted(missing)}")


def assert_migration_recorded(engine):
    with engine.begin() as connection:
        rows = connection.exec_driver_sql(
            "SELECT version FROM schema_migrations ORDER BY version"
        ).all()

    if [row[0] for row in rows] != ["0001_initial_schema"]:
        raise AssertionError("schema_migrations: expected 0001_initial_schema")


def test_fresh_database():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
        engine = make_engine(Path(directory) / "fresh.db")

        applied = run_migrations(engine)
        if applied != ["0001_initial_schema"]:
            raise AssertionError(f"fresh migration: expected 0001_initial_schema, got {applied}")

        if run_migrations(engine) != []:
            raise AssertionError("fresh migration: second run should be a no-op")

        assert_contains("fresh tables", inspect(engine).get_table_names(), EXPECTED_TABLES)
        assert_contains(
            "fresh tasklog columns",
            columns(engine, "tasklog"),
            {"work_date", "hours_worked", "safety_notes", "photo_urls", "status", "client_submission_id"},
        )
        assert_contains(
            "fresh attendance columns",
            columns(engine, "attendancerecord"),
            {"distance_from_site_m", "within_site_radius", "client_submission_id"},
        )
        assert_migration_recorded(engine)
        engine.dispose()

    print("ok - fresh database migration")


def test_legacy_database():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
        engine = make_engine(Path(directory) / "legacy.db")

        with engine.begin() as connection:
            connection.exec_driver_sql(
                """
                CREATE TABLE "user" (
                    id INTEGER PRIMARY KEY,
                    email VARCHAR NOT NULL,
                    name VARCHAR NOT NULL,
                    password_hash VARCHAR NOT NULL,
                    role VARCHAR NOT NULL
                )
                """
            )
            connection.exec_driver_sql(
                """
                CREATE TABLE tasklog (
                    id INTEGER PRIMARY KEY,
                    worker_id INTEGER NOT NULL,
                    site_id INTEGER,
                    description VARCHAR NOT NULL,
                    photo_url VARCHAR,
                    created_at DATETIME NOT NULL
                )
                """
            )
            connection.exec_driver_sql(
                """
                CREATE TABLE attendancerecord (
                    id INTEGER PRIMARY KEY,
                    worker_id INTEGER NOT NULL,
                    site_id INTEGER,
                    record_type VARCHAR NOT NULL,
                    latitude FLOAT NOT NULL,
                    longitude FLOAT NOT NULL,
                    accuracy FLOAT,
                    note VARCHAR,
                    photo_url VARCHAR,
                    status VARCHAR NOT NULL,
                    created_at DATETIME NOT NULL
                )
                """
            )
            connection.exec_driver_sql(
                """
                CREATE TABLE workformsubmission (
                    id INTEGER PRIMARY KEY,
                    form_id INTEGER NOT NULL,
                    worker_id INTEGER NOT NULL,
                    site_id INTEGER,
                    work_date VARCHAR,
                    answers_json VARCHAR NOT NULL,
                    photo_urls VARCHAR,
                    created_at DATETIME NOT NULL
                )
                """
            )

        applied = run_migrations(engine)
        if applied != ["0001_initial_schema"]:
            raise AssertionError(f"legacy migration: expected 0001_initial_schema, got {applied}")

        assert_contains("legacy tables", inspect(engine).get_table_names(), EXPECTED_TABLES)
        assert_contains("legacy user columns", columns(engine, "user"), {"status"})
        assert_contains(
            "legacy tasklog columns",
            columns(engine, "tasklog"),
            {"work_date", "hours_worked", "safety_notes", "photo_urls", "status", "client_submission_id"},
        )
        assert_contains(
            "legacy attendance columns",
            columns(engine, "attendancerecord"),
            {"distance_from_site_m", "within_site_radius", "client_submission_id"},
        )
        assert_contains(
            "legacy form submission columns",
            columns(engine, "workformsubmission"),
            {"status", "client_submission_id"},
        )
        assert_migration_recorded(engine)
        engine.dispose()

    print("ok - legacy database migration")


def main():
    test_fresh_database()
    test_legacy_database()
    print("migration test passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
