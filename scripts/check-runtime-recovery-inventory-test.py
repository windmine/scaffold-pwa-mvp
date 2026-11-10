"""Offline strict-envelope/preservation tests. No provider access or mutations."""
import copy
import sys
import types
import unittest
from unittest.mock import patch

import runtime_recovery_inventory as inv


LEDGER = [{'version': name, 'checksum': inv.digest(name)} for name in inv.VERSION_NAMES]


def fixture(count=27):
    ledger_rows = [{'version': r['version'], 'rowSha256': inv.digest([r['version'], r['checksum'], 'applied metadata'])} for r in LEDGER[:count]]
    outbox_rows = [{'idSha256': inv.digest(1), 'originalSha256': inv.digest(['all original fields']),
                    'recipientKeyMatches': True if count == 28 else None,
                    'recipientRoleIsTemplate': True if count == 28 else None}]
    tables = []
    for name in ('schema_migrations', 'reportpdfemail', 'workform', 'workformsubmission', 'department', 'site', 'user'):
        rows = ledger_rows if name == 'schema_migrations' else outbox_rows if name == 'reportpdfemail' else [{'rowSha256': inv.digest(name + ' sentinel')}] if name in ('department', 'site', 'user') else []
        tables.append({'nameSha256': inv.digest(name), 'columnsSha256': inv.digest(name + (' new' if name == 'reportpdfemail' and count == 28 else ' columns')),
                       'originalColumnsSha256': inv.digest(name + ' columns'), 'rowCount': len(rows),
                       'rowsSha256': inv.digest(sorted(r.get('rowSha256', r.get('originalSha256')) for r in rows))})
    return {'schemaVersion': 1, 'transactionReadOnly': True, 'isolationLevel': 'repeatable read',
            'migrationLedger': copy.deepcopy(LEDGER[:count]), 'ledgerRows': ledger_rows,
            'tables': sorted(tables, key=lambda t: t['nameSha256']),
            'outbox': {'originalColumnsSha256': inv.digest('reportpdfemail columns'), 'rows': outbox_rows,
                       'statusCountsSha256': inv.digest({'pending': 1}), 'attemptFieldsSha256': inv.digest(['attempt fields'])},
            'recipientSchema': dict.fromkeys(inv.SCHEMA_KEYS, True) if count == 28 else None}


class InventoryTests(unittest.TestCase):
    def reject(self, value, count=27):
        with self.assertRaises(ValueError):
            inv.validate_inventory(value, LEDGER[:count])

    def test_valid_and_preservation(self):
        for count in (27, 28):
            inv.validate_inventory(fixture(count), LEDGER[:count])
            inv.validate_inventory(fixture(count), {r['version']: r['checksum'] for r in LEDGER[:count]})
        result = inv.validate_preservation(fixture(), fixture(28), LEDGER)
        self.assertEqual(result['preservedLedgerRows'], 27)
        self.assertEqual(result['preservedTableCount'], 7)
        self.assertEqual(result['preservedOutboxRows'], 1)
        self.assertIs(result['queueAttemptsUnchanged'], True)

    def test_backup_state_hash_excludes_only_observed_readonly_mode(self):
        production = fixture(); production['transactionReadOnly'] = False
        backup = fixture(); original = copy.deepcopy(production)
        result = inv.validate_backup(production, backup, LEDGER[:27])
        self.assertEqual(set(result), {'status', 'productionSha256', 'backupSha256', 'stateSha256', 'backupMatchesPausedProduction'})
        self.assertEqual(result['status'], 'passed'); self.assertIs(result['backupMatchesPausedProduction'], True)
        self.assertEqual(result['productionSha256'], inv.digest(production))
        self.assertEqual(result['backupSha256'], inv.digest(backup))
        self.assertNotEqual(result['productionSha256'], result['backupSha256'])
        self.assertEqual(result['stateSha256'], inv.digest({k: v for k, v in production.items() if k != 'transactionReadOnly'}))
        self.assertEqual(production, original)
        for wrong_production, wrong_backup in ((backup, backup), (production, production)):
            with self.assertRaises(ValueError): inv.validate_backup(wrong_production, wrong_backup, LEDGER[:27])
        for field in ('attemptFieldsSha256', 'statusCountsSha256'):
            changed = copy.deepcopy(backup); changed['outbox'][field] = inv.digest('changed')
            with self.assertRaises(ValueError): inv.validate_backup(production, changed, LEDGER[:27])
        for field in ('columnsSha256', 'originalColumnsSha256', 'rowsSha256', 'rowCount'):
            changed = copy.deepcopy(backup); table = next(t for t in changed['tables'] if t['nameSha256'] == inv.digest('user'))
            table[field] = 2 if field == 'rowCount' else inv.digest('changed')
            with self.assertRaises(ValueError): inv.validate_backup(production, changed, LEDGER[:27])
        for field in backup:
            changed = copy.deepcopy(backup); del changed[field]
            with self.assertRaises(ValueError): inv.validate_backup(production, changed, LEDGER[:27])
        changed = copy.deepcopy(backup); changed['unexpected'] = 'secret'
        with self.assertRaises(ValueError): inv.inventory_state_sha256(changed, LEDGER[:27], True)

    def test_every_object_omission_extra_and_wrong_type(self):
        for count in (27, 28):
            baseline = fixture(count)
            paths = [(), ('migrationLedger', 0), ('ledgerRows', 0), ('tables', 0), ('outbox',), ('outbox', 'rows', 0)]
            if count == 28:
                paths.append(('recipientSchema',))
            for path in paths:
                obj = baseline
                for key in path:
                    obj = obj[key]
                for field in [*obj, '__extra__']:
                    value = copy.deepcopy(baseline); target = value
                    for key in path:
                        target = target[key]
                    if field == '__extra__':
                        target[field] = 'postgresql://password-secret'
                    else:
                        del target[field]
                    self.reject(value, count)
                for field in obj:
                    value = copy.deepcopy(baseline); target = value
                    for key in path:
                        target = target[key]
                    target[field] = {'password': 'secret'}
                    self.reject(value, count)

    def test_invalid_ledger_and_types(self):
        for field, val in [('schemaVersion', True), ('transactionReadOnly', 1), ('isolationLevel', 'read committed')]:
            value = fixture(); value[field] = val; self.reject(value)
        for field in ('version', 'checksum'):
            value = fixture(); value['migrationLedger'][0][field] = 'password-secret'; self.reject(value)
        for count in (0, 26, 29):
            value = fixture(); value['migrationLedger'] = value['migrationLedger'][:count] if count < 27 else value['migrationLedger'] * 2; self.reject(value)
        value = fixture(); value['tables'][0]['rowCount'] = True; self.reject(value)
        value = fixture(); value['tables'][0]['nameSha256'] = 'A' * 64; self.reject(value)

    def test_duplicate_missing_and_order(self):
        for field in ('tables', 'migrationLedger', 'ledgerRows'):
            value = fixture(); value[field].reverse(); self.reject(value)
            value = fixture(); value[field].append(value[field][0]); self.reject(value)
        value = fixture(); value['outbox']['rows'] *= 2; self.reject(value)
        for name in ('schema_migrations', 'reportpdfemail', 'workform', 'workformsubmission', 'department', 'site', 'user'):
            value = fixture(); value['tables'] = [t for t in value['tables'] if t['nameSha256'] != inv.digest(name)]; self.reject(value)
        value = fixture(); value['outbox']['rows'] = []; self.reject(value)
        for name in ('department', 'site', 'user'):
            value = fixture(); table = next(t for t in value['tables'] if t['nameSha256'] == inv.digest(name))
            table.update(rowCount=0, rowsSha256=inv.digest([])); self.reject(value)

    def test_every_recipient_physical_guard_required(self):
        for field in inv.SCHEMA_KEYS:
            for invalid in (False, 1, None, 'true'):
                value = fixture(28); value['recipientSchema'][field] = invalid; self.reject(value, 28)

    def test_preservation_rejects_attempt_status_metadata_and_old_columns(self):
        for field in ('attemptFieldsSha256', 'statusCountsSha256', 'originalColumnsSha256'):
            value = fixture(28); value['outbox'][field] = inv.digest('changed')
            with self.assertRaises(ValueError):
                inv.validate_preservation(fixture(), value, LEDGER)
        for field in ('originalColumnsSha256', 'rowsSha256', 'rowCount', 'nameSha256'):
            value = fixture(28); table = next(t for t in value['tables'] if t['nameSha256'] == inv.digest('workform'))
            table[field] = 1 if field == 'rowCount' else inv.digest('changed')
            with self.assertRaises(ValueError):
                inv.validate_preservation(fixture(), value, LEDGER)
        value = fixture(28); value['ledgerRows'][0]['rowSha256'] = inv.digest('changed metadata')
        next(t for t in value['tables'] if t['nameSha256'] == inv.digest('schema_migrations'))['rowsSha256'] = inv.digest(sorted(r['rowSha256'] for r in value['ledgerRows']))
        with self.assertRaises(ValueError):
            inv.validate_preservation(fixture(), value, LEDGER)
        for field in ('recipientKeyMatches', 'recipientRoleIsTemplate'):
            value = fixture(28); value['outbox']['rows'][0][field] = False
            with self.assertRaises(ValueError):
                inv.validate_preservation(fixture(), value, LEDGER)

    def test_natural_read_only_checked_before_forcing_and_no_leak(self):
        class FakeConnection:
            isolation_level = None
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def cursor(self): return self
            def execute(self, statement):
                statements.append(statement)
                if len(statements) > 1:
                    raise RuntimeError('password-secret')
            def fetchone(self): return ('off',)
        for expected in (True, False):
            statements = []
            module = types.SimpleNamespace(connect=lambda *a, **kw: FakeConnection(), sql=object(), IsolationLevel=types.SimpleNamespace(REPEATABLE_READ='repeatable read'))
            with patch.dict(sys.modules, {'psycopg': module}):
                with self.assertRaisesRegex(ValueError, '^inventory_capture_failed_details_withheld$'):
                    inv.capture_inventory('postgresql://password-secret', LEDGER[:27], natural_read_only=expected)
            self.assertEqual(statements[0], 'SHOW transaction_read_only')
            self.assertEqual(len(statements), 1 if expected else 2)
            if not expected:
                self.assertEqual(statements[1], 'SET TRANSACTION READ ONLY')

    def test_structural_index_constraint_and_trigger_rejection(self):
        body = "BEGIN IF NEW.recipient_key IS DISTINCT FROM OLD.recipient_key OR NEW.recipient_role IS DISTINCT FROM OLD.recipient_role THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Submitted PDF recipient metadata is immutable'; END IF; RETURN NEW; END;"
        indexes = [('ux_reportpdfemail_submission_recipient', True, True, True, True, True, 2, 2, ['submission_id', 'recipient_key']),
                   ('ix_reportpdfemail_submission_id', False, True, True, True, True, 1, 1, ['submission_id'])]
        constraints = [('ck_reportpdfemail_recipient_key', 'CHECK ((length(TRIM(BOTH FROM recipient_key)) > 0))', True),
                       ('role', "CHECK (((recipient_role)::text = ANY ((ARRAY['template'::character varying, 'submitter'::character varying, 'selected'::character varying])::text[])))", True)]
        trigger = ('trg_reportpdfemail_recipient_metadata_immutable', 'O', 19, True, 0, 'public', 'enforce_reportpdfemail_recipient_metadata', body, 'plpgsql', False)
        def check(ix=indexes, checks=constraints, triggers=None):
            class Cursor:
                def execute(self, *args): pass
                def fetchone(self): return ('NO', None)
                def fetchall(self): return next(self.responses)
            cur = Cursor(); cur.responses = iter([ix, checks, [trigger] if triggers is None else triggers])
            return inv._recipient_schema(cur)
        self.assertTrue(all(check().values()))
        for position in (2, 3, 4, 5):
            changed = copy.deepcopy(indexes); row = list(changed[0]); row[position] = False; changed[0] = tuple(row)
            self.assertFalse(check(ix=changed)['compoundUnique'])
        self.assertFalse(check(ix=indexes + [('extra_unique', True, True, True, True, True, 1, 1, ['submission_id'])])['submissionIndexNonUnique'])
        self.assertFalse(check(checks=[(n, d + ' OR true', v) for n, d, v in constraints])['nonemptyKeyCheck'])
        self.assertFalse(check(checks=[(n, d, False) for n, d, v in constraints])['roleCheck'])
        for position, value in ((1, 'D'), (2, 17), (3, False), (5, 'other'), (7, body + ' -- bypass'), (9, True)):
            row = list(trigger); row[position] = value
            self.assertFalse(check(triggers=[tuple(row)])['immutableMetadataTrigger'])


if __name__ == '__main__':
    unittest.main()
