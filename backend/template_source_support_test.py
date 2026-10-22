"""Source-template compatibility with isolated data, synthetic images and mocked SMTP."""
from io import BytesIO
import json
from pathlib import Path
import unittest

import report_pdf_email_test as fixture
from fastapi import HTTPException
from pydantic import ValidationError
from pypdf import PdfReader
from sqlmodel import select
from app.models import ReportPdfEmail, WorkFormSubmission
from app.schemas import WorkFormCreate, WorkFormField, SupervisorWorkFormSubmissionUpdate
from app.use_cases.common import (normalize_work_form_fields, normalize_work_form_photo_metadata,
    normalize_work_form_photo_urls, normalize_location_answer, require_template_features)
from app.use_cases import report_pdf_email as delivery
from app.use_cases.report_pdf import build_report_pdf
from app.use_cases.supervisor_review import update_supervisor_form_submission, render_form_submission_page
from report_pdf_layout_test import report_fixture

ROOT = Path(__file__).resolve().parents[1]
CATALOG = json.loads((ROOT / "docs/templates/mutual-source-templates.json").read_text(encoding="utf-8"))


class TemplateSourceSupportTests(unittest.TestCase):
    setUp = fixture.ReportPdfEmailTests.setUp
    settings = fixture.ReportPdfEmailTests.settings
    submit = fixture.ReportPdfEmailTests.submit
    raster = fixture.ReportPdfEmailTests.raster
    row = fixture.ReportPdfEmailTests.row

    def test_six_complete_blank_definitions_five_publishable(self):
        expected = {"fm15": 117, "harness": 26, "axon": 21, "ecoply": 26, "excavator": 24, "ppe": 26}
        self.assertEqual(CATALOG["department"], {"id": 2, "name": "Mutual"})
        self.assertEqual(sum(item["publish"] for item in CATALOG["templates"]), 5)
        for item in CATALOG["templates"]:
            payload = WorkFormCreate.model_validate(item["payload"])
            fields = normalize_work_form_fields(payload.fields)
            self.assertEqual(len(fields), expected[item["id"]])
            self.assertFalse(item["email_enabled"])
            self.assertIsNone(item["email_recipient"])
            self.assertTrue(all(not field["required"] and not field["options"] for field in fields))
            self.assertTrue(all("default" not in field and "value" not in field for field in fields))
            self.assertEqual(len({field["id"] for field in fields}), len(fields))
        ppe = next(item for item in CATALOG["templates"] if item["id"] == "ppe")
        self.assertFalse(ppe["publish"])
        self.assertEqual(sum(field["type"] == "signature" for field in ppe["payload"]["fields"]), 2)

    def test_bounded_capacity_and_old_definition_shape(self):
        legacy = {"id": "note", "label": "Note", "type": "text", "required": False, "options": []}
        self.assertEqual(normalize_work_form_fields([WorkFormField(**legacy)]), [legacy])
        fields = [WorkFormField(id=f"f_{i}", label=f"Question {i}", type="text") for i in range(128)]
        self.assertEqual(len(normalize_work_form_fields(fields)), 128)
        with self.assertRaises(HTTPException):
            normalize_work_form_fields(fields + [WorkFormField(id="extra", label="Extra", type="text")])
        with self.assertRaises(ValidationError):
            WorkFormCreate(name="Too long", fields=fields + fields[:1])
        with self.assertRaises(ValidationError):
            WorkFormField(id="x", label="Static", type="section", description="x" * 501)
        for field in [WorkFormField(id="x", label="X", type="text", description="Do not silently drop"),
                      WorkFormField(id="x", label="X", type="photos", show_if="earlier=yes")]:
            with self.assertRaises(HTTPException):
                normalize_work_form_fields([field])

    def test_location_validation_is_structured_and_blank_by_default(self):
        self.assertEqual(normalize_location_answer("Location", None), "")
        value = {"latitude": 0.0, "longitude": 0.0, "accuracy": 5, "captured_at": "2026-01-01T00:00:00Z"}
        self.assertEqual(normalize_location_answer("Location", value), value)
        for bad in ["sample location", {**value, "latitude": 91}, {**value, "longitude": -181},
                    {**value, "latitude": True}, {**value, "accuracy": -1}, {**value, "accuracy": float("nan")},
                    {**value, "captured_at": "yesterday"}, {**value, "captured_at": "2026-01-01"}]:
            with self.assertRaises(HTTPException):
                normalize_location_answer("Location", bad)

    def test_photo_association_is_definition_scoped_and_shared_quota(self):
        fields = [{"id": "section", "type": "section", "label": "Electrical"},
                  {"id": "photos", "type": "photos", "label": "Photos", "required": True}]
        url = self.raster((9, 9), "red")
        result = normalize_work_form_photo_metadata([url], [{"url": url, "field_id": "photos", "field_label": "Untrusted"}], fields)
        self.assertEqual(result[0]["field_label"], "Electrical: Photos")
        with self.assertRaises(HTTPException):
            normalize_work_form_photo_metadata([url], [{"url": url, "field_id": "foreign"}], fields)
        with self.assertRaises(HTTPException):
            normalize_work_form_photo_metadata([], [], fields)
        with self.assertRaises(HTTPException):
            normalize_work_form_photo_urls([url] * 51, purpose="report")

    def test_older_clients_fail_closed_for_extended_templates(self):
        for fields in [[{"type": "photos"}], [{"type": "location"}], [{"description": "Static"}], [{}] * 31]:
            with self.assertRaises(HTTPException) as caught:
                require_template_features(fields, 1)
            self.assertEqual(caught.exception.detail["code"], "report_template_update_required")
            require_template_features(fields, 2)
        require_template_features([{"type": "text"}], 1)

    def test_replay_corrections_and_frozen_email_preserve_association(self):
        fields = [{"id": "instructions", "type": "section", "label": "Synthetic instructions", "description": "Keep this exact static text."},
                  {"id": "photo", "type": "photos", "label": "Electrical photos"},
                  {"id": "location", "type": "location", "label": "Location"},
                  {"id": "signed", "type": "signature", "label": "Signature"}]
        self.form.fields_json = json.dumps(fields)
        self.session.add(self.form)
        self.session.commit()
        self.settings()
        photo, signature = self.raster((15, 15), "red"), self.raster((9, 9), "blue")
        location = {"latitude": 0.0, "longitude": 0.0, "accuracy": 8, "captured_at": "2026-01-01T00:00:00Z"}
        args = dict(client_template_features=2, answers={"location": location, "signed": signature},
                    photo_urls=[photo], photo_metadata=[{"url": photo, "field_id": "photo"}])
        with self.assertRaises(HTTPException):
            self.submit(answers={})
        self.session.rollback()
        submitted = self.submit(**args)
        self.assertEqual(self.submit(**args)["id"], submitted["id"])
        frozen = self.row().snapshot_json
        self.assertEqual(len(self.session.exec(select(ReportPdfEmail)).all()), 1)
        corrected = update_supervisor_form_submission(submitted["id"], SupervisorWorkFormSubmissionUpdate(
            confirmed=True, client_template_features=2, expected_revision=1,
            answers={"location": "", "signed": signature}, photo_urls=[photo],
            photo_metadata=[{"url": photo, "field_id": "photo"}]), self.supervisor, self.session)
        self.assertEqual(corrected["photo_metadata"][0]["field_id"], "photo")
        self.assertEqual(corrected["answers"]["location"], "")
        self.assertEqual(self.row().snapshot_json, frozen)
        item = delivery._snapshot_for_delivery(self.row(), self.session)
        self.assertEqual(item["answers"]["location"], location)
        self.assertEqual(item["photo_metadata"][0]["field_id"], "photo")
        self.assertEqual(delivery.dispatch_pending(self.engine)["accepted"], 1)
        self.assertEqual(delivery.dispatch_pending(self.engine)["accepted"], 0)
        self.client.send_message.assert_called_once()
        self.assertEqual(len(self.session.exec(select(WorkFormSubmission)).all()), 1)

    def test_all_source_labels_and_static_text_survive_pdf_and_html(self):
        destination = ROOT / "output/report-template-preparation-20261022/blank-pdfs"
        destination.mkdir(parents=True, exist_ok=True)
        squash = lambda text: "".join(text.split())
        for template in CATALOG["templates"]:
            fields = template["payload"]["fields"]
            item = report_fixture(fields=fields, answers={}, form_name=template["payload"]["name"])
            data = build_report_pdf([item], image_loader=lambda _: None)
            text = squash(" ".join(page.extract_text() for page in PdfReader(BytesIO(data)).pages))
            html = render_form_submission_page(item)
            for field in fields:
                self.assertIn(squash(field["label"]), text, (template["id"], field["label"]))
                if field.get("description"):
                    self.assertIn(squash(field["description"]), text)
                    self.assertIn(field["description"].replace("&", "&amp;"), html)
            (destination / f"{template['id']}-synthetic-blank.pdf").write_bytes(data)


if __name__ == "__main__":
    unittest.main()
