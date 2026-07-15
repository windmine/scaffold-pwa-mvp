import base64
import html
from datetime import date, datetime, timezone
from typing import Optional
from urllib.parse import urlparse

from fastapi import HTTPException
from sqlmodel import Session

from app.config import BUSINESS_TIMEZONE, ROOT_DIR
from app.models import Department, User, WorkForm
from app.upload_storage import load_upload
from app.use_cases.common import can_access_department


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
SPREADSHEET_FORMULA_PREFIXES = ("=", "+", "-", "@")
SPREADSHEET_CONTROL_PREFIXES = ("\t", "\r", "\n")


def spreadsheet_safe_csv_cell(value):
    """Neutralize text that spreadsheet programs may evaluate as a formula."""
    if not isinstance(value, str) or not value:
        return value

    first_visible = value.lstrip(" \t\r\n")
    if value.startswith(SPREADSHEET_CONTROL_PREFIXES) or first_visible.startswith(
        SPREADSHEET_FORMULA_PREFIXES
    ):
        return f"'{value}"
    return value


def write_spreadsheet_safe_csv_row(writer, values):
    writer.writerow([spreadsheet_safe_csv_cell(value) for value in values])


def parse_export_date(value: Optional[str], label: str):
    if not value:
        return None

    try:
        return date.fromisoformat(value)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{label} must use YYYY-MM-DD")


def export_date_filters(date_from: Optional[str] = None, date_to: Optional[str] = None):
    start = parse_export_date(date_from, "date_from")
    end = parse_export_date(date_to, "date_to")
    if start and end and start > end:
        raise HTTPException(status_code=400, detail="date_from must be before or equal to date_to")
    return start, end


def record_export_date(record):
    work_date = getattr(record, "work_date", None)
    if work_date:
        try:
            return date.fromisoformat(work_date)
        except ValueError:
            pass

    created_at = getattr(record, "created_at", None)
    if isinstance(created_at, datetime):
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
        return created_at.astimezone(BUSINESS_TIMEZONE).date()
    if isinstance(created_at, date):
        return created_at

    return None


def filter_records_by_date(records, date_from: Optional[str] = None, date_to: Optional[str] = None):
    start, end = export_date_filters(date_from, date_to)
    if not start and not end:
        return records

    filtered = []
    for record in records:
        record_date = record_export_date(record)
        if record_date is None:
            continue
        if start and record_date < start:
            continue
        if end and record_date > end:
            continue
        filtered.append(record)

    return filtered


def filter_records_by_department(
    records,
    session: Session,
    supervisor: User,
    department_id: Optional[int] = None,
):
    if department_id is None:
        return records

    department = session.get(Department, department_id)
    if not department or not can_access_department(supervisor, department_id):
        raise HTTPException(status_code=404, detail="Department not found")

    return [record for record in records if record.department_id == department_id]


def filter_form_records(records, session: Session, supervisor: User, form_id: Optional[int] = None):
    if form_id is None:
        return records

    form = session.get(WorkForm, form_id)
    if not form or not can_access_department(supervisor, form.department_id):
        raise HTTPException(status_code=404, detail="Form not found")

    return [record for record in records if record.form_id == form_id]


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
