import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59987'; // Intercepted modules/transport only; no API access.
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await context.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, origin, 'External requests are forbidden');
  if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Offline discard locks</title>' });
  assert.match(url.pathname, /^\/assets\/js\/[a-z\d-]+\.js$/);
  const body = url.pathname === '/assets/js/db.js' ? `
    const f = window.lockFixture;
    export async function get(store, id) {
      const value = structuredClone(f.stores[store].get(id));
      await f.hook('get', store, id);
      return value;
    }
    export async function getAll(store) {
      const values = structuredClone([...f.stores[store].values()]);
      await f.hook('getAll', store);
      return values;
    }
    export async function put(store, value) {
      await f.hook('put', store, value.id ?? value.key);
      f.stores[store].set(value.id ?? value.key, structuredClone(value));
    }
    export async function remove(store, id) {
      await f.hook('remove', store, id);
      f.stores[store].delete(id);
    }
  ` : await readFile(path.join(root, url.pathname), 'utf8');
  return route.fulfill({ contentType: 'text/javascript', body });
});
const page = await context.newPage();

async function prepare() {
  await page.goto(origin);
  await page.evaluate(async () => {
    const f = window.lockFixture = {
      stores: { records: new Map(), queue: new Map(), settings: new Map(), drafts: new Map() },
      hook: async () => {}, posts: [],
      seed(id, extra = {}) {
        const record = {
          id, type: 'form', submissionPurpose: 'report', formId: 21, formName: 'Lock test',
          ownerWorkerId: 7, userId: 7, capturedAt: '2026-09-25T00:00:00Z',
          createdAt: '2026-09-25T00:00:00Z', syncStatus: 'queued', answers: {}, fields: [],
          photoUrls: [], ...extra
        };
        this.stores.records.set(id, record);
        this.stores.queue.set(id, { id });
        return record;
      },
      hold(operation, store, id) {
        let signalStarted;
        let release;
        const started = new Promise((resolve) => { signalStarted = resolve; });
        const blocked = new Promise((resolve) => { release = resolve; });
        let used = false;
        this.hook = async (actualOperation, actualStore, actualId) => {
          if (!used && actualOperation === operation && actualStore === store && actualId === id) {
            used = true;
            signalStarted();
            await blocked;
          }
        };
        return { started, release };
      }
    };
    f.api = await import('/assets/js/api-client.js');
    f.offline = await import('/assets/js/offline-submissions.js');
    f.api.saveSession({ id: 7, role: 'worker', department_id: 2 });
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    window.fetch = async (url, options) => {
      if (url !== '/api/form-submissions') throw new Error(`Unexpected request: ${url}`);
      const payload = JSON.parse(options.body);
      f.posts.push(payload);
      return Response.json({ id: 700 + f.posts.length, worker_id: 7, answers: payload.answers });
    };
  });
}

try {
  // Reserve before the first read: otherwise replay may read this queued item
  // while discard is awaiting storage, then recreate it after deletion.
  for (const operation of ['read', 'delete']) {
    await prepare();
    const result = await page.evaluate(async (operation) => {
      const f = window.lockFixture;
      f.seed('discard-first');
      f.seed('unrelated');
      const gate = operation === 'read'
        ? f.hold('get', 'records', 'discard-first')
        : f.hold('remove', 'queue', 'discard-first');
      const discard = f.offline.discardOfflineSubmission('discard-first');
      await gate.started;
      const replay = await f.offline.syncQueuedSubmissions({ purpose: 'report' });
      gate.release();
      await discard;
      return {
        skipped: replay.skipped, flushed: replay.flushed,
        posts: f.posts.map((item) => item.client_submission_id),
        discardedRecord: f.stores.records.has('discard-first'),
        discardedQueue: f.stores.queue.has('discard-first')
      };
    }, operation);
    assert.deepEqual(result, {
      skipped: 1, flushed: 1, posts: ['unrelated'], discardedRecord: false, discardedQueue: false
    }, `Discard owns its record throughout the pending ${operation}`);
  }
  console.log('ok - discard owns pending reads/deletes while unrelated queued Reports still sync');

  await prepare();
  const replayFirst = await page.evaluate(async () => {
    const f = window.lockFixture;
    f.seed('replay-first');
    const gate = f.hold('get', 'records', 'replay-first');
    const replay = f.offline.syncQueuedSubmissions({ purpose: 'report' });
    await gate.started;
    let error = '';
    try { await f.offline.discardOfflineSubmission('replay-first'); }
    catch (caught) { error = caught.message; }
    gate.release();
    const result = await replay;
    return { error, flushed: result.flushed, posts: f.posts.length, status: f.stores.records.get('replay-first')?.syncStatus };
  });
  assert.match(replayFirst.error, /still syncing/);
  assert.equal(replayFirst.flushed, 1);
  assert.equal(replayFirst.posts, 1);
  assert.equal(replayFirst.status, 'synced');
  console.log('ok - a sweep reserves ownership before reading and rejects concurrent discard');

  await prepare();
  const staleQueue = await page.evaluate(async () => {
    const f = window.lockFixture;
    f.seed('stale-queue-snapshot');
    const gate = f.hold('getAll', 'queue');
    const replay = f.offline.syncQueuedSubmissions({ purpose: 'report' });
    await gate.started;
    await f.offline.discardOfflineSubmission('stale-queue-snapshot');
    gate.release();
    const result = await replay;
    return { flushed: result.flushed, posts: f.posts.length, records: f.stores.records.size, queue: f.stores.queue.size };
  });
  assert.deepEqual(staleQueue, { flushed: 0, posts: 0, records: 0, queue: 0 });
  console.log('ok - an old queue snapshot rechecks storage after completed discard and cannot revive it');

  await prepare();
  const releaseAfterFailure = await page.evaluate(async () => {
    const f = window.lockFixture;
    const errors = [];
    for (const scenario of ['missing', 'other-worker', 'fresh-lease', 'delete-failed']) {
      if (scenario !== 'missing') f.seed(scenario, scenario === 'other-worker'
        ? { ownerWorkerId: 8, userId: 8 }
        : scenario === 'fresh-lease' ? { syncStatus: 'syncing', syncStartedAt: new Date().toISOString() } : {});
      f.hook = async (operation, store, id) => {
        if (scenario === 'delete-failed' && operation === 'remove' && store === 'queue' && id === scenario) {
          throw new Error('Injected storage failure');
        }
      };
      try { await f.offline.discardOfflineSubmission(scenario); }
      catch (error) { errors.push(error.message); }
      f.hook = async () => {};
      f.seed(scenario, scenario === 'fresh-lease'
        ? { syncStatus: 'syncing', syncStartedAt: '2026-01-01T00:00:00Z' } : {});
      await f.offline.discardOfflineSubmission(scenario);
    }
    return { errors, records: f.stores.records.size, queue: f.stores.queue.size };
  });
  assert.equal(releaseAfterFailure.errors.length, 4);
  assert.match(releaseAfterFailure.errors[0], /not found/);
  assert.match(releaseAfterFailure.errors[1], /belongs to/);
  assert.match(releaseAfterFailure.errors[2], /still syncing/);
  assert.match(releaseAfterFailure.errors[3], /Injected storage failure/);
  assert.equal(releaseAfterFailure.records, 0);
  assert.equal(releaseAfterFailure.queue, 0);
  console.log('ok - missing/foreign/leased/storage-error discard exits release the lock without changing lease rules');
} finally {
  await context.close();
  await browser.close();
}
