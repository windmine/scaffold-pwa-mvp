import json
import math
from datetime import timezone
from typing import Optional

from fastapi import HTTPException
from sqlmodel import Session, select

from app.models import AttendanceRecord, Site, TaskLog, User, WorkForm, WorkFormSubmission


VALID_ROLES = {"worker", "supervisor"}
VALID_USER_STATUSES = {"active", "resigned"}
VALID_REVIEW_STATUSES = {"pending", "approved", "rejected"}
VALID_APPROVAL_RECORD_TYPES = {"attendance", "task", "form"}
MAX_TASK_LOG_PHOTOS = 8
VALID_WORK_FORM_STATUSES = {"active", "archived"}
VALID_WORK_FORM_FIELD_TYPES = {"text", "textarea", "number", "date", "select", "checkbox", "signature"}
MAX_WORK_FORM_FIELDS = 30
MAX_WORK_FORM_PHOTOS = 8


def format_datetime(value):
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)

    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def attendance_record_response(record: AttendanceRecord, session: Session):
    worker = session.get(User, record.worker_id)
    site = session.get(Site, record.site_id) if record.site_id else None

    return {
        "id": record.id,
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
    photo_urls = task_log_photo_urls(log)

    return {
        "id": log.id,
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
        "status": log.status or "pending",
        "created_at": format_datetime(log.created_at),
    }


def task_template_response(template, session: Session):
    site = session.get(Site, template.site_id) if template.site_id else None

    return {
        "id": template.id,
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


def work_form_response(form: WorkForm):
    return {
        "id": form.id,
        "name": form.name,
        "description": form.description,
        "fields": work_form_fields(form),
        "status": form.status,
        "created_by": form.created_by,
        "created_at": format_datetime(form.created_at),
    }


def work_form_submission_response(submission: WorkFormSubmission, session: Session):
    form = session.get(WorkForm, submission.form_id)
    worker = session.get(User, submission.worker_id)
    site = session.get(Site, submission.site_id) if submission.site_id else None

    return {
        "id": submission.id,
        "form_id": submission.form_id,
        "form_name": form.name if form else f"Form {submission.form_id}",
        "fields": work_form_fields(form) if form else [],
        "worker_id": submission.worker_id,
        "worker_name": worker.name if worker else f"Worker {submission.worker_id}",
        "site_id": submission.site_id,
        "site_name": site.name if site else None,
        "work_date": submission.work_date,
        "answers": parse_json_object(submission.answers_json),
        "photo_urls": parse_json_list(submission.photo_urls),
        "status": submission.status or "pending",
        "created_at": format_datetime(submission.created_at),
    }


def review_record_response(record_kind: str, record, session: Session):
    if record_kind == "attendance":
        item = attendance_record_response(record, session)
    elif record_kind == "task":
        item = task_log_response(record, session)
    elif record_kind == "form":
        item = work_form_submission_response(record, session)
    else:
        raise HTTPException(status_code=400, detail="record type is not reviewable")

    item["kind"] = record_kind
    item["review_key"] = f"{record_kind}:{item['id']}"
    return item


def site_response(site: Site):
    return {
        "id": site.id,
        "name": site.name,
        "address": site.address,
        "latitude": site.latitude,
        "longitude": site.longitude,
        "allowed_radius_m": site.allowed_radius_m,
    }


def upload_url(filename: str):
    return f"/uploads/{filename}"


def user_response(user: User):
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "role": user.role,
        "status": user.status or "active",
    }


def require_worker(user: User):
    if user.role != "worker":
        raise HTTPException(status_code=403, detail="Worker only")


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


def require_confirmed(confirmed: bool):
    if not confirmed:
        raise HTTPException(status_code=400, detail="Double check required before saving this change")


def ensure_site_exists(session: Session, site_id: Optional[int]):
    if site_id is None:
        return None

    site = session.get(Site, site_id)

    if not site:
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


def site_distance_check(site: Optional[Site], latitude: float, longitude: float):
    if site is None:
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


def normalize_work_form_fields(fields):
    normalized_fields = []
    seen_ids = set()

    if len(fields) > MAX_WORK_FORM_FIELDS:
        raise HTTPException(status_code=400, detail=f"Forms can include up to {MAX_WORK_FORM_FIELDS} fields")

    for field in fields:
        field_id = field.id.strip().lower().replace(" ", "_")
        label = field.label.strip()
        field_type = field.type.strip().lower()

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

        normalized_fields.append({
            "id": field_id,
            "label": label,
            "type": field_type,
            "required": field.required,
            "options": options,
        })
        seen_ids.add(field_id)

    return normalized_fields


def validate_work_form_answers(form: WorkForm, answers: dict):
    fields = work_form_fields(form)
    normalized_answers = {}

    for field in fields:
        field_id = field.get("id")
        field_label = field.get("label") or field_id
        field_type = field.get("type")
        required = bool(field.get("required"))
        raw_value = answers.get(field_id)

        if field_type == "checkbox":
            value = bool(raw_value)
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

        if field_type == "select" and value:
            options = field.get("options") or []
            if value not in options:
                raise HTTPException(status_code=400, detail=f"{field_label} has an invalid option")

        normalized_answers[field_id] = value

    return normalized_answers


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


def normalize_site_input(data):
    name = data.name.strip()
    address = data.address.strip() if data.address else None

    if not name:
        raise HTTPException(status_code=400, detail="Site name is required")

    return {
        "name": name,
        "address": address,
        "latitude": data.latitude,
        "longitude": data.longitude,
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
            detail="record_type must be attendance, task, or form"
        )

    return normalized_type


def select_attendance_records(status: Optional[str] = None):
    statement = select(AttendanceRecord)

    if status:
        status = validate_review_status(status)
        statement = statement.where(AttendanceRecord.status == status)

    return statement.order_by(AttendanceRecord.created_at.desc())


def select_task_logs(status: Optional[str] = None):
    statement = select(TaskLog)

    if status:
        status = validate_review_status(status)
        statement = statement.where(TaskLog.status == status)

    return statement.order_by(TaskLog.created_at.desc())


def select_work_form_submissions(status: Optional[str] = None):
    statement = select(WorkFormSubmission)

    if status:
        status = validate_review_status(status)
        statement = statement.where(WorkFormSubmission.status == status)

    return statement.order_by(WorkFormSubmission.created_at.desc())
