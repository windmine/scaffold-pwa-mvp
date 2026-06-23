revision = "0007_record_rubbish_bin"


def upgrade(context):
    for table_name in ["attendancerecord", "tasklog"]:
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
