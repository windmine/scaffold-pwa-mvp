"""Readable Report identity from an already-authorized export/frozen mail snapshot.

No queries or changes to saved answers. Only explicitly named context fields are
promoted; arbitrary answers (including incident details) never become a subject.
"""
from datetime import datetime, timezone
import re
import unicodedata
from zoneinfo import ZoneInfo

REPORT_TIMEZONE = ZoneInfo("Pacific/Auckland")


def one_line(value, limit=None):
    text = " ".join("".join(
        " " if unicodedata.category(char).startswith("C") else char
        for char in str(value or "")
    ).split())
    return text if limit is None or len(text) <= limit else text[:limit - 3].rstrip() + "..."


def submitted_time(value):
    """Display New Zealand time without changing stored instants or Report Dates."""
    if not value:
        return "Not recorded"
    try:
        instant = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if instant.tzinfo is None:
            instant = instant.replace(tzinfo=timezone.utc)
        local = instant.astimezone(REPORT_TIMEZONE)
        return f"{local:%d %b %Y, %H:%M} {local.tzname()} ({REPORT_TIMEZONE.key})"
    except (ValueError, TypeError, OverflowError):
        return one_line(value)


def report_context(item):
    """Recognize unambiguous top-level text labels, never infer from field order."""
    labels = {"qa": "QA", "client": "Client", "location": "Location", "drawing ref": "Drawing Ref"}
    candidates = {}
    answers = item.get("answers") or {}
    for field in item.get("fields") or []:
        label = one_line(field.get("label")).rstrip(":.").casefold()
        if label not in labels or field.get("repeat") or field.get("type") not in ("text", "textarea"):
            continue
        value = answers.get(field.get("id"))
        candidates.setdefault(labels[label], []).append(one_line(value) if isinstance(value, str) else "")
    return [(label, values[0]) for label, values in candidates.items() if len(values) == 1 and values[0]]


def report_email_content(item):
    """Bound mail metadata; keep complete answers/evidence in the attached PDF."""
    template = one_line(item.get("form_name")) or "Report"
    site = one_line(item.get("site_name")) or "No site specified"
    report_id = one_line(item.get("id"), 32) or "unknown"
    report_date = one_line(item.get("work_date"), 32) or "Not recorded"
    subject = f"ReportFlow: {one_line(template, 70)} | {one_line(site, 60)} | {report_date} | #{report_id}"
    lines = [
        "A new report has been submitted. The PDF is attached.", "",
        f"Report type: {one_line(template, 500)}",
        f"Report number: #{report_id}",
        f"Site: {one_line(site, 500)}",
        f"Report date: {report_date}",
        f"Submitted by: {one_line(item.get('worker_name') or item.get('worker_email'), 250) or 'Not recorded'}",
        f"Department: {one_line(item.get('department_name'), 250) or 'Not recorded'}",
        f"Submitted at: {submitted_time(item.get('created_at'))}",
    ]
    context = report_context(item)
    if context:
        lines += ["", "Report context (full answers in PDF):"]
        lines += [f"{label}: {one_line(value, 400)}" for label, value in context]
    lines += ["", "The attachment is the version captured when this report was submitted, including its photos and signatures.",
              "Later corrections in ReportFlow are not included in this email.", ""]

    def slug(value, limit, fallback):
        ascii_text = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
        return re.sub(r"[^A-Za-z0-9]+", "-", ascii_text).strip("-")[:limit].rstrip("-") or fallback

    filename = (f"ReportFlow-{slug(template, 50, 'Report')}-{slug(site, 45, 'Site')}"
                f"-{slug(report_date, 20, 'undated')}-report-{slug(report_id, 32, 'unknown')}.pdf")
    return subject, "\n".join(lines), filename
