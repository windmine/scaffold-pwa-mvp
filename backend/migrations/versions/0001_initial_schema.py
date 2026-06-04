revision = "0001_initial_schema"


def upgrade(context):
    context.execute(
        """
        CREATE TABLE IF NOT EXISTS "user" (
            id INTEGER PRIMARY KEY,
            email VARCHAR NOT NULL,
            name VARCHAR NOT NULL,
            password_hash VARCHAR NOT NULL,
            role VARCHAR NOT NULL DEFAULT 'worker',
            status VARCHAR NOT NULL DEFAULT 'active'
        )
        """
    )
    context.execute(
        """
        CREATE TABLE IF NOT EXISTS site (
            id INTEGER PRIMARY KEY,
            name VARCHAR NOT NULL,
            address VARCHAR,
            latitude FLOAT NOT NULL,
            longitude FLOAT NOT NULL,
            allowed_radius_m INTEGER NOT NULL DEFAULT 100
        )
        """
    )
    context.execute(
        """
        CREATE TABLE IF NOT EXISTS attendancerecord (
            id INTEGER PRIMARY KEY,
            worker_id INTEGER NOT NULL,
            site_id INTEGER,
            record_type VARCHAR NOT NULL,
            latitude FLOAT NOT NULL,
            longitude FLOAT NOT NULL,
            accuracy FLOAT,
            distance_from_site_m FLOAT,
            within_site_radius BOOLEAN,
            note VARCHAR,
            photo_url VARCHAR,
            client_submission_id VARCHAR,
            status VARCHAR NOT NULL DEFAULT 'pending',
            created_at DATETIME NOT NULL
        )
        """
    )
    context.execute(
        """
        CREATE TABLE IF NOT EXISTS tasklog (
            id INTEGER PRIMARY KEY,
            worker_id INTEGER NOT NULL,
            site_id INTEGER,
            description VARCHAR NOT NULL,
            work_date VARCHAR,
            hours_worked FLOAT,
            safety_notes VARCHAR,
            photo_url VARCHAR,
            photo_urls VARCHAR,
            client_submission_id VARCHAR,
            status VARCHAR NOT NULL DEFAULT 'pending',
            created_at DATETIME NOT NULL
        )
        """
    )
    context.execute(
        """
        CREATE TABLE IF NOT EXISTS tasktemplate (
            id INTEGER PRIMARY KEY,
            worker_id INTEGER NOT NULL,
            site_id INTEGER,
            name VARCHAR NOT NULL,
            description VARCHAR NOT NULL,
            hours_worked FLOAT,
            safety_notes VARCHAR,
            created_at DATETIME NOT NULL
        )
        """
    )
    context.execute(
        """
        CREATE TABLE IF NOT EXISTS workform (
            id INTEGER PRIMARY KEY,
            name VARCHAR NOT NULL,
            description VARCHAR,
            fields_json VARCHAR NOT NULL,
            status VARCHAR NOT NULL DEFAULT 'active',
            created_by INTEGER,
            created_at DATETIME NOT NULL
        )
        """
    )
    context.execute(
        """
        CREATE TABLE IF NOT EXISTS workformsubmission (
            id INTEGER PRIMARY KEY,
            form_id INTEGER NOT NULL,
            worker_id INTEGER NOT NULL,
            site_id INTEGER,
            work_date VARCHAR,
            answers_json VARCHAR NOT NULL,
            photo_urls VARCHAR,
            client_submission_id VARCHAR,
            status VARCHAR NOT NULL DEFAULT 'pending',
            created_at DATETIME NOT NULL
        )
        """
    )
    context.execute(
        """
        CREATE TABLE IF NOT EXISTS auditevent (
            id INTEGER PRIMARY KEY,
            actor_id INTEGER NOT NULL,
            action VARCHAR NOT NULL,
            entity_type VARCHAR NOT NULL,
            entity_id INTEGER,
            summary VARCHAR,
            before_json TEXT,
            after_json TEXT,
            created_at DATETIME NOT NULL
        )
        """
    )

    context.add_column_if_missing("user", "status", "VARCHAR DEFAULT 'active'")

    context.add_column_if_missing("tasklog", "work_date", "VARCHAR")
    context.add_column_if_missing("tasklog", "hours_worked", "FLOAT")
    context.add_column_if_missing("tasklog", "safety_notes", "VARCHAR")
    context.add_column_if_missing("tasklog", "photo_urls", "VARCHAR")
    context.add_column_if_missing("tasklog", "status", "VARCHAR DEFAULT 'pending'")
    context.add_column_if_missing("tasklog", "client_submission_id", "VARCHAR")

    context.add_column_if_missing("attendancerecord", "distance_from_site_m", "FLOAT")
    context.add_column_if_missing("attendancerecord", "within_site_radius", "BOOLEAN")
    context.add_column_if_missing("attendancerecord", "client_submission_id", "VARCHAR")

    context.add_column_if_missing("workformsubmission", "status", "VARCHAR DEFAULT 'pending'")
    context.add_column_if_missing("workformsubmission", "client_submission_id", "VARCHAR")

    context.execute('CREATE UNIQUE INDEX IF NOT EXISTS ix_user_email ON "user" (email)')
    context.execute('CREATE INDEX IF NOT EXISTS ix_user_status ON "user" (status)')

    context.execute("CREATE INDEX IF NOT EXISTS ix_attendancerecord_worker_id ON attendancerecord (worker_id)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_attendancerecord_site_id ON attendancerecord (site_id)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_attendancerecord_client_submission_id ON attendancerecord (client_submission_id)")

    context.execute("CREATE INDEX IF NOT EXISTS ix_tasklog_worker_id ON tasklog (worker_id)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_tasklog_site_id ON tasklog (site_id)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_tasklog_status ON tasklog (status)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_tasklog_client_submission_id ON tasklog (client_submission_id)")

    context.execute("CREATE INDEX IF NOT EXISTS ix_tasktemplate_worker_id ON tasktemplate (worker_id)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_tasktemplate_site_id ON tasktemplate (site_id)")

    context.execute("CREATE INDEX IF NOT EXISTS ix_workform_name ON workform (name)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_workform_status ON workform (status)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_workform_created_by ON workform (created_by)")

    context.execute("CREATE INDEX IF NOT EXISTS ix_workformsubmission_form_id ON workformsubmission (form_id)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_workformsubmission_worker_id ON workformsubmission (worker_id)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_workformsubmission_site_id ON workformsubmission (site_id)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_workformsubmission_status ON workformsubmission (status)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_workformsubmission_client_submission_id ON workformsubmission (client_submission_id)")

    context.execute("CREATE INDEX IF NOT EXISTS ix_auditevent_actor_id ON auditevent (actor_id)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_auditevent_action ON auditevent (action)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_auditevent_entity_type ON auditevent (entity_type)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_auditevent_entity_id ON auditevent (entity_id)")
    context.execute("CREATE INDEX IF NOT EXISTS ix_auditevent_created_at ON auditevent (created_at)")
