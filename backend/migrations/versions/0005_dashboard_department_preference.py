revision = "0005_dashboard_department_preference"


def upgrade(context):
    context.add_column_if_missing("user", "dashboard_department_id", "INTEGER")
    context.execute(
        'CREATE INDEX IF NOT EXISTS ix_user_dashboard_department_id '
        'ON "user" (dashboard_department_id)'
    )
