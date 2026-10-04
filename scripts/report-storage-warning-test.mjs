import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59960'; // Full real app; every request is intercepted, including unexpected requests.
const output = path.join(root, 'output', 'report-storage-warning.local');
const mib = 1024 * 1024;
const worker = { id: 73, role: 'worker', worker_class: 'normal', department_id: 2,
  name: 'Storage Worker', email: 'storage-worker@example.invalid', status: 'active' };
const templates = [81, 82].map((id) => ({ id, department_id: 2, name: `Storage inspection ${id}`,
  status: 'active', template_purpose: 'report', definition_version: 1,
  fields: [{ id: 'notes', type: 'textarea', label: 'Observations', required: true }] }));
const draftKey = 'work-form-draft:73:81';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const ample = { usage: 5 * mib, quota: 1024 * mib };
const low = { usage: 80 * mib, quota: 100 * mib };

// Only browser API boundaries are replaced. App modules, event handlers,
// confirmation dialog, actual Blob persistence and IndexedDB transactions are real.
function installBrowserBoundaries({ reportOnly, estimate }) {
  window.__REPORT_ONLY_MODE_OVERRIDE__ = reportOnly;
  window.storageTest = { mode: 'value', value: estimate, calls: 0, releases: [], failDraft: false, failStore: '',
    failures: 0, failedStores: [], deletes: [], puts: [], serviceWorkerMessages: [], originals: new Map() };
  const test = window.storageTest;
  const estimateStorage = () => {
    test.calls += 1;
    if (test.mode === 'throw') throw new TypeError('Estimate unavailable');
    if (test.mode === 'reject') return Promise.reject(new Error('Estimate rejected'));
    if (test.mode === 'hold') return new Promise((resolve) => test.releases.push(resolve));
    return Promise.resolve(test.value);
  };
  Object.defineProperty(navigator.storage, 'estimate', { configurable: true, writable: true, value: estimateStorage });
  test.setEstimate = (mode, value) => {
    test.mode = mode;
    if (value !== undefined) test.value = value;
    navigator.storage.estimate = mode === 'missing' ? undefined : estimateStorage;
  };
  test.releaseEstimates = (value = test.value) => test.releases.splice(0).forEach((release) => release(value));
  const nativePut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, ...args) {
    const key = String(value?.key || value?.id || '');
    if (test.failStore === this.name && ['records', 'queue'].includes(this.name)) {
      test.failedStores.push(this.name);
      throw new DOMException('Device storage quota exhausted during Report queue/checkpoint write', 'QuotaExceededError');
    }
    if (this.name === 'drafts' && key.startsWith('work-form-draft:')) {
      test.puts.push({ key, deleted: Boolean(value?.deleted) });
      if (test.failDraft) {
        test.failures += 1;
        throw new DOMException('Device storage quota exhausted while saving Report draft', 'QuotaExceededError');
      }
    }
    if (value?.deleted) test.deletes.push({ operation: 'tombstone', store: this.name, key });
    return nativePut.call(this, value, ...args);
  };
  for (const operation of ['delete', 'clear']) {
    const native = IDBObjectStore.prototype[operation];
    IDBObjectStore.prototype[operation] = function (...args) {
      test.deletes.push({ operation, store: this.name, key: args[0] });
      return native.apply(this, args);
    };
  }
  const nativeDeleteDatabase = indexedDB.deleteDatabase.bind(indexedDB);
  indexedDB.deleteDatabase = (...args) => {
    test.deletes.push({ operation: 'deleteDatabase', key: args[0] });
    return nativeDeleteDatabase(...args);
  };
  const waiting = { state: 'installed', addEventListener() {}, postMessage(message) {
    test.serviceWorkerMessages.push(message);
  } };
  Object.defineProperty(Navigator.prototype, 'serviceWorker', { configurable: true,
    get: () => ({ controller: {}, addEventListener() {}, async register() {
      return { waiting, installing: null, addEventListener() {} };
    } }) });
}

async function fixture(browser, { reportOnly = true, estimate = ample } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  context.setDefaultTimeout(10000);
  await context.addInitScript(installBrowserBoundaries, { reportOnly, estimate });
  const errors = [], unexpected = [], traffic = { uploads: [], posts: [] };
  let currentWorker = structuredClone(worker), signedIn = true, historyFailure = 0;
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { unexpected.push(url.href); return route.abort(); }
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated storage warning fixture</title>' });
    if (['/api/auth/me', '/api/auth/refresh'].includes(url.pathname)) return signedIn
      ? json(currentWorker) : json({ detail: 'Isolated fixture signed out' }, 401);
    if (url.pathname === '/api/auth/login') { signedIn = true; return json({ user: currentWorker }); }
    if (url.pathname === '/api/auth/logout') { signedIn = false; return json({ message: 'Signed out' }); }
    if (url.pathname === '/api/departments') return json([{ id: 2, name: 'Mutual' }]);
    if (url.pathname === '/api/sites') return json([]);
    if (url.pathname === '/api/work-forms') {
      assert.equal(url.searchParams.get('purpose'), reportOnly ? 'report' : null);
      return json(reportOnly ? templates : [{ ...templates[0], name: 'Retained Daywork', template_purpose: 'daywork' }]);
    }
    if (url.pathname === '/api/my-form-submissions') return historyFailure
      ? json({ detail: 'Isolated authorization expired' }, historyFailure) : json([]);
    if (['/api/my-records', '/api/attendance-records', '/api/task-logs', '/api/my-task-logs', '/api/team-work-logs', '/api/task-templates'].includes(url.pathname)) return json([]);
    if (url.pathname === '/api/photo-uploads') { traffic.uploads.push(request.postDataBuffer()); return json({ url: '/uploads/fixture.png' }); }
    if (url.pathname === '/api/form-submissions') { traffic.posts.push(request.postDataJSON()); return json({ id: 901 }); }
    if (url.pathname.startsWith('/api/')) { unexpected.push(`${request.method()} ${url.pathname}`); return json({ detail: 'Unexpected fixture request' }, 500); }
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    const filename = path.resolve(root, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    assert.ok(filename.startsWith(`${root}${path.sep}`), 'Only repository files are served');
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
  await page.evaluate(async (user) => (await import('/assets/js/api-client.js')).saveSession(user), worker);
  await page.goto(origin);
  await page.locator('#workerView').waitFor({ state: 'visible' });
  await page.locator('button.tab[data-tab-target="formTab"]').click();
  await page.waitForFunction(() => document.querySelector('#workFormSelect option[value="81"]'));
  await page.locator('#workFormSelect').selectOption('81');
  await page.locator('#workFormField_notes').fill('Preserve existing observations while selecting photos.');
  await page.locator('#workFormDate').fill('2026-10-02');
  await page.evaluate((pngBytes) => {
    const test = window.storageTest;
    test.hash = async (blob) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    test.pick = (descriptions) => {
      const transfer = new DataTransfer();
      const encoded = Uint8Array.from(atob(pngBytes), (character) => character.charCodeAt(0));
      for (const [index, description] of descriptions.entries()) {
        const bytes = description.size ? new Uint8Array(description.size) : encoded;
        if (description.size) bytes.set(encoded.subarray(0, bytes.length));
        const file = new File([bytes], description.name, { type: description.type || 'image/png',
          lastModified: description.lastModified || 1790899200000 + index });
        test.originals.set(description.name, file);
        transfer.items.add(file);
      }
      const input = document.querySelector('#workFormPhotos');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
  }, png);
  await waitSaved(page, 0);
  return { context, page, traffic,
    setWorker(value) { currentWorker = structuredClone(value); },
    expire() { signedIn = false; historyFailure = 401; },
    allowLogin() { historyFailure = 0; },
    async close() {
      await context.close();
      assert.deepEqual(errors, [], 'No unhandled real-app errors');
      assert.deepEqual(unexpected, [], 'No unexpected/external requests');
      assert.equal(traffic.uploads.length, 0, 'Selecting, saving, reviewing and recovering never uploads evidence');
      assert.equal(traffic.posts.length, 0, 'No Report is submitted without its separate final confirmation');
    }
  };
}

async function poll(page, predicate, argument, timeout = 10000) {
  // Explicitly await async browser predicates: this installed Playwright's
  // waitForFunction otherwise treats the Promise as truthy without awaiting it.
  const end = Date.now() + timeout;
  while (!await page.evaluate(predicate, argument)) {
    if (Date.now() >= end) throw new Error(`Browser state did not settle: ${predicate.toString()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function saved(page, key = draftKey) {
  return page.evaluate(async (key) => {
    const draft = (await (await import('/assets/js/db.js')).get('drafts', key))?.value;
    if (!draft) return null;
    return { ...draft, photoBlobs: await Promise.all((draft.photoBlobs || []).map(async (blob) => ({
      size: blob.size, type: blob.type, hash: await window.storageTest.hash(blob)
    }))) };
  }, key);
}
async function waitSaved(page, count, key = draftKey) {
  await poll(page, async ({ count, key }) => {
    const draft = (await (await import('/assets/js/db.js')).get('drafts', key))?.value;
    return (draft?.photoBlobs || []).length === count && Boolean(draft)
      && document.querySelector('#workFormAutosaveStatus')?.classList.contains('saved');
  }, { count, key });
}
const previews = (page) => page.locator('#workFormPhotoPreview [data-remove-report-photo]');
const draftContent = (draft) => { const { savedAt: _savedAt, ...content } = draft; return content; };
async function pick(page, descriptions) { await page.evaluate((files) => window.storageTest.pick(files), descriptions); }
async function estimate(page, mode, value) {
  await page.evaluate(({ mode, value }) => window.storageTest.setEstimate(mode, value), { mode, value });
}
async function dialog(page) {
  await page.locator('#confirmationDialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#confirmationDialogTitle').innerText(), 'Check photo storage');
  assert.equal(await page.locator('#confirmationDialogConfirmButton').innerText(), 'Add photos anyway');
  assert.equal(await page.locator('#confirmationDialogCancelButton').innerText(), 'Choose fewer photos');
}
async function cancel(page) {
  await page.locator('#confirmationDialogCancelButton').click();
  await page.locator('#confirmationDialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => !document.querySelector('#workFormPhotos').disabled);
}
async function approve(page) {
  await page.locator('#confirmationDialogConfirmButton').click();
  await page.locator('#confirmationDialog').waitFor({ state: 'hidden' });
}
const largeBatch = (prefix = 'large') => Array.from({ length: 4 }, (_, index) => ({ name: `${prefix}-${index}.png`, size: 5 * mib }));

let groups = 0;
const browser = await chromium.launch({ headless: true });
async function check(name, run, options = {}) {
  if (process.env.REPORT_STORAGE_TEST_FILTER && !name.includes(process.env.REPORT_STORAGE_TEST_FILTER)) return;
  const f = await fixture(browser, options);
  try { await run(f); groups += 1; console.log(`ok - ${name}`); }
  finally { await f.close(); }
}

try {
  await mkdir(output, { recursive: true });
  await check('local-only guidance is always visible and never promises a backup, including Review', async (f) => {
    const guidance = f.page.locator('#reportLocalStorageGuidance');
    assert.equal(await guidance.isVisible(), true);
    assert.match(await guidance.innerText(), /not.*backup|not.*guarantee/i);
    assert.match(await guidance.innerText(), /browser.*(?:clear|evict|remove)|(?:clear|evict|remove).*browser/i);
    await f.page.locator('#submitWorkFormButton').click();
    await f.page.locator('#workFormReviewPanel').waitFor({ state: 'visible' });
    assert.equal(await guidance.isVisible(), true, 'Storage guidance remains outside the hidden editor');
  });

  await check('ample storage saves a small batch without interrupting and keeps exact originals/metadata', async (f) => {
    await pick(f.page, [{ name: 'first.png', size: mib }, { name: 'second.png', size: 2 * mib, lastModified: 1790985600123 }]);
    await waitSaved(f.page, 2);
    assert.equal(await f.page.locator('#confirmationDialog').isVisible(), false);
    assert.equal(await previews(f.page).count(), 2);
    const draft = await saved(f.page);
    assert.deepEqual(draft.photoMetadata.map((item) => item.name), ['first.png', 'second.png']);
    assert.equal(draft.photoMetadata[1].last_modified, 1790985600123);
    assert.deepEqual(draft.photoBlobs, await f.page.evaluate(async () => Promise.all([...window.storageTest.originals.values()]
      .map(async (blob) => ({ size: blob.size, type: blob.type, hash: await window.storageTest.hash(blob) })))));
    assert.ok(await f.page.evaluate(() => window.storageTest.calls > 0), 'Real selection queries the browser estimate');
  });

  for (const [name, budget] of [
    ['little available storage', low],
    ['high origin usage despite ample absolute bytes', { usage: 900 * mib, quota: 1024 * mib }],
    ['insufficient conservative transaction headroom', { usage: 43 * mib, quota: 100 * mib }]
  ]) await check(`${name} warns before adding any originals or previews`, async (f) => {
    const before = await saved(f.page);
    await pick(f.page, name.includes('headroom') ? largeBatch().map((file, index) => ({ ...file, size: (index === 3 ? 4 : 5) * mib }))
      : [{ name: 'new.png', size: mib }]);
    await dialog(f.page);
    assert.equal(await previews(f.page).count(), 0);
    assert.deepEqual(await saved(f.page), before, 'Unaccepted bytes are not autosaved');
    assert.match(await f.page.locator('#confirmationDialogDescription').innerText(), /storage|space/i);
    await cancel(f.page);
    assert.deepEqual(await saved(f.page), before);
  }, { estimate: budget });

  await check('large batches warn even with ample estimates; explicit approval saves original bytes not thumbnails', async (f) => {
    await pick(f.page, largeBatch());
    await dialog(f.page);
    assert.equal(await previews(f.page).count(), 0);
    await approve(f.page);
    await waitSaved(f.page, 4);
    const draft = await saved(f.page);
    assert.deepEqual(draft.photoBlobs.map((photo) => photo.size), [5 * mib, 5 * mib, 5 * mib, 5 * mib]);
    assert.deepEqual(draft.photoBlobs.map((photo) => photo.hash), await f.page.evaluate(async () =>
      Promise.all([...window.storageTest.originals.values()].map((blob) => window.storageTest.hash(blob)))));
    assert.equal(await f.page.locator('#workFormStorageWarning').isVisible(), true);
    assert.equal(await f.page.locator('#workFormStorageWarning').getAttribute('role'), 'status');
    await f.page.locator('#submitWorkFormButton').click();
    await f.page.locator('#workFormReviewPanel').waitFor({ state: 'visible' });
    assert.equal(await f.page.locator('#workFormStorageWarning').isVisible(), true);
  });

  for (const mode of ['missing', 'throw', 'reject', 'hold', 'malformed']) await check(`${mode} estimates degrade safely and a large batch still needs confirmation`, async (f) => {
    await estimate(f.page, mode === 'malformed' ? 'value' : mode, mode === 'malformed' ? { usage: 'zero', quota: -10 } : undefined);
    const start = Date.now();
    await pick(f.page, largeBatch(mode));
    await dialog(f.page);
    assert.ok(Date.now() - start < 5000, 'Estimate timeout must not leave the editor waiting indefinitely');
    assert.equal(await previews(f.page).count(), 0);
    await cancel(f.page);
    await f.page.evaluate(() => window.storageTest.releaseEstimates());
    assert.equal(await previews(f.page).count(), 0, 'Late estimate resolution never revives a cancelled batch');
    await estimate(f.page, 'value', ample);
    await pick(f.page, [{ name: 'after-unavailable.png', size: mib }]);
    await waitSaved(f.page, 1);
  });

  await check('unknown estimates do not block small batches or claim storage is safe', async (f) => {
    await estimate(f.page, 'missing');
    await pick(f.page, [{ name: 'small.png', size: mib }]);
    await waitSaved(f.page, 1);
    assert.equal(await f.page.locator('#confirmationDialog').isVisible(), false);
    assert.doesNotMatch(await f.page.locator('#workFormStorageWarning').innerText(), /enough space|guaranteed|storage is safe/i);
  });

  await check('cancellation and Escape preserve existing photo, answers, saved draft and safe keyboard focus', async (f) => {
    await pick(f.page, [{ name: 'existing.png', size: mib }]);
    await waitSaved(f.page, 1);
    const before = await saved(f.page);
    await estimate(f.page, 'value', low);
    for (const action of ['button', 'escape']) {
      await f.page.locator('#workFormPhotos').focus();
      await pick(f.page, [{ name: `cancel-${action}.png`, size: mib }]);
      await dialog(f.page);
      await f.page.waitForFunction(() => document.activeElement?.id === 'confirmationDialogCancelButton');
      if (action === 'button') await cancel(f.page);
      else { await f.page.keyboard.press('Escape'); await f.page.locator('#confirmationDialog').waitFor({ state: 'hidden' }); }
      assert.equal(await previews(f.page).count(), 1);
      assert.deepEqual(await saved(f.page), before);
      assert.equal(await f.page.locator('#workFormField_notes').inputValue(), before.answers.notes);
      assert.equal(await f.page.locator('#workFormPhotos').inputValue(), '');
    }
  });

  await check('invalid and over-capacity files do not consume storage estimates or trigger false large-batch warnings', async (f) => {
    const beforeCalls = await f.page.evaluate(() => window.storageTest.calls);
    await pick(f.page, [{ name: 'unsupported.heic', type: 'image/heic', size: 30 * mib }, { name: 'too-large.png', size: 6 * mib }]);
    await f.page.locator('#workFormPhotoSelectionFeedback').waitFor({ state: 'visible' });
    assert.equal(await f.page.locator('#confirmationDialog').isVisible(), false);
    assert.equal(await f.page.evaluate(() => window.storageTest.calls), beforeCalls);
    assert.equal(await previews(f.page).count(), 0);
    await pick(f.page, [{ name: 'also-invalid.heic', type: 'image/heic', size: 30 * mib }, { name: 'valid.png', size: mib }]);
    await waitSaved(f.page, 1);
    assert.equal(await f.page.locator('#confirmationDialog').isVisible(), false);
    await pick(f.page, Array.from({ length: 49 }, (_, index) => ({ name: `tiny-${index}.png` })));
    await waitSaved(f.page, 50);
    const fullCalls = await f.page.evaluate(() => window.storageTest.calls);
    await pick(f.page, largeBatch('over-capacity'));
    await f.page.waitForFunction(() => document.querySelector('#workFormPhotoSelectionFeedback')?.textContent.includes('over-capacity-3.png'));
    assert.equal(await f.page.locator('#confirmationDialog').isVisible(), false);
    assert.equal(await f.page.evaluate(() => window.storageTest.calls), fullCalls);
    assert.equal(await previews(f.page).count(), 50);
  });

  await check('accumulated Report size warns before crossing 50 MiB even when each batch is small', async (f) => {
    for (let index = 0; index < 9; index += 1) {
      await pick(f.page, [{ name: `accumulated-${index}.png`, size: 5 * mib }]);
      await waitSaved(f.page, index + 1);
      assert.equal(await f.page.locator('#confirmationDialog').isVisible(), false);
    }
    const before = await saved(f.page);
    await pick(f.page, [{ name: 'reaches-50.png', size: 5 * mib }]);
    await dialog(f.page);
    assert.equal(await previews(f.page).count(), 9);
    await cancel(f.page);
    assert.deepEqual(await saved(f.page), before);
  });

  await check('queued picker changes serialize confirmations and freshly check each batch', async (f) => {
    await estimate(f.page, 'value', low);
    await f.page.evaluate(() => {
      window.storageTest.pick([{ name: 'first-pending.png', size: 1048576 }]);
      window.storageTest.pick([{ name: 'second-pending.png', size: 1048576 }]);
    });
    await dialog(f.page);
    await f.page.locator('#confirmationDialogCancelButton').click();
    await poll(f.page, () => window.storageTest.calls >= 2 && document.querySelector('#confirmationDialog').open);
    await approve(f.page);
    await waitSaved(f.page, 1);
    assert.deepEqual((await saved(f.page)).photoMetadata.map((photo) => photo.name), ['second-pending.png']);
    assert.equal(await f.page.evaluate(() => window.storageTest.calls), 2);
  });

  for (const boundary of ['estimate', 'dialog']) for (const action of ['template', 'clear', 'logout', 'update', 'expiry']) {
    await check(`${action} invalidates unaccepted photos during a pending ${boundary}`, async (f) => {
      await pick(f.page, [{ name: 'original.png', size: mib }]);
      await waitSaved(f.page, 1);
      const before = await saved(f.page);
      await estimate(f.page, boundary === 'estimate' ? 'hold' : 'value', low);
      const oldCalls = await f.page.evaluate(() => window.storageTest.calls);
      await pick(f.page, [{ name: 'must-not-appear.png', size: mib }]);
      if (boundary === 'dialog') await dialog(f.page);
      else await poll(f.page, (oldCalls) => window.storageTest.calls > oldCalls, oldCalls);
      if (action === 'template' || action === 'clear') {
        await f.page.locator('#workFormSelect').evaluate((select, value) => {
          select.value = value; select.dispatchEvent(new Event('change', { bubbles: true }));
        }, action === 'template' ? '82' : '');
        await poll(f.page, (expected) => document.querySelector('#workFormSelect').value === expected
          && !document.querySelector('#confirmationDialog').open, action === 'template' ? '82' : '');
      } else if (action === 'logout') {
        await f.page.locator('#logoutButton').evaluate((button) => button.click());
        await f.page.waitForFunction(() => document.body.dataset.activeView === 'login');
      } else if (action === 'update') {
        await f.page.locator('#updateButton').evaluate((button) => button.click());
        await poll(f.page, () => window.storageTest.serviceWorkerMessages.some((message) => message.type === 'SKIP_WAITING'));
      } else {
        f.expire();
        await f.page.locator('#refreshHistoryButton').evaluate((button) => button.click());
        await f.page.waitForFunction(() => document.body.dataset.activeView === 'login');
      }
      await f.page.evaluate(() => window.storageTest.releaseEstimates());
      await f.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await f.page.locator('#confirmationDialog').isVisible(), false);
      assert.deepEqual(draftContent(await saved(f.page)), draftContent(before),
        'Departure may checkpoint existing work again but must not change evidence or add unaccepted bytes');
      if (action === 'template' || action === 'clear') assert.equal(await previews(f.page).count(), 0);
    });
  }

  for (const boundary of ['estimate', 'dialog']) for (const identity of ['worker', 'department']) await check(`a changed authenticated ${identity} rejects a late ${boundary}`, async (f) => {
    const before = await saved(f.page);
    await estimate(f.page, boundary === 'estimate' ? 'hold' : 'value', low);
    await pick(f.page, [{ name: 'wrong-identity.png', size: mib }]);
    if (boundary === 'estimate') await poll(f.page, () => window.storageTest.releases.length === 1);
    else await dialog(f.page);
    const next = { ...worker, ...(identity === 'worker' ? { id: 74 } : { department_id: 3 }) };
    f.setWorker(next);
    await f.page.evaluate(async (user) => (await import('/assets/js/api-client.js')).saveSession(user), next);
    if (boundary === 'estimate') await f.page.evaluate(() => window.storageTest.releaseEstimates());
    else await approve(f.page);
    await f.page.waitForFunction(() => !document.querySelector('#workFormPhotos').disabled);
    assert.equal(await f.page.locator('#confirmationDialog').isVisible(), false);
    assert.equal(await previews(f.page).count(), 0);
    assert.deepEqual(await saved(f.page), before);
  });

  await check('Review requested during an estimate can still use the outside-editor photo confirmation', async (f) => {
    await estimate(f.page, 'hold', low);
    await pick(f.page, [{ name: 'review-pending.png', size: mib }]);
    await poll(f.page, () => window.storageTest.releases.length === 1);
    await f.page.locator('#submitWorkFormButton').click();
    await f.page.evaluate(() => window.storageTest.releaseEstimates());
    await dialog(f.page);
    assert.equal(await f.page.locator('#confirmationDialogConfirmButton').isEnabled(), true);
    await approve(f.page);
    await f.page.locator('#workFormReviewPanel').waitFor({ state: 'visible' });
    await waitSaved(f.page, 1);
    assert.equal(await f.page.locator('#workFormStorageWarning').isVisible(), true);
    assert.deepEqual((await saved(f.page)).photoMetadata.map((photo) => photo.name), ['review-pending.png']);
  });

  await check('an expired pending autosave cannot overwrite a newer same-account draft after sign-in', async (f) => {
    const time = new Date('2026-10-02T12:00:00Z');
    await f.page.clock.install({ time });
    await f.page.clock.pauseAt(new Date(time.getTime() + 1));
    await estimate(f.page, 'hold', low);
    await pick(f.page, [{ name: 'expired-unaccepted.png', size: mib }]);
    await poll(f.page, () => window.storageTest.releases.length === 1);
    // Advance beyond the actual 650ms autosave debounce, but not the 1500ms
    // estimate timeout. The old save is now waiting on unaccepted photos.
    await f.page.clock.runFor(700);
    f.expire();
    await f.page.locator('#refreshHistoryButton').evaluate((button) => button.click());
    await poll(f.page, () => document.body.dataset.activeView === 'login');
    f.allowLogin();
    await f.page.locator('#emailInput').fill(worker.email);
    await f.page.locator('#passwordInput').fill('Only-an-isolated-fixture-password');
    await f.page.locator('#loginSubmitButton').evaluate((button) => button.click());
    await poll(f.page, () => document.body.dataset.activeView === 'worker');
    await f.page.locator('button.tab[data-tab-target="formTab"]').evaluate((button) => button.click());
    await poll(f.page, () => Boolean(document.querySelector('#workFormSelect option[value="81"]')));
    await f.page.locator('#workFormSelect').evaluate((select) => {
      select.value = '81'; select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await poll(f.page, () => Boolean(document.querySelector('#workFormField_notes')));
    const newest = 'Newer observations after same-account sign-in must win over an expired pending autosave.';
    await f.page.locator('#workFormField_notes').fill(newest);
    await f.page.locator('#submitWorkFormButton').evaluate((button) => button.click());
    await poll(f.page, async ({ key, newest }) => (await (await import('/assets/js/db.js')).get('drafts', key))?.value?.answers?.notes === newest,
      { key: draftKey, newest });
    const newer = await saved(f.page);
    await f.page.evaluate(() => window.storageTest.releaseEstimates());
    await f.page.clock.runFor(2000);
    await poll(f.page, () => !document.querySelector('#confirmationDialog').open);
    assert.deepEqual(await saved(f.page), newer, 'Old async work cannot checkpoint into a reopened same-account draft slot');
    assert.equal(newer.photoBlobs.length, 0);
  });

  for (const store of ['records', 'queue']) await check(`a ${store} quota failure during final submission keeps the clean draft and gives truthful recovery guidance`, async (f) => {
    await pick(f.page, [{ name: 'clean-draft-original.png', size: mib }]);
    await waitSaved(f.page, 1);
    await f.page.locator('#submitWorkFormButton').click();
    await f.page.locator('#workFormReviewPanel').waitFor({ state: 'visible' });
    const before = await saved(f.page);
    await f.page.evaluate((store) => { window.storageTest.failStore = store; }, store);
    await f.page.locator('#confirmWorkFormSubmitButton').click();
    await poll(f.page, (store) => window.storageTest.failedStores.includes(store), store);
    await poll(f.page, () => !document.querySelector('#workFormStorageWarning').hidden
      && document.querySelector('#workFormStorageWarning').textContent.includes('Storage stopped this submission'));
    assert.match(await f.page.locator('#workFormStorageWarning').innerText(), /check My Reports/i);
    assert.doesNotMatch(await f.page.locator('#workFormStorageWarning').innerText(), /not submitted|not saved/i,
      'A submission checkpoint failure must not falsely report that a previously saved draft or server Report was lost');
    assert.equal(await f.page.locator('#workFormStorageRetryButton').isVisible(), false,
      'A clean draft needs no draft-save retry; submission uncertainty requires checking My Reports');
    assert.deepEqual(await saved(f.page), before);
  });

  await check('an optimistic estimate cannot hide a real quota error; retry preserves saved and in-memory originals', async (f) => {
    await pick(f.page, [{ name: 'already-saved.png', size: mib }]);
    await waitSaved(f.page, 1);
    const before = await saved(f.page);
    const previousDeletes = await f.page.evaluate(() => window.storageTest.deletes);
    await f.page.evaluate(() => { window.storageTest.failDraft = true; });
    await pick(f.page, [{ name: 'not-yet-saved.png', size: 2 * mib }]);
    await f.page.locator('#workFormStorageRetryButton').waitFor({ state: 'visible' });
    assert.ok(await f.page.evaluate(() => window.storageTest.failures > 0), 'A real native IndexedDB write boundary rejected the save');
    assert.match(await f.page.locator('#workFormStorageWarning').innerText(), /not saved|could not.*save|couldn't.*save/i);
    assert.match(await f.page.locator('#workFormStorageWarning').innerText(), /keep.*(?:page|app).*open/i);
    assert.match(await f.page.locator('#workFormStorageWarning').innerText(), /(?:do not|don't).*(?:clear|delete)|(?:clear|delete).*browser/i);
    assert.equal(await previews(f.page).count(), 2, 'Failed save retains selected originals in the open editor');
    assert.deepEqual(await saved(f.page), before, 'Prior committed draft is not replaced on quota failure');
    await f.page.locator('#submitWorkFormButton').click();
    await f.page.locator('#workFormReviewPanel').waitFor({ state: 'visible' });
    assert.equal(await f.page.locator('#workFormStorageWarning').isVisible(), true);
    assert.equal(await f.page.locator('#workFormStorageRetryButton').isVisible(), true);
    await f.page.locator('#workFormStorageRetryButton').click();
    await f.page.waitForFunction(() => !document.querySelector('#workFormStorageRetryButton').disabled);
    assert.deepEqual(await saved(f.page), before, 'Another failed retry is non-destructive');
    await f.page.evaluate(() => { window.storageTest.failDraft = false; });
    await f.page.locator('#workFormStorageRetryButton').click();
    await waitSaved(f.page, 2);
    assert.deepEqual((await saved(f.page)).photoBlobs[0], before.photoBlobs[0]);
    const recoveredOriginal = await f.page.evaluate(async () => {
      const original = window.storageTest.originals.get('not-yet-saved.png');
      return { size: original.size, type: original.type, hash: await window.storageTest.hash(original) };
    });
    assert.deepEqual((await saved(f.page)).photoBlobs[1], recoveredOriginal,
      'Retry commits the newly added original byte-for-byte, not its preview');
    assert.deepEqual((await saved(f.page)).photoMetadata.map((photo) => photo.name), ['already-saved.png', 'not-yet-saved.png']);
    assert.equal(await f.page.locator('#workFormStorageRetryButton').isVisible(), false);
    assert.deepEqual(await f.page.evaluate(() => window.storageTest.deletes), previousDeletes,
      'Warnings and recovery never clear databases, drafts, queues or other saved work');
  });

  await check('retained Daywork quota failures preserve legacy autosave guidance without Report storage notices', async (f) => {
    const before = await saved(f.page);
    await f.page.evaluate(() => { window.storageTest.failDraft = true; });
    await f.page.locator('#workFormField_notes').fill('Unfinished retained Daywork must keep its existing save-failure guidance.');
    await poll(f.page, () => window.storageTest.failures > 0
      && document.querySelector('#workFormAutosaveStatus')?.classList.contains('error'));
    assert.equal(await f.page.locator('#workFormAutosaveStatus').innerText(),
      'Changes not saved. Keep this page open and try again.');
    assert.equal(await f.page.locator('#reportLocalStorageGuidance').isVisible(), false);
    assert.equal(await f.page.locator('#workFormStorageWarning').isVisible(), false);
    assert.equal(await f.page.locator('#workFormStorageRetryButton').isVisible(), false);
    assert.deepEqual(await saved(f.page), before, 'A failed retained save also preserves the last committed draft');
  }, { reportOnly: false });

  await check('retained Daywork keeps its legacy selection behavior without Report storage prompts', async (f) => {
    await estimate(f.page, 'value', low);
    await pick(f.page, [{ name: 'daywork.png', size: mib }]);
    await poll(f.page, () => document.querySelectorAll('#workFormPhotoPreview img').length === 1);
    assert.equal(await f.page.locator('#confirmationDialog').isVisible(), false);
    assert.equal(await f.page.locator('#reportLocalStorageGuidance').isVisible(), false);
    assert.equal(await f.page.locator('#workFormStorageWarning').isVisible(), false);
    assert.equal(await f.page.evaluate(() => window.storageTest.calls), 0);
  }, { reportOnly: false });

  await check('EN 320px light and ZH 390px dark warning dialogs/notices are accessible and unclipped', async (f) => {
    for (const { width, language, theme } of [{ width: 320, language: 'en', theme: 'light' }, { width: 390, language: 'zh', theme: 'dark' }]) {
      await f.page.setViewportSize({ width, height: 844 });
      await f.page.evaluate(async ({ language, theme }) => {
        document.documentElement.dataset.theme = theme;
        await (await import('/assets/js/i18n.js')).setLanguage(language);
      }, { language, theme });
      await estimate(f.page, 'value', low);
      await pick(f.page, [{ name: `phone-${language}.png`, size: mib }]);
      await f.page.locator('#confirmationDialog').waitFor({ state: 'visible' });
      await f.page.waitForFunction(() => document.activeElement?.id === 'confirmationDialogCancelButton');
      for (const selector of ['#confirmationDialogCancelButton', '#confirmationDialogConfirmButton']) {
        const box = await f.page.locator(selector).boundingBox();
        assert.ok(box.width >= 44 && box.height >= 44, 'Storage choice buttons keep 44px touch targets');
        assert.ok(box.x >= 0 && box.x + box.width <= width + 1, 'Buttons stay inside the viewport');
      }
      assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (language === 'zh') for (const selector of ['#confirmationDialogTitle', '#confirmationDialogDescription', '#confirmationDialogCancelButton', '#confirmationDialogConfirmButton']) {
        assert.match(await f.page.locator(selector).innerText(), /[\u3400-\u9fff]/);
      }
      await f.page.screenshot({ path: path.join(output, `storage-${width}-${language}-${theme}-dialog.png`), animations: 'disabled' });
      await approve(f.page);
      await waitSaved(f.page, language === 'en' ? 1 : 2);
      await f.page.locator('#workFormStorageWarning').scrollIntoViewIfNeeded();
      assert.equal(await f.page.locator('#workFormStorageWarning').isVisible(), true);
      if (language === 'zh') {
        assert.match(await f.page.locator('#workFormStorageWarning').innerText(), /[\u3400-\u9fff]/);
        assert.match(await f.page.locator('#reportLocalStorageGuidance').innerText(), /[\u3400-\u9fff]/);
      }
      assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await f.page.screenshot({ path: path.join(output, `storage-${width}-${language}-${theme}-notice.png`), animations: 'disabled' });
    }
  });
  console.log(`Passed ${groups} isolated real-app Report storage warning browser groups.`);
} finally { await browser.close(); }
