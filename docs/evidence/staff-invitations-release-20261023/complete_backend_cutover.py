"""Continue already-journaled backup verification, then one guarded migration/cutover."""
from release_operator import *
import time

def run(script, *args):
    subprocess.run([sys.executable, str(OUT / script), *args], check=True)

def terminal(suffix):
    for _ in range(15):
        run('release_operator.py', 'check', suffix)
        path = OUT / (suffix + '-proof.json')
        if path.exists():
            proof = read(path.name)
            assert proof['status'] == 'passed', 'Probe failed; inspect without rerunning its execution'
            assert proof.get('executionCompletedAtUtc')
            return
        status = read(suffix + '-execution-status.json').get('status', {})
        condition = next((row for row in status.get('conditions', []) if row['type'] == 'Completed'), {})
        assert condition.get('status') != 'False', 'Execution failed; inspect without rerunning'
        time.sleep(15)
    raise RuntimeError('Execution observation timeout; do not launch another execution')

assert (OUT / 'backup-verified-execution.json').exists()
terminal('backup-verified')
print('MILESTONE: backup inventory matches paused production', flush=True)
run('release_operator.py', 'launch', 'production-migrate', 'production')
terminal('production')
print('MILESTONE: additive migration0026 complete; existing business data preserved', flush=True)
run('rollout.py', 'deploy', 'fallback')
run('rollout.py', 'deploy', 'candidate')
run('rollout.py', 'promote')
print('MILESTONE: normal backend service restored', flush=True)
