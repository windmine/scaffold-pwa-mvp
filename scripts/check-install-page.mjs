import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import process from 'node:process';

import { chromium } from 'playwright';

// This harness serves only the existing local build. It never starts a backend,
// visits the public installer, or uses real account/session data.
const buildRoot = resolve(process.cwd(), 'dist');
const canonicalInstallUrl = 'https://geo-attendance-system-db9ca.web.app/install.html';
const protectedPath = /^\/(?:api|auth|uploads|photo-uploads|supervisor|attendance|my-records|task-logs|team-work-logs|work-forms|form-submissions|sites|dev|health)(?:\/|$)/;
const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.json', 'application/json'],
  ['.webmanifest', 'application/manifest+json'], ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'], ['.pdf', 'application/pdf'], ['.woff2', 'font/woff2']
]);
const requests = [];
let origin = '';
let browser;
let screenshotDirectory = '';
const failures = [];

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    requests.push({ method: request.method, pathname: url.pathname });
    response.setHeader('cache-control', 'no-store');
    if (!['GET', 'HEAD'].includes(request.method) || protectedPath.test(url.pathname)) {
      response.writeHead(403, { 'content-type': 'text/plain' });
      response.end('Installer checks do not expose protected endpoints.');
      return;
    }
    const pathname = decodeURIComponent(url.pathname);
    const filePath = resolve(buildRoot, pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
    if (!filePath.startsWith(`${buildRoot}${sep}`)) {
      response.writeHead(403);
      response.end();
      return;
    }
    let data;
    try {
      data = await readFile(filePath);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('Not found');
      return;
    }
    response.writeHead(200, {
      'content-type': contentTypes.get(extname(filePath)) || 'application/octet-stream',
      'content-length': data.length
    });
    response.end(request.method === 'HEAD' ? undefined : data);
  })().catch((error) => {
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
    response.end(error.message);
  });
});

function instrumentBrowserBoundaries(options) {
  if (!/^https?:$/.test(location.protocol)) return;
  const probe = {
    storageAccesses: [], messages: [], registrations: [], clipboardWrites: [],
    promptCalls: 0, promptDefaultPrevented: false
  };
  // Seed an isolated context before installing guards. Reading/writing these
  // browser boundaries from installer code is a regression, even if reversible.
  const local = window.localStorage;
  const session = window.sessionStorage;
  const getItem = Storage.prototype.getItem;
  const setItem = Storage.prototype.setItem;
  setItem.call(local, 'leader-user', '{"id":999999,"name":"Installer isolation sentinel"}');
  setItem.call(local, 'installer-draft-sentinel', 'keep-existing-draft');
  setItem.call(session, 'installer-session-sentinel', 'keep-existing-session');
  for (const [property, storage] of [['localStorage', local], ['sessionStorage', session]]) {
    Object.defineProperty(window, property, {
      configurable: true,
      get() {
        probe.storageAccesses.push(property);
        return storage;
      }
    });
  }
  for (const method of ['getItem', 'setItem', 'removeItem', 'clear', 'key']) {
    const original = Storage.prototype[method];
    Storage.prototype[method] = function (...args) {
      probe.storageAccesses.push(`Storage.${method}`);
      return original.apply(this, args);
    };
  }
  const indexedDBValue = window.indexedDB;
  Object.defineProperty(window, 'indexedDB', {
    configurable: true,
    get() {
      probe.storageAccesses.push('indexedDB');
      return indexedDBValue;
    }
  });
  const cookieDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get() {
      probe.storageAccesses.push('document.cookie read');
      return cookieDescriptor.get.call(document);
    },
    set(value) {
      probe.storageAccesses.push('document.cookie write');
      cookieDescriptor.set.call(document, value);
    }
  });
  const originalCacheDelete = CacheStorage.prototype.delete;
  CacheStorage.prototype.delete = function (...args) {
    probe.storageAccesses.push('CacheStorage.delete');
    return originalCacheDelete.apply(this, args);
  };
  probe.snapshot = () => ({
    storageAccesses: [...probe.storageAccesses], messages: [...probe.messages],
    registrations: [...probe.registrations], clipboardWrites: [...probe.clipboardWrites],
    promptCalls: probe.promptCalls, promptDefaultPrevented: probe.promptDefaultPrevented,
    storedUser: getItem.call(local, 'leader-user'),
    storedDraft: getItem.call(local, 'installer-draft-sentinel'),
    storedSession: getItem.call(session, 'installer-session-sentinel')
  });

  if (options.platform) Object.defineProperty(navigator, 'platform', { configurable: true, value: options.platform });
  if (options.maxTouchPoints != null) Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: options.maxTouchPoints });
  if (options.iosStandalone) Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
  if (options.standalone) {
    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      const result = matchMedia(query);
      if (query.includes('display-mode: standalone')) Object.defineProperty(result, 'matches', { value: true });
      return result;
    };
  }
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      async writeText(value) {
        probe.clipboardWrites.push(value);
        if (options.clipboardFailure) throw new Error('Clipboard unavailable in this browser');
      }
    }
  });

  if (options.serviceWorker === 'absent') {
    Reflect.deleteProperty(Navigator.prototype, 'serviceWorker');
  } else if (options.serviceWorker !== 'real') {
    const registration = new EventTarget();
    const waiting = { state: 'installed', postMessage: (message) => probe.messages.push(message) };
    Object.assign(registration, { scope: `${location.origin}/`, active: { state: 'activated' }, installing: null, waiting: options.waiting ? waiting : null });
    const serviceWorker = new EventTarget();
    Object.assign(serviceWorker, {
      controller: null,
      ready: Promise.resolve(registration),
      async register(url, configuration) {
        probe.registrations.push({ url, configuration });
        if (options.serviceWorker === 'failure') throw new Error('Service worker registration unavailable');
        return registration;
      },
      async getRegistration() { return registration; }
    });
    probe.announceWaitingUpdate = () => {
      const installing = new EventTarget();
      installing.state = 'installing';
      registration.installing = installing;
      registration.dispatchEvent(new Event('updatefound'));
      registration.waiting = waiting;
      installing.state = 'installed';
      installing.dispatchEvent(new Event('statechange'));
    };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker });
  } else {
    const postMessage = ServiceWorker.prototype.postMessage;
    ServiceWorker.prototype.postMessage = function (message, ...args) {
      probe.messages.push(message);
      return postMessage.call(this, message, ...args);
    };
  }

  probe.offerInstall = (behavior = 'pending') => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    let resolveChoice;
    let rejectChoice;
    const choice = new Promise((resolvePromise, rejectPromise) => {
      resolveChoice = resolvePromise;
      rejectChoice = rejectPromise;
    });
    Object.defineProperties(event, {
      userChoice: { value: choice },
      prompt: { value: () => {
        probe.promptCalls += 1;
        if (behavior === 'throws') throw new Error('Install prompt failed');
        if (behavior === 'rejects') return Promise.reject(new Error('Install prompt was rejected'));
        return Promise.resolve();
      } }
    });
    probe.finishInstallChoice = (outcome) => resolveChoice({ outcome, platform: 'web' });
    probe.rejectInstallChoice = () => rejectChoice(new Error('Install choice failed'));
    window.dispatchEvent(event);
    probe.promptDefaultPrevented = event.defaultPrevented;
  };
  window.__installerBrowserProbe = probe;
}

async function createContext(options = {}) {
  const context = await browser.newContext({
    baseURL: origin,
    viewport: options.viewport || { width: 390, height: 844 },
    locale: options.locale || 'en-NZ',
    userAgent: options.userAgent,
    isMobile: options.isMobile ?? false,
    hasTouch: options.hasTouch ?? false,
    serviceWorkers: options.serviceWorker === 'real' ? 'allow' : 'block'
  });
  await context.addCookies([{ name: '__session', value: 'installer-cookie-sentinel', url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await context.addInitScript(instrumentBrowserBoundaries, options);
  const violations = [];
  context.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin || protectedPath.test(url.pathname) || request.method() !== 'GET') {
      violations.push(`${request.method()} ${request.url()}`);
    }
  });
  context.on('page', (page) => page.on('pageerror', (error) => violations.push(`page error: ${error.message}`)));
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || protectedPath.test(url.pathname) || route.request().method() !== 'GET') {
      await route.abort();
    } else {
      await route.continue();
    }
  });
  return { context, violations };
}

async function assertIsolated(page, fixture) {
  const snapshot = await page.evaluate(() => window.__installerBrowserProbe.snapshot());
  assert.deepEqual(fixture.violations, [], 'installer made protected/external requests or raised a page error');
  assert.deepEqual(snapshot.storageAccesses, [], 'installer accessed or changed existing browser storage');
  assert.deepEqual(snapshot.messages, [], 'installer must not send service-worker activation messages');
  assert.equal(snapshot.storedUser, '{"id":999999,"name":"Installer isolation sentinel"}');
  assert.equal(snapshot.storedDraft, 'keep-existing-draft');
  assert.equal(snapshot.storedSession, 'keep-existing-session');
  const cookies = await fixture.context.cookies();
  assert.deepEqual(cookies.map(({ name, value, httpOnly }) => ({ name, value, httpOnly })), [
    { name: '__session', value: 'installer-cookie-sentinel', httpOnly: true }
  ], 'installer changed the existing session cookie');
  if (snapshot.registrations.length) {
    assert.deepEqual(snapshot.registrations, [{ url: '/sw.js', configuration: { scope: '/' } }]);
  }
  return snapshot;
}

async function openInstaller(fixture) {
  const page = await fixture.context.newPage();
  page.setDefaultTimeout(10000);
  const response = await page.goto('/install.html', { waitUntil: 'load' });
  assert.equal(response.status(), 200);
  await page.waitForFunction(() => ['manual', 'installed'].includes(document.body.dataset.installState));
  await page.locator('#openReportFlow').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#openReportFlow').getAttribute('href'), '/index.html');
  assert.equal(await page.locator('#installLink').inputValue(), canonicalInstallUrl);
  return page;
}

async function offerInstall(page, behavior) {
  await page.evaluate((mode) => window.__installerBrowserProbe.offerInstall(mode), behavior || 'pending');
  await page.waitForFunction(() => document.body.dataset.installState === 'ready');
  await page.locator('#installAppButton').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => window.__installerBrowserProbe.promptCalls), 0, 'installation must require a user click');
  assert.equal(await page.evaluate(() => window.__installerBrowserProbe.promptDefaultPrevented), true);
}

async function check(name, action) {
  try {
    await action();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`not ok - ${name}\n${error.stack || error.message}`);
  }
}

async function checkManualEnvironments() {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
  const android = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
  const cases = [
    { name: 'desktop without native event' },
    { name: 'iPhone Safari', userAgent: iphone, platform: 'iPhone', maxTouchPoints: 5, instructions: '#iosInstructions' },
    { name: 'desktop-mode iPad Safari', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5, instructions: '#iosInstructions' },
    { name: 'Android Chrome', userAgent: android, instructions: '#androidInstructions' },
    { name: 'embedded browser', userAgent: `${android} MicroMessenger/8.0.0`, embedded: true },
    { name: 'unsupported service worker', serviceWorker: 'absent' },
    { name: 'failed service worker', serviceWorker: 'failure' },
    { name: 'standalone display', standalone: true, installed: true },
    { name: 'iOS home-screen app', userAgent: iphone, iosStandalone: true, installed: true }
  ];
  for (const options of cases) {
    const fixture = await createContext(options);
    try {
      const page = await openInstaller(fixture);
      assert.equal(await page.locator('#installAppButton').isVisible(), false, options.name);
      assert.equal(await page.locator('#iosInstructions').isVisible(), true, options.name);
      assert.equal(await page.locator('#androidInstructions').isVisible(), true, options.name);
      if (options.instructions) assert.equal(await page.locator(options.instructions).evaluate((details) => details.open), true, options.name);
      assert.equal(await page.locator('#embeddedBrowserHelp').isVisible(), Boolean(options.embedded), options.name);
      if (options.installed) {
        assert.equal(await page.locator('body').getAttribute('data-install-state'), 'installed', options.name);
        await page.evaluate(() => window.__installerBrowserProbe.offerInstall());
        assert.equal(await page.locator('#installAppButton').isVisible(), false, options.name);
      }
      await assertIsolated(page, fixture);
    } finally {
      await fixture.context.close();
    }
  }
}

async function checkPromptLifecycle(outcome) {
  const fixture = await createContext();
  try {
    const page = await openInstaller(fixture);
    await offerInstall(page);
    await page.locator('#installAppButton').click();
    await page.waitForFunction(() => document.body.dataset.installState === 'prompting');
    assert.equal(await page.locator('#installAppButton').isDisabled(), true);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => window.__installerBrowserProbe.promptCalls), 1);
    await page.evaluate((choice) => window.__installerBrowserProbe.finishInstallChoice(choice), outcome);
    await page.waitForFunction((state) => document.body.dataset.installState === state, outcome === 'accepted' ? 'accepted' : 'manual');
    assert.equal(await page.locator('#installAppButton').isVisible(), false, 'a consumed install event cannot be reused');
    assert.ok((await page.locator('#installStatus').innerText()).trim(), 'install outcome must be announced');
    if (outcome === 'accepted') {
      await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
      await page.waitForFunction(() => document.body.dataset.installState === 'installed');
    }
    await assertIsolated(page, fixture);
  } finally {
    await fixture.context.close();
  }
}

async function checkPromptFailure(behavior) {
  const fixture = await createContext();
  try {
    const page = await openInstaller(fixture);
    await offerInstall(page, behavior);
    await page.locator('#installAppButton').click();
    if (behavior === 'choice-rejects') {
      await page.evaluate(() => window.__installerBrowserProbe.rejectInstallChoice());
    }
    await page.waitForFunction(() => document.body.dataset.installState === 'manual');
    assert.equal(await page.locator('#installAppButton').isVisible(), false);
    assert.ok((await page.locator('#installStatus').innerText()).trim(), 'install failure must leave useful feedback');
    assert.equal((await assertIsolated(page, fixture)).promptCalls, 1);
    await page.evaluate(() => window.__installerBrowserProbe.offerInstall());
    await page.locator('#installAppButton').waitFor({ state: 'visible' });
    assert.equal(await page.locator('body').getAttribute('data-install-state'), 'ready', 'a fresh browser event must permit a retry');
  } finally {
    await fixture.context.close();
  }
}

async function checkWaitingWorker() {
  for (const waiting of [true, false]) {
    const fixture = await createContext({ waiting });
    try {
      const page = await openInstaller(fixture);
      if (!waiting) await page.evaluate(() => window.__installerBrowserProbe.announceWaitingUpdate());
      await page.locator('#installUpdateNotice').waitFor({ state: 'visible' });
      await assertIsolated(page, fixture);
    } finally {
      await fixture.context.close();
    }
  }
}

async function checkLanguagesAndCopy() {
  for (const clipboardFailure of [false, true]) {
    const fixture = await createContext({ clipboardFailure, platform: 'iPhone', maxTouchPoints: 5,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' });
    try {
      const page = await openInstaller(fixture);
      await page.locator('#iosInstructions > summary').click();
      assert.equal(await page.locator('#iosInstructions').evaluate((details) => details.open), false);
      await page.locator('[data-language="zh"]').click();
      await page.waitForFunction(() => document.documentElement.lang.startsWith('zh'));
      assert.equal(await page.locator('#iosInstructions').evaluate((details) => details.open), false, 'language changes must preserve manually closed instructions');
      await page.locator('#iosInstructions > summary').click();
      assert.match(await page.locator('#iosInstructions').innerText(), /[\u3400-\u9fff]/);
      await page.locator('#copyInstallLink').click();
      await page.waitForFunction(() => document.querySelector('#copyStatus').textContent.trim().length > 0);
      const snapshot = await assertIsolated(page, fixture);
      assert.deepEqual(snapshot.clipboardWrites, [canonicalInstallUrl]);
      if (clipboardFailure) {
        const selection = await page.locator('#installLink').evaluate((input) => ({
          focused: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd
        }));
        assert.deepEqual(selection, { focused: true, start: 0, end: canonicalInstallUrl.length });
      }
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => document.documentElement.lang.startsWith('en'));
      await assertIsolated(page, fixture);
    } finally {
      await fixture.context.close();
    }
  }
  const fixture = await createContext({ locale: 'zh-CN' });
  try {
    const page = await openInstaller(fixture);
    assert.match(await page.locator('html').getAttribute('lang'), /^zh/);
    await assertIsolated(page, fixture);
  } finally {
    await fixture.context.close();
  }
}

async function checkManifestAndDownloads() {
  const fixture = await createContext();
  try {
    const page = await openInstaller(fixture);
    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
    assert.equal(manifestHref, '/manifest.webmanifest');
    const manifestResponse = await fixture.context.request.get(manifestHref);
    assert.equal(manifestResponse.status(), 200);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.name, 'ReportFlow');
    assert.equal(manifest.short_name, 'ReportFlow');
    assert.equal(manifest.scope, '/');
    assert.equal(manifest.start_url, '/index.html');
    assert.ok(!manifest.id || manifest.id === '/index.html', 'installer must not create a separate installed app identity');
    const downloads = [
      ['#downloadInstallPdf', '/downloads/reportflow-install-a4.pdf', 'application/pdf', '%PDF-'],
      ['#downloadInstallPng', '/downloads/reportflow-install-qr.png', 'image/png', null],
      ['#downloadInstallSvg', '/downloads/reportflow-install-qr.svg', 'image/svg+xml', null]
    ];
    for (const [selector, path, type, signature] of downloads) {
      assert.equal(await page.locator(selector).getAttribute('href'), path);
      const response = await fixture.context.request.get(path);
      assert.equal(response.status(), 200, path);
      assert.ok(response.headers()['content-type'].includes(type), path);
      const bytes = await response.body();
      assert.ok(bytes.length > 100, `${path} must not be an empty placeholder`);
      if (signature) assert.equal(bytes.toString('ascii', 0, signature.length), signature);
      if (type === 'image/png') assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      if (type === 'image/svg+xml') assert.match(bytes.toString('utf8'), /<svg\b/);
    }
    await assertIsolated(page, fixture);
  } finally {
    await fixture.context.close();
  }
}

async function checkResponsiveLayout() {
  const fixture = await createContext();
  const issues = [];
  try {
    const page = await openInstaller(fixture);
    await offerInstall(page);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const language of ['en', 'zh']) {
        await page.locator(`[data-language="${language}"]`).click();
        const layout = await page.evaluate(() => ({
          width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth,
          targets: [...document.querySelectorAll('a, button, input, summary')]
            .filter((element) => element.getClientRects().length)
            .map((element) => {
              const rectangle = element.getBoundingClientRect();
              return { id: element.id || element.textContent.trim().slice(0, 70),
                width: rectangle.width, height: rectangle.height, left: rectangle.left, right: rectangle.right };
            })
        }));
        if (screenshotDirectory) {
          const path = join(screenshotDirectory, `install-${width}-${language}.png`);
          await page.screenshot({ path, fullPage: true, animations: 'disabled' });
          console.log(`  screenshot: ${path}`);
        }
        if (layout.scrollWidth > layout.width + 1) issues.push(`${width}/${language} document overflow: ${JSON.stringify(layout)}`);
        for (const target of layout.targets) {
          if (target.width + 0.01 < 44 || target.height + 0.01 < 44
            || target.left < -1 || target.right > layout.width + 1) {
            issues.push(`${width}/${language} control must fit and be at least 44px: ${JSON.stringify(target)}`);
          }
        }
      }
    }
    await assertIsolated(page, fixture);
    assert.equal(issues.length, 0, issues.join('\n'));
  } finally {
    await fixture.context.close();
  }
}

async function checkColdOfflineInstaller() {
  const fixture = await createContext({ serviceWorker: 'real' });
  try {
    const page = await openInstaller(fixture);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 20000 });
    const registration = await page.evaluate(async () => {
      const result = await navigator.serviceWorker.getRegistration('/');
      return { scope: result.scope, script: result.active.scriptURL };
    });
    assert.deepEqual(registration, { scope: `${origin}/`, script: `${origin}/sw.js` });
    const beforeReload = requests.filter((request) => request.pathname === '/install.html').length;
    await page.reload({ waitUntil: 'load' });
    assert.ok(requests.filter((request) => request.pathname === '/install.html').length > beforeReload, 'online installer navigation must prefer the network');
    await assertIsolated(page, fixture);
    await page.close();
    assert.equal(fixture.context.pages().length, 0, 'cold-launch check must close every app page');
    await fixture.context.setOffline(true);
    const coldPage = await fixture.context.newPage();
    const response = await coldPage.goto('/install.html', { waitUntil: 'load', timeout: 20000 });
    assert.equal(response.status(), 200);
    assert.equal(response.fromServiceWorker(), true);
    assert.equal(await response.text(), await readFile(join(buildRoot, 'install.html'), 'utf8'), 'offline navigation must serve the exact installer, not the app shell');
    await coldPage.locator('#openReportFlow').waitFor({ state: 'visible' });
    await coldPage.locator('#languageControls').waitFor({ state: 'visible' });
    await coldPage.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0));
    assert.equal(await coldPage.locator('link[rel="stylesheet"]').evaluate((link) => Boolean(link.sheet)), true, 'installer CSS must load offline');
    assert.equal(await coldPage.locator('#loginForm').count(), 0);
    assert.equal(await coldPage.locator('#installLink').inputValue(), canonicalInstallUrl);
    await assertIsolated(coldPage, fixture);
    const unknownPage = await fixture.context.newPage();
    await assert.rejects(unknownPage.goto('/install-not-a-route.html', { waitUntil: 'domcontentloaded', timeout: 10000 }), 'unrelated offline paths must not receive the installer fallback');
    await unknownPage.close();
  } finally {
    await fixture.context.close();
  }
}

try {
  for (const file of ['install.html', 'assets/css/install.css', 'assets/js/install.js', 'sw.js', 'manifest.webmanifest']) {
    try {
      await readFile(join(buildRoot, file));
    } catch {
      throw new Error(`Installer build is missing dist/${file}. Build the app before running this check.`);
    }
  }
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  const screenshotRoot = String(process.env.INSTALL_PAGE_SCREENSHOT_DIR || '').trim();
  if (screenshotRoot) {
    mkdirSync(resolve(screenshotRoot), { recursive: true });
    screenshotDirectory = mkdtempSync(join(resolve(screenshotRoot), 'install-'));
  }
  browser = await chromium.launch();
  await check('manual, Safari/iPad, embedded, standalone, and unavailable-SW fallbacks remain usable', checkManualEnvironments);
  await check('native prompt is click-only, single-flight, and consumed after dismissal', () => checkPromptLifecycle('dismissed'));
  await check('accepted prompt waits for appinstalled confirmation', () => checkPromptLifecycle('accepted'));
  await check('failed prompt is recoverable without reusing the event', () => checkPromptFailure('throws'));
  await check('rejected prompt is recoverable without reusing the event', () => checkPromptFailure('rejects'));
  await check('rejected install choice is recoverable without reusing the event', () => checkPromptFailure('choice-rejects'));
  await check('waiting updates are informational and never forced', checkWaitingWorker);
  await check('language and clipboard fallback work without persisting or touching app data', checkLanguagesAndCopy);
  await check('installer shares ReportFlow identity and exposes real permanent-link downloads', checkManifestAndDownloads);
  await check('installer controls fit 320, 390, and 1280px in both languages', checkResponsiveLayout);
  await check('real service worker cold-launches the exact offline installer after all pages close', checkColdOfflineInstaller);
  assert.deepEqual(requests.filter((request) => protectedPath.test(request.pathname) || !['GET', 'HEAD'].includes(request.method)), [], 'local installer server received a protected or mutating request');
  if (failures.length) throw new Error(`${failures.length} installer check(s) failed.`);
  console.log('\n11 installer checks passed; no backend, cloud, or account mutations.');
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.closeAllConnections();
  if (server.listening) await new Promise((done) => server.close(done));
}
