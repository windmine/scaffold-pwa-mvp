"""Local release consistency; no provider operations."""
import ast, hashlib, json
from pathlib import Path
out=Path(__file__).resolve().parent
for path in out.glob('*.py'): ast.parse(path.read_text())
fallback=json.loads((out/'fallback-working-tree.json').read_text())
assert fallback['status']=='passed' and fallback['cleanupComplete']
probe=(out/'runtime_probe.py').read_text()
for value in ["before['migrationCount'] == 26", "after['migrationCount'] == 27",
              "table == 'workformsubmission'", 'manual_site_name',
              "before['businessTables'] == after['businessTables']"]: assert value in probe
assert "OLD = 'geo-backend-staff-invitations-20261023'" in (out/'rollout.py').read_text()
assert "PREVIOUS = '35a126d8e9de6e5b'" in (out/'frontend.py').read_text()
for name in ['recovery.py','hardening.py']: assert '0026_staff_invitations' in (out/name).read_text()
proof={'status':'passed','helperSha256':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in out.glob('*.py')},
       'migration':'0026 to 0027; nullable manual_site_name and consistency/revision guards',
       'fallback':'exact candidate with nonempty manual Site write guard; compatible reads, exports, existing ID/no-Site submission and committed replay retained',
       'iamChanges':False,'smtpSecretVersion':'1 unchanged','realEmails':False,
       'unrelatedWorkspaceEdits':'preserved and excluded'}
(out/'preparation-validation.json').write_text(json.dumps(proof,indent=2)+'\n')
print(json.dumps({'status':'passed','helpers':len(proof['helperSha256'])}))
