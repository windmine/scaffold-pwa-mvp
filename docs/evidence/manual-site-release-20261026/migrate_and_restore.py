"""Finish the approved write pause once its drain ends; stop on any uncertain result."""
from release_operator import *
import time
assert not (OUT/'backup-request.json').exists()
pause=read('pause.json'); assert pause['status']=='passed'
deadline=datetime.fromisoformat(pause['drainUntilUtc'])
while datetime.now(timezone.utc)<deadline:
    time.sleep(min(30,max(0,(deadline-datetime.now(timezone.utc)).total_seconds())))
def run(script,*args):
    subprocess.run([sys.executable,'-u',str(OUT/script),*args],check=True)
print('MILESTONE: required request drain complete',flush=True)
run('rollout.py','backup')
run('release_operator.py','launch','backup-verify','backup-verified')
run('complete_backend_cutover.py')
