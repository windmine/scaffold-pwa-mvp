import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

// Pin the immediately preceding live client, not the pre-Blob September 15
// client. Native IndexedDB is shared by two pages running their exact modules;
// only transport is replaced with a deterministic, owner-scoped server model.
const deployedRef = 'bd7f8b46eed7e6fc372231031cb35a81901c104a';
const origin = 'http://127.0.0.1:59990';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAIUlEQVR4AdzKMQ0AAAwCwQYlVY9NcAA7n/x2eFJpXGkDGAAA//9a73TYAAAABklEQVQDALR+E2kvnG+XAAAAAElFTkSuQmCC';
const sourceId = 'compatibility-original';
const clientId = 'compatibility-stable-key';
const retryId = 'compatibility-recovered-retry';
const draftKey = `work-form-recovery:7:2:${sourceId}`;
const ordinaryKey = 'work-form-draft:7:21';
const recoveryDbName = 'scaffold-pwa-report-recipients-v1';
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
          pdfEmailRecipients: saved.pdfEmailRecipients, pdfEmailRecipientUsers: saved.pdfEmailRecipientUsers, expectedPdfEmailVersion: saved.expectedPdfEmailVersion,
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

try {
  for (const recipients of [[], ['approved@example.invalid']]) {
    await check(`exact prior HEAD cannot read or replay recipient-aware ${JSON.stringify(recipients)} drafts or queues`, async (f) => {
      await f.current.evaluate(async (recipients) => {
        const t = window.test;
        const choices = { pdfEmailRecipients: recipients, pdfEmailRecipientUsers: recipients.map((email) => ({ user_id: 37, email })), expectedPdfEmailVersion: 3 };
        await t.mock.saveDraft(t.ordinaryKey, { ...t.draft('Private new selection'), ...choices });
        await t.offline.submitOfflineSubmission({ ...t.record(), ...choices, photoBlobs: [], answers: { note: 'New zero-photo Report' } });
      }, recipients);
      const old = await f.old.evaluate(async () => {
        const t = window.test;
        t.online();
        await t.offline.syncQueuedSubmissions({ purpose: 'report' });
        return { draft: await t.mock.getDraft(t.ordinaryKey), record: await t.db.get('records', t.sourceId),
          queue: await t.db.getAll('queue'), drafts: await t.db.getAll('drafts'), records: await t.db.getAll('records') };
      });
      assert.equal(old.draft, null); assert.equal(old.record, undefined);
      assert.deepEqual(old.queue, []); assert.deepEqual(old.drafts, []); assert.deepEqual(old.records, []);
      assert.equal(f.server.requests.filter((request) => request.source === 'old').length, 0);
      await f.current.evaluate(async () => { window.test.online(); await window.test.offline.syncQueuedSubmissions({ purpose: 'report' }); });
      const post = f.server.requests.find((request) => request.path === '/api/form-submissions');
      assert.deepEqual(post.body.pdf_email_recipients, recipients);
      assert.deepEqual(post.body.pdf_email_recipient_users, recipients.map((email) => ({ user_id: 37, email })));
      assert.equal(post.body.expected_pdf_email_version, 3);
    });
  }

  for (const recipients of [[], ['approved@example.invalid']]) {
    await check(`recipient-aware recovered drafts and retries stay hidden from prior HEAD ${JSON.stringify(recipients)}`, async (f) => {
      await f.current.evaluate(async (recipients) => {
        const t = window.test;
        await t.offline.submitOfflineSubmission({ ...t.record(), pdfEmailRecipients: recipients, pdfEmailRecipientUsers: recipients.map((email) => ({ user_id: 37, email })), expectedPdfEmailVersion: 3 });
        await t.recover();
        const saved = await t.mock.getDraft(t.draftKey);
        if (JSON.stringify(saved.pdfEmailRecipients) !== JSON.stringify(recipients)) throw new Error('Recovery lost recipients');
        await t.queueRecovered();
      }, recipients);
      const old = await f.old.evaluate(async () => {
        const t = window.test; t.online(); await t.offline.syncQueuedSubmissions({ purpose: 'report' });
        return { draft: await t.mock.getDraft(t.draftKey), records: await t.db.getAll('records'), queue: await t.db.getAll('queue') };
      });
      assert.equal(old.draft, null); assert.deepEqual(old.records, []); assert.deepEqual(old.queue, []);
      assert.equal(f.server.requests.filter((request) => request.source === 'old').length, 0);
      await f.current.evaluate(async () => { window.test.online(); await window.test.offline.syncQueuedSubmissions({ purpose: 'report' }); });
      const post = f.server.requests.find((request) => request.path === '/api/form-submissions');
      assert.deepEqual(post.body.pdf_email_recipients, recipients);
      assert.deepEqual(post.body.pdf_email_recipient_users, recipients.map((email) => ({ user_id: 37, email })));
      assert.equal(post.body.expected_pdf_email_version, 3);
    });
  }

  await check('prior draft bytes remain intact; unchanged old copy stays retired while later old edits remain recoverable', async (f) => {
    await f.old.evaluate(() => window.test.mock.saveDraft(window.test.ordinaryKey, window.test.draft('Prior draft')));
    const before = await f.old.evaluate(() => window.test.mock.getDraft(window.test.ordinaryKey));
    await f.current.evaluate(async () => {
      const t = window.test;
      const old = await t.mock.getDraft(t.ordinaryKey);
      await t.mock.saveDraft(t.ordinaryKey, { ...old, pdfEmailRecipients: [], expectedPdfEmailVersion: 3, answers: { note: 'New private draft' } });
    });
    assert.deepEqual(await f.old.evaluate(() => window.test.mock.getDraft(window.test.ordinaryKey)), before);
    await f.current.evaluate(() => window.test.db.remove('drafts', window.test.ordinaryKey));
    assert.equal(await f.current.evaluate(() => window.test.mock.getDraft(window.test.ordinaryKey)), null);
    await f.old.evaluate(() => window.test.mock.saveDraft(window.test.ordinaryKey, window.test.draft('Later legacy edit')));
    assert.equal(await f.current.evaluate(async () => (await window.test.mock.getDraft(window.test.ordinaryKey)).answers.note), 'Later legacy edit');
    await f.current.evaluate(() => window.test.db.remove('drafts', window.test.ordinaryKey));
    assert.equal(await f.current.evaluate(() => window.test.mock.getDraft(window.test.ordinaryKey)), null);
    assert.equal(await f.old.evaluate(async () => (await window.test.mock.getDraft(window.test.ordinaryKey)).answers.note), 'Later legacy edit');
  });

  await check('newly recovered legacy-source draft is hidden before recipient choices exist and old original winning preserves later choices', async (f) => {
    await f.old.evaluate(async () => {
      const t = window.test;
      await t.offline.submitOfflineSubmission(t.record());
      t.original = await t.db.get('records', t.sourceId);
    });
    await f.current.evaluate(() => window.test.recover());
    assert.equal(await f.old.evaluate(() => window.test.mock.getDraft(window.test.draftKey)), null);
    await f.current.evaluate(async () => {
      const t = window.test, draft = await t.mock.getDraft(t.draftKey);
      await t.mock.saveDraft(t.draftKey, { ...draft, pdfEmailRecipients: ['approved@example.invalid'], expectedPdfEmailVersion: 3 });
      await t.queueRecovered();
    });
    await f.old.evaluate(async () => { const t = window.test; t.online(); await t.offline.submitOfflineSubmission(t.original); });
    const saved = await f.current.evaluate(async () => {
      const t = window.test; t.online(); await t.offline.syncQueuedSubmissions({ purpose: 'report' });
      return { records: await t.db.getAll('records'), queue: await t.db.getAll('queue') };
    });
    assert.equal(f.server.creations, 1);
    const kept = saved.records.find((record) => record.syncBlockedReason === 'previously_submitted' && record.id === `${retryId}-submitted-recovery`);
    assert.ok(kept); assert.deepEqual(kept.pdfEmailRecipients, ['approved@example.invalid']);
    assert.equal(kept.expectedPdfEmailVersion, 3); assert.deepEqual(saved.queue, []);
  });

  await check('null original baseline survives autosave after an old tab creates a same-key draft', async (f) => {
    await f.current.evaluate(() => window.test.mock.saveDraft(window.test.ordinaryKey, { ...window.test.draft('New private'), pdfEmailRecipients: [] }));
    await f.old.evaluate(() => window.test.mock.saveDraft(window.test.ordinaryKey, window.test.draft('Later old tab')));
    await f.current.evaluate(async () => {
      const t = window.test;
      await t.mock.saveDraft(t.ordinaryKey, { ...t.draft('Autosaved new private'), pdfEmailRecipients: [] });
      await t.db.remove('drafts', t.ordinaryKey);
    });
    assert.equal(await f.current.evaluate(async () => (await window.test.mock.getDraft(window.test.ordinaryKey)).answers.note), 'Later old tab');
  });

  await check('first upgrade preserves a concurrent old-tab change seen after the original read', async (f) => {
    await f.old.evaluate(() => window.test.mock.saveDraft(window.test.ordinaryKey, window.test.draft('Original A')));
    await f.current.evaluate(async () => { window.test.original = await window.test.mock.getDraft(window.test.ordinaryKey); });
    await f.old.evaluate(() => window.test.mock.saveDraft(window.test.ordinaryKey, window.test.draft('Concurrent B')));
    await f.current.evaluate(async () => {
      const t = window.test;
      await t.db.getAll('drafts'); // A background list must not erase the editor's observed baseline.
      await t.mock.saveDraft(t.ordinaryKey, { ...t.original, pdfEmailRecipients: [] });
      await t.db.remove('drafts', t.ordinaryKey);
    });
    assert.equal(await f.current.evaluate(async () => (await window.test.mock.getDraft(window.test.ordinaryKey)).answers.note), 'Concurrent B');
  });

  await check('same-size photo-only legacy edits with unchanged metadata survive recipient tombstones', async (f) => {
    await f.old.evaluate(() => window.test.mock.saveDraft(window.test.ordinaryKey, window.test.draft('Same answers')));
    await f.current.evaluate(async () => {
      const t = window.test;
      await t.mock.saveDraft(t.ordinaryKey, { ...await t.mock.getDraft(t.ordinaryKey), pdfEmailRecipients: [] });
    });
    await f.old.evaluate(async () => {
      const t = window.test, entry = await t.db.get('drafts', t.ordinaryKey);
      const bytes = new Uint8Array(await entry.value.photoBlobs[0].arrayBuffer()); bytes[bytes.length - 1] ^= 1;
      entry.value.photoBlobs[0] = new Blob([bytes], { type: 'image/png' });
      await t.db.put('drafts', entry); // Deliberately preserve every timestamp and metadata field.
    });
    await f.current.evaluate(() => window.test.db.remove('drafts', window.test.ordinaryKey));
    assert.ok(await f.current.evaluate(() => window.test.mock.getDraft(window.test.ordinaryKey)));
  });

  await check('original-database recovery slot collision is preserved instead of shadowed', async (f) => {
    const actual = await f.current.evaluate(async () => {
      const t = window.test;
      await t.offline.submitOfflineSubmission({ ...t.record(), pdfEmailRecipients: [], expectedPdfEmailVersion: 3 });
      const db = await t.db.openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('drafts', 'readwrite');
        tx.objectStore('drafts').put({ key: t.draftKey, value: { ...t.draft('Original collision'), uploadRecovery: {} } });
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      }); db.close();
      let rejected = false; try { await t.recover(); } catch { rejected = true; }
      return { rejected, source: await t.db.get('records', t.sourceId), draft: await t.mock.getDraft(t.draftKey) };
    });
    assert.equal(actual.rejected, true); assert.equal(actual.source.isDraftRecovery, undefined);
    assert.equal(actual.draft.answers.note, 'Original collision'); assert.equal(actual.draft.recoveryStorageReadOnly, true);
  });

  await check('new client replays legacy queue without inventing explicit recipient intent', async (f) => {
    await f.old.evaluate(() => window.test.offline.submitOfflineSubmission(window.test.record()));
    await f.current.evaluate(async () => { window.test.online(); await window.test.offline.syncQueuedSubmissions({ purpose: 'report' }); });
    const post = f.server.requests.find((request) => request.path === '/api/form-submissions');
    assert.equal(Object.hasOwn(post.body, 'pdf_email_recipients'), false);
    assert.equal(Object.hasOwn(post.body, 'expected_pdf_email_version'), false);
    assert.equal(f.server.creations, 1);
  });

  for (const store of ['drafts', 'records', 'queue']) {
    await check(`recipient recovery ${store} failure rolls back atomically without old-store fallback`, async (f) => {
      await f.current.evaluate(() => window.test.offline.submitOfflineSubmission({ ...window.test.record(), pdfEmailRecipients: [], expectedPdfEmailVersion: 3 }));
      const actual = await f.current.evaluate(async ({ store, recoveryDbName }) => {
        const t = window.test;
        const before = await t.db.get('records', t.sourceId);
        const nativePut = IDBObjectStore.prototype.put;
        let failures = 0, refused = false;
        IDBObjectStore.prototype.put = function (...args) {
          if (this.transaction.db.name === recoveryDbName && this.name === store) {
            failures += 1; throw new DOMException('Synthetic recipient storage failure', 'QuotaExceededError');
          }
          return nativePut.apply(this, args);
        };
        try { await t.recover(); } catch { refused = true; }
        finally { IDBObjectStore.prototype.put = nativePut; }
        const after = await t.db.get('records', t.sourceId);
        const draft = await t.mock.getDraft(t.draftKey);
        const queue = await t.db.get('queue', t.sourceId);
        await t.recover();
        return { before, after, draft, queue, failures, refused };
      }, { store, recoveryDbName });
      assert.equal(actual.failures, 1); assert.equal(actual.refused, true);
      assert.deepEqual(actual.after, actual.before); assert.equal(actual.draft, null); assert.ok(actual.queue);
      assert.deepEqual(await f.old.evaluate(() => window.test.db.getAll('records')), []);
    });
  }

  await check('unavailable recipient database fails closed before fallback or replay', async (f) => {
    const actual = await f.current.evaluate(async (name) => {
      const t = window.test, nativeOpen = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (...args) {
        if (args[0] === name) throw new DOMException('Synthetic unavailable recipient database', 'UnknownError');
        return nativeOpen.apply(this, args);
      };
      const rejected = [];
      try {
        for (const [label, operation] of [
          ['draft', () => t.mock.saveDraft(t.ordinaryKey, { ...t.draft('Unsafe fallback'), pdfEmailRecipients: [] })],
          ['record', () => t.offline.submitOfflineSubmission({ ...t.record(), pdfEmailRecipients: [] })],
          ['read', () => t.db.get('drafts', t.ordinaryKey)],
          ['list', () => t.db.getAll('queue')],
          ['remove', () => t.db.remove('drafts', t.ordinaryKey)]
        ]) { try { await operation(); } catch { rejected.push(label); } }
      } finally { IDBFactory.prototype.open = nativeOpen; }
      return rejected;
    }, recoveryDbName);
    assert.deepEqual(actual, ['draft', 'record', 'read', 'list', 'remove']);
    assert.equal(f.server.requests.length, 0);
    assert.deepEqual(await f.old.evaluate(() => window.test.db.getAll('records')), []);
    assert.equal(await f.old.evaluate(() => window.test.mock.getDraft(window.test.ordinaryKey)), null);
  });
} finally { await browser.close(); }
if (failures.length) throw new Error(JSON.stringify(failures));
console.log(`${groups} recipient storage compatibility groups passed against exact prior HEAD ${deployedRef}.`);
