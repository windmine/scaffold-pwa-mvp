import json
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.models import User, WorkForm, WorkFormSubmission
from app.use_cases.audit import add_audit_event, model_snapshot
from app.use_cases.common import (
    VALID_REPORT_WORKFLOW_STATUSES,
    VALID_WORK_FORM_STATUSES,
    can_access_department,
    department_id_for_new_record,
    ensure_site_exists,
    normalize_client_submission_id,
    normalize_work_form_purpose,
    normalize_work_form_fields,
    normalize_work_form_photo_metadata,
    normalize_work_form_photo_urls,
    require_confirmed,
    require_leader,
    require_worker,
    select_work_form_submissions,
    scope_statement_to_user_department,
    validate_owned_upload_references,
    validate_work_form_answers,
    work_form_upload_references,
    work_form_definition,
    work_form_definition_snapshot_json,
    work_form_response,
    work_form_submission_response,
)


def list_work_forms(user: User, session: Session, purpose: str | None = None):
    statement = select(WorkForm).order_by(WorkForm.name)
    statement = scope_statement_to_user_department(statement, WorkForm, user)
    normalized_purpose = normalize_work_form_purpose(purpose)
    if normalized_purpose:
        statement = statement.where(WorkForm.template_purpose == normalized_purpose)
    if user.role == "worker":
        statement = statement.where(WorkForm.status == "active")
        if (user.worker_class or "normal") != "leader":
            statement = statement.where(WorkForm.template_purpose != "daywork")

    forms = session.exec(statement).all()

    return [
        work_form_response(form, session)
        for form in forms
    ]


def create_work_form(data, supervisor: User, session: Session):
    name = data.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Report Template name is required")

    department_id = department_id_for_new_record(supervisor, session)
    existing = session.exec(
        select(WorkForm).where(
            WorkForm.name == name,
            WorkForm.department_id == department_id,
        )
    ).first()
    if existing:
        raise HTTPException(status_code=409, detail="A Report Template with this name already exists")

    form = WorkForm(
        department_id=department_id,
        name=name,
        description=data.description.strip() if data.description else None,
        fields_json=json.dumps(normalize_work_form_fields(data.fields)),
        definition_version=1,
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
        summary=f"Created Report Template {form.name}",
    )
    session.commit()
    session.refresh(form)

    return work_form_response(form, session)


def update_work_form(form_id: int, data, supervisor: User, session: Session):
    require_confirmed(data.confirmed)
    form = session.get(WorkForm, form_id)

    if not form or not can_access_department(supervisor, form.department_id):
        raise HTTPException(status_code=404, detail="Report Template not found")

    fields = data.model_fields_set
    before = model_snapshot(form)
    definition_before = work_form_definition(form)
    previous_status = form.status

    if "name" in fields and data.name is not None:
        name = data.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Report Template name is required")
        existing = session.exec(
            select(WorkForm).where(
                WorkForm.name == name,
                WorkForm.department_id == form.department_id,
            )
        ).first()
        if existing and existing.id != form.id:
            raise HTTPException(status_code=409, detail="A Report Template with this name already exists")
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

    definition_after = work_form_definition(form)
    if any(
        definition_before[key] != definition_after[key]
        for key in ("name", "description", "fields")
    ):
        form.definition_version = definition_before["version"] + 1

    session.add(form)
    action = "work_form_update"
    summary_action = "Updated Report Template"
    if "status" in fields and form.status != previous_status:
        action = "work_form_archive" if form.status == "archived" else "work_form_reactivate"
        summary_action = "Archived Report Template" if form.status == "archived" else "Activated Report Template"

    add_audit_event(
        session=session,
        actor=supervisor,
        action=action,
        entity_type="work_form",
        entity_id=form.id,
        before=before,
        after=model_snapshot(form),
        summary=f"{summary_action} {form.name}",
    )
    session.commit()
    session.refresh(form)

    return work_form_response(form, session)


def create_work_form_submission(data, user: User, session: Session):
    require_worker(user)
    client_submission_id = normalize_client_submission_id(data.client_submission_id)
    if client_submission_id:
        existing_submission = session.exec(
            select(WorkFormSubmission).where(
                WorkFormSubmission.worker_id == user.id,
                WorkFormSubmission.client_submission_id == client_submission_id,
            )
        ).first()
        if existing_submission:
            return work_form_submission_response(existing_submission, session)

    form = session.get(WorkForm, data.form_id)
    if not form or form.status != "active" or not can_access_department(user, form.department_id):
        raise HTTPException(status_code=404, detail="Report Template not found")
    if (form.template_purpose or "report") == "daywork":
        require_leader(user)
    if (form.template_purpose or "report") == "report" and not data.work_date:
        raise HTTPException(status_code=400, detail="Report Date is required")

    ensure_site_exists(session, data.site_id, user)
    definition = work_form_definition(form)
    answers = validate_work_form_answers(definition, data.answers)
    photo_urls = normalize_work_form_photo_urls(data.photo_urls)
    photo_metadata = normalize_work_form_photo_metadata(photo_urls, data.photo_metadata)
    validate_owned_upload_references(
        work_form_upload_references(definition, answers, photo_urls),
        user,
        session,
    )

    submission = WorkFormSubmission(
        department_id=department_id_for_new_record(user, session),
        form_id=form.id,
        worker_id=user.id,
        site_id=data.site_id,
        work_date=data.work_date,
        answers_json=json.dumps(answers),
        form_definition_version=definition["version"],
        definition_snapshot_json=work_form_definition_snapshot_json(form),
        photo_urls=json.dumps(photo_urls) if photo_urls else None,
        photo_metadata=json.dumps(photo_metadata) if photo_metadata else None,
        client_submission_id=client_submission_id,
        submission_purpose=form.template_purpose or "report",
        workflow_status="submitted",
        status="pending"
    )
    session.add(submission)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        if client_submission_id:
            existing_submission = session.exec(
                select(WorkFormSubmission).where(
                    WorkFormSubmission.worker_id == user.id,
                    WorkFormSubmission.client_submission_id == client_submission_id,
                )
            ).first()
            if existing_submission:
                return work_form_submission_response(existing_submission, session)
        raise
    session.refresh(submission)

    return work_form_submission_response(submission, session)


def transition_report(submission_id: int, data, supervisor: User, session: Session):
    if supervisor.role != "supervisor":
        raise HTTPException(status_code=403, detail="Supervisor only")

    target_status = data.status.strip().lower()
    if (
        target_status not in VALID_REPORT_WORKFLOW_STATUSES
        or target_status == "submitted"
    ):
        raise HTTPException(
            status_code=400,
            detail="status must be in_review or resolved",
        )

    submission = session.get(WorkFormSubmission, submission_id)
    if (
        not submission
        or submission.deleted_at is not None
        or not can_access_department(supervisor, submission.department_id)
    ):
        raise HTTPException(status_code=404, detail="Report not found")
    if (submission.submission_purpose or "report") != "report":
        raise HTTPException(
            status_code=400,
            detail="Submission is not a Report",
        )

    current_status = submission.workflow_status or (
        "resolved"
        if (submission.status or "pending") in {"approved", "rejected"}
        else "submitted"
    )
    expected_status = "submitted" if target_status == "in_review" else "in_review"
    if current_status != expected_status:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Report must be {expected_status} before it can become {target_status}; "
                "refresh Reports"
            ),
        )

    normalized_note = " ".join(str(data.supervisor_note or "").split()) or None
    if target_status == "resolved" and not normalized_note:
        raise HTTPException(
            status_code=400,
            detail="A Supervisor note is required to resolve a Report",
        )

    before = model_snapshot(submission)
    now = datetime.now(timezone.utc)
    update_values = {
        "workflow_status": target_status,
        "supervisor_note": normalized_note,
    }
    if target_status == "in_review":
        update_values.update(
            reviewing_supervisor_id=supervisor.id,
            review_started_at=now,
            resolved_at=None,
        )
    else:
        update_values["resolved_at"] = now

    result = session.exec(
        update(WorkFormSubmission)
        .where(
            WorkFormSubmission.id == submission.id,
            WorkFormSubmission.deleted_at.is_(None),
            WorkFormSubmission.workflow_status == expected_status,
        )
        .values(**update_values)
    )
    if result.rowcount != 1:
        session.rollback()
        raise HTTPException(
            status_code=409,
            detail="Report was transitioned by another Supervisor; refresh Reports",
        )

    session.expire(submission)
    session.refresh(submission)
    add_audit_event(
        session=session,
        actor=supervisor,
        action="report_transition",
        entity_type="form",
        entity_id=submission.id,
        before=before,
        after=model_snapshot(submission),
        summary=f"Transitioned Report #{submission.id} from {expected_status} to {target_status}",
        department_id=submission.department_id,
    )
    session.commit()
    session.refresh(submission)
    return work_form_submission_response(submission, session)


def list_my_form_submissions(
    user: User,
    session: Session,
    purpose: str | None = None,
):
    statement = select(WorkFormSubmission).where(
        WorkFormSubmission.worker_id == user.id,
        WorkFormSubmission.deleted_at.is_(None),
    )
    normalized_purpose = normalize_work_form_purpose(purpose)
    if normalized_purpose:
        statement = statement.where(
            WorkFormSubmission.submission_purpose == normalized_purpose
        )
    records = session.exec(
        statement.order_by(WorkFormSubmission.created_at.desc())
    ).all()

    return [
        work_form_submission_response(record, session)
        for record in records
    ]


def list_supervisor_form_submissions(
    status: str | None,
    supervisor: User,
    session: Session,
    purpose: str | None = None,
):
    records = session.exec(
        select_work_form_submissions(status, supervisor, purpose=purpose)
    ).all()

    return [
        work_form_submission_response(record, session)
        for record in records
    ]
