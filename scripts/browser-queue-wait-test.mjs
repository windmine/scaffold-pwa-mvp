import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Exercise the exact real-backend workflow helper without starting its backend.
const source = readFileSync(new URL('./check-browser-workflows.mjs', import.meta.url), 'utf8');
const start = source.indexOf('async function waitForQueueCount(');
const end = source.indexOf('\nasync function waitForQueueAtLeast(', start);
assert.ok(start > 0 && end > start);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const asyncStart = source.indexOf('async function waitForAsyncCondition(');
const asyncEnd = source.indexOf('\nasync function pageWaitForRecordCount(', asyncStart);
assert.ok(asyncStart > 0 && asyncEnd > asyncStart);
const waitForAsyncCondition = new Function('delay', `return (${source.slice(asyncStart, asyncEnd).trim()});`)(delay);
const waitForQueueCount = new Function('waitForAsyncCondition', `return (${source.slice(start, end).trim()});`)(waitForAsyncCondition);
const accessibleStart = source.indexOf('async function checkAccessibleActionFeedback(');
const accessibleEnd = source.indexOf('\nasync function checkRestoredSessionLoadsSitesAfterRefresh(', accessibleStart);
assert.ok(accessibleStart > 0 && accessibleEnd > accessibleStart);
const accessible = source.slice(accessibleStart, accessibleEnd);
const readinessStart = accessible.indexOf("    await page.locator('#syncIndicator').waitFor(");
const assertionStart = accessible.indexOf("    const syncState = await page.locator('#syncIndicator').evaluate(", readinessStart);
const assertionEnd = accessible.indexOf("    await page.route('**/api/auth/login'", assertionStart);
assert.ok(readinessStart > 0 && assertionStart > readinessStart && assertionEnd > assertionStart);
const accessibleStartupReadiness = new Function('page', `return (async () => {
  ${accessible.slice(readinessStart, assertionStart)}
})();`);
const assertAccessibleOnline = new Function('page', `return (async () => {
  ${accessible.slice(assertionStart, assertionEnd)}
})();`);
const server = createServer((_request, response) => response.end('<!doctype html><title>Queue wait contract</title>'));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
const names = ['scaffold-pwa-local', 'scaffold-pwa-report-evidence-v1', 'scaffold-pwa-report-recovery-v1'];
let failures = 0;
function holdNativeStartupStatusRead() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  window.startupStatusReadHeld = false;
  window.releaseStartupStatusRead = release;
  const nativeGet = IDBObjectStore.prototype.get;
  const completion = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
  IDBObjectStore.prototype.get = function (...args) {
    const request = Reflect.apply(nativeGet, this, args);
    if (this.name !== 'settings' || args[0] !== 'lastSyncAt'
      || this.transaction.db.name !== 'scaffold-pwa-local') return request;
    Object.defineProperty(this.transaction, 'oncomplete', {
      configurable: true,
      get() { return completion.get.call(this); },
      set(handler) {
        completion.set.call(this, async function (event) {
          // Preserve the real request result and committed native transaction;
          // delay only its completion callback to expose the startup race.
          window.startupStatusReadHeld = true;
          await gate;
          handler.call(this, event);
        });
      }
    });
    return request;
  };
}

async function checkNativeStartupReadiness(page) {
  const requests = [];
  await page.addInitScript(() => { window.__REPORT_ONLY_MODE_OVERRIDE__ = false; });
  await page.addInitScript(holdNativeStartupStatusRead);
  await page.route('**/*', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/api/') || pathname.startsWith('/health')) requests.push(pathname);
    // Serve the real source app without a backend. Its fresh anonymous startup
    // does no protected API work; Leaflet needs the same bare-import resolution
    // as browser-workflow-source-server.mjs, with application logic unchanged.
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!/^(?:index\.html|assets\/[\w./-]+|node_modules\/leaflet\/dist\/leaflet-src\.esm\.js)$/.test(relative)
      || relative.split('/').includes('..')) {
      await route.abort();
      return;
    }
    const file = new URL(`../${relative}`, import.meta.url);
    if (relative.endsWith('.js')) {
      const module = readFileSync(file, 'utf8')
        .replaceAll("import L from 'leaflet';", "import * as L from '/node_modules/leaflet/dist/leaflet-src.esm.js';")
        .replace(/^import 'leaflet\/dist\/leaflet\.css';?\r?\n/gm, '');
      await route.fulfill({ contentType: 'text/javascript', body: module });
    } else {
      await route.fulfill({ path: fileURLToPath(file) });
    }
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.startupStatusReadHeld === true, null, { timeout: 10000 });
  assert.deepEqual(await page.locator('#syncIndicator').evaluate((element) => ({
    view: document.body.dataset.activeView,
    state: element.dataset.state,
    role: element.getAttribute('role'),
    live: element.getAttribute('aria-live'),
    text: element.textContent.trim()
  })), { view: 'login', state: 'checking', role: 'status', live: 'polite', text: 'Checking connection...' });
  await assert.rejects(assertAccessibleOnline(page), /sync indicator is not an accessible persistent status:.*Checking connection/);
  let settled = false;
  const readiness = accessibleStartupReadiness(page).finally(() => { settled = true; });
  try {
    await delay(150);
    assert.equal(settled, false, 'accessibility readiness completed before the held native startup read');
  } finally {
    await page.evaluate(() => window.releaseStartupStatusRead());
    await readiness;
  }
  await assertAccessibleOnline(page);
  assert.equal(await page.locator('#syncIndicator').getAttribute('data-state'), 'online');
  assert.deepEqual(requests, [], 'fresh anonymous startup unexpectedly requested health or authentication');
}

async function withPage(name, check) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => {
      window.writeNativeQueue = async (name, value) => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open(name, 1);
          request.onupgradeneeded = () => request.result.createObjectStore('queue', { keyPath: 'id' });
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          await new Promise((resolve, reject) => {
            const tx = db.transaction('queue', 'readwrite');
            tx.objectStore('queue').put(value);
            tx.oncomplete = resolve;
            tx.onabort = tx.onerror = () => reject(tx.error);
          });
        } finally { db.close(); }
      };
    });
    await check(page);
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}: ${error.message}`);
  } finally { await context.close(); }
}
try {
  browser = await chromium.launch({ headless: true });
  await withPage('accessible Online status waits for native lastSyncAt completion after login becomes visible', checkNativeStartupReadiness);
  await withPage('an asynchronous false condition times out instead of accepting its Promise', async (page) => {
    await assert.rejects(waitForAsyncCondition(page, async () => false, null, { timeout: 100 }), /Timeout/);
  });
  await withPage('a hung asynchronous predicate retains the original bounded timeout', async (page) => {
    await assert.rejects(waitForAsyncCondition(page, () => new Promise(() => {}), null, { timeout: 100 }), /Timeout/);
  });
  await withPage('predicate errors propagate instead of being mistaken for readiness', async (page) => {
    await assert.rejects(waitForAsyncCondition(page, async () => { throw new Error('native-read-failed'); }), /native-read-failed/);
  });
  await withPage('an empty native queue never satisfies an asynchronous at-least-one predicate', async (page) => {
    await assert.rejects(waitForQueueCount(page, 1, { atLeast: true, timeout: 250 }), /queue count|Timeout/i);
  });
  await withPage('a nonempty native queue cannot falsely satisfy zero', async (page) => {
    await page.evaluate(([name]) => window.writeNativeQueue(name, { id: 'pending' }), names);
    await assert.rejects(waitForQueueCount(page, 0, { timeout: 250 }), /queue count|Timeout/i);
  });
  for (const [index, name] of names.entries()) {
    await withPage(`delayed native writes in namespace ${index} finish before the wait returns`, async (page) => {
      await page.evaluate(({ name, index }) => {
        window.queueWriteFinished = false;
        setTimeout(async () => {
          await window.writeNativeQueue(name, index === 0 ? { id: 'delayed' }
            : { id: 'delayed', reportStorageVersion: 1, value: { id: 'delayed' } });
          window.queueWriteFinished = true;
        }, 100);
      }, { name, index });
      await waitForQueueCount(page, 1, { timeout: 1500 });
      assert.equal(await page.evaluate(() => window.queueWriteFinished), true);
    });
  }
  await withPage('recovery tombstones shadow identical queue IDs in both older namespaces', async (page) => {
    await page.evaluate(async (names) => {
      await window.writeNativeQueue(names[0], { id: 'retired' });
      await window.writeNativeQueue(names[1], { id: 'retired', reportStorageVersion: 1, value: { id: 'retired' } });
      await window.writeNativeQueue(names[2], { id: 'retired', reportStorageVersion: 1, deleted: true });
    }, names);
    await waitForQueueCount(page, 0, { timeout: 500 });
  });
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
assert.equal(failures, 0, `${failures} browser queue-wait contract groups failed`);
console.log('10 native browser startup/asynchronous/queue-wait contract groups passed.');
