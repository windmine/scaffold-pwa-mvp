import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59972'; // All requests intercepted; no server, production API, or cloud writes.
const output = path.join(root, 'output', 'report-review-filters.local');
const supervisor = { id: 74, role: 'supervisor', departmentId: 2, isGlobalAdmin: true, name: 'Review Supervisor' };
const templates = [
  { id: 21, department_id: 2, name: 'Mutual inspection', template_purpose: 'report', status: 'active' },
  { id: 22, department_id: 2, name: 'Archived inspection', template_purpose: 'report', status: 'archived' },
  { id: 31, department_id: 3, name: 'Other Department inspection', template_purpose: 'report', status: 'active' },
  { id: 23, department_id: 2, name: 'Legacy Daywork', template_purpose: 'daywork', status: 'active' },
  { id: 24, department_id: 2, name: 'Unclassified legacy form', status: 'active' }
];
const workers = [
  { id: 25, department_id: 2, name: 'Mutual Worker', role: 'worker', status: 'active' },
  { id: 26, department_id: 2, name: 'Resigned Worker', role: 'worker', status: 'resigned' },
  { id: 35, department_id: 3, name: 'Other Department Worker', role: 'worker', status: 'active' },
  { id: 74, department_id: 2, name: 'Review Supervisor', role: 'supervisor', status: 'active' }
];

async function fixture(browser, { reportOnly = true, user = supervisor, focus = '2' } = {}) {
  const sourceHtml = (await readFile(path.join(root, 'index.html'), 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const errors = [], unexpected = [], queue = [], exports = [], events = [], held = [];
  let forms = structuredClone(templates), staff = structuredClone(workers);
  let failForms = false, failStaff = false, failQueue = false, paginated = false, holdRule = null;
  let sequence = 0;
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) { unexpected.push(url.href); return route.abort(); }
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: sourceHtml });
    if (url.pathname === '/api/work-forms' || url.pathname === '/api/supervisor/users') {
      const kind = url.pathname === '/api/work-forms' ? 'templates' : 'workers';
      events.push(kind);
      if (kind === 'templates') assert.equal(url.searchParams.get('purpose'), reportOnly ? 'report' : null);
      if (holdRule?.kind === kind) {
        holdRule = null;
        await new Promise((resolve) => held.push({ kind, resolve }));
      }
      return (kind === 'templates' ? failForms : failStaff)
        ? json({ detail: 'Fixture catalog temporarily unavailable' }, 503)
        : json(kind === 'templates' ? forms : staff);
    }
    if (url.pathname === '/api/supervisor/review-queue') {
      const query = Object.fromEntries(url.searchParams);
      queue.push(query);
      events.push('queue');
      const id = query.cursor ? 9000 + ++sequence : ++sequence;
      const body = {
        items: [{ id: `form-${id}`, backendRecordId: id, type: 'form', submissionPurpose: 'report',
          durability: 'durable', readOnly: false, syncStatus: 'synced', status: query.status || 'pending',
          workflowStatus: query.workflow_status || 'submitted', departmentId: Number(query.department_id || 2),
          formId: Number(query.form_id || 21), formName: `Fixture Report ${id}`, userId: Number(query.worker_id || 25),
          userName: 'Mutual Worker', createdAt: '2026-09-29T00:00:00Z', workDate: query.record_date || '2026-09-29',
          answers: { notes: query.search || 'Inspection notes' }, fields: [], photoUrls: [] }],
        counts: { total: paginated ? 2 : 1 }, summary_counts: { total: paginated ? 2 : 1 },
        has_more: paginated && !query.cursor, next_cursor: paginated && !query.cursor ? `cursor-${id}` : null,
        snapshot_at: '2026-09-29T00:00:00Z'
      };
      if (holdRule?.kind === 'queue' && (!holdRule.test || holdRule.test(query))) {
        holdRule = null;
        await new Promise((resolve) => held.push({ kind: 'queue', query, id, resolve }));
      }
      return failQueue ? json({ detail: 'Fixture queue temporarily unavailable' }, 503) : json(body);
    }
    if (/^\/api\/supervisor\/form-submissions\/export\.(pdf|csv)$/.test(url.pathname)) {
      exports.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
      return route.fulfill({ contentType: url.pathname.endsWith('.pdf') ? 'application/pdf' : 'text/csv', body: 'Fixture export' });
    }
    if (url.pathname === '/api/auth/default-department') {
      assert.equal(request.method(), 'PATCH');
      const body = request.postDataJSON();
      if (holdRule?.kind === 'default') {
        holdRule = null;
        await new Promise((resolve) => held.push({ kind: 'default', body, resolve }));
      }
      return json({ ...supervisor, dashboardDepartmentId: body.department_id,
        dashboardDepartmentName: body.department_id === 2 ? 'Mutual' : body.department_id === 3 ? 'Other Department' : '' });
    }
    if (['/api/supervisor/audit-events', '/api/supervisor/trash'].includes(url.pathname)) return json([]);
    if (url.pathname.startsWith('/api/')) { unexpected.push(`${request.method()} ${url.pathname}`); return json({ detail: 'Unexpected fixture request' }, 500); }
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    const file = path.resolve(root, url.pathname.slice(1));
    assert.ok(file.startsWith(`${root}${path.sep}`), 'Fixture serves repository files only');
    const types = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
    return route.fulfill({ contentType: types[path.extname(file)] || 'application/octet-stream', body: await readFile(file) });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => { errors.push(`Unexpected ${dialog.type()} dialog`); void dialog.dismiss(); });

  async function mount({ nextUser = user, nextFocus = focus, reload = false } = {}) {
    if (reload || page.url() === 'about:blank') await page.goto(origin);
    await page.evaluate(async ({ user, focus, reportOnly }) => {
      document.documentElement.dataset.theme = 'light';
      document.body.dataset.activeView = 'supervisor';
      document.body.classList.toggle('report-only-mode', reportOnly);
      document.querySelectorAll('.view').forEach((view) => {
        const current = view.id === 'supervisorView';
        view.hidden = !current; view.classList.toggle('hidden', !current); view.classList.toggle('active', current);
      });
      document.querySelectorAll('[data-admin-workspace-panel]').forEach((panel) => { panel.hidden = panel.id !== 'adminReviewWorkspace'; });
      // Expose the shared scope control in this module fixture without mounting the retained Overview.
      document.querySelector('#adminReviewWorkspace').prepend(document.querySelector('#dashboardScopeCard'));
      document.querySelector('#adminMobileWorkspaceLabel').textContent = 'Reports';
      document.querySelectorAll('[data-admin-workspace-target]').forEach((link) => {
        if (link.dataset.adminWorkspaceTarget === 'review') link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      });
      const api = await import('/assets/js/api-client.js');
      const i18n = await import('/assets/js/i18n.js');
      const preferences = await import('/assets/js/report-review-preferences.js');
      const { filterRecords } = await import('/assets/js/history.js');
      const { createSupervisorReviewModule } = await import('/assets/js/supervisor-review.js');
      const els = new Proxy({}, { get: (_, id) => document.getElementById(id) });
      const state = { user, departmentFocusId: focus, adminWorkspace: 'review', workForms: [], staffUsers: [], sites: [],
        departments: [{ id: 2, name: 'Mutual' }, { id: 3, name: 'Other Department' }],
        supervisorRecords: { reviewRecords: [], queueMode: 'offline_read_only', queueQuery: {}, auditEvents: [], trashRecords: [] } };
      const fixture = { state, els, preferences, i18n, banners: [], expired: 0 };
      const refreshWorkForms = async () => {
        const scope = preferences.reportReviewPreferenceKey(state.user, state.departmentFocusId);
        try {
          const result = await api.getWorkForms(reportOnly ? 'report' : '');
          if (scope !== preferences.reportReviewPreferenceKey(state.user, state.departmentFocusId)) return false;
          state.workForms = result;
          return true;
        } catch { return false; }
      };
      const renderStaffUsers = async () => {
        const scope = preferences.reportReviewPreferenceKey(state.user, state.departmentFocusId);
        try {
          const result = await api.getUsers();
          if (scope !== preferences.reportReviewPreferenceKey(state.user, state.departmentFocusId)) return false;
          state.staffUsers = result;
          return true;
        } catch { return false; }
      };
      const historyModule = {
        filterRecords, fromBackendReviewRecord: (record) => record,
        clearRecordsList: (target) => target.replaceChildren(),
        renderRecordsList(target, records, options = {}) {
          target.replaceChildren();
          for (const record of records) {
            const node = document.createElement('article');
            node.className = 'record-card review-queue-item';
            node.dataset.recordKey = `form:${record.backendRecordId}`;
            node.textContent = record.formName;
            if (options.summaryOnly) { node.tabIndex = 0; node.setAttribute('role', 'option'); }
            node.addEventListener('click', () => options.onRecordSelect?.(record));
            target.append(node);
          }
        }
      };
      const module = createSupervisorReviewModule({ els, state, reportOnly, historyModule,
        feedback: { clearLocal() {}, setButtonBusy() {} }, handleSessionExpired: () => fixture.expired++,
        renderStatusBanner: (message) => fixture.banners.push(message), refreshWorkForms, renderStaffUsers,
        renderSupervisorSites() {}, renderLocationMap() {}, renderManagementAnalytics() {}, renderDepartmentScopedAdminLists() {},
        onDefaultDepartmentChanged(updatedUser) { state.user = updatedUser; }, showEditPanel() {}, closeEditPanel() {}, editValue: () => '', editNumber: () => null,
        siteSelectOptions: () => [] });
      fixture.module = module;
      window.fixture = fixture;
      module.bindEvents();
      i18n.initLanguageToggle({ button: els.languageToggleButton });
      await module.renderPanel();
    }, { user: nextUser, focus: nextFocus, reportOnly });
  }
  await mount();
  return { page, context, queue, exports, events, held, mount,
    setCatalog({ nextForms = forms, nextStaff = staff, formsFail = false, staffFail = false } = {}) {
      forms = structuredClone(nextForms); staff = structuredClone(nextStaff); failForms = formsFail; failStaff = staffFail;
    },
    paginate(value = true) { paginated = value; },
    failQueue(value = true) { failQueue = value; },
    hold(kind, test) { holdRule = { kind, test }; },
    release() { held.splice(0).forEach(({ resolve }) => resolve()); },
    async close() {
      held.splice(0).forEach(({ resolve }) => resolve());
      await context.close();
      assert.deepEqual(errors, [], 'No unhandled browser errors or dialogs');
      assert.deepEqual(unexpected, [], 'No production, external, or unexpected API requests');
    }
  };
}

async function values(page) {
  return page.evaluate(() => Object.fromEntries(['Status', 'Template', 'Worker', 'Date', 'SearchInput'].map((part) => {
    const id = part === 'SearchInput' ? 'supervisorSearchInput' : `supervisor${part}Filter`;
    return [part.toLowerCase().replace('input', ''), document.getElementById(id).value];
  })));
}
async function waitQueue(fixture, after = fixture.queue.length) {
  for (let attempt = 0; attempt < 100 && fixture.queue.length <= after; attempt++) await fixture.page.waitForTimeout(20);
  assert.ok(fixture.queue.length > after, 'Expected a queue request');
  await fixture.page.waitForFunction(() => window.fixture.state.supervisorRecords.queueMode === 'live');
}
async function selectFilters(fixture, { status = '', template = '', worker = '', date = '', search = '' } = {}) {
  await fixture.page.locator('#reportReviewFilters').evaluate((node) => { node.open = true; });
  const before = fixture.queue.length;
  await fixture.page.locator('#supervisorStatusFilter').selectOption(status);
  await fixture.page.locator('#supervisorTemplateFilter').selectOption(template);
  await fixture.page.locator('#supervisorWorkerFilter').selectOption(worker);
  await fixture.page.locator('#supervisorDateFilter').fill(date);
  await fixture.page.locator('#supervisorSearchInput').fill(search);
  await waitQueue(fixture, before);
  await fixture.page.waitForFunction(({ status, template, worker, date, search }) => {
    const query = window.fixture.state.supervisorRecords.queueQuery;
    return query.workflowStatus === status && query.formId === template && query.workerId === worker
      && query.recordDate === date && query.search === search.trim();
  }, { status, template, worker, date, search });
}
async function switchFocus(fixture, focus) {
  const before = fixture.queue.length;
  await fixture.page.locator('#supervisorDepartmentFilter').selectOption(focus);
  await waitQueue(fixture, before);
  await fixture.page.waitForFunction((focus) => String(window.fixture.state.supervisorRecords.queueQuery.departmentId) === focus, focus);
}
async function freshSession(fixture, user, focus) {
  await fixture.page.evaluate(async ({ user, focus }) => {
    const { module, state } = window.fixture;
    module.resetSession();
    state.user = user; state.departmentFocusId = focus;
    await module.renderPanel();
  }, { user, focus });
}
const shortcut = (page, value) => page.locator(`[data-report-workflow-shortcut="${value}"]`);
const blank = { status: '', template: '', worker: '', date: '', search: '' };

const browser = await chromium.launch({ headless: true });
try {
  await mkdir(output, { recursive: true });
  const basic = await fixture(browser);
  try {
    const { page } = basic;
    assert.deepEqual(basic.events.slice(0, 3).sort(), ['queue', 'templates', 'workers']);
    assert.ok(basic.events.indexOf('queue') > basic.events.indexOf('templates'));
    assert.ok(basic.events.indexOf('queue') > basic.events.indexOf('workers'));
    assert.deepEqual(await values(page), blank);
    assert.equal(await page.locator('#supervisorTemplateFilter option[value="22"]').count(), 1, 'Archived Templates remain filterable');
    assert.equal(await page.locator('#supervisorWorkerFilter option[value="26"]').count(), 1, 'Resigned Workers remain filterable');
    for (const id of ['23', '24', '31']) assert.equal(await page.locator(`#supervisorTemplateFilter option[value="${id}"]`).count(), 0);
    assert.equal(await page.locator('#supervisorWorkerFilter option[value="74"]').count(), 0);
    assert.equal(basic.queue[0].purpose, 'report');
    console.log('ok - authorized catalogs precede the first Report queue request, and options include archived/resigned history but exclude foreign/legacy records');

    await selectFilters(basic, { status: 'resolved', template: '22', worker: '26', date: '2026-09-18', search: 'Private inspection notes' });
    for (const status of ['submitted', 'in_review', '']) {
      const before = basic.queue.length;
      await shortcut(page, status).click();
      await waitQueue(basic, before);
      assert.deepEqual(await values(page), { status, template: '22', worker: '26', date: '2026-09-18', search: 'Private inspection notes' });
      assert.equal(await shortcut(page, status).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('[data-report-workflow-shortcut][aria-pressed="true"]').count(), 1);
    }
    await shortcut(page, 'submitted').click();
    await page.waitForFunction(() => window.fixture.state.supervisorRecords.queueQuery.workflowStatus === 'submitted');
    const stored = await page.evaluate(() => [...Array(localStorage.length)].map((_, index) => [localStorage.key(index), localStorage.getItem(localStorage.key(index))]));
    const preferenceKey = await page.evaluate(() => window.fixture.preferences.reportReviewPreferenceKey(window.fixture.state.user, '2'));
    assert.ok(stored.some(([key]) => key === preferenceKey));
    assert.ok(!JSON.stringify(stored).includes('Private inspection notes'), 'Find text must never be persisted');
    assert.ok(!JSON.stringify(stored).includes('Resigned Worker'), 'Saved preferences contain IDs, not names or Report content');
    const beforeReload = basic.queue.length;
    await basic.mount({ reload: true });
    assert.deepEqual(await values(page), { status: 'submitted', template: '22', worker: '26', date: '2026-09-18', search: '' });
    assert.deepEqual(basic.queue[beforeReload], { page_size: '50', workflow_status: 'submitted', kind: 'form', department_id: '2', form_id: '22', worker_id: '26', record_date: '2026-09-18', purpose: 'report' });
    console.log('ok - workflow shortcuts preserve other filters; reload restores structured filters before querying and never saves Find text or private labels');

    await switchFocus(basic, '3');
    assert.deepEqual(await values(page), blank);
    await selectFilters(basic, { status: 'in_review', template: '31', worker: '35', date: '2026-09-29', search: 'Other private search' });
    await switchFocus(basic, '2');
    assert.deepEqual(await values(page), { status: 'submitted', template: '22', worker: '26', date: '2026-09-18', search: '' });
    await switchFocus(basic, '');
    assert.deepEqual(await values(page), blank);
    await selectFilters(basic, { status: 'resolved', template: '31', worker: '35' });
    await switchFocus(basic, '3');
    assert.deepEqual(await values(page), { status: 'in_review', template: '31', worker: '35', date: '2026-09-29', search: '' });
    await switchFocus(basic, '');
    assert.deepEqual(await values(page), { status: 'resolved', template: '31', worker: '35', date: '', search: '' });
    console.log('ok - individual Departments and global All departments retain separate preferences and never carry Find text between scopes');

    await freshSession(basic, { ...supervisor, id: 75 }, '2');
    assert.deepEqual(await values(page), blank);
    await freshSession(basic, { ...supervisor, departmentId: 3 }, '2');
    assert.deepEqual(await values(page), blank);
    await freshSession(basic, { ...supervisor, isGlobalAdmin: false }, '2');
    assert.deepEqual(await values(page), blank);
    await freshSession(basic, supervisor, '2');
    assert.deepEqual(await values(page), { status: 'submitted', template: '22', worker: '26', date: '2026-09-18', search: '' });
    const beforeClear = basic.queue.length;
    await page.locator('#reportReviewFilters').evaluate((node) => { node.open = true; });
    await page.locator('#clearSupervisorFiltersButton').click();
    await waitQueue(basic, beforeClear);
    await basic.mount({ reload: true });
    assert.deepEqual(await values(page), blank);
    await switchFocus(basic, '3');
    assert.deepEqual(await values(page), { status: 'in_review', template: '31', worker: '35', date: '2026-09-29', search: '' });
    console.log('ok - logout/reset preserves the same identity preferences, account/home-Department/privilege changes isolate them, and Clear affects only the current scope');

    basic.setCatalog({ nextForms: templates.filter((item) => item.id !== 31), nextStaff: workers.filter((item) => item.id !== 35) });
    await page.evaluate(() => window.fixture.module.renderPanel());
    assert.deepEqual(await values(page), { status: 'in_review', template: '', worker: '', date: '2026-09-29', search: '' });
    assert.equal(basic.queue.at(-1).form_id, undefined);
    assert.equal(basic.queue.at(-1).worker_id, undefined);
    console.log('ok - deleted or no-longer-authorized Template/Worker IDs are discarded only after a successful fresh catalog validation');
  } finally { await basic.close(); }

  const recovery = await fixture(browser);
  try {
    const { page } = recovery;
    await selectFilters(recovery, { status: 'submitted', template: '21', worker: '25', date: '2026-09-18' });
    recovery.setCatalog({ formsFail: true, staffFail: true });
    await recovery.mount({ reload: true });
    assert.equal(await page.locator('#supervisorTemplateFilter').isDisabled(), true);
    assert.equal(await page.locator('#supervisorWorkerFilter').isDisabled(), true);
    assert.equal(await page.locator('#reportReviewPreferenceNotice').isVisible(), true);
    recovery.setCatalog();
    await page.evaluate(() => window.fixture.module.renderPanel());
    assert.deepEqual(await values(page), { status: 'submitted', template: '21', worker: '25', date: '2026-09-18', search: '' });
    assert.equal(await page.locator('#supervisorTemplateFilter').isDisabled(), false);
    assert.equal(await page.locator('#supervisorWorkerFilter').isDisabled(), false);
    console.log('ok - temporary catalog failures disable unavailable pickers without overwriting saved IDs; Refresh restores them after recovery');

    await page.evaluate(() => {
      const { preferences, state } = window.fixture;
      const key = preferences.reportReviewPreferenceKey(state.user, state.departmentFocusId);
      localStorage.setItem(key, '{not valid JSON');
    });
    await recovery.mount({ reload: true });
    assert.deepEqual(await values(page), blank);
    await page.evaluate(() => {
      const { preferences, state } = window.fixture;
      const key = preferences.reportReviewPreferenceKey(state.user, state.departmentFocusId);
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (target, value) {
        if (target === key) throw new DOMException('Storage unavailable', 'QuotaExceededError');
        return original.call(this, target, value);
      };
    });
    const before = recovery.queue.length;
    await shortcut(page, 'in_review').click();
    await waitQueue(recovery, before);
    assert.equal(await page.locator('#supervisorStatusFilter').inputValue(), 'in_review');
    assert.equal(await page.locator('#reportReviewPreferenceNotice').isVisible(), true);
    assert.match(await page.locator('#reportReviewPreferenceNotice').innerText(), /(?:remember|sav|storage|device|browser)/i);
    assert.equal(recovery.queue.at(-1).workflow_status, 'in_review');
    console.log('ok - malformed storage falls back safely, and storage write failures keep live filtering usable with a visible notice');

    await recovery.mount({ reload: true });
    await page.evaluate(() => {
      const key = window.fixture.preferences.reportReviewPreferenceKey(window.fixture.state.user, '2');
      const original = Storage.prototype.getItem;
      Storage.prototype.getItem = function (target) {
        if (target === key) throw new DOMException('Storage unavailable', 'SecurityError');
        return original.call(this, target);
      };
    });
    await freshSession(recovery, supervisor, '2');
    assert.deepEqual(await values(page), blank);
    assert.equal(await page.locator('#reportReviewPreferenceNotice').isVisible(), true);
    assert.equal(await page.evaluate(() => window.fixture.state.supervisorRecords.queueMode), 'live');
    console.log('ok - blocked preference reads fall back to usable empty filters without blocking the Report inbox');
  } finally { await recovery.close(); }

  const races = await fixture(browser);
  try {
    const { page } = races;
    races.paginate();
    await page.evaluate(() => window.fixture.module.renderPanel());
    races.hold('queue', (query) => Boolean(query.cursor));
    await page.locator('#reviewQueuePagination button').click();
    await page.waitForFunction(() => window.fixture.state.supervisorRecords.loadingMore);
    for (let count = 0; !races.held.length && count < 100; count++) await page.waitForTimeout(10);
    assert.equal(races.held.length, 1);
    const heldId = races.held[0].id;
    await switchFocus(races, '3');
    races.release();
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate((id) => window.fixture.state.supervisorRecords.reviewRecords.some((record) => record.backendRecordId === id), heldId), false);
    assert.ok((await page.evaluate(() => window.fixture.state.supervisorRecords.reviewRecords)).every((record) => record.departmentId === 3));
    console.log('ok - a delayed previous-Department cursor page cannot append to a new Department inbox');

    races.hold('queue', (query) => query.workflow_status === 'submitted');
    await shortcut(page, 'submitted').click();
    for (let count = 0; !races.held.length && count < 100; count++) await page.waitForTimeout(10);
    assert.equal(races.held.length, 1);
    const oldId = races.held[0].id;
    await page.locator('#reportReviewFilters').evaluate((node) => { node.open = true; });
    await page.locator('#supervisorStatusFilter').selectOption('in_review');
    races.release();
    // This intentionally observes before the debounce fires: old responses must already be invalidated.
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate((id) => window.fixture.state.supervisorRecords.reviewRecords.some((record) => record.backendRecordId === id), oldId), false);
    await page.waitForFunction(() => window.fixture.state.supervisorRecords.queueQuery.workflowStatus === 'in_review');
    const queuedBeforeScope = races.queue.length;
    await page.locator('#supervisorSearchInput').fill('Never carry this search');
    await switchFocus(races, '2');
    await page.waitForTimeout(320);
    assert.ok(races.queue.slice(queuedBeforeScope).every((query) => query.department_id === '2' && !query.search));
    console.log('ok - changing a filter invalidates an in-flight response before debounce, and Department changes cancel obsolete scheduled searches');

    await selectFilters(races, { status: 'resolved', template: '22', worker: '26', date: '2026-09-18' });
    for (const kind of ['templates', 'queue']) {
      races.hold(kind);
      const refresh = page.evaluate(() => window.fixture.module.renderPanel());
      for (let count = 0; !races.held.length && count < 100; count++) await page.waitForTimeout(10);
      assert.equal(races.held.length, 1);
      if (kind === 'templates') assert.equal(await shortcut(page, 'submitted').isDisabled(), true);
      await page.evaluate(() => {
        const { state } = window.fixture;
        state.user = { ...state.user, dashboardDepartmentId: 2, dashboardDepartmentName: 'Mutual' };
      });
      races.release();
      await refresh;
      assert.deepEqual(await values(page), { status: 'resolved', template: '22', worker: '26', date: '2026-09-18', search: '' });
      assert.equal(await shortcut(page, 'submitted').isDisabled(), false);
      assert.equal(await page.evaluate(() => window.fixture.state.supervisorRecords.queueMode), 'live');
    }
    console.log('ok - same-scope profile replacement during catalog or final queue loading preserves filters, finishes loading, and unlocks controls');

    races.hold('templates');
    const previousDepartmentRefresh = page.evaluate(() => window.fixture.module.renderPanel());
    for (let count = 0; !races.held.length && count < 100; count++) await page.waitForTimeout(10);
    assert.equal(races.held.length, 1);
    await switchFocus(races, '3');
    races.release();
    await previousDepartmentRefresh;
    assert.equal(await page.locator('#supervisorTemplateFilter option[value="22"]').count(), 0);
    assert.equal(await page.locator('#supervisorTemplateFilter option[value="31"]').count(), 1);
    assert.equal(await page.evaluate(() => window.fixture.state.supervisorRecords.queueQuery.departmentId), '3');
    assert.equal(await shortcut(page, 'submitted').isDisabled(), false);
    console.log('ok - a delayed old-scope catalog completion cannot restore foreign options or leave the new scope locked');

    const durableIds = await page.evaluate(() => window.fixture.state.supervisorRecords.reviewRecords.map((record) => record.backendRecordId));
    races.failQueue();
    await page.evaluate(() => window.fixture.module.renderPanel());
    assert.deepEqual(await page.evaluate(() => window.fixture.state.supervisorRecords.reviewRecords.map((record) => record.backendRecordId)), durableIds);
    assert.equal(await page.evaluate(() => window.fixture.state.supervisorRecords.queueMode), 'offline_read_only');
    assert.ok((await page.evaluate(() => window.fixture.state.supervisorRecords.reviewRecords)).every((record) => record.readOnly));
    assert.equal(await page.locator('#exportReportsPdfButton').isDisabled(), true);
    races.failQueue(false);
    await page.evaluate(() => window.fixture.module.renderPanel());
    assert.equal(await page.evaluate(() => window.fixture.state.supervisorRecords.queueMode), 'live');
    await switchFocus(races, '2');
    console.log('ok - failed same-scope Refresh keeps last durable results read-only and disables exports until reconnection');

    await selectFilters(races, { status: 'submitted', template: '21', worker: '25', date: '2026-09-18', search: 'Current export query' });
    await page.locator('#exportReportsPdfButton').click();
    for (let attempt = 0; !races.exports.length && attempt < 100; attempt++) await page.waitForTimeout(20);
    assert.equal(races.exports.length, 1, 'First PDF click after Find blur must export without needing a second click');
    assert.deepEqual(races.exports.at(-1).query, { template: 'submitted-form', workflow_status: 'submitted', form_id: '21', worker_id: '25', date_from: '2026-09-18', date_to: '2026-09-18', department_id: '2', purpose: 'report', search: 'Current export query' });
    assert.equal(races.exports.at(-1).query.cursor, undefined);
    console.log('ok - PDF export uses the current structured filters and session-only Find query across all pages, never a stale cursor');
  } finally { await races.close(); }

  const changedCatalog = await fixture(browser);
  try {
    const { page } = changedCatalog;
    for (const failure of [false, true]) {
      changedCatalog.setCatalog({ nextForms: templates, nextStaff: workers });
      await page.evaluate(() => window.fixture.module.renderPanel());
      await selectFilters(changedCatalog, { status: 'submitted', template: '21', worker: '25' });
      assert.equal(await page.locator('#reviewQueueList .record-card').count(), 1);
      if (failure) changedCatalog.setCatalog({ formsFail: true, staffFail: true });
      else changedCatalog.setCatalog({ nextForms: templates.filter((item) => item.id !== 21), nextStaff: workers.filter((item) => item.id !== 25) });
      changedCatalog.hold('queue');
      const pending = page.evaluate(() => window.fixture.module.renderPanel());
      for (let count = 0; !changedCatalog.held.length && count < 100; count++) await page.waitForTimeout(10);
      assert.equal(changedCatalog.held.length, 1);
      assert.equal(await page.locator('#supervisorTemplateFilter').inputValue(), '');
      assert.equal(await page.locator('#supervisorWorkerFilter').inputValue(), '');
      assert.equal(changedCatalog.held[0].query.form_id, undefined);
      assert.equal(changedCatalog.held[0].query.worker_id, undefined);
      assert.equal(await page.locator('#reviewQueueList .record-card').count(), 0, 'Old cards must clear when catalog validation changes the effective queue query');
      assert.equal(await page.locator('#reviewQueueDetail .record-card').count(), 0);
      assert.equal(await page.evaluate(() => window.fixture.state.supervisorRecords.reviewRecords.length), 0);
      assert.equal(await page.locator('#exportReportsPdfButton').isDisabled(), true, 'Exports must wait for the matching new query');
      assert.equal(await page.locator('#exportReportsCsvButton').isDisabled(), true);
      changedCatalog.release();
      await pending;
      assert.equal(await page.locator('#exportReportsPdfButton').isDisabled(), false);
      assert.equal(await page.locator('#reviewQueueList .record-card').count(), 1);
    }
    console.log('ok - refreshed catalog removals and failures clear old cards/details and disable exports until the changed queue query completes');
  } finally { await changedCatalog.close(); }

  const defaultScope = await fixture(browser);
  try {
    const { page } = defaultScope;
    await selectFilters(defaultScope, { status: 'in_review', template: '21', worker: '25', date: '2026-09-18' });
    defaultScope.hold('default');
    await page.locator('#saveDefaultDepartmentButton').click();
    for (let count = 0; !defaultScope.held.length && count < 100; count++) await page.waitForTimeout(10);
    assert.equal(defaultScope.held.length, 1);
    assert.deepEqual(defaultScope.held[0].body, { department_id: 2 });
    await switchFocus(defaultScope, '3');
    defaultScope.release();
    await page.waitForFunction(() => window.fixture.state.user.dashboardDepartmentId === 2);
    assert.equal(await page.locator('#supervisorDepartmentFilter').inputValue(), '3');
    assert.equal(await page.evaluate(() => window.fixture.state.departmentFocusId), '3');
    assert.match(await page.locator('#supervisorDepartmentHelp').innerText(), /Saved default view: Mutual/);
    assert.equal(await page.locator('#saveDefaultDepartmentButton').isDisabled(), false);
    assert.deepEqual(await values(page), blank);
    await switchFocus(defaultScope, '2');
    assert.deepEqual(await values(page), { status: 'in_review', template: '21', worker: '25', date: '2026-09-18', search: '' });
    assert.equal(await page.locator('#saveDefaultDepartmentButton').isDisabled(), true);
    console.log('ok - a saved-default response updates the same account after a focus switch without changing the current Department or its separate review filters');

    await switchFocus(defaultScope, '3');
    defaultScope.hold('default');
    await page.locator('#saveDefaultDepartmentButton').click();
    for (let count = 0; !defaultScope.held.length && count < 100; count++) await page.waitForTimeout(10);
    assert.equal(defaultScope.held.length, 1);
    const replacement = { ...supervisor, id: 75, name: 'Different Supervisor', dashboardDepartmentId: null };
    await freshSession(defaultScope, replacement, '3');
    await page.evaluate((user) => localStorage.setItem('geo_user', JSON.stringify(user)), replacement);
    const staleResponse = page.waitForResponse((response) => response.url().includes('/api/auth/default-department'));
    defaultScope.release();
    await (await staleResponse).finished();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => window.fixture.state.user.id), 75);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('geo_user')).id), 75, 'The API helper must not persist the stale account before the module guard');
    assert.match(await page.locator('#supervisorDepartmentHelp').innerText(), /Saved default view: All departments/);
    assert.deepEqual(await values(page), blank);
    console.log('ok - delayed default-Department responses cannot replace a new login or overwrite its saved browser identity');
  } finally { await defaultScope.close(); }

  const mobile = await fixture(browser);
  try {
    const { page } = mobile;
    for (const width of [320, 390]) for (const language of ['en', 'zh']) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(({ language, theme }) => {
        window.fixture.i18n.setLanguage(language);
        document.documentElement.dataset.theme = theme;
        document.querySelector('#reportReviewFilters').open = false;
      }, { language, theme });
      for (const status of ['', 'submitted', 'in_review']) {
        const button = shortcut(page, status);
        assert.equal(await button.isVisible(), true, 'Shortcuts stay visible when phone filters are collapsed');
        const box = await button.boundingBox();
        assert.ok(box.width >= 44 && box.height >= 44, `${width}/${language}/${theme}: shortcut target >=44px`);
        if (language === 'zh') assert.match(await button.innerText(), /[\u4e00-\u9fff]/);
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      assert.equal(overflow, false, `${width}/${language}/${theme}: no horizontal overflow`);
      await page.screenshot({ path: path.join(output, `review-filters-${width}-${language}-${theme}.png`), fullPage: true });
    }
    await page.evaluate(() => window.fixture.i18n.setLanguage('en'));
    await shortcut(page, 'submitted').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.fixture.state.supervisorRecords.queueQuery.workflowStatus === 'submitted');
    assert.equal(await shortcut(page, 'submitted').getAttribute('aria-pressed'), 'true');
    console.log('ok - shortcuts remain visible, translated, keyboard-operable and >=44px with no phone overflow at 320/390px in both themes');
  } finally { await mobile.close(); }

  const retained = await fixture(browser, { reportOnly: false });
  try {
    const { page } = retained;
    assert.equal(await page.locator('#supervisorStatusFilter').inputValue(), 'pending');
    assert.equal(retained.queue[0].status, 'pending');
    assert.equal(retained.queue[0].purpose, undefined);
    assert.equal(await shortcut(page, 'submitted').isVisible(), false);
    await page.locator('#supervisorStatusFilter').selectOption('approved');
    await page.waitForFunction(() => window.fixture.state.supervisorRecords.queueQuery.status === 'approved');
    assert.equal(await page.evaluate(() => [...Array(localStorage.length)].some((_, index) => localStorage.key(index).includes('review'))), false);
    console.log('ok - retained full-interface status filtering remains approve/reject based and does not save Report preferences');
  } finally { await retained.close(); }
} finally { await browser.close(); }

console.log('PASS - Report review filter browser regressions');
