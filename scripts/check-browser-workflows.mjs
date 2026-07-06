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
    const status = document.querySelector('#statusBanner')?.textContent || '';
    return document.body.dataset.activeView === 'login' && status !== 'Checking app status...';
  });
  await page.locator('#emailInput').fill(email);
  await page.locator('#passwordInput').fill(password);
  await page.locator('#loginForm button[type="submit"]').click();
  try {
    await page.waitForFunction((view) => document.body.dataset.activeView === view, expectedView, { timeout: 20000 });
  } catch (error) {
    const debug = await page.evaluate(() => ({
      activeView: document.body.dataset.activeView || '',
      status: document.querySelector('#statusBanner')?.textContent || '',
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

async function myRecordCount(page) {
  return await page.evaluate(async () => {
    const response = await fetch('/api/my-records', { credentials: 'include' });
    if (!response.ok) throw new Error(`my-records failed: ${response.status}`);
    return (await response.json()).length;
  });
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
      checkInDisabled: document.querySelector('#checkInButton')?.disabled ?? null,
      locationPreview: document.querySelector('#locationPreview')?.textContent || ''
    }));
    throw new Error(`Expected at least ${minimum} queued submission: ${JSON.stringify(debug)}`, {
      cause: error
    });
  }
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
  try {
    await test();
    console.log(`ok - ${name}`);
  } catch (error) {
    checks.push({ name, error });
    console.error(`not ok - ${name}`);
    console.error(`  ${error.stack || error.message}`);
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
    await page.locator('#checkInButton').waitFor({ state: 'visible' });
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
    await page.locator('#statusBanner').getByText('Could not get location').waitFor({ timeout: 10000 });
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

  try {
    await loginAs(page, 'worker@example.com', 'worker');
    const beforeCount = await myRecordCount(page);
    await selectFirstSite(page);
    await captureLocation(page);

    await context.setOffline(true);
    await page.locator('#checkInButton').click();
    await waitForQueueAtLeast(page, 1);

    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitForQueueCount(page, 0);
    await page.waitForFunction(
      async (countBefore) => {
        const response = await fetch('/api/my-records', { credentials: 'include' });
        if (!response.ok) return false;
        return (await response.json()).length > countBefore;
      },
      beforeCount,
      { timeout: 20000 }
    );
  } finally {
    await context.setOffline(false).catch(() => {});
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
          status: document.querySelector('#statusBanner')?.textContent || '',
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
    await workerPage.locator('#statusBanner').getByText('Daywork log form submitted for approval').waitFor({ timeout: 20000 });
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
    await supervisorPage.locator('#reviewQueueDetails').evaluate((element) => {
      element.open = true;
    });
    await supervisorPage.locator('#supervisorStatusFilter').selectOption('pending');
    await supervisorPage.locator('#reviewQueueList .record-form').filter({ hasText: 'Daywork log form' }).first().waitFor({ timeout: 20000 });
    const reviewText = await supervisorPage.locator('#reviewQueueList .record-form').filter({ hasText: 'Daywork log form' }).first().innerText();
    assertCleanDayworkText('supervisor review', reviewText);
  } finally {
    await supervisorContext.close();
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

async function checkSupervisorReview(browser) {
  const workerContext = await newContext(browser, {
    geolocation: { latitude: 0, longitude: 0, accuracy: 20 },
    permissions: ['geolocation']
  });
  const workerPage = await workerContext.newPage();

  try {
    await loginAs(workerPage, 'worker@example.com', 'worker');
    await selectFirstSite(workerPage);
    await captureLocation(workerPage);
    await workerPage.locator('#checkInButton').click();
    await workerPage.locator('#statusBanner').getByText('supervisor review').waitFor({ timeout: 15000 });
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
    await supervisorPage.locator('#reviewQueueDetails').evaluate((element) => {
      element.open = true;
    });
    await supervisorPage.locator('#supervisorStatusFilter').selectOption('pending');
    await supervisorPage.locator('#reviewQueueList .record-card').first().waitFor({ timeout: 20000 });
    const reviewText = await supervisorPage.locator('#reviewQueueList').innerText();
    if (!reviewText.includes('Demo Worker') || !reviewText.includes('Outside')) {
      throw new Error(`expected pending outside-site worker record in review queue, got: ${reviewText}`);
    }
  } finally {
    await supervisorContext.close();
  }
}

async function checkServiceWorkerUpdatePrompt(browser) {
  const context = await newContext(browser, {
    initScript: () => {
      window.__serviceWorkerMessages = [];
      const listeners = new Map();
      const waitingWorker = {
        state: 'installed',
        postMessage(message) {
          window.__serviceWorkerMessages.push(message);
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
  });
  const page = await context.newPage();

  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const status = document.querySelector('#statusBanner')?.textContent || '';
      return status !== 'Checking app status...';
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
    await runCheck('browser geolocation denial shows recoverable error', () => checkDeniedGeolocation(browser));
    await runCheck('Daywork team rows use searchable member picker', () => checkDayworkTeamMemberPicker(browser));
    await runCheck('Daywork history and review hide helper fields', () => checkDayworkRecordRendering(browser));
    await runCheck('staff users scope global admin controls by role', () => checkStaffGlobalAdminScoping(browser));
    await runCheck('IndexedDB attendance queue replays after reconnect', () => checkOfflineQueueAndReplay(browser));
    await runCheck('supervisor review shows pending outside-site worker record', () => checkSupervisorReview(browser));
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
  rmSync(tempDir, { recursive: true, force: true });
}
