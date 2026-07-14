import json

from sqlalchemy import text


revision = "0015_work_form_definition_snapshots"


def definition_snapshot(form_id, name, description, fields_json, version):
    try:
        fields = json.loads(fields_json or "[]")
    except (TypeError, json.JSONDecodeError):
        fields = []

    if not isinstance(fields, list):
        fields = []

    return json.dumps(
        {
            "schema_version": 1,
            "version": int(version or 1),
            "name": name or f"Form {form_id}",
            "description": description,
            "fields": fields,
        },
        separators=(",", ":"),
        sort_keys=True,
    )


def upgrade(context):
    context.add_column_if_missing(
        "workform",
        "definition_version",
        "INTEGER NOT NULL DEFAULT 1",
    )
    context.add_column_if_missing(
        "workformsubmission",
        "form_definition_version",
        "INTEGER",
    )
    context.add_column_if_missing(
        "workformsubmission",
        "definition_snapshot_json",
        "TEXT",
    )

    if not context.table_exists("workformsubmission"):
        return

    rows = context.connection.execute(
        text(
            """
            SELECT
                submission.id AS submission_id,
                submission.form_id AS form_id,
                form.name AS form_name,
                form.description AS form_description,
                form.fields_json AS fields_json,
                form.definition_version AS definition_version
            FROM workformsubmission AS submission
            LEFT JOIN workform AS form ON form.id = submission.form_id
            WHERE submission.definition_snapshot_json IS NULL
               OR submission.definition_snapshot_json = ''
            """
        )
    ).mappings().all()

    for row in rows:
        version = int(row["definition_version"] or 1)
        context.connection.execute(
            text(
                """
                UPDATE workformsubmission
                SET form_definition_version = :version,
                    definition_snapshot_json = :snapshot
                WHERE id = :submission_id
                """
            ),
            {
                "version": version,
                "snapshot": definition_snapshot(
                    row["form_id"],
                    row["form_name"],
                    row["form_description"],
                    row["fields_json"],
                    version,
                ),
                "submission_id": row["submission_id"],
            },
        )
