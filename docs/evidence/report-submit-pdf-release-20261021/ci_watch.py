"""Read CI only and save compact, credential-free evidence."""
from release_operator import *

run_id = sys.argv[1]
name = sys.argv[2]
result = subprocess.run(['gh','run','view',run_id,'--repo','windmine/scaffold-pwa-mvp',
    '--json','databaseId,headSha,status,conclusion,jobs,url'],capture_output=True,
    encoding='utf-8',errors='replace',timeout=60,check=True)
value=json.loads(result.stdout)
write(name,value)
print(json.dumps({'id':value['databaseId'],'status':value['status'],'conclusion':value['conclusion'],
    'url':value['url'],'jobs':[{'name':x['name'],'status':x['status'],'conclusion':x['conclusion']} for x in value['jobs']]}))
