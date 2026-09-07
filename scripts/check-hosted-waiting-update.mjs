import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Read-only, anonymous probe. Start BEFORE Hosting promotion and wait for "armed".
// node scripts/check-hosted-waiting-update.mjs https://LIVE_HOST docs/evidence/NEW.json
// Keeps the old client alive for up to 15 minutes, checking every 10 seconds.
// Expected new bytes are frozen from local dist/ at startup. No login or cloud writes.
const scriptPath = fileURLToPath(import.meta.url);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

function check(condition, code) {
  if (!condition) {
    const error = new Error(code);
    error.safeCode = code;
    throw error;
  }
}

function cacheVersion(bytes) {
  const match = bytes.toString().match(/const CACHE_VERSION = ["']([^"']+)["'];/);
  check(match, 'service_worker_cache_version_missing');
  return match[1];
}

async function remoteBytes(origin, path) {
  const response = await fetch(new URL(path, origin), {
    cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000)
  });
  check(response.status === 200, 'public_artifact_fetch_failed');
  return Buffer.from(await response.arrayBuffer());
}

async function until(test, code, timeout = 45000, interval = 250) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await test();
    if (value) return value;
    await delay(interval);
  }
  check(false, code);
}

async function registrationState(page) {
  return await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration('/');
    return {
      scope: registration?.scope || '', active: registration?.active?.state || '',
      activeUrl: registration?.active?.scriptURL || '', waiting: registration?.waiting?.state || '',
      controller: navigator.serviceWorker.controller?.scriptURL || '',
      oldControllerStillControls: navigator.serviceWorker.controller === window.__hostedUpdateOldController,
      cacheNames: await caches.keys()
    };
  });
}

async function cachedShell(page, version) {
  return await page.evaluate(async (version) => {
    if (!(await caches.keys()).includes(version)) return null;
    const cache = await caches.open(version);
    const index = await cache.match('/index.html', { ignoreVary: true });
    if (!index) return null;
    const bytes = await index.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const paths = (await cache.keys()).map((request) => new URL(request.url).pathname);
    return {
      indexSha256: [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
      paths,
      sensitivePaths: paths.filter((path) => /^\/(api|auth|uploads|photo-uploads|supervisor|work-forms|form-submissions)(\/|$)/.test(path))
    };
  }, version);
}

export async function runWaitingUpdateProbe({
  origin, evidencePath, expectedSw, expectedIndex, timeoutMs = 900000, intervalMs = 10000,
  allowLocalhostHttp = false, onArmed = () => {}
}) {
  const url = new URL(origin);
  check(url.protocol === 'https:' || (allowLocalhostHttp && url.protocol === 'http:'
    && url.hostname === '127.0.0.1'), 'https_origin_required');
  check(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'plain_origin_required');
  const targetOrigin = url.origin;
  check(!existsSync(evidencePath), 'evidence_file_already_exists');
  const screenshotBase = evidencePath.replace(/\.json$/i, '');
  const screenshotPaths = ['waiting', 'updated', 'offline'].map((name) => `${screenshotBase}-${name}.png`);
  check(screenshotPaths.every((path) => !existsSync(path)), 'screenshot_file_already_exists');
  const expected = { swSha256: digest(expectedSw), indexSha256: digest(expectedIndex), cacheVersion: cacheVersion(expectedSw) };
  const evidence = {
    schemaVersion: 1, origin: targetOrigin, status: 'running', startedAtUtc: new Date().toISOString(),
    scope: 'Anonymous read-only Chromium waiting-SW update; not a physical-phone test',
    expected, viewport: { width: 390, height: 844 }, checks: [],
    scriptSha256: digest(readFileSync(scriptPath))
  };
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  const save = () => writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  const passed = (label) => { evidence.checks.push(label); save(); console.log(`ok - ${label}`); };
  let stage = 'verify_old_live_bytes';
  let browser;
  const pageErrors = [];
  const blockedWrites = [];
  try {
    const oldSw = await remoteBytes(targetOrigin, '/sw.js');
    const oldIndex = await remoteBytes(targetOrigin, '/index.html');
    evidence.original = { swSha256: digest(oldSw), indexSha256: digest(oldIndex), cacheVersion: cacheVersion(oldSw) };
    check(evidence.original.swSha256 !== expected.swSha256
      && evidence.original.cacheVersion !== expected.cacheVersion, 'new_release_already_live_cannot_arm_update_probe');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: evidence.viewport, isMobile: true, hasTouch: true, locale: 'en-NZ' });
    context.setDefaultTimeout(45000);
    context.on('page', (page) => page.on('pageerror', () => pageErrors.push('page_error')));
    await context.route('**/*', (route) => {
      const request = route.request();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        blockedWrites.push({ method: request.method(), path: new URL(request.url()).pathname });
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    const oldNavigation = await page.goto(targetOrigin, { waitUntil: 'domcontentloaded' });
    check(oldNavigation?.ok() && digest(await oldNavigation.body()) === evidence.original.indexSha256,
      'old_live_page_bytes_changed_before_arm');
    await page.waitForFunction(() => document.body.dataset.activeView === 'login');
    stage = 'old_service_worker_control';
    await until(async () => (await registrationState(page)).active === 'activated', 'old_worker_install_timeout');
    if (!(await registrationState(page)).controller) await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    await page.evaluate(() => { window.__hostedUpdateOldController = navigator.serviceWorker.controller; });
    const originalRegistration = await registrationState(page);
    const originalCache = await cachedShell(page, evidence.original.cacheVersion);
    check(originalRegistration.activeUrl === `${targetOrigin}/sw.js`
      && originalRegistration.scope === `${targetOrigin}/` && !originalRegistration.waiting
      && originalRegistration.oldControllerStillControls
      && originalCache?.indexSha256 === evidence.original.indexSha256,
    'old_controller_or_cached_shell_not_verified');
    check(digest(await remoteBytes(targetOrigin, '/sw.js')) === evidence.original.swSha256,
      'live_worker_changed_before_arm');
    evidence.original.registration = originalRegistration;
    evidence.original.cachedIndexSha256 = originalCache.indexSha256;
    passed('old_live_bytes_controller_and_cached_shell_verified');
    evidence.status = 'armed';
    evidence.armedAtUtc = new Date().toISOString();
    save();
    console.log(`armed ${JSON.stringify({ origin: targetOrigin, oldCache: evidence.original.cacheVersion,
      expectedCache: expected.cacheVersion, evidencePath })}`);
    await onArmed();

    stage = 'waiting_for_frontend_promotion';
    const deadline = Date.now() + timeoutMs;
    let waitingState;
    while (Date.now() < deadline) {
      const liveSw = await remoteBytes(targetOrigin, '/sw.js');
      const liveHash = digest(liveSw);
      check([evidence.original.swSha256, expected.swSha256].includes(liveHash), 'unexpected_live_service_worker_revision');
      await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration('/');
        if (!registration) throw new Error('registration_missing');
        let timer;
        try {
          await Promise.race([registration.update(), new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('update_check_timeout')), 30000);
          })]);
        } finally {
          clearTimeout(timer);
        }
      });
      waitingState = await registrationState(page);
      check(waitingState.oldControllerStillControls, 'old_worker_replaced_before_user_update');
      if (liveHash === expected.swSha256 && waitingState.waiting === 'installed') {
        const installedCache = await cachedShell(page, expected.cacheVersion);
        if (installedCache?.indexSha256 === expected.indexSha256) {
          evidence.waiting = { registration: waitingState, cachedIndexSha256: installedCache.indexSha256,
            servedSwSha256: liveHash, observedAtUtc: new Date().toISOString() };
          break;
        }
      }
      await delay(intervalMs);
    }
    check(evidence.waiting, 'expected_waiting_update_not_observed_within_15_minutes');
    stage = 'visible_update_action';
    const updateButton = page.locator('#updateButton');
    await updateButton.waitFor({ state: 'visible' });
    check(/^Update App$/i.test((await updateButton.innerText()).trim()), 'update_app_action_label_mismatch');
    await page.screenshot({ path: screenshotPaths[0], fullPage: true });
    passed('expected_new_worker_waits_while_old_client_controls_and_update_action_is_visible');
    stage = 'user_updates_and_new_shell_reloads';
    const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    await updateButton.click();
    const newNavigation = await navigation;
    check(newNavigation?.ok() && digest(await newNavigation.body()) === expected.indexSha256,
      'updated_navigation_does_not_match_expected_index');
    await page.waitForFunction(() => document.body.dataset.activeView === 'login'
      && document.body.classList.contains('report-only-mode'));
    const activeState = await until(async () => {
      const state = await registrationState(page);
      return state.active === 'activated' && !state.waiting && state.cacheNames.includes(expected.cacheVersion)
        && !state.cacheNames.includes(evidence.original.cacheVersion) ? state : false;
    }, 'new_worker_activation_or_old_cache_cleanup_failed');
    const newCache = await cachedShell(page, expected.cacheVersion);
    check(newCache?.indexSha256 === expected.indexSha256 && newCache.sensitivePaths.length === 0,
      'new_cache_contains_wrong_shell_or_private_paths');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'updated_phone_overflow');
    evidence.updated = { registration: activeState, cachedIndexSha256: newCache.indexSha256,
      reportOnly: true, sensitiveCacheEntries: newCache.sensitivePaths.length };
    await page.screenshot({ path: screenshotPaths[1], fullPage: true });
    passed('update_action_activates_expected_worker_and_reloads_report_only_shell');
    stage = 'new_shell_cold_offline_launch';
    await page.close();
    check(context.pages().length === 0, 'old_page_not_closed_before_cold_offline_launch');
    await context.setOffline(true);
    const offline = await context.newPage();
    const offlineResponse = await offline.goto(targetOrigin, { waitUntil: 'domcontentloaded' });
    check(offlineResponse?.fromServiceWorker() && digest(await offlineResponse.body()) === expected.indexSha256,
      'cold_offline_navigation_not_served_by_expected_cached_shell');
    await offline.waitForFunction(() => !navigator.onLine && Boolean(navigator.serviceWorker.controller)
      && document.body.dataset.activeView === 'login' && document.body.classList.contains('report-only-mode'));
    check(await offline.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'offline_phone_overflow');
    const offlineCache = await cachedShell(offline, expected.cacheVersion);
    check(offlineCache?.sensitivePaths.length === 0, 'private_paths_found_after_offline_launch');
    check(pageErrors.length === 0 && blockedWrites.length === 0, 'page_error_or_unexpected_mutation_attempt');
    await offline.screenshot({ path: screenshotPaths[2], fullPage: true });
    evidence.coldOffline = { allPriorPagesClosed: true, responseFromServiceWorker: true,
      cachedIndexSha256: offlineCache.indexSha256, reportOnly: true, physicalPhoneTest: false };
    passed('new_report_only_shell_cold_launches_offline_after_last_client_closed');
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.failure = { stage, code: error.safeCode || 'browser_or_read_only_request_failed' };
    console.error(`Waiting-update probe failed: ${stage} (${evidence.failure.code})`);
  } finally {
    if (browser) await browser.close();
    evidence.completedAtUtc = new Date().toISOString();
    evidence.pageErrors = pageErrors.length;
    evidence.blockedWriteAttempts = blockedWrites;
    save();
  }
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    check(process.argv.length === 4, 'origin_and_new_evidence_path_required');
    const repoRoot = resolve(dirname(scriptPath), '..');
    const evidence = await runWaitingUpdateProbe({ origin: process.argv[2], evidencePath: resolve(process.argv[3]),
      expectedSw: readFileSync(resolve(repoRoot, 'dist/sw.js')), expectedIndex: readFileSync(resolve(repoRoot, 'dist/index.html')) });
    if (evidence.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    console.error(`Waiting-update probe refused: ${error.safeCode || 'invalid_configuration_or_evidence_path'}`);
    process.exitCode = 1;
  }
}
