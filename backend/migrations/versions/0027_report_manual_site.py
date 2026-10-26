"""Optional per-Report site labels; existing linked Sites and rows are unchanged."""
revision = "0027_report_manual_site"


def upgrade(context):
    context.add_column_if_missing("workformsubmission", "manual_site_name", "VARCHAR(200)")
    invalid = """NEW.manual_site_name IS NOT NULL AND (
        NEW.site_id IS NOT NULL OR COALESCE(NEW.submission_purpose, 'report') != 'report'
        OR LENGTH(TRIM(NEW.manual_site_name)) = 0 OR LENGTH(NEW.manual_site_name) > 200
    )"""
    if context.connection.dialect.name == "sqlite":
        for operation in ("INSERT", "UPDATE"):
            context.execute(f"""
                CREATE TRIGGER trg_workformsubmission_manual_site_{operation.lower()}
                BEFORE {operation} ON workformsubmission WHEN {invalid}
                BEGIN SELECT RAISE(ABORT, 'A Report may have a linked Site or a manual site name'); END
            """)
        context.execute("""
            CREATE TRIGGER trg_workformsubmission_manual_site_correction
            BEFORE UPDATE ON workformsubmission
            WHEN NEW.manual_site_name IS NOT OLD.manual_site_name AND (
                NEW.revision != OLD.revision + 1 OR NEW.edited_at IS NULL
                OR NEW.edited_by_supervisor_id IS NULL
            )
            BEGIN SELECT RAISE(ABORT, 'Manual site corrections require a new revision'); END
        """)
        return
    context.execute(f"""
        CREATE FUNCTION enforce_workformsubmission_manual_site() RETURNS TRIGGER AS $$
        BEGIN
            IF {invalid} THEN
                RAISE EXCEPTION USING ERRCODE = '23514',
                    MESSAGE = 'A Report may have a linked Site or a manual site name';
            END IF;
            IF TG_OP = 'UPDATE' THEN
                IF NEW.manual_site_name IS DISTINCT FROM OLD.manual_site_name AND (
                    NEW.revision != OLD.revision + 1 OR NEW.edited_at IS NULL
                    OR NEW.edited_by_supervisor_id IS NULL
                ) THEN
                    RAISE EXCEPTION USING ERRCODE = '23514',
                        MESSAGE = 'Manual site corrections require a new revision';
                END IF;
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
    """)
    context.execute("""
        CREATE TRIGGER trg_workformsubmission_manual_site
        BEFORE INSERT OR UPDATE ON workformsubmission FOR EACH ROW
        EXECUTE FUNCTION enforce_workformsubmission_manual_site()
    """)
