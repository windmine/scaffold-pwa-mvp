import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const browser = await chromium.launch();
const context = await browser.newContext();
const origin = 'http://127.0.0.1:59987';
await context.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, origin);
  if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<title>Offline checkpoint test</title>' });
  assert.match(url.pathname, /^\/assets\/js\/[a-z-]+\.js$/);
  let body = await readFile(new URL('..' + url.pathname, import.meta.url), 'utf8');
  if (url.pathname === '/assets/js/db.js') {
    // Hold both tabs after discovering storage and before the native IDB
    // transaction. Only a unique insert can resolve the remaining race.
    const writeBoundary = 'const includeQueue = discard || marker !== undefined;';
    assert.ok(body.includes(writeBoundary));
    body = body.replace(writeBoundary, `${writeBoundary}
      if (id === 'two-tabs' && addOnly) await window.checkpointRendezvous();`);
  }
  return route.fulfill({ contentType: 'text/javascript', body });
});

async function openPage() {
  const page = await context.newPage();
  await page.goto(origin);
  await page.evaluate(async () => {
    const db = await import('/assets/js/db.js');
    const offline = await import('/assets/js/offline-submissions.js');
    const { saveSession } = await import('/assets/js/api-client.js');
    const user = { id: 7, role: 'worker', department_id: 2, name: 'Checkpoint test' };
    saveSession(user);
    const posts = [], uploads = [];
    window.fetch = async (url, options) => {
      if (url === '/api/photo-uploads') {
        uploads.push(await options.body.get('file').text());
        return Response.json({ url: '/uploads/local-image.png' });
      }
      if (url !== '/api/form-submissions') throw new Error('Unexpected request: ' + url);
      const payload = JSON.parse(options.body);
      posts.push(payload);
      return Response.json({ id: 90 + posts.length, answers: payload.answers });
    };
    function record(id, extra = {}) {
      return { id, clientSubmissionId: id, type: 'form', submissionPurpose: 'report',
        formId: 9, definitionVersion: 1, ownerWorkerId: 7, userId: 7, departmentId: 2,
        fields: [], answers: { note: id }, workDate: '2026-11-18',
        capturedAt: '2026-11-18T00:00:00Z', createdAt: '2026-11-18T00:00:00Z',
        syncStatus: 'queued', pdfEmailRecipients: [], ...extra };
    }
    window.fixture = { db, offline, user, saveSession, record, posts, uploads };
  });
  return page;
}

try {
  let page = await openPage();
  const rollback = await page.evaluate(async () => {
    const { db, record } = window.fixture;
    const id = 'atomic';
    const pending = record(id);
    const marker = { id, kind: 'form' };
    const original = IDBObjectStore.prototype.put;
    let fail = true;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (fail && this.name === 'queue') throw new DOMException('Simulated full storage', 'QuotaExceededError');
      return original.call(this, value, ...args);
    };
    try {
      async function checkAbort(operation) {
        try { await operation(); } catch (error) { return error.name; }
        throw new Error('Expected checkpoint failure');
      }
      await checkAbort(() => db.saveSubmissionCheckpoint(pending, marker));
      const empty = !await db.get('records', id) && !await db.get('queue', id);
      fail = false;
      await db.saveSubmissionCheckpoint(pending, marker, { addOnly: true });
      fail = true;
      await checkAbort(() => db.saveSubmissionCheckpoint({ ...pending, syncStatus: 'synced', backendRecordId: 88 }, null));
      await checkAbort(() => db.saveSubmissionCheckpoint(pending, null, { discard: true }));
      const originalQueue = (await db.get('records', id))?.syncStatus === 'queued' && (await db.get('queue', id))?.id === id;
      fail = false;
      const duplicate = await checkAbort(() => db.saveSubmissionCheckpoint({ ...pending, answers: {} }, marker, { addOnly: true }));
      const unchanged = (await db.get('records', id))?.answers?.note === id;
      await db.saveSubmissionCheckpoint(pending, null, { discard: true });
      return { empty, originalQueue, duplicate, unchanged };
    } finally { IDBObjectStore.prototype.put = original; }
  });
  assert.deepEqual(rollback, { empty: true, originalQueue: true, duplicate: 'ConstraintError', unchanged: true });
  console.log('ok - failed initial save, completion and discard each roll back both stores; a duplicate preserves the first checkpoint');

  const otherTab = await openPage();
  let arrivals = 0, release;
  const rendezvous = new Promise((resolve) => { release = resolve; });
  await context.exposeBinding('checkpointRendezvous', () => {
    if (++arrivals === 2) release();
    return rendezvous;
  });
  const attempts = await Promise.all([page, otherTab].map((tab, index) => tab.evaluate(async (index) => {
    const { db, record } = window.fixture;
    const id = 'two-tabs';
    const draft = record(id, { sourceDraftRevisionId: 'same-revision', answers: { tab: index } });
    if (index === 0) delete draft.pdfEmailRecipients;
    try {
      await db.saveSubmissionCheckpoint(draft, { id, tab: index }, { addOnly: true });
      return 'winner';
    } catch (error) { return error.name; }
  }, index)));
  assert.deepEqual([...attempts].sort(), ['ConstraintError', 'winner']);
  const winner = await page.evaluate(async () => {
    const { db } = window.fixture;
    const row = await db.get('records', 'two-tabs');
    const marker = await db.get('queue', 'two-tabs');
    await db.saveSubmissionCheckpoint(row, null, { discard: true });
    return [row.answers.tab, marker.tab];
  });
  assert.deepEqual(winner, [attempts.indexOf('winner'), attempts.indexOf('winner')]);
  await otherTab.close();
  console.log('ok - simultaneous confirmations on two tabs commit one matching record and queue marker');

  await page.evaluate(async () => {
    const { db, record } = window.fixture;
    // Recreate a device left by the release that wrote only its first store.
    await db.put('records', record('orphan', { photoBlobs: [new Blob(['original photo'], { type: 'image/png' })] }));
    await db.put('records', record('other-worker', { ownerWorkerId: 8, userId: 8 }));
    await db.put('records', record('other-department', { departmentId: 3 }));
    await db.put('records', record('complete', { syncStatus: 'synced', backendRecordId: 99 }));
    await db.put('records', record('recovered', { isDraftRecovery: true }));
    await db.put('records', record('explicitly-removed'));
    await db.remove('queue', 'explicitly-removed');
    await db.put('records', record('fresh-lease', { syncStatus: 'syncing', syncStartedAt: new Date().toISOString() }));
  });
  await page.close();
  page = await openPage();
  const repaired = await page.evaluate(async () => {
    const { db, offline, posts, uploads } = window.fixture;
    const first = await offline.syncQueuedSubmissions({ purpose: 'report' });
    const second = await offline.syncQueuedSubmissions({ purpose: 'report', recheckMissingMarkers: true });
    return { flushed: [first.flushed, second.flushed], posts: posts.map((item) => item.client_submission_id),
      files: uploads, markerIds: (await db.getAll('queue')).map((row) => row.id),
      storedId: (await db.get('records', 'orphan'))?.backendRecordId,
      futureRetry: first.retryAfterMs > 0 && first.retryAfterMs <= 120000 };
  });
  assert.deepEqual(repaired, { flushed: [1, 0], posts: ['orphan'], files: ['original photo'], markerIds: ['fresh-lease'],
    storedId: 91, futureRetry: true });
  console.log('ok - reopening recovers the original Report and photo once, preserves scope and tombstones and schedules a lease recheck');

  const afterLease = await page.evaluate(async () => {
    const { db, offline, record, posts } = window.fixture;
    const id = 'fresh-lease';
    await db.put('records', { ...await db.get('records', id), syncStartedAt: new Date(Date.now() - 120001).toISOString() });
    await db.put('records', record('later-orphan'));
    const result = await offline.syncQueuedSubmissions({ purpose: 'report', recheckMissingMarkers: true });
    return { flushed: result.flushed, queue: await db.getAll('queue'), posted: posts.map((item) => item.client_submission_id).sort() };
  });
  assert.deepEqual(afterLease, { flushed: 2, queue: [], posted: ['fresh-lease', 'later-orphan', 'orphan'] });
  console.log('ok - expired leases and old-client orphans created after startup are reconciled on retry');

  const olderStores = await page.evaluate(async () => {
    const { db, record } = window.fixture;
    const names = ['scaffold-pwa-local', 'scaffold-pwa-report-evidence-v1',
      'scaffold-pwa-report-recovery-v1', 'scaffold-pwa-report-recipients-v1'];
    const stores = await Promise.all(names.map((name) => new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    })));
    function raw(index, storeName, operation) {
      return new Promise((resolve, reject) => {
        const tx = stores[index].transaction(storeName, 'readwrite');
        const request = operation(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(tx.error);
      });
    }
    try {
      for (const [i] of names.entries()) {
        const id = 'archived-layout-' + i;
        const value = record(id);
        if (i < 3) delete value.pdfEmailRecipients;
        if (i === 2) value.uploadRecovery = { clientSubmissionId: id };
        await raw(i, 'records', (store) => store.put(i === 0 ? value : { id, value, reportStorageVersion: 1 }));
      }
      // A later compatible app already retired the older record. A fresh
      // device opening both stores must never add a replay marker for it.
      await raw(0, 'records', (store) => store.put(record('shadowed')));
      await raw(3, 'records', (store) => store.put({ id: 'shadowed', deleted: true, reportStorageVersion: 1 }));
      await db.repairMissingSubmissionMarkers((row) => row.id.startsWith('archived-layout-') || row.id === 'shadowed'
        ? { id: row.id, ownerWorkerId: 7 } : null);
      return await Promise.all(names.map(async (_, i) => {
        const keys = await raw(i, 'queue', (store) => store.getAllKeys());
        const key = 'archived-layout-' + i;
        const stored = await raw(i, 'queue', (store) => store.get(key));
        return keys.filter((item) => item.startsWith('archived-layout-')).join() === key
          && !keys.includes('shadowed') && (i === 0 ? stored : stored?.value)?.ownerWorkerId === 7;
      }));
    } finally { stores.forEach((store) => store.close()); }
  });
  assert.deepEqual(olderStores, [true, true, true, true]);
  console.log('ok - repairs remain in each original storage namespace, respecting newer tombstones and earlier clients');
} finally { await browser.close(); }
