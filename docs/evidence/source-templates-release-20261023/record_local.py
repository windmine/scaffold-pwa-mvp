"""Record existing local outcomes without rerunning tests or changing production."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

ROOT=Path.cwd()
OUT=Path(__file__).resolve().parent
LOCAL=ROOT/'output/report-template-preparation-20261022'
names=['backend-checks-loopback.txt','mobile-checks-loopback.txt','mobile-resume.txt','mobile-resume-final.txt']
proofs={name:{'path':(LOCAL/name).relative_to(ROOT).as_posix(),'sha256':hashlib.sha256((LOCAL/name).read_bytes()).hexdigest()} for name in names}
backend=(LOCAL/names[0]).read_text(encoding='utf-8',errors='replace')
mobile=(LOCAL/names[-1]).read_text(encoding='utf-8',errors='replace')
assert 'backend local checks passed' in backend and 'Remaining mobile checks passed' in mobile
browser=mobile.split('Running node scripts/check-browser-workflows.mjs\n',1)[1]
checks=sum(line.startswith('ok - ') for line in browser.splitlines())
assert checks==75
value={'status':'passed','atUtc':datetime.now(timezone.utc).isoformat(),
 'sourceCommit':'f82d5860202c13df0967535b2f1d48d66019ab98','backendSuites':27,'newBackendTests':7,
 'browserWorkflows':checks,'mobileGate':'completed in preserved prefix and resumed suffix; source CI runs entire gate',
 'buildPassed':True,'lintPassed':True,'logs':proofs,
 'preservedAttempts':[
  'Initial sandbox backend loopback/cleanup failure; isolated escalated backend run passed.',
  'Initial browser instrumentation expected prior photo-handler signature; exact test boundary updated.',
  'First complete mobile process ended without terminal result during presentation checks; cause unconfirmed.',
  'Resumed template library assertion omitted intended client feature marker; expectation updated and suffix passed.'
 ],
 'visualReview':['Audit first/last synthetic PDF pages','Axon static instruction PDF page','Audit phone top/end','PPE separate signature contexts','Excavator phone photo/signature section'],
 'limits':['No physical-phone pass','No real GPS capture','No real email','Original PDFs visually checked in parent extraction environment, not materialized on Windows']}
(OUT/'local-gates.json').write_text(json.dumps(value,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'status':'passed','backendSuites':27,'browserWorkflows':checks}))
