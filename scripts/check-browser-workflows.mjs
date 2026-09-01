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
const previewPort = Number(process.env.BROWSER_WORKFLOW_PREVIEW_PORT || 4175);
const backendBase = `http://127.0.0.1:${backendPort}`;
const appBase = `http://127.0.0.1:${frontendPort}`;
const productionAppBase = `http://127.0.0.1:${previewPort}`;
const password = 'Passw0rd!';
const workflowFilter = String(process.env.BROWSER_WORKFLOW_ONLY || '').trim().toLowerCase();
const processOutputLimit = 40000;

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

function appendProcessOutput(processState, text) {
  processState.output = `${processState.output}${text}`.slice(-processOutputLimit);
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
    appendProcessOutput(processState, text);
    if (process.env.BROWSER_WORKFLOW_DEBUG) process.stdout.write(`[${name}] ${text}`);
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    appendProcessOutput(processState, text);
    if (process.env.BROWSER_WORKFLOW_DEBUG) process.stderr.write(`[${name}] ${text}`);
  });

  child.on('exit', (code, signal) => {
    processState.exitCode = code;
    processState.exitSignal = signal;
  });

  children.push(processState);
  return processState;
}

function managedProcessExitError(workflowName) {
  const processState = children.find(({ child }) => child.exitCode != null || child.signalCode != null);
  if (!processState) return null;

  const exitReason = processState.exitSignal
    ? `signal ${processState.exitSignal}`
    : `code ${processState.exitCode}`;
  const recentOutput = processState.output.trim();
  return new Error([
    `Managed ${processState.name} process exited unexpectedly with ${exitReason} while running "${workflowName}".`,
    recentOutput ? `Recent ${processState.name} output:\n${recentOutput}` : `The ${processState.name} process produced no output.`
  ].join('\n'));
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
    join(root, 'scripts', 'browser-workflow-source-server.mjs')
  ], {
    cwd: root,
    env: {
      ...process.env,
      BROWSER_WORKFLOW_SOURCE_ROOT: root,
      BROWSER_WORKFLOW_FRONTEND_PORT: String(frontendPort),
      VITE_API_PROXY_TARGET: backendBase
    }
  });

  await waitForHttp(appBase);

  startProcess('frontend-preview', process.execPath, [
    join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    String(previewPort),
    '--strictPort'
  ], {
    cwd: root,
    env: {
      ...process.env,
      VITE_DISABLE_HTTPS: 'true',
      VITE_API_PROXY_TARGET: backendBase
    }
  });

  await waitForHttp(productionAppBase);
}

async function newContext(browser, options = {}) {
  const context = await browser.newContext({
    baseURL: options.baseURL || appBase,
    viewport: options.viewport || { width: 390, height: 844 },
    isMobile: options.isMobile ?? true,
    hasTouch: options.hasTouch ?? true,
    geolocation: options.geolocation,
    permissions: options.permissions || [],
    serviceWorkers: options.serviceWorkers || 'block'
  });

  await context.addInitScript((reportOnly) => {
    window.__REPORT_ONLY_MODE_OVERRIDE__ = reportOnly;
  }, options.reportOnly ?? false);

  if (options.initScript) {
    await context.addInitScript(options.initScript);
  }

  if (process.env.BROWSER_WORKFLOW_DEBUG) {
    context.on('page', (page) => {
      page.on('console', (message) => process.stderr.write(`[browser console] ${message.type()}: ${message.text()}\n`));
      page.on('pageerror', (error) => process.stderr.write(`[browser error] ${error.stack || error.message}\n`));
      page.on('requestfailed', (request) => process.stderr.write(`[browser request failed] ${request.url()} ${request.failure()?.errorText || ''}\n`));
    });
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
  const processErrorBefore = managedProcessExitError(name);
  if (processErrorBefore) throw processErrorBefore;
  try {
    await test();
    console.log(`ok - ${name}`);
  } catch (error) {
    const processErrorAfter = managedProcessExitError(name);
    if (processErrorAfter) throw processErrorAfter;
    checks.push({ name, error });
    console.error(`not ok - ${name}`);
    console.error(`  ${error.stack || error.message}`);
  }
}

async function expectReadableLabelSize(page, selectors, contextLabel, minimumPx = 14) {
  const measurements = await page.evaluate((targetSelectors) => targetSelectors.map((selector) => {
    const elements = [...document.querySelectorAll(selector)];
    return {
      selector,
      values: elements.map((element) => ({
        fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
        text: element.textContent?.replace(/\s+/g, ' ').trim().slice(0, 80) || ''
      }))
    };
  }), selectors);
  const missing = measurements.filter((measurement) => !measurement.values.length);
  const undersized = measurements.flatMap((measurement) => measurement.values
    .filter((value) => !Number.isFinite(value.fontSize) || value.fontSize + 0.01 < minimumPx)
    .map((value) => ({ selector: measurement.selector, ...value })));

  if (missing.length || undersized.length) {
    throw new Error(`${contextLabel} labels are below the ${minimumPx}px readability floor: ${JSON.stringify({
      missing: missing.map(({ selector }) => selector),
      undersized
    })}`);
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
    const loginPrecedesInstallInDom = await page.locator('#loginView').evaluate((view) => {
      const loginForm = view.querySelector('#loginForm');
      const installPromotion = view.querySelector('.install-box');
      return Boolean(loginForm
        && installPromotion
        && (loginForm.compareDocumentPosition(installPromotion) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    const loginFormBox = await page.locator('#loginForm').boundingBox();
    const installPromotionBox = await page.locator('#loginView .install-box').boundingBox();
    if (!loginPrecedesInstallInDom
      || !loginFormBox
      || !installPromotionBox
      || loginFormBox.y + loginFormBox.height > installPromotionBox.y) {
      throw new Error(`install promotion appears before the primary login form: ${JSON.stringify({ loginPrecedesInstallInDom, loginFormBox, installPromotionBox })}`);
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
      || !busyState.label.includes('Submitting Report')
      || busyState.formBusy !== 'true'
      || !busyState.fieldsInert
    ) {
      throw new Error(`Report submit did not expose its busy state: ${JSON.stringify(busyState)}`);
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
        && button.textContent.trim() === 'Submit Report';
    }, null, { timeout: 20000 });
    const completedButton = await page.locator('#submitWorkFormButton').evaluate((button) => ({
      disabled: button.disabled,
      busy: button.getAttribute('aria-busy'),
      label: button.textContent || ''
    }));
    if (completedButton.disabled || completedButton.busy !== null || completedButton.label.trim() !== 'Submit Report') {
      throw new Error(`Report submit did not restore after completion: ${JSON.stringify(completedButton)}`);
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

async function checkNormalWorkerAttendanceShortcuts(browser) {
  const context = await newContext(browser, {
    geolocation: { latitude: -36.7832, longitude: 174.7631, accuracy: 10 },
    permissions: ['geolocation']
  });
  const page = await context.newPage();
  const workerEmail = `attendance-shortcuts-${Date.now()}@example.com`;
  const secondWorkerEmail = `attendance-scope-${Date.now()}@example.com`;

  try {
    await loginAs(page, 'supervisor@example.com', 'supervisor');
    await page.evaluate(async ({ email, secondEmail, workerPassword }) => {
      const { createUser, getSession } = await import('/assets/js/api-client.js');
      const supervisor = getSession();
      await createUser({
        name: 'Attendance Shortcut Worker',
        email,
        password: workerPassword,
        role: 'worker',
        worker_class: 'normal',
        department_id: supervisor.departmentId,
        is_global_admin: false
      });
      await createUser({
        name: 'Attendance Scope Worker',
        email: secondEmail,
        password: workerPassword,
        role: 'worker',
        worker_class: 'normal',
        department_id: supervisor.departmentId,
        is_global_admin: false
      });
    }, {
      email: workerEmail,
      secondEmail: secondWorkerEmail,
      workerPassword: password
    });
    await logout(page);
    await page.waitForTimeout(300);
    await loginAs(page, workerEmail, 'worker');

    await page.waitForFunction(() => (
      document.querySelector('#attendancePrimaryButton')?.dataset.attendanceAction === 'check_in'
      && document.querySelector('#normalWorkerGuide')?.dataset.guideState === 'full'
    ), null, { timeout: 15000 });

    const deduplicatedContext = await page.evaluate(async () => {
      const { buildWorkerAttendanceContext } = await import('/assets/js/history.js');
      return buildWorkerAttendanceContext([
        {
          id: 101,
          clientSubmissionId: 'duplicate-check-in',
          type: 'attendance',
          siteId: 1,
          action: 'check_in',
          createdAt: '2026-08-07T08:00:00.000Z',
          source: 'backend'
        },
        {
          id: 'local-duplicate',
          clientSubmissionId: 'duplicate-check-in',
          type: 'attendance',
          siteId: 1,
          action: 'check_in',
          createdAt: '2026-08-07T08:00:00.000Z',
          syncStatus: 'queued',
          source: 'local'
        },
        {
          id: 102,
          clientSubmissionId: 'matching-check-out',
          type: 'attendance',
          siteId: 1,
          action: 'check_out',
          createdAt: '2026-08-07T17:00:00.000Z',
          source: 'backend'
        }
      ]);
    });
    if (deduplicatedContext.hasOpenCheckIn || deduplicatedContext.expectedAction !== 'check_in') {
      throw new Error(`backend/local attendance retry was counted twice: ${JSON.stringify(deduplicatedContext)}`);
    }

    const sites = await page.evaluate(async () => {
      const response = await fetch('/api/sites', { credentials: 'include' });
      if (!response.ok) throw new Error(`sites failed: ${response.status}`);
      return response.json();
    });
    const auckland = sites.find((site) => site.name === 'Auckland Yard');
    const northShore = sites.find((site) => site.name === 'North Shore Warehouse');
    if (!auckland || !northShore) {
      throw new Error(`attendance shortcut fixture Sites are missing: ${JSON.stringify(sites)}`);
    }

    const initialLayout = await page.evaluate(() => {
      const guide = document.querySelector('#normalWorkerGuide');
      const siteSelect = document.querySelector('#attendanceSite');
      const guideBox = guide?.getBoundingClientRect();
      const siteBox = siteSelect?.getBoundingClientRect();
      return {
        guideState: guide?.dataset.guideState || '',
        guideHeight: guideBox?.height || 0,
        siteDocumentTop: siteBox ? siteBox.top + window.scrollY : 0
      };
    });
    if (initialLayout.guideState !== 'full' || initialLayout.guideHeight < 100) {
      throw new Error(`fresh normal Worker did not receive the full guide: ${JSON.stringify(initialLayout)}`);
    }

    await page.locator('#attendanceSite').selectOption(String(auckland.id));
    await captureLocation(page);
    await page.waitForFunction(({ nearestSiteId, selectedSiteId }) => {
      const select = document.querySelector('#attendanceSite');
      const firstSiteOption = [...(select?.options || [])].find((option) => option.value);
      return firstSiteOption?.value === nearestSiteId && select?.value === selectedSiteId;
    }, {
      nearestSiteId: String(northShore.id),
      selectedSiteId: String(auckland.id)
    });

    await page.locator('#attendanceSite').selectOption(String(northShore.id));
    await page.locator('#locationPreview').getByText('Inside site area').waitFor({ timeout: 5000 });
    const initialRecordCount = await myRecordCount(page);
    await page.locator('#attendancePrimaryButton').click();
    await pageWaitForRecordCount(page, initialRecordCount + 1);
    await page.waitForFunction((siteId) => (
      document.querySelector('#attendancePrimaryButton')?.dataset.attendanceAction === 'check_out'
      && document.querySelector('#attendanceSite')?.value === siteId
      && document.querySelector('#normalWorkerGuide')?.dataset.guideState === 'compact'
    ), String(northShore.id), { timeout: 15000 });

    const compactLayout = await page.evaluate(() => {
      const guide = document.querySelector('#normalWorkerGuide');
      const siteSelect = document.querySelector('#attendanceSite');
      const guideBox = guide?.getBoundingClientRect();
      const siteBox = siteSelect?.getBoundingClientRect();
      return {
        guideState: guide?.dataset.guideState || '',
        guideHeight: guideBox?.height || 0,
        siteDocumentTop: siteBox ? siteBox.top + window.scrollY : 0
      };
    });
    if (
      compactLayout.guideState !== 'compact'
      || compactLayout.guideHeight >= initialLayout.guideHeight
      || compactLayout.siteDocumentTop > initialLayout.siteDocumentTop - 80
    ) {
      throw new Error(`first attendance did not compact the guide enough: ${JSON.stringify({ initialLayout, compactLayout })}`);
    }

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction((siteId) => (
      document.body.dataset.activeView === 'worker'
      && document.querySelector('#attendancePrimaryButton')?.dataset.attendanceAction === 'check_out'
      && document.querySelector('#attendanceSite')?.value === siteId
      && document.querySelector('#normalWorkerGuide')?.dataset.guideState === 'compact'
    ), String(northShore.id), { timeout: 20000 });

    await page.evaluate(async () => {
      const { getAll, remove } = await import('/assets/js/db.js');
      const records = await getAll('records');
      await Promise.all(records
        .filter((record) => record.type === 'attendance')
        .map((record) => remove('records', record.id)));
    });
    await page.route('**/api/my-records', (route) => route.abort('failed'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction((siteId) => (
      document.body.dataset.activeView === 'worker'
      && document.querySelector('#attendancePrimaryButton')?.dataset.attendanceAction === 'check_out'
      && document.querySelector('#attendanceSite')?.value === siteId
      && document.querySelector('#normalWorkerGuide')?.dataset.guideState === 'compact'
    ), String(northShore.id), { timeout: 20000 });
    await page.unroute('**/api/my-records');

    await page.locator('#attendanceSite').selectOption(String(auckland.id));
    await captureLocation(page);
    const openSiteState = await page.evaluate(() => {
      const select = document.querySelector('#attendanceSite');
      return {
        selectedSiteId: select?.value || '',
        firstSiteId: [...(select?.options || [])].find((option) => option.value)?.value || ''
      };
    });
    if (
      openSiteState.selectedSiteId !== String(auckland.id)
      || openSiteState.firstSiteId !== String(northShore.id)
    ) {
      throw new Error(`open-Site priority overwrote an explicit Site choice: ${JSON.stringify(openSiteState)}`);
    }

    await page.locator('#attendanceSite').selectOption(String(northShore.id));
    await page.locator('#attendancePrimaryButton').click();
    await pageWaitForRecordCount(page, initialRecordCount + 2);
    await page.waitForFunction((recentSiteId) => {
      const select = document.querySelector('#attendanceSite');
      const firstSiteOption = [...(select?.options || [])].find((option) => option.value);
      return document.querySelector('#attendancePrimaryButton')?.dataset.attendanceAction === 'check_in'
        && select?.value === ''
        && firstSiteOption?.value === recentSiteId
        && document.querySelector('#normalWorkerGuide')?.dataset.guideState === 'compact';
    }, String(northShore.id), { timeout: 15000 });

    const snapshotRaceFixture = await page.evaluate(async (siteId) => {
      const { getSession } = await import('/assets/js/api-client.js');
      const response = await fetch('/api/my-records', { credentials: 'include' });
      if (!response.ok) throw new Error(`attendance race fixture failed: ${response.status}`);
      const records = await response.json();
      const worker = getSession();
      return {
        records,
        newerRecord: {
          id: 9000001,
          worker_id: worker.id,
          worker_name: worker.fullName,
          department_id: worker.departmentId,
          site_id: Number(siteId),
          site_name: 'Snapshot Race Site',
          record_type: 'check_in',
          latitude: -36.7832,
          longitude: 174.7631,
          accuracy: 10,
          distance_from_site_m: 5,
          within_site_radius: true,
          note: 'Newest snapshot marker',
          status: 'pending',
          entry_source: 'worker',
          client_submission_id: 'newest-snapshot-marker',
          created_at: new Date(Date.now() + 60000).toISOString()
        }
      };
    }, String(northShore.id));

    let releaseOlderHistory;
    let markOlderHistorySeen;
    let markOlderHistoryDone;
    let markNewerHistoryDone;
    const olderHistoryGate = new Promise((resolve) => { releaseOlderHistory = resolve; });
    const olderHistorySeen = new Promise((resolve) => { markOlderHistorySeen = resolve; });
    const olderHistoryDone = new Promise((resolve) => { markOlderHistoryDone = resolve; });
    const newerHistoryDone = new Promise((resolve) => { markNewerHistoryDone = resolve; });
    let historyRaceRequestCount = 0;
    await page.route('**/api/my-records', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      historyRaceRequestCount += 1;
      if (historyRaceRequestCount === 1) {
        markOlderHistorySeen();
        await olderHistoryGate;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(snapshotRaceFixture.records)
        });
        markOlderHistoryDone();
        return;
      }
      if (historyRaceRequestCount === 2) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            snapshotRaceFixture.newerRecord,
            ...snapshotRaceFixture.records
          ])
        });
        markNewerHistoryDone();
        return;
      }
      await route.continue();
    });

    await page.locator('#refreshHistoryButton').evaluate((button) => button.click());
    await olderHistorySeen;
    await page.locator('#refreshHistoryButton').evaluate((button) => button.click());
    await newerHistoryDone;
    await page.waitForFunction(() => (
      document.querySelector('#historyList')?.textContent?.includes('Newest snapshot marker')
    ), null, { timeout: 10000 });
    releaseOlderHistory();
    await olderHistoryDone;
    await delay(250);
    const orderedSnapshot = await page.evaluate(async () => {
      const { getSession } = await import('/assets/js/api-client.js');
      const { loadWorkerAttendanceSnapshot } = await import('/assets/js/offline-attendance-snapshot.js');
      return loadWorkerAttendanceSnapshot(getSession());
    });
    if (
      !orderedSnapshot?.records?.some(
        (record) => record.clientSubmissionId === 'newest-snapshot-marker'
      )
      || !await page.locator('#historyList').getByText('Newest snapshot marker').count()
    ) {
      throw new Error(`older history response replaced newer state: ${JSON.stringify(orderedSnapshot)}`);
    }
    await page.unroute('**/api/my-records');

    const staleAccountRecord = {
      ...snapshotRaceFixture.newerRecord,
      id: 9000002,
      note: 'STALE WORKER A RECORD',
      client_submission_id: 'stale-worker-a-record',
      created_at: new Date(Date.now() + 120000).toISOString()
    };
    let releaseStaleAccountHistory;
    let markStaleAccountHistorySeen;
    let markStaleAccountHistoryDone;
    const staleAccountGate = new Promise((resolve) => { releaseStaleAccountHistory = resolve; });
    const staleAccountHistorySeen = new Promise((resolve) => { markStaleAccountHistorySeen = resolve; });
    const staleAccountHistoryDone = new Promise((resolve) => { markStaleAccountHistoryDone = resolve; });
    let holdStaleAccountHistory = true;
    await page.route('**/api/my-records', async (route) => {
      if (route.request().method() !== 'GET' || !holdStaleAccountHistory) {
        await route.continue();
        return;
      }
      markStaleAccountHistorySeen();
      await staleAccountGate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([staleAccountRecord])
      });
      markStaleAccountHistoryDone();
    });
    await page.locator('#refreshHistoryButton').evaluate((button) => button.click());
    await staleAccountHistorySeen;
    await logout(page);
    holdStaleAccountHistory = false;
    await page.locator('#emailInput').fill(secondWorkerEmail);
    await page.locator('#passwordInput').fill(password);
    await page.locator('#loginSubmitButton').click();
    await page.waitForFunction(() => document.body.dataset.activeView === 'worker', null, { timeout: 20000 });
    await page.locator('#workerView').waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForFunction(() => document.querySelector('#historyList .empty-state'), null, {
      timeout: 15000
    });
    releaseStaleAccountHistory();
    await staleAccountHistoryDone;
    await delay(250);
    const scopedHistoryState = await page.evaluate(async () => {
      const { getSession } = await import('/assets/js/api-client.js');
      return {
        email: getSession()?.email || '',
        historyText: document.querySelector('#historyList')?.textContent || ''
      };
    });
    if (
      scopedHistoryState.email !== secondWorkerEmail
      || scopedHistoryState.historyText.includes('STALE WORKER A RECORD')
    ) {
      throw new Error(`previous Worker history crossed account scope: ${JSON.stringify(scopedHistoryState)}`);
    }
    await page.unroute('**/api/my-records');
  } finally {
    await context.close();
  }
}

async function checkNormalWorkerWorkFormSubmission(browser) {
  const context = await newContext(browser, { reportOnly: true });
  const page = await context.newPage();
  const workerEmail = `normal-report-${Date.now()}@example.com`;
  const reportMarker = `PPE issue report ${Date.now()}`;

  try {
    await loginAs(page, 'supervisor@example.com', 'supervisor');
    await page.evaluate(async ({ email, workerPassword }) => {
      const { createUser, getSession } = await import('/assets/js/api-client.js');
      const supervisor = getSession();
      await createUser({
        name: 'Normal Report Worker',
        email,
        password: workerPassword,
        role: 'worker',
        worker_class: 'normal',
        department_id: supervisor.departmentId,
        is_global_admin: false
      });
    }, {
      email: workerEmail,
      workerPassword: password
    });
    await logout(page);
    await loginAs(page, workerEmail, 'worker');

    const workerShell = await page.evaluate(() => ({
      mode: document.body.classList.contains('report-only-mode'),
      navigation: [...document.querySelectorAll('#workerView .tab')]
        .filter((element) => element.getClientRects().length)
        .map((element) => element.textContent?.trim()),
      activePanel: document.querySelector('#workerView .tab-panel.active')?.id || '',
      dashboardVisible: Boolean(document.querySelector('#workerView .worker-dashboard')?.getClientRects().length),
      accountVisible: Boolean(document.querySelector('#userContext')?.getClientRects().length),
      logoutVisible: Boolean(document.querySelector('#logoutButton')?.getClientRects().length),
      heading: document.querySelector('#formTab h2')?.textContent?.trim() || '',
      templateLabel: document.querySelector('#workFormSelect')?.closest('label')?.querySelector('span')?.textContent?.trim() || '',
      templatePrompt: document.querySelector('#workFormSelect option[value=""]')?.textContent?.trim() || '',
      reportDateLabel: document.querySelector('#workFormDate')?.closest('label')?.childNodes[0]?.nodeValue?.trim() || '',
      reportDateRequired: document.querySelector('#workFormDate')?.required ?? null,
      siteLabel: document.querySelector('#workFormSite')?.closest('label')?.childNodes[0]?.nodeValue?.trim() || '',
      siteRequired: document.querySelector('#workFormSite')?.required ?? null,
      horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
      smallestPrimaryActionHeight: Math.min(
        ...[...document.querySelectorAll('#workerView .tab, #submitWorkFormButton')]
          .filter((element) => element.getClientRects().length)
          .map((element) => element.getBoundingClientRect().height)
      ),
      statusOptions: [...(document.querySelector('#historyStatusFilter')?.options || [])]
        .filter((option) => !option.hidden)
        .map((option) => option.value),
      submitLabel: document.querySelector('#submitWorkFormButton')?.textContent?.trim() || ''
    }));
    if (
      !workerShell.mode
      || JSON.stringify(workerShell.navigation) !== JSON.stringify(['New Report', 'My Reports'])
      || workerShell.activePanel !== 'formTab'
      || workerShell.dashboardVisible
      || !workerShell.accountVisible
      || !workerShell.logoutVisible
      || workerShell.heading !== 'New Report'
      || workerShell.templateLabel !== 'Report Template'
      || workerShell.templatePrompt !== 'Select a Report Template'
      || workerShell.reportDateLabel !== 'Report Date'
      || !workerShell.reportDateRequired
      || workerShell.siteLabel !== 'Site (optional)'
      || workerShell.siteRequired
      || workerShell.horizontalOverflow > 1
      || workerShell.smallestPrimaryActionHeight < 44
      || JSON.stringify(workerShell.statusOptions) !== JSON.stringify(['', 'submitted', 'in_review', 'resolved', 'queued'])
      || workerShell.submitLabel !== 'Submit Report'
    ) {
      throw new Error(`normal Worker report-only shell was incorrect: ${JSON.stringify(workerShell)}`);
    }

    const formTab = page.locator('.tab[data-tab-target="formTab"]');
    await formTab.waitFor({ state: 'visible', timeout: 10000 });
    if (
      await page.locator('.tab[data-tab-target="taskTab"]').isVisible()
      || await page.locator('.tab[data-tab-target="teamLogTab"]').isVisible()
    ) {
      throw new Error('normal Worker received Leader-only Daywork or Team access');
    }

    await formTab.click();
    await page.waitForFunction(() => (
      [...document.querySelectorAll('#workFormSelect option')]
        .some((option) => option.textContent?.trim() === 'Inspection form')
    ), null, { timeout: 15000 });
    const activeForms = await page.evaluate(async () => {
      const response = await fetch('/api/work-forms', { credentials: 'include' });
      if (!response.ok) throw new Error(`work forms failed: ${response.status}`);
      return response.json();
    });
    if (!activeForms.some((form) => form.name === 'Inspection form') || activeForms.some((form) => form.status !== 'active')) {
      throw new Error(`normal Worker did not receive only active department Work Forms: ${JSON.stringify(activeForms)}`);
    }

    await page.locator('#workFormSelect').selectOption({ label: 'Inspection form' });
    await page.locator('#workFormField_inspection_area').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#workFormDate').fill('');
    await page.locator('#submitWorkFormButton').click();
    const missingDateState = await page.locator('#workFormDate').evaluate((input) => ({
      invalid: input.matches(':invalid'),
      focused: document.activeElement === input
    }));
    if (!missingDateState.invalid || !missingDateState.focused) {
      throw new Error(`Report Date was not enforced before submission: ${JSON.stringify(missingDateState)}`);
    }
    await page.locator('#workFormDate').fill('2026-09-01');
    await page.locator('#workFormField_inspection_area').fill(reportMarker);
    await page.locator('#workFormField_inspection_result').selectOption({ label: 'Needs action' });
    await page.locator('#workFormField_issues_found').fill('Damaged safety glasses need replacement.');
    await page.locator('#workFormField_follow_up_required').locator('xpath=..').click();

    const submissionResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/form-submissions'
    ), { timeout: 20000 });
    await page.locator('#submitWorkFormButton').click();
    const submissionResponse = await submissionResponsePromise;
    if (!submissionResponse.ok()) {
      throw new Error(`normal Worker Work Form submission failed: ${submissionResponse.status()} ${await submissionResponse.text()}`);
    }
    const submittedReport = await submissionResponse.json();
    const submissionPayload = submissionResponse.request().postDataJSON();
    if (submissionPayload.work_date !== '2026-09-01' || submissionPayload.site_id !== null) {
      throw new Error(`Report Date or optional Site payload was incorrect: ${JSON.stringify(submissionPayload)}`);
    }
    await page.locator('#workFormFeedback').getByText('Inspection form submitted for review').waitFor({ timeout: 20000 });

    await page.locator('.tab[data-tab-target="historyTab"]').click();
    await page.locator('#historyTab').waitFor({ state: 'visible', timeout: 10000 });
    const historyRecord = page.locator('#historyList .record-form').filter({ hasText: reportMarker }).first();
    await historyRecord.waitFor({ state: 'visible', timeout: 20000 });
    const historyText = await historyRecord.innerText();
    if (
      !historyText.includes('Inspection form')
      || !historyText.includes('Submitted')
      || !historyText.includes('Submitted:')
      || !historyText.includes('Report Date: 2026-09-01')
      || !historyText.includes('Unassigned site')
      || !historyText.includes(reportMarker)
      || historyText.includes('Final supervisor note:')
    ) {
      throw new Error(`normal Worker report history was incomplete: ${historyText}`);
    }

    await logout(page);
    await loginAs(page, 'supervisor@example.com', 'supervisor');
    await page.locator('#adminMobileMenuButton').click();
    await page.locator('#adminWorkspaceDrawer[open]').waitFor({ state: 'visible', timeout: 10000 });
    const supervisorShell = await page.evaluate(() => ({
      navigation: [...document.querySelectorAll('.admin-drawer-nav [data-admin-workspace-target]')]
        .filter((element) => element.getClientRects().length)
        .map((element) => ({
          target: element.dataset.adminWorkspaceTarget,
          label: element.querySelector('strong')?.textContent?.trim() || ''
        })),
      current: document.querySelector('.admin-drawer-nav [aria-current="page"]')?.dataset.adminWorkspaceTarget || '',
      type: document.querySelector('#supervisorTypeFilter')?.value || '',
      typeVisible: Boolean(document.querySelector('#supervisorTypeFilter')?.closest('label')?.getClientRects().length),
      status: document.querySelector('#supervisorStatusFilter')?.value || '',
      statusVisible: Boolean(document.querySelector('#supervisorStatusFilter')?.closest('label')?.getClientRects().length),
      statusOptions: [...(document.querySelector('#supervisorStatusFilter')?.options || [])]
        .filter((option) => !option.hidden)
        .map((option) => option.value),
      templateVisible: Boolean(document.querySelector('#supervisorTemplateFilter')?.closest('label')?.getClientRects().length),
      workerVisible: Boolean(document.querySelector('#supervisorWorkerFilter')?.closest('label')?.getClientRects().length),
      reportCsvVisible: Boolean(document.querySelector('#exportReportsCsvButton')?.getClientRects().length),
      reportPdfVisible: Boolean(document.querySelector('#exportReportsPdfButton')?.getClientRects().length),
      attendanceExportVisible: Boolean(document.querySelector('#exportAttendanceButton')?.getClientRects().length),
      taskExportVisible: Boolean(document.querySelector('#exportTaskLogsButton')?.getClientRects().length),
      mapVisible: Boolean(document.querySelector('#locationMapDetails')?.getClientRects().length),
      analyticsVisible: Boolean(document.querySelector('#managementAnalyticsDetails')?.getClientRects().length),
      exportsVisible: Boolean(document.querySelector('#adminReportsWorkspace')?.getClientRects().length),
      horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth
    }));
    if (
      JSON.stringify(supervisorShell.navigation) !== JSON.stringify([
        { target: 'review', label: 'Reports' },
        { target: 'forms', label: 'Report Templates' },
        { target: 'people', label: 'Staff' }
      ])
      || supervisorShell.current !== 'review'
      || supervisorShell.type !== 'form'
      || supervisorShell.typeVisible
      || supervisorShell.status !== ''
      || !supervisorShell.statusVisible
      || JSON.stringify(supervisorShell.statusOptions) !== JSON.stringify(['', 'submitted', 'in_review', 'resolved'])
      || !supervisorShell.templateVisible
      || !supervisorShell.workerVisible
      || !supervisorShell.reportCsvVisible
      || !supervisorShell.reportPdfVisible
      || supervisorShell.attendanceExportVisible
      || supervisorShell.taskExportVisible
      || supervisorShell.mapVisible
      || supervisorShell.analyticsVisible
      || supervisorShell.exportsVisible
      || supervisorShell.horizontalOverflow > 1
    ) {
      throw new Error(`Supervisor report-only shell was incorrect: ${JSON.stringify(supervisorShell)}`);
    }
    await page.locator('#adminWorkspaceDrawerCloseButton').click();
    await page.waitForFunction(() => document.querySelector('#adminWorkspaceDrawer')?.open === false);
    const supervisorReport = page.locator('#reviewQueueList .record-form').filter({ hasText: reportMarker }).first();
    await supervisorReport.waitFor({ state: 'visible', timeout: 20000 });
    const supervisorReportText = await supervisorReport.innerText();
    if (!supervisorReportText.includes('Submitted')) {
      throw new Error(`Supervisor Reports did not show the submitted Report workflow: ${supervisorReportText}`);
    }

    await page.waitForFunction(() => (
      [...document.querySelectorAll('#supervisorTemplateFilter option')]
        .some((option) => option.textContent?.includes('Inspection form'))
      && [...document.querySelectorAll('#supervisorWorkerFilter option')]
        .some((option) => option.textContent?.includes('Normal Report Worker'))
    ));
    const filteredQueueResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'GET'
        && url.pathname === '/api/supervisor/review-queue'
        && url.searchParams.get('workflow_status') === 'submitted'
        && url.searchParams.get('form_id') === String(submittedReport.form_id)
        && url.searchParams.get('worker_id') === String(submittedReport.worker_id)
        && url.searchParams.get('record_date') === '2026-09-01';
    });
    await page.locator('#supervisorStatusFilter').selectOption('submitted');
    await page.locator('#supervisorTemplateFilter').selectOption({ label: 'Inspection form' });
    await page.locator('#supervisorWorkerFilter').selectOption({ label: 'Normal Report Worker' });
    await page.locator('#supervisorDateFilter').fill('2026-09-01');
    if (!(await filteredQueueResponse).ok()) {
      throw new Error('combined Supervisor Report filters did not produce a successful scoped request');
    }
    await supervisorReport.waitFor({ state: 'visible', timeout: 20000 });
    await supervisorReport.click();

    const submittedActions = page.locator('#reviewQueueActions');
    const startReviewButton = submittedActions.getByRole('button', { name: 'Start review' });
    await startReviewButton.waitFor({ timeout: 10000 });
    if (
      await submittedActions.getByRole('button', { name: 'Approve', exact: true }).count()
      || await submittedActions.getByRole('button', { name: 'Reject', exact: true }).count()
      || await submittedActions.getByRole('button', { name: 'Edit', exact: true }).count()
      || await submittedActions.getByRole('button', { name: 'Move to bin', exact: true }).count()
      || await startReviewButton.evaluate((button) => button.getBoundingClientRect().height < 44)
    ) {
      throw new Error('report-only Review Queue exposed legacy Approve, Reject, Edit, or rubbish-bin controls');
    }

    const startReviewResponse = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/api/supervisor/form-submissions/${submittedReport.id}/transition`
    ));
    await startReviewButton.click();
    const startReviewResult = await startReviewResponse;
    const startReviewPayload = startReviewResult.request().postDataJSON();
    if (!startReviewResult.ok() || startReviewPayload.status !== 'in_review') {
      throw new Error(`Start review transition was incomplete: ${JSON.stringify(startReviewPayload)}`);
    }
    await page.locator('#reviewQueueList .empty-state').waitFor({ state: 'visible', timeout: 10000 });

    await page.locator('#supervisorStatusFilter').selectOption('in_review');
    const inReviewReport = page.locator('#reviewQueueList .record-form').filter({ hasText: reportMarker }).first();
    await inReviewReport.waitFor({ state: 'visible', timeout: 20000 });
    await inReviewReport.click();
    const resolveButton = page.locator('#reviewQueueActions').getByRole('button', { name: 'Resolve report' });
    await resolveButton.click();
    const resolutionNote = page.locator('#reportResolutionNote');
    await resolutionNote.waitFor({ state: 'visible', timeout: 10000 });
    const resolutionPhoneLayout = await page.evaluate(() => ({
      horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
      submitHeight: document.querySelector('#editPanelForm button[type="submit"]')?.getBoundingClientRect().height || 0,
      focusedField: document.activeElement?.id || ''
    }));
    if (
      resolutionPhoneLayout.horizontalOverflow > 1
      || resolutionPhoneLayout.submitHeight < 44
      || resolutionPhoneLayout.focusedField !== 'reportResolutionNote'
    ) {
      throw new Error(`Report resolution panel was not phone-ready: ${JSON.stringify(resolutionPhoneLayout)}`);
    }
    if ((await resolutionNote.getAttribute('required')) === null) {
      throw new Error('Resolution note was not required');
    }
    await page.locator('#editPanelForm button[type="submit"]').click();
    if (!(await resolutionNote.evaluate((field) => field.matches(':invalid') && document.activeElement === field))) {
      throw new Error('empty resolution note was not blocked and focused');
    }
    await resolutionNote.fill('Replacement safety glasses issued.');
    const resolveResponse = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/api/supervisor/form-submissions/${submittedReport.id}/transition`
    ));
    await page.locator('#editPanelForm button[type="submit"]').click();
    const resolvedResponse = await resolveResponse;
    const resolveRequestPayload = resolvedResponse.request().postDataJSON();
    const resolvedPayload = await resolvedResponse.json();
    if (
      resolveRequestPayload.status !== 'resolved'
      || resolveRequestPayload.supervisor_note !== 'Replacement safety glasses issued.'
      || resolvedPayload.workflow_status !== 'resolved'
      || resolvedPayload.supervisor_note !== 'Replacement safety glasses issued.'
    ) {
      throw new Error(`Resolve report transition was incomplete: ${JSON.stringify(resolvedPayload)}`);
    }
    await page.locator('#supervisorStatusFilter').selectOption('resolved');
    const resolvedSupervisorReport = page.locator('#reviewQueueList .record-form').filter({ hasText: reportMarker }).first();
    await resolvedSupervisorReport.waitFor({ state: 'visible', timeout: 20000 });
    await resolvedSupervisorReport.click();
    const resolvedSupervisorText = await page.locator('#reviewQueueDetail').innerText();
    if (
      !resolvedSupervisorText.includes('Resolved')
      || !resolvedSupervisorText.includes('Reviewing supervisor:')
      || !resolvedSupervisorText.includes('Review started:')
      || !resolvedSupervisorText.includes('Resolved:')
      || !resolvedSupervisorText.includes('Final supervisor note:')
      || !resolvedSupervisorText.includes('Replacement safety glasses issued.')
      || await page.locator('#reviewQueueActions').getByRole('button', { name: 'Resolve report' }).count()
    ) {
      throw new Error(`resolved Supervisor Report detail was incomplete: ${resolvedSupervisorText}`);
    }

    await openAdminWorkspace(page, 'forms');
    await page.locator('#adminFormsWorkspaceTitle').waitFor({ state: 'visible', timeout: 10000 });
    const templateLanguage = await page.evaluate(() => ({
      heading: document.querySelector('#adminFormsWorkspaceTitle')?.textContent?.trim() || '',
      addLabel: document.querySelector('#addWorkFormButton')?.textContent?.trim() || '',
      createLabel: document.querySelector('#workFormSubmitButton')?.textContent?.trim() || '',
      horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth
    }));
    if (
      templateLanguage.heading !== 'Manage Report Templates'
      || templateLanguage.addLabel !== 'Add Report Template'
      || templateLanguage.createLabel !== 'Create Report Template'
      || templateLanguage.horizontalOverflow > 1
    ) {
      throw new Error(`Supervisor Report Template language or phone layout was incorrect: ${JSON.stringify(templateLanguage)}`);
    }
    await page.locator('#adminMobileMenuButton').click();
    await page.locator('.admin-drawer-nav [data-admin-workspace-target="people"]').click();
    await page.locator('#staffUsersDetails').waitFor({ state: 'visible', timeout: 10000 });
    if (
      await page.locator('#sitesDetails').isVisible()
      || await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) > 1
    ) {
      throw new Error('Supervisor Staff section exposed retained Sites or caused phone-width overflow');
    }

    await logout(page);
    await loginAs(page, workerEmail, 'worker');
    await page.locator('.tab[data-tab-target="historyTab"]').click();
    const resolvedHistoryRecord = page.locator('#historyList .record-form').filter({ hasText: reportMarker }).first();
    await resolvedHistoryRecord.waitFor({ state: 'visible', timeout: 20000 });
    const resolvedHistoryText = await resolvedHistoryRecord.innerText();
    if (
      !resolvedHistoryText.includes('Resolved')
      || !resolvedHistoryText.includes('Reviewing supervisor:')
      || !resolvedHistoryText.includes('Review started:')
      || !resolvedHistoryText.includes('Resolved:')
      || !resolvedHistoryText.includes('Final supervisor note:')
      || !resolvedHistoryText.includes('Replacement safety glasses issued.')
    ) {
      throw new Error(`resolved Report history omitted its final Supervisor note: ${resolvedHistoryText}`);
    }
    await page.locator('#historyStatusFilter').selectOption('submitted');
    await page.locator('#historyList .empty-state').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#historyStatusFilter').selectOption('resolved');
    await resolvedHistoryRecord.waitFor({ state: 'visible', timeout: 10000 });
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
  const context = await newContext(browser, { reportOnly: true });
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
        description: 'Browser regression for resumable Report signatures, photos, and idempotent replay.',
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
      const pngDataUrl = (fillStyle) => {
        const canvas = document.createElement('canvas');
        canvas.width = 4;
        canvas.height = 4;
        const drawing = canvas.getContext('2d');
        drawing.fillStyle = fillStyle;
        drawing.fillRect(0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/png');
      };
      const signature = pngDataUrl('#111827');
      const reportPhoto = pngDataUrl('#dc2626');
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
        photoDataUrls: [reportPhoto],
        photoMetadata: [{ name: 'ppe-evidence.png', type: 'image/png' }],
        workDate: '2026-07-15',
        createdAt: new Date().toISOString()
      });
      return {
        id,
        queued: result.queued,
        clientSubmissionId: result.record.clientSubmissionId,
        firstSignature: result.record.answers.crews[0].crew_signature,
        secondSignature: result.record.answers.crews[1].crew_signature,
        photoDataUrl: result.record.photoDataUrls[0],
        photoUrls: result.record.photoUrls
      };
    }, form);

    if (
      !queued.queued
      || queued.clientSubmissionId !== queued.id
      || !queued.firstSignature.startsWith('/uploads/')
      || !queued.secondSignature.startsWith('data:image/png')
      || !queued.photoDataUrl.startsWith('data:image/png')
      || queued.photoUrls.length !== 0
      || uploadRequests !== 2
    ) {
      throw new Error(`Report signature/photo progress was not persisted after a partial upload: ${JSON.stringify({ queued, uploadRequests })}`);
    }

    failSecondUpload = false;
    const replay = await replayQueuedSubmissions(page);
    if (replay.flushed !== 1 || replay.failed !== 0 || uploadRequests !== 4) {
      throw new Error(`repeat signature retry did not resume at the unfinished row: ${JSON.stringify({ replay, uploadRequests })}`);
    }

    await waitForQueueCount(page, 0);
    const synced = await page.evaluate(async (recordId) => {
      const { get } = await import('/assets/js/db.js');
      const record = await get('records', recordId);
      return {
        syncStatus: record?.syncStatus || '',
        backendRecordId: record?.backendRecordId || null,
        clientSubmissionId: record?.clientSubmissionId || '',
        signatures: record?.answers?.crews?.map((row) => row.crew_signature) || [],
        photoUrls: record?.photoUrls || []
      };
    }, queued.id);
    if (
      synced.syncStatus !== 'synced'
      || !synced.backendRecordId
      || synced.clientSubmissionId !== queued.clientSubmissionId
      || synced.signatures.length !== 2
      || synced.signatures.some((value) => !value.startsWith('/uploads/'))
      || synced.photoUrls.length !== 1
      || synced.photoUrls.some((value) => !value.startsWith('/uploads/'))
    ) {
      throw new Error(`Report retry did not finish with durable signature and photo URLs: ${JSON.stringify(synced)}`);
    }

    const firstBackendState = await page.evaluate(async (clientSubmissionId) => {
      const response = await fetch('/api/my-form-submissions', { credentials: 'include' });
      if (!response.ok) throw new Error(`my-form-submissions failed: ${response.status}`);
      const matches = (await response.json()).filter(
        (record) => record.client_submission_id === clientSubmissionId
      );
      return { count: matches.length, record: matches[0] || null };
    }, queued.clientSubmissionId);
    if (
      firstBackendState.count !== 1
      || firstBackendState.record?.id !== synced.backendRecordId
      || firstBackendState.record?.site_id !== null
      || firstBackendState.record?.photo_urls?.length !== 1
      || firstBackendState.record.photo_urls.some((value) => !value.startsWith('/uploads/'))
      || firstBackendState.record?.answers?.crews?.length !== 2
      || firstBackendState.record.answers.crews.some(
        (row) => !row.crew_signature?.startsWith('/uploads/')
      )
    ) {
      throw new Error(`backend Report was not durably stored once after replay: ${JSON.stringify(firstBackendState)}`);
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
    }, queued.id);

    const duplicateReplay = await replayQueuedSubmissions(page);
    if (
      duplicateReplay.flushed !== 1
      || duplicateReplay.failed !== 0
      || uploadRequests !== 4
    ) {
      throw new Error(`idempotent Report replay did not reuse its durable uploads: ${JSON.stringify({ duplicateReplay, uploadRequests })}`);
    }
    await waitForQueueCount(page, 0);

    const finalState = await page.evaluate(async ({ recordId, clientSubmissionId }) => {
      const { get } = await import('/assets/js/db.js');
      const localRecord = await get('records', recordId);
      const response = await fetch('/api/my-form-submissions', { credentials: 'include' });
      if (!response.ok) throw new Error(`my-form-submissions failed: ${response.status}`);
      const matches = (await response.json()).filter(
        (record) => record.client_submission_id === clientSubmissionId
      );
      return {
        local: {
          syncStatus: localRecord?.syncStatus || '',
          backendRecordId: localRecord?.backendRecordId || null,
          clientSubmissionId: localRecord?.clientSubmissionId || ''
        },
        backendCount: matches.length,
        backendRecord: matches[0] || null
      };
    }, { recordId: queued.id, clientSubmissionId: queued.clientSubmissionId });
    if (
      finalState.local.syncStatus !== 'synced'
      || finalState.local.clientSubmissionId !== queued.clientSubmissionId
      || finalState.local.backendRecordId !== synced.backendRecordId
      || finalState.backendCount !== 1
      || finalState.backendRecord?.id !== synced.backendRecordId
    ) {
      throw new Error(`forced Report replay created or returned the wrong durable submission: ${JSON.stringify(finalState)}`);
    }

    await page.locator('.tab[data-tab-target="historyTab"]').click();
    await page.locator('#historyTab').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#refreshHistoryButton').click();
    const myReport = page.locator('#historyList .record-form').filter({ hasText: formName });
    await myReport.first().waitFor({ state: 'visible', timeout: 20000 });
    if (await myReport.count() !== 1) {
      throw new Error(`My Reports did not contain exactly one replayed Report: ${await myReport.count()}`);
    }
    const durableImageSources = await myReport.first().locator('img').evaluateAll((images) => (
      images.map((image) => new URL(image.src).pathname)
    ));
    if (
      durableImageSources.length !== 3
      || durableImageSources.some((value) => !value.startsWith('/uploads/'))
    ) {
      throw new Error(`My Reports did not render durable photo/signature URLs: ${JSON.stringify(durableImageSources)}`);
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

async function checkReportOnlyExcludesDaywork(browser) {
  const retainedContext = await newContext(browser, { reportOnly: false });
  const retainedPage = await retainedContext.newPage();
  const reportMarker = `Report boundary ${Date.now()}`;

  try {
    await loginAs(retainedPage, 'worker@example.com', 'worker');
    await fillDayworkSubmission(retainedPage);
    await retainedPage.locator('#submitTaskButton').click();
    await retainedPage.locator('#taskFeedback')
      .getByText('Daywork log form submitted for approval')
      .waitFor({ timeout: 20000 });
  } finally {
    await retainedContext.close();
  }

  const reportContext = await newContext(browser, { reportOnly: true });
  const page = await reportContext.newPage();
  const scopedRequests = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if ([
      '/api/work-forms',
      '/api/my-form-submissions',
      '/api/supervisor/review-queue',
      '/api/supervisor/form-submissions/export.csv',
      '/api/supervisor/form-submissions/export.pdf'
    ].includes(url.pathname)) {
      scopedRequests.push(url.toString());
    }
  });
  const allRequestsAreReportScoped = (pathname) => {
    const matches = scopedRequests
      .map((value) => new URL(value))
      .filter((url) => url.pathname === pathname);
    return matches.length > 0 && matches.every((url) => url.searchParams.get('purpose') === 'report');
  };

  try {
    await loginAs(page, 'worker@example.com', 'worker');
    await page.locator('.tab[data-tab-target="formTab"]').click();
    await page.waitForFunction(() => (
      [...document.querySelectorAll('#workFormSelect option')]
        .some((option) => option.textContent?.trim() === 'Inspection form')
    ));

    const reportTemplateOptions = await page.locator('#workFormSelect option').allTextContents();
    if (
      !reportTemplateOptions.includes('Inspection form')
      || reportTemplateOptions.some((label) => /daywork/i.test(label))
      || !allRequestsAreReportScoped('/api/work-forms')
    ) {
      throw new Error(`New Report did not enforce the report template boundary: ${JSON.stringify({
        reportTemplateOptions,
        scopedRequests
      })}`);
    }

    await page.locator('#workFormSelect').selectOption({ label: 'Inspection form' });
    await page.locator('#workFormDate').fill('2026-09-01');
    await page.locator('#workFormField_inspection_area').fill(reportMarker);
    await page.locator('#workFormField_inspection_result').selectOption('Pass');
    await page.locator('#submitWorkFormButton').click();
    await page.locator('#workFormFeedback').getByText('Inspection form submitted for review').waitFor({ timeout: 20000 });

    await page.locator('.tab[data-tab-target="historyTab"]').click();
    const submittedReport = page.locator('#historyList .record-form').filter({ hasText: reportMarker }).first();
    await submittedReport.waitFor({ state: 'visible', timeout: 20000 });
    const myReportsText = await page.locator('#historyList').innerText();
    if (
      /Daywork log form/i.test(myReportsText)
      || !allRequestsAreReportScoped('/api/my-form-submissions')
    ) {
      throw new Error(`My Reports crossed into Daywork: ${JSON.stringify({ myReportsText, scopedRequests })}`);
    }

    await logout(page);
    await loginAs(page, 'supervisor@example.com', 'supervisor');
    const supervisorReport = page.locator('#reviewQueueList .record-form').filter({ hasText: reportMarker }).first();
    await supervisorReport.waitFor({ state: 'visible', timeout: 20000 });
    const supervisorReportsText = await page.locator('#reviewQueueList').innerText();
    const templateFilters = await page.locator('#supervisorTemplateFilter option').allTextContents();
    const dayworkPdfControl = page.locator('#exportDocumentSelect option[value="daywork-pdf"]');
    const dayworkPdfState = await dayworkPdfControl.evaluate((option) => ({
      hidden: option.hidden,
      disabled: option.disabled,
      visible: Boolean(option.getClientRects().length)
    }));
    if (
      /Daywork log form/i.test(supervisorReportsText)
      || templateFilters.some((label) => /daywork/i.test(label))
      || !dayworkPdfState.hidden
      || !dayworkPdfState.disabled
      || dayworkPdfState.visible
      || !allRequestsAreReportScoped('/api/supervisor/review-queue')
    ) {
      throw new Error(`Supervisor Reports crossed into Daywork: ${JSON.stringify({
        supervisorReportsText,
        templateFilters,
        dayworkPdfState,
        scopedRequests
      })}`);
    }

    const exportResponsePromise = page.waitForResponse((response) => (
      new URL(response.url()).pathname === '/api/supervisor/form-submissions/export.csv'
    ), { timeout: 20000 });
    await page.locator('#exportReportsCsvButton').click();
    const exportResponse = await exportResponsePromise;
    if (
      !exportResponse.ok()
      || new URL(exportResponse.url()).searchParams.get('purpose') !== 'report'
    ) {
      throw new Error(`Report collection export was not report-scoped: ${exportResponse.url()}`);
    }

    const pdfResponsePromise = page.waitForResponse((response) => (
      new URL(response.url()).pathname === '/api/supervisor/form-submissions/export.pdf'
    ), { timeout: 20000 });
    await page.locator('#exportReportsPdfButton').click();
    const pdfResponse = await pdfResponsePromise;
    if (
      !pdfResponse.ok()
      || new URL(pdfResponse.url()).searchParams.get('purpose') !== 'report'
    ) {
      throw new Error(`Report PDF collection export was not report-scoped: ${pdfResponse.url()}`);
    }
  } finally {
    await reportContext.close();
  }
}

async function checkReportOnlyOfflineHistoryFallback(browser) {
  const context = await newContext(browser, { reportOnly: true });
  const page = await context.newPage();
  const stamp = Date.now();
  const queuedReportMarker = `Queued Report ${stamp}`;
  const syncingReportMarker = `Syncing Report ${stamp}`;
  const dayworkMarker = `Hidden Daywork ${stamp}`;
  const staleReportMarker = `Stale synced Report ${stamp}`;
  const attendanceMarker = `Hidden attendance ${stamp}`;

  try {
    await loginAs(page, 'worker@example.com', 'worker');
    await page.evaluate(async ({ markers }) => {
      const { state } = await import('/assets/js/app-shell-state.js');
      const { put } = await import('/assets/js/db.js');
      const common = {
        userId: state.user.id,
        userName: state.user.fullName,
        siteId: null,
        siteName: 'Unassigned site',
        createdAt: new Date().toISOString(),
        answers: {},
        fields: []
      };
      await Promise.all([
        put('records', {
          ...common,
          id: `offline-report-queued-${markers.stamp}`,
          type: 'form',
          formId: 501,
          formName: markers.queuedReport,
          submissionPurpose: 'report',
          syncStatus: 'queued'
        }),
        put('records', {
          ...common,
          id: `offline-report-syncing-${markers.stamp}`,
          type: 'form',
          formId: 502,
          formName: markers.syncingReport,
          submissionPurpose: 'report',
          syncStatus: 'syncing'
        }),
        put('records', {
          ...common,
          id: `offline-daywork-${markers.stamp}`,
          type: 'form',
          formId: 503,
          formName: markers.daywork,
          submissionPurpose: 'daywork',
          syncStatus: 'queued'
        }),
        put('records', {
          ...common,
          id: `offline-report-synced-${markers.stamp}`,
          type: 'form',
          formId: 504,
          formName: markers.staleReport,
          submissionPurpose: 'report',
          syncStatus: 'synced',
          backendRecordId: 999999
        }),
        put('records', {
          ...common,
          id: `offline-attendance-${markers.stamp}`,
          type: 'attendance',
          notes: markers.attendance,
          syncStatus: 'queued'
        })
      ]);
    }, {
      markers: {
        stamp,
        queuedReport: queuedReportMarker,
        syncingReport: syncingReportMarker,
        daywork: dayworkMarker,
        staleReport: staleReportMarker,
        attendance: attendanceMarker
      }
    });

    await page.route('**/api/my-form-submissions?**', (route) => route.abort('failed'));
    await page.locator('.tab[data-tab-target="historyTab"]').click();
    await page.locator('#refreshHistoryButton').click();
    await page.waitForFunction((marker) => (
      document.querySelector('#historyList')?.textContent?.includes(marker)
    ), queuedReportMarker, { timeout: 15000 });

    const historyText = await page.locator('#historyList').innerText();
    if (
      !historyText.includes(queuedReportMarker)
      || !historyText.includes(syncingReportMarker)
      || historyText.includes(dayworkMarker)
      || historyText.includes(staleReportMarker)
      || historyText.includes(attendanceMarker)
    ) {
      throw new Error(`offline My Reports fallback crossed the Report queue boundary: ${historyText}`);
    }
  } finally {
    await context.close();
  }
}

async function checkExplicitReportPurposeOverridesDayworkName(browser) {
  const context = await newContext(browser, { reportOnly: true });
  const page = await context.newPage();
  const stamp = Date.now();
  const templateName = `Daywork PPE Issue Report ${stamp}`;
  const answerMarker = `Legitimate report answer ${stamp}`;

  try {
    await loginAs(page, 'supervisor@example.com', 'supervisor');
    const createdTemplate = await page.evaluate(async ({ name }) => {
      const { createWorkForm } = await import('/assets/js/api-client.js');
      return await createWorkForm({
        name,
        description: 'Legitimate PPE safety Report despite its historical name.',
        fields: [{ id: 'issue', label: 'PPE issue', type: 'text', required: true }]
      });
    }, { name: templateName });
    if (createdTemplate.template_purpose !== 'report') {
      throw new Error(`backend did not classify the legitimate named Report explicitly: ${JSON.stringify(createdTemplate)}`);
    }

    await logout(page);
    await loginAs(page, 'worker@example.com', 'worker');
    await page.locator('.tab[data-tab-target="formTab"]').click();
    await page.waitForFunction((name) => (
      [...document.querySelectorAll('#workFormSelect option')]
        .some((option) => option.textContent?.trim() === name)
    ), templateName, { timeout: 15000 });
    await page.locator('#workFormSelect').selectOption({ label: templateName });
    await page.locator('#workFormDate').fill('2026-09-01');
    await page.locator('#workFormField_issue').fill(answerMarker);
    await page.locator('#submitWorkFormButton').click();
    await page.locator('#workFormFeedback').getByText(`${templateName} submitted for review`).waitFor({ timeout: 20000 });

    await page.locator('.tab[data-tab-target="historyTab"]').click();
    await page.locator('#historyList .record-form').filter({ hasText: answerMarker }).first()
      .waitFor({ state: 'visible', timeout: 20000 });

    await logout(page);
    await loginAs(page, 'supervisor@example.com', 'supervisor');
    await page.locator('#reviewQueueList .record-form').filter({ hasText: answerMarker }).first()
      .waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForFunction((name) => (
      [...document.querySelectorAll('#supervisorTemplateFilter option')]
        .some((option) => option.textContent?.trim() === name)
    ), templateName, { timeout: 15000 });
    const templateOptions = await page.locator('#supervisorTemplateFilter option').allTextContents();
    if (!templateOptions.includes(templateName)) {
      throw new Error(`Supervisor Reports hid an explicit Report because of its name: ${JSON.stringify(templateOptions)}`);
    }
  } finally {
    await context.close();
  }

  const retainedContext = await newContext(browser, { reportOnly: false });
  const retainedPage = await retainedContext.newPage();
  try {
    await loginAs(retainedPage, 'worker@example.com', 'worker');
    await retainedPage.locator('.tab[data-tab-target="taskTab"]').click();
    await retainedPage.locator('#dayworkFormField_client').waitFor({ state: 'visible', timeout: 15000 });
    const retainedDayworkState = await retainedPage.evaluate((reportName) => ({
      hint: document.querySelector('#dayworkFormHint')?.textContent || '',
      hasReportField: Boolean(document.querySelector('#dayworkFormField_issue')),
      reportTemplateAvailable: [...document.querySelectorAll('#workFormSelect option')]
        .some((option) => option.textContent?.trim() === reportName)
    }), templateName);
    if (
      retainedDayworkState.hint.includes(templateName)
      || retainedDayworkState.hasReportField
      || !retainedDayworkState.reportTemplateAvailable
    ) {
      throw new Error(`retained Daywork selector did not respect explicit purpose: ${JSON.stringify(retainedDayworkState)}`);
    }
  } finally {
    await retainedContext.close();
  }
}

async function checkReportOnlyReplayScope(browser) {
  let context = await newContext(browser, { reportOnly: true });
  let page = await context.newPage();
  const postRequests = [];
  const trackPostRequests = (targetPage) => {
    targetPage.on('request', (request) => {
      const url = new URL(request.url());
      if (request.method() === 'POST' && [
        '/api/attendance',
        '/api/task-logs',
        '/api/form-submissions'
      ].includes(url.pathname)) {
        postRequests.push({
          path: url.pathname,
          body: request.postDataJSON()
        });
      }
    });
  };
  trackPostRequests(page);

  const seedQueue = async (targetPage, suffix, includeHidden = false) => await targetPage.evaluate(async ({ queueSuffix, withHidden }) => {
    const { state } = await import('/assets/js/app-shell-state.js');
    const { getWorkForms } = await import('/assets/js/api-client.js');
    const { put } = await import('/assets/js/db.js');
    const reportForm = state.workForms.find((form) => form.name === 'Inspection form');
    const dayworkForm = (await getWorkForms('daywork'))[0];
    if (!reportForm || (withHidden && !dayworkForm)) throw new Error('Replay fixture forms are unavailable.');
    const now = new Date().toISOString();
    const owner = {
      ownerWorkerId: state.user.id,
      ownerWorkerName: state.user.fullName,
      userId: state.user.id,
      userName: state.user.fullName,
      capturedAt: now,
      createdAt: now,
      syncStatus: 'queued',
      photoDataUrls: [],
      photoUrls: [],
      photoMetadata: []
    };
    const reportId = `report-replay-${queueSuffix}`;
    const records = [{
      ...owner,
      id: reportId,
      clientSubmissionId: reportId,
      type: 'form',
      submissionPurpose: 'report',
      formId: reportForm.id,
      formName: `Replay Report ${queueSuffix}`,
      fields: reportForm.fields,
      answers: {
        inspection_area: `Replay area ${queueSuffix}`,
        inspection_result: 'Pass',
        issues_found: '',
        follow_up_required: false
      },
      siteId: null,
      siteName: 'Unassigned site',
      workDate: '2026-09-01'
    }];
    if (withHidden) {
      records.push(
        {
          ...owner,
          id: `daywork-replay-${queueSuffix}`,
          clientSubmissionId: `daywork-replay-${queueSuffix}`,
          type: 'form',
          submissionPurpose: 'daywork',
          formId: dayworkForm.id,
          formName: dayworkForm.name,
          fields: dayworkForm.fields,
          answers: {},
          siteId: null,
          siteName: 'Unassigned site',
          workDate: '2026-09-01'
        },
        {
          ...owner,
          id: `attendance-replay-${queueSuffix}`,
          clientSubmissionId: `attendance-replay-${queueSuffix}`,
          type: 'attendance',
          action: 'check_in',
          siteId: null,
          siteName: 'Unassigned site',
          location: { latitude: -36.8485, longitude: 174.7633, accuracy: 10, capturedAt: now }
        },
        {
          ...owner,
          id: `task-replay-${queueSuffix}`,
          clientSubmissionId: `task-replay-${queueSuffix}`,
          type: 'task',
          summary: 'Hidden task replay fixture',
          siteId: null,
          siteName: 'Unassigned site',
          workDate: '2026-09-01'
        }
      );
    }
    await Promise.all(records.flatMap((record) => [
      put('records', record),
      put('queue', {
        id: record.id,
        kind: record.type,
        ownerWorkerId: record.ownerWorkerId,
        capturedAt: record.capturedAt,
        createdAt: record.createdAt,
        syncStartedAt: ''
      })
    ]));
    return {
      reportId,
      reportFormId: reportForm.id,
      hiddenIds: records.slice(1).map((record) => record.id)
    };
  }, { queueSuffix: suffix, withHidden: includeHidden });

  try {
    await loginAs(page, 'worker@example.com', 'worker');
    const automatic = await seedQueue(page, `automatic-${Date.now()}`, true);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(async (recordId) => {
      const { get } = await import('/assets/js/db.js');
      return (await get('records', recordId))?.syncStatus === 'synced';
    }, automatic.reportId, { timeout: 20000, polling: 100 });
    await page.waitForFunction(() => (
      document.querySelector('#syncIndicator')?.textContent?.includes('Online - 1 synced')
    ), null, { timeout: 10000 });

    const automaticHidden = await page.evaluate(async (ids) => {
      const { get } = await import('/assets/js/db.js');
      return await Promise.all(ids.map(async (id) => ({ id, record: await get('records', id), queue: await get('queue', id) })));
    }, automatic.hiddenIds);
    const automaticPosts = [...postRequests];
    if (
      automaticPosts.length !== 1
      || automaticPosts[0].path !== '/api/form-submissions'
      || Number(automaticPosts[0].body.form_id) !== Number(automatic.reportFormId)
      || automaticHidden.some((item) => item.record?.syncStatus !== 'queued' || !item.queue)
    ) {
      throw new Error(`report-only automatic replay crossed hidden queues: ${JSON.stringify({ automaticPosts, automaticHidden })}`);
    }

    await context.close();
    context = await newContext(browser, { reportOnly: true });
    page = await context.newPage();
    postRequests.length = 0;
    trackPostRequests(page);
    await loginAs(page, 'worker@example.com', 'worker');

    const manual = await seedQueue(page, `manual-${Date.now()}`, false);
    await page.locator('.tab[data-tab-target="historyTab"]').click();
    await page.locator('#refreshHistoryButton').click();
    const manualCard = page.locator('#historyList .record-form').filter({ hasText: `Replay Report manual-` }).first();
    await manualCard.waitFor({ state: 'visible', timeout: 15000 });
    const manualRequestPromise = page.waitForRequest((request) => (
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/form-submissions'
    ), { timeout: 15000 });
    await manualCard.getByRole('button', { name: 'Retry sync' }).click();
    await manualRequestPromise;
    await page.waitForFunction(async (recordId) => {
      const { get } = await import('/assets/js/db.js');
      return (await get('records', recordId))?.syncStatus === 'synced';
    }, manual.reportId, { timeout: 20000, polling: 100 });

    if (
      postRequests.length !== 1
      || postRequests.some((request) => request.path !== '/api/form-submissions')
      || postRequests.some((request) => Number(request.body.form_id) !== Number(manual.reportFormId))
    ) {
      throw new Error(`report-only manual replay crossed hidden queues: ${JSON.stringify(postRequests)}`);
    }
  } finally {
    await context.close();
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
    await page.locator('#dayworkFormFields [data-team-member-choice]').first()
      .waitFor({ state: 'visible', timeout: 20000 });
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
  const nativeDialogs = [];
  supervisorPage.on('dialog', async (dialog) => {
    nativeDialogs.push({ message: dialog.message(), type: dialog.type() });
    await dialog.dismiss();
  });

  try {
    await loginAs(supervisorPage, 'supervisor@example.com', 'supervisor');
    await openAdminWorkspace(supervisorPage, 'people');
    await supervisorPage.locator('#staffUsersDetails').evaluate((element) => {
      element.open = true;
    });
    await supervisorPage.locator('#staffUsersList .record-card').first().waitFor({ timeout: 20000 });
    const departmentCreateState = await supervisorPage.evaluate(() => ({
      panelHidden: document.querySelector('#staffUserCreatePanel')?.hidden ?? null,
      expanded: document.querySelector('#addStaffUserButton')?.getAttribute('aria-expanded'),
      addDisabled: document.querySelector('#addStaffUserButton')?.disabled ?? null,
      searchVisible: document.querySelector('#staffSearchInput')?.getClientRects().length > 0,
      listVisible: document.querySelector('#staffUsersList')?.getClientRects().length > 0
    }));
    if (
      !departmentCreateState.panelHidden
      || departmentCreateState.expanded !== 'false'
      || departmentCreateState.addDisabled
      || !departmentCreateState.searchVisible
      || !departmentCreateState.listVisible
    ) {
      throw new Error(`department Staff list did not start list-first: ${JSON.stringify(departmentCreateState)}`);
    }
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

    const statusRequests = [];
    await supervisorPage.route('**/api/supervisor/users/*/status', async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') {
        await route.continue();
        return;
      }
      statusRequests.push(request.postDataJSON());
      await new Promise((resolve) => setTimeout(resolve, 250));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({})
      });
    });

    const workerCard = supervisorPage.locator('#staffUsersList .record-card')
      .filter({ hasText: 'worker@example.com' })
      .first();
    const resignButton = workerCard.getByRole('button', { name: 'Mark resigned' });
    await resignButton.waitFor({ state: 'visible', timeout: 10000 });
    await resignButton.focus();
    await resignButton.click();
    const confirmationDialog = supervisorPage.locator('#confirmationDialog');
    await confirmationDialog.waitFor({ state: 'visible', timeout: 5000 });
    await supervisorPage.waitForFunction(() => document.activeElement?.id === 'confirmationDialogCancelButton');
    await supervisorPage.keyboard.press('Escape');
    await confirmationDialog.waitFor({ state: 'hidden', timeout: 5000 });
    await supervisorPage.waitForTimeout(100);
    const cancelState = await supervisorPage.evaluate(() => ({
      focusedText: document.activeElement?.textContent?.trim(),
      dialogOpen: document.querySelector('#confirmationDialog')?.open
    }));
    if (statusRequests.length || cancelState.dialogOpen || cancelState.focusedText !== 'Mark resigned') {
      throw new Error(`cancelled account status change was not side-effect free: ${JSON.stringify({ cancelState, statusRequests })}`);
    }

    await resignButton.click();
    await confirmationDialog.waitFor({ state: 'visible', timeout: 5000 });
    const statusRequestPromise = supervisorPage.waitForRequest((request) => (
      request.method() === 'POST'
      && /\/api\/supervisor\/users\/\d+\/status$/.test(new URL(request.url()).pathname)
    ));
    await supervisorPage.locator('#confirmationDialogConfirmButton').click();
    await supervisorPage.waitForFunction(() => (
      [...document.querySelectorAll('#staffUsersList .record-card')]
        .find((card) => card.textContent.includes('worker@example.com'))
        ?.querySelector('button[aria-busy="true"]')?.disabled === true
    ));
    await supervisorPage.keyboard.press('Enter');
    const statusRequest = await statusRequestPromise;
    await statusRequest.response();
    await supervisorPage.waitForFunction(() => (
      [...document.querySelectorAll('#staffUsersList .record-card')]
        .find((card) => card.textContent.includes('worker@example.com'))
        ?.querySelector('button')?.getClientRects().length > 0
    ));
    if (
      statusRequests.length !== 1
      || statusRequests[0]?.status !== 'resigned'
      || statusRequests[0]?.confirmed !== true
      || statusRequest.postDataJSON()?.status !== 'resigned'
    ) {
      throw new Error(`confirmed account status change did not send exactly one request: ${JSON.stringify(statusRequests)}`);
    }
    await supervisorPage.unroute('**/api/supervisor/users/*/status');

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
    if (nativeDialogs.length) {
      throw new Error(`staff status change used native dialogs: ${JSON.stringify(nativeDialogs)}`);
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
    const initialStaffCreateState = await adminPage.evaluate(() => ({
      panelHidden: document.querySelector('#staffUserCreatePanel')?.hidden ?? null,
      expanded: document.querySelector('#addStaffUserButton')?.getAttribute('aria-expanded'),
      addDisabled: document.querySelector('#addStaffUserButton')?.disabled ?? null,
      searchVisible: document.querySelector('#staffSearchInput')?.getClientRects().length > 0,
      listVisible: document.querySelector('#staffUsersList')?.getClientRects().length > 0
    }));
    if (
      !initialStaffCreateState.panelHidden
      || initialStaffCreateState.expanded !== 'false'
      || initialStaffCreateState.addDisabled
      || !initialStaffCreateState.searchVisible
      || !initialStaffCreateState.listVisible
    ) {
      throw new Error(`Staff creation was not behind Add: ${JSON.stringify(initialStaffCreateState)}`);
    }

    await adminPage.locator('#addStaffUserButton').click();
    await adminPage.waitForFunction(() => (
      document.querySelector('#staffUserCreatePanel')?.hidden === false
      && document.querySelector('#addStaffUserButton')?.getAttribute('aria-expanded') === 'true'
      && document.querySelector('#addStaffUserButton')?.disabled === true
      && document.activeElement?.id === 'staffNameInput'
    ));
    await adminPage.locator('#staffNameInput').fill('Discarded staff draft');
    await adminPage.locator('#staffPasswordInput').fill('DiscardedPassword1!');
    await adminPage.locator('#cancelStaffUserCreateButton').click();
    await adminPage.waitForFunction(() => (
      document.querySelector('#staffUserCreatePanel')?.hidden === true
      && document.querySelector('#addStaffUserButton')?.getAttribute('aria-expanded') === 'false'
      && document.querySelector('#addStaffUserButton')?.disabled === false
      && document.activeElement?.id === 'addStaffUserButton'
    ));
    if (await adminPage.locator('#staffNameInput').inputValue() || await adminPage.locator('#staffPasswordInput').inputValue()) {
      throw new Error('Cancel Staff creation did not clear its draft fields');
    }

    await adminPage.locator('#addStaffUserButton').click();
    await adminPage.waitForFunction(() => document.activeElement?.id === 'staffNameInput');
    const adminControls = await adminPage.evaluate(() => {
      const globalAdminLabel = document.querySelector('#staffGlobalAdminInput')?.closest('label');
      return {
        globalAdminLabelVisible: globalAdminLabel
          ? !globalAdminLabel.classList.contains('hidden') && getComputedStyle(globalAdminLabel).display !== 'none'
          : null,
        globalAdminInputDisabled: document.querySelector('#staffGlobalAdminInput')?.disabled ?? null,
        globalAdminInputChecked: document.querySelector('#staffGlobalAdminInput')?.checked ?? null,
        workerClassDisabled: document.querySelector('#staffWorkerClassSelect')?.disabled ?? null,
        departmentSelectDisabled: document.querySelector('#staffDepartmentSelect')?.disabled ?? null
      };
    });
    if (
      !adminControls.globalAdminLabelVisible
      || adminControls.globalAdminInputDisabled !== true
      || adminControls.globalAdminInputChecked
      || adminControls.workerClassDisabled
      || adminControls.departmentSelectDisabled
    ) {
      throw new Error(`Worker create role did not constrain global admin access: ${JSON.stringify(adminControls)}`);
    }

    await adminPage.locator('#staffRoleSelect').selectOption('supervisor');
    const supervisorCreateControls = await adminPage.evaluate(() => ({
      globalAdminInputDisabled: document.querySelector('#staffGlobalAdminInput')?.disabled ?? null,
      workerClassDisabled: document.querySelector('#staffWorkerClassSelect')?.disabled ?? null
    }));
    if (supervisorCreateControls.globalAdminInputDisabled || !supervisorCreateControls.workerClassDisabled) {
      throw new Error(`Supervisor create role did not enable global admin access: ${JSON.stringify(supervisorCreateControls)}`);
    }

    await adminPage.locator('label:has(#staffGlobalAdminInput) .form-checkbox-control').click();
    await adminPage.locator('#staffRoleSelect').selectOption('worker');
    const resetCreateControls = await adminPage.evaluate(() => ({
      globalAdminInputDisabled: document.querySelector('#staffGlobalAdminInput')?.disabled ?? null,
      globalAdminInputChecked: document.querySelector('#staffGlobalAdminInput')?.checked ?? null,
      workerClassDisabled: document.querySelector('#staffWorkerClassSelect')?.disabled ?? null
    }));
    if (
      resetCreateControls.globalAdminInputDisabled !== true
      || resetCreateControls.globalAdminInputChecked
      || resetCreateControls.workerClassDisabled
    ) {
      throw new Error(`Worker create role retained global admin access: ${JSON.stringify(resetCreateControls)}`);
    }

    const createdStaffName = `Created Staff ${Date.now()}`;
    const createdStaffEmail = `created-staff-${Date.now()}@example.com`;
    await adminPage.locator('#staffNameInput').fill(createdStaffName);
    await adminPage.locator('#staffEmailInput').fill(createdStaffEmail);
    await adminPage.locator('#staffPasswordInput').fill('CreatedStaffPassword1!');

    let rejectNextStaffCreate = true;
    await adminPage.route('**/api/supervisor/users', async (route) => {
      const request = route.request();
      const isCreate = request.method() === 'POST'
        && new URL(request.url()).pathname === '/api/supervisor/users';
      if (isCreate && rejectNextStaffCreate) {
        rejectNextStaffCreate = false;
        await new Promise((resolve) => setTimeout(resolve, 200));
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'Simulated Staff create failure.' })
        });
        return;
      }
      await route.continue();
    });

    await adminPage.locator('#staffUserSubmitButton').click();
    await adminPage.waitForFunction(() => (
      document.querySelector('#staffUserSubmitButton')?.getAttribute('aria-busy') === 'true'
      && document.querySelector('#cancelStaffUserCreateButton')?.disabled === true
      && document.querySelector('#addStaffUserButton')?.disabled === true
    ));
    await adminPage.locator('#toastViewport .toast')
      .filter({ hasText: 'Simulated Staff create failure.' })
      .waitFor({ timeout: 10000 });
    const failedStaffCreateState = await adminPage.evaluate(() => ({
      panelHidden: document.querySelector('#staffUserCreatePanel')?.hidden ?? null,
      addDisabled: document.querySelector('#addStaffUserButton')?.disabled ?? null,
      cancelDisabled: document.querySelector('#cancelStaffUserCreateButton')?.disabled ?? null,
      submitBusy: document.querySelector('#staffUserSubmitButton')?.getAttribute('aria-busy'),
      name: document.querySelector('#staffNameInput')?.value || '',
      email: document.querySelector('#staffEmailInput')?.value || ''
    }));
    if (
      failedStaffCreateState.panelHidden
      || !failedStaffCreateState.addDisabled
      || failedStaffCreateState.cancelDisabled
      || failedStaffCreateState.submitBusy !== null
      || failedStaffCreateState.name !== createdStaffName
      || failedStaffCreateState.email !== createdStaffEmail
    ) {
      throw new Error(`failed Staff creation hid or cleared the retry state: ${JSON.stringify(failedStaffCreateState)}`);
    }

    const createStaffRequestPromise = adminPage.waitForRequest((request) => (
      request.method() === 'POST'
      && new URL(request.url()).pathname === '/api/supervisor/users'
    ), { timeout: 8000 });
    await adminPage.locator('#staffUserSubmitButton').click();
    await createStaffRequestPromise;
    await adminPage.locator('#toastViewport .toast')
      .filter({ hasText: 'Staff user created.' })
      .waitFor({ timeout: 20000 });
    await adminPage.waitForFunction(() => (
      document.querySelector('#staffUserCreatePanel')?.hidden === true
      && document.querySelector('#addStaffUserButton')?.getAttribute('aria-expanded') === 'false'
      && document.querySelector('#addStaffUserButton')?.disabled === false
      && document.activeElement?.id === 'addStaffUserButton'
    ));
    await adminPage.locator('#staffUsersList .record-card')
      .filter({ hasText: createdStaffName })
      .first()
      .waitFor({ timeout: 20000 });
    await adminPage.unroute('**/api/supervisor/users');

    await adminPage.locator('#addStaffUserButton').click();
    const refreshWarningStaffName = `Refresh Warning Staff ${Date.now()}`;
    await adminPage.locator('#staffNameInput').fill(refreshWarningStaffName);
    await adminPage.locator('#staffEmailInput').fill(`refresh-warning-${Date.now()}@example.com`);
    await adminPage.locator('#staffPasswordInput').fill('RefreshWarningPassword1!');
    let staffCreateCompleted = false;
    await adminPage.route('**/api/supervisor/users', async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (request.method() === 'POST' && pathname === '/api/supervisor/users') {
        staffCreateCompleted = true;
        await route.continue();
        return;
      }
      if (staffCreateCompleted && request.method() === 'GET' && pathname === '/api/supervisor/users') {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'Simulated Staff list refresh failure.' })
        });
        return;
      }
      await route.continue();
    });
    const refreshWarningCreateResponsePromise = adminPage.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/supervisor/users'
    ), { timeout: 20000 });
    const refreshWarningListResponsePromise = adminPage.waitForResponse((response) => (
      response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/supervisor/users'
      && response.status() === 503
    ), { timeout: 20000 });
    await adminPage.locator('#staffUserSubmitButton').click();
    const refreshWarningCreateResponse = await refreshWarningCreateResponsePromise;
    if (!refreshWarningCreateResponse.ok()) {
      throw new Error(`Staff refresh-warning setup failed to create its user: ${refreshWarningCreateResponse.status()}`);
    }
    await refreshWarningListResponsePromise;
    await adminPage.locator('#toastViewport .toast')
      .filter({ hasText: 'Staff user created, but the updated list could not load.' })
      .waitFor({ timeout: 20000 });
    await adminPage.waitForFunction(() => document.activeElement?.id === 'addStaffUserButton');
    const refreshFailureState = await adminPage.evaluate((previousName) => ({
      panelHidden: document.querySelector('#staffUserCreatePanel')?.hidden ?? null,
      addDisabled: document.querySelector('#addStaffUserButton')?.disabled ?? null,
      listPreserved: [...document.querySelectorAll('#staffUsersList .record-card')]
        .some((card) => card.textContent.includes(previousName)),
      unavailableShown: document.querySelector('#staffUsersList')?.textContent?.includes('Staff users are unavailable.') ?? null,
      activeElementId: document.activeElement?.id || ''
    }), createdStaffName);
    if (
      !refreshFailureState.panelHidden
      || refreshFailureState.addDisabled
      || !refreshFailureState.listPreserved
      || refreshFailureState.unavailableShown
      || refreshFailureState.activeElementId !== 'addStaffUserButton'
    ) {
      throw new Error(`Staff refresh failure did not preserve the prior list and completion state: ${JSON.stringify(refreshFailureState)}`);
    }
    await adminPage.unroute('**/api/supervisor/users');

    const demoWorkerCard = adminPage.locator('#staffUsersList .record-card')
      .filter({ hasText: 'Demo Worker' })
      .first();
    await demoWorkerCard.getByRole('button', { name: 'Edit user' }).click();
    await adminPage.locator('#editUserRole').waitFor({ state: 'visible', timeout: 10000 });
    const initialEditControls = await adminPage.evaluate(() => ({
      globalAdminValue: document.querySelector('#editUserGlobalAdmin')?.value ?? null,
      globalAdminDisabled: document.querySelector('#editUserGlobalAdmin')?.disabled ?? null,
      workerClassDisabled: document.querySelector('#editUserWorkerClass')?.disabled ?? null
    }));
    if (
      initialEditControls.globalAdminValue !== 'false'
      || initialEditControls.globalAdminDisabled !== true
      || initialEditControls.workerClassDisabled
    ) {
      throw new Error(`Worker edit role did not constrain global admin access: ${JSON.stringify(initialEditControls)}`);
    }

    await adminPage.locator('#editUserRole').selectOption('supervisor');
    if (
      await adminPage.locator('#editUserGlobalAdmin').isDisabled()
      || !await adminPage.locator('#editUserWorkerClass').isDisabled()
    ) {
      throw new Error('Supervisor edit role did not enable global admin access');
    }
    await adminPage.locator('#editUserGlobalAdmin').selectOption('true');
    await adminPage.locator('#editUserRole').selectOption('worker');
    const resetEditControls = await adminPage.evaluate(() => ({
      globalAdminValue: document.querySelector('#editUserGlobalAdmin')?.value ?? null,
      globalAdminDisabled: document.querySelector('#editUserGlobalAdmin')?.disabled ?? null,
      workerClassDisabled: document.querySelector('#editUserWorkerClass')?.disabled ?? null
    }));
    if (
      resetEditControls.globalAdminValue !== 'false'
      || resetEditControls.globalAdminDisabled !== true
      || resetEditControls.workerClassDisabled
    ) {
      throw new Error(`Worker edit role retained global admin access: ${JSON.stringify(resetEditControls)}`);
    }

    await adminPage.locator('#addStaffUserButton').click();
    await adminPage.waitForFunction(() => document.activeElement?.id === 'staffNameInput');
    await adminPage.locator('#staffRoleSelect').selectOption('supervisor');
    await adminPage.locator('label:has(#staffGlobalAdminInput) .form-checkbox-control').click();
    await adminPage.locator('#staffSearchInput').fill('privileged state must clear');
    await adminPage.locator('#editUserRole').selectOption('supervisor');
    await adminPage.locator('#editUserGlobalAdmin').selectOption('true');
    await logout(adminPage);

    const loggedOutStaffState = await adminPage.evaluate(() => ({
      count: document.querySelector('#staffUsersCount')?.textContent?.trim() ?? null,
      listText: document.querySelector('#staffUsersList')?.textContent?.trim() ?? null,
      createPanelHidden: document.querySelector('#staffUserCreatePanel')?.hidden ?? null,
      createExpanded: document.querySelector('#addStaffUserButton')?.getAttribute('aria-expanded'),
      createAddDisabled: document.querySelector('#addStaffUserButton')?.disabled ?? null,
      editPanelHidden: document.querySelector('#supervisorEditPanel')?.classList.contains('hidden') ?? null,
      editPanelEmpty: !(document.querySelector('#editPanelForm')?.textContent || '').trim()
    }));
    if (
      loggedOutStaffState.count !== '0'
      || loggedOutStaffState.listText !== ''
      || !loggedOutStaffState.createPanelHidden
      || loggedOutStaffState.createExpanded !== 'false'
      || loggedOutStaffState.createAddDisabled
      || !loggedOutStaffState.editPanelHidden
      || !loggedOutStaffState.editPanelEmpty
    ) {
      throw new Error(`Staff data survived logout: ${JSON.stringify(loggedOutStaffState)}`);
    }

    await adminPage.locator('#emailInput').fill('supervisor@example.com');
    await adminPage.locator('#passwordInput').fill(password);
    await adminPage.locator('#loginForm button[type="submit"]').click();
    await adminPage.waitForFunction(() => document.body.dataset.activeView === 'supervisor', null, { timeout: 20000 });
    await adminPage.locator('#supervisorView').waitFor({ state: 'visible', timeout: 20000 });
    await openAdminWorkspace(adminPage, 'people');
    await adminPage.locator('#staffUsersDetails').evaluate((element) => {
      element.open = true;
    });
    await adminPage.locator('#staffUsersList .record-card').filter({ hasText: 'Demo Worker' }).first().waitFor({ timeout: 20000 });

    const resetSessionControls = await adminPage.evaluate(() => ({
      role: document.querySelector('#staffRoleSelect')?.value ?? null,
      globalAdminChecked: document.querySelector('#staffGlobalAdminInput')?.checked ?? null,
      globalAdminDisabled: document.querySelector('#staffGlobalAdminInput')?.disabled ?? null,
      search: document.querySelector('#staffSearchInput')?.value ?? null,
      createPanelHidden: document.querySelector('#staffUserCreatePanel')?.hidden ?? null,
      createExpanded: document.querySelector('#addStaffUserButton')?.getAttribute('aria-expanded'),
      createAddDisabled: document.querySelector('#addStaffUserButton')?.disabled ?? null,
      editPanelHidden: document.querySelector('#supervisorEditPanel')?.classList.contains('hidden') ?? null,
      editPanelEmpty: !(document.querySelector('#editPanelForm')?.textContent || '').trim()
    }));
    if (
      resetSessionControls.role !== 'worker'
      || resetSessionControls.globalAdminChecked
      || resetSessionControls.globalAdminDisabled !== true
      || resetSessionControls.search !== ''
      || !resetSessionControls.createPanelHidden
      || resetSessionControls.createExpanded !== 'false'
      || resetSessionControls.createAddDisabled
      || !resetSessionControls.editPanelHidden
      || !resetSessionControls.editPanelEmpty
    ) {
      throw new Error(`Staff privilege controls survived logout: ${JSON.stringify(resetSessionControls)}`);
    }

    const departmentReloginText = await adminPage.locator('#staffUsersList').innerText();
    if (departmentReloginText.includes('Super Admin') || departmentReloginText.includes('global admin')) {
      throw new Error(`department Supervisor inherited global staff data: "${departmentReloginText}"`);
    }

    await logout(adminPage);
    await adminPage.locator('#emailInput').fill('admin@example.com');
    await adminPage.locator('#passwordInput').fill(password);
    await adminPage.locator('#loginForm button[type="submit"]').click();
    await adminPage.waitForFunction(() => document.body.dataset.activeView === 'supervisor', null, { timeout: 20000 });
    await openAdminWorkspace(adminPage, 'people');
    await adminPage.locator('#staffUsersDetails').evaluate((element) => {
      element.open = true;
    });
    await adminPage.locator('#staffUsersList .record-card').filter({ hasText: 'Super Admin' }).first().waitFor({ timeout: 20000 });

    const selfCard = adminPage.locator('#staffUsersList .record-card')
      .filter({ hasText: 'Super Admin' })
      .first();
    await selfCard.getByRole('button', { name: 'Edit user' }).click();
    await adminPage.locator('#editUserRole').waitFor({ state: 'visible', timeout: 10000 });
    const selfEditControls = await adminPage.evaluate(() => ({
      role: document.querySelector('#editUserRole')?.value ?? null,
      roleDisabled: document.querySelector('#editUserRole')?.disabled ?? null,
      globalAdminValue: document.querySelector('#editUserGlobalAdmin')?.value ?? null,
      globalAdminDisabled: document.querySelector('#editUserGlobalAdmin')?.disabled ?? null
    }));
    if (
      selfEditControls.role !== 'supervisor'
      || selfEditControls.roleDisabled !== true
      || selfEditControls.globalAdminValue !== 'true'
      || selfEditControls.globalAdminDisabled !== true
    ) {
      throw new Error(`Self-edit exposed an invalid global-admin transition: ${JSON.stringify(selfEditControls)}`);
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
  const nativeDialogs = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('dialog', async (dialog) => {
    nativeDialogs.push({ message: dialog.message(), type: dialog.type() });
    await dialog.dismiss();
  });

  try {
    await loginAs(page, 'supervisor@example.com', 'supervisor');
    await openAdminWorkspace(page, 'forms');
    await page.locator('#workFormsDetails').evaluate((element) => {
      element.open = true;
    });

    await page.locator('#workFormsList .record-form').first().waitFor({ timeout: 20000 });
    const initialCreateState = await page.evaluate(() => {
      const content = document.querySelector('.work-forms-content')?.getBoundingClientRect();
      const list = document.querySelector('#workFormsList')?.getBoundingClientRect();
      return {
        panelHidden: document.querySelector('#workFormCreatePanel')?.hidden ?? null,
        expanded: document.querySelector('#addWorkFormButton')?.getAttribute('aria-expanded'),
        addDisabled: document.querySelector('#addWorkFormButton')?.disabled ?? null,
        listVisible: document.querySelector('#workFormsList')?.getClientRects().length > 0,
        listWidthRatio: content?.width && list?.width ? list.width / content.width : 0
      };
    });
    if (
      !initialCreateState.panelHidden
      || initialCreateState.expanded !== 'false'
      || initialCreateState.addDisabled
      || !initialCreateState.listVisible
      || initialCreateState.listWidthRatio < 0.9
    ) {
      throw new Error(`Work Form creation was not list-first: ${JSON.stringify(initialCreateState)}`);
    }

    await page.locator('#addWorkFormButton').click();
    await page.waitForFunction(() => (
      document.querySelector('#workFormCreatePanel')?.hidden === false
      && document.querySelector('#addWorkFormButton')?.getAttribute('aria-expanded') === 'true'
      && document.querySelector('#addWorkFormButton')?.disabled === true
      && document.activeElement?.id === 'workFormNameInput'
    ));
    await page.locator('#workFormNameInput').fill('Discarded work form draft');
    await page.locator('#addWorkFormFieldButton').click();
    await page.locator('#workFormFieldCards > [data-work-form-field-card] [data-field-property="label"]').fill('Discarded field');
    await page.locator('#workFormPreviewButton').click();
    await page.locator('#workFormDraftPreview').waitFor({ state: 'visible' });
    await page.locator('#workFormAdvancedDetails > summary').click();
    await page.locator('#cancelWorkFormCreateButton').click();
    await page.waitForFunction(() => (
      document.querySelector('#workFormCreatePanel')?.hidden === true
      && document.querySelector('#addWorkFormButton')?.getAttribute('aria-expanded') === 'false'
      && document.querySelector('#addWorkFormButton')?.disabled === false
      && document.activeElement?.id === 'addWorkFormButton'
    ));
    const cancelledDraftState = await page.evaluate(() => ({
      name: document.querySelector('#workFormNameInput')?.value || '',
      fieldCards: document.querySelectorAll('#workFormFieldCards > [data-work-form-field-card]').length,
      advancedOpen: document.querySelector('#workFormAdvancedDetails')?.open ?? null,
      previewHidden: document.querySelector('#workFormDraftPreview')?.classList.contains('hidden') ?? null,
      builderFeedback: document.querySelector('#workFormBuilderFeedback')?.textContent?.trim() || '',
      actionFeedback: document.querySelector('#workFormBuilderActionFeedback')?.textContent?.trim() || ''
    }));
    if (
      cancelledDraftState.name
      || cancelledDraftState.fieldCards
      || cancelledDraftState.advancedOpen
      || !cancelledDraftState.previewHidden
      || cancelledDraftState.builderFeedback
      || cancelledDraftState.actionFeedback
    ) {
      throw new Error(`Cancel Work Form creation did not reset its draft controls: ${JSON.stringify(cancelledDraftState)}`);
    }

    await page.locator('#addWorkFormButton').click();
    await page.waitForFunction(() => document.activeElement?.id === 'workFormNameInput');

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

    let rejectNextWorkFormCreate = true;
    await page.route('**/api/supervisor/work-forms', async (route) => {
      const request = route.request();
      const isCreate = request.method() === 'POST'
        && new URL(request.url()).pathname === '/api/supervisor/work-forms';
      if (isCreate && rejectNextWorkFormCreate) {
        rejectNextWorkFormCreate = false;
        await new Promise((resolve) => setTimeout(resolve, 200));
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'Simulated Work Form create failure.' })
        });
        return;
      }
      await route.continue();
    });

    await page.locator('#workFormSubmitButton').click();
    await page.waitForFunction(() => (
      document.querySelector('#workFormSubmitButton')?.getAttribute('aria-busy') === 'true'
      && document.querySelector('#cancelWorkFormCreateButton')?.disabled === true
      && document.querySelector('#addWorkFormButton')?.disabled === true
    ));
    await page.locator('#workFormBuilderActionFeedback')
      .getByText('Simulated Work Form create failure.')
      .waitFor({ timeout: 10000 });
    const failedCreateState = await page.evaluate(() => ({
      panelHidden: document.querySelector('#workFormCreatePanel')?.hidden ?? null,
      addDisabled: document.querySelector('#addWorkFormButton')?.disabled ?? null,
      cancelDisabled: document.querySelector('#cancelWorkFormCreateButton')?.disabled ?? null,
      submitBusy: document.querySelector('#workFormSubmitButton')?.getAttribute('aria-busy'),
      fieldCards: document.querySelectorAll('#workFormFieldCards > [data-work-form-field-card]').length
    }));
    if (
      failedCreateState.panelHidden
      || !failedCreateState.addDisabled
      || failedCreateState.cancelDisabled
      || failedCreateState.submitBusy !== null
      || failedCreateState.fieldCards !== 3
    ) {
      throw new Error(`failed Work Form creation hid or cleared the retry state: ${JSON.stringify(failedCreateState)}`);
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
    await page.locator('#toastViewport .toast').filter({ hasText: 'Report Template created.' }).waitFor({ timeout: 20000 });
    await page.waitForFunction(() => (
      document.querySelector('#workFormCreatePanel')?.hidden === true
      && document.querySelector('#addWorkFormButton')?.getAttribute('aria-expanded') === 'false'
      && document.querySelector('#addWorkFormButton')?.disabled === false
      && document.activeElement?.id === 'addWorkFormButton'
    ));
    await page.unroute('**/api/supervisor/work-forms');

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

    const confirmationDialog = page.locator('#confirmationDialog');
    const editTypeSelect = editResultCard.locator('[data-field-property="type"]');
    await editTypeSelect.focus();
    await editTypeSelect.selectOption('text');
    await confirmationDialog.waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForFunction(() => document.activeElement?.id === 'confirmationDialogCancelButton');
    const lossyDialogState = await page.evaluate(() => ({
      title: document.querySelector('#confirmationDialogTitle')?.textContent?.trim(),
      message: document.querySelector('#confirmationDialogDescription')?.textContent?.trim(),
      confirmLabel: document.querySelector('#confirmationDialogConfirmButton')?.textContent?.trim(),
      focusedId: document.activeElement?.id
    }));
    if (
      lossyDialogState.title !== 'Change field type?'
      || !lossyDialogState.message?.includes('current options')
      || lossyDialogState.confirmLabel !== 'Change field type'
      || lossyDialogState.focusedId !== 'confirmationDialogCancelButton'
    ) {
      throw new Error(`lossy field change did not use the accessible app dialog: ${JSON.stringify(lossyDialogState)}`);
    }

    await page.keyboard.press('Escape');
    await confirmationDialog.waitFor({ state: 'hidden', timeout: 5000 });
    const cancelledTypeState = await page.evaluate((fieldId) => {
      const card = document.querySelector(`#supervisorEditPanel [data-field-id="${CSS.escape(fieldId)}"]`);
      return {
        type: card?.querySelector('[data-field-property="type"]')?.value,
        options: card?.querySelector('[data-field-property="options"]')?.value,
        focusedProperty: document.activeElement?.dataset?.fieldProperty
      };
    }, resultId);
    if (
      cancelledTypeState.type !== 'select'
      || cancelledTypeState.options !== 'Pass\nFail\nN/A\nBlocked'
      || cancelledTypeState.focusedProperty !== 'type'
    ) {
      throw new Error(`cancelled field change lost data or focus: ${JSON.stringify(cancelledTypeState)}`);
    }

    await editTypeSelect.selectOption('text');
    await confirmationDialog.waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#confirmationDialogConfirmButton').click();
    await confirmationDialog.waitFor({ state: 'hidden', timeout: 5000 });
    const confirmedTypeState = await page.evaluate((fieldId) => {
      const card = document.querySelector(`#supervisorEditPanel [data-field-id="${CSS.escape(fieldId)}"]`);
      return {
        type: card?.querySelector('[data-field-property="type"]')?.value,
        hasOptions: Boolean(card?.querySelector('[data-field-property="options"]'))
      };
    }, resultId);
    if (confirmedTypeState.type !== 'text' || confirmedTypeState.hasOptions) {
      throw new Error(`confirmed field change did not remove its choice settings: ${JSON.stringify(confirmedTypeState)}`);
    }

    const rebuiltTypeSelect = editPanel.locator(`[data-field-id="${resultId}"] [data-field-property="type"]`);
    await rebuiltTypeSelect.selectOption('select');
    await editPanel.locator(`[data-field-id="${resultId}"] [data-field-property="options"]`).fill('Pass\nFail\nN/A\nBlocked');

    await page.locator('#languageToggleButton').click();
    await page.waitForFunction(() => document.documentElement.dataset.language === 'zh');
    await rebuiltTypeSelect.focus();
    await rebuiltTypeSelect.selectOption('text');
    await confirmationDialog.waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForFunction(() => document.activeElement?.id === 'confirmationDialogCancelButton');
    const chineseDialogState = await page.evaluate(() => ({
      title: document.querySelector('#confirmationDialogTitle')?.textContent?.trim(),
      message: document.querySelector('#confirmationDialogDescription')?.textContent?.trim(),
      confirmLabel: document.querySelector('#confirmationDialogConfirmButton')?.textContent?.trim(),
      cancelLabel: document.querySelector('#confirmationDialogCancelButton')?.textContent?.trim()
    }));
    if (
      !Object.values(chineseDialogState).every((value) => /[\u3400-\u9fff]/u.test(value || ''))
      || Object.values(chineseDialogState).some((value) => /\b(?:Change|field|type|This|removes|current|options|formula|grouped|from|draft|Confirm|Cancel)\b/i.test(value || ''))
    ) {
      throw new Error(`confirmation dialog was not fully translated: ${JSON.stringify(chineseDialogState)}`);
    }
    await page.locator('#confirmationDialogCancelButton').click();
    await confirmationDialog.waitFor({ state: 'hidden', timeout: 5000 });
    await page.locator('#languageToggleButton').click();
    await page.waitForFunction(() => document.documentElement.dataset.language === 'en');

    const updateRequestPromise = page.waitForRequest((request) => (
      request.method() === 'PATCH'
      && /\/api\/supervisor\/work-forms\/\d+$/.test(new URL(request.url()).pathname)
    ));
    await editPanel.locator('button[type="submit"]').click();
    if (await confirmationDialog.getAttribute('open') !== null) {
      throw new Error('routine Work Form save opened a confirmation dialog');
    }
    const updateRequest = await updateRequestPromise;
    const updatePayload = updateRequest.postDataJSON();
    await page.locator('#toastViewport .toast').filter({ hasText: 'Report Template updated.' }).waitFor({ timeout: 20000 });

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

    const updatedCard = page.locator('#workFormsList .record-form').filter({ hasText: formName }).first();
    const archiveRequestPromise = page.waitForRequest((request) => (
      request.method() === 'PATCH'
      && /\/api\/supervisor\/work-forms\/\d+$/.test(new URL(request.url()).pathname)
      && request.postDataJSON()?.status === 'archived'
    ));
    await updatedCard.getByRole('button', { name: 'Archive' }).click();
    if (await confirmationDialog.getAttribute('open') !== null) {
      throw new Error('reversible Work Form archive opened a confirmation dialog');
    }
    const archiveRequest = await archiveRequestPromise;
    if (archiveRequest.postDataJSON()?.status !== 'archived') {
      throw new Error(`Work Form archive sent the wrong payload: ${archiveRequest.postData()}`);
    }
    await page.locator('#workFormsList .record-form').filter({ hasText: formName })
      .getByRole('button', { name: 'Activate' })
      .waitFor({ state: 'visible', timeout: 20000 });
    if (nativeDialogs.length) {
      throw new Error(`native browser dialogs were used: ${JSON.stringify(nativeDialogs)}`);
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

    await supervisorPage.locator('#locationReviewMap .location-map-point').first().dispatchEvent('mouseover');
    await supervisorPage.locator('#locationReviewMap .leaflet-tooltip').first().waitFor({ timeout: 5000 });
    const mapLabelSelectors = [
      '#locationMapCount',
      '#locationReviewMap .location-map-point span',
      '#locationReviewMap .location-map-site-marker span',
      '#locationReviewMap .leaflet-tooltip',
      '.location-map-legend span',
      '#locationMapHistory .location-history-row small'
    ];
    await expectReadableLabelSize(supervisorPage, mapLabelSelectors, 'desktop map');
    await supervisorPage.setViewportSize({ width: 390, height: 844 });
    await supervisorPage.locator('#locationReviewMap .location-map-point').first().dispatchEvent('mouseover');
    await supervisorPage.locator('#locationReviewMap .leaflet-tooltip').first().waitFor({ timeout: 5000 });
    await expectReadableLabelSize(supervisorPage, mapLabelSelectors, 'mobile map');
    if (await supervisorPage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) > 1) {
      throw new Error('larger mobile map labels introduced horizontal page overflow');
    }
    await supervisorPage.setViewportSize({ width: 1280, height: 900 });

    const markedQueueResponse = supervisorPage.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === 'GET'
        && url.pathname === '/api/supervisor/review-queue'
        && url.searchParams.get('search') === overviewMarker
      );
    }, { timeout: 15000 });
    await supervisorPage.locator('#supervisorSearchInput').fill(overviewMarker);
    await markedQueueResponse;
    const markedRecord = supervisorPage.locator('#reviewQueueList .record-card').filter({ hasText: overviewMarker });
    await markedRecord.waitFor({ timeout: 15000 });
    const markedRecordKey = await markedRecord.getAttribute('data-record-key');
    if (!markedRecordKey?.startsWith('attendance:')) {
      throw new Error(`outside-site Review record did not expose its attendance key: ${markedRecordKey || 'missing'}`);
    }
    const markedAttendanceId = markedRecordKey.slice('attendance:'.length);

    await supervisorPage.locator('#supervisorSearchInput').evaluate((element) => {
      element.value = 'exclude-analytics-target';
    });
    await supervisorPage.locator('#supervisorTypeFilter').evaluate((element) => {
      element.value = 'task';
    });
    await supervisorPage.locator('#supervisorStatusFilter').evaluate((element) => {
      element.value = 'approved';
    });
    await supervisorPage.locator('#supervisorDateFilter').evaluate((element) => {
      element.value = '2000-01-01';
    });

    await openAdminWorkspace(supervisorPage, 'reports');
    const relatedException = supervisorPage
      .locator(`#analyticsExceptionList .analytics-exception[data-analytics-record-key="${markedRecordKey}"]`)
      .filter({ hasText: 'Outside site' })
      .first();
    await relatedException.waitFor({ timeout: 15000 });
    const analyticsLabelSelectors = [
      '#analyticsExceptionCount',
      '#analyticsMetrics .analytics-metric span',
      '.analytics-chart-legend span',
      '#analyticsTrendChart .analytics-trend-column small',
      '#analyticsExceptionSummary span',
      '#analyticsExceptionList .analytics-exception p',
      '#analyticsExceptionList .analytics-exception-detail',
      '#analyticsExceptionList .analytics-exception-actions button',
      '#analyticsSiteSummary .analytics-table thead th'
    ];
    await expectReadableLabelSize(supervisorPage, analyticsLabelSelectors, 'desktop Analytics');
    await supervisorPage.setViewportSize({ width: 390, height: 844 });
    await expectReadableLabelSize(supervisorPage, analyticsLabelSelectors, 'mobile Analytics');
    if (await supervisorPage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) > 1) {
      throw new Error('larger mobile Analytics labels introduced horizontal page overflow');
    }
    await supervisorPage.setViewportSize({ width: 1280, height: 900 });
    await relatedException.getByRole('button', { name: 'Open Review record', exact: true }).click();
    await supervisorPage.locator('[data-admin-workspace-panel="review"]').waitFor({ state: 'visible', timeout: 15000 });
    const selectedAnalyticsRecord = supervisorPage.locator(
      `#reviewQueueList .review-queue-item[data-record-key="${markedRecordKey}"][aria-selected="true"]`
    );
    await selectedAnalyticsRecord.waitFor({ timeout: 20000 });
    await supervisorPage.locator('#reviewQueueDetail .record-card').filter({ hasText: overviewMarker })
      .waitFor({ timeout: 10000 });
    const clearedReviewFilters = await supervisorPage.evaluate(() => ({
      search: document.querySelector('#supervisorSearchInput')?.value,
      type: document.querySelector('#supervisorTypeFilter')?.value,
      status: document.querySelector('#supervisorStatusFilter')?.value,
      date: document.querySelector('#supervisorDateFilter')?.value
    }));
    if (Object.values(clearedReviewFilters).some(Boolean)) {
      throw new Error(`Analytics Review navigation left excluding filters active: ${JSON.stringify(clearedReviewFilters)}`);
    }

    await supervisorPage.locator('#locationMapWorkerFilter').evaluate((element) => {
      const excludingOption = [...element.options].find((option) => option.value);
      element.value = excludingOption?.value || '';
    });
    await supervisorPage.locator('#locationMapStatusFilter').evaluate((element) => {
      element.value = 'approved';
    });
    await supervisorPage.locator('#locationMapDateFrom').evaluate((element) => {
      element.value = '2000-01-01';
    });
    await supervisorPage.locator('#locationMapDateTo').evaluate((element) => {
      element.value = '2000-01-01';
    });
    await supervisorPage.locator('#locationMapOutsideOnly').evaluate((element) => {
      element.checked = true;
    });

    await openAdminWorkspace(supervisorPage, 'reports');
    const relatedMapException = supervisorPage
      .locator(`#analyticsExceptionList .analytics-exception[data-analytics-record-key="${markedRecordKey}"]`)
      .filter({ hasText: 'Outside site' })
      .first();
    await relatedMapException.waitFor({ timeout: 15000 });
    await relatedMapException.getByRole('button', { name: 'Show map point', exact: true }).click();
    await supervisorPage.locator('[data-admin-workspace-panel="review"]').waitFor({ state: 'visible', timeout: 15000 });
    await supervisorPage.waitForFunction(() => document.querySelector('#locationMapDetails')?.open === true);
    const selectedMapRecord = supervisorPage.locator(
      `#locationMapHistory .location-history-row[data-location-record-id="${markedAttendanceId}"].selected`
    );
    await selectedMapRecord.waitFor({ timeout: 20000 });
    await supervisorPage.locator('#locationMapSelection').getByText(overviewMarker).waitFor({ timeout: 10000 });
    const clearedMapFilters = await supervisorPage.evaluate(() => ({
      worker: document.querySelector('#locationMapWorkerFilter')?.value,
      site: document.querySelector('#locationMapSiteFilter')?.value,
      status: document.querySelector('#locationMapStatusFilter')?.value,
      dateFrom: document.querySelector('#locationMapDateFrom')?.value,
      dateTo: document.querySelector('#locationMapDateTo')?.value,
      outsideOnly: document.querySelector('#locationMapOutsideOnly')?.checked
    }));
    if (
      clearedMapFilters.worker
      || clearedMapFilters.site
      || clearedMapFilters.status
      || clearedMapFilters.dateFrom
      || clearedMapFilters.dateTo
      || clearedMapFilters.outsideOnly
    ) {
      throw new Error(`Analytics map navigation left excluding filters active: ${JSON.stringify(clearedMapFilters)}`);
    }

    const pendingMarkedQueueResponse = supervisorPage.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === 'GET'
        && url.pathname === '/api/supervisor/review-queue'
        && url.searchParams.get('search') === overviewMarker
        && url.searchParams.get('status') === 'pending'
      );
    }, { timeout: 15000 });
    await supervisorPage.locator('#supervisorStatusFilter').selectOption('pending');
    await supervisorPage.locator('#supervisorSearchInput').fill(overviewMarker);
    await pendingMarkedQueueResponse;
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

async function checkSupervisorMapDepartmentSwitch(browser) {
  const context = await newContext(browser, {
    viewport: { width: 1280, height: 900 },
    isMobile: false,
    hasTouch: false
  });
  const page = await context.newPage();
  const alphaWorkerId = 910001;
  const betaWorkerId = 920001;

  try {
    await loginAs(page, 'admin@example.com', 'supervisor');

    const departments = await page.locator('#supervisorDepartmentFilter option[value]:not([value=""])')
      .evaluateAll((options) => options.map((option) => ({
        label: option.textContent.trim(),
        value: option.value
      })));
    const alphaDepartment = departments.find((department) => department.label === 'Leader');
    const betaDepartment = departments.find((department) => department.label === 'Mutual');
    if (!alphaDepartment || !betaDepartment) {
      throw new Error(`map department regression needs Leader and Mutual options: ${JSON.stringify(departments)}`);
    }

    const locationRecords = [
      {
        id: 910001,
        department_id: Number(alphaDepartment.value),
        department_name: alphaDepartment.label,
        worker_id: alphaWorkerId,
        worker_name: 'Map Alpha Worker',
        site_id: null,
        site_name: 'Alpha Site',
        record_type: 'check_in',
        latitude: -36.8485,
        longitude: 174.7633,
        accuracy: 8,
        distance_from_site_m: 12,
        within_site_radius: true,
        note: 'Alpha map scope fixture',
        status: 'pending',
        entry_source: 'worker',
        created_at: new Date(Date.now() - 60000).toISOString()
      },
      {
        id: 920001,
        department_id: Number(betaDepartment.value),
        department_name: betaDepartment.label,
        worker_id: betaWorkerId,
        worker_name: 'Map Beta Worker',
        site_id: null,
        site_name: 'Beta Site',
        record_type: 'check_out',
        latitude: -36.7585,
        longitude: 174.8533,
        accuracy: 10,
        distance_from_site_m: 18,
        within_site_radius: true,
        note: 'Beta map scope fixture',
        status: 'pending',
        entry_source: 'worker',
        created_at: new Date().toISOString()
      }
    ];
    await page.route('**/api/supervisor/records*', async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== 'GET' || url.pathname !== '/api/supervisor/records') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(locationRecords)
      });
    });

    await page.locator('#supervisorDepartmentFilter').selectOption(alphaDepartment.value);
    await openAdminWorkspace(page, 'review');
    await page.locator('#locationMapDetails summary').click();
    const alphaRow = page.locator('#locationMapHistory .location-history-row')
      .filter({ hasText: 'Map Alpha Worker' });
    await alphaRow.waitFor({ timeout: 15000 });
    if (await page.locator('#locationMapHistory').getByText('Map Beta Worker').count()) {
      throw new Error('Mutual map record appeared while Leader department was selected');
    }
    if (await page.locator('#locationReviewMap .location-map-point').count() !== 1) {
      throw new Error('Leader map scope did not render exactly one attendance point');
    }

    await page.locator('#locationMapWorkerFilter').selectOption(String(alphaWorkerId));
    await alphaRow.click();
    await page.locator('#locationMapSelection').getByText('Map Alpha Worker').waitFor({ timeout: 10000 });
    if (await page.locator('#locationMapHistory .location-history-row.selected').count() !== 1) {
      throw new Error('Leader map point was not selected before changing department');
    }

    await openAdminWorkspace(page, 'overview');
    await page.locator('#supervisorDepartmentFilter').selectOption(betaDepartment.value);
    await openAdminWorkspace(page, 'review');
    await page.waitForFunction(({ alphaName, betaName }) => {
      const historyText = document.querySelector('#locationMapHistory')?.textContent || '';
      const selectionText = document.querySelector('#locationMapSelection')?.textContent || '';
      return (
        historyText.includes(betaName)
        && !historyText.includes(alphaName)
        && selectionText.includes('Select an attendance point or history row to review it.')
        && !selectionText.includes(alphaName)
        && document.querySelector('#locationMapWorkerFilter')?.value === ''
        && document.querySelectorAll('#locationMapHistory .location-history-row.selected').length === 0
        && document.querySelectorAll('#locationReviewMap .location-map-point').length === 1
      );
    }, { alphaName: 'Map Alpha Worker', betaName: 'Map Beta Worker' }, { timeout: 20000 });

    const selectionActionCount = await page.locator(
      '#locationMapSelection [data-map-edit], #locationMapSelection [data-map-decision]'
    ).count();
    if (selectionActionCount) {
      throw new Error('out-of-scope map selection kept record actions after changing department');
    }
    const betaRow = page.locator('#locationMapHistory .location-history-row')
      .filter({ hasText: 'Map Beta Worker' });
    await betaRow.click();
    await page.locator('#locationMapSelection').getByText('Map Beta Worker').waitFor({ timeout: 10000 });
    if (await page.locator('#locationMapHistory .location-history-row.selected').count() !== 1) {
      throw new Error('Mutual map point could not be selected after changing department');
    }
  } finally {
    await context.close();
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
  const expectedWorkspaces = ['overview', 'review', 'reports', 'forms', 'people', 'audit'];

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

    await page.locator('#staffUsersList .record-card').first().waitFor({ timeout: 20000 });
    const mobileStaffCreateState = await page.evaluate(() => {
      const toolbar = document.querySelector('.staff-users-card .admin-list-toolbar')?.getBoundingClientRect();
      const addButton = document.querySelector('#addStaffUserButton')?.getBoundingClientRect();
      return {
        panelHidden: document.querySelector('#staffUserCreatePanel')?.hidden ?? null,
        expanded: document.querySelector('#addStaffUserButton')?.getAttribute('aria-expanded'),
        addDisabled: document.querySelector('#addStaffUserButton')?.disabled ?? null,
        listVisible: document.querySelector('#staffUsersList')?.getClientRects().length > 0,
        fullWidthAction: Boolean(toolbar && addButton && Math.abs(toolbar.width - addButton.width) <= 1),
        overflow: document.documentElement.scrollWidth - window.innerWidth
      };
    });
    if (
      !mobileStaffCreateState.panelHidden
      || mobileStaffCreateState.expanded !== 'false'
      || mobileStaffCreateState.addDisabled
      || !mobileStaffCreateState.listVisible
      || !mobileStaffCreateState.fullWidthAction
      || mobileStaffCreateState.overflow > 1
    ) {
      throw new Error(`mobile Staff Add action did not keep the list primary: ${JSON.stringify(mobileStaffCreateState)}`);
    }

    await page.locator('#addStaffUserButton').click();
    await page.waitForFunction(() => document.activeElement?.id === 'staffNameInput');
    if (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) > 1) {
      throw new Error('mobile Staff creation panel caused horizontal overflow');
    }
    await page.locator('#cancelStaffUserCreateButton').click();
    await page.waitForFunction(() => document.activeElement?.id === 'addStaffUserButton');

    await page.locator('#adminMobileMenuButton').click();
    await page.locator('#adminWorkspaceDrawer [data-admin-workspace-target="forms"]').click();
    await page.locator('[data-admin-workspace-panel="forms"]').waitFor({ state: 'visible' });
    await page.locator('#workFormsList .record-form').first().waitFor({ timeout: 20000 });
    const mobileWorkFormCreateState = await page.evaluate(() => {
      const toolbar = document.querySelector('.work-forms-card .admin-list-toolbar')?.getBoundingClientRect();
      const addButton = document.querySelector('#addWorkFormButton')?.getBoundingClientRect();
      return {
        panelHidden: document.querySelector('#workFormCreatePanel')?.hidden ?? null,
        expanded: document.querySelector('#addWorkFormButton')?.getAttribute('aria-expanded'),
        addDisabled: document.querySelector('#addWorkFormButton')?.disabled ?? null,
        listVisible: document.querySelector('#workFormsList')?.getClientRects().length > 0,
        fullWidthAction: Boolean(toolbar && addButton && Math.abs(toolbar.width - addButton.width) <= 1),
        overflow: document.documentElement.scrollWidth - window.innerWidth
      };
    });
    if (
      !mobileWorkFormCreateState.panelHidden
      || mobileWorkFormCreateState.expanded !== 'false'
      || mobileWorkFormCreateState.addDisabled
      || !mobileWorkFormCreateState.listVisible
      || !mobileWorkFormCreateState.fullWidthAction
      || mobileWorkFormCreateState.overflow > 1
    ) {
      throw new Error(`mobile Work Form Add action did not keep the list primary: ${JSON.stringify(mobileWorkFormCreateState)}`);
    }

    await page.locator('#addWorkFormButton').click();
    await page.waitForFunction(() => document.activeElement?.id === 'workFormNameInput');
    if (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) > 1) {
      throw new Error('mobile Work Form creation panel caused horizontal overflow');
    }
    await page.locator('#cancelWorkFormCreateButton').click();
    await page.waitForFunction(() => document.activeElement?.id === 'addWorkFormButton');

    await page.locator('#adminMobileMenuButton').click();
    await page.locator('#adminWorkspaceDrawer [data-admin-workspace-target="people"]').click();
    await page.locator('[data-admin-workspace-panel="people"]').waitFor({ state: 'visible' });

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

async function checkColdOfflineWorkerLaunch(browser) {
  const context = await newContext(browser, {
    baseURL: productionAppBase,
    reportOnly: false,
    geolocation: { latitude: -36.8485, longitude: 174.7633 },
    permissions: ['geolocation'],
    serviceWorkers: 'allow'
  });
  let page = await context.newPage();
  let workerId = '';

  try {
    await loginAs(page, 'worker@example.com', 'worker');
    await page.waitForFunction(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return document.body.dataset.activeView === 'worker'
        && registration?.active?.state === 'activated'
        && Boolean(navigator.serviceWorker.controller)
        && Boolean(await caches.match('/index.html'))
        && document.querySelectorAll('#attendanceSite option[value]:not([value=""])').length > 0;
    }, null, { timeout: 30000 });
    workerId = await page.evaluate(() => {
      try {
        return String(JSON.parse(localStorage.getItem('geo_user') || 'null')?.id || '');
      } catch {
        return '';
      }
    });
    if (!workerId) throw new Error('online setup did not retain the Worker identity');
    const cachedShellState = await page.evaluate(async () => {
      const entrypoints = [
        ...[...document.querySelectorAll('script[src]')].map((element) => new URL(element.src).pathname),
        ...[...document.querySelectorAll('link[rel="stylesheet"][href]')]
          .map((element) => new URL(element.href).pathname)
      ];
      const cacheEntries = [];
      for (const cacheName of await caches.keys()) {
        const cache = await caches.open(cacheName);
        cacheEntries.push(...(await cache.keys()).map((request) => new URL(request.url).pathname));
      }
      const missingEntrypoints = entrypoints.filter((publicPath) => !cacheEntries.includes(publicPath));
      const unmatchedEntrypoints = [];
      const entrypointDiagnostics = [];
      for (const publicPath of entrypoints) {
        const matched = await caches.match(publicPath);
        const matchedIgnoringVary = await caches.match(publicPath, { ignoreVary: true });
        if (!matched) unmatchedEntrypoints.push(publicPath);
        entrypointDiagnostics.push({
          publicPath,
          matched: Boolean(matched),
          matchedIgnoringVary: Boolean(matchedIgnoringVary),
          vary: matchedIgnoringVary?.headers.get('vary') || ''
        });
      }
      const currentUser = JSON.parse(localStorage.getItem('geo_user') || 'null');
      const {
        loadWorkerSiteSnapshot,
        saveWorkerSiteSnapshot
      } = await import('/assets/js/offline-site-snapshot.js');
      const ownSnapshot = await loadWorkerSiteSnapshot(currentUser);
      const otherWorkerSnapshot = await loadWorkerSiteSnapshot({
        ...currentUser,
        id: `${currentUser.id}-other`
      });
      const otherDepartmentSnapshot = await loadWorkerSiteSnapshot({
        ...currentUser,
        departmentId: `${currentUser.departmentId}-other`
      });
      const missingDepartmentUser = { ...currentUser, departmentId: null };
      const missingDepartmentSnapshot = await loadWorkerSiteSnapshot(missingDepartmentUser);
      const missingDepartmentSaved = await saveWorkerSiteSnapshot(missingDepartmentUser, ownSnapshot?.sites || []);
      return {
        cacheNames: await caches.keys(),
        index: Boolean(await caches.match('/index.html')),
        entrypoints,
        missingEntrypoints,
        unmatchedEntrypoints,
        entrypointDiagnostics,
        cacheEntries,
        snapshotIsolation: {
          ownSiteCount: ownSnapshot?.sites.length || 0,
          otherWorkerRejected: otherWorkerSnapshot === null,
          otherDepartmentRejected: otherDepartmentSnapshot === null,
          missingDepartmentRejected: missingDepartmentSnapshot === null && !missingDepartmentSaved
        }
      };
    });
    if (
      !cachedShellState.index
      || cachedShellState.missingEntrypoints.length
      || cachedShellState.unmatchedEntrypoints.length
      || !cachedShellState.snapshotIsolation.ownSiteCount
      || !cachedShellState.snapshotIsolation.otherWorkerRejected
      || !cachedShellState.snapshotIsolation.otherDepartmentRejected
      || !cachedShellState.snapshotIsolation.missingDepartmentRejected
    ) {
      throw new Error(`production app shell or Worker Site snapshot isolation was incomplete: ${JSON.stringify(cachedShellState)}`);
    }

    await page.close();
    await context.setOffline(true);
    page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    const failedRequests = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('requestfailed', (request) => failedRequests.push({
      url: request.url(),
      error: request.failure()?.errorText || ''
    }));
    await page.goto('/index.html?cold-offline-launch=1', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.dataset.activeView === 'worker', null, { timeout: 10000 })
      .catch(() => {});

    const coldLaunchState = await page.evaluate(async (entrypoints) => {
      const cacheEntries = [];
      for (const cacheName of await caches.keys()) {
        const cache = await caches.open(cacheName);
        cacheEntries.push(...(await cache.keys()).map((request) => new URL(request.url).pathname));
      }
      const protectedPrefixes = [
        '/api',
        '/auth',
        '/photo-uploads',
        '/uploads',
        '/supervisor',
        '/attendance',
        '/my-records',
        '/task-logs',
        '/task-templates',
        '/team-work-log-members',
        '/team-work-logs',
        '/my-team-work-logs',
        '/work-forms',
        '/form-submissions',
        '/sites',
        '/dev',
        '/health'
      ];
      return {
        title: document.title,
        online: navigator.onLine,
        controlled: Boolean(navigator.serviceWorker?.controller),
        activeView: document.body.dataset.activeView || '',
        siteOptions: [...document.querySelectorAll('#attendanceSite option[value]:not([value=""])')]
          .map((option) => ({ value: option.value, label: option.textContent?.trim() || '' })),
        offlineHeadingVisible: [...document.querySelectorAll('h1')]
          .some((heading) => heading.textContent?.trim() === 'You are offline'),
        systemFeedback: document.querySelector('#statusBanner')?.textContent?.trim() || '',
        cacheNames: await caches.keys(),
        protectedCacheEntries: cacheEntries.filter((pathname) => protectedPrefixes.some((prefix) => (
          pathname === prefix || pathname.startsWith(`${prefix}/`)
        ))),
        entrypointCacheState: await Promise.all(entrypoints.map(async (publicPath) => {
          const response = await caches.match(publicPath);
          return {
            publicPath,
            matched: Boolean(response),
            status: response?.status || 0,
            type: response?.type || '',
            contentType: response?.headers.get('content-type') || '',
            vary: response?.headers.get('vary') || ''
          };
        }))
      };
    }, cachedShellState.entrypoints);
    const failedStaticRequests = failedRequests.filter(({ url }) => {
      const pathname = new URL(url).pathname;
      return pathname.startsWith('/assets/')
        || pathname === '/manifest.webmanifest'
        || pathname === '/offline.html';
    });
    if (
      coldLaunchState.online
      || !coldLaunchState.controlled
      || coldLaunchState.activeView !== 'worker'
      || coldLaunchState.offlineHeadingVisible
      || !coldLaunchState.siteOptions.length
      || coldLaunchState.protectedCacheEntries.length
      || pageErrors.length
      || failedStaticRequests.length
    ) {
      throw new Error(`cold offline launch did not restore the Worker app and saved Sites: ${JSON.stringify({
        ...coldLaunchState,
        pageErrors,
        consoleErrors,
        failedRequests,
        failedStaticRequests
      })}`);
    }

    await page.locator('#attendanceSite').selectOption({ index: 1 });
    await captureLocation(page);
    await page.waitForFunction(() => !document.querySelector('#attendancePrimaryButton')?.disabled);
    await page.locator('#attendancePrimaryButton').click();
    await page.waitForFunction(async (expectedWorkerId) => {
      const { getAll } = await import('/assets/js/db.js');
      const records = await getAll('records');
      return records.some((record) => (
        record.type === 'attendance'
        && String(record.ownerWorkerId) === String(expectedWorkerId)
        && record.syncStatus === 'queued'
        && !record.backendRecordId
      ));
    }, workerId, { timeout: 15000, polling: 100 });

    const protectedNavigation = await context.newPage();
    let protectedPathServedAppShell = false;
    try {
      await protectedNavigation.goto('/api/my-records', {
        waitUntil: 'domcontentloaded',
        timeout: 5000
      });
      protectedPathServedAppShell = await protectedNavigation.evaluate(() => (
        document.title === 'Leader Field Reports'
        || Boolean(document.querySelector('#workerView'))
      ));
    } catch {
      // Network-only navigation is expected to fail while the browser is offline.
    } finally {
      await protectedNavigation.close();
    }
    if (protectedPathServedAppShell) {
      throw new Error('offline API navigation incorrectly received the cached application shell');
    }

    const snapshotCleared = await page.evaluate(async () => {
      const user = JSON.parse(localStorage.getItem('geo_user') || 'null');
      const { clearWorkerSiteSnapshot, loadWorkerSiteSnapshot } = await import('/assets/js/offline-site-snapshot.js');
      await clearWorkerSiteSnapshot(user);
      return (await loadWorkerSiteSnapshot(user)) === null;
    });
    if (!snapshotCleared) {
      throw new Error('Worker Site snapshot cleanup did not remove the scoped offline data');
    }
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
  const context = await newContext(browser, {
    reportOnly: false,
    initScript: installWaitingServiceWorkerMock
  });
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
  const context = await newContext(browser, {
    reportOnly: true,
    initScript: installWaitingServiceWorkerMock
  });
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
    await openAdminWorkspace(page, 'people');
    if ((await page.locator('#addStaffUserButton').innerText()).trim() !== '添加员工') {
      throw new Error('Add Staff action was not translated before opening the form');
    }
    await page.locator('#addStaffUserButton').click();
    await page.locator('#staffUserCreatePanel').waitFor({ state: 'visible' });
    if ((await page.locator('#staffUserCreateTitle').innerText()).trim() !== '添加员工用户') {
      throw new Error('Add Staff heading was not translated inside the revealed form');
    }
    await page.locator('#cancelStaffUserCreateButton').click();
    await page.locator('#staffUserCreatePanel').waitFor({ state: 'hidden' });

    await openAdminWorkspace(page, 'forms');
    if ((await page.locator('#addWorkFormButton').innerText()).trim() !== '添加报告模板') {
      throw new Error('Add Report Template action was not translated before opening the builder');
    }
    await page.locator('#addWorkFormButton').click();
    await page.locator('#addWorkFormFieldButton').click();
    const fieldCard = page.locator('#workFormFieldCards > [data-work-form-field-card]').first();
    await fieldCard.waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(() => (
      document.querySelector('#workFormFieldCards')?.getAttribute('aria-label') === '报告模板字段'
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
    if (restored.notifications !== 'Notifications' || restored.builderLabel !== 'Report Template fields') {
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
    await runCheck('normal Worker guide compacts and Site priority follows attendance context', () => checkNormalWorkerAttendanceShortcuts(browser));
    await runCheck('normal Workers submit active Work Forms and see their own history', () => checkNormalWorkerWorkFormSubmission(browser));
    await runCheck('browser geolocation denial shows recoverable error', () => checkDeniedGeolocation(browser));
    await runCheck('Daywork team rows use searchable member picker', () => checkDayworkTeamMemberPicker(browser));
    await runCheck('Daywork history and review hide helper fields', () => checkDayworkRecordRendering(browser));
    await runCheck('report-only New Report, My Reports, queue, and exports exclude Daywork', () => checkReportOnlyExcludesDaywork(browser));
    await runCheck('offline My Reports fallback shows only queued Report submissions', () => checkReportOnlyOfflineHistoryFallback(browser));
    await runCheck('explicit Report purpose overrides Daywork words in a template name', () => checkExplicitReportPurposeOverridesDayworkName(browser));
    await runCheck('report-only automatic and manual replay skip hidden record queues', () => checkReportOnlyReplayScope(browser));
    await runCheck('reconnect preserves in-progress Daywork and Work Form answers', () => checkReconnectPreservesWorkerForms(browser));
    await runCheck('staff users scope global admin controls by role', () => checkStaffGlobalAdminScoping(browser));
    await runCheck('supervisors create and edit conditional Work Forms with field cards', () => checkSupervisorWorkFormCardBuilder(browser));
    await runCheck('Offline Submission ownership, occurrence time, and idempotent replay', () => checkOfflineQueueAndReplay(browser));
    await runCheck('Report photos and repeat signatures resume once after partial upload failure', () => checkRepeatSignatureUploadResume(browser));
    await runCheck('supervisor review shows pending outside-site worker record', () => checkSupervisorReview(browser));
    await runCheck('department switching replaces map points and clears stale selection', () => checkSupervisorMapDepartmentSwitch(browser));
    await runCheck('supervisor workspaces remain navigable on desktop and mobile', () => checkSupervisorWorkspaceNavigation(browser));
    await runCheck('supervisor Review Desk is responsive', () => checkSupervisorReviewDeskLayout(browser));
    await runCheck('offline Review Queue is explicit and read-only', () => checkOfflineReviewQueueReadOnly(browser));
    await runCheck('retained attendance app cold-launches offline and queues attendance', () => checkColdOfflineWorkerLaunch(browser));
    await runCheck('retained Work Form drafts protect production-mode app updates', () => checkWorkFormAutosaveAndUpdateProtection(browser));
    await runCheck('report-only service worker update prompt posts SKIP_WAITING', () => checkServiceWorkerUpdatePrompt(browser));
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
