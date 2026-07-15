import csv
import json
import re
from io import BytesIO, StringIO
from datetime import date, datetime, timezone, timedelta
from typing import Optional

from fastapi import HTTPException
from fastapi.responses import Response
from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import Image as ReportLabImage
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from sqlmodel import Session, select

from app.models import AttendanceRecord, TaskLog, TeamWorkLog, TeamWorkLogEntry, User, WorkForm, WorkFormSubmission
from app.upload_storage import cleanup_detached_record_uploads, record_upload_urls
from app.use_cases.audit import add_audit_event, model_snapshot
from app.use_cases.common import (
    attendance_record_response,
    break_answer_duration_hours,
    can_access_department,
    ensure_site_exists,
    normalize_task_photo_urls,
    normalize_work_form_photo_urls,
    require_confirmed,
    review_record_response,
    select_attendance_records,
    select_task_logs,
    select_team_work_logs,
    select_work_form_submissions,
    site_distance_check,
    task_log_response,
    validate_owned_upload_references,
    validate_work_form_answers,
    validate_photo_url,
    work_form_definition,
    work_form_definition_snapshot_json,
    work_form_upload_references,
    work_form_submission_definition,
    work_form_submission_response,
)
from app.use_cases.supervisor_review_exports import (
    export_image_src,
    export_logo_bytes,
    export_logo_src,
    filter_form_records,
    filter_records_by_date,
    filter_records_by_department,
    h,
    image_bytes_from_value,
    label_from_id,
    photo_caption,
    render_meta_grid,
    render_photo_grid,
    render_signature_grid,
    write_spreadsheet_safe_csv_row,
    text_value,
)
from app.use_cases.review_queue import list_review_records
from app.use_cases.review_record_policy import apply_review_decision, enforce_review_status_unchanged
from app.use_cases.team_work_logs import prepare_team_work_log_entries


VALID_TASK_LOG_HTML_LAYOUTS = {"daily-log", "photo-report"}
VALID_FORM_PDF_TEMPLATES = {"submitted-form", "daywork"}


def export_document(title: str, subtitle: str, body: str, filename: str):
    logo_src = export_logo_src()
    logo_html = (
        f"<img class=\"export-logo\" src=\"{h(logo_src)}\" alt=\"Leader Scaffolding\" />"
        if logo_src
        else "<div class=\"export-logo-fallback\">Leader Scaffolding</div>"
    )
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
      border-top: 8px solid #096cf5;
    }}
    .export-brand {{
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
    }}
    .export-logo {{
      display: block;
      width: min(360px, 50vw);
      height: auto;
    }}
    .export-logo-fallback {{
      color: #096cf5;
      font-size: 26px;
      font-weight: 900;
      letter-spacing: 0;
      text-transform: uppercase;
    }}
    .export-title {{
      flex: 1;
      text-align: right;
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
    .form-subtitle {{
      margin: 18px 0 8px;
      padding: 8px 10px;
      border-left: 4px solid #096cf5;
      background: #f1f6ff;
      color: #111111;
      font-size: 15px;
      font-weight: 900;
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
      .export-brand {{
        align-items: flex-start;
        flex-direction: column;
      }}
      .export-title {{
        text-align: left;
      }}
      .export-logo {{
        width: min(360px, 84vw);
      }}
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
    <div class="export-brand">
      {logo_html}
      <div class="export-title">
        <h1>{h(title)}</h1>
        <p>{h(subtitle)}</p>
      </div>
    </div>
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


def export_task_logs_html(
    session: Session,
    supervisor: User,
    layout: str = "daily-log",
    status: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    department_id: Optional[int] = None,
):
    layout = (layout or "daily-log").strip().lower()
    if layout not in VALID_TASK_LOG_HTML_LAYOUTS:
        raise HTTPException(status_code=400, detail="layout must be daily-log or photo-report")

    records = session.exec(select_task_logs(status, supervisor)).all()
    records = filter_records_by_department(records, session, supervisor, department_id)
    records = filter_records_by_date(records, date_from, date_to)
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


def export_task_log_html(log_id: int, session: Session, supervisor: User, layout: str = "daily-log"):
    layout = (layout or "daily-log").strip().lower()
    if layout not in VALID_TASK_LOG_HTML_LAYOUTS:
        raise HTTPException(status_code=400, detail="layout must be daily-log or photo-report")

    record = session.get(TaskLog, log_id)
    if (
        not record
        or record.deleted_at is not None
        or not can_access_department(supervisor, record.department_id)
    ):
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
    repeat_children = {}

    for field in fields:
        if field.get("repeat"):
            repeat_children.setdefault(field["repeat"], []).append(field)

    if fields:
        entries = [
            (
                field.get("label") or label_from_id(field.get("id")),
                field.get("type"),
                answers.get(field.get("id")),
                field,
            )
            for field in fields
            if not field.get("repeat")
        ]
    else:
        entries = [
            (label_from_id(key), "", value, {})
            for key, value in answers.items()
        ]

    for label, field_type, value, field in entries:
        if field_type == "section":
            rows.append(f"<h3 class=\"form-subtitle\">{h(label)}</h3>")
            continue

        if field_type == "repeat":
            rows.append(f"<h3 class=\"form-subtitle\">{h(label)}</h3>")
            repeat_rows = value if isinstance(value, list) else []
            children = repeat_children.get(field.get("id"), [])
            if not repeat_rows:
                rows.append("<p class=\"muted\">No rows provided.</p>")
                continue
            for index, repeat_row in enumerate(repeat_rows, start=1):
                child_values = []
                for child in children:
                    if child.get("type") == "section":
                        continue
                    child_value = repeat_row.get(child.get("id")) if isinstance(repeat_row, dict) else None
                    label_text = child.get("label") or label_from_id(child.get("id"))
                    if child.get("type") == "signature" and child_value:
                        child_value = "Signed"
                    child_values.append(f"{h(label_text)}: {h(child_value) if text_value(child_value) else '-'}")
                rows.append(
                    "<div class=\"field-row\">"
                    f"<span class=\"field-label\">Row {index}</span>"
                    f"<div class=\"field-value\">{'<br />'.join(child_values) if child_values else h(repeat_row)}</div>"
                    "</div>"
                )
            continue

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
        render_photo_grid(item["photo_urls"], metadata=item.get("photo_metadata") or []),
        "</section>",
        f"<footer class=\"footer\">Submitted by {h(item['worker_name'])} | {h(title)} #{h(item['id'])}</footer>",
        "</article>",
    ]
    return "".join(body)


def normalize_form_pdf_template(template: str = "submitted-form"):
    value = (template or "submitted-form").strip().lower()
    aliases = {
        "form": "submitted-form",
        "forms": "submitted-form",
        "submitted-forms": "submitted-form",
        "work-form": "submitted-form",
        "work-forms": "submitted-form",
        "daywork-log": "daywork",
        "daywork-form": "daywork",
    }
    value = aliases.get(value, value)
    if value not in VALID_FORM_PDF_TEMPLATES:
        raise HTTPException(status_code=400, detail="template must be submitted-form or daywork")
    return value


def is_daywork_submission(item):
    text = f"{item.get('form_name') or ''}".lower()
    return "daywork" in text or "daily work" in text


def pdf_styles():
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "LeaderPdfTitle",
            parent=base["Heading1"],
            fontName="Helvetica-Bold",
            fontSize=18,
            leading=22,
            textColor=colors.HexColor("#111111"),
            spaceAfter=10,
        ),
        "section": ParagraphStyle(
            "LeaderPdfSection",
            parent=base["Heading2"],
            fontName="Helvetica-Bold",
            fontSize=12,
            leading=15,
            textColor=colors.HexColor("#111111"),
            spaceBefore=10,
            spaceAfter=6,
        ),
        "subtitle": ParagraphStyle(
            "LeaderPdfSubtitle",
            parent=base["Heading3"],
            fontName="Helvetica-Bold",
            fontSize=10,
            leading=13,
            textColor=colors.HexColor("#111111"),
            backColor=colors.HexColor("#f1f6ff"),
            borderColor=colors.HexColor("#096cf5"),
            borderWidth=0,
            borderPadding=6,
            spaceBefore=8,
            spaceAfter=4,
        ),
        "body": ParagraphStyle(
            "LeaderPdfBody",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=9,
            leading=12,
            textColor=colors.HexColor("#111111"),
        ),
        "muted": ParagraphStyle(
            "LeaderPdfMuted",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=9,
            leading=12,
            textColor=colors.HexColor("#5b6472"),
        ),
        "field_label": ParagraphStyle(
            "LeaderPdfFieldLabel",
            parent=base["BodyText"],
            fontName="Helvetica-Bold",
            fontSize=7,
            leading=9,
            textColor=colors.HexColor("#5b6472"),
            uppercase=True,
        ),
        "field_value": ParagraphStyle(
            "LeaderPdfFieldValue",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=9,
            leading=12,
            textColor=colors.HexColor("#111111"),
        ),
        "meta_label": ParagraphStyle(
            "LeaderPdfMetaLabel",
            parent=base["BodyText"],
            fontName="Helvetica-Bold",
            fontSize=6.5,
            leading=8,
            textColor=colors.HexColor("#5b6472"),
            uppercase=True,
        ),
        "meta_value": ParagraphStyle(
            "LeaderPdfMetaValue",
            parent=base["BodyText"],
            fontName="Helvetica-Bold",
            fontSize=8.5,
            leading=11,
            textColor=colors.HexColor("#111111"),
        ),
        "caption": ParagraphStyle(
            "LeaderPdfCaption",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=7,
            leading=9,
            textColor=colors.HexColor("#5b6472"),
        ),
        "footer": ParagraphStyle(
            "LeaderPdfFooter",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=8,
            leading=10,
            textColor=colors.HexColor("#5b6472"),
        ),
    }


def pdf_text(value):
    return h(value).replace("\n", "<br />") if text_value(value) else "-"


def pdf_paragraph(value, style):
    return Paragraph(pdf_text(value), style)


def pdf_meta_table(items, styles):
    rows = []
    for index in range(0, len(items), 2):
        pair = items[index:index + 2]
        row = []
        for label, value in pair:
            row.extend([
                Paragraph(h(label).upper(), styles["meta_label"]),
                Paragraph(pdf_text(value), styles["meta_value"]),
            ])
        if len(pair) == 1:
            row.extend(["", ""])
        rows.append(row)

    table = Table(rows, colWidths=[25 * mm, 64 * mm, 25 * mm, 64 * mm], hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.8, colors.HexColor("#aeb7c4")),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#d7dde5")),
        ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#f6f7f9")),
        ("BACKGROUND", (2, 0), (2, -1), colors.HexColor("#f6f7f9")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return table


def pdf_field_block(label, value, styles):
    table = Table(
        [[
            Paragraph(h(label).upper(), styles["field_label"]),
            Paragraph(pdf_text(value), styles["field_value"]),
        ]],
        colWidths=[42 * mm, 136 * mm],
        hAlign="LEFT",
    )
    table.setStyle(TableStyle([
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, colors.HexColor("#e5e9ef")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return table


def pdf_image_flowable(image_bytes, max_width, max_height):
    if not image_bytes:
        return None

    try:
        reader = ImageReader(BytesIO(image_bytes))
        width, height = reader.getSize()
        if width <= 0 or height <= 0:
            return None
        scale = min(max_width / width, max_height / height)
        image = ReportLabImage(BytesIO(image_bytes), width=width * scale, height=height * scale)
        image.hAlign = "LEFT"
        return image
    except Exception:
        return None


DAYWORK_BLUE = colors.HexColor("#168bd2")
DAYWORK_LINE = colors.HexColor("#d8d8d8")
DAYWORK_LABEL_BACKGROUND = colors.HexColor("#f4f4f4")
DAYWORK_LABEL_WIDTH = 52 * mm
DAYWORK_VALUE_WIDTH = 124 * mm


def daywork_pdf_styles():
    base = getSampleStyleSheet()
    return {
        "heading": ParagraphStyle(
            "DayworkHeading",
            parent=base["Heading2"],
            fontName="Helvetica-Bold",
            fontSize=14,
            leading=18,
            textColor=DAYWORK_BLUE,
            spaceBefore=4,
            spaceAfter=2,
        ),
        "label": ParagraphStyle(
            "DayworkLabel",
            parent=base["BodyText"],
            fontName="Helvetica-Bold",
            fontSize=9,
            leading=11,
            textColor=colors.HexColor("#444444"),
        ),
        "value": ParagraphStyle(
            "DayworkValue",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=9,
            leading=11,
            textColor=colors.HexColor("#444444"),
        ),
        "muted": ParagraphStyle(
            "DayworkMuted",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=9,
            leading=11,
            textColor=colors.HexColor("#666666"),
        ),
    }


def normalize_daywork_key(value):
    return re.sub(r"[^a-z0-9]+", "_", text_value(value).lower()).strip("_")


def daywork_repeat_text(repeat_rows, children, signatures, parent_label):
    rows = repeat_rows if isinstance(repeat_rows, list) else []
    if not rows:
        return ""

    lines = []
    for index, repeat_row in enumerate(rows, start=1):
        child_lines = []
        for child in children:
            if child.get("type") == "section":
                continue
            child_value = repeat_row.get(child.get("id")) if isinstance(repeat_row, dict) else None
            label_text = child.get("label") or label_from_id(child.get("id"))
            if child.get("type") == "signature" and child_value:
                signatures.append({"label": f"{parent_label} row {index} - {label_text}", "src": child_value})
                child_value = "Signed"
            child_lines.append(f"{label_text}: {text_value(child_value) or '-'}")
        lines.append(f"Row {index}: " + "; ".join(child_lines))
    return "\n".join(lines)


def daywork_answer_entries(item):
    answers = item.get("answers") or {}
    fields = item.get("fields") or []
    entries = []
    signatures = []
    repeat_children = {}

    for field in fields:
        if field.get("repeat"):
            repeat_children.setdefault(field["repeat"], []).append(field)

    def add_entry(field_id, label, field_type, value):
        normalized_type = (field_type or "").strip().lower()
        if normalized_type == "section":
            return
        if normalized_type == "signature":
            if value:
                signatures.append({"label": label, "src": value})
            return
        entries.append({
            "id": field_id or "",
            "label": label or label_from_id(field_id),
            "type": normalized_type,
            "value": value,
        })

    if fields:
        for field in fields:
            if field.get("repeat"):
                continue
            field_id = field.get("id")
            field_type = field.get("type")
            label = field.get("label") or label_from_id(field_id)
            value = answers.get(field_id)
            if field_type == "repeat":
                value = daywork_repeat_text(value, repeat_children.get(field_id, []), signatures, label)
            add_entry(field_id, label, field_type, value)
    else:
        for key, value in answers.items():
            label = label_from_id(key)
            if "signature" in normalize_daywork_key(key) and isinstance(value, str):
                signatures.append({"label": label, "src": value})
            else:
                add_entry(key, label, "", value)

    return entries, signatures


def daywork_take_value(entries, aliases, consumed):
    keys = {normalize_daywork_key(alias) for alias in aliases}
    for index, entry in enumerate(entries):
        if index in consumed:
            continue
        entry_keys = {
            normalize_daywork_key(entry.get("id")),
            normalize_daywork_key(entry.get("label")),
        }
        if keys.intersection(entry_keys):
            consumed.add(index)
            return entry.get("value")
    return ""


def daywork_extra_rows(entries, consumed):
    rows = []
    for index, entry in enumerate(entries):
        if index in consumed:
            continue
        value = entry.get("value")
        if text_value(value):
            rows.append((entry.get("label") or label_from_id(entry.get("id")), value))
    return rows


def parse_daywork_date(value):
    raw = text_value(value)
    if not raw:
        return None

    for parser in (
        lambda item: datetime.fromisoformat(item.replace("Z", "+00:00")),
        lambda item: datetime.strptime(item, "%Y-%m-%d"),
        lambda item: datetime.strptime(item, "%d/%m/%Y"),
        lambda item: datetime.strptime(item, "%d-%m-%Y"),
    ):
        try:
            return parser(raw)
        except ValueError:
            continue
    return None


def daywork_date_label(value):
    parsed = parse_daywork_date(value)
    return parsed.strftime("%d/%m/%Y") if parsed else text_value(value)


def daywork_day_label(value):
    parsed = parse_daywork_date(value)
    return parsed.strftime("%A") if parsed else ""


def daywork_cell(value, styles):
    if isinstance(value, list):
        return value
    return Paragraph(pdf_text(value), styles["value"])


def daywork_table(rows, styles):
    data = [
        [
            Paragraph(h(label), styles["label"]) if text_value(label) else "",
            daywork_cell(value, styles),
        ]
        for label, value in rows
    ]
    table = Table(
        data,
        colWidths=[DAYWORK_LABEL_WIDTH, DAYWORK_VALUE_WIDTH],
        hAlign="LEFT",
        splitByRow=1,
    )
    table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.5, DAYWORK_LINE),
        ("BACKGROUND", (0, 0), (0, -1), DAYWORK_LABEL_BACKGROUND),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return table


def daywork_photo_rows(item, styles):
    urls = item.get("photo_urls") or []
    if not urls:
        return [("Photos", "-")]

    rows = []
    for index, url in enumerate(urls):
        image = pdf_image_flowable(image_bytes_from_value(url), 54 * mm, 76 * mm)
        cell = [image] if image else [Paragraph("Image unavailable", styles["muted"])]
        rows.append(("Photos" if index == 0 else "", cell))
    return rows


def daywork_signature_cell(signatures, styles):
    if not signatures:
        return "-"

    image = pdf_image_flowable(image_bytes_from_value(signatures[0].get("src")), 58 * mm, 24 * mm)
    if image:
        return [image]
    return signatures[0].get("label") or "Signed"


def daywork_submitted_by(item):
    return item.get("worker_email") or item.get("worker_name") or "Unknown"


def daywork_number_label(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return text_value(value)
    if number.is_integer():
        return str(int(number))
    return str(round(number, 2)).rstrip("0").rstrip(".")


def daywork_compact_time(value):
    if isinstance(value, dict):
        start = text_value(value.get("start")).replace(":", "")
        end = text_value(value.get("end")).replace(":", "")
        if start and end:
            return f"{start}-{end}"
    return text_value(value)


def daywork_team_hours(row):
    if not isinstance(row, dict):
        return None
    try:
        people = float(row.get("team_people"))
        duration = float((row.get("team_time") or {}).get("duration_hours"))
        break_hours = daywork_team_break_hours(row)
        return round(people * max(duration - break_hours, 0), 2)
    except (TypeError, ValueError):
        pass

    value = row.get("team_man_hours")
    try:
        return round(float(value), 2)
    except (TypeError, ValueError):
        return None


def daywork_team_break_hours(row):
    if not isinstance(row, dict):
        return 0

    value = break_answer_duration_hours(row.get("team_break"))
    return value if value is not None else 0


def daywork_team_break_label(row):
    if not isinstance(row, dict):
        return ""

    value = row.get("team_break")
    if value in (None, ""):
        return "No break"
    return text_value(value)


def daywork_team_duration_hours(row):
    if not isinstance(row, dict):
        return None

    team_time = row.get("team_time") if isinstance(row.get("team_time"), dict) else {}
    duration = team_time.get("duration_hours")
    try:
        return round(max(float(duration) - daywork_team_break_hours(row), 0), 2)
    except (TypeError, ValueError):
        pass

    try:
        people = float(row.get("team_people"))
        hours = daywork_team_hours(row)
        if people > 0 and hours is not None:
            return round(hours / people, 2)
    except (TypeError, ValueError):
        pass

    return None


def daywork_total_man_hours_expression(teams):
    parts = []
    total = 0

    for row in teams:
        if not isinstance(row, dict):
            continue

        hours = daywork_team_hours(row)
        people = row.get("team_people")
        duration = daywork_team_duration_hours(row)

        try:
            people_number = float(people)
        except (TypeError, ValueError):
            people_number = None

        if people_number is not None and duration is not None:
            parts.append(f"{daywork_number_label(people_number)}men x {daywork_number_label(duration)}hours")
            total += hours if hours is not None else round(people_number * duration, 2)
        elif hours is not None:
            parts.append(f"{daywork_number_label(hours)}hours")
            total += hours

    if not parts:
        return ""

    return f"{' + '.join(parts)} = {daywork_number_label(total)}hours"


def daywork_team_detail_rows(item, entries, consumed):
    teams = (item.get("answers") or {}).get("teams")
    if not isinstance(teams, list) or not teams:
        return [], ""

    for index, entry in enumerate(entries):
        if normalize_daywork_key(entry.get("id")) == "teams":
            consumed.add(index)

    rows = []
    total = 0
    for index, row in enumerate(teams, start=1):
        if not isinstance(row, dict):
            continue
        people = row.get("team_people")
        team_name = text_value(row.get("team_name")) or f"Team {index}"
        if text_value(people):
            team_name = f"{team_name} ({daywork_number_label(people)} people)"
        rows.append((f"Team {index}", team_name))
        rows.append((f"Working Hours-Team {index}", daywork_compact_time(row.get("team_time"))))
        rows.append((f"Break-Team {index}", daywork_team_break_label(row)))

        hours = daywork_team_hours(row)
        if hours is not None:
            total += hours

    if not rows:
        return [], ""

    return rows, daywork_total_man_hours_expression(teams) or f"{daywork_number_label(total)}hours"


def pdf_daywork_submission_flowables(item, styles):
    entries, signatures = daywork_answer_entries(item)
    consumed = set()

    date_value = (
        daywork_take_value(entries, ["date", "work_date", "work date"], consumed)
        or item.get("work_date")
        or item.get("created_at")
    )
    site_manager_name = daywork_take_value(
        entries,
        ["site_manager_name", "site manager name", "site manager", "manager_name", "manager name"],
        consumed,
    )

    site_rows = [
        ("Client", daywork_take_value(entries, ["client", "customer", "builder"], consumed)),
        (
            "Project/ Site",
            daywork_take_value(entries, ["project_site", "project site", "project", "site"], consumed)
            or item.get("site_name")
            or "Unassigned site",
        ),
        ("Date", daywork_date_label(date_value)),
        ("Day", daywork_take_value(entries, ["day"], consumed) or daywork_day_label(date_value)),
    ]

    detail_rows = [
        ("SI number", daywork_take_value(entries, ["si_number", "si number", "si no", "site instruction number"], consumed)),
        ("Building", daywork_take_value(entries, ["building", "building_area", "area"], consumed)),
        ("Level", daywork_take_value(entries, ["level", "floor"], consumed)),
        ("Gridline", daywork_take_value(entries, ["gridline", "grid line"], consumed)),
    ]
    team_rows, calculated_total_hours = daywork_team_detail_rows(item, entries, consumed)
    if team_rows:
        detail_rows.extend(team_rows)
        detail_rows.append(("Total Man Hours--All Teams", calculated_total_hours))
    else:
        detail_rows.extend([
            ("Team 1", daywork_take_value(entries, ["team_1", "team 1", "team", "crew"], consumed) or item.get("worker_name")),
            (
                "Working Hours-Team 1",
                daywork_take_value(entries, ["working_hours_team_1", "working hours team 1", "working_hours", "working hours", "work_time", "work time"], consumed),
            ),
            (
                "Total Man Hours--All Teams",
                daywork_take_value(entries, ["total_man_hours_all_teams", "total man hours all teams", "total_man_hours", "total man hours", "total_worker_hours", "total worker hours", "hours_worked", "hours worked"], consumed),
            ),
        ])
    detail_rows.extend([
        (
            "Job description",
            daywork_take_value(entries, ["job_description", "job description", "work_completed", "work completed", "task_description", "task description", "description"], consumed),
        ),
        ("Dimension", daywork_take_value(entries, ["dimension", "dimensions", "measurements", "measurement"], consumed)),
    ])
    detail_rows.extend(daywork_extra_rows(entries, consumed))
    detail_rows.extend(daywork_photo_rows(item, styles))
    detail_rows.extend([
        ("Site Manager Name", site_manager_name),
        ("Signature", daywork_signature_cell(signatures, styles)),
    ])

    return [
        daywork_table([("Sequence Number", item.get("id"))], styles),
        Spacer(1, 5),
        Paragraph("Site details:", styles["heading"]),
        daywork_table(site_rows, styles),
        Spacer(1, 5),
        Paragraph("Details", styles["heading"]),
        daywork_table(detail_rows, styles),
    ]


def pdf_image_grid(title, items, styles, empty_text, max_width=82 * mm, max_height=60 * mm):
    flowables = [Paragraph(h(title), styles["section"])]
    if not items:
        flowables.append(Paragraph(h(empty_text), styles["muted"]))
        return flowables

    cells = []
    for image_bytes, caption in items:
        image = pdf_image_flowable(image_bytes, max_width, max_height)
        cell = []
        if image:
            cell.append(image)
            cell.append(Spacer(1, 3))
        else:
            cell.append(Paragraph("Image unavailable", styles["muted"]))
        cell.append(Paragraph(h(caption), styles["caption"]))
        cells.append(cell)

    rows = []
    for index in range(0, len(cells), 2):
        row = cells[index:index + 2]
        if len(row) == 1:
            row.append("")
        rows.append(row)

    table = Table(rows, colWidths=[86 * mm, 86 * mm], hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#d7dde5")),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#d7dde5")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    flowables.append(table)
    return flowables


def pdf_photo_flowables(item, styles):
    urls = item.get("photo_urls") or []
    metadata = item.get("photo_metadata") or []
    photos = [
        (image_bytes_from_value(url), photo_caption(index, metadata))
        for index, url in enumerate(urls, start=1)
    ]
    return pdf_image_grid("Photos", photos, styles, "No photos attached.")


def pdf_signature_flowables(signatures, styles):
    signature_items = [
        (image_bytes_from_value(signature.get("src")), signature.get("label") or f"Signature {index}")
        for index, signature in enumerate(signatures, start=1)
    ]
    return pdf_image_grid("Sign off", signature_items, styles, "No signatures attached.", max_height=28 * mm)


def pdf_form_answer_flowables(item, styles):
    answers = item.get("answers") or {}
    fields = item.get("fields") or []
    signatures = []
    flowables = []
    repeat_children = {}

    for field in fields:
        if field.get("repeat"):
            repeat_children.setdefault(field["repeat"], []).append(field)

    if fields:
        entries = [
            (
                field.get("label") or label_from_id(field.get("id")),
                field.get("type"),
                answers.get(field.get("id")),
                field,
            )
            for field in fields
            if not field.get("repeat")
        ]
    else:
        entries = [
            (label_from_id(key), "", value, {})
            for key, value in answers.items()
        ]

    for label, field_type, value, field in entries:
        if field_type == "section":
            flowables.append(Paragraph(h(label), styles["subtitle"]))
            continue

        if field_type == "repeat":
            flowables.append(Paragraph(h(label), styles["subtitle"]))
            repeat_rows = value if isinstance(value, list) else []
            children = repeat_children.get(field.get("id"), [])
            if not repeat_rows:
                flowables.append(Paragraph("No rows provided.", styles["muted"]))
                continue
            for index, repeat_row in enumerate(repeat_rows, start=1):
                child_lines = []
                for child in children:
                    if child.get("type") == "section":
                        continue
                    child_value = repeat_row.get(child.get("id")) if isinstance(repeat_row, dict) else None
                    label_text = child.get("label") or label_from_id(child.get("id"))
                    if child.get("type") == "signature" and child_value:
                        signatures.append({"label": f"{label} row {index} - {label_text}", "src": child_value})
                        child_value = "Signed"
                    child_lines.append(f"<b>{h(label_text)}:</b> {pdf_text(child_value)}")
                row_text = f"<b>Row {index}</b><br />" + "<br />".join(child_lines)
                flowables.append(Paragraph(row_text, styles["field_value"]))
            continue

        if field_type == "signature" and value:
            signatures.append({"label": label, "src": value})
            continue

        flowables.append(pdf_field_block(label, value, styles))

    return flowables, signatures


def pdf_form_submission_flowables(item, styles, template):
    title = (
        f"Daywork Log - {item['site_name'] or 'Unassigned site'}"
        if template == "daywork"
        else item["form_name"] or f"Form {item['form_id']}"
    )
    answer_heading = "Daywork details" if template == "daywork" else "Form answers"
    flowables = [
        Paragraph(h(title), styles["title"]),
        pdf_meta_table([
            ("Worker", item["worker_name"]),
            ("Site", item["site_name"] or "Unassigned site"),
            ("Work date", item["work_date"] or "-"),
            ("Status", item["status"]),
            ("Submitted", item["created_at"]),
            ("Submission", f"#{item['id']}"),
            ("Form", item["form_name"] or f"Form {item['form_id']}"),
        ], styles),
        Spacer(1, 8),
        Paragraph(h(answer_heading), styles["section"]),
    ]
    answer_flowables, signatures = pdf_form_answer_flowables(item, styles)
    flowables.extend(answer_flowables or [Paragraph("No answers provided.", styles["muted"])])
    if signatures:
        flowables.extend(pdf_signature_flowables(signatures, styles))
    flowables.extend(pdf_photo_flowables(item, styles))
    flowables.append(Spacer(1, 10))
    flowables.append(Paragraph(
        f"Submitted by {h(item['worker_name'])} | {h(title)} #{h(item['id'])}",
        styles["footer"],
    ))
    return flowables


class NumberedCanvas(Canvas):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._saved_page_states = []

    def showPage(self):
        self._saved_page_states.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        page_count = len(self._saved_page_states)
        for state in self._saved_page_states:
            self.__dict__.update(state)
            self.setFillColor(colors.black)
            self.setFont("Helvetica", 9)
            self.drawRightString(A4[0] - 17 * mm, 8 * mm, f"Page {self._pageNumber} of {page_count}")
            Canvas.showPage(self)
        Canvas.save(self)


def export_daywork_pdf_document(body_flowables: list, filename: str, submitted_by: str):
    buffer = BytesIO()
    logo_bytes = export_logo_bytes()
    page_width, page_height = A4
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        rightMargin=17 * mm,
        leftMargin=17 * mm,
        topMargin=47 * mm,
        bottomMargin=18 * mm,
        title="General Daywork Form",
    )

    def draw_daywork_header(canvas, document):
        canvas.saveState()
        if logo_bytes:
            try:
                reader = ImageReader(BytesIO(logo_bytes))
                image_width, image_height = reader.getSize()
                scale = min((82 * mm) / image_width, (34 * mm) / image_height)
                draw_width = image_width * scale
                draw_height = image_height * scale
                canvas.drawImage(
                    reader,
                    document.leftMargin,
                    page_height - 5 * mm - draw_height,
                    width=draw_width,
                    height=draw_height,
                    preserveAspectRatio=True,
                    mask="auto",
                )
            except Exception:
                canvas.setFillColor(colors.HexColor("#2354a3"))
                canvas.setFont("Helvetica-Bold", 20)
                canvas.drawString(document.leftMargin, page_height - 15 * mm, "LEADER")
                canvas.setFont("Helvetica-Bold", 15)
                canvas.drawString(document.leftMargin, page_height - 23 * mm, "SCAFFOLDING")
        else:
            canvas.setFillColor(colors.HexColor("#2354a3"))
            canvas.setFont("Helvetica-Bold", 20)
            canvas.drawString(document.leftMargin, page_height - 15 * mm, "LEADER")
            canvas.setFont("Helvetica-Bold", 15)
            canvas.drawString(document.leftMargin, page_height - 23 * mm, "SCAFFOLDING")

        canvas.setFillColor(colors.black)
        canvas.setFont("Helvetica", 10.5)
        canvas.drawRightString(page_width - document.rightMargin, page_height - 12 * mm, f"Submitted By: {text_value(submitted_by) or '-'}")
        canvas.setFillColor(DAYWORK_BLUE)
        canvas.setFont("Helvetica-Bold", 14)
        canvas.drawString(document.leftMargin + 1 * mm, page_height - 43 * mm, "General Daywork Form")
        canvas.restoreState()

    doc.build(
        body_flowables,
        onFirstPage=draw_daywork_header,
        onLaterPages=draw_daywork_header,
        canvasmaker=NumberedCanvas,
    )
    return Response(
        buffer.getvalue(),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"'
        },
    )


def export_pdf_document(title: str, subtitle: str, body_flowables: list, filename: str):
    buffer = BytesIO()
    styles = pdf_styles()
    logo_bytes = export_logo_bytes()
    page_width, page_height = A4
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        rightMargin=16 * mm,
        leftMargin=16 * mm,
        topMargin=42 * mm,
        bottomMargin=18 * mm,
        title=title,
    )

    def draw_header_footer(canvas, document):
        canvas.saveState()
        if logo_bytes:
            try:
                reader = ImageReader(BytesIO(logo_bytes))
                image_width, image_height = reader.getSize()
                scale = min((62 * mm) / image_width, (24 * mm) / image_height)
                draw_width = image_width * scale
                draw_height = image_height * scale
                canvas.drawImage(
                    reader,
                    document.leftMargin,
                    page_height - 10 * mm - draw_height,
                    width=draw_width,
                    height=draw_height,
                    preserveAspectRatio=True,
                    mask="auto",
                )
            except Exception:
                canvas.setFillColor(colors.HexColor("#096cf5"))
                canvas.setFont("Helvetica-Bold", 14)
                canvas.drawString(document.leftMargin, page_height - 18 * mm, "Leader Scaffolding")
        else:
            canvas.setFillColor(colors.HexColor("#096cf5"))
            canvas.setFont("Helvetica-Bold", 14)
            canvas.drawString(document.leftMargin, page_height - 18 * mm, "Leader Scaffolding")

        title_style = ParagraphStyle(
            "HeaderTitle",
            parent=styles["body"],
            fontName="Helvetica-Bold",
            fontSize=10,
            leading=12,
            alignment=TA_RIGHT,
        )
        subtitle_style = ParagraphStyle(
            "HeaderSubtitle",
            parent=styles["muted"],
            fontSize=8,
            leading=10,
            alignment=TA_RIGHT,
        )
        header_width = page_width - document.leftMargin - document.rightMargin - 70 * mm
        header_title = Paragraph(h(title), title_style)
        header_subtitle = Paragraph(h(subtitle), subtitle_style)
        header_title.wrapOn(canvas, header_width, 14 * mm)
        header_subtitle.wrapOn(canvas, header_width, 10 * mm)
        header_title.drawOn(canvas, document.leftMargin + 70 * mm, page_height - 17 * mm)
        header_subtitle.drawOn(canvas, document.leftMargin + 70 * mm, page_height - 23 * mm)
        canvas.setStrokeColor(colors.HexColor("#096cf5"))
        canvas.setLineWidth(1.2)
        canvas.line(document.leftMargin, page_height - 36 * mm, page_width - document.rightMargin, page_height - 36 * mm)
        canvas.setFillColor(colors.HexColor("#5b6472"))
        canvas.setFont("Helvetica", 7)
        canvas.drawRightString(page_width - document.rightMargin, 8 * mm, f"Page {document.page}")
        canvas.restoreState()

    doc.build(body_flowables, onFirstPage=draw_header_footer, onLaterPages=draw_header_footer)
    return Response(
        buffer.getvalue(),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"'
        },
    )


def form_submission_pdf_items(
    session: Session,
    supervisor: User,
    status: Optional[str],
    template: str,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    form_id: Optional[int] = None,
    department_id: Optional[int] = None,
):
    records = session.exec(select_work_form_submissions(status, supervisor)).all()
    records = filter_records_by_department(records, session, supervisor, department_id)
    records = filter_form_records(records, session, supervisor, form_id)
    records = filter_records_by_date(records, date_from, date_to)
    items = [
        review_record_response("form", record, session)
        for record in records
    ]
    if template == "daywork":
        return [item for item in items if is_daywork_submission(item)]
    return items


def export_form_submissions_html(
    session: Session,
    supervisor: User,
    status: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    form_id: Optional[int] = None,
    department_id: Optional[int] = None,
):
    records = session.exec(select_work_form_submissions(status, supervisor)).all()
    records = filter_records_by_department(records, session, supervisor, department_id)
    records = filter_form_records(records, session, supervisor, form_id)
    records = filter_records_by_date(records, date_from, date_to)
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


def export_form_submissions_pdf(
    session: Session,
    supervisor: User,
    template: str = "submitted-form",
    status: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    form_id: Optional[int] = None,
    department_id: Optional[int] = None,
):
    template = normalize_form_pdf_template(template)
    items = form_submission_pdf_items(
        session,
        supervisor,
        status,
        template,
        date_from,
        date_to,
        form_id,
        department_id,
    )
    if template == "daywork":
        styles = daywork_pdf_styles()
        story = []
        for index, item in enumerate(items):
            if index:
                story.append(PageBreak())
            story.extend(pdf_daywork_submission_flowables(item, styles))

        if not story:
            story = [Paragraph("No Daywork submissions found", styles["heading"])]

        filename = "daywork-submissions.pdf" if not status else f"daywork-submissions-{status}.pdf"
        submitted_by = daywork_submitted_by(items[0]) if len(items) == 1 else "Multiple submitters"
        return export_daywork_pdf_document(story, filename, submitted_by)

    styles = pdf_styles()
    story = []

    for index, item in enumerate(items):
        if index:
            story.append(PageBreak())
        story.extend(pdf_form_submission_flowables(item, styles, template))

    if not story:
        empty_label = "No Daywork submissions found" if template == "daywork" else "No form submissions found"
        story = [Paragraph(empty_label, styles["title"])]

    title = "Daywork PDF Export" if template == "daywork" else "Submitted Work Forms PDF"
    subtitle = f"{len(items)} {'Daywork' if template == 'daywork' else 'form submission'} records"
    filename_prefix = "daywork-submissions" if template == "daywork" else "work-form-submissions"
    filename = f"{filename_prefix}.pdf" if not status else f"{filename_prefix}-{status}.pdf"
    return export_pdf_document(title, subtitle, story, filename)


def export_form_submission_html(submission_id: int, session: Session, supervisor: User):
    record = session.get(WorkFormSubmission, submission_id)
    if (
        not record
        or record.deleted_at is not None
        or not can_access_department(supervisor, record.department_id)
    ):
        raise HTTPException(status_code=404, detail="Form submission not found")

    item = review_record_response("form", record, session)
    return export_document(
        item["form_name"] or "Work Form Submission",
        f"Form submission #{item['id']}",
        render_form_submission_page(item),
        f"work-form-submission-{item['id']}.html",
    )


def export_form_submission_pdf(
    submission_id: int,
    session: Session,
    supervisor: User,
    template: str = "submitted-form",
):
    template = normalize_form_pdf_template(template)
    record = session.get(WorkFormSubmission, submission_id)
    if (
        not record
        or record.deleted_at is not None
        or not can_access_department(supervisor, record.department_id)
    ):
        raise HTTPException(status_code=404, detail="Form submission not found")

    item = review_record_response("form", record, session)
    if template == "daywork" and not is_daywork_submission(item):
        raise HTTPException(status_code=400, detail="Submission is not a Daywork form")

    filename_prefix = "daywork-submission" if template == "daywork" else "work-form-submission"
    if template == "daywork":
        daywork_styles = daywork_pdf_styles()
        story = pdf_daywork_submission_flowables(item, daywork_styles)
        return export_daywork_pdf_document(
            story,
            f"{filename_prefix}-{item['id']}.pdf",
            daywork_submitted_by(item),
        )

    styles = pdf_styles()
    title = item["form_name"] or "Work Form Submission"
    subtitle = f"Form submission #{item['id']}"
    story = pdf_form_submission_flowables(item, styles, template)
    return export_pdf_document(
        title,
        subtitle,
        story,
        f"{filename_prefix}-{item['id']}.pdf",
    )


def list_pending_attendance_records(session: Session, supervisor: User):
    records = session.exec(
        select_attendance_records("pending", supervisor)
    ).all()

    return [
        attendance_record_response(record, session)
        for record in records
    ]


def list_supervisor_attendance_records(session: Session, supervisor: User, status: Optional[str] = None):
    records = session.exec(
        select_attendance_records(status, supervisor)
    ).all()

    return [
        attendance_record_response(record, session)
        for record in records
    ]


def create_manual_attendance_record(data, supervisor: User, session: Session):
    require_confirmed(data.confirmed)
    if data.record_type not in ["check_in", "check_out"]:
        raise HTTPException(status_code=400, detail="record_type must be check_in or check_out")

    worker = session.get(User, data.worker_id)
    if (
        not worker
        or worker.role != "worker"
        or not can_access_department(supervisor, worker.department_id)
    ):
        raise HTTPException(status_code=404, detail="Worker not found")

    site = ensure_site_exists(session, data.site_id, supervisor)
    if not site or site.department_id != worker.department_id:
        raise HTTPException(status_code=400, detail="Site must belong to the worker's department")

    if data.occurred_at.tzinfo is None:
        raise HTTPException(status_code=400, detail="occurred_at must include a timezone")
    occurred_at = data.occurred_at.astimezone(timezone.utc)
    if occurred_at > datetime.now(timezone.utc) + timedelta(minutes=5):
        raise HTTPException(status_code=400, detail="Attendance time cannot be in the future")

    note = data.note.strip()
    if len(note) < 3:
        raise HTTPException(status_code=400, detail="A reason for the manual attendance entry is required")

    record = AttendanceRecord(
        department_id=worker.department_id,
        worker_id=worker.id,
        site_id=site.id,
        record_type=data.record_type,
        latitude=None,
        longitude=None,
        accuracy=None,
        distance_from_site_m=None,
        within_site_radius=None,
        note=note,
        status="approved",
        entry_source="supervisor_manual",
        created_by_supervisor_id=supervisor.id,
        created_at=occurred_at,
    )
    session.add(record)
    session.flush()
    add_audit_event(
        session=session,
        actor=supervisor,
        action="attendance_manual_create",
        entity_type="attendance",
        entity_id=record.id,
        after=model_snapshot(record),
        summary=f"Added manual {data.record_type.replace('_', ' ')} for {worker.name}",
        department_id=worker.department_id,
    )
    session.commit()
    session.refresh(record)

    return attendance_record_response(record, session)


def update_supervisor_attendance_record(record_id: int, data, supervisor: User, session: Session):
    require_confirmed(data.confirmed)
    record = session.get(AttendanceRecord, record_id)

    if (
        not record
        or record.deleted_at is not None
        or not can_access_department(supervisor, record.department_id)
    ):
        raise HTTPException(status_code=404, detail="Record not found")

    previous_upload_urls = record_upload_urls(record)
    fields = data.model_fields_set
    enforce_review_status_unchanged(record, data.status, fields)
    before = model_snapshot(record)

    if "record_type" in fields and data.record_type is not None:
        if data.record_type not in ["check_in", "check_out"]:
            raise HTTPException(status_code=400, detail="record_type must be check_in or check_out")
        record.record_type = data.record_type
    if "site_id" in fields:
        site = ensure_site_exists(session, data.site_id, supervisor)
        if site and site.department_id != record.department_id:
            raise HTTPException(status_code=400, detail="Site must belong to the record department")
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
        validate_owned_upload_references(
            data.photo_url,
            supervisor,
            session,
            already_attached=previous_upload_urls,
        )
        record.photo_url = data.photo_url
    site = ensure_site_exists(session, record.site_id, supervisor)
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
        department_id=record.department_id,
    )
    session.commit()
    session.refresh(record)
    cleanup_detached_record_uploads(previous_upload_urls, record, session)

    return attendance_record_response(record, session)


def export_attendance_records_csv(
    session: Session,
    supervisor: User,
    status: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    department_id: Optional[int] = None,
):
    records = session.exec(select_attendance_records(status, supervisor)).all()
    records = filter_records_by_department(records, session, supervisor, department_id)
    records = filter_records_by_date(records, date_from, date_to)
    output = StringIO()
    writer = csv.writer(output)
    write_spreadsheet_safe_csv_row(writer, [
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
        "entry_source",
        "created_by_supervisor_id",
        "created_by_supervisor_name",
    ])

    for record in records:
        item = attendance_record_response(record, session)
        write_spreadsheet_safe_csv_row(writer, [
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
            item["entry_source"],
            item["created_by_supervisor_id"],
            item["created_by_supervisor_name"],
        ])

    filename = "attendance-records.csv" if not status else f"attendance-records-{status}.csv"

    return Response(
        output.getvalue(),
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"'
        }
    )


def list_supervisor_task_logs(session: Session, supervisor: User, status: Optional[str] = None):
    records = session.exec(
        select_task_logs(status, supervisor)
    ).all()

    return [
        task_log_response(record, session)
        for record in records
    ]


def create_supervisor_task_log(data, supervisor: User, session: Session):
    require_confirmed(data.confirmed)
    target_user = session.get(User, data.user_id)
    if not target_user or not can_access_department(supervisor, target_user.department_id):
        raise HTTPException(status_code=404, detail="User not found")

    site = ensure_site_exists(session, data.site_id, supervisor)
    if not site or site.department_id != target_user.department_id:
        raise HTTPException(status_code=400, detail="Site must belong to the selected user's department")

    description = data.description.strip()
    if not description:
        raise HTTPException(status_code=400, detail="Task description is required")

    log = TaskLog(
        department_id=target_user.department_id,
        worker_id=target_user.id,
        site_id=site.id,
        description=description,
        work_date=data.work_date,
        hours_worked=data.hours_worked,
        safety_notes=data.safety_notes.strip() if data.safety_notes else None,
        status="approved",
        entry_source="supervisor_manual",
        created_by_supervisor_id=supervisor.id,
    )
    session.add(log)
    session.flush()
    add_audit_event(
        session=session,
        actor=supervisor,
        action="task_log_manual_create",
        entity_type="task_log",
        entity_id=log.id,
        after=model_snapshot(log),
        summary=f"Added approved task log for {target_user.name}",
        department_id=target_user.department_id,
    )
    session.commit()
    session.refresh(log)
    return task_log_response(log, session)


def create_supervisor_work_form_submission(data, supervisor: User, session: Session):
    require_confirmed(data.confirmed)
    target_user = session.get(User, data.user_id)
    if not target_user or not can_access_department(supervisor, target_user.department_id):
        raise HTTPException(status_code=404, detail="User not found")

    form = session.get(WorkForm, data.form_id)
    if not form or form.status != "active" or not can_access_department(supervisor, form.department_id):
        raise HTTPException(status_code=404, detail="Form not found")
    if form.department_id != target_user.department_id:
        raise HTTPException(status_code=400, detail="Form must belong to the selected user's department")

    site = ensure_site_exists(session, data.site_id, supervisor) if data.site_id else None
    if site and site.department_id != target_user.department_id:
        raise HTTPException(status_code=400, detail="Site must belong to the selected user's department")

    definition = work_form_definition(form)
    answers = validate_work_form_answers(definition, data.answers)
    validate_owned_upload_references(
        work_form_upload_references(definition, answers),
        supervisor,
        session,
    )
    submission = WorkFormSubmission(
        department_id=target_user.department_id,
        form_id=form.id,
        worker_id=target_user.id,
        site_id=site.id if site else None,
        work_date=data.work_date,
        answers_json=json.dumps(answers),
        form_definition_version=definition["version"],
        definition_snapshot_json=work_form_definition_snapshot_json(form),
        status="approved",
    )
    session.add(submission)
    session.flush()
    add_audit_event(
        session=session,
        actor=supervisor,
        action="form_submission_manual_create",
        entity_type="form_submission",
        entity_id=submission.id,
        after=model_snapshot(submission),
        summary=f"Added approved {form.name} submission for {target_user.name}",
        department_id=target_user.department_id,
    )
    session.commit()
    session.refresh(submission)
    return work_form_submission_response(submission, session)


def task_logs_csv_response(items, filename: str):
    output = StringIO()
    writer = csv.writer(output)
    write_spreadsheet_safe_csv_row(writer, [
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
        "entry_source",
        "created_by_supervisor_id",
        "created_by_supervisor_name",
        "status",
        "created_at",
    ])

    for item in items:
        write_spreadsheet_safe_csv_row(writer, [
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
            item["entry_source"],
            item["created_by_supervisor_id"],
            item["created_by_supervisor_name"],
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


def export_task_logs_csv(
    session: Session,
    supervisor: User,
    status: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    department_id: Optional[int] = None,
):
    records = session.exec(select_task_logs(status, supervisor)).all()
    records = filter_records_by_department(records, session, supervisor, department_id)
    records = filter_records_by_date(records, date_from, date_to)
    items = [task_log_response(record, session) for record in records]
    filename = "task-logs.csv" if not status else f"task-logs-{status}.csv"
    return task_logs_csv_response(items, filename)


def export_task_log_csv(log_id: int, session: Session, supervisor: User):
    record = session.get(TaskLog, log_id)
    if (
        not record
        or record.deleted_at is not None
        or not can_access_department(supervisor, record.department_id)
    ):
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
            if field.get("type") == "section" or field.get("repeat"):
                continue
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
    if isinstance(value, dict):
        return text_value(value)
    if isinstance(value, list):
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
    write_spreadsheet_safe_csv_row(writer, [
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
        write_spreadsheet_safe_csv_row(writer, [
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


def export_form_submissions_csv(
    session: Session,
    supervisor: User,
    status: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    form_id: Optional[int] = None,
    department_id: Optional[int] = None,
):
    records = session.exec(select_work_form_submissions(status, supervisor)).all()
    records = filter_records_by_department(records, session, supervisor, department_id)
    records = filter_form_records(records, session, supervisor, form_id)
    records = filter_records_by_date(records, date_from, date_to)
    items = [
        review_record_response("form", record, session)
        for record in records
    ]
    filename = "work-form-submissions.csv" if not status else f"work-form-submissions-{status}.csv"
    return form_submissions_csv_response(items, filename)


def export_form_submission_csv(submission_id: int, session: Session, supervisor: User):
    record = session.get(WorkFormSubmission, submission_id)
    if (
        not record
        or record.deleted_at is not None
        or not can_access_department(supervisor, record.department_id)
    ):
        raise HTTPException(status_code=404, detail="Form submission not found")

    item = review_record_response("form", record, session)
    return form_submissions_csv_response([item], f"work-form-submission-{item['id']}.csv")


def update_supervisor_form_submission(submission_id: int, data, supervisor: User, session: Session):
    require_confirmed(data.confirmed)
    submission = session.get(WorkFormSubmission, submission_id)

    if (
        not submission
        or submission.deleted_at is not None
        or not can_access_department(supervisor, submission.department_id)
    ):
        raise HTTPException(status_code=404, detail="Form submission not found")

    definition = work_form_submission_definition(submission, session)

    previous_upload_urls = record_upload_urls(submission)
    fields = data.model_fields_set
    enforce_review_status_unchanged(submission, data.status, fields)
    before = model_snapshot(submission)

    if "site_id" in fields:
        site = ensure_site_exists(session, data.site_id, supervisor)
        if site and site.department_id != submission.department_id:
            raise HTTPException(status_code=400, detail="Site must belong to the submission department")
        submission.site_id = data.site_id
    if "work_date" in fields:
        submission.work_date = data.work_date
    if "answers" in fields and data.answers is not None:
        answers = validate_work_form_answers(definition, data.answers)
        validate_owned_upload_references(
            work_form_upload_references(definition, answers),
            supervisor,
            session,
            already_attached=previous_upload_urls,
        )
        submission.answers_json = json.dumps(answers)
    if "photo_urls" in fields and data.photo_urls is not None:
        photo_urls = normalize_work_form_photo_urls(data.photo_urls)
        validate_owned_upload_references(
            photo_urls,
            supervisor,
            session,
            already_attached=previous_upload_urls,
        )
        submission.photo_urls = json.dumps(photo_urls) if photo_urls else None
    session.add(submission)
    add_audit_event(
        session=session,
        actor=supervisor,
        action="form_submission_update",
        entity_type="form",
        entity_id=submission.id,
        before=before,
        after=model_snapshot(submission),
        summary=f"Updated form submission #{submission.id}",
        department_id=submission.department_id,
    )
    session.commit()
    session.refresh(submission)
    cleanup_detached_record_uploads(previous_upload_urls, submission, session)

    return work_form_submission_response(submission, session)


def update_supervisor_task_log(log_id: int, data, supervisor: User, session: Session):
    require_confirmed(data.confirmed)
    log = session.get(TaskLog, log_id)

    if (
        not log
        or log.deleted_at is not None
        or not can_access_department(supervisor, log.department_id)
    ):
        raise HTTPException(status_code=404, detail="Task log not found")

    previous_upload_urls = record_upload_urls(log)
    fields = data.model_fields_set
    enforce_review_status_unchanged(log, data.status, fields)
    before = model_snapshot(log)
    if "description" in fields and data.description is not None:
        log.description = data.description
    if "site_id" in fields:
        site = ensure_site_exists(session, data.site_id, supervisor)
        if site and site.department_id != log.department_id:
            raise HTTPException(status_code=400, detail="Site must belong to the task log department")
        log.site_id = data.site_id
    if "work_date" in fields:
        log.work_date = data.work_date
    if "hours_worked" in fields:
        log.hours_worked = data.hours_worked
    if "safety_notes" in fields:
        log.safety_notes = data.safety_notes
    if "photo_urls" in fields:
        photo_urls = normalize_task_photo_urls(None, data.photo_urls or [])
        validate_owned_upload_references(
            photo_urls,
            supervisor,
            session,
            already_attached=previous_upload_urls,
        )
        log.photo_url = photo_urls[0] if photo_urls else None
        log.photo_urls = json.dumps(photo_urls) if photo_urls else None
    elif "photo_url" in fields:
        validate_photo_url(data.photo_url)
        validate_owned_upload_references(
            data.photo_url,
            supervisor,
            session,
            already_attached=previous_upload_urls,
        )
        log.photo_url = data.photo_url
        log.photo_urls = json.dumps([data.photo_url]) if data.photo_url else None
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
        department_id=log.department_id,
    )
    session.commit()
    session.refresh(log)
    cleanup_detached_record_uploads(previous_upload_urls, log, session)

    return task_log_response(log, session)


def update_supervisor_team_work_log(log_id: int, data, supervisor: User, session: Session):
    require_confirmed(data.confirmed)
    log = session.get(TeamWorkLog, log_id)

    if (
        not log
        or log.deleted_at is not None
        or not can_access_department(supervisor, log.department_id)
    ):
        raise HTTPException(status_code=404, detail="Team work log not found")

    fields = data.model_fields_set
    enforce_review_status_unchanged(log, data.status, fields)
    before = model_snapshot(log)
    week_start = data.week_start if "week_start" in fields and data.week_start is not None else log.week_start

    if "entries" in fields and data.entries is not None:
        prepared_entries = prepare_team_work_log_entries(
            data.entries,
            log.department_id,
            week_start,
            session,
            allow_inactive_workers=True,
        )
        existing_entries = session.exec(
            select(TeamWorkLogEntry).where(TeamWorkLogEntry.team_work_log_id == log.id)
        ).all()
        for entry in existing_entries:
            session.delete(entry)
        session.flush()
        for entry in prepared_entries:
            session.add(TeamWorkLogEntry(team_work_log_id=log.id, **entry))
    elif "week_start" in fields and data.week_start is not None:
        existing_entries = session.exec(
            select(TeamWorkLogEntry).where(TeamWorkLogEntry.team_work_log_id == log.id)
        ).all()
        prepare_team_work_log_entries(
            existing_entries,
            log.department_id,
            week_start,
            session,
            allow_inactive_workers=True,
        )

    if "week_start" in fields and data.week_start is not None:
        log.week_start = data.week_start
    if "notes" in fields:
        log.notes = data.notes.strip() if data.notes else None
    session.add(log)
    add_audit_event(
        session=session,
        actor=supervisor,
        action="team_log_update",
        entity_type="team_log",
        entity_id=log.id,
        before=before,
        after=model_snapshot(log),
        summary=f"Updated team work log #{log.id}",
        department_id=log.department_id,
    )
    session.commit()
    session.refresh(log)

    return review_record_response("team_log", log, session)
