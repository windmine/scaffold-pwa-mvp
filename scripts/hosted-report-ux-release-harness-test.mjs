// Real Template-library module, controlled first render, and no network/server.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { searchTemplateLibrary } from './check-hosted-report-ux-release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59974'; // Every request intercepted below.
const sourceHtml = (await readFile(path.join(root, 'index.html'), 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const marker = 'owned-template-nonce';
const templates = [
  { id: 81, department_id: 2, name: marker, description: 'Owned fixture', fields: [],
    status: 'active', template_purpose: 'report', definition_version: 1 },
  { id: 82, department_id: 2, name: 'Unrelated template', description: 'Other fixture', fields: [],
    status: 'active', template_purpose: 'report', definition_version: 1 }
];
const stubs = {
  'app-shell-state.js': 'export function defaultStaffDepartmentId(user) { return String(user?.departmentId || ""); }',
  'site-map-picker.js': `export function currentPosition() { throw new Error('Unexpected geolocation'); }
    export function createSiteMapPicker() { return { reset() {}, refresh() {}, bindEvents() {} }; }`
};

async function fixture(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const errors = [], unexpected = [];
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.pathname.startsWith('/api/')) {
      unexpected.push(`${route.request().method()} ${url.origin}${url.pathname}`);
      return route.abort();
    }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: sourceHtml });
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    const name = path.basename(url.pathname);
    if (stubs[name]) return route.fulfill({ contentType: 'text/javascript', body: stubs[name] });
    const file = path.resolve(root, url.pathname.slice(1));
    assert.ok(file.startsWith(`${root}${path.sep}`));
    const types = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
    return route.fulfill({ contentType: types[path.extname(file)] || 'application/octet-stream', body: await readFile(file) });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  await page.evaluate(async (templates) => {
    document.body.dataset.activeView = 'supervisor';
    document.body.classList.add('report-only-mode');
    document.querySelectorAll('.view').forEach((view) => {
      const current = view.id === 'supervisorView';
      view.hidden = !current;
      view.classList.toggle('hidden', !current);
      view.classList.toggle('active', current);
    });
    document.querySelectorAll('[data-admin-workspace-panel]').forEach((panel) => { panel.hidden = panel.id !== 'adminFormsWorkspace'; });
    const els = new Proxy({}, { get: (_, id) => document.getElementById(id) });
    const state = { user: null,
      departmentFocusId: '', adminWorkspace: 'forms', departments: [{ id: 2, name: 'Mutual' }],
      workForms: templates, staffUsers: [], sites: [] };
    const staff = (await import('/assets/js/staff-sites.js')).createStaffSitesModule({
      els, state, reportOnly: true, loadSites: async () => [], fillSiteSelects() {}, refreshWorkForms: async () => true,
      renderStatusBanner() {}, showEditPanel() { throw new Error('Unexpected editor'); }, closeEditPanel() {},
      editValue() { throw new Error('Unexpected edit'); }, editNumber() { throw new Error('Unexpected edit'); }, confirmAction: async () => true
    });
    staff.bindEvents();
    // app.js constructs modules before restoring the authenticated identity.
    state.user = { id: 74, role: 'supervisor', departmentId: 2, isGlobalAdmin: true };
    state.departmentFocusId = '2';
    // Simulate the visible workspace before its first asynchronous catalog render.
    window.fixture = { staff, state, searchInputs: 0 };
    els.workFormSearchInput.addEventListener('input', () => { window.fixture.searchInputs += 1; });
  }, templates);
  return { page, async close() {
    await context.close();
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
  } };
}

const browser = await chromium.launch({ headless: true });
try {
  const early = await fixture(browser);
  try {
    const input = early.page.locator('#workFormSearchInput');
    assert.equal(await input.isVisible(), true);
    assert.equal(await input.isEnabled(), true);
    assert.equal(await early.page.locator('#workFormsList article').count(), 0);
    await input.fill(marker);
    assert.equal(await input.inputValue(), '', 'The first scope-initializing render clears an early query');
    assert.equal(await early.page.locator('#workFormsList article').count(), 2);
    console.log('ok - real enabled search reproduces early first-render query loss and the original exact-count symptom');
  } finally { await early.close(); }

  const ready = await fixture(browser);
  try {
    // Release the held catalog at the exact barrier, with no time-based sleeps.
    // These delegates still execute the real browser locators and module render.
    const calls = [];
    const controlledPage = { locator(selector) {
      const locator = ready.page.locator(selector);
      return new Proxy(locator, { get(target, key) {
        if (key === 'fill') return async (value) => {
          calls.push('fill');
          assert.equal(await ready.page.locator('#workFormsList article').count(), 2,
            'Hosted verifier must wait for initial catalog before filling search');
          return target.fill(value);
        };
        if (key === 'waitFor') return async (...args) => {
          calls.push('waitFor');
          await ready.page.evaluate(() => window.fixture.staff.renderWorkFormsList({ refreshDrafts: false }));
          return target.waitFor(...args);
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    } };
    const card = await searchTemplateLibrary(controlledPage, 81, marker);
    assert.deepEqual(calls.slice(0, 2), ['waitFor', 'fill']);
    assert.equal(await card.count(), 1);
    assert.equal(await ready.page.locator('#workFormsList article').count(), 1);
    assert.equal(await ready.page.locator('#workFormSearchInput').inputValue(), marker);
    console.log('ok - hosted helper waits at the catalog barrier before exact search without retyping/retries');
  } finally { await ready.close(); }
} finally { await browser.close(); }
console.log('PASS - hosted UX harness readiness regression checks');
