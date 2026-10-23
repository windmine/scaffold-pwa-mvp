"""Run the existing approved recovery procedure; retain only sanitized evidence."""
from rollout import *
import re

phase=sys.argv[1]
assert phase in ['pre','current']
ci()
name='neon-premigration' if phase=='pre' else 'neon-current-final'
assert not (OUT/(name+'-request.json')).exists()
if phase=='pre': assert_baseline()
else:
    passed('backend-promotion.json')
    migration=passed('production-proof.json')
    completed=datetime.fromisoformat(migration['executionCompletedAtUtc'].replace('Z','+00:00'))
    assert completed.tzinfo is not None, 'Migration completion time must include its UTC offset'
    eligible=completed+timedelta(seconds=130)
    assert datetime.now(timezone.utc)>=eligible, (
        'Current recovery is too early for a two-minute restore offset; eligibleAtUtc='+eligible.isoformat())
command=[shutil.which('pwsh'),'-NoProfile','-File','scripts/prove-neon-recovery.ps1',
    '-RestoreOffsetMinutes','2','-PythonCommand',sys.executable,'-EvidencePath',str(OUT/(name+'.json'))]
if phase=='pre': command += ['-ReleasePhase','PreMigration','-PreMigrationRecoveryHead','0025_report_corrections']
write(name+'-request.json',{'atUtc':now(),'phase':phase,'command':command,'smtpSecretAccess':False})
result=subprocess.run(command,capture_output=True,encoding='utf-8',errors='replace',timeout=600)
output=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',result.stdout+result.stderr)
output=re.sub(r'(?i)postgres(?:ql)?(?:\+psycopg)?://\S+','[redacted-database-url]',output)
output=re.sub(r'(?i)(Bearer\s+)\S+',r'\1[redacted]',output)
(OUT/(name+'-log.txt')).write_text(output,encoding='utf-8')
assert (OUT/(name+'.json')).exists(),'Inspect recovery branch state before any repeat'
proof=read(name+'.json')
print(json.dumps({'exitCode':result.returncode,'status':proof['status'],'failureStage':proof.get('failureStage'),
    'expectedHead':proof.get('expectedRecoveryHead'),'cleanup':proof.get('cleanup')}))
sys.exit(result.returncode)
