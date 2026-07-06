revision = "0014_client_submission_unique_indexes"


IDEMPOTENCY_INDEXES = [
    {
        "table": "attendancerecord",
        "actor_column": "worker_id",
        "index_name": "ux_attendance_worker_client_submission",
        "label": "attendance records",
    },
    {
        "table": "tasklog",
        "actor_column": "worker_id",
        "index_name": "ux_tasklog_worker_client_submission",
        "label": "task logs",
    },
    {
        "table": "workformsubmission",
        "actor_column": "worker_id",
        "index_name": "ux_formsubmission_worker_client_submission",
        "label": "work form submissions",
    },
    {
        "table": "teamworklog",
        "actor_column": "leader_id",
        "index_name": "ux_teamworklog_leader_client_submission",
        "label": "team work logs",
    },
]


def fail_if_duplicates_exist(context, table: str, actor_column: str, label: str):
    rows = context.connection.exec_driver_sql(
        f"""
        SELECT {actor_column}, client_submission_id, COUNT(*) AS duplicate_count
        FROM {table}
        WHERE client_submission_id IS NOT NULL AND client_submission_id <> ''
        GROUP BY {actor_column}, client_submission_id
        HAVING COUNT(*) > 1
        ORDER BY duplicate_count DESC, {actor_column}, client_submission_id
        LIMIT 5
        """
    ).all()

    if not rows:
        return

    examples = ", ".join(
        f"{actor_column}={row[0]} client_submission_id={row[1]!r} count={row[2]}"
        for row in rows
    )
    raise RuntimeError(
        f"Cannot add idempotency unique index for {label}; duplicate client submission ids exist: {examples}"
    )


def upgrade(context):
    for item in IDEMPOTENCY_INDEXES:
        if not context.table_exists(item["table"]):
            continue

        fail_if_duplicates_exist(
            context,
            item["table"],
            item["actor_column"],
            item["label"],
        )
        context.execute(
            f"""
            CREATE UNIQUE INDEX IF NOT EXISTS {item["index_name"]}
            ON {item["table"]} ({item["actor_column"]}, client_submission_id)
            WHERE client_submission_id IS NOT NULL AND client_submission_id <> ''
            """
        )
