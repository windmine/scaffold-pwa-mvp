import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import create_engine, inspect
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session


sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.migrations import adapt_statement_for_dialect, run_migrations  # noqa: E402
from app.models import AttendanceRecord, TaskLog, TeamWorkLog, User, WorkFormSubmission  # noqa: E402
from app.use_cases.record_trash import purge_expired_deleted_records  # noqa: E402


EXPECTED_TABLES = {
    "department",
    "registrationverification",
    "user",
    "site",
    "attendancerecord",
    "tasklog",
    "tasktemplate",
    "workform",
    "workformsubmission",
    "teamworklog",
    "teamworklogentry",
    "auditevent",
    "schema_migrations",
}

EXPECTED_VERSIONS = [
    "0001_initial_schema",
    "0002_work_form_photo_metadata",
    "0003_departments",
    "0004_registration_verification",
    "0005_dashboard_department_preference",
    "0006_manual_attendance_entries",
    "0007_record_rubbish_bin",
    "0008_manual_task_logs",
    "0009_worker_classes_and_team_logs",
    "0010_pdf_daywork_form_template",
    "0011_multi_team_daywork_form",
    "0012_form_and_team_log_rubbish_bin",
    "0013_daywork_team_break_options",
    "0014_client_submission_unique_indexes",
    "0015_work_form_definition_snapshots",
    "0016_review_queue_indexes",
    "0017_global_admin_supervisor_invariant",
    "0018_report_review_workflow",
    "0019_report_daywork_purpose",
]


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


def column_details(engine, table_name: str):
    return {
        column["name"]: column
        for column in inspect(engine).get_columns(table_name)
    }


def index_names(engine, table_name: str):
    return {index["name"] for index in inspect(engine).get_indexes(table_name)}


def assert_review_queue_indexes(engine, label: str):
    for table_name in ("attendancerecord", "tasklog", "workformsubmission", "teamworklog"):
        assert_contains(
            f"{label} {table_name} review queue indexes",
            index_names(engine, table_name),
            {
                f"ix_{table_name}_review_queue_department",
                f"ix_{table_name}_review_queue_global",
            },
        )


def assert_contains(label: str, actual, expected):
    missing = set(expected) - set(actual)

    if missing:
        raise AssertionError(f"{label}: missing {sorted(missing)}")


def copy_migrations_before_0014(target: Path):
    source = Path(__file__).resolve().parent / "migrations" / "versions"
    target.mkdir(parents=True, exist_ok=True)

    for path in source.glob("*.py"):
        if path.name in {
            "__init__.py",
            "0014_client_submission_unique_indexes.py",
            "0015_work_form_definition_snapshots.py",
            "0016_review_queue_indexes.py",
            "0017_global_admin_supervisor_invariant.py",
            "0018_report_review_workflow.py",
            "0019_report_daywork_purpose.py",
        }:
            continue
        shutil.copy2(path, target / path.name)


def copy_migrations_before_0017(target: Path):
    source = Path(__file__).resolve().parent / "migrations" / "versions"
    target.mkdir(parents=True, exist_ok=True)

    for path in source.glob("*.py"):
        if path.name in {
            "__init__.py",
            "0017_global_admin_supervisor_invariant.py",
            "0018_report_review_workflow.py",
            "0019_report_daywork_purpose.py",
        }:
            continue
        shutil.copy2(path, target / path.name)


def copy_migrations_before_0018(target: Path):
    source = Path(__file__).resolve().parent / "migrations" / "versions"
    target.mkdir(parents=True, exist_ok=True)

    for path in source.glob("*.py"):
        if path.name in {
            "__init__.py",
            "0018_report_review_workflow.py",
            "0019_report_daywork_purpose.py",
        }:
            continue
        shutil.copy2(path, target / path.name)


def copy_migrations_before_0019(target: Path):
    source = Path(__file__).resolve().parent / "migrations" / "versions"
    target.mkdir(parents=True, exist_ok=True)

    for path in source.glob("*.py"):
        if path.name in {"__init__.py", "0019_report_daywork_purpose.py"}:
            continue
        shutil.copy2(path, target / path.name)


def assert_migration_recorded(engine):
    with engine.begin() as connection:
        rows = connection.exec_driver_sql(
            "SELECT version FROM schema_migrations ORDER BY version"
        ).all()

    if [row[0] for row in rows] != EXPECTED_VERSIONS:
        raise AssertionError(f"schema_migrations: expected {EXPECTED_VERSIONS}")


def test_postgres_statement_adaptation():
    statement = """
    CREATE TABLE IF NOT EXISTS tasklog (
        id INTEGER PRIMARY KEY,
        created_at DATETIME NOT NULL
    )
    """

    adapted = adapt_statement_for_dialect(statement, "postgresql")

    if "GENERATED BY DEFAULT AS IDENTITY" not in adapted:
        raise AssertionError("postgres statement adaptation: expected identity primary key")
    if "TIMESTAMP WITH TIME ZONE" not in adapted:
        raise AssertionError("postgres statement adaptation: expected timezone timestamp")
    if adapt_statement_for_dialect(statement, "sqlite") != statement:
        raise AssertionError("postgres statement adaptation: sqlite statements should be unchanged")

    print("ok - postgres statement adaptation")


def test_fresh_database():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
        engine = make_engine(Path(directory) / "fresh.db")

        applied = run_migrations(engine)
        if applied != EXPECTED_VERSIONS:
            raise AssertionError(f"fresh migration: expected {EXPECTED_VERSIONS}, got {applied}")

        if run_migrations(engine) != []:
            raise AssertionError("fresh migration: second run should be a no-op")

        assert_contains("fresh tables", inspect(engine).get_table_names(), EXPECTED_TABLES)
        assert_contains(
            "fresh tasklog columns",
            columns(engine, "tasklog"),
            {
                "department_id",
                "work_date",
                "hours_worked",
                "safety_notes",
                "photo_urls",
                "status",
                "client_submission_id",
                "deleted_at",
                "deleted_by_supervisor_id",
                "deletion_reason",
                "entry_source",
                "created_by_supervisor_id",
            },
        )
        assert_contains(
            "fresh attendance columns",
            columns(engine, "attendancerecord"),
            {
                "department_id",
                "distance_from_site_m",
                "within_site_radius",
                "client_submission_id",
                "entry_source",
                "created_by_supervisor_id",
                "deleted_at",
                "deleted_by_supervisor_id",
                "deletion_reason",
            },
        )
        attendance_columns = column_details(engine, "attendancerecord")
        if not attendance_columns["latitude"]["nullable"] or not attendance_columns["longitude"]["nullable"]:
            raise AssertionError("fresh attendance columns: manual entries require nullable coordinates")
        assert_contains(
            "fresh form submission columns",
            columns(engine, "workformsubmission"),
            {
                "department_id",
                "photo_metadata",
                "deleted_at",
                "deleted_by_supervisor_id",
                "deletion_reason",
                "form_definition_version",
                "definition_snapshot_json",
                "workflow_status",
                "supervisor_note",
                "reviewing_supervisor_id",
                "review_started_at",
                "resolved_at",
                "submission_purpose",
            },
        )
        assert_contains(
            "fresh user columns",
            columns(engine, "user"),
            {"department_id", "dashboard_department_id", "is_global_admin"},
        )
        assert_contains(
            "fresh user worker class",
            columns(engine, "user"),
            {"worker_class"},
        )
        assert_contains(
            "fresh team work log columns",
            columns(engine, "teamworklog"),
            {
                "department_id",
                "leader_id",
                "week_start",
                "notes",
                "client_submission_id",
                "status",
                "deleted_at",
                "deleted_by_supervisor_id",
                "deletion_reason",
                "created_at",
            },
        )
        assert_contains(
            "fresh team work log entry columns",
            columns(engine, "teamworklogentry"),
            {"team_work_log_id", "worker_id", "site_id", "work_date", "start_time", "end_time", "break_minutes", "hours_worked", "work_description"},
        )
        assert_contains(
            "fresh registration verification columns",
            columns(engine, "registrationverification"),
            {"email", "name", "code_hash", "token_hash", "attempts", "expires_at", "verified_at", "consumed_at"},
        )
        assert_contains("fresh site columns", columns(engine, "site"), {"department_id"})
        assert_contains(
            "fresh workform columns",
            columns(engine, "workform"),
            {"department_id", "definition_version", "template_purpose"},
        )
        assert_review_queue_indexes(engine, "fresh")
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
            connection.exec_driver_sql(
                """
                INSERT INTO workformsubmission (
                    id,
                    form_id,
                    worker_id,
                    answers_json,
                    created_at
                ) VALUES (
                    1,
                    1,
                    1,
                    '{}',
                    '2026-01-01T00:00:00Z'
                )
                """
            )

        applied = run_migrations(engine)
        if applied != EXPECTED_VERSIONS:
            raise AssertionError(f"legacy migration: expected {EXPECTED_VERSIONS}, got {applied}")

        assert_contains("legacy tables", inspect(engine).get_table_names(), EXPECTED_TABLES)
        assert_contains(
            "legacy user columns",
            columns(engine, "user"),
            {"status", "department_id", "dashboard_department_id", "is_global_admin", "worker_class"},
        )
        assert_contains(
            "legacy registration verification columns",
            columns(engine, "registrationverification"),
            {"email", "name", "code_hash", "token_hash", "attempts", "expires_at", "verified_at", "consumed_at"},
        )
        assert_contains(
            "legacy tasklog columns",
            columns(engine, "tasklog"),
            {
                "department_id",
                "work_date",
                "hours_worked",
                "safety_notes",
                "photo_urls",
                "status",
                "client_submission_id",
                "deleted_at",
                "deleted_by_supervisor_id",
                "deletion_reason",
                "entry_source",
                "created_by_supervisor_id",
            },
        )
        assert_contains(
            "legacy attendance columns",
            columns(engine, "attendancerecord"),
            {
                "department_id",
                "distance_from_site_m",
                "within_site_radius",
                "client_submission_id",
                "entry_source",
                "created_by_supervisor_id",
                "deleted_at",
                "deleted_by_supervisor_id",
                "deletion_reason",
            },
        )
        attendance_columns = column_details(engine, "attendancerecord")
        if not attendance_columns["latitude"]["nullable"] or not attendance_columns["longitude"]["nullable"]:
            raise AssertionError("legacy attendance columns: manual entries require nullable coordinates")
        assert_contains(
            "legacy form submission columns",
            columns(engine, "workformsubmission"),
            {
                "department_id",
                "status",
                "client_submission_id",
                "photo_metadata",
                "deleted_at",
                "deleted_by_supervisor_id",
                "deletion_reason",
                "form_definition_version",
                "definition_snapshot_json",
                "workflow_status",
                "supervisor_note",
                "reviewing_supervisor_id",
                "review_started_at",
                "resolved_at",
                "submission_purpose",
            },
        )
        with engine.begin() as connection:
            snapshot_row = connection.exec_driver_sql(
                "SELECT form_definition_version, definition_snapshot_json FROM workformsubmission WHERE id = 1"
            ).first()
        if not snapshot_row or snapshot_row[0] != 1 or '"name":"Form 1"' not in snapshot_row[1]:
            raise AssertionError("legacy form submission: expected frozen fallback definition snapshot")
        assert_contains(
            "legacy team work log columns",
            columns(engine, "teamworklog"),
            {"deleted_at", "deleted_by_supervisor_id", "deletion_reason"},
        )
        assert_review_queue_indexes(engine, "legacy")
        assert_migration_recorded(engine)
        engine.dispose()

    print("ok - legacy database migration")


def test_report_review_workflow_migration():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
        root = Path(directory)
        old_migrations_dir = root / "pre-0018-migrations"
        copy_migrations_before_0018(old_migrations_dir)
        engine = make_engine(root / "report-review-workflow.db")
        applied_before = run_migrations(engine, migrations_dir=old_migrations_dir)
        if applied_before != EXPECTED_VERSIONS[:-2]:
            raise AssertionError(
                f"report workflow setup: expected {EXPECTED_VERSIONS[:-2]}, got {applied_before}"
            )

        legacy_payload = {
            "site_id": 77,
            "work_date": "2026-01-31",
            "answers_json": '{"issue":"Missing PPE","worker_signature":"/uploads/legacy-signature.png"}',
            "photo_urls": '["/uploads/legacy-photo.png"]',
            "photo_metadata": '[{"url":"/uploads/legacy-photo.png","name":"legacy-photo.png"}]',
            "client_submission_id": "legacy-report-replay-key",
            "form_definition_version": 4,
            "definition_snapshot_json": '{"version":4,"name":"Legacy PPE Report","description":null,"fields":[]}',
        }
        with engine.begin() as connection:
            connection.exec_driver_sql(
                """
                INSERT INTO "user" (
                    id, email, name, password_hash, role, status,
                    department_id, is_global_admin, worker_class
                ) VALUES (
                    1, 'report-reviewer@example.com', 'Report Reviewer', 'test',
                    'supervisor', 'active', 1, FALSE, NULL
                )
                """
            )
            connection.exec_driver_sql(
                """
                INSERT INTO workformsubmission (
                    id, department_id, form_id, worker_id, answers_json, status, created_at
                ) VALUES
                    (1, 1, 1, 10, '{}', 'pending',  '2026-02-01T00:00:00Z'),
                    (2, 1, 1, 11, '{}', 'approved', '2026-02-02T00:00:00Z'),
                    (3, 1, 1, 12, '{}', 'rejected', '2026-02-03T00:00:00Z'),
                    (4, 1, 1, 13, '{}', 'legacy',   '2026-02-04T00:00:00Z'),
                    (5, 1, 1, 14, '{}', 'approved', '2026-02-05T00:00:00Z')
                """
            )
            connection.exec_driver_sql(
                """
                UPDATE workformsubmission
                SET site_id = ?, work_date = ?, answers_json = ?, photo_urls = ?,
                    photo_metadata = ?, client_submission_id = ?,
                    form_definition_version = ?, definition_snapshot_json = ?
                WHERE id = 1
                """,
                tuple(legacy_payload.values()),
            )
            connection.exec_driver_sql(
                """
                INSERT INTO auditevent (
                    department_id, actor_id, action, entity_type, entity_id,
                    summary, created_at
                ) VALUES (
                    1, 1, 'review_decision', 'form', 2,
                    'Approved form record #2', '2026-02-03T04:05:06Z'
                )
                """
            )
            connection.exec_driver_sql(
                """
                INSERT INTO auditevent (
                    department_id, actor_id, action, entity_type, entity_id,
                    summary, created_at
                ) VALUES (
                    1, 1, 'form_submission_manual_create', 'form_submission', 5,
                    'Added approved Report for Worker', '2026-02-05T06:07:08Z'
                )
                """
            )

        applied = run_migrations(engine)
        if applied != [
            "0018_report_review_workflow",
            "0019_report_daywork_purpose",
        ]:
            raise AssertionError(f"report workflow migration: unexpected versions {applied}")

        with engine.begin() as connection:
            rows = connection.exec_driver_sql(
                """
                SELECT id, status, workflow_status, reviewing_supervisor_id,
                       review_started_at, resolved_at, supervisor_note
                FROM workformsubmission
                ORDER BY id
                """
            ).all()

        expected = [
            (1, "pending", "submitted", None, None, None, None),
            (
                2,
                "approved",
                "resolved",
                1,
                "2026-02-03T04:05:06Z",
                "2026-02-03T04:05:06Z",
                None,
            ),
            (3, "rejected", "resolved", None, None, None, None),
            (4, "legacy", "submitted", None, None, None, None),
            (
                5,
                "approved",
                "resolved",
                1,
                "2026-02-05T06:07:08Z",
                "2026-02-05T06:07:08Z",
                None,
            ),
        ]
        if rows != expected:
            raise AssertionError(f"report workflow backfill: unexpected rows {rows}")

        with engine.begin() as connection:
            preserved_payload = connection.exec_driver_sql(
                """
                SELECT site_id, work_date, answers_json, photo_urls, photo_metadata,
                       client_submission_id, form_definition_version,
                       definition_snapshot_json
                FROM workformsubmission
                WHERE id = 1
                """
            ).one()
        if preserved_payload != tuple(legacy_payload.values()):
            raise AssertionError(
                f"report workflow migration changed legacy submitted content: {preserved_payload}"
            )

        workflow_columns = column_details(engine, "workformsubmission")
        workflow_column = workflow_columns["workflow_status"]
        if workflow_column["nullable"] or "submitted" not in str(workflow_column["default"]):
            raise AssertionError(
                f"report workflow column must be non-null with submitted default: {workflow_column}"
            )
        for column_name in (
            "supervisor_note",
            "reviewing_supervisor_id",
            "review_started_at",
            "resolved_at",
        ):
            if not workflow_columns[column_name]["nullable"]:
                raise AssertionError(f"historical review metadata must remain nullable: {column_name}")

        with engine.begin() as connection:
            connection.exec_driver_sql(
                """
                INSERT INTO workformsubmission (
                    id, department_id, form_id, worker_id, answers_json, status, created_at
                ) VALUES (6, 1, 1, 15, '{}', 'pending', '2026-02-06T00:00:00Z')
                """
            )
            default_workflow = connection.exec_driver_sql(
                "SELECT workflow_status FROM workformsubmission WHERE id = 6"
            ).scalar_one()
        if default_workflow != "submitted":
            raise AssertionError("new Report row did not receive the submitted workflow default")

        assert_contains(
            "report workflow indexes",
            index_names(engine, "workformsubmission"),
            {
                "ix_workformsubmission_workflow_status",
                "ix_workformsubmission_reviewing_supervisor_id",
                "ix_workformsubmission_report_workflow",
            },
        )
        assert_statement_rejected(
            engine,
            "report workflow status update",
            "UPDATE workformsubmission SET workflow_status = 'invalid' WHERE id = 1",
        )
        assert_statement_rejected(
            engine,
            "report workflow status insert",
            """
            INSERT INTO workformsubmission (
                id, department_id, form_id, worker_id, answers_json, status,
                workflow_status, created_at
            ) VALUES (7, 1, 1, 16, '{}', 'pending', 'invalid', '2026-02-07T00:00:00Z')
            """,
        )
        assert_statement_rejected(
            engine,
            "report workflow null update",
            "UPDATE workformsubmission SET workflow_status = NULL WHERE id = 1",
        )
        assert_migration_recorded(engine)
        if run_migrations(engine) != []:
            raise AssertionError("report workflow migration was not idempotent on a second run")
        engine.dispose()

    print("ok - report review workflow status backfill")


def test_report_daywork_purpose_migration():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
        root = Path(directory)
        old_migrations_dir = root / "pre-0019-migrations"
        copy_migrations_before_0019(old_migrations_dir)
        engine = make_engine(root / "report-daywork-purpose.db")
        applied_before = run_migrations(engine, migrations_dir=old_migrations_dir)
        if applied_before != EXPECTED_VERSIONS[:-1]:
            raise AssertionError(
                f"purpose setup: expected {EXPECTED_VERSIONS[:-1]}, got {applied_before}"
            )

        with engine.begin() as connection:
            connection.exec_driver_sql(
                """
                INSERT INTO workform (
                    id, department_id, name, description, fields_json,
                    definition_version, status, created_at
                ) VALUES
                    (10, 1, 'Daywork log form', 'Built-in Daywork',
                     '[{"id":"work_completed"},{"id":"hours_worked"},{"id":"materials_used"},{"id":"safety_notes"},{"id":"worker_signature"}]',
                     7, 'active',
                     '2026-08-01T00:00:00Z'),
                    (11, 1, 'PPE issue form', 'Worker Report', '[]', 3, 'active',
                     '2026-08-02T00:00:00Z'),
                    (12, 1, 'Legacy labour docket', 'Renamed legacy template',
                     '[{"id":"teams"},{"id":"team_people"},{"id":"team_time"},{"id":"team_man_hours"},{"id":"job_description"},{"id":"signature"}]',
                     5, 'active', '2026-08-03T00:00:00Z'),
                    (13, 2, 'Daywork log form', 'PPE issue report with a misleading legacy name',
                     '[{"id":"issue"},{"id":"worker_signature"}]',
                     1, 'active', '2026-08-04T00:00:00Z'),
                    (14, 1, 'Legacy labour evidence', 'Template edited after submissions',
                     '[{"id":"custom_note"}]',
                     9, 'active', '2026-08-05T00:00:00Z')
                """
            )
            connection.exec_driver_sql(
                """
                INSERT INTO workformsubmission (
                    id, department_id, form_id, worker_id, site_id, work_date,
                    answers_json, photo_urls, photo_metadata, client_submission_id,
                    form_definition_version, definition_snapshot_json, status,
                    workflow_status, supervisor_note, reviewing_supervisor_id,
                    review_started_at, resolved_at, created_at
                ) VALUES
                    (20, 1, 10, 100, 77, '2026-08-01',
                     '{"hours":8}', '["/uploads/daywork.png"]',
                     '[{"url":"/uploads/daywork.png"}]', 'daywork-evidence',
                     7, '{"version":7,"name":"Daywork log form","fields":[{"id":"work_completed"},{"id":"hours_worked"},{"id":"materials_used"},{"id":"safety_notes"},{"id":"worker_signature"}]}',
                     'approved', 'resolved', 'Checked', 900,
                     '2026-08-02T03:00:00Z', '2026-08-02T04:00:00Z',
                     '2026-08-01T09:00:00Z'),
                    (21, 1, 11, 101, NULL, '2026-08-02',
                     '{"issue":"Missing helmet"}', '["/uploads/report.png"]',
                     '[{"url":"/uploads/report.png"}]', 'report-evidence',
                     3, '{"version":3,"name":"PPE issue form","fields":[]}',
                     'pending', 'in_review', 'Investigating', 901,
                     '2026-08-03T03:00:00Z', NULL,
                     '2026-08-02T09:00:00Z'),
                    (25, 1, 14, 102, NULL, '2026-08-03',
                     '{"teams":[]}', NULL, NULL, 'renamed-daywork-evidence',
                     8, '{"version":8,"name":"Daywork log form","fields":[{"id":"teams"},{"id":"team_people"},{"id":"team_time"},{"id":"team_man_hours"},{"id":"job_description"},{"id":"signature"}]}',
                     'pending', 'submitted', NULL, NULL, NULL, NULL,
                     '2026-08-03T09:00:00Z'),
                    (30, 1, 10, 103, NULL, '2026-08-04',
                     '{"issue":"Historical Report"}', NULL, NULL,
                     'historical-report-evidence',
                     6, '{"version":6,"name":"PPE issue form","fields":[{"id":"issue"},{"id":"worker_signature"}]}',
                     'pending', 'submitted', NULL, NULL, NULL, NULL,
                     '2026-08-04T09:00:00Z')
                """
            )
            evidence_before = connection.exec_driver_sql(
                """
                SELECT id, department_id, form_id, worker_id, site_id, work_date,
                       answers_json, photo_urls, photo_metadata, client_submission_id,
                       form_definition_version, definition_snapshot_json, status,
                       workflow_status, supervisor_note, reviewing_supervisor_id,
                       review_started_at, resolved_at, created_at
                FROM workformsubmission
                WHERE id IN (20, 21, 25, 30)
                ORDER BY id
                """
            ).all()

        applied = run_migrations(engine)
        if applied != ["0019_report_daywork_purpose"]:
            raise AssertionError(f"purpose migration: unexpected versions {applied}")

        with engine.begin() as connection:
            form_rows = connection.exec_driver_sql(
                "SELECT id, template_purpose FROM workform WHERE id IN (10, 11, 12, 13, 14) ORDER BY id"
            ).all()
            submission_rows = connection.exec_driver_sql(
                "SELECT id, submission_purpose FROM workformsubmission "
                "WHERE id IN (20, 21, 25, 30) ORDER BY id"
            ).all()
            evidence_after = connection.exec_driver_sql(
                """
                SELECT id, department_id, form_id, worker_id, site_id, work_date,
                       answers_json, photo_urls, photo_metadata, client_submission_id,
                       form_definition_version, definition_snapshot_json, status,
                       workflow_status, supervisor_note, reviewing_supervisor_id,
                       review_started_at, resolved_at, created_at
                FROM workformsubmission
                WHERE id IN (20, 21, 25, 30)
                ORDER BY id
                """
            ).all()

        if form_rows != [
            (10, "daywork"),
            (11, "report"),
            (12, "daywork"),
            (13, "report"),
            (14, "report"),
        ]:
            raise AssertionError(f"template purpose backfill: unexpected rows {form_rows}")
        if submission_rows != [
            (20, "daywork"),
            (21, "report"),
            (25, "daywork"),
            (30, "report"),
        ]:
            raise AssertionError(
                f"submission purpose backfill: unexpected rows {submission_rows}"
            )
        if evidence_after != evidence_before:
            raise AssertionError("purpose migration changed historical submitted evidence")

        with engine.begin() as connection:
            connection.exec_driver_sql(
                """
                INSERT INTO workformsubmission (
                    id, department_id, form_id, worker_id, answers_json,
                    status, workflow_status, created_at
                ) VALUES (
                    22, 1, 10, 102, '{}', 'pending', 'submitted',
                    '2026-08-03T09:00:00Z'
                )
                """
            )
            legacy_insert_purpose = connection.exec_driver_sql(
                "SELECT submission_purpose FROM workformsubmission WHERE id = 22"
            ).scalar_one()
        if legacy_insert_purpose != "daywork":
            raise AssertionError(
                "raw legacy Daywork insert must derive purpose from its parent Template"
            )
        assert_statement_rejected(
            engine,
            "legacy Supervisor cannot insert an approved Report",
            """
            INSERT INTO workformsubmission (
                id, department_id, form_id, worker_id, answers_json,
                status, workflow_status, created_at
            ) VALUES (
                23, 1, 11, 103, '{}', 'approved', 'submitted',
                '2026-08-04T09:00:00Z'
            )
            """,
        )
        assert_statement_rejected(
            engine,
            "Report insert cannot impersonate a review transition",
            """
            INSERT INTO workformsubmission (
                id, department_id, form_id, worker_id, answers_json,
                status, workflow_status, supervisor_note,
                reviewing_supervisor_id, review_started_at, created_at
            ) VALUES (
                24, 1, 11, 104, '{}', 'pending', 'in_review',
                'Inserted as reviewed', 900, '2026-08-04T08:55:00Z',
                '2026-08-04T09:00:00Z'
            )
            """,
        )
        assert_statement_rejected(
            engine,
            "orphan submission cannot claim Daywork to bypass the Report boundary",
            """
            INSERT INTO workformsubmission (
                id, department_id, form_id, worker_id, answers_json,
                status, workflow_status, submission_purpose, created_at
            ) VALUES (
                28, 1, 9999, 107, '{}', 'approved', 'submitted', 'daywork',
                '2026-08-04T10:00:00Z'
            )
            """,
        )
        assert_statement_rejected(
            engine,
            "submission insert cannot use an invalid purpose",
            """
            INSERT INTO workformsubmission (
                id, department_id, form_id, worker_id, answers_json,
                status, workflow_status, submission_purpose, created_at
            ) VALUES (
                29, 1, 11, 108, '{}', 'pending', 'submitted', 'invalid',
                '2026-08-04T11:00:00Z'
            )
            """,
        )

        with engine.begin() as connection:
            connection.exec_driver_sql(
                """
                UPDATE workformsubmission
                SET answers_json = '{"teams":[{"job_description":"Historical edit"}]}',
                    status = 'approved',
                    submission_purpose = 'daywork'
                WHERE id = 25
                """
            )
            historical_daywork_update = connection.exec_driver_sql(
                """
                SELECT answers_json, status, submission_purpose
                FROM workformsubmission
                WHERE id = 25
                """
            ).one()
        if historical_daywork_update != (
            '{"teams":[{"job_description":"Historical edit"}]}',
            "approved",
            "daywork",
        ):
            raise AssertionError(
                "historical Daywork must remain editable after its parent Template becomes a Report"
            )
        assert_statement_rejected(
            engine,
            "historical Daywork purpose cannot be rewritten to its current Report parent",
            "UPDATE workformsubmission SET submission_purpose = 'report' WHERE id = 25",
        )
        assert_statement_rejected(
            engine,
            "historical Report remains immutable after its parent Template becomes Daywork",
            """
            UPDATE workformsubmission
            SET answers_json = '{"issue":"Rewritten historical Report"}',
                status = 'approved'
            WHERE id = 30
            """,
        )
        assert_statement_rejected(
            engine,
            "historical Report purpose cannot be rewritten to its current Daywork parent",
            "UPDATE workformsubmission SET submission_purpose = 'daywork' WHERE id = 30",
        )

        with engine.begin() as connection:
            connection.exec_driver_sql(
                """
                INSERT INTO workformsubmission (
                    id, department_id, form_id, worker_id, answers_json,
                    status, workflow_status, submission_purpose, created_at
                ) VALUES (
                    26, 1, 11, 105, '{"issue":"New Report"}',
                    'pending', 'submitted', 'daywork',
                    '2026-08-05T09:00:00Z'
                )
                """
            )
            connection.exec_driver_sql(
                """
                INSERT INTO workformsubmission (
                    id, department_id, form_id, worker_id, answers_json,
                    status, workflow_status, created_at
                ) VALUES (
                    27, 1, 10, 106, '{"work_completed":"Retained"}',
                    'approved', 'submitted', '2026-08-05T10:00:00Z'
                )
                """
            )
            allowed_inserts = connection.exec_driver_sql(
                """
                SELECT id, status, workflow_status, submission_purpose
                FROM workformsubmission
                WHERE id IN (26, 27)
                ORDER BY id
                """
            ).all()
        if allowed_inserts != [
            (26, "pending", "submitted", "report"),
            (27, "approved", "submitted", "daywork"),
        ]:
            raise AssertionError(
                f"purpose boundary changed valid Report/Daywork inserts: {allowed_inserts}"
            )
        assert_statement_rejected(
            engine,
            "insert purpose synchronization cannot authorize a later purpose rewrite",
            "UPDATE workformsubmission SET submission_purpose = 'report' WHERE id = 27",
        )

        with engine.begin() as connection:
            connection.exec_driver_sql(
                """
                UPDATE workformsubmission
                SET workflow_status = 'resolved',
                    supervisor_note = 'Replacement PPE issued',
                    reviewing_supervisor_id = 902,
                    review_started_at = '2026-08-03T03:00:00Z',
                    resolved_at = '2026-08-05T11:00:00Z'
                WHERE id = 21
                """
            )
            connection.exec_driver_sql(
                """
                UPDATE workformsubmission
                SET deleted_at = '2026-08-05T12:00:00Z',
                    deleted_by_supervisor_id = 902,
                    deletion_reason = 'Temporary cleanup'
                WHERE id = 21
                """
            )
            trashed_report = connection.exec_driver_sql(
                """
                SELECT workflow_status, supervisor_note, reviewing_supervisor_id,
                       review_started_at, resolved_at, deleted_at,
                       deleted_by_supervisor_id, deletion_reason
                FROM workformsubmission
                WHERE id = 21
                """
            ).one()
            connection.exec_driver_sql(
                """
                UPDATE workformsubmission
                SET deleted_at = NULL,
                    deleted_by_supervisor_id = NULL,
                    deletion_reason = NULL
                WHERE id = 21
                """
            )
            connection.exec_driver_sql(
                """
                UPDATE workformsubmission
                SET site_id = 88,
                    work_date = '2026-08-06',
                    answers_json = '{"work_completed":"Edited Daywork"}',
                    status = 'approved'
                WHERE id = 22
                """
            )
            restored_trash = connection.exec_driver_sql(
                """
                SELECT deleted_at, deleted_by_supervisor_id, deletion_reason
                FROM workformsubmission
                WHERE id = 21
                """
            ).one()
            edited_daywork = connection.exec_driver_sql(
                """
                SELECT site_id, work_date, answers_json, status, submission_purpose
                FROM workformsubmission
                WHERE id = 22
                """
            ).one()

        if trashed_report != (
            "resolved",
            "Replacement PPE issued",
            902,
            "2026-08-03T03:00:00Z",
            "2026-08-05T11:00:00Z",
            "2026-08-05T12:00:00Z",
            902,
            "Temporary cleanup",
        ):
            raise AssertionError(
                f"Report boundary blocked valid review/trash metadata: {trashed_report}"
            )
        if restored_trash != (None, None, None):
            raise AssertionError(
                f"Report boundary blocked valid rubbish-bin restore: {restored_trash}"
            )
        if edited_daywork != (
            88,
            "2026-08-06",
            '{"work_completed":"Edited Daywork"}',
            "approved",
            "daywork",
        ):
            raise AssertionError(
                f"Report boundary changed retained Daywork edit behavior: {edited_daywork}"
            )

        form_columns = column_details(engine, "workform")
        submission_columns = column_details(engine, "workformsubmission")
        if (
            form_columns["template_purpose"]["nullable"]
            or "report" not in str(form_columns["template_purpose"]["default"])
        ):
            raise AssertionError("template purpose must be non-null with report default")
        if (
            submission_columns["submission_purpose"]["nullable"]
            or "report" not in str(submission_columns["submission_purpose"]["default"])
        ):
            raise AssertionError("submission purpose must be non-null with report default")

        assert_contains(
            "purpose indexes",
            index_names(engine, "workform") | index_names(engine, "workformsubmission"),
            {
                "ix_workform_template_purpose",
                "ix_workformsubmission_submission_purpose",
            },
        )
        assert_statement_rejected(
            engine,
            "invalid template purpose",
            "UPDATE workform SET template_purpose = 'invalid' WHERE id = 10",
        )
        assert_statement_rejected(
            engine,
            "invalid submission purpose",
            "UPDATE workformsubmission SET submission_purpose = 'invalid' WHERE id = 20",
        )
        assert_statement_rejected(
            engine,
            "Report purpose cannot be rewritten as Daywork",
            "UPDATE workformsubmission SET submission_purpose = 'daywork' WHERE id = 21",
        )
        assert_statement_rejected(
            engine,
            "legacy approval cannot change a Report outcome",
            "UPDATE workformsubmission SET status = 'approved' WHERE id = 21",
        )
        assert_statement_rejected(
            engine,
            "legacy edit cannot replace submitted Report evidence",
            """
            UPDATE workformsubmission
            SET site_id = 88,
                work_date = '2026-09-30',
                answers_json = '{"issue":"Rewritten"}',
                photo_urls = '["/uploads/replacement.png"]',
                photo_metadata = '[{"url":"/uploads/replacement.png"}]',
                definition_snapshot_json = '{"version":99,"name":"Replacement","fields":[]}'
            WHERE id = 21
            """,
        )
        assert_migration_recorded(engine)
        if run_migrations(engine) != []:
            raise AssertionError("purpose migration was not idempotent on a second run")
        engine.dispose()

    print("ok - Report and Daywork purpose backfill preserves evidence")


def assert_statement_rejected(engine, label: str, statement: str):
    try:
        with engine.begin() as connection:
            connection.exec_driver_sql(statement)
    except IntegrityError:
        return
    raise AssertionError(f"{label}: expected database integrity rejection")


def test_global_admin_supervisor_invariant_migration():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
        root = Path(directory)
        old_migrations_dir = root / "pre-0017-migrations"
        copy_migrations_before_0017(old_migrations_dir)
        engine = make_engine(root / "global-admin-invariant.db")
        applied_before = run_migrations(engine, migrations_dir=old_migrations_dir)
        if applied_before != EXPECTED_VERSIONS[:-3]:
            raise AssertionError(
                f"global admin invariant setup: expected {EXPECTED_VERSIONS[:-3]}, got {applied_before}"
            )

        with engine.begin() as connection:
            connection.exec_driver_sql(
                """
                INSERT INTO "user" (
                    email, name, password_hash, role, status, department_id,
                    is_global_admin, worker_class
                ) VALUES (
                    'legacy-global-worker@example.com', 'Legacy Global Worker', 'test',
                    'worker', 'active', 1, TRUE, 'normal'
                )
                """
            )
            connection.exec_driver_sql(
                """
                INSERT INTO "user" (
                    email, name, password_hash, role, status, department_id,
                    is_global_admin, worker_class
                ) VALUES (
                    'legacy-noncanonical-global-worker@example.com',
                    'Legacy Noncanonical Global Worker', 'test',
                    'worker', 'active', 1, 2, 'normal'
                )
                """
            )
            connection.exec_driver_sql(
                """
                INSERT INTO "user" (
                    email, name, password_hash, role, status, department_id,
                    is_global_admin, worker_class
                ) VALUES (
                    'valid-global-supervisor@example.com', 'Valid Global Supervisor', 'test',
                    'supervisor', 'active', 1, TRUE, NULL
                )
                """
            )

        applied = run_migrations(engine)
        if applied != [
            "0017_global_admin_supervisor_invariant",
            "0018_report_review_workflow",
            "0019_report_daywork_purpose",
        ]:
            raise AssertionError(f"global admin invariant migration: unexpected versions {applied}")

        with engine.begin() as connection:
            repaired_worker = connection.exec_driver_sql(
                "SELECT role, is_global_admin FROM \"user\" "
                "WHERE email = 'legacy-global-worker@example.com'"
            ).first()
            retained_supervisor = connection.exec_driver_sql(
                "SELECT role, is_global_admin FROM \"user\" "
                "WHERE email = 'valid-global-supervisor@example.com'"
            ).first()
            repaired_noncanonical_worker = connection.exec_driver_sql(
                "SELECT role, is_global_admin FROM \"user\" "
                "WHERE email = 'legacy-noncanonical-global-worker@example.com'"
            ).first()
        if repaired_worker != ("worker", 0):
            raise AssertionError(f"global admin invariant repair: unexpected Worker row {repaired_worker}")
        if retained_supervisor != ("supervisor", 1):
            raise AssertionError(
                f"global admin invariant repair: valid Supervisor changed {retained_supervisor}"
            )
        if repaired_noncanonical_worker != ("worker", 0):
            raise AssertionError(
                "global admin invariant repair: noncanonical truthy Worker flag "
                f"was retained {repaired_noncanonical_worker}"
            )

        assert_statement_rejected(
            engine,
            "global admin invariant insert",
            """
            INSERT INTO "user" (
                email, name, password_hash, role, status, department_id,
                is_global_admin, worker_class
            ) VALUES (
                'rejected-global-worker@example.com', 'Rejected Global Worker', 'test',
                'worker', 'active', 1, TRUE, 'normal'
            )
            """,
        )
        assert_statement_rejected(
            engine,
            "global admin invariant update",
            """
            UPDATE "user"
            SET role = 'worker'
            WHERE email = 'valid-global-supervisor@example.com'
            """,
        )
        assert_statement_rejected(
            engine,
            "global admin invariant noncanonical truthy insert",
            """
            INSERT INTO "user" (
                email, name, password_hash, role, status, department_id,
                is_global_admin, worker_class
            ) VALUES (
                'rejected-noncanonical-global-worker@example.com',
                'Rejected Noncanonical Global Worker', 'test',
                'worker', 'active', 1, 2, 'normal'
            )
            """,
        )
        assert_statement_rejected(
            engine,
            "global admin invariant noncanonical truthy update",
            """
            UPDATE "user"
            SET is_global_admin = 2
            WHERE email = 'legacy-global-worker@example.com'
            """,
        )

        with engine.begin() as connection:
            connection.exec_driver_sql(
                """
                UPDATE "user"
                SET role = 'worker', is_global_admin = FALSE, worker_class = 'normal'
                WHERE email = 'valid-global-supervisor@example.com'
                """
            )
            downgraded = connection.exec_driver_sql(
                "SELECT role, is_global_admin, worker_class FROM \"user\" "
                "WHERE email = 'valid-global-supervisor@example.com'"
            ).first()
        if downgraded != ("worker", 0, "normal"):
            raise AssertionError(f"global admin invariant atomic downgrade: unexpected row {downgraded}")

        assert_migration_recorded(engine)
        engine.dispose()

    print("ok - global admin access requires the Supervisor role")


def assert_duplicate_rejected(session: Session, label: str, first, duplicate, allowed):
    session.add(first)
    session.commit()

    session.add(duplicate)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
    else:
        raise AssertionError(f"{label}: duplicate client_submission_id should be rejected")

    session.add(allowed)
    session.commit()


def test_client_submission_unique_indexes():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
        engine = make_engine(Path(directory) / "idempotency.db")
        run_migrations(engine)

        with Session(engine) as session:
            assert_duplicate_rejected(
                session,
                "attendance idempotency index",
                AttendanceRecord(worker_id=1, record_type="check_in", client_submission_id="same-attendance"),
                AttendanceRecord(worker_id=1, record_type="check_out", client_submission_id="same-attendance"),
                AttendanceRecord(worker_id=2, record_type="check_in", client_submission_id="same-attendance"),
            )
            assert_duplicate_rejected(
                session,
                "task-log idempotency index",
                TaskLog(worker_id=1, description="First task", client_submission_id="same-task"),
                TaskLog(worker_id=1, description="Duplicate task", client_submission_id="same-task"),
                TaskLog(worker_id=2, description="Allowed task", client_submission_id="same-task"),
            )
            assert_duplicate_rejected(
                session,
                "form-submission idempotency index",
                WorkFormSubmission(form_id=1, worker_id=1, answers_json="{}", client_submission_id="same-form"),
                WorkFormSubmission(form_id=1, worker_id=1, answers_json="{}", client_submission_id="same-form"),
                WorkFormSubmission(form_id=1, worker_id=2, answers_json="{}", client_submission_id="same-form"),
            )
            assert_duplicate_rejected(
                session,
                "team-work-log idempotency index",
                TeamWorkLog(leader_id=1, week_start="2026-06-29", client_submission_id="same-team-log"),
                TeamWorkLog(leader_id=1, week_start="2026-07-06", client_submission_id="same-team-log"),
                TeamWorkLog(leader_id=2, week_start="2026-06-29", client_submission_id="same-team-log"),
            )

        engine.dispose()

    print("ok - client submission unique indexes")


def test_client_submission_duplicate_precheck():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
        root = Path(directory)
        old_migrations_dir = root / "pre-0014-migrations"
        copy_migrations_before_0014(old_migrations_dir)
        engine = make_engine(root / "precheck.db")
        run_migrations(engine, migrations_dir=old_migrations_dir)

        with Session(engine) as session:
            session.add(AttendanceRecord(worker_id=7, record_type="check_in", client_submission_id="duplicate-key"))
            session.add(AttendanceRecord(worker_id=7, record_type="check_out", client_submission_id="duplicate-key"))
            session.commit()

        try:
            run_migrations(engine)
        except RuntimeError as error:
            message = str(error)
            if "duplicate client submission ids exist" not in message:
                raise AssertionError(f"client submission duplicate precheck: unexpected error {message}") from error
        else:
            raise AssertionError("client submission duplicate precheck: migration should fail on existing duplicates")
        finally:
            engine.dispose()

    print("ok - client submission duplicate precheck")


def test_rubbish_bin_purge():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
        engine = make_engine(Path(directory) / "trash.db")
        run_migrations(engine)
        now = datetime.now(timezone.utc)

        with Session(engine) as session:
            supervisor = User(
                department_id=1,
                email="trash-supervisor@example.com",
                name="Trash Supervisor",
                password_hash="test",
                role="supervisor",
            )
            session.add(supervisor)
            session.flush()
            expired_attendance = AttendanceRecord(
                department_id=1,
                worker_id=999,
                record_type="check_in",
                latitude=-36.8,
                longitude=174.7,
                status="approved",
                deleted_at=now - timedelta(days=31),
                deleted_by_supervisor_id=supervisor.id,
                deletion_reason="Expired duplicate",
            )
            retained_task = TaskLog(
                department_id=1,
                worker_id=999,
                description="Retained deleted task",
                status="approved",
                deleted_at=now - timedelta(days=29),
                deleted_by_supervisor_id=supervisor.id,
                deletion_reason="Recent duplicate",
            )
            expired_form_submission = WorkFormSubmission(
                department_id=1,
                form_id=1,
                worker_id=999,
                answers_json="{}",
                status="pending",
                deleted_at=now - timedelta(days=31),
                deleted_by_supervisor_id=supervisor.id,
                deletion_reason="Expired duplicate",
            )
            retained_team_log = TeamWorkLog(
                department_id=1,
                leader_id=999,
                week_start="2026-06-29",
                status="approved",
                deleted_at=now - timedelta(days=29),
                deleted_by_supervisor_id=supervisor.id,
                deletion_reason="Recent duplicate",
            )
            session.add(expired_attendance)
            session.add(retained_task)
            session.add(expired_form_submission)
            session.add(retained_team_log)
            session.commit()
            expired_id = expired_attendance.id
            retained_id = retained_task.id
            expired_form_id = expired_form_submission.id
            retained_team_log_id = retained_team_log.id

            counts = purge_expired_deleted_records(session, now)
            if (
                counts["attendance"] != 1
                or counts["task"] != 0
                or counts["form"] != 1
                or counts["team_log"] != 0
            ):
                raise AssertionError(f"rubbish bin purge: unexpected counts {counts}")
            if session.get(AttendanceRecord, expired_id) is not None:
                raise AssertionError("rubbish bin purge: expired attendance should be permanently deleted")
            if session.get(TaskLog, retained_id) is None:
                raise AssertionError("rubbish bin purge: records under 30 days must be retained")
            if session.get(WorkFormSubmission, expired_form_id) is not None:
                raise AssertionError("rubbish bin purge: expired form submission should be permanently deleted")
            if session.get(TeamWorkLog, retained_team_log_id) is None:
                raise AssertionError("rubbish bin purge: recent team logs must be retained")

        engine.dispose()

    print("ok - rubbish bin 30-day purge")


def main():
    test_postgres_statement_adaptation()
    test_fresh_database()
    test_legacy_database()
    test_report_review_workflow_migration()
    test_report_daywork_purpose_migration()
    test_global_admin_supervisor_invariant_migration()
    test_client_submission_unique_indexes()
    test_client_submission_duplicate_precheck()
    test_rubbish_bin_purge()
    print("migration test passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
