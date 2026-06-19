from fastapi import HTTPException
from sqlmodel import Session, select

from app.models import AttendanceRecord, User
from app.use_cases.common import (
    attendance_record_response,
    department_id_for_new_record,
    ensure_site_exists,
    normalize_client_submission_id,
    require_worker,
    site_distance_check,
    validate_photo_url,
)


def create_attendance(data, user: User, session: Session):
    require_worker(user)

    if data.record_type not in ["check_in", "check_out"]:
        raise HTTPException(
            status_code=400,
            detail="record_type must be check_in or check_out"
        )

    site = ensure_site_exists(session, data.site_id, user)
    validate_photo_url(data.photo_url)
    client_submission_id = normalize_client_submission_id(data.client_submission_id)
    if client_submission_id:
        existing_record = session.exec(
            select(AttendanceRecord).where(
                AttendanceRecord.worker_id == user.id,
                AttendanceRecord.client_submission_id == client_submission_id
            )
        ).first()
        if existing_record:
            return attendance_record_response(existing_record, session)

    distance_from_site_m, within_site_radius = site_distance_check(
        site,
        data.latitude,
        data.longitude
    )

    record = AttendanceRecord(
        department_id=department_id_for_new_record(user, session),
        worker_id=user.id,
        site_id=data.site_id,
        record_type=data.record_type,
        latitude=data.latitude,
        longitude=data.longitude,
        accuracy=data.accuracy,
        distance_from_site_m=distance_from_site_m,
        within_site_radius=within_site_radius,
        note=data.note,
        photo_url=data.photo_url,
        client_submission_id=client_submission_id,
        status="approved" if within_site_radius is True else "pending"
    )

    session.add(record)
    session.commit()
    session.refresh(record)

    return attendance_record_response(record, session)


def update_my_attendance_record(record_id: int, data, user: User, session: Session):
    require_worker(user)
    record = session.get(AttendanceRecord, record_id)

    if not record or record.worker_id != user.id:
        raise HTTPException(status_code=404, detail="Record not found")
    if record.status != "pending":
        raise HTTPException(status_code=400, detail="Only pending attendance can be edited by the worker")

    fields = data.model_fields_set
    if "record_type" in fields and data.record_type is not None:
        if data.record_type not in ["check_in", "check_out"]:
            raise HTTPException(status_code=400, detail="record_type must be check_in or check_out")
        record.record_type = data.record_type
    if "site_id" in fields:
        ensure_site_exists(session, data.site_id, user)
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

    site = ensure_site_exists(session, record.site_id, user)
    record.distance_from_site_m, record.within_site_radius = site_distance_check(
        site,
        record.latitude,
        record.longitude
    )
    if record.within_site_radius is True:
        record.status = "approved"

    session.add(record)
    session.commit()
    session.refresh(record)

    return attendance_record_response(record, session)


def delete_my_attendance_record(record_id: int, user: User, session: Session):
    require_worker(user)
    record = session.get(AttendanceRecord, record_id)

    if not record or record.worker_id != user.id:
        raise HTTPException(status_code=404, detail="Record not found")
    if record.status != "pending":
        raise HTTPException(status_code=400, detail="Only pending attendance can be deleted by the worker")

    session.delete(record)
    session.commit()

    return {"message": "Attendance record deleted"}


def list_my_attendance_records(user: User, session: Session):
    records = session.exec(
        select(AttendanceRecord)
        .where(AttendanceRecord.worker_id == user.id)
        .order_by(AttendanceRecord.created_at.desc())
    ).all()

    return [
        attendance_record_response(record, session)
        for record in records
    ]
