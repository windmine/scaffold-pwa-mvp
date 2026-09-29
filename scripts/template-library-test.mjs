import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59973'; // Fully intercepted: no server or live API is contacted.
const output = path.join(root, 'output', 'template-library.local');
const supervisor = { id: 74, role: 'supervisor', departmentId: 2, isGlobalAdmin: true, name: 'Library Supervisor' };
const description = 'Inspect access routes, scaffold condition, fall protection and housekeeping before the crew begins work. '
  + 'Record hazards and the follow-up action for each area; this long description stays available in the full preview.';
const fields = [
  { id: 'section', type: 'section', label: 'Detailed inspection section' },
  { id: 'notes', type: 'textarea', label: 'Full inspection findings', required: true },
  { id: 'signed', type: 'signature', label: 'Supervisor handwritten approval', required: true },
  { id: 'areas', type: 'repeat', label: 'Areas inspected', min_rows: 1, max_rows: 10 },
  { id: 'hazards', type: 'number', label: 'Hazard count per area', repeat: 'areas' },
  { id: 'total', type: 'formula', label: 'Calculated hazard total', formula: 'hazards' }
];
const templates = [
  { id: 81, department_id: 2, name: 'Site safety inspection', description, fields,
    status: 'active', template_purpose: 'report', definition_version: 4 },
  { id: 82, department_id: 2, name: '<img src=x onerror=alert(1)> Gear check',
    description: '<svg onload=alert(2)> Mutual scaffold equipment & PPE',
    fields: [{ id: 'hostile', type: 'text', label: '<img src=x onerror=alert(3)> Detailed equipment check' }],
    status: 'active', template_purpose: 'report', definition_version: 1 },
  { id: 83, department_id: 2, name: 'First aid inspection', description: 'Archived incident record', fields: [],
    status: 'archived', template_purpose: 'report', definition_version: 2 },
  { id: 84, department_id: 3, name: 'Other Department inspection', description: 'Different Department', fields: [],
    status: 'active', template_purpose: 'report', definition_version: 1 },
  { id: 85, department_id: 2, name: 'Legacy Daywork inspection', description: 'Never appears in Report-only library', fields: [],
    status: 'active', template_purpose: 'daywork', definition_version: 1 },
  { id: 86, department_id: 2, name: 'Legacy unclassified inspection', description: 'No Report purpose', fields: [],
    status: 'active', definition_version: 1 }
];
const sourceHtml = (await readFile(path.join(root, 'index.html'), 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const stubs = {
  'app-shell-state.js': 'export function defaultStaffDepartmentId(user) { return String(user?.departmentId || ""); }',
  'site-map-picker.js': `export function currentPosition() { throw new Error('Unexpected geolocation'); }
    export function createSiteMapPicker() { return { reset() {}, refresh() {}, bindEvents() {} }; }`
};

async function fixture(browser, { reportOnly = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const errors = [];
  const unexpected = [];
  const mutations = [];
  let forms = structuredClone(templates);
  let holdMutations = false;
  let holdRefreshes = false;
  let rejectMutation = false;
  const held = [];
  const heldRefreshes = [];
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push(url.origin);
      return route.abort();
    }
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: sourceHtml });
    if (url.pathname === '/api/work-forms') {
      assert.equal(url.searchParams.get('purpose'), reportOnly ? 'report' : null);
      if (holdRefreshes) await new Promise((resolve) => heldRefreshes.push(resolve));
      // Deliberately include retained records to exercise the renderer's additional purpose guard.
      return json(forms);
    }
    if (url.pathname === '/api/supervisor/work-forms' && request.method() === 'POST') {
      const body = request.postDataJSON();
      mutations.push({ method: request.method(), body });
      const created = { status: 'active', template_purpose: 'report', ...body, id: 100, department_id: 2, definition_version: 1 };
      forms.push(created);
      return json(created);
    }
    const match = /^\/api\/supervisor\/work-forms\/(\d+)$/.exec(url.pathname);
    if (match && request.method() === 'PATCH') {
      const body = request.postDataJSON();
      mutations.push({ id: Number(match[1]), method: request.method(), body, headers: request.headers() });
      if (holdMutations) await new Promise((resolve) => held.push(resolve));
      if (rejectMutation) return json({ detail: 'Template update unavailable' }, 503);
      const form = forms.find((item) => item.id === Number(match[1]));
      Object.assign(form, body);
      return json(form);
    }
    if (url.pathname.startsWith('/api/')) {
      unexpected.push(`${request.method()} ${url.pathname}`);
      return json({ detail: 'Unexpected fixture API request' }, 500);
    }
    const name = path.basename(url.pathname);
    if (stubs[name]) return route.fulfill({ contentType: 'text/javascript', body: stubs[name] });
    const file = path.resolve(root, url.pathname.slice(1));
    assert.ok(file.startsWith(`${root}${path.sep}`), 'Only repository files are served');
    const types = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    return route.fulfill({ contentType: types[path.extname(file)] || 'application/octet-stream', body: await readFile(file) });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => { errors.push(`Unexpected ${dialog.type()} dialog: ${dialog.message()}`); void dialog.dismiss(); });
  await page.goto(origin);
  await page.evaluate(async ({ templates, supervisor, reportOnly }) => {
    localStorage.clear();
    sessionStorage.clear();
    document.cookie = 'geo_csrf_token=TemplateLibraryFixture; SameSite=Lax; path=/';
    document.documentElement.dataset.theme = 'light';
    document.body.dataset.activeView = 'supervisor';
    document.body.classList.toggle('report-only-mode', reportOnly);
    document.querySelectorAll('.view').forEach((view) => {
      const current = view.id === 'supervisorView';
      view.hidden = !current;
      view.classList.toggle('hidden', !current);
      view.classList.toggle('active', current);
    });
    document.querySelectorAll('[data-admin-workspace-panel]').forEach((panel) => { panel.hidden = panel.id !== 'adminFormsWorkspace'; });
    document.querySelector('#adminMobileWorkspaceLabel').textContent = 'Report Templates';
    document.querySelectorAll('[data-admin-workspace-target]').forEach((link) => {
      if (link.dataset.adminWorkspaceTarget === 'forms') link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    const els = new Proxy({}, { get: (_, id) => document.getElementById(id) });
    const state = { user: supervisor, departmentFocusId: '2', adminWorkspace: 'forms',
      departments: [{ id: 2, name: 'Mutual' }, { id: 3, name: 'Other Department' }], workForms: templates, staffUsers: [], sites: [] };
    const api = await import('/assets/js/api-client.js');
    const i18n = await import('/assets/js/i18n.js');
    window.fixture = { els, state, banners: [], refreshes: 0 };
    const refreshWorkForms = async () => {
      window.fixture.refreshes += 1;
      state.workForms = await api.getWorkForms(reportOnly ? 'report' : '');
      window.fixture.staff.renderWorkFormsList();
      return true;
    };
    const staff = (await import('/assets/js/staff-sites.js')).createStaffSitesModule({
      els, state, reportOnly, loadSites: async () => [], fillSiteSelects() {}, refreshWorkForms,
      renderStatusBanner: (message, error) => window.fixture.banners.push({ message, error }),
      showEditPanel() { throw new Error('Unexpected retained editor'); }, closeEditPanel() {},
      editValue() { throw new Error('Unexpected edit read'); }, editNumber() { throw new Error('Unexpected edit read'); },
      confirmAction: async () => true
    });
    Object.assign(window.fixture, { staff, refreshWorkForms, i18n });
    staff.bindEvents();
    staff.renderWorkFormsList();
    await staff.renderTemplateDrafts();
    i18n.initLanguageToggle({ button: els.languageToggleButton });
    els.themeToggleButton.addEventListener('click', () => {
      document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    });
  }, { templates, supervisor, reportOnly });
  await page.locator('#workFormsList').waitFor({ state: 'visible' });
  return { page, context, mutations,
    hold() { holdMutations = true; },
    holdRefresh() { holdRefreshes = true; },
    reject(value) { rejectMutation = value; },
    async release() {
      for (let attempts = 0; !held.length && attempts < 100; attempts += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(held.length, 'A mutation is waiting');
      holdMutations = false;
      held.splice(0).forEach((resolve) => resolve());
    },
    async releaseRefresh() {
      for (let attempts = 0; !heldRefreshes.length && attempts < 100; attempts += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(heldRefreshes.length, 'A Template refresh is waiting');
      holdRefreshes = false;
      heldRefreshes.splice(0).forEach((resolve) => resolve());
    },
    async close() {
      held.splice(0).forEach((resolve) => resolve());
      heldRefreshes.splice(0).forEach((resolve) => resolve());
      await context.close();
      assert.deepEqual(errors, [], 'No unhandled errors, alerts, or unsafe HTML');
      assert.deepEqual(unexpected, [], 'No external or unexpected requests');
    }
  };
}

const cards = (page) => page.locator('#workFormsList .template-library-card');
const card = (page, name) => cards(page).filter({ has: page.locator('.record-title', { hasText: name }) });
async function titles(page) { return page.locator('#workFormsList .record-title').allTextContents(); }
async function assertCards(page, expected) {
  await page.waitForFunction((expected) => JSON.stringify([...document.querySelectorAll('#workFormsList .record-title')].map((node) => node.textContent)) === JSON.stringify(expected), expected);
  assert.deepEqual(await titles(page), expected);
}
async function resetFilters(page) { await page.locator('#clearWorkFormFiltersButton').click(); }
async function setPresentation(page, language, theme) {
  await page.evaluate(({ language, theme }) => {
    window.fixture.i18n.setLanguage(language);
    document.documentElement.dataset.theme = theme;
  }, { language, theme });
}

const browser = await chromium.launch({ headless: true });
try {
  await mkdir(output, { recursive: true });
  const basic = await fixture(browser);
  try {
    const { page } = basic;
    await assertCards(page, [templates[0].name, templates[1].name]);
    assert.equal(await page.locator('#workFormStatusFilter').inputValue(), 'active');
    assert.equal(await page.locator('#workFormSearchInput').inputValue(), '');
    assert.equal(await page.locator('#workFormsResults').getAttribute('role'), 'status');
    assert.equal(await page.locator('#workFormsResults').isVisible(), true);
    assert.match(await page.locator('#workFormsResults').innerText(), /2.*3/);
    const summary = await card(page, templates[0].name).locator('.template-library-summary').innerText();
    assert.match(summary, /4 fields/);
    assert.match(summary, /1 signature/);
    assert.match(summary, /1 repeating group/);
    assert.match(summary, /(?:Version|version|v)\s*4/);
    assert.equal(await card(page, templates[0].name).getByText(fields[1].label, { exact: true }).count(), 0);
    assert.equal(await page.locator('#workFormsList').getByText(templates[4].name, { exact: true }).count(), 0);
    console.log('ok - library defaults to Active, reports scoped matching/total counts, and replaces field dumps with compact structural summaries');

    await page.locator('#workFormSearchInput').fill('  MUTUAL  ');
    await assertCards(page, [templates[1].name]);
    await page.locator('#workFormSearchInput').fill('inspection');
    await assertCards(page, [templates[0].name]);
    await page.locator('#workFormStatusFilter').selectOption('archived');
    await assertCards(page, [templates[2].name]);
    await page.locator('#workFormStatusFilter').selectOption('all');
    await assertCards(page, [templates[0].name, templates[2].name]);
    await page.locator('#workFormSearchInput').fill('no-such-template');
    await assertCards(page, []);
    assert.match(await page.locator('#workFormsResults').innerText(), /0.*3/);
    assert.match(await page.locator('#workFormsList').innerText(), /no.*(?:match|found)|try|clear/i);
    await resetFilters(page);
    await assertCards(page, [templates[0].name, templates[1].name]);
    assert.equal(await page.locator('#workFormStatusFilter').inputValue(), 'active');
    assert.equal(await page.locator('#workFormSearchInput').inputValue(), '');
    console.log('ok - trimmed case-insensitive name/description search combines with Active/Archived/All, handles no results, and Clear restores defaults');

    const hostile = card(page, templates[1].name);
    assert.equal(await hostile.locator('img, svg, script').count(), 0);
    assert.match(await hostile.innerText(), /<svg onload=alert\(2\)>/);
    await hostile.getByRole('button', { name: 'Preview', exact: true }).click();
    assert.match(await hostile.locator('[data-work-form-preview]').innerText(), /<img src=x onerror=alert\(3\)> Detailed equipment check/);
    assert.equal(await hostile.locator('img, svg, script').count(), 0);
    await hostile.getByRole('button', { name: 'Hide preview', exact: true }).click();
    const first = card(page, templates[0].name);
    await first.getByRole('button', { name: 'Preview', exact: true }).click();
    assert.equal(await first.locator('[data-work-form-preview]').isVisible(), true);
    assert.match(await first.locator('[data-work-form-preview]').innerText(), /Full inspection findings/);
    assert.match(await first.locator('[data-work-form-preview]').innerText(), /Supervisor handwritten approval/);
    assert.ok((await first.locator('[data-work-form-preview]').innerText()).includes(description));
    await first.getByRole('button', { name: 'Hide preview', exact: true }).click();
    await setPresentation(page, 'zh', 'dark');
    assert.equal(await hostile.locator('.record-title').innerText(), templates[1].name);
    assert.match(await page.locator('#workFormsResults').innerText(), /[\u4e00-\u9fff]/);
    await setPresentation(page, 'en', 'light');
    console.log('ok - user labels/descriptions remain literal, bilingual controls translate, and full definitions stay available through Preview');

    await page.locator('#workFormSearchInput').fill('inspection');
    await card(page, templates[0].name).getByRole('button', { name: 'Archive', exact: true }).focus();
    await page.keyboard.press('Enter');
    await assertCards(page, []);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'workFormStatusFilter', 'Keyboard focus returns to the status filter when the changed card disappears');
    assert.equal(await page.locator('#workFormSearchInput').inputValue(), 'inspection');
    assert.equal(await page.locator('#workFormStatusFilter').inputValue(), 'active');
    await page.locator('#workFormStatusFilter').selectOption('archived');
    await assertCards(page, [templates[0].name, templates[2].name]);
    await card(page, templates[0].name).getByRole('button', { name: 'Activate', exact: true }).click();
    await assertCards(page, [templates[2].name]);
    await page.locator('#workFormStatusFilter').selectOption('active');
    await assertCards(page, [templates[0].name]);
    assert.deepEqual(basic.mutations.map(({ body }) => body), [{ status: 'archived', confirmed: true }, { status: 'active', confirmed: true }]);
    assert.equal(basic.mutations[0].headers['x-csrf-token'], 'TemplateLibraryFixture');
    console.log('ok - archive/reactivate immediately respect the current status filter and preserve the search, with existing CSRF transport');
  } finally { await basic.close(); }

  const pending = await fixture(browser);
  try {
    const { page } = pending;
    pending.hold();
    await card(page, templates[0].name).getByRole('button', { name: 'Archive', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#workFormsList [aria-busy="true"]'));
    await page.locator('#workFormSearchInput').fill('inspection');
    await resetFilters(page);
    const redrawnButton = card(page, templates[0].name).locator('.record-actions button').last();
    assert.equal(await redrawnButton.isDisabled(), true, 'Filter redraw must retain the in-flight status lock');
    await redrawnButton.evaluate((button) => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForTimeout(20);
    assert.equal(pending.mutations.length, 1, 'Programmatic duplicate event cannot create a second mutation');
    await pending.release();
    await assertCards(page, [templates[1].name]);
    console.log('ok - pending status changes remain single-flight after search/Clear rebuild the library cards');
  } finally { await pending.close(); }

  const locked = await fixture(browser);
  try {
    const { page } = locked;
    locked.hold();
    await card(page, templates[0].name).getByRole('button', { name: 'Archive', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#workFormsList [aria-busy="true"]'));
    assert.equal(await page.evaluate(async () => (await window.fixture.staff.prepareForNavigation()).safe), true);
    await page.locator('#workFormSearchInput').fill('gear');
    await resetFilters(page);
    assert.equal(await page.locator('#workFormsList .record-actions button:enabled').count(), 0, 'All new cards inherit the editor/navigation lock');
    await locked.release();
    await assertCards(page, [templates[1].name]);
    await page.waitForFunction(() => !document.querySelector('#workFormsList [aria-busy="true"]'));
    assert.equal(await page.locator('#workFormsList .record-actions button:enabled').count(), 0, 'Finishing a status request does not bypass the editor/navigation lock');
    await page.evaluate(() => window.fixture.staff.cancelNavigationPreparation());
    assert.equal(await page.locator('#workFormsList .record-actions button:disabled').count(), 0, 'Unlock restores all replacement card controls after the request completed');
    console.log('ok - status completion and filter redraw retain the editor/navigation lock, then restore usable replacement controls on unlock');
  } finally { await locked.close(); }

  const publication = await fixture(browser);
  try {
    const { page } = publication;
    await card(page, templates[1].name).getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator('#templateEditPanel').waitFor({ state: 'visible' });
    await page.locator('#editWorkFormName').fill('Saved equipment check');
    publication.holdRefresh();
    await page.locator('#saveTemplateEditButton').click();
    await page.waitForFunction(() => window.fixture.refreshes >= 2);
    await page.locator('#workFormSearchInput').fill('inspection');
    await resetFilters(page);
    assert.equal(await page.locator('#workFormsList .record-actions button:enabled').count(), 0, 'Filter redraw cannot enable cards while publication awaits its refresh');
    await publication.releaseRefresh();
    await assertCards(page, [templates[0].name, 'Saved equipment check']);
    await page.waitForFunction(() => [...document.querySelectorAll('#workFormsList .record-actions button')].every((button) => !button.disabled));
    assert.equal(await page.locator('#templateEditPanel').isVisible(), false);
    assert.equal(await page.locator('#workFormsList .record-actions button:disabled').count(), 0, 'All replacement card controls are usable after publication finishes');
    console.log('ok - held publication refresh plus filter redraw locks every card action and restores all controls once publication completes');
  } finally { await publication.close(); }

  const failed = await fixture(browser);
  try {
    const { page } = failed;
    await page.locator('#workFormSearchInput').fill('inspection');
    failed.hold();
    failed.reject(true);
    await card(page, templates[0].name).getByRole('button', { name: 'Archive', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#workFormsList [aria-busy="true"]'));
    await page.locator('#workFormSearchInput').fill('INSPECTION');
    assert.equal(await card(page, templates[0].name).locator('[data-template-mutation-action="status"]').isDisabled(), true);
    await failed.release();
    await page.waitForFunction(() => !document.querySelector('#workFormsList [aria-busy="true"]'));
    assert.equal(await page.locator('#workFormSearchInput').inputValue(), 'INSPECTION');
    assert.equal(await page.locator('#workFormStatusFilter').inputValue(), 'active');
    assert.equal(await card(page, templates[0].name).locator('.record-actions button:disabled').count(), 0);
    assert.equal(await page.evaluate(() => window.fixture.banners.at(-1).message), 'Template update unavailable');
    failed.reject(false);
    await card(page, templates[0].name).getByRole('button', { name: 'Archive', exact: true }).click();
    await assertCards(page, []);
    assert.equal(failed.mutations.length, 2, 'A failed status mutation becomes retryable once, without duplicate requests');
    console.log('ok - failed status changes release redrawn locks, preserve current filters and allow an explicit retry');
  } finally { await failed.close(); }

  for (const change of ['scope', 'account']) {
    const stale = await fixture(browser);
    try {
      const { page } = stale;
      stale.hold();
      await card(page, templates[0].name).getByRole('button', { name: 'Archive', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#workFormsList [aria-busy="true"]'));
      await page.evaluate((change) => {
        const { state, staff } = window.fixture;
        if (change === 'scope') state.departmentFocusId = '3';
        else { staff.resetSession(); state.user = { ...state.user, id: 75 }; }
        staff.renderWorkFormsList();
      }, change);
      await stale.release();
      await page.waitForTimeout(80);
      assert.equal(await page.evaluate(() => window.fixture.refreshes), 0, 'Stale status completion must not refresh another scope/session');
      assert.deepEqual(await page.evaluate(() => window.fixture.banners), [], 'Stale completion must not announce success for a different scope/session');
    } finally { await stale.close(); }
  }
  console.log('ok - Department/account changes suppress late status completion in the replacement library');

  const drafts = await fixture(browser);
  try {
    const { page } = drafts;
    await card(page, templates[0].name).getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator('#templateEditPanel').waitFor({ state: 'visible' });
    await page.locator('#editWorkFormName').fill('Private unfinished edit');
    const editRaw = page.locator('#templateEditForm [data-work-form-raw]');
    await page.locator('#templateEditForm [data-work-form-advanced] summary').click();
    await editRaw.fill('unfinished|raw|syntax\n  keep this exactly');
    await page.evaluate(async () => {
      await window.fixture.staff.flushTemplateDrafts();
      await window.fixture.staff.renderTemplateDrafts();
      window.fixture.editorNode = document.getElementById('editWorkFormName');
      window.fixture.rawNode = document.querySelector('#templateEditForm [data-work-form-raw]');
      window.fixture.draftNode = document.querySelector('#templateDraftsList article');
    });
    assert.equal(await page.locator('#templateDraftsPanel').isVisible(), true);
    await page.locator('#workFormSearchInput').fill('no matching published Template');
    await page.locator('#workFormStatusFilter').selectOption('archived');
    await resetFilters(page);
    assert.equal(await page.locator('#templateEditPanel').isVisible(), true);
    assert.equal(await page.locator('#editWorkFormName').inputValue(), 'Private unfinished edit');
    assert.equal(await editRaw.inputValue(), 'unfinished|raw|syntax\n  keep this exactly');
    assert.equal(await page.evaluate(() => window.fixture.editorNode === document.getElementById('editWorkFormName')
      && window.fixture.rawNode === document.querySelector('#templateEditForm [data-work-form-raw]')
      && window.fixture.draftNode === document.querySelector('#templateDraftsList article')), true,
    'Search/status/Clear neither remount the editor nor replace the private draft panel');
    await page.locator('#closeTemplateEditButton').click();
    await page.locator('#addWorkFormButton').click();
    await page.locator('#workFormNameInput').fill('Private new Template');
    await page.locator('#workFormDescriptionInput').fill('Unsaved work is not a search result');
    await page.evaluate(async () => {
      await window.fixture.staff.flushTemplateDrafts();
      await window.fixture.staff.renderTemplateDrafts();
      window.fixture.createNode = document.getElementById('workFormNameInput');
      window.fixture.draftMarkup = document.getElementById('templateDraftsList').innerHTML;
    });
    await page.locator('#workFormSearchInput').fill('absent');
    await page.locator('#workFormStatusFilter').selectOption('all');
    assert.equal(await page.locator('#workFormCreatePanel').isVisible(), true);
    assert.equal(await page.locator('#workFormNameInput').inputValue(), 'Private new Template');
    assert.equal(await page.evaluate(() => window.fixture.createNode === document.getElementById('workFormNameInput')
      && window.fixture.draftMarkup === document.getElementById('templateDraftsList').innerHTML), true);
    const saved = await page.evaluate(async () => (await import('/assets/js/report-template-drafts.js')).listTemplateDrafts(window.fixture.state.user));
    assert.equal(saved.length, 2);
    assert.equal(saved.find((draft) => draft.formId === '81').builder.rawText, 'unfinished|raw|syntax\n  keep this exactly');
    assert.equal(drafts.mutations.length, 0, 'Filtering never publishes either private draft');
    console.log('ok - filtering touches published cards only; create/edit drafts, exact unapplied syntax and mounted editor/draft nodes remain intact');
  } finally { await drafts.close(); }

  const scopes = await fixture(browser);
  try {
    const { page } = scopes;
    await page.locator('#workFormSearchInput').fill('first aid');
    await page.locator('#workFormStatusFilter').selectOption('archived');
    await page.evaluate(() => {
      window.fixture.state.departmentFocusId = '3';
      window.fixture.staff.renderWorkFormsList();
    });
    await assertCards(page, [templates[3].name]);
    assert.equal(await page.locator('#workFormSearchInput').inputValue(), '');
    assert.equal(await page.locator('#workFormStatusFilter').inputValue(), 'active');
    assert.match(await page.locator('#workFormsResults').innerText(), /1.*1/);
    await page.locator('#workFormSearchInput').fill('different');
    await page.locator('#workFormStatusFilter').selectOption('all');
    await page.evaluate(() => {
      window.fixture.state.user = { ...window.fixture.state.user, id: 75 };
      window.fixture.staff.renderWorkFormsList();
    });
    assert.equal(await page.locator('#workFormSearchInput').inputValue(), '');
    assert.equal(await page.locator('#workFormStatusFilter').inputValue(), 'active');
    await page.locator('#workFormSearchInput').fill('another filter');
    await page.locator('#workFormStatusFilter').selectOption('archived');
    await page.evaluate(() => window.fixture.staff.resetSession());
    assert.equal(await page.locator('#workFormSearchInput').inputValue(), '');
    assert.equal(await page.locator('#workFormStatusFilter').inputValue(), 'active');
    console.log('ok - Department focus, identity changes and session reset discard stale library filters');
  } finally { await scopes.close(); }

  const created = await fixture(browser);
  try {
    const { page } = created;
    await page.locator('#workFormSearchInput').fill('first aid');
    await page.locator('#workFormStatusFilter').selectOption('archived');
    await page.locator('#addWorkFormButton').click();
    await page.locator('#workFormNameInput').fill('Fresh library Template');
    await page.locator('#workFormAdvancedDetails summary').click();
    await page.locator('#workFormFieldsInput').fill('text|Fresh field|required|id=fresh');
    await page.locator('#applyWorkFormRawButton').click();
    await page.locator('#workFormSubmitButton').click();
    await card(page, 'Fresh library Template').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#workFormSearchInput').inputValue(), '');
    assert.equal(await page.locator('#workFormStatusFilter').inputValue(), 'active');
    assert.equal(created.mutations.length, 1);
    assert.equal(created.mutations[0].body.name, 'Fresh library Template');
    console.log('ok - publishing a new Template restores the Active library so its new card is immediately discoverable');
  } finally { await created.close(); }

  const layout = await fixture(browser);
  try {
    const { page } = layout;
    for (const width of [320, 390]) for (const language of ['en', 'zh']) for (const theme of ['light', 'dark']) {
      const label = `library-${width}-${language}-${theme}`;
      await page.setViewportSize({ width, height: 844 });
      await setPresentation(page, language, theme);
      await page.locator('#workFormsDetails').scrollIntoViewIfNeeded();
      const dimensions = await page.evaluate(() => {
        const visible = (element) => Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden';
        return {
          width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth,
          controls: [...document.querySelectorAll('#workFormSearchInput, #workFormStatusFilter, #clearWorkFormFiltersButton, #workFormsList .record-actions button')].filter(visible).map((element) => {
            const { x, width, height } = element.getBoundingClientRect();
            return { name: element.id || element.textContent, x, width, height };
          }),
          descriptions: [...document.querySelectorAll('#workFormsList .template-library-card .record-header .record-meta')].map((element) => ({
            height: element.getBoundingClientRect().height,
            lineHeight: parseFloat(getComputedStyle(element).lineHeight)
          }))
        };
      });
      assert.ok(dimensions.scrollWidth <= dimensions.width, `${label}: no horizontal overflow (${dimensions.scrollWidth}/${dimensions.width})`);
      for (const control of dimensions.controls) {
        assert.ok(control.width >= 43.99 && control.height >= 43.99, `${label}: ${control.name} preserves a 44px target (${control.width}x${control.height})`);
        assert.ok(control.x >= 0 && control.x + control.width <= dimensions.width + 1, `${label}: ${control.name} fits the viewport`);
      }
      assert.ok(dimensions.descriptions.length > 0, 'Cards expose their compact descriptions');
      for (const item of dimensions.descriptions) assert.ok(item.height <= item.lineHeight * 2 + 1, `${label}: description is at most two visible lines`);
      assert.equal(await card(page, templates[0].name).locator('.record-title').innerText(), templates[0].name, 'User Template names are not translated');
      await page.mouse.move(1, 1);
      await page.screenshot({ path: path.join(output, `${label}.png`), animations: 'disabled', fullPage: true });
    }
    console.log('ok - 8 phone-width/language/theme combinations keep two-line summaries, 44px controls, literal names and no horizontal overflow');
  } finally { await layout.close(); }
} finally { await browser.close(); }
