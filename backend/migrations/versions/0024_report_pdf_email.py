revision = "0024_report_pdf_email"


def upgrade(context):
    context.add_column_if_missing("workform", "pdf_email_enabled", "BOOLEAN NOT NULL DEFAULT FALSE")
    context.add_column_if_missing("workform", "pdf_email_recipient", "VARCHAR")
    context.add_column_if_missing("workform", "pdf_email_version", "INTEGER NOT NULL DEFAULT 1")
    # No backfill: old Reports must never become outgoing mail.
    context.execute("""
        CREATE TABLE IF NOT EXISTS reportpdfemail (
            id INTEGER PRIMARY KEY,
            submission_id INTEGER NOT NULL,
            department_id INTEGER NOT NULL,
            recipient VARCHAR NOT NULL,
            template_email_version INTEGER NOT NULL,
            snapshot_json TEXT NOT NULL,
            status VARCHAR NOT NULL DEFAULT 'pending',
            failure_code VARCHAR,
            message_id VARCHAR NOT NULL,
            attempted_at DATETIME,
            accepted_at DATETIME,
            created_at DATETIME NOT NULL,
            CONSTRAINT ck_reportpdfemail_status CHECK (status IN ('pending', 'accepted', 'failed', 'uncertain'))
        )
    """)
    context.execute("CREATE UNIQUE INDEX IF NOT EXISTS ix_reportpdfemail_submission_id ON reportpdfemail (submission_id)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_reportpdfemail_department_id ON reportpdfemail (department_id)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_reportpdfemail_status ON reportpdfemail (status)")
