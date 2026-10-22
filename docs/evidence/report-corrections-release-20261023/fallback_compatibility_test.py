"""Run against the packaged fallback. Synthetic DB, blocked network, no SMTP."""
from contextlib import ExitStack, redirect_stdout
from datetime import datetime, timezone
from io import BytesIO, StringIO
import json
import os
from pathlib import Path
import socket
from tempfile import TemporaryDirectory
from unittest.mock import patch


def main():
    with TemporaryDirectory(prefix='corrections-fallback-') as directory, ExitStack() as stack:
        root = Path(directory)
        os.environ.update({'DATABASE_URL': 'sqlite:///' + (root / 'data.db').as_posix(),
            'APP_ENV': 'development', 'K_SERVICE': '', 'AUTO_MIGRATE': 'false',
            'GEO_SECRET_KEY': 'isolated-fallback-fixture-not-a-real-credential',
            'UPLOAD_STORAGE_BACKEND': 'local', 'UPLOAD_DIR': str(root / 'uploads'), 'UPLOAD_BUCKET': '',
            'SMTP_HOST': '', 'SMTP_USERNAME': '', 'SMTP_PASSWORD': '', 'SMTP_FROM_EMAIL': '',
            'REGISTRATION_EMAIL_ENABLED': 'false', 'REPORT_PDF_EMAIL_WORKER_ENABLED': 'false',
            'ENABLE_DEV_SEED': 'false', 'RATE_LIMIT_ENABLED': 'false'})
        with patch.object(socket, 'create_connection', side_effect=AssertionError('Network forbidden')):
            from fastapi import HTTPException
            from PIL import Image
            from sqlalchemy import update
            from sqlalchemy.exc import IntegrityError
            from sqlmodel import Session, create_engine, select
            from app import report_pdf_email_worker, upload_storage
            from app.migrations import run_migrations, verify_migrations
            from app.models import Department, ReportPdfEmail, User, WorkForm, WorkFormSubmission
            from app.schemas import ReportTransitionRequest, SupervisorWorkFormSubmissionUpdate, WorkFormSubmissionCreate
            from app.use_cases import report_pdf_email, supervisor_review, work_forms
            engine = create_engine(os.environ['DATABASE_URL'])
            stack.callback(engine.dispose)
            assert run_migrations(engine)[-1] == '0025_report_corrections'
            with engine.connect() as connection:
                verify_migrations(connection)
            checks = []
            with Session(engine) as session:
                worker = User(id=9001, department_id=9901, email='worker@example.invalid', name='Worker', password_hash='unused')
                supervisor = User(id=9002, department_id=9901, email='supervisor@example.invalid', name='Supervisor', role='supervisor', password_hash='unused')
                foreign = User(id=9003, department_id=9902, email='foreign@example.invalid', name='Other', role='supervisor', password_hash='unused')
                form = WorkForm(id=9001, department_id=9901, name='Fallback fixture', pdf_email_enabled=True,
                    pdf_email_recipient='recipient@example.invalid', fields_json=json.dumps([
                    {'id': 'issue', 'type': 'text', 'label': 'Issue'}, {'id': 'signed', 'type': 'signature', 'label': 'Signed'}]))
                session.add_all([Department(id=9901, name='One'), Department(id=9902, name='Two'), worker, supervisor, foreign, form])
                session.commit()
                def raster(color, owner):
                    value = BytesIO(); Image.new('RGB', (8, 8), color).save(value, format='PNG')
                    return '/uploads/' + upload_storage.store_verified_raster(value.getvalue(), owner).filename
                for status in ('pending', 'accepted', 'uncertain'):
                    original_photo, signature = raster('red', worker.id), raster('blue', worker.id)
                    submitted = work_forms.create_work_form_submission(WorkFormSubmissionCreate(form_id=9001,
                        expected_definition_version=1, work_date='2026-10-21', client_submission_id='fallback-' + status,
                        answers={'issue': 'Original ' + status, 'signed': signature}, photo_urls=[original_photo]), worker, session)
                    row = session.exec(select(ReportPdfEmail).where(ReportPdfEmail.submission_id == submitted['id'])).one()
                    frozen = row.snapshot_json
                    row.status = status; session.add(row); session.commit()
                    replacement = raster('green', supervisor.id)
                    # Model a correction already committed by the full candidate before fallback.
                    session.execute(update(WorkFormSubmission).where(WorkFormSubmission.id == submitted['id']).values(
                        answers_json=json.dumps({'issue': 'Corrected ' + status, 'signed': signature}),
                        photo_urls=json.dumps([replacement]), work_date='2026-10-23', revision=2,
                        edited_at=datetime.now(timezone.utc), edited_by_supervisor_id=supervisor.id))
                    session.commit(); session.expire_all()
                    record = session.get(WorkFormSubmission, submitted['id'])
                    assert record.revision == 2 and json.loads(record.answers_json)['issue'] == 'Corrected ' + status
                    payload = SupervisorWorkFormSubmissionUpdate(confirmed=True, expected_revision=2, answers={'issue': 'Blocked'})
                    try: supervisor_review.update_supervisor_form_submission(record.id, payload, supervisor, session)
                    except HTTPException as error:
                        assert error.status_code == 503 and error.detail['code'] == 'report_corrections_temporarily_disabled'
                    else: raise AssertionError('Fallback correction was allowed')
                    try: work_forms.transition_report(record.id, ReportTransitionRequest(status='in_review'), supervisor, session)
                    except HTTPException as error: assert error.status_code == 409
                    else: raise AssertionError('Retired transition was allowed')
                    try: supervisor_review.update_supervisor_form_submission(record.id, payload, foreign, session)
                    except HTTPException as error: assert error.status_code == 404
                    else: raise AssertionError('Foreign scope was exposed')
                    item = next(item for item in work_forms.list_my_form_submissions(worker, session, purpose='report') if item['id'] == record.id)
                    assert item['revision'] == 2 and item['answers']['issue'] == 'Corrected ' + status
                    assert item['workflow_status'] == 'submitted' and item['supervisor_note'] is None
                    for export in (supervisor_review.export_form_submission_csv, supervisor_review.export_form_submission_html,
                                   supervisor_review.export_form_submission_pdf):
                        response = export(submission_id=record.id, session=session, supervisor=supervisor)
                        assert response.status_code == 200 and response.body
                        if export != supervisor_review.export_form_submission_pdf:
                            assert ('Corrected ' + status).encode() in response.body
                        else: assert response.body.startswith(b'%PDF')
                    for actor in (worker, supervisor):
                        assert upload_storage.open_authorized_upload(replacement.rsplit('/', 1)[1], actor, session)
                        assert upload_storage.open_authorized_upload(signature.rsplit('/', 1)[1], actor, session)
                    assert not upload_storage.open_authorized_upload(replacement.rsplit('/', 1)[1], foreign, session)
                    assert upload_storage.upload_adapter().stat(original_photo.rsplit('/', 1)[1])
                    delivered = report_pdf_email._snapshot_for_delivery(row, session)
                    assert delivered['answers']['issue'] == 'Original ' + status and delivered['photo_urls'] == [original_photo]
                    assert row.snapshot_json == frozen and row.status == status
                    try:
                        session.execute(update(ReportPdfEmail).where(ReportPdfEmail.id == row.id).values(snapshot_json='{}'))
                        session.commit()
                    except IntegrityError: session.rollback()
                    else: raise AssertionError('Frozen outbox changed')
                    checks.append(status + ': corrected reads/exports/evidence, editing/transition guards, frozen original outbox')
                # Submission remains available without dispatch; every new identity queues exactly once.
                before = len(session.exec(select(ReportPdfEmail)).all())
                work_forms.create_work_form_submission(WorkFormSubmissionCreate(form_id=9001, expected_definition_version=1,
                    work_date='2026-10-23', client_submission_id='fallback-new', answers={'issue': 'New submission'}), worker, session)
                assert len(session.exec(select(ReportPdfEmail)).all()) == before + 1
                captured = StringIO()
                with patch('sys.argv', ['worker']), redirect_stdout(captured):
                    assert report_pdf_email_worker.main() == 0
                assert json.loads(captured.getvalue()) == {'status': 'disabled'}
                checks.append('new submission and outbox enqueue; disabled worker performs no dispatch')
            engine.dispose()
            print(json.dumps({'status': 'passed', 'checks': checks, 'networkAllowed': False, 'smtpAttempted': False}))


if __name__ == '__main__':
    main()
