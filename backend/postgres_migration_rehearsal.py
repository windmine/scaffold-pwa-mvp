"""Migration/evidence checks for the runner's disposable native PostgreSQL cluster.

This module accepts only engines created by postgres_rehearsal.py. It never
discovers credentials, starts services, or reads an application DATABASE_URL.
"""

import json
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import event, inspect, text
from sqlalchemy.exc import IntegrityError

from app.migrations import MIGRATIONS_DIR, MigrationError, run_migrations, verify_migrations


RELEASE_HEAD = "0020_missing_snapshot_daywork_correction"
REPORT_FIELDS = [
    {"id": "issue", "label": "Issue", "type": "text"},
    {"id": "worker_signature", "label": "Signature", "type": "signature"},
]
DAYWORK_FIELDS = [
    {"id": key, "label": key, "type": "signature" if key == "worker_signature" else "text"}
    for key in ("work_completed", "hours_worked", "materials_used", "safety_notes", "worker_signature")
]
EVIDENCE_COLUMNS = (
    "id, department_id, form_id, worker_id, site_id, work_date, answers_json, "
    "photo_urls, photo_metadata, client_submission_id, form_definition_version, "
    "definition_snapshot_json, status, created_at"
)


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def rows(engine, statement, parameters=None):
    with engine.connect() as connection:
        return connection.execute(text(statement), parameters or {}).all()


def ledger(engine):
    return rows(engine, "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version")


def require_isolated_postgres(engine):
    require(engine.dialect.name == "postgresql", "PostgreSQL rehearsal must not substitute SQLite")
    require(engine.url.host == "127.0.0.1", "Rehearsal engine must be the runner's loopback PostgreSQL")
    role = rows(engine, """
        SELECT role.rolsuper, database.datdba = role.oid AS owns_database
        FROM pg_roles AS role JOIN pg_database AS database ON database.datname = current_database()
        WHERE role.rolname = current_user
    """)[0]
    require(not role[0] and role[1], "Migration rehearsal requires a non-superuser database-owner role")


def verify_read_only(engine):
    with engine.begin() as connection:
        connection.execute(text("SET TRANSACTION READ ONLY"))
        verify_migrations(connection)


def reject_verification(engine, label):
    try:
        verify_read_only(engine)
    except MigrationError:
        return
    raise AssertionError(f"PostgreSQL read-only verifier accepted {label}")


def reject_statement(engine, label, statement, parameters=None, sqlstate="23514"):
    try:
        with engine.begin() as connection:
            connection.execute(text(statement), parameters or {})
    except IntegrityError as error:
        actual = getattr(error.orig, "sqlstate", None)
        require(actual == sqlstate, f"{label}: expected PostgreSQL SQLSTATE {sqlstate}, got {actual}")
        return
    raise AssertionError(f"PostgreSQL accepted forbidden operation: {label}")


def manifest_versions():
    versions = sorted(path.stem for path in MIGRATIONS_DIR.glob("*.py") if path.name != "__init__.py")
    require(len(versions) == 20 and versions[-1] == RELEASE_HEAD, "Update rehearsal expectations for a changed migration manifest")
    return versions


def migrate_through_0017(engine):
    with tempfile.TemporaryDirectory(prefix="report-pg-migration-manifest-") as directory:
        old_manifest = Path(directory)
        for path in MIGRATIONS_DIR.glob("*.py"):
            if path.name != "__init__.py" and path.stem < "0018":
                shutil.copy2(path, old_manifest / path.name)
        applied = run_migrations(engine, old_manifest)
    require(applied == manifest_versions()[:17], "PostgreSQL legacy fixture was not migrated through exactly 0017")


def seed_legacy_evidence(engine, *, include_missing_snapshots=False):
    """Insert synthetic records into the real 0017 schema, never create_all()."""
    with engine.begin() as connection:
        connection.execute(text("""
            INSERT INTO "user" (id, email, name, password_hash, role, status, department_id, is_global_admin, worker_class)
            VALUES (900, 'reviewer-a@rehearsal.invalid', 'Reviewer A', 'synthetic', 'supervisor', 'active', 1, FALSE, NULL),
                   (901, 'reviewer-b@rehearsal.invalid', 'Reviewer B', 'synthetic', 'supervisor', 'active', 1, FALSE, NULL),
                   (1000, 'worker@rehearsal.invalid', 'Worker', 'synthetic', 'worker', 'active', 1, FALSE, 'normal'),
                   (1001, 'leader@rehearsal.invalid', 'Leader', 'synthetic', 'worker', 'active', 1, FALSE, 'leader')
        """))
        connection.execute(text("""
            INSERT INTO site (id, department_id, name, latitude, longitude, allowed_radius_m)
            VALUES (77, 1, 'Historical yard', -36.8, 174.7, 100)
        """))
        templates = [
            (100, "PPE issue report", REPORT_FIELDS, 4),
            (101, "Renamed labour docket", DAYWORK_FIELDS, 7),
            (102, "Daywork log form - PPE issue", REPORT_FIELDS, 1),
            (103, "Changed template now report", REPORT_FIELDS, 9),
        ]
        for form_id, name, fields, version in templates:
            connection.execute(text("""
                INSERT INTO workform (id, department_id, name, description, fields_json, definition_version, status, created_by, created_at)
                VALUES (:id, 1, :name, 'Synthetic migration evidence', :fields, :version, 'active', 900, :created)
            """), {"id": form_id, "name": name, "fields": json.dumps(fields), "version": version,
                   "created": datetime(2026, 8, 1, tzinfo=timezone.utc)})
        specifications = [
            (200, 100, "pending", REPORT_FIELDS, 4),
            (201, 100, "approved", REPORT_FIELDS, 4),
            (202, 100, "rejected", REPORT_FIELDS, 4),
            (203, 101, "approved", DAYWORK_FIELDS, 7),
            (204, 103, "pending", DAYWORK_FIELDS, 8),
            (205, 100, "legacy", REPORT_FIELDS, 4),
            (206, 101, "pending", REPORT_FIELDS, 6),
            (207, 102, "pending", REPORT_FIELDS, 1),
        ]
        if include_missing_snapshots:
            specifications.extend([(208, 101, "pending", None, None), (209, 101, "pending", None, None)])
        for index, (record_id, form_id, status, fields, version) in enumerate(specifications):
            signature = f"/uploads/legacy-signature-{record_id}.png"
            photo = f"/uploads/legacy-photo-{record_id}.png"
            answers = {"issue": f"Historical PPE answer {record_id}", "worker_signature": signature}
            if fields == DAYWORK_FIELDS:
                answers.update({"work_completed": "Retained Daywork", "hours_worked": 8})
            snapshot = json.dumps({"schema_version": 1, "version": version, "name": "Exact historical definition",
                                   "description": "Original description", "fields": fields}, sort_keys=True) if fields is not None else None
            if record_id == 209:
                snapshot = ""
            connection.execute(text("""
                INSERT INTO workformsubmission (
                    id, department_id, form_id, worker_id, site_id, work_date, answers_json,
                    photo_urls, photo_metadata, client_submission_id, form_definition_version,
                    definition_snapshot_json, status, created_at
                ) VALUES (:id, 1, :form_id, 1000, :site_id, :work_date, :answers, :photos,
                          :photo_metadata, :client_id, :version, :snapshot, :status, :created)
            """), {"id": record_id, "form_id": form_id, "site_id": 77 if index % 2 else None,
                   "work_date": f"2026-08-{index + 1:02d}", "answers": json.dumps(answers),
                   "photos": json.dumps([photo]), "photo_metadata": json.dumps([{"url": photo, "name": f"photo-{record_id}.png"}]),
                   "client_id": f"legacy-pg-replay-{record_id}", "version": version, "snapshot": snapshot,
                   "status": status, "created": datetime(2026, 8, index + 1, 9, tzinfo=timezone.utc)})
        for actor, record_id, created in [
            (900, 201, datetime(2026, 8, 3, 4, 5, 6, tzinfo=timezone.utc)),
            (901, 201, datetime(2026, 8, 4, 5, 6, 7, tzinfo=timezone.utc)),
            (900, 202, datetime(2026, 8, 5, 6, 7, 8, tzinfo=timezone.utc)),
        ]:
            connection.execute(text("""
                INSERT INTO auditevent (department_id, actor_id, action, entity_type, entity_id, summary, created_at)
                VALUES (1, :actor, 'review_decision', 'form', :record_id, 'Historical decision evidence', :created)
            """), {"actor": actor, "record_id": record_id, "created": created})


def evidence(engine):
    return rows(engine, f"SELECT {EVIDENCE_COLUMNS} FROM workformsubmission ORDER BY id")


def check_fresh(database, report):
    with database("migration_fresh") as engine:
        require_isolated_postgres(engine)
        reject_verification(engine, "a fresh database without migration history")
        require(not inspect(engine).get_table_names(), "Read-only PostgreSQL verification created tables")
        report("PostgreSQL empty-schema verification fails without creating migration tables")
        versions = manifest_versions()
        require(run_migrations(engine) == versions, "Fresh PostgreSQL did not apply all 20 real migrations")
        before = ledger(engine)
        verify_read_only(engine)
        require(run_migrations(engine) == [], "Second PostgreSQL migration run was not idempotent")
        require(ledger(engine) == before, "Idempotent PostgreSQL run or verification changed migration history")
        constraints = {item["name"] for item in inspect(engine).get_check_constraints("workformsubmission")}
        require({"ck_workformsubmission_workflow_status", "ck_workformsubmission_submission_purpose"} <= constraints,
                "Native PostgreSQL Report CHECK constraints are missing")
        triggers = {row[0] for row in rows(engine, """
            SELECT tgname FROM pg_trigger WHERE tgrelid = 'workformsubmission'::regclass
            AND NOT tgisinternal AND tgenabled <> 'D'
        """)}
        require({"trg_workformsubmission_report_boundary", "trg_workformsubmission_sync_purpose_insert"} <= triggers,
                "Native PostgreSQL Report boundary triggers are missing")
        report("PostgreSQL fresh 20-migration chain, read-only exact verification, native constraints/triggers, and idempotence",
               {"migration_count": len(versions), "head": RELEASE_HEAD})

        with engine.begin() as connection:
            connection.execute(text("UPDATE schema_migrations SET checksum = 'rehearsal-mismatch' WHERE version = :version"),
                               {"version": versions[4]})
        damaged = ledger(engine)
        reject_verification(engine, "a changed historical checksum")
        require(ledger(engine) == damaged, "Read-only verification repaired a PostgreSQL checksum")
        with engine.begin() as connection:
            connection.execute(text("UPDATE schema_migrations SET checksum = :checksum WHERE version = :version"),
                               {"version": versions[4], "checksum": before[4][2]})
            connection.execute(text("""
                INSERT INTO schema_migrations (version, name, checksum, applied_at)
                VALUES ('9999_rehearsal_future', '9999_rehearsal_future.py', 'future', '2026-09-07T00:00:00Z')
            """))
        future = ledger(engine)
        reject_verification(engine, "unknown future PostgreSQL migration history")
        require(ledger(engine) == future, "Read-only verification changed future PostgreSQL history")
        report("PostgreSQL read-only verifier rejects checksum and future-history mismatches without repairs")


def check_backfill(database, report):
    with database("migration_legacy_0017") as engine:
        require_isolated_postgres(engine)
        migrate_through_0017(engine)
        seed_legacy_evidence(engine)
        before_evidence = evidence(engine)
        before_audits = rows(engine, "SELECT * FROM auditevent ORDER BY id")
        reject_verification(engine, "the genuine PostgreSQL 0017 schema")
        require(run_migrations(engine) == manifest_versions()[17:], "Legacy PostgreSQL did not apply precisely 0018 through 0020")
        verify_read_only(engine)
        require(evidence(engine) == before_evidence, "PostgreSQL backfill changed dates, answers, signatures, photos, snapshots, or legacy outcomes")
        require(rows(engine, "SELECT * FROM auditevent ORDER BY id") == before_audits, "PostgreSQL backfill changed historical audit evidence")
        outcomes = rows(engine, """
            SELECT id, workflow_status, submission_purpose, reviewing_supervisor_id,
                   review_started_at, resolved_at, supervisor_note FROM workformsubmission ORDER BY id
        """)
        expected_stages = {200: "submitted", 201: "resolved", 202: "resolved", 203: "resolved",
                           204: "submitted", 205: "submitted", 206: "submitted", 207: "submitted"}
        expected_purposes = {record_id: "daywork" if record_id in {203, 204} else "report" for record_id in expected_stages}
        review_evidence = {201: (901, datetime(2026, 8, 4, 5, 6, 7, tzinfo=timezone.utc)),
                           202: (900, datetime(2026, 8, 5, 6, 7, 8, tzinfo=timezone.utc))}
        for record_id, workflow, purpose, reviewer, started, resolved, note in outcomes:
            require((workflow, purpose) == (expected_stages[record_id], expected_purposes[record_id]),
                    f"PostgreSQL backfill misclassified synthetic record {record_id}")
            expected_reviewer, expected_time = review_evidence.get(record_id, (None, None))
            require((reviewer, started, resolved, note) == (expected_reviewer, expected_time, expected_time, None),
                    f"PostgreSQL backfill invented or lost reviewer evidence for {record_id}")
        require(rows(engine, "SELECT id, template_purpose FROM workform ORDER BY id") ==
                [(100, "report"), (101, "daywork"), (102, "report"), (103, "report")],
                "PostgreSQL purpose migration relied on mutable names instead of definition evidence")
        report("PostgreSQL 0017→0020 preserves eight snapshotted historical Reports/Daywork records and exact evidence",
               {"records": len(outcomes), "legacy_outcomes": ["pending", "approved", "rejected", "legacy"]})
        report("PostgreSQL audit backfill preserves real reviewer timestamps without inventing notes; snapshots outrank parent templates")
        check_report_boundaries(engine, report)


def check_report_boundaries(engine, report):
    before = evidence(engine)
    immutable_edits = {
        "department_id": 2, "form_id": 101, "worker_id": 1001, "site_id": 88,
        "work_date": "2026-09-01", "answers_json": '{"worker_signature":"/uploads/replaced.png"}',
        "photo_urls": '["/uploads/replaced-photo.png"]', "photo_metadata": "[]",
        "form_definition_version": 99, "definition_snapshot_json": "{}",
        "client_submission_id": "replacement-client-key", "status": "approved",
        "created_at": datetime(2026, 9, 1, tzinfo=timezone.utc), "submission_purpose": "daywork",
    }
    for column, value in immutable_edits.items():
        reject_statement(engine, f"immutable Report {column}",
                         f"UPDATE workformsubmission SET {column} = :value WHERE id = 200", {"value": value})
    reject_statement(engine, "legacy Report rejection", "UPDATE workformsubmission SET status = 'rejected' WHERE id = 200")
    reject_statement(engine, "historical Report under Daywork parent edit", "UPDATE workformsubmission SET answers_json = '{}' WHERE id = 206")
    reject_statement(engine, "invalid Report workflow", "UPDATE workformsubmission SET workflow_status = 'approved' WHERE id = 200")
    reject_statement(engine, "null Report workflow", "UPDATE workformsubmission SET workflow_status = NULL WHERE id = 200", sqlstate="23502")
    reject_statement(engine, "invalid template purpose", "UPDATE workform SET template_purpose = 'attendance' WHERE id = 100")
    require(evidence(engine) == before, "Rejected PostgreSQL legacy updates changed Report evidence")
    report("PostgreSQL native triggers reject legacy Report edits/approval/rejection, purpose changes, and invalid workflow values",
           {"immutable_columns_checked": len(immutable_edits)})

    insertion = """
        INSERT INTO workformsubmission (id, department_id, form_id, worker_id, work_date, answers_json,
            status, workflow_status, submission_purpose, supervisor_note, reviewing_supervisor_id, created_at)
        VALUES (:id, 1, :form_id, 1000, '2026-09-01', '{}', :status, :workflow, :purpose, :note, :reviewer, :created)
    """
    base = {"id": 300, "form_id": 100, "status": "pending", "workflow": "submitted", "purpose": "report",
            "note": None, "reviewer": None, "created": datetime(2026, 9, 1, tzinfo=timezone.utc)}
    for changes in ({"status": "approved"}, {"status": "rejected"}, {"workflow": "resolved"},
                    {"note": "Supervisor-created"}, {"reviewer": 900},
                    {"purpose": "daywork", "status": "approved"}, {"purpose": "invalid"}):
        reject_statement(engine, f"Report manual-insert bypass {sorted(changes)}", insertion, {**base, **changes})
    with engine.begin() as connection:
        connection.execute(text(insertion), {**base, "purpose": "daywork"})
        connection.execute(text(insertion), {**base, "id": 301, "form_id": 101, "status": "approved", "workflow": "resolved"})
        connection.execute(text("UPDATE workformsubmission SET answers_json = '{\"legacy\":\"editable\"}', status = 'approved' WHERE id = 204"))
    require(rows(engine, "SELECT id, submission_purpose FROM workformsubmission WHERE id IN (300, 301) ORDER BY id") ==
            [(300, "report"), (301, "daywork")], "PostgreSQL insert purpose was not derived from the parent template")
    require(rows(engine, "SELECT submission_purpose, status FROM workformsubmission WHERE id = 204") == [("daywork", "approved")],
            "Historical Daywork under a Report parent lost retained edit/approval compatibility")
    report("PostgreSQL manual Report insert bypasses fail; durable purpose derivation and retained Daywork remain compatible")

    with engine.begin() as connection:
        connection.execute(text("UPDATE workform SET template_purpose = 'daywork' WHERE id = 100"))
    reject_statement(engine, "Report edit after parent purpose change", "UPDATE workformsubmission SET answers_json = '{}' WHERE id = 200")
    reject_statement(engine, "Report purpose after parent purpose change", "UPDATE workformsubmission SET submission_purpose = 'daywork' WHERE id = 200")
    # Duplicate protection is tested against a legitimate Daywork insert so that
    # the unique index, not a Report-boundary trigger, must reject it.
    reject_statement(engine, "duplicate client submission key", """
        INSERT INTO workformsubmission (department_id, form_id, worker_id, answers_json, client_submission_id, status, created_at)
        VALUES (1, 101, 1000, '{}', 'legacy-pg-replay-200', 'pending', '2026-09-01T00:00:00Z')
    """, sqlstate="23505")
    report("PostgreSQL Report immutability survives parent changes and Worker replay uniqueness is enforced")


class InjectedMigrationFailure(RuntimeError):
    pass


def check_transaction_rollback(database, report):
    with database("migration_rollback") as engine:
        require_isolated_postgres(engine)
        migrate_through_0017(engine)
        seed_legacy_evidence(engine)
        before_ledger = ledger(engine)
        before_evidence = evidence(engine)
        before_columns = [column["name"] for column in inspect(engine).get_columns("workformsubmission")]
        before_indexes = {index["name"] for index in inspect(engine).get_indexes("workformsubmission")}
        injected = []

        def fail_before_final_ledger(_connection, _cursor, statement, parameters, _context, _executemany):
            normalized = " ".join(statement.split()).upper()
            if normalized.startswith("INSERT INTO SCHEMA_MIGRATIONS") and parameters.get("version") == RELEASE_HEAD:
                injected.append(RELEASE_HEAD)
                raise InjectedMigrationFailure("Intentional isolated PostgreSQL failure before final migration ledger insert")

        event.listen(engine, "before_cursor_execute", fail_before_final_ledger)
        try:
            try:
                run_migrations(engine)
            except InjectedMigrationFailure:
                pass
            else:
                raise AssertionError("PostgreSQL migration fault injection did not run")
        finally:
            event.remove(engine, "before_cursor_execute", fail_before_final_ledger)
        require(injected == [RELEASE_HEAD], "PostgreSQL failure did not occur at the intended final ledger boundary")
        require(ledger(engine) == before_ledger and evidence(engine) == before_evidence,
                "Failed PostgreSQL migration committed partial ledger or evidence backfill")
        require([column["name"] for column in inspect(engine).get_columns("workformsubmission")] == before_columns,
                "PostgreSQL migration failure left partial report columns")
        require({index["name"] for index in inspect(engine).get_indexes("workformsubmission")} == before_indexes,
                "PostgreSQL migration failure left partial indexes")
        require(not rows(engine, "SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_workformsubmission_report_boundary')")[0][0],
                "PostgreSQL migration failure left its trigger function behind")
        require(run_migrations(engine) == manifest_versions()[17:], "PostgreSQL migration retry did not apply the rolled-back batch")
        verify_read_only(engine)
        report("PostgreSQL failure before 0020 ledger insertion rolls back all three upgrades, backfill, DDL, indexes, and functions; retry succeeds")


def check_missing_snapshot_classification(database, report):
    # Original208/209 have PPE-only answers, no version, and no historical audit.
    # Keep those exact ambiguous records: current parent alone cannot prove their
    # historical purpose. The additive correction must refuse the entire batch.
    from report_purpose_correction_test import database_snapshot

    with database("migration_missing_snapshot") as engine:
        require_isolated_postgres(engine)
        migrate_through_0017(engine)
        seed_legacy_evidence(engine, include_missing_snapshots=True)
        before = database_snapshot(engine)
        try:
            run_migrations(engine)
        except MigrationError as error:
            require("refused ambiguous submission 208" in str(error), "Unexpected ambiguous-snapshot failure")
        else:
            raise AssertionError("Missing-snapshot records were guessed from the current parent")
        require(database_snapshot(engine) == before, "Ambiguous-snapshot refusal left partial schema, ledger or evidence changes")
        report("PostgreSQL original ambiguous NULL/empty snapshot fixtures fail closed with complete migration-batch rollback")


def run_migration_checks(database, report):
    check_fresh(database, report)
    check_backfill(database, report)
    check_transaction_rollback(database, report)
    check_missing_snapshot_classification(database, report)
    from report_purpose_correction_test import run_correction_checks
    run_correction_checks(database, report)
