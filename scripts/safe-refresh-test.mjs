import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { waitForAsyncCondition } from './browser-async-wait.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'output/safe-refresh-local');
const origin = 'http://127.0.0.1:59961'; // All requests intercepted; no production access.
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

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
let count = 0;
try {
  {
    const f = await fixture(browser); await openForm(f);
    await f.page.locator('#workFormSite').selectOption('__manual__');
    await f.page.locator('#workFormManualSite').fill('Unfinished manual site');
    const signature = f.page.locator('#workFormFields canvas').first();
    await signature.scrollIntoViewIfNeeded(); const signatureBox = await signature.boundingBox();
    await f.page.mouse.move(signatureBox.x + 20, signatureBox.y + 20); await f.page.mouse.down();
    await f.page.mouse.move(signatureBox.x + 70, signatureBox.y + 45, { steps: 5 }); await f.page.mouse.up();
    const signatureBefore = await signature.evaluate((canvas) => canvas.toDataURL());
    await f.page.locator('#workFormPhotos').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: photo });
    await waitForAsyncCondition(f.page, async () => (await import('/assets/js/app-shell-state.js')).state.workFormPhotoBlobs.length === 1);
    await f.page.evaluate(async () => {
      const node = document.querySelector('#workFormField_notes'); window.keptField = node;
      const api = await import('/assets/js/offline-submissions.js');
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
      await api.submitOfflineSubmission({ id: 'refresh-queued', type: 'form', submissionPurpose: 'report', formId: 81,
        formName: 'Synthetic queued Report', definitionVersion: 1, fields: [], workDate: '2026-10-26', answers: {} });
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
      window.offerUpdate = true;
    });
    f.traffic.forms.push({ ...template, id: 82, name: 'New synthetic Template' });
    f.traffic.sites.push({ ...site, id: 10, name: 'New synthetic Site' });
    const before = await state(f); await refresh(f, true); const after = await state(f);
    assert.equal(after.boot, before.boot); assert.equal(after.forms.length, 2); assert.equal(after.sites.length, 2);
    assert.deepEqual(after.queue, before.queue); assert.deepEqual(after.blobs, before.blobs); assert.deepEqual(after.metadata, before.metadata);
    assert.equal(await f.page.evaluate(() => window.keptField === document.querySelector('#workFormField_notes')), true);
    assert.equal(await f.page.locator('#workFormField_notes').inputValue(), 'Keep this unfinished answer');
    assert.equal(await f.page.locator('#workFormManualSite').inputValue(), 'Unfinished manual site');
    assert.equal(await f.page.locator('#workFormSite').inputValue(), '__manual__');
    assert.equal(after.checks, 1); assert.deepEqual(after.messages, []); assert.equal(await f.page.locator('#updateButton').isVisible(), true);
    assert.equal(await signature.evaluate((canvas) => canvas.toDataURL()), signatureBefore);
    await waitForAsyncCondition(f.page, async () => {
      const drafts = await (await import('/assets/js/db.js')).getAll('drafts');
      return drafts.some((entry) => entry.value?.answers?.notes === 'Keep this unfinished answer'
        && entry.value.manualSiteName === 'Unfinished manual site' && entry.value.answers.sign?.startsWith('data:image/'));
    });
    assert.match(await f.page.locator('#dataRefreshStatus').innerText(), /Data refreshed/);
    await f.page.screenshot({ path: path.join(output, 'worker-refresh.png'), fullPage: true });
    await f.close(); console.log(`ok ${++count} - keyboard refresh preserves live form, original photo, manual Site and queue; only checks app version`);
  }
  {
    const f = await fixture(browser); await openForm(f);
    await f.page.locator('#workFormSite').selectOption('9');
    f.traffic.sites = []; f.traffic.forms = [{ ...template, definition_version: 2, fields: [{ id: 'different', type: 'text', label: 'Replacement' }] }];
    await refresh(f);
    assert.equal(await f.page.locator('#workFormSite').inputValue(), '9');
    assert.equal(await f.page.locator('#workFormField_notes').inputValue(), 'Keep this unfinished answer');
    assert.equal(await f.page.locator('#workFormField_different').count(), 0);
    await f.page.locator('#submitWorkFormButton').click();
    assert.match(await f.page.locator('#workFormFeedback').innerText(), /Template changed/);
    await f.close(); console.log(`ok ${++count} - removed selected Site and changed Template do not replace unfinished content or bypass version protection`);
  }
  {
    const f = await fixture(browser); await openForm(f); const before = await state(f);
    assert.equal(before.records.length, 1, 'Failure must retain nonempty durable history');
    f.traffic.fail.add('/api/sites'); f.traffic.fail.add('/api/my-form-submissions');
    f.traffic.forms.push({ ...template, id: 82 }); await refresh(f); const after = await state(f);
    assert.deepEqual(after.sites, before.sites); assert.deepEqual(after.records, before.records); assert.equal(after.forms.length, 2);
    assert.match(await f.page.locator('#dataRefreshStatus').innerText(), /could not be refreshed/);
    const requests = f.traffic.paths.length;
    await f.page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }));
    await refresh(f); assert.equal(f.traffic.paths.length, requests);
    assert.match(await f.page.locator('#dataRefreshStatus').innerText(), /offline/);
    await f.close(); console.log(`ok ${++count} - partial read failures retain prior lists; offline refresh makes no requests`);
  }
  {
    const f = await fixture(browser); await openForm(f); const before = await state(f);
    f.traffic.fail.add('/api/work-forms'); await f.page.evaluate(() => { window.failUpdate = true; });
    f.traffic.sites.push({ ...site, id: 10 }); await refresh(f);
    assert.deepEqual((await state(f)).forms, before.forms); assert.equal((await state(f)).sites.length, 2);
    assert.match(await f.page.locator('#dataRefreshStatus').innerText(), /could not be refreshed/);
    f.traffic.fail.clear(); await f.page.evaluate(() => { window.failUpdate = false; }); await refresh(f);
    assert.match(await f.page.locator('#dataRefreshStatus').innerText(), /Data refreshed/);
    await f.close(); console.log(`ok ${++count} - Template and update-check failures preserve editor; explicit retry recovers`);
  }
  {
    const f = await fixture(browser); await openForm(f);
    f.traffic.hold.add('/api/sites'); f.traffic.hold.add('/api/work-forms');
    await f.page.locator('#refreshDataButton').click();
    await f.page.waitForFunction(() => document.querySelector('#refreshDataButton').disabled);
    await f.page.locator('#refreshDataButton').evaluate((button) => { button.dispatchEvent(new Event('click')); button.dispatchEvent(new Event('click')); });
    await f.page.locator('#workFormField_notes').fill('Typed during refresh');
    await f.page.locator('#workFormSite').selectOption('__manual__'); await f.page.locator('#workFormManualSite').fill('Typed while waiting');
    assert.equal(f.traffic.held.length, 2, 'Repeated clicks must not duplicate requests');
    f.release(); await f.page.waitForFunction(() => !document.querySelector('#refreshDataButton').disabled);
    assert.equal(await f.page.locator('#workFormManualSite').inputValue(), 'Typed while waiting');
    assert.equal(await f.page.locator('#workFormField_notes').inputValue(), 'Typed during refresh');
    f.traffic.hold.add('/api/sites'); f.traffic.sites = [{ ...site, id: 99 }];
    await f.page.locator('#refreshDataButton').click();
    await f.page.locator('[role="tab"][data-tab-target="historyTab"]').click();
    f.release(); await f.page.waitForTimeout(100);
    assert.equal((await state(f)).sites.some((site) => site.id === 99), false);
    assert.equal(await f.page.locator('#dataRefreshStatus').isVisible(), false);
    await f.close(); console.log(`ok ${++count} - edits during requests survive; double clicks coalesce; navigation cancels late results`);
  }
  {
    const f = await fixture(browser);
    f.traffic.hold.add('/api/sites'); f.traffic.hold.add('/api/work-forms');
    await f.page.locator('#refreshDataButton').click(); await f.page.locator('#logoutButton').click();
    await f.page.locator('#loginView').waitFor({ state: 'visible' }); f.release(); await f.page.waitForTimeout(100);
    const after = await state(f); assert.deepEqual(after.sites, []); assert.deepEqual(after.forms, []);
    assert.equal(await f.page.locator('#dataRefreshStatus').isVisible(), false);
    await f.close(); console.log(`ok ${++count} - logout prevents late responses from restoring another session's data`);
  }
  {
    const f = await fixture(browser, 'supervisor');
    await f.page.locator('#reviewQueueDetail button').filter({ hasText: /^Edit$/ }).first().click();
    await f.page.locator('#editReportDate').fill('2026-10-25');
    await f.page.evaluate(() => { window.keptCorrection = document.querySelector('#editReportDate'); });
    await refresh(f);
    assert.equal(await f.page.locator('#editReportDate').inputValue(), '2026-10-25');
    assert.equal(await f.page.evaluate(() => window.keptCorrection === document.querySelector('#editReportDate')), true);
    await f.page.screenshot({ path: path.join(output, 'supervisor-refresh.png'), fullPage: true });
    await f.close(); console.log(`ok ${++count} - supervisor refresh retains unsaved correction and its original concurrency revision`);
  }
  {
    const f = await fixture(browser, 'supervisor'); await openForm(f, true);
    await f.page.setViewportSize({ width: 320, height: 844 }); await refresh(f);
    assert.equal(await f.page.locator('#workFormField_notes').inputValue(), 'Keep this unfinished answer');
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    // Measure the settled touch target, after the existing 140ms hover transform.
    await f.page.locator('#refreshDataButton').evaluate(async (button) => {
      await Promise.all(button.getAnimations().map((animation) => animation.finished));
    });
    const box = await f.page.locator('#refreshDataButton').boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44, `Refresh touch target: ${JSON.stringify(box)}`);
    await f.page.locator('#languageToggleButton').click(); await refresh(f);
    assert.match(await f.page.locator('#dataRefreshStatus').innerText(), /数据已刷新/);
    await f.page.screenshot({ path: path.join(output, 'supervisor-mobile-refresh.png'), fullPage: true });
    await f.close(); console.log(`ok ${++count} - mobile supervisor editor, 44px keyboard target, no overflow and translated feedback`);
  }
  {
    const f = await fixture(browser, 'supervisor');
    await f.page.locator('[data-admin-workspace-target="forms"]').first().click();
    const settings = f.page.locator('[data-template-id="81"] .pdf-email-settings');
    await settings.locator('summary').click();
    await settings.locator('[data-pdf-email-recipient]').fill('unsaved@example.invalid');
    await settings.locator('summary').click(); // Even collapsed unsaved controls survive.
    f.traffic.forms.push({ ...template, id: 82 }); await refresh(f);
    assert.equal(await settings.locator('[data-pdf-email-recipient]').inputValue(), 'unsaved@example.invalid');
    assert.equal(await f.page.locator('[data-template-id="82"]').count(), 1);
    await f.close(); console.log(`ok ${++count} - Template refresh retains unsaved email settings without sending or saving them`);
  }
  {
    const f = await fixture(browser);
    await f.page.evaluate(async () => {
      const { createSafeRefresh } = await import('/assets/js/safe-refresh.js');
      const button = document.createElement('button'); button.id = 'timeoutTest'; document.body.append(button);
      const status = document.createElement('p'); status.id = 'timeoutStatus'; document.body.append(status);
      window.lateApplied = false;
      createSafeRefresh({ button, status, captureScope: () => ({}), scopeIsCurrent: () => true, timeoutMs: 30,
        tasks: (_, current) => [{ run: async () => { await new Promise((resolve) => { window.releaseLate = resolve; }); if (current()) window.lateApplied = true; return true; } }] });
      button.click();
    });
    await f.page.waitForFunction(() => !document.querySelector('#timeoutTest').disabled);
    assert.match(await f.page.locator('#timeoutStatus').innerText(), /could not be refreshed/);
    await f.page.evaluate(() => window.releaseLate()); assert.equal(await f.page.evaluate(() => window.lateApplied), false);
    await f.close(); console.log(`ok ${++count} - stalled refresh times out and ignores late completion without reloading`);
  }
  console.log(`PASS ${count} safe Refresh browser groups`);
} finally { await browser.close(); }
