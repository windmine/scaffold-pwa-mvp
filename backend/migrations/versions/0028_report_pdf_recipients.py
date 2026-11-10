"""Per-recipient outbox identity; never enqueue or alter historical delivery state."""
from sqlalchemy import inspect, text
from app.migrations import MigrationError

revision = "0028_report_pdf_recipients"


def upgrade(context):
    connection = context.connection
    inspector = inspect(connection)
    indexes = {index["name"]: index for index in inspector.get_indexes("reportpdfemail")}
    old = indexes.get("ix_reportpdfemail_submission_id")
    if (not old or not old["unique"] or old["column_names"] != ["submission_id"]
            or any(value is not None for key, value in old.get("dialect_options", {}).items() if key.endswith("_where"))
            or old.get("duplicates_constraint")):
        raise MigrationError("Expected standalone unique reportpdfemail submission index before recipient upgrade")
    # SQLite requires a constant default for an added NOT NULL column. New inserts
    # must supply a real key (enforced below); existing addresses remain untouched.
    context.add_column_if_missing("reportpdfemail", "recipient_key", "VARCHAR NOT NULL DEFAULT ''")
    context.add_column_if_missing("reportpdfemail", "recipient_role", "VARCHAR NOT NULL DEFAULT 'template' CHECK (recipient_role IN ('template', 'submitter', 'selected'))")
    rows = connection.execute(text("SELECT id, recipient FROM reportpdfemail")).all()
    for row in rows:
        key = row.recipient.strip().casefold()
        if not key:
            raise MigrationError("Existing PDF recipient has no normalized address; manual review required")
        connection.execute(text("UPDATE reportpdfemail SET recipient_key=:key WHERE id=:id"), {"key": key, "id": row.id})
    # Install the replacement guarantee before removing the original guarantee.
    context.execute("CREATE UNIQUE INDEX ux_reportpdfemail_submission_recipient ON reportpdfemail (submission_id, recipient_key)")
    context.execute("DROP INDEX ix_reportpdfemail_submission_id")
    context.execute("CREATE INDEX ix_reportpdfemail_submission_id ON reportpdfemail (submission_id)")
    if connection.dialect.name == "sqlite":
        context.execute("""
            CREATE TRIGGER trg_reportpdfemail_recipient_key_insert
            BEFORE INSERT ON reportpdfemail WHEN LENGTH(TRIM(NEW.recipient_key)) = 0
            BEGIN SELECT RAISE(ABORT, 'PDF email requires a normalized recipient key'); END
        """)
        context.execute("""
            CREATE TRIGGER trg_reportpdfemail_recipient_metadata_immutable
            BEFORE UPDATE ON reportpdfemail
            WHEN NEW.recipient_key IS NOT OLD.recipient_key OR NEW.recipient_role IS NOT OLD.recipient_role
            BEGIN SELECT RAISE(ABORT, 'Submitted PDF recipient metadata is immutable'); END
        """)
    else:
        context.execute("ALTER TABLE reportpdfemail ALTER COLUMN recipient_key DROP DEFAULT")
        context.execute("ALTER TABLE reportpdfemail ADD CONSTRAINT ck_reportpdfemail_recipient_key CHECK (LENGTH(TRIM(recipient_key)) > 0)")
        context.execute("""
            CREATE FUNCTION enforce_reportpdfemail_recipient_metadata() RETURNS TRIGGER AS $$
            BEGIN
                IF NEW.recipient_key IS DISTINCT FROM OLD.recipient_key OR NEW.recipient_role IS DISTINCT FROM OLD.recipient_role THEN
                    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Submitted PDF recipient metadata is immutable';
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql
        """)
        context.execute("""
            CREATE TRIGGER trg_reportpdfemail_recipient_metadata_immutable
            BEFORE UPDATE ON reportpdfemail FOR EACH ROW
            EXECUTE FUNCTION enforce_reportpdfemail_recipient_metadata()
        """)
