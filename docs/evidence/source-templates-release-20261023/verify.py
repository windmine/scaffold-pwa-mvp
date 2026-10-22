"""Read-only final verification and exact owned temporary-resource cleanup."""
from rollout import *


def verify():
    current = service()
    assert current['status']['traffic'] == [{'revisionName': CANDIDATE, 'percent': 100}]
    assert safe_runtime(current['spec']['template']['spec']) == read('candidate.json')['runtime']
    invariants()
    checks = health(current['status']['url']) + health(HOST+'/api')
    for origin in [current['status']['url'], HOST+'/api']:
        for path in ['/auth/me', '/supervisor/users', '/supervisor/form-submissions?purpose=report']:
            row = http(origin, path)
            assert row['status'] in [401, 403]
            checks.append({'origin': origin, **row})
    start = read('candidate-deployment-request.json')['atUtc']
    logs = cloud('logging', 'read', f'resource.type="cloud_run_revision" AND resource.labels.service_name="{SERVICE}" AND resource.labels.revision_name="{CANDIDATE}" AND timestamp>="{start}"', '--limit', '5000', '--freshness', '2h')
    errors = [x for x in logs if x.get('severity') in {'ERROR','CRITICAL','ALERT','EMERGENCY'} or x.get('httpRequest',{}).get('status',0) >= 500]
    assert not errors, 'Candidate ERROR or 5xx needs investigation'
    write('live-backend-verification.json', {'status':'passed','atUtc':now(),'revision':CANDIDATE,
          'traffic':current['status']['traffic'],'runtime':safe_runtime(current['spec']['template']['spec']),
          'checks':checks,'logCount':len(logs),'errorOr5xxCount':len(errors),'serviceAndSmtpSecretIamUnchanged':True,
          'secretReferencesUnchanged':True,'publicAppUrl':HOST,'smtpAuthenticationOrEmailAttempted':False})
    print(json.dumps({'operation':'verify','status':'passed','checks':len(checks),'logs':len(logs),'errorOr5xx':0}))


if __name__ == '__main__':
    verify()
