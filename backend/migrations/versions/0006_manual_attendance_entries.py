revision = "0006_manual_attendance_entries"


def upgrade(context):
    if not context.table_exists("attendancerecord"):
        return

    dialect = context.connection.dialect.name
    if dialect == "sqlite":
        context.execute(
            """
            CREATE TABLE attendancerecord_manual_entry (
                id INTEGER PRIMARY KEY,
                department_id INTEGER,
                worker_id INTEGER NOT NULL,
                site_id INTEGER,
                record_type VARCHAR NOT NULL,
                latitude FLOAT,
                longitude FLOAT,
                accuracy FLOAT,
                distance_from_site_m FLOAT,
                within_site_radius BOOLEAN,
                note VARCHAR,
                photo_url VARCHAR,
                client_submission_id VARCHAR,
                entry_source VARCHAR NOT NULL DEFAULT 'worker',
                created_by_supervisor_id INTEGER,
                status VARCHAR NOT NULL DEFAULT 'pending',
                created_at DATETIME NOT NULL
            )
            """
        )
        context.execute(
            """
            INSERT INTO attendancerecord_manual_entry (
                id, department_id, worker_id, site_id, record_type,
                latitude, longitude, accuracy, distance_from_site_m,
                within_site_radius, note, photo_url, client_submission_id,
                entry_source, created_by_supervisor_id, status, created_at
            )
            SELECT
                id, department_id, worker_id, site_id, record_type,
                latitude, longitude, accuracy, distance_from_site_m,
                within_site_radius, note, photo_url, client_submission_id,
                'worker', NULL, status, created_at
            FROM attendancerecord
            """
        )
        context.execute("DROP TABLE attendancerecord")
        context.execute(
            "ALTER TABLE attendancerecord_manual_entry RENAME TO attendancerecord"
        )
    else:
        context.add_column_if_missing(
            "attendancerecord",
            "entry_source",
            "VARCHAR NOT NULL DEFAULT 'worker'",
        )
        context.add_column_if_missing(
            "attendancerecord",
            "created_by_supervisor_id",
            "INTEGER",
        )
        context.execute(
            "ALTER TABLE attendancerecord ALTER COLUMN latitude DROP NOT NULL"
        )
        context.execute(
            "ALTER TABLE attendancerecord ALTER COLUMN longitude DROP NOT NULL"
        )

    context.execute(
        "CREATE INDEX IF NOT EXISTS ix_attendancerecord_department_id "
        "ON attendancerecord (department_id)"
    )
    context.execute(
        "CREATE INDEX IF NOT EXISTS ix_attendancerecord_worker_id "
        "ON attendancerecord (worker_id)"
    )
    context.execute(
        "CREATE INDEX IF NOT EXISTS ix_attendancerecord_site_id "
        "ON attendancerecord (site_id)"
    )
    context.execute(
        "CREATE INDEX IF NOT EXISTS ix_attendancerecord_client_submission_id "
        "ON attendancerecord (client_submission_id)"
    )
    context.execute(
        "CREATE INDEX IF NOT EXISTS ix_attendancerecord_created_by_supervisor_id "
        "ON attendancerecord (created_by_supervisor_id)"
    )
