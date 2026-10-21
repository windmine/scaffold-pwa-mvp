"""Prepare release-specific copies of the established journaled operators."""
from pathlib import Path
import ast
import json

ROOT = Path.cwd()
OUT = Path(__file__).resolve().parent
OLD = ROOT / 'docs/evidence/invitation-email-release-20261020'
SOURCE = '80b4ea01a041a84bdcc0483f8e3d41a34d55f117'
BASE = '35204d8884ce751ffed3deb67896e9e0139b6313'


def save(name, text):
    assert not (OUT/name).exists(), name
    ast.parse(text)
    (OUT/name).write_text(text, encoding='utf-8', newline='\n')


def copy_source(name):
    return (OLD/name).read_text().replace('invitation-email-release-20261020', 'report-submit-pdf-release-20261021').replace('2f861c569949e5f91e29748d7ab47c672c7beef1', SOURCE)


def main():
    baseline = json.loads((OUT/'preflight.json').read_text())
    (OUT/'baseline-service.json').write_text(json.dumps({
        'runtime': baseline['runtime'], 'templateMetadata': baseline['templateMetadata'],
        'status': baseline['serviceStatus'], 'serviceIam': baseline['serviceIam'],
        'smtpSecretIam': baseline['smtpSecretIam']}, indent=2)+'\n')
    text = copy_source('release_operator.py').replace("BUILD = '04840382-49f1-49bb-8e4c-15a958822bae'", "BUILD = None")
    text = text.replace("build = cloud('builds', 'describe', BUILD,", "build_id = read('build-submission.json')['id']\n    build = cloud('builds', 'describe', build_id,")
    text = text.replace("'buildId': BUILD", "'buildId': build_id").replace("'build': BUILD", "'build': build_id")
    text = text.replace('rf-invite-', 'rf-pdf-').replace('20261020', '20261021')
    text = text.replace('geo-backend-invite-maint-', 'geo-backend-report-pdf-maint-')
    text = text.replace("code = (OUT / 'runtime_probe.py').read_text(encoding='utf-8')", "code = (OUT / 'runtime_probe.py').read_text(encoding='utf-8')\n    if mode.startswith('stage-'):\n        code = code.replace('STAGE_BRANCH_REPLACE', stage['branch']['id'])")
    save('release_operator.py', text)

    text = copy_source('runtime_probe.py')
    text = text.replace('ADDED = {"email_status", "email_attempted_at", "email_accepted_at"}', 'ADDED = {"pdf_email_enabled", "pdf_email_recipient", "pdf_email_version"}')
    text = text.replace('if table == "schema_migrations":', 'if table in {"schema_migrations", "reportpdfemail"}:')
    text = text.replace("table == 'workerinvitation'", "table == 'workform'")
    text = text.replace("table_name='workerinvitation'", "table_name='workform'")
    text = text.replace('invitationEmailColumns', 'pdfEmailColumns')
    text = text.replace("SELECT count(*) FROM workerinvitation WHERE email_status <> 'not_sent' OR email_attempted_at IS NOT NULL OR email_accepted_at IS NOT NULL", 'SELECT count(*) FROM workform WHERE pdf_email_enabled OR pdf_email_recipient IS NOT NULL OR pdf_email_version <> 1')
    text = text.replace('result["emailAttemptRows"] = cursor.fetchone()[0]', 'result["configuredTemplateRows"] = cursor.fetchone()[0]\n                cursor.execute("SELECT count(*) FROM reportpdfemail")\n                result["outboxRows"] = cursor.fetchone()[0]\n                cursor.execute("SELECT count(*) FROM reportpdfemail WHERE status=\'pending\'")\n                result["pendingOutboxRows"] = cursor.fetchone()[0]')
    text = text.replace('br-gentle-sound-a7reig2b', 'STAGE_BRANCH_REPLACE')
    text = text.replace('rf_invite_smoke_', 'rf_pdf_smoke_').replace('owned-invitation-release:', 'owned-report-pdf-release:')
    text = text.replace("== 23", "== 24").replace("== 22", "== 23")
    text = text.replace('0023_worker_invitation_email', '0024_report_pdf_email').replace('0022_worker_password_recovery', '0023_worker_invitation_email')
    text = text.replace("after['emailAttemptRows'] == 0", "after['configuredTemplateRows'] == 0 and after['outboxRows'] == 0")
    text = text.replace("proof['api'] = local_api(env, smoke=mode != 'stage-fallback')", "proof['api'] = local_api(env, smoke=False)")
    save('runtime_probe.py', text)

    text = copy_source('build_images.py').replace('b32dc42785289c995ea53e2a60e3e1336ae9c75f', BASE)
    text = text.replace('0023_worker_invitation_email', '0024_report_pdf_email').replace('20261020', '20261021')
    text = text.replace('reportflow-invitation', 'reportflow-report-pdf').replace(':invitation-', ':report-pdf-')
    text = text.replace('(target / MIGRATION).write_bytes(subprocess.check_output(["git", "show", SOURCE + ":" + MIGRATION], cwd=ROOT))', 'for path in [MIGRATION, "backend/app/models.py", "backend/app/use_cases/record_trash.py"]:\n                (target / path).write_bytes(subprocess.check_output(["git", "show", SOURCE + ":" + path], cwd=ROOT))')
    text = text.replace('["invitation_email_test.py"] if kind == "candidate" else []', '["invitation_email_test.py", "report_pdf_email_test.py", "supervisor_report_submission_test.py"] if kind == "candidate" else ["invitation_email_test.py"]')
    text = text.replace('from app.models import User,WorkerInvitation;', 'from app.models import User,WorkerInvitation,WorkForm,ReportPdfEmail;')
    text = text.replace('len(v)==23', 'len(v)==24').replace('Fallback exact 23-migration', 'Fallback exact 24-migration')
    text = text.replace('s.exec(select(WorkerInvitation)).all(); s.close();', 's.exec(select(WorkerInvitation)).all(); s.exec(select(WorkForm)).all(); s.exec(select(ReportPdfEmail)).all(); s.close();')
    save('build_images.py', text)

    text = copy_source('rollout.py')
    text = text.replace('geo-backend-invite-', 'geo-backend-report-pdf-').replace('20261020', '20261021')
    text = text.replace("OLD = 'geo-backend-smtp-20261021'", "OLD = 'geo-backend-invite-20261020'")
    text = text.replace("'39515236017'", "str(read('source-ci-id.json')['id'])")
    text = text.replace("tag = 'invite-'", "tag = 'report-pdf-'")
    text = text.replace('reportflow-invitation-backup-', 'reportflow-report-pdf-backup-')
    text = text.replace("env['PUBLIC_APP_URL'] = {'name': 'PUBLIC_APP_URL', 'value': HOST}", "assert env['PUBLIC_APP_URL']['value'] == HOST\n        env['REPORT_PDF_EMAIL_WORKER_ENABLED'] = {'name': 'REPORT_PDF_EMAIL_WORKER_ENABLED', 'value': 'false'}")
    save('rollout.py', text)

    text = copy_source('frontend.py').replace('release-invite-20261020', 'release-report-pdf-20261021').replace('rollback-invite-20261020', 'rollback-report-pdf-20261021').replace('61d90b34933c5079', '4988eacbe73feaaf')
    save('frontend.py', text)
    text = copy_source('verify_cleanup.py').replace('rf-invite-', 'rf-pdf-').replace('-20261020', '-20261021')
    text = text.replace("assert stage['id']=='br-gentle-sound-a7reig2b'", "assert stage['name']=='reportflow-report-pdf-stage-20261021'")
    save('verify_cleanup.py', text)
    print('Prepared release-specific operators; no provider operations executed')


if __name__ == '__main__': main()
