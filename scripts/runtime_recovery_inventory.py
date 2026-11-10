"""Strict, hashed-only PostgreSQL recovery inventories. Importing does no I/O.

All public base tables INCLUDING schema_migrations are counted in ``tables``.
Only reportpdfemail's two recipient columns are excluded from original hashes.
Hashes attest captured evidence, not its provenance; callers must bind artifacts
to their independently verified database, image, source and public table count.
"""
from __future__ import annotations

import hashlib
import json
import re

OLD_HEAD = '0027_report_manual_site'
NEW_HEAD = '0028_report_pdf_recipients'
VERSION_NAMES = '''0001_initial_schema 0002_work_form_photo_metadata 0003_departments
0004_registration_verification 0005_dashboard_department_preference
0006_manual_attendance_entries 0007_record_rubbish_bin 0008_manual_task_logs
0009_worker_classes_and_team_logs 0010_pdf_daywork_form_template
0011_multi_team_daywork_form 0012_form_and_team_log_rubbish_bin
0013_daywork_team_break_options 0014_client_submission_unique_indexes
0015_work_form_definition_snapshots 0016_review_queue_indexes
0017_global_admin_supervisor_invariant 0018_report_review_workflow
0019_report_daywork_purpose 0020_missing_snapshot_daywork_correction
0021_worker_invitations 0022_worker_password_recovery 0023_worker_invitation_email
0024_report_pdf_email 0025_report_corrections 0026_staff_invitations
0027_report_manual_site 0028_report_pdf_recipients'''.split()
ADDED = {'recipient_key', 'recipient_role'}
OUTBOX_COLUMNS = {'id', 'submission_id', 'department_id', 'recipient',
                  'template_email_version', 'snapshot_json', 'status',
                  'failure_code', 'message_id', 'attempted_at', 'accepted_at', 'created_at'}
ATTEMPT_COLUMNS = ['id', 'status', 'failure_code', 'message_id', 'attempted_at', 'accepted_at']
SCHEMA_KEYS = {'compoundUnique', 'submissionIndexNonUnique', 'keyNotNull',
               'keyHasNoDefault', 'nonemptyKeyCheck', 'roleCheck', 'immutableMetadataTrigger'}


def require(ok, code):
    if not ok:
        raise ValueError(code)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), default=str).encode()).hexdigest()


def _shape(value, keys):
    require(type(value) is dict and set(value) == set(keys), 'invalid_object_shape')


def _hash(value):
    require(type(value) is str and re.fullmatch('[0-9a-f]{64}', value) is not None, 'invalid_hash')


def _ledger(value):
    if type(value) is dict:
        value = [{'version': key, 'checksum': val} for key, val in sorted(value.items())]
    require(type(value) is list and len(value) in (27, 28), 'unsupported_ledger_count')
    for index, entry in enumerate(value):
        _shape(entry, {'version', 'checksum'})
        require(entry['version'] == VERSION_NAMES[index], 'invalid_ledger_version')
        _hash(entry['checksum'])
    return value


def validate_inventory(value, expected_ledger, natural_read_only=True):
    expected = _ledger(expected_ledger)
    require(type(natural_read_only) is bool, 'invalid_read_only_expectation')
    _shape(value, {'schemaVersion', 'transactionReadOnly', 'isolationLevel', 'migrationLedger',
                   'ledgerRows', 'tables', 'outbox', 'recipientSchema'})
    require(type(value['schemaVersion']) is int and value['schemaVersion'] == 1, 'invalid_schema_version')
    require(type(value['transactionReadOnly']) is bool and value['transactionReadOnly'] is natural_read_only,
            'natural_read_only_mismatch')
    require(value['isolationLevel'] == 'repeatable read', 'invalid_isolation')
    require(type(value['migrationLedger']) is list, 'invalid_ledger_shape')
    ledger = _ledger(value['migrationLedger'])
    require(ledger == expected, 'ledger_mismatch')
    rows = value['ledgerRows']
    require(type(rows) is list and len(rows) == len(ledger), 'missing_ledger_rows')
    for entry, migration in zip(rows, ledger):
        _shape(entry, {'version', 'rowSha256'})
        require(entry['version'] == migration['version'], 'ledger_row_order_mismatch')
        _hash(entry['rowSha256'])
    tables = value['tables']
    require(type(tables) is list and len(tables) >= 7, 'missing_tables')
    for table in tables:
        _shape(table, {'nameSha256', 'columnsSha256', 'originalColumnsSha256', 'rowCount', 'rowsSha256'})
        for key in ('nameSha256', 'columnsSha256', 'originalColumnsSha256', 'rowsSha256'):
            _hash(table[key])
        require(type(table['rowCount']) is int and table['rowCount'] >= 0, 'invalid_row_count')
        if table['rowCount'] == 0:
            require(table['rowsSha256'] == digest([]), 'invalid_empty_table_hash')
        if table['nameSha256'] != digest('reportpdfemail') or len(ledger) == 27:
            require(table['columnsSha256'] == table['originalColumnsSha256'], 'unexpected_column_change')
    names = [t['nameSha256'] for t in tables]
    require(names == sorted(set(names)), 'table_order_or_duplicate')
    require({digest(n) for n in ('schema_migrations', 'reportpdfemail', 'workform', 'workformsubmission', 'department', 'site', 'user')} <= set(names), 'required_table_missing')
    by_name = {t['nameSha256']: t for t in tables}
    require(all(by_name[digest(n)]['rowCount'] > 0 for n in ('department', 'site', 'user')), 'business_sentinel_empty')
    ledger_table = by_name[digest('schema_migrations')]
    require(ledger_table['rowCount'] == len(ledger) and ledger_table['rowsSha256'] == digest(sorted(r['rowSha256'] for r in rows)), 'ledger_table_mismatch')
    outbox = value['outbox']
    _shape(outbox, {'originalColumnsSha256', 'rows', 'statusCountsSha256', 'attemptFieldsSha256'})
    for key in ('originalColumnsSha256', 'statusCountsSha256', 'attemptFieldsSha256'):
        _hash(outbox[key])
    table = by_name[digest('reportpdfemail')]
    require(outbox['originalColumnsSha256'] == table['originalColumnsSha256'], 'outbox_column_mismatch')
    require(type(outbox['rows']) is list and len(outbox['rows']) == table['rowCount'], 'outbox_count_mismatch')
    for row in outbox['rows']:
        _shape(row, {'idSha256', 'originalSha256', 'recipientKeyMatches', 'recipientRoleIsTemplate'})
        _hash(row['idSha256']); _hash(row['originalSha256'])
        for key in ('recipientKeyMatches', 'recipientRoleIsTemplate'):
            require(row[key] is None if len(ledger) == 27 else type(row[key]) is bool, 'invalid_recipient_marker')
    ids = [r['idSha256'] for r in outbox['rows']]
    require(ids == sorted(set(ids)), 'outbox_order_or_duplicate')
    require(table['rowsSha256'] == digest(sorted(r['originalSha256'] for r in outbox['rows'])), 'outbox_rows_mismatch')
    if len(ledger) == 27:
        require(value['recipientSchema'] is None, 'unexpected_recipient_schema')
    else:
        _shape(value['recipientSchema'], SCHEMA_KEYS)
        require(all(v is True for v in value['recipientSchema'].values()), 'recipient_schema_invalid')
        require(table['columnsSha256'] != table['originalColumnsSha256'], 'recipient_columns_missing')
    return value


def inventory_state_sha256(value, expected_ledger, natural_read_only):
    """Hash validated database state, excluding only its observed access mode."""
    validate_inventory(value, expected_ledger, natural_read_only=natural_read_only)
    return digest({key: item for key, item in value.items() if key != 'transactionReadOnly'})


def validate_backup(production, backup, expected_ledger):
    """A naturally read-only backup must match all paused production state."""
    production_hash = inventory_state_sha256(production, expected_ledger, False)
    backup_hash = inventory_state_sha256(backup, expected_ledger, True)
    require(production_hash == backup_hash, 'backup_inventory_state_mismatch')
    return {'status': 'passed', 'productionSha256': digest(production),
            'backupSha256': digest(backup), 'stateSha256': production_hash,
            'backupMatchesPausedProduction': True}


def validate_preservation(before, after, candidate_ledger):
    ledger = _ledger(candidate_ledger)
    require(len(ledger) == 28, 'candidate_not_schema28')
    validate_inventory(before, ledger[:27], natural_read_only=before.get('transactionReadOnly'))
    validate_inventory(after, ledger, natural_read_only=after.get('transactionReadOnly'))
    require(after['ledgerRows'][:27] == before['ledgerRows'], 'prior_ledger_rows_changed')
    require(len(before['tables']) == len(after['tables']), 'table_count_changed')
    for old, new in zip(before['tables'], after['tables']):
        require(old['nameSha256'] == new['nameSha256'], 'table_identity_changed')
        require(old['originalColumnsSha256'] == new['originalColumnsSha256'], 'original_columns_changed')
        if old['nameSha256'] != digest('schema_migrations'):
            require(old['rowCount'] == new['rowCount'] and old['rowsSha256'] == new['rowsSha256'], 'original_rows_changed')
    for key in ('originalColumnsSha256', 'statusCountsSha256', 'attemptFieldsSha256'):
        require(before['outbox'][key] == after['outbox'][key], 'outbox_state_changed')
    for old, new in zip(before['outbox']['rows'], after['outbox']['rows']):
        require(old['idSha256'] == new['idSha256'] and old['originalSha256'] == new['originalSha256'], 'outbox_row_changed')
        require(new['recipientKeyMatches'] is True and new['recipientRoleIsTemplate'] is True, 'historical_recipient_changed')
    return {'status': 'passed', 'beforeSha256': digest(before), 'afterSha256': digest(after),
            'preservedTableCount': len(before['tables']), 'preservedLedgerRows': 27,
            'preservedOutboxRows': len(before['outbox']['rows']), 'queueAttemptsUnchanged': True}


def _recipient_schema(cur):
    # Structural index checks reject partial/expression/invalid/unready indexes.
    cur.execute('''SELECT c.relname, i.indisunique, i.indisvalid, i.indisready,
        i.indpred IS NULL, i.indexprs IS NULL, i.indnkeyatts, i.indnatts,
        ARRAY(SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
              JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.ord)
        FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
        WHERE i.indrelid='public.reportpdfemail'::regclass''')
    indexes = {row[0]: row[1:] for row in cur.fetchall()}
    cur.execute("SELECT is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='reportpdfemail' AND column_name='recipient_key'")
    key = cur.fetchone()
    cur.execute("SELECT conname,pg_get_constraintdef(oid),convalidated FROM pg_constraint WHERE conrelid='public.reportpdfemail'::regclass AND contype='c'")
    constraints = [(name, re.sub(r'\s+', '', definition).lower(), valid) for name, definition, valid in cur.fetchall()]
    cur.execute('''SELECT t.tgname,t.tgenabled,t.tgtype,t.tgqual IS NULL,t.tgnargs,
        n.nspname,p.proname,p.prosrc,l.lanname,p.prosecdef
        FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
        JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
        WHERE t.tgrelid='public.reportpdfemail'::regclass AND NOT t.tgisinternal''')
    triggers = cur.fetchall()
    body = """BEGIN IF NEW.recipient_key IS DISTINCT FROM OLD.recipient_key OR NEW.recipient_role IS DISTINCT FROM OLD.recipient_role THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Submitted PDF recipient metadata is immutable'; END IF; RETURN NEW; END;"""
    normalize = lambda text: re.sub(r'\s+', ' ', text).strip()
    trigger_ok = any(name == 'trg_reportpdfemail_recipient_metadata_immutable' and enabled in ('O', 'A')
                     and kind == 19 and no_when and nargs == 0 and namespace == 'public'
                     and function == 'enforce_reportpdfemail_recipient_metadata' and normalize(source) == normalize(body)
                     and language == 'plpgsql' and not security
                     for name, enabled, kind, no_when, nargs, namespace, function, source, language, security in triggers)
    nonempty = {'check((length(trim(bothfromrecipient_key))>0))', 'check((length(btrim((recipient_key)::text))>0))', 'check((length(trim(bothfrom(recipient_key)::text))>0))'}
    role = "check(((recipient_role)::text=any((array['template'::charactervarying,'submitter'::charactervarying,'selected'::charactervarying])::text[])))"
    return {'compoundUnique': indexes.get('ux_reportpdfemail_submission_recipient') == (True, True, True, True, True, 2, 2, ['submission_id', 'recipient_key']),
            'submissionIndexNonUnique': indexes.get('ix_reportpdfemail_submission_id') == (False, True, True, True, True, 1, 1, ['submission_id']) and not any(row[0] and row[-1] == ['submission_id'] for row in indexes.values()),
            'keyNotNull': key is not None and key[0] == 'NO', 'keyHasNoDefault': key is not None and key[1] is None,
            'nonemptyKeyCheck': any(name == 'ck_reportpdfemail_recipient_key' and valid and definition in nonempty for name, definition, valid in constraints),
            'roleCheck': any(valid and definition == role for _, definition, valid in constraints),
            'immutableMetadataTrigger': trigger_ok}


def capture_inventory(url, expected_ledger, *, natural_read_only):
    """One consistent read-only capture; never emits database exception details.

    The natural transaction mode is observed BEFORE forcing READ ONLY. Writable
    baselines are supported only with explicit natural_read_only=False. No SQL
    mutation is executed, even on these naturally writable targets.
    """
    expected = _ledger(expected_ledger)
    require(type(natural_read_only) is bool, 'invalid_read_only_expectation')
    try:
        import psycopg
        from psycopg import sql, IsolationLevel
        with psycopg.connect(url.replace('postgresql+psycopg://', 'postgresql://', 1), connect_timeout=20) as conn:
            conn.isolation_level = IsolationLevel.REPEATABLE_READ
            with conn.cursor() as cur:
                cur.execute('SHOW transaction_read_only')
                natural = cur.fetchone()[0]
                require(natural in ('on', 'off') and (natural == 'on') is natural_read_only, 'natural_read_only_mismatch')
                cur.execute('SET TRANSACTION READ ONLY')
                cur.execute('SHOW transaction_read_only')
                require(cur.fetchone()[0] == 'on', 'read_only_not_enforced')
                cur.execute('SHOW transaction_isolation')
                isolation = cur.fetchone()[0]
                require(isolation == 'repeatable read', 'invalid_isolation')
                cur.execute("SET LOCAL statement_timeout = '30s'")
                cur.execute("SET LOCAL lock_timeout = '5s'")
                cur.execute("SELECT version,checksum FROM public.schema_migrations ORDER BY version")
                ledger = [{'version': v, 'checksum': c} for v, c in cur.fetchall()]
                require(_ledger(ledger) == expected, 'ledger_mismatch')
                cur.execute("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")
                names = [r[0] for r in cur.fetchall()]
                tables, ledger_rows, outbox_rows, attempts, statuses = [], [], [], [], {}
                outbox_columns = None
                for name in names:
                    cur.execute("""SELECT column_name,data_type,udt_schema,udt_name,is_nullable,ordinal_position,
                        column_default,character_maximum_length,numeric_precision,numeric_scale,datetime_precision,
                        is_identity,identity_generation,is_generated,generation_expression,collation_name
                        FROM information_schema.columns WHERE table_schema='public' AND table_name=%s ORDER BY ordinal_position""", (name,))
                    metadata = [list(r) for r in cur.fetchall()]
                    columns = [r[0] for r in metadata]
                    require(bool(columns), 'table_columns_missing')
                    original = [r for r in metadata if name != 'reportpdfemail' or r[0] not in ADDED]
                    old_columns = [r[0] for r in original]
                    if name == 'reportpdfemail':
                        require(OUTBOX_COLUMNS <= set(old_columns), 'original_outbox_columns_missing')
                        require(set(columns) & ADDED == (ADDED if len(ledger) == 28 else set()), 'recipient_columns_mismatch')
                        if len(ledger) == 28:
                            require(columns[-2:] == ['recipient_key', 'recipient_role'], 'recipient_column_order_mismatch')
                            added_metadata = metadata[-2:]
                            require(all(r[1:5] == ['character varying', 'pg_catalog', 'varchar', 'NO']
                                        and r[7] is None and r[11] == 'NO' and r[13] == 'NEVER'
                                        for r in added_metadata), 'recipient_column_type_mismatch')
                            require(added_metadata[0][6] is None and added_metadata[1][6] in
                                    ("'template'::character varying", "'template'::text"), 'recipient_column_default_mismatch')
                        outbox_columns = digest(original)
                    if name == 'workformsubmission':
                        require('manual_site_name' in columns, 'manual_site_column_missing')
                    cur.execute(sql.SQL('SELECT {} FROM {}.{}').format(sql.SQL(',').join(map(sql.Identifier, columns)), sql.Identifier('public'), sql.Identifier(name)))
                    hashes = []
                    for values in cur.fetchall():
                        row = dict(zip(columns, values))
                        hashed = digest([row[c] for c in old_columns]); hashes.append(hashed)
                        if name == 'schema_migrations':
                            ledger_rows.append({'version': row['version'], 'rowSha256': hashed})
                        if name == 'reportpdfemail':
                            outbox_rows.append({'idSha256': digest(row['id']), 'originalSha256': hashed,
                                'recipientKeyMatches': row['recipient_key'] == row['recipient'].strip().casefold() if len(ledger) == 28 else None,
                                'recipientRoleIsTemplate': row['recipient_role'] == 'template' if len(ledger) == 28 else None})
                            attempts.append(digest([row[c] for c in ATTEMPT_COLUMNS]))
                            statuses[row['status']] = statuses.get(row['status'], 0) + 1
                    tables.append({'nameSha256': digest(name), 'columnsSha256': digest(metadata),
                        'originalColumnsSha256': digest(original), 'rowCount': len(hashes), 'rowsSha256': digest(sorted(hashes))})
                schema = _recipient_schema(cur) if len(ledger) == 28 else None
            conn.rollback()
        result = {'schemaVersion': 1, 'transactionReadOnly': natural == 'on', 'isolationLevel': isolation,
            'migrationLedger': ledger, 'ledgerRows': sorted(ledger_rows, key=lambda r: r['version']),
            'tables': sorted(tables, key=lambda t: t['nameSha256']),
            'outbox': {'originalColumnsSha256': outbox_columns, 'rows': sorted(outbox_rows, key=lambda r: r['idSha256']),
                       'statusCountsSha256': digest(statuses), 'attemptFieldsSha256': digest(sorted(attempts))},
            'recipientSchema': schema}
        return validate_inventory(result, expected, natural_read_only)
    except Exception:
        raise ValueError('inventory_capture_failed_details_withheld') from None
