import base64
import csv
import html
import json
from io import BytesIO, StringIO
from typing import Optional
from urllib.parse import urlparse

from fastapi import HTTPException
from fastapi.responses import Response
from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.platypus import Image as ReportLabImage
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from sqlmodel import Session, select

from app.config import ROOT_DIR
from app.models import AttendanceRecord, TaskLog, User, WorkFormSubmission
from app.upload_storage import load_upload
from app.use_cases.audit import add_audit_event, model_snapshot
from app.use_cases.common import (
    attendance_record_response,
    can_access_department,
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
VALID_FORM_PDF_TEMPLATES = {"submitted-form", "daywork"}
EXPORT_LOGO_CANDIDATES = [
    ROOT_DIR / "assets" / "icons" / "leader-logo-export.png",
    ROOT_DIR / "assets" / "icons" / "leader-logo-export.webp",
    ROOT_DIR / "assets" / "icons" / "leader-logo-export.jpg",
    ROOT_DIR / "assets" / "icons" / "leader-logo-export.jpeg",
    ROOT_DIR / "assets" / "icons" / "leader-logo-export.svg",
    ROOT_DIR / "assets" / "icons" / "leader-logo.png",
    ROOT_DIR / "assets" / "icons" / "leader-logo.svg",
]
EXPORT_LOGO_MIME_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
}


def text_value(value):
    if value is None:
        return ""
    if value is True:
        return "Yes"
    if value is False:
        return "No"
    if isinstance(value, dict):
        if value.get("start") or value.get("end"):
            label = f"{value.get('start') or '-'} to {value.get('end') or '-'}"
            if value.get("duration_hours") not in (None, ""):
                label += f" ({value.get('duration_hours')}h)"
            return label
        return ", ".join(f"{label_from_id(key)}: {text_value(item)}" for key, item in value.items())
    if isinstance(value, list):
        return "; ".join(text_value(item) for item in value)
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


def export_logo_src():
    for logo_path in EXPORT_LOGO_CANDIDATES:
        if not logo_path.exists():
            continue

        mime_type = EXPORT_LOGO_MIME_TYPES.get(logo_path.suffix.lower())
        if not mime_type:
            continue

        try:
            encoded = base64.b64encode(logo_path.read_bytes()).decode("ascii")
        except OSError:
            continue

        return f"data:{mime_type};base64,{encoded}"

    return ""


def export_logo_bytes():
    for logo_path in EXPORT_LOGO_CANDIDATES:
        if not logo_path.exists() or logo_path.suffix.lower() == ".svg":
            continue

        try:
            return logo_path.read_bytes()
        except OSError:
            continue

    return None


def image_bytes_from_value(value: str):
    if not isinstance(value, str) or not value:
        return None

    if value.startswith("data:image/") and ";base64," in value:
        try:
            return base64.b64decode(value.split(";base64,", 1)[1])
        except (ValueError, TypeError):
            return None

    filename = upload_filename_from_url(value)
    if not filename:
        return None

    try:
        upload = load_upload(filename)
    except ValueError:
        return None

    if not upload or not upload.content_type.startswith("image/"):
        return None

    return upload.content


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


def photo_caption(index, metadata):
    item = metadata[index - 1] if index - 1 < len(metadata or []) else {}
    taken_at = item.get("taken_at") or item.get("last_modified_iso") if isinstance(item, dict) else ""
    name = item.get("name") if isinstance(item, dict) else ""
    parts = [f"Photo {index}"]
    if taken_at:
        parts.append(f"Taken {taken_at}")
    if name:
        parts.append(name)
    return " | ".join(parts)


def render_photo_grid(urls, empty_text="No photos attached.", metadata=None):
    if not urls:
        return f"<p class=\"muted\">{h(empty_text)}</p>"

    photos = []
    for index, url in enumerate(urls, start=1):
        photos.append(
            "<figure class=\"photo-frame\">"
            f"<img src=\"{h(export_image_src(url))}\" alt=\"Photo {index}\" />"
            f"<figcaption>{h(photo_caption(index, metadata or []))}</figcaption>"
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


def export_task_logs_html(session: Session, supervisor: User, layout: str = "daily-log", status: Optional[str] = None):
    layout = (layout or "daily-log").strip().lower()
    if layout not in VALID_TASK_LOG_HTML_LAYOUTS:
        raise HTTPException(status_code=400, detail="layout must be daily-log or photo-report")

    records = session.exec(select_task_logs(status, supervisor)).all()
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
    if not record or not can_access_department(supervisor, record.department_id):
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


def form_submission_pdf_items(session: Session, supervisor: User, status: Optional[str], template: str):
    records = session.exec(select_work_form_submissions(status, supervisor)).all()
    items = [
        review_record_response("form", record, session)
        for record in records
    ]
    if template == "daywork":
        return [item for item in items if is_daywork_submission(item)]
    return items


def export_form_submissions_html(session: Session, supervisor: User, status: Optional[str] = None):
    records = session.exec(select_work_form_submissions(status, supervisor)).all()
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
):
    template = normalize_form_pdf_template(template)
    items = form_submission_pdf_items(session, supervisor, status, template)
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
    if not record or not can_access_department(supervisor, record.department_id):
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
    if not record or not can_access_department(supervisor, record.department_id):
        raise HTTPException(status_code=404, detail="Form submission not found")

    item = review_record_response("form", record, session)
    if template == "daywork" and not is_daywork_submission(item):
        raise HTTPException(status_code=400, detail="Submission is not a Daywork form")

    styles = pdf_styles()
    title = "Daywork Log PDF" if template == "daywork" else item["form_name"] or "Work Form Submission"
    subtitle = f"Form submission #{item['id']}"
    story = pdf_form_submission_flowables(item, styles, template)
    filename_prefix = "daywork-submission" if template == "daywork" else "work-form-submission"
    return export_pdf_document(
        title,
        subtitle,
        story,
        f"{filename_prefix}-{item['id']}.pdf",
    )


def list_review_records(session: Session, supervisor: User, status: Optional[str] = None):
    rows = []
    rows.extend(
        ("attendance", record)
        for record in session.exec(select_attendance_records(status, supervisor)).all()
    )
    rows.extend(
        ("task", record)
        for record in session.exec(select_task_logs(status, supervisor)).all()
    )
    rows.extend(
        ("form", record)
        for record in session.exec(select_work_form_submissions(status, supervisor)).all()
    )
    rows.sort(key=lambda row: row[1].created_at, reverse=True)

    return [
        review_record_response(record_kind, record, session)
        for record_kind, record in rows
    ]


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


def update_supervisor_attendance_record(record_id: int, data, supervisor: User, session: Session):
    require_confirmed(data.confirmed)
    record = session.get(AttendanceRecord, record_id)

    if not record or not can_access_department(supervisor, record.department_id):
        raise HTTPException(status_code=404, detail="Record not found")

    fields = data.model_fields_set
    before = model_snapshot(record)

    if "record_type" in fields and data.record_type is not None:
        if data.record_type not in ["check_in", "check_out"]:
            raise HTTPException(status_code=400, detail="record_type must be check_in or check_out")
        record.record_type = data.record_type
    if "site_id" in fields:
        ensure_site_exists(session, data.site_id, supervisor)
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
    )
    session.commit()
    session.refresh(record)

    return attendance_record_response(record, session)


def export_attendance_records_csv(session: Session, supervisor: User, status: Optional[str] = None):
    records = session.exec(
        select_attendance_records(status, supervisor)
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


def list_supervisor_task_logs(session: Session, supervisor: User, status: Optional[str] = None):
    records = session.exec(
        select_task_logs(status, supervisor)
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


def export_task_logs_csv(session: Session, supervisor: User, status: Optional[str] = None):
    records = session.exec(
        select_task_logs(status, supervisor)
    ).all()
    items = [task_log_response(record, session) for record in records]
    filename = "task-logs.csv" if not status else f"task-logs-{status}.csv"
    return task_logs_csv_response(items, filename)


def export_task_log_csv(log_id: int, session: Session, supervisor: User):
    record = session.get(TaskLog, log_id)
    if not record or not can_access_department(supervisor, record.department_id):
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


def export_form_submission_csv(submission_id: int, session: Session, supervisor: User):
    record = session.get(WorkFormSubmission, submission_id)
    if not record or not can_access_department(supervisor, record.department_id):
        raise HTTPException(status_code=404, detail="Form submission not found")

    item = review_record_response("form", record, session)
    return form_submissions_csv_response([item], f"work-form-submission-{item['id']}.csv")


def update_supervisor_task_log(log_id: int, data, supervisor: User, session: Session):
    require_confirmed(data.confirmed)
    log = session.get(TaskLog, log_id)

    if not log or not can_access_department(supervisor, log.department_id):
        raise HTTPException(status_code=404, detail="Task log not found")

    fields = data.model_fields_set
    before = model_snapshot(log)
    if "description" in fields and data.description is not None:
        log.description = data.description
    if "site_id" in fields:
        ensure_site_exists(session, data.site_id, supervisor)
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

        if not record or not can_access_department(supervisor, record.department_id):
            raise HTTPException(status_code=404, detail="Record not found")
    elif record_type == "task":
        record = session.get(TaskLog, record_id)

        if not record or not can_access_department(supervisor, record.department_id):
            raise HTTPException(status_code=404, detail="Task log not found")
    else:
        record = session.get(WorkFormSubmission, record_id)

        if not record or not can_access_department(supervisor, record.department_id):
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
