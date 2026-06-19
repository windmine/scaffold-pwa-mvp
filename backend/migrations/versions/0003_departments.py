revision = "0003_departments"


DEPARTMENTS = [
    (1, "Leader"),
    (2, "Mutual"),
    (3, "MC"),
    (4, "Stech"),
    (5, "BOP"),
]


def upgrade(context):
    context.execute(
        """
        CREATE TABLE IF NOT EXISTS department (
            id INTEGER PRIMARY KEY,
            name VARCHAR NOT NULL,
            status VARCHAR NOT NULL DEFAULT 'active',
            created_at DATETIME NOT NULL
        )
        """
    )

    for department_id, name in DEPARTMENTS:
        context.execute(
            f"""
            INSERT INTO department (id, name, status, created_at)
            SELECT {department_id}, '{name}', 'active', '2026-06-17T00:00:00Z'
            WHERE NOT EXISTS (
                SELECT 1 FROM department WHERE id = {department_id} OR name = '{name}'
            )
            """
        )

    context.add_column_if_missing("user", "department_id", "INTEGER")
    context.add_column_if_missing("user", "is_global_admin", "BOOLEAN DEFAULT FALSE")
    context.add_column_if_missing("site", "department_id", "INTEGER")
    context.add_column_if_missing("attendancerecord", "department_id", "INTEGER")
    context.add_column_if_missing("tasklog", "department_id", "INTEGER")
    context.add_column_if_missing("tasktemplate", "department_id", "INTEGER")
    context.add_column_if_missing("workform", "department_id", "INTEGER")
    context.add_column_if_missing("workformsubmission", "department_id", "INTEGER")
    context.add_column_if_missing("auditevent", "department_id", "INTEGER")

    for table_name in [
        '"user"',
        "site",
        "attendancerecord",
        "tasklog",
        "tasktemplate",
        "workform",
        "workformsubmission",
        "auditevent",
    ]:
        context.execute(f"UPDATE {table_name} SET department_id = 1 WHERE department_id IS NULL")

    context.execute("UPDATE \"user\" SET is_global_admin = FALSE WHERE is_global_admin IS NULL")

    context.execute("CREATE UNIQUE INDEX IF NOT EXISTS ix_department_name ON department (name)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_department_status ON department (status)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_user_department_id ON \"user\" (department_id)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_user_is_global_admin ON \"user\" (is_global_admin)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_site_department_id ON site (department_id)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_attendancerecord_department_id ON attendancerecord (department_id)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_tasklog_department_id ON tasklog (department_id)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_tasktemplate_department_id ON tasktemplate (department_id)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_workform_department_id ON workform (department_id)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_workformsubmission_department_id ON workformsubmission (department_id)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_auditevent_department_id ON auditevent (department_id)")
