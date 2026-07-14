import json
import math
import ast
import operator
import re
from datetime import timezone
from typing import Optional

from fastapi import HTTPException
from sqlmodel import Session, select

from app.models import (
    AttendanceRecord,
    Department,
    Site,
    TaskLog,
    TeamWorkLog,
    TeamWorkLogEntry,
    User,
    WorkForm,
    WorkFormSubmission,
)


VALID_ROLES = {"worker", "supervisor"}
VALID_WORKER_CLASSES = {"normal", "leader"}
VALID_USER_STATUSES = {"active", "resigned"}
DEFAULT_DEPARTMENT_NAME = "Leader"
DEPARTMENT_NAMES = ["Leader", "Mutual", "MC", "Stech", "BOP"]
VALID_REVIEW_STATUSES = {"pending", "approved", "rejected"}
VALID_APPROVAL_RECORD_TYPES = {"attendance", "task", "form", "team_log"}
MAX_TASK_LOG_PHOTOS = 8
VALID_WORK_FORM_STATUSES = {"active", "archived"}
VALID_WORK_FORM_FIELD_TYPES = {
    "text",
    "textarea",
    "number",
    "date",
    "select",
    "checkbox",
    "signature",
    "section",
    "time_range",
    "formula",
    "repeat",
}
MAX_WORK_FORM_FIELDS = 30
MAX_WORK_FORM_PHOTOS = 8
MAX_REPEAT_ROWS = 50
WORK_FORM_DEFINITION_SCHEMA_VERSION = 1
SAFE_FIELD_ID_PATTERN = re.compile(r"^[a-z0-9_]+$")
SAFE_REFERENCE_PATTERN = re.compile(r"^[a-z0-9_]+$")


def format_datetime(value):
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)

    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def attendance_record_response(record: AttendanceRecord, session: Session):
    worker = session.get(User, record.worker_id)
    site = session.get(Site, record.site_id) if record.site_id else None
    department = session.get(Department, record.department_id) if record.department_id else None
    created_by_supervisor = (
        session.get(User, record.created_by_supervisor_id)
        if record.created_by_supervisor_id
        else None
    )
    deleted_by_supervisor = (
        session.get(User, record.deleted_by_supervisor_id)
        if record.deleted_by_supervisor_id
        else None
    )

    return {
        "id": record.id,
        "department_id": record.department_id,
        "department_name": department.name if department else None,
        "worker_id": record.worker_id,
        "worker_name": worker.name if worker else f"Worker {record.worker_id}",
        "site_id": record.site_id,
        "site_name": site.name if site else None,
        "record_type": record.record_type,
        "latitude": record.latitude,
        "longitude": record.longitude,
        "accuracy": record.accuracy,
        "distance_from_site_m": record.distance_from_site_m,
        "within_site_radius": record.within_site_radius,
        "note": record.note,
        "photo_url": record.photo_url,
        "client_submission_id": record.client_submission_id,
        "entry_source": record.entry_source or "worker",
        "created_by_supervisor_id": record.created_by_supervisor_id,
        "created_by_supervisor_name": created_by_supervisor.name if created_by_supervisor else None,
        "deleted_at": format_datetime(record.deleted_at) if record.deleted_at else None,
        "deleted_by_supervisor_id": record.deleted_by_supervisor_id,
        "deleted_by_supervisor_name": deleted_by_supervisor.name if deleted_by_supervisor else None,
        "deletion_reason": record.deletion_reason,
        "status": record.status,
        "created_at": format_datetime(record.created_at),
    }


def task_log_photo_urls(log: TaskLog):
    urls = []

    if log.photo_urls:
        try:
            loaded = json.loads(log.photo_urls)
            if isinstance(loaded, list):
                urls = [
                    item
                    for item in loaded
                    if isinstance(item, str) and item
                ]
        except json.JSONDecodeError:
            urls = []

    if log.photo_url and log.photo_url not in urls:
        urls.insert(0, log.photo_url)

    return urls


def task_log_response(log: TaskLog, session: Session):
    worker = session.get(User, log.worker_id)
    site = session.get(Site, log.site_id) if log.site_id else None
    department = session.get(Department, log.department_id) if log.department_id else None
    photo_urls = task_log_photo_urls(log)
    created_by_supervisor = (
        session.get(User, log.created_by_supervisor_id)
        if log.created_by_supervisor_id
        else None
    )
    deleted_by_supervisor = (
        session.get(User, log.deleted_by_supervisor_id)
        if log.deleted_by_supervisor_id
        else None
    )

    return {
        "id": log.id,
        "department_id": log.department_id,
        "department_name": department.name if department else None,
        "worker_id": log.worker_id,
        "worker_name": worker.name if worker else f"Worker {log.worker_id}",
        "site_id": log.site_id,
        "site_name": site.name if site else None,
        "description": log.description,
        "work_date": log.work_date,
        "hours_worked": log.hours_worked,
        "safety_notes": log.safety_notes,
        "photo_url": photo_urls[0] if photo_urls else None,
        "photo_urls": photo_urls,
        "client_submission_id": log.client_submission_id,
        "entry_source": log.entry_source or "worker",
        "created_by_supervisor_id": log.created_by_supervisor_id,
        "created_by_supervisor_name": created_by_supervisor.name if created_by_supervisor else None,
        "deleted_at": format_datetime(log.deleted_at) if log.deleted_at else None,
        "deleted_by_supervisor_id": log.deleted_by_supervisor_id,
        "deleted_by_supervisor_name": deleted_by_supervisor.name if deleted_by_supervisor else None,
        "deletion_reason": log.deletion_reason,
        "status": log.status or "pending",
        "created_at": format_datetime(log.created_at),
    }


def task_template_response(template, session: Session):
    site = session.get(Site, template.site_id) if template.site_id else None

    return {
        "id": template.id,
        "department_id": template.department_id,
        "worker_id": template.worker_id,
        "site_id": template.site_id,
        "site_name": site.name if site else None,
        "name": template.name,
        "description": template.description,
        "hours_worked": template.hours_worked,
        "safety_notes": template.safety_notes,
        "created_at": format_datetime(template.created_at),
    }


def parse_json_list(value: Optional[str]):
    if not value:
        return []

    try:
        loaded = json.loads(value)
    except json.JSONDecodeError:
        return []

    return loaded if isinstance(loaded, list) else []


def parse_json_object(value: Optional[str]):
    if not value:
        return {}

    try:
        loaded = json.loads(value)
    except json.JSONDecodeError:
        return {}

    return loaded if isinstance(loaded, dict) else {}


def work_form_fields(form: WorkForm):
    return parse_json_list(form.fields_json)


def work_form_definition(form: WorkForm):
    return {
        "schema_version": WORK_FORM_DEFINITION_SCHEMA_VERSION,
        "version": int(form.definition_version or 1),
        "name": form.name,
        "description": form.description,
        "fields": work_form_fields(form),
    }


def work_form_definition_snapshot_json(form: WorkForm):
    return json.dumps(
        work_form_definition(form),
        separators=(",", ":"),
        sort_keys=True,
    )


def work_form_submission_definition(submission: WorkFormSubmission, session: Session):
    snapshot = parse_json_object(submission.definition_snapshot_json)
    fields = snapshot.get("fields")

    if isinstance(fields, list):
        return {
            "schema_version": int(snapshot.get("schema_version") or WORK_FORM_DEFINITION_SCHEMA_VERSION),
            "version": int(snapshot.get("version") or submission.form_definition_version or 1),
            "name": str(snapshot.get("name") or f"Form {submission.form_id}"),
            "description": snapshot.get("description"),
            "fields": fields,
        }

    form = session.get(WorkForm, submission.form_id)
    if form:
        return work_form_definition(form)

    return {
        "schema_version": WORK_FORM_DEFINITION_SCHEMA_VERSION,
        "version": int(submission.form_definition_version or 1),
        "name": f"Form {submission.form_id}",
        "description": None,
        "fields": [],
    }


def work_form_response(form: WorkForm, session: Session | None = None):
    department = session.get(Department, form.department_id) if session and form.department_id else None

    return {
        "id": form.id,
        "department_id": form.department_id,
        "department_name": department.name if department else None,
        "name": form.name,
        "description": form.description,
        "fields": work_form_fields(form),
        "definition_version": int(form.definition_version or 1),
        "status": form.status,
        "created_by": form.created_by,
        "created_at": format_datetime(form.created_at),
    }


def work_form_submission_response(submission: WorkFormSubmission, session: Session):
    definition = work_form_submission_definition(submission, session)
    worker = session.get(User, submission.worker_id)
    site = session.get(Site, submission.site_id) if submission.site_id else None
    department = session.get(Department, submission.department_id) if submission.department_id else None
    deleted_by_supervisor = (
        session.get(User, submission.deleted_by_supervisor_id)
        if submission.deleted_by_supervisor_id
        else None
    )

    return {
        "id": submission.id,
        "department_id": submission.department_id,
        "department_name": department.name if department else None,
        "form_id": submission.form_id,
        "form_name": definition["name"],
        "form_description": definition["description"],
        "definition_version": definition["version"],
        "definition_schema_version": definition["schema_version"],
        "fields": definition["fields"],
        "worker_id": submission.worker_id,
        "worker_name": worker.name if worker else f"Worker {submission.worker_id}",
        "worker_email": worker.email if worker else None,
        "site_id": submission.site_id,
        "site_name": site.name if site else None,
        "work_date": submission.work_date,
        "answers": parse_json_object(submission.answers_json),
        "photo_urls": parse_json_list(submission.photo_urls),
        "photo_metadata": parse_json_list(submission.photo_metadata),
        "client_submission_id": submission.client_submission_id,
        "status": submission.status or "pending",
        "deleted_at": format_datetime(submission.deleted_at) if submission.deleted_at else None,
        "deleted_by_supervisor_id": submission.deleted_by_supervisor_id,
        "deleted_by_supervisor_name": deleted_by_supervisor.name if deleted_by_supervisor else None,
        "deletion_reason": submission.deletion_reason,
        "created_at": format_datetime(submission.created_at),
    }


def team_work_log_response(log: TeamWorkLog, session: Session):
    leader = session.get(User, log.leader_id)
    department = session.get(Department, log.department_id) if log.department_id else None
    deleted_by_supervisor = (
        session.get(User, log.deleted_by_supervisor_id)
        if log.deleted_by_supervisor_id
        else None
    )
    entries = session.exec(
        select(TeamWorkLogEntry)
        .where(TeamWorkLogEntry.team_work_log_id == log.id)
        .order_by(TeamWorkLogEntry.work_date, TeamWorkLogEntry.start_time, TeamWorkLogEntry.id)
    ).all()
    entry_items = []

    for entry in entries:
        worker = session.get(User, entry.worker_id)
        site = session.get(Site, entry.site_id)
        entry_items.append({
            "id": entry.id,
            "worker_id": entry.worker_id,
            "worker_name": worker.name if worker else f"Worker {entry.worker_id}",
            "site_id": entry.site_id,
            "site_name": site.name if site else f"Site {entry.site_id}",
            "work_date": entry.work_date,
            "start_time": entry.start_time,
            "end_time": entry.end_time,
            "break_minutes": entry.break_minutes,
            "hours_worked": entry.hours_worked,
            "work_description": entry.work_description,
        })

    return {
        "id": log.id,
        "department_id": log.department_id,
        "department_name": department.name if department else None,
        "leader_id": log.leader_id,
        "leader_name": leader.name if leader else f"Leader {log.leader_id}",
        "week_start": log.week_start,
        "notes": log.notes,
        "client_submission_id": log.client_submission_id,
        "status": log.status or "pending",
        "deleted_at": format_datetime(log.deleted_at) if log.deleted_at else None,
        "deleted_by_supervisor_id": log.deleted_by_supervisor_id,
        "deleted_by_supervisor_name": deleted_by_supervisor.name if deleted_by_supervisor else None,
        "deletion_reason": log.deletion_reason,
        "entries": entry_items,
        "entry_count": len(entry_items),
        "member_count": len({entry["worker_id"] for entry in entry_items}),
        "total_hours": round(sum(entry["hours_worked"] for entry in entry_items), 2),
        "created_at": format_datetime(log.created_at),
    }


def review_record_response(record_kind: str, record, session: Session):
    if record_kind == "attendance":
        item = attendance_record_response(record, session)
    elif record_kind == "task":
        item = task_log_response(record, session)
    elif record_kind == "form":
        item = work_form_submission_response(record, session)
    elif record_kind == "team_log":
        item = team_work_log_response(record, session)
    else:
        raise HTTPException(status_code=400, detail="record type is not reviewable")

    item["kind"] = record_kind
    item["review_key"] = f"{record_kind}:{item['id']}"
    return item


def site_response(site: Site):
    return {
        "id": site.id,
        "department_id": site.department_id,
        "name": site.name,
        "address": site.address,
        "latitude": site.latitude,
        "longitude": site.longitude,
        "allowed_radius_m": site.allowed_radius_m,
    }


def upload_url(filename: str):
    return f"/uploads/{filename}"


def department_response(department: Department):
    return {
        "id": department.id,
        "name": department.name,
        "status": department.status or "active",
        "created_at": format_datetime(department.created_at),
    }


def list_departments(session: Session):
    departments = session.exec(
        select(Department)
        .where(Department.status == "active")
        .order_by(Department.id)
    ).all()

    return [
        department_response(department)
        for department in departments
    ]


def default_department(session: Session):
    department = session.exec(
        select(Department).where(Department.name == DEFAULT_DEPARTMENT_NAME)
    ).first()

    if department:
        return department

    department = Department(name=DEFAULT_DEPARTMENT_NAME, status="active")
    session.add(department)
    session.flush()
    return department


def user_response(user: User, session: Session | None = None):
    department = session.get(Department, user.department_id) if session and user.department_id else None
    dashboard_department = (
        session.get(Department, user.dashboard_department_id)
        if session and user.dashboard_department_id
        else None
    )

    return {
        "id": user.id,
        "department_id": user.department_id,
        "department_name": department.name if department else None,
        "dashboard_department_id": user.dashboard_department_id,
        "dashboard_department_name": dashboard_department.name if dashboard_department else None,
        "email": user.email,
        "name": user.name,
        "role": user.role,
        "worker_class": user.worker_class if user.role == "worker" else None,
        "status": user.status or "active",
        "is_global_admin": bool(user.is_global_admin),
    }


def normalize_client_submission_id(value: Optional[str]):
    if not value:
        return None

    normalized = value.strip()
    return normalized or None


def require_worker(user: User):
    if user.role != "worker":
        raise HTTPException(status_code=403, detail="Worker only")


def require_leader(user: User):
    require_worker(user)
    if (user.worker_class or "normal") != "leader":
        raise HTTPException(status_code=403, detail="Leader only")


def user_is_global_admin(user: User):
    return bool(getattr(user, "is_global_admin", False))


def can_access_department(user: User, department_id: Optional[int]):
    if user_is_global_admin(user):
        return True

    return department_id is not None and department_id == user.department_id


def ensure_department_exists(session: Session, department_id: Optional[int]):
    if department_id is None:
        return default_department(session)

    department = session.get(Department, department_id)
    if not department or (department.status or "active") != "active":
        raise HTTPException(status_code=400, detail="Department not found")

    return department


def department_id_for_new_record(user: User, session: Session):
    if user.department_id:
        return user.department_id

    department = default_department(session)
    user.department_id = department.id
    session.add(user)
    session.flush()
    return department.id


def require_department_access(user: User, department_id: Optional[int], detail: str = "Record not found"):
    if not can_access_department(user, department_id):
        raise HTTPException(status_code=404, detail=detail)


def scope_statement_to_user_department(statement, model, user: User):
    if user_is_global_admin(user):
        return statement

    return statement.where(model.department_id == user.department_id)


def validate_user_input(email: str, name: str, password: str, role: str):
    email = email.strip().lower()
    name = name.strip()
    role = role.strip().lower()

    if "@" not in email or "." not in email:
        raise HTTPException(status_code=400, detail="Enter a valid email address")
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
    if len(password.encode("utf-8")) > 72:
        raise HTTPException(status_code=400, detail="Password must be 72 bytes or shorter")
    if role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail="Role must be worker or supervisor")

    return email, name, role


def validate_worker_class(worker_class: Optional[str]):
    normalized = (worker_class or "normal").strip().lower()
    if normalized not in VALID_WORKER_CLASSES:
        raise HTTPException(status_code=400, detail="worker_class must be normal or leader")
    return normalized


def require_confirmed(confirmed: bool):
    if not confirmed:
        raise HTTPException(status_code=400, detail="Double check required before saving this change")


def ensure_site_exists(session: Session, site_id: Optional[int], user: User | None = None):
    if site_id is None:
        return None

    site = session.get(Site, site_id)

    if not site:
        raise HTTPException(status_code=400, detail="Site not found")
    if user and not can_access_department(user, site.department_id):
        raise HTTPException(status_code=400, detail="Site not found")

    return site


def distance_between_coordinates_m(
    start_latitude: float,
    start_longitude: float,
    end_latitude: float,
    end_longitude: float
):
    earth_radius_m = 6371000
    start_lat = math.radians(start_latitude)
    end_lat = math.radians(end_latitude)
    delta_lat = math.radians(end_latitude - start_latitude)
    delta_lon = math.radians(end_longitude - start_longitude)
    a = (
        math.sin(delta_lat / 2) ** 2
        + math.cos(start_lat) * math.cos(end_lat) * math.sin(delta_lon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return earth_radius_m * c


def site_distance_check(
    site: Optional[Site],
    latitude: Optional[float],
    longitude: Optional[float],
):
    if site is None or latitude is None or longitude is None:
        return None, None

    distance = round(
        distance_between_coordinates_m(
            site.latitude,
            site.longitude,
            latitude,
            longitude
        ),
        1
    )

    return distance, distance <= site.allowed_radius_m


def validate_photo_url(photo_url: Optional[str]):
    if photo_url and len(photo_url) > 500:
        raise HTTPException(status_code=400, detail="Photo URL is too long")
    if photo_url and not photo_url.startswith("/uploads/"):
        raise HTTPException(status_code=400, detail="Photo URL must come from /photo-uploads")


def normalize_task_photo_urls(
    photo_url: Optional[str] = None,
    photo_urls: Optional[list[str]] = None
):
    urls = []

    if photo_urls:
        urls.extend([url for url in photo_urls if url])
    if photo_url and photo_url not in urls:
        urls.insert(0, photo_url)

    if len(urls) > MAX_TASK_LOG_PHOTOS:
        raise HTTPException(
            status_code=400,
            detail=f"Task logs can include up to {MAX_TASK_LOG_PHOTOS} photos"
        )

    for url in urls:
        validate_photo_url(url)

    return urls


def safe_field_id(raw_id: str):
    field_id = raw_id.strip().lower().replace(" ", "_")
    field_id = re.sub(r"_+", "_", field_id).strip("_")

    if not field_id or not SAFE_FIELD_ID_PATTERN.match(field_id):
        raise HTTPException(
            status_code=400,
            detail="Field ids can only include lowercase letters, numbers, and underscores",
        )

    return field_id


CONDITION_OPERATORS = ["!=", ">=", "<=", "=", ">", "<"]


def split_condition(condition: str):
    for operator_text in CONDITION_OPERATORS:
        if operator_text not in condition:
            continue
        field_id, expected = condition.split(operator_text, 1)
        field_id = field_id.strip()
        if not SAFE_REFERENCE_PATTERN.fullmatch(field_id):
            return None
        return field_id, operator_text, expected
    return None


def normalize_show_if(value):
    if value is None:
        return None

    condition = str(value).strip()
    if not condition:
        return None

    if not split_condition(condition):
        raise HTTPException(status_code=400, detail="show_if must use field=value style syntax")

    return condition[:240]


FORMULA_OPERATORS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.USub: operator.neg,
    ast.UAdd: operator.pos,
}


def validate_formula_expression(expression: str, label: str):
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError:
        raise HTTPException(status_code=400, detail=f"Formula field '{label}' has invalid syntax")

    for node in ast.walk(tree):
        if isinstance(node, ast.Expression):
            continue
        if type(node) in FORMULA_OPERATORS:
            continue
        if isinstance(node, ast.BinOp) and type(node.op) in FORMULA_OPERATORS:
            continue
        if isinstance(node, ast.UnaryOp) and type(node.op) in FORMULA_OPERATORS:
            continue
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            continue
        if isinstance(node, ast.Name) and SAFE_REFERENCE_PATTERN.match(node.id):
            continue
        if isinstance(node, ast.Load):
            continue
        raise HTTPException(status_code=400, detail=f"Formula field '{label}' uses unsupported syntax")


def formula_references(expression: str):
    tree = ast.parse(expression, mode="eval")
    return {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}


def normalize_formula(value, label: str):
    formula = str(value or "").strip()
    if not formula:
        raise HTTPException(status_code=400, detail=f"Formula field '{label}' needs a formula")
    if len(formula) > 500:
        raise HTTPException(status_code=400, detail=f"Formula field '{label}' is too long")
    validate_formula_expression(formula, label)
    return formula


def compare_condition_value(left, operator_text: str, right: str):
    if isinstance(left, bool):
        left_text = "true" if left else "false"
    elif isinstance(left, dict) and "duration_hours" in left:
        left_text = str(left.get("duration_hours") if left.get("duration_hours") is not None else "")
    elif left is None:
        left_text = ""
    else:
        left_text = str(left)

    right_text = str(right).strip()

    if operator_text in {"=", "!="}:
        result = left_text.strip().lower() == right_text.lower()
        return not result if operator_text == "!=" else result

    try:
        left_number = float(left_text)
        right_number = float(right_text)
    except (TypeError, ValueError):
        return False

    if operator_text == ">":
        return left_number > right_number
    if operator_text == "<":
        return left_number < right_number
    if operator_text == ">=":
        return left_number >= right_number
    if operator_text == "<=":
        return left_number <= right_number
    return False


def condition_is_met(condition: Optional[str], answers: dict):
    condition = (condition or "").strip()
    if not condition:
        return True

    parsed = split_condition(condition)
    if not parsed:
        return False
    field_id, operator_text, expected = parsed
    return compare_condition_value(answers.get(field_id), operator_text, expected)


def formula_value_from_answer(value):
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    if isinstance(value, dict):
        duration = value.get("duration_hours")
        try:
            return float(duration)
        except (TypeError, ValueError):
            return 0
    break_duration = break_answer_duration_hours(value)
    if break_duration is not None:
        return break_duration
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0


def break_answer_duration_hours(value):
    if value in (None, ""):
        return None

    text = str(value).strip().lower()
    if not text:
        return None
    if text in {"no break", "none", "0", "0 minutes", "0 minute"}:
        return 0
    if text in {"0.25", "15", "15 min", "15 mins", "15 minute", "15 minutes"}:
        return 0.25
    if text in {"0.5", "0.50", "30", "30 min", "30 mins", "30 minute", "30 minutes"}:
        return 0.5
    if text in {"0.75", "45", "45 min", "45 mins", "45 minute", "45 minutes"}:
        return 0.75
    if text in {"1", "1.0", "1 hour", "1 hr", "60", "60 min", "60 mins", "60 minute", "60 minutes"}:
        return 1

    return None


def evaluate_formula_expression(expression: str, answers: dict):
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError:
        raise HTTPException(status_code=400, detail="Formula has invalid syntax")

    def evaluate(node):
        if isinstance(node, ast.Expression):
            return evaluate(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return float(node.value)
        if isinstance(node, ast.Name):
            return formula_value_from_answer(answers.get(node.id))
        if isinstance(node, ast.BinOp) and type(node.op) in FORMULA_OPERATORS:
            right = evaluate(node.right)
            if isinstance(node.op, ast.Div) and right == 0:
                return 0
            return FORMULA_OPERATORS[type(node.op)](evaluate(node.left), right)
        if isinstance(node, ast.UnaryOp) and type(node.op) in FORMULA_OPERATORS:
            return FORMULA_OPERATORS[type(node.op)](evaluate(node.operand))
        raise HTTPException(status_code=400, detail="Formula uses unsupported syntax")

    value = evaluate(tree)
    if not math.isfinite(value):
        return 0
    return round(value, 2)


def normalize_work_form_fields(fields):
    normalized_fields = []
    seen_ids = set()

    if len(fields) > MAX_WORK_FORM_FIELDS:
        raise HTTPException(status_code=400, detail=f"Forms can include up to {MAX_WORK_FORM_FIELDS} fields")

    for field in fields:
        field_id = safe_field_id(field.id)
        label = field.label.strip()
        field_type = field.type.strip().lower()
        if field_type in {"subsection", "sub_section"}:
            field_type = "section"
        if field_type in {"time-range", "timerange"}:
            field_type = "time_range"

        if not field_id:
            raise HTTPException(status_code=400, detail="Field id is required")
        if field_id in seen_ids:
            raise HTTPException(status_code=400, detail=f"Duplicate field id: {field_id}")
        if not label:
            raise HTTPException(status_code=400, detail="Field label is required")
        if field_type not in VALID_WORK_FORM_FIELD_TYPES:
            raise HTTPException(status_code=400, detail="Unsupported field type")

        options = [
            option.strip()
            for option in (field.options or [])
            if option and option.strip()
        ]
        if field_type == "select" and not options:
            raise HTTPException(status_code=400, detail=f"Select field '{label}' needs options")
        if field_type in {"section", "repeat", "formula"}:
            options = []

        normalized = {
            "id": field_id,
            "label": label,
            "type": field_type,
            "required": field.required,
            "options": options,
        }

        if field_type in {"section", "formula"}:
            normalized["required"] = False

        show_if = normalize_show_if(field.show_if)
        if show_if:
            normalized["show_if"] = show_if

        repeat = safe_field_id(field.repeat) if field.repeat else None
        if repeat:
            normalized["repeat"] = repeat

        if field_type == "formula":
            normalized["formula"] = normalize_formula(field.formula, label)

        if field_type == "repeat":
            min_rows = field.min_rows if field.min_rows is not None else (1 if field.required else 0)
            max_rows = field.max_rows if field.max_rows is not None else 12
            if max_rows < max(1, min_rows):
                raise HTTPException(status_code=400, detail=f"Repeat section '{label}' max rows must be at least min rows")
            normalized["min_rows"] = min_rows
            normalized["max_rows"] = min(max_rows, MAX_REPEAT_ROWS)
            normalized["required"] = min_rows > 0

        normalized_fields.append(normalized)
        seen_ids.add(field_id)

    repeat_ids = {field["id"] for field in normalized_fields if field["type"] == "repeat"}
    for field in normalized_fields:
        if field.get("repeat") and field["repeat"] not in repeat_ids:
            raise HTTPException(status_code=400, detail=f"Repeat child '{field['label']}' references an unknown repeat section")
        if field["type"] == "repeat" and field.get("repeat"):
            raise HTTPException(status_code=400, detail="Repeat sections cannot be nested")

    validate_work_form_field_dependencies(normalized_fields)
    return normalized_fields


def validate_work_form_field_dependencies(fields: list[dict]):
    top_level_scope = set()
    repeat_parent_scopes = {}

    for field in fields:
        if field.get("repeat"):
            continue
        validate_work_form_field_dependencies_in_scope(field, top_level_scope)
        if field["type"] == "repeat":
            repeat_parent_scopes[field["id"]] = set(top_level_scope)
        elif field["type"] != "section":
            top_level_scope.add(field["id"])

    repeat_scopes = {repeat_id: set(scope) for repeat_id, scope in repeat_parent_scopes.items()}
    for field in fields:
        repeat_id = field.get("repeat")
        if not repeat_id:
            continue
        scope = repeat_scopes[repeat_id]
        validate_work_form_field_dependencies_in_scope(field, scope)
        if field["type"] != "section":
            scope.add(field["id"])


def validate_work_form_field_dependencies_in_scope(field: dict, available: set[str]):
    label = field.get("label") or field.get("id")
    show_if = field.get("show_if")
    if show_if:
        reference = split_condition(show_if)[0]
        if reference not in available:
            raise HTTPException(
                status_code=400,
                detail=f"Field '{label}' condition must reference an earlier field in the same scope",
            )

    if field.get("type") != "formula":
        return

    missing = sorted(formula_references(field.get("formula") or "") - available)
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Formula field '{label}' references unavailable field(s): {', '.join(missing)}",
        )


def definition_fields(definition_or_form):
    if isinstance(definition_or_form, WorkForm):
        return work_form_fields(definition_or_form)
    if isinstance(definition_or_form, dict) and isinstance(definition_or_form.get("fields"), list):
        return definition_or_form["fields"]
    return []


def validate_work_form_answers(definition_or_form, answers: dict):
    fields = definition_fields(definition_or_form)
    top_level_fields = [field for field in fields if not field.get("repeat")]
    repeat_children = {}
    normalized_answers = {}

    for field in fields:
        if field.get("repeat"):
            repeat_children.setdefault(field["repeat"], []).append(field)

    for field in top_level_fields:
        field_type = field.get("type")
        field_id = field.get("id")
        if field_type == "section":
            continue
        if not condition_is_met(field.get("show_if"), normalized_answers):
            normalized_answers[field_id] = [] if field_type == "repeat" else ""
            continue
        if field_type == "formula":
            normalized_answers[field_id] = evaluate_formula_expression(
                field.get("formula") or "0",
                normalized_answers,
            )
            continue
        if field_type == "repeat":
            normalized_answers[field_id] = validate_repeat_answer(
                field,
                repeat_children.get(field_id, []),
                answers.get(field_id),
                normalized_answers,
            )
            continue
        normalized_answers[field_id] = normalize_work_form_answer(field, answers.get(field_id))

    return normalized_answers


def validate_repeat_answer(parent_field: dict, child_fields: list[dict], raw_value, parent_answers: dict):
    field_label = parent_field.get("label") or parent_field.get("id")
    min_rows = int(parent_field.get("min_rows") or 0)
    max_rows = int(parent_field.get("max_rows") or 12)

    if raw_value in (None, ""):
        rows = []
    elif isinstance(raw_value, list):
        rows = raw_value
    else:
        raise HTTPException(status_code=400, detail=f"{field_label} must be a list of rows")

    if len(rows) < min_rows:
        raise HTTPException(status_code=400, detail=f"{field_label} needs at least {min_rows} row(s)")
    if len(rows) > max_rows:
        raise HTTPException(status_code=400, detail=f"{field_label} can include up to {max_rows} row(s)")

    normalized_rows = []
    for index, raw_row in enumerate(rows, start=1):
        if not isinstance(raw_row, dict):
            raise HTTPException(status_code=400, detail=f"{field_label} row {index} is invalid")
        row_answers = {}
        for child in child_fields:
            child_type = child.get("type")
            if child_type == "section":
                continue
            scope = {**parent_answers, **row_answers}
            if not condition_is_met(child.get("show_if"), scope):
                row_answers[child["id"]] = ""
                continue
            if child_type == "formula":
                row_answers[child["id"]] = evaluate_formula_expression(
                    child.get("formula") or "0",
                    scope,
                )
                continue
            row_answers[child["id"]] = normalize_work_form_answer(child, raw_row.get(child["id"]))

        normalized_rows.append(row_answers)

    return normalized_rows


def normalize_work_form_answer(field: dict, raw_value):
    field_id = field.get("id")
    field_label = field.get("label") or field_id
    field_type = field.get("type")
    required = bool(field.get("required"))

    if field_type == "checkbox":
        value = bool(raw_value)
    elif field_type == "time_range":
        value = normalize_time_range_answer(field_label, raw_value, required)
    elif raw_value is None:
        value = ""
    else:
        value = str(raw_value).strip()

    if required and (value == "" or value is False):
        raise HTTPException(status_code=400, detail=f"{field_label} is required")

    if field_type == "signature" and value:
        validate_photo_url(value)

    if field_type == "number" and value != "":
        try:
            value = float(value)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"{field_label} must be a number")
        if not math.isfinite(value):
            raise HTTPException(status_code=400, detail=f"{field_label} must be a finite number")

    if field_type == "select" and value:
        options = field.get("options") or []
        if value not in options:
            raise HTTPException(status_code=400, detail=f"{field_label} has an invalid option")

    return value


def normalize_time_range_answer(field_label: str, raw_value, required: bool):
    if raw_value in (None, ""):
        if required:
            raise HTTPException(status_code=400, detail=f"{field_label} is required")
        return {}

    if not isinstance(raw_value, dict):
        raise HTTPException(status_code=400, detail=f"{field_label} must include start and end times")

    start = str(raw_value.get("start") or "").strip()
    end = str(raw_value.get("end") or "").strip()

    if required and (not start or not end):
        raise HTTPException(status_code=400, detail=f"{field_label} needs both start and end times")
    if bool(start) != bool(end):
        raise HTTPException(status_code=400, detail=f"{field_label} needs both start and end times")
    if not start and not end:
        return {}

    start_minutes = validate_time_value(field_label, "start", start)
    end_minutes = validate_time_value(field_label, "end", end)
    duration_minutes = end_minutes - start_minutes
    if duration_minutes < 0:
        duration_minutes += 24 * 60

    return {
        "start": start,
        "end": end,
        "duration_hours": round(duration_minutes / 60, 2),
    }


def validate_time_value(field_label: str, part: str, value: str):
    if not re.fullmatch(r"\d{2}:\d{2}", value):
        raise HTTPException(status_code=400, detail=f"{field_label} {part} time is invalid")

    try:
        hours, minutes = value.split(":", 1)
        hours_int = int(hours)
        minutes_int = int(minutes)
    except (ValueError, AttributeError):
        raise HTTPException(status_code=400, detail=f"{field_label} {part} time is invalid")

    if not 0 <= hours_int <= 23 or not 0 <= minutes_int <= 59:
        raise HTTPException(status_code=400, detail=f"{field_label} {part} time is invalid")

    return hours_int * 60 + minutes_int


def normalize_work_form_photo_urls(photo_urls: list[str]):
    if len(photo_urls) > MAX_WORK_FORM_PHOTOS:
        raise HTTPException(
            status_code=400,
            detail=f"Form submissions can include up to {MAX_WORK_FORM_PHOTOS} photos"
        )

    urls = [url for url in photo_urls if url]
    for url in urls:
        validate_photo_url(url)
    return urls


def normalize_work_form_photo_metadata(photo_urls: list[str], photo_metadata: list[dict]):
    metadata = []
    metadata_by_url = {
        item.get("url"): item
        for item in (photo_metadata or [])
        if isinstance(item, dict) and item.get("url")
    }

    for index, url in enumerate(photo_urls):
        raw = metadata_by_url.get(url)
        if raw is None and index < len(photo_metadata or []):
            item = photo_metadata[index]
            raw = item if isinstance(item, dict) else {}
        raw = raw or {}

        metadata.append({
            "url": url,
            "name": str(raw.get("name") or "")[:180],
            "taken_at": str(raw.get("taken_at") or "")[:80],
            "taken_at_source": str(raw.get("taken_at_source") or "")[:80],
            "last_modified": raw.get("last_modified") if isinstance(raw.get("last_modified"), (int, float)) else None,
            "last_modified_iso": str(raw.get("last_modified_iso") or "")[:80],
            "size": raw.get("size") if isinstance(raw.get("size"), int) else None,
            "type": str(raw.get("type") or "")[:120],
        })

    return metadata


def normalize_site_input(data):
    name = data.name.strip()
    address = data.address.strip() if data.address else None

    if not name:
        raise HTTPException(status_code=400, detail="Site name is required")

    return {
        "name": name,
        "address": address,
        "latitude": round(data.latitude, 6),
        "longitude": round(data.longitude, 6),
        "allowed_radius_m": data.allowed_radius_m,
    }


def validate_review_status(status: str):
    normalized_status = status.strip().lower()

    if normalized_status not in VALID_REVIEW_STATUSES:
        raise HTTPException(
            status_code=400,
            detail="status must be pending, approved, or rejected"
        )

    return normalized_status


def validate_approval_decision(status: str):
    normalized_status = status.strip().lower()

    if normalized_status not in {"approved", "rejected"}:
        raise HTTPException(
            status_code=400,
            detail="status must be approved or rejected"
        )

    return normalized_status


def normalize_approval_record_type(record_type: str):
    normalized_type = record_type.strip().lower()

    if normalized_type not in VALID_APPROVAL_RECORD_TYPES:
        raise HTTPException(
            status_code=400,
            detail="record_type must be attendance, task, form, or team_log"
        )

    return normalized_type


def select_attendance_records(status: Optional[str] = None, user: User | None = None):
    statement = select(AttendanceRecord).where(AttendanceRecord.deleted_at.is_(None))

    if status:
        status = validate_review_status(status)
        statement = statement.where(AttendanceRecord.status == status)
    if user:
        statement = scope_statement_to_user_department(statement, AttendanceRecord, user)

    return statement.order_by(AttendanceRecord.created_at.desc())


def select_task_logs(status: Optional[str] = None, user: User | None = None):
    statement = select(TaskLog).where(TaskLog.deleted_at.is_(None))

    if status:
        status = validate_review_status(status)
        statement = statement.where(TaskLog.status == status)
    if user:
        statement = scope_statement_to_user_department(statement, TaskLog, user)

    return statement.order_by(TaskLog.created_at.desc())


def select_work_form_submissions(status: Optional[str] = None, user: User | None = None):
    statement = select(WorkFormSubmission).where(WorkFormSubmission.deleted_at.is_(None))

    if status:
        status = validate_review_status(status)
        statement = statement.where(WorkFormSubmission.status == status)
    if user:
        statement = scope_statement_to_user_department(statement, WorkFormSubmission, user)

    return statement.order_by(WorkFormSubmission.created_at.desc())


def select_team_work_logs(status: Optional[str] = None, user: User | None = None):
    statement = select(TeamWorkLog).where(TeamWorkLog.deleted_at.is_(None))

    if status:
        status = validate_review_status(status)
        statement = statement.where(TeamWorkLog.status == status)
    if user:
        statement = scope_statement_to_user_department(statement, TeamWorkLog, user)

    return statement.order_by(TeamWorkLog.created_at.desc())
