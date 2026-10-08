import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59987'; // Fully intercepted; never contacts a server or live account.
const output = path.join(root, 'output', 'report-staff-simplicity.local');
const departments = [{ id: 1, name: 'Leader' }, { id: 2, name: 'Mutual' }];
const baseUser = { department_id: 2, department_name: 'Mutual', role: 'worker', status: 'active', is_global_admin: false };
const normal = { ...baseUser, id: 301, name: 'Normal fixture', email: 'normal@example.invalid', worker_class: 'normal' };
const leader = { ...baseUser, id: 302, name: 'Leading fixture', email: 'leading@example.invalid', worker_class: 'leader' };
const supervisor = { ...baseUser, id: 303, name: 'Review fixture', email: 'review@example.invalid', role: 'supervisor', worker_class: null };
const admin = { ...supervisor, id: 304, name: 'Admin fixture', email: 'admin@example.invalid', is_global_admin: true };
const invited = { ...normal, id: 305, name: 'Invited fixture', email: 'invited@example.invalid', password_setup_required: true,
  invitation_status: 'pending', invitation_expires_at: '2026-12-01T12:00:00Z' };
const template = { id: 401, department_id: 2, name: 'Inspection', status: 'active', template_purpose: 'report',
  definition_version: 1, fields: [{ id: 'notes', label: 'Notes', type: 'textarea', required: true }] };

async function fixture(browser, { user = admin, reportOnly = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, serviceWorkers: 'block' });
  const users = structuredClone([normal, leader, supervisor, admin, invited]);
  const mutations = [], errors = [], unexpected = [];
  await context.addInitScript((mode) => {
    window.__REPORT_ONLY_MODE_OVERRIDE__ = mode;
    localStorage.setItem('leader-theme', 'light');
  }, reportOnly);
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push(request.url());
      return route.abort();
    }
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Staff fixture</title>' });
    if (['/api/auth/me', '/api/auth/refresh'].includes(url.pathname)) return json(user);
    if (url.pathname === '/api/departments') return json(departments);
    if (url.pathname === '/api/sites') return json([]);
    if (url.pathname === '/api/work-forms') {
      assert.equal(url.searchParams.get('purpose'), reportOnly ? 'report' : null);
      return json([template]);
    }
    if (url.pathname === '/api/supervisor/users' && request.method() === 'GET') {
      return json(user.is_global_admin ? users : users.filter((entry) => !entry.is_global_admin && entry.department_id === user.department_id));
    }
    const userMatch = url.pathname.match(/^\/api\/supervisor\/users\/(\d+)$/);
    if (userMatch && request.method() === 'PATCH') {
      const payload = request.postDataJSON();
      mutations.push({ path: url.pathname, payload });
      const current = users.find((entry) => entry.id === Number(userMatch[1]));
      // The fixture models the existing backend omission contract, not a backend test:
      // worker roles retain the current class (or default normal), Supervisor clears it.
      const workerClass = payload.role === 'worker' ? payload.worker_class ?? current.worker_class ?? 'normal' : null;
      Object.assign(current, payload, { worker_class: workerClass });
      delete current.confirmed;
      return json(current);
    }
    if (['/api/supervisor/worker-invitations', '/api/supervisor/users'].includes(url.pathname) && request.method() === 'POST') {
      const payload = request.postDataJSON();
      mutations.push({ path: url.pathname, payload });
      const isInvitation = url.pathname.endsWith('worker-invitations');
      const created = { ...baseUser, ...payload, id: 400 + mutations.length,
        department_name: departments.find((entry) => entry.id === payload.department_id)?.name,
        ...(isInvitation ? { role: 'worker', password_setup_required: true, invitation_status: 'pending' } : {}) };
      users.push(created);
      return json(isInvitation ? { user: created, token: 'isolated_fixture_token_123456789012345678901234567890', expires_at: '2026-12-01T12:00:00Z' } : created);
    }
    if (url.pathname === '/api/supervisor/review-queue') {
      assert.equal(url.searchParams.get('purpose'), reportOnly ? 'report' : null);
      const counts = { total: 0, pending: 0, reviewed: 0, form: 0, attendance: 0, task: 0, team_log: 0 };
      return json({ items: [], counts, summary_counts: counts, has_more: false, next_cursor: null, snapshot_at: new Date().toISOString() });
    }
    if (url.pathname === '/api/my-form-submissions') {
      assert.equal(url.searchParams.get('purpose'), reportOnly ? 'report' : null);
      return json([]);
    }
    const retainedReads = ['/api/my-records', '/api/my-task-logs', '/api/my-team-work-logs', '/api/team-work-log-members',
      '/api/task-templates', '/api/supervisor/trash'];
    if (request.method() === 'GET' && (url.pathname === '/api/supervisor/audit-events' || (!reportOnly && retainedReads.includes(url.pathname)))) return json([]);
    if (url.pathname.startsWith('/api/')) {
      unexpected.push(`${request.method()} ${url.pathname}`);
      return json({ detail: 'Unexpected fixture request' }, 500);
    }
    const file = path.resolve(root, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    assert.ok(file.startsWith(`${root}${path.sep}`));
    let body = await readFile(file);
    const extension = path.extname(file);
    if (extension === '.js') body = body.toString()
      .replaceAll("import L from 'leaflet';", "import * as L from '/node_modules/leaflet/dist/leaflet-src.esm.js';")
      .replace(/^import 'leaflet\/dist\/leaflet\.css';?\r?\n/gm, '');
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
    return route.fulfill({ contentType: types[extension] || 'application/octet-stream', body });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/fixture`);
  await page.evaluate(async (value) => (await import('/assets/js/api-client.js')).saveSession(value), user);
  await page.goto(origin);
  await page.waitForFunction((role) => document.body.dataset.activeView === role, user.role);
  if (user.role === 'supervisor') {
    await page.locator('#staffUsersList .record-card').first().waitFor({ state: 'attached' });
    await openStaff(page);
  } else {
    await page.waitForFunction(() => document.querySelector('#workFormSelect').options.length > 1);
  }
  return { page, users, mutations,
    async close() {
      await context.close();
      assert.deepEqual(errors, [], 'No unhandled browser errors');
      assert.deepEqual(unexpected, [], 'No requests outside the explicit local fixture');
    }
  };
}

async function openStaff(page) {
  const desktop = page.locator('.admin-desktop-nav [data-admin-workspace-target="people"]');
  if (await desktop.isVisible()) await desktop.click();
  else {
    await page.locator('#adminMobileMenuButton').click();
    await page.locator('#adminWorkspaceDrawer [data-admin-workspace-target="people"]').click();
  }
  await page.locator('#staffUsersList').waitFor({ state: 'visible' });
}

const card = (page, user) => page.locator('#staffUsersList .record-card').filter({ hasText: user.email });
async function edit(page, user) {
  await card(page, user).locator('.record-actions button').first().click();
  await page.locator('#editUserName').waitFor({ state: 'visible' });
}

async function saveEdit(f) {
  const count = f.mutations.length;
  await f.page.locator('#editPanelForm button[type="submit"]').click();
  await f.page.locator('#confirmationDialog[open]').waitFor();
  await f.page.locator('#confirmationDialogConfirmButton').click();
  await f.page.locator('#supervisorEditPanel').waitFor({ state: 'hidden' });
  assert.equal(f.mutations.length, count + 1, 'Save makes exactly one mutation');
  return f.mutations.at(-1).payload;
}

async function assertSimpleCreation(page) {
  assert.equal(await page.locator('#staffWorkerClassSelect').isVisible(), false);
  assert.equal(await page.locator('#staffWorkerClassSelect').isDisabled(), true);
  assert.equal(await page.getByRole('combobox', { name: 'Worker class', exact: true }).count(), 0, 'Class is absent from the accessibility tree');
  await page.locator('#staffRoleSelect').focus();
  await page.keyboard.press('Tab');
  assert.notEqual(await page.evaluate(() => document.activeElement.id), 'staffWorkerClassSelect', 'Keyboard focus skips hidden class');
}

async function presentation(page, language, theme) {
  if (await page.evaluate(() => document.documentElement.dataset.language) !== language) await page.locator('#languageToggleButton').click();
  if (await page.evaluate(() => document.documentElement.dataset.theme) !== theme) await page.locator('#themeToggleButton').click();
}

let groups = 0;
const pass = (message) => { groups += 1; console.log(`ok - ${message}`); };
const browser = await chromium.launch({ headless: true });
try {
  await mkdir(output, { recursive: true });
  const editing = await fixture(browser);
  try {
    const { page } = editing;
    await page.locator('.admin-desktop-nav [data-admin-workspace-target="forms"]').click();
    await page.locator('#workFormsList [data-template-mutation-action="edit"]').first().click();
    await page.locator('#editWorkFormName').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#editWorkFormName').disabled);
    await page.evaluate(() => {
      // The real form-level input listener schedules this production callback.
      // Count scheduling, not just writes: an unchanged receipt can mask the bug.
      const original = window.setTimeout;
      window.templateAutosaveSchedules = 0;
      window.setTimeout = function (handler, delay, ...args) {
        if (typeof handler === 'function' && handler.toString().includes('flushTemplateDrafts')) window.templateAutosaveSchedules += 1;
        return original.call(this, handler, delay, ...args);
      };
    });
    await page.locator('#editWorkFormName').fill('Inspection editing draft');
    await page.waitForFunction(() => document.querySelector('#templateEditDraftStatus').textContent === 'Template draft saved on this device.');
    assert.ok(await page.evaluate(() => window.templateAutosaveSchedules) > 0, 'Real Template-name input still schedules autosave');
    const builder = page.locator('#templateEditForm [data-work-form-builder]');
    await builder.locator('[data-work-form-advanced] > summary').click();
    const pendingRaw = '\n  unsupported|Unfinished raw syntax|true| A, B  \n>text|\n\n';
    await builder.locator('[data-work-form-raw]').fill(pendingRaw);
    await page.waitForFunction(() => document.querySelector('#templateEditDraftStatus').textContent === 'Template draft saved on this device.');
    const drafts = () => page.evaluate(async () => {
      const { listTemplateDrafts } = await import('/assets/js/report-template-drafts.js');
      const { getSession } = await import('/assets/js/api-client.js');
      return listTemplateDrafts(getSession());
    });
    const savedBefore = await drafts();
    assert.equal(savedBefore.length, 1);
    assert.equal(savedBefore[0].builder.rawText, pendingRaw);
    assert.equal(savedBefore[0].builder.rawDirty, true);
    const scheduledBefore = await page.evaluate(() => window.templateAutosaveSchedules);
    const toggle = builder.locator('[data-work-form-advanced-options]');
    await toggle.focus();
    await page.keyboard.press('Space');
    assert.equal(await toggle.isChecked(), true);
    await toggle.focus();
    await page.keyboard.press('Space');
    assert.equal(await toggle.isChecked(), false);
    assert.equal(await page.evaluate(() => window.templateAutosaveSchedules), scheduledBefore,
      'View-only advanced options must not reach the real edit-form autosave scheduler');
    assert.equal(await builder.locator('[data-work-form-raw]').inputValue(), pendingRaw);
    assert.deepEqual(await drafts(), savedBefore, 'Toggle preserves exact stored draft, receipt revision and pending raw syntax');
    await page.locator('#editWorkFormDescription').fill('Description remains an ordinary draft edit');
    await page.waitForFunction(() => document.querySelector('#templateEditDraftStatus').textContent === 'Template draft saved on this device.');
    const savedAfter = await drafts();
    assert.equal(savedAfter[0].description, 'Description remains an ordinary draft edit');
    assert.equal(savedAfter[0].builder.rawText, pendingRaw);
    assert.ok(savedAfter[0].storeRevision > savedBefore[0].storeRevision);
    assert.equal(editing.mutations.length, 0, 'Draft and presentation changes never publish');
    pass('Actual Template edit form excludes view-only toggles from autosave while preserving pending raw syntax and ordinary saves');
  } finally { await editing.close(); }

  const f = await fixture(browser);
  try {
    const { page } = f;
    for (const user of [normal, leader]) assert.equal(await card(page, user).locator('.badge').innerText(), 'Worker');
    assert.equal(await page.locator('#userContextAdminBadge').textContent(), 'Super admin');
    await page.locator('#addStaffUserButton').click();
    await assertSimpleCreation(page);
    assert.equal(await page.locator('#staffPasswordInput').isVisible(), false, 'Private invitation flow remains');
    assert.equal(await page.locator('#staffGlobalAdminInput').isDisabled(), true);
    await page.locator('#staffRoleSelect').selectOption('supervisor');
    assert.equal(await page.locator('#staffGlobalAdminInput').isDisabled(), false);
    assert.equal(await page.locator('#staffPasswordInput').isVisible(), true);
    await page.locator('#staffGlobalAdminInput').focus();
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#staffGlobalAdminInput').isChecked(), true);
    await page.locator('#staffRoleSelect').selectOption('worker');
    assert.equal(await page.locator('#staffGlobalAdminInput').isChecked(), false);
    await assertSimpleCreation(page);
    await page.locator('#staffNameInput').fill('New worker fixture');
    await page.locator('#staffEmailInput').fill('new-worker@example.invalid');
    await page.locator('#staffWorkerClassSelect').evaluate((select) => { select.value = 'leader'; });
    await page.locator('#staffUserSubmitButton').click();
    await page.locator('#workerInvitationDialog[open]').waitFor();
    assert.deepEqual(f.mutations.at(-1), { path: '/api/supervisor/worker-invitations', payload: {
      name: 'New worker fixture', email: 'new-worker@example.invalid', worker_class: 'normal', department_id: 2
    } }, 'New report-only Worker explicitly defaults normal, even with a stale hidden value');
    await page.locator('#closeWorkerInvitationButton').click();
    pass('Report-only cards/create hide class, retain invitations and safely default normal');

    for (const user of [normal, leader]) {
      await edit(page, user);
      assert.equal(await page.locator('#editUserWorkerClass').count(), 0);
      assert.equal(await page.locator('#editUserPassword').count(), 0, 'Worker password recovery remains separate');
      await page.locator('#editUserName').fill(`${user.name} updated`);
      assert.deepEqual(await saveEdit(f), { name: `${user.name} updated`, email: user.email, role: 'worker', status: 'active',
        department_id: 2, is_global_admin: false, confirmed: true });
      assert.equal(f.users.find((entry) => entry.id === user.id).worker_class, user.worker_class);
    }
    pass('Normal and Leader name edits send no class field and preserve existing class');

    await edit(page, normal);
    f.users.find((entry) => entry.id === normal.id).worker_class = 'leader';
    await page.locator('#editUserEmail').fill('concurrent@example.invalid');
    const concurrent = await saveEdit(f);
    assert.equal(Object.hasOwn(concurrent, 'worker_class'), false);
    assert.equal(f.users.find((entry) => entry.id === normal.id).worker_class, 'leader', 'Omission preserves a class changed after edit opened');
    pass('Class omission cannot overwrite a concurrent retained-privilege change');

    await edit(page, leader);
    await page.locator('#editUserRole').selectOption('supervisor');
    assert.equal(await page.locator('#editUserGlobalAdmin').isDisabled(), false);
    await page.locator('#editUserGlobalAdmin').selectOption('true');
    const promote = await saveEdit(f);
    assert.equal(promote.role, 'supervisor');
    assert.equal(promote.is_global_admin, true);
    assert.equal(Object.hasOwn(promote, 'worker_class'), false);
    assert.equal(f.users.find((entry) => entry.id === leader.id).worker_class, null);
    await edit(page, leader);
    await page.locator('#editUserRole').selectOption('worker');
    assert.equal(await page.locator('#editUserGlobalAdmin').inputValue(), 'false');
    assert.equal(await page.locator('#editUserGlobalAdmin').isDisabled(), true);
    const demote = await saveEdit(f);
    assert.equal(demote.role, 'worker');
    assert.equal(demote.is_global_admin, false);
    assert.equal(Object.hasOwn(demote, 'worker_class'), false);
    assert.equal(f.users.find((entry) => entry.id === leader.id).worker_class, 'normal');
    pass('Explicit role transitions preserve global-admin guards and backend class/default ownership');

    await edit(page, admin);
    assert.equal(await page.locator('#editUserRole').isDisabled(), true);
    assert.equal(await page.locator('#editUserGlobalAdmin').isDisabled(), true);
    await page.locator('#supervisorSecondaryCancelEditButton').click();
    await edit(page, invited);
    assert.equal(await page.locator('#editUserRole').isDisabled(), true);
    assert.equal(await page.locator('#editUserWorkerClass').count(), 0);
    await page.locator('#supervisorSecondaryCancelEditButton').click();
    pass('Self and pending-invitation role restrictions remain unchanged');

    for (const width of [320, 390]) for (const [language, theme] of [['en', 'light'], ['zh', 'dark']]) {
      await page.setViewportSize({ width, height: 844 });
      await presentation(page, language, theme);
      await page.locator('#addStaffUserButton').click();
      await assertSimpleCreation(page);
      assert.equal(await page.locator('#staffDepartmentSelect').isVisible(), true);
      await page.locator('#staffNameInput').scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await page.screenshot({ path: path.join(output, `staff-create-${width}-${language}-${theme}.png`), animations: 'disabled' });
      await page.locator('#cancelStaffUserCreateButton').click();
      await edit(page, leader);
      assert.equal(await page.locator('#editUserWorkerClass').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await page.locator('#supervisorSecondaryCancelEditButton').click();
      assert.equal(await card(page, leader).locator('.badge').innerText(), language === 'zh' ? '员工' : 'Worker');
    }
    pass('320/390px English-light and Chinese-dark create/edit layouts remain usable and translated');
  } finally { await f.close(); }

  const department = await fixture(browser, { user: supervisor });
  try {
    await department.page.locator('#addStaffUserButton').click();
    await assertSimpleCreation(department.page);
    assert.equal(await department.page.locator('#staffGlobalAdminInput').isVisible(), false);
    assert.equal(await department.page.locator('#staffDepartmentSelect').isDisabled(), true);
    await department.page.locator('#cancelStaffUserCreateButton').click();
    await edit(department.page, leader);
    assert.equal(await department.page.locator('#editUserGlobalAdmin').count(), 0);
    assert.equal(await department.page.locator('#editUserDepartmentId').count(), 0);
    assert.equal(await department.page.locator('#editUserWorkerClass').count(), 0);
    await department.page.locator('#editUserName').fill('Department edited fixture');
    assert.deepEqual(await saveEdit(department), { name: 'Department edited fixture', email: leader.email,
      role: 'worker', status: 'active', confirmed: true });
    assert.equal(department.users.find((entry) => entry.id === leader.id).worker_class, 'leader');
    pass('Department Supervisor cannot gain class, Department or global-admin controls');
  } finally { await department.close(); }

  const retained = await fixture(browser, { reportOnly: false });
  try {
    const { page } = retained;
    assert.equal(await card(page, normal).locator('.badge').innerText(), 'normal');
    assert.equal(await card(page, leader).locator('.badge').innerText(), 'leader');
    await page.locator('#addStaffUserButton').click();
    assert.equal(await page.locator('#staffWorkerClassSelect').isVisible(), true);
    assert.equal(await page.locator('#staffWorkerClassSelect').isDisabled(), false);
    await page.locator('#staffNameInput').fill('Retained worker fixture');
    await page.locator('#staffEmailInput').fill('retained@example.invalid');
    await page.locator('#staffPasswordInput').fill('FixturePassword123!');
    await page.locator('#staffWorkerClassSelect').selectOption('leader');
    await page.locator('#staffUserSubmitButton').click();
    await page.locator('#staffUserCreatePanel').waitFor({ state: 'hidden' });
    assert.deepEqual(retained.mutations.at(-1), { path: '/api/supervisor/users', payload: { name: 'Retained worker fixture',
      email: 'retained@example.invalid', worker_class: 'leader', department_id: 2, password: 'FixturePassword123!', role: 'worker', is_global_admin: false } });
    await edit(page, normal);
    assert.equal(await page.locator('#editUserWorkerClass').isVisible(), true);
    await page.locator('#editUserRole').selectOption('supervisor');
    assert.equal(await page.locator('#editUserWorkerClass').isDisabled(), true);
    await page.locator('#editUserRole').selectOption('worker');
    assert.equal(await page.locator('#editUserWorkerClass').isDisabled(), false);
    await page.locator('#editUserWorkerClass').selectOption('leader');
    assert.equal((await saveEdit(retained)).worker_class, 'leader');
    pass('Retained full interface still displays, creates and edits Worker classes');
  } finally { await retained.close(); }

  for (const reportOnly of [true, false]) {
    const worker = await fixture(browser, { user: { ...leader, department_id: 1, department_name: 'Leader' }, reportOnly });
    try {
      const { page } = worker;
      assert.equal(await page.locator('#userContextGroup').textContent(), 'Leader', 'Department named Leader is not relabeled');
      assert.equal(await page.locator('#userContextAdminBadge').isVisible(), !reportOnly);
      if (!reportOnly) assert.equal(await page.locator('#userContextAdminBadge').textContent(), 'Leader');
      const session = await page.evaluate(async () => (await import('/assets/js/api-client.js')).getSession());
      assert.equal(session.workerClass, 'leader', 'Presentation never rewrites the saved class');
      assert.equal(worker.mutations.length, 0);
      pass(`${reportOnly ? 'Report-only' : 'Retained'} Worker topbar preserves Department and saved identity`);
    } finally { await worker.close(); }
  }
  console.log(`Report Staff simplicity checks passed (${groups} groups). Screenshots: ${output}`);
} finally { await browser.close(); }
