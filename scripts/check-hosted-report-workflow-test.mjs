import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { browserApiRequest, resolutionNoteLocator } from './check-hosted-report-workflow.mjs';

// This test never starts the hosted runner or accesses a real origin/account.
const historySource = readFileSync(new URL('../assets/js/history.js', import.meta.url), 'utf8');
const paragraph = historySource.match(/finalSupervisorNote \? `(<p class="report-supervisor-note">[^`]+<\/p>)`/);
assert.ok(paragraph, 'Production resolution-note markup must be located rather than duplicated');
const note = 'TEST ONLY resolution-note selector regression';
const markup = paragraph[1].replace('${escapeHtml(finalSupervisorNote)}', note);
const browser = await chromium.launch({ headless: true });
let requestCount = 0;
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  // Set an intercepted, non-routable document so normal cookie access is available.
  await context.route('**/*', (route) => {
    requestCount += 1;
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><body></body>' });
  });
  const page = await context.newPage();
  await page.goto('https://hosted-runner-test.invalid/');
  await page.setContent(`<section id="reviewQueueDetail">${markup}</section>`);
  const detail = page.locator('#reviewQueueDetail');
  assert.equal(await detail.getByText(note, { exact: true }).count(), 0,
    'Old exact-note selector must reproduce its mismatch against actual production markup');
  const scopedNote = resolutionNoteLocator(detail, note);
  assert.equal(await scopedNote.count(), 1);
  assert.equal(await scopedNote.innerText(), `Final supervisor note: ${note}`);
  assert.equal(await resolutionNoteLocator(detail, 'unrelated note').count(), 0);
  console.log('ok - resolved-note locator matches actual labelled markup and rejects unrelated notes');

  await page.evaluate(() => {
    window.fetch = (_path, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  });
  const startedAt = Date.now();
  await assert.rejects(page.evaluate(browserApiRequest, { path: '/api/test-only', timeoutMs: 20 }),
    /TimeoutError|timed out/i);
  assert.ok(Date.now() - startedAt < 2000, 'Stalled browser fetch must be aborted promptly');
  console.log('ok - stalled API fetch is aborted, not left beyond the polling deadline');

  await page.evaluate(() => {
    document.cookie = 'geo_csrf_token=test-only-csrf; Secure; SameSite=Strict; Path=/';
    window.fetch = async (path, options) => ({
      status: 200, ok: true,
      json: async () => ({ path, method: options.method, credentials: options.credentials,
        csrf: options.headers['X-CSRF-Token'], payload: JSON.parse(options.body), hasSignal: !!options.signal })
    });
  });
  const result = await page.evaluate(browserApiRequest, {
    path: '/api/test-only', method: 'POST', body: { fixture: 'synthetic' }
  });
  assert.deepEqual(result, { status: 200, ok: true, body: {
    path: '/api/test-only', method: 'POST', credentials: 'include', csrf: 'test-only-csrf',
    payload: { fixture: 'synthetic' }, hasSignal: true
  } });
  assert.equal(requestCount, 1, 'Only the locally fulfilled fake document request is allowed');
  console.log('ok - bounded API wrapper preserves same-origin session, CSRF, and JSON payload');
  console.log('3 hosted runner checks passed; no network requests reached a server');
} finally {
  await browser.close();
}
