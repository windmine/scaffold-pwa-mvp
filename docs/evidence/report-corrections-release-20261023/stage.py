"""Create only the release-owned isolated staging branch after green source CI."""
from rollout import *

ci()
assert_baseline()
name='reportflow-corrections-stage-20261023'
assert not (OUT/'stage-request.json').exists()
args=[shutil.which('npx.cmd'),'--yes','neon@2.32.0']
def neon(extra):
    result=subprocess.run([*args,*extra,'--project-id','plain-smoke-06194407','--no-analytics','-o','json'],
        capture_output=True,encoding='utf-8',errors='replace',timeout=150)
    assert result.returncode==0,'Provider result unconfirmed; inspect exact requested name before repeating'
    return json.loads(result.stdout)
rows=neon(['branches','list'])
assert not any(row['name']==name for row in rows)
write('stage-request.json',{'atUtc':now(),'name':name,'parent':'br-snowy-tree-a7hfuph6','expiresInHours':4})
expiry=(datetime.now(timezone.utc)+timedelta(hours=4)).strftime('%Y-%m-%dT%H:%M:%SZ')
created=neon(['branches','create','--name',name,'--parent','br-snowy-tree-a7hfuph6','--type','read_write',
    '--suspend-timeout','300','--cu','0.25','--expires-at',expiry])
stage={key:created[key] for key in ('branch','endpoints')}
created=None
assert stage['branch']['name']==name and stage['branch']['parent_id']=='br-snowy-tree-a7hfuph6'
assert stage['branch']['id']!='br-snowy-tree-a7hfuph6'
assert len(stage['endpoints'])==1 and stage['endpoints'][0]['type']=='read_write'
write('stage-branch.json',stage)
print(json.dumps({'status':'created','stageBranch':stage['branch']['id'],'expiresAt':stage['branch']['expires_at']}))
