revision = "0009_worker_classes_and_team_logs"


def upgrade(context):
    context.add_column_if_missing(
        "user",
        "worker_class",
        "VARCHAR DEFAULT 'normal'",
    )
    context.execute(
        "UPDATE \"user\" SET worker_class = 'normal' "
        "WHERE role = 'worker' AND (worker_class IS NULL OR worker_class = '')"
    )
    context.execute(
        "UPDATE \"user\" SET worker_class = NULL WHERE role = 'supervisor'"
    )
    context.execute(
        "CREATE INDEX IF NOT EXISTS ix_user_worker_class ON \"user\" (worker_class)"
    )

    context.execute(
        """
        CREATE TABLE IF NOT EXISTS teamworklog (
            id INTEGER PRIMARY KEY,
            department_id INTEGER,
            leader_id INTEGER NOT NULL,
            week_start VARCHAR NOT NULL,
            notes VARCHAR,
            client_submission_id VARCHAR,
            status VARCHAR NOT NULL DEFAULT 'pending',
            created_at DATETIME NOT NULL
        )
        """
    )
    context.execute(
        """
        CREATE TABLE IF NOT EXISTS teamworklogentry (
            id INTEGER PRIMARY KEY,
            team_work_log_id INTEGER NOT NULL,
            worker_id INTEGER NOT NULL,
            site_id INTEGER NOT NULL,
            work_date VARCHAR NOT NULL,
            start_time VARCHAR NOT NULL,
            end_time VARCHAR NOT NULL,
            break_minutes INTEGER NOT NULL DEFAULT 0,
            hours_worked FLOAT NOT NULL,
            work_description VARCHAR NOT NULL
        )
        """
    )
    context.execute("CREATE INDEX IF NOT EXISTS ix_teamworklog_department_id ON teamworklog (department_id)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_teamworklog_leader_id ON teamworklog (leader_id)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_teamworklog_week_start ON teamworklog (week_start)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_teamworklog_status ON teamworklog (status)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_teamworklog_client_submission_id ON teamworklog (client_submission_id)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_teamworklog_created_at ON teamworklog (created_at)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_teamworklogentry_team_work_log_id ON teamworklogentry (team_work_log_id)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_teamworklogentry_worker_id ON teamworklogentry (worker_id)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_teamworklogentry_site_id ON teamworklogentry (site_id)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_teamworklogentry_work_date ON teamworklogentry (work_date)")
