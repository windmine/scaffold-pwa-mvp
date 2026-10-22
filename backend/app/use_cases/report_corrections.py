"""Department-scoped, version-guarded corrections to submitted Reports."""
from datetime import date, datetime, timezone
import json

from fastapi import HTTPException
from sqlalchemy import update

from app.models import WorkFormSubmission
from app.schemas import WorkFormField
from app.upload_storage import cleanup_detached_record_uploads, record_evidence_upload_urls, record_upload_urls
from app.use_cases.audit import add_audit_event, model_snapshot
from app.use_cases.common import (
    ensure_site_exists, normalize_work_form_fields, normalize_work_form_photo_metadata, normalize_work_form_photo_urls,
    parse_json_list, validate_owned_upload_references, validate_work_form_answers,
    work_form_submission_definition, work_form_submission_response, work_form_upload_references,
)


def correct_report(submission, data, supervisor, session):
    if supervisor.role != "supervisor":
        raise HTTPException(status_code=403, detail="Supervisor only")
    if data.expected_revision is None:
        raise HTTPException(status_code=409, detail={"code": "report_revision_conflict",
            "message": "Refresh the Report before editing; a current revision is required."})
    try:
        snapshot = json.loads(submission.definition_snapshot_json or "null")
        if (not isinstance(snapshot, dict) or not isinstance(snapshot.get("fields"), list)
                or any(not isinstance(field, dict) or not isinstance(field.get("id"), str)
                       or not isinstance(field.get("type"), str) for field in snapshot["fields"])
                or type(snapshot.get("version")) is not int or snapshot["version"] < 1
                or type(snapshot.get("schema_version")) is not int or snapshot["schema_version"] != 1
                or snapshot["version"] != submission.form_definition_version):
            raise ValueError("Definition unavailable")
        # Validate types, repeated fields and dependencies using the same schema
        # rules as publication, without replacing or upgrading the saved fields.
        normalized = normalize_work_form_fields([WorkFormField.model_validate(field) for field in snapshot["fields"]])
        if any(field["id"] != checked["id"] or field["type"] != checked["type"]
               for field, checked in zip(snapshot["fields"], normalized)):
            raise ValueError("Definition unavailable")
    except (ValueError, TypeError, HTTPException):
        raise HTTPException(status_code=409, detail={"code": "report_definition_unavailable",
            "message": "This Report's original Definition is unavailable. Its saved content cannot be edited."}) from None
    fields = data.model_fields_set
    if "status" in fields:
        raise HTTPException(status_code=409, detail="Reports no longer use review states. Refresh Reports.")
    # Claim the exact version before reading evidence. This serializes competing
    # updates while retaining the original identity and Definition.
    claim = session.execute(update(WorkFormSubmission).where(
        WorkFormSubmission.id == submission.id,
        WorkFormSubmission.department_id == submission.department_id,
        WorkFormSubmission.submission_purpose == "report",
        WorkFormSubmission.deleted_at.is_(None),
        WorkFormSubmission.revision == data.expected_revision,
    ).values(revision=WorkFormSubmission.revision).execution_options(synchronize_session=False))
    if claim.rowcount != 1:
        session.rollback()
        raise HTTPException(status_code=409, detail={"code": "report_revision_conflict",
            "message": "Report changed. Refresh it before saving your corrections."})
    session.refresh(submission)
    before = model_snapshot(submission)
    previous_uploads = record_upload_urls(submission)
    attached = record_evidence_upload_urls(submission)
    values = {}
    if "site_id" in fields:
        site = ensure_site_exists(session, data.site_id, supervisor)
        if site and site.department_id != submission.department_id:
            raise HTTPException(status_code=400, detail="Site must belong to the Report Department")
        values["site_id"] = data.site_id
    if "work_date" in fields:
        if not data.work_date:
            raise HTTPException(status_code=400, detail="Report Date is required")
        try:
            date.fromisoformat(data.work_date)
        except ValueError:
            raise HTTPException(status_code=400, detail="Report Date must be a valid calendar date in YYYY-MM-DD format") from None
        values["work_date"] = data.work_date
    if "answers" in fields:
        if data.answers is None:
            raise HTTPException(status_code=400, detail="Report answers are required")
        definition = work_form_submission_definition(submission, session)
        answers = validate_work_form_answers(definition, data.answers)
        validate_owned_upload_references(work_form_upload_references(definition, answers),
                                         supervisor, session, already_attached=attached)
        values["answers_json"] = json.dumps(answers)
    if "photo_urls" in fields or "photo_metadata" in fields:
        if "photo_urls" in fields and data.photo_urls is None:
            raise HTTPException(status_code=400, detail="Report photos must be a list")
        urls = normalize_work_form_photo_urls(
            data.photo_urls if "photo_urls" in fields else parse_json_list(submission.photo_urls), purpose="report")
        validate_owned_upload_references(urls, supervisor, session, already_attached=attached)
        # Match retained metadata by URL only; removing a photo must never shift
        # the next photo's capture metadata onto another image.
        metadata = (data.photo_metadata if "photo_metadata" in fields else
                    [item for item in parse_json_list(submission.photo_metadata) if item.get("url") in urls])
        by_url = {item.get("url"): item for item in (metadata or []) if isinstance(item, dict)}
        normalized = normalize_work_form_photo_metadata(urls, [by_url.get(url, {"url": url}) for url in urls])
        values["photo_urls"] = json.dumps(urls) if urls else None
        values["photo_metadata"] = json.dumps(normalized) if normalized else None
    changed = any(getattr(submission, key) != value for key, value in values.items())
    if changed:
        for key, value in values.items():
            setattr(submission, key, value)
        submission.revision += 1
        submission.edited_at = datetime.now(timezone.utc)
        submission.edited_by_supervisor_id = supervisor.id
        session.add(submission)
        session.flush()
        add_audit_event(session=session, actor=supervisor, action="form_submission_update",
            entity_type="form", entity_id=submission.id, before=before, after=model_snapshot(submission),
            summary=f"Corrected Report #{submission.id}", department_id=submission.department_id)
    session.commit()
    session.refresh(submission)
    if changed:
        cleanup_detached_record_uploads(previous_uploads, submission, session)
    return work_form_submission_response(submission, session)
