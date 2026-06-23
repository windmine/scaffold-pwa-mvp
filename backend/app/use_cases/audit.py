import json
from typing import Optional

from sqlmodel import Session, select

from app.models import (
    AttendanceRecord,
    AuditEvent,
    Department,
    Site,
    TaskLog,
    TeamWorkLog,
    User,
    WorkForm,
    WorkFormSubmission,
)
from app.use_cases.common import format_datetime, parse_json_list, parse_json_object


SNAPSHOT_FIELDS = {
    User: [
        "id",
        "department_id",
        "dashboard_department_id",
        "email",
        "name",
        "role",
        "worker_class",
        "status",
        "is_global_admin",
    ],
    Department: ["id", "name", "status", "created_at"],
    Site: ["id", "department_id", "name", "address", "latitude", "longitude", "allowed_radius_m"],
    AttendanceRecord: [
        "id",
        "department_id",
        "worker_id",
        "site_id",
        "record_type",
        "latitude",
        "longitude",
        "accuracy",
        "distance_from_site_m",
        "within_site_radius",
        "note",
        "photo_url",
        "client_submission_id",
        "entry_source",
        "created_by_supervisor_id",
        "deleted_at",
        "deleted_by_supervisor_id",
        "deletion_reason",
        "status",
        "created_at",
    ],
    TaskLog: [
        "id",
        "department_id",
        "worker_id",
        "site_id",
        "description",
        "work_date",
        "hours_worked",
        "safety_notes",
        "photo_url",
        "photo_urls",
        "client_submission_id",
        "entry_source",
        "created_by_supervisor_id",
        "deleted_at",
        "deleted_by_supervisor_id",
        "deletion_reason",
        "status",
        "created_at",
    ],
    WorkForm: ["id", "department_id", "name", "description", "fields_json", "status", "created_by", "created_at"],
    WorkFormSubmission: [
        "id",
        "department_id",
        "form_id",
        "worker_id",
        "site_id",
        "work_date",
        "answers_json",
        "photo_urls",
        "photo_metadata",
        "client_submission_id",
        "status",
        "created_at",
    ],
    TeamWorkLog: [
        "id",
        "department_id",
        "leader_id",
        "week_start",
        "notes",
        "client_submission_id",
        "status",
        "created_at",
    ],
}


def model_snapshot(model):
    fields = SNAPSHOT_FIELDS.get(type(model), [])
    data = {}

    for field in fields:
        value = getattr(model, field)
        if field in {"created_at", "deleted_at"} and value is not None:
            value = format_datetime(value)
        elif field == "fields_json":
            data["fields"] = parse_json_list(value)
            continue
        elif field == "answers_json":
            data["answers"] = parse_json_object(value)
            continue
        elif field == "photo_urls":
            data["photo_urls"] = parse_json_list(value)
            continue
        elif field == "photo_metadata":
            data["photo_metadata"] = parse_json_list(value)
            continue

        data[field] = value

    return data


def json_or_none(value: Optional[dict]):
    if value is None:
        return None

    return json.dumps(value, sort_keys=True, default=str)


def add_audit_event(
    session: Session,
    actor: User,
    action: str,
    entity_type: str,
    entity_id: Optional[int],
    before: Optional[dict] = None,
    after: Optional[dict] = None,
    summary: Optional[str] = None,
    department_id: Optional[int] = None,
):
    event = AuditEvent(
        department_id=department_id if department_id is not None else actor.department_id,
        actor_id=actor.id,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        summary=summary,
        before_json=json_or_none(before),
        after_json=json_or_none(after),
    )
    session.add(event)
    return event


def audit_event_response(event: AuditEvent, session: Session):
    actor = session.get(User, event.actor_id)
    department = session.get(Department, event.department_id) if event.department_id else None
    actor_department = (
        session.get(Department, actor.department_id)
        if actor and actor.department_id
        else None
    )
    actor_role = actor.role if actor else None
    actor_is_global_admin = bool(actor.is_global_admin) if actor else False
    if actor_is_global_admin:
        actor_access_level = "Global admin"
    elif actor_role == "supervisor":
        actor_access_level = "Department supervisor"
    elif actor_role == "worker" and (actor.worker_class or "normal") == "leader":
        actor_access_level = "Leader"
    elif actor_role:
        actor_access_level = actor_role.replace("_", " ").title()
    else:
        actor_access_level = "Unknown"

    return {
        "id": event.id,
        "department_id": event.department_id,
        "department_name": department.name if department else None,
        "actor_id": event.actor_id,
        "actor_name": actor.name if actor else f"User {event.actor_id}",
        "actor_email": actor.email if actor else None,
        "actor_department_id": actor.department_id if actor else None,
        "actor_department_name": actor_department.name if actor_department else None,
        "actor_role": actor_role,
        "actor_is_global_admin": actor_is_global_admin,
        "actor_access_level": actor_access_level,
        "action": event.action,
        "entity_type": event.entity_type,
        "entity_id": event.entity_id,
        "summary": event.summary,
        "before": parse_json_object(event.before_json),
        "after": parse_json_object(event.after_json),
        "created_at": format_datetime(event.created_at),
    }


def list_audit_events(
    session: Session,
    supervisor: User,
    limit: int = 100,
    entity_type: Optional[str] = None,
    actor_id: Optional[int] = None,
):
    limit = max(1, min(limit, 200))
    statement = select(AuditEvent)

    if entity_type:
        statement = statement.where(AuditEvent.entity_type == entity_type.strip().lower())
    if actor_id:
        statement = statement.where(AuditEvent.actor_id == actor_id)
    if not supervisor.is_global_admin:
        statement = statement.where(AuditEvent.department_id == supervisor.department_id)

    events = session.exec(
        statement.order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc()).limit(limit)
    ).all()

    return [
        audit_event_response(event, session)
        for event in events
    ]
