import json

from fastapi import HTTPException
from sqlmodel import Session, select

from app.models import User, WorkForm, WorkFormSubmission
from app.use_cases.audit import add_audit_event, model_snapshot
from app.use_cases.common import (
    VALID_WORK_FORM_STATUSES,
    ensure_site_exists,
    normalize_client_submission_id,
    normalize_work_form_fields,
    normalize_work_form_photo_urls,
    require_confirmed,
    require_worker,
    select_work_form_submissions,
    validate_work_form_answers,
    work_form_response,
    work_form_submission_response,
)


def list_work_forms(user: User, session: Session):
    statement = select(WorkForm).order_by(WorkForm.name)
    if user.role == "worker":
        statement = statement.where(WorkForm.status == "active")

    forms = session.exec(statement).all()

    return [
        work_form_response(form)
        for form in forms
    ]


def create_work_form(data, supervisor: User, session: Session):
    name = data.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Form name is required")

    existing = session.exec(
        select(WorkForm).where(WorkForm.name == name)
    ).first()
    if existing:
        raise HTTPException(status_code=409, detail="A form with this name already exists")

    form = WorkForm(
        name=name,
        description=data.description.strip() if data.description else None,
        fields_json=json.dumps(normalize_work_form_fields(data.fields)),
        status="active",
        created_by=supervisor.id
    )
    session.add(form)
    session.flush()
    add_audit_event(
        session=session,
        actor=supervisor,
        action="work_form_create",
        entity_type="work_form",
        entity_id=form.id,
        after=model_snapshot(form),
        summary=f"Created work form {form.name}",
    )
    session.commit()
    session.refresh(form)

    return work_form_response(form)


def update_work_form(form_id: int, data, supervisor: User, session: Session):
    require_confirmed(data.confirmed)
    form = session.get(WorkForm, form_id)

    if not form:
        raise HTTPException(status_code=404, detail="Form not found")

    fields = data.model_fields_set
    before = model_snapshot(form)
    previous_status = form.status

    if "name" in fields and data.name is not None:
        name = data.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Form name is required")
        existing = session.exec(
            select(WorkForm).where(WorkForm.name == name)
        ).first()
        if existing and existing.id != form.id:
            raise HTTPException(status_code=409, detail="A form with this name already exists")
        form.name = name

    if "description" in fields:
        form.description = data.description.strip() if data.description else None

    if "fields" in fields and data.fields is not None:
        form.fields_json = json.dumps(normalize_work_form_fields(data.fields))

    if "status" in fields and data.status is not None:
        status = data.status.strip().lower()
        if status not in VALID_WORK_FORM_STATUSES:
            raise HTTPException(status_code=400, detail="status must be active or archived")
        form.status = status

    session.add(form)
    action = "work_form_update"
    if "status" in fields and form.status != previous_status:
        action = "work_form_archive" if form.status == "archived" else "work_form_reactivate"

    add_audit_event(
        session=session,
        actor=supervisor,
        action=action,
        entity_type="work_form",
        entity_id=form.id,
        before=before,
        after=model_snapshot(form),
        summary=f"{action.replace('_', ' ').capitalize()} {form.name}",
    )
    session.commit()
    session.refresh(form)

    return work_form_response(form)


def create_work_form_submission(data, user: User, session: Session):
    require_worker(user)
    form = session.get(WorkForm, data.form_id)
    if not form or form.status != "active":
        raise HTTPException(status_code=404, detail="Form not found")

    ensure_site_exists(session, data.site_id)
    answers = validate_work_form_answers(form, data.answers)
    photo_urls = normalize_work_form_photo_urls(data.photo_urls)
    client_submission_id = normalize_client_submission_id(data.client_submission_id)
    if client_submission_id:
        existing_submission = session.exec(
            select(WorkFormSubmission).where(
                WorkFormSubmission.worker_id == user.id,
                WorkFormSubmission.client_submission_id == client_submission_id
            )
        ).first()
        if existing_submission:
            return work_form_submission_response(existing_submission, session)

    submission = WorkFormSubmission(
        form_id=form.id,
        worker_id=user.id,
        site_id=data.site_id,
        work_date=data.work_date,
        answers_json=json.dumps(answers),
        photo_urls=json.dumps(photo_urls) if photo_urls else None,
        client_submission_id=client_submission_id,
        status="pending"
    )
    session.add(submission)
    session.commit()
    session.refresh(submission)

    return work_form_submission_response(submission, session)


def list_my_form_submissions(user: User, session: Session):
    records = session.exec(
        select(WorkFormSubmission)
        .where(WorkFormSubmission.worker_id == user.id)
        .order_by(WorkFormSubmission.created_at.desc())
    ).all()

    return [
        work_form_submission_response(record, session)
        for record in records
    ]


def list_supervisor_form_submissions(status: str | None, session: Session):
    records = session.exec(
        select_work_form_submissions(status)
    ).all()

    return [
        work_form_submission_response(record, session)
        for record in records
    ]
