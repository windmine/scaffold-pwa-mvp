revision = "0022_worker_password_recovery"


def upgrade(context):
    context.add_column_if_missing("user", "password_recovery_generation", "INTEGER NOT NULL DEFAULT 0")
    context.add_column_if_missing("user", "auth_generation", "INTEGER NOT NULL DEFAULT 0")
    # Preserve pre-migration sessions only for existing identities. New ORM
    # accounts explicitly default False; recycled email addresses cannot adopt
    # a historical subject-only token belonging to a different identity.
    context.add_column_if_missing("user", "legacy_auth_allowed", "BOOLEAN NOT NULL DEFAULT TRUE")
    context.execute("""
        CREATE TABLE IF NOT EXISTS workerpasswordrecovery (
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
    context.execute("CREATE UNIQUE INDEX IF NOT EXISTS ix_workerpasswordrecovery_token_hash ON workerpasswordrecovery (token_hash)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_workerpasswordrecovery_worker_id ON workerpasswordrecovery (worker_id)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_workerpasswordrecovery_department_id ON workerpasswordrecovery (department_id)")
