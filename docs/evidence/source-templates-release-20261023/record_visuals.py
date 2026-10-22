"""Record reviewed synthetic/anonymous screenshots and byte-identical live copies."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

out=Path(__file__).resolve().parent
preview=json.loads((out/'preview-installer.json').read_text(encoding='utf-8'))
live=json.loads((out/'live-installer.json').read_text(encoding='utf-8'))
expected={item['label']:item['sha256'] for item in preview['screenshots']}
copies=[]
for item in live['screenshots']:
    assert item['sha256']==expected[item['label']]
    assert hashlib.sha256(Path(item['path']).read_bytes()).hexdigest()==item['sha256']
    copies.append({'label':item['label'],'sha256':item['sha256'],'matchesReviewedPreview':True})
reviewed=[]
for name in ['preview-installer-english.png','preview-installer-chinese.png','preview-installer-offline.png',
             'live-waiting-update-waiting.png','live-waiting-update-updated.png','live-waiting-update-offline.png']:
    reviewed.append({'path':name,'sha256':hashlib.sha256((out/name).read_bytes()).hexdigest()})
value={'status':'passed','atUtc':datetime.now(timezone.utc).isoformat(),'directlyReviewed':reviewed,'liveInstallerCopies':copies,
       'findings':['Phone-width installer and sign-in controls fit without horizontal overflow.','The update notice is visible before activation and absent after reload.','Cold-offline screenshot is the anonymous header only; no offline login or authenticated content is claimed.'],
       'physicalPhoneTest':False,'authenticatedProductionTest':False}
(out/'visual-review.json').write_text(json.dumps(value,indent=2)+'\n',encoding='utf-8')
print('Recorded six directly reviewed images and three byte-identical live installer copies')
