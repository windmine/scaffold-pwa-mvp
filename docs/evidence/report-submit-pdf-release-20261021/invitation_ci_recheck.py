"""Repeat the exact failed privacy workflow only, with fresh isolated local data."""
from pathlib import Path
import importlib.util
import json
import subprocess
import sys
from tempfile import TemporaryDirectory
from datetime import datetime, timezone

ROOT=Path.cwd()
OUT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('localchecks',ROOT/'.github/scripts/run_local_checks.py')
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
proof={'startedAtUtc':datetime.now(timezone.utc).isoformat(),'sourceCommit':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),
    'scope':'unchanged exact invitation late-response privacy workflow; isolated local data and SMTP disabled','runs':[]}
for number in range(1,4):
    with TemporaryDirectory(prefix='rf-invitation-ci-recheck-') as temporary:
        env=module.isolated_environment(Path(temporary))
        env['BROWSER_WORKFLOW_ONLY']='Worker invitation late responses'
        log=ROOT/'output'/f'report-submit-pdf-invitation-recheck-{number}.log'
        with log.open('w',encoding='utf-8') as stream:
            result=subprocess.run(['node','scripts/check-browser-workflows.mjs'],env=env,stdout=stream,stderr=subprocess.STDOUT,timeout=180)
        proof['runs'].append({'number':number,'exitCode':result.returncode,'log':str(log.relative_to(ROOT))})
        print(json.dumps(proof['runs'][-1]),flush=True)
        if result.returncode: break
proof['status']='passed' if len(proof['runs'])==3 and all(x['exitCode']==0 for x in proof['runs']) else 'failed'
proof['finishedAtUtc']=datetime.now(timezone.utc).isoformat()
(OUT/'invitation-ci-recheck.json').write_text(json.dumps(proof,indent=2)+'\n',encoding='utf-8')
sys.exit(0 if proof['status']=='passed' else 1)
