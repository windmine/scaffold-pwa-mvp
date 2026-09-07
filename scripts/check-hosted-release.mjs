import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

// Read-only hosted release checks. No login, production mutation, or credential access.
const [originArgument, evidenceArgument] = process.argv.slice(2);
const origin = new URL(originArgument);
assert.equal(origin.protocol, 'https:');
assert.equal(origin.username + origin.password + origin.search + origin.hash, '');
assert.equal(origin.pathname, '/');
const evidencePath = resolve(evidenceArgument);
assert.ok(!existsSync(evidencePath), 'Evidence must be a new file');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sw = readFileSync('dist/sw.js', 'utf8');
const shell = JSON.parse(sw.match(/const APP_SHELL = (\[[\s\S]*?\]);/)[1]);
const paths = [...new Set([...shell, '/sw.js'])];
const evidence = { schemaVersion: 1, origin: origin.origin, startedAtUtc: new Date().toISOString(),
  status: 'running', scope: 'Read-only hosted shell parity, readiness, anonymous isolation and Chromium cold-offline PWA',
  assets: [], readiness: [], anonymous: [], pwa: {} };
let browser;
try {
  for (let index = 0; index < paths.length; index += 5) {
    const results = await Promise.all(paths.slice(index, index + 5).map(async (path) => {
      const response = await fetch(new URL(path, origin), { cache: 'no-store', signal: AbortSignal.timeout(30000) });
      assert.equal(response.status, 200, `Missing shell asset ${path}`);
      const local = readFileSync(resolve('dist', path === '/' ? 'index.html' : path.slice(1)));
      const remote = Buffer.from(await response.arrayBuffer());
      assert.equal(digest(remote), digest(local), `Shell parity mismatch ${path}`);
      const cacheControl = response.headers.get('cache-control');
      if (['/sw.js', '/offline.html'].includes(path)) assert.match(cacheControl, /no-cache/);
      if (path === '/manifest.webmanifest') assert.match(cacheControl, /max-age=3600/);
      return { path, sha256: digest(local), bytes: local.length, cacheControl };
    }));
    evidence.assets.push(...results);
  }
  console.log(`ok - ${evidence.assets.length} exact generated shell assets and cache headers`);
  for (let index = 0; index < 5; index += 1) {
    const response = await fetch(new URL('/api/health/ready', origin), { signal: AbortSignal.timeout(30000) });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    for (const key of ['database', 'migrations', 'upload_storage']) assert.equal(body.checks[key], 'ok');
    assert.equal(body.details.upload_storage.backend, 'gcs');
    evidence.readiness.push({ checkedAtUtc: new Date().toISOString(), ...body });
  }
  for (const path of ['/api/sites', '/api/my-form-submissions?purpose=report', '/api/supervisor/form-submissions?purpose=report']) {
    const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 401, `Anonymous isolation ${path}`);
    evidence.anonymous.push({ path, status: response.status });
  }
  console.log('ok - five database/migration/GCS probes and anonymous isolation');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.name)));
  const page = await context.newPage();
  await page.goto(origin.origin, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.body.dataset.activeView === 'login');
  assert.ok(await page.evaluate(() => document.body.classList.contains('report-only-mode')));
  assert.equal(await page.locator('#registrationPanel').isVisible(), false);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration())?.active),
    null, { timeout: 45000 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  evidence.pwa.controller = await page.evaluate(() => navigator.serviceWorker.controller.scriptURL);
  await page.close();
  await context.setOffline(true);
  const offline = await context.newPage();
  await offline.goto(origin.origin, { waitUntil: 'domcontentloaded' });
  await offline.waitForFunction(() => document.body.dataset.activeView === 'login');
  assert.ok(await offline.evaluate(() => document.body.classList.contains('report-only-mode')));
  evidence.pwa.coldOfflineAfterLastPageClosed = true;
  evidence.pwa.physicalPhoneTest = false;
  assert.deepEqual(errors, []);
  console.log('ok - anonymous phone-width report shell and cold-offline service-worker launch');
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.failure = String(error.message).slice(0, 1000);
  process.exitCode = 1;
  console.error(evidence.failure);
} finally {
  if (browser) await browser.close();
  evidence.completedAtUtc = new Date().toISOString();
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
}
