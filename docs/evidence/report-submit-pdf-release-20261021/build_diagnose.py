from release_operator import *
import re
value=read('build-current.json')
assert value['status']=='FAILURE'
logs=cloud('logging','read',f'resource.type="build" AND resource.labels.build_id="{value["id"]}"',
    '--limit','100','--order','desc','--freshness','2h')
lines=[re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',x.get('textPayload','')) for x in reversed(logs)]
write(sys.argv[1],{'buildId':value['id'],'lines':lines})
print('\n'.join(lines[-80:]))
