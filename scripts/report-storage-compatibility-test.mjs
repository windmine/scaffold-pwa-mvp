import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

// Exact deployed code, not a simulation of its photo/draft behavior. All
// requests are intercepted and every context has disposable browser storage.
const deployedRef = '921be2d';
const origin = 'http://127.0.0.1:59987';
const isolatedName = 'scaffold-pwa-report-evidence-v1';
const oldSources = new Map();
const browser = await chromium.launch({ headless: true });

async function fixture() {
  const context = await browser.newContext();
  const makePage = async (legacy) => {
    const page = await context.newPage();
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, origin, 'No external requests are permitted');
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated mixed-version test</title>' });
      assert.match(url.pathname, /^\/assets\/js\/[a-z-]+\.js$/);
      const file = url.pathname.slice(1);
      if (legacy && !oldSources.has(file)) oldSources.set(file,
        execFileSync('git', ['show', `${deployedRef}:${file}`], { encoding: 'utf8', windowsHide: true }));
      return route.fulfill({ contentType: 'text/javascript', body: legacy ? oldSources.get(file)
        : await readFile(path.resolve(file), 'utf8') });
    });
    await page.goto(origin);
    await page.evaluate(async () => {
      const db = await import('/assets/js/db.js');
      const api = await import('/assets/js/api-client.js');
      const offline = await import('/assets/js/offline-submissions.js');
      const mock = await import('/assets/js/mock-api.js');
      const worker = { id: 7, role: 'worker', department_id: 2, name: 'Mixed version Worker' };
      api.saveSession(worker);
      let online = false;
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
      const requests = { uploads: [], posts: [], failUpload: null };
      window.fetch = async (url, options) => {
        if (url === '/api/photo-uploads') {
          const blob = options.body.get('file');
          const content = await blob.text();
          if (requests.failUpload === requests.uploads.length) {
            return Response.json({ detail: 'Synthetic unavailable upload' }, { status: 503 });
          }
          requests.uploads.push(content);
          return Response.json({ url: `/uploads/photo-${requests.uploads.length}.png` });
        }
        if (url === '/api/form-submissions') {
          const body = JSON.parse(options.body);
          requests.posts.push(body);
          return Response.json({ id: 701, worker_id: 7, status: 'pending', photo_urls: body.photo_urls, answers: body.answers });
        }
        throw new Error('Unexpected request');
      };
      const record = (id) => ({ id, type: 'form', submissionPurpose: 'report', formId: 21,
        formName: 'Compatibility Report', workDate: '2026-09-18', definitionVersion: 1,
        fields: [], answers: {}, photoDataUrls: [],
        photoBlobs: [new Blob(['first original'], { type: 'image/png' }), new Blob(['second original'], { type: 'image/png' })],
        photoMetadata: [{ name: 'first.png' }, { name: 'second.png' }] });
      const draft = (answer, blobs = true) => ({ kind: 'work-form', schemaVersion: 1,
        ownerWorkerId: 7, departmentId: 2, templatePurpose: 'report', formId: 21,
        formName: 'Compatibility Report', definitionVersion: 1, answers: { note: answer },
        photoDataUrls: [], ...(blobs ? { photoBlobs: [new Blob(['draft original'], { type: 'image/png' })] } : {}),
        savedAt: new Date().toISOString() });
      window.test = { db, api, offline, mock, worker, record, draft, requests,
        online(value = true) { online = value; } };
    });
    return page;
  };
  return { context, modern: await makePage(false), old: await makePage(true) };
}

try {
  {
    const f = await fixture();
    await f.modern.evaluate(async () => {
      const t = window.test;
      await t.mock.saveDraft('work-form-draft:7:21', t.draft('new photo draft'));
      await t.mock.saveDraft('work-form-draft:7:22', { ...t.draft('zero photos'), formId: 22, photoBlobs: [] });
      await t.offline.submitOfflineSubmission(t.record('new-blob-record'));
      await t.db.put('records', { ...t.record('retained-blob-failsafe'), submissionPurpose: 'daywork' });
      await t.mock.saveDraft('retained-blob-draft', { ...t.draft('retained failsafe'), templatePurpose: 'daywork' });
    });
    const oldResult = await f.old.evaluate(async () => {
      const t = window.test;
      t.online();
      const result = await t.offline.syncQueuedSubmissions({ purpose: 'report' });
      return { drafts: await t.mock.getDraftEntries(), records: await t.db.getAll('records'),
        result, uploads: t.requests.uploads.length, posts: t.requests.posts.length };
    });
    assert.equal(oldResult.result.flushed, 0);
    assert.deepEqual(oldResult.drafts, []);
    assert.deepEqual(oldResult.records, []);
    assert.equal(oldResult.uploads + oldResult.posts, 0);
    await f.modern.evaluate(async () => {
      const t = window.test;
      t.online();
      t.api.saveSession({ ...t.worker, id: 8 });
      const skipped = await t.offline.syncQueuedSubmissions({ purpose: 'report' });
      if (skipped.flushed || t.requests.posts.length) throw new Error('Foreign owner replayed');
      t.api.saveSession(t.worker);
      t.requests.failUpload = 1;
      const partial = await t.offline.syncQueuedSubmissions({ purpose: 'report' });
      if (partial.flushed || t.requests.uploads.length !== 1 || t.requests.posts.length) throw new Error('Partial replay failed');
    });
    await f.old.evaluate(async () => {
      const t = window.test;
      await t.offline.syncQueuedSubmissions({ purpose: 'report' });
      if (t.requests.posts.length) throw new Error('Old tab consumed partial Blob Report');
    });
    const completed = await f.modern.evaluate(async () => {
      const t = window.test;
      t.requests.failUpload = null;
      await t.offline.syncQueuedSubmissions({ purpose: 'report' });
      return { uploads: t.requests.uploads, posts: t.requests.posts, queue: await t.db.getAll('queue'),
        status: (await t.db.get('records', 'new-blob-record')).syncStatus };
    });
    assert.deepEqual(completed.uploads, ['first original', 'second original']);
    assert.equal(completed.posts.length, 1);
    assert.equal(completed.posts[0].photo_urls.length, 2);
    assert.deepEqual(completed.queue, []);
    assert.equal(completed.status, 'synced');
    await f.context.close();
    console.log('ok - deployed old tab cannot see new photo/zero-photo drafts or replay Blob Reports; new replay retains ownership and partial evidence');
  }

  {
    const f = await fixture();
    const key = 'work-form-draft:7:21';
    await f.old.evaluate(async (key) => {
      const t = window.test;
      await t.mock.saveDraft(key, { ...t.draft('legacy original', false), photoDataUrls: ['data:image/png;base64,bGVnYWN5'] });
    }, key);
    await f.modern.evaluate(async (key) => {
      const t = window.test;
      t.originalDraft = await t.mock.getDraft(key);
      if (t.originalDraft.answers.note !== 'legacy original') throw new Error('Legacy draft unreadable');
    }, key);
    await f.old.evaluate(async (key) => {
      const t = window.test;
      await t.mock.saveDraft(key, { ...t.draft('concurrent old editor', false), photoDataUrls: ['data:image/png;base64,b2xkLWVkaXRvcg=='] });
    }, key);
    await f.modern.evaluate(async (key) => {
      const t = window.test;
      const { restoreReportPhotoEvidence } = await import('/assets/js/report-photo-evidence.js');
      await t.mock.saveDraft(key, restoreReportPhotoEvidence(t.originalDraft));
      if ((await t.mock.getDraft(key)).answers.note !== 'legacy original') throw new Error('Isolated draft overwritten');
      await t.db.remove('drafts', key);
      const recovered = await t.mock.getDraft(key);
      if (recovered.answers.note !== 'concurrent old editor') throw new Error('Concurrent old draft lost');
      await t.mock.saveDraft(key, restoreReportPhotoEvidence(recovered));
    }, key);
    assert.equal(await f.old.evaluate((key) => window.test.mock.getDraft(key), key), null);
    await f.modern.evaluate(async (key) => {
      const t = window.test;
      const current = await t.mock.getDraft(key);
      if (await current.photoBlobs[0].text() !== 'old-editor') throw new Error('Migrated original changed');
      await t.db.remove('drafts', key);
      if (await t.mock.getDraft(key)) throw new Error('Submitted old copy resurrected');
    }, key);
    await f.context.close();
    console.log('ok - exact legacy draft migration preserves bytes and concurrent old edits, without stale draft resurrection');
  }

  for (const readMode of ['get', 'getAll']) {
    const f = await fixture();
    const key = 'work-form-draft:7:21';
    await f.modern.evaluate(async (key) => {
      const t = window.test;
      await t.mock.saveDraft(key, t.draft('first isolated'));
      await t.db.remove('drafts', key);
    }, key);
    await f.old.evaluate(async (key) => window.test.mock.saveDraft(key,
      window.test.draft('new legacy after delete', false)), key);
    await f.modern.evaluate(async ({ key, readMode }) => {
      const t = window.test;
      const entry = readMode === 'get' ? await t.db.get('drafts', key)
        : (await t.db.getAll('drafts')).find((entry) => entry.key === key);
      if (entry?.value.answers.note !== 'new legacy after delete') throw new Error('Later old draft not recoverable');
      await t.db.remove('drafts', key);
      if (await t.db.get('drafts', key)) throw new Error('Discard did not remove recovered old draft');
      if ((await t.db.getAll('drafts')).some((entry) => entry.key === key)) throw new Error('Discarded draft remained listed');
    }, { key, readMode });
    assert.equal(await f.old.evaluate((key) => window.test.mock.getDraft(key), key), null);
    await f.context.close();
    console.log(`ok - explicit discard after ${readMode} removes a later legacy draft behind an isolated tombstone`);
  }

  {
    const f = await fixture();
    const key = 'work-form-draft:7:21';
    await f.old.evaluate(async (key) => window.test.mock.saveDraft(key,
      window.test.draft('legacy cleanup retry', false)), key);
    await f.modern.evaluate(async (key) => {
      const t = window.test;
      const original = await t.mock.getDraft(key);
      const nativeDelete = IDBObjectStore.prototype.delete;
      IDBObjectStore.prototype.delete = function (...args) {
        if (this.transaction.db.name === 'scaffold-pwa-local' && this.name === 'drafts') {
          this.transaction.abort();
          return;
        }
        return nativeDelete.apply(this, args);
      };
      await t.mock.saveDraft(key, { ...original, photoBlobs: t.draft('fixture').photoBlobs });
      await t.db.remove('drafts', key);
      if (await t.mock.getDraft(key)) throw new Error('Failed legacy cleanup resurrected submitted draft');
      IDBObjectStore.prototype.delete = nativeDelete;
    }, key);
    assert.equal((await f.old.evaluate((key) => window.test.mock.getDraft(key), key)).answers.note, 'legacy cleanup retry');
    await f.context.close();
    console.log('ok - failed legacy cleanup retains old evidence but tombstone prevents stale-copy resurrection');
  }

  {
    const f = await fixture();
    await f.old.evaluate(async () => {
      const t = window.test;
      const record = t.record('legacy-base64-queue');
      delete record.photoBlobs;
      record.photoDataUrls = ['data:image/png;base64,bGVnYWN5LXF1ZXVl'];
      record.photoMetadata = [{ name: 'legacy.png' }];
      await t.offline.submitOfflineSubmission(record);
    });
    const result = await f.modern.evaluate(async () => {
      const t = window.test;
      t.online();
      const sync = await t.offline.syncQueuedSubmissions({ purpose: 'report' });
      return { sync, uploads: t.requests.uploads, posts: t.requests.posts, queue: await t.db.getAll('queue') };
    });
    assert.equal(result.sync.flushed, 1);
    assert.deepEqual(result.uploads, ['legacy-queue']);
    assert.equal(result.posts[0].photo_urls.length, 1);
    assert.deepEqual(result.queue, []);
    assert.equal(await f.old.evaluate(async () => (await window.test.db.get('records', 'legacy-base64-queue')).syncStatus), 'synced');
    await f.context.close();
    console.log('ok - existing deployed base64 queues remain readable and replay in their original database without duplicate migration');
  }

  {
    const f = await fixture();
    await f.modern.evaluate(async (isolatedName) => {
      const t = window.test;
      await t.mock.saveDraft('work-form-draft:7:21', t.draft('safe original'));
      const nativePut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.transaction.db.name === isolatedName) throw new DOMException('Synthetic full storage', 'QuotaExceededError');
        return nativePut.apply(this, args);
      };
      let failed = false;
      try { await t.mock.saveDraft('work-form-draft:7:21', t.draft('failed replacement')); } catch { failed = true; }
      if (!failed) throw new Error('Isolated write failure was hidden');
      failed = false;
      try { await t.offline.submitOfflineSubmission(t.record('failed-blob-record')); } catch { failed = true; }
      if (!failed) throw new Error('Failed Blob record must not appear durable');
      IDBObjectStore.prototype.put = nativePut;
      if ((await t.mock.getDraft('work-form-draft:7:21')).answers.note !== 'safe original') throw new Error('Prior draft lost');
      if (await t.db.get('records', 'failed-blob-record')) throw new Error('Failed record persisted');
    }, isolatedName);
    assert.deepEqual(await f.old.evaluate(async () => ({ records: await window.test.db.getAll('records'),
      drafts: await window.test.db.getAll('drafts'), queue: await window.test.db.getAll('queue') })),
    { records: [], drafts: [], queue: [] });
    await f.context.close();
    console.log('ok - isolated storage failure preserves existing draft and never falls back to old-client-visible Blob writes');
  }
} finally {
  await browser.close();
}
