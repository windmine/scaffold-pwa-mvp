import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  createReportNoteDraftStore, reportNoteContext, reportNoteDraftKey, REPORT_NOTE_MAX_LENGTH
} from '../assets/js/report-note-drafts.js';

const supervisor = { id: 17, departmentId: 3, role: 'supervisor', isGlobalAdmin: false };
const report = { type: 'form', backendRecordId: 21, departmentId: 3, submissionPurpose: 'report', durability: 'durable' };
const context = reportNoteContext(supervisor, report);
const absent = { revision: 0, text: '', savedAt: '', deleted: true, finalized: false };
let groups = 0;

async function check(name, callback) {
  await callback();
  groups += 1;
  console.log(`PASS ${name}`);
}

function memoryStorage() {
  const rows = new Map();
  const reads = [];
  const writes = [];
  let pending = Promise.resolve();
  return {
    rows, reads, writes,
    async readRow(key) {
      await pending;
      reads.push(key);
      return structuredClone(rows.get(key));
    },
    updateRow(key, update) {
      const operation = pending.then(() => {
        const next = update(structuredClone(rows.get(key)));
        rows.set(key, structuredClone(next));
        writes.push(key);
        return structuredClone(next);
      });
      pending = operation.catch(() => {});
      return operation;
    }
  };
}

await check('strict durable Report and Supervisor scope only', () => {
  assert.deepEqual(context, { ownerId: '17', ownerDepartmentId: '3', globalAdmin: false, departmentId: '3', reportId: '21' });
  assert.ok(Object.isFrozen(context));
  assert.equal(reportNoteDraftKey(context), 'report-resolution-note:v1:supervisor:17:home:3:global:0:department:3:report:21');
  assert.throws(() => reportNoteDraftKey({ ...context, departmentId: '4' }), { code: 'REPORT_NOTE_CONTEXT' });
  assert.deepEqual(reportNoteContext({ ...supervisor, id: '17', departmentId: '3' }, report, '3'), context);
  assert.deepEqual(reportNoteContext(supervisor, { ...report, submissionPurpose: undefined, submission_purpose: 'report' }), context);
  assert.deepEqual(reportNoteContext(supervisor, { ...report, department_id: '3' }), context);
  for (const user of [null, {}, { ...supervisor, role: 'worker' }, { ...supervisor, role: 'admin' }]) {
    assert.equal(reportNoteContext(user, report), null);
  }
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '', '03', ' 3', '+3', '3e0', null, {}, true, [3]]) {
    assert.equal(reportNoteContext({ ...supervisor, id: value }, report), null);
    assert.equal(reportNoteContext({ ...supervisor, departmentId: value }, report), null);
    assert.equal(reportNoteContext(supervisor, { ...report, departmentId: value }), null);
    assert.equal(reportNoteContext(supervisor, { ...report, backendRecordId: value }), null);
    if (value !== '') assert.equal(reportNoteContext(supervisor, report, value), null);
  }
  for (const change of [
    { type: 'task' }, { submissionPurpose: 'daywork' }, { submissionPurpose: '' },
    { submissionPurpose: undefined }, { submission_purpose: 'daywork' },
    { backendRecordId: undefined, id: 'form-21' }, { departmentId: undefined }, { departmentId: 4 },
    { durability: 'local_only' }, { durability: undefined }, { department_id: 4 }, { department_id: null }
  ]) assert.equal(reportNoteContext(supervisor, { ...report, ...change }), null);
  assert.equal(reportNoteContext(supervisor, report, '4'), null);
  const global = { ...supervisor, isGlobalAdmin: true };
  const crossDepartment = { ...report, departmentId: 4 };
  assert.equal(reportNoteContext(global, crossDepartment, '').departmentId, '4');
  assert.equal(reportNoteContext(global, crossDepartment, '4').departmentId, '4');
  assert.equal(reportNoteContext(global, crossDepartment, '3'), null);
  assert.equal(reportNoteContext({ ...global, isGlobalAdmin: 'true' }, crossDepartment), null);
});

await check('literal text, timestamps, empty edits and backend length bound round-trip', async () => {
  const storage = memoryStorage();
  const store = createReportNoteDraftStore(storage);
  assert.deepEqual(await store.loadNoteDraft(context), absent);
  const text = '  Unfinished\n\tSupervisor note  \n';
  const first = await store.saveNoteDraft(context, { text, expectedRevision: 0 });
  assert.deepEqual(first, { ...absent, revision: 1, text, deleted: false, savedAt: first.savedAt });
  assert.equal(new Date(first.savedAt).toISOString(), first.savedAt);
  assert.deepEqual(await store.loadNoteDraft(context), first);
  first.text = 'Attempted external snapshot mutation';
  assert.equal((await store.loadNoteDraft(context)).text, text);
  const full = await store.saveNoteDraft(context, { text: 'x'.repeat(REPORT_NOTE_MAX_LENGTH), expectedRevision: 1 });
  assert.equal(full.text.length, 1000);
  await assert.rejects(store.saveNoteDraft(context, { text: `${full.text}x`, expectedRevision: 2 }), { code: 'REPORT_NOTE_LENGTH' });
  await assert.rejects(store.saveNoteDraft(context, { text: ['text'], expectedRevision: 2 }), { code: 'REPORT_NOTE_LENGTH' });
  assert.deepEqual(await store.loadNoteDraft(context), full);
  const empty = await store.saveNoteDraft(context, { text: '', expectedRevision: 2 });
  assert.equal(empty.deleted, false);
  assert.equal(empty.text, '');
  assert.equal(empty.revision, 3);
});

await check('keyed reads isolate Supervisor, home, capability, target Department and Report', async () => {
  const storage = memoryStorage();
  const store = createReportNoteDraftStore(storage);
  const contexts = [
    context,
    reportNoteContext({ ...supervisor, id: 18 }, report),
    reportNoteContext({ ...supervisor, isGlobalAdmin: true }, report),
    reportNoteContext({ ...supervisor, isGlobalAdmin: true, departmentId: 4 }, report),
    reportNoteContext({ ...supervisor, isGlobalAdmin: true }, { ...report, departmentId: 4 }),
    reportNoteContext(supervisor, { ...report, backendRecordId: 22 })
  ];
  for (const [index, current] of contexts.entries()) {
    assert.deepEqual(await store.loadNoteDraft(current), absent);
    await store.saveNoteDraft(current, { text: `Private note ${index}`, expectedRevision: 0 });
  }
  assert.equal(storage.rows.size, contexts.length);
  assert.ok([...storage.rows.keys()].every((key) => key.startsWith('report-resolution-note:v1:')));
  for (const [index, current] of contexts.entries()) {
    assert.equal((await store.loadNoteDraft(current)).text, `Private note ${index}`);
    assert.equal(storage.reads.at(-1), storage.writes[index]);
  }
  const forbidden = createReportNoteDraftStore({ readRow() { assert.fail('Invalid context read'); }, updateRow() { assert.fail('Invalid context write'); } });
  for (const invalid of [null, {}, [], { ...context, ownerId: 17 }, { ...context, extra: 'private' },
    { ...context, departmentId: '4' }, { ...context, globalAdmin: 'true' },
    { ...context, [Symbol('hidden')]: 'extra' }]) {
    await assert.rejects(forbidden.loadNoteDraft(invalid), { code: 'REPORT_NOTE_CONTEXT' });
    await assert.rejects(forbidden.saveNoteDraft(invalid, { text: 'private', expectedRevision: 0 }), { code: 'REPORT_NOTE_CONTEXT' });
    await assert.rejects(forbidden.clearNoteDraft(invalid, { expectedRevision: 0 }), { code: 'REPORT_NOTE_CONTEXT' });
  }
});

await check('concurrent writers and stale deletes use compare-and-swap', async () => {
  const storage = memoryStorage();
  const first = createReportNoteDraftStore(storage);
  const second = createReportNoteDraftStore(storage);
  const attempts = await Promise.allSettled([
    first.saveNoteDraft(context, { text: 'First tab', expectedRevision: 0 }),
    second.saveNoteDraft(context, { text: 'Second tab', expectedRevision: 0 })
  ]);
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.find((result) => result.status === 'rejected').reason.code, 'REPORT_NOTE_CONFLICT');
  const winner = attempts.find((result) => result.status === 'fulfilled').value;
  await assert.rejects(second.clearNoteDraft(context, { expectedRevision: 0 }), { code: 'REPORT_NOTE_CONFLICT' });
  assert.deepEqual(await first.loadNoteDraft(context), winner);
  for (const revision of [undefined, -1, '1', 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(first.saveNoteDraft(context, { text: 'Bad revision', expectedRevision: revision }), { code: 'REPORT_NOTE_REVISION' });
  }
});

await check('discard tombstones prevent resurrection while allowing explicit fresh edits', async () => {
  const store = createReportNoteDraftStore(memoryStorage());
  await store.saveNoteDraft(context, { text: 'Discard me', expectedRevision: 0 });
  const discarded = await store.clearNoteDraft(context, { expectedRevision: 1 });
  assert.deepEqual(discarded, { ...absent, revision: 2, savedAt: discarded.savedAt });
  for (const revision of [0, 1]) {
    await assert.rejects(store.saveNoteDraft(context, { text: 'Stale resurrection', expectedRevision: revision }), { code: 'REPORT_NOTE_CONFLICT' });
  }
  const current = await store.loadNoteDraft(context);
  const fresh = await store.saveNoteDraft(context, { text: 'New intentional edit', expectedRevision: current.revision });
  assert.equal(fresh.revision, 3);
  assert.equal(fresh.text, 'New intentional edit');
});

await check('finalized tombstones permanently block stale and newly-loaded editors', async () => {
  const storage = memoryStorage();
  const store = createReportNoteDraftStore(storage);
  await store.saveNoteDraft(context, { text: 'Resolved note', expectedRevision: 0 });
  const finalized = await store.clearNoteDraft(context, { expectedRevision: 1, finalized: true });
  assert.equal(finalized.finalized, true);
  assert.equal(finalized.deleted, true);
  assert.equal(finalized.text, '');
  for (const revision of [0, 1, finalized.revision]) {
    await assert.rejects(store.saveNoteDraft(context, { text: 'Cannot resurrect', expectedRevision: revision }), { code: 'REPORT_NOTE_FINALIZED' });
  }
  await assert.rejects(store.clearNoteDraft(context, { expectedRevision: finalized.revision }), { code: 'REPORT_NOTE_FINALIZED' });
  assert.deepEqual(await store.loadNoteDraft(context), finalized);
  assert.equal(storage.rows.values().next().value.text, '');
});

await check('malformed private rows fail closed without overwrite or silent loss', async () => {
  const storage = memoryStorage();
  const store = createReportNoteDraftStore(storage);
  await store.saveNoteDraft(context, { text: 'Keep original', expectedRevision: 0 });
  const key = storage.writes[0];
  const original = storage.rows.get(key);
  const malformedRows = [null, [], 'bad', { ...original, schemaVersion: 2 }, { ...original, key: `${key}:foreign` },
    { ...original, context: { ...context, ownerId: '18' } }, { ...original, context: { ...context, extra: true } },
    { ...original, extra: true }, { ...original, revision: 0 }, { ...original, revision: '1' },
    { ...original, text: null }, { ...original, text: 'x'.repeat(1001) }, { ...original, savedAt: '' },
    { ...original, savedAt: '2026-10-01' }, { ...original, savedAt: 'not-a-date' },
    { ...original, deleted: true }, { ...original, finalized: true }, { ...original, finalized: 'false' }];
  for (const malformed of malformedRows) {
    storage.rows.set(key, structuredClone(malformed));
    for (const operation of [() => store.loadNoteDraft(context),
      () => store.saveNoteDraft(context, { text: 'Overwrite', expectedRevision: 1 }),
      () => store.clearNoteDraft(context, { expectedRevision: 1 })]) {
      await assert.rejects(operation(), { code: 'REPORT_NOTE_MALFORMED' });
      assert.deepEqual(storage.rows.get(key), malformed);
    }
  }
  storage.rows.set(key, { ...original, revision: Number.MAX_SAFE_INTEGER });
  await assert.rejects(store.saveNoteDraft(context, { text: 'Overflow', expectedRevision: Number.MAX_SAFE_INTEGER }), { code: 'REPORT_NOTE_REVISION' });
});

await check('failed storage propagates and in-flight writes retain their captured exact scope', async () => {
  const quota = new Error('Synthetic quota failure');
  const failed = createReportNoteDraftStore({ readRow: async () => { throw quota; }, updateRow: async () => { throw quota; } });
  await assert.rejects(failed.loadNoteDraft(context), (error) => error === quota);
  await assert.rejects(failed.saveNoteDraft(context, { text: 'Unsaved', expectedRevision: 0 }), (error) => error === quota);
  await assert.rejects(failed.clearNoteDraft(context, { expectedRevision: 0 }), (error) => error === quota);
  let release;
  const delay = new Promise((resolve) => { release = resolve; });
  const storage = memoryStorage();
  const delayed = createReportNoteDraftStore({ ...storage, async updateRow(key, update) { await delay; return storage.updateRow(key, update); } });
  const mutable = { ...context };
  const pending = delayed.saveNoteDraft(mutable, { text: 'Original private scope', expectedRevision: 0 });
  mutable.ownerId = '18';
  mutable.departmentId = '4';
  release();
  await pending;
  assert.equal((await delayed.loadNoteDraft(context)).text, 'Original private scope');
  assert.deepEqual(await delayed.loadNoteDraft({ ...context, ownerId: '18' }), absent);
  assert.deepEqual(storage.rows.values().next().value.context, context);
});

await check('native IndexedDB persists across reload and serializes independent browser tabs', async () => {
  const browser = await chromium.launch({ headless: true });
  const origin = 'http://127.0.0.1:59983';
  const browserContext = await browser.newContext();
  try {
    await browserContext.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, origin, 'No live or external requests are allowed');
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Private Report note test</title>' });
      assert.ok(['/assets/js/db.js', '/assets/js/report-note-drafts.js'].includes(url.pathname));
      return route.fulfill({ contentType: 'text/javascript', body: await readFile(path.resolve(url.pathname.slice(1)), 'utf8') });
    });
    const first = await browserContext.newPage();
    const second = await browserContext.newPage();
    const prepare = async (page) => {
      await page.goto(origin);
      await page.evaluate(async () => { window.noteStore = await import('/assets/js/report-note-drafts.js'); });
    };
    await Promise.all([prepare(first), prepare(second)]);
    const save = (page, text, expectedRevision) => page.evaluate(async ({ context, text, expectedRevision }) => {
      try { return { value: await window.noteStore.saveNoteDraft(context, { text, expectedRevision }) }; }
      catch (error) { return { code: error.code }; }
    }, { context, text, expectedRevision });
    const attempts = await Promise.all([save(first, 'Native first tab', 0), save(second, 'Native second tab', 0)]);
    assert.equal(attempts.filter((result) => result.value).length, 1);
    assert.equal(attempts.find((result) => result.code).code, 'REPORT_NOTE_CONFLICT');
    const winner = attempts.find((result) => result.value).value;
    await prepare(first);
    assert.deepEqual(await first.evaluate((context) => window.noteStore.loadNoteDraft(context), context), winner);
    const tombstone = await first.evaluate((context) => window.noteStore.clearNoteDraft(context, { expectedRevision: 1, finalized: true }), context);
    assert.equal(tombstone.revision, 2);
    assert.equal(tombstone.finalized, true);
    assert.equal((await save(second, 'Stale native tab', 1)).code, 'REPORT_NOTE_FINALIZED');
    assert.equal((await save(second, 'Fresh but finalized native tab', 2)).code, 'REPORT_NOTE_FINALIZED');
    const stored = await first.evaluate(async () => {
      const { openDb } = await import('/assets/js/db.js');
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('drafts', 'readonly');
        const request = tx.objectStore('drafts').getAll();
        tx.oncomplete = () => { db.close(); resolve(request.result); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      });
    });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].text, '');
    assert.ok(stored[0].key.startsWith('report-resolution-note:v1:'));
    assert.deepEqual(stored[0].context, context);
  } finally {
    await browserContext.close();
    await browser.close();
  }
});

console.log(`Passed ${groups} Report note draft groups.`);
