"""Disable only new staff invitation creation over the exact compatible candidate."""
import hashlib
from pathlib import Path

PATH = 'backend/app/use_cases/worker_invitations.py'
ANCHOR = 'def create_staff_invitation(data, supervisor: User, session: Session):\n'
GUARD = ('    raise HTTPException(status_code=503, detail={"code": "staff_invitations_temporarily_disabled",\n'
         '        "message": "New staff invitations are temporarily unavailable. Existing accounts remain available."})\n')

def apply(directory):
    path = Path(directory) / PATH
    before = path.read_bytes()
    text = before.decode('utf-8').replace('\r\n', '\n')
    assert text.count(ANCHOR) == 1 and 'staff_invitations_temporarily_disabled' not in text
    after = text.replace(ANCHOR, ANCHOR + GUARD).encode()
    path.write_bytes(after)
    return {'path': PATH, 'beforeSha256': hashlib.sha256(before).hexdigest(),
        'afterSha256': hashlib.sha256(after).hexdigest(),
        'behavior': 'New staff invitation creation disabled; schema26, pending role guards/acceptance, extended templates, corrections, exports and frozen outbox retained',
        'requiredRuntime': 'Scheduler PAUSED and REPORT_PDF_EMAIL_WORKER_ENABLED=false during fallback; never reset invitations or outbox attempts'}
