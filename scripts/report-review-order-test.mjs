import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59961'; // Entire real app intercepted: no server, database, or cloud writes.
const output = path.join(root, 'output', 'report-review-order.local');
const now = Date.parse('2026-10-02T12:00:30Z');
const supervisor = { id: 74, role: 'supervisor', department_id: 2, department_name: 'Mutual',
  dashboard_department_id: 2, dashboard_department_name: 'Mutual', is_global_admin: true,
  name: 'Review Supervisor', email: 'review-order@example.invalid', status: 'active' };
const worker = { id: 25, role: 'worker', worker_class: 'normal', department_id: 2,
  name: 'Mutual Worker', email: 'review-worker@example.invalid', status: 'active' };
const templates = [
  { id: 21, department_id: 2, name: 'Safety inspection', status: 'active', template_purpose: 'report',
    definition_version: 1, fields: [{ id: 'observations', type: 'textarea', label: 'Observations', required: true }] },
  { id: 22, department_id: 2, name: 'Archived inspection', status: 'archived', template_purpose: 'report',
    definition_version: 1, fields: [{ id: 'observations', type: 'textarea', label: 'Observations', required: true }] },
  { id: 31, department_id: 3, name: 'Other Department inspection', status: 'active', template_purpose: 'report',
    definition_version: 1, fields: [{ id: 'observations', type: 'textarea', label: 'Observations', required: true }] }
];
const workers = [worker, { ...worker, id: 26, name: 'Resigned Worker', status: 'resigned' },
  { ...worker, id: 35, department_id: 3, name: 'Other Department Worker' }];
const ago = (milliseconds) => new Date(now - milliseconds).toISOString();
function report(id, overrides = {}) {
  return { id, kind: 'form', review_key: `form:${id}`, department_id: 2, department_name: 'Mutual',
    form_id: 21, form_name: `Inspection ${id}`, worker_id: 25, worker_name: 'Mutual Worker',
    submission_purpose: 'report', status: 'pending', workflow_status: 'submitted',
    durability: 'durable', read_only: false, work_date: '2026-10-01', created_at: ago(120000),
    fields: templates[0].fields, answers: { observations: `Inspection evidence ${id}` },
    photo_urls: [], photo_metadata: [], supervisor_note: null, resolved_at: null, ...overrides };
}
const initialReports = [
  report(901, { created_at: ago(2 * 86400000), work_date: '2026-10-02' }),
  report(902, { created_at: ago(3600000), work_date: '2020-01-01' }),
  report(903, { workflow_status: 'in_review', created_at: ago(5 * 86400000),
    review_started_at: ago(3600000), reviewing_supervisor_id: 74 }),
  report(904, { workflow_status: 'resolved', created_at: ago(9 * 86400000),
    resolved_at: ago(3600000), supervisor_note: 'Official final note' }),
  report(905, { created_at: ago(30000) }),
  report(906, { created_at: ago(90000) }),
  report(907, { created_at: ago(4 * 60000) }),
  report(908, { created_at: ago(3 * 3600000) }),
  report(909, { created_at: ago(86400000) }),
  report(910, { created_at: ago(-86400000) }),
  report(911, { created_at: null }),
  report(912, { created_at: 'not-a-submission-timestamp' }),
  report(913, { created_at: ago(2 * 3600000).replace('Z', '') }),
  report(921, { form_id: 22, worker_id: 26, worker_name: 'Resigned Worker', created_at: ago(6 * 60000) }),
  report(931, { department_id: 3, department_name: 'Other Department', form_id: 31,
    worker_id: 35, worker_name: 'Other Department Worker', created_at: ago(3600000) })
];
const paginatedReports = Array.from({ length: 137 }, (_, index) => report(1000 + index, {
  // Large timestamp ties cross the first and second page boundaries; IDs must settle each tie.
  created_at: ago((Math.floor(index / 31) + 1) * 86400000),
  workflow_status: index < 121 ? 'submitted' : index < 129 ? 'in_review' : 'resolved',
  ...(index >= 121 && index < 129 ? { review_started_at: ago(60000), reviewing_supervisor_id: 74 } : {}),
  ...(index >= 129 ? { supervisor_note: 'Resolved by fixture', resolved_at: ago(60000) } : {})
}));

function timestamp(value) {
  if (typeof value !== 'string' || !value) return 0;
  const explicit = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`;
  const parsed = Date.parse(explicit);
  return Number.isFinite(parsed) ? parsed : 0;
}
function ordered(records, query) {
  const rank = { submitted: 0, in_review: 1, resolved: 2 };
  const rows = records.filter((item) => (!query.purpose || item.submission_purpose === query.purpose)
    && (!query.department_id || String(item.department_id) === query.department_id)
    && (!query.form_id || String(item.form_id) === query.form_id)
    && (!query.worker_id || String(item.worker_id) === query.worker_id)
    && (!query.workflow_status || item.workflow_status === query.workflow_status)
    && (!query.status || item.status === query.status)
    && (!query.record_date || item.work_date === query.record_date)
    && (!query.search || JSON.stringify(item).toLowerCase().includes(query.search.toLowerCase())));
  return rows.sort((left, right) => query.sort_order === 'oldest_waiting'
    ? rank[left.workflow_status] - rank[right.workflow_status]
      || timestamp(left.created_at) - timestamp(right.created_at) || left.id - right.id
    : timestamp(right.created_at) - timestamp(left.created_at) || right.id - left.id);
}
const keys = (items) => items.map((item) => `form:${item.id}`);
const signature = (query) => JSON.stringify(Object.entries(query)
  .filter(([key]) => !['cursor', 'page_size'].includes(key)).sort(([left], [right]) => left.localeCompare(right)));

async function fixture(browser, { records = initialReports, user = supervisor, reportOnly = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block',
    timezoneId: 'Pacific/Auckland' });
  context.setDefaultTimeout(12000);
  await context.addInitScript((reportOnly) => { window.__REPORT_ONLY_MODE_OVERRIDE__ = reportOnly; }, reportOnly);
  const reports = structuredClone(records), queries = [], responses = [], unexpected = [], errors = [], held = [];
  const cursors = new Map();
  let currentUser = structuredClone(user), signedIn = true, failure = 0, failureDetail = '', echo = 'correct', holdRule = null;
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { unexpected.push(url.href); return route.abort(); }
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated Report ordering</title>' });
    if (['/api/auth/me', '/api/auth/refresh'].includes(url.pathname)) return signedIn
      ? json(currentUser) : json({ detail: 'Isolated fixture signed out' }, 401);
    if (url.pathname === '/api/auth/login') { signedIn = true; return json({ user: currentUser }); }
    if (url.pathname === '/api/auth/logout') { signedIn = false; return json({ message: 'Signed out' }); }
    if (url.pathname === '/api/departments') return json([{ id: 2, name: 'Mutual' }, { id: 3, name: 'Other Department' }]);
    if (url.pathname === '/api/sites') return json([]);
    if (url.pathname === '/api/work-forms') {
      assert.equal(url.searchParams.get('purpose'), reportOnly ? 'report' : null);
      return json(templates);
    }
    if (url.pathname === '/api/supervisor/users') return json([...workers, currentUser]);
    if (url.pathname === '/api/my-form-submissions') return json(reports.filter((item) => item.worker_id === currentUser.id
      && (!reportOnly || item.submission_purpose === 'report')));
    if (['/api/supervisor/audit-events', '/api/supervisor/trash', '/api/task-templates',
      '/api/supervisor/records', '/api/supervisor/task-logs', '/api/supervisor/team-work-logs'].includes(url.pathname)) return json([]);
    if (url.pathname === '/api/supervisor/review-queue') {
      const query = Object.fromEntries(url.searchParams);
      queries.push(query);
      if (reportOnly) assert.equal(query.purpose, 'report');
      const querySignature = signature(query);
      let offset = 0;
      if (query.cursor) {
        const cursor = cursors.get(query.cursor);
        assert.ok(cursor, 'Only a cursor actually returned by this isolated server may be used');
        assert.equal(cursor.signature, querySignature, 'Sort/filter/scope changes must never reuse a prior query cursor');
        offset = cursor.offset;
      }
      // An older/incompatible server ignores the requested order and returns its newest-first page.
      const items = ordered(reports, echo === 'correct' ? query : { ...query, sort_order: 'newest' });
      const pageSize = Number(query.page_size || 50);
      const hasMore = offset + pageSize < items.length;
      const cursor = hasMore ? `isolated-cursor-${queries.length}-${offset + pageSize}` : null;
      if (cursor) cursors.set(cursor, { signature: querySignature, offset: offset + pageSize });
      const body = { items: items.slice(offset, offset + pageSize), counts: { total: items.length },
        summary_counts: { total: items.length }, has_more: hasMore, next_cursor: cursor,
        snapshot_at: new Date(now).toISOString(),
        ...(echo === 'missing' ? {} : { sort_order: echo === 'wrong' ? 'newest' : query.sort_order || 'newest' }) };
      const status = failure;
      if (holdRule?.(query)) {
        holdRule = null;
        await new Promise((resolve) => held.push({ query, body, resolve }));
      }
      responses.push({ query, body, status });
      return status ? json({ detail: failureDetail || 'Isolated queue unavailable' }, status) : json(body);
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
  await page.clock.install({ time: new Date(now) });
  await page.goto(`${origin}/fixture`);
  await page.evaluate(async (user) => (await import('/assets/js/api-client.js')).saveSession(user), currentUser);
  await page.goto(origin);
  await page.locator(user.role === 'worker' ? '#workerView' : '#supervisorView').waitFor({ state: 'visible' });
  if (user.role === 'supervisor') {
    if (!reportOnly) await workspace(page, 'review');
    try { await live(page); }
    catch (error) {
      console.error('Fixture readiness:', { errors, unexpected, queries,
        visibleText: await page.locator('#adminReviewWorkspace').innerText() });
      await context.close();
      throw error;
    }
    await rendered(page, keys(ordered(reports, queries.at(-1))).slice(0, 50));
  }
  return { context, page, reports, queries, responses, held, errors,
    setUser(next) { currentUser = structuredClone(next); },
    failQueue(status = 503, detail = '') { failure = status; failureDetail = detail; },
    setEcho(value) { echo = value; },
    hold(test = () => true) { holdRule = test; },
    release() { held.splice(0).forEach(({ resolve }) => resolve()); },
    async close() {
      held.splice(0).forEach(({ resolve }) => resolve());
      await context.close();
      assert.deepEqual(errors, [], 'No unhandled real-app browser errors');
      assert.deepEqual(unexpected, [], 'No cloud, external, or unexpected API calls');
    }
  };
}

async function workspace(page, name) {
  if (!await page.locator(`[data-admin-workspace-target="${name}"]:visible`).count()) {
    await page.locator('#adminMobileMenuButton').click();
  }
  await page.locator(`[data-admin-workspace-target="${name}"]:visible`).first().click();
}
async function live(page) {
  await page.waitForFunction(() => !document.querySelector('#exportReportsPdfButton').disabled
    && !document.querySelector('.review-queue-read-only'));
}
async function rendered(page, expected) {
  await page.waitForFunction((expected) => JSON.stringify([...document.querySelectorAll('#reviewQueueList [data-record-key]')]
    .map((item) => item.dataset.recordKey)) === JSON.stringify(expected), expected);
}
async function rowKeys(page) {
  return page.locator('#reviewQueueList [data-record-key]').evaluateAll((items) => items.map((item) => item.dataset.recordKey));
}
async function waitQuery(f, after, matches = () => true) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const result = f.queries.slice(after).find(matches);
    if (result) return result;
    await f.page.waitForTimeout(20);
  }
  assert.fail('Expected an isolated queue query matching the new sort/filter/scope');
}
async function waitHeld(f) {
  for (let attempt = 0; attempt < 150 && !f.held.length; attempt++) await f.page.waitForTimeout(20);
  assert.equal(f.held.length, 1, 'Expected exactly one deliberately held queue response');
}
async function openFilters(page) {
  await page.locator('#reportReviewFilters').evaluate((node) => { node.open = true; });
}
async function sort(f, order) {
  await openFilters(f.page);
  const before = f.queries.length;
  await f.page.locator('#supervisorSortOrder').selectOption(order);
  const query = await waitQuery(f, before, (query) => (query.sort_order || 'newest') === order && !query.cursor);
  await live(f.page);
  await rendered(f.page, keys(ordered(f.reports, query)).slice(0, 50));
  return query;
}
async function refresh(f) {
  const before = f.queries.length;
  await f.page.locator('#refreshSupervisorButton').click();
  return waitQuery(f, before, (query) => !query.cursor);
}
async function select(f, selector, value, expectedQuery) {
  await openFilters(f.page);
  const before = f.queries.length;
  await f.page.locator(selector).selectOption(value);
  const query = await waitQuery(f, before, expectedQuery);
  await live(f.page);
  await rendered(f.page, keys(ordered(f.reports, query)).slice(0, 50));
  return query;
}
async function scope(f, department) {
  const before = f.queries.length;
  // The shared Department selector lives outside the report-only workspace.
  // Dispatch its native event to exercise the real scope/session handler without replacing app state.
  await f.page.locator('#supervisorDepartmentFilter').evaluate((node, value) => {
    node.value = value;
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }, department);
  const query = await waitQuery(f, before, (query) => (query.department_id || '') === department && !query.cursor);
  await live(f.page);
  await rendered(f.page, keys(ordered(f.reports, query)).slice(0, 50));
  return query;
}
async function logout(f) {
  const response = f.page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/logout');
  await f.page.locator('#logoutButton').click();
  await f.page.locator('#loginView').waitFor({ state: 'visible' });
  await (await response).finished();
}
async function login(f) {
  const before = f.queries.length;
  await f.page.locator('#emailInput').fill('review-order@example.invalid');
  await f.page.locator('#passwordInput').fill('Only-an-isolated-fixture-password');
  await f.page.locator('#loginSubmitButton').click();
  const query = await waitQuery(f, before);
  await live(f.page);
  await rendered(f.page, keys(ordered(f.reports, query)).slice(0, 50));
  return query;
}
async function values(page) {
  return page.evaluate(() => ({ sort: document.querySelector('#supervisorSortOrder').value,
    status: document.querySelector('#supervisorStatusFilter').value,
    template: document.querySelector('#supervisorTemplateFilter').value,
    worker: document.querySelector('#supervisorWorkerFilter').value,
    date: document.querySelector('#supervisorDateFilter').value,
    search: document.querySelector('#supervisorSearchInput').value }));
}
const shortcut = (page, value) => page.locator(`[data-report-workflow-shortcut="${value}"]`);
const blank = { sort: 'newest', status: '', template: '', worker: '', date: '', search: '' };

const browser = await chromium.launch({ headless: true });
const only = process.env.REPORT_REVIEW_ORDER_TEST_ONLY || '';
let passed = 0;
async function test(name, body, options) {
  if (only && !name.includes(only)) return;
  const f = await fixture(browser, options);
  try { await body(f); passed++; console.log(`ok - ${name}`); }
  catch (error) {
    console.error('Failed real-app group:', name, { errors: f.errors, queries: f.queries.slice(-5),
      visibleText: (await f.page.locator('body').innerText()).slice(-7000) });
    throw error;
  }
  finally { await f.close(); }
}

try {
  await mkdir(output, { recursive: true });
  await test('newest remains the default and real Supervisor list/detail ages use submission time, not Report Date', async (f) => {
    assert.deepEqual(await values(f.page), blank);
    assert.equal(f.queries[0].sort_order || 'newest', 'newest');
    const expected = { 901: 'Waiting 2 days', 902: 'Waiting 1 hour', 905: 'Waiting less than 1 minute',
      906: 'Waiting 1 minute', 907: 'Waiting 4 minutes', 908: 'Waiting 3 hours', 909: 'Waiting 1 day',
      910: 'Waiting less than 1 minute', 913: 'Waiting 2 hours' };
    for (const [id, label] of Object.entries(expected)) {
      assert.equal(await f.page.locator(`#reviewQueueList [data-record-key="form:${id}"] .report-waiting-age`).innerText(), label);
    }
    for (const id of [903, 904, 911, 912]) {
      assert.equal(await f.page.locator(`#reviewQueueList [data-record-key="form:${id}"] .report-waiting-age`).count(), 0,
        'In-review/resolved or missing/invalid creation times must not receive a waiting age');
    }
    await f.page.locator('#reviewQueueList [data-record-key="form:902"]').click();
    assert.equal(await f.page.locator('#reviewQueueDetail .report-waiting-age').innerText(), 'Waiting 1 hour');
    assert.match(await f.page.locator('#reviewQueueDetail').innerText(), /2020/);
  });

  await test('oldest-waiting preserves server workflow ranks and timestamp ties across all 137 records and three pages', async (f) => {
    const query = await sort(f, 'oldest_waiting');
    const expected = keys(ordered(f.reports, query));
    assert.equal(await f.page.locator('#reviewQueueList [data-record-key]').count(), 50);
    assert.notEqual(expected[0], keys(ordered(f.reports, { ...query, sort_order: 'newest' }))[0]);
    for (const total of [100, 137]) {
      const before = f.queries.length;
      await f.page.locator('.review-queue-load-more').click();
      const next = await waitQuery(f, before, (query) => Boolean(query.cursor));
      assert.equal(next.sort_order, 'oldest_waiting');
      await rendered(f.page, expected.slice(0, total));
    }
    const loaded = await rowKeys(f.page);
    assert.equal(new Set(loaded).size, 137);
    assert.equal(await f.page.locator('.review-queue-load-more').count(), 0);
    assert.deepEqual(loaded, expected);
    assert.deepEqual(loaded.slice(121, 129).sort(), f.reports.filter((item) => item.workflow_status === 'in_review').map((item) => `form:${item.id}`).sort());
    assert.deepEqual(loaded.slice(129).sort(), f.reports.filter((item) => item.workflow_status === 'resolved').map((item) => `form:${item.id}`).sort());
  }, { records: paginatedReports });

  await test('sort and structured filters compose; workflow shortcuts retain sort and Clear restores newest', async (f) => {
    await sort(f, 'oldest_waiting');
    await select(f, '#supervisorTemplateFilter', '22', (query) => query.form_id === '22');
    await select(f, '#supervisorWorkerFilter', '26', (query) => query.worker_id === '26');
    const beforeDate = f.queries.length;
    await f.page.locator('#supervisorDateFilter').fill('2026-10-01');
    await f.page.locator('#supervisorSearchInput').fill('Inspection');
    const query = await waitQuery(f, beforeDate, (query) => query.record_date === '2026-10-01' && query.search === 'Inspection');
    await rendered(f.page, keys(ordered(f.reports, query)));
    for (const workflow of ['submitted', 'in_review', '']) {
      const before = f.queries.length;
      await shortcut(f.page, workflow).click();
      const current = await waitQuery(f, before, (query) => (query.workflow_status || '') === workflow);
      await live(f.page);
      await rendered(f.page, keys(ordered(f.reports, current)));
      assert.deepEqual(await values(f.page), { sort: 'oldest_waiting', status: workflow, template: '22', worker: '26',
        date: '2026-10-01', search: 'Inspection' });
      assert.equal(current.sort_order, 'oldest_waiting');
      assert.equal(await shortcut(f.page, workflow).getAttribute('aria-pressed'), 'true');
    }
    const beforeClear = f.queries.length;
    await f.page.locator('#clearSupervisorFiltersButton').click();
    const cleared = await waitQuery(f, beforeClear, (query) => (query.sort_order || 'newest') === 'newest');
    await live(f.page);
    await rendered(f.page, keys(ordered(f.reports, cleared)).slice(0, 50));
    assert.deepEqual(await values(f.page), blank);
    for (const field of ['workflow_status', 'form_id', 'worker_id', 'record_date', 'search', 'cursor']) assert.equal(cleared[field], undefined);
  });

  await test('fresh reload restores sort before querying while leaving Find text private and session-only', async (f) => {
    await sort(f, 'oldest_waiting');
    await select(f, '#supervisorStatusFilter', 'submitted', (query) => query.workflow_status === 'submitted');
    await select(f, '#supervisorTemplateFilter', '22', (query) => query.form_id === '22');
    await select(f, '#supervisorWorkerFilter', '26', (query) => query.worker_id === '26');
    const beforeFind = f.queries.length;
    await f.page.locator('#supervisorSearchInput').fill('Private unsaved find phrase');
    await waitQuery(f, beforeFind, (query) => query.search === 'Private unsaved find phrase');
    await live(f.page);
    const storage = await f.page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
    assert.equal(JSON.stringify(storage).includes('Private unsaved find phrase'), false);
    const before = f.queries.length;
    await f.page.reload();
    const first = await waitQuery(f, before);
    await live(f.page);
    await rendered(f.page, keys(ordered(f.reports, first)));
    assert.equal(first.sort_order, 'oldest_waiting');
    assert.equal(first.workflow_status, 'submitted');
    assert.equal(first.form_id, '22');
    assert.equal(first.worker_id, '26');
    assert.equal(first.search, undefined);
    assert.equal(first.cursor, undefined);
    assert.deepEqual(await values(f.page), { sort: 'oldest_waiting', status: 'submitted', template: '22', worker: '26', date: '', search: '' });
  });

  await test('sort changes clear old rows and reject late first-page responses without reusing a cursor', async (f) => {
    const initial = await rowKeys(f.page);
    f.hold((query) => query.sort_order === 'oldest_waiting');
    await openFilters(f.page);
    await f.page.locator('#supervisorSortOrder').selectOption('oldest_waiting');
    await waitHeld(f);
    assert.deepEqual(await rowKeys(f.page), []);
    assert.equal(await f.page.locator('#exportReportsPdfButton').isDisabled(), true);
    assert.equal(await f.page.locator('.review-queue-load-more').count(), 0);
    assert.equal(f.held[0].query.cursor, undefined);
    assert.equal(await f.page.locator('#supervisorSortOrder').isDisabled(), true,
      'The sort selector stays disabled while its first page is loading');
    const beforeClear = f.queries.length;
    await f.page.locator('#clearSupervisorFiltersButton').click();
    const cleared = await waitQuery(f, beforeClear, (query) => (query.sort_order || 'newest') === 'newest');
    assert.equal(cleared.cursor, undefined);
    await live(f.page);
    await rendered(f.page, initial);
    assert.deepEqual(await rowKeys(f.page), initial);
    const response = f.page.waitForResponse((response) => response.url().includes('/review-queue?')
      && new URL(response.url()).searchParams.get('sort_order') === 'oldest_waiting');
    f.release();
    await (await response).finished();
    await f.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await rowKeys(f.page), initial, 'Old-sort first page must not repaint the selected newer order');
    assert.equal(await f.page.locator('#supervisorSortOrder').inputValue(), 'newest');
  }, { records: paginatedReports });

  await test('late Load more replies cannot append or replace the new sort or its pagination', async (f) => {
    f.hold((query) => Boolean(query.cursor));
    await f.page.locator('.review-queue-load-more').click();
    await waitHeld(f);
    const oldCursor = f.held[0].query.cursor;
    const query = await sort(f, 'oldest_waiting');
    assert.equal(query.cursor, undefined);
    const expected = keys(ordered(f.reports, query));
    const response = f.page.waitForResponse((response) => new URL(response.url()).searchParams.get('cursor') === oldCursor);
    f.release();
    await (await response).finished();
    await f.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await rowKeys(f.page), expected.slice(0, 50));
    const before = f.queries.length;
    await f.page.locator('.review-queue-load-more').click();
    const next = await waitQuery(f, before, (query) => Boolean(query.cursor));
    assert.notEqual(next.cursor, oldCursor);
    assert.equal(next.sort_order, 'oldest_waiting');
    await rendered(f.page, expected.slice(0, 100));
  }, { records: paginatedReports });

  await test('failed same-sort refresh keeps durable read-only order; a failed sort change cannot show another query snapshot', async (f) => {
    await sort(f, 'oldest_waiting');
    const retained = await rowKeys(f.page);
    f.failQueue();
    await refresh(f);
    await f.page.locator('.review-queue-read-only').waitFor();
    assert.deepEqual(await rowKeys(f.page), retained);
    assert.equal(await f.page.locator('#exportReportsPdfButton').isDisabled(), true);
    assert.equal(await f.page.locator('.review-queue-load-more').count(), 0);
    const before = f.queries.length;
    await f.page.locator('#supervisorSortOrder').selectOption('newest');
    const changed = await waitQuery(f, before, (query) => (query.sort_order || 'newest') === 'newest');
    assert.equal(changed.cursor, undefined);
    await f.page.locator('.review-queue-read-only').waitFor();
    await rendered(f.page, []);
    await refresh(f);
    await f.page.locator('.review-queue-read-only').waitFor();
    assert.deepEqual(await rowKeys(f.page), []);
    f.failQueue(0);
    const restored = await refresh(f);
    await live(f.page);
    await rendered(f.page, keys(ordered(f.reports, restored)).slice(0, 50));
  }, { records: paginatedReports });

  await test('missing or wrong backend sort acknowledgements fail closed instead of presenting newest results as oldest waiting', async (f) => {
    for (const echo of ['missing', 'wrong']) {
      f.setEcho(echo);
      const before = f.queries.length;
      await openFilters(f.page);
      await f.page.locator('#supervisorSortOrder').selectOption('oldest_waiting');
      await waitQuery(f, before, (query) => query.sort_order === 'oldest_waiting');
      await f.page.locator('.review-queue-read-only').waitFor();
      await rendered(f.page, []);
      assert.equal(await f.page.locator('#exportReportsPdfButton').isDisabled(), true);
      assert.equal(await f.page.locator('.review-queue-load-more').count(), 0);
      await sort(f, 'newest');
    }
    f.setEcho('correct');
    await sort(f, 'oldest_waiting');
  });

  await test('a workflow-change cursor conflict keeps loaded results read-only until explicit Refresh starts a new snapshot', async (f) => {
    await f.page.locator('#reviewQueueList [data-record-key="form:1020"]').click();
    await f.page.locator('#reviewQueueActions').getByRole('button', { name: 'Resolve report', exact: true }).click();
    await f.page.waitForFunction(() => !document.querySelector('#reportResolutionNote').disabled);
    const note = 'Keep my unfinished resolution note through a concurrent queue workflow change.';
    await f.page.locator('#reportResolutionNote').fill(note);
    await sort(f, 'oldest_waiting');
    await f.page.locator('#reviewQueueList [data-record-key="form:1020"]').click();
    await f.page.locator('#reviewQueueActions').getByRole('button', { name: 'Continue note', exact: true }).click();
    await f.page.locator('#reportNotePanel').waitFor({ state: 'visible' });
    await f.page.waitForFunction((note) => {
      const field = document.querySelector('#reportResolutionNote');
      return !field.disabled && field.value === note;
    }, note);
    const previous = await rowKeys(f.page);
    f.failQueue(409, { code: 'report_review_order_changed',
      message: 'Report order changed while paging. Refresh Reports to start again.' });
    const before = f.queries.length;
    await f.page.locator('.review-queue-load-more').click();
    await waitQuery(f, before, (query) => Boolean(query.cursor));
    await f.page.locator('.review-queue-read-only').waitFor();
    assert.deepEqual(await rowKeys(f.page), previous);
    assert.equal(await f.page.locator('.review-queue-load-more').count(), 0);
    assert.equal(await f.page.locator('#exportReportsPdfButton').isDisabled(), true);
    assert.match(await f.page.locator('#reportReviewPreferenceNotice').innerText(), /Reports changed.*Refresh/i);
    assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), note);
    assert.equal(await f.page.locator('#resolveReportNoteButton').isDisabled(), true);
    assert.equal(await f.page.locator('#reportResolutionNote').isDisabled(), false, 'Private note editing is not blocked by a stale queue');
    f.failQueue(0);
    const beforeNoteRefresh = f.queries.length;
    await f.page.locator('#refreshReportNoteButton').click();
    await waitQuery(f, beforeNoteRefresh, (query) => query.worker_id === '25' && query.form_id === '21');
    await f.page.waitForFunction(() => !document.querySelector('#refreshReportNoteButton').disabled);
    assert.equal(await f.page.locator('#resolveReportNoteButton').isDisabled(), true,
      'A fresh per-note lookup cannot release the queue-conflict safety latch');
    // Simulate another Supervisor moving the old head into a later workflow rank.
    const moved = f.reports.find((item) => `form:${item.id}` === previous[0]);
    moved.workflow_status = 'resolved';
    moved.supervisor_note = 'Resolved by another Supervisor while paging';
    moved.resolved_at = new Date(now).toISOString();
    const refreshed = await refresh(f);
    assert.equal(refreshed.cursor, undefined);
    assert.equal(refreshed.sort_order, 'oldest_waiting');
    await live(f.page);
    await rendered(f.page, keys(ordered(f.reports, refreshed)).slice(0, 50));
    assert.notEqual((await rowKeys(f.page))[0], previous[0]);
    assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), note);
  }, { records: paginatedReports.map((item, index) => ({ ...item,
    workflow_status: index < 20 ? 'submitted' : index < 40 ? 'in_review' : 'resolved',
    ...(index >= 20 && index < 40 ? { review_started_at: ago(60000), reviewing_supervisor_id: 74 } : {}) })) });

  await test('Department, account, home Department, and global capability isolate saved sort preferences', async (f) => {
    await sort(f, 'oldest_waiting');
    await scope(f, '3');
    assert.deepEqual(await values(f.page), blank);
    await select(f, '#supervisorStatusFilter', 'in_review', (query) => query.workflow_status === 'in_review');
    await scope(f, '2');
    assert.equal(await f.page.locator('#supervisorSortOrder').inputValue(), 'oldest_waiting');
    await scope(f, '');
    assert.deepEqual(await values(f.page), blank);
    await scope(f, '3');
    assert.equal(await f.page.locator('#supervisorStatusFilter').inputValue(), 'in_review');
    assert.equal(await f.page.locator('#supervisorSortOrder').inputValue(), 'newest');
    for (const user of [{ ...supervisor, id: 75 }, { ...supervisor, department_id: 3 },
      { ...supervisor, is_global_admin: false }]) {
      await logout(f);
      f.setUser(user);
      await login(f);
      assert.deepEqual(await values(f.page), blank);
    }
    await logout(f);
    f.setUser(supervisor);
    const restored = await login(f);
    assert.equal(restored.sort_order, 'oldest_waiting');
    assert.equal(await f.page.locator('#supervisorSortOrder').inputValue(), 'oldest_waiting');
  });

  await test('a late old-account queue reply cannot restore private rows or sort after logout', async (f) => {
    await sort(f, 'oldest_waiting');
    f.hold();
    await refresh(f);
    await waitHeld(f);
    await logout(f);
    assert.equal(await f.page.locator('#reviewQueueList [data-record-key]').count(), 0);
    f.setUser({ ...supervisor, id: 75, dashboard_department_id: 3 });
    const next = await login(f);
    assert.equal(next.sort_order || 'newest', 'newest');
    assert.equal(next.department_id, '3');
    const expected = await rowKeys(f.page);
    const response = f.page.waitForResponse((response) => response.url().includes('/review-queue?')
      && new URL(response.url()).searchParams.get('department_id') === '2');
    f.release();
    await (await response).finished();
    await f.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await rowKeys(f.page), expected);
    assert.deepEqual(await values(f.page), blank);
  });

  await test('sort and workflow changes retain an unfinished resolution note without submitting it', async (f) => {
    await f.page.locator('#reviewQueueList [data-record-key="form:903"]').click();
    await f.page.locator('#reviewQueueActions').getByRole('button', { name: 'Resolve report', exact: true }).click();
    await f.page.locator('#reportNotePanel').waitFor({ state: 'visible' });
    await f.page.waitForFunction(() => {
      const field = document.querySelector('#reportResolutionNote');
      return !field.disabled && !field.readOnly && !field.closest('[inert]');
    });
    const text = 'Unfinished private note survives an oldest-waiting sort change.';
    await f.page.locator('#reportResolutionNote').fill(text);
    await sort(f, 'oldest_waiting');
    assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), text);
    const before = f.queries.length;
    await shortcut(f.page, 'submitted').click();
    await waitQuery(f, before, (query) => query.workflow_status === 'submitted');
    await live(f.page);
    assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), text);
    if (await f.page.locator('#reportNotePanel').isVisible()) {
      await f.page.locator('#closeReportNoteButton').click();
      await f.page.locator('#reportNotePanel').waitFor({ state: 'hidden' });
    }
    await f.page.waitForFunction(async (text) => (await (await import('/assets/js/db.js')).getAll('drafts'))
      .some((row) => String(row.key).startsWith('report-resolution-note:v1:') && !row.deleted && row.text === text), text);
    const beforeRestore = f.queries.length;
    await shortcut(f.page, '').click();
    await waitQuery(f, beforeRestore, (query) => !query.workflow_status);
    await live(f.page);
    await f.page.locator('#reviewQueueList [data-record-key="form:903"]').click();
    await f.page.locator('#reviewQueueActions').getByRole('button', { name: 'Continue note', exact: true }).click();
    await f.page.locator('#reportNotePanel').waitFor({ state: 'visible' });
    await f.page.waitForFunction((text) => {
      const field = document.querySelector('#reportResolutionNote');
      return !field.disabled && field.value === text;
    }, text);
    assert.equal(f.reports.find((item) => item.id === 903).workflow_status, 'in_review');
  });

  await test('minute refresh updates waiting age without replacing list focus or an active resolution note', async (f) => {
    await f.page.locator('#reviewQueueList [data-record-key="form:903"]').click();
    await f.page.locator('#reviewQueueActions').getByRole('button', { name: 'Resolve report', exact: true }).click();
    await f.page.waitForFunction(() => !document.querySelector('#reportResolutionNote').disabled);
    await f.page.locator('#reportResolutionNote').fill('Keep editor and selection intact during age refresh.');
    await f.page.locator('#reportResolutionNote').evaluate((field) => { field.setSelectionRange(5, 11); });
    await f.page.evaluate(() => {
      window.orderTestOriginalRow = document.querySelector('#reviewQueueList [data-record-key="form:905"]');
      window.orderTestOriginalNote = document.querySelector('#reportResolutionNote');
    });
    const queryCount = f.queries.length;
    await f.page.clock.fastForward(61000);
    assert.equal(await f.page.locator('#reviewQueueList [data-record-key="form:905"] .report-waiting-age').innerText(), 'Waiting 1 minute');
    assert.equal(await f.page.evaluate(() => window.orderTestOriginalRow === document.querySelector('#reviewQueueList [data-record-key="form:905"]')), true);
    assert.equal(await f.page.evaluate(() => window.orderTestOriginalNote === document.activeElement), true);
    assert.deepEqual(await f.page.locator('#reportResolutionNote').evaluate((field) => [field.selectionStart, field.selectionEnd]), [5, 11]);
    assert.equal(await f.page.locator('#reportResolutionNote').inputValue(), 'Keep editor and selection intact during age refresh.');
    assert.equal(f.queries.length, queryCount, 'Waiting ages update locally without extra queue requests');
    await f.page.locator('#closeReportNoteButton').click();
    const row = f.page.locator('#reviewQueueList [data-record-key="form:905"]');
    await row.focus();
    await f.page.clock.fastForward(61000);
    assert.equal(await row.evaluate((node) => node === document.activeElement), true);
  });

  await test('Worker Reports and retained Daywork never show Supervisor waiting ages or sorting controls', async (f) => {
    await logout(f);
    f.setUser(worker);
    await f.page.locator('#emailInput').fill(worker.email);
    await f.page.locator('#passwordInput').fill('Only-an-isolated-fixture-password');
    await f.page.locator('#loginSubmitButton').click();
    await f.page.locator('#workerView').waitFor({ state: 'visible' });
    await f.page.locator('.tab[data-tab-target="historyTab"]').click();
    await f.page.locator('#historyList .record-card').first().waitFor();
    assert.equal(await f.page.locator('#historyList .report-waiting-age').count(), 0);
    assert.equal(await f.page.locator('#supervisorSortOrder').isVisible(), false);
    const retained = await fixture(browser, { reportOnly: false,
      records: [report(970, { form_name: 'Retained Daywork', submission_purpose: 'daywork' })] });
    try {
      assert.equal(await retained.page.locator('#reviewQueueList [data-record-key="form:970"]').count(), 1);
      assert.equal(await retained.page.locator('.report-waiting-age').count(), 0);
      assert.equal(await retained.page.locator('#supervisorSortOrder').isVisible(), false);
      assert.ok(retained.queries.every((query) => query.sort_order === undefined));
    } finally { await retained.close(); }
  });

  await test('phone and desktop ordering controls and waiting labels are translated, accessible, and unclipped', async (f) => {
    await sort(f, 'oldest_waiting');
    await select(f, '#supervisorStatusFilter', 'submitted', (query) => query.workflow_status === 'submitted');
    for (const { width, language, theme } of [
      { width: 320, language: 'en', theme: 'light' },
      { width: 390, language: 'zh', theme: 'dark' },
      { width: 1440, language: 'en', theme: 'light' }
    ]) {
      await f.page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      await f.page.evaluate(async ({ language, theme }) => {
        document.documentElement.dataset.theme = theme;
        await (await import('/assets/js/i18n.js')).setLanguage(language);
      }, { language, theme });
      await openFilters(f.page);
      await f.page.locator('#supervisorSortOrder').scrollIntoViewIfNeeded();
      assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
        `${width}/${language}/${theme}: no horizontal overflow`);
      const box = await f.page.locator('#supervisorSortOrder').boundingBox();
      assert.ok(box.width >= 44 && box.height >= 44, 'Sort selector retains a >=44px target');
      if (width < 1100) {
        const formBox = await f.page.locator('#supervisorFilterForm').boundingBox();
        assert.ok(box.width >= formBox.width - 2, 'Phone sort control spans the full filter row so its label does not clip');
      }
      assert.ok(await f.page.locator('label').filter({ has: f.page.locator('#supervisorSortOrder') }).count()
        || await f.page.locator('label[for="supervisorSortOrder"]').count(), 'Sort has a visible associated label');
      if (language === 'zh') {
        assert.match(await f.page.locator('#supervisorSortOrder option[value="oldest_waiting"]').innerText(), /[\u4e00-\u9fff]/);
        assert.match(await f.page.locator('#reviewQueueList .report-waiting-age').first().innerText(), /[\u4e00-\u9fff]/);
        assert.doesNotMatch(await f.page.locator('#reviewQueueList .report-waiting-age').first().innerText(), /Waiting/);
      }
      await f.page.screenshot({ path: path.join(output, `review-order-${width}-${language}-${theme}.png`), fullPage: true });
      if (width < 1100) {
        await f.page.screenshot({ path: path.join(output, `review-order-${width}-${language}-${theme}-filters.png`) });
        await f.page.locator('#reportReviewFilters').evaluate((node) => { node.open = false; });
        await f.page.locator('#reviewQueueList').evaluate((node) => { node.scrollTop = 0; });
        await f.page.locator('#reviewQueueList .report-waiting-age').first().scrollIntoViewIfNeeded();
        assert.equal(await f.page.locator('#reviewQueueList .report-waiting-age').first().isVisible(), true);
        assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        await f.page.screenshot({ path: path.join(output, `review-order-${width}-${language}-${theme}-inbox.png`) });
      }
    }
  }, { records: initialReports.filter((item) => ![911, 912].includes(item.id)) });
  console.log(`Passed ${passed} isolated real-app Report ordering browser groups.`);
} finally { await browser.close(); }
