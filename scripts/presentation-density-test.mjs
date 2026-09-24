import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59981'; // Fully intercepted; no server or live API is contacted.
const output = path.join(root, 'output', 'presentation-density.local');
const worker = { id: 73, department_id: 2, department_name: 'Mutual', role: 'worker',
  worker_class: 'normal', name: 'Presentation Worker', email: 'presentation@example.invalid', status: 'active' };
const supervisor = { ...worker, id: 74, role: 'supervisor', name: 'Presentation Supervisor' };
const template = { id: 81, department_id: 2, name: 'Site inspection', status: 'active',
  template_purpose: 'report', definition_version: 1,
  fields: [{ id: 'notes', label: 'Notes', type: 'textarea', required: true }] };
const reports = ['submitted', 'in_review', 'resolved'].map((workflowStatus, index) => ({
  id: 501 + index, kind: 'form', review_key: `form:${501 + index}`, department_id: 2, department_name: 'Mutual',
  worker_id: worker.id, worker_name: worker.name, form_id: template.id, form_name: template.name,
  fields: template.fields, answers: { notes: ['Access routes checked and clear.', 'Guardrail needs follow-up.', 'Work area inspected and signed off.'][index] },
  submission_purpose: 'report', definition_version: 1, workflow_status: workflowStatus,
  status: workflowStatus === 'resolved' ? 'approved' : 'pending', work_date: '2026-09-25',
  site_id: null, photo_urls: [], photo_metadata: [], created_at: `2026-09-25T0${index}:00:00Z`,
  supervisor_note: workflowStatus === 'resolved' ? 'Inspection complete; no further action required.' : '',
  reviewing_supervisor_id: index ? supervisor.id : null, reviewing_supervisor_name: index ? supervisor.name : '',
  review_started_at: index ? `2026-09-25T0${index}:10:00Z` : null,
  resolved_at: workflowStatus === 'resolved' ? '2026-09-25T02:30:00Z' : null
}));

async function fixture(browser, user = null) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const errors = [];
  const unexpectedRequests = [];
  let offline = false;
  let loginFailure = false;
  await context.addInitScript(() => {
    localStorage.setItem('leader-theme', localStorage.getItem('leader-theme') || 'light');
    // Exercise the actual update-found handler without installing a service worker.
    const controller = new EventTarget();
    const registration = new EventTarget();
    controller.controller = {};
    controller.register = async () => registration;
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: controller });
    window.presentationWaitingUpdate = () => {
      const installing = new EventTarget();
      installing.state = 'installed';
      installing.postMessage = () => { throw new Error('This read-only fixture must not activate an update'); };
      registration.installing = installing;
      registration.dispatchEvent(new Event('updatefound'));
      installing.dispatchEvent(new Event('statechange'));
    };
  });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      unexpectedRequests.push(url.origin);
      return route.abort();
    }
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated presentation fixture</title>' });
    if (offline && url.pathname.startsWith('/api/')) return route.abort('internetdisconnected');
    if (['/api/auth/refresh', '/api/auth/me'].includes(url.pathname)) return json(user || worker);
    if (url.pathname === '/api/auth/login') return loginFailure
      ? json({ detail: 'Check your email and password.' }, 401) : json({ user: user || worker });
    if (url.pathname === '/api/auth/logout') return json({ message: 'Signed out' });
    if (url.pathname === '/api/departments') return json([{ id: 2, name: 'Mutual' }]);
    if (url.pathname === '/api/sites') return json([]);
    if (url.pathname === '/api/work-forms') {
      assert.equal(url.searchParams.get('purpose'), 'report');
      return json([template]);
    }
    if (url.pathname === '/api/my-form-submissions') {
      assert.equal(url.searchParams.get('purpose'), 'report');
      return json([]);
    }
    if (url.pathname === '/api/supervisor/users') return json([worker]);
    if (url.pathname === '/api/supervisor/review-queue') {
      assert.equal(url.searchParams.get('purpose'), 'report');
      const counts = { total: reports.length, pending: 2, reviewed: 1, form: reports.length, attendance: 0, task: 0, team_log: 0 };
      return json({ items: reports, counts, summary_counts: counts, has_more: false, next_cursor: null, snapshot_at: new Date().toISOString() });
    }
    if (url.pathname.startsWith('/api/')) {
      unexpectedRequests.push(`${route.request().method()} ${url.pathname}`);
      return json({ detail: 'Unexpected fixture API request' }, 500);
    }
    const file = path.resolve(root, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    assert.ok(file.startsWith(`${root}${path.sep}`), 'Only repository files can be served');
    let body = await readFile(file);
    const extension = path.extname(file);
    if (extension === '.js') body = body.toString()
      .replaceAll("import L from 'leaflet';", "import * as L from '/node_modules/leaflet/dist/leaflet-src.esm.js';")
      .replace(/^import 'leaflet\/dist\/leaflet\.css';?\r?\n/gm, '');
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
    return route.fulfill({ contentType: types[extension] || 'application/octet-stream', body });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/fixture`);
  if (user) await page.evaluate(async (value) => {
    const { saveSession } = await import('/assets/js/api-client.js');
    saveSession(value);
  }, user);
  await page.goto(origin);
  await page.waitForFunction((view) => document.body.dataset.activeView === view, user?.role || 'login');
  if (user?.role === 'worker') await page.waitForFunction(() => document.querySelector('#workFormSelect').options.length > 1);
  if (user?.role === 'supervisor') await page.waitForFunction(() => document.querySelector('#reviewQueueModeBadge')?.textContent === 'Live'
    && !document.querySelector('#exportReportsPdfButton').disabled
    && document.querySelectorAll('#reviewQueueList [role="option"]').length === 3);
  return { page, context, errors, unexpectedRequests,
    setLoginFailure(value) { loginFailure = value; },
    async goOffline() {
      offline = true;
      await context.addInitScript(() => Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }));
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
        window.dispatchEvent(new Event('offline'));
      });
    },
    async close() {
      await context.close();
      assert.deepEqual(errors, [], 'No unhandled browser errors');
      assert.deepEqual(unexpectedRequests, [], 'All requests stay within the narrow mocked Report contract');
    } };
}

async function setPresentation(page, language, theme) {
  if (await page.evaluate(() => document.documentElement.dataset.language) !== language) await page.locator('#languageToggleButton').click();
  if (await page.evaluate(() => document.documentElement.dataset.theme) !== theme) await page.locator('#themeToggleButton').click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.language), language);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
}

async function assertTopbar(page, label) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const layout = await page.evaluate(() => {
    const visible = (element) => Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden';
    return {
      width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth,
      buttons: [...document.querySelectorAll('.topbar-actions button')].filter(visible).map((element) => {
        const { x, width, height } = element.getBoundingClientRect();
        return { id: element.id, x, width, height };
      })
    };
  });
  assert.ok(layout.scrollWidth <= layout.width, `${label}: no horizontal overflow (${layout.scrollWidth}/${layout.width})`);
  assert.ok(layout.buttons.some((button) => button.id === 'languageToggleButton'), `${label}: language remains directly available`);
  assert.ok(layout.buttons.some((button) => button.id === 'themeToggleButton'), `${label}: theme remains directly available`);
  for (const button of layout.buttons) {
    assert.ok(button.width >= 43.99 && button.height >= 43.99, `${label}: ${button.id} retains a 44px target (${button.width}x${button.height})`);
    assert.ok(button.x >= 0 && button.x + button.width <= layout.width + 1, `${label}: ${button.id} fits the viewport`);
  }
}

async function matrix(page, role) {
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    for (const language of ['en', 'zh']) for (const theme of ['light', 'dark']) {
      const label = `${role}-${width}-${language}-${theme}`;
      await setPresentation(page, language, theme);
      await assertTopbar(page, label);
      if (role === 'login') {
        const signIn = await page.locator('#loginSubmitButton').boundingBox();
        assert.ok(signIn.y >= 0 && signIn.y + signIn.height <= 844, `${label}: sign-in is visible without scrolling`);
        assert.equal(await page.locator('#signInHelp').evaluate((element) => element.open), false);
        assert.equal(await page.locator('#installHelp').evaluate((element) => element.open), false);
        const guide = page.locator('#loginView a[href="/install.html"]');
        assert.equal(await guide.isVisible(), true, `${label}: QR/install guide remains directly visible`);
        assert.equal(await guide.evaluate((element) => Boolean(element.closest('details'))), false);
      }
      if ((width === 390 && ((language === 'en' && theme === 'light') || (language === 'zh' && theme === 'dark')))
        || (width === 320 && language === 'zh' && theme === 'dark')) {
        await page.mouse.move(1, 1);
        await page.screenshot({ path: path.join(output, `${label}.png`), animations: 'disabled' });
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await setPresentation(page, 'en', 'light');
  console.log(`ok - ${role}: 16 responsive/language/theme combinations preserve targets and non-overflow`);
}

const browser = await chromium.launch({ headless: true });
try {
  await mkdir(output, { recursive: true });
  const login = await fixture(browser);
  try {
    await matrix(login.page, 'login');
    const guidance = login.page.locator('#signInHelp');
    assert.equal(await login.page.locator('#invitedAccountNotice').isVisible(), true);
    assert.match(await login.page.locator('#invitedAccountNotice').innerText(), /invit/i);
    assert.equal(await guidance.evaluate((element) => element.compareDocumentPosition(document.querySelector('#loginForm')) & Node.DOCUMENT_POSITION_PRECEDING), 2,
      'Optional guidance follows the sign-in form');
    await guidance.locator('summary').focus();
    await login.page.keyboard.press('Enter');
    assert.equal(await guidance.evaluate((element) => element.open), true, 'Help opens using the keyboard');
    assert.match(await guidance.innerText(), /private.*setup link/i);
    assert.match(await guidance.innerText(), /supervisor/i);
    await login.page.keyboard.press('Space');
    assert.equal(await guidance.evaluate((element) => element.open), false, 'Help closes using the keyboard');
    const installation = login.page.locator('#installHelp');
    await installation.locator('summary').focus();
    await login.page.keyboard.press('Enter');
    assert.equal(await login.page.locator('#downloadAppButton').isVisible(), true);
    assert.match(await login.page.locator('#downloadAppHelp').innerText(), /browser.*menu|home screen/i);
    await login.page.locator('#downloadAppButton').click();
    assert.match(await login.page.locator('#downloadAppHelp').innerText(), /browser.*menu|home screen/i);
    await login.page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
    await guidance.locator('summary').click();
    await login.page.evaluate(() => window.scrollTo(0, 0));
    await login.page.mouse.move(1, 1);
    await login.page.screenshot({ path: path.join(output, 'login-help-open-390-en-light.png'), animations: 'disabled', fullPage: true });
    await guidance.locator('summary').click();
    await installation.locator('summary').click();
    await setPresentation(login.page, 'zh', 'dark');
    await guidance.locator('summary').click();
    assert.match(await guidance.innerText(), /[\u4e00-\u9fff]/, 'Expanded guidance is translated');
    await login.page.reload();
    await login.page.waitForFunction(() => document.body.dataset.activeView === 'login');
    assert.equal(await login.page.evaluate(() => document.documentElement.dataset.language), 'zh', 'Language persists after reload');
    assert.equal(await login.page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'Theme persists after reload');
    assert.equal(await guidance.evaluate((element) => element.open), false, 'Optional help starts closed after reload');
    await setPresentation(login.page, 'en', 'light');
    login.setLoginFailure(true);
    await login.page.locator('#emailInput').fill(worker.email);
    await login.page.locator('#passwordInput').fill('Isolated-fixture-only');
    await login.page.locator('#loginSubmitButton').click();
    await login.page.locator('#loginFeedback').waitFor({ state: 'visible' });
    assert.match(await login.page.locator('#loginFeedback').innerText(), /email|password/i);
    assert.equal(await login.page.locator('#loginFeedback').evaluate((element) => Boolean(element.closest('details'))), false,
      'Action errors never hide inside optional guidance');
    console.log('ok - concise sign-in retains keyboard-accessible help, QR access, translated guidance, preferences and visible errors');
  } finally { await login.close(); }

  const field = await fixture(browser, worker);
  try {
    await matrix(field.page, 'worker');
    await field.page.locator('#workFormSelect').selectOption(String(template.id));
    await field.page.waitForFunction(() => !document.querySelector('#workFormSubmissionForm').inert && document.querySelector('#workFormField_notes'));
    await field.page.locator('#workFormField_notes').fill('Keep unfinished work visible and recoverable.');
    await field.page.waitForFunction(async () => {
      const { get } = await import('/assets/js/db.js');
      return (await get('drafts', 'work-form-draft:73:81'))?.value?.answers?.notes === 'Keep unfinished work visible and recoverable.';
    });
    await field.page.locator('button.tab[data-tab-target="historyTab"]').click();
    await field.page.locator('#reportDraftsPanel').waitFor({ state: 'visible' });
    assert.match(await field.page.locator('#reportDraftsPanel').innerText(), /not submitted|only saved|device/i);
    await field.page.locator('#reportDraftsList').getByRole('button', { name: 'Continue draft', exact: true }).click();
    await field.page.locator('#workFormField_notes').waitFor({ state: 'visible' });
    assert.equal(await field.page.locator('#workFormField_notes').inputValue(), 'Keep unfinished work visible and recoverable.');
    const available = field.page.locator('#reportTemplateAvailability');
    assert.equal(await available.isVisible(), true);
    assert.ok((await available.innerText()).length <= 80, 'Healthy template status is concise');
    await field.page.evaluate(() => {
      window.presentationWaitingUpdate();
      const prompt = new Event('beforeinstallprompt', { cancelable: true });
      prompt.prompt = () => {};
      prompt.userChoice = Promise.resolve({ outcome: 'dismissed' });
      window.dispatchEvent(prompt);
    });
    await field.page.locator('#updateButton').waitFor({ state: 'visible' });
    await field.page.locator('#statusBanner').waitFor({ state: 'visible' });
    assert.match(await field.page.locator('#statusBanner').innerText(), /drafts.*saved/i, 'Waiting-update protection is not collapsed');
    for (const width of [320, 390, 768, 1280]) {
      await field.page.setViewportSize({ width, height: 844 });
      for (const language of ['en', 'zh']) for (const theme of ['light', 'dark']) {
        await setPresentation(field.page, language, theme);
        await assertTopbar(field.page, `worker-all-actions-${width}-${language}-${theme}`);
      }
    }
    await field.page.setViewportSize({ width: 390, height: 844 });
    await setPresentation(field.page, 'en', 'light');
    await field.page.mouse.move(1, 1);
    await field.page.screenshot({ path: path.join(output, 'worker-update-and-draft-390.png'), animations: 'disabled' });
    await field.goOffline();
    await field.page.waitForFunction(() => document.querySelector('#syncIndicator').dataset.state === 'offline');
    assert.equal(await field.page.locator('#syncIndicator').isVisible(), true, 'Offline status stays visible');
    assert.equal(await field.page.locator('#workFormField_notes').inputValue(), 'Keep unfinished work visible and recoverable.');
    assert.equal(await field.page.locator('#workFormAutosaveStatus').isVisible(), true, 'Draft save status stays visible');
    await field.page.reload();
    await field.page.waitForFunction(() => document.body.dataset.activeView === 'worker');
    await field.page.waitForFunction(() => /saved Report Templates/.test(document.querySelector('#reportTemplateAvailability').innerText));
    assert.equal(await available.isVisible(), true, 'Offline Template status stays visible outside optional help');
    assert.match(await available.innerText(), /wait.*reconnect/i);
    await field.page.mouse.move(1, 1);
    await field.page.screenshot({ path: path.join(output, 'worker-offline-390-en-light.png'), animations: 'disabled' });
    console.log('ok - Worker draft Continue/save and offline/update protections remain visible and intact');
  } finally { await field.close(); }

  const review = await fixture(browser, supervisor);
  try {
    await matrix(review.page, 'supervisor');
    assert.equal(await review.page.locator('#reviewQueueModeBadge').innerText(), 'Live');
    assert.equal(await review.page.locator('#exportReportsPdfButton').isEnabled(), true);
    assert.equal(await review.page.locator('.report-export-scope').isVisible(), true, 'Export scope remains discoverable');
    assert.match(await review.page.locator('.report-export-scope').innerText(), /filter|Find|match/i);
    assert.match(await review.page.locator('.report-export-scope').innerText(), /all|every|across/i, 'Export scope still explains cross-page inclusion');
    await review.goOffline();
    await review.page.locator('#refreshSupervisorButton').click();
    await review.page.waitForFunction(() => document.querySelector('#exportReportsPdfButton').disabled);
    assert.equal(await review.page.locator('#reviewQueueNotice').isVisible(), true);
    assert.match(await review.page.locator('#reviewQueueNotice').innerText(), /read.only/i);
    const notifications = review.page.getByRole('button', { name: 'Dismiss notification', exact: true });
    while (await notifications.count()) await notifications.first().click();
    await review.page.evaluate(() => window.scrollTo(0, 0));
    await review.page.mouse.move(1, 1);
    await review.page.screenshot({ path: path.join(output, 'supervisor-offline-readonly-390-en-light.png'), animations: 'disabled' });
    console.log('ok - healthy Supervisor review retains concise export scope; offline failure remains explicit and disables exports');
  } finally { await review.close(); }
} finally {
  await browser.close();
}
