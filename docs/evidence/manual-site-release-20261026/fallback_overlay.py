"""Preserve schema27/read/export/replay support while blocking manual Site writes."""
import hashlib
from pathlib import Path

PATH = 'backend/app/use_cases/common.py'
ANCHOR = 'def normalize_report_site_name(value, site_id, purpose="report"):\n'
GUARD = ('    if value is not None and value.strip():\n'
         '        raise HTTPException(status_code=503, detail={"code": "manual_site_temporarily_disabled",\n'
         '            "message": "Typed Site names are temporarily unavailable. Saved reports remain available."})\n')

def apply(directory):
    path = Path(directory) / PATH
    before = path.read_bytes()
    text = before.decode('utf-8').replace('\r\n','\n')
    assert text.count(ANCHOR) == 1 and 'manual_site_temporarily_disabled' not in text
    after = text.replace(ANCHOR, ANCHOR + GUARD).encode()
    path.write_bytes(after)
    return {'path':PATH,'beforeSha256':hashlib.sha256(before).hexdigest(),
        'afterSha256':hashlib.sha256(after).hexdigest(),
        'behavior':'Block nonempty manual Site writes, preserve schema27, stored labels, existing-ID/no-Site submissions, replay, corrections without a supplied manual name, exports and frozen outbox',
        'requiredRuntime':'Pause Scheduler, disable and drain worker before fallback; preserve ledger, attempts and device storage'}
