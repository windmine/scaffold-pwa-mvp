import json


revision = "0010_pdf_daywork_form_template"


OLD_DAYWORK_FIELDS = [
    {"id": "work_completed", "label": "Work completed", "type": "textarea", "required": True},
    {"id": "hours_worked", "label": "Hours worked", "type": "number", "required": True},
    {"id": "materials_used", "label": "Materials used", "type": "textarea", "required": False},
    {"id": "safety_notes", "label": "Safety notes", "type": "textarea", "required": False},
    {"id": "worker_signature", "label": "Worker signature", "type": "signature", "required": True},
]

PDF_DAYWORK_FIELDS = [
    {"id": "site_details", "label": "Site details", "type": "section", "required": False},
    {"id": "client", "label": "Client", "type": "text", "required": True},
    {"id": "details", "label": "Details", "type": "section", "required": False},
    {"id": "si_number", "label": "SI number", "type": "text", "required": False},
    {"id": "building", "label": "Building", "type": "text", "required": False},
    {"id": "level", "label": "Level", "type": "text", "required": False},
    {"id": "gridline", "label": "Gridline", "type": "text", "required": False},
    {"id": "team_1", "label": "Team 1", "type": "text", "required": True},
    {"id": "working_hours_team_1", "label": "Working Hours-Team 1", "type": "text", "required": True},
    {"id": "total_man_hours_all_teams", "label": "Total Man Hours--All Teams", "type": "text", "required": True},
    {"id": "job_description", "label": "Job description", "type": "textarea", "required": True},
    {"id": "dimension", "label": "Dimension", "type": "textarea", "required": False},
    {"id": "site_manager_name", "label": "Site Manager Name", "type": "text", "required": False},
    {"id": "signature", "label": "Signature", "type": "signature", "required": True},
]

PDF_DAYWORK_DESCRIPTION = "General Daywork Form matching the site daywork PDF layout."


def sql_string(value: str):
    return "'" + value.replace("'", "''") + "'"


def upgrade(context):
    if not context.table_exists("workform"):
        return

    old_fields_json = json.dumps(OLD_DAYWORK_FIELDS)
    new_fields_json = json.dumps(PDF_DAYWORK_FIELDS)

    context.execute(
        "UPDATE workform "
        f"SET description = {sql_string(PDF_DAYWORK_DESCRIPTION)}, "
        f"fields_json = {sql_string(new_fields_json)} "
        "WHERE name = 'Daywork log form' "
        f"AND fields_json = {sql_string(old_fields_json)}"
    )
