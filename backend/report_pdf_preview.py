"""Generate a synthetic visual-QA Report; never reads production or sample data."""
import argparse
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw

from app.use_cases.report_pdf import build_report_pdf


def preview_image(value):
    signature = value.startswith("demo-signature")
    image = Image.new("RGB", (960, 230 if signature else 470), "white" if signature else "#e9eff5")
    draw = ImageDraw.Draw(image)
    if signature:
        draw.line([(80, 140), (110, 60), (95, 180), (165, 105), (190, 140),
                   (210, 110), (245, 140), (320, 105), (420, 130), (520, 90)],
                  fill="#26384b", width=4)
        draw.text((650, 160), "DEMO SIGNATURE", fill="#677787", font_size=23)
    else:
        # Code-native schematic stands in for a photo; no real site/person is used.
        for x in (140, 430, 720):
            draw.line((x, 95, x, 375), fill="#708496", width=10)
        for y in (120, 235, 350):
            draw.line((115, y, 750, y), fill="#708496", width=10)
        draw.line((140, 120, 430, 350), fill="#92a3b1", width=7)
        draw.line((430, 120, 720, 350), fill="#92a3b1", width=7)
        draw.text((45, 25), "SYNTHETIC SITE EVIDENCE - PREVIEW ONLY", fill="#1955a0", font_size=27)
        draw.text((45, 417), "Example image placement; not a real submitted photo.", fill="#435667", font_size=23)
    result = BytesIO()
    image.save(result, format="PNG")
    return result.getvalue()


def preview_report():
    return {
        "id": "DEMO-001", "department_name": "Mutual", "form_name": "Tool box talk",
        "form_description": "FORMAT PREVIEW ONLY - synthetic answers, signatures and image.",
        "definition_version": 3, "worker_name": "Example Worker",
        "worker_email": "worker@example.com", "site_name": "Example Project",
        "work_date": "2026-09-16", "created_at": "2026-09-16T08:15:00+12:00",
        "workflow_status": "resolved", "submission_purpose": "report",
        "fields": [
            {"id": "meeting", "type": "section", "label": "Meeting details"},
            {"id": "client", "type": "text", "label": "Client"},
            {"id": "job", "type": "text", "label": "Job No."},
            {"id": "supervisor", "type": "text", "label": "Supervisor"},
            {"id": "time", "type": "text", "label": "Time"},
            {"id": "previous", "type": "section", "label": "Previous Meeting"},
            {"id": "actions", "type": "textarea", "label": "Actions from previous meeting"},
            {"id": "new", "type": "section", "label": "New Meeting"},
            {"id": "topics", "type": "textarea", "label": "Topics discussed"},
            {"id": "understood", "type": "checkbox", "label": "Everyone understands the plan"},
            {"id": "required", "type": "textarea", "label": "Actions required"},
            {"id": "due", "type": "date", "label": "Due date"},
            {"id": "attendees", "type": "repeat", "label": "Sign off"},
            {"id": "signature", "type": "signature", "label": "Signature", "repeat": "attendees"},
            {"id": "name", "type": "text", "label": "Name", "repeat": "attendees"},
        ],
        "answers": {
            "client": "Example Client", "job": "EX-104", "supervisor": "Example Supervisor",
            "time": "08:00 AM", "actions": "Confirm the marked access route remains clear before work starts.",
            "topics": "Discussed safe access, manual handling and the planned work area.\n"
                      "The team confirmed that any changed conditions will be raised with the Supervisor.",
            "understood": True, "required": "Check the access route and confirm completion at the next meeting.",
            "due": "2026-09-17", "attendees": [
                {"signature": "demo-signature-1", "name": "Example Worker"},
                {"signature": "demo-signature-2", "name": "Example Team Member"},
            ],
        },
        "photo_urls": ["demo-photo"], "photo_metadata": [{"name": "Example access route"}],
        "reviewing_supervisor_name": "Example Supervisor", "review_started_at": "2026-09-16T09:00:00+12:00",
        "resolved_at": "2026-09-16T09:15:00+12:00", "supervisor_note": "Access route checked. Actions completed.",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("output/pdf/report-format-preview.pdf"))
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(build_report_pdf([preview_report()], image_loader=preview_image))
    print(f"Created synthetic preview: {args.output.resolve()}")
