import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { chromium } from 'playwright';

const root = process.cwd();
const backendDir = join(root, 'backend');
const tempDir = mkdtempSync(join(tmpdir(), 'scaffold-pwa-browser-workflows-'));
const backendPort = Number(process.env.BROWSER_WORKFLOW_BACKEND_PORT || 8765);
const frontendPort = Number(process.env.BROWSER_WORKFLOW_FRONTEND_PORT || 5175);
const backendBase = `http://127.0.0.1:${backendPort}`;
const appBase = `http://127.0.0.1:${frontendPort}`;
const password = 'Passw0rd!';
const workflowFilter = String(process.env.BROWSER_WORKFLOW_ONLY || '').trim().toLowerCase();

const children = [];
const checks = [];

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function sqliteUrl(filePath) {
  return `sqlite:///${filePath.replace(/\\/g, '/')}`;
}

function startProcess(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd || root,
    env: options.env || process.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const processState = {
    name,
    child,
    output: ''
  };

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    processState.output += text;
    if (process.env.BROWSER_WORKFLOW_DEBUG) process.stdout.write(`[${name}] ${text}`);
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    processState.output += text;
    if (process.env.BROWSER_WORKFLOW_DEBUG) process.stderr.write(`[${name}] ${text}`);
  });

  children.push(processState);
  return processState;
}

async function stopProcess(processState) {
  const { child } = processState;
  if (!child.pid || child.exitCode != null || child.killed) return;

  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore'
      });
      killer.on('close', resolve);
      killer.on('error', resolve);
    });
    if (child.exitCode == null) {
      await Promise.race([
        new Promise((resolve) => child.once('close', resolve)),
        delay(3000)
      ]);
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
    return;
  }

  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(2500).then(() => {
      if (child.exitCode == null) child.kill('SIGKILL');
    })
  ]);
}

async function waitForHttp(url, options = {}) {
  const timeoutMs = options.timeoutMs || 45000;
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, {
        method: options.method || 'GET'
      });
      if (response.ok || options.acceptStatus?.includes(response.status)) {
        return response;
      }
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await delay(350);
  }

  throw new Error(`Timed out waiting for ${url}${lastError ? ` (${lastError.message})` : ''}`);
}

async function setupServers() {
  const dbPath = join(tempDir, 'geo-browser-workflows.db');
  const uploadDir = join(tempDir, 'uploads');

  startProcess('backend', 'python', [
    '-m',
    'uvicorn',
    'app.main:app',
    '--host',
    '127.0.0.1',
    '--port',
    String(backendPort)
  ], {
    cwd: backendDir,
    env: {
      ...process.env,
      APP_ENV: 'development',
      AUTO_MIGRATE: 'true',
      ENABLE_DEV_SEED: 'true',
      GEO_SECRET_KEY: 'browser-workflow-local-secret',
      DATABASE_URL: sqliteUrl(dbPath),
      UPLOAD_DIR: uploadDir
    }
  });

  await waitForHttp(`${backendBase}/health`);
  const seedResponse = await fetch(`${backendBase}/dev/seed`, { method: 'POST' });
  if (!seedResponse.ok) {
    throw new Error(`Demo seed failed: ${seedResponse.status} ${await seedResponse.text()}`);
  }

  startProcess('frontend', process.execPath, [
    join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
    '--host',
    '127.0.0.1',
    '--port',
    String(frontendPort),
    '--strictPort'
  ], {
    cwd: root,
    env: {
      ...process.env,
      VITE_DISABLE_HTTPS: 'true',
      VITE_API_PROXY_TARGET: backendBase
    }
  });

  await waitForHttp(appBase);
}

async function newContext(browser, options = {}) {
  const context = await browser.newContext({
    baseURL: appBase,
    viewport: options.viewport || { width: 390, height: 844 },
    isMobile: options.isMobile ?? true,
    hasTouch: options.hasTouch ?? true,
    geolocation: options.geolocation,
    permissions: options.permissions || [],
    serviceWorkers: options.serviceWorkers || 'block'
  });

  if (options.initScript) {
    await context.addInitScript(options.initScript);
  }

  return context;
}

function viewSelector(view) {
  if (view === 'worker') return '#workerView';
  if (view === 'supervisor') return '#supervisorView';
  return '#loginView';
}

async function loginAs(page, email, expectedView) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const syncState = document.querySelector('#syncIndicator')?.dataset.state || '';
    return document.body.dataset.activeView === 'login' && syncState !== 'checking';
  });
  await page.locator('#emailInput').fill(email);
  await page.locator('#passwordInput').fill(password);
  await page.locator('#loginForm button[type="submit"]').click();
  try {
    await page.waitForFunction((view) => document.body.dataset.activeView === view, expectedView, { timeout: 20000 });
  } catch (error) {
    const debug = await page.evaluate(() => ({
      activeView: document.body.dataset.activeView || '',
      status: document.querySelector('#statusBanner')?.textContent
        || document.querySelector('#toastViewport .toast:last-child')?.textContent
        || document.querySelector('[data-local-feedback]:not(.hidden)')?.textContent
        || '',
      emailValue: document.querySelector('#emailInput')?.value || '',
      loginViewClass: document.querySelector('#loginView')?.className || '',
      workerViewClass: document.querySelector('#workerView')?.className || '',
      supervisorViewClass: document.querySelector('#supervisorView')?.className || '',
      url: window.location.href
    }));
    throw new Error(`Login did not open ${expectedView} view: ${JSON.stringify(debug)}`, {
      cause: error
    });
  }
  await page.locator(viewSelector(expectedView)).waitFor({ state: 'visible', timeout: 20000 });
}

async function logout(page) {
  await page.locator('#logoutButton').click();
  await page.waitForFunction(() => document.body.dataset.activeView === 'login', null, { timeout: 10000 });
  await page.locator('#loginView').waitFor({ state: 'visible', timeout: 10000 });
}

async function selectFirstSite(page) {
  await page.waitForFunction(() => (
    document.querySelectorAll('#attendanceSite option[value]:not([value=""])').length > 0
  ));
  await page.locator('#attendanceSite').selectOption({ index: 1 });
}

async function captureLocation(page) {
  await page.locator('#captureLocationButton').click();
  await page.locator('#locationPreview').getByText('Captured location').waitFor({ timeout: 15000 });
}

async function clickAttendanceAction(page, action) {
  const primaryButton = page.locator('#attendancePrimaryButton');
  if (await primaryButton.getAttribute('data-attendance-action') === action) {
    await primaryButton.click();
    return;
  }

  await page.locator('#attendanceCorrectionDetails').evaluate((details) => {
    details.open = true;
  });
  const correctionButton = page.locator('#attendanceCorrectionButton');
  const correctionAction = await correctionButton.getAttribute('data-attendance-action');
  if (correctionAction !== action) {
    throw new Error(`attendance correction action was ${correctionAction || 'missing'}, expected ${action}`);
  }
  await correctionButton.click();
}

async function openAdminWorkspace(page, workspace) {
  const panel = page.locator(`[data-admin-workspace-panel="${workspace}"]`);
  const desktopLink = page.locator(`.admin-desktop-nav [data-admin-workspace-target="${workspace}"]`);
  if (await desktopLink.isVisible()) {
    await desktopLink.click();
  } else {
    await page.locator('#adminMobileMenuButton').click();
    await page.locator(`#adminWorkspaceDrawer [data-admin-workspace-target="${workspace}"]`).click();
  }
  await panel.waitFor({ state: 'visible', timeout: 15000 });
}

async function myRecordCount(page) {
  return await page.evaluate(async () => {
    const response = await fetch('/api/my-records', { credentials: 'include' });
    if (!response.ok) throw new Error(`my-records failed: ${response.status}`);
    return (await response.json()).length;
  });
}

async function pageWaitForRecordCount(page, expected) {
  await page.waitForFunction(async (count) => {
    const response = await fetch('/api/my-records', { credentials: 'include' });
    if (!response.ok) return false;
    return (await response.json()).length >= count;
  }, expected, { timeout: 20000 });
}

async function waitForQueueCount(page, expected) {
  await page.waitForFunction(async (value) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('scaffold-pwa-local', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    try {
      const count = await new Promise((resolve, reject) => {
        const transaction = db.transaction('queue', 'readonly');
        const request = transaction.objectStore('queue').count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return count === value;
    } finally {
      db.close();
    }
  }, expected, { timeout: 20000 });
}

async function waitForQueueAtLeast(page, minimum) {
  try {
    await page.waitForFunction(async (value) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('scaffold-pwa-local', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      try {
        const count = await new Promise((resolve, reject) => {
          const transaction = db.transaction('queue', 'readonly');
          const request = transaction.objectStore('queue').count();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        return count >= value;
      } finally {
        db.close();
      }
    }, minimum, { timeout: 10000 });
  } catch (error) {
    const debug = await page.evaluate(() => ({
      activeView: document.body.dataset.activeView || '',
      status: document.querySelector('#statusBanner')?.textContent || '',
      navigatorOnline: navigator.onLine,
      attendancePrimaryDisabled: document.querySelector('#attendancePrimaryButton')?.disabled ?? null,
      locationPreview: document.querySelector('#locationPreview')?.textContent || ''
    }));
    throw new Error(`Expected at least ${minimum} queued submission: ${JSON.stringify(debug)}`, {
      cause: error
    });
  }
}

async function queuedLocalRecords(page) {
  return await page.evaluate(async () => {
    const { get, getAll } = await import('/assets/js/db.js');
    const queueItems = await getAll('queue');
    return (await Promise.all(queueItems.map((item) => get('records', item.id)))).filter(Boolean);
  });
}

async function setQueuedAttendanceOccurrence(page, recordId, occurredAt) {
  await page.evaluate(async ({ id, capturedAt }) => {
    const { get, put } = await import('/assets/js/db.js');
    const record = await get('records', id);
    const queueItem = await get('queue', id);
    record.capturedAt = capturedAt;
    record.createdAt = capturedAt;
    record.location = { ...record.location, capturedAt };
    await put('records', record);
    await put('queue', {
      ...queueItem,
      ownerWorkerId: record.ownerWorkerId,
      capturedAt,
      createdAt: capturedAt
    });
  }, { id: recordId, capturedAt: occurredAt });
}

async function replayQueuedSubmissions(page) {
  return await page.evaluate(async () => {
    const { syncQueuedSubmissions } = await import('/assets/js/offline-submissions.js');
    return await syncQueuedSubmissions();
  });
}

async function expectNoLegacyBearerToken(page) {
  const token = await page.evaluate(() => localStorage.getItem('geo_token'));
  if (token !== null) {
    throw new Error('legacy bearer token is still present in localStorage');
  }
}

function assertCleanDayworkText(label, text) {
  const forbidden = ['team_people', 'team_name', 'team_time', 'Number of people'];
  const leaked = forbidden.filter((value) => text.includes(value));
  if (leaked.length) {
    throw new Error(`${label} leaked Daywork helper fields: ${leaked.join(', ')} in "${text}"`);
  }
  if (!text.includes('Team: Demo Worker') || !text.includes('Working time: 07:00 to 15:30')) {
    throw new Error(`${label} did not render labelled Daywork team details: "${text}"`);
  }
}

async function fillDayworkSubmission(page) {
  await page.locator('.tab[data-tab-target="taskTab"]').click();
  await page.locator('#taskTab').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('#taskSite').selectOption({ index: 1 });
  await page.locator('#dayworkFormField_client').fill('Browser workflow client');
  await page.locator('#dayworkFormField_job_description').fill('Install scaffold bays');

  const row = page.locator('#dayworkFormFields [data-repeat-row="teams"]').first();
  await row.waitFor({ state: 'visible', timeout: 10000 });
  const picker = row.locator('[data-team-member-picker]');
  await picker.locator('[data-team-member-choice]').first().waitFor({ timeout: 20000 });
  await picker.locator('[data-team-member-search]').fill('Demo');
  await picker.locator('[data-team-member-choice]').first().check();

  const timeInputs = row.locator('[data-work-form-field="team_time"] input[type="time"]');
  await timeInputs.nth(0).fill('07:00');
  await timeInputs.nth(1).fill('15:30');
  await row.locator('[data-work-form-field="team_break"] select').selectOption({ label: '30 minutes' });

  await page.locator('#dayworkFormField_signature').evaluate((canvas) => {
    const context = canvas.getContext('2d');
    context.beginPath();
    context.moveTo(40, 120);
    context.lineTo(240, 90);
    context.lineTo(420, 130);
    context.stroke();
    canvas.dataset.signed = 'true';
  });
}

async function runCheck(name, test) {
  if (workflowFilter && !name.toLowerCase().includes(workflowFilter)) return;
  try {
    await test();
    console.log(`ok - ${name}`);
  } catch (error) {
    checks.push({ name, error });
    console.error(`not ok - ${name}`);
    console.error(`  ${error.stack || error.message}`);
  }
}

async function checkAnonymousStartupDoesNotLoadSites(browser) {
  const context = await newContext(browser);
  const page = await context.newPage();
  const siteRequests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/sites') {
      siteRequests.push(request.url());
    }
  });

  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const syncState = document.querySelector('#syncIndicator')?.dataset.state || '';
      return document.body.dataset.activeView === 'login' && syncState !== 'checking';
    });
    await page.waitForTimeout(250);

    const siteOptions = await page.locator('#attendanceSite option').allTextContents();
    if (await page.locator('#registrationPanel').isVisible()) {
      throw new Error('public registration panel is visible during the invited-account pilot');
    }
    if (!(await page.locator('#invitedAccountNotice').getByText('Invited accounts only.').isVisible())) {
      throw new Error('invited-account guidance is not visible on the sign-in screen');
    }
    if (siteRequests.length) {
      throw new Error(`anonymous startup requested authenticated sites: ${JSON.stringify(siteRequests)}`);
    }
    if (siteOptions.some((label) => label.includes('Auckland Yard') || label.includes('CBD Tower Job'))) {
      throw new Error(`login startup exposed local demo sites: ${JSON.stringify(siteOptions)}`);
    }
  } finally {
    await context.close();
  }
}

async function checkAccessibleActionFeedback(browser) {
  const context = await newContext(browser);
  const page = await context.newPage();

  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.locator('#syncIndicator').waitFor({ state: 'visible', timeout: 10000 });

    const syncState = await page.locator('#syncIndicator').evaluate((element) => ({
      role: element.getAttribute('role'),
      live: element.getAttribute('aria-live'),
      text: element.textContent || ''
    }));
    if (syncState.role !== 'status' || syncState.live !== 'polite' || !syncState.text.includes('Online')) {
      throw new Error(`sync indicator is not an accessible persistent status: ${JSON.stringify(syncState)}`);
    }

    await page.route('**/api/auth/login', async (route) => {
      await delay(350);
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Feedback test login failed.' })
      });
    });
    await page.locator('#emailInput').fill('feedback-test@example.com');
    await page.locator('#passwordInput').fill(password);
    await page.locator('#loginSubmitButton').click();
    await page.waitForFunction(() => document.querySelector('#loginSubmitButton')?.getAttribute('aria-busy') === 'true');
    const pendingLabel = await page.locator('#loginSubmitButton').innerText();
    if (!pendingLabel.includes('Signing in')) {
      throw new Error(`login did not expose a pending label: ${pendingLabel}`);
    }

    const localError = page.locator('#loginFeedback[role="alert"]');
    await localError.getByText('Feedback test login failed.').waitFor({ timeout: 10000 });
    if (await page.locator('#loginSubmitButton').getAttribute('aria-busy') !== null) {
      throw new Error('login button kept aria-busy after the failed request');
    }

    await page.locator('#downloadAppButton').click();
    const toast = page.locator('#toastViewport .toast[role="status"]').last();
    await toast.waitFor({ state: 'visible', timeout: 5000 });
    if (!(await toast.innerText()).trim()) {
      throw new Error('unscoped action feedback did not render in the toast viewport');
    }

    const syncTextAfterActions = await page.locator('#syncIndicator').innerText();
    if (!syncTextAfterActions.includes('Online')) {
      throw new Error(`action feedback overwrote the persistent sync state: ${syncTextAfterActions}`);
    }

    await page.unroute('**/api/auth/login');
    await page.locator('#emailInput').fill('worker@example.com');
    await page.locator('#passwordInput').fill(password);
    await page.locator('#loginSubmitButton').click();
    await page.waitForFunction(() => document.body.dataset.activeView === 'worker', null, { timeout: 20000 });
    await page.locator('.tab[data-tab-target="formTab"]').click();
    await page.waitForFunction(() => (
      [...document.querySelectorAll('#workFormSelect option')]
        .some((option) => option.textContent === 'Inspection form')
    ));
    await page.locator('#workFormSelect').selectOption({ label: 'Inspection form' });

    await page.locator('#submitWorkFormButton').click();
    const areaField = page.locator('#workFormField_inspection_area');
    await page.waitForFunction(() => document.activeElement?.id === 'workFormField_inspection_area');
    const areaError = await areaField.evaluate((field) => ({
      invalid: field.getAttribute('aria-invalid'),
      describedBy: field.getAttribute('aria-describedby'),
      description: field.getAttribute('aria-describedby')
        ? document.getElementById(field.getAttribute('aria-describedby'))?.textContent || ''
        : ''
    }));
    if (areaError.invalid !== 'true' || !areaError.describedBy || !areaError.description.trim()) {
      throw new Error(`first invalid Work Form field did not expose inline feedback: ${JSON.stringify(areaError)}`);
    }

    await areaField.fill('Main deck');
    if (await areaField.getAttribute('aria-invalid') !== null) {
      throw new Error('editing the invalid Work Form field did not clear its error state');
    }
    await page.locator('#submitWorkFormButton').click();
    await page.waitForFunction(() => document.activeElement?.id === 'workFormField_inspection_result');
    await page.locator('#workFormField_inspection_result').selectOption('Pass');

    let releaseSubmission;
    let markRequestReached;
    const responseGate = new Promise((resolve) => { releaseSubmission = resolve; });
    const requestReached = new Promise((resolve) => { markRequestReached = resolve; });
    await page.route('**/api/form-submissions', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      markRequestReached();
      await responseGate;
      await route.continue();
    });

    const submitPromise = page.locator('#submitWorkFormButton').click();
    await requestReached;
    const busyState = await page.locator('#submitWorkFormButton').evaluate((button) => ({
      disabled: button.disabled,
      busy: button.getAttribute('aria-busy'),
      label: button.textContent || '',
      formBusy: button.form?.getAttribute('aria-busy'),
      fieldsInert: document.querySelector('#workFormFields')?.inert
    }));
    if (
      !busyState.disabled
      || busyState.busy !== 'true'
      || !busyState.label.includes('Submitting form')
      || busyState.formBusy !== 'true'
      || !busyState.fieldsInert
    ) {
      throw new Error(`Work Form submit did not expose its busy state: ${JSON.stringify(busyState)}`);
    }
    releaseSubmission();
    await submitPromise;

    const receipt = page.locator('#workFormFeedback[role="status"]');
    await receipt.getByText('Inspection form submitted for approval.').waitFor({ timeout: 20000 });
    await page.waitForFunction(() => {
      const button = document.querySelector('#submitWorkFormButton');
      return button
        && !button.disabled
        && button.getAttribute('aria-busy') === null
        && button.textContent.trim() === 'Submit form';
    }, null, { timeout: 20000 });
    const completedButton = await page.locator('#submitWorkFormButton').evaluate((button) => ({
      disabled: button.disabled,
      busy: button.getAttribute('aria-busy'),
      label: button.textContent || ''
    }));
    if (completedButton.disabled || completedButton.busy !== null || completedButton.label.trim() !== 'Submit form') {
      throw new Error(`Work Form submit did not restore after completion: ${JSON.stringify(completedButton)}`);
    }
    const duplicateToastCount = await page.locator('#toastViewport .toast', {
      hasText: 'Inspection form submitted for approval.'
    }).count();
    if (duplicateToastCount) {
      throw new Error('local Work Form success was also announced as a duplicate toast');
    }
  } finally {
    await context.close();
  }
}

async function checkRestoredSessionLoadsSitesAfterRefresh(browser) {
  const context = await newContext(browser);
  const page = await context.newPage();

  try {
    await loginAs(page, 'worker@example.com', 'worker');
    const requests = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path === '/api/auth/refresh' || path === '/api/sites') requests.push(path);
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.dataset.activeView === 'worker');
    await selectFirstSite(page);

    const refreshIndex = requests.indexOf('/api/auth/refresh');
    const sitesIndex = requests.indexOf('/api/sites');
    if (refreshIndex < 0 || sitesIndex < 0 || sitesIndex < refreshIndex) {
      throw new Error(`site loading did not follow session restoration: ${JSON.stringify(requests)}`);
    }
  } finally {
    await context.close();
  }
}

async function checkAuthenticatedSiteFailureDoesNotExposeDemoSites(browser) {
  const context = await newContext(browser);
  const page = await context.newPage();

  try {
    await page.route('**/api/sites', (route) => route.abort('failed'));
    await loginAs(page, 'worker@example.com', 'worker');
    await page.waitForFunction(() => (
      document.querySelector('#attendanceSite option')?.textContent
        ?.includes('Sites unavailable')
    ));

    const siteState = await page.evaluate(() => ({
      options: [...document.querySelectorAll('#attendanceSite option')]
        .filter((option) => option.value)
        .map((option) => option.textContent),
      placeholder: document.querySelector('#attendanceSite option')?.textContent || ''
    }));
    if (siteState.options.length || !siteState.placeholder.includes('Sites unavailable')) {
      throw new Error(`Authenticated Site failure exposed selectable fallback Sites: ${JSON.stringify(siteState)}`);
    }
  } finally {
    await context.close();
  }
}

async function checkLoginAndGrantedGeolocation(browser) {
  const context = await newContext(browser, {
    geolocation: { latitude: -36.8485, longitude: 174.7633, accuracy: 12 },
    permissions: ['geolocation']
  });
  const page = await context.newPage();

  try {
    await loginAs(page, 'worker@example.com', 'worker');
    await expectNoLegacyBearerToken(page);
    await selectFirstSite(page);
    await captureLocation(page);
    const previewText = await page.locator('#locationPreview').innerText();
    if (!previewText.includes('Inside')) {
      throw new Error(`expected inside-site location preview, got: ${previewText}`);
    }
    await page.locator('#attendancePrimaryButton').waitFor({ state: 'visible' });
  } finally {
    await context.close();
  }
}

async function checkContextualAttendanceAction(browser) {
  const context = await newContext(browser, {
    geolocation: { latitude: -36.8485, longitude: 174.7633, accuracy: 12 },
    permissions: ['geolocation']
  });
  const page = await context.newPage();

  try {
    await loginAs(page, 'worker@example.com', 'worker');
    const initialRecordCount = await myRecordCount(page);
    const expectedAction = await page.evaluate(async () => {
      const response = await fetch('/api/my-records', { credentials: 'include' });
      if (!response.ok) throw new Error(`my-records failed: ${response.status}`);
      const records = await response.json();
      const latest = records
        .filter((record) => ['check_in', 'check_out'].includes(record.record_type))
        .sort((left, right) => (
          new Date(right.created_at) - new Date(left.created_at) || Number(right.id) - Number(left.id)
        ))[0];
      return latest?.record_type === 'check_in' ? 'check_out' : 'check_in';
    });
    await page.waitForFunction((action) => (
      document.querySelector('#attendancePrimaryButton')?.dataset.attendanceAction === action
    ), expectedAction, { timeout: 15000 });

    const initialState = await page.evaluate((action) => {
      const primary = document.querySelector('#attendancePrimaryButton');
      const correctionDetails = document.querySelector('#attendanceCorrectionDetails');
      const correction = document.querySelector('#attendanceCorrectionButton');
      return {
        expectedAction: action,
        primaryAction: primary?.dataset.attendanceAction || '',
        primaryLabel: primary?.textContent?.trim() || '',
        prominentActionCount: document.querySelectorAll('.attendance-primary-actions > .attendance-submit').length,
        correctionOpen: correctionDetails?.open ?? null,
        correctionVisible: correction ? correction.getClientRects().length > 0 : null,
        correctionAction: correction?.dataset.attendanceAction || '',
        correctionIsSecondary: correction?.classList.contains('secondary') ?? false,
        legacyActionCount: document.querySelectorAll('#checkInButton, #checkOutButton').length
      };
    }, expectedAction);
    const initialOpposite = initialState.expectedAction === 'check_in' ? 'check_out' : 'check_in';
    const expectedLabel = initialState.expectedAction === 'check_in' ? 'Check in now' : 'Check out now';
    if (
      initialState.primaryAction !== initialState.expectedAction
      || initialState.primaryLabel !== expectedLabel
      || initialState.prominentActionCount !== 1
      || initialState.correctionOpen !== false
      || initialState.correctionVisible !== false
      || initialState.correctionAction !== initialOpposite
      || !initialState.correctionIsSecondary
      || initialState.legacyActionCount !== 0
    ) {
      throw new Error(`attendance actions were not contextual: ${JSON.stringify(initialState)}`);
    }

    await selectFirstSite(page);
    await captureLocation(page);
    await page.locator('#attendanceCorrectionDetails').evaluate((details) => {
      details.open = true;
    });
    await page.locator('#attendanceCorrectionButton').click();
    await pageWaitForRecordCount(page, initialRecordCount + 1);
    await page.waitForFunction((expected) => (
      document.querySelector('#attendancePrimaryButton')?.dataset.attendanceAction === expected
      && document.querySelector('#attendanceCorrectionDetails')?.open === false
      && document.activeElement?.id === 'attendanceCorrectionSummary'
    ), initialState.expectedAction, { timeout: 15000 });

    await selectFirstSite(page);
    await captureLocation(page);
    await page.locator('#attendancePrimaryButton').click();
    await pageWaitForRecordCount(page, initialRecordCount + 2);
    await page.waitForFunction((previousAction) => (
      document.querySelector('#attendancePrimaryButton')?.dataset.attendanceAction
        && document.querySelector('#attendancePrimaryButton').dataset.attendanceAction !== previousAction
    ), initialState.primaryAction, { timeout: 15000 });

    const completedState = await page.evaluate(() => ({
      primaryAction: document.querySelector('#attendancePrimaryButton')?.dataset.attendanceAction || '',
      correctionAction: document.querySelector('#attendanceCorrectionButton')?.dataset.attendanceAction || '',
      correctionOpen: document.querySelector('#attendanceCorrectionDetails')?.open ?? null
    }));
    if (
      completedState.primaryAction !== initialOpposite
      || completedState.correctionAction !== initialState.expectedAction
      || completedState.correctionOpen !== false
    ) {
      throw new Error(`attendance action did not advance after submission: ${JSON.stringify(completedState)}`);
    }
  } finally {
    await context.close();
  }
}

async function checkDeniedGeolocation(browser) {
  const context = await newContext(browser, {
    initScript: () => {
      Object.defineProperty(Navigator.prototype, 'geolocation', {
        configurable: true,
        get() {
          return {
            getCurrentPosition(_success, error) {
              setTimeout(() => {
                error({ code: 1, message: 'User denied Geolocation' });
              }, 0);
            }
          };
        }
      });
    }
  });
  const page = await context.newPage();

  try {
    await loginAs(page, 'worker@example.com', 'worker');
    await selectFirstSite(page);
    await page.locator('#captureLocationButton').click();
    await page.locator('#attendanceFeedback').getByText('Could not get location').waitFor({ timeout: 10000 });
  } finally {
    await context.close();
  }
}

async function checkOfflineQueueAndReplay(browser) {
  const context = await newContext(browser, {
    geolocation: { latitude: -36.8485, longitude: 174.7633, accuracy: 12 },
    permissions: ['geolocation']
  });
  const page = await context.newPage();
  const secondWorkerEmail = `offline-owner-${Date.now()}@example.com`;

  try {
    await loginAs(page, 'supervisor@example.com', 'supervisor');
    await page.evaluate(async ({ email, workerPassword }) => {
      const { createUser, getSession } = await import('/assets/js/api-client.js');
      const supervisor = getSession();
      await createUser({
        name: 'Offline Replay Worker',
        email,
        password: workerPassword,
        role: 'worker',
        worker_class: 'normal',
        department_id: supervisor.departmentId,
        is_global_admin: false
      });
    }, { email: secondWorkerEmail, workerPassword: password });
    await logout(page);
    await page.waitForTimeout(300);

    await loginAs(page, 'worker@example.com', 'worker');
    const firstWorker = await page.evaluate(async () => {
      const { getSession } = await import('/assets/js/api-client.js');
      return getSession();
    });
    const beforeCount = await myRecordCount(page);
    await selectFirstSite(page);
    await captureLocation(page);

    await context.setOffline(true);
    await clickAttendanceAction(page, 'check_in');
    await waitForQueueAtLeast(page, 1);

    let [queuedRecord] = await queuedLocalRecords(page);
    if (!queuedRecord) throw new Error('offline attendance record was not stored');
    if (queuedRecord.ownerWorkerId !== firstWorker.id || queuedRecord.userId !== firstWorker.id) {
      throw new Error(`offline attendance owner was not bound to Worker A: ${JSON.stringify(queuedRecord)}`);
    }
    if (queuedRecord.capturedAt !== queuedRecord.location?.capturedAt) {
      throw new Error('offline attendance did not preserve the location capture time');
    }

    const delayedOccurrence = new Date(Date.now() - (2 * 24 * 60 * 60 * 1000)).toISOString();
    await setQueuedAttendanceOccurrence(page, queuedRecord.id, delayedOccurrence);
    queuedRecord = (await queuedLocalRecords(page))[0];
    const originalClientSubmissionId = queuedRecord.clientSubmissionId;
    const retryCountBeforeAccountSwitch = queuedRecord.retryCount;

    await logout(page);
    await context.setOffline(false);
    await page.waitForTimeout(300);
    await loginAs(page, secondWorkerEmail, 'worker');
    const secondWorkerCount = await myRecordCount(page);
    const secondWorkerReplay = await replayQueuedSubmissions(page);
    if (secondWorkerReplay.ownershipBlocked < 1) {
      throw new Error(`Worker B replay did not report an ownership block: ${JSON.stringify(secondWorkerReplay)}`);
    }
    await waitForQueueCount(page, 1);
    const [ownershipBlockedRecord] = await queuedLocalRecords(page);
    if (
      ownershipBlockedRecord.syncBlockedReason !== 'owner_mismatch'
      || ownershipBlockedRecord.retryCount !== retryCountBeforeAccountSwitch
      || ownershipBlockedRecord.clientSubmissionId !== originalClientSubmissionId
    ) {
      throw new Error(`ownership block changed retry/idempotency state: ${JSON.stringify(ownershipBlockedRecord)}`);
    }
    if (await myRecordCount(page) !== secondWorkerCount) {
      throw new Error('Worker A offline attendance was written to Worker B');
    }

    await logout(page);
    await page.waitForTimeout(300);
    await loginAs(page, 'worker@example.com', 'worker');
    await waitForQueueCount(page, 0);
    const syncedAttendance = await page.evaluate(async (clientSubmissionId) => {
      const response = await fetch('/api/my-records', { credentials: 'include' });
      if (!response.ok) throw new Error(`my-records failed: ${response.status}`);
      return (await response.json()).find((record) => record.client_submission_id === clientSubmissionId);
    }, originalClientSubmissionId);
    if (!syncedAttendance || syncedAttendance.worker_id !== firstWorker.id) {
      throw new Error(`queued attendance did not return to Worker A: ${JSON.stringify(syncedAttendance)}`);
    }
    if (new Date(syncedAttendance.created_at).getTime() !== new Date(delayedOccurrence).getTime()) {
      throw new Error(`delayed attendance used sync time instead of occurrence time: ${JSON.stringify(syncedAttendance)}`);
    }

    await page.evaluate(async (recordId) => {
      const { get, put } = await import('/assets/js/db.js');
      const record = await get('records', recordId);
      record.backendRecordId = null;
      record.syncStatus = 'queued';
      record.syncedAt = '';
      await put('records', record);
      await put('queue', {
        id: record.id,
        kind: record.type,
        ownerWorkerId: record.ownerWorkerId,
        capturedAt: record.capturedAt,
        createdAt: record.createdAt,
        syncStartedAt: ''
      });
    }, queuedRecord.id);
    const replayResult = await replayQueuedSubmissions(page);
    if (replayResult.flushed !== 1) {
      throw new Error(`idempotent replay did not flush cleanly: ${JSON.stringify(replayResult)}`);
    }
    await waitForQueueCount(page, 0);

    await page.waitForFunction(
      async ({ expectedCount, clientSubmissionId }) => {
        const response = await fetch('/api/my-records', { credentials: 'include' });
        if (!response.ok) return false;
        const records = await response.json();
        return records.length === expectedCount
          && records.filter((record) => record.client_submission_id === clientSubmissionId).length === 1;
      },
      { expectedCount: beforeCount + 1, clientSubmissionId: originalClientSubmissionId },
      { timeout: 20000 }
    );
  } finally {
    await context.setOffline(false).catch(() => {});
    await context.close();
  }
}

async function checkRepeatSignatureUploadResume(browser) {
  const context = await newContext(browser);
  const page = await context.newPage();
  const formName = `Repeat signature retry ${Date.now()}`;
  let uploadRequests = 0;
  let failSecondUpload = true;

  try {
    await loginAs(page, 'supervisor@example.com', 'supervisor');
    const form = await page.evaluate(async (name) => {
      const { createWorkForm } = await import('/assets/js/api-client.js');
      return await createWorkForm({
        name,
        description: 'Browser regression for resumable repeat signatures.',
        fields: [
          {
            id: 'crews',
            label: 'Crews',
            type: 'repeat',
            required: true,
            min_rows: 2,
            max_rows: 2
          },
          {
            id: 'crew_signature',
            label: 'Crew signature',
            type: 'signature',
            required: true,
            repeat: 'crews'
          }
        ]
      });
    }, formName);
    await logout(page);
    await page.waitForTimeout(300);
    await loginAs(page, 'worker@example.com', 'worker');

    await page.route('**/api/photo-uploads', async (route) => {
      uploadRequests += 1;
      if (failSecondUpload && uploadRequests === 2) {
        await route.abort('failed');
        return;
      }
      await route.continue();
    });

    const queued = await page.evaluate(async (workForm) => {
      const canvas = document.createElement('canvas');
      canvas.width = 4;
      canvas.height = 4;
      const drawing = canvas.getContext('2d');
      drawing.fillStyle = '#111827';
      drawing.fillRect(0, 0, canvas.width, canvas.height);
      const signature = canvas.toDataURL('image/png');
      const id = `repeat-signature-${Date.now()}`;
      const { submitOfflineSubmission } = await import('/assets/js/offline-submissions.js');
      const result = await submitOfflineSubmission({
        id,
        type: 'form',
        formId: workForm.id,
        formName: workForm.name,
        fields: workForm.fields,
        answers: {
          crews: [
            { crew_signature: signature },
            { crew_signature: signature }
          ]
        },
        workDate: '2026-07-15',
        createdAt: new Date().toISOString()
      });
      return {
        id,
        queued: result.queued,
        firstSignature: result.record.answers.crews[0].crew_signature,
        secondSignature: result.record.answers.crews[1].crew_signature
      };
    }, form);

    if (
      !queued.queued
      || !queued.firstSignature.startsWith('/uploads/')
      || !queued.secondSignature.startsWith('data:image/png')
      || uploadRequests !== 2
    ) {
      throw new Error(`repeat signature progress was not persisted after a partial upload: ${JSON.stringify({ queued, uploadRequests })}`);
    }

    failSecondUpload = false;
    const replay = await replayQueuedSubmissions(page);
    if (replay.flushed !== 1 || replay.failed !== 0 || uploadRequests !== 3) {
      throw new Error(`repeat signature retry did not resume at the unfinished row: ${JSON.stringify({ replay, uploadRequests })}`);
    }

    await waitForQueueCount(page, 0);
    const synced = await page.evaluate(async (recordId) => {
      const { get } = await import('/assets/js/db.js');
      const record = await get('records', recordId);
      return {
        syncStatus: record?.syncStatus || '',
        signatures: record?.answers?.crews?.map((row) => row.crew_signature) || []
      };
    }, queued.id);
    if (
      synced.syncStatus !== 'synced'
      || synced.signatures.length !== 2
      || synced.signatures.some((value) => !value.startsWith('/uploads/'))
    ) {
      throw new Error(`repeat signature retry did not finish with durable upload URLs: ${JSON.stringify(synced)}`);
    }
  } finally {
    await context.close();
  }
}

async function checkDayworkTeamMemberPicker(browser) {
  const context = await newContext(browser);
  const page = await context.newPage();

  try {
    await loginAs(page, 'worker@example.com', 'worker');
    await page.locator('.tab[data-tab-target="taskTab"]').click();
    await page.locator('#taskTab').waitFor({ state: 'visible', timeout: 10000 });
    const picker = page.locator('#dayworkFormFields [data-team-member-picker]').first();
    try {
      await picker.locator('[data-team-member-choice]').first().waitFor({ timeout: 20000 });
    } catch (error) {
      const debug = await page.evaluate(async () => {
        const response = await fetch('/api/team-work-log-members', { credentials: 'include' });
        const workFormsResponse = await fetch('/api/work-forms', { credentials: 'include' });
        const members = response.ok ? await response.json() : await response.text();
        const workForms = workFormsResponse.ok ? await workFormsResponse.json() : [];
        const daywork = Array.isArray(workForms)
          ? workForms.find((form) => `${form.name || ''} ${form.description || ''}`.toLowerCase().includes('daywork'))
          : null;
        return {
          activeView: document.body.dataset.activeView || '',
          status: document.querySelector('#statusBanner')?.textContent
            || document.querySelector('#toastViewport .toast:last-child')?.textContent
            || document.querySelector('[data-local-feedback]:not(.hidden)')?.textContent
            || '',
          dayworkHint: document.querySelector('#dayworkFormHint')?.textContent || '',
          pickerCount: document.querySelectorAll('#dayworkFormFields [data-team-member-picker]').length,
          repeatRowCount: document.querySelectorAll('#dayworkFormFields [data-repeat-row]').length,
          dayworkText: document.querySelector('#dayworkFormFields')?.textContent || '',
          optionText: document.querySelector('#dayworkFormFields [data-team-member-options]')?.textContent || '',
          membersStatus: response.status,
          members,
          workFormsStatus: workFormsResponse.status,
          dayworkFields: daywork?.fields?.map((field) => ({
            id: field.id,
            type: field.type,
            repeat: field.repeat || ''
          })) || []
        };
      });
      throw new Error(`Daywork member picker did not show choices: ${JSON.stringify(debug)}`, {
        cause: error
      });
    }
    await picker.locator('[data-team-member-search]').fill('Demo');
    await picker.locator('[data-team-member-choice]').first().check();
    await page.waitForFunction(() => {
      const row = document.querySelector('#dayworkFormFields [data-repeat-row="teams"]');
      return row?.querySelector('[data-daywork-team-member-names]')?.value.includes('Demo Worker')
        && row?.querySelector('[data-daywork-team-member-count]')?.value === '1'
        && !row?.textContent.includes('Number of people');
    }, null, { timeout: 10000 });
  } finally {
    await context.close();
  }
}

async function checkDayworkRecordRendering(browser) {
  const workerContext = await newContext(browser);
  const workerPage = await workerContext.newPage();

  try {
    await loginAs(workerPage, 'worker@example.com', 'worker');
    await fillDayworkSubmission(workerPage);
    await workerPage.locator('#submitTaskButton').click();
    await workerPage.locator('#taskFeedback').getByText('Daywork log form submitted for approval').waitFor({ timeout: 20000 });
    await workerPage.locator('.tab[data-tab-target="historyTab"]').click();
    await workerPage.locator('#historyTab').waitFor({ state: 'visible', timeout: 10000 });
    await workerPage.locator('#historyList .record-form').filter({ hasText: 'Daywork log form' }).first().waitFor({ timeout: 20000 });
    const historyText = await workerPage.locator('#historyList .record-form').filter({ hasText: 'Daywork log form' }).first().innerText();
    assertCleanDayworkText('worker history', historyText);
  } finally {
    await workerContext.close();
  }

  const supervisorContext = await newContext(browser, {
    viewport: { width: 1280, height: 900 },
    isMobile: false,
    hasTouch: false
  });
  const supervisorPage = await supervisorContext.newPage();

  try {
    await loginAs(supervisorPage, 'supervisor@example.com', 'supervisor');
    await openAdminWorkspace(supervisorPage, 'review');
    await supervisorPage.locator('#reviewQueueDetails').evaluate((element) => {
      element.open = true;
    });
    await supervisorPage.locator('#supervisorStatusFilter').selectOption('pending');
    const dayworkReviewItem = supervisorPage.locator('#reviewQueueList .record-form').filter({ hasText: 'Daywork log form' }).first();
    await dayworkReviewItem.waitFor({ timeout: 20000 });
    await dayworkReviewItem.click();
    const dayworkReviewDetail = supervisorPage.locator('#reviewQueueDetail .record-form').filter({ hasText: 'Daywork log form' }).first();
    await dayworkReviewDetail.waitFor({ timeout: 10000 });
    const reviewText = await dayworkReviewDetail.innerText();
    assertCleanDayworkText('supervisor review', reviewText);
  } finally {
    await supervisorContext.close();
  }
}

async function checkReconnectPreservesWorkerForms(browser) {
  const context = await newContext(browser);
  const page = await context.newPage();
  const dayworkMarker = `Daywork reconnect ${Date.now()}`;
  const formMarker = `Inspection reconnect ${Date.now()}`;

  try {
    await loginAs(page, 'worker@example.com', 'worker');

    await page.locator('.tab[data-tab-target="taskTab"]').click();
    await page.locator('#dayworkFormField_client').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#dayworkFormField_client').fill(dayworkMarker);

    await page.locator('.tab[data-tab-target="formTab"]').click();
    await page.waitForFunction(() => (
      [...document.querySelectorAll('#workFormSelect option')]
        .some((option) => option.textContent === 'Inspection form')
    ));
    await page.locator('#workFormSelect').selectOption({ label: 'Inspection form' });
    const inspectionInput = page.locator('#workFormFields [data-work-form-field="inspection_area"] input');
    await inspectionInput.waitFor({ state: 'visible', timeout: 10000 });
    await inspectionInput.fill(formMarker);

    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => (
      [...document.querySelectorAll('#toastViewport .toast')]
        .some((toast) => (toast.textContent || '').includes('back online'))
    ), null, { timeout: 20000 });

    if (await page.locator('#dayworkFormField_client').inputValue() !== dayworkMarker) {
      throw new Error('Daywork input was lost when connectivity returned');
    }
    if (await inspectionInput.inputValue() !== formMarker) {
      throw new Error('Work Form input was lost when connectivity returned');
    }
  } finally {
    await context.close();
  }
}

async function checkStaffGlobalAdminScoping(browser) {
  const supervisorContext = await newContext(browser, {
    viewport: { width: 1280, height: 900 },
    isMobile: false,
    hasTouch: false
  });
  const supervisorPage = await supervisorContext.newPage();

  try {
    await loginAs(supervisorPage, 'supervisor@example.com', 'supervisor');
    await openAdminWorkspace(supervisorPage, 'people');
    await supervisorPage.locator('#staffUsersDetails').evaluate((element) => {
      element.open = true;
    });
    await supervisorPage.locator('#staffUsersList .record-card').first().waitFor({ timeout: 20000 });
    const departmentListText = await supervisorPage.locator('#staffUsersList').innerText();
    if (departmentListText.includes('Super Admin') || departmentListText.includes('global admin')) {
      throw new Error(`department admin staff list exposed global admin account: "${departmentListText}"`);
    }

    const departmentControls = await supervisorPage.evaluate(async () => {
      const response = await fetch('/api/supervisor/users', { credentials: 'include' });
      const users = response.ok ? await response.json() : [];
      const globalAdminLabel = document.querySelector('#staffGlobalAdminInput')?.closest('label');
      return {
        apiStatus: response.status,
        globalUsers: users.filter((user) => user.is_global_admin || user.isGlobalAdmin).map((user) => user.email),
        globalAdminLabelVisible: globalAdminLabel
          ? !globalAdminLabel.classList.contains('hidden') && getComputedStyle(globalAdminLabel).display !== 'none'
          : null,
        globalAdminInputDisabled: document.querySelector('#staffGlobalAdminInput')?.disabled ?? null,
        departmentSelectDisabled: document.querySelector('#staffDepartmentSelect')?.disabled ?? null
      };
    });

    if (departmentControls.apiStatus !== 200) {
      throw new Error(`department admin users API failed: ${JSON.stringify(departmentControls)}`);
    }
    if (departmentControls.globalUsers.length) {
      throw new Error(`department admin users API exposed global admin accounts: ${JSON.stringify(departmentControls)}`);
    }
    if (departmentControls.globalAdminLabelVisible || departmentControls.globalAdminInputDisabled !== true) {
      throw new Error(`department admin create form exposed global admin control: ${JSON.stringify(departmentControls)}`);
    }
    if (departmentControls.departmentSelectDisabled !== true) {
      throw new Error(`department admin create form allowed department switching: ${JSON.stringify(departmentControls)}`);
    }

    await openAdminWorkspace(supervisorPage, 'forms');
    await supervisorPage.locator('#workFormsDetails').evaluate((element) => {
      element.open = true;
    });
    const dayworkFormCard = supervisorPage.locator('#workFormsList .record-form').filter({ hasText: 'Daywork log form' }).first();
    await dayworkFormCard.waitFor({ timeout: 20000 });
    const formSummaryText = await dayworkFormCard.innerText();
    if (formSummaryText.includes('Number of people') || formSummaryText.includes('team_people')) {
      throw new Error(`Daywork work-form summary exposed helper field: "${formSummaryText}"`);
    }
    await dayworkFormCard.getByRole('button', { name: 'Preview' }).click();
    await dayworkFormCard.locator('[data-work-form-preview]').waitFor({ state: 'visible', timeout: 10000 });
    const previewText = await dayworkFormCard.locator('[data-work-form-preview]').innerText();
    if (previewText.includes('Number of people') || previewText.includes('team_people')) {
      throw new Error(`Daywork work-form preview exposed helper field: "${previewText}"`);
    }
  } finally {
    await supervisorContext.close();
  }

  const adminContext = await newContext(browser, {
    viewport: { width: 1280, height: 900 },
    isMobile: false,
    hasTouch: false
  });
  const adminPage = await adminContext.newPage();

  try {
    await loginAs(adminPage, 'admin@example.com', 'supervisor');
    await openAdminWorkspace(adminPage, 'people');
    await adminPage.locator('#staffUsersDetails').evaluate((element) => {
      element.open = true;
    });
    await adminPage.locator('#staffUsersList .record-card').filter({ hasText: 'Super Admin' }).first().waitFor({ timeout: 20000 });
    const adminControls = await adminPage.evaluate(() => {
      const globalAdminLabel = document.querySelector('#staffGlobalAdminInput')?.closest('label');
      return {
        globalAdminLabelVisible: globalAdminLabel
          ? !globalAdminLabel.classList.contains('hidden') && getComputedStyle(globalAdminLabel).display !== 'none'
          : null,
        globalAdminInputDisabled: document.querySelector('#staffGlobalAdminInput')?.disabled ?? null,
        departmentSelectDisabled: document.querySelector('#staffDepartmentSelect')?.disabled ?? null
      };
    });
    if (!adminControls.globalAdminLabelVisible || adminControls.globalAdminInputDisabled || adminControls.departmentSelectDisabled) {
      throw new Error(`global admin lost global staff controls: ${JSON.stringify(adminControls)}`);
    }
  } finally {
    await adminContext.close();
  }
}

async function checkSupervisorWorkFormCardBuilder(browser) {
  const context = await newContext(browser, {
    viewport: { width: 1280, height: 900 },
    isMobile: false,
    hasTouch: false
  });
  const page = await context.newPage();
  const formName = `Card builder ${Date.now()}`;
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    await loginAs(page, 'supervisor@example.com', 'supervisor');
    await openAdminWorkspace(page, 'forms');
    await page.locator('#workFormsDetails').evaluate((element) => {
      element.open = true;
    });

    const addFieldButton = page.locator('#addWorkFormFieldButton');
    const topLevelCards = page.locator('#workFormFieldCards > [data-work-form-field-card]');
    await page.locator('#workFormNameInput').fill(formName);
    await page.locator('#workFormDescriptionInput').fill('Created through the visual field card regression.');

    await addFieldButton.click();
    let resultCard = topLevelCards.nth(0);
    const resultId = await resultCard.getAttribute('data-field-id');
    await resultCard.locator('[data-field-property="label"]').fill('Result');
    await resultCard.locator('[data-field-property="type"]').selectOption('select');
    resultCard = page.locator(`#workFormFieldCards > [data-field-id="${resultId}"]`);
    await resultCard.locator('[data-field-property="options"]').fill('Pass\nFail\nN/A');
    await resultCard.locator('.work-form-required-toggle').click();

    await addFieldButton.click();
    let issueCard = topLevelCards.nth(1);
    const issueId = await issueCard.getAttribute('data-field-id');
    await issueCard.locator('[data-field-property="label"]').fill('Issue details');
    await issueCard.locator('[data-field-property="type"]').selectOption('textarea');
    issueCard = page.locator(`#workFormFieldCards > [data-field-id="${issueId}"]`);
    await issueCard.locator('.work-form-required-toggle').click();
    await issueCard.locator('.work-form-condition-toggle').click();
    issueCard = page.locator(`#workFormFieldCards > [data-field-id="${issueId}"]`);
    await issueCard.locator('[data-field-property="condition-field"]').selectOption(resultId);
    await issueCard.locator('[data-field-property="condition-operator"]').selectOption('=');
    await issueCard.locator('[data-field-property="condition-value"]').selectOption('Fail');

    const checkboxVisuals = await page.evaluate(({ resultFieldId, issueFieldId }) => {
      const inspect = (selector) => {
        const label = document.querySelector(selector);
        const input = label?.querySelector('input[type="checkbox"]');
        const control = label?.querySelector('.form-checkbox-control');
        const labelStyle = label ? getComputedStyle(label) : null;
        const inputStyle = input ? getComputedStyle(input) : null;
        const controlRect = control?.getBoundingClientRect();
        return {
          checked: input?.checked ?? false,
          controlHeight: controlRect?.height || 0,
          controlWidth: controlRect?.width || 0,
          inputOpacity: inputStyle?.opacity || '',
          labelMinHeight: Number.parseFloat(labelStyle?.minHeight || '0')
        };
      };
      return {
        required: inspect(`#workFormFieldCards > [data-field-id="${CSS.escape(resultFieldId)}"] .work-form-required-toggle`),
        condition: inspect(`#workFormFieldCards > [data-field-id="${CSS.escape(issueFieldId)}"] .work-form-condition-toggle`)
      };
    }, { resultFieldId: resultId, issueFieldId: issueId });
    for (const [name, visual] of Object.entries(checkboxVisuals)) {
      if (!visual.checked || visual.controlWidth < 30 || visual.controlHeight < 30 || visual.inputOpacity !== '0' || visual.labelMinHeight < 58) {
        throw new Error(`${name} Work Form checkbox did not use the accessible visual treatment: ${JSON.stringify(visual)}`);
      }
    }

    await addFieldButton.click();
    let noteCard = topLevelCards.nth(2);
    const noteId = await noteCard.getAttribute('data-field-id');
    await noteCard.locator('[data-field-property="label"]').fill('Supervisor note');

    noteCard = page.locator(`#workFormFieldCards > [data-field-id="${noteId}"]`);
    issueCard = page.locator(`#workFormFieldCards > [data-field-id="${issueId}"]`);
    await noteCard.locator('[data-field-drag-handle]').evaluate((handle, targetId) => {
      const target = document.querySelector(`#workFormFieldCards > [data-field-id="${CSS.escape(targetId)}"]`);
      const dataTransfer = new DataTransfer();
      const targetRect = target.getBoundingClientRect();
      handle.dispatchEvent(new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        dataTransfer
      }));
      target.dispatchEvent(new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        clientY: targetRect.top + 2,
        dataTransfer
      }));
      target.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientY: targetRect.top + 2,
        dataTransfer
      }));
      document.querySelector(`#workFormFieldCards > [data-field-id="${CSS.escape(targetId)}"]`)
        ?.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
    }, issueId);

    const fieldOrder = async () => await topLevelCards.evaluateAll((cards) => (
      cards.map((card) => card.getAttribute('data-field-id'))
    ));
    let order = await fieldOrder();
    if (order.join('|') !== [resultId, noteId, issueId].join('|')) {
      throw new Error(`drag did not reorder field cards: ${JSON.stringify(order)}`);
    }

    resultCard = page.locator(`#workFormFieldCards > [data-field-id="${resultId}"]`);
    await resultCard.locator('[data-move-field="down"]').click();
    resultCard = page.locator(`#workFormFieldCards > [data-field-id="${resultId}"]`);
    await resultCard.locator('[data-move-field="down"]').click();
    order = await fieldOrder();
    if (order.join('|') !== [noteId, resultId, issueId].join('|')) {
      throw new Error(`dependency-breaking move was not rejected: ${JSON.stringify(order)}`);
    }
    const moveFeedback = await page.locator('#workFormBuilderFeedback').innerText();
    if (!moveFeedback.includes('Could not move field')) {
      throw new Error(`dependency-breaking move lacked local feedback: ${moveFeedback}`);
    }
    await resultCard.locator('[data-move-field="up"]').click();

    const advanced = page.locator('#workFormAdvancedDetails');
    if (await advanced.getAttribute('open') !== null) {
      throw new Error('Advanced raw syntax opened by default');
    }
    await advanced.locator('summary').click();
    const rawInput = page.locator('#workFormFieldsInput');
    const rawSyntax = await rawInput.inputValue();
    if (!rawSyntax.includes(`id=${resultId}`) || !rawSyntax.includes(`show_if=${resultId}=Fail`)) {
      throw new Error(`visual cards did not serialise stable ids and condition: ${rawSyntax}`);
    }
    await rawInput.fill(rawSyntax.replace('Supervisor note', 'Site note'));
    await page.locator('#workFormPreviewButton').click();
    await page.locator('#workFormRawFeedback').getByText('Apply or discard').waitFor({ timeout: 5000 });
    await page.locator('#applyWorkFormRawButton').click();
    await page.locator(`#workFormFieldCards > [data-field-id="${noteId}"] [data-field-property="label"]`).waitFor();
    if (await page.locator(`#workFormFieldCards > [data-field-id="${noteId}"] [data-field-property="label"]`).inputValue() !== 'Site note') {
      throw new Error('applying raw syntax did not rebuild the visual cards');
    }

    await page.locator('#workFormPreviewButton').click();
    const preview = page.locator('#workFormDraftPreview');
    await preview.waitFor({ state: 'visible', timeout: 10000 });
    const resultPreview = preview.locator(`[data-work-form-field="${resultId}"] select`);
    const issuePreview = preview.locator(`[data-work-form-field="${issueId}"]`);
    const optionLabels = await resultPreview.locator('option').allTextContents();
    if (optionLabels.join('|') !== 'Select|Pass|Fail|N/A') {
      throw new Error(`preview did not preserve choice options: ${JSON.stringify(optionLabels)}`);
    }
    if (await issuePreview.isVisible()) {
      throw new Error('conditional field was visible for the default Pass result');
    }
    await resultPreview.evaluate((select) => {
      select.value = 'Fail';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    if (!await issuePreview.isVisible()) {
      throw new Error('conditional field did not appear for Fail');
    }

    const createRequestPromise = page.waitForRequest((request) => (
      request.method() === 'POST'
      && new URL(request.url()).pathname === '/api/supervisor/work-forms'
    ), { timeout: 8000 });
    await page.locator('#workFormSubmitButton').click();
    const createRequest = await createRequestPromise.catch(async (error) => {
      const debug = await page.evaluate(() => ({
        actionFeedback: document.querySelector('#workFormBuilderActionFeedback')?.textContent || '',
        builderFeedback: document.querySelector('#workFormBuilderFeedback')?.textContent || '',
        buttonBusy: document.querySelector('#workFormSubmitButton')?.getAttribute('aria-busy'),
        buttonDisabled: document.querySelector('#workFormSubmitButton')?.disabled,
        formValid: document.querySelector('#workFormBuilderForm')?.checkValidity(),
        invalidIds: [...document.querySelectorAll('#workFormBuilderForm :invalid')].map((element) => element.id || element.dataset.fieldProperty || element.tagName),
        rawPending: document.querySelector('#workFormAdvancedDetails')?.classList.contains('has-pending-raw')
      }));
      throw new Error(`${error.message}; state=${JSON.stringify(debug)}; pageErrors=${JSON.stringify(pageErrors)}`);
    });
    const createPayload = createRequest.postDataJSON();
    await page.locator('#workFormBuilderActionFeedback').getByText('Work form created.').waitFor({ timeout: 20000 });

    const expectedOrder = [resultId, noteId, issueId];
    if (createPayload.fields.map((field) => field.id).join('|') !== expectedOrder.join('|')) {
      throw new Error(`create payload had the wrong field order: ${JSON.stringify(createPayload.fields)}`);
    }
    if (createPayload.fields[0].options.join('|') !== 'Pass|Fail|N/A' || !createPayload.fields[0].required) {
      throw new Error(`create payload lost choice settings: ${JSON.stringify(createPayload.fields[0])}`);
    }
    if (createPayload.fields[2].show_if !== `${resultId}=Fail`) {
      throw new Error(`create payload lost condition: ${JSON.stringify(createPayload.fields[2])}`);
    }

    const savedCard = page.locator('#workFormsList .record-form').filter({ hasText: formName }).first();
    await savedCard.waitFor({ timeout: 20000 });
    await savedCard.getByRole('button', { name: 'Edit' }).click();
    const editPanel = page.locator('#supervisorEditPanel');
    await editPanel.waitFor({ state: 'visible', timeout: 10000 });
    const editResultCard = editPanel.locator(`[data-field-id="${resultId}"]`);
    await editResultCard.locator('[data-field-property="label"]').fill('Inspection result');
    await editResultCard.locator('[data-field-property="options"]').fill('Pass\nFail\nN/A\nBlocked');

    const updateRequestPromise = page.waitForRequest((request) => (
      request.method() === 'PATCH'
      && /\/api\/supervisor\/work-forms\/\d+$/.test(new URL(request.url()).pathname)
    ));
    page.once('dialog', (dialog) => dialog.accept());
    await editPanel.locator('button[type="submit"]').click();
    const updateRequest = await updateRequestPromise;
    const updatePayload = updateRequest.postDataJSON();
    await page.locator('#toastViewport .toast').filter({ hasText: 'Work form updated.' }).waitFor({ timeout: 20000 });

    if (updatePayload.fields[0].id !== resultId || updatePayload.fields[0].label !== 'Inspection result') {
      throw new Error(`edit did not preserve the stable field id: ${JSON.stringify(updatePayload.fields[0])}`);
    }
    if (!updatePayload.fields[0].options.includes('Blocked')) {
      throw new Error(`edit did not preserve changed options: ${JSON.stringify(updatePayload.fields[0])}`);
    }
    await page.waitForFunction((name) => (
      [...document.querySelectorAll('#workFormsList .record-form')]
        .some((card) => card.textContent.includes(name) && card.textContent.includes('Inspection result'))
    ), formName, { timeout: 20000 });
    const updatedSummary = await page.locator('#workFormsList .record-form').filter({ hasText: formName }).first().innerText();
    if (!updatedSummary.includes('Inspection result')) {
      throw new Error(`updated form list did not reflect card edits: ${updatedSummary}`);
    }
  } finally {
    await context.close();
  }
}

async function checkSupervisorReview(browser) {
  const overviewMarker = `overview-regression-${Date.now()}`;
  const workerContext = await newContext(browser, {
    geolocation: { latitude: 0, longitude: 0, accuracy: 20 },
    permissions: ['geolocation']
  });
  const workerPage = await workerContext.newPage();

  try {
    await loginAs(workerPage, 'worker@example.com', 'worker');
    const initialRecordCount = await myRecordCount(workerPage);
    await selectFirstSite(workerPage);
    await captureLocation(workerPage);
    await workerPage.locator('#attendanceNotes').evaluate((element, marker) => {
      element.value = marker;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, overviewMarker);
    await clickAttendanceAction(workerPage, 'check_in');
    await workerPage.locator('#attendanceFeedback').getByText('supervisor review').waitFor({ timeout: 15000 });
    await workerContext.setGeolocation({ latitude: -36.8485, longitude: 174.7633, accuracy: 20 });
    await selectFirstSite(workerPage);
    await captureLocation(workerPage);
    await clickAttendanceAction(workerPage, 'check_out');
    await pageWaitForRecordCount(workerPage, initialRecordCount + 2);
    await logout(workerPage);
  } finally {
    await workerContext.close();
  }

  const supervisorContext = await newContext(browser, {
    viewport: { width: 1280, height: 900 },
    isMobile: false,
    hasTouch: false
  });
  const supervisorPage = await supervisorContext.newPage();

  try {
    await loginAs(supervisorPage, 'supervisor@example.com', 'supervisor');
    await openAdminWorkspace(supervisorPage, 'review');
    await supervisorPage.locator('#reviewQueueDetails').evaluate((element) => {
      element.open = true;
    });
    await supervisorPage.locator('#supervisorStatusFilter').selectOption('pending');
    await supervisorPage.locator('#reviewQueueList .record-card').first().waitFor({ timeout: 20000 });
    const reviewText = await supervisorPage.locator('#reviewQueueList').innerText();
    if (!reviewText.includes('Demo Worker') || !reviewText.includes('Outside')) {
      throw new Error(`expected pending outside-site worker record in review queue, got: ${reviewText}`);
    }

    await supervisorPage.locator('#locationMapDetails summary').click();
    await supervisorPage.locator('#locationReviewMap .location-map-point').first().waitFor({ timeout: 15000 });
    await supervisorPage.locator('#locationReviewMap .location-map-site-marker').first().waitFor({ timeout: 15000 });
    await supervisorPage.locator('#locationReviewMap .location-site-boundary').first().waitFor({ timeout: 15000 });
    const mapDebug = await supervisorPage.evaluate(() => ({
      pointLabels: [...document.querySelectorAll('#locationReviewMap .location-map-point')]
        .map((element) => element.textContent.trim()),
      siteLabels: [...document.querySelectorAll('#locationReviewMap .location-map-site-marker')]
        .map((element) => element.textContent.trim()),
      boundaryCount: document.querySelectorAll('#locationReviewMap .location-site-boundary').length
    }));
    if (
      !mapDebug.pointLabels.includes('IN')
      || !mapDebug.pointLabels.includes('OUT')
      || !mapDebug.siteLabels.includes('SITE')
      || mapDebug.boundaryCount < 1
    ) {
      throw new Error(`location map did not render visible site/check-in markers: ${JSON.stringify(mapDebug)}`);
    }

    await supervisorPage.locator('#supervisorSearchInput').fill(overviewMarker);
    const markedRecord = supervisorPage.locator('#reviewQueueList .record-card').filter({ hasText: overviewMarker });
    await markedRecord.waitFor({ timeout: 15000 });
    await markedRecord.click();
    await markedRecord.evaluate((element) => {
      if (element.getAttribute('aria-selected') !== 'true') {
        throw new Error('selected Review Desk item did not expose aria-selected=true');
      }
    });
    const markedDetail = supervisorPage.locator('#reviewQueueDetail .record-card').filter({ hasText: overviewMarker });
    await markedDetail.waitFor({ timeout: 10000 });
    const detailText = await markedDetail.innerText();
    if (!detailText.includes('Demo Worker') || !detailText.includes('Outside')) {
      throw new Error(`selected Review Desk detail lost record evidence: ${detailText}`);
    }
    await markedDetail.getByRole('button', { name: 'Approve', exact: true }).click();
    await supervisorPage.locator('#reviewQueueFeedback').getByText('Record approved.').waitFor({ timeout: 15000 });
    await supervisorPage.waitForFunction(() => {
      const metricValue = (containerSelector, label) => {
        const item = [...document.querySelectorAll(`${containerSelector} > *`)]
          .find((element) => element.querySelector('span')?.textContent.trim() === label);
        return Number(item?.querySelector('strong')?.textContent || 0);
      };
      return (
        metricValue('#supervisorSummary', 'Reviewed') > 0
        && metricValue('#analyticsMetrics', 'Records') > 0
        && document.querySelectorAll('#reviewQueueList .record-card').length === 0
        && document.querySelector('#reviewQueueDetail .review-detail-empty')
      );
    }, undefined, { timeout: 20000 });
  } finally {
    await supervisorContext.close();
  }
}

async function checkOfflineReviewQueueReadOnly(browser) {
  const context = await newContext(browser, {
    viewport: { width: 1280, height: 900 },
    isMobile: false,
    hasTouch: false
  });
  const page = await context.newPage();

  try {
    await loginAs(page, 'supervisor@example.com', 'supervisor');
    await openAdminWorkspace(page, 'review');
    await page.locator('#reviewQueueDetails').evaluate((element) => {
      element.open = true;
    });
    await page.locator('#reviewQueueList .record-card').first().waitFor({ timeout: 20000 });
    await page.evaluate(async () => {
      const { put } = await import('/assets/js/db.js');
      await put('records', {
        id: 'local-only-supervisor-trap',
        type: 'attendance',
        userId: 'foreign-worker',
        userName: 'LOCAL ONLY MUST NOT APPEAR',
        siteName: 'Device-only site',
        action: 'check_in',
        status: 'pending',
        createdAt: new Date().toISOString()
      });
    });

    await page.route('**/supervisor/review-queue**', (route) => route.abort('failed'));
    await page.locator('#refreshSupervisorButton').click();
    await page.locator('#reviewQueueNotice .review-queue-read-only').waitFor({ timeout: 20000 });
    const offlineState = await page.evaluate(() => ({
      text: document.querySelector('#reviewQueueDetails')?.textContent || '',
      decisionButtons: [...document.querySelectorAll('#reviewQueueDetails .record-actions button')]
        .filter((button) => ['Approve', 'Reject'].includes(button.textContent.trim())).length,
      editButtons: [...document.querySelectorAll('#reviewQueueDetails .record-actions button')]
        .filter((button) => button.textContent.trim() === 'Edit').length,
      exportAttendanceDisabled: document.querySelector('#exportAttendanceButton')?.disabled,
      exportTaskDisabled: document.querySelector('#exportTaskLogsButton')?.disabled,
      exportDocumentDisabled: document.querySelector('#exportDocumentButton')?.disabled
    }));
    if (offlineState.text.includes('LOCAL ONLY MUST NOT APPEAR')) {
      throw new Error('offline Supervisor Review Queue exposed a device-local Worker record');
    }
    if (
      offlineState.decisionButtons
      || offlineState.editButtons
      || !offlineState.exportAttendanceDisabled
      || !offlineState.exportTaskDisabled
      || !offlineState.exportDocumentDisabled
    ) {
      throw new Error(`offline Review Queue exposed durable mutations: ${JSON.stringify(offlineState)}`);
    }

    await page.unroute('**/supervisor/review-queue**');
    await page.locator('#refreshSupervisorButton').click();
    await page.locator('#reviewQueueNotice .review-queue-read-only').waitFor({ state: 'detached', timeout: 20000 });
    await page.locator('#reviewQueueList .record-card').first().waitFor({ timeout: 20000 });
  } finally {
    await context.close();
  }
}

async function checkSupervisorReviewDeskLayout(browser) {
  const context = await newContext(browser, {
    viewport: { width: 1280, height: 900 },
    isMobile: false,
    hasTouch: false
  });
  const page = await context.newPage();

  try {
    await loginAs(page, 'supervisor@example.com', 'supervisor');
    await openAdminWorkspace(page, 'review');
    await page.locator('#reviewQueueDetails').evaluate((element) => {
      element.open = true;
    });
    await page.locator('#reviewQueueList .review-queue-item').first().waitFor({ timeout: 20000 });
    const desktopLayout = await page.evaluate(() => {
      const inbox = document.querySelector('.review-inbox')?.getBoundingClientRect();
      const detail = document.querySelector('.review-detail-shell')?.getBoundingClientRect();
      return inbox && detail ? { inbox: { x: inbox.x, y: inbox.y }, detail: { x: detail.x, y: detail.y } } : null;
    });
    if (!desktopLayout || desktopLayout.detail.x <= desktopLayout.inbox.x || Math.abs(desktopLayout.detail.y - desktopLayout.inbox.y) > 4) {
      throw new Error(`Review Desk did not render side-by-side on desktop: ${JSON.stringify(desktopLayout)}`);
    }

    await page.setViewportSize({ width: 700, height: 900 });
    const mobileLayout = await page.evaluate(() => {
      const inbox = document.querySelector('.review-inbox')?.getBoundingClientRect();
      const detail = document.querySelector('.review-detail-shell')?.getBoundingClientRect();
      return inbox && detail ? {
        inbox: { x: inbox.x, y: inbox.y, bottom: inbox.bottom },
        detail: { x: detail.x, y: detail.y },
        overflow: document.documentElement.scrollWidth - window.innerWidth
      } : null;
    });
    if (!mobileLayout || mobileLayout.detail.y < mobileLayout.inbox.bottom || mobileLayout.overflow > 1) {
      throw new Error(`Review Desk did not stack cleanly on a narrow viewport: ${JSON.stringify(mobileLayout)}`);
    }
  } finally {
    await context.close();
  }
}

async function checkSupervisorWorkspaceNavigation(browser) {
  const context = await newContext(browser, {
    viewport: { width: 1280, height: 900 },
    isMobile: false,
    hasTouch: false
  });
  const page = await context.newPage();
  const expectedWorkspaces = ['overview', 'review', 'reports', 'people', 'forms', 'audit'];

  try {
    await loginAs(page, 'supervisor@example.com', 'supervisor');
    await page.locator('[data-admin-workspace-panel="overview"]').waitFor({ state: 'visible', timeout: 15000 });

    const desktopState = await page.evaluate(() => ({
      desktopNavVisible: getComputedStyle(document.querySelector('.admin-desktop-nav')).display !== 'none',
      mobileToolbarVisible: getComputedStyle(document.querySelector('.admin-mobile-toolbar')).display !== 'none',
      targets: [...document.querySelectorAll('.admin-desktop-nav [data-admin-workspace-target]')]
        .map((link) => link.dataset.adminWorkspaceTarget),
      visiblePanels: [...document.querySelectorAll('[data-admin-workspace-panel]')]
        .filter((panel) => !panel.hidden)
        .map((panel) => panel.dataset.adminWorkspacePanel),
      current: document.querySelector('.admin-desktop-nav [aria-current="page"]')?.dataset.adminWorkspaceTarget || ''
    }));
    if (
      !desktopState.desktopNavVisible
      || desktopState.mobileToolbarVisible
      || JSON.stringify(desktopState.targets) !== JSON.stringify(expectedWorkspaces)
      || JSON.stringify(desktopState.visiblePanels) !== JSON.stringify(['overview'])
      || desktopState.current !== 'overview'
    ) {
      throw new Error(`desktop supervisor workspaces were not initialized: ${JSON.stringify(desktopState)}`);
    }

    await page.locator('.admin-desktop-nav [data-admin-workspace-target="reports"]').click();
    await page.locator('[data-admin-workspace-panel="reports"]').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.activeElement?.id === 'adminReportsWorkspaceTitle');
    const reportsState = await page.evaluate(() => ({
      overviewHidden: document.querySelector('[data-admin-workspace-panel="overview"]')?.hidden,
      analyticsVisible: document.querySelector('#managementAnalyticsDetails')?.getClientRects().length > 0,
      exportsTop: document.querySelector('.admin-reports-layout > .reports-exports-card')?.getBoundingClientRect().top,
      exportsRight: document.querySelector('.admin-reports-layout > .reports-exports-card')?.getBoundingClientRect().right,
      analyticsTop: document.querySelector('#managementAnalyticsDetails')?.getBoundingClientRect().top,
      analyticsLeft: document.querySelector('#managementAnalyticsDetails')?.getBoundingClientRect().left,
      current: document.querySelector('.admin-desktop-nav [aria-current="page"]')?.dataset.adminWorkspaceTarget || '',
      focused: document.activeElement?.id || ''
    }));
    if (
      !reportsState.overviewHidden
      || !reportsState.analyticsVisible
      || Math.abs(reportsState.exportsTop - reportsState.analyticsTop) > 1
      || reportsState.analyticsLeft < reportsState.exportsRight
      || reportsState.current !== 'reports'
      || reportsState.focused !== 'adminReportsWorkspaceTitle'
    ) {
      throw new Error(`Reports workspace did not activate cleanly: ${JSON.stringify(reportsState)}`);
    }

    await page.goBack({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-admin-workspace-panel="overview"]').waitFor({ state: 'visible' });
    if (await page.locator('.admin-desktop-nav [aria-current="page"]').getAttribute('data-admin-workspace-target') !== 'overview') {
      throw new Error('browser Back did not restore the default Overview workspace');
    }

    await page.goForward({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-admin-workspace-panel="reports"]').waitFor({ state: 'visible' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-admin-workspace-panel="reports"]').waitFor({ state: 'visible', timeout: 15000 });
    if (await page.locator('.admin-desktop-nav [aria-current="page"]').getAttribute('data-admin-workspace-target') !== 'reports') {
      throw new Error('workspace URL did not survive Forward navigation and reload');
    }

    await page.locator('.admin-desktop-nav [data-admin-workspace-target="overview"]').click();
    await page.locator('#adminOverview .admin-command-link[href="#reviewQueueDetails"]').click();
    await page.locator('[data-admin-workspace-panel="review"]').waitFor({ state: 'visible' });
    const deepLinkState = await page.evaluate(() => ({
      detailsOpen: document.querySelector('#reviewQueueDetails')?.open,
      current: document.querySelector('.admin-desktop-nav [aria-current="page"]')?.dataset.adminWorkspaceTarget || ''
    }));
    if (!deepLinkState.detailsOpen || deepLinkState.current !== 'review') {
      throw new Error(`workspace quick link did not reveal Review: ${JSON.stringify(deepLinkState)}`);
    }

    const wideReviewState = await page.evaluate(() => {
      const attendance = document.querySelector('.admin-review-layout > .manual-attendance-card')?.getBoundingClientRect();
      const task = document.querySelector('.admin-review-layout > .admin-task-log-card')?.getBoundingClientRect();
      return attendance && task ? {
        sameRow: Math.abs(attendance.top - task.top) <= 1,
        separateColumns: task.left >= attendance.right
      } : null;
    });
    if (!wideReviewState?.sameRow || !wideReviewState.separateColumns) {
      throw new Error(`wide Review entry cards did not share two columns: ${JSON.stringify(wideReviewState)}`);
    }

    await page.setViewportSize({ width: 1000, height: 900 });
    const compactDesktopState = await page.evaluate(() => {
      const inbox = document.querySelector('.review-inbox')?.getBoundingClientRect();
      const detail = document.querySelector('.review-detail-shell')?.getBoundingClientRect();
      return inbox && detail ? {
        stacked: detail.top >= inbox.bottom,
        overflow: document.documentElement.scrollWidth - window.innerWidth
      } : null;
    });
    if (!compactDesktopState?.stacked || compactDesktopState.overflow > 1) {
      throw new Error(`compact desktop Review Desk did not stack safely: ${JSON.stringify(compactDesktopState)}`);
    }

    await page.setViewportSize({ width: 820, height: 900 });
    const tabletState = await page.evaluate(() => ({
      attendanceColumns: getComputedStyle(document.querySelector('.manual-attendance-form')).gridTemplateColumns.split(' ').length,
      taskColumns: getComputedStyle(document.querySelector('.admin-task-log-form')).gridTemplateColumns.split(' ').length,
      overflow: document.documentElement.scrollWidth - window.innerWidth
    }));
    if (tabletState.attendanceColumns !== 2 || tabletState.taskColumns !== 2 || tabletState.overflow > 1) {
      throw new Error(`tablet Review forms did not use the compact two-column layout: ${JSON.stringify(tabletState)}`);
    }

    await page.setViewportSize({ width: 700, height: 900 });
    const responsiveState = await page.evaluate(() => ({
      desktopNavVisible: getComputedStyle(document.querySelector('.admin-desktop-nav')).display !== 'none',
      mobileToolbarVisible: getComputedStyle(document.querySelector('.admin-mobile-toolbar')).display !== 'none',
      attendanceColumns: getComputedStyle(document.querySelector('.manual-attendance-form')).gridTemplateColumns.split(' ').length,
      taskColumns: getComputedStyle(document.querySelector('.admin-task-log-form')).gridTemplateColumns.split(' ').length,
      overflow: document.documentElement.scrollWidth - window.innerWidth
    }));
    if (
      responsiveState.desktopNavVisible
      || !responsiveState.mobileToolbarVisible
      || responsiveState.attendanceColumns !== 1
      || responsiveState.taskColumns !== 1
      || responsiveState.overflow > 1
    ) {
      throw new Error(`mobile supervisor navigation did not replace the desktop rail: ${JSON.stringify(responsiveState)}`);
    }

    await page.locator('#adminMobileMenuButton').click();
    await page.locator('#adminWorkspaceDrawer[open]').waitFor({ state: 'visible' });
    const drawerTargets = await page.locator('#adminWorkspaceDrawer [data-admin-workspace-target]').evaluateAll(
      (links) => links.map((link) => link.dataset.adminWorkspaceTarget)
    );
    if (JSON.stringify(drawerTargets) !== JSON.stringify(expectedWorkspaces)) {
      throw new Error(`mobile workspace drawer targets were incomplete: ${JSON.stringify(drawerTargets)}`);
    }

    await page.evaluate(() => {
      const panel = document.querySelector('#supervisorEditPanel');
      const form = document.querySelector('#editPanelForm');
      panel.classList.remove('hidden');
      form.innerHTML = '<input value="Unsaved workspace edit">';
    });
    await page.locator('#adminWorkspaceDrawer [data-admin-workspace-target="people"]').click();
    await page.locator('[data-admin-workspace-panel="people"]').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.activeElement?.id === 'adminPeopleWorkspaceTitle');
    const peopleState = await page.evaluate(() => ({
      drawerOpen: document.querySelector('#adminWorkspaceDrawer')?.open,
      editorHidden: document.querySelector('#supervisorEditPanel')?.classList.contains('hidden'),
      editorEmpty: !document.querySelector('#editPanelForm')?.children.length,
      focused: document.activeElement?.id || '',
      label: document.querySelector('#adminMobileWorkspaceLabel')?.textContent?.trim() || '',
      currentCount: document.querySelectorAll('[data-admin-workspace-target="people"][aria-current="page"]').length
    }));
    if (
      peopleState.drawerOpen
      || !peopleState.editorHidden
      || !peopleState.editorEmpty
      || peopleState.focused !== 'adminPeopleWorkspaceTitle'
      || peopleState.label !== 'People & Sites'
      || peopleState.currentCount !== 2
    ) {
      throw new Error(`mobile People & Sites navigation lost state or focus: ${JSON.stringify(peopleState)}`);
    }

    await page.locator('#adminMobileMenuButton').click();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (
      document.querySelector('#adminWorkspaceDrawer')?.open === false
      && document.activeElement?.id === 'adminMobileMenuButton'
    ));

    await page.locator('#adminMobileMenuButton').click();
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.waitForFunction(() => (
      document.querySelector('#adminWorkspaceDrawer')?.open === false
      && document.activeElement?.dataset.adminWorkspaceTarget === 'people'
      && document.activeElement?.closest('.admin-desktop-nav')
    ));

    await page.setViewportSize({ width: 700, height: 900 });
    await page.locator('#adminMobileMenuButton').click();
    await page.route('**/api/supervisor/review-queue*', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Workspace session expired.' })
      });
    });
    await page.locator('#refreshSupervisorButton').evaluate((button) => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.locator('#loginView').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForFunction(() => (
      document.querySelector('#adminWorkspaceDrawer')?.open === false
      && document.activeElement?.id === 'emailInput'
    ));
  } finally {
    await context.close();
  }
}

function installWaitingServiceWorkerMock() {
  window.__serviceWorkerMessages = [];
  const listeners = new Map();
  const waitingWorker = {
    state: 'installed',
    postMessage(message) {
      window.__serviceWorkerMessages.push({
        ...message,
        autosaveStatus: document.querySelector('#workFormAutosaveStatus')?.textContent?.trim() || '',
        savedAt: document.querySelector('#workFormAutosaveStatus')?.dataset.savedAt || ''
      });
    },
    addEventListener() {}
  };
  const mockServiceWorker = {
    controller: {},
    addEventListener(type, callback) {
      listeners.set(type, callback);
    },
    async register() {
      return {
        waiting: waitingWorker,
        installing: null,
        addEventListener() {}
      };
    }
  };

  Object.defineProperty(Navigator.prototype, 'serviceWorker', {
    configurable: true,
    get() {
      return mockServiceWorker;
    }
  });
}

async function checkWorkFormAutosaveAndUpdateProtection(browser) {
  const context = await newContext(browser, { initScript: installWaitingServiceWorkerMock });
  const page = await context.newPage();
  const inspectionMarker = 'North elevation final inspection draft';
  const dayworkMarker = 'Client draft retained independently';
  const logoutMarker = 'Latest draft survives immediate logout';
  const latestUpdateMarker = 'Latest edit before protected update';
  let workerId = '';

  const waitForDraftAnswer = async (formId, fieldId, expected) => {
    await page.waitForFunction(async ({ selectedWorkerId, selectedFormId, selectedFieldId, expectedValue }) => {
      const { openDb } = await import('/assets/js/db.js');
      const db = await openDb();
      const drafts = await new Promise((resolve, reject) => {
        const request = db.transaction('drafts', 'readonly').objectStore('drafts').getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      }).finally(() => db.close());
      const expectedKey = `work-form-draft:${selectedWorkerId}:${selectedFormId}`;
      return drafts.some((item) => (
        item.key === expectedKey
        && item.value?.kind === 'work-form'
        && String(item.value.ownerWorkerId) === String(selectedWorkerId)
        && String(item.value.formId) === String(selectedFormId)
        && item.value.answers?.[selectedFieldId] === expectedValue
      ));
    }, {
      selectedWorkerId: workerId,
      selectedFormId: formId,
      selectedFieldId: fieldId,
      expectedValue: expected
    }, { timeout: 15000, polling: 100 });
  };

  try {
    await loginAs(page, 'worker@example.com', 'worker');
    workerId = await page.evaluate(async () => String((await import('/assets/js/app-shell-state.js')).state.user?.id || ''));
    await page.locator('.tab[data-tab-target="formTab"]').click();
    await page.waitForFunction(() => (
      [...document.querySelectorAll('#workFormSelect option')]
        .some((option) => option.textContent === 'Inspection form')
    ));
    await page.evaluate(() => window.dispatchEvent(new Event('load')));
    await page.locator('#updateButton').waitFor({ state: 'visible', timeout: 15000 });

    const formIds = await page.locator('#workFormSelect').evaluate((select) => Object.fromEntries(
      [...select.options]
        .filter((option) => option.value)
        .map((option) => [option.textContent.trim(), option.value])
    ));
    const inspectionFormId = formIds['Inspection form'];
    const dayworkFormId = formIds['Daywork log form'];
    if (!inspectionFormId || !dayworkFormId) {
      throw new Error(`expected seeded Work Forms, got ${JSON.stringify(formIds)}`);
    }

    await page.evaluate(async ({ foreignFormId }) => {
      const { saveDraft } = await import('/assets/js/mock-api.js');
      await saveDraft(`work-form-draft:foreign-worker:${foreignFormId}`, {
        kind: 'work-form',
        schemaVersion: 1,
        ownerWorkerId: 'foreign-worker',
        formId: foreignFormId,
        formName: 'Inspection form',
        definitionVersion: 1,
        siteId: '',
        workDate: '',
        answers: { inspection_area: 'Foreign Worker draft must stay isolated' },
        photoDataUrls: [],
        photoMetadata: [],
        savedAt: new Date().toISOString()
      });
    }, { foreignFormId: inspectionFormId });

    await page.locator('#workFormSelect').selectOption(inspectionFormId);
    await page.locator('#workFormField_inspection_area').waitFor({ state: 'visible' });
    await page.locator('#workFormField_inspection_area').fill('North elevation draft');
    await page.locator('#workFormField_inspection_area').fill(inspectionMarker);
    await page.locator('#workFormSite').selectOption({ index: 1 });
    const inspectionSiteId = await page.locator('#workFormSite').inputValue();
    await page.locator('#workFormDate').fill('2026-07-20');
    await waitForDraftAnswer(inspectionFormId, 'inspection_area', inspectionMarker);
    await page.waitForFunction(() => (
      document.querySelector('#workFormAutosaveStatus')?.textContent?.trim().startsWith('Saved at ')
      && document.querySelector('#workFormAutosaveStatus')?.dataset.savedAt
    ));

    const savedStatus = await page.locator('#workFormAutosaveStatus').evaluate((element) => ({
      live: element.getAttribute('aria-live'),
      atomic: element.getAttribute('aria-atomic'),
      savedAt: element.dataset.savedAt || '',
      text: element.textContent.trim()
    }));
    if (savedStatus.live !== 'polite' || savedStatus.atomic !== 'true' || !savedStatus.savedAt) {
      throw new Error(`Work Form Saved at receipt is not accessible: ${JSON.stringify(savedStatus)}`);
    }
    const persistedSavedAt = await page.evaluate(async ({ selectedWorkerId, selectedFormId }) => {
      const { getDraft } = await import('/assets/js/mock-api.js');
      return (await getDraft(`work-form-draft:${selectedWorkerId}:${selectedFormId}`))?.savedAt || '';
    }, { selectedWorkerId: workerId, selectedFormId: inspectionFormId });
    if (persistedSavedAt !== savedStatus.savedAt) {
      throw new Error(`Saved at receipt did not match committed storage: ${JSON.stringify({ persistedSavedAt, savedStatus })}`);
    }

    await page.locator('#workFormSelect').selectOption(dayworkFormId);
    await page.locator('#workFormField_client').waitFor({ state: 'visible' });
    await page.locator('#workFormField_client').fill(dayworkMarker);
    await waitForDraftAnswer(dayworkFormId, 'client', dayworkMarker);

    await page.locator('#workFormSelect').selectOption(inspectionFormId);
    await page.waitForFunction(({ expected, expectedSiteId }) => (
      document.querySelector('#workFormField_inspection_area')?.value === expected
      && document.querySelector('#workFormDate')?.value === '2026-07-20'
      && document.querySelector('#workFormSite')?.value === expectedSiteId
    ), { expected: inspectionMarker, expectedSiteId: inspectionSiteId });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.dataset.activeView === 'worker');
    await page.locator('.tab[data-tab-target="formTab"]').click();
    await page.waitForFunction(() => (
      [...document.querySelectorAll('#workFormSelect option')]
        .some((option) => option.textContent === 'Inspection form')
    ));
    await page.locator('#workFormSelect').selectOption(inspectionFormId);
    await page.waitForFunction(({ expected, expectedSiteId }) => (
      document.querySelector('#workFormField_inspection_area')?.value === expected
      && document.querySelector('#workFormDate')?.value === '2026-07-20'
      && document.querySelector('#workFormSite')?.value === expectedSiteId
    ), { expected: inspectionMarker, expectedSiteId: inspectionSiteId });

    await page.locator('#submitWorkFormButton').click();
    await page.waitForFunction(() => document.activeElement?.id === 'workFormField_inspection_result');
    await waitForDraftAnswer(inspectionFormId, 'inspection_area', inspectionMarker);
    await page.locator('#workFormField_inspection_result').selectOption('Pass');
    await page.locator('#submitWorkFormButton').click();
    await page.locator('#workFormFeedback[role="status"]')
      .getByText('Inspection form submitted for approval.')
      .waitFor({ timeout: 20000 });
    await page.waitForFunction(async ({ selectedWorkerId, clearedFormId, remainingFormId }) => {
      const { openDb } = await import('/assets/js/db.js');
      const db = await openDb();
      const drafts = await new Promise((resolve, reject) => {
        const request = db.transaction('drafts', 'readonly').objectStore('drafts').getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      }).finally(() => db.close());
      return !drafts.some((item) => item.key === `work-form-draft:${selectedWorkerId}:${clearedFormId}`)
        && drafts.some((item) => item.key === `work-form-draft:${selectedWorkerId}:${remainingFormId}`)
        && drafts.some((item) => item.key === `work-form-draft:foreign-worker:${clearedFormId}`);
    }, {
      selectedWorkerId: workerId,
      clearedFormId: inspectionFormId,
      remainingFormId: dayworkFormId
    }, { timeout: 15000, polling: 100 });

    await page.locator('#workFormSelect').selectOption(dayworkFormId);
    await page.waitForFunction((expected) => document.querySelector('#workFormField_client')?.value === expected, dayworkMarker);
    await page.locator('#workFormField_client').fill(logoutMarker);
    await page.locator('#logoutButton').click();
    await page.locator('#loginView').waitFor({ state: 'visible', timeout: 15000 });
    await loginAs(page, 'worker@example.com', 'worker');
    await page.locator('.tab[data-tab-target="formTab"]').click();
    await page.waitForFunction(() => [...document.querySelectorAll('#workFormSelect option')]
      .some((option) => option.textContent === 'Daywork log form'));
    await page.locator('#workFormSelect').selectOption(dayworkFormId);
    await page.waitForFunction((expected) => document.querySelector('#workFormField_client')?.value === expected, logoutMarker);
    await page.evaluate(() => {
      window.__originalDraftPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function put(value, ...args) {
        if (this.name === 'drafts' && String(value?.key || '').startsWith('work-form-draft:')) {
          throw new DOMException('Draft storage unavailable for test.', 'QuotaExceededError');
        }
        return window.__originalDraftPut.call(this, value, ...args);
      };
    });
    await page.locator('#workFormField_client').fill(latestUpdateMarker);
    await page.locator('#workFormSelect').selectOption(inspectionFormId);
    await page.waitForFunction((expectedFormId) => (
      document.querySelector('#workFormSelect')?.value === expectedFormId
      && document.querySelector('#workFormAutosaveStatus')?.textContent?.includes('not saved')
    ), dayworkFormId);
    const immediateMessages = await page.evaluate(() => {
      document.querySelector('#updateButton').click();
      return window.__serviceWorkerMessages.slice();
    });
    if (immediateMessages.length) {
      throw new Error(`app update bypassed the pending Work Form save: ${JSON.stringify(immediateMessages)}`);
    }

    await page.locator('#appUpdatePausedDialog[open]').waitFor({ state: 'visible', timeout: 10000 });
    const blockedState = await page.evaluate(() => ({
      messages: window.__serviceWorkerMessages,
      busy: document.querySelector('#updateButton')?.getAttribute('aria-busy'),
      status: document.querySelector('#workFormAutosaveStatus')?.textContent?.trim() || ''
    }));
    if (blockedState.messages.length || blockedState.busy !== null || !blockedState.status.includes('not saved')) {
      throw new Error(`failed draft save did not pause the update safely: ${JSON.stringify(blockedState)}`);
    }

    await page.evaluate(() => {
      IDBObjectStore.prototype.put = window.__originalDraftPut;
    });
    await page.locator('#retryAppUpdateButton').click();
    await page.waitForFunction(() => window.__serviceWorkerMessages.some((message) => message?.type === 'SKIP_WAITING'));
    const updateMessage = await page.evaluate(() => window.__serviceWorkerMessages.find((message) => message?.type === 'SKIP_WAITING'));
    if (!updateMessage.autosaveStatus.startsWith('Saved at ') || !updateMessage.savedAt) {
      throw new Error(`SKIP_WAITING was sent before the latest draft receipt: ${JSON.stringify(updateMessage)}`);
    }
    await waitForDraftAnswer(dayworkFormId, 'client', latestUpdateMarker);
  } finally {
    await context.close();
  }
}

async function checkKeyboardAccessibleRequiredSignature(browser) {
  const context = await newContext(browser, {
    isMobile: false,
    hasTouch: false,
    viewport: { width: 900, height: 720 }
  });
  const page = await context.newPage();

  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const initialState = await page.evaluate(async () => {
      const { collectWorkFormAnswers, renderWorkFormFields } = await import('/assets/js/work-form-fields.js');
      const fixture = document.createElement('section');
      fixture.id = 'signatureAccessibilityFixture';
      document.body.append(fixture);

      const form = {
        fields: [{ id: 'approval', label: 'Approval', type: 'signature', required: true }]
      };
      const options = { container: fixture, idPrefix: 'accessibilitySignature' };
      renderWorkFormFields(fixture, form, options);

      const canvas = fixture.querySelector('[data-signature-canvas]');
      let inputEvents = 0;
      let changeEvents = 0;
      canvas.addEventListener('input', () => { inputEvents += 1; });
      canvas.addEventListener('change', () => { changeEvents += 1; });

      let validation = null;
      try {
        collectWorkFormAnswers(form, options);
      } catch (error) {
        validation = { name: error.name, fieldId: error.fieldId };
      }

      window.__signatureAccessibility = {
        collect: () => collectWorkFormAnswers(form, options),
        eventCounts: () => ({ inputEvents, changeEvents })
      };

      const describedBy = (canvas.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
      return {
        canvasId: canvas.id,
        invalid: canvas.getAttribute('aria-invalid'),
        validation,
        role: canvas.getAttribute('role'),
        roleDescription: canvas.getAttribute('aria-roledescription'),
        labelled: Boolean(document.getElementById(canvas.getAttribute('aria-labelledby'))),
        descriptions: describedBy.map((id) => ({
          id,
          text: document.getElementById(id)?.textContent || '',
          role: document.getElementById(id)?.getAttribute('role') || '',
          live: document.getElementById(id)?.getAttribute('aria-live') || ''
        }))
      };
    });

    if (
      initialState.validation?.name !== 'WorkFormValidationError'
      || initialState.validation?.fieldId !== initialState.canvasId
      || initialState.invalid !== 'true'
    ) {
      throw new Error(`required keyboard signature did not expose accessible validation: ${JSON.stringify(initialState)}`);
    }
    const instructionText = initialState.descriptions.map((item) => item.text).join(' ');
    const liveStatus = initialState.descriptions.find((item) => item.role === 'status');
    if (
      initialState.role !== 'application'
      || initialState.roleDescription !== 'signature pad'
      || !initialState.labelled
      || !/keyboard/i.test(instructionText)
      || !/arrow/i.test(instructionText)
      || liveStatus?.live !== 'polite'
    ) {
      throw new Error(`signature keyboard semantics were incomplete: ${JSON.stringify(initialState)}`);
    }

    const canvas = page.locator('#accessibilitySignature_approval');
    await canvas.focus();
    const focusStyle = await canvas.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth) || 0,
        outlineOffset: Number.parseFloat(style.outlineOffset) || 0
      };
    });
    if (focusStyle.outlineStyle === 'none' || focusStyle.outlineWidth < 3 || focusStyle.outlineOffset < 2) {
      throw new Error(`signature keyboard focus was not clearly visible: ${JSON.stringify(focusStyle)}`);
    }

    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Enter');

    const signedState = await page.evaluate(() => {
      const canvasElement = document.querySelector('#accessibilitySignature_approval');
      const answers = window.__signatureAccessibility.collect();
      return {
        signed: canvasElement.dataset.signed,
        keyboardDrawing: canvasElement.dataset.signatureKeyboardDrawing,
        invalid: canvasElement.getAttribute('aria-invalid'),
        answer: answers.approval,
        events: window.__signatureAccessibility.eventCounts()
      };
    });
    if (
      signedState.signed !== 'true'
      || signedState.keyboardDrawing !== 'false'
      || signedState.invalid !== null
      || !signedState.answer.startsWith('data:image/png;base64,')
      || signedState.events.inputEvents !== 1
      || signedState.events.changeEvents !== 1
    ) {
      throw new Error(`keyboard signature was not captured like a pointer signature: ${JSON.stringify(signedState)}`);
    }

    await page.getByRole('button', { name: 'Clear Approval signature' }).focus();
    await page.keyboard.press('Enter');
    const clearedState = await page.evaluate(() => {
      const canvasElement = document.querySelector('#accessibilitySignature_approval');
      const statusId = canvasElement.dataset.signatureStatus;
      let validation = null;
      try {
        window.__signatureAccessibility.collect();
      } catch (error) {
        validation = { name: error.name, fieldId: error.fieldId };
      }
      return {
        signed: canvasElement.dataset.signed,
        status: document.getElementById(statusId)?.textContent || '',
        validation,
        events: window.__signatureAccessibility.eventCounts()
      };
    });
    if (
      clearedState.signed !== 'false'
      || !/blank/i.test(clearedState.status)
      || clearedState.validation?.name !== 'WorkFormValidationError'
      || clearedState.validation?.fieldId !== initialState.canvasId
      || clearedState.events.changeEvents !== 2
    ) {
      throw new Error(`keyboard signature Clear did not restore the required state: ${JSON.stringify(clearedState)}`);
    }
  } finally {
    await context.close();
  }
}

async function checkPhotoViewerFocusManagement(browser) {
  const context = await newContext(browser, {
    isMobile: false,
    hasTouch: false,
    viewport: { width: 900, height: 720 }
  });
  const page = await context.newPage();

  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => {
      const { createPhotoViewer } = await import('/assets/js/photo-viewer.js');
      const fixture = document.createElement('section');
      fixture.id = 'photoViewerAccessibilityFixture';
      fixture.innerHTML = `
        <button id="photoViewerAccessibilityOpener" type="button">Open test photos</button>
        <button id="photoViewerAccessibilityOutside" type="button">Outside viewer</button>
        <button id="photoViewerAccessibilityPreInert" type="button" inert>Already inert</button>
        <div id="photoViewerAccessibilityDialog" class="photo-viewer hidden" role="dialog" aria-modal="true" aria-label="Test photo viewer">
          <div data-photo-viewer-close></div>
          <div>
            <p id="photoViewerAccessibilityCaption">Photo</p>
            <button id="photoViewerAccessibilityClose" type="button">Close</button>
            <img id="photoViewerAccessibilityImage" alt="" />
            <button id="photoViewerAccessibilityPrevious" type="button">Previous</button>
            <button id="photoViewerAccessibilityNext" type="button">Next</button>
          </div>
        </div>
      `;
      document.body.append(fixture);

      const dialog = fixture.querySelector('#photoViewerAccessibilityDialog');
      const viewer = createPhotoViewer({
        viewer: dialog,
        image: fixture.querySelector('#photoViewerAccessibilityImage'),
        caption: fixture.querySelector('#photoViewerAccessibilityCaption'),
        closeButton: fixture.querySelector('#photoViewerAccessibilityClose'),
        previousButton: fixture.querySelector('#photoViewerAccessibilityPrevious'),
        nextButton: fixture.querySelector('#photoViewerAccessibilityNext'),
        body: document.body
      });
      const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
      const opener = fixture.querySelector('#photoViewerAccessibilityOpener');
      opener.addEventListener('click', () => viewer.open([pixel, pixel], 0, 'Test photo'));
      viewer.bindEvents();
      viewer.bindEvents();
      window.__photoViewerAccessibility = {
        dialog,
        openOne: () => viewer.open([pixel], 0, 'Test photo')
      };
    });

    const opener = page.locator('#photoViewerAccessibilityOpener');
    await opener.click();
    const activeId = () => page.evaluate(() => document.activeElement?.id || '');
    if (await activeId() !== 'photoViewerAccessibilityClose') {
      throw new Error(`photo viewer did not focus Close on open; active=${await activeId()}`);
    }

    await page.keyboard.press('Tab');
    if (await activeId() !== 'photoViewerAccessibilityPrevious') throw new Error('photo viewer did not move focus to Previous');
    await page.keyboard.press('Tab');
    if (await activeId() !== 'photoViewerAccessibilityNext') throw new Error('photo viewer did not move focus to Next');
    await page.keyboard.press('Tab');
    if (await activeId() !== 'photoViewerAccessibilityClose') throw new Error('photo viewer did not wrap focus forward');
    await page.keyboard.press('Shift+Tab');
    if (await activeId() !== 'photoViewerAccessibilityNext') throw new Error('photo viewer did not wrap focus backward');

    await page.locator('#photoViewerAccessibilityOutside').evaluate((element) => element.focus());
    const containedFocus = await page.evaluate(() => (
      document.querySelector('#photoViewerAccessibilityDialog').contains(document.activeElement)
    ));
    if (!containedFocus) throw new Error(`photo viewer allowed focus to escape to ${await activeId()}`);

    const inertWhileOpen = await page.evaluate(() => ({
      opener: document.querySelector('#photoViewerAccessibilityOpener').inert,
      outside: document.querySelector('#photoViewerAccessibilityOutside').inert,
      preInert: document.querySelector('#photoViewerAccessibilityPreInert').inert
    }));
    if (!inertWhileOpen.opener || !inertWhileOpen.outside || !inertWhileOpen.preInert) {
      throw new Error(`photo viewer did not make background interaction inert: ${JSON.stringify(inertWhileOpen)}`);
    }

    await page.keyboard.press('Escape');
    const closedState = await page.evaluate(() => ({
      hidden: document.querySelector('#photoViewerAccessibilityDialog').classList.contains('hidden'),
      activeId: document.activeElement?.id || '',
      openerInert: document.querySelector('#photoViewerAccessibilityOpener').inert,
      outsideInert: document.querySelector('#photoViewerAccessibilityOutside').inert,
      preInert: document.querySelector('#photoViewerAccessibilityPreInert').inert
    }));
    if (
      !closedState.hidden
      || closedState.activeId !== 'photoViewerAccessibilityOpener'
      || closedState.openerInert
      || closedState.outsideInert
      || !closedState.preInert
    ) {
      throw new Error(`photo viewer did not restore focus/background state: ${JSON.stringify(closedState)}`);
    }

    await page.evaluate(() => window.__photoViewerAccessibility.openOne());
    await page.keyboard.press('Tab');
    if (await activeId() !== 'photoViewerAccessibilityClose') {
      throw new Error(`single-photo viewer did not skip disabled navigation; active=${await activeId()}`);
    }
    await page.keyboard.press('Shift+Tab');
    if (await activeId() !== 'photoViewerAccessibilityClose') {
      throw new Error(`single-photo viewer did not retain its only focus target; active=${await activeId()}`);
    }
    await page.locator('#photoViewerAccessibilityClose').click();
    if (await activeId() !== 'photoViewerAccessibilityOpener') {
      throw new Error(`photo viewer Close did not restore its opener; active=${await activeId()}`);
    }
  } finally {
    await context.close();
  }
}

async function checkPrimaryGradientContrast(browser) {
  const context = await newContext(browser, {
    isMobile: false,
    hasTouch: false,
    viewport: { width: 900, height: 720 }
  });
  const page = await context.newPage();

  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.addStyleTag({ content: '* { transition: none !important; }' });
    await page.evaluate(() => {
      const fixture = document.createElement('div');
      fixture.id = 'primaryContrastFixture';
      fixture.style.cssText = 'position:fixed;inset:8px auto auto 8px;z-index:1000;display:flex;gap:8px';
      fixture.innerHTML = `
        <button id="primaryContrastButton" type="button">Primary action</button>
        <a id="primaryContrastLink" class="admin-command-link primary" href="#">Primary workspace</a>
        <span id="primaryContrastStep" class="worker-task-number">1</span>
      `;
      document.body.append(fixture);

      const mobileTab = document.createElement('button');
      mobileTab.id = 'primaryContrastMobileTab';
      mobileTab.className = 'tab active';
      mobileTab.type = 'button';
      mobileTab.textContent = 'Active worker tab';
      document.querySelector('#workerView').append(mobileTab);
    });

    async function inspect(selector, state) {
      const locator = page.locator(selector);
      if (state === 'hover') await locator.hover();
      const result = await locator.evaluate((element) => {
        const parseRgb = (value) => {
          const match = value.match(/rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)/i);
          return match ? match.slice(1, 4).map(Number) : null;
        };
        const luminance = (rgb) => {
          const linear = rgb.map((channel) => {
            const value = channel / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          });
          return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
        };
        const style = getComputedStyle(element);
        const foreground = parseRgb(style.color);
        const stops = (style.backgroundImage.match(/rgba?\([^)]*\)/g) || []).map(parseRgb).filter(Boolean);
        const ratios = stops.map((background) => {
          const light = Math.max(luminance(foreground), luminance(background));
          const dark = Math.min(luminance(foreground), luminance(background));
          return (light + 0.05) / (dark + 0.05);
        });
        return { backgroundImage: style.backgroundImage, color: style.color, ratios };
      });
      if (!result.ratios.length || result.ratios.some((ratio) => ratio < 4.5)) {
        throw new Error(`${selector} ${state} gradient fails 4.5:1 contrast: ${JSON.stringify(result)}`);
      }
    }

    await inspect('#primaryContrastButton', 'normal');
    await inspect('#primaryContrastButton', 'hover');
    await inspect('#primaryContrastLink', 'normal');
    await inspect('#primaryContrastLink', 'hover');
    await inspect('#primaryContrastStep', 'normal');
    await inspect('#primaryContrastMobileTab', 'normal');
    await page.setViewportSize({ width: 390, height: 844 });
    await inspect('#primaryContrastMobileTab', 'normal');
  } finally {
    await context.close();
  }
}

async function checkServiceWorkerUpdatePrompt(browser) {
  const context = await newContext(browser, { initScript: installWaitingServiceWorkerMock });
  const page = await context.newPage();

  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      return document.querySelector('#syncIndicator')?.dataset.state !== 'checking';
    });
    await page.evaluate(() => window.dispatchEvent(new Event('load')));
    await page.locator('#updateButton').waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('#statusBanner').getByText('A new app version is ready').waitFor({ timeout: 5000 });
    await page.locator('#updateButton').click();
    await page.locator('#statusBanner').getByText('Updating app').waitFor({ timeout: 5000 });

    const messages = await page.evaluate(() => window.__serviceWorkerMessages);
    if (!messages.some((message) => message?.type === 'SKIP_WAITING')) {
      throw new Error(`expected SKIP_WAITING postMessage, got ${JSON.stringify(messages)}`);
    }
  } finally {
    await context.close();
  }
}

async function checkChineseTranslation(browser) {
  const initChinese = () => localStorage.setItem('leader-language', 'zh');
  const anonymousContext = await newContext(browser, { initScript: initChinese });
  const anonymousPage = await anonymousContext.newPage();

  try {
    await anonymousPage.goto('/', { waitUntil: 'domcontentloaded' });
    await anonymousPage.waitForFunction(() => (
      document.body.dataset.activeView === 'login'
      && document.querySelector('#syncIndicator')?.dataset.state !== 'checking'
    ));

    const chromeState = await anonymousPage.evaluate(() => ({
      language: document.documentElement.lang,
      notifications: document.querySelector('#toastViewport')?.getAttribute('aria-label') || ''
    }));
    if (chromeState.language !== 'zh-Hans' || chromeState.notifications !== '通知') {
      throw new Error(`Chinese app chrome was incomplete: ${JSON.stringify(chromeState)}`);
    }

    await anonymousPage.locator('#loginSubmitButton').click();
    await anonymousPage.locator('#loginFeedback').getByText('请填写此字段。').waitFor({ timeout: 5000 });
    if (await anonymousPage.locator('#loginFeedback').getByText('Please fill out this field.').count()) {
      throw new Error('required-field feedback remained in English');
    }

    await anonymousPage.locator('#emailInput').fill('not-an-email');
    await anonymousPage.locator('#passwordInput').fill(password);
    await anonymousPage.locator('#loginSubmitButton').click();
    await anonymousPage.locator('#loginFeedback').getByText('请输入有效的电子邮箱地址。').waitFor({ timeout: 5000 });

    await anonymousPage.locator('#emailInput').fill('missing-user@example.com');
    await anonymousPage.locator('#loginSubmitButton').click();
    await anonymousPage.locator('#loginFeedback').getByText('电子邮箱或密码错误').waitFor({ timeout: 10000 });

    if ((await anonymousPage.locator('#loginSubmitButton').innerText()).trim() !== '登录') {
      throw new Error('login button lost its Chinese label after the busy cycle');
    }
    await anonymousPage.locator('#languageToggleButton').click();
    await anonymousPage.waitForFunction(() => document.documentElement.lang === 'en-NZ');
    const restoredLoginLabel = (await anonymousPage.locator('#loginSubmitButton').innerText()).trim();
    if (restoredLoginLabel !== 'Sign in') {
      throw new Error(`login button did not restore its canonical English label after the busy cycle: ${restoredLoginLabel}`);
    }
  } finally {
    await anonymousContext.close();
  }

  const supervisorContext = await newContext(browser, {
    initScript: initChinese,
    isMobile: false,
    hasTouch: false,
    viewport: { width: 1280, height: 900 }
  });
  const page = await supervisorContext.newPage();

  try {
    await loginAs(page, 'supervisor@example.com', 'supervisor');
    await openAdminWorkspace(page, 'forms');
    await page.locator('#addWorkFormFieldButton').click();
    const fieldCard = page.locator('#workFormFieldCards > [data-work-form-field-card]').first();
    await fieldCard.waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(() => (
      document.querySelector('#workFormFieldCards')?.getAttribute('aria-label') === '工作表单字段'
    ));

    const builderState = await fieldCard.evaluate((card) => ({
      text: card.innerText,
      labelPlaceholder: card.querySelector('[data-field-property="label"]')?.getAttribute('placeholder') || '',
      dragTitle: card.querySelector('[data-field-drag-handle]')?.getAttribute('title') || '',
      dragLabel: card.querySelector('[data-field-drag-handle]')?.getAttribute('aria-label') || ''
    }));
    if (
      builderState.labelPlaceholder !== '员工需要填写什么？'
      || builderState.dragTitle !== '拖动排序'
      || builderState.dragLabel !== '拖动未命名字段'
      || /\b(?:Field type|Required|Remove|New field)\b/.test(builderState.text)
    ) {
      throw new Error(`Chinese Work Form builder was incomplete: ${JSON.stringify(builderState)}`);
    }

    await fieldCard.locator('[data-field-property="type"]').selectOption('select');
    await page.locator('#workFormPreviewButton').click();
    const multiError = await fieldCard.locator('[data-work-form-field-error]').innerText();
    if (
      !multiError.includes('请为此字段添加标签。')
      || !multiError.includes('选择题至少需要一个选项。')
      || /\b(?:Add|label|field|Choice|needs|option)\b/i.test(multiError)
    ) {
      throw new Error(`multi-error Work Form validation was not fully translated: ${multiError}`);
    }

    const signatureState = await page.evaluate(async () => {
      const { applyLanguage } = await import('/assets/js/i18n.js');
      const { renderWorkFormFields } = await import('/assets/js/work-form-fields.js');
      const fixture = document.createElement('section');
      fixture.id = 'chineseSignatureFixture';
      document.body.append(fixture);
      renderWorkFormFields(fixture, {
        fields: [{ id: 'approval', label: 'Approval', type: 'signature', required: true }]
      }, { container: fixture, idPrefix: 'chineseSignature' });
      applyLanguage(fixture);
      const canvas = fixture.querySelector('[data-signature-canvas]');
      const descriptions = (canvas.getAttribute('aria-describedby') || '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent || '');
      return {
        roleDescription: canvas.getAttribute('aria-roledescription'),
        descriptions,
        requiredText: fixture.querySelector('.visually-hidden')?.textContent.trim() || ''
      };
    });
    if (
      signatureState.roleDescription !== '签名板'
      || signatureState.requiredText !== '（必填）'
      || signatureState.descriptions.some((text) => /\b(?:Keyboard|signature pad|blank)\b/i.test(text))
    ) {
      throw new Error(`Chinese signature instructions were incomplete: ${JSON.stringify(signatureState)}`);
    }

    const signatureCanvas = page.locator('#chineseSignature_approval');
    await signatureCanvas.focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (
      document.querySelector('#chineseSignature_approval_status')?.textContent === '键盘绘制已停止。签名已记录。'
    ));

    const photoState = await page.evaluate(async () => {
      const { createPhotoViewer } = await import('/assets/js/photo-viewer.js');
      const fixture = document.createElement('section');
      fixture.className = 'hidden';
      fixture.innerHTML = '<button data-photo-viewer-close>close</button><button data-previous>previous</button><button data-next>next</button><img><p></p>';
      document.body.append(fixture);
      const image = fixture.querySelector('img');
      const caption = fixture.querySelector('p');
      const viewer = createPhotoViewer({
        viewer: fixture,
        image,
        caption,
        closeButton: fixture.querySelector('[data-photo-viewer-close]'),
        previousButton: fixture.querySelector('[data-previous]'),
        nextButton: fixture.querySelector('[data-next]')
      });
      viewer.open([
        'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
        'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
      ], 0, 'Photo');
      const result = { alt: image.alt, caption: caption.textContent };
      viewer.close();
      fixture.remove();
      return result;
    });
    if (photoState.alt !== '照片 1' || photoState.caption !== '照片 1 / 2') {
      throw new Error(`dynamic photo text was not translated: ${JSON.stringify(photoState)}`);
    }

    await page.locator('#languageToggleButton').click();
    await page.waitForFunction(() => document.documentElement.lang === 'en-NZ');
    const restored = await page.evaluate(() => ({
      notifications: document.querySelector('#toastViewport')?.getAttribute('aria-label') || '',
      builderLabel: document.querySelector('#workFormFieldCards')?.getAttribute('aria-label') || ''
    }));
    if (restored.notifications !== 'Notifications' || restored.builderLabel !== 'Work form fields') {
      throw new Error(`English labels were not restored after language toggle: ${JSON.stringify(restored)}`);
    }
  } finally {
    await supervisorContext.close();
  }
}

async function main() {
  await setupServers();

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    throw new Error(
      `Could not launch Playwright Chromium. Run "npx playwright install chromium" once, then retry. ${error.message}`
    );
  }

  try {
    await runCheck('action feedback is local, busy, announced, and separate from sync state', () => checkAccessibleActionFeedback(browser));
    await runCheck('Chinese translation covers validation, forms, signatures, and photos', () => checkChineseTranslation(browser));
    await runCheck('required signatures are fully keyboard accessible', () => checkKeyboardAccessibleRequiredSignature(browser));
    await runCheck('photo viewer traps and restores focus', () => checkPhotoViewerFocusManagement(browser));
    await runCheck('primary action gradients meet WCAG AA contrast', () => checkPrimaryGradientContrast(browser));
    await runCheck('anonymous login startup does not request or expose sites', () => checkAnonymousStartupDoesNotLoadSites(browser));
    await runCheck('restored session loads sites only after auth refresh', () => checkRestoredSessionLoadsSitesAfterRefresh(browser));
    await runCheck('authenticated Site failure does not expose demo Sites', () => checkAuthenticatedSiteFailureDoesNotExposeDemoSites(browser));
    await runCheck('browser login uses cookie session without localStorage bearer token', (async () => {
      const context = await newContext(browser);
      const page = await context.newPage();
      try {
        await loginAs(page, 'worker@example.com', 'worker');
        await expectNoLegacyBearerToken(page);
      } finally {
        await context.close();
      }
    }));
    await runCheck('browser geolocation grant enables attendance capture', () => checkLoginAndGrantedGeolocation(browser));
    await runCheck('attendance presents one contextual action with a secondary correction path', () => checkContextualAttendanceAction(browser));
    await runCheck('browser geolocation denial shows recoverable error', () => checkDeniedGeolocation(browser));
    await runCheck('Daywork team rows use searchable member picker', () => checkDayworkTeamMemberPicker(browser));
    await runCheck('Daywork history and review hide helper fields', () => checkDayworkRecordRendering(browser));
    await runCheck('reconnect preserves in-progress Daywork and Work Form answers', () => checkReconnectPreservesWorkerForms(browser));
    await runCheck('staff users scope global admin controls by role', () => checkStaffGlobalAdminScoping(browser));
    await runCheck('supervisors create and edit conditional Work Forms with field cards', () => checkSupervisorWorkFormCardBuilder(browser));
    await runCheck('Offline Submission ownership, occurrence time, and idempotent replay', () => checkOfflineQueueAndReplay(browser));
    await runCheck('repeat signatures resume after a partial upload failure', () => checkRepeatSignatureUploadResume(browser));
    await runCheck('supervisor review shows pending outside-site worker record', () => checkSupervisorReview(browser));
    await runCheck('supervisor workspaces remain navigable on desktop and mobile', () => checkSupervisorWorkspaceNavigation(browser));
    await runCheck('supervisor Review Desk is responsive', () => checkSupervisorReviewDeskLayout(browser));
    await runCheck('offline Review Queue is explicit and read-only', () => checkOfflineReviewQueueReadOnly(browser));
    await runCheck('Work Form autosave protects drafts and app updates', () => checkWorkFormAutosaveAndUpdateProtection(browser));
    await runCheck('service worker update prompt posts SKIP_WAITING', () => checkServiceWorkerUpdatePrompt(browser));
  } finally {
    await browser.close();
  }

  if (checks.length) {
    console.error(`\n${checks.length} browser workflow check${checks.length === 1 ? '' : 's'} failed.`);
    process.exitCode = 1;
    return;
  }

  console.log('\nbrowser workflow checks passed');
}

try {
  await main();
} finally {
  await Promise.all([...children].reverse().map(stopProcess));
  await delay(250);
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
