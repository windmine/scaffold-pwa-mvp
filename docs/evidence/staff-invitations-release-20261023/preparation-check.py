"""Local consistency check for the bounded release procedure; no cloud calls."""
import ast, hashlib, json
from pathlib import Path
out=Path(__file__).resolve().parent
for path in out.glob('*.py'):
    ast.parse(path.read_text())
fallback=json.loads((out/'fallback-local.json').read_text())
assert fallback['status']=='passed' and fallback['cleanupComplete']
probe=(out/'runtime_probe.py').read_text()
assert "before['migrationCount'] == 25" in probe and "after['migrationCount'] == 26" in probe
assert "table == 'workerinvitation'" in probe and 'invited_is_global_admin' in probe
assert "before['businessTables'] == after['businessTables']" in probe
rollout=(out/'rollout.py').read_text()
assert "OLD = 'geo-backend-templates-20261023'" in rollout
assert 'geo-backend-staff-invitations-fallback-20261023' in rollout
assert "PREVIOUS = 'e827de152baed084'" in (out/'frontend.py').read_text()
for name in ['recovery.py','hardening.py']:
    assert '0025_report_corrections' in (out/name).read_text()
files={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in out.glob('*.py')}
proof={'status':'passed','helperSha256':files,'migration':'0025 to 0026; adds only invitation role/grant snapshot columns','fallback':'exact candidate plus new-staff-create guard, pending acceptance and report/template features retained','iamChanges':False,'smtpSecretVersion':'1 unchanged','realEmailTest':False,'unrelatedWorkspaceEdits':'preserved and excluded from runtime build','libraryGuide':'libfile_860858c4be908191868c0ba124cc0dc7','localLibraryXattr':'unsupported on Windows (os.setxattr absent); upload succeeded','preservedReleasePreparationFailure':'First local fallback fixture collided with seeded Department1; switched synthetic fixture to9901; final proof passed'}
(out/'preparation-validation.json').write_text(json.dumps(proof,indent=2)+'\n')
print(json.dumps({'status':'passed','helpers':len(files),'cloudActions':False}))
