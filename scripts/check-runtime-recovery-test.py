"""Offline runtime recovery trust-boundary tests; never contacts providers."""
import ast
import base64
import copy
import gzip
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import tarfile
import types
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timezone
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


canonical = load('canonical_verifier', ROOT / 'scripts/verify-neon-recovery.py')
runtime = load('runtime_recovery', ROOT / 'scripts/runtime_recovery.py')
probe = load('runtime_probe', ROOT / 'scripts/runtime-recovery-probe.py')
inventory_tests = load('inventory_test_fixtures', ROOT / 'scripts/check-runtime-recovery-inventory-test.py')
FILES = {p: (ROOT / p).read_bytes() for p in runtime.HELPERS}
tracked = subprocess.run(['git', '-c', 'core.bare=false', 'ls-files', 'backend'], cwd=ROOT, capture_output=True, text=True, check=True).stdout.splitlines()
for path in tracked:
    FILES[path] = (ROOT / path).read_bytes()
FILES['requirements.txt'] = (ROOT / 'requirements.txt').read_bytes()
PACKAGES = [{'path': p, 'sha256': runtime.sha(b)} for p, b in sorted(FILES.items()) if p == 'requirements.txt' or p.startswith('backend/')]
LEDGER = [{'version': Path(p['path']).stem, 'checksum': p['sha256']} for p in PACKAGES if __import__('re').fullmatch(r'backend/migrations/versions/\d{4}_[a-z0-9_]+\.py', p['path'])]
inventory_tests.LEDGER = LEDGER
ARCHIVE = b'fake archive container; source files and manifest use real checkout bytes'
NOW = datetime(2026, 11, 10, 12, 0, tzinfo=timezone.utc)
PRODUCTION_HOST = 'ep-production.ap-southeast-2.aws.neon.tech'
URL = 'postgresql://user:secret-value@' + PRODUCTION_HOST + '/neondb?sslmode=require'
PG_BIN = None
if '--pg-bin' in sys.argv:
    position = sys.argv.index('--pg-bin')
    PG_BIN = Path(sys.argv[position + 1]).resolve()
    del sys.argv[position:position + 2]


def verification(count):
    return {'status': 'passed', 'connected': True, 'transactionReadOnly': True,
            'migrationCount': count, 'migrationHead': LEDGER[count - 1]['version'],
            'migrationVersions': [r['version'] for r in LEDGER[:count]],
            'migrationChecksums': {r['version']: r['checksum'] for r in LEDGER[:count]},
            'publicTableCount': 7, 'schemaSha256': 'a' * 64, 'rowCountSha256': 'b' * 64,
            'businessDataPresent': dict.fromkeys(('department', 'site', 'user'), True),
            'pythonVersion': '3.12.8', 'psycopgVersion': '3.2.1'}


def fixture(phase='PreMigration'):
    count = 27 if phase == 'PreMigration' else 28
    bound = {'ReleasePhase': phase, 'CandidateHead': LEDGER[-1]['version'], 'ExpectedRecoveryHead': LEDGER[count - 1]['version'],
             'CandidateLedger': copy.deepcopy(LEDGER), 'ExpectedLedger': copy.deepcopy(LEDGER[:count])}
    caller = {'projectId': 'project-test', 'region': 'asia-east1', 'runtimeServiceAccount': 'runtime@project-test.iam.gserviceaccount.com',
              'databaseSecret': 'database-secret', 'jwtSecret': 'jwt-secret', 'minimumHistoryHours': 6, 'maximumAgeDays': 7,
              'releasePhase': phase, 'preMigrationHead': LEDGER[26]['version'] if count == 27 else '', 'neonProjectId': 'neon-project'}
    config = {'mode': 'recovery', 'runId': 'a' * 32, 'sourceCommit': 'b' * 40,
              'image': 'asia-east1-docker.pkg.dev/project-test/images/backend@sha256:' + 'c' * 64,
              'packageFiles': copy.deepcopy(PACKAGES), 'contract': bound, 'productionHostSha256': runtime.sha(PRODUCTION_HOST.encode()),
              'target': {'branch': {'id': 'br-proof', 'project_id': 'neon-project', 'parent_id': 'br-production', 'name': 'recovery-proof-' + 'a' * 32,
                                   'default': False, 'primary': False, 'parent_timestamp': '2026-11-10T11:40:00Z', 'created_at': '2026-11-10T11:50:30Z',
                                   'expires_at': '2026-11-10T11:55:00Z', 'current_state': 'ready'},
                         'endpoint': {'id': 'ep-proof', 'project_id': 'neon-project', 'branch_id': 'br-proof', 'type': 'read_only',
                                      'host': 'ep-proof.ap-southeast-2.aws.neon.tech', 'current_state': 'active'},
                         'request': {'startedAtUtc': '2026-11-10T11:50:00Z', 'restorePointUtc': '2026-11-10T11:40:00Z', 'expiresAtUtc': '2026-11-10T11:55:00Z'}},
              'expectedBeforeSha256': None, 'pauseVerified': False}
    source = {'bucket': 'source-bucket', 'object': 'release/source.tar', 'generation': '1'}
    def runtime_fixture(conf, suffix):
        command = ['python', '-c', runtime.payload(conf, FILES)]
        return {'job': runtime.JOB, 'execution': runtime.JOB + '-' + suffix, 'buildId': '12345678-1234-1234-1234-123456789abc',
                'image': conf['image'], 'sourceCommit': conf['sourceCommit'], 'sourceArchiveSha256': runtime.sha(ARCHIVE),
                'buildSourceCommit': 'b' * 40, 'buildArchiveSha256': runtime.sha(ARCHIVE),
                'sourceArchiveObject': copy.deepcopy(source), 'packageFiles': copy.deepcopy(PACKAGES), 'helperHashes': {p: runtime.sha(FILES[p]) for p in runtime.HELPERS},
                'config': conf, 'payloadSha256': runtime.sha(command[2].encode()), 'commandSha256': runtime.digest(command)}
    def record_fixture(rt, start, end):
        conf = rt['config']; migrate = conf['mode'] == 'production-migrate'
        before, after = inventory_tests.fixture(27), inventory_tests.fixture(28)
        before['transactionReadOnly'] = after['transactionReadOnly'] = False
        return {'schemaVersion': 1, 'kind': 'runtime-recovery-record', 'status': 'passed',
                **{k: conf[k] for k in ('runId', 'mode', 'sourceCommit', 'image')}, 'configSha256': runtime.digest(conf),
                'packageSha256': runtime.digest(PACKAGES), 'startedAtUtc': start, 'completedAtUtc': end,
                'verification': None if migrate else verification(count), 'inventory': None if migrate else inventory_tests.fixture(count),
                'before': before if migrate else None, 'after': after if migrate else None,
                'preservation': runtime.validate_preservation(before, after, LEDGER) if migrate else None}
    def execution(rt, record):
        return {'apiVersion': 'run.googleapis.com/v1', 'kind': 'Execution',
                'metadata': {'name': rt['execution'], 'labels': {'run.googleapis.com/job': runtime.JOB, 'cloud.googleapis.com/location': caller['region']}},
                'spec': {'taskCount': 1, 'parallelism': 1, 'template': {'spec': {'maxRetries': 0, 'serviceAccountName': caller['runtimeServiceAccount'],
                         'containers': [{'image': rt['image'], 'command': ['python'], 'args': ['-c', runtime.payload(rt['config'], FILES)], 'env': runtime.expected_env(caller)}]}}},
                'status': {'succeededCount': 1, 'conditions': [{'type': 'Completed', 'status': 'True'}],
                           'startTime': record['startedAtUtc'], 'completionTime': record['completedAtUtc']}}
    def log(rt, record):
        return {'textPayload': runtime.PREFIX + json.dumps(record), 'resource': {'type': 'cloud_run_job',
                'labels': {'project_id': caller['projectId'], 'location': caller['region'], 'job_name': runtime.JOB}},
                'labels': {'run.googleapis.com/execution_name': rt['execution']}, 'logName': 'projects/project-test/logs/run.googleapis.com%2Fstdout',
                'timestamp': record['completedAtUtc'], 'insertId': 'insert123'}
    rt = runtime_fixture(config, 'recovery')
    record = record_fixture(rt, '2026-11-10T11:51:00Z', '2026-11-10T11:52:00Z')
    evidence = {'schemaVersion': 4, 'kind': 'neon-runtime-recovery', 'provider': 'neon', 'environment': 'production', 'status': 'passed',
                'failureStage': None, 'releasePhase': phase, 'candidateHead': bound['CandidateHead'], 'expectedRecoveryHead': bound['ExpectedRecoveryHead'],
                'expectedMigrationHead': bound['ExpectedRecoveryHead'], 'candidateMigrationLedger': bound['CandidateLedger'], 'expectedRecoveryMigrationLedger': bound['ExpectedLedger'],
                'startedAtUtc': '2026-11-10T11:50:00Z', 'verificationCompletedAtUtc': '2026-11-10T11:53:00Z',
                'cleanupCompletedAtUtc': '2026-11-10T11:56:00Z', 'completedAtUtc': '2026-11-10T11:56:00Z',
                'requestedRestorePointUtc': '2026-11-10T11:40:00Z', 'requestedExpiresAtUtc': '2026-11-10T11:55:00Z',
                'projectId': caller['neonProjectId'], 'cloudProjectId': caller['projectId'], 'region': caller['region'],
                'productionBranch': {'id': 'br-production', 'name': 'production', 'historyRetentionSeconds': 21600, 'hostSha256': config['productionHostSha256']},
                'proofBranch': {'id': 'br-proof', 'name': 'recovery-proof-' + config['runId'], 'parentId': 'br-production',
                    'parentTimestampUtc': '2026-11-10T11:40:00Z', 'createdAtUtc': '2026-11-10T11:50:30Z', 'expiresAtUtc': '2026-11-10T11:55:00Z',
                    'default': False, 'primary': False, 'endpointId': 'ep-proof', 'endpointType': 'read_only', 'host': config['target']['endpoint']['host']},
                'runtime': rt, 'record': record, 'migration': None,
                'cleanup': {'method': 'automatic-expiry', 'ownershipVerified': True, 'branchAbsent': True, 'endpointAbsent': True, 'failureStage': None}}
    providers = {'project': {'project': {'id': caller['neonProjectId'], 'history_retention_seconds': 21600}},
                 'branches': [{'id': 'br-production', 'name': 'production', 'default': True, 'primary': True}],
                 'endpoints': [{'id': 'ep-production', 'branch_id': 'br-production', 'host': PRODUCTION_HOST, 'type': 'read_write'}],
                 'execution': execution(rt, record), 'logs': [log(rt, record)], 'build': {'id': rt['buildId'], 'projectId': caller['projectId'], 'status': 'SUCCESS',
                     'sourceProvenance': {'resolvedStorageSource': source, 'fileHashes': {'gs://source-bucket/release/source.tar':
                         {'fileHash': [{'type': 'SHA256', 'value': base64.b64encode(bytes.fromhex(runtime.sha(ARCHIVE))).decode()}]}}},
                     'results': {'images': [{'name': config['image'].split('@')[0], 'digest': config['image'].split('@')[1]}]}},
                 'buildArchiveFile': 'fixture-build-archive.tar', 'migrationExecution': None, 'migrationLogs': None}
    if phase == 'Current':
        conf = copy.deepcopy(config); conf.update(mode='production-migrate', target=None, pauseVerified=True, runId='d' * 32)
        before = inventory_tests.fixture(27); before['transactionReadOnly'] = False
        conf['expectedBeforeSha256'] = runtime.digest(before)
        migration = runtime_fixture(conf, 'migration')
        rec = record_fixture(migration, '2026-11-10T11:30:00Z', '2026-11-10T11:35:00Z')
        evidence['migration'] = {**migration, 'record': rec}
        providers['migrationExecution'] = execution(migration, rec); providers['migrationLogs'] = [log(migration, rec)]
    request = {'repoRoot': str(ROOT), 'evidencePath': '', 'evidenceFile': '', 'contract': copy.deepcopy(bound), 'caller': caller, 'providers': providers}
    # Provider observations and saved evidence are independent serializations.
    return copy.deepcopy(request), copy.deepcopy(evidence)


def assign(obj, path, value):
    for key in path[:-1]: obj = obj[key]
    obj[path[-1]] = value


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        class ProbeTime(datetime):
            @classmethod
            def now(cls, tz=None):
                return NOW.replace(hour=11, minute=51)
        patcher = patch.object(probe, 'datetime', ProbeTime)
        patcher.start(); self.addCleanup(patcher.stop)

    def validate(self, request, evidence):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'proof.json'; path.write_text(json.dumps(evidence), encoding='utf-8')
            request = copy.deepcopy(request)
            request['evidenceFile'] = str(path)
            request['evidencePath'] = request['evidencePath'] or str(path)
            # Dedicated build-context tests exercise the real Docker/archive
            # validator. This suite isolates runtime execution and evidence.
            with patch.object(runtime, 'source_archive', return_value=(ARCHIVE, FILES, PACKAGES)), patch.object(runtime, 'build_check'):
                return runtime.validate(request, now=NOW)

    def reject(self, request, evidence):
        with self.assertRaises((ValueError, KeyError, TypeError)):
            self.validate(request, evidence)

    def test_complete_pre_and_current(self):
        for phase in ('PreMigration', 'Current'):
            self.assertTrue(self.validate(*fixture(phase)))

    def test_only_provider_empty_smtp_literal_omission_is_supported(self):
        request, evidence = fixture()
        env = request['providers']['execution']['spec']['template']['spec']['containers'][0]['env']
        smtp = next(item for item in env if item['name'] == 'SMTP_HOST')
        del smtp['value']
        self.assertTrue(self.validate(request, evidence))
        for extra in ({'value': 'smtp.example'}, {'value': None}, {'valueFrom': {}}, {'extra': ''}):
            bad = copy.deepcopy(request)
            items = bad['providers']['execution']['spec']['template']['spec']['containers'][0]['env']
            next(item for item in items if item['name'] == 'SMTP_HOST').update(extra)
            self.reject(bad, evidence)
        for mode in ('missing-smtp', 'duplicate-smtp', 'other-omission'):
            bad = copy.deepcopy(request)
            items = bad['providers']['execution']['spec']['template']['spec']['containers'][0]['env']
            if mode == 'missing-smtp': items.remove(next(item for item in items if item['name'] == 'SMTP_HOST'))
            elif mode == 'duplicate-smtp': items.append({'name': 'SMTP_HOST'})
            else: next(item for item in items if item['name'] == 'AUTO_MIGRATE').pop('value')
            self.reject(bad, evidence)

    def test_envelope_missing_extra_types_failure_and_secrets(self):
        for phase in ('PreMigration', 'Current'):
            request, evidence = fixture(phase)
            for field in evidence:
                bad = copy.deepcopy(evidence); del bad[field]; self.reject(request, bad)
            for path, value in [(('schemaVersion',), True), (('status',), 'failed'), (('failureStage',), 'password-secret'),
                                (('extra',), 'secret'), (('record', 'extra'), 'secret'), (('proofBranch', 'host'), 'postgresql://secret')]:
                bad = copy.deepcopy(evidence); assign(bad, path, value); self.reject(request, bad)

    def test_ledgers(self):
        for operation in ('missing', 'duplicate', 'reordered', 'checksum', 'head'):
            request, evidence = fixture(); ledger = evidence['expectedRecoveryMigrationLedger']
            if operation == 'missing': ledger.pop()
            elif operation == 'duplicate': ledger.append(ledger[-1])
            elif operation == 'reordered': ledger.reverse()
            elif operation == 'checksum': ledger[0]['checksum'] = 'f' * 64
            else: evidence['expectedRecoveryHead'] = LEDGER[-1]['version']
            self.reject(request, evidence)

    def test_execution_identity_environment_shape_and_completion(self):
        changes = [(('metadata', 'name'), 'unrelated'), (('metadata', 'labels', 'run.googleapis.com/job'), 'other'),
                   (('spec', 'taskCount'), 2), (('spec', 'parallelism'), True), (('spec', 'template', 'spec', 'maxRetries'), 1),
                   (('spec', 'template', 'spec', 'serviceAccountName'), 'other'), (('status', 'failedCount'), 1),
                   (('status', 'cancelledCount'), 1), (('status', 'runningCount'), 1), (('status', 'retriedCount'), 1),
                   (('status', 'conditions'), [{'type': 'Completed', 'status': 'False'}]),
                   (('spec', 'template', 'spec', 'containers', 0, 'image'), 'wrong'),
                   (('spec', 'template', 'spec', 'containers', 0, 'args'), ['-c', 'print(1)']),
                   (('spec', 'template', 'spec', 'containers', 0, 'env'), []),
                   (('spec', 'template', 'spec', 'volumes'), [{'secret': 'other'}])]
        for path, value in changes:
            request, evidence = fixture(); assign(request['providers']['execution'], path, value); self.reject(request, evidence)
        request, evidence = fixture(); containers = request['providers']['execution']['spec']['template']['spec']['containers']; containers.append(copy.deepcopy(containers[0])); self.reject(request, evidence)

    def test_logs_and_writable(self):
        for operation in ('missing', 'duplicate', 'identity', 'mismatch', 'format', 'writable', 'duplicate_json'):
            request, evidence = fixture(); logs = request['providers']['logs']
            if operation == 'missing': logs.clear()
            elif operation == 'duplicate': logs.append(copy.deepcopy(logs[0]))
            elif operation == 'identity': logs[0]['labels']['run.googleapis.com/execution_name'] = 'other'
            elif operation == 'mismatch': logs[0]['textPayload'] = runtime.PREFIX + '{}'
            elif operation == 'format': logs[0]['jsonPayload'] = {'kind': 'runtime-recovery-record'}
            elif operation == 'duplicate_json': logs[0]['textPayload'] = runtime.PREFIX + '{"x":1,"x":2}'
            else:
                evidence['record']['inventory']['transactionReadOnly'] = False
                logs[0]['textPayload'] = runtime.PREFIX + json.dumps(evidence['record'])
            self.reject(request, evidence)

    def test_current_requires_real_prior_migration(self):
        for operation in ('missing', 'fake', 'unsupported', 'late', 'failed'):
            request, evidence = fixture('Current')
            if operation == 'missing': evidence['migration'] = None
            elif operation == 'fake': evidence['migration'] = {'status': 'passed'}
            elif operation == 'unsupported': evidence['migration']['record']['kind'] = 'migration-complete-marker'
            elif operation == 'late': request['providers']['migrationExecution']['status']['completionTime'] = evidence['requestedRestorePointUtc']
            else: request['providers']['migrationExecution']['status']['failedCount'] = 1
            self.reject(request, evidence)
        for path, value in [(('sourceArchiveObject', 'generation'), '2'), (('buildSourceCommit',), 'f' * 40),
                            (('buildArchiveSha256',), 'f' * 64)]:
            request, evidence = fixture('Current'); assign(evidence['migration'], path, value); self.reject(request, evidence)

    def test_creation_snapshot_ownership_endpoint_and_request_binding(self):
        changes = [(('branch', 'parent_id'), 'br-other'), (('branch', 'project_id'), 'other-project'),
                   (('branch', 'name'), 'recovery-proof-' + 'f' * 32), (('branch', 'default'), True),
                   (('branch', 'primary'), True), (('branch', 'current_state'), 'init'),
                   (('branch', 'parent_timestamp'), '2026-11-10T11:30:00Z'),
                   (('branch', 'created_at'), '2026-11-10T11:45:00Z'),
                   (('branch', 'expires_at'), '2026-11-10T12:30:00Z'),
                   (('endpoint', 'id'), 'ep-other'), (('endpoint', 'branch_id'), 'br-other'),
                   (('endpoint', 'project_id'), 'other'), (('endpoint', 'type'), 'read_write'),
                   (('endpoint', 'host'), 'ep-other.ap-southeast-2.aws.neon.tech'), (('endpoint', 'current_state'), 'init'),
                   (('request', 'restorePointUtc'), '2026-11-10T11:30:00Z'),
                   (('request', 'startedAtUtc'), '2026-11-10T11:45:00Z'),
                   (('request', 'expiresAtUtc'), '2026-11-10T12:30:00Z')]
        for path, value in changes:
            request, evidence = fixture(); assign(evidence['runtime']['config']['target'], path, value); self.reject(request, evidence)
        # Even internally coherent rehashed/re-executed snapshots cannot override
        # the evidence's separately bound branch and requested timestamps.
        for path, value in [(('branch', 'parent_timestamp'), '2026-11-10T11:30:00Z'),
                            (('request', 'expiresAtUtc'), '2026-11-10T12:30:00Z')]:
            request, evidence = fixture(); rt = evidence['runtime']; assign(rt['config']['target'], path, value)
            command = ['python', '-c', runtime.payload(rt['config'], FILES)]
            rt['payloadSha256'] = runtime.sha(command[2].encode()); rt['commandSha256'] = runtime.digest(command)
            evidence['record']['configSha256'] = runtime.digest(rt['config'])
            request['providers']['execution']['spec']['template']['spec']['containers'][0]['args'] = command[1:]
            request['providers']['logs'][0]['textPayload'] = runtime.PREFIX + json.dumps(evidence['record'])
            self.reject(request, evidence)

    def test_cleanup_ownership_thresholds_context_and_path(self):
        for path, value in [(('cleanup', 'ownershipVerified'), False), (('cleanup', 'endpointAbsent'), False),
                            (('cleanup', 'method'), 'pending-expiry'), (('proofBranch', 'parentId'), 'br-other'),
                            (('proofBranch', 'default'), True), (('requestedExpiresAtUtc',), '2026-11-10T12:05:00Z')]:
            request, evidence = fixture(); assign(evidence, path, value); self.reject(request, evidence)
        request, evidence = fixture(); request['providers']['endpoints'] = [{'id': 'ep-proof', 'branch_id': 'br-proof', 'host': evidence['proofBranch']['host']}]; self.reject(request, evidence)
        request, evidence = fixture(); request['providers']['branches'].append({'id': 'br-proof', 'name': evidence['proofBranch']['name']}); self.reject(request, evidence)
        for field, value in [('minimumHistoryHours', 7), ('minimumHistoryHours', True), ('maximumAgeDays', 0), ('projectId', 'other'),
                             ('region', 'other'), ('neonProjectId', 'other'), ('preMigrationHead', ''), ('releasePhase', 'Current')]:
            request, evidence = fixture(); request['caller'][field] = value; self.reject(request, evidence)
        request, evidence = fixture(); request['evidencePath'] = str(ROOT / 'not-this-proof.json'); self.reject(request, evidence)

    def test_payload_exact_bytes_and_size(self):
        request, evidence = fixture()
        text = runtime.payload(evidence['runtime']['config'], FILES)
        self.assertLess(len(text.encode()), 32768)
        self.assertEqual(text, runtime.payload(evidence['runtime']['config'], FILES))
        tree = ast.parse(text)
        constants = [n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)]
        packed = next(v for v in constants if v.startswith('H4s'))
        bundle = json.loads(gzip.decompress(base64.b64decode(packed)))
        for module, path in [('canonical_verifier', 'scripts/verify-neon-recovery.py'), ('runtime_recovery_inventory', 'scripts/runtime_recovery_inventory.py'), ('runtime_probe', 'scripts/runtime-recovery-probe.py')]:
            self.assertEqual(base64.b64decode(bundle['modules'][module]), FILES[path])
        self.assertEqual(bundle['config'], evidence['runtime']['config'])
        self.assertEqual(base64.b64decode(packed)[9], 255)
        # Execute the actual transport/loader, not just decode its manifest. No
        # /app package or credential is present: the probe must fail sanitized,
        # rather than fail importing modules in JSON alphabetical order.
        environment = {key: value for key, value in os.environ.items() if key in
                       ('PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PYTHONPATH', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME')}
        environment['PYTHONDONTWRITEBYTECODE'] = '1'
        result = subprocess.run([sys.executable, '-c', text], env=environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, '')
        self.assertEqual(json.loads(result.stdout.removeprefix(runtime.PREFIX)), {
            'schemaVersion': 1, 'status': 'failed', 'failureCode': 'runtime_verification_failed'})
        dependencies = dict(FILES)
        dependencies['scripts/verify-neon-recovery.py'] = b'SENTINEL = 1\n'
        dependencies['scripts/runtime_recovery_inventory.py'] = b'import canonical_verifier\nSENTINEL = canonical_verifier.SENTINEL + 1\n'
        dependencies['scripts/runtime-recovery-probe.py'] = b'import runtime_recovery_inventory\ndef main(config):\n assert runtime_recovery_inventory.SENTINEL == 2\n return 0\n'
        result = subprocess.run([sys.executable, '-c', runtime.payload(evidence['runtime']['config'], dependencies)],
                                env=environment, capture_output=True, text=True)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '', ''))

    def test_build_source_helpers_and_runtime_binding(self):
        for path, value in [(('sourceArchiveSha256',), 'f' * 64),
                            (('payloadSha256',), 'e' * 64), (('commandSha256',), 'd' * 64),
                            (('helperHashes', 'scripts/runtime_recovery_inventory.py'), 'a' * 64),
                            (('packageFiles', 0, 'sha256'), 'b' * 64)]:
            request, evidence = fixture(); assign(evidence['runtime'], path, value); self.reject(request, evidence)
        for path, value in [(('verification', 'transactionReadOnly'), False), (('verification', 'publicTableCount'), 6),
                            (('verification', 'businessDataPresent', 'user'), 1), (('inventory', 'tables', 0, 'extra'), 'password-secret')]:
            request, evidence = fixture(); assign(evidence['record'], path, value)
            request['providers']['logs'][0]['textPayload'] = runtime.PREFIX + json.dumps(evidence['record'])
            self.reject(request, evidence)

    def test_probe_production_migration_exact_command_and_before_gate(self):
        _, evidence = fixture('Current'); config = evidence['migration']['config']
        before = evidence['migration']['record']['before']; after = evidence['migration']['record']['after']
        with patch.dict(os.environ, {'DATABASE_URL': URL}, clear=True), patch.object(probe, 'verify_package', return_value=runtime.digest(PACKAGES)), patch.object(probe, 'capture_inventory', side_effect=[before, after]) as capture, patch.object(probe.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0)) as command:
            record = probe.run(config)
            self.assertEqual(command.call_args.args[0], [sys.executable, '-m', 'app.migrations'])
            self.assertTrue(command.call_args.kwargs['capture_output'])
            self.assertEqual(command.call_args.kwargs['env']['SMTP_HOST'], '')
            self.assertEqual(command.call_args.kwargs['env']['REPORT_PDF_EMAIL_WORKER_ENABLED'], 'false')
            self.assertEqual([c.kwargs for c in capture.call_args_list], [{'natural_read_only': False}] * 2)
            self.assertEqual(record['preservation']['preservedLedgerRows'], 27)
        changed = copy.deepcopy(before); changed['outbox']['attemptFieldsSha256'] = 'f' * 64
        with patch.dict(os.environ, {'DATABASE_URL': URL}, clear=True), patch.object(probe, 'verify_package', return_value=runtime.digest(PACKAGES)), patch.object(probe, 'capture_inventory', return_value=changed), patch.object(probe.subprocess, 'run') as command:
            with self.assertRaises(ValueError): probe.run(config)
            command.assert_not_called()

    def test_production_inventory_is_readonly_work_and_not_recovery_evidence(self):
        _, evidence = fixture(); config = copy.deepcopy(evidence['runtime']['config'])
        config.update(mode='production-inventory', target=None, pauseVerified=True)
        observed = inventory_tests.fixture(); observed['transactionReadOnly'] = False
        runtime.config_check(config)
        with patch.dict(os.environ, {'DATABASE_URL': URL}, clear=True), patch.object(probe, 'verify_package', return_value=runtime.digest(PACKAGES)), patch.object(probe, 'capture_inventory', return_value=observed) as capture, patch.object(probe.subprocess, 'run') as command, patch.object(canonical, 'verify') as canonical_call:
            record = probe.run(config)
            capture.assert_called_once_with(URL, LEDGER[:27], natural_read_only=False)
            command.assert_not_called(); canonical_call.assert_not_called()
            self.assertIs(record['inventory'], observed)
            self.assertIsNone(record['before']); self.assertIsNone(record['after']); self.assertIsNone(record['preservation'])
            runtime.record_check(record, {'config': config})
        for phase in ('PreMigration', 'Current'):
            request, evidence = fixture(phase); rt = evidence['runtime']
            rt['config'] = copy.deepcopy(config)
            payload = runtime.payload(rt['config'], FILES)
            rt['payloadSha256'] = runtime.sha(payload.encode()); rt['commandSha256'] = runtime.digest(['python', '-c', payload])
            self.reject(request, evidence)

    def test_backup_inventory_uses_natural_readonly_and_exact_state_without_migrating(self):
        _, evidence = fixture(); config = copy.deepcopy(evidence['runtime']['config'])
        observed = inventory_tests.fixture()
        config.update(mode='backup-inventory', pauseVerified=True,
                      expectedBeforeSha256=runtime.inventory_state_sha256(observed, LEDGER[:27], True))
        config['target']['branch'].update(name='reportflow-recipdir-backup-20261110', parent_timestamp=None, expires_at='2026-11-11T11:55:00Z')
        config['target']['request'].update(restorePointUtc=None, expiresAtUtc='2026-11-11T11:55:00Z')
        runtime.config_check(config)
        with patch.dict(os.environ, {'DATABASE_URL': URL}, clear=True), patch.object(probe, 'verify_package', return_value=runtime.digest(PACKAGES)), patch.object(probe, 'capture_inventory', return_value=observed) as capture, patch.object(probe.subprocess, 'run') as command, patch.object(canonical, 'verify') as canonical_call:
            record = probe.run(config)
            capture.assert_called_once_with(URL.replace(PRODUCTION_HOST, config['target']['endpoint']['host']), LEDGER[:27], natural_read_only=True)
            command.assert_not_called(); canonical_call.assert_not_called()
            runtime.record_check(record, {'config': config})
            changed = copy.deepcopy(config); changed['expectedBeforeSha256'] = 'f' * 64
            with self.assertRaises(ValueError): probe.run(changed)
            with self.assertRaises(ValueError): runtime.record_check({**record, 'configSha256': runtime.digest(changed)}, {'config': changed})
            command.assert_not_called()
        for phase in ('PreMigration', 'Current'):
            request, evidence = fixture(phase); rt = evidence['runtime']; rt['config'] = copy.deepcopy(config)
            payload = runtime.payload(rt['config'], FILES)
            rt['payloadSha256'] = runtime.sha(payload.encode()); rt['commandSha256'] = runtime.digest(['python', '-c', payload])
            request['providers']['execution']['spec']['template']['spec']['containers'][0]['args'] = ['-c', payload]
            evidence['record'] = record
            request['providers']['logs'][0]['textPayload'] = runtime.PREFIX + json.dumps(record)
            self.reject(request, evidence)

    def test_probe_rejects_url_and_libpq_redirects(self):
        _, evidence = fixture(); config = evidence['runtime']['config']
        with patch.dict(os.environ, {'DATABASE_URL': URL}, clear=True):
            self.assertIn('@ep-proof.', probe.connection_target(config))
        for extra in ('options=-c%20default_transaction_read_only=on', 'service=evil', 'host=other', 'hostaddr=127.0.0.1', 'sslmode=require'):
            with patch.dict(os.environ, {'DATABASE_URL': URL + '&' + extra}, clear=True):
                with self.assertRaises(ValueError): probe.connection_target(config)
        for key in ('PGOPTIONS', 'PGSERVICE', 'PGHOST', 'PGSERVICEFILE'):
            with patch.dict(os.environ, {'DATABASE_URL': URL, key: 'force'}, clear=True):
                with self.assertRaises(ValueError): probe.connection_target(config)
        for bad in (URL.replace('/neondb', '/other'), URL.replace('sslmode=require', 'sslmode=disable'), URL + '#fragment', URL.replace(PRODUCTION_HOST, 'ep-other.ap-southeast-2.aws.neon.tech')):
            with patch.dict(os.environ, {'DATABASE_URL': bad}, clear=True):
                with self.assertRaises(ValueError): probe.connection_target(config)

    def test_probe_verbatim_canonical_and_natural_readonly_call(self):
        _, evidence = fixture(); config = evidence['runtime']['config']; result = verification(27)
        def canonical_call():
            self.assertIn('@ep-proof.', os.environ['NEON_RECOVERY_DATABASE_URL'])
            return result
        with patch.dict(os.environ, {'DATABASE_URL': URL}, clear=True), patch.object(probe, 'verify_package', return_value=runtime.digest(PACKAGES)), patch.object(canonical, 'verify', side_effect=canonical_call) as verify, patch.object(probe, 'capture_inventory', return_value=inventory_tests.fixture()) as capture:
            record = probe.run(config)
            self.assertIs(record['verification'], result)
            verify.assert_called_once_with()
            self.assertEqual(capture.call_args.kwargs, {'natural_read_only': True})
            self.assertEqual(capture.call_args.args[1], LEDGER[:27])
            self.assertNotIn('NEON_RECOVERY_DATABASE_URL', os.environ)

    def test_runtime_package_includes_assets_and_rejects_caches_missing_changed(self):
        _, evidence = fixture(); config = copy.deepcopy(evidence['runtime']['config'])
        migration_files = {p: b for p, b in FILES.items() if __import__('re').fullmatch(r'backend/migrations/versions/\d{4}_[a-z0-9_]+\.py', p)}
        files = {**migration_files, 'requirements.txt': b'fixture', 'backend/assets/logo.bin': b'non-python runtime bytes'}
        config['packageFiles'] = [{'path': p, 'sha256': runtime.sha(b)} for p, b in sorted(files.items())]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, content in files.items():
                path = root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(content)
            self.assertEqual(probe.verify_package(config, root), runtime.digest(config['packageFiles']))
            asset = root / 'backend/assets/logo.bin'; asset.write_bytes(b'changed')
            with self.assertRaises(ValueError): probe.verify_package(config, root)
            asset.unlink()
            with self.assertRaises(ValueError): probe.verify_package(config, root)
            asset.write_bytes(files['backend/assets/logo.bin'])
            cache = root / 'backend/__pycache__/extra.pyc'; cache.parent.mkdir(); cache.write_bytes(b'extra cache')
            with self.assertRaises(ValueError): probe.verify_package(config, root)
            cache.unlink()
            self.assertEqual(probe.verify_package(config, root), runtime.digest(config['packageFiles']))

    def test_source_archive_requires_current_head_and_exact_checkout_bytes(self):
        contents = {**FILES, **{p: (ROOT / p).read_bytes() for p in ('Dockerfile', '.dockerignore', '.gcloudignore')}}
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w') as archive:
            for name, content in sorted(contents.items()):
                info = tarfile.TarInfo(name); info.size = len(content); archive.addfile(info, io.BytesIO(content))
        archive_bytes = buffer.getvalue(); commit = 'b' * 40
        def git_result(args, **kwargs):
            return types.SimpleNamespace(stdout=commit if 'rev-parse' in args else archive_bytes)
        with patch.object(runtime.subprocess, 'run', side_effect=git_result):
            archive, source, packages = runtime.source_archive(ROOT, commit)
            self.assertEqual(archive, archive_bytes); self.assertEqual(packages, PACKAGES)
        with patch.object(runtime.subprocess, 'run', return_value=types.SimpleNamespace(stdout='c' * 40)):
            with self.assertRaisesRegex(ValueError, 'runtime_source_not_current_release_head'):
                runtime.source_archive(ROOT, commit)
        original_read = Path.read_bytes
        for name in ('scripts/runtime_recovery_inventory.py', 'backend/app/migrations.py', 'Dockerfile'):
            def changed(path):
                return b'changed local bytes' if path == ROOT / name else original_read(path)
            with patch.object(runtime.subprocess, 'run', side_effect=git_result), patch.object(Path, 'read_bytes', changed):
                with self.assertRaises(ValueError): runtime.source_archive(ROOT, commit)

    def test_sanitized_cli_and_probe_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'request.json'; path.write_text('{"password":"secret"}', encoding='utf-8')
            result = subprocess.run([sys.executable, '-B', str(ROOT / 'scripts/runtime_recovery.py'), 'validate', '--request', str(path)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1); self.assertEqual(result.stderr, '')
            self.assertEqual(json.loads(result.stdout), {'passed': False, 'failureCode': 'runtime_recovery_contract_rejected'})
        output = io.StringIO()
        with patch.object(probe, 'run', side_effect=RuntimeError('postgresql://password-secret')), redirect_stdout(output):
            self.assertEqual(probe.main({}), 1)
        self.assertNotIn('password', output.getvalue()); self.assertNotIn('Traceback', output.getvalue())
        self.assertEqual(json.loads(output.getvalue()[len(runtime.PREFIX):])['status'], 'failed')
        for text in ('{"x":1,"x":2}', '{"x":NaN}', '{"x":Infinity}'):
            with self.assertRaises(ValueError): runtime.strict_loads(text)

    @unittest.skipUnless(PG_BIN, 'Optional owned native PostgreSQL: pass --pg-bin directory')
    def test_native_postgres_capture_preservation_and_physical_schema(self):
        # Reuse the existing runner's loopback-only cluster ownership, independent
        # generated credentials, startup identity checks, and verified cleanup.
        # No existing database URL is accepted or discovered by this test.
        sys.path.insert(0, str(ROOT / 'backend'))
        import postgres_rehearsal
        import runtime_recovery_inventory as inventory
        def phase(database, report):
            from app.migrations import run_migrations, MIGRATIONS_DIR
            from sqlalchemy import text
            from psycopg import sql
            with database('runtime_recovery_inventory') as engine:
                with tempfile.TemporaryDirectory(prefix='runtime-inventory-migrations-') as directory:
                    for path in MIGRATIONS_DIR.glob('[0-9]*.py'):
                        if path.stem <= LEDGER[26]['version']:
                            shutil.copy2(path, Path(directory) / path.name)
                    run_migrations(engine, Path(directory))
                with engine.begin() as connection:
                    connection.execute(text("""INSERT INTO site (id,name,latitude,longitude,allowed_radius_m,department_id)
                        VALUES (9001,'Synthetic recovery site',0,0,100,1)"""))
                    connection.execute(text("""INSERT INTO "user" (id,email,name,password_hash,role,status,department_id,is_global_admin)
                        VALUES (9001,'synthetic@example.invalid','Synthetic recovery worker','not-a-login','worker','active',1,FALSE)"""))
                    connection.execute(text("""INSERT INTO reportpdfemail
                        (id,submission_id,department_id,recipient,template_email_version,snapshot_json,status,
                         failure_code,message_id,attempted_at,accepted_at,created_at)
                        VALUES (9001,9001,9001,'Synthetic@Example.invalid',1,:snapshot,
                        'accepted',NULL,'synthetic-message','2026-11-01 01:00:00','2026-11-01 01:01:00','2026-11-01 00:00:00')"""), {'snapshot': '{"synthetic":true}'})
                url = engine.url.render_as_string(hide_password=False)
                before = inventory.capture_inventory(url, LEDGER[:27], natural_read_only=False)
                with self.assertRaises(ValueError):
                    inventory.capture_inventory(url, LEDGER[:27], natural_read_only=True)
                run_migrations(engine)
                after = inventory.capture_inventory(url, LEDGER, natural_read_only=False)
                result = inventory.validate_preservation(before, after, LEDGER)
                self.assertEqual(result['preservedOutboxRows'], 1)
                self.assertTrue(all(after['recipientSchema'].values()))
                report('Native schema27-to28 capture preserves all original data, ledger metadata, and accepted outbox attempts')
                # Database-scoped test setting affects only the newly created
                # disposable fixture database; it proves natural read-only mode.
                with engine.connect().execution_options(isolation_level='AUTOCOMMIT') as connection:
                    statement = sql.SQL('ALTER DATABASE {} SET default_transaction_read_only=on').format(sql.Identifier(engine.url.database)).as_string()
                    connection.exec_driver_sql(statement)
                readonly = inventory.capture_inventory(url, LEDGER, natural_read_only=True)
                self.assertTrue(readonly['transactionReadOnly'])
                self.assertIs(inventory.validate_backup(after, readonly, LEDGER)['backupMatchesPausedProduction'], True)
                with self.assertRaises(ValueError):
                    inventory.capture_inventory(url, LEDGER, natural_read_only=False)
                report('Natural read-only observed correctly; both direction mismatches rejected')
                # Existing pooled connection remains writable; restore fixture
                # default before checking physical corruption and queue mutation.
                with engine.connect().execution_options(isolation_level='AUTOCOMMIT') as connection:
                    connection.exec_driver_sql(sql.SQL('ALTER DATABASE {} RESET default_transaction_read_only').format(sql.Identifier(engine.url.database)).as_string())
                with engine.begin() as connection:
                    connection.execute(text("UPDATE reportpdfemail SET attempted_at='2026-11-02 00:00:00' WHERE id=9001"))
                changed = inventory.capture_inventory(url, LEDGER, natural_read_only=False)
                with self.assertRaises(ValueError): inventory.validate_preservation(before, changed, LEDGER)
                with engine.begin() as connection:
                    connection.execute(text('ALTER TABLE reportpdfemail DISABLE TRIGGER trg_reportpdfemail_recipient_metadata_immutable'))
                with self.assertRaises(ValueError): inventory.capture_inventory(url, LEDGER, natural_read_only=False)
                report('Real attempt change and disabled immutable-metadata trigger are rejected')
        # Inject only the phase callback, not capture logic, SQL, migration code,
        # or driver results. The existing runner owns every database operation.
        callback = types.SimpleNamespace(run_migration_checks=phase)
        with patch.dict(sys.modules, {'postgres_migration_rehearsal': callback}):
            result = postgres_rehearsal.rehearsal(PG_BIN, migrations_only=True)
        self.assertTrue(result['cleanup_complete'], 'Owned PostgreSQL cleanup did not finish')
        self.assertTrue(result['passed'], str(result.get('failures') or result.get('error')))


if __name__ == '__main__':
    unittest.main()
