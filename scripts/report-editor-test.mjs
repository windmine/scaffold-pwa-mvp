import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59968';
const output = path.join(root, 'output/report-editor.local');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SAAAAABJRU5ErkJggg==', 'base64');
const record = {
  backendRecordId: 41, revision: 3, formId: 8, formName: 'Site inspection',
  workDate: '2026-10-22', siteId: 5, siteName: 'Site five',
  fields: [
    { id: 'notes', label: 'Notes', type: 'textarea', required: true },
    { id: 'signed', label: 'Signature', type: 'signature', required: true },
    { id: 'crew', label: 'Crew', type: 'repeat', min_rows: 0, max_rows: 5 },
    { id: 'name', label: 'Name', type: 'text', repeat: 'crew', required: true },
    { id: 'sign', label: 'Crew signature', type: 'signature', repeat: 'crew', required: true }
  ],
  answers: { notes: 'Original answer', signed: '/uploads/original.png', crew: [
    { name: 'First person', sign: '/uploads/first.png' },
    { name: 'Second person', sign: '/uploads/second.png' }
  ] },
  photoUrls: ['/uploads/photo.png'], photoMetadata: [{ name: 'original-photo.png', size: 80, type: 'image/png' }]
};

async function fixture(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const patches = [], uploads = [], errors = [], unexpected = [];
  let patchStatus = 200, holdUpload = false, releaseUpload;
  page.on('pageerror', (error) => errors.push(error.message));
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== origin) { unexpected.push(url.href); return route.abort(); }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><link rel="stylesheet" href="/assets/css/styles.css"></head><body><article id="panel" class="card"><h2 id="title"></h2><form id="editor"></form></article></body></html>` });
    if (url.pathname.startsWith('/uploads/')) return route.fulfill({ contentType: 'image/png', body: png });
    if (url.pathname === '/api/photo-uploads') {
      uploads.push({ headers: request.headers(), body: request.postDataBuffer() });
      if (holdUpload) await new Promise((resolve) => { releaseUpload = resolve; });
      return json({ url: '/uploads/new.png' });
    }
    if (url.pathname === '/api/supervisor/form-submissions/41') {
      patches.push({ headers: request.headers(), body: request.postDataJSON() });
      return patchStatus === 200 ? json({ ...record, revision: 4 }) : json({ detail: {
        code: patchStatus === 409 ? 'report_revision_conflict' : 'session_expired', message: 'Changed by another Supervisor'
      } }, patchStatus);
    }
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    if (!url.pathname.startsWith('/assets/')) { unexpected.push(url.pathname); return route.abort(); }
    const file = path.resolve(root, '.' + url.pathname);
    if (!file.startsWith(root + path.sep)) return route.abort();
    return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(file) });
  });
  await page.goto(origin);
  await page.evaluate(async (initialRecord) => {
    const { createReportEditor } = await import('/assets/js/report-editor.js');
    const state = { user: { id: 7, role: 'supervisor', departmentId: 2 } };
    let epoch = 1, closeOptions = {};
    window.saved = 0; window.notices = [];
    const form = document.getElementById('editor');
    const closeEditPanel = (scope, { reason = '' } = {}) => {
      if (closeOptions.closeGuard?.(reason) === false) return false;
      closeOptions.onClose?.(); closeOptions = {};
      form.replaceChildren();
      return true;
    };
    const showEditPanel = (title, fields, label, save, scope, options = {}) => {
      if (form.childElementCount && !closeEditPanel()) return false;
      closeOptions = options;
      document.getElementById('title').textContent = title;
      for (const field of fields) {
        if (field.type === 'custom') { form.insertAdjacentHTML('beforeend', field.html); continue; }
        const wrapper = document.createElement('label'); wrapper.textContent = field.label;
        const input = document.createElement(field.type === 'select' ? 'select' : 'input'); input.id = field.id;
        if (field.type === 'select') for (const option of field.options) input.add(new Option(option.label, option.value));
        else input.type = field.type;
        input.value = field.value || ''; wrapper.append(input); form.append(wrapper);
      }
      const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = label;
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.onclick = () => closeEditPanel('supervisor', { reason: 'cancel' });
      form.append(submit, cancel);
      form.onsubmit = (event) => { event.preventDefault(); void save(); };
      return true;
    };
    window.editor = createReportEditor({ state, showEditPanel, closeEditPanel,
      captureSession: () => epoch, isCurrentSession: (session) => session === epoch,
      handleSessionExpired: () => { epoch++; window.editor.resetSession(); },
      onSaved: async () => { window.saved++; }, notify: (...values) => window.notices.push(values) });
    window.openReport = (override = {}) => window.editor.open({ ...initialRecord, ...override }, [{ id: 5, name: 'Site five' }, { id: 6, name: 'Site six' }]);
    window.changeSession = () => { epoch++; window.editor.resetSession(); };
    window.closeEditor = closeEditPanel;
    window.openReport();
  }, record);
  return { page, context, patches, uploads, errors, unexpected,
    status: (value) => { patchStatus = value; }, hold: () => { holdUpload = true; },
    release: () => releaseUpload?.(),
    close: async () => { releaseUpload?.(); assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); await context.close(); }
  };
}

const browser = await chromium.launch({ headless: true });
let count = 0;
try {
  await mkdir(output, { recursive: true });
  {
    const f = await fixture(browser);
    assert.equal(await f.page.locator('img[data-existing-signature]').count(), 3);
    await f.page.locator('#reportCorrectionField_notes').fill('Corrected answer');
    await f.page.locator('#editReportDate').fill('2026-10-23');
    await f.page.locator('#editReportSite').selectOption('6');
    await f.page.locator('[data-repeat-remove]').first().click();
    assert.equal(await f.page.locator('[data-repeat-row]').count(), 1);
    await f.page.getByRole('button', { name: 'Save Report', exact: true }).click();
    await f.page.waitForFunction(() => window.saved === 1);
    assert.equal(f.uploads.length, 0);
    assert.equal(f.patches.length, 1);
    const { body, headers } = f.patches[0];
    assert.equal(body.expected_revision, 3); assert.equal(body.confirmed, true);
    assert.equal(body.work_date, '2026-10-23'); assert.equal(body.site_id, 6);
    assert.equal(body.answers.notes, 'Corrected answer'); assert.equal(body.answers.signed, record.answers.signed);
    assert.deepEqual(body.answers.crew, [record.answers.crew[1]], 'removing a repeat row must not attach the removed signature to the next person');
    assert.deepEqual(body.photo_urls, record.photoUrls); assert.deepEqual(body.photo_metadata, record.photoMetadata.map((item, index) => ({ ...item, url: record.photoUrls[index] })));
    assert.equal(headers['x-report-recovery-worker'], '7'); assert.equal(headers['x-report-recovery-department'], '2');
    assert.equal(headers['x-report-recovery-role'], 'supervisor');
    await f.close(); console.log(`ok ${++count} - date, Site and answers update with exact revision and retained signatures`);
  }
  {
    const f = await fixture(browser); f.status(409);
    await f.page.locator('#reportCorrectionField_notes').fill('Keep my correction');
    await f.page.getByRole('button', { name: 'Save Report', exact: true }).click();
    await f.page.getByText('This Report changed since you opened it.', { exact: false }).waitFor();
    assert.equal(await f.page.locator('#reportCorrectionField_notes').inputValue(), 'Keep my correction');
    assert.equal(await f.page.evaluate(() => window.editor.prepareForNavigation().then((result) => result.safe)), false);
    assert.equal(await f.page.evaluate(() => window.saved), 0);
    await f.page.screenshot({ path: path.join(output, 'phone-conflict.png'), fullPage: true });
    await f.close(); console.log(`ok ${++count} - concurrent edit conflict retains corrections and prevents unconfirmed departure`);
  }
  {
    const f = await fixture(browser);
    await f.page.getByRole('button', { name: 'Remove photo 1', exact: true }).click();
    await f.page.locator('[data-report-edit-add]').setInputFiles({ name: 'replacement.png', mimeType: 'image/png', buffer: png });
    await f.page.getByRole('button', { name: 'Save Report', exact: true }).click();
    await f.page.waitForFunction(() => window.saved === 1);
    assert.equal(f.uploads.length, 1);
    assert.deepEqual(f.patches[0].body.photo_urls, ['/uploads/new.png']);
    assert.equal(f.patches[0].body.photo_metadata[0].name, 'replacement.png');
    assert.equal(f.uploads[0].headers['x-report-recovery-role'], 'supervisor');
    await f.close(); console.log(`ok ${++count} - explicit photo replacement uploads original bytes under Supervisor identity`);
  }
  {
    const f = await fixture(browser); f.hold();
    await f.page.locator('[data-report-edit-add]').setInputFiles({ name: 'new.png', mimeType: 'image/png', buffer: png });
    await f.page.getByRole('button', { name: 'Save Report', exact: true }).click();
    await f.page.waitForFunction(() => document.querySelector('[data-report-edit-feedback]').textContent.includes('Saving'));
    assert.equal(await f.page.evaluate(() => window.closeEditor()), false);
    await f.page.waitForTimeout(50);
    await f.page.evaluate(() => window.changeSession());
    assert.equal(await f.page.locator('#editor').textContent(), '');
    f.release(); await f.page.waitForTimeout(100);
    assert.equal(f.patches.length, 0); assert.equal(await f.page.evaluate(() => window.saved), 0);
    await f.close(); console.log(`ok ${++count} - held upload cannot save after account scope changes, and busy Cancel is blocked`);
  }
  {
    const f = await fixture(browser);
    await f.page.getByRole('button', { name: 'Clear Signature signature', exact: true }).click();
    await f.page.getByRole('button', { name: 'Save Report', exact: true }).click();
    await f.page.getByText('Signature is required.', { exact: true }).waitFor();
    assert.equal(f.patches.length, 0);
    const pad = f.page.locator('#reportCorrectionField_signed');
    await pad.focus(); await pad.press('Space'); await pad.press('ArrowRight'); await pad.press('ArrowDown'); await pad.press('Space');
    await f.page.getByRole('button', { name: 'Save Report', exact: true }).click();
    await f.page.waitForFunction(() => window.saved === 1);
    assert.equal(f.patches[0].body.answers.signed, '/uploads/new.png');
    assert.deepEqual(f.patches[0].body.answers.crew, record.answers.crew);
    await f.close(); console.log(`ok ${++count} - explicit signature clear needs new handwriting, with other signatures retained`);
  }
  {
    const f = await fixture(browser);
    await f.page.evaluate(() => { window.closeEditor('supervisor', { reason: 'cancel' }); window.openReport({ revision: undefined }); });
    assert.equal(await f.page.locator('#editor').textContent(), '');
    assert.match((await f.page.evaluate(() => window.notices))[0][0], /must support Report corrections/);
    assert.equal(f.patches.length, 0);
    await f.close(); console.log(`ok ${++count} - old backend without revision cannot open a correction editor`);
  }
  for (const status of [401, 403]) {
    const f = await fixture(browser); f.status(status);
    await f.page.getByRole('button', { name: 'Save Report', exact: true }).click();
    await f.page.waitForFunction(() => document.getElementById('editor').childElementCount === 0);
    assert.equal(await f.page.evaluate(() => window.editor.hasActive()), false);
    assert.equal(await f.page.evaluate(() => window.saved), 0);
    await f.close(); console.log(`ok ${++count} - authorization denial ${status} clears private Report corrections`);
  }
  {
    const f = await fixture(browser);
    await f.page.evaluate((answers) => {
      window.closeEditor('supervisor', { reason: 'cancel' });
      window.openReport({ answers: { ...answers, crew: [] } });
    }, record.answers);
    assert.equal(await f.page.locator('[data-repeat-row]').count(), 0);
    await f.page.locator('[data-repeat-add]').click();
    await f.page.locator('[data-repeat-remove]').click();
    assert.equal(await f.page.locator('[data-repeat-row]').count(), 0);
    await f.page.locator('#editReportDate').fill('2026-10-23');
    await f.page.getByRole('button', { name: 'Save Report', exact: true }).click();
    await f.page.waitForFunction(() => window.saved === 1);
    assert.deepEqual(f.patches[0].body.answers.crew, []);
    await f.close(); console.log(`ok ${++count} - empty optional groups stay empty and allow date-only corrections`);
  }
  console.log(`PASS ${count} Report correction browser groups`);
} finally { await browser.close(); }
