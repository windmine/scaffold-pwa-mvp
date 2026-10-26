"""Preserve the existing trigger/IAM; pause, drain and upgrade only its worker image."""
from rollout import *

JOB = 'reportflow-pdf-email'


def job():
    return cloud('run', 'jobs', 'describe', JOB, '--region', REGION)


def scheduler():
    return cloud('scheduler', 'jobs', 'describe', JOB, '--location', REGION)


def runtime(value):
    return value['spec']['template']['spec']['template']['spec']


def safe_execution(value):
    """Retain execution identity/status with only hashed literal environment values."""
    result = copy.deepcopy(value)
    result['spec']['template']['spec'] = safe_runtime(result['spec']['template']['spec'])
    return result


def validate_schedule(value, state):
    baseline = read('preflight.json')['scheduler']
    assert value['state'] == state
    for key in ('name', 'description', 'schedule', 'timeZone', 'retryConfig', 'attemptDeadline', 'httpTarget'):
        assert value.get(key) == baseline.get(key), 'Existing Scheduler configuration changed: ' + key
    return value


def preserved_iam():
    baseline = read('preflight.json')
    assert cloud('run', 'jobs', 'get-iam-policy', JOB, '--region', REGION) == baseline['workerIam']
    policy = cloud('projects', 'get-iam-policy', PROJECT)
    assert hashlib.sha256(json.dumps(policy, sort_keys=True).encode()).hexdigest() == baseline['projectIamSha256']
    invariants()


def validate_job(value, enabled, upgraded=False):
    actual = safe_runtime(runtime(value))
    expected = copy.deepcopy(runtime(read('preflight.json')['worker']))
    assert expected['serviceAccountName'] == ACCOUNT
    container = expected['containers'][0]
    flag = next(item for item in container['env'] if item['name'] == 'REPORT_PDF_EMAIL_WORKER_ENABLED')
    flag['valueSha256'] = hashlib.sha256(str(enabled).lower().encode()).hexdigest()
    if upgraded:
        container['image'] = read('images.json')['images']['candidate']
    assert actual == expected, 'Existing PDF worker configuration changed unexpectedly'
    spec = value['spec']['template']['spec']
    baseline_spec = read('preflight.json')['worker']['spec']['template']['spec']
    assert spec['taskCount'] == baseline_spec['taskCount'] == 1
    assert spec['parallelism'] == baseline_spec['parallelism'] == 1
    assert actual.get('maxRetries', 0) == 0 and str(actual['timeoutSeconds']) == '600'
    assert actual['containers'][0]['command'] == ['python']
    assert actual['containers'][0]['args'] == ['-m', 'app.report_pdf_email_worker', '--limit', '10']
    return actual


def active_executions():
    rows = cloud('run', 'jobs', 'executions', 'list', '--job', JOB, '--region', REGION, '--limit', '1000')
    # A terminal completion timestamp, including a failed/cancelled result, is
    # required. Never cancel an in-flight SMTP attempt to hasten the release.
    return [row['metadata']['name'] for row in rows if not row.get('status', {}).get('completionTime')]


def pause():
    assert not (OUT / 'worker-pause-request.json').exists(), 'Inspect prior pause outcome before retry'
    assert_baseline(); preserved_iam()
    validate_schedule(scheduler(), 'ENABLED'); validate_job(job(), True)
    write('worker-pause-request.json', {'atUtc': now(), 'job': JOB, 'actions': ['pause existing Scheduler', 'disable existing worker'],
                                      'iamChanges': False, 'cancelExecutions': False})
    cloud('scheduler', 'jobs', 'pause', JOB, '--location', REGION)
    validate_schedule(scheduler(), 'PAUSED')
    cloud('run', 'jobs', 'update', JOB, '--region', REGION, '--update-env-vars', 'REPORT_PDF_EMAIL_WORKER_ENABLED=false')
    current = validate_job(job(), False); preserved_iam()
    write('worker-paused.json', {'status': 'passed', 'atUtc': now(), 'runtime': current,
                                'schedulerPaused': True, 'workerDisabled': True, 'activeExecutions': active_executions()})
    print(json.dumps({'status': 'paused_drain_pending', 'activeExecutions': read('worker-paused.json')['activeExecutions']}))


def drain():
    passed('worker-paused.json'); validate_schedule(scheduler(), 'PAUSED'); validate_job(job(), False)
    active = active_executions()
    if active:
        write('worker-drain-observation.json', {'atUtc': now(), 'activeExecutions': active})
        print(json.dumps({'status': 'waiting_for_existing_executions', 'count': len(active)})); return
    previous = read('worker-drain-observation.json') if (OUT / 'worker-drain-observation.json').exists() else None
    if not previous or previous['activeExecutions'] or (datetime.now(timezone.utc) - datetime.fromisoformat(previous['atUtc'])).total_seconds() < 5:
        if not previous or previous['activeExecutions']:
            write('worker-drain-observation.json', {'atUtc': now(), 'activeExecutions': []})
        print(json.dumps({'status': 'waiting_for_second_empty_observation', 'minimumSeconds': 5})); return
    preserved_iam()
    write('worker-quiesced.json', {'status': 'passed', 'atUtc': now(), 'firstEmptyAtUtc': previous['atUtc'],
        'schedulerPaused': True, 'workerDisabled': True, 'activeExecutions': [], 'executionsCancelled': False})
    print(json.dumps({'status': 'passed', 'schedulerPaused': True, 'workerDisabled': True, 'activeExecutions': 0}))


def assert_quiesced(upgraded=False):
    passed('worker-quiesced.json'); validate_schedule(scheduler(), 'PAUSED'); validate_job(job(), False, upgraded)
    assert not active_executions(), 'PDF worker execution is still active'


def update():
    assert not (OUT / 'worker-update-request.json').exists(), 'Inspect previous worker update before retry'
    passed('production-proof.json'); passed('backend-promotion.json'); ci(); assert_quiesced(); preserved_iam()
    image = read('images.json')['images']['candidate']
    write('worker-update-request.json', {'atUtc': now(), 'job': JOB, 'image': image, 'enabled': False,
                                       'preserveExistingRuntimeAndIam': True})
    cloud('run', 'jobs', 'update', JOB, '--region', REGION, '--image', image,
          '--update-env-vars', 'REPORT_PDF_EMAIL_WORKER_ENABLED=false')
    value = validate_job(job(), False, True); assert_quiesced(True); preserved_iam()
    write('worker-updated.json', {'status': 'passed', 'atUtc': now(), 'runtime': value, 'schedulerPaused': True})
    print(json.dumps({'status': 'passed', 'workerUpdated': True, 'workerEnabled': False}))


def execute_disabled():
    assert not (OUT / 'disabled-worker-execution-request.json').exists()
    passed('worker-updated.json'); assert_quiesced(True)
    write('disabled-worker-execution-request.json', {'atUtc': now(), 'job': JOB, 'enabled': False, 'oneExecution': True})
    result = cloud('run', 'jobs', 'execute', JOB, '--region', REGION, '--async')
    write('disabled-worker-execution.json', safe_execution(result))
    print(json.dumps({'execution': result['metadata']['name'], 'mode': 'disabled', 'status': 'started'}))


def aggregate(execution):
    rows = cloud('logging', 'read', f'resource.type="cloud_run_job" AND resource.labels.job_name="{JOB}" AND labels."run.googleapis.com/execution_name"="{execution}"',
                 '--limit', '100', '--freshness', '2h')
    results = []
    for row in rows:
        data = row.get('jsonPayload')
        if data is None:
            try: data = json.loads(row.get('textPayload', ''))
            except (ValueError, TypeError): continue
        if isinstance(data, dict) and data.get('status') in ('disabled', 'completed', 'blocked'):
            results.append(data)
    return results


def check_disabled():
    execution = read('disabled-worker-execution.json')['metadata']['name']
    result = cloud('run', 'jobs', 'executions', 'describe', execution, '--region', REGION)
    condition = next((x for x in result.get('status', {}).get('conditions', []) if x['type'] == 'Completed'), {})
    if condition.get('status') == 'Unknown' or not condition:
        print(json.dumps({'status': 'running', 'execution': execution})); return
    assert condition.get('status') == 'True'
    values = aggregate(execution); assert values == [{'status': 'disabled'}]
    write('disabled-worker-proof.json', {'status': 'passed', 'atUtc': now(), 'execution': execution,
        'result': values[0], 'smtpAuthenticationOrEmailAttempted': False})
    print(json.dumps({'status': 'passed', 'result': 'disabled', 'smtpAttempted': False}))


def enable():
    assert not (OUT / 'worker-enable-request.json').exists()
    passed('disabled-worker-proof.json'); passed('backend-promotion.json'); passed('hosting-promotion.json')
    inventory = passed('pre-worker-verified-proof.json')['before']
    assert inventory['configuredTemplateRows'] == 0 and inventory['outboxRows'] == 0, 'Unexpected email routing or queued work; inspect before enabling'
    assert (datetime.now(timezone.utc) - datetime.fromisoformat(passed('pre-worker-verified-proof.json')['atUtc'])).total_seconds() < 300
    assert_quiesced(True); preserved_iam()
    write('worker-enable-request.json', {'atUtc': now(), 'job': JOB, 'schedulerPaused': True, 'restoreExistingEnabledState': True})
    cloud('run', 'jobs', 'update', JOB, '--region', REGION, '--update-env-vars', 'REPORT_PDF_EMAIL_WORKER_ENABLED=true')
    value = validate_job(job(), True, True); validate_schedule(scheduler(), 'PAUSED'); preserved_iam()
    write('worker-enabled.json', {'status': 'passed', 'atUtc': now(), 'runtime': value, 'schedulerPaused': True})
    print(json.dumps({'status': 'passed', 'workerEnabled': True, 'schedulerPaused': True}))


def activate():
    assert not (OUT / 'scheduler-activation-request.json').exists()
    passed('worker-enabled.json'); passed('hosting-promotion.json'); passed('backend-promotion.json')
    validate_job(job(), True, True); validate_schedule(scheduler(), 'PAUSED'); preserved_iam()
    assert not active_executions()
    write('scheduler-activation-request.json', {'atUtc': now(), 'job': JOB,
        'restoreExistingSchedule': True, 'newEmailTest': False, 'existingPendingWorkResumesNormally': True})
    cloud('scheduler', 'jobs', 'resume', JOB, '--location', REGION)
    value = validate_schedule(scheduler(), 'ENABLED'); preserved_iam()
    write('scheduler-active.json', {'status': 'passed', 'atUtc': now(), 'scheduler': value})
    print(json.dumps({'status': 'passed', 'scheduler': 'ENABLED', 'cadence': 'existing every five minutes'}))


def verify_scheduled():
    active = passed('scheduler-active.json'); value = validate_schedule(scheduler(), 'ENABLED')
    current = validate_job(job(), True, True); preserved_iam()
    rows = cloud('run', 'jobs', 'executions', 'list', '--job', JOB, '--region', REGION, '--limit', '100')
    after = datetime.fromisoformat(active['atUtc'])
    matches = [row for row in rows if datetime.fromisoformat(row['metadata']['creationTimestamp'].replace('Z', '+00:00')) >= after]
    completed = []
    for row in matches:
        if not row.get('status', {}).get('completionTime'): continue
        condition = next((x for x in row['status'].get('conditions', []) if x['type'] == 'Completed'), {})
        assert condition.get('status') == 'True', 'Scheduled worker failed; inspect durable results, never reset attempts'
        values = aggregate(row['metadata']['name'])
        assert len(values) == 1 and values[0]['status'] == 'completed'
        counts = values[0]['counts']
        assert set(counts) == {'accepted', 'failed', 'uncertain', 'skipped'} and all(type(v) is int and v >= 0 for v in counts.values())
        completed.append({'execution': row['metadata']['name'], 'result': values[0], 'completedAt': row['status']['completionTime']})
    if not completed:
        print(json.dumps({'status': 'waiting_for_scheduled_execution', 'scheduleTime': value.get('scheduleTime')})); return
    assert value.get('lastAttemptTime') and datetime.fromisoformat(value['lastAttemptTime'].replace('Z', '+00:00')) >= after
    assert value.get('status', {}).get('code', 0) == 0
    write('scheduled-worker-verification.json', {'status': 'passed', 'atUtc': now(), 'scheduler': value,
        'executions': completed, 'runtime': current, 'existingIamPreserved': True,
        'normalScheduledWorkProcessed': any(sum(entry['result']['counts'].values()) for entry in completed)})
    print(json.dumps({'status': 'passed', 'scheduledExecutions': len(completed),
                      'aggregateCounts': [entry['result']['counts'] for entry in completed]}))


def quiesce_fallback():
    """Prepare a limited service fallback without interrupting SMTP in flight."""
    assert not (OUT / 'fallback-worker-pause-request.json').exists(), 'Inspect existing fallback pause outcome before retry'
    passed('production-proof.json'); passed('fallback.json'); preserved_iam()
    current = job()
    image = runtime(current)['containers'][0]['image']
    upgraded = image == read('images.json')['images']['candidate']
    entries = {entry['name']: entry for entry in runtime(current)['containers'][0]['env']}
    assert entries['REPORT_PDF_EMAIL_WORKER_ENABLED']['value'] in ('true', 'false')
    enabled = entries['REPORT_PDF_EMAIL_WORKER_ENABLED']['value'] == 'true'
    validate_job(current, enabled, upgraded)
    schedule = scheduler(); assert schedule['state'] in ('ENABLED', 'PAUSED')
    validate_schedule(schedule, schedule['state'])
    write('fallback-worker-pause-request.json', {'atUtc': now(), 'job': JOB, 'upgradedImage': upgraded,
        'schedulerState': schedule['state'], 'workerEnabled': enabled, 'cancelExecutions': False})
    if schedule['state'] == 'ENABLED': cloud('scheduler', 'jobs', 'pause', JOB, '--location', REGION)
    validate_schedule(scheduler(), 'PAUSED')
    if enabled: cloud('run', 'jobs', 'update', JOB, '--region', REGION, '--update-env-vars', 'REPORT_PDF_EMAIL_WORKER_ENABLED=false')
    validate_job(job(), False, upgraded); preserved_iam()
    write('fallback-worker-paused.json', {'status': 'passed', 'atUtc': now(), 'upgradedImage': upgraded,
        'activeExecutions': active_executions(), 'schedulerPaused': True, 'workerDisabled': True})
    print(json.dumps({'status': 'fallback_paused_drain_pending', 'activeExecutions': read('fallback-worker-paused.json')['activeExecutions']}))


def drain_fallback():
    proof = passed('fallback-worker-paused.json')
    validate_schedule(scheduler(), 'PAUSED'); validate_job(job(), False, proof['upgradedImage'])
    active = active_executions()
    name = 'fallback-worker-drain-observation.json'
    previous = read(name) if (OUT / name).exists() else None
    if active or not previous or previous['activeExecutions']:
        write(name, {'atUtc': now(), 'activeExecutions': active})
        print(json.dumps({'status': 'waiting_for_fallback_drain', 'activeExecutions': len(active), 'minimumSeconds': 5})); return
    if (datetime.now(timezone.utc) - datetime.fromisoformat(previous['atUtc'])).total_seconds() < 5:
        print(json.dumps({'status': 'waiting_for_second_empty_observation', 'minimumSeconds': 5})); return
    preserved_iam()
    write('fallback-worker-quiesced.json', {'status': 'passed', 'atUtc': now(), 'upgradedImage': proof['upgradedImage'],
        'firstEmptyAtUtc': previous['atUtc'], 'activeExecutions': [], 'schedulerPaused': True, 'workerDisabled': True})
    print(json.dumps({'status': 'passed', 'fallbackWorkerQuiesced': True}))


def assert_fallback_quiesced():
    proof = passed('fallback-worker-quiesced.json')
    validate_schedule(scheduler(), 'PAUSED'); validate_job(job(), False, proof['upgradedImage'])
    assert not active_executions(), 'Existing PDF execution has not completed'
    preserved_iam()


if __name__ == '__main__':
    actions = {'pause': pause, 'drain': drain, 'update': update, 'execute-disabled': execute_disabled,
               'check-disabled': check_disabled, 'enable': enable, 'activate': activate, 'verify-scheduled': verify_scheduled,
               'quiesce-fallback': quiesce_fallback, 'drain-fallback': drain_fallback}
    actions[sys.argv[1]]()
