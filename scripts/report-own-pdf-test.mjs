import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59944';
const output = path.join(root, 'output/worker-pdf-local');
const markup = `<!doctype html><html lang="en-NZ"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/assets/css/styles.css"></head><body class="report-only-mode"><main style="width:100%;max-width:1000px;margin:auto;padding:12px;box-sizing:border-box"><h1>My Reports</h1><div id="historyList" class="records-list"></div><div id="detailList"></div><div hidden><div id="workerSummary"></div><input id="historySearchInput"><select id="historyTypeFilter"><option value="form">Form</option></select><select id="historyStatusFilter"><option value=""></option></select><input id="historyDateFilter" type="date"><span id="historyResultCount"></span><button id="refreshHistoryButton">Refresh</button><button id="clearHistoryFiltersButton">Clear filters</button></div><button id="language" data-language-toggle>Language</button><template id="recordTemplate"><article class="record-card"><div class="record-header"><div><h3 class="record-title"></h3><p class="record-meta"></p></div><span class="badge"></span></div><p class="record-detail"></p><div class="record-extra"></div><div class="record-actions hidden"></div></article></template></main></body></html>`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
context.setDefaultTimeout(6000);
let requestCount = 0;
let responseStatus = 200;
let mime = 'application/pdf';
let body = '%PDF-1.4\nsynthetic test PDF';
let delay;
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, origin, 'No external requests permitted');
  if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: markup });
  if (url.pathname === '/api/my-form-submissions/71/export.pdf') {
    requestCount++;
    assert.equal(route.request().method(), 'GET');
    assert.equal(route.request().headers().accept, 'application/pdf');
    if (delay) await delay;
    return route.fulfill({ status: responseStatus, contentType: mime, body });
  }
  if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
  assert.match(url.pathname, /^\/assets\/(js\/[a-z0-9-]+\.js|css\/styles\.css)$/);
  return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(path.join(root, url.pathname), 'utf8') });
});
const page = await context.newPage();
const errors = [];
const downloads = [];
page.on('pageerror', e => errors.push(e.message));
page.on('download', download => downloads.push(download.suggestedFilename()));
const actions = page.locator('.report-own-pdf-actions');
const downloadButton = () => actions.getByRole('button', { name: 'Download PDF', exact: true });
const shareButton = () => actions.getByRole('button', { name: 'Share PDF', exact: true });
async function setup() {
  await page.goto(origin);
  await page.evaluate(async () => {
    const { createHistoryModule } = await import('/assets/js/history.js');
    const i18n = await import('/assets/js/i18n.js');
    const api = await import('/assets/js/api-client.js');
    const els = Object.fromEntries([...document.querySelectorAll('[id]')].map(n => [n.id, n]));
    const user = { id: 12, departmentId: 3, role: 'worker', status: 'active' };
    localStorage.setItem('geo_user', JSON.stringify(user));
    const state = { user, historyRecords: [], sites: [] };
    let expired = 0;
    const module = createHistoryModule({ els, state, reportOnly: true, photoViewer: { closeForSources() {} }, renderStatusBanner() {}, handleSessionExpired() { expired++; state.user = null; module.resetSession(); }, canWorkerEditRecord: () => false });
    const base = { id: 'form-71', backendRecordId: 71, type: 'form', userId: 12, departmentId: 3, submissionPurpose: 'report', formName: 'Inspection', workDate: '2026-11-11', createdAt: '2026-11-11T00:00:00Z', syncStatus: 'synced', source: 'backend', fields: [], answers: {}, photoUrls: [] };
    const render = (overrides = {}) => { state.historyRecords = [{ ...base, ...overrides }]; module.renderFilteredHistory(); };
    const calls = [];
    const supported = (outcome = 'success', activation = false) => {
      Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: activation } });
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: data => data.files?.[0]?.type === 'application/pdf' });
      Object.defineProperty(navigator, 'share', { configurable: true, value: async data => {
        calls.push({ name: data.files[0].name, type: data.files[0].type, keys: Object.keys(data), size: data.files[0].size });
        if (outcome === 'cancel') throw new DOMException('Cancelled', 'AbortError');
        if (outcome === 'fail') throw new DOMException('Denied', 'NotAllowedError');
        if (outcome === 'pending') await new Promise(resolve => { window.finishShare = resolve; });
      } });
    };
    const urls = new Set();
    const create = URL.createObjectURL.bind(URL); const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); urls.add(url); return url; };
    URL.revokeObjectURL = url => { urls.delete(url); revoke(url); };
    window.fixture = { els, user, state, module, i18n, api, base, render, calls, supported, urls, expired: () => expired };
    i18n.initLanguageToggle({ button: els.language });
    module.bindEvents(); render();
  });
}
async function expand(overrides = {}) {
  await page.evaluate(v => window.fixture.render(v), overrides);
  const disclosure = page.getByRole('button', { name: 'Show details', exact: true });
  if (await disclosure.count()) await disclosure.click();
}
async function statusIncludes(text) {
  await page.waitForFunction(value => document.querySelector('.report-own-pdf-status')?.textContent.includes(value), text);
}
try {
  await setup();
  assert.equal(await actions.count(), 0, 'Compact card stays uncluttered');
  await expand();
  assert.equal(await actions.count(), 1);
  assert.equal(await actions.locator('button').count(), 2);
  const downloaded = page.waitForEvent('download');
  await downloadButton().click();
  assert.equal((await downloaded).suggestedFilename(), 'report-71.pdf');
  await statusIncludes('PDF download started');
  assert.equal(requestCount, 1);
  assert.equal(await page.evaluate(() => window.fixture.urls.size), 1);
  await page.getByRole('button', { name: 'Hide details', exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixture.urls.size), 0, 'Collapse revokes file URLs');
  for (const value of [{ source: 'local', backendRecordId: null, syncStatus: 'queued' }, { source: 'local', backendRecordId: null, syncStatus: 'syncing' }, { isDraftRecovery: true }, { userId: 99 }, { departmentId: 4 }, { submissionPurpose: 'daywork' }, { departmentId: null }]) {
    await expand(value); assert.equal(await actions.count(), 0, JSON.stringify(value));
  }
  console.log('ok - only current Worker own submitted Reports expose PDFs; queues/drafts/Daywork/foreign records do not');
  await expand();
  await page.evaluate(() => window.fixture.supported());
  await shareButton().click(); await statusIncludes('PDF ready');
  assert.equal(await page.evaluate(() => window.fixture.calls.length), 0);
  const preparedRequests = requestCount;
  await shareButton().focus(); await page.keyboard.press('Enter');
  await statusIncludes('Sharing finished');
  assert.equal(requestCount, preparedRequests, 'Second gesture uses prepared file without losing activation to a fetch');
  assert.deepEqual(await page.evaluate(() => window.fixture.calls[0]), { name: 'report-71.pdf', type: 'application/pdf', keys: ['files'], size: body.length });
  console.log('ok - delayed prepare requests a fresh user gesture; native chooser receives the actual PDF, never a private URL');
  for (const outcome of ['cancel', 'fail']) {
    await expand(); await page.evaluate(outcome => window.fixture.supported(outcome, true), outcome);
    const count = downloads.length;
    await shareButton().click();
    await statusIncludes(outcome === 'cancel' ? 'Sharing cancelled.' : 'Sharing is unavailable.');
    assert.equal(downloads.length, count, 'Cancel/failure never silently downloads or sends');
    assert.equal(await shareButton().isEnabled(), true);
  }
  await expand();
  await page.evaluate(() => { Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false }); });
  const fallback = page.waitForEvent('download'); await shareButton().click(); await fallback;
  await statusIncludes('download started instead');
  console.log('ok - native cancellation and failure are recoverable; browsers without file sharing download instead');
  await expand();
  const offlineRequests = requestCount;
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); window.dispatchEvent(new Event('offline')); });
  await shareButton().click(); await downloadButton().click(); await statusIncludes('You are offline');
  assert.equal(requestCount, offlineRequests);
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); });
  for (const [code, text] of [[404, 'Refresh My Reports'], [403, 'Refresh My Reports'], [409, 'Contact your Supervisor'], [503, 'Check your connection']]) {
    responseStatus = code; await downloadButton().click(); await statusIncludes(text); assert.equal(await shareButton().isEnabled(), true);
  }
  responseStatus = 200; mime = 'text/html'; body = '<html>not a PDF</html>';
  await downloadButton().click(); await statusIncludes('Check your connection');
  mime = 'application/pdf'; body = 'not pdf';
  await downloadButton().click(); await statusIncludes('Check your connection');
  body = '%PDF-1.4\nsynthetic test PDF';
  console.log('ok - offline, unavailable, authorization and invalid-content failures never create a bogus PDF');
  let release; delay = new Promise(resolve => { release = resolve; });
  await downloadButton().click(); await statusIncludes('Preparing PDF');
  assert.equal(await shareButton().isDisabled(), true);
  const lateCount = downloads.length;
  await page.getByRole('button', { name: 'Hide details', exact: true }).click();
  release(); delay = null;
  await page.waitForTimeout(100);
  assert.equal(downloads.length, lateCount, 'Collapsed cards do not download late responses');
  await expand();
  delay = new Promise(resolve => { release = resolve; });
  await downloadButton().click(); await statusIncludes('Preparing PDF');
  await page.evaluate(() => { window.fixture.state.user = { id: 99, role: 'worker', departmentId: 4 }; window.fixture.module.resetSession(); });
  release(); delay = null; await page.waitForTimeout(100);
  assert.equal(downloads.length, lateCount);
  assert.equal(await actions.count(), 0);
  await page.evaluate(() => { window.fixture.state.user = window.fixture.user; });
  await expand(); await page.evaluate(() => window.fixture.supported('pending', true));
  await shareButton().click(); await page.waitForFunction(() => typeof window.finishShare === 'function');
  assert.equal(await downloadButton().isDisabled(), true);
  await page.evaluate(() => window.finishShare()); await statusIncludes('Sharing finished');
  console.log('ok - repeated clicks are single-flight; collapse, refresh and account changes cancel stale PDF work');
  // A different tab changes the shared login without updating this tab's state.
  await expand(); await page.evaluate(() => window.fixture.supported());
  await shareButton().click(); await statusIncludes('PDF ready');
  const oldCalls = await page.evaluate(() => window.fixture.calls.length);
  await page.evaluate(() => {
    localStorage.setItem('geo_user', JSON.stringify({ id: 99, role: 'worker', departmentId: 4 }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'geo_user' }));
  });
  assert.equal(await shareButton().isDisabled(), true);
  await statusIncludes('Your account changed');
  await page.evaluate(() => document.querySelector('.report-own-pdf-actions button:last-of-type').click());
  assert.equal(await page.evaluate(() => window.fixture.calls.length), oldCalls);
  await page.evaluate(() => localStorage.setItem('geo_user', JSON.stringify(window.fixture.user)));
  await expand();
  delay = new Promise(resolve => { release = resolve; });
  await downloadButton().click(); await statusIncludes('Preparing PDF');
  const beforeLogout = downloads.length;
  await page.evaluate(() => { localStorage.removeItem('geo_user'); window.dispatchEvent(new StorageEvent('storage', { key: 'geo_user' })); });
  release(); delay = null; await page.waitForTimeout(100);
  assert.equal(downloads.length, beforeLogout);
  assert.equal(await shareButton().isDisabled(), true);
  await page.evaluate(() => localStorage.setItem('geo_user', JSON.stringify(window.fixture.user)));
  await expand(); await page.evaluate(() => window.fixture.supported());
  await shareButton().click(); await statusIncludes('PDF ready');
  // Even without a storage event (same-tab change), every action rereads login.
  await page.evaluate(() => localStorage.removeItem('geo_user'));
  await shareButton().click();
  assert.equal(await page.evaluate(() => window.fixture.calls.length), oldCalls);
  await page.evaluate(() => localStorage.setItem('geo_user', JSON.stringify(window.fixture.user)));
  await expand();
  await page.evaluate(() => window.fixture.supported());
  await shareButton().click(); await statusIncludes('PDF ready');
  const expiredRequests = requestCount;
  // Simulate a suspended mobile tab where wall time advances before timers run.
  await page.evaluate(() => { const now = Date.now; Date.now = () => now() + 61_000; });
  await shareButton().click(); await statusIncludes('PDF ready');
  assert.equal(requestCount, expiredRequests + 1, 'Expired bytes are fetched again before sharing');
  await expand();
  delay = new Promise(resolve => { release = resolve; });
  await downloadButton().click(); await statusIncludes('Preparing PDF');
  const beforeOffline = downloads.length;
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); window.dispatchEvent(new Event('offline')); });
  release(); delay = null; await page.waitForTimeout(100);
  assert.equal(downloads.length, beforeOffline);
  await statusIncludes('You are offline');
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); });
  await expand();
  console.log('ok - shared-login changes, suspended-tab expiry and network loss invalidate prepared or pending PDFs');
  responseStatus = 401; await downloadButton().click();
  await page.waitForFunction(() => window.fixture.expired() === 1);
  assert.equal(await actions.count(), 0); responseStatus = 200;
  await page.evaluate(() => { window.fixture.state.user = window.fixture.user; });
  for (const [width, language, theme] of [[320, 'en', 'light'], [390, 'zh', 'dark'], [1200, 'en', 'light']]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(({ language, theme }) => { document.documentElement.dataset.theme = theme; window.fixture.i18n.setLanguage(language); }, { language, theme });
    // Disclosure is translated, so expand through its language-independent selector.
    await page.evaluate(() => window.fixture.render());
    await page.locator('.record-disclosure-button').click();
    await page.evaluate(() => window.fixture.i18n.applyLanguage());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const button of await actions.locator('button').all()) assert.ok((await button.boundingBox()).height >= 44);
    assert.equal(await actions.locator('[role="status"]').getAttribute('aria-live'), 'polite');
    if (language === 'zh') assert.doesNotMatch(await actions.innerText(), /Download PDF|Share PDF/);
    await actions.locator('button').first().focus();
    assert.equal(await actions.locator('button').first().evaluate(button => document.activeElement === button), true);
    await page.screenshot({ path: path.join(output, `worker-pdf-${width}-${language}-${theme}.png`), fullPage: true });
  }
  const invalid = await page.evaluate(async () => {
    for (const id of ['../1', '1?x=2', 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      try { await window.fixture.api.exportMyReportPdf(id); return false; } catch { /* expected */ }
    }
    return true;
  });
  assert.equal(invalid, true);
  assert.deepEqual(errors, []);
  console.log('ok - session expiry, strict IDs, keyboard, 44px touch targets and EN/ZH mobile/desktop layouts pass');
} finally { await context.close(); await browser.close(); }
