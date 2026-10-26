"""Manual Report sites: isolated database/HTTP fixtures and mocked SMTP only."""
from io import BytesIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import report_pdf_email_test as fixture
import supervisor_report_submission_test as http_fixture
from fastapi import HTTPException
from pydantic import ValidationError
from pypdf import PdfReader
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, create_engine, select
from app.migrations import run_migrations
from app.models import Site, WorkFormSubmission
from app.schemas import SupervisorWorkFormSubmissionUpdate, WorkFormSubmissionCreate
from app.use_cases import report_pdf_email as delivery, supervisor_review as review
from app.use_cases.common import work_form_submission_response


class ManualSiteTests(unittest.TestCase):
    setUp = fixture.ReportPdfEmailTests.setUp
    submit = fixture.ReportPdfEmailTests.submit
    settings = fixture.ReportPdfEmailTests.settings
    row = fixture.ReportPdfEmailTests.row

    def edit(self, item, **fields):
        return review.update_supervisor_form_submission(item['id'], SupervisorWorkFormSubmissionUpdate(
            expected_revision=item['revision'], confirmed=True, client_template_features=3, **fields),
            self.supervisor, self.session)

    def test_manual_roundtrip_replay_without_creating_site(self):
        first = self.submit(manual_site_name='  Synthetic west gate  ', client_template_features=3)
        self.assertEqual(first['manual_site_name'], 'Synthetic west gate')
        self.assertEqual(first['site_name'], 'Synthetic west gate')
        self.assertIsNone(first['site_id'])
        self.session.expire_all()
        self.assertEqual(work_form_submission_response(self.session.get(WorkFormSubmission, first['id']),
                         self.session)['site_name'], first['site_name'])
        replay = self.submit(manual_site_name='Different retry value', client_template_features=3)
        self.assertTrue(replay['idempotent_replay'])
        self.assertEqual(replay['site_name'], first['site_name'])
        self.assertEqual(self.session.exec(select(Site)).all(), [])
        self.assertEqual(len(self.session.exec(select(WorkFormSubmission)).all()), 1)
        from app.use_cases.review_queue import list_review_record_page
        page = list_review_record_page(self.session, self.supervisor, kind='form', purpose='report', search='west gate')
        self.assertEqual([item['id'] for item in page['items']], [first['id']])
        foreign = list_review_record_page(self.session, self.foreign, kind='form', purpose='report', search='west gate')
        self.assertEqual(foreign['items'], [])
        self.smtp.assert_not_called()

    def test_linked_ids_optional_blank_and_invalid_names(self):
        self.session.add(Site(id=10, department_id=1, name='Shared site', latitude=0, longitude=0))
        self.session.commit()
        linked = self.submit(site_id=10)
        self.assertEqual((linked['site_id'], linked['site_name'], linked['manual_site_name']), (10, 'Shared site', None))
        blank = self.submit('blank', manual_site_name='   ')
        self.assertIsNone(blank['site_name'])
        for kwargs in ({'site_id': 10, 'manual_site_name': 'Both'}, {'manual_site_name': 'Bad\nname'},
                       {'manual_site_name': 'Bad\x00name'}):
            with self.assertRaises(HTTPException): self.submit('invalid', **kwargs)
            self.session.rollback()
        with self.assertRaises(ValidationError): WorkFormSubmissionCreate(form_id=1, manual_site_name='x' * 201)
        self.assertEqual(len(self.session.exec(select(Site)).all()), 1)

    def test_corrections_modes_legacy_clients_and_frozen_email(self):
        self.settings()
        first = self.submit(manual_site_name='Original synthetic site', client_template_features=3)
        # Old clients omit the new property and send site_id=null on every edit.
        old_edit = self.edit(first, site_id=None, answers={'issue': 'Corrected'})
        self.assertEqual(old_edit['manual_site_name'], first['manual_site_name'])
        current = self.edit(old_edit, site_id=None, manual_site_name='Corrected synthetic site')
        with self.assertRaises(HTTPException) as stale:
            self.edit(first, site_id=None, manual_site_name='Stale')
        self.assertEqual(stale.exception.status_code, 409)
        self.session.rollback()
        self.assertEqual(json.loads(self.row().snapshot_json)['site_name'], first['site_name'])
        pdf = review.export_form_submission_pdf(submission_id=first['id'], session=self.session, supervisor=self.supervisor)
        self.assertIn('Corrected synthetic site', '\n'.join(p.extract_text() for p in PdfReader(BytesIO(pdf.body)).pages))
        output = Path(__file__).resolve().parents[1] / 'output/manual-site-local'
        output.mkdir(exist_ok=True, parents=True)
        (output / 'synthetic-report.pdf').write_bytes(pdf.body)
        for exporter in (review.export_form_submission_html, review.export_form_submission_csv):
            result = exporter(submission_id=first['id'], session=self.session, supervisor=self.supervisor)
            self.assertIn(b'Corrected synthetic site', result.body)
        delivery.dispatch_pending(self.engine)
        message = self.client.send_message.call_args.args[0]
        attachment = next(message.iter_attachments()).get_payload(decode=True)
        self.assertIn('Original synthetic site', '\n'.join(p.extract_text() for p in PdfReader(BytesIO(attachment)).pages))
        self.session.add(Site(id=10, department_id=1, name='Linked site', latitude=0, longitude=0))
        self.session.commit()
        linked = self.edit(current, site_id=10, manual_site_name=None)
        self.assertEqual(linked['site_name'], 'Linked site')
        manual = self.edit(linked, site_id=None, manual_site_name='Manual again')
        cleared = self.edit(manual, site_id=None, manual_site_name=None)
        self.assertIsNone(cleared['site_name'])
        self.assertEqual(delivery.dispatch_pending(self.engine)['accepted'], 0)
        self.client.send_message.assert_called_once()

    def test_migration_guards_and_old_rows(self):
        # Upgrade a real schema-26 SQLite database, preserving existing row/ledger.
        import shutil
        with TemporaryDirectory(prefix='manual-site-migration-') as directory:
            root = Path(directory); manifest = root / 'old'; manifest.mkdir()
            for path in (Path(__file__).parent / 'migrations/versions').glob('*.py'):
                if path.stem != '__init__' and path.stem < '0027': shutil.copy2(path, manifest / path.name)
            engine = create_engine('sqlite:///' + (root / 'test.db').as_posix())
            try:
                run_migrations(engine, manifest)
                with engine.begin() as connection:
                    connection.execute(text("INSERT INTO workform (id,name,fields_json,template_purpose,created_at) VALUES (91,'Synthetic','[]','report','2026-10-26')"))
                    connection.execute(text("INSERT INTO workformsubmission (id,form_id,worker_id,work_date,answers_json,created_at) VALUES (91,91,1,'2026-10-26','{}','2026-10-26')"))
                    before = tuple(connection.execute(text('SELECT * FROM workformsubmission')).one())
                    ledger = connection.execute(text('SELECT * FROM schema_migrations ORDER BY version')).all()
                self.assertEqual(run_migrations(engine), ['0027_report_manual_site'])
                self.assertEqual(run_migrations(engine), [])
                with engine.connect() as connection:
                    after = tuple(connection.execute(text('SELECT * FROM workformsubmission')).one())
                    self.assertEqual(after[:-1], before); self.assertIsNone(after[-1])
                    self.assertEqual(connection.execute(text('SELECT * FROM schema_migrations ORDER BY version')).all()[:-1], ledger)
                for query in ("UPDATE workformsubmission SET manual_site_name='Unversioned' WHERE id=91",
                    "INSERT INTO workformsubmission (form_id,worker_id,site_id,manual_site_name,answers_json,created_at) VALUES (91,1,3,'Both','{}','2026-10-26')"):
                    with self.assertRaises(IntegrityError), engine.begin() as connection: connection.execute(text(query))
                with engine.begin() as connection:
                    connection.execute(text("UPDATE workformsubmission SET manual_site_name='Versioned',revision=revision+1,edited_at='2026-10-26',edited_by_supervisor_id=2 WHERE id=91"))
            finally: engine.dispose()


class ManualSiteHttpTests(unittest.TestCase):
    setUp = http_fixture.SupervisorReportTests.setUp
    request = http_fixture.SupervisorReportTests.request

    def test_worker_supervisor_global_and_department_boundaries(self):
        for actor in (1, 2, 4):
            path = '/form-submissions' if actor == 1 else '/supervisor/my-report-submissions'
            payload = {'form_id': 1, 'work_date': '2026-10-26', 'client_template_features': 3,
                       'manual_site_name': 'Synthetic location', 'answers': {'answer': 'Synthetic'}}
            status, body, _ = self.request(actor=actor, path=path, payload=payload)
            self.assertEqual(status, 200, body)
            self.assertEqual(body['worker_id'], actor)
            self.assertEqual(body['department_id'], 1)
            self.assertEqual(body['site_name'], 'Synthetic location')
            status, _, _ = self.request(actor=actor, path=path, payload={**payload, 'manual_site_name': None, 'site_id': 2})
            self.assertIn(status, (400, 404))
            status, _, _ = self.request(actor=actor, path=path, payload={**payload, 'form_id': 2})
            self.assertIn(status, (400, 404))
        self.smtp.assert_not_called()
        with Session(self.engine) as session: self.assertEqual(len(session.exec(select(Site)).all()), 2)


if __name__ == '__main__': unittest.main()
