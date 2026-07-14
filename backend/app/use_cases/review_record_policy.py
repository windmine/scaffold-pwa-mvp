from fastapi import HTTPException
from sqlalchemy import or_, update
from sqlmodel import Session

from app.models import User
from app.use_cases.audit import add_audit_event, model_snapshot
from app.use_cases.common import (
    can_access_department,
    normalize_approval_record_type,
    validate_approval_decision,
    validate_review_status,
)
from app.use_cases.review_record_adapters import REVIEW_RECORD_ADAPTERS


def resolve_review_record(
    record_type: str,
    record_id: int,
    supervisor: User,
    session: Session,
):
    normalized_type = normalize_approval_record_type(record_type)
    adapter = REVIEW_RECORD_ADAPTERS[normalized_type]
    record = session.get(adapter.model, record_id)
    if (
        not record
        or record.deleted_at is not None
        or not can_access_department(supervisor, record.department_id)
    ):
        raise HTTPException(status_code=404, detail="Review Record not found")
    return adapter, record


def enforce_review_status_unchanged(record, requested_status, changed_fields):
    if "status" not in changed_fields or requested_status is None:
        return
    normalized_status = validate_review_status(requested_status)
    current_status = record.status or "pending"
    if normalized_status != current_status:
        raise HTTPException(
            status_code=400,
            detail="Use the Review Record decision route to approve or reject a pending record",
        )


def apply_review_decision(
    record_type: str,
    record_id: int,
    status: str,
    supervisor: User,
    session: Session,
    comment: str | None = None,
):
    decision = validate_approval_decision(status)
    adapter, record = resolve_review_record(record_type, record_id, supervisor, session)
    if (record.status or "pending") != "pending":
        raise HTTPException(
            status_code=409,
            detail="Review Record has already been decided; refresh the Review Queue",
        )

    before = model_snapshot(record)
    result = session.exec(
        update(adapter.model)
        .where(
            adapter.model.id == record.id,
            or_(adapter.model.status == "pending", adapter.model.status.is_(None)),
            adapter.model.deleted_at.is_(None),
        )
        .values(status=decision)
    )
    if result.rowcount != 1:
        session.rollback()
        raise HTTPException(
            status_code=409,
            detail="Review Record was decided by another Supervisor; refresh the Review Queue",
        )

    session.expire(record)
    session.refresh(record)
    normalized_comment = " ".join(str(comment or "").split())
    summary = f"{decision.capitalize()} {adapter.kind} record #{record.id}"
    if normalized_comment:
        summary = f"{summary}: {normalized_comment}"
    add_audit_event(
        session=session,
        actor=supervisor,
        action="review_decision",
        entity_type=adapter.kind,
        entity_id=record.id,
        before=before,
        after=model_snapshot(record),
        summary=summary,
    )
    session.commit()
    session.refresh(record)
    return adapter.serialize(record, session)
