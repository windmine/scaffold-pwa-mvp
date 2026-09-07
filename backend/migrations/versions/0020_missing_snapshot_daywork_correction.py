"""Repair only positively identified legacy Daywork; never rewrite 0019."""

import hashlib
import json
from datetime import datetime, timezone

from sqlalchemy import text

from app.migrations import MigrationError


revision = "0020_missing_snapshot_daywork_correction"
PREVIOUS_REVISION = "0019_report_daywork_purpose"
ORIGINAL_KEYS = {"work_completed", "hours_worked", "materials_used", "safety_notes", "worker_signature"}
PDF_KEYS = {"team_1", "working_hours_team_1", "total_man_hours_all_teams", "job_description", "signature"}
REPEAT_KEYS = {"teams", "team_people", "team_time", "team_man_hours", "job_description", "signature"}
PROVENANCE_TABLE = "workformsubmission_purpose_correction"


def refuse(row, reason):
    raise MigrationError(
        f"Migration {revision} refused ambiguous submission {row['id']}: {reason}. "
        "Review historical evidence before release; do not rewrite snapshots or migration checksums."
    )


def timestamp(value):
    if isinstance(value, datetime):
        result = value
    else:
        result = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return result.replace(tzinfo=timezone.utc) if result.tzinfo is None else result.astimezone(timezone.utc)


def json_object(value):
    try:
        result = json.loads(value) if isinstance(value, str) else value
    except (ValueError, TypeError):
        return None
    return result if isinstance(result, dict) else None


def keys(value):
    return {str(key).strip().lower() for key in value} if isinstance(value, dict) else set()


def definition_keys(value):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            return None
    if isinstance(value, dict):
        value = value.get("fields")
    if not isinstance(value, list) or any(not isinstance(field, dict) or not field.get("id") for field in value):
        return None
    return {str(field["id"]).strip().lower() for field in value}


def daywork_definition(ids):
    return ids is not None and any(signature <= ids for signature in (ORIGINAL_KEYS, PDF_KEYS, REPEAT_KEYS))


def answer_evidence(answers):
    ids = keys(answers)
    if ORIGINAL_KEYS <= ids:
        return "original_daywork_answer_signature"
    if PDF_KEYS <= ids:
        return "pdf_daywork_answer_signature"
    teams = answers.get("teams") if isinstance(answers, dict) else None
    if {"teams", "job_description", "signature"} <= ids and isinstance(teams, list) and teams:
        if all({"team_people", "team_time", "team_man_hours"} <= keys(team) for team in teams):
            return "repeat_daywork_answer_signature"
    return None


def submission_audits(connection, row):
    return connection.execute(text("""
        SELECT * FROM auditevent
        WHERE entity_id = :id AND entity_type IN ('form', 'form_submission')
        ORDER BY created_at DESC, id DESC
    """), {"id": row["id"]}).mappings().all()


def captured_definition_evidence(row, audits, cutoff):
    evidence = set()
    for audit in audits:
        for column in ("before_json", "after_json"):
            raw = audit[column]
            if not raw:
                continue
            snapshot = json_object(raw)
            if snapshot is None:
                refuse(row, "malformed submission audit")
            definition = snapshot.get("definition_snapshot")
            if not definition:
                continue
            if any(snapshot.get(key) != row[key] for key in ("id", "form_id", "worker_id", "department_id")):
                refuse(row, "submission audit identity conflict")
            try:
                audit_time = timestamp(audit["created_at"])
            except (ValueError, TypeError):
                refuse(row, "invalid submission audit timestamp")
            if audit_time >= cutoff:
                refuse(row, "submission definition evidence was recorded after 0019")
            ids = definition_keys(definition)
            if ids is None:
                refuse(row, "invalid captured Definition evidence")
            evidence.add("daywork" if daywork_definition(ids) else "report")
    return evidence


def verify_legacy_review(row, audits, cutoff):
    if any(audit["action"] == "report_transition" for audit in audits):
        refuse(row, "a genuine Report transition has already occurred")
    resolved = str(row["status"] or "").strip().lower() in {"approved", "rejected"}
    expected_status = "resolved" if resolved else "submitted"
    if row["workflow_status"] != expected_status or row["supervisor_note"] is not None:
        refuse(row, "Report review state no longer matches the legacy backfill")
    historical = [audit for audit in audits if
                  (audit["action"] == "review_decision" and audit["entity_type"] == "form") or
                  (audit["action"] == "form_submission_manual_create" and audit["entity_type"] == "form_submission")]
    reviewer, reviewed_at = None, None
    if resolved and historical:
        latest = historical[0]
        try:
            reviewed_at = timestamp(latest["created_at"])
        except (ValueError, TypeError):
            refuse(row, "invalid legacy review timestamp")
        if reviewed_at >= cutoff:
            refuse(row, "legacy review evidence was recorded after 0019")
        reviewer = latest["actor_id"]
    try:
        actual_times = tuple(timestamp(row[key]) if row[key] is not None else None
                             for key in ("review_started_at", "resolved_at"))
    except (ValueError, TypeError):
        refuse(row, "invalid Report review timestamp")
    if row["reviewing_supervisor_id"] != reviewer or actual_times != (reviewed_at, reviewed_at):
        refuse(row, "reviewer evidence no longer matches the legacy backfill")


def verify_parent(connection, row, submitted_at):
    parent = connection.execute(text("SELECT * FROM workform WHERE id = :id"), {"id": row["form_id"]}).mappings().first()
    if not parent or parent["department_id"] != row["department_id"]:
        refuse(row, "parent Template is missing or belongs to another Department")
    if parent["template_purpose"] != "daywork" or not daywork_definition(definition_keys(parent["fields_json"])):
        refuse(row, "current parent conflicts with historical Daywork evidence")
    if row["form_definition_version"] is not None and row["form_definition_version"] != parent["definition_version"]:
        refuse(row, "parent Definition version changed")
    try:
        if timestamp(parent["created_at"]) > submitted_at:
            refuse(row, "parent Template postdates the submission")
    except (ValueError, TypeError):
        refuse(row, "invalid parent creation timestamp")
    events = connection.execute(text("SELECT * FROM auditevent WHERE entity_type = 'work_form' AND entity_id = :id ORDER BY created_at, id"),
                                {"id": row["form_id"]}).mappings().all()
    latest_prior = None
    for audit in events:
        try:
            if timestamp(audit["created_at"]) < submitted_at:
                latest_prior = audit
                continue
        except (ValueError, TypeError):
            refuse(row, "invalid parent audit timestamp")
        before, after = json_object(audit["before_json"]), json_object(audit["after_json"])
        if before is None or after is None:
            refuse(row, "parent history is incomplete after submission")
        if any(before.get(key) != after.get(key) for key in ("fields", "definition_version", "template_purpose", "name", "description")):
            refuse(row, "parent Template was edited after submission")
    if latest_prior is not None:
        captured_parent = json_object(latest_prior["after_json"])
        if captured_parent is None or not daywork_definition(definition_keys(captured_parent)):
            refuse(row, "latest historical parent Definition conflicts with Daywork evidence")
        captured_version = captured_parent.get("definition_version")
        if captured_version is not None and captured_version != parent["definition_version"]:
            refuse(row, "current parent version conflicts with its historical audit")


def upgrade(context):
    connection = context.connection
    required = ("workformsubmission", "workform", "auditevent", "schema_migrations")
    if any(not context.table_exists(table) for table in required):
        raise MigrationError(f"Migration {revision} requires the complete 0019 schema")
    if connection.dialect.name == "sqlite":
        # SQLite's legacy driver defers BEGIN until DML. Begin explicitly so a
        # failure also rolls back correction-table/trigger DDL on an existing DB.
        if not connection.connection.driver_connection.in_transaction:
            context.execute("BEGIN IMMEDIATE")
    elif connection.dialect.name == "postgresql":
        context.execute("LOCK TABLE workformsubmission, workform, auditevent IN ACCESS EXCLUSIVE MODE")
    else:
        raise MigrationError(f"Migration {revision} supports only SQLite and PostgreSQL")

    candidates = connection.execute(text("""
        SELECT * FROM workformsubmission
        WHERE submission_purpose = 'report'
          AND (definition_snapshot_json IS NULL OR definition_snapshot_json = '')
        ORDER BY id
    """)).mappings().all()
    previous = connection.execute(text("SELECT applied_at FROM schema_migrations WHERE version = :version"),
                                  {"version": PREVIOUS_REVISION}).scalar_one()
    try:
        cutoff = timestamp(previous)
    except (ValueError, TypeError) as error:
        raise MigrationError(f"Migration {revision} requires a valid 0019 application timestamp") from error
    corrections = []
    for row in candidates:
        audits = submission_audits(connection, row)
        captured = captured_definition_evidence(row, audits, cutoff)
        signature = answer_evidence(json_object(row["answers_json"]))
        if captured == {"report"} and signature is None:
            continue  # Positive frozen Report evidence must remain a Report.
        if "report" in captured:
            refuse(row, "captured Report Definition conflicts with Daywork answers")
        if signature is None:
            refuse(row, "missing positive historical Daywork or Report evidence")
        try:
            submitted_at = timestamp(row["created_at"])
        except (ValueError, TypeError):
            refuse(row, "invalid original submission timestamp")
        if submitted_at >= cutoff:
            refuse(row, "submission does not predate 0019")
        verify_parent(connection, row, submitted_at)
        verify_legacy_review(row, audits, cutoff)
        corrections.append((row, signature))

    context.execute(f"""
        CREATE TABLE IF NOT EXISTS {PROVENANCE_TABLE} (
            submission_id INTEGER PRIMARY KEY,
            migration_version VARCHAR NOT NULL,
            previous_purpose VARCHAR NOT NULL,
            corrected_purpose VARCHAR NOT NULL,
            evidence_kind VARCHAR NOT NULL,
            evidence_sha256 VARCHAR NOT NULL,
            corrected_at DATETIME NOT NULL
        )
    """)
    if not corrections:
        return

    if connection.dialect.name == "sqlite":
        trigger_sql = connection.execute(text("""
            SELECT sql FROM sqlite_master WHERE type = 'trigger'
              AND name = 'trg_workformsubmission_purpose_immutable_update'
        """)).scalar_one_or_none()
        if not trigger_sql:
            raise MigrationError("Missing immutable-purpose trigger; refusing corrective migration")
        context.execute("DROP TRIGGER trg_workformsubmission_purpose_immutable_update")
    else:
        enabled = connection.execute(text("""
            SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'workformsubmission'::regclass
              AND tgname = 'trg_workformsubmission_report_boundary' AND NOT tgisinternal
        """)).scalar_one_or_none()
        if enabled != "O":
            raise MigrationError("Unexpected Report boundary trigger state; refusing corrective migration")
        context.execute("ALTER TABLE workformsubmission DISABLE TRIGGER trg_workformsubmission_report_boundary")

    for row, signature in corrections:
        result = connection.execute(text("""
            UPDATE workformsubmission SET submission_purpose = 'daywork'
            WHERE id = :id AND submission_purpose = 'report'
              AND (definition_snapshot_json IS NULL OR definition_snapshot_json = '')
        """), {"id": row["id"]})
        if result.rowcount != 1:
            refuse(row, "submission changed during correction")
        fingerprint = hashlib.sha256(json.dumps(dict(row), sort_keys=True, default=str).encode()).hexdigest()
        connection.execute(text(f"""
            INSERT INTO {PROVENANCE_TABLE} (submission_id, migration_version, previous_purpose,
                corrected_purpose, evidence_kind, evidence_sha256, corrected_at)
            VALUES (:id, :version, 'report', 'daywork', :kind, :fingerprint, :created)
        """), {"id": row["id"], "version": revision, "kind": signature,
               "fingerprint": fingerprint, "created": datetime.now(timezone.utc)})

    if connection.dialect.name == "sqlite":
        context.execute(trigger_sql)
    else:
        context.execute("ALTER TABLE workformsubmission ENABLE TRIGGER trg_workformsubmission_report_boundary")
    # An exception before restoration propagates to run_migrations' enclosing
    # transaction, restoring the original data, guards, and ledger together.
