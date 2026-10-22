revision = "0025_report_corrections"


def upgrade(context):
    context.add_column_if_missing("workformsubmission", "revision", "INTEGER NOT NULL DEFAULT 1")
    context.add_column_if_missing("workformsubmission", "edited_at", "DATETIME")
    context.add_column_if_missing("workformsubmission", "edited_by_supervisor_id", "INTEGER")
    identity = ("department_id", "form_id", "worker_id", "form_definition_version",
                "definition_snapshot_json", "client_submission_id", "submission_purpose",
                "status", "created_at", "workflow_status", "supervisor_note",
                "reviewing_supervisor_id", "review_started_at", "resolved_at")
    content = ("site_id", "work_date", "answers_json", "photo_urls", "photo_metadata")
    email_identity = ("id", "submission_id", "department_id", "recipient", "template_email_version",
                      "snapshot_json", "message_id", "created_at")
    if context.connection.dialect.name == "sqlite":
        frozen_email_changed = " OR ".join(f"NEW.{key} IS NOT OLD.{key}" for key in email_identity)
        context.execute(f"""
            CREATE TRIGGER IF NOT EXISTS trg_reportpdfemail_frozen_submission_update
            BEFORE UPDATE ON reportpdfemail
            WHEN {frozen_email_changed}
            BEGIN
                SELECT RAISE(ABORT, 'Submitted Report email snapshot and routing are immutable');
            END
        """)
        context.execute("DROP TRIGGER IF EXISTS trg_workformsubmission_report_immutable_update")
        # The existing purpose trigger already protects purpose changes, with a
        # statement-local exception for its legacy AFTER INSERT synchronization.
        changed_identity = " OR ".join(f"NEW.{key} IS NOT OLD.{key}" for key in identity if key != "submission_purpose")
        changed_content = " OR ".join(f"NEW.{key} IS NOT OLD.{key}" for key in content)
        context.execute(f"""
            CREATE TRIGGER IF NOT EXISTS trg_workformsubmission_report_correction_update
            BEFORE UPDATE ON workformsubmission
            WHEN COALESCE(OLD.submission_purpose, 'report') = 'report' AND (
                ({changed_identity}) OR NEW.revision < OLD.revision OR (
                    ({changed_content}) AND (
                        NEW.revision != OLD.revision + 1 OR NEW.edited_at IS NULL
                        OR NEW.edited_by_supervisor_id IS NULL
                    )
                )
            )
            BEGIN
                SELECT RAISE(ABORT, 'Report identity is immutable and corrections require a new revision');
            END
        """)
        return

    changed_identity = " OR ".join(f"NEW.{key} IS DISTINCT FROM OLD.{key}" for key in identity)
    changed_content = " OR ".join(f"NEW.{key} IS DISTINCT FROM OLD.{key}" for key in content)
    frozen_email_changed = " OR ".join(f"NEW.{key} IS DISTINCT FROM OLD.{key}" for key in email_identity)
    context.execute(f"""
        CREATE OR REPLACE FUNCTION enforce_reportpdfemail_frozen_submission()
        RETURNS TRIGGER AS $$
        BEGIN
            IF {frozen_email_changed} THEN
                RAISE EXCEPTION USING ERRCODE = '23514',
                    MESSAGE = 'Submitted Report email snapshot and routing are immutable';
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
    """)
    context.execute("""
        CREATE TRIGGER trg_reportpdfemail_frozen_submission_update
        BEFORE UPDATE ON reportpdfemail FOR EACH ROW
        EXECUTE FUNCTION enforce_reportpdfemail_frozen_submission()
    """)
    # Replace the function, preserving its existing trigger and insertion/purpose
    # boundaries. Prior migration sources and all historical records stay intact.
    context.execute(f"""
        CREATE OR REPLACE FUNCTION enforce_workformsubmission_report_boundary()
        RETURNS TRIGGER AS $$
        DECLARE parent_purpose VARCHAR;
        BEGIN
            IF TG_OP = 'INSERT' THEN
                IF NEW.submission_purpose IS NULL OR NEW.submission_purpose NOT IN ('report', 'daywork') THEN
                    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Invalid submission purpose';
                END IF;
                SELECT form.template_purpose INTO parent_purpose FROM workform AS form WHERE form.id = NEW.form_id;
                IF COALESCE(parent_purpose, 'report') = 'report' AND (
                    NEW.status IS DISTINCT FROM 'pending' OR NEW.workflow_status IS DISTINCT FROM 'submitted'
                    OR NEW.supervisor_note IS NOT NULL OR NEW.reviewing_supervisor_id IS NOT NULL
                    OR NEW.review_started_at IS NOT NULL OR NEW.resolved_at IS NOT NULL
                ) THEN
                    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Reports must start submitted';
                END IF;
                RETURN NEW;
            END IF;
            IF NEW.submission_purpose IS DISTINCT FROM COALESCE(OLD.submission_purpose, 'report') THEN
                RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Submission purpose is immutable';
            END IF;
            IF COALESCE(OLD.submission_purpose, 'report') = 'report' AND (
                ({changed_identity}) OR NEW.revision < OLD.revision OR (
                    ({changed_content}) AND (
                        NEW.revision != OLD.revision + 1 OR NEW.edited_at IS NULL
                        OR NEW.edited_by_supervisor_id IS NULL
                    )
                )
            ) THEN
                RAISE EXCEPTION USING ERRCODE = '23514',
                    MESSAGE = 'Report identity is immutable and corrections require a new revision';
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
    """)
