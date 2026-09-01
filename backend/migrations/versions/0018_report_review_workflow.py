revision = "0018_report_review_workflow"


WORKFLOW_CONSTRAINT_ERROR = (
    "Report workflow status must be submitted, in_review, or resolved"
)


def upgrade(context):
    if not context.table_exists("workformsubmission"):
        return

    context.add_column_if_missing(
        "workformsubmission",
        "workflow_status",
        "VARCHAR NOT NULL DEFAULT 'submitted'",
    )
    context.add_column_if_missing("workformsubmission", "supervisor_note", "TEXT")
    context.add_column_if_missing("workformsubmission", "reviewing_supervisor_id", "INTEGER")
    context.add_column_if_missing("workformsubmission", "review_started_at", "DATETIME")
    context.add_column_if_missing("workformsubmission", "resolved_at", "DATETIME")

    # Keep the existing approval outcome intact. The new field records the report's
    # workflow stage, so old approved/rejected reports become resolved while
    # pending or unrecognised legacy values remain safely actionable as submitted.
    context.execute(
        """
        UPDATE workformsubmission
        SET workflow_status = CASE
            WHEN LOWER(TRIM(COALESCE(status, ''))) IN ('approved', 'rejected')
                THEN 'resolved'
            ELSE 'submitted'
        END
        """
    )

    # Historical decision/manual-create audits are the only trustworthy source for
    # reviewer and resolution time. Leave values null when no durable evidence exists.
    if context.table_exists("auditevent"):
        context.execute(
            """
            UPDATE workformsubmission
            SET reviewing_supervisor_id = (
                    SELECT event.actor_id
                    FROM auditevent AS event
                    WHERE (
                            (event.action = 'review_decision' AND event.entity_type = 'form')
                            OR (
                                event.action = 'form_submission_manual_create'
                                AND event.entity_type = 'form_submission'
                            )
                        )
                      AND event.entity_id = workformsubmission.id
                    ORDER BY event.created_at DESC, event.id DESC
                    LIMIT 1
                ),
                review_started_at = (
                    SELECT event.created_at
                    FROM auditevent AS event
                    WHERE (
                            (event.action = 'review_decision' AND event.entity_type = 'form')
                            OR (
                                event.action = 'form_submission_manual_create'
                                AND event.entity_type = 'form_submission'
                            )
                        )
                      AND event.entity_id = workformsubmission.id
                    ORDER BY event.created_at DESC, event.id DESC
                    LIMIT 1
                ),
                resolved_at = (
                    SELECT event.created_at
                    FROM auditevent AS event
                    WHERE (
                            (event.action = 'review_decision' AND event.entity_type = 'form')
                            OR (
                                event.action = 'form_submission_manual_create'
                                AND event.entity_type = 'form_submission'
                            )
                        )
                      AND event.entity_id = workformsubmission.id
                    ORDER BY event.created_at DESC, event.id DESC
                    LIMIT 1
                )
            WHERE workflow_status = 'resolved'
            """
        )

    context.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_workformsubmission_workflow_status
        ON workformsubmission (workflow_status)
        """
    )
    context.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_workformsubmission_reviewing_supervisor_id
        ON workformsubmission (reviewing_supervisor_id)
        """
    )
    context.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_workformsubmission_report_workflow
        ON workformsubmission (
            department_id,
            workflow_status,
            deleted_at,
            created_at DESC,
            id DESC
        )
        """
    )

    if context.connection.dialect.name == "sqlite":
        context.execute(
            f"""
            CREATE TRIGGER IF NOT EXISTS trg_workformsubmission_workflow_status_insert
            BEFORE INSERT ON workformsubmission
            WHEN NEW.workflow_status NOT IN ('submitted', 'in_review', 'resolved')
            BEGIN
                SELECT RAISE(ABORT, '{WORKFLOW_CONSTRAINT_ERROR}');
            END
            """
        )
        context.execute(
            f"""
            CREATE TRIGGER IF NOT EXISTS trg_workformsubmission_workflow_status_update
            BEFORE UPDATE OF workflow_status ON workformsubmission
            WHEN NEW.workflow_status NOT IN ('submitted', 'in_review', 'resolved')
            BEGIN
                SELECT RAISE(ABORT, '{WORKFLOW_CONSTRAINT_ERROR}');
            END
            """
        )
        return

    context.execute(
        """
        ALTER TABLE workformsubmission
        ADD CONSTRAINT ck_workformsubmission_workflow_status
        CHECK (workflow_status IN ('submitted', 'in_review', 'resolved'))
        """
    )
