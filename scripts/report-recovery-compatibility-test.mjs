import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

// Pin the immediately preceding live client, not the pre-Blob September 15
// client. Native IndexedDB is shared by two pages running their exact modules;
// only transport is replaced with a deterministic, owner-scoped server model.
const deployedRef = '3fc9708325d02fef5565ad684b69275c54543b41';
const origin = 'http://127.0.0.1:59989';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAIUlEQVR4AdzKMQ0AAAwCwQYlVY9NcAA7n/x2eFJpXGkDGAAA//9a73TYAAAABklEQVQDALR+E2kvnG+XAAAAAElFTkSuQmCC';
const sourceId = 'compatibility-original';
const clientId = 'compatibility-stable-key';
const retryId = 'compatibility-recovered-retry';
const draftKey = `work-form-recovery:7:2:${sourceId}`;
const ordinaryKey = 'work-form-draft:7:21';
const recoveryDbName = 'scaffold-pwa-report-recovery-v1';
const oldSources = new Map();
const failures = [];
let groups = 0;
const browser = await chromium.launch({ headless: true });

function durableReport(body, id = 701) {
  return { ...body, id, worker_id: 7, department_id: 2, submission_purpose: 'report',
    status: 'pending', workflow_status: 'submitted', fields: [
      { id: 'note', type: 'text' }, { id: 'signature', type: 'signature' }
    ] };
}

async function fixture() {
  const context = await browser.newContext();
  const server = { durable: new Map(), requests: [], creations: 0, uploads: 0, authenticatedWorker: 7 };
  const makePage = async (legacy) => {
    const page = await context.newPage();
    const source = legacy ? 'old' : 'current';
    await page.exposeFunction('compatibilityTransport', ({ url, method, headers, body, photo }) => {
      const parsed = new URL(url, origin);
      assert.equal(parsed.origin, origin, 'No external requests are permitted');
      const request = { source, path: parsed.pathname, method, headers, body, photo };
      server.requests.push(request);
      const result = (payload, status = 200) => ({ payload, status });
      const scopedWorker = headers['x-report-recovery-worker'];
      const scopedDepartment = headers['x-report-recovery-department'];
      if ((scopedWorker || scopedDepartment)
        && (scopedWorker !== String(server.authenticatedWorker) || scopedDepartment !== '2')) {
        return result({ detail: { code: 'report_recovery_identity_mismatch', message: 'Worker changed' } }, 409);
      }
      if (parsed.pathname === '/api/my-form-submissions/by-client-id' && method === 'GET') {
        assert.equal(parsed.searchParams.get('purpose'), 'report');
        const key = parsed.searchParams.get('client_submission_id');
        const submission = server.durable.get(`${server.authenticatedWorker}:${key}`);
        return result({ status: submission ? 'submitted' : 'not_found', client_submission_id: key,
          worker_id: server.authenticatedWorker, department_id: 2, submission: submission || null });
      }
      if (parsed.pathname === '/api/photo-uploads' && method === 'POST') {
        server.uploads += 1;
        return result({ url: `/uploads/compatibility-${server.uploads}.png` });
      }
      if (parsed.pathname === '/api/form-submissions' && method === 'POST') {
        const key = `${server.authenticatedWorker}:${body.client_submission_id}`;
        const previous = server.durable.get(key);
        if (previous) return result({ ...previous, idempotent_replay: true });
        server.creations += 1;
        const submission = { ...durableReport(body, 700 + server.creations), worker_id: server.authenticatedWorker };
        server.durable.set(key, submission);
        return result({ ...submission, idempotent_replay: false });
      }
      throw new Error(`Unexpected intercepted request: ${method} ${parsed.pathname}`);
    });
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, origin, 'No external requests are permitted');
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html',
        body: '<!doctype html><title>Isolated current-live Report recovery compatibility</title>' });
      assert.match(url.pathname, /^\/assets\/js\/[a-z-]+\.js$/);
      const file = url.pathname.slice(1);
      if (legacy && !oldSources.has(file)) oldSources.set(file,
        execFileSync('git', ['show', `${deployedRef}:${file}`], { encoding: 'utf8', windowsHide: true }));
      return route.fulfill({ contentType: 'text/javascript', body: legacy ? oldSources.get(file)
        : await readFile(path.resolve(file), 'utf8') });
    });
    await page.goto(origin);
    await page.evaluate(async ({ png, sourceId, clientId, retryId, draftKey, ordinaryKey }) => {
      const db = await import('/assets/js/db.js');
      const api = await import('/assets/js/api-client.js');
      const offline = await import('/assets/js/offline-submissions.js');
      const mock = await import('/assets/js/mock-api.js');
      api.saveSession({ id: 7, role: 'worker', department_id: 2, name: 'Compatibility Worker' });
      let online = false;
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
      const nativeFetch = window.fetch;
      window.fetch = async (url, options = {}) => {
        if (!String(url).startsWith('/api/')) return nativeFetch(url, options);
        const photo = options.body instanceof FormData ? options.body.get('file') : null;
        const result = await window.compatibilityTransport({ url: String(url), method: options.method || 'GET',
          headers: Object.fromEntries(new Headers(options.headers || {}).entries()),
          body: typeof options.body === 'string' ? JSON.parse(options.body) : null,
          photo: photo ? { bytes: [...new Uint8Array(await photo.arrayBuffer())], type: photo.type } : null });
        return Response.json(result.payload, { status: result.status });
      };
      const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0));
      const signature = `data:image/png;base64,${png}`;
      const record = (id = sourceId, note = 'Original failed answer') => ({ id, type: 'form',
        submissionPurpose: 'report', formId: 21, formName: 'Compatibility Report', departmentId: 2,
        workDate: '2026-10-05', definitionVersion: 1, fields: [
          { id: 'note', type: 'text' }, { id: 'signature', type: 'signature' }
        ], answers: { note, signature }, photoBlobs: [new Blob([bytes], { type: 'image/png' })],
        photoDataUrls: [], photoMetadata: [{ name: 'original.png' }], clientSubmissionId: clientId,
        syncStatus: 'queued', syncError: 'Definite failed upload', createdAt: '2026-10-05T00:00:00Z' });
      const draft = (note) => ({ kind: 'work-form', schemaVersion: 1, ownerWorkerId: 7,
        departmentId: 2, templatePurpose: 'report', formId: 21, formName: 'Compatibility Report',
        definitionVersion: 1, fields: record().fields, answers: { note, signature },
        workDate: '2026-10-05', photoBlobs: [new Blob([bytes], { type: 'image/png' })],
        photoDataUrls: [], photoMetadata: [{ name: 'draft.png' }], savedAt: new Date().toISOString() });
      const recover = async () => {
        online = true;
        return offline.recoverOfflineReportAsDraft(sourceId);
      };
      const queueRecovered = async (note = 'Recovered edits must remain visible') => {
        const saved = await mock.getDraft(draftKey);
        if (!saved?.uploadRecovery) throw new Error('Recovery did not produce its distinct draft');
        online = false;
        return offline.submitOfflineSubmission({ ...record(retryId, note),
          photoBlobs: saved.photoBlobs, photoMetadata: saved.photoMetadata,
          uploadRecovery: structuredClone(saved.uploadRecovery), clientSubmissionId: saved.uploadRecovery.clientSubmissionId },
        { draftKey });
      };
      window.test = { db, api, offline, mock, record, draft, recover, queueRecovered,
        sourceId, clientId, retryId, draftKey, ordinaryKey, online(value = true) { online = value; } };
    }, { png, sourceId, clientId, retryId, draftKey, ordinaryKey });
    return page;
  };
  try {
    return { context, server, current: await makePage(false), old: await makePage(true), openPage: makePage };
  } catch (error) { await context.close(); throw error; }
}

async function check(name, run) {
  const f = await fixture();
  try { await run(f); groups += 1; console.log(`ok - ${name}`); }
  catch (error) { failures.push({ name, message: error.message }); console.error(`not ok - ${name}: ${error.message}`); }
  finally { await f.context.close(); }
}

async function newRecovery(f) {
  await f.current.evaluate(async () => {
    const t = window.test;
    await t.mock.saveDraft(t.ordinaryKey, t.draft('Keep ordinary same-Template work'));
    await t.offline.submitOfflineSubmission(t.record());
    await t.recover();
  });
}

try {
  await check('exact September 29 clients cannot read recovery drafts by key or enumeration', async (f) => {
    await newRecovery(f);
    const actual = await f.old.evaluate(async () => {
      const t = window.test;
      return { direct: await t.db.get('drafts', t.draftKey),
        listed: (await t.db.getAll('drafts')).filter((entry) => entry.key === t.draftKey),
        mock: await t.mock.getDraft(t.draftKey) };
    });
    assert.equal(Boolean(actual.direct), false, 'An incompatible live tab must not directly read a recovered draft');
    assert.deepEqual(actual.listed, [], 'Recovered draft must not appear in old-client enumeration');
    assert.equal(actual.mock, null);
    const current = await f.current.evaluate(async () => ({
      recovery: (await window.test.mock.getDraft(window.test.draftKey)).answers.note,
      ordinary: (await window.test.mock.getDraft(window.test.ordinaryKey)).answers.note
    }));
    assert.deepEqual(current, { recovery: 'Original failed answer', ordinary: 'Keep ordinary same-Template work' });
  });

  await check('old live replay cannot consume a new recovered attempt or bypass its identity protocol', async (f) => {
    await newRecovery(f);
    await f.current.evaluate(() => window.test.queueRecovered());
    const before = f.server.requests.length;
    const old = await f.old.evaluate(async () => {
      const t = window.test;
      const visibleRecord = await t.db.get('records', t.retryId);
      const visibleQueue = await t.db.get('queue', t.retryId);
      // Isolate the new retry here; an older page's own original remains safe
      // through server idempotency and has its separate held-original race.
      await t.db.remove('queue', t.sourceId);
      t.online();
      return { visibleRecord, visibleQueue, result: await t.offline.syncQueuedSubmissions({ purpose: 'report' }) };
    });
    assert.equal(old.result.flushed, 0, 'The old client must not send recovered edits without the new recovery protocol');
    assert.equal(old.visibleRecord, undefined);
    assert.equal(old.visibleQueue, undefined);
    assert.deepEqual(f.server.requests.slice(before), [], 'Old replay must issue neither uploads nor a submission');
    const synced = await f.current.evaluate(async () => {
      const t = window.test;
      t.online();
      const result = await t.offline.syncQueuedSubmissions({ purpose: 'report' });
      return { result, record: await t.db.get('records', t.retryId), queue: await t.db.getAll('queue') };
    });
    assert.equal(synced.result.flushed, 1);
    assert.equal(synced.record.answers.note, 'Recovered edits must remain visible');
    assert.equal(f.server.creations, 1);
    assert.deepEqual(synced.queue, []);
    const writes = f.server.requests.filter((request) => request.method === 'POST');
    assert.ok(writes.some((request) => request.path === '/api/photo-uploads'));
    for (const write of writes) {
      assert.equal(write.source, 'current');
      assert.equal(write.headers['x-report-recovery-worker'], '7');
      assert.equal(write.headers['x-report-recovery-department'], '2');
    }
    assert.equal(writes.find((request) => request.path === '/api/form-submissions').body.client_submission_id, clientId);
  });

  await check('an original durable winner cannot make an old tab hide newer recovered edits', async (f) => {
    await newRecovery(f);
    await f.current.evaluate(() => window.test.queueRecovered());
    f.server.durable.set(`7:${clientId}`, durableReport({ form_id: 21, client_submission_id: clientId,
      answers: { note: 'Original already accepted' }, photo_urls: [], photo_metadata: [] }));
    const before = f.server.requests.length;
    const oldResult = await f.old.evaluate(async () => {
      await window.test.db.remove('queue', window.test.sourceId);
      window.test.online();
      return window.test.offline.syncQueuedSubmissions({ purpose: 'report' });
    });
    assert.equal(oldResult.flushed, 0, 'Old replay must not consume and mark recovered edits synced');
    assert.deepEqual(f.server.requests.slice(before), []);
    const saved = await f.current.evaluate(async () => {
      const t = window.test;
      t.online();
      await t.offline.syncQueuedSubmissions({ purpose: 'report' });
      return { records: await t.db.getAll('records'), queue: await t.db.getAll('queue') };
    });
    assert.ok(saved.records.some((record) => record.isDraftRecovery && record.syncBlockedReason === 'previously_submitted'
      && (record.capturedAnswers || record.answers).note === 'Recovered edits must remain visible'),
    'Recovered edits need an explicit visible saved copy, not hidden capturedAnswers on a synced record');
    assert.deepEqual(saved.queue, []);
    assert.equal(f.server.creations, 0);
    assert.equal(f.server.durable.get(`7:${clientId}`).answers.note, 'Original already accepted');
  });

  await check('current clients still read ordinary September 29 drafts and replay their queued originals', async (f) => {
    await f.old.evaluate(async () => {
      const t = window.test;
      await t.mock.saveDraft(t.ordinaryKey, t.draft('Ordinary old-client draft'));
      await t.offline.submitOfflineSubmission(t.record());
    });
    const actual = await f.current.evaluate(async () => {
      const t = window.test;
      const draft = await t.mock.getDraft(t.ordinaryKey);
      const original = await t.db.get('records', t.sourceId);
      t.online();
      const result = await t.offline.syncQueuedSubmissions({ purpose: 'report' });
      return { note: draft?.answers.note, bytes: [...new Uint8Array(await original.photoBlobs[0].arrayBuffer())],
        result, queue: await t.db.getAll('queue') };
    });
    assert.equal(actual.note, 'Ordinary old-client draft');
    assert.deepEqual(actual.bytes, [...Buffer.from(png, 'base64')]);
    assert.equal(actual.result.flushed, 1);
    assert.deepEqual(actual.queue, []);
    assert.equal(f.server.creations, 1);
    assert.equal(f.server.durable.get(`7:${clientId}`).answers.note, 'Original failed answer');
  });

  await check('an old already-read original may finish but new recovery keeps the same key and edited saved copy', async (f) => {
    await f.old.evaluate(async () => {
      const t = window.test;
      await t.offline.submitOfflineSubmission(t.record());
      t.alreadyReadOriginal = await t.db.get('records', t.sourceId);
    });
    await f.current.evaluate(() => window.test.recover());
    await f.current.evaluate(() => window.test.queueRecovered());
    await f.old.evaluate(async () => {
      const t = window.test;
      t.online();
      await t.offline.submitOfflineSubmission(t.alreadyReadOriginal);
    });
    const saved = await f.current.evaluate(async () => {
      const t = window.test;
      t.online();
      await t.offline.syncQueuedSubmissions({ purpose: 'report' });
      return { records: await t.db.getAll('records'), queue: await t.db.getAll('queue') };
    });
    assert.equal(f.server.creations, 1, 'Stable original key must permit only one durable Report');
    assert.equal(f.server.durable.get(`7:${clientId}`).answers.note, 'Original failed answer');
    assert.ok(saved.records.some((record) => record.isDraftRecovery && record.syncBlockedReason === 'previously_submitted'
      && (record.capturedAnswers || record.answers).note === 'Recovered edits must remain visible'));
    const retiredOriginal = saved.records.find((record) => record.id === sourceId);
    assert.equal(retiredOriginal.isDraftRecovery, true, 'Old completion cannot overwrite the current client\'s retired source');
    assert.equal(retiredOriginal.recoveredToDraft, draftKey);
    assert.deepEqual(saved.queue, []);
  });

  for (const store of ['drafts', 'records', 'queue']) {
    await check(`failed ${store} write rolls back all three recovery stores without changing old originals`, async (f) => {
      await f.old.evaluate(async () => {
        const t = window.test;
        await t.mock.saveDraft(t.ordinaryKey, t.draft('Old ordinary work must survive'));
        await t.offline.submitOfflineSubmission(t.record());
      });
      const oldBefore = await f.old.evaluate(async () => ({
        record: await window.test.db.get('records', window.test.sourceId),
        queue: await window.test.db.get('queue', window.test.sourceId),
        draft: await window.test.mock.getDraft(window.test.ordinaryKey)
      }));
      const actual = await f.current.evaluate(async ({ store, recoveryDbName }) => {
        const t = window.test;
        const nativePut = IDBObjectStore.prototype.put;
        let failures = 0, refused = false;
        IDBObjectStore.prototype.put = function (...args) {
          const value = args[0];
          if (this.transaction.db.name === recoveryDbName && this.name === store
            && ((store === 'drafts' && value.key === t.draftKey)
              || (store !== 'drafts' && value.id === t.sourceId))) {
            failures += 1;
            throw new DOMException('Injected recovery transaction quota failure', 'QuotaExceededError');
          }
          return nativePut.apply(this, args);
        };
        try { await t.recover(); } catch { refused = true; }
        finally { IDBObjectStore.prototype.put = nativePut; }
        const unchanged = { source: await t.db.get('records', t.sourceId),
          queue: await t.db.get('queue', t.sourceId), recovery: await t.mock.getDraft(t.draftKey),
          ordinary: await t.mock.getDraft(t.ordinaryKey) };
        if (!failures || !refused) throw new Error('Native recovery write boundary did not fail as requested');
        await t.recover();
        return { failures, refused, unchanged,
          recoveredDraftCount: (await t.db.getAll('drafts')).filter((entry) => entry.key === t.draftKey).length,
          retired: (await t.db.get('records', t.sourceId))?.isDraftRecovery,
          queued: (await t.db.getAll('queue')).some((entry) => entry.id === t.sourceId) };
      }, { store, recoveryDbName });
      assert.equal(actual.failures, 1, 'The new database native write boundary must actually be exercised');
      assert.equal(actual.refused, true, 'A failed atomic recovery must reject instead of publishing a partial draft');
      assert.deepEqual(actual.unchanged.source, oldBefore.record);
      assert.deepEqual(actual.unchanged.queue, oldBefore.queue);
      assert.deepEqual(actual.unchanged.ordinary, oldBefore.draft);
      assert.equal(actual.unchanged.recovery, null);
      assert.equal(actual.recoveredDraftCount, 1);
      assert.equal(actual.retired, true);
      assert.equal(actual.queued, false);
      const oldAfter = await f.old.evaluate(async () => ({
        record: await window.test.db.get('records', window.test.sourceId),
        queue: await window.test.db.get('queue', window.test.sourceId),
        draft: await window.test.mock.getDraft(window.test.ordinaryKey)
      }));
      assert.deepEqual(oldAfter, oldBefore, 'Atomic recovery must not rewrite data behind an incompatible open editor');
    });
  }

  await check('unavailable recovery database rejects reads, writes and removal without old-visible fallback', async (f) => {
    await f.old.evaluate(async () => {
      const t = window.test;
      await t.mock.saveDraft(t.ordinaryKey, t.draft('Old ordinary work'));
      await t.offline.submitOfflineSubmission(t.record());
    });
    const beforeRequests = f.server.requests.length;
    const actual = await f.current.evaluate(async (recoveryDbName) => {
      const t = window.test;
      const nativeOpen = IDBFactory.prototype.open;
      let failures = 0;
      IDBFactory.prototype.open = function (...args) {
        if (args[0] === recoveryDbName) {
          failures += 1;
          throw new DOMException('Injected unavailable recovery database', 'UnknownError');
        }
        return nativeOpen.apply(this, args);
      };
      const recovery = { sourceRecordId: t.sourceId, clientSubmissionId: t.clientId, ownerWorkerId: 7,
        departmentId: 2, formId: 21, recoveredAt: new Date().toISOString(), omittedPhotos: [] };
      const refused = [];
      try {
        for (const [name, action] of [
          ['read', () => t.db.get('drafts', t.draftKey)],
          ['list', () => t.db.getAll('queue')],
          ['draft', () => t.mock.saveDraft(t.draftKey, { ...t.draft('Unsafe fallback'), uploadRecovery: recovery })],
          ['record', () => t.offline.submitOfflineSubmission({ ...t.record(t.retryId), uploadRecovery: recovery })],
          ['remove', () => t.db.remove('drafts', t.draftKey)],
          ['recover', () => t.recover()]
        ]) {
          try { await action(); } catch { refused.push(name); }
        }
      } finally { IDBFactory.prototype.open = nativeOpen; }
      return { failures, refused, source: await t.db.get('records', t.sourceId),
        ordinary: (await t.mock.getDraft(t.ordinaryKey)).answers.note };
    }, recoveryDbName);
    assert.ok(actual.failures >= 6, 'Each operation must encounter the unavailable storage boundary');
    assert.deepEqual(actual.refused, ['read', 'list', 'draft', 'record', 'remove', 'recover']);
    assert.equal(actual.source.isDraftRecovery, undefined);
    assert.equal(actual.ordinary, 'Old ordinary work');
    assert.deepEqual(f.server.requests.slice(beforeRequests), [], 'Storage uncertainty must block before transport');
    const old = await f.old.evaluate(async () => ({
      retry: await window.test.db.get('records', window.test.retryId),
      queue: await window.test.db.get('queue', window.test.retryId),
      draft: await window.test.mock.getDraft(window.test.draftKey)
    }));
    assert.equal(old.retry, undefined);
    assert.equal(old.queue, undefined);
    assert.equal(old.draft, null);
  });

  await check('recovery deletions are absolute tombstones and later writes stay out of the old database', async (f) => {
    await newRecovery(f);
    await f.current.evaluate(async () => {
      const t = window.test;
      await t.queueRecovered();
      await t.db.remove('queue', t.retryId);
      await t.db.remove('records', t.retryId);
      await t.db.remove('drafts', t.draftKey);
    });
    // A stale old tab can still write its own namespace. Those copies must not
    // resurrect a deleted recovery item in a compatible client's merged view.
    await f.old.evaluate(async () => {
      const t = window.test;
      await t.mock.saveDraft(t.draftKey, t.draft('Stale old recovered draft'));
      await t.db.put('records', t.record(t.retryId, 'Stale old retry'));
      await t.db.put('queue', { id: t.retryId, kind: 'form', ownerWorkerId: 7 });
    });
    const removed = await f.current.evaluate(async () => {
      const t = window.test;
      return { directRecord: await t.db.get('records', t.retryId), directQueue: await t.db.get('queue', t.retryId),
        directDraft: await t.db.get('drafts', t.draftKey),
        records: (await t.db.getAll('records')).filter((entry) => entry.id === t.retryId),
        queue: (await t.db.getAll('queue')).filter((entry) => entry.id === t.retryId),
        drafts: (await t.db.getAll('drafts')).filter((entry) => entry.key === t.draftKey) };
    });
    assert.deepEqual(removed, { directRecord: undefined, directQueue: undefined, directDraft: undefined,
      records: [], queue: [], drafts: [] });
    await f.current.evaluate(async () => {
      const t = window.test;
      // Routing remains sticky even if later code omits uploadRecovery.
      await t.db.put('records', t.record(t.retryId, 'New compatible retry replacement'));
      await t.db.put('queue', { id: t.retryId, kind: 'form', ownerWorkerId: 7 });
      await t.mock.saveDraft(t.draftKey, t.draft('New compatible draft replacement'));
    });
    const old = await f.old.evaluate(async () => ({
      record: (await window.test.db.get('records', window.test.retryId)).answers.note,
      draft: (await window.test.mock.getDraft(window.test.draftKey)).answers.note
    }));
    assert.deepEqual(old, { record: 'Stale old retry', draft: 'Stale old recovered draft' });
    const current = await f.current.evaluate(async () => ({
      record: (await window.test.db.get('records', window.test.retryId)).answers.note,
      draft: (await window.test.mock.getDraft(window.test.draftKey)).answers.note
    }));
    assert.deepEqual(current, { record: 'New compatible retry replacement', draft: 'New compatible draft replacement' });
  });

  await check('cold reopened clients restore and replay only the compatible recovery namespace', async (f) => {
    await newRecovery(f);
    await f.current.close();
    const fresh = await f.openPage(false);
    const restored = await fresh.evaluate(async () => {
      const t = window.test;
      const draft = await t.mock.getDraft(t.draftKey);
      return { note: draft.answers.note, readonly: draft.recoveryStorageReadOnly,
        bytes: [...new Uint8Array(await draft.photoBlobs[0].arrayBuffer())],
        ordinary: (await t.mock.getDraft(t.ordinaryKey)).answers.note };
    });
    assert.equal(restored.note, 'Original failed answer');
    assert.equal(restored.readonly, undefined);
    assert.deepEqual(restored.bytes, [...Buffer.from(png, 'base64')]);
    assert.equal(restored.ordinary, 'Keep ordinary same-Template work');
    await fresh.evaluate(() => window.test.queueRecovered('Cold reopened recovered edits'));
    await fresh.close();
    const reopened = await f.openPage(false);
    const old = await f.openPage(true);
    assert.equal(await old.evaluate(async () => Boolean(await window.test.db.get('records', window.test.retryId))), false);
    const synced = await reopened.evaluate(async () => {
      const t = window.test;
      t.online();
      const result = await t.offline.syncQueuedSubmissions({ purpose: 'report' });
      return { result, record: await t.db.get('records', t.retryId), queue: await t.db.getAll('queue') };
    });
    assert.equal(synced.result.flushed, 1);
    assert.equal(synced.record.answers.note, 'Cold reopened recovered edits');
    assert.equal(f.server.creations, 1);
    assert.deepEqual(synced.queue, []);
    for (const request of f.server.requests.filter((request) => request.method === 'POST')) {
      assert.equal(request.headers['x-report-recovery-worker'], '7');
      assert.equal(request.headers['x-report-recovery-department'], '2');
    }
  });

  await check('unreleased recovery copies in the old namespace stay read-only without writes or replay', async (f) => {
    await f.old.evaluate(async () => {
      const t = window.test;
      const recovery = { sourceRecordId: t.sourceId, clientSubmissionId: t.clientId, ownerWorkerId: 7,
        departmentId: 2, formId: 21, recoveredAt: new Date().toISOString(), omittedPhotos: [] };
      await t.mock.saveDraft(t.draftKey, { ...t.draft('Old unsafe recovery draft'), uploadRecovery: recovery });
      await t.offline.submitOfflineSubmission({ ...t.record(t.retryId, 'Old unsafe recovered retry'), uploadRecovery: recovery });
    });
    const snapshotOld = () => f.old.evaluate(async () => {
      const t = window.test;
      const serialize = async (entry) => !entry ? entry : { ...entry,
        photoBlobs: await Promise.all((entry.photoBlobs || []).map(async (blob) => ({
          type: blob.type, bytes: [...new Uint8Array(await blob.arrayBuffer())]
        }))) };
      return { draft: await serialize(await t.mock.getDraft(t.draftKey)),
        record: await serialize(await t.db.get('records', t.retryId)), queue: await t.db.get('queue', t.retryId) };
    });
    const before = await snapshotOld();
    const current = await f.current.evaluate(async () => {
      const t = window.test;
      const nativePut = IDBObjectStore.prototype.put, nativeDelete = IDBObjectStore.prototype.delete;
      let writes = 0;
      const evidenceWrite = (store) => { if (['records', 'queue', 'drafts'].includes(store.name)) writes += 1; };
      IDBObjectStore.prototype.put = function (...args) { evidenceWrite(this); return nativePut.apply(this, args); };
      IDBObjectStore.prototype.delete = function (...args) { evidenceWrite(this); return nativeDelete.apply(this, args); };
      try {
        const record = await t.db.get('records', t.retryId), draft = await t.mock.getDraft(t.draftKey);
        const draftEntries = await t.db.getAll('drafts');
        const { summarizeReportDrafts } = await import('/assets/js/report-drafts.js');
        const summaries = summarizeReportDrafts(draftEntries, t.api.getSession(), [{ id: 21, department_id: 2,
          template_purpose: 'report', status: 'active', definition_version: 1 }]);
        t.online();
        const result = await t.offline.syncQueuedSubmissions({ purpose: 'report' });
        const refused = [];
        try { await t.db.put('records', record); } catch { refused.push('record'); }
        try { await t.mock.saveDraft(t.draftKey, draft); } catch { refused.push('draft'); }
        return { record, draft, result, refused, writes, summaries, queue: await t.db.get('queue', t.retryId) };
      } finally { IDBObjectStore.prototype.put = nativePut; IDBObjectStore.prototype.delete = nativeDelete; }
    });
    assert.equal(current.record.recoveryStorageReadOnly, true);
    assert.equal(current.record.isDraftRecovery, true);
    assert.equal(current.record.answers.note, 'Old unsafe recovered retry');
    assert.equal(current.draft.recoveryStorageReadOnly, true);
    assert.equal(current.draft.answers.note, 'Old unsafe recovery draft');
    assert.equal(current.summaries[0].availability, 'storage_incompatible');
    assert.equal(current.result.flushed, 0);
    assert.equal(current.result.skipped, 1);
    assert.deepEqual(current.refused, ['record', 'draft']);
    assert.equal(current.writes, 0, 'Reading/quarantining unsafe copies must not mutate any stored evidence');
    assert.deepEqual(current.queue, before.queue, 'Unsafe queue is preserved, not silently discarded or upgraded');
    assert.deepEqual(f.server.requests, []);
    assert.deepEqual(await snapshotOld(), before);
  });

  await check('discarding an unsafe old recovery copy hides it without changing the old native record or queue', async (f) => {
    await f.old.evaluate(async () => {
      const t = window.test;
      const recovery = { sourceRecordId: t.sourceId, clientSubmissionId: t.clientId, ownerWorkerId: 7,
        departmentId: 2, formId: 21, recoveredAt: new Date().toISOString(), omittedPhotos: [] };
      await t.mock.saveDraft(t.draftKey, { ...t.draft('Retain original unsafe draft'), uploadRecovery: recovery });
      await t.offline.submitOfflineSubmission({ ...t.record(t.retryId, 'Retain original unsafe record'), uploadRecovery: recovery });
    });
    const snapshotOld = () => f.old.evaluate(async () => ({
      draft: await window.test.mock.getDraft(window.test.draftKey),
      record: await window.test.db.get('records', window.test.retryId),
      queue: await window.test.db.get('queue', window.test.retryId)
    }));
    const before = await snapshotOld();
    await f.current.evaluate(async () => {
      const t = window.test;
      await t.offline.discardOfflineSubmission(t.retryId);
      await t.db.remove('drafts', t.draftKey);
    });
    assert.deepEqual(await snapshotOld(), before,
      'Explicit Discard must only hide unsafe pre-release copies for compatible clients, preserving raw old-tab evidence');
    const current = await f.current.evaluate(async () => ({
      draft: await window.test.db.get('drafts', window.test.draftKey),
      record: await window.test.db.get('records', window.test.retryId),
      queue: await window.test.db.get('queue', window.test.retryId),
      listedRecords: (await window.test.db.getAll('records')).length,
      listedQueue: (await window.test.db.getAll('queue')).length,
      listedDrafts: (await window.test.db.getAll('drafts')).length
    }));
    assert.deepEqual(current, { draft: undefined, record: undefined, queue: undefined,
      listedRecords: 0, listedQueue: 0, listedDrafts: 0 });
    assert.deepEqual(f.server.requests, []);
  });

  await check('removing a read-only flag from an old recovery copy cannot silently upgrade its storage', async (f) => {
    await f.old.evaluate(async () => {
      const t = window.test;
      const recovery = { sourceRecordId: t.sourceId, clientSubmissionId: t.clientId, ownerWorkerId: 7,
        departmentId: 2, formId: 21, recoveredAt: new Date().toISOString(), omittedPhotos: [] };
      await t.mock.saveDraft(t.draftKey, { ...t.draft('Unsafe draft remains read-only'), uploadRecovery: recovery });
      await t.offline.submitOfflineSubmission({ ...t.record(t.retryId, 'Unsafe record remains read-only'), uploadRecovery: recovery });
    });
    const result = await f.current.evaluate(async () => {
      const t = window.test;
      const record = await t.db.get('records', t.retryId), draft = await t.mock.getDraft(t.draftKey);
      delete record.recoveryStorageReadOnly;
      delete draft.recoveryStorageReadOnly;
      const refused = [];
      try { await t.db.put('records', record); } catch { refused.push('record'); }
      try { await t.mock.saveDraft(t.draftKey, draft); } catch { refused.push('draft'); }
      try { await t.db.put('queue', { id: t.retryId, kind: 'form', ownerWorkerId: 7 }); } catch { refused.push('queue'); }
      return { refused, record: await t.db.get('records', t.retryId), draft: await t.mock.getDraft(t.draftKey) };
    });
    assert.deepEqual(result.refused, ['record', 'draft', 'queue']);
    assert.equal(result.record.recoveryStorageReadOnly, true);
    assert.equal(result.draft.recoveryStorageReadOnly, true);
    assert.deepEqual(f.server.requests, []);
  });

  await check('even malformed recovery markers route new records and drafts away from incompatible clients', async (f) => {
    await f.current.evaluate(async () => {
      const t = window.test;
      const values = [null, false, '', { sourceRecordId: 42 }];
      for (const [index, value] of values.entries()) {
        const id = `malformed-recovery-${index}`;
        await t.db.put('records', { ...t.record(id), uploadRecovery: value });
        await t.db.put('queue', { id, kind: 'form', ownerWorkerId: 7 });
        await t.mock.saveDraft(`work-form-recovery:7:2:${id}`, { ...t.draft(`Malformed ${index}`), uploadRecovery: value });
      }
      await t.db.put('records', { ...t.record('marker-only-source'), recoveredToDraft: null });
      await t.mock.saveDraft('work-form-recovery:7:2:prefix-only', t.draft('Prefix-only protected copy'));
    });
    const old = await f.old.evaluate(async () => ({ records: await window.test.db.getAll('records'),
      queue: await window.test.db.getAll('queue'), drafts: await window.test.db.getAll('drafts') }));
    assert.deepEqual(old, { records: [], queue: [], drafts: [] });
    const current = await f.current.evaluate(async () => ({ records: (await window.test.db.getAll('records')).length,
      queue: (await window.test.db.getAll('queue')).length, drafts: (await window.test.db.getAll('drafts')).length }));
    assert.deepEqual(current, { records: 5, queue: 4, drafts: 5 });
    assert.deepEqual(f.server.requests, []);
  });
} finally { await browser.close(); }

if (failures.length) {
  console.error(JSON.stringify({ status: 'failed', deployedRef, passed: groups, failures }, null, 2));
  process.exitCode = 1;
} else console.log(`${groups} exact-live Report recovery compatibility groups passed.`);
