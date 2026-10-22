"""Read-only aggregate inventory via the existing authorized Neon CLI session."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from datetime import datetime, timezone

OUT = Path(__file__).resolve().parent

def inventory(name):
    assert re.fullmatch(r'[a-z-]+', name)
    destination = OUT / (name + '.json')
    assert not destination.exists(), 'Preserve the previous observation'
    query = '''BEGIN READ ONLY;
SELECT json_build_object(
 'read_only',current_setting('transaction_read_only'),
 'migrations',(SELECT json_object_agg(version,checksum ORDER BY version) FROM schema_migrations),
 'users',(SELECT json_build_object('count',count(*),'digest',md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY id),''))) FROM "user" t),
 'templates',(SELECT json_build_object('count',count(*),'digest',md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY id),''))) FROM workform t),
 'reports',(SELECT json_build_object('count',count(*),'digest',md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY id),''))) FROM workformsubmission t),
 'outbox',(SELECT json_build_object('count',count(*),'digest',md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY id),''))) FROM reportpdfemail t),
 'configured_email_templates',(SELECT count(*) FROM workform WHERE pdf_email_enabled OR pdf_email_recipient IS NOT NULL),
 'pending_emails',(SELECT count(*) FROM reportpdfemail WHERE status IN ('pending','sending')));
ROLLBACK;'''
    temporary = Path.cwd() / 'output/report-template-preparation-20261022'
    sql_file = temporary / (name + '.sql')
    sql_file.write_text(query, encoding='utf-8')
    environment = {**os.environ, 'PATH': r'C:\Program Files\PostgreSQL\17\bin' + os.pathsep + os.environ['PATH'],
        'PGOPTIONS': '-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=3000', 'PSQL_HISTORY': os.devnull}
    result = subprocess.run([shutil.which('npx.cmd'), '--yes', 'neon@2.32.0', 'psql', 'br-snowy-tree-a7hfuph6',
        '--project-id', 'plain-smoke-06194407', '--database-name', 'neondb', '--no-analytics', '--',
        '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-f', str(sql_file.resolve())],
        env=environment, capture_output=True, encoding='utf-8', timeout=90)
    assert result.returncode == 0, 'Read-only inventory failed; provider output withheld'
    clean = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', result.stdout + '\n' + result.stderr)
    rows = [json.loads(line.strip()) for line in clean.splitlines() if line.strip().startswith('{')]
    assert len(rows) == 1 and rows[0]['read_only'] == 'on'
    value = rows[0]
    bundled = {p.stem: hashlib.sha256(p.read_bytes()).hexdigest() for p in Path('backend/migrations/versions').glob('[0-9]*.py')}
    assert value['migrations'] == bundled and len(bundled) == 25
    assert value['configured_email_templates'] == 0 and value['pending_emails'] == 0, 'Stop: routing or actionable outbox is present'
    destination.write_text(json.dumps({'status':'passed','atUtc':datetime.now(timezone.utc).isoformat(), **value}, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'status':'passed','observation':name,'migrations':len(bundled),'configuredEmailTemplates':0,'pendingEmails':0}))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('name')
    inventory(parser.parse_args().name)
