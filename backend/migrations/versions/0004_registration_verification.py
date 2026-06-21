revision = "0004_registration_verification"


def upgrade(context):
    context.execute(
        """
        CREATE TABLE IF NOT EXISTS registrationverification (
            id INTEGER PRIMARY KEY,
            email VARCHAR NOT NULL,
            name VARCHAR NOT NULL,
            code_hash VARCHAR NOT NULL,
            token_hash VARCHAR,
            attempts INTEGER NOT NULL DEFAULT 0,
            expires_at DATETIME NOT NULL,
            verified_at DATETIME,
            consumed_at DATETIME,
            created_at DATETIME NOT NULL
        )
        """
    )
    context.execute(
        "CREATE INDEX IF NOT EXISTS ix_registrationverification_email "
        "ON registrationverification (email)"
    )
    context.execute(
        "CREATE INDEX IF NOT EXISTS ix_registrationverification_token_hash "
        "ON registrationverification (token_hash)"
    )
    context.execute(
        "CREATE INDEX IF NOT EXISTS ix_registrationverification_expires_at "
        "ON registrationverification (expires_at)"
    )
    context.execute(
        "CREATE INDEX IF NOT EXISTS ix_registrationverification_created_at "
        "ON registrationverification (created_at)"
    )
