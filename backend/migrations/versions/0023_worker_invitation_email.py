revision = "0023_worker_invitation_email"


def upgrade(context):
    context.add_column_if_missing("workerinvitation", "email_status", "VARCHAR NOT NULL DEFAULT 'not_sent'")
    context.add_column_if_missing("workerinvitation", "email_attempted_at", "DATETIME")
    context.add_column_if_missing("workerinvitation", "email_accepted_at", "DATETIME")
