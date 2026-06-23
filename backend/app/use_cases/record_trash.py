import asyncio
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import delete
from sqlmodel import Session, select

from app.database import engine
from app.models import AttendanceRecord, TaskLog, User
from app.use_cases.audit import add_audit_event, model_snapshot
from app.use_cases.common import (
    attendance_record_response,
    can_access_department,
    format_datetime,
    require_confirmed,
    scope_statement_to_user_department,
    task_log_response,
)


TRASH_RETENTION_DAYS = 30
TRASH_PURGE_INTERVAL_SECONDS = 60 * 60
TRASH_MODELS = {
    "attendance": AttendanceRecord,
    "task": TaskLog,
}


def purge_expired_deleted_records(session: Session, now: datetime | None = None):
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=TRASH_RETENTION_DAYS)
    deleted_counts = {}

    for record_type, model in TRASH_MODELS.items():
        result = session.exec(
            delete(model).where(
                model.deleted_at.is_not(None),
                model.deleted_at <= cutoff,
            ).execution_options(synchronize_session=False)
        )
        deleted_counts[record_type] = result.rowcount or 0

    session.commit()
    return deleted_counts


def purge_expired_deleted_records_with_new_session():
    with Session(engine) as session:
        return purge_expired_deleted_records(session)


async def run_periodic_trash_purge():
    while True:
        await asyncio.sleep(TRASH_PURGE_INTERVAL_SECONDS)
        purge_expired_deleted_records_with_new_session()


def get_trash_model(record_type: str):
    normalized = record_type.strip().lower()
    model = TRASH_MODELS.get(normalized)
    if not model:
        raise HTTPException(status_code=400, detail="record_type must be attendance or task")
    return normalized, model


def trash_record_response(record_type: str, record, session: Session):
    item = (
        attendance_record_response(record, session)
        if record_type == "attendance"
        else task_log_response(record, session)
    )
    item["kind"] = record_type
    item["purge_at"] = format_datetime(
        record.deleted_at + timedelta(days=TRASH_RETENTION_DAYS)
    )
    return item


def list_trash(session: Session, supervisor: User):
    purge_expired_deleted_records(session)
    rows = []

    for record_type, model in TRASH_MODELS.items():
        statement = select(model).where(model.deleted_at.is_not(None))
        statement = scope_statement_to_user_department(statement, model, supervisor)
        rows.extend(
            (record_type, record)
            for record in session.exec(statement).all()
        )

    rows.sort(key=lambda row: row[1].deleted_at, reverse=True)
    return [
        trash_record_response(record_type, record, session)
        for record_type, record in rows
    ]


def move_record_to_trash(
    record_type: str,
    record_id: int,
    data,
    supervisor: User,
    session: Session,
):
    require_confirmed(data.confirmed)
    record_type, model = get_trash_model(record_type)
    record = session.get(model, record_id)

    if (
        not record
        or record.deleted_at is not None
        or not can_access_department(supervisor, record.department_id)
    ):
        raise HTTPException(status_code=404, detail="Record not found")

    reason = data.reason.strip()
    if len(reason) < 3:
        raise HTTPException(status_code=400, detail="A deletion reason is required")

    before = model_snapshot(record)
    record.deleted_at = datetime.now(timezone.utc)
    record.deleted_by_supervisor_id = supervisor.id
    record.deletion_reason = reason
    session.add(record)
    add_audit_event(
        session=session,
        actor=supervisor,
        action=f"{record_type}_trash",
        entity_type=record_type,
        entity_id=record.id,
        before=before,
        after=model_snapshot(record),
        summary=f"Moved {record_type} record #{record.id} to rubbish bin",
        department_id=record.department_id,
    )
    session.commit()
    session.refresh(record)
    return trash_record_response(record_type, record, session)


def restore_record(
    record_type: str,
    record_id: int,
    data,
    supervisor: User,
    session: Session,
):
    require_confirmed(data.confirmed)
    purge_expired_deleted_records(session)
    record_type, model = get_trash_model(record_type)
    record = session.get(model, record_id)

    if (
        not record
        or record.deleted_at is None
        or not can_access_department(supervisor, record.department_id)
    ):
        raise HTTPException(status_code=404, detail="Deleted record not found")

    before = model_snapshot(record)
    record.deleted_at = None
    record.deleted_by_supervisor_id = None
    record.deletion_reason = None
    session.add(record)
    add_audit_event(
        session=session,
        actor=supervisor,
        action=f"{record_type}_restore",
        entity_type=record_type,
        entity_id=record.id,
        before=before,
        after=model_snapshot(record),
        summary=f"Restored {record_type} record #{record.id}",
        department_id=record.department_id,
    )
    session.commit()
    session.refresh(record)
    return (
        attendance_record_response(record, session)
        if record_type == "attendance"
        else task_log_response(record, session)
    )
