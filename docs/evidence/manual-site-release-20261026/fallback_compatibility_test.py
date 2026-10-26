"""Synthetic compatible-fallback test, network and SMTP blocked."""
import json, socket
from datetime import datetime, timezone
from io import BytesIO
from unittest.mock import patch
from pypdf import PdfReader
from fastapi import HTTPException
from sqlmodel import select
import report_manual_site_test as fixture
from app.models import Site, WorkFormSubmission
from app.schemas import SupervisorWorkFormSubmissionUpdate
from app.use_cases import supervisor_review as review
from app.use_cases.common import work_form_submission_response

test = fixture.ManualSiteTests()
checks = []
try:
    with patch.object(socket,'create_connection',side_effect=AssertionError('Network forbidden')):
        test.setUp()
        first = test.submit()
        row = test.session.get(WorkFormSubmission,first['id'])
        row.manual_site_name = 'Existing synthetic manual site'
        row.revision += 1
        row.edited_at = datetime.now(timezone.utc)
        row.edited_by_supervisor_id = test.supervisor.id
        test.session.add(row); test.session.commit(); test.session.refresh(row)
        current = work_form_submission_response(row,test.session)
        assert current['site_name']=='Existing synthetic manual site'
        checks.append('schema27 stored labels readable')
        for operation in [lambda:test.submit('blocked',manual_site_name='New synthetic site',client_template_features=3),
                          lambda:test.edit(current,manual_site_name='Changed',site_id=None)]:
            try: operation()
            except HTTPException as error: assert error.status_code==503
            else: raise AssertionError('Fallback manual write was not blocked')
            test.session.rollback()
        checks.append('new manual submissions and corrections fail closed')
        replay=test.submit(manual_site_name='Retry label',client_template_features=3)
        assert replay['idempotent_replay'] and replay['site_name']==current['site_name']
        updated=test.edit(current,site_id=None,answers={'issue':'Synthetic correction'})
        assert updated['site_name']==current['site_name']
        pdf=review.export_form_submission_pdf(submission_id=first['id'],session=test.session,supervisor=test.supervisor)
        assert current['site_name'] in '\n'.join(p.extract_text() for p in PdfReader(BytesIO(pdf.body)).pages)
        checks.append('idempotent replay, old-client corrections and PDF labels preserved')
        test.session.add(Site(id=910,department_id=1,name='Linked synthetic site',latitude=0,longitude=0)); test.session.commit()
        assert test.submit('linked',site_id=910)['site_id']==910
        assert test.submit('blank')['site_name'] is None
        test.smtp.assert_not_called()
        checks.append('linked and blank Site submissions retained without email')
finally:
    test.doCleanups()
print(json.dumps({'status':'passed','checks':checks,'networkAllowed':False,'smtpAttempted':False}))
