import assert from 'node:assert/strict';
import {
  readReportReviewPreferences, reportReviewPreferenceKey, writeReportReviewPreferences
} from '../assets/js/report-review-preferences.js';

const supervisor = { id: 17, departmentId: 3, role: 'supervisor', isGlobalAdmin: false };
const administrator = { ...supervisor, isGlobalAdmin: true };
const defaults = { status: '', formId: '', workerId: '', date: '', sortOrder: 'newest' };
const selected = { status: 'in_review', formId: '5', workerId: '19', date: '2026-09-29', sortOrder: 'oldest_waiting' };
let groups = 0;

function memoryStorage() {
  const entries = new Map();
  return { entries, getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
}

function check(name, callback) {
  callback();
  groups += 1;
  console.log(`PASS ${name}`);
}

check('canonical identity and effective Department scope', () => {
  assert.equal(reportReviewPreferenceKey(supervisor, ''), reportReviewPreferenceKey(supervisor, '3'));
  assert.equal(reportReviewPreferenceKey(supervisor, 3), reportReviewPreferenceKey({ ...supervisor, id: '17', departmentId: '3' }, '3'));
  assert.equal(reportReviewPreferenceKey(supervisor, '4'), null);
  const keys = [
    reportReviewPreferenceKey(supervisor, '3'),
    reportReviewPreferenceKey({ ...supervisor, id: 18 }, '3'),
    reportReviewPreferenceKey({ ...supervisor, departmentId: 4 }, '4'),
    reportReviewPreferenceKey(administrator, '3'),
    reportReviewPreferenceKey(administrator, '4'),
    reportReviewPreferenceKey(administrator, ''),
    reportReviewPreferenceKey({ ...administrator, departmentId: 4 }, '3')
  ];
  assert.ok(keys.every((key) => key?.includes(':v1:')));
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(reportReviewPreferenceKey({ ...supervisor, isGlobalAdmin: 'true' }, '4'), null);
});

check('invalid identities and scopes cannot access storage', () => {
  const forbidden = { getItem() { assert.fail('Unexpected read'); }, setItem() { assert.fail('Unexpected write'); } };
  const invalidUsers = [null, {}, { ...supervisor, role: 'worker' }, { ...supervisor, role: 'admin' }];
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '', '03', ' 3', '+3', '3e0', null, {}, true]) {
    invalidUsers.push({ ...supervisor, id: value }, { ...supervisor, departmentId: value });
    assert.equal(reportReviewPreferenceKey(administrator, value), value === '' ? reportReviewPreferenceKey(administrator, '') : null);
  }
  for (const user of invalidUsers) {
    assert.equal(reportReviewPreferenceKey(user, '3'), null);
    assert.deepEqual(readReportReviewPreferences(user, '3', { storage: forbidden }), { filters: defaults, available: true });
    assert.equal(writeReportReviewPreferences(user, '3', selected, { storage: forbidden }), false);
  }
  assert.equal(reportReviewPreferenceKey(supervisor, undefined), null);
});

check('structured preferences round-trip without search or Report content', () => {
  const storage = memoryStorage();
  assert.equal(writeReportReviewPreferences(supervisor, '3', {
    ...selected, query: 'Sensitive incident', name: 'A Worker', photos: ['private.jpg'], token: 'secret'
  }, { storage }), true);
  assert.deepEqual(readReportReviewPreferences(supervisor, '', { storage }), { filters: selected, available: true });
  const raw = storage.entries.get(reportReviewPreferenceKey(supervisor, '3'));
  assert.deepEqual(JSON.parse(raw), { schemaVersion: 1, filters: selected });
  assert.ok(!/Sensitive|Worker|private|secret/.test(raw));
});

check('accounts, home Departments, global capability and focused Departments remain isolated', () => {
  const storage = memoryStorage();
  writeReportReviewPreferences(supervisor, '3', selected, { storage });
  for (const [user, focus] of [
    [{ ...supervisor, id: 18 }, '3'], [{ ...supervisor, departmentId: 4 }, '4'],
    [administrator, '3'], [administrator, '4'], [administrator, '']
  ]) assert.deepEqual(readReportReviewPreferences(user, focus, { storage }).filters, defaults);
  writeReportReviewPreferences(administrator, '4', { ...selected, status: 'submitted' }, { storage });
  writeReportReviewPreferences(administrator, '', { ...selected, status: 'resolved' }, { storage });
  assert.equal(readReportReviewPreferences(administrator, '4', { storage }).filters.status, 'submitted');
  assert.equal(readReportReviewPreferences(administrator, '', { storage }).filters.status, 'resolved');
  assert.deepEqual(readReportReviewPreferences({ ...administrator, departmentId: 4 }, '4', { storage }).filters, defaults);
  assert.deepEqual(readReportReviewPreferences(supervisor, '3', { storage }).filters, selected);
});

check('only Report workflow values and canonical safe identifiers survive', () => {
  const storage = memoryStorage();
  for (const status of ['', 'submitted', 'in_review', 'resolved']) {
    writeReportReviewPreferences(supervisor, '', { status, formId: 7, workerId: Number.MAX_SAFE_INTEGER }, { storage });
    assert.deepEqual(readReportReviewPreferences(supervisor, '', { storage }).filters,
      { status, formId: '7', workerId: String(Number.MAX_SAFE_INTEGER), date: '', sortOrder: 'newest' });
  }
  for (const value of ['approved', 'rejected', 'pending', 'Submitted', null, {}, [], 7]) {
    writeReportReviewPreferences(supervisor, '', { status: value }, { storage });
    assert.equal(readReportReviewPreferences(supervisor, '', { storage }).filters.status, '');
  }
  for (const value of ['00', '05', '1.5', '1e2', ' 9 ', '-3', '9007199254740992', 0, -1, 1.5, {}, true, null]) {
    writeReportReviewPreferences(supervisor, '', { formId: value, workerId: value }, { storage });
    assert.deepEqual(readReportReviewPreferences(supervisor, '', { storage }).filters, defaults);
  }
});

check('v1 records without sort retain filters and invalid sorts fall back to newest', () => {
  const storage = memoryStorage();
  const key = reportReviewPreferenceKey(supervisor, '3');
  const legacy = { ...selected };
  delete legacy.sortOrder;
  storage.setItem(key, JSON.stringify({ schemaVersion: 1, filters: legacy }));
  assert.deepEqual(readReportReviewPreferences(supervisor, '3', { storage }).filters, { ...legacy, sortOrder: 'newest' });
  for (const sortOrder of ['newest', 'oldest_waiting']) {
    writeReportReviewPreferences(supervisor, '3', { ...selected, sortOrder }, { storage });
    assert.deepEqual(readReportReviewPreferences(supervisor, '3', { storage }).filters, { ...selected, sortOrder });
  }
  for (const sortOrder of ['', 'oldest', 'Oldest waiting', 'newest ', null, {}, [], 1, true]) {
    storage.setItem(key, JSON.stringify({ schemaVersion: 1, filters: { ...selected, sortOrder } }));
    assert.deepEqual(readReportReviewPreferences(supervisor, '3', { storage }).filters, { ...selected, sortOrder: 'newest' });
    writeReportReviewPreferences(supervisor, '3', { ...selected, sortOrder }, { storage });
    assert.equal(readReportReviewPreferences(supervisor, '3', { storage }).filters.sortOrder, 'newest');
  }
});

check('Report Dates require real calendar days including Gregorian leap rules', () => {
  const storage = memoryStorage();
  for (const date of ['2026-09-29', '2024-02-29', '2000-02-29', '0001-01-01', '0099-12-31', '9999-12-31']) {
    writeReportReviewPreferences(supervisor, '', { date }, { storage });
    assert.equal(readReportReviewPreferences(supervisor, '', { storage }).filters.date, date);
  }
  for (const date of ['', '2026-02-29', '1900-02-29', '2026-04-31', '2026-13-01', '2026-00-01',
    '2026-09-00', '2026-9-29', '0000-01-01', '2026-09-29T00:00:00Z', ' 2026-09-29', 20260929, null]) {
    writeReportReviewPreferences(supervisor, '', { date }, { storage });
    assert.equal(readReportReviewPreferences(supervisor, '', { storage }).filters.date, '');
  }
});

check('missing, corrupt, oversized or incompatible records safely use defaults', () => {
  const storage = memoryStorage();
  const key = reportReviewPreferenceKey(supervisor, '3');
  assert.deepEqual(readReportReviewPreferences(supervisor, '3', { storage }), { filters: defaults, available: true });
  for (const raw of ['{', 'null', '[]', '42', '"text"', ' '.repeat(1025),
    JSON.stringify({ schemaVersion: 2, filters: selected }), JSON.stringify({ filters: selected }),
    JSON.stringify({ schemaVersion: 1, filters: selected, query: 'Never restore' }),
    JSON.stringify({ schemaVersion: 1, filters: { ...selected, query: 'Never restore' } }),
    JSON.stringify({ schemaVersion: 1, filters: [] }),
    '{"schemaVersion":1,"filters":{"__proto__":{"status":"resolved"}}}'
  ]) {
    storage.setItem(key, raw);
    assert.deepEqual(readReportReviewPreferences(supervisor, '3', { storage }), { filters: defaults, available: true });
  }
  storage.setItem(key, JSON.stringify({ schemaVersion: 1, filters: { ...selected, date: '2026-02-30', formId: {} } }));
  assert.deepEqual(readReportReviewPreferences(supervisor, '3', { storage }).filters,
    { ...selected, date: '', formId: '' });
});

check('blocked and quota-limited storage never interrupts filtering', () => {
  const blocked = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } };
  assert.deepEqual(readReportReviewPreferences(supervisor, '3', { storage: blocked }), { filters: defaults, available: false });
  assert.equal(writeReportReviewPreferences(supervisor, '3', selected, { storage: blocked }), false);
  assert.deepEqual(readReportReviewPreferences(supervisor, '3', { storage: null }), { filters: defaults, available: false });
  assert.equal(writeReportReviewPreferences(supervisor, '3', selected, { storage: null }), false);
  const writableOnly = { getItem() { throw new Error('SecurityError'); }, setItem() {} };
  assert.equal(writeReportReviewPreferences(supervisor, '3', selected, { storage: writableOnly }), true);
});

check('default browser storage access is resolved lazily inside the error boundary', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    Object.defineProperty(globalThis.window, 'localStorage', { get() { throw new Error('SecurityError'); } });
    assert.deepEqual(readReportReviewPreferences(supervisor, '3'), { filters: defaults, available: false });
    assert.equal(writeReportReviewPreferences(supervisor, '3', selected), false);
    const storage = memoryStorage();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } });
    assert.equal(writeReportReviewPreferences(supervisor, '3', selected), true);
    assert.deepEqual(readReportReviewPreferences(supervisor, '3').filters, selected);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else delete globalThis.window;
  }
});

check('clear overwrites only the active scope and returned defaults are not shared', () => {
  const storage = memoryStorage();
  writeReportReviewPreferences(administrator, '3', selected, { storage });
  writeReportReviewPreferences(administrator, '4', selected, { storage });
  writeReportReviewPreferences(administrator, '3', defaults, { storage });
  const result = readReportReviewPreferences(administrator, '3', { storage });
  assert.deepEqual(result.filters, defaults);
  result.filters.status = 'resolved';
  assert.deepEqual(readReportReviewPreferences(administrator, '3', { storage }).filters, defaults);
  assert.deepEqual(readReportReviewPreferences(administrator, '4', { storage }).filters, selected);
  for (const filters of [undefined, null, [], 'text']) {
    assert.equal(writeReportReviewPreferences(administrator, '3', filters, { storage }), true);
    assert.deepEqual(readReportReviewPreferences(administrator, '3', { storage }).filters, defaults);
  }
});

console.log(`Report review preferences passed ${groups} groups.`);
