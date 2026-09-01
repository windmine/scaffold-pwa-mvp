import json


revision = "0019_report_daywork_purpose"


TEMPLATE_PURPOSE_CONSTRAINT_ERROR = (
    "Report Template purpose must be report or daywork"
)
SUBMISSION_PURPOSE_CONSTRAINT_ERROR = (
    "Report submission purpose must be report or daywork"
)
REPORT_IMMUTABILITY_CONSTRAINT_ERROR = (
    "Submitted Report content and legacy outcome are immutable"
)
DAYWORK_REPEAT_FIELD_SIGNATURE = {
    "teams",
    "team_people",
    "team_time",
    "team_man_hours",
    "job_description",
    "signature",
}
DAYWORK_PDF_FIELD_SIGNATURE = {
    "team_1",
    "working_hours_team_1",
    "total_man_hours_all_teams",
    "job_description",
    "signature",
}
DAYWORK_ORIGINAL_FIELD_SIGNATURE = {
    "work_completed",
    "hours_worked",
    "materials_used",
    "safety_notes",
    "worker_signature",
}
DAYWORK_FIELD_SIGNATURES = (
    DAYWORK_REPEAT_FIELD_SIGNATURE,
    DAYWORK_PDF_FIELD_SIGNATURE,
    DAYWORK_ORIGINAL_FIELD_SIGNATURE,
)


def field_ids(value):
    try:
        fields = json.loads(value or "[]")
    except (TypeError, ValueError):
        return None
    if isinstance(fields, dict):
        fields = fields.get("fields")
    if not isinstance(fields, list):
        return None
    return {
        str(field.get("id") or "").strip().lower()
        for field in fields
        if isinstance(field, dict) and field.get("id")
    }


def has_historical_daywork_evidence(fields_json):
    ids = field_ids(fields_json)
    return ids is not None and any(
        signature.issubset(ids) for signature in DAYWORK_FIELD_SIGNATURES
    )


def upgrade(context):
    has_work_forms = context.table_exists("workform")
    has_submissions = context.table_exists("workformsubmission")

    if has_work_forms:
        context.add_column_if_missing(
            "workform",
            "template_purpose",
            "VARCHAR NOT NULL DEFAULT 'report'",
        )
        form_rows = context.connection.exec_driver_sql(
            "SELECT id, fields_json FROM workform"
        ).all()
        daywork_form_ids = [
            int(form_id)
            for form_id, fields_json in form_rows
            if has_historical_daywork_evidence(fields_json)
        ]
        context.execute("UPDATE workform SET template_purpose = 'report'")
        if daywork_form_ids:
            ids = ", ".join(str(form_id) for form_id in daywork_form_ids)
            context.execute(
                f"UPDATE workform SET template_purpose = 'daywork' WHERE id IN ({ids})"
            )
        context.execute(
            """
            CREATE INDEX IF NOT EXISTS ix_workform_template_purpose
            ON workform (template_purpose)
            """
        )

    if has_submissions:
        context.add_column_if_missing(
            "workformsubmission",
            "submission_purpose",
            "VARCHAR NOT NULL DEFAULT 'report'",
        )
        if has_work_forms:
            submission_rows = context.connection.exec_driver_sql(
                """
                SELECT
                    submission.id,
                    submission.definition_snapshot_json,
                    COALESCE(form.template_purpose, 'report') AS parent_purpose
                FROM workformsubmission AS submission
                LEFT JOIN workform AS form ON form.id = submission.form_id
                """
            ).all()
            daywork_submission_ids = []
            for submission_id, snapshot_json, parent_purpose in submission_rows:
                snapshot_field_ids = field_ids(snapshot_json)
                if snapshot_field_ids is None:
                    purpose = parent_purpose
                elif any(
                    signature.issubset(snapshot_field_ids)
                    for signature in DAYWORK_FIELD_SIGNATURES
                ):
                    purpose = "daywork"
                else:
                    purpose = "report"
                if purpose == "daywork":
                    daywork_submission_ids.append(int(submission_id))

            context.execute(
                "UPDATE workformsubmission SET submission_purpose = 'report'"
            )
            if daywork_submission_ids:
                ids = ", ".join(
                    str(submission_id) for submission_id in daywork_submission_ids
                )
                context.execute(
                    "UPDATE workformsubmission "
                    f"SET submission_purpose = 'daywork' WHERE id IN ({ids})"
                )
        else:
            context.execute(
                "UPDATE workformsubmission SET submission_purpose = 'report'"
            )
        context.execute(
            """
            CREATE INDEX IF NOT EXISTS ix_workformsubmission_submission_purpose
            ON workformsubmission (submission_purpose)
            """
        )

    if context.connection.dialect.name == "sqlite":
        if has_work_forms:
            context.execute(
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_workform_template_purpose_insert
                BEFORE INSERT ON workform
                WHEN NEW.template_purpose NOT IN ('report', 'daywork')
                BEGIN
                    SELECT RAISE(ABORT, '{TEMPLATE_PURPOSE_CONSTRAINT_ERROR}');
                END
                """
            )
            context.execute(
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_workform_template_purpose_update
                BEFORE UPDATE OF template_purpose ON workform
                WHEN NEW.template_purpose NOT IN ('report', 'daywork')
                BEGIN
                    SELECT RAISE(ABORT, '{TEMPLATE_PURPOSE_CONSTRAINT_ERROR}');
                END
                """
            )
        if has_submissions:
            context.execute(
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_workformsubmission_submission_purpose_insert
                BEFORE INSERT ON workformsubmission
                WHEN NEW.submission_purpose NOT IN ('report', 'daywork')
                BEGIN
                    SELECT RAISE(ABORT, '{SUBMISSION_PURPOSE_CONSTRAINT_ERROR}');
                END
                """
            )
            context.execute(
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_workformsubmission_submission_purpose_update
                BEFORE UPDATE OF submission_purpose ON workformsubmission
                WHEN NEW.submission_purpose NOT IN ('report', 'daywork')
                BEGIN
                    SELECT RAISE(ABORT, '{SUBMISSION_PURPOSE_CONSTRAINT_ERROR}');
                END
                """
            )
        if has_work_forms and has_submissions:
            # SQLite cannot assign NEW values in a BEFORE INSERT trigger. Keep a
            # statement-local marker while the AFTER INSERT trigger derives the
            # durable purpose so every ordinary purpose UPDATE remains immutable.
            context.execute(
                """
                CREATE TABLE IF NOT EXISTS workformsubmission_purpose_insert_sync (
                    submission_id INTEGER PRIMARY KEY
                )
                """
            )
            context.execute(
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_workformsubmission_purpose_immutable_update
                BEFORE UPDATE OF submission_purpose ON workformsubmission
                WHEN NEW.submission_purpose IS NOT OLD.submission_purpose
                  AND NOT EXISTS (
                        SELECT 1
                        FROM workformsubmission_purpose_insert_sync AS sync
                        WHERE sync.submission_id = OLD.id
                    )
                BEGIN
                    SELECT RAISE(ABORT, '{SUBMISSION_PURPOSE_CONSTRAINT_ERROR}');
                END
                """
            )
            context.execute(
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_workformsubmission_report_insert
                BEFORE INSERT ON workformsubmission
                WHEN COALESCE(
                        (
                            SELECT form.template_purpose
                            FROM workform AS form
                            WHERE form.id = NEW.form_id
                        ),
                        'report'
                    ) = 'report'
                  AND (
                        NEW.status IS NULL
                        OR NEW.status != 'pending'
                        OR NEW.workflow_status IS NULL
                        OR NEW.workflow_status != 'submitted'
                        OR NEW.supervisor_note IS NOT NULL
                        OR NEW.reviewing_supervisor_id IS NOT NULL
                        OR NEW.review_started_at IS NOT NULL
                        OR NEW.resolved_at IS NOT NULL
                    )
                BEGIN
                    SELECT RAISE(ABORT, '{REPORT_IMMUTABILITY_CONSTRAINT_ERROR}');
                END
                """
            )
            context.execute(
                """
                CREATE TRIGGER IF NOT EXISTS trg_workformsubmission_sync_purpose_insert
                AFTER INSERT ON workformsubmission
                BEGIN
                    INSERT INTO workformsubmission_purpose_insert_sync (submission_id)
                    VALUES (NEW.id);
                    UPDATE workformsubmission
                    SET submission_purpose = COALESCE(
                        (
                            SELECT form.template_purpose
                            FROM workform AS form
                            WHERE form.id = NEW.form_id
                        ),
                        'report'
                    )
                    WHERE id = NEW.id;
                    DELETE FROM workformsubmission_purpose_insert_sync
                    WHERE submission_id = NEW.id;
                END
                """
            )
            context.execute(
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_workformsubmission_report_immutable_update
                BEFORE UPDATE OF
                    department_id,
                    form_id,
                    worker_id,
                    site_id,
                    work_date,
                    answers_json,
                    form_definition_version,
                    definition_snapshot_json,
                    photo_urls,
                    photo_metadata,
                    client_submission_id,
                    status,
                    created_at
                ON workformsubmission
                WHEN COALESCE(OLD.submission_purpose, 'report') = 'report'
                  AND (
                        NEW.department_id IS NOT OLD.department_id
                        OR NEW.form_id IS NOT OLD.form_id
                        OR NEW.worker_id IS NOT OLD.worker_id
                        OR NEW.site_id IS NOT OLD.site_id
                        OR NEW.work_date IS NOT OLD.work_date
                        OR NEW.answers_json IS NOT OLD.answers_json
                        OR NEW.form_definition_version IS NOT OLD.form_definition_version
                        OR NEW.definition_snapshot_json IS NOT OLD.definition_snapshot_json
                        OR NEW.photo_urls IS NOT OLD.photo_urls
                        OR NEW.photo_metadata IS NOT OLD.photo_metadata
                        OR NEW.client_submission_id IS NOT OLD.client_submission_id
                        OR NEW.status IS NOT OLD.status
                        OR NEW.created_at IS NOT OLD.created_at
                    )
                BEGIN
                    SELECT RAISE(ABORT, '{REPORT_IMMUTABILITY_CONSTRAINT_ERROR}');
                END
                """
            )
        return

    if has_work_forms and has_submissions:
        context.execute(
            """
            CREATE OR REPLACE FUNCTION sync_workformsubmission_purpose()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.submission_purpose := COALESCE(
                    (
                        SELECT form.template_purpose
                        FROM workform AS form
                        WHERE form.id = NEW.form_id
                    ),
                    'report'
                );
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql
            """
        )
        context.execute(
            f"""
            CREATE OR REPLACE FUNCTION enforce_workformsubmission_report_boundary()
            RETURNS TRIGGER AS $$
            DECLARE
                parent_purpose VARCHAR;
            BEGIN
                IF TG_OP = 'INSERT' THEN
                    IF NEW.submission_purpose IS NULL
                       OR NEW.submission_purpose NOT IN ('report', 'daywork') THEN
                        RAISE EXCEPTION USING
                            ERRCODE = '23514',
                            MESSAGE = '{SUBMISSION_PURPOSE_CONSTRAINT_ERROR}';
                    END IF;
                    SELECT form.template_purpose
                    INTO parent_purpose
                    FROM workform AS form
                    WHERE form.id = NEW.form_id;
                    parent_purpose := COALESCE(
                        parent_purpose,
                        'report'
                    );
                    IF parent_purpose = 'report'
                       AND (
                            NEW.status IS DISTINCT FROM 'pending'
                            OR NEW.workflow_status IS DISTINCT FROM 'submitted'
                            OR NEW.supervisor_note IS NOT NULL
                            OR NEW.reviewing_supervisor_id IS NOT NULL
                            OR NEW.review_started_at IS NOT NULL
                            OR NEW.resolved_at IS NOT NULL
                        ) THEN
                        RAISE EXCEPTION USING
                            ERRCODE = '23514',
                            MESSAGE = '{REPORT_IMMUTABILITY_CONSTRAINT_ERROR}';
                    END IF;
                    RETURN NEW;
                END IF;

                parent_purpose := COALESCE(
                    OLD.submission_purpose,
                    'report'
                );
                IF NEW.submission_purpose IS DISTINCT FROM parent_purpose THEN
                    RAISE EXCEPTION USING
                        ERRCODE = '23514',
                        MESSAGE = '{SUBMISSION_PURPOSE_CONSTRAINT_ERROR}';
                END IF;
                IF parent_purpose = 'report'
                   AND (
                        NEW.department_id IS DISTINCT FROM OLD.department_id
                        OR NEW.form_id IS DISTINCT FROM OLD.form_id
                        OR NEW.worker_id IS DISTINCT FROM OLD.worker_id
                        OR NEW.site_id IS DISTINCT FROM OLD.site_id
                        OR NEW.work_date IS DISTINCT FROM OLD.work_date
                        OR NEW.answers_json IS DISTINCT FROM OLD.answers_json
                        OR NEW.form_definition_version IS DISTINCT FROM OLD.form_definition_version
                        OR NEW.definition_snapshot_json IS DISTINCT FROM OLD.definition_snapshot_json
                        OR NEW.photo_urls IS DISTINCT FROM OLD.photo_urls
                        OR NEW.photo_metadata IS DISTINCT FROM OLD.photo_metadata
                        OR NEW.client_submission_id IS DISTINCT FROM OLD.client_submission_id
                        OR NEW.status IS DISTINCT FROM OLD.status
                        OR NEW.created_at IS DISTINCT FROM OLD.created_at
                    ) THEN
                    RAISE EXCEPTION USING
                        ERRCODE = '23514',
                        MESSAGE = '{REPORT_IMMUTABILITY_CONSTRAINT_ERROR}';
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql
            """
        )
        context.execute(
            """
            DROP TRIGGER IF EXISTS trg_workformsubmission_report_boundary
            ON workformsubmission
            """
        )
        context.execute(
            """
            CREATE TRIGGER trg_workformsubmission_report_boundary
            BEFORE INSERT OR UPDATE ON workformsubmission
            FOR EACH ROW
            EXECUTE FUNCTION enforce_workformsubmission_report_boundary()
            """
        )
        context.execute(
            """
            DROP TRIGGER IF EXISTS trg_workformsubmission_sync_purpose_insert
            ON workformsubmission
            """
        )
        context.execute(
            """
            CREATE TRIGGER trg_workformsubmission_sync_purpose_insert
            BEFORE INSERT ON workformsubmission
            FOR EACH ROW
            EXECUTE FUNCTION sync_workformsubmission_purpose()
            """
        )

    if has_work_forms:
        context.execute(
            """
            ALTER TABLE workform
            ADD CONSTRAINT ck_workform_template_purpose
            CHECK (template_purpose IN ('report', 'daywork'))
            """
        )
    if has_submissions:
        context.execute(
            """
            ALTER TABLE workformsubmission
            ADD CONSTRAINT ck_workformsubmission_submission_purpose
            CHECK (submission_purpose IN ('report', 'daywork'))
            """
        )
