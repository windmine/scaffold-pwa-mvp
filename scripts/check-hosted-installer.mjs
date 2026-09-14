import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, ftruncateSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

// Anonymous, read-only installer verification. Does not log in, click Install,
// approve a browser prompt, activate a waiting worker, or change cloud resources.
// node scripts/check-hosted-installer.mjs https://HOST NEW-EVIDENCE.json [--screenshots]
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), '..');
const canonicalInstallUrl = 'https://geo-attendance-system-db9ca.web.app/install.html';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const protectedPath = /^\/(?:api|auth|uploads|photo-uploads|supervisor|attendance|my-records|task-logs|team-work-logs|work-forms|form-submissions|sites|dev|health)(?:\/|$)/;
const artifactContract = [
  ['/install.html', ['text/html']],
  ['/assets/css/install.css', ['text/css']],
  ['/assets/js/install.js', ['text/javascript', 'application/javascript']],
  ['/assets/icons/reportflow-install-qr.svg', ['image/svg+xml']],
  ['/downloads/reportflow-install-qr.svg', ['image/svg+xml']],
  ['/downloads/reportflow-install-qr.png', ['image/png']],
  ['/downloads/reportflow-install-a4.pdf', ['application/pdf']]
];

function configuration(args) {
  assert.ok(args.length === 2 || (args.length === 3 && args[2] === '--screenshots'),
    'Usage: node scripts/check-hosted-installer.mjs https://HOST NEW-EVIDENCE.json [--screenshots]');
  let url;
  try { url = new URL(args[0]); } catch { throw new Error('A plain HTTPS origin is required'); }
  assert.equal(url.protocol, 'https:', 'HTTPS is required');
  assert.ok(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Use a plain HTTPS origin without credentials, path, query, or fragment');
  const evidencePath = resolve(args[1]);
  assert.match(evidencePath, /\.json$/i, 'Evidence path must end in .json');
  assert.equal(existsSync(evidencePath), false, 'Evidence file already exists; choose a new path');
  const screenshotPaths = Object.fromEntries(['english', 'chinese', 'offline'].map((label) => (
    [label, evidencePath.replace(/\.json$/i, `-${label}.png`)]
  )));
  if (args[2] === '--screenshots') {
    for (const path of Object.values(screenshotPaths)) assert.equal(existsSync(path), false, 'A derived screenshot already exists; choose a new evidence basename');
  }
  return { origin: url.origin, evidencePath, screenshots: args[2] === '--screenshots', screenshotPaths };
}

function guardBrowserActions() {
  if (!/^https?:$/.test(location.protocol)) return;
  const actions = { nativePrompts: 0, workerMessages: [] };
  // Observation only until an unsafe action is attempted. No app storage or
  // identity is read, seeded, imported, or changed by this hosted probe.
  if (window.BeforeInstallPromptEvent?.prototype?.prompt) {
    BeforeInstallPromptEvent.prototype.prompt = function () {
      actions.nativePrompts += 1;
      return Promise.reject(new Error('Native installation is not authorized by this verifier'));
    };
  }
  if (window.ServiceWorker?.prototype?.postMessage) {
    ServiceWorker.prototype.postMessage = function (message) {
      actions.workerMessages.push(String(message?.type || 'unknown'));
      throw new Error('Service-worker messages are not authorized by this verifier');
    };
  }
  window.__hostedInstallerActions = actions;
}

export async function verifyHostedInstaller(config) {
  config = configuration([config.origin, config.evidencePath, ...(config.screenshots ? ['--screenshots'] : [])]);
  const expected = artifactContract.map(([path, mimeTypes]) => {
    const bytes = readFileSync(join(repoRoot, 'dist', path.slice(1)));
    return { path, mimeTypes, bytes, sha256: sha256(bytes) };
  });
  const expectedInstaller = expected.find((artifact) => artifact.path === '/install.html');
  const evidence = {
    schemaVersion: 1,
    origin: config.origin,
    status: 'running',
    startedAtUtc: new Date().toISOString(),
    scope: 'Anonymous read-only hosted installer parity, language/layout, shared service worker, and cold-offline launch; not a physical-phone test',
    scriptSha256: sha256(readFileSync(scriptPath)),
    viewport: { width: 390, height: 844 },
    canonicalInstallUrl,
    assets: [], checks: [], rendered: {}, screenshots: [], pwa: {},
    isolation: { blockedRequests: [], pageErrors: [], nativePrompts: 0, workerMessages: [] }
  };
  // Reserve a new evidence file atomically. Updates below target only this owned
  // descriptor; existing evidence and screenshot files are never overwritten.
  const evidenceFile = openSync(config.evidencePath, 'wx', 0o600);
  const save = () => {
    const json = `${JSON.stringify(evidence, null, 2)}\n`;
    writeSync(evidenceFile, json, 0, 'utf8');
    ftruncateSync(evidenceFile, Buffer.byteLength(json));
  };
  const passed = (name) => {
    evidence.checks.push(name);
    save();
    console.log(`ok - ${name}`);
  };
  let browser;
  let stage = 'asset_parity';
  save();
  try {
    for (const artifact of expected) {
      const response = await fetch(new URL(artifact.path, config.origin), {
        method: 'GET', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000)
      });
      assert.equal(response.status, 200, `Missing installer artifact: ${artifact.path}`);
      const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      assert.ok(artifact.mimeTypes.includes(mime), `Incorrect MIME for ${artifact.path}: ${mime}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(sha256(bytes), artifact.sha256, `Local/deployed bytes differ: ${artifact.path}`);
      const cacheControl = response.headers.get('cache-control') || '';
      if (artifact.path === '/install.html') assert.match(cacheControl, /(?:^|,)\s*no-cache(?:\s*(?:,|$))/i, 'Installer HTML must require cache revalidation');
      evidence.assets.push({ path: artifact.path, status: response.status, mime,
        sha256: artifact.sha256, bytes: bytes.length, cacheControl });
      save();
    }
    passed('seven installer artifacts match frozen local SHA-256 and MIME, including PDF and no-cache HTML');

    stage = 'anonymous_browser';
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: evidence.viewport, isMobile: true, hasTouch: true, locale: 'en-NZ', serviceWorkers: 'allow' });
    context.setDefaultTimeout(20000);
    context.setDefaultNavigationTimeout(45000);
    await context.addInitScript(guardBrowserActions);
    const blocked = new Set();
    const requestViolation = (request) => {
      const url = new URL(request.url());
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { return 'invalid_path'; }
      if (url.origin !== config.origin) return 'external_origin';
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return 'mutating_method';
      if (protectedPath.test(pathname)) return 'protected_path';
      return '';
    };
    const recordViolation = (request, reason) => {
      const url = new URL(request.url());
      const entry = { method: request.method(), origin: url.origin, path: url.pathname, reason };
      const key = JSON.stringify(entry);
      if (!blocked.has(key)) {
        blocked.add(key);
        evidence.isolation.blockedRequests.push(entry);
      }
    };
    context.on('request', (request) => {
      const reason = requestViolation(request);
      if (reason) recordViolation(request, reason);
    });
    await context.route('**/*', async (route) => {
      const reason = requestViolation(route.request());
      if (reason) {
        recordViolation(route.request(), reason);
        await route.abort();
      } else {
        await route.continue();
      }
    });
    context.on('page', (page) => {
      page.on('pageerror', (error) => evidence.isolation.pageErrors.push({ name: error.name, message: error.message.slice(0, 500) }));
      page.on('dialog', async (dialog) => {
        evidence.isolation.pageErrors.push({ name: 'unexpected_dialog', message: dialog.type() });
        await dialog.dismiss();
      });
    });
    const assertReadOnly = async (page) => {
      const actions = await page.evaluate(() => window.__hostedInstallerActions);
      assert.ok(actions && Array.isArray(actions.workerMessages), 'Read-only browser action guard did not initialize');
      evidence.isolation.nativePrompts += actions?.nativePrompts || 0;
      evidence.isolation.workerMessages.push(...(actions?.workerMessages || []));
      assert.deepEqual(evidence.isolation.blockedRequests, [], 'Installer attempted protected, external, or mutating requests');
      assert.deepEqual(evidence.isolation.pageErrors, [], 'Installer raised browser page errors');
      assert.equal(evidence.isolation.nativePrompts, 0, 'Native installation must not be invoked');
      assert.deepEqual(evidence.isolation.workerMessages, [], 'Installer must not force service-worker activation');
      assert.equal((await context.cookies()).length, 0, 'The anonymous installer unexpectedly created cookies');
    };
    const capture = async (page, label) => {
      if (!config.screenshots) return;
      const bytes = await page.screenshot({ fullPage: true, animations: 'disabled' });
      const path = config.screenshotPaths[label];
      writeFileSync(path, bytes, { flag: 'wx' });
      evidence.screenshots.push({ label, path, bytes: bytes.length, sha256: sha256(bytes) });
    };
    const inspect = async (page, language, label) => {
      await page.waitForFunction((expectedLanguage) => document.documentElement.lang.startsWith(expectedLanguage), language);
      await page.locator('#languageControls').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.images.length >= 2
        && [...document.images].every((image) => image.complete && image.naturalWidth > 0));
      const rendered = await page.evaluate(() => ({
        title: document.title,
        heading: document.querySelector('#installHeading')?.textContent.trim(),
        language: document.documentElement.lang,
        openLink: document.querySelector('#openReportFlow')?.href,
        installLink: document.querySelector('#installLink')?.value,
        manifestUrl: document.querySelector('link[rel="manifest"]')?.href,
        width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        instructions: document.querySelector('#iosInstructions')?.textContent.trim(),
        images: [...document.images].map((image) => ({ src: image.getAttribute('src'), naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight })),
        installerScriptReady: !document.querySelector('#languageControls')?.hidden,
        stylesheetReady: Boolean(document.querySelector('link[rel="stylesheet"]')?.sheet)
      }));
      const title = language === 'zh' ? '安装 ReportFlow' : 'Install ReportFlow';
      assert.equal(rendered.title, title);
      assert.equal(rendered.heading, title);
      assert.equal(rendered.openLink, `${config.origin}/index.html`);
      assert.equal(rendered.installLink, canonicalInstallUrl);
      assert.equal(rendered.manifestUrl, `${config.origin}/manifest.webmanifest`);
      assert.ok(rendered.scrollWidth <= rendered.width + 1, 'Installer has horizontal overflow');
      assert.ok(rendered.installerScriptReady && rendered.stylesheetReady, 'Installer script or stylesheet did not load');
      assert.ok(rendered.images.some((image) => image.src === '/assets/icons/reportflow-icon.svg'));
      assert.ok(rendered.images.some((image) => image.src === '/assets/icons/reportflow-install-qr.svg'));
      if (language === 'zh') assert.match(rendered.instructions, /[\u3400-\u9fff]/);
      else assert.match(rendered.instructions, /Add to Home Screen/);
      evidence.rendered[label] = rendered;
      await assertReadOnly(page);
      await capture(page, label);
    };

    const page = await context.newPage();
    const navigation = await page.goto(`${config.origin}/install.html`, { waitUntil: 'load' });
    assert.equal(navigation.status(), 200);
    assert.equal(sha256(await navigation.body()), expectedInstaller.sha256, 'Rendered installer differs from frozen local build');
    assert.equal(page.url(), `${config.origin}/install.html`);
    await inspect(page, 'en', 'english');
    const manifest = await page.evaluate(async () => {
      const response = await fetch(document.querySelector('link[rel="manifest"]').href, { cache: 'no-store' });
      if (!response.ok) throw new Error('Manifest fetch failed');
      return response.json();
    });
    assert.equal(manifest.name, 'ReportFlow');
    assert.equal(manifest.short_name, 'ReportFlow');
    assert.equal(manifest.start_url, '/index.html');
    assert.equal(manifest.scope, '/');
    assert.ok(!manifest.id || manifest.id === '/index.html', 'Installer must share the existing app identity');
    evidence.manifest = { name: manifest.name, shortName: manifest.short_name, startUrl: manifest.start_url, scope: manifest.scope, id: manifest.id || null };
    await page.locator('[data-language="zh"]').click();
    await inspect(page, 'zh', 'chinese');
    passed('anonymous English and Chinese installer, shared manifest identity, images, and phone layout verified');

    stage = 'shared_worker_control';
    await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration('/'))?.active), null, { timeout: 45000 });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 45000 });
    evidence.pwa.registration = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration('/');
      return { scope: registration.scope, activeUrl: registration.active.scriptURL,
        controllerUrl: navigator.serviceWorker.controller.scriptURL, waiting: registration.waiting?.state || '' };
    });
    assert.equal(evidence.pwa.registration.scope, `${config.origin}/`);
    assert.equal(evidence.pwa.registration.activeUrl, `${config.origin}/sw.js`);
    assert.equal(evidence.pwa.registration.controllerUrl, `${config.origin}/sw.js`);
    await assertReadOnly(page);
    assert.equal(context.pages().length, 1, 'Installer unexpectedly opened additional pages');
    await page.close();
    assert.equal(context.pages().length, 0);
    evidence.pwa.closedEveryPageBeforeOffline = true;
    await context.setOffline(true);

    stage = 'cold_offline_installer';
    const coldPage = await context.newPage();
    const coldNavigation = await coldPage.goto(`${config.origin}/install.html`, { waitUntil: 'load' });
    assert.equal(coldNavigation.status(), 200);
    assert.equal(coldNavigation.fromServiceWorker(), true);
    const offlineSha256 = sha256(await coldNavigation.body());
    assert.equal(offlineSha256, expectedInstaller.sha256, 'Cold offline page is not the exact cached installer');
    await inspect(coldPage, 'en', 'offline');
    assert.equal(await coldPage.locator('#loginForm').count(), 0, 'Cold offline installer was replaced by the app login shell');
    evidence.pwa.offline = { status: coldNavigation.status(), fromServiceWorker: true, installerSha256: offlineSha256, logoAndQrLoaded: true };
    evidence.pwa.physicalPhoneTest = false;
    passed('shared service worker serves the exact installer and cached logo/QR after every prior page closes');
    await context.close();
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.failure = { stage, message: String(error.message).slice(0, 1500) };
    console.error(`Hosted installer failed at ${stage}: ${evidence.failure.message}`);
  } finally {
    await browser?.close();
    evidence.completedAtUtc = new Date().toISOString();
    save();
    closeSync(evidenceFile);
  }
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const evidence = await verifyHostedInstaller(configuration(process.argv.slice(2)));
    if (evidence.status !== 'passed') process.exitCode = 1;
    else console.log(`\nHosted installer checks passed; evidence: ${process.argv[3]}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
