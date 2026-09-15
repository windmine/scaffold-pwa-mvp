"""Pure Report PDF layout regressions; fixtures contain no real Report evidence.

Run with ``python backend/report_pdf_layout_test.py``. Route authorization,
filtering and immutable Definition selection are covered by report_export_test.
These checks complement, rather than replace, rendered-page visual inspection.
"""

import re
from io import BytesIO

from PIL import Image, ImageDraw
from pypdf import PdfReader

from app.use_cases.report_pdf import build_report_pdf


def report_fixture(**overrides):
    item = {
        "id": 4101,
        "department_id": 1,
        "department_name": "Mutual",
        "form_id": 31,
        "form_name": "Synthetic safety meeting",
        "form_description": "Synthetic export fixture, not a real meeting.",
        "definition_version": 7,
        "definition_schema_version": 1,
        "fields": [
            {"id": "meeting", "type": "section", "label": "Meeting details"},
            {"id": "discussion", "type": "textarea", "label": "Discussion"},
        ],
        "worker_id": 71,
        "worker_name": "Sample Worker",
        "worker_email": "sample-worker@example.invalid",
        "site_id": 11,
        "site_name": "Training site",
        "work_date": "2026-09-16",
        "answers": {"discussion": "Discussed access and housekeeping."},
        "photo_urls": [],
        "photo_metadata": [],
        "client_submission_id": "synthetic-pdf-layout-fixture",
        "submission_purpose": "report",
        "workflow_status": "resolved",
        "supervisor_note": "Final review complete. All actions recorded.",
        "reviewing_supervisor_id": 81,
        "reviewing_supervisor_name": "Sample Reviewer",
        "review_started_at": "2026-09-16T01:02:03Z",
        "resolved_at": "2026-09-16T02:03:04Z",
        "status": "pending",
        "created_at": "2026-09-16T00:01:02Z",
    }
    item.update(overrides)
    return item


def read_pdf(items, image_loader=lambda _value: None):
    data = build_report_pdf(items, image_loader=image_loader)
    assert isinstance(data, bytes) and data.startswith(b"%PDF-"), type(data)
    reader = PdfReader(BytesIO(data))
    assert reader.pages, "Export must contain a readable page"
    for page in reader.pages:
        assert abs(float(page.mediabox.width) - 595.2756) < 0.1
        assert abs(float(page.mediabox.height) - 841.8898) < 0.1
    return reader


def page_texts(reader):
    return [re.sub(r"\s+", " ", page.extract_text() or "").strip() for page in reader.pages]


def assert_page_numbers(reader):
    count = len(reader.pages)
    for index, text in enumerate(page_texts(reader), start=1):
        assert re.search(rf"\bPage\s+{index}\s+of\s+{count}\b", text), text[-200:]


def synthetic_image(width, height, color):
    buffer = BytesIO()
    picture = Image.new("RGB", (width, height), "white")
    # Geometric strokes are test evidence, never a copy of a person's signature.
    ImageDraw.Draw(picture).line(
        [(8, height - 8), (width // 3, 8), (width // 2, height - 15), (width - 8, 12)],
        fill=color,
        width=3,
    )
    picture.save(buffer, format="PNG")
    return buffer.getvalue()


def drawing_events(reader, pages=None):
    """Track text and raster paint order, including signatures inside table cells."""
    events = []
    for page in reader.pages if pages is None else pages:
        resources = page["/Resources"].get_object()
        images = resources.get("/XObject", {}).get_object() if "/XObject" in resources else {}

        def visit_text(text, _cm, _tm, _font, _size):
            normalized = re.sub(r"\s+", " ", text).strip()
            if normalized:
                events.append(("text", normalized))

        def visit_operand(operator, operands, cm, _tm):
            if operator != b"Do" or not operands:
                return
            image = images.get(operands[0])
            if image is None:
                return
            image = image.get_object()
            if image.get("/Subtype") == "/Image":
                width, height = int(image["/Width"]), int(image["/Height"])
                events.append(("image", (width, height)))
                assert cm[1] == cm[2] == 0, "Unexpected rotated evidence"
                assert cm[4] >= 0 and cm[5] >= 0, cm
                assert cm[4] + cm[0] <= float(page.mediabox.width) + 0.1, cm
                assert cm[5] + cm[3] <= float(page.mediabox.height) + 0.1, cm
                assert abs(cm[0] / width - cm[3] / height) < 0.001, "Image aspect ratio changed"

        page.extract_text(visitor_text=visit_text, visitor_operand_before=visit_operand)
    return events


def test_empty_collection_and_a4():
    reader = read_pdf([])
    assert len(reader.pages) == 1
    text = page_texts(reader)[0]
    assert "No Reports found" in text, text
    assert "Sample Worker" not in text
    assert_page_numbers(reader)
    print("ok - empty Report collection is a readable, numbered A4 PDF")


def test_metadata_workflow_and_snapshot_footer():
    item = report_fixture()
    reader = read_pdf([item])
    text = " ".join(page_texts(reader))
    for value in (
        "Mutual", item["form_name"], item["worker_name"], item["worker_email"],
        item["site_name"], str(item["id"]), "resolved", item["created_at"],
        item["reviewing_supervisor_name"], item["review_started_at"],
        item["resolved_at"], item["supervisor_note"], item["answers"]["discussion"],
    ):
        assert value.casefold() in text.casefold(), (value, text)
    assert "pending" not in text.casefold(), "Report must use its workflow, not retained outcome status"
    for page in page_texts(reader):
        assert "Version 7" in page, page
        assert re.search(r"Report Date\s*:?\s*2026-09-16", page), page
        assert "Issue Date Feb2022" not in page
    assert_page_numbers(reader)
    print("ok - Report metadata, workflow, review evidence and actual Definition/date footer survive export")


def test_collection_headers_follow_each_report_on_continuations():
    first = report_fixture(
        form_name="FIRST collection template",
        worker_email="first@example.invalid",
        answers={"discussion": "\n".join(f"First body marker {index:03d}" for index in range(130))},
    )
    second = report_fixture(
        id=4102, department_id=2, department_name="Stech", definition_version=12,
        work_date="2026-09-17", form_name="SECOND collection template",
        worker_email="second@example.invalid",
        answers={"discussion": "\n".join(f"Second body marker {index:03d}" for index in range(130))},
    )
    reader = read_pdf([first, second])
    assert len(reader.pages) >= 6, len(reader.pages)
    seen_second = False
    first_page_count = second_page_count = 0
    for text in page_texts(reader):
        if second["form_name"] in text:
            seen_second = True
            second_page_count += 1
            assert first["form_name"] not in text and first["worker_email"] not in text, text
            assert "Stech" in text and "second@example.invalid" in text, text
            assert "Version 12" in text and "2026-09-17" in text, text
        else:
            assert not seen_second, "Collection switched back to the previous Report header"
            first_page_count += 1
            assert first["form_name"] in text and "Mutual" in text, text
            assert first["worker_email"] in text and "Version 7" in text, text
            assert second["worker_email"] not in text, text
    assert first_page_count >= 2 and second_page_count >= 2
    assert_page_numbers(reader)
    print("ok - collection pages repeat their own department, title, submitter and snapshot footer")


def test_long_answers_labels_and_review_notes_split_without_loss():
    long_label = " ".join(f"label{index:03d}" for index in range(450)) + " LABEL_END"
    long_answer = "\n".join(f"Answer line {index:03d}" for index in range(185)) + "\nANSWER_END"
    long_note = "\n".join(f"Review line {index:03d}" for index in range(160)) + "\nREVIEW_END"
    item = report_fixture(
        fields=[{"id": "long", "type": "textarea", "label": long_label}],
        answers={"long": long_answer}, supervisor_note=long_note,
    )
    reader = read_pdf([item])
    text = " ".join(page_texts(reader))
    for marker in ("label000", "label449", "LABEL_END", "ANSWER_END", "REVIEW_END"):
        assert marker in text, marker
    for index in range(185):
        assert f"Answer line {index:03d}" in text, index
    for index in range(160):
        assert f"Review line {index:03d}" in text, index
    assert_page_numbers(reader)
    print("ok - oversized labels, answers and final notes split across A4 pages without lost tails")


def test_signatures_remain_inline_with_names_and_repeat_rows():
    assets = {
        "/uploads/synthetic-signature-main.png": synthetic_image(181, 61, "navy"),
        "/uploads/synthetic-signature-a.png": synthetic_image(182, 62, "green"),
        "/uploads/synthetic-signature-b.png": synthetic_image(183, 63, "purple"),
        "/uploads/synthetic-photo.png": synthetic_image(224, 140, "orange"),
    }
    loaded = []

    def image_loader(value):
        loaded.append(value)
        return assets.get(value)

    item = report_fixture(
        fields=[
            {"id": "signoff", "type": "section", "label": "Sign off"},
            {"id": "main_signature", "type": "signature", "label": "Main signature"},
            {"id": "main_name", "type": "text", "label": "Main name"},
            {"id": "attendees", "type": "repeat", "label": "Attendees"},
            {"id": "attendee_signature", "type": "signature", "label": "Attendee signature", "repeat": "attendees"},
            {"id": "attendee_name", "type": "text", "label": "Attendee name", "repeat": "attendees"},
            {"id": "optional_signature", "type": "signature", "label": "Optional signature"},
        ],
        answers={
            "main_signature": "/uploads/synthetic-signature-main.png",
            "main_name": "Synthetic lead name",
            "attendees": [
                {"attendee_signature": "/uploads/synthetic-signature-a.png", "attendee_name": "Synthetic attendee alpha"},
                {"attendee_signature": "/uploads/synthetic-signature-b.png", "attendee_name": "Synthetic attendee beta"},
            ],
            "optional_signature": None,
        },
        photo_urls=["/uploads/synthetic-photo.png"],
        photo_metadata=[{"name": "Synthetic evidence.png", "taken_at": "2026-09-16T00:00:01Z"}],
    )
    reader = read_pdf([item], image_loader=image_loader)
    events = drawing_events(reader)
    main_image = events.index(("image", (181, 61)))
    first_image = events.index(("image", (182, 62)))
    second_image = events.index(("image", (183, 63)))

    def text_index(value):
        return next(index for index, (kind, content) in enumerate(events) if kind == "text" and value in content)

    assert text_index("Main signature") < main_image < text_index("Synthetic lead name")
    assert text_index("Synthetic lead name") < first_image < text_index("Synthetic attendee alpha")
    assert text_index("Synthetic attendee alpha") < second_image < text_index("Synthetic attendee beta")
    assert ("image", (224, 140)) in events
    text = " ".join(page_texts(reader))
    assert "Optional signature" in text
    assert "Synthetic evidence.png" in text and "2026-09-16T00:00:01Z" in text
    assert sorted(loaded) == sorted(assets), loaded
    image_names = {
        (181, 61): "Synthetic lead name",
        (182, 62): "Synthetic attendee alpha",
        (183, 63): "Synthetic attendee beta",
    }
    for page in reader.pages:
        page_events = drawing_events(reader, pages=[page])
        page_text = re.sub(r"\s+", " ", page.extract_text() or "")
        for image_size, name in image_names.items():
            if ("image", image_size) in page_events:
                assert name in page_text, f"Signature for {name} was orphaned from its short name row"
    print("ok - inline signature images precede their matching names, including repeat rows and optional blanks")


def test_unbroken_values_wrap_without_loss():
    item = report_fixture(
        fields=[{"id": "token", "type": "text", "label": "Z" * 2100 + " LABEL_TOKEN_END"}],
        answers={"token": "Q" * 3500 + " ANSWER_TOKEN_END"},
    )
    reader = read_pdf([item])
    text = " ".join(page_texts(reader))
    assert sum(map(len, re.findall(r"Z{2,}", text))) == 2100
    assert sum(map(len, re.findall(r"Q{2,}", text))) == 3500
    assert "LABEL_TOKEN_END" in text and "ANSWER_TOKEN_END" in text
    assert_page_numbers(reader)
    print("ok - 2100-character labels and 3500-character unbroken answers wrap without character loss")


def test_many_signature_pairs_do_not_orphan_names():
    signatures = {
        f"/uploads/synthetic-paired-{index:02d}.png": synthetic_image(187 + index, 67, "black")
        for index in range(16)
    }
    children = [
        {"id": "mark", "type": "signature", "label": "Signature", "repeat": "people"},
        {"id": "name", "type": "text", "label": "Name", "repeat": "people"},
    ]
    for ordered_children in (children, list(reversed(children))):
        repeated_item = report_fixture(
            fields=[{"id": "people", "type": "repeat", "label": "Sign off"}, *ordered_children],
            answers={"people": [
                {"mark": f"/uploads/synthetic-paired-{index:02d}.png", "name": f"PAIR_ROW_{index:02d}"}
                for index in range(16)
            ]},
        )
        flat_fields = []
        flat_answers = {}
        for index in range(16):
            for child in ordered_children:
                field_id = f"{child['id']}_{index:02d}"
                flat_fields.append({"id": field_id, "type": child["type"], "label": child["label"]})
                flat_answers[field_id] = (
                    f"/uploads/synthetic-paired-{index:02d}.png"
                    if child["type"] == "signature" else f"PAIR_ROW_{index:02d}"
                )
        flat_item = report_fixture(fields=flat_fields, answers=flat_answers)
        for structure, item in (("repeat", repeated_item), ("flat", flat_item)):
            reader = read_pdf([item], image_loader=signatures.get)
            assert len(reader.pages) >= 4
            total_images = total_names = 0
            for page in reader.pages:
                events = drawing_events(reader, pages=[page])
                text = page.extract_text() or ""
                for index in range(16):
                    image_count = events.count(("image", (187 + index, 67)))
                    name_count = text.count(f"PAIR_ROW_{index:02d}")
                    assert image_count == name_count, (
                        f"A page break orphaned {structure} signature {index} "
                        f"from its name ({ordered_children[0]['type']} first)"
                    )
                    total_images += image_count
                    total_names += name_count
            assert total_images == total_names == 16
            assert_page_numbers(reader)
    print("ok - 16 flat/repeated signature-name pairs stay together in either Definition field order")


def test_long_header_metadata_falls_back_without_disappearing():
    item = report_fixture(
        department_name="W" * 90,
        worker_email="M" * 160 + "@example.invalid",
        form_name=" ".join(f"Wide title {index:02d}" for index in range(45)),
    )
    reader = read_pdf([item])
    text = " ".join(page_texts(reader))
    # Wrapped text may have spaces inserted by extraction, but no value may vanish.
    compact = re.sub(r"\s+", "", text)
    assert item["department_name"] in compact, "Wide department omitted from both header and body"
    assert item["worker_email"] in compact, "Wide submitter omitted from both header and body"
    assert "Wide title 00" in text and "Wide title 44" in text
    assert_page_numbers(reader)
    print("ok - oversized repeated-header metadata remains complete in the body fallback")


def test_unavailable_images_are_explicit():
    item = report_fixture(
        fields=[
            {"id": "missing", "type": "signature", "label": "Missing signature"},
            {"id": "corrupt", "type": "signature", "label": "Corrupt signature"},
        ],
        answers={"missing": "/uploads/missing.png", "corrupt": "/uploads/corrupt.png"},
        photo_urls=["/uploads/missing-photo.png", "/uploads/corrupt-photo.png"],
    )
    reader = read_pdf([item], image_loader=lambda value: b"not an image" if "corrupt" in value else None)
    text = " ".join(page_texts(reader))
    assert text.casefold().count("unavailable") >= 4, text
    assert "Missing signature" in text and "Corrupt signature" in text
    assert "Photo 1" in text and "Photo 2" in text
    print("ok - missing and undecodable photo/signature evidence is explicitly unavailable")


def test_markup_is_literal_text_not_pdf_links_or_images():
    unsafe = '<script>alert("synthetic")</script> & <img src="https://example.invalid/x">'
    item = report_fixture(
        form_name="Safety <draft> & checks",
        fields=[
            {"id": "section", "type": "section", "label": "Section <literal>"},
            {"id": "text", "type": "text", "label": "Label <b>literal</b>"},
        ],
        answers={"text": unsafe},
        supervisor_note='<a href="https://example.invalid/">Not a link</a>',
    )
    reader = read_pdf([item])
    text = " ".join(page_texts(reader))
    for value in (item["form_name"], "Section <literal>", "Label <b>literal</b>", unsafe, item["supervisor_note"]):
        assert value in text, (value, text)
    for page in reader.pages:
        assert not page.get("/Annots"), "Report field markup must not become active PDF annotations"
    print("ok - HTML-looking field content remains literal printable text")


if __name__ == "__main__":
    test_empty_collection_and_a4()
    test_metadata_workflow_and_snapshot_footer()
    test_collection_headers_follow_each_report_on_continuations()
    test_long_answers_labels_and_review_notes_split_without_loss()
    test_signatures_remain_inline_with_names_and_repeat_rows()
    test_unbroken_values_wrap_without_loss()
    test_many_signature_pairs_do_not_orphan_names()
    test_long_header_metadata_falls_back_without_disappearing()
    test_unavailable_images_are_explicit()
    test_markup_is_literal_text_not_pdf_links_or_images()
