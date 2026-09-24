import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59982'; // Every request is intercepted; never contacts a backend.
const worker = { id: 73, department_id: 2, department_name: 'Mutual', role: 'worker',
  worker_class: 'normal', name: 'Startup test Worker', email: 'startup@example.invalid', status: 'active' };
const template = { id: 81, department_id: 2, name: 'Startup test Report', status: 'active',
  template_purpose: 'report', definition_version: 1,
  fields: [{ id: 'notes', label: 'Notes', type: 'textarea', required: true }] };
const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(browser, { photoCount = 2, queueReadFailure = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const firstUpload = deferred();
  const secondUpload = deferred();
  const finalSubmission = deferred();
  const requests = { uploads: 0, posts: [], history: 0 };
  const errors = [];
  let activeWorker = worker;
  let uploadFailure = 0;
  let uploadFailureHeaders = {};
  let uploadFailureAt = null;
  const durable = [];
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, origin, 'No external requests are permitted');
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated startup fixture</title>' });
    if (['/api/auth/refresh', '/api/auth/me'].includes(url.pathname)) return json(activeWorker);
    if (url.pathname === '/api/auth/login') return json({ user: activeWorker });
    if (url.pathname === '/api/auth/logout') return json({ message: 'Signed out' });
    if (url.pathname === '/api/departments') return json([{ id: 2, name: 'Mutual' }]);
    if (url.pathname === '/api/sites') return json([]);
    if (url.pathname === '/api/work-forms') {
      assert.equal(url.searchParams.get('purpose'), 'report');
      return json([template]);
    }
    if (url.pathname === '/api/my-form-submissions') {
      requests.history += 1;
      assert.equal(url.searchParams.get('purpose'), 'report');
      return json(durable.filter((item) => item.worker_id === activeWorker.id));
    }
    if (url.pathname === '/api/photo-uploads') {
      const number = ++requests.uploads;
      await (number === 1 ? firstUpload.promise : secondUpload.promise);
      if (uploadFailure && (uploadFailureAt == null || uploadFailureAt === number)) return route.fulfill({ status: uploadFailure, contentType: 'application/json',
        headers: uploadFailureHeaders, body: JSON.stringify({ detail: 'The startup fixture rejected this upload.' }) });
      return json({ url: `/uploads/startup-${number}.png` });
    }
    if (url.pathname === '/api/form-submissions') {
      const body = route.request().postDataJSON();
      requests.posts.push(body);
      await finalSubmission.promise;
      const report = { ...body, id: 901, worker_id: worker.id, worker_name: worker.name,
        form_name: template.name, fields: template.fields, submission_purpose: 'report',
        status: 'pending', workflow_status: 'submitted', created_at: new Date().toISOString() };
      durable.push(report);
      return json(report);
    }
    if (url.pathname.startsWith('/uploads/')) return route.fulfill({ contentType: 'image/png', body: Buffer.from(photo.split(',')[1], 'base64') });
    assert.ok(!url.pathname.startsWith('/api/'), `Unexpected API request: ${url.pathname}`);
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.resolve(root, relative);
    assert.ok(file.startsWith(`${root}${path.sep}`), 'Only repository fixture files may be served');
    let body = await readFile(file);
    const extension = path.extname(file);
    if (extension === '.js') {
      body = body.toString().replaceAll("import L from 'leaflet';", "import * as L from '/node_modules/leaflet/dist/leaflet-src.esm.js';")
        .replace(/^import 'leaflet\/dist\/leaflet\.css';?\r?\n/gm, '');
      if (queueReadFailure && url.pathname === '/assets/js/offline-submissions.js') {
        const boundary = "const queueItems = await getAll('queue');";
        assert.ok(body.includes(boundary), 'Controlled queue-read failure boundary must remain exact');
        body = body.replace(boundary, "throw new Error('Test IndexedDB queue read failed');");
      }
    }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
    return route.fulfill({ contentType: types[extension] || 'application/octet-stream', body });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/fixture`);
  await page.evaluate(async ({ worker, template, photo, photoCount }) => {
    const { saveSession } = await import('/assets/js/api-client.js');
    const { submitOfflineSubmission } = await import('/assets/js/offline-submissions.js');
    saveSession(worker);
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    const result = await submitOfflineSubmission({
      id: 'startup-queued-report', type: 'form', submissionPurpose: 'report',
      formId: template.id, formName: template.name, definitionVersion: template.definition_version,
      fields: template.fields, workDate: '2026-09-25', answers: { notes: 'Original queued Report' },
      photoDataUrls: Array.from({ length: photoCount }, () => photo),
      photoMetadata: Array.from({ length: photoCount }, (_, index) => ({ name: `Photo ${index + 1}.png` }))
    });
    if (!result.queued) throw new Error('Fixture must start as a durable offline submission');
  }, { worker, template, photo, photoCount });
  return { context, page, requests, errors, firstUpload, secondUpload, finalSubmission,
    setWorker(value) { activeWorker = value; },
    setUploadFailure(value, headers = {}, attempt = null) { uploadFailure = value; uploadFailureHeaders = headers; uploadFailureAt = attempt; },
    async close() { firstUpload.resolve(); secondUpload.resolve(); finalSubmission.resolve(); await context.close(); } };
}

async function waitUntil(check, message, timeout = 5000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function openWhileUploading(f) {
  await f.page.goto(origin);
  await waitUntil(() => f.requests.uploads === 1, 'Startup never began its queued upload');
  await f.page.waitForFunction(() => document.body.dataset.activeView === 'worker', null, { timeout: 1500 })
    .catch(() => { throw new Error('Worker screen remains hidden while the first queued upload is unresolved'); });
  assert.equal(f.requests.posts.length, 0, 'Opening must not claim an unfinished Report is submitted');
  assert.equal(await f.page.locator('#workFormSelect').isEnabled(), true, 'New Report controls are usable during replay');
}

async function queuedRecord(page) {
  return page.evaluate(async () => {
    const { get, getAll } = await import('/assets/js/db.js');
    return { record: await get('records', 'startup-queued-report'), queue: await getAll('queue') };
  });
}

async function signIn(page, user = worker) {
  await page.locator('#emailInput').fill(user.email);
  await page.locator('#passwordInput').fill('Only-an-isolated-test-password');
  await page.locator('#loginSubmitButton').click();
}

async function fillReadyReport(page, text) {
  // The editor intentionally stays inert while its device draft is read.
  // Playwright fill() may resolve on an inert textarea without entering text;
  // wait for the real editing boundary, then prove text exists before replay.
  await page.waitForFunction(() => !document.querySelector('#workFormSubmissionForm').inert
    && Boolean(document.querySelector('#workFormField_notes')));
  await page.locator('#workFormField_notes').fill(text);
  assert.equal(await page.locator('#workFormField_notes').inputValue(), text,
    'The preservation check must start with actual entered text');
}

async function captureProgressScreens(page) {
  const output = path.join(root, 'output', 'startup-sync.local');
  await mkdir(output, { recursive: true });
  const capture = async (name) => {
    await page.evaluate(() => window.scrollTo(0, 0));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
      'Progress layout must not introduce horizontal overflow on small phone widths');
    await page.screenshot({ path: path.join(output, name) });
  };
  if (await page.evaluate(() => document.documentElement.dataset.theme !== 'light')) await page.locator('#themeToggleButton').click();
  await capture('progress-390-en-light.png');
  await page.setViewportSize({ width: 320, height: 844 });
  await capture('progress-320-en-light.png');
  await page.locator('#languageToggleButton').click();
  await page.locator('#themeToggleButton').click();
  assert.match(await page.locator('#queueSyncMessage').innerText(), /[\u4e00-\u9fff]/, 'Progress text switches to Chinese');
  await capture('progress-320-zh-dark.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await capture('progress-390-zh-dark.png');
  await page.locator('#languageToggleButton').click();
  await page.locator('#themeToggleButton').click();
}

const browser = await chromium.launch({ headless: true });
try {
  const f = await fixture(browser);
  try {
    await openWhileUploading(f);
    const panel = f.page.locator('#queueSyncStatus');
    await panel.waitFor({ state: 'visible' });
    assert.equal(await f.page.locator('#queueSyncMessage').getAttribute('role'), 'status');
    assert.match(await panel.innerText(), /keep.*open/i);
    assert.match(await panel.innerText(), /0\s*(?:\/|of)\s*2/);
    assert.equal(await f.page.locator('#syncIndicator').getAttribute('data-state'), 'syncing');
    await captureProgressScreens(f.page);
    const discard = await f.page.evaluate(async () => {
      const { discardOfflineSubmission } = await import('/assets/js/offline-submissions.js');
      try { await discardOfflineSubmission('startup-queued-report'); return { rejected: false }; }
      catch (error) { return { rejected: true, message: error.message }; }
    });
    assert.equal(discard.rejected, true, 'An actively uploading Report cannot be discarded from a newly usable screen');
    assert.equal((await queuedRecord(f.page)).record.photoDataUrls.length, 2, 'Blocked discard retains both originals');
    await f.page.locator('button.tab[data-tab-target="historyTab"]').click();
    await f.page.locator('#historyTab').waitFor({ state: 'visible' });
    await f.page.locator('button.tab[data-tab-target="formTab"]').click();
    await f.page.locator('#workFormSelect').selectOption(String(template.id));
    await fillReadyReport(f.page, 'New unsent work entered while upload is pending');
    await f.page.evaluate(() => { window.startupInput = document.querySelector('#workFormField_notes'); });
    await f.page.evaluate(() => { window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('online')); });
    assert.equal(f.requests.uploads, 1, 'Repeated reconnect events join the existing replay');
    f.firstUpload.resolve();
    await waitUntil(() => f.requests.uploads === 2, 'Second upload did not start after checkpointing first');
    await f.page.waitForFunction(() => /1\s*(?:\/|of)\s*2/.test(document.querySelector('#queueSyncStatus')?.innerText || ''));
    const checkpoint = await f.page.evaluate(async () => {
      const { get } = await import('/assets/js/db.js');
      return (await get('records', 'startup-queued-report')).photoUrls;
    });
    assert.deepEqual(checkpoint, ['/uploads/startup-1.png'], 'Progress corresponds to durable evidence checkpoint');
    f.secondUpload.resolve();
    await waitUntil(() => f.requests.posts.length === 1, 'Final Report submission never started');
    assert.equal(await panel.isVisible(), true, 'Progress remains visible while final Report is saving');
    assert.match(await panel.innerText(), /sav|submitt|finish/i);
    f.finalSubmission.resolve();
    await f.page.waitForFunction(async () => {
      const { getAll } = await import('/assets/js/db.js');
      return (await getAll('queue')).length === 0;
    });
    await f.page.waitForFunction(() => document.querySelector('#syncIndicator')?.dataset.state !== 'syncing');
    assert.ok(f.requests.history >= 2, 'Completion refreshes durable history without rebuilding the editor');
    assert.equal(await f.page.locator('#workFormField_notes').inputValue(), 'New unsent work entered while upload is pending');
    assert.equal(await f.page.evaluate(() => document.querySelector('#workFormField_notes') === window.startupInput), true,
      'Completion must not replace the active form editor');
    assert.equal(await f.page.locator('#workFormField_notes').evaluate((element) => element === document.activeElement), true,
      'Completion must not steal editing focus');
    assert.equal(f.requests.posts.length, 1, 'Exactly one Report is created');
    assert.deepEqual(f.requests.posts[0].answers, { notes: 'Original queued Report' });
    assert.deepEqual(f.requests.posts[0].photo_urls, ['/uploads/startup-1.png', '/uploads/startup-2.png']);
    assert.deepEqual(f.errors, [], 'No unhandled startup or detached synchronization errors');
    console.log('ok - startup opens during upload, progress follows durable checkpoints, and completion preserves active edits/focus');
  } finally {
    await f.close();
  }

  const signedIn = await fixture(browser);
  try {
    await signedIn.page.evaluate(() => localStorage.removeItem('geo_user'));
    await signedIn.page.goto(origin);
    await signedIn.page.waitForFunction(() => document.body.dataset.activeView === 'login');
    assert.equal(signedIn.requests.uploads, 0, 'Anonymous startup must not replay a previous Worker queue');
    await signIn(signedIn.page);
    await waitUntil(() => signedIn.requests.uploads === 1, 'Login did not resume its Worker queue');
    await signedIn.page.waitForFunction(() => document.body.dataset.activeView === 'worker', null, { timeout: 1500 });
    assert.equal(await signedIn.page.locator('#workFormSelect').isEnabled(), true);
    await signedIn.page.locator('#queueSyncStatus').waitFor({ state: 'visible' });
    assert.equal(signedIn.requests.posts.length, 0);
    console.log('ok - explicit sign-in opens the Worker screen before queued evidence uploads finish');
  } finally {
    await signedIn.close();
  }

  const switched = await fixture(browser);
  try {
    await openWhileUploading(switched);
    await switched.page.locator('#logoutButton').click();
    await switched.page.waitForFunction(() => document.body.dataset.activeView === 'login');
    assert.equal(await switched.page.locator('#queueSyncStatus').isVisible(), false, 'Logout hides outgoing Worker progress immediately');
    const nextWorker = { ...worker, id: 74, name: 'Next test Worker', email: 'next-startup@example.invalid' };
    switched.setWorker(nextWorker);
    await signIn(switched.page, nextWorker);
    await switched.page.waitForFunction(() => document.body.dataset.activeView === 'worker', null, { timeout: 1500 });
    await switched.page.evaluate(() => {
      const panel = document.querySelector('#queueSyncStatus');
      window.observedQueueMessages = [panel.innerText];
      window.queueObserver = new MutationObserver(() => window.observedQueueMessages.push(panel.innerText));
      window.queueObserver.observe(panel, { subtree: true, childList: true, characterData: true });
    });
    switched.firstUpload.resolve();
    await switched.page.waitForFunction(async () => {
      const { get } = await import('/assets/js/db.js');
      return (await get('records', 'startup-queued-report')).syncStatus === 'queued';
    });
    const saved = await queuedRecord(switched.page);
    assert.equal(saved.record.ownerWorkerId, worker.id);
    assert.equal(saved.record.photoDataUrls.length, 2);
    assert.deepEqual(saved.record.photoUrls, ['/uploads/startup-1.png'], 'Only an already successful in-flight upload is checkpointed');
    assert.equal(saved.queue.length, 1, 'Outgoing Worker queue remains recoverable');
    assert.equal(switched.requests.uploads, 1, 'No next evidence uploads run as another Worker');
    assert.equal(switched.requests.posts.length, 0, 'No outgoing Worker Report is posted under the next session');
    assert.match(await switched.page.locator('#userContextName').innerText(), /Next test Worker/);
    await switched.page.waitForFunction(() => document.querySelector('#syncIndicator')?.dataset.state !== 'syncing');
    assert.equal(await switched.page.locator('#syncIndicator').getAttribute('data-state') === 'syncing', false);
    assert.equal(await switched.page.evaluate(() => window.observedQueueMessages.some((text) => /[01]\s*of\s*2/.test(text))), false,
      'Old upload callbacks cannot expose outgoing Worker progress to the next account');
    assert.equal(await switched.page.locator('#historyList').innerText().then((text) => text.includes('Original queued Report')), false,
      'The next Worker cannot see the outgoing Worker queued answers');
    assert.deepEqual(switched.errors, []);
    console.log('ok - logout/account switch clears progress and stops outgoing replay without dropping evidence or leaking answers');
  } finally {
    await switched.close();
  }

  const expired = await fixture(browser);
  try {
    await openWhileUploading(expired);
    await expired.page.locator('#workFormSelect').selectOption(String(template.id));
    await fillReadyReport(expired.page, 'Keep this new draft when upload authorization expires');
    expired.setUploadFailure(401);
    expired.firstUpload.resolve();
    await expired.page.waitForFunction(() => document.body.dataset.activeView === 'login');
    assert.equal(await expired.page.locator('#queueSyncStatus').isVisible(), false);
    const saved = await queuedRecord(expired.page);
    assert.equal(saved.queue.length, 1);
    assert.equal(saved.record.photoDataUrls.length, 2);
    assert.equal(saved.record.syncBlockedByAuth, true);
    assert.equal(expired.requests.posts.length, 0);
    const draft = await expired.page.evaluate(async () => {
      const { get } = await import('/assets/js/db.js');
      return (await get('drafts', 'work-form-draft:73:81'))?.value;
    });
    assert.equal(draft.answers.notes, 'Keep this new draft when upload authorization expires');
    assert.deepEqual(expired.errors, []);
    console.log('ok - background upload authorization failure returns to sign-in and saves concurrent editing without losing queued evidence');
  } finally {
    await expired.close();
  }

  const cooldown = await fixture(browser);
  try {
    await openWhileUploading(cooldown);
    cooldown.setUploadFailure(429, { 'Retry-After': '60' });
    cooldown.firstUpload.resolve();
    await cooldown.page.waitForFunction(() => /wait|retry|cool|paus/i.test(document.querySelector('#queueSyncMessage')?.innerText || ''));
    const text = await cooldown.page.locator('#queueSyncStatus').innerText();
    assert.match(text, /60/);
    assert.match(text, /keep.*open/i);
    assert.equal(await cooldown.page.locator('#workFormSelect').isEnabled(), true);
    assert.equal(cooldown.requests.posts.length, 0);
    assert.equal((await queuedRecord(cooldown.page)).record.photoDataUrls.length, 2);
    await cooldown.page.evaluate(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
      window.dispatchEvent(new Event('offline'));
    });
    await cooldown.page.waitForFunction(() => document.querySelector('#syncIndicator')?.dataset.state === 'offline');
    assert.match(await cooldown.page.locator('#queueSyncStatus').innerText(), /offline|reconnect/i);
    assert.equal(await cooldown.page.locator('#workFormSelect').isEnabled(), true);
    assert.deepEqual(cooldown.errors, []);
    console.log('ok - server cooldown is visible while the Worker screen remains usable and original evidence stays saved');
  } finally {
    await cooldown.close();
  }

  const noPhotos = await fixture(browser, { photoCount: 0 });
  try {
    await noPhotos.page.goto(origin);
    await waitUntil(() => noPhotos.requests.posts.length === 1, 'No-photo queued Report never reached final submission');
    await noPhotos.page.waitForFunction(() => document.body.dataset.activeView === 'worker', null, { timeout: 1500 });
    assert.equal(noPhotos.requests.uploads, 0);
    await noPhotos.page.locator('#queueSyncStatus').waitFor({ state: 'visible' });
    assert.match(await noPhotos.page.locator('#queueSyncMessage').innerText(), /finish|sav|submitt/i);
    assert.equal(await noPhotos.page.locator('#workFormSelect').isEnabled(), true);
    assert.equal((await queuedRecord(noPhotos.page)).queue.length, 1, 'No-photo final save is pending, not yet durable');
    noPhotos.finalSubmission.resolve();
    await noPhotos.page.waitForFunction(async () => {
      const { getAll } = await import('/assets/js/db.js');
      return (await getAll('queue')).length === 0;
    });
    assert.deepEqual(noPhotos.errors, []);
    console.log('ok - no-photo Report also opens immediately and shows final-submission progress until saved');
  } finally {
    await noPhotos.close();
  }

  const storageFailure = await fixture(browser, { queueReadFailure: true });
  try {
    await storageFailure.page.goto(origin);
    await storageFailure.page.waitForFunction(() => document.body.dataset.activeView === 'worker', null, { timeout: 1500 });
    await storageFailure.page.waitForFunction(() => document.querySelector('#queueSyncStatus')?.dataset.state === 'attention');
    assert.match(await storageFailure.page.locator('#queueSyncMessage').innerText(), /paus|retry/i);
    assert.equal(await storageFailure.page.locator('#workFormSelect').isEnabled(), true);
    assert.equal(storageFailure.requests.uploads, 0);
    assert.equal((await queuedRecord(storageFailure.page)).queue.length, 1);
    assert.deepEqual(storageFailure.errors, [], 'A rejected detached replay is handled, never an unhandled promise');
    console.log('ok - queue storage failure gives recoverable attention without blocking startup or dropping saved work');
  } finally {
    await storageFailure.close();
  }

  const relogin = await fixture(browser);
  try {
    await openWhileUploading(relogin);
    await relogin.page.locator('#logoutButton').click();
    await relogin.page.waitForFunction(() => document.body.dataset.activeView === 'login');
    await signIn(relogin.page);
    await relogin.page.waitForFunction(() => document.body.dataset.activeView === 'worker', null, { timeout: 1500 });
    relogin.setUploadFailure(401, {}, 1);
    relogin.firstUpload.resolve();
    await waitUntil(() => relogin.requests.uploads === 2, 'Fresh same-account login did not retry after stale authorization failure');
    assert.equal(await relogin.page.locator('body').getAttribute('data-active-view'), 'worker',
      'A stale upload authorization failure must not expire the replacement login');
    await relogin.page.waitForFunction(() => /0\s*of\s*2/.test(document.querySelector('#queueSyncStatus')?.innerText || ''));
    relogin.secondUpload.resolve();
    relogin.finalSubmission.resolve();
    await waitUntil(() => relogin.requests.posts.length === 1, 'Fresh login did not finish its Report after retrying evidence');
    await relogin.page.waitForFunction(async () => {
      const { getAll } = await import('/assets/js/db.js');
      return (await getAll('queue')).length === 0;
    });
    assert.equal(relogin.requests.posts.length, 1);
    assert.equal(await relogin.page.locator('body').getAttribute('data-active-view'), 'worker');
    assert.deepEqual(relogin.errors, []);
    console.log('ok - same-account re-login ignores stale authorization failure and retries under the fresh session exactly once');
  } finally {
    await relogin.close();
  }
} finally {
  await browser.close();
}
