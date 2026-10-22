"""Transactional Report outbox. No network in submission or settings requests.

The dispatcher claims once before any SMTP work. A crash leaves an uncertain
attempt, never a retryable row: SMTP cannot promise exactly-once delivery.
"""
from datetime import datetime, timezone
import json
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import update
from sqlmodel import Session, select

from app import email_transport
from app.models import ReportPdfEmail, User, WorkForm, WorkFormSubmission
from app.use_cases.audit import add_audit_event
from app.use_cases.common import (
    can_access_department, format_datetime, require_confirmed,
    work_form_response, work_form_submission_response, validate_owned_upload_references,
)


def update_email_settings(form_id, data, supervisor, session):
    require_confirmed(data.confirmed)
    if supervisor.role != "supervisor":
        raise HTTPException(status_code=403, detail="Supervisor only")
    form = session.get(WorkForm, form_id)
    if not form or form.template_purpose != "report" or not can_access_department(supervisor, form.department_id):
        raise HTTPException(status_code=404, detail="Report Template not found")
    recipient = (data.recipient or "").strip()
    try:
        if recipient or data.enabled:
            email_transport.validate_mailbox(recipient)
            recipient.encode("ascii")
    except (email_transport.EmailSendError, UnicodeError):
        raise HTTPException(status_code=400, detail="Enter one valid recipient email address.") from None
    # Separate concurrency version: email routing never changes the Definition
    # version used by offline Worker drafts or Supervisor question editors.
    claim = session.execute(update(WorkForm).where(
        WorkForm.id == form.id, WorkForm.department_id == form.department_id,
        WorkForm.template_purpose == "report", WorkForm.pdf_email_version == data.expected_version,
    ).values(pdf_email_version=WorkForm.pdf_email_version).execution_options(synchronize_session=False))
    if claim.rowcount != 1:
        session.rollback()
        raise HTTPException(status_code=409, detail="Email settings changed. Refresh the Template before saving again.")
    session.refresh(form)
    before = {"enabled": form.pdf_email_enabled, "recipient": form.pdf_email_recipient, "version": form.pdf_email_version}
    if form.pdf_email_enabled != data.enabled or form.pdf_email_recipient != (recipient or None):
        form.pdf_email_version += 1
    form.pdf_email_enabled = data.enabled
    form.pdf_email_recipient = recipient or None
    session.add(form)
    add_audit_event(session=session, actor=supervisor, action="report_template_email_update",
        entity_type="work_form", entity_id=form.id, before=before,
        after={"enabled": form.pdf_email_enabled, "recipient": form.pdf_email_recipient, "version": form.pdf_email_version},
        summary=f"Updated PDF email settings for Report Template #{form.id}")
    session.commit()
    session.refresh(form)
    return work_form_response(form, session, include_email_settings=True)


def enqueue_report_pdf(submission, form, session):
    # Serialize with settings changes so the committed recipient is unambiguous.
    session.execute(update(WorkForm).where(WorkForm.id == form.id).values(
        pdf_email_version=WorkForm.pdf_email_version,
    ).execution_options(synchronize_session=False))
    session.refresh(form)
    if not form.pdf_email_enabled or form.template_purpose != "report":
        return
    item = work_form_submission_response(submission, session)
    session.add(ReportPdfEmail(
        submission_id=submission.id, department_id=submission.department_id,
        recipient=form.pdf_email_recipient or "", template_email_version=form.pdf_email_version,
        snapshot_json=json.dumps(item, separators=(",", ":"), ensure_ascii=True),
        message_id=f"<reportflow-{uuid4().hex}@reportflow.invalid>",
    ))


def email_status(submission_id, session):
    row = session.exec(select(ReportPdfEmail).where(ReportPdfEmail.submission_id == submission_id)).first()
    if not row:
        return None
    # Only the Department-scoped Supervisor review serializer uses this.
    # The saved recipient lets a Supervisor check an uncertain attempt even if
    # the Template's current recipient has since changed. Workers get neither.
    return {"status": row.status, "recipient": row.recipient, "failure_code": row.failure_code,
            "attempted_at": format_datetime(row.attempted_at) if row.attempted_at else None,
            "accepted_at": format_datetime(row.accepted_at) if row.accepted_at else None}


def _snapshot_for_delivery(row, session):
    from app.use_cases.supervisor_review import validate_form_record_evidence
    record = session.get(WorkFormSubmission, row.submission_id)
    if (not record or record.deleted_at is not None or record.submission_purpose != "report"
            or record.department_id != row.department_id):
        raise ValueError("Report unavailable")
    item = json.loads(row.snapshot_json)
    current = work_form_submission_response(record, session)
    # The committed outbox remains the original submission after corrections.
    # Identity and frozen Definition must still match the current Report.
    for key in ("id", "department_id", "form_id", "worker_id",
                "definition_version", "fields", "submission_purpose"):
        if item.get(key) != current.get(key):
            raise ValueError("Report snapshot mismatch")
    original = WorkFormSubmission(
        department_id=record.department_id, form_id=record.form_id, worker_id=record.worker_id,
        answers_json=json.dumps(item.get("answers", {})),
        photo_urls=json.dumps(item.get("photo_urls", [])),
        definition_snapshot_json=record.definition_snapshot_json,
    )
    validate_form_record_evidence(item, original)
    # Every queued email originates in authenticated self-submission. Independently
    # verify original attachment ownership; the snapshot cannot authorize itself
    # to load another person's media even if stored data is corrupt.
    from app.upload_storage import record_evidence_upload_urls
    author = session.get(User, record.worker_id)
    if not author:
        raise ValueError("Report author unavailable")
    validate_owned_upload_references(record_evidence_upload_urls(original), author, session)
    return item


def dispatch_one(engine, outbox_id):
    """Claim and attempt at most once. Return only a sanitized outcome."""
    now = datetime.now(timezone.utc)
    with Session(engine) as session:
        result = session.execute(update(ReportPdfEmail).where(
            ReportPdfEmail.id == outbox_id, ReportPdfEmail.status == "pending",
        ).values(status="uncertain", attempted_at=now).execution_options(synchronize_session=False))
        if result.rowcount != 1:
            session.rollback()
            return "skipped"
        claimed_message_id = session.get(ReportPdfEmail, outbox_id).message_id
        # Durable before rendering/network: an interrupted worker is never
        # automatically retried, including an unknown commit acknowledgement.
        session.commit()
    status, code = "failed", "pdf_unavailable"
    try:
        with Session(engine) as session:
            row = session.get(ReportPdfEmail, outbox_id)
            if not row or row.message_id != claimed_message_id or row.status != "uncertain":
                raise ValueError("Claim no longer exists")
            item = _snapshot_for_delivery(row, session)
            recipient, message_id, submission_id = row.recipient, row.message_id, row.submission_id
        from app.use_cases.report_pdf import build_report_pdf
        pdf = build_report_pdf([item], strict_evidence=True)
        if len(pdf) > email_transport.MAX_PDF_ATTACHMENT_BYTES:
            code = "pdf_too_large"
        else:
            # Recheck deletion/scope after potentially slow rendering.
            with Session(engine) as session:
                row = session.get(ReportPdfEmail, outbox_id)
                if not row or row.message_id != claimed_message_id or row.status != "uncertain":
                    raise ValueError("Claim no longer exists")
                _snapshot_for_delivery(row, session)
            code = "smtp_failed"
            email_transport.send_email(recipient, f"ReportFlow submitted Report #{submission_id}",
                f"Report #{submission_id} was successfully submitted. Its submitted PDF, including attached photos and signatures, is attached.\n",
                pdf_attachment=pdf, filename=f"report-{submission_id}.pdf", message_id=message_id)
            status, code = "accepted", None
    except email_transport.EmailSendError as error:
        status = "uncertain" if error.outcome == "unknown" else "failed"
        code = "acceptance_unknown" if status == "uncertain" else "smtp_failed"
    except Exception:
        # PDF/storage/validation errors are safe pre-send failures. An unexpected
        # transport exception might follow DATA and must remain uncertain.
        if code == "smtp_failed":
            status, code = "uncertain", "acceptance_unknown"
    with Session(engine) as session:
        session.execute(update(ReportPdfEmail).where(
            ReportPdfEmail.id == outbox_id, ReportPdfEmail.status == "uncertain",
            ReportPdfEmail.message_id == claimed_message_id,
        ).values(status=status, failure_code=code,
                 accepted_at=datetime.now(timezone.utc) if status == "accepted" else None))
        session.commit()  # If this fails, the earlier uncertain claim remains.
    return status


def dispatch_pending(engine, *, limit=10):
    if not 1 <= limit <= 50:
        raise ValueError("Batch size must be between 1 and 50")
    # Fail before claiming any work if this runtime is not configured securely.
    email_transport.require_smtp_configuration()
    with Session(engine) as session:
        ids = session.exec(select(ReportPdfEmail.id).where(ReportPdfEmail.status == "pending")
                           .order_by(ReportPdfEmail.id).limit(limit)).all()
    counts = {key: 0 for key in ("accepted", "failed", "uncertain", "skipped")}
    for outbox_id in ids:
        counts[dispatch_one(engine, outbox_id)] += 1
    return counts
