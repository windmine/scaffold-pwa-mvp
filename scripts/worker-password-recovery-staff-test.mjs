import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59979';
const token = 'RecoveryOnlyFixtureToken_1234567890';
const expiry = '2099-10-01T12:00:00Z';
const worker = { id: 3, name: '<img src=x onerror=alert(1)> Worker', email: 'worker@example.test', role: 'worker',
  department_id: 2, department_name: 'Test Department', status: 'active', password_setup_required: false };
const initialUsers = [worker,
  { ...worker, id: 4, name: 'Pending recovery', password_recovery_status: 'pending', password_recovery_expires_at: expiry },
  { ...worker, id: 5, name: 'New invite', password_setup_required: true, invitation_status: 'pending' },
  { ...worker, id: 6, name: 'Resigned Worker', status: 'resigned' },
  { ...worker, id: 7, name: 'Supervisor', role: 'supervisor' },
  { ...worker, id: 8, name: 'Other department', department_id: 9 }];
const html = (await readFile(path.join(root, 'index.html'), 'utf8'))
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
  .replace(/<link\b[^>]*>/gi, '');
const stubs = {
  'app-shell-state.js': 'export function defaultStaffDepartmentId(user) { return String(user?.departmentId || ""); }',
  'site-map-picker.js': `export function currentPosition() { throw new Error('Unexpected geolocation'); }
    export function createSiteMapPicker() { return { reset() {}, refresh() {}, bindEvents() {} }; }`,
  'work-form-builder.js': `export const workFormBuilderMarkup = '';
    export function createWorkFormBuilder() { return { reset() {}, getDraftState() { return { fields: [] }; } }; }`,
  'work-form-fields.js': 'export function renderWorkFormFields() {}',
  'report-template-drafts.js': `export function templateDraftScope() { return null; }
    export function listTemplateDrafts() { window.fixture.draftCalls++; return []; }
    export function saveTemplateDraft() { throw new Error('Recovery must not save drafts'); }
    export function removeTemplateDraft() { throw new Error('Recovery must not remove drafts'); }`
};
const allowedModules = new Set(['staff-sites.js', 'worker-invitation-dialog.js', 'api-client.js', 'ui-feedback.js', 'i18n.js', 'utils.js']);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
let users;
let requests;
let failMutation;
let failRefresh;
let holdMutation;
let releaseMutation;
await context.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, origin, 'External requests forbidden');
  if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
  if (url.pathname === '/api/supervisor/users') {
    return route.fulfill({ status: failRefresh ? 503 : 200, contentType: 'application/json',
      body: JSON.stringify(failRefresh ? { detail: 'Staff temporarily unavailable' } : users) });
  }
  const recovery = /^\/api\/supervisor\/users\/(\d+)\/password-recovery$/.exec(url.pathname);
  if (recovery) {
    const method = route.request().method();
    requests.push({ method, url: url.href, headers: route.request().headers(), body: route.request().postData() });
    if (holdMutation) await new Promise((resolve) => { releaseMutation = resolve; });
    if (failMutation) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ detail: 'Recovery request refused' }) });
    const updated = { ...users.find((user) => String(user.id) === recovery[1]),
      password_recovery_status: method === 'POST' ? 'pending' : 'revoked', password_recovery_expires_at: method === 'POST' ? expiry : null };
    users = users.map((user) => user.id === updated.id ? updated : user);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(method === 'POST'
      ? { user: updated, token, expires_at: expiry, delivery_method: 'manual' }
      : { user: updated, message: 'Recovery link revoked. The current password is unchanged.' }) });
  }
  const name = path.basename(url.pathname);
  if (stubs[name]) return route.fulfill({ contentType: 'text/javascript', body: stubs[name] });
  if (url.pathname.startsWith('/assets/js/') && allowedModules.has(name)) {
    return route.fulfill({ contentType: 'text/javascript', body: await readFile(path.join(root, 'assets/js', name), 'utf8') });
  }
  if (url.pathname.startsWith('/assets/') || url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
  throw new Error(`Unexpected request: ${url.href}`);
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

async function prepare({ confirm = 'yes', share = 'supported', clipboard = 'supported' } = {}) {
  users = structuredClone(initialUsers);
  requests = [];
  failMutation = false;
  failRefresh = false;
  holdMutation = false;
  releaseMutation = null;
  await page.goto(origin);
  await page.evaluate(async ({ confirm, share, clipboard }) => {
    window.fixture = { confirmations: [], banners: [], shareCalls: [], copied: [], draftCalls: 0 };
    document.cookie = 'geo_csrf_token=RecoveryCsrfFixture; SameSite=Lax; path=/';
    localStorage.clear();
    sessionStorage.clear();
    Object.defineProperty(navigator, 'share', { configurable: true, value: share === 'unsupported' ? undefined : (data) => {
      window.fixture.shareCalls.push({ data, userGesture: navigator.userActivation.isActive });
      if (share === 'pending') return new Promise((resolve) => { window.fixture.finishShare = resolve; });
      return Promise.resolve();
    } });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard === 'unsupported' ? undefined : {
      writeText: async (value) => { window.fixture.copied.push(value); }
    } });
    const els = new Proxy({}, { get: (_, id) => document.getElementById(id) });
    const state = { user: { id: 1, role: 'supervisor', departmentId: 2, isGlobalAdmin: false },
      departments: [{ id: 2, name: 'Test Department' }], departmentFocusId: '', staffUsers: [], workForms: [], sites: [] };
    const staff = (await import('/assets/js/staff-sites.js')).createStaffSitesModule({
      els, state, reportOnly: true, loadSites: async () => [], fillSiteSelects() {}, refreshWorkForms() {},
      renderStatusBanner: (message, error) => window.fixture.banners.push({ message, error }),
      showEditPanel: (title, fields) => {
        window.fixture.editFields = fields;
        for (const field of fields) {
          const control = document.createElement(field.type === 'select' ? 'select' : 'input');
          control.id = field.id;
          if (field.options) control.innerHTML = field.options.map((option) => `<option value="${option.value}">${option.label}</option>`).join('');
          control.value = field.value;
          document.body.append(control);
        }
      }, closeEditPanel() {},
      editValue() { throw new Error('Unexpected edit read'); }, editNumber() { throw new Error('Unexpected edit read'); },
      confirmAction: (options) => {
        window.fixture.confirmations.push(options);
        return confirm === 'pending' ? new Promise((resolve) => { window.fixture.finishConfirm = resolve; }) : Promise.resolve(confirm === 'yes');
      }
    });
    Object.assign(window.fixture, { els, state, staff });
    await staff.renderStaffUsers();
    let node = els.staffUsersList;
    while (node) { node.hidden = false; node.removeAttribute('aria-hidden'); if (node.tagName === 'DETAILS') node.open = true; node = node.parentElement; }
    const details = els.staffUsersList.closest('details');
    if (details) details.open = true;
  }, { confirm, share, clipboard });
}

function action(id, name) {
  return page.locator(`[data-password-recovery-user-id="${id}"]`).filter({ hasText: name });
}

async function openRecovery(id = 3) {
  await action(id, id === 4 ? 'Replace' : 'Create').click();
  await page.waitForFunction(() => document.getElementById('workerInvitationDialog').open);
}

async function settleAction() {
  await page.waitForFunction(() => [...document.querySelectorAll('[data-password-recovery-user-id]')].every((button) => !button.disabled));
}

try {
  await prepare();
  assert.equal(await page.locator('[data-password-recovery-user-id="3"]').count(), 1);
  assert.equal(await page.locator('[data-password-recovery-user-id="4"]').count(), 2);
  for (const id of [5, 6, 7, 8]) assert.equal(await page.locator(`[data-password-recovery-user-id="${id}"]`).count(), 0);
  assert.match(await page.locator('#staffUsersList').textContent(), /Password recovery link pending/);
  await page.locator('#staffUsersList article').first().locator('button').filter({ hasText: 'Edit user' }).click();
  assert.equal(await page.evaluate(() => window.fixture.editFields.some((field) => field.id === 'editUserPassword')), false);
  console.log('ok - recovery is offered only to active established in-scope Workers; report-only edit no longer sets their password');

  await openRecovery();
  await settleAction();
  const privateLink = `${origin}/recover-password.html#token=${token}`;
  assert.equal(await page.locator('#workerInvitationLink').inputValue(), privateLink);
  assert.equal(await page.locator('#workerInvitationTitle').textContent(), 'Worker recovery link ready');
  assert.equal(await page.locator('#workerInvitationLinkLabel').textContent(), 'Private recovery link');
  assert.equal(await page.locator('#workerInvitationIdentity img').count(), 0);
  assert.match(await page.locator('#workerInvitationHelp').textContent(), /Verify this Worker’s identity/);
  assert.match(await page.locator('#workerInvitationLinkNotice').textContent(), /current password stays unchanged/);
  assert.deepEqual(requests.map(({ method, body }) => ({ method, body })), [{ method: 'POST', body: null }]);
  assert.equal(requests[0].headers['x-csrf-token'], 'RecoveryCsrfFixture');
  assert.equal(requests[0].headers.cookie.includes('geo_csrf_token='), true);
  await page.locator('#shareWorkerInvitationButton').click();
  await page.waitForFunction(() => document.getElementById('workerInvitationStatus').textContent.startsWith('Sharing finished'));
  assert.deepEqual(await page.evaluate(() => window.fixture.shareCalls), [{ data: {
    title: 'ReportFlow password recovery', text: `Private recovery link for ${worker.name} (${worker.email}). Open it to choose your new password.`, url: privateLink
  }, userGesture: true }]);
  await page.locator('#copyWorkerInvitationButton').click();
  assert.deepEqual(await page.evaluate(() => window.fixture.copied), [privateLink]);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length + window.fixture.draftCalls), 0);
  await page.locator('#closeWorkerInvitationButton').click();
  assert.equal(await page.locator('#workerInvitationLink').inputValue(), '');
  console.log('ok - recovery link uses private fragment, safe identity, manual gesture Share/Copy, CSRF, and never persists token or touches drafts');

  await prepare();
  await openRecovery(4);
  assert.match(await page.evaluate(() => window.fixture.confirmations[0].message), /previous recovery link will stop working/);
  await settleAction();
  await page.locator('#closeWorkerInvitationButton').click();
  await action(4, 'Revoke').click();
  await settleAction();
  assert.deepEqual(requests.map((request) => request.method), ['POST', 'DELETE']);
  assert.equal(await action(4, 'Revoke').count(), 0);
  assert.equal(await action(4, 'Create').count(), 1);
  assert.match(await page.evaluate(() => window.fixture.banners.at(-1).message), /current password is unchanged/);
  console.log('ok - replacing invalidates prior link explicitly, revoking changes metadata without changing password');

  await prepare({ confirm: 'no' });
  await action(3, 'Create').click();
  await settleAction();
  assert.equal(requests.length, 0);
  assert.equal(await page.locator('#workerInvitationDialog').isVisible(), false);
  console.log('ok - cancelled recovery confirmation issues no request');

  await prepare({ confirm: 'pending' });
  await action(4, 'Replace').click();
  await action(4, 'Replace').evaluate((button) => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await action(4, 'Revoke').evaluate((button) => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  assert.equal(await page.evaluate(() => window.fixture.confirmations.length), 1);
  holdMutation = true;
  await page.evaluate(() => window.fixture.finishConfirm(true));
  await page.waitForFunction(() => document.querySelector('[data-password-recovery-user-id="4"]').getAttribute('aria-busy') === 'true');
  await action(4, 'Revoke').evaluate((button) => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.waitForTimeout(30);
  assert.equal(requests.length, 1);
  releaseMutation();
  await page.waitForFunction(() => document.getElementById('workerInvitationDialog').open);
  await settleAction();
  console.log('ok - confirmation and transport are single-flight across both recovery controls');

  for (const change of ['logout', 'scope', 'workspace', 'identity', 'status']) {
    await prepare();
    holdMutation = true;
    await action(3, 'Create').click();
    await page.waitForFunction(() => document.querySelector('[data-password-recovery-user-id="3"]').getAttribute('aria-busy') === 'true');
    while (!releaseMutation) await new Promise((resolve) => setTimeout(resolve, 5));
    await page.evaluate((change) => {
      const { staff, state } = window.fixture;
      if (change === 'logout') { staff.resetSession(); state.user = null; }
      if (change === 'scope') { state.departmentFocusId = '9'; staff.renderFilteredStaffUsers(); }
      if (change === 'workspace') staff.clearPrivateLinks();
      if (change === 'identity') state.staffUsers.find((user) => user.id === 3).email = 'changed@example.test';
      if (change === 'status') state.staffUsers.find((user) => user.id === 3).status = 'resigned';
    }, change);
    releaseMutation();
    await settleAction();
    await page.waitForTimeout(20);
    assert.equal(await page.locator('#workerInvitationDialog').isVisible(), false, change);
    assert.equal(await page.locator('#workerInvitationLink').inputValue(), '', change);
  }
  console.log('ok - logout, scope/workspace switch and changed Worker identity/status suppress late recovery secrets');

  await prepare({ confirm: 'pending' });
  await action(3, 'Create').click();
  await page.evaluate(() => { window.fixture.staff.clearPrivateLinks(); window.fixture.finishConfirm(true); });
  await settleAction();
  assert.equal(requests.length, 0);
  console.log('ok - leaving during confirmation suppresses the mutation itself');

  await prepare();
  failMutation = true;
  await action(3, 'Create').click();
  await settleAction();
  assert.equal(await page.locator('#workerInvitationDialog').isVisible(), false);
  assert.equal(await page.evaluate(() => window.fixture.banners.at(-1).message), 'Recovery request refused');
  failMutation = false;
  failRefresh = true;
  await openRecovery();
  await settleAction();
  assert.equal(await page.locator('#workerInvitationLink').inputValue(), privateLink);
  assert.match(await page.evaluate(() => window.fixture.banners.at(-1).message), /still share the new link privately/);
  assert.equal(await action(3, 'Replace').count(), 1);
  assert.equal(await action(3, 'Revoke').count(), 1);
  console.log('ok - request failure remains retryable; successful link and accurate actions survive list-refresh failure');

  await prepare({ share: 'pending' });
  await openRecovery();
  await page.locator('#shareWorkerInvitationButton').click();
  await page.evaluate(() => { window.fixture.staff.clearPrivateLinks(); window.fixture.finishShare(); });
  await page.waitForFunction(() => !document.getElementById('shareWorkerInvitationButton').disabled);
  assert.equal(await page.locator('#workerInvitationLink').inputValue(), '');
  assert.equal(await page.locator('#workerInvitationStatus').textContent(), '');
  assert.equal(await page.locator('#workerInvitationDialog').isVisible(), false);
  console.log('ok - clearing private links suppresses a pending native-share completion');

  await prepare({ share: 'unsupported', clipboard: 'unsupported' });
  await openRecovery();
  assert.equal(await page.locator('#shareWorkerInvitationButton').isVisible(), false);
  await page.locator('#copyWorkerInvitationButton').click();
  assert.match(await page.locator('#workerInvitationStatus').textContent(), /Select and copy/);
  assert.equal(await page.evaluate(() => {
    const input = document.getElementById('workerInvitationLink');
    return input.value.slice(input.selectionStart, input.selectionEnd);
  }), privateLink);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#workerInvitationLink').inputValue(), '');
  assert.equal(await page.evaluate(() => window.fixture.draftCalls), 0);
  assert.deepEqual(errors, []);
  console.log('ok - unsupported sharing/clipboard keeps manual selection fallback and Escape clears recovery secrets');
} finally {
  if (releaseMutation) releaseMutation();
  await context.close();
  await browser.close();
}
