"""Additive PDF email migration contract shared by SQLite and owned PostgreSQL tests."""
from pathlib import Path
import json
import shutil
from tempfile import TemporaryDirectory
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError
from app.migrations import run_migrations


def check_additive_migration(engine):
    """Also invoked against an owned native PostgreSQL test database."""
    with TemporaryDirectory(prefix="before-pdf-mail-") as directory:
        for migration in (Path(__file__).parent / "migrations/versions").glob("*.py"):
            if migration.stem != "__init__" and migration.stem < "0024":
                shutil.copy2(migration, Path(directory) / migration.name)
        run_migrations(engine, Path(directory))
    with engine.begin() as connection:
        connection.execute(text("""INSERT INTO workform
            (id, department_id, name, fields_json, definition_version, status, template_purpose, created_at)
            VALUES (9009, 1, 'Existing Report Template', '[]', 3, 'active', 'report', '2026-10-20T00:00:00Z')"""))
        connection.execute(text("""INSERT INTO workformsubmission
            (id, department_id, form_id, worker_id, work_date, answers_json, form_definition_version,
             definition_snapshot_json, client_submission_id, submission_purpose, workflow_status, created_at)
            VALUES (9009, 1, 9009, 1, '2026-10-20', '{}', 3,
             :snapshot,
             'existing-report-before-email', 'report', 'submitted', '2026-10-20T00:00:00Z')"""),
             {"snapshot": json.dumps({"schema_version": 1, "version": 3, "name": "Existing Report Template", "description": None, "fields": []})})
        reports_before = connection.execute(text("SELECT * FROM workformsubmission ORDER BY id")).mappings().all()
        before = connection.execute(text("SELECT version, checksum FROM schema_migrations ORDER BY version")).all()
        form_before = connection.execute(text("SELECT id, fields_json, definition_version FROM workform ORDER BY id")).all()
    assert run_migrations(engine) == ["0024_report_pdf_email", "0025_report_corrections", "0026_staff_invitations", "0027_report_manual_site"]
    assert not run_migrations(engine)
    with engine.connect() as connection:
        assert connection.execute(text("SELECT version, checksum FROM schema_migrations WHERE version < '0024' ORDER BY version")).all() == before
        assert connection.execute(text("SELECT id, fields_json, definition_version FROM workform ORDER BY id")).all() == form_before
        assert connection.execute(text("SELECT COUNT(*) FROM workform WHERE pdf_email_enabled OR pdf_email_recipient IS NOT NULL OR pdf_email_version <> 1")).scalar_one() == 0
        assert connection.execute(text("SELECT COUNT(*) FROM reportpdfemail")).scalar_one() == 0
        reports_after = connection.execute(text("SELECT * FROM workformsubmission ORDER BY id")).mappings().all()
        assert [{key: row[key] for key in reports_before[0]} for row in reports_after] == reports_before
        assert all(row["revision"] == 1 and row["edited_at"] is None for row in reports_after)
        assert "reportpdfemail" in inspect(connection).get_table_names()
    # The original submitted PDF must survive content corrections, while its
    # identity/routing can never be silently rewritten before delivery.
    with engine.begin() as connection:
        connection.execute(text("""INSERT INTO reportpdfemail
            (id,submission_id,department_id,recipient,template_email_version,snapshot_json,message_id,created_at)
            VALUES (9009,9009,1,'original@example.invalid',1,'{}','original-message','2026-10-20T00:00:00Z')"""))
    for field, value in (("snapshot_json", '{"photo_urls":["/uploads/foreign.png"]}'),
                         ("recipient", "changed@example.invalid"), ("message_id", "changed-message"),
                         ("submission_id", 9010), ("department_id", 2), ("template_email_version", 2)):
        try:
            with engine.begin() as connection:
                connection.execute(text(f"UPDATE reportpdfemail SET {field}=:value WHERE id=9009"), {"value": value})
        except IntegrityError:
            pass
        else:
            raise AssertionError(f"Submitted email {field} remained mutable")
    with engine.begin() as connection:
        connection.execute(text("UPDATE reportpdfemail SET status='uncertain', attempted_at='2026-10-21T00:00:00Z' WHERE id=9009"))
        connection.execute(text("UPDATE reportpdfemail SET status='accepted', accepted_at='2026-10-21T00:00:00Z' WHERE id=9009"))
        assert connection.execute(text("SELECT recipient,snapshot_json,status FROM reportpdfemail WHERE id=9009")).one() == ("original@example.invalid", "{}", "accepted")
        connection.execute(text("DELETE FROM reportpdfemail WHERE id=9009"))
