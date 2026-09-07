"""Real-migration correction checks; only caller-owned disposable databases."""

import json
import shutil
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.exc import IntegrityError

from app.migrations import MIGRATIONS_DIR, MigrationError, run_migrations, verify_migrations


CORRECTION = "0020_missing_snapshot_daywork_correction"
DAYWORK_FIELDS = [
    {"id": key, "type": "signature" if key == "worker_signature" else "text"}
    for key in ("work_completed", "hours_worked", "materials_used", "safety_notes", "worker_signature")
]
DAYWORK_ANSWERS = {
    "work_completed": "Historical labour",
    "hours_worked": 8,
    "materials_used": "Original materials",
    "safety_notes": "Original safety note",
    "worker_signature": "/uploads/original-signature.png",
}


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def query(engine, statement, parameters=None):
    with engine.connect() as connection:
        return connection.execute(text(statement), parameters or {}).mappings().all()


def migrate_through(engine, last_version):
    with tempfile.TemporaryDirectory(prefix="report-correction-manifest-") as directory:
        manifest = Path(directory)
        for path in MIGRATIONS_DIR.glob("*.py"):
            if path.name != "__init__.py" and path.stem[:4] <= last_version:
                shutil.copy2(path, manifest / path.name)
        run_migrations(engine, manifest)


def seed(engine):
    with engine.begin() as connection:
        connection.execute(text("""
            INSERT INTO "user" (id, email, name, password_hash, role, status, department_id, is_global_admin, worker_class)
            VALUES (900, 'correction-supervisor@example.invalid', 'Supervisor', 'synthetic', 'supervisor', 'active', 1, FALSE, NULL),
                   (1000, 'correction-worker@example.invalid', 'Worker', 'synthetic', 'worker', 'active', 1, FALSE, 'leader')
        """))
        connection.execute(text("""
            INSERT INTO workform (id, department_id, name, fields_json, definition_version, status, created_by, created_at)
            VALUES (100, 1, 'Historical Daywork', :fields, 1, 'active', 900, :created)
        """), {"fields": json.dumps(DAYWORK_FIELDS), "created": datetime(2026, 7, 1, tzinfo=timezone.utc)})
        for record_id, snapshot in [(200, None), (201, "")]:
            connection.execute(text("""
                INSERT INTO workformsubmission (id, department_id, form_id, worker_id, site_id,
                    work_date, answers_json, photo_urls, photo_metadata, client_submission_id,
                    form_definition_version, definition_snapshot_json, status, created_at)
                VALUES (:id, 1, 100, 1000, NULL, '2026-08-01', :answers, :photos, :metadata,
                    :client_id, NULL, :snapshot, 'pending', :created)
            """), {"id": record_id, "answers": json.dumps(DAYWORK_ANSWERS),
                   "photos": '["/uploads/original-photo.png"]',
                   "metadata": '[{"url":"/uploads/original-photo.png","name":"Original photo"}]',
                   "client_id": f"correction-replay-{record_id}", "snapshot": snapshot,
                   "created": datetime(2026, 8, 1, tzinfo=timezone.utc)})


def audit(engine, record_id, *, action="review_decision", entity_type="form", before=None, after=None,
          created="2026-08-02T00:00:00+00:00"):
    with engine.begin() as connection:
        connection.execute(text("""
            INSERT INTO auditevent (department_id, actor_id, action, entity_type, entity_id,
                                   before_json, after_json, created_at)
            VALUES (1, 900, :action, :entity_type, :id, :before, :after, :created)
        """), {"id": record_id, "action": action, "entity_type": entity_type,
               "before": json.dumps(before) if before is not None else None,
               "after": json.dumps(after) if after is not None else None, "created": created})


def database_snapshot(engine):
    tables = sorted(inspect(engine).get_table_names())
    state = {}
    for table in tables:
        quoted = engine.dialect.identifier_preparer.quote(table)
        records = [dict(row) for row in query(engine, f"SELECT * FROM {quoted}")]
        state[table] = sorted(json.dumps(row, sort_keys=True, default=str) for row in records)
    if engine.dialect.name == "sqlite":
        state["_schema"] = [tuple(row.values()) for row in query(engine, "SELECT name, sql FROM sqlite_master ORDER BY name")]
    else:
        state["_triggers"] = [tuple(row.values()) for row in query(engine, """
            SELECT tgname, tgenabled, pg_get_triggerdef(oid) AS definition
            FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname
        """)]
    return state


def rejected_update(engine, statement):
    try:
        with engine.begin() as connection:
            connection.execute(text(statement))
    except IntegrityError:
        return
    raise AssertionError("Corrective migration left an immutable-purpose/Report bypass")


def test_historical_daywork_is_corrected(database, report):
    for previous in ("0017", "0019"):
        with database(f"correction_from_{previous}") as engine:
            migrate_through(engine, "0017")
            seed(engine)
            if previous == "0019":
                migrate_through(engine, "0019")
            before = query(engine, "SELECT * FROM workformsubmission ORDER BY id")
            old_ledger = query(engine, "SELECT * FROM schema_migrations ORDER BY version")
            applied = run_migrations(engine)
            after = query(engine, "SELECT * FROM workformsubmission ORDER BY id")
            require([row["submission_purpose"] for row in after] == ["daywork", "daywork"],
                    "NULL/empty historical Daywork snapshots remain misclassified as Reports")
            for original, corrected in zip(before, after):
                for key, value in original.items():
                    if key != "submission_purpose":
                        require(corrected[key] == value, f"Correction changed original {key}")
            require(CORRECTION in applied, "Additive correction was not recorded")
            current_ledger = query(engine, "SELECT * FROM schema_migrations ORDER BY version")
            require(current_ledger[:len(old_ledger)] == old_ledger, "Correction rewrote applied migration history")
            provenance = query(engine, "SELECT * FROM workformsubmission_purpose_correction ORDER BY submission_id")
            require([row["submission_id"] for row in provenance] == [200, 201], "Correction provenance does not identify exact repaired rows")
            require(all(row["migration_version"] == CORRECTION and row["previous_purpose"] == "report"
                        and row["corrected_purpose"] == "daywork" and len(row["evidence_sha256"]) == 64
                        and row["evidence_kind"] == "original_daywork_answer_signature" for row in provenance),
                    "Correction provenance lost its reason or original evidence fingerprint")
            rejected_update(engine, "UPDATE workformsubmission SET submission_purpose = 'report' WHERE id = 200")
            require(run_migrations(engine) == [], "Correction replay was not idempotent")
            with engine.connect() as connection:
                verify_migrations(connection)
        report(f"{previous} upgrade corrects proven historical Daywork without changing submitted evidence")


def test_ambiguous_provenance_rolls_back(database, report):
    mutations = {
        "unknown_answers": "UPDATE workformsubmission SET answers_json = '{\"issue\":\"PPE\"}' WHERE id = 201",
        "changed_parent": "UPDATE workform SET fields_json = '[{\"id\":\"issue\",\"type\":\"text\"}]' WHERE id = 100",
        "changed_version": "UPDATE workformsubmission SET form_definition_version = 9 WHERE id = 201",
        "orphan": "DELETE FROM workform WHERE id = 100",
        "bad_date": "UPDATE workformsubmission SET created_at = '9999-01-01T00:00:00+00:00' WHERE id = 201",
    }
    for label, statement in mutations.items():
        with database(f"correction_refuse_{label}") as engine:
            migrate_through(engine, "0017")
            seed(engine)
            with engine.begin() as connection:
                connection.execute(text(statement))
            before = database_snapshot(engine)
            try:
                run_migrations(engine)
            except MigrationError as error:
                require("refused ambiguous submission" in str(error), "Wrong migration refusal")
            else:
                raise AssertionError(f"Correction guessed ambiguous {label} provenance")
            require(database_snapshot(engine) == before, "Ambiguous correction left a partial 0018/0019/0020 upgrade")
        report(f"Correction refuses {label} with full migration-batch rollback")


def test_review_and_parent_audit_refusals(database, report):
    for label in ("report_transition", "resolution_note", "review_state", "parent_edit", "historical_parent_report", "conflicting_definition"):
        with database(f"correction_review_{label}") as engine:
            migrate_through(engine, "0017")
            seed(engine)
            if label == "parent_edit":
                audit(engine, 100, entity_type="work_form", action="work_form_update",
                      before={"fields": DAYWORK_FIELDS, "definition_version": 1},
                      after={"fields": DAYWORK_FIELDS, "definition_version": 2})
            if label == "historical_parent_report":
                audit(engine, 100, entity_type="work_form", action="work_form_update",
                      before={"fields": DAYWORK_FIELDS, "definition_version": 1},
                      after={"fields": [{"id": "issue"}], "definition_version": 2},
                      created="2026-07-31T00:00:00+00:00")
            if label == "conflicting_definition":
                audit(engine, 201, after={"id": 201, "form_id": 100, "worker_id": 1000, "department_id": 1,
                                         "definition_snapshot": {"version": 1, "fields": [{"id": "issue"}]}})
            migrate_through(engine, "0019")
            if label == "report_transition":
                audit(engine, 201, action="report_transition")
            if label in {"resolution_note", "review_state"}:
                with engine.begin() as connection:
                    connection.execute(text("UPDATE workformsubmission SET " +
                                            ("supervisor_note = 'Real review note'" if label == "resolution_note" else "workflow_status = 'in_review'") +
                                            " WHERE id = 201"))
            before = database_snapshot(engine)
            try:
                run_migrations(engine)
            except MigrationError:
                pass
            else:
                raise AssertionError(f"Correction overwrote conflicting {label} evidence")
            require(database_snapshot(engine) == before, "Refused existing-0019 repair changed state or guards")
            rejected_update(engine, "UPDATE workformsubmission SET answers_json = '{}' WHERE id = 200")
        report(f"Correction refuses {label} and preserves existing-0019 guards/evidence")


def test_legacy_resolution_and_true_reports_are_preserved(database, report):
    with database("correction_legacy_outcomes") as engine:
        migrate_through(engine, "0017")
        seed(engine)
        with engine.begin() as connection:
            connection.execute(text("UPDATE workformsubmission SET status = CASE WHEN id = 200 THEN 'approved' ELSE 'rejected' END"))
            for record_id, snapshot, answers in [(202, "[]", DAYWORK_ANSWERS), (203, '{"fields":[]}', DAYWORK_ANSWERS),
                                                (204, None, {"issue": "A genuine historical Report"})]:
                connection.execute(text("""
                    INSERT INTO workformsubmission (id, department_id, form_id, worker_id, answers_json,
                        definition_snapshot_json, status, created_at)
                    VALUES (:id, 1, 100, 1000, :answers, :snapshot, 'pending', '2026-08-01T00:00:00+00:00')
                """), {"id": record_id, "answers": json.dumps(answers), "snapshot": snapshot})
        audit(engine, 200)
        audit(engine, 201, action="form_submission_manual_create", entity_type="form_submission")
        audit(engine, 204, after={"id": 204, "form_id": 100, "worker_id": 1000, "department_id": 1,
                                 "definition_snapshot": {"version": 1, "fields": [{"id": "issue"}]}})
        migrate_through(engine, "0019")
        before = query(engine, "SELECT * FROM workformsubmission ORDER BY id")
        audits = query(engine, "SELECT * FROM auditevent ORDER BY id")
        run_migrations(engine)
        after = query(engine, "SELECT * FROM workformsubmission ORDER BY id")
        for original, corrected in zip(before, after):
            expected = dict(original)
            if original["id"] in {200, 201}:
                expected["submission_purpose"] = "daywork"
            require(dict(corrected) == expected, "Correction changed legacy outcome/reviewer/evidence or a genuine Report")
        require(query(engine, "SELECT * FROM auditevent ORDER BY id") == audits, "Correction invented or changed application audit events")
        rejected_update(engine, "UPDATE workformsubmission SET answers_json = '{}' WHERE id = 202")
        rejected_update(engine, "UPDATE workformsubmission SET submission_purpose = 'daywork' WHERE id = 204")
        require(len(query(engine, "SELECT * FROM workformsubmission_purpose_correction")) == 2, "Provenance contains untouched Reports")
    report("Legacy approvals/rejections/reviewer timestamps remain intact; explicit empty and positively evidenced Reports remain immutable Reports")


def test_correction_failure_rolls_back_guards_and_provenance(database, report):
    for previous, boundary in ((version, phase) for version in ("0017", "0019") for phase in ("provenance", "ledger")):
        with database(f"correction_fault_{previous}_{boundary}") as engine:
            migrate_through(engine, "0017")
            seed(engine)
            if previous == "0019":
                migrate_through(engine, "0019")
            before = database_snapshot(engine)
            failures = []

            def fault(_connection, _cursor, statement, parameters, _context, _executemany):
                normalized = statement.lstrip().upper()
                if boundary == "provenance" and normalized.startswith("INSERT INTO WORKFORMSUBMISSION_PURPOSE_CORRECTION"):
                    failures.append(boundary)
                    raise RuntimeError("Intentional correction failure")
                if boundary == "ledger" and normalized.startswith("INSERT INTO SCHEMA_MIGRATIONS"):
                    version = parameters.get("version") if isinstance(parameters, dict) else parameters[0]
                    if version == CORRECTION:
                        failures.append(boundary)
                        raise RuntimeError("Intentional correction failure")

            event.listen(engine, "before_cursor_execute", fault)
            try:
                try:
                    run_migrations(engine)
                except RuntimeError as error:
                    require(str(error) == "Intentional correction failure", "Unexpected injected failure")
                else:
                    raise AssertionError("Correction failure did not fire")
            finally:
                event.remove(engine, "before_cursor_execute", fault)
            require(failures == [boundary], "Correction fault did not reach the intended boundary")
            require(database_snapshot(engine) == before, "Correction failure left partial data, provenance, DDL or disabled triggers")
            require(CORRECTION in run_migrations(engine), "Rolled-back correction could not be retried")
            rejected_update(engine, "UPDATE workformsubmission SET submission_purpose = 'report' WHERE id = 200")
        report(f"{previous} correction {boundary} failure rolls back data, provenance and guards; retry succeeds")


def test_fresh_schema_is_idempotent(database, report):
    with database("correction_fresh") as engine:
        require(CORRECTION in run_migrations(engine), "Fresh database did not receive the correction migration")
        before = database_snapshot(engine)
        require(run_migrations(engine) == [], "Fresh corrected schema is not idempotent")
        require(database_snapshot(engine) == before, "Idempotent correction changed fresh schema")
        with engine.connect() as connection:
            verify_migrations(connection)
    report("Fresh schema receives0020 and remains exact-ledger/idempotence compatible")


def run_correction_checks(database, report):
    test_historical_daywork_is_corrected(database, report)
    test_ambiguous_provenance_rolls_back(database, report)
    test_review_and_parent_audit_refusals(database, report)
    test_legacy_resolution_and_true_reports_are_preserved(database, report)
    test_correction_failure_rolls_back_guards_and_provenance(database, report)
    test_fresh_schema_is_idempotent(database, report)


@contextmanager
def sqlite_database(label):
    with tempfile.TemporaryDirectory(prefix=f"{label}-") as directory:
        engine = create_engine(f"sqlite:///{Path(directory).as_posix()}/fixture.db")
        try:
            yield engine
        finally:
            engine.dispose()


def main():
    run_correction_checks(sqlite_database, lambda label: print(f"ok - {label}"))


if __name__ == "__main__":
    main()
