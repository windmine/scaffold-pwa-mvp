"""One explicit guard over the exact candidate; never alters the working source."""
import hashlib
from pathlib import Path

PATH = 'backend/app/use_cases/report_corrections.py'
ANCHOR = 'def correct_report(submission, data, supervisor, session):\n'
GUARD = ('    raise HTTPException(status_code=503, detail={"code": "report_corrections_temporarily_disabled",\n'
         '        "message": "Report editing is temporarily unavailable. Saved Reports remain available."})\n')


def apply(directory):
    path = Path(directory) / PATH
    before = path.read_bytes()
    text = before.decode('utf-8').replace('\r\n', '\n')
    assert text.count(ANCHOR) == 1 and 'report_corrections_temporarily_disabled' not in text
    after = text.replace(ANCHOR, ANCHOR + GUARD).encode()
    path.write_bytes(after)
    return {'path': PATH, 'beforeSha256': hashlib.sha256(before).hexdigest(),
            'afterSha256': hashlib.sha256(after).hexdigest(),
            'behavior': 'Report corrections disabled; candidate schema25, reads, exports, evidence, submissions and frozen outbox compatibility retained',
            'requiredRuntime': 'Scheduler PAUSED and REPORT_PDF_EMAIL_WORKER_ENABLED=false; never reset outbox attempts'}
