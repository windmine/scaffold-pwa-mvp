import base64
import csv
import html
import json
from io import StringIO
from typing import Optional
from urllib.parse import urlparse

from fastapi import HTTPException
from fastapi.responses import Response
from sqlmodel import Session, select

from app.models import AttendanceRecord, TaskLog, User, WorkFormSubmission
from app.upload_storage import load_upload
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


VALID_TASK_LOG_HTML_LAYOUTS = {"daily-log", "photo-report"}


def text_value(value):
    if value is None:
        return ""
    if value is True:
        return "Yes"
    if value is False:
        return "No"
    return str(value)


def h(value):
    return html.escape(text_value(value), quote=True)


def label_from_id(value):
    return text_value(value).replace("_", " ").strip().title()


def upload_filename_from_url(value: str):
    if not isinstance(value, str) or not value:
        return None

    path = urlparse(value).path
    if not path.startswith("/uploads/"):
        return None

    return path.rsplit("/", 1)[-1]


def export_image_src(value: str):
    filename = upload_filename_from_url(value)
    if not filename:
        return value

    try:
        upload = load_upload(filename)
    except ValueError:
        return value

    if not upload or not upload.content_type.startswith("image/"):
        return value

    encoded = base64.b64encode(upload.content).decode("ascii")
    return f"data:{upload.content_type};base64,{encoded}"


def render_meta_grid(items):
    cells = []
    for label, value in items:
        display_value = text_value(value) or "-"
        cells.append(
            "<div class=\"meta-cell\">"
            f"<span>{h(label)}</span>"
            f"<strong>{h(display_value)}</strong>"
            "</div>"
        )

    return "<section class=\"meta-grid\">" + "".join(cells) + "</section>"


def render_photo_grid(urls, empty_text="No photos attached."):
    if not urls:
        return f"<p class=\"muted\">{h(empty_text)}</p>"

    photos = []
    for index, url in enumerate(urls, start=1):
        photos.append(
            "<figure class=\"photo-frame\">"
            f"<img src=\"{h(export_image_src(url))}\" alt=\"Photo {index}\" />"
            f"<figcaption>Photo {index}</figcaption>"
            "</figure>"
        )

    return "<div class=\"photo-grid\">" + "".join(photos) + "</div>"


def render_signature_grid(signatures):
    if not signatures:
        return ""

    frames = []
    for index, signature in enumerate(signatures, start=1):
        frames.append(
            "<figure class=\"signature-frame\">"
            f"<img src=\"{h(export_image_src(signature['src']))}\" alt=\"{h(signature['label'])}\" />"
            f"<figcaption>{h(signature['label']) or f'Signature {index}'}</figcaption>"
            "</figure>"
        )

    return "<section><h2>Sign off</h2><div class=\"signature-grid\">" + "".join(frames) + "</div></section>"


def export_document(title: str, subtitle: str, body: str, filename: str):
    document = f"""<!doctype html>
<html lang="en-NZ">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{h(title)}</title>
  <style>
    :root {{
      color: #111111;
      font-family: Arial, Helvetica, sans-serif;
      line-height: 1.4;
    }}
    body {{
      margin: 0;
      background: #f2f4f7;
    }}
    .export-header,
    .export-page {{
      width: min(960px, calc(100% - 32px));
      margin: 16px auto;
      background: #ffffff;
      border: 1px solid #d7dde5;
    }}
    .export-header {{
      padding: 20px 24px;
      border-top: 8px solid #d71920;
    }}
    .export-header h1 {{
      margin: 0 0 6px;
      font-size: 28px;
      line-height: 1.15;
    }}
    .export-header p {{
      margin: 0;
      color: #5b6472;
      font-weight: 700;
    }}
    .export-page {{
      padding: 24px;
      break-after: page;
      page-break-after: always;
    }}
    .export-page:last-child {{
      break-after: auto;
      page-break-after: auto;
    }}
    .document-title {{
      margin: 0 0 16px;
      padding-bottom: 12px;
      border-bottom: 2px solid #111111;
      font-size: 24px;
    }}
    .meta-grid {{
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      border: 1px solid #aeb7c4;
      margin-bottom: 18px;
    }}
    .meta-cell {{
      min-height: 58px;
      padding: 10px 12px;
      border-right: 1px solid #d7dde5;
      border-bottom: 1px solid #d7dde5;
    }}
    .meta-cell:nth-child(2n) {{
      border-right: 0;
    }}
    .meta-cell span,
    .field-label,
    figcaption {{
      display: block;
      color: #5b6472;
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
    }}
    .meta-cell strong {{
      display: block;
      margin-top: 4px;
      font-size: 15px;
      white-space: pre-wrap;
    }}
    h2 {{
      margin: 22px 0 10px;
      font-size: 18px;
      border-bottom: 1px solid #d7dde5;
      padding-bottom: 6px;
    }}
    .field-row {{
      padding: 10px 0;
      border-bottom: 1px solid #e5e9ef;
    }}
    .field-value {{
      margin-top: 4px;
      white-space: pre-wrap;
    }}
    .photo-grid {{
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }}
    .photo-frame,
    .signature-frame {{
      margin: 0;
      border: 1px solid #d7dde5;
      background: #ffffff;
      padding: 8px;
    }}
    .photo-frame img {{
      width: 100%;
      aspect-ratio: 4 / 3;
      object-fit: contain;
      background: #f6f7f9;
    }}
    .signature-grid {{
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }}
    .signature-frame img {{
      width: 100%;
      aspect-ratio: 4 / 1;
      object-fit: contain;
      background: #ffffff;
      border-bottom: 1px solid #111111;
    }}
    .photo-report .photo-frame img {{
      aspect-ratio: 16 / 10;
    }}
    .muted,
    .footer {{
      color: #5b6472;
    }}
    .footer {{
      margin-top: 22px;
      padding-top: 10px;
      border-top: 1px solid #d7dde5;
      font-size: 12px;
    }}
    @media print {{
      body {{
        background: #ffffff;
      }}
      .export-header,
      .export-page {{
        width: auto;
        margin: 0;
        border-left: 0;
        border-right: 0;
      }}
      .export-header {{
        break-after: avoid;
        page-break-after: avoid;
      }}
    }}
    @media (max-width: 680px) {{
      .meta-grid,
      .photo-grid,
      .signature-grid {{
        grid-template-columns: 1fr;
      }}
      .meta-cell {{
        border-right: 0;
      }}
    }}
  </style>
</head>
<body>
  <header class="export-header">
    <h1>{h(title)}</h1>
    <p>{h(subtitle)}</p>
  </header>
  {body}
</body>
</html>"""

    return Response(
        document,
        media_type="text/html",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"'
        }
    )


def render_task_log_daily_page(item):
    title = f"Daily Task Log - {item['site_name'] or 'Unassigned site'}"
    body = [
        f"<article class=\"export-page\"><h1 class=\"document-title\">{h(title)}</h1>",
        render_meta_grid([
            ("Worker", item["worker_name"]),
            ("Site", item["site_name"] or "Unassigned site"),
            ("Work date", item["work_date"] or "-"),
            ("Hours worked", item["hours_worked"]),
            ("Status", item["status"]),
            ("Submitted", item["created_at"]),
        ]),
        "<section><h2>Work completed</h2>",
        f"<div class=\"field-row\"><span class=\"field-label\">Task summary</span><div class=\"field-value\">{h(item['description'] or '-')}</div></div>",
        f"<div class=\"field-row\"><span class=\"field-label\">Safety notes</span><div class=\"field-value\">{h(item['safety_notes'] or '-')}</div></div>",
        "</section>",
        "<section><h2>Photos</h2>",
        render_photo_grid(item["photo_urls"]),
        "</section>",
        f"<footer class=\"footer\">Submitted by {h(item['worker_name'])} | Task log #{h(item['id'])}</footer>",
        "</article>",
    ]
    return "".join(body)


def render_task_log_photo_report_page(item):
    title = f"Task Photo Report - {item['site_name'] or 'Unassigned site'}"
    body = [
        f"<article class=\"export-page photo-report\"><h1 class=\"document-title\">{h(title)}</h1>",
        render_meta_grid([
            ("Worker", item["worker_name"]),
            ("Site", item["site_name"] or "Unassigned site"),
            ("Work date", item["work_date"] or "-"),
            ("Hours worked", item["hours_worked"]),
            ("Submitted", item["created_at"]),
            ("Task log", f"#{item['id']}"),
        ]),
        "<section><h2>Description</h2>",
        f"<div class=\"field-row\"><div class=\"field-value\">{h(item['description'] or '-')}</div></div>",
        "</section>",
        "<section><h2>Photo evidence</h2>",
        render_photo_grid(item["photo_urls"]),
        "</section>",
        f"<footer class=\"footer\">Status: {h(item['status'])} | Safety notes: {h(item['safety_notes'] or '-')}</footer>",
        "</article>",
    ]
    return "".join(body)


def export_task_logs_html(session: Session, layout: str = "daily-log", status: Optional[str] = None):
    layout = (layout or "daily-log").strip().lower()
    if layout not in VALID_TASK_LOG_HTML_LAYOUTS:
        raise HTTPException(status_code=400, detail="layout must be daily-log or photo-report")

    records = session.exec(select_task_logs(status)).all()
    items = [task_log_response(record, session) for record in records]

    if layout == "photo-report":
        title = "Task Log Photo Report"
        subtitle = f"{len(items)} task log records"
        pages = [render_task_log_photo_report_page(item) for item in items]
        filename = "task-log-photo-report.html" if not status else f"task-log-photo-report-{status}.html"
    else:
        title = "Daily Task Log Export"
        subtitle = f"{len(items)} task log records"
        pages = [render_task_log_daily_page(item) for item in items]
        filename = "daily-task-logs.html" if not status else f"daily-task-logs-{status}.html"

    if not pages:
        pages = ["<article class=\"export-page\"><h1 class=\"document-title\">No task logs found</h1></article>"]

    return export_document(title, subtitle, "".join(pages), filename)


def export_task_log_html(log_id: int, session: Session, layout: str = "daily-log"):
    layout = (layout or "daily-log").strip().lower()
    if layout not in VALID_TASK_LOG_HTML_LAYOUTS:
        raise HTTPException(status_code=400, detail="layout must be daily-log or photo-report")

    record = session.get(TaskLog, log_id)
    if not record:
        raise HTTPException(status_code=404, detail="Task log not found")

    item = task_log_response(record, session)
    if layout == "photo-report":
        return export_document(
            "Task Log Photo Report",
            f"Task log #{item['id']}",
            render_task_log_photo_report_page(item),
            f"task-log-{item['id']}-photo-report.html",
        )

    return export_document(
        "Daily Task Log",
        f"Task log #{item['id']}",
        render_task_log_daily_page(item),
        f"task-log-{item['id']}-daily-log.html",
    )


def render_form_answer_rows(item):
    answers = item.get("answers") or {}
    fields = item.get("fields") or []
    signatures = []
    rows = []

    if fields:
        entries = [
            (
                field.get("label") or label_from_id(field.get("id")),
                field.get("type"),
                answers.get(field.get("id")),
            )
            for field in fields
        ]
    else:
        entries = [
            (label_from_id(key), "", value)
            for key, value in answers.items()
        ]

    for label, field_type, value in entries:
        if field_type == "signature" and value:
            signatures.append({"label": label, "src": value})
            continue

        rows.append(
            "<div class=\"field-row\">"
            f"<span class=\"field-label\">{h(label)}</span>"
            f"<div class=\"field-value\">{h(value) if text_value(value) else '-'}</div>"
            "</div>"
        )

    return "".join(rows), signatures


def render_form_submission_page(item):
    answer_rows, signatures = render_form_answer_rows(item)
    title = item["form_name"] or f"Form {item['form_id']}"
    body = [
        f"<article class=\"export-page\"><h1 class=\"document-title\">{h(title)}</h1>",
        render_meta_grid([
            ("Worker", item["worker_name"]),
            ("Site", item["site_name"] or "Unassigned site"),
            ("Work date", item["work_date"] or "-"),
            ("Status", item["status"]),
            ("Submitted", item["created_at"]),
            ("Submission", f"#{item['id']}"),
        ]),
        "<section><h2>Form answers</h2>",
        answer_rows or "<p class=\"muted\">No answers provided.</p>",
        "</section>",
        render_signature_grid(signatures),
        "<section><h2>Photos</h2>",
        render_photo_grid(item["photo_urls"]),
        "</section>",
        f"<footer class=\"footer\">Submitted by {h(item['worker_name'])} | {h(title)} #{h(item['id'])}</footer>",
        "</article>",
    ]
    return "".join(body)


def export_form_submissions_html(session: Session, status: Optional[str] = None):
    records = session.exec(select_work_form_submissions(status)).all()
    items = [
        review_record_response("form", record, session)
        for record in records
    ]
    pages = [render_form_submission_page(item) for item in items]

    if not pages:
        pages = ["<article class=\"export-page\"><h1 class=\"document-title\">No form submissions found</h1></article>"]

    filename = "work-form-submissions.html" if not status else f"work-form-submissions-{status}.html"
    return export_document(
        "Work Form Submission Export",
        f"{len(items)} form submission records",
        "".join(pages),
        filename,
    )


def export_form_submission_html(submission_id: int, session: Session):
    record = session.get(WorkFormSubmission, submission_id)
    if not record:
        raise HTTPException(status_code=404, detail="Form submission not found")

    item = review_record_response("form", record, session)
    return export_document(
        item["form_name"] or "Work Form Submission",
        f"Form submission #{item['id']}",
        render_form_submission_page(item),
        f"work-form-submission-{item['id']}.html",
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


def task_logs_csv_response(items, filename: str):
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

    for item in items:
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

    return Response(
        output.getvalue(),
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"'
        }
    )


def export_task_logs_csv(session: Session, status: Optional[str] = None):
    records = session.exec(
        select_task_logs(status)
    ).all()
    items = [task_log_response(record, session) for record in records]
    filename = "task-logs.csv" if not status else f"task-logs-{status}.csv"
    return task_logs_csv_response(items, filename)


def export_task_log_csv(log_id: int, session: Session):
    record = session.get(TaskLog, log_id)
    if not record:
        raise HTTPException(status_code=404, detail="Task log not found")

    item = task_log_response(record, session)
    return task_logs_csv_response([item], f"task-log-{item['id']}.csv")


def form_answer_columns(item):
    fields = item.get("fields") or []
    answers = item.get("answers") or {}
    columns = []
    seen = set()

    if fields:
        for field in fields:
            field_id = field.get("id")
            if not field_id or field_id in seen:
                continue
            columns.append((field_id, f"answer_{field_id}"))
            seen.add(field_id)

    for key in answers:
        if key not in seen:
            columns.append((key, f"answer_{key}"))
            seen.add(key)

    return columns


def csv_answer_value(value):
    if isinstance(value, (list, dict)):
        return json.dumps(value)
    return text_value(value)


def form_submissions_csv_response(items, filename: str):
    all_columns = []
    seen = set()

    for item in items:
        for field_id, header in form_answer_columns(item):
            if field_id in seen:
                continue
            all_columns.append((field_id, header))
            seen.add(field_id)

    output = StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "id",
        "form_id",
        "form_name",
        "worker_id",
        "worker_name",
        "site_id",
        "site_name",
        "work_date",
        "status",
        "created_at",
        *[header for _, header in all_columns],
        "photo_urls",
    ])

    for item in items:
        answers = item.get("answers") or {}
        writer.writerow([
            item["id"],
            item["form_id"],
            item["form_name"],
            item["worker_id"],
            item["worker_name"],
            item["site_id"],
            item["site_name"],
            item["work_date"],
            item["status"],
            item["created_at"],
            *[csv_answer_value(answers.get(field_id)) for field_id, _ in all_columns],
            "; ".join(item["photo_urls"]),
        ])

    return Response(
        output.getvalue(),
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"'
        }
    )


def export_form_submission_csv(submission_id: int, session: Session):
    record = session.get(WorkFormSubmission, submission_id)
    if not record:
        raise HTTPException(status_code=404, detail="Form submission not found")

    item = review_record_response("form", record, session)
    return form_submissions_csv_response([item], f"work-form-submission-{item['id']}.csv")


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
