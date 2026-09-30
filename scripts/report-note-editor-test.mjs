import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59966'; // Entire real app is intercepted; no server or cloud writes.
const output = path.join(root, 'output', 'report-note-editor.local');
const prefix = 'report-resolution-note:v1:';
const supervisor = { id: 74, role: 'supervisor', department_id: 2, department_name: 'Mutual',
  dashboard_department_id: 2, dashboard_department_name: 'Mutual', is_global_admin: true,
  name: 'Note Supervisor', email: 'notes@example.invalid', status: 'active' };
const worker = { id: 25, role: 'worker', worker_class: 'normal', department_id: 2,
  name: 'Note Worker', email: 'worker-notes@example.invalid', status: 'active' };
const templates = [{ id: 21, department_id: 2, name: 'Safety inspection', status: 'active',
  template_purpose: 'report', definition_version: 1,
  fields: [{ id: 'observations', type: 'textarea', label: 'Observations', required: true }] }];
const initialReports = [901, 902].map((id) => ({ id, kind: 'form', review_key: `form:${id}`,
  department_id: 2, department_name: 'Mutual', form_id: 21, form_name: `Inspection ${id}`,
  worker_id: 25, worker_name: 'Note Worker', submission_purpose: 'report',
  status: 'pending', workflow_status: 'in_review', durability: 'durable', read_only: false,
  work_date: '2026-10-01', created_at: '2026-10-01T01:00:00Z',
  review_started_at: '2026-10-01T01:05:00Z', reviewing_supervisor_id: 74,
  fields: templates[0].fields, answers: { observations: `Evidence for Report ${id}` },
  photo_urls: [], photo_metadata: [], supervisor_note: null, resolved_at: null }));

function installBrowserBoundaries() {
  window.noteStorageFailure = false;
  window.noteClearFailure = false;
  window.noteReadFailure = false;
  window.noteWriteHold = false;
  window.noteWriteHoldReached = false;
  window.serviceWorkerMessages = [];
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, ...args) {
    if (this.name === 'drafts' && String(value?.key || '').startsWith('report-resolution-note:v1:')
      && (window.noteStorageFailure || (window.noteClearFailure && (value?.deleted || value?.finalized)))) {
      throw new DOMException('Private note storage is temporarily unavailable', 'QuotaExceededError');
    }
    const result = originalPut.call(this, value, ...args);
    if (window.noteWriteHold && this.name === 'drafts' && String(value?.key || '').startsWith('report-resolution-note:v1:')) {
      window.noteWriteHoldReached = true;
      // Real extra IDB requests keep this transaction alive. The native write
      // request may succeed, but the application must await transaction commit.
      const keepAlive = () => {
        const read = originalGet.call(this, value.key);
        read.onsuccess = () => { if (window.noteWriteHold) keepAlive(); };
      };
      keepAlive();
    }
    return result;
  };
  const originalGet = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function (key) {
    if (window.noteReadFailure && this.name === 'drafts' && String(key).startsWith('report-resolution-note:v1:')) {
      throw new DOMException('Private note could not be read', 'InvalidStateError');
    }
    return originalGet.call(this, key);
  };
  const waiting = { state: 'installed', addEventListener() {}, postMessage(message) {
    window.serviceWorkerMessages.push(message);
  } };
  Object.defineProperty(Navigator.prototype, 'serviceWorker', { configurable: true,
    get: () => ({ controller: {}, addEventListener() {}, async register() {
      return { waiting, installing: null, addEventListener() {} };
    } }) });
}

async function fixture(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  context.setDefaultTimeout(10000);
  await context.addInitScript(installBrowserBoundaries);
  const reports = structuredClone(initialReports);
  const errors = [], unexpected = [], transitions = [], queries = [];
  let currentUser = structuredClone(supervisor), signedIn = true, queueFailure = 0, transitionFailure = 0;
  let failQueueAfterResolution = false;
  let holdTransition = false, releaseTransition = null;
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) { unexpected.push(url.href); return route.abort(); }
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Private note fixture</title>' });
    if (['/api/auth/me', '/api/auth/refresh'].includes(url.pathname)) return signedIn
      ? json(currentUser) : json({ detail: 'Fixture signed out' }, 401);
    if (url.pathname === '/api/auth/login') { signedIn = true; return json({ user: currentUser }); }
    if (url.pathname === '/api/auth/logout') { signedIn = false; return json({ message: 'Signed out' }); }
    if (url.pathname === '/api/departments') return json([{ id: 2, name: 'Mutual' }, { id: 3, name: 'Other Department' }]);
    if (url.pathname === '/api/sites') return json([]);
    if (url.pathname === '/api/work-forms') {
      assert.equal(url.searchParams.get('purpose'), 'report');
      return json(templates);
    }
    if (url.pathname === '/api/supervisor/users') return json([worker, currentUser]);
    if (['/api/supervisor/audit-events', '/api/supervisor/trash', '/api/my-form-submissions'].includes(url.pathname)) return json([]);
    if (url.pathname === '/api/supervisor/review-queue') {
      const query = Object.fromEntries(url.searchParams);
      queries.push(query);
      assert.equal(query.purpose, 'report');
      if (queueFailure) return json({ detail: 'Fixture Report refresh is unavailable' }, queueFailure);
      const items = reports.filter((record) => (!query.department_id || String(record.department_id) === query.department_id)
        && (!query.form_id || String(record.form_id) === query.form_id)
        && (!query.worker_id || String(record.worker_id) === query.worker_id)
        && (!query.workflow_status || record.workflow_status === query.workflow_status)
        && (!query.record_date || record.work_date === query.record_date)
        && (!query.search || JSON.stringify(record).includes(query.search)));
      return json({ items, counts: { total: items.length }, summary_counts: { total: items.length },
        has_more: false, next_cursor: null, snapshot_at: '2026-10-01T02:00:00Z' });
    }
    const transition = url.pathname.match(/^\/api\/supervisor\/form-submissions\/(\d+)\/transition$/);
    if (transition) {
      assert.equal(request.method(), 'POST');
      const body = request.postDataJSON();
      transitions.push({ id: Number(transition[1]), ...body });
      if (holdTransition) await new Promise((resolve) => { releaseTransition = resolve; });
      if (transitionFailure) return json({ detail: 'Fixture resolution could not be confirmed' }, transitionFailure);
      const record = reports.find((item) => item.id === Number(transition[1]));
      if (record.workflow_status === 'resolved') return json({ detail: 'Report already resolved' }, 409);
      record.workflow_status = body.status;
      record.supervisor_note = body.supervisor_note;
      record.resolved_at = body.status === 'resolved' ? '2026-10-01T02:00:00Z' : null;
      if (failQueueAfterResolution && body.status === 'resolved') queueFailure = 503;
      return json(record);
    }
    if (url.pathname === '/api/auth/default-department') {
      currentUser.dashboard_department_id = request.postDataJSON().department_id;
      return json(currentUser);
    }
    if (url.pathname.startsWith('/api/')) {
      unexpected.push(`${request.method()} ${url.pathname}`);
      return json({ detail: 'Unexpected isolated fixture request' }, 500);
    }
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    const filename = path.resolve(root, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    assert.ok(filename.startsWith(`${root}${path.sep}`), 'Fixture serves repository files only');
    let body = await readFile(filename);
    const extension = path.extname(filename);
    if (extension === '.js') body = body.toString()
      .replaceAll("import L from 'leaflet';", "import * as L from '/node_modules/leaflet/dist/leaflet-src.esm.js';")
      .replace(/^import 'leaflet\/dist\/leaflet\.css';?\r?\n/gm, '');
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
      '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
    return route.fulfill({ contentType: types[extension] || 'application/octet-stream', body });
  });
  function observe(page) {
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => {
      if (dialog.type() !== 'beforeunload') errors.push(`Unexpected ${dialog.type()} dialog`);
      void dialog.accept();
    });
  }
  const page = await context.newPage();
  observe(page);
  await page.goto(`${origin}/fixture`);
  await page.evaluate(async (user) => (await import('/assets/js/api-client.js')).saveSession(user), currentUser);
  await page.goto(origin);
  await ready(page);
  return { context, page, reports, errors, transitions, queries,
    setUser(value) { currentUser = structuredClone(value); },
    failQueue(status = 503) { queueFailure = status; },
    failTransition(status = 503) { transitionFailure = status; },
    failRefreshAfterResolution() { failQueueAfterResolution = true; },
    holdTransition() { holdTransition = true; },
    releaseTransition() { holdTransition = false; releaseTransition?.(); releaseTransition = null; },
    async newPage() { const extra = await context.newPage(); observe(extra); await extra.goto(origin); await ready(extra); return extra; },
    async close() {
      releaseTransition?.();
      await context.close();
      assert.deepEqual(errors, [], 'No unhandled app errors');
      assert.deepEqual(unexpected, [], 'No external or unexpected API requests');
    }
  };
}

async function ready(page) {
  await page.locator('#supervisorView').waitFor({ state: 'visible' });
  await page.locator('#reviewQueueList [data-record-key="form:901"]').waitFor();
}
async function openNote(page, id = 901, { readOnly = false } = {}) {
  if (!await page.locator('#adminReviewWorkspace').isVisible()) await workspace(page, 'review');
  const item = page.locator(`#reviewQueueList [data-record-key="form:${id}"]`);
  if (!await item.isVisible()) await page.locator('#reviewQueueBackButton').click();
  await item.click();
  await page.locator('#reviewQueueActions').getByRole('button', { name: /^(Resolve report|Continue note|View saved note)$/ }).first().click();
  await page.locator('#reportNotePanel').waitFor({ state: 'visible' });
  await page.waitForFunction((readOnly) => {
    const field = document.querySelector('#reportResolutionNote');
    const reload = document.querySelector('#reloadReportNoteButton');
    const failedReadReady = readOnly && reload && !reload.hidden && !reload.disabled;
    return field && ((!field.disabled && (readOnly || !field.readOnly)) || failedReadReady)
      && !field.closest('[inert]');
  }, readOnly);
}
async function workspace(page, name) {
  const visible = page.locator(`[data-admin-workspace-target="${name}"]:visible`).first();
  if (!await visible.count()) await page.locator('#adminMobileMenuButton').click();
  await page.locator(`[data-admin-workspace-target="${name}"]:visible`).first().click();
}
async function rows(page) {
  return page.evaluate(async (keyPrefix) => (await (await import('/assets/js/db.js')).getAll('drafts'))
    .filter((row) => String(row.key).startsWith(keyPrefix)), prefix);
}
async function saved(page, text) {
  await page.waitForFunction(async ({ keyPrefix, expected }) => {
    const entries = await (await import('/assets/js/db.js')).getAll('drafts');
    return entries.some((row) => String(row.key).startsWith(keyPrefix) && !row.deleted
      && (row.value?.text === expected || row.text === expected));
  }, { keyPrefix: prefix, expected: text });
}
async function logIn(page) {
  await page.locator('#emailInput').fill('notes@example.invalid');
  await page.locator('#passwordInput').fill('Only-an-isolated-test-password');
  await page.locator('#loginSubmitButton').click();
}
async function closeNote(page) {
  await page.locator('#closeReportNoteButton').click();
  await page.locator('#reportNotePanel').waitFor({ state: 'hidden' });
}
async function waitTransitions(f, count) {
  await f.page.waitForFunction(() => !document.querySelector('#resolveReportNoteButton')?.getAttribute('aria-busy'));
  for (let attempt = 0; attempt < 100 && f.transitions.length < count; attempt++) await f.page.waitForTimeout(20);
  assert.equal(f.transitions.length, count);
}

const browser = await chromium.launch({ headless: true });
const only = process.env.REPORT_NOTE_TEST_ONLY || '';
let passed = 0;
async function test(name, body) {
  if (only && !name.includes(only)) return;
  const f = await fixture(browser);
  try { await body(f); passed++; console.log(`ok - ${name}`); }
  finally { await f.close(); }
}

try {
  await mkdir(output, { recursive: true });
  await test('raw resolution notes survive close, reopen, reload and Report switching without submission', async (f) => {
    const text = '  Unfinished <script>literal</script>\nFinal detail is still pending.  ';
    await openNote(f.page);
    assert.equal(await f.page.locator('#reportResolutionNote').getAttribute('maxlength'), '1000');
    await f.page.locator('#reportResolutionNote').fill(text);
    await closeNote(f.page);
    await saved(f.page, text);
    await openNote(f.page, 902);
    assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), '');
    await f.page.locator('#reportResolutionNote').fill('A different Report note');
    await closeNote(f.page);
    await openNote(f.page);
    assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), text);
    await workspace(f.page, 'forms');
    await workspace(f.page, 'review');
    assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), text, 'Workspace navigation keeps the live note');
    await f.page.reload();
    await ready(f.page);
    await openNote(f.page);
    assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), text);
    assert.equal(f.transitions.length, 0, 'Draft actions never resolve a Report');
  });

  await test('failed device saves preserve input and block close, logout and Update App', async (f) => {
    await openNote(f.page);
    await f.page.evaluate(() => { window.noteStorageFailure = true; });
    const text = 'Keep this unsaved resolution note visible';
    await f.page.locator('#reportResolutionNote').fill(text);
    await f.page.locator('#closeReportNoteButton').click();
    assert.equal(await f.page.locator('#reportNotePanel').isVisible(), true);
    assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), text);
    await f.page.locator('#retryReportNoteSaveButton').waitFor({ state: 'visible' });
    assert.equal(await f.page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }), true, 'Uncommitted text requests the browser unload warning');
    await f.page.locator('#logoutButton').click();
    assert.equal(await f.page.locator('#supervisorView').isVisible(), true);
    assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), text);
    await f.page.locator('#updateButton').waitFor({ state: 'visible' });
    await f.page.locator('#updateButton').click();
    await f.page.locator('#appUpdatePausedDialog[open]').waitFor();
    assert.equal(await f.page.evaluate(() => window.serviceWorkerMessages.length), 0);
    await f.page.locator('#keepEditingWorkFormButton').click();
    await f.page.locator('#reportNotePanel').waitFor({ state: 'visible' });
    assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), text);
    await f.page.evaluate(() => { window.noteStorageFailure = false; });
    await f.page.locator('#retryReportNoteSaveButton').click();
    await saved(f.page, text);
    await closeNote(f.page);
    assert.equal(await f.page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }), false, 'A committed closed note no longer blocks unloading');
  });

  await test('private notes survive logout only for their own Supervisor and never render for a Worker', async (f) => {
    await openNote(f.page);
    const text = 'Private note belonging only to Supervisor 74';
    await f.page.locator('#reportResolutionNote').fill(text);
    await f.page.locator('#logoutButton').click();
    await f.page.locator('#loginView').waitFor({ state: 'visible' });
    assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), '', 'Signed-out DOM removes private note text');
    f.setUser(worker);
    await logIn(f.page);
    await f.page.locator('#workerView').waitFor({ state: 'visible' });
    assert.equal(await f.page.locator('#reportNotePanel').isVisible(), false);
    assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), '');
    await f.page.locator('#logoutButton').click();
    await f.page.locator('#loginView').waitFor({ state: 'visible' });
    f.setUser({ ...supervisor, id: 75, email: 'other-notes@example.invalid' });
    await logIn(f.page);
    await ready(f.page);
    await openNote(f.page);
    assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), '', 'Other Supervisor cannot restore note');
    await f.page.locator('#logoutButton').click();
    await f.page.locator('#loginView').waitFor({ state: 'visible' });
    f.setUser(supervisor);
    await logIn(f.page);
    await ready(f.page);
    await openNote(f.page);
    assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), text);
  });

  await test('opening another Report cannot replace an unsaved note when device storage fails', async (f) => {
    await openNote(f.page);
    const text = 'Report 901 must not be replaced by Report 902';
    await f.page.evaluate(() => { window.noteStorageFailure = true; });
    await f.page.locator('#reportResolutionNote').fill(text);
    await f.page.locator('#reviewQueueList [data-record-key="form:902"]').click();
    await f.page.locator('#reviewQueueActions').getByRole('button', { name: 'Resolve report', exact: true }).click();
    await f.page.locator('#reportNotePanel').waitFor({ state: 'visible' });
    assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), text);
    assert.match(await f.page.locator('#reportNoteIdentity').innerText(), /901/);
    assert.equal(f.transitions.length, 0);
    await f.page.evaluate(() => { window.noteStorageFailure = false; });
    await f.page.locator('#retryReportNoteSaveButton').click();
    await saved(f.page, text);
    await closeNote(f.page);
    await openNote(f.page, 902);
    assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), '');
  });

  await test('an app update waits for the latest note text to commit before activating', async (f) => {
    await openNote(f.page);
    const text = 'Latest note typed immediately before Update App';
    await f.page.locator('#reportResolutionNote').fill(text);
    await f.page.locator('#updateButton').click();
    await f.page.waitForFunction(() => window.serviceWorkerMessages.some((message) => message.type === 'SKIP_WAITING'));
    assert.equal((await rows(f.page)).some((row) => row.value?.text === text || row.text === text), true);
    assert.equal(f.transitions.length, 0);
  });

  await test('closing waits for a held native transaction and saves text entered during the pending write', async (f) => {
    await openNote(f.page);
    await f.page.evaluate(() => { window.noteWriteHold = true; });
    await f.page.locator('#reportResolutionNote').fill('First captured value');
    await f.page.waitForFunction(() => window.noteWriteHoldReached);
    await f.page.locator('#reportResolutionNote').fill('Latest text entered while the first transaction is pending');
    await f.page.locator('#closeReportNoteButton').click();
    assert.equal(await f.page.locator('#reportNotePanel').isVisible(), true);
    assert.equal(await f.page.locator('#closeReportNoteButton').isDisabled(), true);
    await f.page.evaluate(() => { window.noteWriteHold = false; });
    await f.page.locator('#reportNotePanel').waitFor({ state: 'hidden' });
    await saved(f.page, 'Latest text entered while the first transaction is pending');
    await openNote(f.page);
    assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), 'Latest text entered while the first transaction is pending');
    assert.equal(f.transitions.length, 0);
  });

  await test('changed home Department and revoked global capability cannot restore a prior private note', async (f) => {
    await openNote(f.page);
    const text = 'Private note in the original exact account scope';
    await f.page.locator('#reportResolutionNote').fill(text);
    await saved(f.page, text);
    for (const user of [
      { ...supervisor, department_id: 3, department_name: 'Other Department' },
      { ...supervisor, is_global_admin: false }
    ]) {
      await f.page.locator('#logoutButton').click();
      await f.page.locator('#loginView').waitFor({ state: 'visible' });
      f.setUser(user);
      await logIn(f.page);
      await ready(f.page);
      await openNote(f.page);
      assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), '');
    }
    assert.equal((await rows(f.page)).some((row) => row.text === text), true, 'Hidden original is not deleted');
    assert.equal(f.transitions.length, 0);
  });

  await test('failed resolution preserves the note and requires explicit refreshed state before retry', async (f) => {
    await openNote(f.page);
    const text = '  Verified details and resolution evidence.  ';
    await f.page.locator('#reportResolutionNote').fill(text);
    f.failTransition();
    await f.page.locator('#resolveReportNoteButton').click();
    await waitTransitions(f, 1);
    await f.page.locator('#refreshReportNoteButton').waitFor({ state: 'visible' });
    assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), text);
    await saved(f.page, text);
    assert.equal(await f.page.locator('#resolveReportNoteButton').isDisabled(), true);
    f.failTransition(0);
    const prior = f.queries.length;
    await f.page.locator('#refreshReportNoteButton').click();
    await f.page.waitForFunction(() => !document.querySelector('#resolveReportNoteButton').disabled);
    const refresh = f.queries.slice(prior).find((query) => query.kind === 'form' && query.form_id === '21');
    assert.ok(refresh, 'Explicit refresh requests the Report scope rather than relying on a filtered queue');
    assert.equal(refresh.purpose, 'report');
    assert.equal(refresh.department_id, '2');
    assert.equal(refresh.worker_id, '25');
    assert.equal(refresh.record_date, '2026-10-01');
    await f.page.locator('#resolveReportNoteButton').click();
    await waitTransitions(f, 2);
    assert.equal(f.transitions[1].supervisor_note, text.trim());
    await f.page.waitForFunction(async (keyPrefix) => !(await (await import('/assets/js/db.js')).getAll('drafts'))
      .some((row) => String(row.key).startsWith(keyPrefix) && !row.deleted && !row.finalized && (row.value?.text || row.text)), prefix);
    assert.equal(f.reports[0].workflow_status, 'resolved');
  });

  await test('a Report resolved elsewhere leaves the private draft read-only without overwriting the official note', async (f) => {
    await openNote(f.page);
    const text = 'Unfinished local wording, not the official resolution';
    await f.page.locator('#reportResolutionNote').fill(text);
    await closeNote(f.page);
    f.reports[0].workflow_status = 'resolved';
    f.reports[0].supervisor_note = 'Official note from another Supervisor';
    f.reports[0].resolved_at = '2026-10-01T02:10:00Z';
    await f.page.locator('#refreshSupervisorButton').click();
    await f.page.locator('#reviewQueueDetail .report-supervisor-note').filter({ hasText: 'Official note from another Supervisor' }).waitFor();
    await openNote(f.page, 901, { readOnly: true });
    if (await f.page.locator('#refreshReportNoteButton').isVisible()) await f.page.locator('#refreshReportNoteButton').click();
    await f.page.waitForFunction(() => document.querySelector('#resolveReportNoteButton').disabled);
    assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), text);
    assert.equal(f.transitions.length, 0);
    assert.equal(f.reports[0].supervisor_note, 'Official note from another Supervisor');
  });

  await test('successful resolution stays final when local cleanup fails', async (f) => {
    await openNote(f.page);
    const text = 'Official resolution accepted even though device cleanup fails';
    await f.page.locator('#reportResolutionNote').fill(text);
    await saved(f.page, text);
    await f.page.evaluate(() => { window.noteClearFailure = true; });
    await f.page.locator('#resolveReportNoteButton').click();
    await waitTransitions(f, 1);
    assert.equal(f.reports[0].workflow_status, 'resolved');
    assert.equal(f.reports[0].supervisor_note, text);
    assert.equal((await rows(f.page)).some((row) => row.text === text), true, 'Cleanup error does not hide the retained draft');
    if (await f.page.locator('#reportNotePanel').isVisible()) {
      assert.equal(await f.page.locator('#resolveReportNoteButton').isDisabled(), true, 'Known accepted resolution cannot be retried');
    }
    await f.page.reload();
    await ready(f.page);
    await openNote(f.page, 901, { readOnly: true });
    assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), text);
    assert.equal(await f.page.locator('#resolveReportNoteButton').isDisabled(), true);
    assert.equal(f.transitions.length, 1, 'Reloading a retained final note does not replay the transition');
  });

  await test('a failed queue refresh after successful resolution cannot revive or resubmit the note', async (f) => {
    await openNote(f.page);
    const text = 'Successfully accepted before the queue refresh failed';
    await f.page.locator('#reportResolutionNote').fill(text);
    f.failRefreshAfterResolution();
    await f.page.locator('#resolveReportNoteButton').click();
    await waitTransitions(f, 1);
    await f.page.waitForFunction(async (keyPrefix) => (await (await import('/assets/js/db.js')).getAll('drafts'))
      .some((row) => String(row.key).startsWith(keyPrefix) && row.finalized), prefix);
    assert.equal(f.reports[0].workflow_status, 'resolved');
    if (await f.page.locator('#reportNotePanel').isVisible()) {
      assert.equal(await f.page.locator('#resolveReportNoteButton').isDisabled(), true);
    }
    f.failQueue(0);
    await f.page.reload();
    await ready(f.page);
    await f.page.locator('#reviewQueueList [data-record-key="form:901"]').click();
    assert.equal(await f.page.locator('#reviewQueueActions button:visible').filter({ hasText: /^(Resolve report|Continue note|View saved note)$/ }).count(), 0);
    assert.equal(f.transitions.length, 1);
  });

  await test('offline read-only refresh keeps unfinished text and prevents resolution', async (f) => {
    await openNote(f.page);
    const text = 'Keep this note until the Report can be revalidated';
    await f.page.locator('#reportResolutionNote').fill(text);
    await saved(f.page, text);
    f.failQueue();
    await f.page.locator('#refreshSupervisorButton').click();
    await f.page.locator('.review-queue-read-only').waitFor();
    assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), text);
    assert.equal(await f.page.locator('#resolveReportNoteButton').isDisabled(), true);
    assert.equal(f.transitions.length, 0);
    await saved(f.page, text);
    f.failQueue(0);
    await f.page.locator('#refreshReportNoteButton').click();
    await f.page.waitForFunction(() => !document.querySelector('#resolveReportNoteButton').disabled);
    assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), text);
    assert.equal(f.transitions.length, 0, 'Refreshing a recovered connection does not resolve the Report');
  });

  await test('auth expiry clears private UI and a late transition cannot repaint another account', async (f) => {
    await openNote(f.page);
    const text = 'Old account note during a slow resolution';
    await f.page.locator('#reportResolutionNote').fill(text);
    await saved(f.page, text);
    f.holdTransition();
    await f.page.locator('#resolveReportNoteButton').click();
    for (let attempt = 0; attempt < 100 && f.transitions.length < 1; attempt++) await f.page.waitForTimeout(20);
    assert.equal(f.transitions.length, 1);
    f.failQueue(401);
    await f.page.locator('#refreshSupervisorButton').click();
    await f.page.locator('#loginView').waitFor({ state: 'visible' });
    assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), '');
    f.failQueue(0);
    f.setUser({ ...supervisor, id: 75, email: 'other-notes@example.invalid' });
    await logIn(f.page);
    await ready(f.page);
    await openNote(f.page, 902);
    await f.page.locator('#reportResolutionNote').fill('New account independent note');
    await saved(f.page, 'New account independent note');
    f.releaseTransition();
    await f.page.waitForTimeout(150);
    assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), 'New account independent note');
    assert.equal(await f.page.locator('#reportNotePanel').isVisible(), true);
    assert.equal((await rows(f.page)).some((row) => row.text === 'New account independent note'), true);
  });

  await test('two tabs cannot overwrite a newer private note revision', async (f) => {
    await openNote(f.page);
    await f.page.locator('#reportResolutionNote').fill('Common starting note');
    await saved(f.page, 'Common starting note');
    const other = await f.newPage();
    await openNote(other);
    assert.equal(await other.locator('#reportResolutionNote').inputValue(), 'Common starting note');
    await f.page.locator('#reportResolutionNote').fill('First tab newer note');
    await saved(f.page, 'First tab newer note');
    await other.locator('#reportResolutionNote').fill('Second tab competing note');
    await other.locator('#closeReportNoteButton').click();
    assert.equal(await other.locator('#reportNotePanel').isVisible(), true);
    assert.equal(await other.locator('#reportResolutionNote').inputValue(), 'Second tab competing note');
    const entries = await rows(f.page);
    assert.equal(entries.some((row) => row.value?.text === 'First tab newer note' || row.text === 'First tab newer note'), true);
    assert.equal(entries.some((row) => row.value?.text === 'Second tab competing note' || row.text === 'Second tab competing note'), false);
    assert.equal(f.transitions.length, 0);
  });

  await test('an unchanged but stale tab must pass revision validation before resolving', async (f) => {
    await openNote(f.page);
    await f.page.locator('#reportResolutionNote').fill('Original shared draft');
    await saved(f.page, 'Original shared draft');
    const other = await f.newPage();
    await openNote(other);
    assert.equal(await other.locator('#reportResolutionNote').inputValue(), 'Original shared draft');
    await f.page.locator('#reportResolutionNote').fill('Newer first-tab draft');
    await saved(f.page, 'Newer first-tab draft');
    await other.locator('#resolveReportNoteButton').click();
    await other.locator('#reloadReportNoteButton').waitFor({ state: 'visible' });
    assert.equal(await other.locator('#reportResolutionNote').inputValue(), 'Original shared draft');
    assert.equal(await other.locator('#resolveReportNoteButton').isDisabled(), true);
    assert.equal((await rows(f.page)).some((row) => row.text === 'Newer first-tab draft'), true);
    assert.equal(f.transitions.length, 0, 'Fresh workflow alone is insufficient: the saved note revision must still match');
  });

  await test('successful resolution cleanup cannot delete a newer note saved by another tab', async (f) => {
    await openNote(f.page);
    await f.page.locator('#reportResolutionNote').fill('First tab submitted wording');
    await saved(f.page, 'First tab submitted wording');
    f.holdTransition();
    await f.page.locator('#resolveReportNoteButton').click();
    for (let attempt = 0; attempt < 100 && f.transitions.length < 1; attempt++) await f.page.waitForTimeout(20);
    assert.equal(f.transitions.length, 1, 'Start the race only after the first tab reserved its submitted revision');
    const other = await f.newPage();
    await openNote(other);
    await other.locator('#reportResolutionNote').fill('Newer private revision while first response is pending');
    await saved(other, 'Newer private revision while first response is pending');
    f.releaseTransition();
    await f.page.waitForFunction(() => /Report resolved/.test(document.querySelector('#reportNoteStatus')?.textContent || ''));
    const entries = await rows(f.page);
    assert.equal(entries.some((row) => row.text === 'Newer private revision while first response is pending' && !row.deleted), true);
    assert.equal(await f.page.locator('#resolveReportNoteButton').isDisabled(), true);
    assert.equal(f.reports[0].supervisor_note, 'First tab submitted wording');
    await other.locator('#resolveReportNoteButton').click();
    await other.waitForFunction(() => document.querySelector('#resolveReportNoteButton').disabled
      && /resolved|can no longer/i.test(document.querySelector('#reportNoteStatus')?.textContent || ''));
    assert.equal(f.transitions.length, 1, 'Fresh workflow validation prevents the other tab from overwriting the final note');
  });

  await test('failed draft reads keep editing disabled until an explicit successful reload', async (f) => {
    await openNote(f.page);
    const text = 'Previously saved note must not be overwritten with an empty failed read';
    await f.page.locator('#reportResolutionNote').fill(text);
    await closeNote(f.page);
    await f.page.reload();
    await ready(f.page);
    await f.page.evaluate(() => { window.noteReadFailure = true; });
    await openNote(f.page, 901, { readOnly: true });
    await f.page.locator('#reloadReportNoteButton').waitFor({ state: 'visible' });
    assert.equal(await f.page.locator('#reportResolutionNote').isDisabled(), true);
    assert.equal(await f.page.locator('#resolveReportNoteButton').isDisabled(), true);
    assert.equal((await rows(f.page)).some((row) => row.text === text), true);
    await closeNote(f.page);
    assert.equal((await rows(f.page)).some((row) => row.text === text), true, 'Closing a failed read does not erase unread saved text');
    await openNote(f.page, 901, { readOnly: true });
    await f.page.locator('#logoutButton').click();
    await f.page.locator('#loginView').waitFor({ state: 'visible' });
    assert.equal((await rows(f.page)).some((row) => row.text === text), true, 'No user input means an unread row does not trap logout');
    await logIn(f.page);
    await ready(f.page);
    await openNote(f.page, 901, { readOnly: true });
    await f.page.locator('#reloadReportNoteButton').waitFor({ state: 'visible' });
    await f.page.waitForFunction(() => !document.querySelector('#reloadReportNoteButton').disabled);
    await f.page.evaluate(() => { window.noteReadFailure = false; });
    await f.page.locator('#reloadReportNoteButton').click();
    await f.page.waitForFunction((text) => {
      const field = document.querySelector('#reportResolutionNote');
      return !field.disabled && !field.readOnly && field.value === text;
    }, text);
    assert.equal(f.transitions.length, 0);
  });

  await test('discard requires confirmation and clears only the private draft', async (f) => {
    await openNote(f.page);
    const text = 'Draft to explicitly discard';
    await f.page.locator('#reportResolutionNote').fill(text);
    await saved(f.page, text);
    await f.page.locator('#discardReportNoteButton').click();
    await f.page.locator('#confirmationDialog[open]').waitFor();
    await f.page.locator('#confirmationDialogCancelButton').click();
    assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), text);
    assert.equal((await rows(f.page)).some((row) => row.text === text), true);
    await f.page.locator('#discardReportNoteButton').click();
    await f.page.locator('#confirmationDialog[open]').waitFor();
    await f.page.locator('#confirmationDialogConfirmButton').click();
    await f.page.locator('#reportNotePanel').waitFor({ state: 'hidden' });
    assert.equal((await rows(f.page)).some((row) => row.deleted && !row.finalized && row.text === ''), true);
    await openNote(f.page);
    assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), '');
    assert.equal(f.reports[0].workflow_status, 'in_review');
    assert.equal(f.transitions.length, 0);
  });

  await test('note editor remains readable on small phones in both languages and themes', async (f) => {
    await openNote(f.page);
    await f.page.locator('#reportResolutionNote').fill('Draft resolution note stays on this device until explicitly resolved.');
    await saved(f.page, 'Draft resolution note stays on this device until explicitly resolved.');
    for (const width of [320, 390]) {
      await f.page.setViewportSize({ width, height: 844 });
      for (const language of ['en', 'zh']) {
        for (const theme of ['light', 'dark']) {
          await f.page.evaluate(({ language, theme }) => {
            document.documentElement.dataset.theme = theme;
            window.localStorage.setItem('leader-theme', theme);
            return import('/assets/js/i18n.js').then(({ setLanguage }) => setLanguage(language));
          }, { language, theme });
          await f.page.locator('#reportNotePanel').scrollIntoViewIfNeeded();
          assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
          const buttonSize = await f.page.locator('#resolveReportNoteButton').boundingBox();
          assert.ok(buttonSize.width >= 44 && buttonSize.height >= 44);
          assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), 'Draft resolution note stays on this device until explicitly resolved.');
          await f.page.screenshot({ path: path.join(output, `note-${width}-${language}-${theme}.png`), fullPage: true });
        }
      }
    }
    assert.equal(f.transitions.length, 0);
  });
  console.log(`Passed ${passed} isolated real-app Report note browser groups.`);
} finally { await browser.close(); }
