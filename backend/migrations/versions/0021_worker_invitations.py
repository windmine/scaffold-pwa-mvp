revision = "0021_worker_invitations"


def upgrade(context):
    context.add_column_if_missing("user", "password_setup_required", "BOOLEAN NOT NULL DEFAULT FALSE")
    context.add_column_if_missing("user", "invitation_generation", "INTEGER NOT NULL DEFAULT 0")
    context.execute("""
        CREATE TABLE IF NOT EXISTS workerinvitation (
            id INTEGER PRIMARY KEY,
            worker_id INTEGER NOT NULL,
            department_id INTEGER NOT NULL,
            email VARCHAR NOT NULL,
            generation INTEGER NOT NULL,
            token_hash VARCHAR NOT NULL,
            issued_by INTEGER NOT NULL,
            expires_at DATETIME NOT NULL,
            consumed_at DATETIME,
            revoked_at DATETIME,
            created_at DATETIME NOT NULL
        )
    """)
    context.execute("CREATE UNIQUE INDEX IF NOT EXISTS ix_workerinvitation_token_hash ON workerinvitation (token_hash)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_workerinvitation_worker_id ON workerinvitation (worker_id)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_workerinvitation_department_id ON workerinvitation (department_id)")
