import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59964'; // Entire real app/transport is intercepted; no server or cloud writes.
const output = path.join(root, 'output', 'report-upload-recovery.local');
const sourceId = 'failed-report-upload-recovery';
const clientId = 'failed-report-original-idempotency-key';
const worker = { id: 73, department_id: 2, department_name: 'Mutual', role: 'worker',
  worker_class: 'normal', name: 'Recovery Worker', email: 'recovery@example.invalid', status: 'active' };
const template = { id: 81, department_id: 2, name: 'Upload recovery inspection', status: 'active',
  template_purpose: 'report', definition_version: 1, fields: [
    { id: 'notes', label: 'Notes', type: 'textarea', required: true },
    { id: 'checked', label: 'Area checked', type: 'checkbox' },
    { id: 'signature', label: 'Worker signature', type: 'signature', required: true },
    { id: 'crew', label: 'Witnesses', type: 'repeat', min_rows: 0, max_rows: 5 },
    { id: 'witness_name', label: 'Witness name', type: 'text', repeat: 'crew' },
    { id: 'witness_signature', label: 'Witness signature', type: 'signature', repeat: 'crew' }
  ] };
const recoveryKey = `work-form-recovery:${worker.id}:${worker.department_id}:${sourceId}`;
const ordinaryKey = `work-form-draft:${worker.id}:${template.id}`;
// Browser-encoded 8x8 PNG, verified by the same native raster decoder used by recovery.
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAIUlEQVR4AdzKMQ0AAAwCwQYlVY9NcAA7n/x2eFJpXGkDGAAA//9a73TYAAAABklEQVQDALR+E2kvnG+XAAAAAElFTkSuQmCC';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function installBoundaries() {
  window.fixtureOnline = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => window.fixtureOnline });
  window.recoveryStorageFailure = '';
  window.recoveryStorageFaults = [];
  window.holdRecoveryDraftRead = false;
  window.recoveryDraftReadReached = false;
  const nativeGet = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function (key) {
    const request = nativeGet.call(this, key);
    if (window.holdRecoveryDraftRead && this.name === 'drafts' && String(key).startsWith('work-form-recovery:')
      && this.transaction.mode === 'readonly' && this.transaction.db.name === 'scaffold-pwa-report-recovery-v1') {
      window.recoveryDraftReadReached = true;
      const keepAlive = () => {
        const tick = nativeGet.call(this, key);
        tick.onsuccess = () => { if (window.holdRecoveryDraftRead) keepAlive(); };
      };
      keepAlive();
    }
    return request;
  };
  const nativePut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, ...args) {
    const id = String(value?.id || value?.key || '');
    const isRecoveryDraft = this.name === 'drafts' && id.startsWith('work-form-recovery:');
    const isOrdinaryDraft = this.name === 'drafts' && id === 'work-form-draft:73:81';
    const isRetiredRecord = this.name === 'records' && value?.value?.recoveredToDraft;
    const isRetiredQueue = this.name === 'queue' && id === 'failed-report-upload-recovery' && value?.deleted;
    const shouldFail = (window.recoveryStorageFailure === 'draft' && isRecoveryDraft)
      || (window.recoveryStorageFailure === 'ordinary-draft' && isOrdinaryDraft)
      || (window.recoveryStorageFailure === 'record' && isRetiredRecord)
      || (window.recoveryStorageFailure === 'queue' && isRetiredQueue);
    if (shouldFail) {
      window.recoveryStorageFaults.push({ store: this.name, id });
      throw new DOMException('Injected recovery transaction failure', 'QuotaExceededError');
    }
    return nativePut.call(this, value, ...args);
  };
}

async function fixture(browser, { existingDraft = false, legacyPhotos = false, extra = {} } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  context.setDefaultTimeout(10000);
  await context.addInitScript(installBoundaries);
  const traffic = { lookups: [], uploads: [], uploadHeaders: [], posts: [], postHeaders: [], history: 0 };
  const errors = [], unexpected = [], durable = [];
  let currentWorker = structuredClone(worker), signedIn = true;
  let lookupStatus = 200, lookupBody = { status: 'not_found', client_submission_id: clientId, submission: null,
    worker_id: worker.id, department_id: worker.department_id };
  let lookupGate = null, uploadGate = null, postGate = null;
  let uploadFailure = 422, lostPostResponse = false, idempotentReplay = false;
  let historyFailure = 0;
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { unexpected.push(url.href); return route.abort(); }
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated Report upload recovery</title>' });
    if (['/api/auth/refresh', '/api/auth/me'].includes(url.pathname)) return signedIn ? json(currentWorker) : json({ detail: 'Signed out' }, 401);
    if (url.pathname === '/api/auth/login') { signedIn = true; return json({ user: currentWorker }); }
    if (url.pathname === '/api/auth/logout') { signedIn = false; return json({ message: 'Signed out' }); }
    if (url.pathname === '/api/departments') return json([{ id: 2, name: 'Mutual' }]);
    if (url.pathname === '/api/sites') return json([{ id: 9, department_id: 2, name: 'Harbour Site', status: 'active', latitude: 0, longitude: 0, radius_meters: 100 }]);
    if (url.pathname === '/api/work-forms') {
      assert.equal(url.searchParams.get('purpose'), 'report');
      return json([template]);
    }
    if (url.pathname === '/api/my-form-submissions/by-client-id') {
      assert.equal(request.method(), 'GET');
      assert.equal(url.searchParams.get('purpose'), 'report');
      traffic.lookups.push(url.searchParams.get('client_submission_id'));
      if (lookupGate) await lookupGate.promise;
      return json(lookupBody, lookupStatus);
    }
    if (url.pathname === '/api/my-form-submissions') {
      assert.equal(url.searchParams.get('purpose'), 'report');
      traffic.history += 1;
      if (historyFailure) return json({ detail: 'Durable history temporarily unavailable' }, historyFailure);
      return json(durable.filter((item) => item.worker_id === currentWorker.id));
    }
    if (url.pathname === '/api/photo-uploads') {
      assert.equal(request.method(), 'POST');
      traffic.uploads.push(request.postDataBuffer());
      traffic.uploadHeaders.push(request.headers());
      if (uploadGate) await uploadGate.promise;
      if (uploadFailure) return json({ detail: 'This image could not be decoded. Replace the damaged photo.' }, uploadFailure);
      return json({ url: `/uploads/recovery-${traffic.uploads.length}.png` });
    }
    if (url.pathname === '/api/form-submissions') {
      assert.equal(request.method(), 'POST');
      const body = request.postDataJSON();
      traffic.posts.push(body);
      traffic.postHeaders.push(request.headers());
      if (postGate) await postGate.promise;
      const report = durable.find((item) => item.client_submission_id === body.client_submission_id)
        || { ...body, id: 901, department_id: 2, worker_id: worker.id, worker_name: worker.name,
          form_name: template.name, fields: template.fields, submission_purpose: 'report',
          status: 'pending', workflow_status: 'submitted', created_at: '2026-10-01T01:00:00Z' };
      if (!durable.includes(report)) durable.push(report);
      if (lostPostResponse) return route.abort('failed');
      return json({ ...report, ...(idempotentReplay ? { idempotent_replay: true } : {}) });
    }
    if (url.pathname.startsWith('/uploads/')) return route.fulfill({ contentType: 'image/png', body: Buffer.from(png.split(',')[1], 'base64') });
    if (url.pathname.startsWith('/api/')) { unexpected.push(`${request.method()} ${url.pathname}`); return json({ detail: 'Unexpected fixture request' }, 500); }
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    const filename = path.resolve(root, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    assert.ok(filename.startsWith(`${root}${path.sep}`), 'Only local repository assets are served');
    let body = await readFile(filename);
    const extension = path.extname(filename);
    if (extension === '.js') body = body.toString()
      .replaceAll("import L from 'leaflet';", "import * as L from '/node_modules/leaflet/dist/leaflet-src.esm.js';")
      .replace(/^import 'leaflet\/dist\/leaflet\.css';?\r?\n/gm, '');
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
      '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
    return route.fulfill({ contentType: types[extension] || 'application/octet-stream', body });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => { if (dialog.type() !== 'beforeunload') errors.push(`Unexpected ${dialog.type()} dialog`); void dialog.accept(); });
  await page.goto(`${origin}/fixture`);
  await page.evaluate(async ({ worker, template, png, sourceId, clientId, ordinaryKey, existingDraft, legacyPhotos, extra }) => {
    const api = await import('/assets/js/api-client.js');
    const db = await import('/assets/js/db.js');
    api.saveSession(worker);
    const bytes = Uint8Array.from(atob(png.split(',')[1]), (character) => character.charCodeAt(0));
    const good = new Blob([bytes], { type: 'image/png' });
    const broken = new Blob(['not an image'], { type: 'image/png' });
    const answers = { notes: 'Original answers must survive the failed upload.', checked: true, signature: png,
      crew: [{ witness_name: 'First witness', witness_signature: png }, { witness_name: 'Second witness', witness_signature: png }] };
    const record = { id: sourceId, clientSubmissionId: clientId, type: 'form', submissionPurpose: 'report',
      ownerWorkerId: worker.id, userId: worker.id, userName: worker.name, departmentId: worker.department_id,
      formId: template.id, formName: template.name, definitionVersion: template.definition_version, fields: template.fields,
      workDate: '2026-09-30', siteId: 9, siteName: 'Harbour Site', answers: { ...answers, signature: '/uploads/checkpoint-signature.png' },
      capturedAnswers: answers, photoBlobs: legacyPhotos ? [] : [good, broken, good, good],
      photoDataUrls: legacyPhotos ? [png, 'data:image/png;base64,bm90IGFuIGltYWdl', png, png] : [],
      photoUrls: ['/uploads/checkpoint-photo.png'], photoMetadata: ['First.png', 'Damaged.png', 'Third.png', 'Fourth.png'].map((name, index) => ({
        name, type: 'image/png', last_modified: 1790755200000 + index, last_modified_iso: `2026-09-30T00:00:0${index}.000Z`
      })), capturedAt: '2026-09-30T01:00:00Z', createdAt: '2026-09-30T01:00:00Z',
      syncStatus: 'queued', syncError: 'This image could not be decoded.', status: 'pending', ...extra };
    await db.put('records', record);
    await db.put('queue', { id: sourceId });
    if (existingDraft) await db.put('drafts', { key: ordinaryKey, value: {
      kind: 'work-form', schemaVersion: 1, ownerWorkerId: worker.id, departmentId: worker.department_id,
      templatePurpose: 'report', formId: template.id, formName: template.name, definitionVersion: 1,
      fields: template.fields, answers: { notes: 'Separate ordinary draft stays untouched', checked: false, signature: png },
      workDate: '2026-10-01', siteId: '', photoBlobs: [good], photoMetadata: [{ name: 'Ordinary.png' }],
      savedAt: '2026-10-01T02:00:00Z'
    }, updatedAt: '2026-10-01T02:00:00Z' });
  }, { worker, template, png, sourceId, clientId, ordinaryKey, existingDraft, legacyPhotos, extra });
  return { context, page, traffic, errors, unexpected, durable,
    lookup(body, status = 200) { lookupBody = { worker_id: worker.id, department_id: worker.department_id, ...body }; lookupStatus = status; },
    setWorker(value) { currentWorker = structuredClone(value); },
    expireSession() { signedIn = false; },
    failHistory(status = 503) { historyFailure = status; },
    allowUploads() { uploadFailure = 0; },
    failUploads(status = 422) { uploadFailure = status; },
    losePostResponse(value = true) { lostPostResponse = value; },
    replayPost(value = true) { idempotentReplay = value; },
    holdLookup() { lookupGate = deferred(); return lookupGate; },
    holdUpload() { uploadGate = deferred(); return uploadGate; },
    holdPost() { postGate = deferred(); return postGate; },
    async close() {
      lookupGate?.resolve(); uploadGate?.resolve(); postGate?.resolve();
      await context.close();
      assert.deepEqual(errors, [], 'No unhandled app errors');
      assert.deepEqual(unexpected, [], 'No unexpected or external requests');
    }
  };
}

async function snapshot(page) {
  return page.evaluate(async ({ sourceId, recoveryKey, ordinaryKey }) => {
    const db = await import('/assets/js/db.js');
    const summarize = async (value) => !value ? null : { ...value,
      photoBlobs: await Promise.all((value.photoBlobs || []).map(async (blob) => ({ type: blob.type, size: blob.size,
        bytes: [...new Uint8Array(await blob.arrayBuffer())] }))) };
    return { source: await summarize(await db.get('records', sourceId)), queue: await db.getAll('queue'),
      records: await Promise.all((await db.getAll('records')).map(summarize)),
      recovery: await summarize((await db.get('drafts', recoveryKey))?.value),
      ordinary: await summarize((await db.get('drafts', ordinaryKey))?.value),
      drafts: (await db.getAll('drafts')).map((entry) => ({ key: entry.key, value: entry.value })) };
  }, { sourceId, recoveryKey, ordinaryKey });
}

async function openFailedReport(f) {
  await f.page.goto(origin);
  await f.page.locator('#workerView').waitFor({ state: 'visible' });
  await waitUntil(() => f.traffic.uploads.length > 0, 'Startup must first attempt the queued upload');
  await waitForBrowser(f.page, async (id) => {
    const record = await (await import('/assets/js/db.js')).get('records', id);
    return record?.syncStatus === 'queued' && document.querySelector('#syncIndicator')?.dataset.state !== 'syncing';
  }, sourceId);
  await f.page.locator('button.tab[data-tab-target="historyTab"]').click();
  await f.page.locator('#historyList .record-disclosure-button').first().click();
}

function recoverButton(page) { return page.getByRole('button', { name: 'Recover as draft', exact: true }); }

async function waitForRecovery(page) {
  await waitForBrowser(page, async (key) => Boolean((await (await import('/assets/js/db.js')).get('drafts', key))?.value), recoveryKey);
}

async function openRecoveredEditor(page) {
  const hasRecoveredText = await page.locator('#workFormField_notes').count()
    && await page.locator('#workFormField_notes').inputValue() === 'Original answers must survive the failed upload.';
  if (!hasRecoveredText) {
    await page.locator('button.tab[data-tab-target="historyTab"]').click();
    const card = page.locator('#reportDraftsList .report-draft-card').filter({ hasText: 'Recovered upload draft.' });
    await card.getByRole('button', { name: 'Continue draft', exact: true }).click();
  } else if (!await page.locator('#formTab').isVisible()) await page.locator('button.tab[data-tab-target="formTab"]').click();
  await page.waitForFunction(() => !document.querySelector('#workFormSubmissionForm')?.inert
    && document.querySelector('#workFormField_notes')?.value === 'Original answers must survive the failed upload.');
}

async function settledRecoveryButton(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) =>
    button.textContent === 'Recover as draft' && !button.disabled && button.getAttribute('aria-busy') !== 'true'));
}

async function waitUntil(check, message) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForBrowser(page, predicate, argument) {
  // This installed Playwright treats an async waitForFunction predicate's
  // Promise as truthy. Explicitly await evaluate results before polling again.
  const deadline = Date.now() + 10000;
  while (!await page.evaluate(predicate, argument)) {
    if (Date.now() > deadline) throw new Error(`Browser condition did not settle: ${predicate.toString()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function submittedReport(overrides = {}) {
  return { id: 901, client_submission_id: clientId, department_id: 2, worker_id: worker.id, worker_name: worker.name,
    form_id: template.id, form_name: template.name, definition_version: 1, fields: template.fields,
    submission_purpose: 'report', status: 'pending', workflow_status: 'submitted', work_date: '2026-09-30',
    created_at: '2026-10-01T01:00:00Z', site_id: 9, site_name: 'Harbour Site',
    answers: { notes: 'Already durable original Report', checked: true, signature: '/uploads/server-signature.png' },
    photo_urls: ['/uploads/server-photo.png'], photo_metadata: [{ name: 'Original submitted photo.png' }], ...overrides };
}

async function submitEditor(f) {
  f.allowUploads();
  await f.page.locator('#submitWorkFormButton').click();
  await f.page.locator('#workFormReviewPanel').waitFor({ state: 'visible' });
  await f.page.waitForFunction(() => !document.querySelector('#confirmWorkFormSubmitButton').disabled);
  await f.page.locator('#confirmWorkFormSubmitButton').click();
  await waitUntil(() => f.traffic.posts.length > 0, 'Recovered Report did not reach final submission');
}

let groups = 0;
async function check(name, run) {
  if (process.env.REPORT_RECOVERY_TEST_FILTER && !name.includes(process.env.REPORT_RECOVERY_TEST_FILTER)) return;
  await run();
  groups += 1;
  console.log(`ok - ${name}`);
}

const browser = await chromium.launch({ headless: true });
try {
  await check('verified recovery preserves answers and valid evidence without overwriting an ordinary draft', async () => {
  const f = await fixture(browser, { existingDraft: true });
  try {
    await openFailedReport(f);
    assert.equal(await recoverButton(f.page).count(), 1, 'A failed own Report offers Recover as draft without deleting the original');
    const before = await snapshot(f.page);
    await recoverButton(f.page).click();
    await waitForRecovery(f.page);
    const saved = await snapshot(f.page);
    assert.deepEqual(f.traffic.lookups, [clientId], 'Recovery confirms exactly the original submission key first');
    assert.equal(f.traffic.posts.length, 0, 'Recovery itself never submits a Report');
    assert.equal(saved.recovery.answers.notes, before.source.capturedAnswers.notes);
    assert.equal(saved.recovery.answers.checked, true);
    assert.equal(saved.recovery.answers.signature, png, 'Restore captured handwritten signature, not checkpoint URL');
    assert.deepEqual(saved.recovery.answers.crew, before.source.capturedAnswers.crew, 'Repeated answers and handwritten signatures survive together');
    assert.equal(saved.recovery.workDate, before.source.workDate);
    assert.equal(Number(saved.recovery.siteId), 9);
    assert.equal(saved.recovery.definitionVersion, 1);
    assert.deepEqual(saved.recovery.fields, template.fields);
    assert.deepEqual(saved.recovery.photoBlobs, [before.source.photoBlobs[0], before.source.photoBlobs[2], before.source.photoBlobs[3]],
      'All valid original photos survive byte-exactly in original order');
    assert.deepEqual(saved.recovery.photoMetadata.map((photo) => photo.name), ['First.png', 'Third.png', 'Fourth.png']);
    assert.deepEqual(saved.recovery.uploadRecovery.omittedPhotos.map((photo) => photo.name), ['Damaged.png']);
    assert.equal(saved.recovery.uploadRecovery.clientSubmissionId, clientId, 'Recovery never rotates the idempotency identity');
    assert.equal(saved.source.isDraftRecovery, true);
    assert.equal(saved.source.recoveredToDraft, recoveryKey);
    assert.deepEqual(saved.source.photoBlobs, before.source.photoBlobs, 'Read-only fallback retains even damaged evidence');
    assert.equal(saved.queue.some((entry) => entry.id === sourceId), false);
    assert.deepEqual(saved.ordinary, before.ordinary, 'Separate ordinary same-Template draft cannot be overwritten');
    await openRecoveredEditor(f.page);
    await f.page.waitForFunction(() => document.querySelector('#syncIndicator')?.dataset.state === 'online'
      && document.querySelector('#queueSyncStatus')?.classList.contains('hidden'));
    assert.doesNotMatch(await f.page.locator('#syncIndicator').innerText(), /attention|queued|syncing/i,
      'Retiring the final queued Report must clear the old attention indicator');
    assert.equal(await f.page.locator('#workFormField_checked').isChecked(), true);
    assert.equal(await f.page.locator('#workFormDate').inputValue(), '2026-09-30');
    assert.equal(await f.page.locator('#workFormSite').inputValue(), '9');
    assert.equal(await f.page.locator('#workFormPhotoPreview img').count(), 3);
  } finally { await f.close(); }
  });

  await check('legacy base64 recovery keeps valid original bytes and excludes only the damaged image', async () => {
    const f = await fixture(browser, { legacyPhotos: true });
    try {
      await openFailedReport(f);
      await recoverButton(f.page).click();
      await waitForRecovery(f.page);
      const saved = await snapshot(f.page);
      assert.equal(saved.recovery.photoBlobs.length, 3);
      for (const photo of saved.recovery.photoBlobs) assert.deepEqual(photo.bytes, [...Buffer.from(png.split(',')[1], 'base64')]);
      assert.deepEqual(saved.recovery.photoMetadata.map((photo) => photo.name), ['First.png', 'Third.png', 'Fourth.png']);
      assert.equal(saved.recovery.answers.signature, png);
      assert.equal(saved.source.photoDataUrls.length, 4, 'Legacy fallback retains every original');
      assert.equal(f.traffic.posts.length, 0);
    } finally { await f.close(); }
  });

  await check('a definite server photo rejection survives earlier transient retry failures and recovery excludes the rejected original', async () => {
    const rejected = { index: 2, status: 422, message: 'Server rejected this otherwise browser-decodable photo' };
    const f = await fixture(browser, { legacyPhotos: true, extra: {
      photoDataUrls: [png, png, png, png], failedPhotoUpload: rejected,
      photoMetadata: ['First.png', 'Second.png', 'Server-rejected.png', 'Fourth.png'].map((name) => ({ name }))
    } });
    try {
      f.failUploads(503); // Replay stops at missing photo 1 before reaching known rejected photo 2.
      await openFailedReport(f);
      assert.deepEqual((await snapshot(f.page)).source.failedPhotoUpload, rejected,
        'Startup markSyncing must not erase a definite rejection when an earlier upload fails transiently');
      assert.equal(await f.page.evaluate(async (id) => {
        const source = (await (await import('/assets/js/db.js')).get('records', id)).photoDataUrls[2];
        const blob = (await import('/assets/js/utils.js')).dataUrlToBlob(source);
        const bitmap = await createImageBitmap(blob);
        const readable = bitmap.width > 0 && bitmap.height > 0;
        bitmap.close();
        return readable;
      }, sourceId), true, 'This regression must use a locally valid image rejected only by the server');
      await f.page.getByRole('button', { name: 'Retry sync', exact: true }).click();
      await f.page.waitForFunction(() => document.body.innerText.includes('Sync still failed.'));
      assert.deepEqual((await snapshot(f.page)).source.failedPhotoUpload, rejected,
        'An explicit retry failing earlier must also retain the rejection marker');
      assert.equal(f.traffic.posts.length, 0);
      const disclosure = f.page.locator('#historyList .record-disclosure-button').first();
      if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click();
      await recoverButton(f.page).click();
      await waitForRecovery(f.page);
      const saved = await snapshot(f.page);
      assert.deepEqual(saved.recovery.photoMetadata.map((photo) => photo.name), ['First.png', 'Second.png', 'Fourth.png']);
      assert.equal(saved.recovery.photoBlobs.length, 3);
      assert.deepEqual(saved.recovery.uploadRecovery.omittedPhotos.map((photo) => ({ index: photo.index, name: photo.name })),
        [{ index: 2, name: 'Server-rejected.png' }]);
      assert.deepEqual(saved.source.failedPhotoUpload, rejected, 'Read-only original keeps its rejection evidence');
      assert.equal(f.traffic.posts.length, 0);
    } finally { await f.close(); }
  });

  for (const version of [null, 'unknown', 0]) await check(`recovered unknown or invalid Definition version ${version} stays read-only`, async () => {
    const f = await fixture(browser, { extra: { definitionVersion: version } });
    try {
      await openFailedReport(f);
      await recoverButton(f.page).click();
      await waitForRecovery(f.page);
      await f.page.waitForFunction(() => document.querySelector('#submitWorkFormButton')?.disabled
        && /read-only/.test(document.querySelector('#submitWorkFormButton')?.textContent || ''));
      const saved = await snapshot(f.page);
      assert.equal(saved.recovery.definitionVersion, version);
      assert.equal(saved.recovery.answers.notes, 'Original answers must survive the failed upload.');
      assert.equal(saved.recovery.photoBlobs.length, 3);
      assert.equal(await f.page.locator('#workFormFields input, #workFormFields textarea, #workFormFields select').count(), 0,
        'Unknown snapshot answers must remain text instead of controls for the current Definition');
      assert.match(await f.page.locator('#workFormFields').innerText(), /Original answers must survive/);
      assert.equal(f.traffic.posts.length, 0);
      assert.equal(saved.queue.some((entry) => entry.id === sourceId), false);
    } finally { await f.close(); }
  });

  await check('server-confirmed existing Report suppresses recovery and cannot create a duplicate', async () => {
    const f = await fixture(browser);
    try {
      await openFailedReport(f);
      const report = submittedReport();
      f.durable.push(report);
      f.lookup({ status: 'submitted', client_submission_id: clientId, submission: report });
      const uploadCount = f.traffic.uploads.length;
      await recoverButton(f.page).click();
      await waitForBrowser(f.page, async (id) => Boolean((await (await import('/assets/js/db.js')).get('records', id))?.backendRecordId), sourceId);
      const saved = await snapshot(f.page);
      assert.equal(saved.recovery, null);
      assert.equal(saved.source.backendRecordId, 901);
      assert.equal(saved.queue.some((entry) => entry.id === sourceId), false);
      assert.equal(f.traffic.posts.length, 0);
      assert.equal(f.traffic.uploads.length, uploadCount);
      await f.page.reload();
      await f.page.locator('#workerView').waitFor({ state: 'visible' });
      assert.equal(f.traffic.posts.length, 0, 'Reload must not replay an already found Report');
    } finally { await f.close(); }
  });

  for (const [name, status, body] of [
    ['unavailable', 503, { detail: 'Unavailable' }],
    ['generic404', 404, { detail: 'Not found' }],
    ['malformed200', 200, {}],
    ['unbound-not-found', 200, { status: 'not_found', submission: null }],
    ['wrong-client-id', 200, { status: 'not_found', client_submission_id: 'someone-else', submission: null }],
    ['contradictory-absence', 200, { status: 'not_found', client_submission_id: clientId, submission: submittedReport() }],
    ['different-authenticated-worker', 200, { status: 'not_found', client_submission_id: clientId, submission: null, worker_id: 74 }],
    ['different-authenticated-department', 200, { status: 'not_found', client_submission_id: clientId, submission: null, department_id: 3 }],
    ['foreign-result', 200, { status: 'submitted', client_submission_id: clientId, submission: submittedReport({ worker_id: 74 }) }]
  ]) await check(`${name} lookup fails closed without modifying queue, originals or drafts`, async () => {
    const f = await fixture(browser);
    try {
      await openFailedReport(f);
      const before = await snapshot(f.page);
      f.lookup(body, status);
      await recoverButton(f.page).click();
      await waitUntil(() => f.traffic.lookups.length === 1, 'Expected verification request');
      await settledRecoveryButton(f.page);
      assert.deepEqual(await snapshot(f.page), before);
      assert.equal(f.traffic.posts.length, 0);
    } finally { await f.close(); }
  });

  await check('offline recovery waits for server verification and preserves the failed original', async () => {
    const f = await fixture(browser);
    try {
      await openFailedReport(f);
      const before = await snapshot(f.page);
      await f.page.evaluate(() => { window.fixtureOnline = false; window.dispatchEvent(new Event('offline')); });
      await recoverButton(f.page).click();
      await settledRecoveryButton(f.page);
      assert.equal(f.traffic.lookups.length, 0);
      assert.equal(f.traffic.posts.length, 0);
      assert.deepEqual(await snapshot(f.page), before);
    } finally { await f.close(); }
  });

  await check('browser without cross-tab locks fails closed before lookup or recovery storage writes', async () => {
    const f = await fixture(browser);
    try {
      await openFailedReport(f);
      const before = await snapshot(f.page);
      await f.page.evaluate(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
      await recoverButton(f.page).click();
      await settledRecoveryButton(f.page);
      assert.equal(f.traffic.lookups.length, 0);
      assert.equal(f.traffic.posts.length, 0);
      assert.deepEqual(await snapshot(f.page), before);
      assert.match(await f.page.locator('body').innerText(), /browser|support|safe|lock/i);
    } finally { await f.close(); }
  });

  await check('deleted server Report cannot become an editable replacement', async () => {
    const f = await fixture(browser);
    try {
      await openFailedReport(f);
      f.lookup({ status: 'deleted', client_submission_id: clientId, submission: null });
      const before = await snapshot(f.page);
      await recoverButton(f.page).click();
      await waitUntil(() => f.traffic.lookups.length === 1, 'Deleted status was not checked');
      await waitForBrowser(f.page, async (id) => (await (await import('/assets/js/db.js')).get('records', id))?.syncBlockedReason === 'previously_submitted', sourceId);
      const saved = await snapshot(f.page);
      assert.equal(saved.recovery, null);
      assert.equal(saved.source.isDraftRecovery, true);
      assert.deepEqual(saved.source.photoBlobs, before.source.photoBlobs);
      assert.deepEqual(saved.source.capturedAnswers, before.source.capturedAnswers);
      assert.equal(saved.queue.some((entry) => entry.id === sourceId), false);
      assert.equal(f.traffic.posts.length, 0);
    } finally { await f.close(); }
  });

  for (const store of ['draft', 'record', 'queue']) await check(`${store} write failure aborts the entire recovery transaction and retry succeeds once`, async () => {
    const f = await fixture(browser);
    try {
      await openFailedReport(f);
      const before = await snapshot(f.page);
      await f.page.evaluate((value) => { window.recoveryStorageFailure = value; }, store);
      await recoverButton(f.page).click();
      await waitUntil(() => f.traffic.lookups.length === 1, 'Recovery must confirm server state before storage writes');
      await settledRecoveryButton(f.page);
      assert.equal(await f.page.evaluate(() => window.recoveryStorageFaults.length), 1, `The ${store} boundary must actually be exercised`);
      assert.deepEqual(await snapshot(f.page), before, 'An aborted transaction cannot retire source, remove queue, or save half a draft');
      await f.page.evaluate(() => { window.recoveryStorageFailure = ''; });
      await recoverButton(f.page).click();
      await waitForRecovery(f.page);
      const saved = await snapshot(f.page);
      assert.equal(saved.drafts.filter((entry) => entry.key === recoveryKey).length, 1);
      assert.equal(saved.queue.some((entry) => entry.id === sourceId), false);
      assert.equal(f.traffic.posts.length, 0);
    } finally { await f.close(); }
  });

  await check('pending recovery owns its queue record against replay and duplicate recovery clicks', async () => {
    const f = await fixture(browser);
    try {
      await openFailedReport(f);
      const gate = f.holdLookup();
      const uploads = f.traffic.uploads.length;
      await recoverButton(f.page).click();
      await waitUntil(() => f.traffic.lookups.length === 1, 'Recovery lookup did not start');
      const replay = await f.page.evaluate(async () => (await import('/assets/js/offline-submissions.js')).syncQueuedSubmissions({ purpose: 'report' }));
      assert.equal(replay.skipped, 1);
      assert.equal(f.traffic.uploads.length, uploads);
      assert.equal(f.traffic.posts.length, 0);
      gate.resolve();
      await waitForRecovery(f.page);
      assert.equal(f.traffic.lookups.length, 1);
    } finally { await f.close(); }
  });

  await check('active replay rejects a previously rendered recovery action before any lookup or storage changes', async () => {
    const f = await fixture(browser);
    try {
      await openFailedReport(f);
      await recoverButton(f.page).evaluate((button) => { window.oldRecoveryButton = button; });
      const gate = f.holdUpload();
      const uploads = f.traffic.uploads.length;
      await f.page.getByRole('button', { name: 'Retry sync', exact: true }).click();
      await waitUntil(() => f.traffic.uploads.length === uploads + 1, 'Retry upload did not start');
      await f.page.evaluate(() => window.oldRecoveryButton.click());
      assert.equal(f.traffic.lookups.length, 0, 'An active replay must win before recovery checks the server');
      assert.equal((await snapshot(f.page)).recovery, null);
      assert.equal(f.traffic.posts.length, 0);
      gate.resolve();
      await waitForBrowser(f.page, async (id) => (await (await import('/assets/js/db.js')).get('records', id))?.syncStatus === 'queued', sourceId);
      assert.equal((await snapshot(f.page)).source.photoBlobs.length, 4);
    } finally { await f.close(); }
  });

  await check('recovery first saves newly typed ordinary work and an old button cannot recover twice', async () => {
    const f = await fixture(browser, { existingDraft: true });
    try {
      await openFailedReport(f);
      await recoverButton(f.page).evaluate((button) => { window.oldRecoveryButton = button; });
      await f.page.locator('button.tab[data-tab-target="formTab"]').click();
      await f.page.locator('#workFormSelect').selectOption(String(template.id));
      await f.page.waitForFunction(() => !document.querySelector('#workFormSubmissionForm')?.inert
        && document.querySelector('#workFormField_notes')?.value === 'Separate ordinary draft stays untouched');
      const changed = 'Ordinary draft edited immediately before recovering a different upload';
      await f.page.locator('#workFormField_notes').fill(changed);
      assert.equal(await f.page.locator('#workFormField_notes').inputValue(), changed);
      await f.page.locator('button.tab[data-tab-target="historyTab"]').click();
      const disclosure = f.page.locator('#historyList .record-disclosure-button').first();
      if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click();
      await recoverButton(f.page).click();
      await waitForRecovery(f.page);
      assert.equal((await snapshot(f.page)).ordinary.answers.notes, changed);
      await f.page.evaluate(() => window.oldRecoveryButton.click());
      assert.equal(f.traffic.lookups.length, 1);
      assert.equal((await snapshot(f.page)).drafts.filter((entry) => entry.key === recoveryKey).length, 1);
      assert.equal(f.traffic.posts.length, 0);
    } finally { await f.close(); }
  });

  await check('ordinary draft save failure blocks recovery before lookup and retry preserves the exact new text', async () => {
    const f = await fixture(browser, { existingDraft: true });
    try {
      await openFailedReport(f);
      const before = await snapshot(f.page);
      await f.page.locator('button.tab[data-tab-target="formTab"]').click();
      await f.page.locator('#workFormSelect').selectOption(String(template.id));
      await f.page.waitForFunction(() => !document.querySelector('#workFormSubmissionForm')?.inert
        && document.querySelector('#workFormField_notes')?.value === 'Separate ordinary draft stays untouched');
      const changed = 'Unsaved ordinary answers must survive a failed save before upload recovery.\nExact second line.';
      await f.page.evaluate(() => { window.recoveryStorageFailure = 'ordinary-draft'; });
      await f.page.locator('#workFormField_notes').fill(changed);
      await f.page.locator('button.tab[data-tab-target="historyTab"]').click();
      const disclosure = f.page.locator('#historyList .record-disclosure-button').first();
      if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click();
      await recoverButton(f.page).click();
      await settledRecoveryButton(f.page);
      assert.ok(await f.page.evaluate((key) => window.recoveryStorageFaults.some((fault) => fault.store === 'drafts' && fault.id === key), ordinaryKey),
        'The mounted ordinary draft must actually reach its failing save boundary');
      assert.deepEqual(f.traffic.lookups, [], 'Unsaved ordinary work must block recovery before server verification');
      assert.equal(f.traffic.posts.length, 0, 'A failed ordinary save cannot submit any Report');
      assert.deepEqual(await snapshot(f.page), before,
        'Failed ordinary save preserves the stored draft, failed upload, original photo bytes and queue without a recovery slot');
      await f.page.locator('button.tab[data-tab-target="formTab"]').click();
      assert.equal(await f.page.locator('#workFormField_notes').inputValue(), changed,
        'Newly typed ordinary answers remain mounted after the failed recovery');
      await f.page.evaluate(() => { window.recoveryStorageFailure = ''; });
      await f.page.locator('button.tab[data-tab-target="historyTab"]').click();
      if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click();
      await recoverButton(f.page).click();
      await waitForRecovery(f.page);
      const saved = await snapshot(f.page);
      assert.equal(saved.ordinary.answers.notes, changed, 'Retry saves the exact new ordinary answers before recovering');
      assert.deepEqual(saved.ordinary.photoBlobs, before.ordinary.photoBlobs, 'Retry preserves the separate ordinary draft photo');
      assert.deepEqual(f.traffic.lookups, [clientId], 'Only the successful retry checks the server');
      assert.equal(saved.drafts.filter((entry) => entry.key === recoveryKey).length, 1);
      assert.equal(saved.source.recoveredToDraft, recoveryKey);
      assert.deepEqual(saved.source.photoBlobs, before.source.photoBlobs, 'Retired source retains every original photo');
      assert.equal(saved.queue.some((entry) => entry.id === sourceId), false);
      assert.deepEqual(saved.recovery.photoBlobs, [before.source.photoBlobs[0], before.source.photoBlobs[2], before.source.photoBlobs[3]]);
      assert.equal(f.traffic.posts.length, 0);
    } finally { await f.close(); }
  });

  await check('explicit logout waits for an active recovery to finish safely', async () => {
    const f = await fixture(browser);
    try {
      await openFailedReport(f);
      const before = await snapshot(f.page);
      const gate = f.holdLookup();
      await recoverButton(f.page).click();
      await waitUntil(() => f.traffic.lookups.length === 1, 'Recovery lookup did not start');
      await f.page.locator('#logoutButton').click();
      assert.equal(await f.page.locator('body').getAttribute('data-active-view'), 'worker');
      assert.deepEqual(await snapshot(f.page), before);
      gate.resolve();
      await waitForRecovery(f.page);
      await f.page.locator('#logoutButton').click();
      await f.page.waitForFunction(() => document.body.dataset.activeView === 'login');
      assert.ok((await snapshot(f.page)).recovery);
      assert.equal(f.traffic.lookups.length, 1);
      assert.equal(f.traffic.posts.length, 0);
      assert.equal(await f.page.locator('#historyList').innerText().then((text) => text.includes(before.source.capturedAnswers.notes)), false);
    } finally { await f.close(); }
  });

  await check('expired authorization clears private UI and a detached recovery control cannot restart it', async () => {
    const f = await fixture(browser);
    try {
      await openFailedReport(f);
      const before = await snapshot(f.page);
      await recoverButton(f.page).evaluate((button) => { window.detachedRecoveryButton = button; });
      f.lookup({ detail: 'Expired session' }, 401);
      f.expireSession();
      await recoverButton(f.page).click();
      await f.page.waitForFunction(() => document.body.dataset.activeView === 'login');
      await f.page.evaluate(() => window.detachedRecoveryButton.click());
      assert.deepEqual(await snapshot(f.page), before);
      assert.equal(f.traffic.lookups.length, 1);
      assert.equal(f.traffic.posts.length, 0);
      assert.equal(await f.page.locator('#historyList').innerText().then((text) => text.includes(before.source.capturedAnswers.notes)), false);
    } finally { await f.close(); }
  });

  await check('unrelated history authorization failure clears private UI during a held recovery lookup', async () => {
    const f = await fixture(browser);
    try {
      await openFailedReport(f);
      const before = await snapshot(f.page);
      const gate = f.holdLookup();
      await recoverButton(f.page).click();
      await waitUntil(() => f.traffic.lookups.length === 1, 'Recovery lookup did not start');
      f.failHistory(401);
      await f.page.locator('#refreshHistoryButton').click();
      await f.page.waitForFunction(() => document.body.dataset.activeView === 'login');
      assert.equal(await f.page.locator('#historyList').innerText().then((text) => text.includes(before.source.capturedAnswers.notes)), false,
        'An unrelated explicit 401 clears private history without waiting for the lookup');
      assert.deepEqual(await snapshot(f.page), before);
      gate.resolve();
      await waitForBrowser(f.page, async (id) => !(await navigator.locks.query()).held.some((lock) => String(lock.name).includes(id)), sourceId);
      assert.deepEqual(await snapshot(f.page), before, 'The late successful lookup cannot publish a draft after expiry');
      assert.equal(f.traffic.posts.length, 0);
    } finally { await f.close(); }
  });

  for (const change of ['worker', 'department']) await check(`changed ${change} during lookup prevents recovery under another session`, async () => {
    const f = await fixture(browser);
    try {
      await openFailedReport(f);
      const before = await snapshot(f.page);
      const gate = f.holdLookup();
      await recoverButton(f.page).click();
      await waitUntil(() => f.traffic.lookups.length === 1, 'Recovery lookup did not start');
      const nextWorker = { ...worker, ...(change === 'worker' ? { id: 74 } : { department_id: 3 }) };
      f.setWorker(nextWorker);
      await f.page.evaluate(async (value) => (await import('/assets/js/api-client.js')).saveSession(value), nextWorker);
      gate.resolve();
      await settledRecoveryButton(f.page);
      assert.deepEqual(await snapshot(f.page), before);
      assert.equal(f.traffic.posts.length, 0);
      await f.page.reload();
      await f.page.locator('#workerView').waitFor({ state: 'visible' });
      await f.page.locator('button.tab[data-tab-target="historyTab"]').click();
      assert.equal(await f.page.locator('#historyList').innerText().then((text) => text.includes(before.source.capturedAnswers.notes)), false);
    } finally { await f.close(); }
  });

  await check('recovery survives reload and resubmission keeps its original idempotency key', async () => {
    const f = await fixture(browser, { existingDraft: true });
    try {
      await openFailedReport(f);
      await recoverButton(f.page).click();
      await waitForRecovery(f.page);
      const originalDraft = (await snapshot(f.page)).ordinary;
      await f.page.reload();
      await f.page.locator('#workerView').waitFor({ state: 'visible' });
      await openRecoveredEditor(f.page);
      const replacement = 'Recovered answer edited without replacing the ordinary draft';
      await f.page.locator('#workFormField_notes').fill(replacement);
      assert.equal(await f.page.locator('#workFormField_notes').inputValue(), replacement);
      await submitEditor(f);
      await waitForBrowser(f.page, async () => (await (await import('/assets/js/db.js')).getAll('queue')).length === 0);
      assert.equal(f.traffic.posts.length, 1);
      assert.equal(f.traffic.posts[0].client_submission_id, clientId);
      assert.equal(f.traffic.posts[0].answers.notes, replacement);
      assert.equal(f.traffic.posts[0].photo_urls.length, 3);
      assert.equal(f.traffic.postHeaders[0]['x-report-recovery-worker'], String(worker.id));
      assert.equal(f.traffic.postHeaders[0]['x-report-recovery-department'], String(worker.department_id));
      assert.equal(f.traffic.uploadHeaders[0]['x-report-recovery-worker'], undefined, 'Ordinary queued uploads keep their existing protocol');
      for (const headers of f.traffic.uploadHeaders.slice(1)) {
        assert.equal(headers['x-report-recovery-worker'], String(worker.id));
        assert.equal(headers['x-report-recovery-department'], String(worker.department_id));
      }
      assert.equal(f.durable.length, 1);
      assert.deepEqual((await snapshot(f.page)).ordinary, originalDraft);
    } finally { await f.close(); }
  });

  await check('Continue draft cannot replace text entered in the mounted recovered editor during a pending storage read', async () => {
    const f = await fixture(browser);
    try {
      await openFailedReport(f);
      await recoverButton(f.page).click();
      await waitForRecovery(f.page);
      await openRecoveredEditor(f.page);
      await f.page.waitForFunction(() => document.querySelector('#syncIndicator')?.dataset.state === 'online'
        && document.querySelector('#queueSyncStatus')?.classList.contains('hidden'));
      await f.page.locator('button.tab[data-tab-target="historyTab"]').click();
      await f.page.evaluate(() => { window.holdRecoveryDraftRead = true; });
      await f.page.locator('#reportDraftsList .report-draft-card').filter({ hasText: 'Recovered upload draft.' })
        .getByRole('button', { name: 'Continue draft', exact: true }).click();
      await f.page.waitForFunction(() => window.recoveryDraftReadReached);
      await f.page.locator('button.tab[data-tab-target="formTab"]').click();
      const edited = 'Typed while Continue draft waits for the existing recovery slot';
      await f.page.locator('#workFormField_notes').fill(edited);
      assert.equal(await f.page.locator('#workFormField_notes').inputValue(), edited, 'The race must contain actual entered text');
      await f.page.evaluate(() => { window.holdRecoveryDraftRead = false; });
      await f.page.waitForFunction(() => ![...document.querySelectorAll('#reportDraftsList button')]
        .some((button) => button.getAttribute('aria-busy') === 'true'));
      assert.equal(await f.page.locator('#workFormField_notes').inputValue(), edited, 'A stale read must not replace newer mounted input');
      await waitForBrowser(f.page, async ({ key, text }) =>
        (await (await import('/assets/js/db.js')).get('drafts', key))?.value?.answers?.notes === text,
      { key: recoveryKey, text: edited });
      assert.equal(f.traffic.posts.length, 0);
    } finally { await f.page.evaluate(() => { window.holdRecoveryDraftRead = false; }).catch(() => {}); await f.close(); }
  });

  await check('lost final response is found before recovery instead of generating a second Report', async () => {
    const f = await fixture(browser);
    try {
      await openFailedReport(f);
      f.allowUploads();
      f.losePostResponse();
      f.failHistory(); // Recovery must verify independently of unavailable durable history.
      await f.page.getByRole('button', { name: 'Retry sync', exact: true }).click();
      await waitUntil(() => f.traffic.posts.length === 1, 'The original Report did not reach its final request');
      await waitForBrowser(f.page, async (id) => (await (await import('/assets/js/db.js')).get('records', id))?.syncStatus === 'queued', sourceId);
      await f.page.waitForFunction(() => document.body.innerText.includes('Sync still failed.'));
      const report = f.durable[0];
      assert.equal(report.client_submission_id, clientId);
      f.lookup({ status: 'submitted', client_submission_id: clientId, submission: report });
      const disclosure = f.page.locator('#historyList .record-disclosure-button').first();
      if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click();
      await recoverButton(f.page).click();
      await waitForBrowser(f.page, async (id) => Boolean((await (await import('/assets/js/db.js')).get('records', id))?.backendRecordId), sourceId);
      assert.equal((await snapshot(f.page)).recovery, null);
      assert.equal(f.traffic.posts.length, 1);
      assert.equal(f.durable.length, 1);
    } finally { await f.close(); }
  });

  await check('late idempotent server replay preserves recovered edits read-only instead of pretending they were submitted', async () => {
    const f = await fixture(browser);
    try {
      await openFailedReport(f);
      await recoverButton(f.page).click();
      await waitForRecovery(f.page);
      await openRecoveredEditor(f.page);
      const edited = 'Recovered edits made after the original reached the server';
      await f.page.locator('#workFormField_notes').fill(edited);
      assert.equal(await f.page.locator('#workFormField_notes').inputValue(), edited);
      f.durable.push(submittedReport());
      f.replayPost();
      await submitEditor(f);
      await waitForBrowser(f.page, async () => (await (await import('/assets/js/db.js')).getAll('queue')).length === 0);
      const saved = await snapshot(f.page);
      assert.equal(f.traffic.posts.length, 1);
      assert.equal(f.traffic.posts[0].client_submission_id, clientId);
      assert.equal(f.durable.length, 1);
      assert.equal(f.durable[0].answers.notes, 'Already durable original Report', 'Existing immutable Report must not be altered');
      assert.ok(saved.records.some((record) => record.isDraftRecovery
        && record.syncBlockedReason === 'previously_submitted'
        && (record.capturedAnswers || record.answers)?.notes === edited), 'Unsubmitted recovered edits remain a read-only device copy');
    } finally { await f.close(); }
  });

  await check('second recovery finding the original submission preserves later edited answers and photos in a visible read-only copy', async () => {
    const f = await fixture(browser);
    try {
      await openFailedReport(f);
      await recoverButton(f.page).click();
      await waitForRecovery(f.page);
      await openRecoveredEditor(f.page);
      const edited = 'Second recovery must retain these newer answers after an earlier attempt won';
      await f.page.locator('#workFormField_notes').fill(edited);
      assert.equal(await f.page.locator('#workFormField_notes').inputValue(), edited);
      f.failUploads();
      await f.page.locator('#submitWorkFormButton').click();
      await f.page.locator('#workFormReviewPanel').waitFor({ state: 'visible' });
      await f.page.waitForFunction(() => !document.querySelector('#confirmWorkFormSubmitButton').disabled);
      await f.page.locator('#confirmWorkFormSubmitButton').click();
      await waitForBrowser(f.page, async (originalId) => (await (await import('/assets/js/db.js')).getAll('records'))
        .some((record) => record.id !== originalId && record.uploadRecovery && record.syncStatus === 'queued'
          && !record.isDraftRecovery && record.syncError), sourceId);
      await f.page.waitForFunction(() => !document.querySelector('#submitWorkFormButton')?.disabled
        && /saved locally/.test(document.querySelector('#workFormFeedback')?.innerText || ''));
      const before = await snapshot(f.page);
      const attempt = before.records.find((record) => record.id !== sourceId && record.uploadRecovery
        && record.syncStatus === 'queued' && !record.isDraftRecovery);
      assert.ok(attempt);
      assert.equal(attempt.clientSubmissionId, clientId);
      assert.equal(attempt.capturedAnswers.notes, edited);
      assert.equal(attempt.photoBlobs.length, 3);
      const report = submittedReport();
      f.durable.push(report);
      f.failHistory();
      f.lookup({ status: 'submitted', client_submission_id: clientId, submission: report });
      await f.page.locator('button.tab[data-tab-target="historyTab"]').click();
      for (const disclosure of await f.page.locator('#historyList .record-disclosure-button').all()) {
        if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click();
      }
      assert.equal(await recoverButton(f.page).count(), 1);
      await recoverButton(f.page).click();
      await waitForBrowser(f.page, async (id) => (await (await import('/assets/js/db.js')).get('records', id))?.backendRecordId === 901, attempt.id);
      const saved = await snapshot(f.page);
      assert.equal(f.traffic.posts.length, 0, 'Both failures happened before POST; reconciliation only reads');
      assert.equal(f.durable.length, 1);
      assert.equal(saved.queue.length, 0);
      assert.equal(saved.drafts.some((entry) => entry.key === `work-form-recovery:${worker.id}:${worker.department_id}:${attempt.id}`), false,
        'An existing server Report cannot create another editable recovery slot');
      const copy = saved.records.find((record) => record.id !== sourceId && record.isDraftRecovery
        && record.syncBlockedReason === 'previously_submitted' && (record.capturedAnswers || record.answers)?.notes === edited);
      assert.ok(copy, 'The second failed attempt keeps its newer edits in a separate visible read-only record');
      assert.deepEqual(copy.photoBlobs, attempt.photoBlobs);
      assert.deepEqual(copy.capturedAnswers, attempt.capturedAnswers);
      await f.page.waitForFunction(() => ![...document.querySelectorAll('#historyList button')].some((button) => button.textContent === 'Recover as draft'));
      for (const disclosure of await f.page.locator('#historyList .record-disclosure-button').all()) {
        if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click();
      }
      assert.ok((await f.page.locator('#historyList').innerText()).includes(edited), 'Retained newer answers must actually be available in My Reports');
    } finally { await f.close(); }
  });

  await check('pre-release recovery copies remain visibly read-only across reload without replay or native evidence changes', async () => {
    const f = await fixture(browser);
    const readNativeCopies = async () => f.page.evaluate(async ({ sourceId, recoveryKey }) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('scaffold-pwa-report-evidence-v1', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const read = (store, key) => new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const request = tx.objectStore(store).get(key);
        let result;
        request.onsuccess = () => { result = request.result; };
        tx.oncomplete = () => resolve(result);
        tx.onabort = tx.onerror = () => reject(tx.error);
      });
      try {
        const rows = { record: await read('records', sourceId), queue: await read('queue', sourceId),
          draft: await read('drafts', recoveryKey) };
        for (const entry of [rows.record?.value, rows.draft?.value?.value]) {
          if (entry) entry.photoBlobs = await Promise.all((entry.photoBlobs || []).map(async (blob) => ({
            type: blob.type, bytes: [...new Uint8Array(await blob.arrayBuffer())]
          })));
        }
        return rows;
      } finally { db.close(); }
    }, { sourceId, recoveryKey });
    try {
      await f.page.evaluate(async ({ sourceId, recoveryKey, worker }) => {
        const storage = await import('/assets/js/db.js');
        const record = await storage.get('records', sourceId);
        const recovery = { sourceRecordId: sourceId, clientSubmissionId: record.clientSubmissionId,
          ownerWorkerId: worker.id, departmentId: worker.department_id, formId: record.formId,
          recoveredAt: '2026-10-01T03:00:00Z', omittedPhotos: [] };
        const draft = { key: recoveryKey, value: { kind: 'work-form', schemaVersion: 1,
          ownerWorkerId: worker.id, departmentId: worker.department_id, templatePurpose: 'report',
          formId: record.formId, formName: record.formName, definitionVersion: record.definitionVersion,
          fields: record.fields, answers: record.capturedAnswers, workDate: record.workDate,
          siteId: String(record.siteId), photoBlobs: [record.photoBlobs[0]], photoDataUrls: [],
          photoMetadata: [record.photoMetadata[0]], savedAt: '2026-10-01T03:00:00Z', uploadRecovery: recovery
        }, updatedAt: '2026-10-01T03:00:00Z' };
        // Seed the actual old namespace, not current put(), which correctly
        // routes all newly written recovery work into its isolated database.
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('scaffold-pwa-report-evidence-v1', 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          await new Promise((resolve, reject) => {
            const tx = db.transaction(['records', 'drafts'], 'readwrite');
            tx.objectStore('records').put({ id: sourceId, reportStorageVersion: 1,
              value: { ...record, uploadRecovery: recovery } });
            tx.objectStore('drafts').put({ key: recoveryKey, reportStorageVersion: 1, value: draft });
            tx.oncomplete = resolve;
            tx.onabort = tx.onerror = () => reject(tx.error);
          });
        } finally { db.close(); }
      }, { sourceId, recoveryKey, worker });
      const before = await readNativeCopies();
      const openReadOnly = async () => {
        await f.page.goto(origin);
        await f.page.locator('#workerView').waitFor({ state: 'visible' });
        await f.page.locator('button.tab[data-tab-target="historyTab"]').click();
        const draftCard = f.page.locator('#reportDraftsList .report-draft-card')
          .filter({ hasText: 'This pre-release recovery copy is read-only.' });
        await draftCard.waitFor({ state: 'visible' });
        await f.page.locator('#historyList .record-disclosure-button').first().click();
        assert.match(await f.page.locator('#historyList').innerText(), /pre-release recovery copy is read-only/);
        assert.equal(await recoverButton(f.page).count(), 0);
        assert.equal(await f.page.getByRole('button', { name: 'Retry sync', exact: true }).count(), 0);
        await draftCard.getByRole('button', { name: 'Continue draft', exact: true }).click();
        await f.page.waitForFunction(() => document.querySelector('#formTab')?.classList.contains('active')
          && document.querySelector('#workFormAutosaveStatus')?.textContent.includes('pre-release recovery copy is read-only'));
        assert.match(await f.page.locator('#workFormFields').innerText(), /Original answers must survive the failed upload\./);
        assert.equal(await f.page.locator('#workFormField_notes').count(), 0);
        assert.equal(await f.page.locator('#submitWorkFormButton').isDisabled(), true);
        assert.equal(await f.page.locator('#workFormPhotos').isDisabled(), true);
      };
      await openReadOnly();
      await openReadOnly();
      assert.deepEqual(f.traffic.lookups, [], 'Quarantine cannot re-authorize an unsafe recovered attempt');
      assert.deepEqual(f.traffic.uploads, [], 'Quarantined originals must never upload during startup or Continue');
      assert.deepEqual(f.traffic.posts, [], 'Read-only copies must never reach submission');
      assert.deepEqual(await readNativeCopies(), before, 'Raw old-namespace records, queue and draft remain byte-exact');
      if (await f.page.evaluate(() => document.documentElement.dataset.theme) !== 'light') await f.page.locator('#themeToggleButton').click();
      await f.page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
      assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await mkdir(output, { recursive: true });
      await f.page.screenshot({ path: path.join(output, 'pre-release-readonly-390-en-light.png'), fullPage: true });
    } finally { await f.close(); }
  });

  await check('phone recovery and omitted-photo guidance fit English-light and Chinese-dark layouts', async () => {
    const f = await fixture(browser);
    try {
      await openFailedReport(f);
      await mkdir(output, { recursive: true });
      if (await f.page.evaluate(() => document.documentElement.dataset.theme) !== 'light') await f.page.locator('#themeToggleButton').click();
      await f.page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
      for (const width of [390, 320]) {
        await f.page.setViewportSize({ width, height: 844 });
        assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await f.page.screenshot({ path: path.join(output, `failed-${width}-en-light.png`), fullPage: true });
      }
      await recoverButton(f.page).click();
      await waitForRecovery(f.page);
      await openRecoveredEditor(f.page);
      assert.match(await f.page.locator('#formTab').innerText(), /damaged|omitt|could not|not recovered|removed/i,
        'Workers must be told a damaged photo was not recovered');
      await f.page.waitForFunction(() => document.querySelector('#syncIndicator')?.dataset.state === 'online'
        && document.querySelector('#queueSyncStatus')?.classList.contains('hidden'));
      for (const width of [320, 390]) {
        await f.page.setViewportSize({ width, height: 844 });
        assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await f.page.screenshot({ path: path.join(output, `recovered-${width}-en-light.png`), fullPage: true });
      }
      await f.page.locator('#languageToggleButton').click();
      await f.page.locator('#themeToggleButton').click();
      await f.page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      await f.page.waitForFunction(() => /[\u4e00-\u9fff]/.test(document.querySelector('#workFormPhotoSelectionFeedback')?.innerText || ''));
      assert.doesNotMatch(await f.page.locator('#workFormAutosaveStatus').innerText(), /Draft restored on this device/i,
        'The restored-draft suffix must also translate');
      for (const width of [390, 320]) {
        await f.page.setViewportSize({ width, height: 844 });
        assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await f.page.screenshot({ path: path.join(output, `recovered-${width}-zh-dark.png`), fullPage: true });
      }
    } finally { await f.close(); }
  });
  console.log(`${groups} Report upload recovery browser groups passed.`);
} finally { await browser.close(); }
