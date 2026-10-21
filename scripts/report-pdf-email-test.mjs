import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Real settings component, API/CSRF client, language and CSS. Every request is
// intercepted; no server, accounts, credentials or real email are involved.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59974';
const output = path.join(root, 'output/report-pdf-email.local');
const markup = `<!doctype html><html lang="en-NZ" data-theme="light"><head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/assets/css/styles.css"></head>
  <body class="report-only-mode"><main style="max-width:760px;margin:auto;padding:12px">
    <h1>Report Templates</h1><article id="template" class="record-card"><h2>Site inspection</h2></article>
    <p id="status"></p><button id="language" data-language-toggle>中文</button></main></body></html>`;
const browser = await chromium.launch({ headless: true });
await mkdir(output, { recursive: true });
let checks = 0;
async function fixture({ email = { enabled: false, recipient: null, version: 1 }, purpose = 'report' } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  context.setDefaultTimeout(5000);
  const requests = [];
  const errors = [];
  let fail = 0;
  let held = null;
  let hold = false;
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    assert.equal(url.origin, origin, 'No external requests allowed');
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: markup });
    if (url.pathname === '/api/supervisor/work-forms/17/pdf-email') {
      assert.equal(request.method(), 'PUT');
      assert.equal(request.headers()['x-csrf-token'], 'SyntheticPdfCsrf');
      const data = request.postDataJSON();
      requests.push(data);
      if (hold) await new Promise((resolve) => { held = resolve; });
      return route.fulfill({ status: fail || 200, contentType: 'application/json', body: JSON.stringify(fail
        ? { detail: 'Settings conflict' }
        : { id: 17, template_purpose: 'report', pdf_email: { enabled: data.enabled, recipient: data.recipient, version: data.expected_version + 1 } }) });
    }
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    assert.match(url.pathname, /^\/assets\/(?:js\/[a-z\d-]+\.js|css\/styles\.css)$/);
    return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
      body: await readFile(path.join(root, url.pathname), 'utf8') });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  await page.evaluate(async ({ email, purpose }) => {
    document.cookie = 'geo_csrf_token=SyntheticPdfCsrf; SameSite=Lax; path=/';
    const { mountTemplateEmailSettings, reportPdfEmailStatus } = await import('/assets/js/report-pdf-email.js');
    const i18n = await import('/assets/js/i18n.js');
    window.fixture = { current: true, canSave: true, busy: [], saved: [], reportPdfEmailStatus, i18n };
    mountTemplateEmailSettings(document.querySelector('#template'), { id: 17, template_purpose: purpose, pdf_email: email }, {
      isCurrent: () => window.fixture.current && document.querySelector('#template').isConnected,
      canSave: () => window.fixture.canSave,
      onBusy: (value) => window.fixture.busy.push(value),
      onSaved: (value) => window.fixture.saved.push(value)
    });
    i18n.initLanguageToggle({ button: document.querySelector('#language') });
  }, { email, purpose });
  const form = page.locator('[data-pdf-email-settings]');
  if (await form.count()) await page.locator('summary').click();
  return { page, form, requests,
    fail(value) { fail = value; },
    hold() { hold = true; },
    async release() { assert.ok(held); held(); held = null; hold = false; },
    async close() { if (held) held(); assert.deepEqual(errors, []); await context.close(); },
  };
}
try {
  let f = await fixture();
  const enabled = f.form.locator('[data-pdf-email-enabled]');
  const recipient = f.form.locator('[data-pdf-email-recipient]');
  const save = f.form.locator('button');
  assert.equal(await enabled.isChecked(), false);
  assert.equal(f.requests.length, 0);
  await enabled.check();
  await save.click();
  assert.equal(f.requests.length, 0, 'Enabled requires recipient');
  await recipient.fill('a@example.invalid,b@example.invalid');
  await save.click();
  assert.equal(f.requests.length, 0, 'Only one recipient');
  await recipient.fill('inspection@example.invalid');
  f.hold();
  await save.click();
  await f.page.waitForFunction(() => window.fixture.busy.length === 1);
  assert.equal(await save.isDisabled(), true);
  assert.equal(await recipient.isDisabled(), true);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0], { enabled: true, recipient: 'inspection@example.invalid', expected_version: 1, confirmed: true });
  await f.release();
  await f.page.waitForFunction(() => window.fixture.saved.length === 1);
  assert.match(await f.form.innerText(), /Existing Reports will not be emailed/);
  await f.page.screenshot({ path: path.join(output, 'settings-en-phone.png'), fullPage: true });
  await f.page.locator('#language').click();
  await f.page.waitForFunction(() => document.documentElement.lang === 'zh-Hans');
  assert.match(await f.form.innerText(), /收件人邮箱/);
  await f.page.screenshot({ path: path.join(output, 'settings-zh-phone.png'), fullPage: true });
  await enabled.uncheck();
  await recipient.fill('');
  await save.click();
  await f.page.waitForFunction(() => window.fixture.saved.length === 2);
  assert.equal(f.requests[1].expected_version, 2);
  assert.equal(f.requests[1].enabled, false);
  assert.equal(f.requests[1].recipient, null);
  assert.deepEqual(await f.page.evaluate(() => window.fixture.busy), [true, false, true, false]);
  await f.close(); checks += 5;

  for (const code of [409, 503]) {
    f = await fixture();
    f.fail(code);
    await f.form.locator('button').click();
    await f.page.waitForFunction(() => window.fixture.busy.length === 2);
    assert.match(await f.form.innerText(), /Refresh the Template list/);
    assert.equal(await f.form.locator('button').isDisabled(), true);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(await f.page.evaluate(() => window.fixture.saved), []);
    await f.close(); checks += 1;
  }
  f = await fixture();
  await f.page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }));
  await f.form.locator('button').click();
  assert.equal(f.requests.length, 0);
  assert.match(await f.form.innerText(), /Connect before saving/);
  await f.close(); checks += 1;

  f = await fixture();
  f.hold();
  await f.form.locator('button').click();
  await f.page.waitForFunction(() => window.fixture.busy.length === 1);
  await f.page.evaluate(() => { window.fixture.current = false; });
  await f.release();
  await f.page.waitForFunction(() => window.fixture.busy.length === 2);
  assert.deepEqual(await f.page.evaluate(() => window.fixture.saved), []);
  await f.close(); checks += 1;

  for (const options of [{ purpose: 'daywork' }, { email: null }]) {
    f = await fixture(options);
    assert.equal(await f.form.count(), 0);
    assert.equal(f.requests.length, 0);
    await f.close(); checks += 1;
  }
  f = await fixture();
  const labels = await f.page.evaluate(() => ['pending', 'accepted', 'failed', 'uncertain'].map((status) => window.fixture.reportPdfEmailStatus({ status })));
  assert.match(labels[0], /pending.*submitted/);
  assert.match(labels[1], /inbox delivery is unconfirmed/);
  assert.match(labels[2], /not sent.*saved/);
  assert.match(labels[3], /Do not send again/);
  await f.close(); checks += 1;
  console.log(`PDF email browser checks passed: ${checks}; all requests intercepted.`);
} finally { await browser.close(); }
