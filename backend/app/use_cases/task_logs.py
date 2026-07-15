import json
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.models import TaskLog, TaskTemplate, User
from app.use_cases.common import (
    department_id_for_new_record,
    ensure_site_exists,
    normalize_client_submission_id,
    normalize_task_photo_urls,
    require_leader,
    require_worker,
    task_log_response,
    task_template_response,
    validate_owned_upload_references,
)


def create_task_log(data, user: User, session: Session):
    require_leader(user)
    ensure_site_exists(session, data.site_id, user)
    photo_urls = normalize_task_photo_urls(data.photo_url, data.photo_urls)
    client_submission_id = normalize_client_submission_id(data.client_submission_id)
    if client_submission_id:
        existing_log = session.exec(
            select(TaskLog).where(
                TaskLog.worker_id == user.id,
                TaskLog.client_submission_id == client_submission_id
            )
        ).first()
        if existing_log:
            return task_log_response(existing_log, session)

    validate_owned_upload_references(photo_urls, user, session)

    rapid_duplicate = session.exec(
        select(TaskLog)
        .where(
            TaskLog.worker_id == user.id,
            TaskLog.site_id == data.site_id,
            TaskLog.description == data.description,
            TaskLog.work_date == data.work_date,
            TaskLog.hours_worked == data.hours_worked,
            TaskLog.safety_notes == data.safety_notes,
            TaskLog.photo_urls == (json.dumps(photo_urls) if photo_urls else None),
            TaskLog.deleted_at.is_(None),
            TaskLog.created_at >= datetime.now(timezone.utc) - timedelta(seconds=10),
        )
        .order_by(TaskLog.created_at.desc())
    ).first()
    if rapid_duplicate:
        return task_log_response(rapid_duplicate, session)

    log = TaskLog(
        department_id=department_id_for_new_record(user, session),
        worker_id=user.id,
        site_id=data.site_id,
        description=data.description,
        work_date=data.work_date,
        hours_worked=data.hours_worked,
        safety_notes=data.safety_notes,
        photo_url=photo_urls[0] if photo_urls else None,
        photo_urls=json.dumps(photo_urls) if photo_urls else None,
        client_submission_id=client_submission_id,
        status="pending"
    )

    session.add(log)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        if client_submission_id:
            existing_log = session.exec(
                select(TaskLog).where(
                    TaskLog.worker_id == user.id,
                    TaskLog.client_submission_id == client_submission_id
                )
            ).first()
            if existing_log:
                return task_log_response(existing_log, session)
        raise
    session.refresh(log)

    return task_log_response(log, session)


def update_my_task_log(log_id: int, user: User, session: Session):
    require_worker(user)
    log = session.get(TaskLog, log_id)

    if not log or log.worker_id != user.id or log.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Task log not found")

    raise HTTPException(status_code=403, detail="Submitted task logs cannot be edited by workers")


def delete_my_task_log(log_id: int, user: User, session: Session):
    require_worker(user)
    log = session.get(TaskLog, log_id)

    if not log or log.worker_id != user.id or log.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Task log not found")

    raise HTTPException(status_code=403, detail="Submitted task logs cannot be deleted by workers")


def list_my_task_logs(user: User, session: Session):
    records = session.exec(
        select(TaskLog)
        .where(
            TaskLog.worker_id == user.id,
            TaskLog.deleted_at.is_(None),
        )
        .order_by(TaskLog.created_at.desc())
    ).all()

    return [
        task_log_response(record, session)
        for record in records
    ]


def list_task_templates(user: User, session: Session):
    require_leader(user)
    templates = session.exec(
        select(TaskTemplate)
        .where(TaskTemplate.worker_id == user.id)
        .order_by(TaskTemplate.name)
    ).all()

    return [
        task_template_response(template, session)
        for template in templates
    ]


def create_task_template(data, user: User, session: Session):
    require_leader(user)
    ensure_site_exists(session, data.site_id, user)
    template = TaskTemplate(
        department_id=department_id_for_new_record(user, session),
        worker_id=user.id,
        site_id=data.site_id,
        name=data.name.strip(),
        description=data.description,
        hours_worked=data.hours_worked,
        safety_notes=data.safety_notes
    )
    session.add(template)
    session.commit()
    session.refresh(template)

    return task_template_response(template, session)


def update_task_template(template_id: int, data, user: User, session: Session):
    require_leader(user)
    template = session.get(TaskTemplate, template_id)
    if not template or template.worker_id != user.id:
        raise HTTPException(status_code=404, detail="Task template not found")

    fields = data.model_fields_set
    if "name" in fields and data.name is not None:
        template.name = data.name.strip()
    if "description" in fields and data.description is not None:
        template.description = data.description
    if "site_id" in fields:
        ensure_site_exists(session, data.site_id, user)
        template.site_id = data.site_id
    if "hours_worked" in fields:
        template.hours_worked = data.hours_worked
    if "safety_notes" in fields:
        template.safety_notes = data.safety_notes

    session.add(template)
    session.commit()
    session.refresh(template)

    return task_template_response(template, session)


def delete_task_template(template_id: int, user: User, session: Session):
    require_leader(user)
    template = session.get(TaskTemplate, template_id)
    if not template or template.worker_id != user.id:
        raise HTTPException(status_code=404, detail="Task template not found")

    session.delete(template)
    session.commit()

    return {"message": "Task template deleted"}
