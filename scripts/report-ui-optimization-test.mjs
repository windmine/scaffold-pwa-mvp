import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { waitForAsyncCondition } from './browser-async-wait.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'output/ui-optimization-local');
const origin = 'http://127.0.0.1:59962'; // All requests intercepted; no production access.
const template = { id: 81, department_id: 2, name: 'Synthetic Refresh Report', status: 'active',
  template_purpose: 'report', definition_version: 1, pdf_email: { enabled: false, recipient: null, version: 1 },
  fields: [{ id: 'notes', label: 'Notes', type: 'textarea' }, { id: 'sign', label: 'Signature', type: 'signature' }] };
const site = { id: 9, department_id: 2, name: 'Synthetic Site', address: 'Test only' };
const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');

async function fixture(browser, role = 'worker') {
  const user = { id: 73, department_id: 2, department_name: 'Mutual', role, worker_class: 'normal',
    name: 'Synthetic Refresh User', email: 'refresh@example.invalid', status: 'active' };
  const context = await browser.newContext({ viewport: { width: role === 'worker' ? 390 : 1280, height: 844 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    window.refreshBoot = crypto.randomUUID();
    window.updateChecks = 0; window.updateMessages = []; window.offerUpdate = false;
    const listeners = new Map();
    const registration = { waiting: null, installing: null,
      addEventListener: (name, fn) => listeners.set(name, fn),
      update: async () => {
        window.updateChecks += 1;
        if (window.failUpdate) throw new Error('Synthetic update failure');
        if (window.offerUpdate) registration.waiting = { postMessage: (data) => window.updateMessages.push(data) };
      }
    };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
      controller: {}, addEventListener() {}, register: async () => registration,
      getRegistration: async () => registration
    } });
  });
  const traffic = { paths: [], writes: [], forms: [structuredClone(template)], sites: [site],
    fail: new Set(), hold: new Set(), held: [], own: [{ id: 902, worker_id: user.id, form_id: 81,
      department_id: 2, form_name: template.name, submission_purpose: 'report', fields: template.fields,
      answers: { notes: 'Existing synthetic Report' }, work_date: '2026-10-26', revision: 1, photo_urls: [],
      created_at: '2026-10-26T00:00:00Z' }] };
  const errors = [];
  const release = () => { traffic.hold.clear(); traffic.held.splice(0).forEach((resolve) => resolve()); };
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    assert.equal(url.origin, origin, 'Only the isolated fixture origin is allowed');
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Refresh fixture</title>' });
    if (url.pathname.startsWith('/api/')) {
      traffic.paths.push(url.pathname);
      if (traffic.hold.has(url.pathname)) await new Promise((resolve) => traffic.held.push(resolve));
      if (traffic.fail.has(url.pathname)) return json({ detail: 'Synthetic read failure' }, 503);
      if (['/api/auth/refresh', '/api/auth/me'].includes(url.pathname)) return json(user);
      if (url.pathname === '/api/auth/logout') return json({ message: 'Signed out' });
      if (request.method() !== 'GET') { traffic.writes.push(url.pathname); return json({ detail: 'No writes permitted' }, 500); }
      if (url.pathname === '/api/departments') return json([{ id: 2, name: 'Mutual' }]);
      if (url.pathname === '/api/sites') return json(traffic.sites);
      if (url.pathname === '/api/work-forms') {
        assert.equal(url.searchParams.get('purpose'), 'report'); return json(traffic.forms);
      }
      if (url.pathname === '/api/my-form-submissions') return json(traffic.own);
      if (url.pathname === '/api/supervisor/users') return json([]);
      if (url.pathname === '/api/supervisor/review-queue') return json({
        items: [{ kind: 'form', id: 901, department_id: 2, worker_id: 8, worker_name: 'Synthetic Author',
          form_id: 81, form_name: template.name, fields: template.fields, answers: { notes: 'Submitted synthetic answer' },
          work_date: '2026-10-26', revision: 1, submission_purpose: 'report', status: 'submitted',
          photo_urls: [], created_at: '2026-10-26T00:00:00Z' }],
        counts: { total: 1 }, summary_counts: { total: 1 }, has_more: false, next_cursor: null,
        sort_order: 'newest', snapshot_at: '2026-10-26T00:00:00Z'
      });
      errors.push(`Unexpected request ${url.pathname}`); return json([], 500);
    }
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    const file = path.resolve(root, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    assert.ok(file.startsWith(root + path.sep));
    let body = await readFile(file);
    if (file.endsWith('.js')) body = body.toString().replaceAll("import L from 'leaflet';", "import * as L from '/node_modules/leaflet/dist/leaflet-src.esm.js';")
      .replace(/^import 'leaflet\/dist\/leaflet\.css';?\r?\n/gm, '');
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
    return route.fulfill({ contentType: types[path.extname(file)] || 'application/octet-stream', body });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(8000);
  await page.goto(origin + '/fixture');
  await page.evaluate(async (user) => { const api = await import('/assets/js/api-client.js'); api.saveSession(user); }, user);
  await page.goto(origin);
  await page.locator('#refreshDataButton').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#workFormSelect option[value="81"]'));
  await page.waitForFunction(() => document.querySelector('#syncIndicator').dataset.state !== 'syncing');
  return { context, page, traffic, errors, release, async close() {
    release(); assert.deepEqual(traffic.writes, [], 'Refresh must never send queued Reports or mutate the backend');
    assert.deepEqual(errors, []); await context.close();
  } };
}

async function openForm(f, supervisor = false) {
  if (supervisor) await f.page.locator('[data-admin-workspace-target="submit"]').first().click();
  await f.page.locator('#workFormSelect').selectOption('81');
  await f.page.waitForFunction(() => !document.querySelector('#workFormSubmissionForm').inert && document.querySelector('#workFormField_notes'));
  await f.page.locator('#workFormField_notes').fill('Keep this unfinished answer');
}
async function refresh(f, keyboard = false) {
  const button = f.page.locator('#refreshDataButton');
  if (keyboard) { await button.focus(); await button.press('Enter'); } else await button.click();
  await f.page.waitForFunction(() => !document.querySelector('#refreshDataButton').disabled);
}
async function state(f) {
  return f.page.evaluate(async () => {
    const { state } = await import('/assets/js/app-shell-state.js');
    const db = await import('/assets/js/db.js');
    return { sites: state.sites, forms: state.workForms, records: state.historyRecords,
      blobs: await Promise.all(state.workFormPhotoBlobs.map(async (blob) => [...new Uint8Array(await blob.arrayBuffer())])),
      metadata: state.workFormPhotoMetadata, queue: await db.getAll('queue'), drafts: await db.getAll('drafts'),
      boot: window.refreshBoot, checks: window.updateChecks, messages: window.updateMessages };
  });
}

const catalog = JSON.parse(await readFile(path.join(root, 'docs/templates/mutual-source-templates.json'), 'utf8'));
const audit = { ...template, ...catalog.templates[0].payload, id: 82 };
const longForm = { ...template, id: 83, name: 'Synthetic long form', fields: [
  { id: 'first', label: 'First section', type: 'section' },
  { id: 'required', label: 'Required answer', type: 'text', required: true },
  ...template.fields,
  { id: 'second', label: 'Second section', type: 'section' },
  { id: 'extra', label: 'Extra answer', type: 'text' },
  { id: 'third', label: 'Third section', type: 'section' },
  { id: 'last', label: 'Last answer', type: 'text' }
] };
async function catalogs(f) {
  f.traffic.forms.push(structuredClone(audit), structuredClone(longForm));
  await refresh(f);
}
async function choose(f, id) {
  await f.page.locator('#workFormSelect').selectOption(String(id));
  await f.page.waitForFunction((value) => document.querySelector('#workFormSelectedTitle').textContent === value,
    f.traffic.forms.find((form) => form.id === id).name);
}
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
let count = 0;
try {
  {
    const f = await fixture(browser); await openForm(f);
    for (const width of [320, 390, 1440]) {
      await f.page.setViewportSize({ width, height: 844 });
      for (const value of ['', '9', '__manual__', '9', '__manual__', '']) {
        await f.page.locator('#workFormSite').selectOption(value);
        assert.equal(await f.page.locator('#workFormManualSite').isVisible(), value === '__manual__');
        assert.equal(await f.page.locator('#workFormManualSite').getAttribute('required') !== null, value === '__manual__');
        if (value === '__manual__') await f.page.locator('#workFormManualSite').fill('Synthetic typed site');
      }
    }
    await f.page.locator('#workFormSite').selectOption('__manual__');
    await waitForAsyncCondition(f.page, async () => (await (await import('/assets/js/db.js')).getAll('drafts'))
      .some((entry) => entry.value?.manualSiteName === 'Synthetic typed site'));
    await f.page.reload(); await f.page.locator('#refreshDataButton').waitFor({ state: 'visible' });
    await openForm(f);
    assert.equal(await f.page.locator('#workFormSite').inputValue(), '__manual__');
    assert.equal(await f.page.locator('#workFormManualSite').inputValue(), 'Synthetic typed site');
    await f.page.locator('#workFormSite').selectOption('9');
    assert.equal(await f.page.locator('#workFormManualSite').isVisible(), false);
    await f.page.locator('#submitWorkFormButton').click();
    await f.page.locator('#workFormReviewPanel').waitFor({ state: 'visible' });
    assert.match(await f.page.locator('#workFormReviewSummary').innerText(), /Synthetic Site/);
    assert.doesNotMatch(await f.page.locator('#workFormReviewSummary').innerText(), /Synthetic typed site/);
    await f.close(); console.log(`ok ${++count} - Site modes hide stale input, restore drafts and review only the selected Site`);
  }
  {
    const f = await fixture(browser); await catalogs(f); await choose(f, 83);
    await f.page.locator('#workFormField_notes').fill('Retain this answer');
    await f.page.evaluate(() => { window.kept = document.querySelector('#workFormField_notes'); });
    await f.page.locator('#workFormTemplateSearch').fill('  health SAFETY ');
    assert.equal(await f.page.locator('#workFormSelect option').count(), 3); // blank, matching audit, current selection
    assert.equal(await f.page.locator('#workFormSelect').inputValue(), '83');
    await f.page.locator('#workFormTemplateSearch').fill('No such template');
    assert.match(await f.page.locator('#workFormTemplateSearchStatus').innerText(), /No matching/);
    await f.page.locator('#workFormTemplateSearch').press('Enter');
    assert.equal(await f.page.locator('#workFormReviewPanel').isVisible(), false);
    assert.equal(await f.page.evaluate(() => window.kept === document.querySelector('#workFormField_notes')), true);
    await f.page.locator('[role="tab"][data-tab-target="historyTab"]').click();
    await f.page.getByRole('button', { name: 'Continue draft', exact: true }).click();
    await f.page.locator('#formTab').waitFor({ state: 'visible' });
    assert.equal(await f.page.locator('#workFormTemplateSearch').inputValue(), '');
    assert.equal(await f.page.locator('#workFormField_notes').inputValue(), 'Retain this answer');
    await f.page.locator('#workFormTemplateSearch').fill('missing');
    f.traffic.forms = f.traffic.forms.filter((form) => form.id !== 83);
    await refresh(f); await f.page.locator('#workFormTemplateSearch').fill('audit');
    assert.equal(await f.page.locator('#workFormSelect').inputValue(), '83');
    assert.equal(await f.page.locator('#workFormField_notes').inputValue(), 'Retain this answer');
    await f.page.locator('#reportFormReviewShortcut').click();
    assert.equal(await f.page.locator('#workFormReviewPanel').isVisible(), false);
    await f.close(); console.log(`ok ${++count} - template search preserves editor, handles no matches, draft continuation and unavailable selected templates`);
  }
  {
    const f = await fixture(browser); await catalogs(f); await choose(f, 83);
    await f.page.locator('#reportFormSection').selectOption({ label: 'Third section' });
    await f.page.locator('#reportFormSectionGo').press('Enter');
    assert.equal(await f.page.evaluate(() => document.activeElement.textContent), 'Third section');
    await f.page.locator('#reportFormReviewShortcut').click();
    assert.equal(await f.page.locator('#workFormReviewPanel').isVisible(), false);
    assert.equal(await f.page.evaluate(() => document.activeElement.id), 'workFormField_required');
    await f.page.locator('#workFormField_required').fill('Synthetic answer');
    await f.page.locator('#workFormField_notes').fill('Keep answers and evidence');
    await f.page.locator('#workFormSite').selectOption('__manual__');
    await f.page.locator('#workFormManualSite').fill('Synthetic manual site');
    const signature = f.page.locator('#workFormFields canvas');
    await signature.scrollIntoViewIfNeeded(); const box = await signature.boundingBox();
    await f.page.mouse.move(box.x + 15, box.y + 15); await f.page.mouse.down();
    await f.page.mouse.move(box.x + 70, box.y + 40, { steps: 5 }); await f.page.mouse.up();
    const signatureBefore = await signature.evaluate(canvas => canvas.toDataURL());
    await f.page.locator('#workFormPhotos').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: photo });
    await waitForAsyncCondition(f.page, async () => (await import('/assets/js/app-shell-state.js')).state.workFormPhotoBlobs.length === 1);
    await f.page.evaluate(() => { window.kept = document.querySelector('#workFormField_notes'); });
    for (const label of ['First section', 'Second section', 'Third section']) {
      await f.page.locator('#reportFormSection').selectOption({ label });
      await f.page.locator('#reportFormSectionGo').click();
      assert.equal(await f.page.evaluate(() => document.activeElement.textContent), label);
    }
    const before = await state(f);
    await f.page.locator('#reportFormReviewShortcut').click();
    await f.page.locator('#workFormReviewPanel').waitFor({ state: 'visible' });
    assert.equal(await f.page.locator('#reportFormNavigation').isVisible(), false);
    assert.deepEqual((await state(f)).queue, before.queue, 'Review must not submit');
    await f.page.locator('#workFormReviewBackButton').click();
    assert.equal(await f.page.locator('#reportFormSectionGo').isEnabled(), true);
    await f.page.locator('#reportFormSection').selectOption({ label: 'First section' });
    await f.page.locator('#reportFormSectionGo').press('Enter');
    assert.equal(await f.page.evaluate(() => window.kept === document.querySelector('#workFormField_notes')), true);
    assert.equal(await signature.evaluate(canvas => canvas.toDataURL()), signatureBefore);
    assert.deepEqual((await state(f)).blobs, before.blobs);
    await f.close(); console.log(`ok ${++count} - keyboard section jumps and review shortcut preserve fields/photos/signature and validation; review does not submit`);
  }
  {
    const f = await fixture(browser); await catalogs(f); await choose(f, 82);
    for (const width of [320, 390, 760, 761, 768, 1440, 390]) {
      await f.page.setViewportSize({ width, height: 844 });
      assert.equal(await f.page.locator('#reportFormSection option').count(), 14);
      await f.page.locator('#reportFormSection').selectOption({ index: 12 });
      await f.page.locator('#reportFormSectionGo').click();
      const geometry = await f.page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        nav: document.querySelector('#reportFormNavigation').getBoundingClientRect().toJSON(),
        focused: document.activeElement.getBoundingClientRect().toJSON()
      }));
      assert.equal(geometry.overflow, false);
      assert.ok(geometry.nav.top >= 0 && geometry.nav.bottom < 200, JSON.stringify(geometry));
      assert.ok(geometry.focused.top >= geometry.nav.bottom, 'Jump target must not hide behind sticky navigation');
      for (const id of ['reportFormSectionGo', 'reportFormReviewShortcut']) {
        await f.page.locator(`#${id}`).evaluate(async el => { await Promise.allSettled(el.getAnimations().map(a => a.finished)); });
        const box = await f.page.locator(`#${id}`).boundingBox();
        assert.ok(box.height >= 44 && box.width >= 44, `${id} ${JSON.stringify(box)}`);
        assert.equal(await f.page.locator(`#${id}`).evaluate(el => {
          const rect = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        }), true, `${width}px: ${id} must not be covered by Report tabs`);
      }
      await f.page.screenshot({ path: path.join(output, `audit-navigation-${width}.png`) });
    }
    await f.page.locator('#workFormTemplateSearch').fill('audit');
    await f.page.locator('#workFormSelectedTitle').scrollIntoViewIfNeeded();
    assert.equal(await f.page.locator('#workFormSelectedTitle').innerText(), audit.name);
    await f.page.screenshot({ path: path.join(output, 'audit-selected-title.png') });
    await f.close(); console.log(`ok ${++count} - actual 117-entry audit: 14 section targets, unobstructed sticky navigation across phone/tablet/desktop transitions, readable title and no overflow`);
  }
  {
    const f = await fixture(browser, 'supervisor');
    await f.page.locator('#reportReviewFilters').evaluate(el => { el.open = true; });
    await f.page.locator('#supervisorDateFilter').fill('2026-10-26');
    await f.page.locator('#reviewQueueList [role="option"]').first().waitFor({ state: 'visible' });
    for (const width of [1100, 1280, 1440]) {
      await f.page.setViewportSize({ width, height: 900 });
      const geometry = await f.page.evaluate(() => ({
        fields: ['supervisorSearchInput','supervisorTemplateFilter','supervisorWorkerFilter','supervisorDateFilter','clearSupervisorFiltersButton']
          .map(id => document.getElementById(id).getBoundingClientRect().toJSON()),
        row: document.querySelector('#reviewQueueList [role="option"]').getBoundingClientRect().toJSON(),
        dateClipped: document.querySelector('#supervisorDateFilter').scrollWidth > document.querySelector('#supervisorDateFilter').clientWidth,
        overflow: document.documentElement.scrollWidth > innerWidth + 1
      }));
      assert.equal(geometry.overflow, false);
      assert.equal(geometry.dateClipped, false, 'The selected Report Date must remain fully visible');
      assert.ok(Math.max(...geometry.fields.map(r=>r.bottom))-Math.min(...geometry.fields.map(r=>r.bottom)) < 2, JSON.stringify(geometry));
      assert.ok(geometry.row.height < 175, JSON.stringify(geometry));
      await f.page.screenshot({ path: path.join(output, `supervisor-${width}.png`) });
    }
    assert.match(await f.page.locator('#reviewQueueDetail').innerText(), /Submitted synthetic answer/);
    await f.page.locator('#reviewQueueList [role="option"]').first().press('Enter');
    await f.page.locator('#supervisorSearchInput').fill('Synthetic');
    await f.page.locator('#clearSupervisorFiltersButton').click();
    assert.equal(await f.page.locator('#supervisorSearchInput').inputValue(), '');
    await openForm(f, true);
    await f.page.locator('#workFormTemplateSearch').fill('missing');
    assert.equal(await f.page.locator('#workFormField_notes').inputValue(), 'Keep this unfinished answer');
    await f.page.locator('#workFormSite').selectOption('9');
    assert.equal(await f.page.locator('#workFormManualSite').isVisible(), false);
    await f.page.locator('#workFormTemplateSearch').fill('');
    await catalogs(f); await choose(f, 82);
    for (const width of [1440, 768, 390]) {
      await f.page.setViewportSize({ width, height: 900 });
      await f.page.locator('#reportFormSection').selectOption({ index: 12 });
      await f.page.locator('#reportFormSectionGo').click();
      assert.equal(await f.page.locator('#reportFormSectionGo').evaluate(el => {
        const rect = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      }), true, `Supervisor ${width}px section control must remain unobstructed`);
    }
    await f.close(); console.log(`ok ${++count} - compact desktop filters/cards, full detail, clearing and Supervisor self-submit remain available`);
  }
  {
    const f = await fixture(browser); await openForm(f);
    await f.page.setViewportSize({ width: 320, height: 844 });
    assert.equal(await f.page.locator('#refreshDataButton').innerText(), 'Refresh data');
    assert.equal(await f.page.locator('#refreshHistoryButton').textContent(), 'Refresh reports');
    await f.page.evaluate(() => { window.offerUpdate = true; }); await refresh(f);
    assert.equal(await f.page.locator('#dataRefreshStatus').innerText(), 'Data refreshed. Updates checked.');
    assert.equal(await f.page.locator('#updateButton').isVisible(), true);
    f.traffic.fail.add('/api/sites'); await refresh(f);
    assert.match(await f.page.locator('#dataRefreshStatus').innerText(), /could not be refreshed/);
    assert.equal(await f.page.locator('#dataRefreshStatus').getAttribute('data-tone'), 'warning');
    await f.page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }));
    const paths = f.traffic.paths.length;
    await f.page.locator('#workFormTemplateSearch').fill('missing'); await refresh(f);
    assert.equal(f.traffic.paths.length, paths);
    assert.match(await f.page.locator('#dataRefreshStatus').innerText(), /offline/);
    await f.page.locator('#languageToggleButton').click();
    assert.equal(await f.page.locator('#refreshDataButton').innerText(), '刷新数据');
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await f.page.screenshot({ path: path.join(output, 'worker-320-chinese.png') });
    await f.page.locator('#logoutButton').click();
    await f.page.locator('#loginView').waitFor({ state: 'visible' });
    assert.equal(await f.page.locator('#workFormTemplateSearch').inputValue(), '');
    assert.equal(await f.page.locator('#workFormSelectedTitle').textContent(), '');
    await f.close(); console.log(`ok ${++count} - Refresh scopes, concise success, prominent errors, offline filtering and session reset`);
  }
  console.log(`Passed ${count} Report UI optimization groups; no backend writes or real email.`);
} finally { await browser.close(); }

