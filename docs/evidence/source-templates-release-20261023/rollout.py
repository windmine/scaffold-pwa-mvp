"""No-migration release: preserve runtime/IAM and verify candidate before promotion."""
from release_operator import *
from concurrent.futures import ThreadPoolExecutor
from urllib.request import urlopen
from urllib.error import HTTPError

CANDIDATE = 'geo-backend-templates-20261023'
OLD = 'geo-backend-corrections-20261023'
TAG = 'templates-candidate-20261023'
OUTPUT = {'serving.knative.dev/creator', 'serving.knative.dev/lastModifier',
          'run.googleapis.com/operation-id', 'run.googleapis.com/ingress-status', 'run.googleapis.com/urls'}

def passed(name):
    value = read(name)
    assert value['status'] == 'passed', name
    return value

def ci():
    result = subprocess.run(['gh','run','view',str(read('source-ci-id.json')['id']),
        '--json','databaseId,headSha,status,conclusion,jobs,url'],capture_output=True,encoding='utf-8',check=True,timeout=60)
    value = json.loads(result.stdout)
    assert value['headSha'] == SOURCE and value['status'] == 'completed' and value['conclusion'] == 'success'
    assert len(value['jobs']) == 2 and all(x['conclusion'] == 'success' for x in value['jobs'])
    write('ci-source.json',value)

def invariants():
    def bindings(policy):
        return sorted(json.dumps(x,sort_keys=True) for x in policy.get('bindings',[]))
    baseline = read('preflight.json')
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lambda args: cloud(*args),[
            ('run','services','get-iam-policy',SERVICE,'--region',REGION),
            ('secrets','get-iam-policy','reportflow-smtp-password'),
            ('secrets','versions','describe','1','--secret','reportflow-smtp-password')]))
    assert bindings(results[0]) == bindings(baseline['serviceIam'])
    assert bindings(results[1]) == bindings(baseline['smtpSecretIam'])
    assert results[2]['state'] == 'ENABLED'

def http(origin,path):
    try: response=urlopen(origin.rstrip('/')+path,timeout=30)
    except HTTPError as error: response=error
    with response:
        return {'path':path,'status':response.status,'body':json.load(response)}

def health(origin):
    checks=[http(origin,path) for path in ['/health','/health/ready']]
    assert all(x['status']==200 for x in checks)
    assert all(checks[1]['body']['checks'][key]=='ok' for key in ['database','migrations','upload_storage'])
    return checks

def deploy():
    assert not (OUT/'candidate-deployment-request.json').exists(), 'Inspect uncertain revision before retry'
    ci(); invariants()
    passed('hardening-current-final.json'); passed('database-baseline.json')
    current=assert_baseline()
    assert current['status']['traffic']==[{'revisionName':OLD,'percent':100}]
    runtime=copy.deepcopy(current['spec']['template']['spec'])
    runtime['containers'][0]['image']=read('images.json')['images']['candidate']
    metadata={key:copy.deepcopy(value) for key,value in current['metadata'].items() if key in {'name','namespace','resourceVersion','labels'}}
    metadata['annotations']={key:value for key,value in current['metadata'].get('annotations',{}).items() if key not in OUTPUT}
    template={key:copy.deepcopy(value) for key,value in current['spec']['template']['metadata'].items() if key in {'annotations','labels'}}
    template['name']=CANDIDATE
    traffic=[{'revisionName':OLD,'percent':100},{'revisionName':CANDIDATE,'percent':0,'tag':TAG}]
    document={'apiVersion':'serving.knative.dev/v1','kind':'Service','metadata':metadata,
              'spec':{'template':{'metadata':template,'spec':runtime},'traffic':traffic}}
    write('candidate-deployment-request.json',{'atUtc':now(),'revision':CANDIDATE,'runtime':safe_runtime(runtime),'traffic':traffic,'migrationRequired':False})
    with tempfile.TemporaryDirectory(prefix='rf-templates-service-') as temporary:
        path=Path(temporary)/'service.json'
        path.write_bytes(json.dumps(document).encode())
        cloud('run','services','replace',str(path),'--region',REGION)
    actual=cloud('run','revisions','describe',CANDIDATE,'--region',REGION)
    assert safe_runtime(actual['spec'])==safe_runtime(runtime)
    assert any(x['type']=='Ready' and x['status']=='True' for x in actual['status']['conditions'])
    live=service()
    assert [(t['revisionName'],t.get('percent')) for t in live['status']['traffic'] if t.get('percent')]==[(OLD,100)]
    url=next(t['url'] for t in live['status']['traffic'] if t.get('tag')==TAG)
    checks=health(url)
    invariants()
    write('candidate.json',{'status':'passed','atUtc':now(),'revision':CANDIDATE,'url':url,'runtime':safe_runtime(runtime),'health':checks})
    print(json.dumps({'status':'passed','candidate':CANDIDATE,'productionTraffic':OLD}))

def promote():
    assert not (OUT/'backend-promotion-request.json').exists(), 'Inspect traffic before repeating'
    ci(); invariants(); passed('candidate.json')
    from scheduled_worker import assert_quiesced
    assert_quiesced()
    inventory=passed('database-before-rollout.json')
    assert (datetime.now(timezone.utc)-datetime.fromisoformat(inventory['atUtc'])).total_seconds()<1800
    assert inventory['configured_email_templates']==0 and inventory['pending_emails']==0
    live=service()
    assert [(t['revisionName'],t.get('percent')) for t in live['status']['traffic'] if t.get('percent')]==[(OLD,100)]
    health(passed('candidate.json')['url'])
    write('backend-promotion-request.json',{'atUtc':now(),'revision':CANDIDATE,'previousRevision':OLD,'maintenanceRequired':False})
    cloud('run','services','update-traffic',SERVICE,'--region',REGION,'--to-revisions',CANDIDATE+'=100','--clear-tags')
    live=service()
    assert live['status']['traffic']==[{'revisionName':CANDIDATE,'percent':100}]
    assert safe_runtime(live['spec']['template']['spec'])==read('candidate.json')['runtime']
    checks=health(live['status']['url'])+health(HOST+'/api')
    invariants()
    write('backend-promotion.json',{'status':'passed','atUtc':now(),'revision':CANDIDATE,'previousRevision':OLD,'traffic':live['status']['traffic'],'health':checks,'writePause':False})
    print(json.dumps({'status':'passed','productionRevision':CANDIDATE,'normalService':True,'writePause':False}))

if __name__=='__main__':
    {'deploy':deploy,'promote':promote,'record-build':record_build,'ci':ci}[sys.argv[1]]()
