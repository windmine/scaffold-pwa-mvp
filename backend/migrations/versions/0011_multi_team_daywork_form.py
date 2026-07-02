import json


revision = "0011_multi_team_daywork_form"


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

MULTI_TEAM_DAYWORK_FIELDS = [
    {"id": "site_details", "label": "Site details", "type": "section", "required": False},
    {"id": "client", "label": "Client", "type": "text", "required": True},
    {"id": "details", "label": "Details", "type": "section", "required": False},
    {"id": "si_number", "label": "SI number", "type": "text", "required": False},
    {"id": "building", "label": "Building", "type": "text", "required": False},
    {"id": "level", "label": "Level", "type": "text", "required": False},
    {"id": "gridline", "label": "Gridline", "type": "text", "required": False},
    {"id": "teams", "label": "Teams", "type": "repeat", "required": True, "min_rows": 1, "max_rows": 8},
    {"id": "team_name", "label": "Team", "type": "text", "required": True, "repeat": "teams"},
    {"id": "team_people", "label": "Number of people", "type": "number", "required": True, "repeat": "teams"},
    {"id": "team_time", "label": "Working time", "type": "time_range", "required": True, "repeat": "teams"},
    {"id": "team_man_hours", "label": "Team man hours", "type": "formula", "formula": "team_people * team_time", "repeat": "teams"},
    {"id": "job_description", "label": "Job description", "type": "textarea", "required": True},
    {"id": "dimension", "label": "Dimension", "type": "textarea", "required": False},
    {"id": "site_manager_name", "label": "Site Manager Name", "type": "text", "required": False},
    {"id": "signature", "label": "Signature", "type": "signature", "required": True},
]

MULTI_TEAM_DAYWORK_DESCRIPTION = "General Daywork Form with repeatable teams and calculated man-hours."


def sql_string(value: str):
    return "'" + value.replace("'", "''") + "'"


def upgrade(context):
    if not context.table_exists("workform"):
        return

    old_fields_json = json.dumps(PDF_DAYWORK_FIELDS)
    new_fields_json = json.dumps(MULTI_TEAM_DAYWORK_FIELDS)

    context.execute(
        "UPDATE workform "
        f"SET description = {sql_string(MULTI_TEAM_DAYWORK_DESCRIPTION)}, "
        f"fields_json = {sql_string(new_fields_json)} "
        "WHERE name = 'Daywork log form' "
        f"AND fields_json = {sql_string(old_fields_json)}"
    )
