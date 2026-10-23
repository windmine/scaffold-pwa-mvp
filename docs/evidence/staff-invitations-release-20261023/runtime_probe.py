"""Run inside an exact release image. Emit only aggregate, credential-free proof."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit, urlunsplit
from urllib.request import urlopen
from datetime import datetime, timezone
import psycopg
from psycopg import sql
import secrets

ADDED = {"invited_role", "invited_is_global_admin"}
SMOKE_READER_URL = 'https://files.pythonhosted.org/packages/18/42/a945f65cc61c739ec80f4112c4b78ed1791f25d33f45f19389c9c9e247e2/pypdf-6.20.0-py3-none-any.whl'
SMOKE_READER_SHA256 = 'f003fc2014814d264fe7dd3f9d435c158e23e1a85a2233f87a0a2d6d21c914ad'
SMOKE_READER_SIZE = 401710


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str, separators=(",", ":")).encode()).hexdigest()


def snapshot(url):
    with psycopg.connect(url.replace("postgresql+psycopg://", "postgresql://", 1), connect_timeout=20) as connection:
        connection.read_only = True
        with connection.cursor() as cursor:
            cursor.execute("SET LOCAL statement_timeout = '30s'")
            cursor.execute("SET LOCAL lock_timeout = '5s'")
            cursor.execute("SHOW transaction_read_only")
            assert cursor.fetchone()[0] == "on"
            cursor.execute("SELECT version, checksum FROM schema_migrations ORDER BY version")
            ledger = dict(cursor.fetchall())
            bundled = {p.stem: hashlib.sha256(p.read_bytes()).hexdigest() for p in Path('/app/backend/migrations/versions').glob('[0-9]*.py')}
            assert list(ledger) == sorted(bundled)[:len(ledger)] and all(bundled[k] == v for k, v in ledger.items())
            cursor.execute("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")
            tables = [r[0] for r in cursor.fetchall()]
            business = {}
            for table in tables:
                if table == "schema_migrations":
                    continue
                cursor.execute("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=%s ORDER BY ordinal_position", (table,))
                columns = [r[0] for r in cursor.fetchall() if not (table == 'workerinvitation' and r[0] in ADDED)]
                cursor.execute(sql.SQL('SELECT {} FROM {}').format(sql.SQL(',').join(map(sql.Identifier, columns)), sql.Identifier(table)))
                rows = sorted(digest(row) for row in cursor.fetchall())
                business[table] = {"columns": columns, "rows": len(rows), "rowsSha256": digest(rows)}
            cursor.execute("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='workerinvitation'")
            added = sorted(ADDED & {r[0] for r in cursor.fetchall()})
            result = {"migrationCount": len(ledger), "migrationHead": list(ledger)[-1], "migrationChecksums": ledger,
                      "businessTables": business, "invitationColumns": added, "transactionReadOnly": True}
            if len(added) == 2:
                cursor.execute("SELECT count(*) FROM workerinvitation WHERE invited_role <> 'worker' OR invited_is_global_admin")
                result["nonWorkerInvitationRows"] = cursor.fetchone()[0]
            cursor.execute("SELECT count(*) FROM workform WHERE pdf_email_enabled OR pdf_email_recipient IS NOT NULL OR pdf_email_version <> 1")
            result["configuredTemplateRows"] = cursor.fetchone()[0]
            cursor.execute("SELECT count(*) FROM reportpdfemail")
            result["outboxRows"] = cursor.fetchone()[0]
            cursor.execute("SELECT status, count(*) FROM reportpdfemail GROUP BY status ORDER BY status")
            result["outboxStatuses"] = dict(cursor.fetchall())
            cursor.execute("SELECT count(*) FROM reportpdfemail WHERE status='pending'")
            result["pendingOutboxRows"] = cursor.fetchone()[0]
            return result


def migrate(environment):
    for args in [[], ["--check"]]:
        result = subprocess.run([sys.executable, "-m", "app.migrations", *args], env=environment,
                                capture_output=True, timeout=150)
        assert result.returncode == 0, "Migration CLI failed; detailed output deliberately withheld"


def smoke_reader(environment, directory):
    """Supply a verified test reader only to the smoke client subprocess."""
    source = Path('/app/backend/smoke_test.py')
    diagnosis_code = '''import json,runpy,sys
try:
    runpy.run_path('/app/backend/smoke_test.py',run_name='smoke_import_diagnosis')
except ModuleNotFoundError as error:
    print(json.dumps({'exception':'ModuleNotFoundError','missingModule':error.name}))
    sys.exit(42)
sys.exit(0)
'''
    diagnosed = subprocess.run([sys.executable, '-c', diagnosis_code], env=environment,
                               capture_output=True, timeout=20)
    assert diagnosed.returncode == 42, 'Exact runtime did not reproduce the missing smoke reader'
    diagnosis = json.loads(diagnosed.stdout)
    assert diagnosis == {'exception': 'ModuleNotFoundError', 'missingModule': 'pypdf'}
    diagnosis.update(status='confirmed', smokeSourceSha256=hashlib.sha256(source.read_bytes()).hexdigest(),
                     originalImageUnchanged=True, importOnlyNoApiRequests=True)
    print('REPORTFLOW_SMOKE_DEPENDENCY_DIAGNOSIS ' + json.dumps(diagnosis, sort_keys=True))
    with urlopen(SMOKE_READER_URL, timeout=30) as response:
        assert response.geturl() == SMOKE_READER_URL, 'Unexpected test wheel redirect'
        wheel = response.read(SMOKE_READER_SIZE + 1)
    assert len(wheel) == SMOKE_READER_SIZE and hashlib.sha256(wheel).hexdigest() == SMOKE_READER_SHA256, 'Test reader wheel checksum mismatch'
    target = Path(directory) / 'pypdf-6.20.0-py3-none-any.whl'
    target.write_bytes(wheel)
    # Python can import a pure-Python wheel directly as a zip path. No install,
    # extraction, runtime dependency change or server PYTHONPATH change occurs.
    smoke_env = {**environment, 'PYTHONPATH': str(target) + (os.pathsep + environment['PYTHONPATH'] if environment.get('PYTHONPATH') else '')}
    checked = subprocess.run([sys.executable, '-c', "import pypdf; assert pypdf.__version__ == '6.20.0'"],
                             env=smoke_env, capture_output=True, timeout=20)
    assert checked.returncode == 0, 'Verified test reader cannot be imported'
    return smoke_env, {'version': '6.20.0', 'wheelSha256': SMOKE_READER_SHA256,
                       'wheelBytes': SMOKE_READER_SIZE, 'smokeSubprocessOnly': True,
                       'originalMissingModuleReproduced': True, 'productionImageUnchanged': True}


def local_api(environment, *, smoke):
    with tempfile.TemporaryDirectory(prefix="release-stage-") as directory:
        env = {**environment, "APP_ENV": "development", "ENVIRONMENT": "development", "K_SERVICE": "",
               "UPLOAD_STORAGE_BACKEND": "local", "UPLOAD_DIR": directory, "UPLOAD_BUCKET": "",
               "AUTH_COOKIE_SECURE": "false", "RATE_LIMIT_ENABLED": "false", "ENABLE_DEV_SEED": "true" if smoke else "false",
               "GEO_SECRET_KEY": "synthetic-release-stage-key-not-a-production-credential",
               "SMTP_HOST": "", "SMTP_FROM_EMAIL": "", "SMTP_PASSWORD": "", "SMTP_USERNAME": "",
               "REGISTRATION_EMAIL_ENABLED": "false", "REPORT_PDF_EMAIL_WORKER_ENABLED": "false",
               "API_BASE_URL": "http://127.0.0.1:8087"}
        process = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8087"],
                                   env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            ready = None
            for _ in range(150):
                assert process.poll() is None, "Stage API exited"
                try:
                    with urlopen('http://127.0.0.1:8087/health/ready', timeout=3) as response:
                        ready = json.load(response)
                    if ready['status'] == 'ok':
                        break
                except Exception:
                    pass
                time.sleep(0.2)
            assert ready and ready['status'] == 'ok'
            result = {"readiness": ready, "smtpDisabled": True, "uploads": "disposable-local-only"}
            if smoke:
                with tempfile.TemporaryDirectory(prefix='release-smoke-reader-') as reader_directory:
                    smoke_env, reader = smoke_reader(env, reader_directory)
                    checked = subprocess.run([sys.executable, "/app/backend/smoke_test.py"], env=smoke_env, capture_output=True, timeout=360)
                assert not Path(reader_directory).exists(), 'Test reader fixture cleanup failed'
                result.update(testReader=reader, testReaderCleanupComplete=True)
                # Failure output can contain fixture identities; retain only counts.
                lines = checked.stdout.decode('utf-8', errors='replace').splitlines()
                result.update(smokeExitCode=checked.returncode, passingChecks=sum(line.startswith('ok - ') for line in lines))
                if checked.returncode:
                    # Only source-defined check labels; never emit response bodies/tokens.
                    labels = [line[5:] for line in lines if line.startswith('ok - ')]
                    failure_label = checked.stderr.decode('utf-8', errors='replace').split(':', 1)[0][:120]
                    import re
                    status = re.search(r'expected (\d+), got (\d+)', checked.stderr.decode('utf-8', errors='replace'))
                    print('REPORTFLOW_SMOKE_DIAGNOSIS ' + json.dumps({'passingChecks': len(labels), 'lastChecks': labels[-5:], 'failureLabel': failure_label, 'statuses': status.groups() if status else None}))
                    raise AssertionError('Provider smoke failed; response details withheld')
            return result
        finally:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)


def disposable_smoke(environment):
    url = environment['DATABASE_URL']
    assert os.environ['STAGE_BRANCH_ID'] == 'STAGE_BRANCH_REPLACE'
    parsed = urlsplit(url)
    assert parsed.hostname == os.environ['STAGE_DB_HOST']
    name = 'rf_pdf_smoke_' + secrets.token_hex(8)
    marker = 'owned-staff-invitations-release:' + name
    # The normal provider harness runs with repository assets. The runtime image
    # packages the identical logo under report-logos, but legacy HTML looks in
    # /app/assets/icons. Supply that existing test fixture in this ephemeral job
    # only; retain the unchanged production-image packaging limitation explicitly.
    logo = Path('/app/backend/app/assets/report-logos/leader.png').read_bytes()
    assert hashlib.sha256(logo).hexdigest() == 'cd6ef60ecc607ee1f1730f63e74241ff93c67d29d2c1fceab53491a9fa7fdecc'
    fixture = Path('/app/assets/icons/leader-logo-export.png')
    assert not fixture.exists()
    fixture.parent.mkdir(parents=True, exist_ok=True)
    fixture.write_bytes(logo)
    with psycopg.connect(url.replace('postgresql+psycopg://', 'postgresql://', 1), autocommit=True, connect_timeout=20) as control:
        owner = control.execute('SELECT current_user').fetchone()[0]
        assert not control.execute('SELECT 1 FROM pg_database WHERE datname=%s', (name,)).fetchall()
        control.execute(sql.SQL('CREATE DATABASE {} OWNER {}').format(sql.Identifier(name), sql.Identifier(owner)))
        control.execute(sql.SQL('COMMENT ON DATABASE {} IS {}').format(sql.Identifier(name), sql.Literal(marker)))
        try:
            isolated = {**environment, 'DATABASE_URL': urlunsplit(parsed._replace(path='/'+name))}
            migrate(isolated)
            result = local_api(isolated, smoke=True)
        finally:
            actual = control.execute('SELECT pg_get_userbyid(datdba), shobj_description(oid,\'pg_database\') FROM pg_database WHERE datname=%s', (name,)).fetchone()
            assert actual == (owner, marker), 'Owned staging smoke database identity changed'
            control.execute('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=%s AND pid<>pg_backend_pid()', (name,))
            control.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(name)))
            assert not control.execute('SELECT 1 FROM pg_database WHERE datname=%s', (name,)).fetchall()
            fixture.unlink()
            print('REPORTFLOW_SMOKE_FIXTURE_CLEANUP ' + json.dumps({'status': 'passed', 'databaseDropped': True,
                'databaseAbsenceVerified': True, 'supplementalLogoRemoved': not fixture.exists()}))
        return {**result, 'freshDisposableDatabase': True, 'cleanupComplete': True,
                'supplementalRepositoryLogoFixture': True, 'productionImageUnchanged': True}


def main():
    mode = os.environ['PROBE_MODE']
    assert mode in {'inventory', 'stage-inspect', 'stage-migrate', 'stage-check', 'stage-fallback', 'stage-smoke', 'backup-verify', 'production-migrate'}
    original = os.environ['DATABASE_URL']
    parsed = urlsplit(original)
    original_host = parsed.hostname.replace('-pooler.', '.')
    assert digest(original_host) == os.environ['PRODUCTION_DB_HOST_SHA256'], 'Production host identity mismatch'
    assert parsed.username and parsed.password and parsed.path == '/neondb', 'Unexpected database URI shape'
    if mode.startswith('stage-'):
        target = os.environ['STAGE_DB_HOST']
        assert target.endswith('.ap-southeast-2.aws.neon.tech') and target != original_host
        assert os.environ['STAGE_BRANCH_ID'] == 'STAGE_BRANCH_REPLACE'
        # Branches inherit the existing database role. Credentials stay inside
        # the existing runtime binding; only the verified endpoint is changed.
        userinfo = parsed.netloc.rsplit('@', 1)[0]
        original = urlunsplit(parsed._replace(netloc=userinfo + '@' + target))
    env = {**os.environ, 'DATABASE_URL': original, 'AUTO_MIGRATE': 'false', 'SQL_ECHO': 'false'}
    before = snapshot(original)
    if mode == 'production-migrate':
        assert digest(before) == os.environ['EXPECTED_BEFORE_SHA256'], 'Paused production differs from verified backup'
    proof = {'status': 'passed', 'mode': mode, 'atUtc': datetime.now(timezone.utc).isoformat(), 'before': before}
    if mode == 'backup-verify':
        target = os.environ['BACKUP_DB_HOST']
        assert target.endswith('.ap-southeast-2.aws.neon.tech') and target != original_host
        assert os.environ['BACKUP_BRANCH_ID'] not in ['br-snowy-tree-a7hfuph6', 'STAGE_BRANCH_REPLACE']
        backup_url = urlunsplit(parsed._replace(netloc=parsed.netloc.rsplit('@', 1)[0] + '@' + target))
        saved = snapshot(backup_url)
        assert before == saved and before['migrationCount'] == 25, 'Backup does not match paused production inventory'
        proof.update(backup=saved, backupMatchesProduction=True, backupBranchId=os.environ['BACKUP_BRANCH_ID'])
    if mode in {'stage-migrate', 'production-migrate'}:
        assert before['migrationCount'] == 25 and before['migrationHead'] == '0025_report_corrections'
        assert before['invitationColumns'] == []
        migrate(env)
        after = snapshot(original)
        assert after['migrationCount'] == 26 and after['migrationHead'] == '0026_staff_invitations'
        assert set(after['invitationColumns']) == ADDED and after['nonWorkerInvitationRows'] == 0
        assert before['businessTables'] == after['businessTables']
        assert all(before[key] == after[key] for key in ('configuredTemplateRows', 'outboxRows', 'pendingOutboxRows', 'outboxStatuses'))
        assert all(after['migrationChecksums'][k] == v for k, v in before['migrationChecksums'].items())
        proof.update(after=after, businessDataPreserved=True, applied=['0026_staff_invitations'])
        print('REPORTFLOW_RELEASE_MIGRATION ' + json.dumps(proof, sort_keys=True))
    if mode == 'stage-smoke':
        assert before['migrationCount'] == 26
        proof['api'] = disposable_smoke(env)
    if mode in {'stage-migrate', 'stage-check', 'stage-fallback'}:
        if mode in {'stage-fallback', 'stage-check'}:
            assert before['migrationCount'] == 26
        proof['api'] = local_api(env, smoke=False)
    print('REPORTFLOW_RELEASE_PROOF ' + json.dumps(proof, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        import traceback
        print('REPORTFLOW_RELEASE_FAILURE ' + json.dumps({'status': 'failed', 'type': type(error).__name__,
            'code': str(error) if isinstance(error, AssertionError) else 'detail-withheld',
            'lines': [frame.lineno for frame in traceback.extract_tb(error.__traceback__) if frame.filename == '<string>'],
            'mode': os.environ.get('PROBE_MODE')}))
        sys.exit(1)
