"""Recipient migration contract run on disposable SQLite and native PostgreSQL."""
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory

from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError

from app.migrations import run_migrations


def check_recipient_migration(engine):
    with TemporaryDirectory(prefix="before-pdf-recipients-") as directory:
        for path in (Path(__file__).parent / "migrations/versions").glob("*.py"):
            if path.stem != "__init__" and path.stem < "0028":
                shutil.copy2(path, Path(directory) / path.name)
        run_migrations(engine, Path(directory))
    with engine.begin() as connection:
        connection.execute(text("""INSERT INTO workform
            (id,name,fields_json,created_at,pdf_email_enabled,pdf_email_recipient,pdf_email_version)
            VALUES (9100,'Existing','[]','2026-10-20',TRUE,'Original@Example.invalid',9)"""))
        for number, status in enumerate(("pending", "accepted", "failed", "uncertain"), 9100):
            connection.execute(text("""INSERT INTO reportpdfemail
                (id,submission_id,department_id,recipient,template_email_version,snapshot_json,
                 status,failure_code,message_id,attempted_at,accepted_at,created_at)
                VALUES (:id,:id,1,:recipient,9,:snapshot,:status,:failure,:message,:attempted,:accepted,'2026-10-20')"""),
                {"id": number, "recipient": "Original@Example.invalid", "snapshot": '{"frozen":"original"}',
                 "status": status, "failure": "unknown" if status == "uncertain" else None,
                 "message": f"preserved-{number}", "attempted": None if status == "pending" else "2026-10-21",
                 "accepted": "2026-10-21" if status == "accepted" else None})
        outbox = connection.execute(text("SELECT * FROM reportpdfemail ORDER BY id")).mappings().all()
        forms = connection.execute(text("SELECT * FROM workform ORDER BY id")).mappings().all()
        ledger = connection.execute(text("SELECT * FROM schema_migrations ORDER BY version")).all()
    assert run_migrations(engine) == ["0028_report_pdf_recipients"]
    assert run_migrations(engine) == []
    with engine.connect() as connection:
        after = connection.execute(text("SELECT * FROM reportpdfemail ORDER BY id")).mappings().all()
        assert [{key: row[key] for key in outbox[0]} for row in after] == outbox
        assert all(row["recipient_key"] == "original@example.invalid" and row["recipient_role"] == "template" for row in after)
        current_forms = connection.execute(text("SELECT * FROM workform ORDER BY id")).mappings().all()
        assert [{key: row[key] for key in forms[0]} for row in current_forms] == forms
        assert current_forms == forms
        assert connection.execute(text("SELECT * FROM schema_migrations ORDER BY version")).all()[:-1] == ledger
        indexes = {index["name"]: index for index in inspect(connection).get_indexes("reportpdfemail")}
        assert not indexes["ix_reportpdfemail_submission_id"]["unique"]
        unique = indexes["ux_reportpdfemail_submission_recipient"]
        assert unique["unique"] and unique["column_names"] == ["submission_id", "recipient_key"]
    insert = text("""INSERT INTO reportpdfemail
        (id,submission_id,department_id,recipient,recipient_key,recipient_role,template_email_version,snapshot_json,message_id,created_at)
        VALUES (:id,9100,1,:recipient,:key,:role,9,'{}',:message,'2026-10-22')""")
    with engine.begin() as connection:
        for number, role in ((9200, "submitter"), (9201, "selected")):
            recipient = f"New-{number}@Example.invalid"
            connection.execute(insert, {"id": number, "recipient": recipient, "key": recipient.casefold(), "role": role, "message": f"new-{number}"})
    for recipient, key, role in (("ORIGINAL@example.INVALID", "original@example.invalid", "selected"),
                                 ("NEW-9200@example.invalid", "new-9200@example.invalid", "selected"),
                                 ("invalid@example.invalid", "", "selected"),
                                 ("invalid@example.invalid", "invalid@example.invalid", "unknown")):
        try:
            with engine.begin() as connection:
                connection.execute(insert, {"id": 9300, "recipient": recipient, "key": key, "role": role, "message": "rejected"})
        except IntegrityError:
            pass
        else:
            raise AssertionError("Duplicate/invalid recipient metadata was accepted")
    for field, value in (("recipient_key", "changed@example.invalid"), ("recipient_role", "selected")):
        try:
            with engine.begin() as connection:
                connection.execute(text(f"UPDATE reportpdfemail SET {field}=:value WHERE id=9100"), {"value": value})
        except IntegrityError:
            pass
        else:
            raise AssertionError("Frozen recipient metadata was mutable")


def check_unexpected_recipient_index(engine):
    """Fail before changing schema/data when the legacy index has drifted."""
    from app.migrations import MigrationError
    with TemporaryDirectory(prefix="before-recipient-index-") as directory:
        for path in (Path(__file__).parent / "migrations/versions").glob("*.py"):
            if path.stem != "__init__" and path.stem < "0028":
                shutil.copy2(path, Path(directory) / path.name)
        run_migrations(engine, Path(directory))
    with engine.begin() as connection:
        connection.execute(text("DROP INDEX ix_reportpdfemail_submission_id"))
        connection.execute(text("CREATE INDEX ix_reportpdfemail_submission_id ON reportpdfemail (submission_id)"))
        ledger = connection.execute(text("SELECT * FROM schema_migrations ORDER BY version")).all()
    try:
        run_migrations(engine)
    except MigrationError as error:
        assert "Expected standalone unique" in str(error)
    else:
        raise AssertionError("Unexpected legacy index was silently replaced")
    with engine.connect() as connection:
        assert connection.execute(text("SELECT * FROM schema_migrations ORDER BY version")).all() == ledger
        assert "recipient_key" not in {column["name"] for column in inspect(connection).get_columns("reportpdfemail")}
        assert "pdf_email_approved_recipients_json" not in {column["name"] for column in inspect(connection).get_columns("workform")}
