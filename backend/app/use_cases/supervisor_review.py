import csv
import json
from io import StringIO
from typing import Optional

from fastapi import HTTPException
from fastapi.responses import Response
from sqlmodel import Session, select

from app.models import AttendanceRecord, TaskLog, User, WorkFormSubmission
from app.use_cases.audit import add_audit_event, model_snapshot
from app.use_cases.common import (
    attendance_record_response,
    ensure_site_exists,
    normalize_approval_record_type,
    normalize_task_photo_urls,
    require_confirmed,
    review_record_response,
    select_attendance_records,
    select_task_logs,
    select_work_form_submissions,
    site_distance_check,
    task_log_response,
    validate_approval_decision,
    validate_photo_url,
    validate_review_status,
)


def list_review_records(session: Session, status: Optional[str] = None):
    rows = []
    rows.extend(
        ("attendance", record)
        for record in session.exec(select_attendance_records(status)).all()
    )
    rows.extend(
        ("task", record)
        for record in session.exec(select_task_logs(status)).all()
    )
    rows.extend(
        ("form", record)
        for record in session.exec(select_work_form_submissions(status)).all()
    )
    rows.sort(key=lambda row: row[1].created_at, reverse=True)

    return [
        review_record_response(record_kind, record, session)
        for record_kind, record in rows
    ]


def list_pending_attendance_records(session: Session):
    records = session.exec(
        select(AttendanceRecord)
        .where(AttendanceRecord.status == "pending")
        .order_by(AttendanceRecord.created_at.desc())
    ).all()

    return [
        attendance_record_response(record, session)
        for record in records
    ]


def list_supervisor_attendance_records(session: Session, status: Optional[str] = None):
    records = session.exec(
        select_attendance_records(status)
    ).all()

    return [
        attendance_record_response(record, session)
        for record in records
    ]


def update_supervisor_attendance_record(record_id: int, data, supervisor: User, session: Session):
    require_confirmed(data.confirmed)
    record = session.get(AttendanceRecord, record_id)

    if not record:
        raise HTTPException(status_code=404, detail="Record not found")

    fields = data.model_fields_set
    before = model_snapshot(record)

    if "record_type" in fields and data.record_type is not None:
        if data.record_type not in ["check_in", "check_out"]:
            raise HTTPException(status_code=400, detail="record_type must be check_in or check_out")
        record.record_type = data.record_type
    if "site_id" in fields:
        ensure_site_exists(session, data.site_id)
        record.site_id = data.site_id
    if "latitude" in fields and data.latitude is not None:
        record.latitude = data.latitude
    if "longitude" in fields and data.longitude is not None:
        record.longitude = data.longitude
    if "accuracy" in fields:
        record.accuracy = data.accuracy
    if "note" in fields:
        record.note = data.note
    if "photo_url" in fields:
        validate_photo_url(data.photo_url)
        record.photo_url = data.photo_url
    if "status" in fields and data.status is not None:
        record.status = validate_review_status(data.status)

    site = ensure_site_exists(session, record.site_id)
    record.distance_from_site_m, record.within_site_radius = site_distance_check(
        site,
        record.latitude,
        record.longitude
    )

    session.add(record)
    add_audit_event(
        session=session,
        actor=supervisor,
        action="attendance_update",
        entity_type="attendance",
        entity_id=record.id,
        before=before,
        after=model_snapshot(record),
        summary=f"Updated attendance record #{record.id}",
    )
    session.commit()
    session.refresh(record)

    return attendance_record_response(record, session)


def export_attendance_records_csv(session: Session, status: Optional[str] = None):
    records = session.exec(
        select_attendance_records(status)
    ).all()
    output = StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "id",
        "worker_id",
        "worker_name",
        "site_id",
        "site_name",
        "record_type",
        "status",
        "created_at",
        "latitude",
        "longitude",
        "accuracy",
        "distance_from_site_m",
        "within_site_radius",
        "note",
        "photo_url",
    ])

    for record in records:
        item = attendance_record_response(record, session)
        writer.writerow([
            item["id"],
            item["worker_id"],
            item["worker_name"],
            item["site_id"],
            item["site_name"],
            item["record_type"],
            item["status"],
            item["created_at"],
            item["latitude"],
            item["longitude"],
            item["accuracy"],
            item["distance_from_site_m"],
            item["within_site_radius"],
            item["note"],
            item["photo_url"],
        ])

    filename = "attendance-records.csv" if not status else f"attendance-records-{status}.csv"

    return Response(
        output.getvalue(),
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"'
        }
    )


def list_supervisor_task_logs(session: Session, status: Optional[str] = None):
    records = session.exec(
        select_task_logs(status)
    ).all()

    return [
        task_log_response(record, session)
        for record in records
    ]


def export_task_logs_csv(session: Session, status: Optional[str] = None):
    records = session.exec(
        select_task_logs(status)
    ).all()
    output = StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "id",
        "worker_id",
        "worker_name",
        "site_id",
        "site_name",
        "work_date",
        "hours_worked",
        "description",
        "safety_notes",
        "photo_urls",
        "status",
        "created_at",
    ])

    for record in records:
        item = task_log_response(record, session)
        writer.writerow([
            item["id"],
            item["worker_id"],
            item["worker_name"],
            item["site_id"],
            item["site_name"],
            item["work_date"],
            item["hours_worked"],
            item["description"],
            item["safety_notes"],
            "; ".join(item["photo_urls"]),
            item["status"],
            item["created_at"],
        ])

    filename = "task-logs.csv" if not status else f"task-logs-{status}.csv"

    return Response(
        output.getvalue(),
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"'
        }
    )


def update_supervisor_task_log(log_id: int, data, supervisor: User, session: Session):
    require_confirmed(data.confirmed)
    log = session.get(TaskLog, log_id)

    if not log:
        raise HTTPException(status_code=404, detail="Task log not found")

    fields = data.model_fields_set
    before = model_snapshot(log)
    if "description" in fields and data.description is not None:
        log.description = data.description
    if "site_id" in fields:
        ensure_site_exists(session, data.site_id)
        log.site_id = data.site_id
    if "work_date" in fields:
        log.work_date = data.work_date
    if "hours_worked" in fields:
        log.hours_worked = data.hours_worked
    if "safety_notes" in fields:
        log.safety_notes = data.safety_notes
    if "photo_urls" in fields:
        photo_urls = normalize_task_photo_urls(None, data.photo_urls or [])
        log.photo_url = photo_urls[0] if photo_urls else None
        log.photo_urls = json.dumps(photo_urls) if photo_urls else None
    elif "photo_url" in fields:
        validate_photo_url(data.photo_url)
        log.photo_url = data.photo_url
        log.photo_urls = json.dumps([data.photo_url]) if data.photo_url else None
    if "status" in fields and data.status is not None:
        log.status = validate_review_status(data.status)

    session.add(log)
    add_audit_event(
        session=session,
        actor=supervisor,
        action="task_log_update",
        entity_type="task_log",
        entity_id=log.id,
        before=before,
        after=model_snapshot(log),
        summary=f"Updated task log #{log.id}",
    )
    session.commit()
    session.refresh(log)

    return task_log_response(log, session)


def apply_review_decision(
    record_type: str,
    record_id: int,
    status: str,
    supervisor: User,
    session: Session
):
    status = validate_approval_decision(status)
    record_type = normalize_approval_record_type(record_type)

    if record_type == "attendance":
        record = session.get(AttendanceRecord, record_id)

        if not record:
            raise HTTPException(status_code=404, detail="Record not found")
    elif record_type == "task":
        record = session.get(TaskLog, record_id)

        if not record:
            raise HTTPException(status_code=404, detail="Task log not found")
    else:
        record = session.get(WorkFormSubmission, record_id)

        if not record:
            raise HTTPException(status_code=404, detail="Form submission not found")

    before = model_snapshot(record)
    record.status = status
    session.add(record)
    add_audit_event(
        session=session,
        actor=supervisor,
        action="review_decision",
        entity_type=record_type,
        entity_id=record.id,
        before=before,
        after=model_snapshot(record),
        summary=f"{status.capitalize()} {record_type} record #{record.id}",
    )
    session.commit()
    session.refresh(record)

    return review_record_response(record_type, record, session)
