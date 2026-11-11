"""Read-only PDF exports scoped to the authenticated Report author."""
from fastapi import HTTPException
from fastapi.responses import Response
from sqlmodel import Session

from app.models import User, WorkFormSubmission
from app.use_cases.common import require_worker, review_record_response
from app.use_cases.report_pdf import build_report_pdf
from app.use_cases.supervisor_review import validate_form_record_evidence


PRIVATE_HEADERS = {"Cache-Control": "private, no-store"}


def export_my_report_pdf(submission_id: str, user: User, session: Session):
    require_worker(user)
    # Reject malformed/overflowing IDs with the same result as inaccessible rows.
    identifier = str(submission_id)
    if not identifier.isascii() or not identifier.isdecimal() or len(identifier) > 19:
        raise HTTPException(status_code=404, detail="Report not found", headers=PRIVATE_HEADERS)
    record_id = int(identifier)
    if not 0 < record_id <= 9223372036854775807:
        raise HTTPException(status_code=404, detail="Report not found", headers=PRIVATE_HEADERS)
    record = session.get(WorkFormSubmission, record_id)
    if (not record or record.deleted_at is not None or record.submission_purpose != "report"
            or record.worker_id != user.id or user.department_id is None
            or record.department_id != user.department_id):
        raise HTTPException(status_code=404, detail="Report not found", headers=PRIVATE_HEADERS)

    # Render the current saved correction, not a frozen email/outbox snapshot.
    item = review_record_response("form", record, session, include_pdf_email=False)
    try:
        validate_form_record_evidence(item, record)
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(
            status_code=409,
            detail="Export unavailable: saved image evidence could not be verified from this record's frozen Definition. Original answers and files are unchanged.",
            headers=PRIVATE_HEADERS,
        ) from None
    return Response(
        content=build_report_pdf([item]), media_type="application/pdf",
        headers={**PRIVATE_HEADERS, "Content-Disposition": f'attachment; filename="report-{record.id}.pdf"'},
    )
