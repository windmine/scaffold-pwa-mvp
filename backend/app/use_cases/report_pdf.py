"""Print saved Reports as branded A4 forms, without changing their evidence.

Callers supply already-authorized, snapshot-backed export records. Image loading
stays with Upload Storage; the renderer never resolves arbitrary remote URLs.
"""
from io import BytesIO

from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import (
    BaseDocTemplate, Frame, Image, NextPageTemplate, PageBreak, PageTemplate,
    Paragraph, Spacer, Table, TableStyle,
)

from app.use_cases.report_pdf_branding import report_department_branding
from app.use_cases.supervisor_review_exports import (
    h, image_bytes_from_value, label_from_id, photo_caption, text_value,
)


PAGE_WIDTH, PAGE_HEIGHT = A4
MARGIN = 50
CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN
LABEL_WIDTH = CONTENT_WIDTH * 0.30
VALUE_WIDTH = CONTENT_WIDTH - LABEL_WIDTH
BLUE = colors.HexColor("#1955a0")
INK = colors.HexColor("#353a40")
GRID = colors.HexColor("#c6c9cd")
LABEL_FILL = colors.HexColor("#eeeeee")


def _styles():
    body = ParagraphStyle(
        "report-body", fontName="Helvetica", fontSize=9, leading=12,
        textColor=INK, splitLongWords=True, spaceAfter=0,
    )
    return {
        "body": body,
        "label": ParagraphStyle("report-label", parent=body, fontName="Helvetica-Bold"),
        "section": ParagraphStyle(
            "report-section", parent=body, fontName="Helvetica-Bold", fontSize=12,
            leading=15, textColor=BLUE, spaceBefore=12, spaceAfter=6, keepWithNext=True,
        ),
        "title": ParagraphStyle(
            "report-title", parent=body, fontName="Helvetica-Bold", fontSize=15,
            leading=18, textColor=BLUE,
        ),
        "muted": ParagraphStyle(
            "report-muted", parent=body, fontSize=8, leading=10,
            textColor=colors.HexColor("#656b72"),
        ),
        "submitter": ParagraphStyle(
            "report-submitter", parent=body, fontSize=8, leading=11, alignment=TA_RIGHT,
        ),
    }


def _paragraph(value, style):
    return Paragraph(h(value).replace("\n", "<br />") or "&#160;", style)


def _row(label, value, styles, *, minimum_height=None):
    """Allow large labels/answers to continue inside a row on the next page."""
    cell = value if isinstance(value, list) else _paragraph(value, styles["body"])
    table = Table(
        [[_paragraph(label, styles["label"]), cell]],
        colWidths=[LABEL_WIDTH, VALUE_WIDTH], hAlign="LEFT",
        minRowHeights=[minimum_height] if minimum_height else None,
        splitByRow=1, splitInRow=1,
    )
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, -1), LABEL_FILL),
        ("GRID", (0, 0), (-1, -1), 0.45, GRID),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return table


def _image(value, image_loader, max_height):
    try:
        content = image_loader(value)
        if not content:
            return None
        width, height = ImageReader(BytesIO(content)).getSize()
        scale = min((VALUE_WIDTH - 16) / width, max_height / height)
        result = Image(BytesIO(content), width=width * scale, height=height * scale)
        result.hAlign = "LEFT"
        return result
    except Exception:
        # Missing or damaged evidence must be visible, not silently dropped.
        return None


def _answer_rows(fields, answers, styles, image_loader):
    children = {}
    for field in fields:
        if field.get("repeat"):
            children.setdefault(field["repeat"], []).append(field)

    def render(entries, values):
        result = []
        # Pair once, not in both directions: chaining every signature/name block
        # into one oversized KeepTogether can itself separate names at a break.
        pair_starts = set()
        pair_index = 0
        while pair_index + 1 < len(entries):
            first, second = entries[pair_index:pair_index + 2]
            kinds = (first.get("type"), second.get("type"))
            other = second if kinds[0] == "signature" else first
            if (
                kinds.count("signature") == 1
                and other.get("type") not in ("section", "repeat")
                and len(text_value(values.get(other.get("id")))) < 200
                and len(text_value(other.get("label"))) < 200
            ):
                pair_starts.add(pair_index)
                pair_index += 2
            else:
                pair_index += 1
        for index, field in enumerate(entries):
            field_id = field.get("id")
            label = field.get("label") or label_from_id(field_id)
            kind = field.get("type")
            value = values.get(field_id)
            if kind == "section":
                result.append(_paragraph(label, styles["section"]))
            elif kind == "repeat":
                result.append(_paragraph(label, styles["section"]))
                rows = value if isinstance(value, list) else []
                if not rows:
                    result.append(_row("Entries", "No rows provided.", styles))
                for row_index, row in enumerate(rows, start=1):
                    heading = _paragraph(f"{label} - Row {row_index}", styles["label"])
                    heading.keepWithNext = True
                    result.extend([Spacer(1, 6), heading, Spacer(1, 4)])
                    result.extend(render(children.get(field_id, []), row if isinstance(row, dict) else {}))
            elif kind == "signature":
                evidence = _image(value, image_loader, 94) if value else None
                content = [evidence] if evidence else (
                    [_paragraph("Signature unavailable.", styles["muted"])] if value else ""
                )
                block = _row(label, content, styles, minimum_height=104 if value else 72)
                block.keepWithNext = index in pair_starts
                result.append(block)
            else:
                block = _row(label, text_value(value), styles)
                block.keepWithNext = index in pair_starts
                result.append(block)
        return result

    return render([field for field in fields if not field.get("repeat")], answers)


def _report_story(item, styles, image_loader):
    story = []
    if item.get("form_description"):
        story.append(_paragraph(item["form_description"], styles["muted"]))
    story.append(_paragraph("Report details", styles["section"]))
    for label, value in (
        ("Report Date", item.get("work_date") or "-"),
        ("Site", item.get("site_name") or "Unassigned site"),
        ("Worker", item.get("worker_name")),
        ("Submitted", item.get("created_at")),
        ("Status", item.get("workflow_status") or "submitted"),
    ):
        story.append(_row(label, value, styles))

    fields = item.get("fields") or []
    answers = item.get("answers") or {}
    if not fields:
        fields = [{"id": key, "label": label_from_id(key)} for key in answers]
    if not fields or fields[0].get("type") != "section":
        story.append(_paragraph("Report answers", styles["section"]))
    story.extend(_answer_rows(fields, answers, styles, image_loader) or [
        _row("Answers", "No answers provided.", styles),
    ])

    story.append(_paragraph("Photos", styles["section"]))
    urls = item.get("photo_urls") or []
    metadata = item.get("photo_metadata") or []
    for index, url in enumerate(urls, start=1):
        evidence = _image(url, image_loader, 215)
        cell = [evidence] if evidence else [_paragraph("Photo unavailable.", styles["muted"])]
        cell.extend([Spacer(1, 5), _paragraph(photo_caption(index, metadata), styles["muted"])])
        story.append(_row(f"Photo {index}", cell, styles))
    if not urls:
        story.append(_row("Photos", "No photos attached.", styles))

    story.append(_paragraph("Report review", styles["section"]))
    for label, value in (
        ("Reviewing Supervisor", item.get("reviewing_supervisor_name")),
        ("Review started", item.get("review_started_at")),
        ("Resolved", item.get("resolved_at")),
        ("Supervisor note", item.get("supervisor_note")),
    ):
        story.append(_row(label, value or "-", styles))
    return story


class _NumberedCanvas(Canvas):
    """Replay completed pages once their global collection page count is known."""
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._page_states = []

    def showPage(self):
        self._page_states.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total = len(self._page_states)
        for state in self._page_states:
            self.__dict__.update(state)
            self.saveState()
            self.setFont("Helvetica", 8)
            self.setFillColor(INK)
            self.drawRightString(PAGE_WIDTH - MARGIN, 24, f"Page {self._pageNumber} of {total}")
            self.restoreState()
            Canvas.showPage(self)
        Canvas.save(self)


def _page_template(index, item, styles):
    department, logo = report_department_branding(item.get("department_name"))
    brand = _paragraph(department, styles["muted"])
    _, brand_height = brand.wrap(210, PAGE_HEIGHT)
    submitter = _paragraph(
        f"Submitted By: {item.get('worker_email') or item.get('worker_name') or '-'}\n"
        f"Report #{item.get('id', '-')}", styles["submitter"],
    )
    _, submitter_height = submitter.wrap(CONTENT_WIDTH - 175, PAGE_HEIGHT)
    title = _paragraph(item.get("form_name") or "Submitted Reports", styles["title"])
    _, title_height = title.wrap(CONTENT_WIDTH, PAGE_HEIGHT)
    # A bounded repeated header leaves room even for unusually long Template names.
    header_title = title if title_height <= 72 else _paragraph("Report Template (see below)", styles["title"])
    _, header_height = header_title.wrap(CONTENT_WIDTH, PAGE_HEIGHT)
    body_top = PAGE_HEIGHT - 106 - header_height - 8

    def header(canvas, document):
        canvas.saveState()
        if logo:
            reader = ImageReader(BytesIO(logo))
            width, height = reader.getSize()
            square_mutual = department == "Mutual" and 0.9 <= width / height <= 1.1
            scale = min(148 / width, (75 if square_mutual else 57) / height)
            logo_top = 15 if square_mutual else 27
            canvas.drawImage(reader, MARGIN, PAGE_HEIGHT - logo_top - height * scale,
                             width=width * scale, height=height * scale, mask="auto")
        # Full long department names remain in the body; keep the header bounded.
        if brand_height <= 20:
            brand.drawOn(canvas, MARGIN, PAGE_HEIGHT - (101 if logo and square_mutual else 91))
        if submitter_height <= 66:
            submitter.drawOn(canvas, MARGIN + 175, PAGE_HEIGHT - 27 - submitter_height)
        else:
            summary = _paragraph(f"Submitted By: see Report details\nReport #{item.get('id', '-')}", styles["submitter"])
            _, summary_height = summary.wrap(CONTENT_WIDTH - 175, PAGE_HEIGHT)
            summary.drawOn(canvas, MARGIN + 175, PAGE_HEIGHT - 27 - summary_height)
        header_title.drawOn(canvas, MARGIN, PAGE_HEIGHT - 106 - header_height)
        if item:
            canvas.setFont("Helvetica", 8)
            canvas.setFillColor(INK)
            canvas.drawString(MARGIN, 34, f"Version {text_value(item.get('definition_version')) or '-'}")
            canvas.drawString(MARGIN, 22, f"Report Date {text_value(item.get('work_date')) or '-'}")
        canvas.restoreState()

    frame = Frame(MARGIN, 52, CONTENT_WIDTH, body_top - 52,
                  leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    template = PageTemplate(id=f"report-{index}", frames=[frame], onPage=header)
    overflow = []
    if title_height > 72:
        overflow.append(_row("Report Template", item.get("form_name"), styles))
    if brand_height > 20:
        overflow.append(_row("Department", department, styles))
    if submitter_height > 66:
        overflow.append(_row("Submitted By", item.get("worker_email") or item.get("worker_name"), styles))
    return template, overflow


def build_report_pdf(items, image_loader=image_bytes_from_value):
    """Return PDF bytes for authorized Reports, each starting on its own page."""
    buffer = BytesIO()
    styles = _styles()
    document = BaseDocTemplate(
        buffer, pagesize=A4, leftMargin=MARGIN, rightMargin=MARGIN,
        title=items[0].get("form_name") if len(items) == 1 else "Submitted Reports",
        author="ReportFlow", pageCompression=1,
    )
    story = []
    for index, item in enumerate(items or [{}]):
        template, overflow = _page_template(index, item, styles)
        document.addPageTemplates(template)
        if index:
            story.extend([NextPageTemplate(template.id), PageBreak()])
        story.extend(overflow)
        if item:
            story.extend(_report_story(item, styles, image_loader))
        else:
            story.append(_paragraph("No Reports found", styles["section"]))
    document.build(story, canvasmaker=_NumberedCanvas)
    return buffer.getvalue()
