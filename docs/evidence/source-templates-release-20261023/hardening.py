"""Run the unchanged strict read-only gate against the declared ledger phase."""
from release_operator import *
import re

phase=sys.argv[1]
assert phase in ['current','live']
name='hardening-live' if phase=='live' else 'hardening-current-final'
assert not (OUT/(name+'.json')).exists()
neon='docs/evidence/report-corrections-release-20261023/neon-current-final.json'
proofs={'AlertDeliveryEvidence':'docs/evidence/alert-delivery-diagnosis-2026-10-12.json',
    'NeonRecoveryEvidence':neon,
    'UploadRecoveryEvidence':'docs/evidence/report-fixes-release-20261012/upload-recovery.json'}
command=[shutil.which('pwsh'),'-NoProfile','-File','scripts/check-production-hardening.ps1']
for key,value in proofs.items(): command += ['-'+key,value]
command += ['-BillingAccount','0123B1-051D70-935F73']
if phase=='pre': command += ['-ReleasePhase','PreMigration','-PreMigrationRecoveryHead','0024_report_pdf_email']
proof={'status':'running','startedAtUtc':now(),'strict':True,'sourceCommit':SOURCE,'phase':phase,
    'recoveryProofs':{key:{'path':value,'sha256':hashlib.sha256((ROOT/value).read_bytes()).hexdigest()} for key,value in proofs.items()},'command':command}
write(name+'.json',proof)
result=subprocess.run(command,capture_output=True,encoding='utf-8',errors='replace',timeout=600)
output=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',result.stdout+result.stderr)
output=re.sub(r'(?i)postgres(?:ql)?(?:\+psycopg)?://\S+','[redacted-database-url]',output)
output=re.sub(r'(?i)(Bearer\s+)\S+',r'\1[redacted]',output)
(OUT/(name+'-log.txt')).write_text(output,encoding='utf-8')
proof.update(status='passed' if result.returncode==0 else 'failed',exitCode=result.returncode,checkedAtUtc=now(),
    failures=[x for x in output.splitlines() if x.startswith('not ok - ')],warnings=[x for x in output.splitlines() if x.startswith('warn - ')],
    passingChecks=[x[5:] for x in output.splitlines() if x.startswith('ok - ')])
write(name+'.json',proof)
print(json.dumps({'status':proof['status'],'passingChecks':len(proof['passingChecks']),'failures':proof['failures'],'warnings':proof['warnings']}))
sys.exit(result.returncode)
