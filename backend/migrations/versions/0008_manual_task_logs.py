revision = "0008_manual_task_logs"


def upgrade(context):
    context.add_column_if_missing(
        "tasklog",
        "entry_source",
        "VARCHAR NOT NULL DEFAULT 'worker'",
    )
    context.add_column_if_missing(
        "tasklog",
        "created_by_supervisor_id",
        "INTEGER",
    )
    context.execute(
        "CREATE INDEX IF NOT EXISTS ix_tasklog_created_by_supervisor_id "
        "ON tasklog (created_by_supervisor_id)"
    )
