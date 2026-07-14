revision = "0016_review_queue_indexes"


REVIEW_RECORD_TABLES = (
    "attendancerecord",
    "tasklog",
    "workformsubmission",
    "teamworklog",
)


def upgrade(context):
    for table_name in REVIEW_RECORD_TABLES:
        if not context.table_exists(table_name):
            continue
        context.execute(
            f"""
            CREATE INDEX IF NOT EXISTS ix_{table_name}_review_queue_department
            ON {table_name} (department_id, status, deleted_at, created_at DESC, id DESC)
            """
        )
        context.execute(
            f"""
            CREATE INDEX IF NOT EXISTS ix_{table_name}_review_queue_global
            ON {table_name} (status, deleted_at, created_at DESC, id DESC)
            """
        )
