import json

from fastapi import HTTPException
from sqlmodel import Session, select

from app.models import TaskLog, TaskTemplate, User
from app.use_cases.common import (
    ensure_site_exists,
    normalize_task_photo_urls,
    require_worker,
    task_log_response,
    task_template_response,
)


def create_task_log(data, user: User, session: Session):
    require_worker(user)
    ensure_site_exists(session, data.site_id)
    photo_urls = normalize_task_photo_urls(data.photo_url, data.photo_urls)

    log = TaskLog(
        worker_id=user.id,
        site_id=data.site_id,
        description=data.description,
        work_date=data.work_date,
        hours_worked=data.hours_worked,
        safety_notes=data.safety_notes,
        photo_url=photo_urls[0] if photo_urls else None,
        photo_urls=json.dumps(photo_urls) if photo_urls else None,
        status="pending"
    )

    session.add(log)
    session.commit()
    session.refresh(log)

    return task_log_response(log, session)


def update_my_task_log(log_id: int, user: User, session: Session):
    require_worker(user)
    log = session.get(TaskLog, log_id)

    if not log or log.worker_id != user.id:
        raise HTTPException(status_code=404, detail="Task log not found")

    raise HTTPException(status_code=403, detail="Submitted task logs cannot be edited by workers")


def delete_my_task_log(log_id: int, user: User, session: Session):
    require_worker(user)
    log = session.get(TaskLog, log_id)

    if not log or log.worker_id != user.id:
        raise HTTPException(status_code=404, detail="Task log not found")

    raise HTTPException(status_code=403, detail="Submitted task logs cannot be deleted by workers")


def list_my_task_logs(user: User, session: Session):
    records = session.exec(
        select(TaskLog)
        .where(TaskLog.worker_id == user.id)
        .order_by(TaskLog.created_at.desc())
    ).all()

    return [
        task_log_response(record, session)
        for record in records
    ]


def list_task_templates(user: User, session: Session):
    require_worker(user)
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
    require_worker(user)
    ensure_site_exists(session, data.site_id)
    template = TaskTemplate(
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
    require_worker(user)
    template = session.get(TaskTemplate, template_id)
    if not template or template.worker_id != user.id:
        raise HTTPException(status_code=404, detail="Task template not found")

    fields = data.model_fields_set
    if "name" in fields and data.name is not None:
        template.name = data.name.strip()
    if "description" in fields and data.description is not None:
        template.description = data.description
    if "site_id" in fields:
        ensure_site_exists(session, data.site_id)
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
    require_worker(user)
    template = session.get(TaskTemplate, template_id)
    if not template or template.worker_id != user.id:
        raise HTTPException(status_code=404, detail="Task template not found")

    session.delete(template)
    session.commit()

    return {"message": "Task template deleted"}
