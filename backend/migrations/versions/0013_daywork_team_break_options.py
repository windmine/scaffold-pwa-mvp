import json


revision = "0013_daywork_team_break_options"


OLD_MULTI_TEAM_DAYWORK_FIELDS = [
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

NEW_MULTI_TEAM_DAYWORK_FIELDS = [
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
    {"id": "team_break", "label": "Break", "type": "select", "required": True, "options": ["No break", "15 minutes", "30 minutes", "45 minutes", "1 hour"], "repeat": "teams"},
    {"id": "team_man_hours", "label": "Team man hours", "type": "formula", "formula": "team_people * (team_time - team_break)", "repeat": "teams"},
    {"id": "job_description", "label": "Job description", "type": "textarea", "required": True},
    {"id": "dimension", "label": "Dimension", "type": "textarea", "required": False},
    {"id": "site_manager_name", "label": "Site Manager Name", "type": "text", "required": False},
    {"id": "signature", "label": "Signature", "type": "signature", "required": True},
]


def sql_string(value: str):
    return "'" + value.replace("'", "''") + "'"


def upgrade(context):
    if not context.table_exists("workform"):
        return

    context.execute(
        "UPDATE workform "
        f"SET fields_json = {sql_string(json.dumps(NEW_MULTI_TEAM_DAYWORK_FIELDS))} "
        "WHERE name = 'Daywork log form' "
        f"AND fields_json = {sql_string(json.dumps(OLD_MULTI_TEAM_DAYWORK_FIELDS))}"
    )
