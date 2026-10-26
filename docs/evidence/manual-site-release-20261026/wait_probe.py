"""Observe an already-launched probe; never start or retry an execution."""
from release_operator import *
import time
suffix=sys.argv[1]
assert (OUT/(suffix+'-execution.json')).exists()
for _ in range(20):
    check_job(suffix)
    path=OUT/(suffix+'-proof.json')
    if path.exists():
        result=read(path.name)
        assert result['status']=='passed' and result['executionCompletedAtUtc'], 'Probe failed; inspect without repeating'
        break
    state=read(suffix+'-execution-status.json').get('status',{})
    assert not any(x['type']=='Completed' and x.get('status')=='False' for x in state.get('conditions',[])), 'Execution failed; do not repeat'
    time.sleep(15)
else: raise RuntimeError('Observation deadline reached; execution was not repeated or cancelled')
