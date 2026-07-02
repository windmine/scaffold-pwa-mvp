revision = "0012_form_and_team_log_rubbish_bin"


def upgrade(context):
    for table_name in ["workformsubmission", "teamworklog"]:
        context.add_column_if_missing(table_name, "deleted_at", "DATETIME")
        context.add_column_if_missing(
            table_name,
            "deleted_by_supervisor_id",
            "INTEGER",
        )
        context.add_column_if_missing(table_name, "deletion_reason", "VARCHAR")
        context.execute(
            f"CREATE INDEX IF NOT EXISTS ix_{table_name}_deleted_at "
            f"ON {table_name} (deleted_at)"
        )
        context.execute(
            f"CREATE INDEX IF NOT EXISTS ix_{table_name}_deleted_by_supervisor_id "
            f"ON {table_name} (deleted_by_supervisor_id)"
        )
