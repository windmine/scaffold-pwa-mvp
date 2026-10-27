import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { waitForAsyncCondition } from './browser-async-wait.mjs';

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

async function fixture(browser, user = null, width = 390) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: 'block' });
  const errors = [];
  const unexpectedRequests = [];
  let offline = false;
  let loginFailure = false;
  let loginGate = null;
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
    if (url.pathname === '/api/auth/login') {
      if (loginGate) {
        loginGate.started();
        await loginGate.wait;
      }
      return loginFailure ? json({ detail: 'Check your email and password.' }, 401) : json({ user: user || worker });
    }
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
      return json({ items: reports, counts, summary_counts: counts, has_more: false, next_cursor: null,
        sort_order: url.searchParams.get('sort_order') || 'newest', snapshot_at: new Date().toISOString() });
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
    holdNextLogin() {
      let notifyStarted, release;
      const started = new Promise((resolve) => { notifyStarted = resolve; });
      const wait = new Promise((resolve) => { release = resolve; });
      loginGate = { started: notifyStarted, wait, release };
      return { started, release: () => { release(); loginGate = null; } };
    },
    async goOffline() {
      offline = true;
      await context.addInitScript(() => Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }));
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
        window.dispatchEvent(new Event('offline'));
      });
    },
    async close() {
      loginGate?.release();
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
      height: document.querySelector('.topbar').getBoundingClientRect().height,
      buttons: [...document.querySelectorAll('.topbar-actions button')].filter(visible).map((element) => {
        const { x, width, height } = element.getBoundingClientRect();
        return { id: element.id, x, width, height };
      })
    };
  });
  assert.ok(layout.scrollWidth <= layout.width, `${label}: no horizontal overflow (${layout.scrollWidth}/${layout.width})`);
  if (layout.width <= 390 && layout.buttons.length <= 3) {
    assert.ok(layout.height <= 140, `${label}: ordinary mobile header stays compact (${layout.height}px)`);
  }
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
        assert.equal(await page.locator('#installHelp').isVisible(), false, 'Manual install guidance has one entry point');
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
    const password = login.page.locator('#passwordInput');
    const visibility = login.page.locator('#passwordVisibilityButton');
    await password.fill('Fixture-password-only');
    await visibility.focus();
    await login.page.keyboard.press('Space');
    assert.equal(await password.getAttribute('type'), 'text');
    assert.equal(await visibility.getAttribute('aria-pressed'), 'true');
    assert.equal(await visibility.innerText(), 'Hide password');
    assert.equal(await password.inputValue(), 'Fixture-password-only');
    await login.page.keyboard.press('Enter');
    assert.equal(await password.getAttribute('type'), 'password');
    assert.equal(await visibility.getAttribute('aria-controls'), 'passwordInput');
    await guidance.locator('summary').click();
    await login.page.evaluate(() => window.scrollTo(0, 0));
    await login.page.mouse.move(1, 1);
    await login.page.screenshot({ path: path.join(output, 'login-help-open-390-en-light.png'), animations: 'disabled', fullPage: true });
    await guidance.locator('summary').click();
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
    const heldLogin = login.holdNextLogin();
    await login.page.locator('#loginSubmitButton').click();
    await heldLogin.started;
    assert.equal(await password.getAttribute('type'), 'password', 'Submitting always conceals the password');
    await login.page.locator('#loginFeedback').waitFor({ state: 'visible' });
    assert.equal(await login.page.locator('#loginSubmitButton').isDisabled(), true);
    assert.match(await login.page.locator('#loginFeedback').innerText(), /Signing in with the backend/,
      'Visible feedback is still pending while the login response is held');
    heldLogin.release();
    await login.page.waitForFunction(() => !document.querySelector('#loginSubmitButton').disabled);
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
    await waitForAsyncCondition(field.page, async () => {
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
    assert.equal(await review.page.locator('#reportReviewFilters').evaluate((element) => element.open), false);
    assert.equal(await review.page.locator('#reportExportOptions').evaluate((element) => element.open), false);
    await review.page.locator('#reportExportOptions > summary').click();
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
  const desktop = await fixture(browser, supervisor, 1280);
  try {
    assert.equal(await desktop.page.locator('#reportReviewFilters').evaluate((element) => element.open), false, 'Restored desktop sessions start with secondary filters closed');
    await desktop.page.locator('#reportReviewFilters > summary').click();
    for (const width of [1280, 1440, 1100, 1024, 980, 768, 390, 320]) {
      await desktop.page.setViewportSize({ width, height: 844 });
      for (const language of ['en', 'zh']) for (const theme of ['light', 'dark']) {
        const label = `supervisor-clear-${width}-${language}-${theme}`;
        await setPresentation(desktop.page, language, theme);
        const clear = desktop.page.locator('#clearSupervisorFiltersButton');
        await clear.scrollIntoViewIfNeeded();
        if ([1280, 390, 320].includes(width) && ((language === 'en' && theme === 'light') || (language === 'zh' && theme === 'dark'))) {
          await desktop.page.locator('#reportReviewFilters').screenshot({ path: path.join(output, `${label}.png`), animations: 'disabled' });
        }
        const layout = await desktop.page.evaluate(() => {
          const form = document.querySelector('#supervisorFilterForm');
          const button = document.querySelector('#clearSupervisorFiltersButton').getBoundingClientRect();
          const controls = [...form.querySelectorAll('input, select')].filter((node) => node.getClientRects().length);
          return {
            right: button.right, formRight: form.getBoundingClientRect().right,
            width: button.width, height: button.height, top: button.top, left: button.left, bottom: button.bottom,
            lastControlBottom: Math.max(...controls.map((node) => node.getBoundingClientRect().bottom)),
            firstControlBottom: Math.min(...controls.map((node) => node.getBoundingClientRect().bottom)),
            lastControlRight: Math.max(...controls.map((node) => node.getBoundingClientRect().right)),
            overflow: document.documentElement.scrollWidth > window.innerWidth
          };
        });
        assert.ok(Math.abs(layout.right - layout.formRight) <= 1, `${label}: Clear aligns with the full filter group, not the first grid column (${layout.right}/${layout.formRight})`);
        if (width >= 1100) {
          assert.ok(layout.left >= layout.lastControlRight, `${label}: Clear follows controls on the compact row without overlap`);
          assert.ok(Math.abs(layout.bottom - layout.lastControlBottom) <= 1
            && Math.abs(layout.bottom - layout.firstControlBottom) <= 1, `${label}: the compact row shares a bottom alignment`);
        } else {
          assert.ok(layout.top >= layout.lastControlBottom, `${label}: Clear follows the stacked filter controls without overlap`);
        }
        assert.ok(layout.width >= 44 && layout.height >= 44, `${label}: Clear retains a 44px target`);
        assert.equal(layout.overflow, false, `${label}: no horizontal overflow`);
        assert.equal(await clear.getAttribute('type'), 'button');
        assert.equal(await clear.innerText(), language === 'en' ? 'Clear' : '清除');
      }
    }
    for (const width of [1280, 390]) for (const language of ['en', 'zh']) {
      await desktop.page.setViewportSize({ width, height: 844 });
      await setPresentation(desktop.page, language, 'light');
      await desktop.page.locator('#supervisorTemplateFilter').selectOption(String(template.id));
      await desktop.page.locator('#supervisorWorkerFilter').selectOption(String(worker.id));
      await desktop.page.locator('#supervisorDateFilter').fill('2026-10-14');
      const filtered = desktop.page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/api/supervisor/review-queue' && url.searchParams.get('search') === 'Clear position check';
      });
      await desktop.page.locator('#supervisorSearchInput').fill('Clear position check');
      await filtered;
      await desktop.page.waitForFunction(() => !document.querySelector('#clearSupervisorFiltersButton').disabled);
      await desktop.page.locator('#supervisorDateFilter').focus();
      // Native date inputs may expose multiple keyboard segments before the next control.
      for (let step = 0; step < 5 && !await desktop.page.locator('#clearSupervisorFiltersButton').evaluate((node) => document.activeElement === node); step++) {
        await desktop.page.keyboard.press('Tab');
      }
      assert.equal(await desktop.page.locator('#clearSupervisorFiltersButton').evaluate((node) => document.activeElement === node), true, 'Clear follows Report Date in keyboard navigation');
      const cleared = desktop.page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/api/supervisor/review-queue' && url.searchParams.get('purpose') === 'report'
          && ['search', 'workflow_status', 'form_id', 'worker_id', 'record_date', 'cursor'].every((key) => !url.searchParams.get(key))
          && (url.searchParams.get('sort_order') || 'newest') === 'newest';
      });
      await desktop.page.keyboard.press('Enter');
      assert.equal((await cleared).ok(), true, 'Clear refreshes the default Report query');
      for (const selector of ['#supervisorSearchInput', '#supervisorStatusFilter', '#supervisorTemplateFilter', '#supervisorWorkerFilter', '#supervisorDateFilter']) {
        assert.equal(await desktop.page.locator(selector).inputValue(), '', `${width}/${language}: Clear resets ${selector}`);
      }
      assert.equal(await desktop.page.locator('#supervisorSortOrder').count(), 0);
      assert.equal(await desktop.page.locator('#supervisorStatusFilter').isVisible(), false);
      assert.equal(await desktop.page.locator('#reportReviewFilters').evaluate((node) => node.open), true, 'Clear keeps the filters open');
    }
    console.log('ok - Supervisor Clear aligns with the complete filter group across 32 layouts and resets the Report query by keyboard on desktop/mobile in English/Chinese');
    await desktop.page.setViewportSize({ width: 390, height: 844 });
    await desktop.page.setViewportSize({ width: 1280, height: 844 });
    assert.equal(await desktop.page.locator('#reportReviewFilters').evaluate((element) => element.open), true, 'Resizing preserves the user choice');
    await desktop.page.reload();
    await desktop.page.waitForFunction(() => document.body.dataset.activeView === 'supervisor');
    assert.equal(await desktop.page.locator('#reportReviewFilters').evaluate((element) => element.open), false, 'Reload restores the compact desktop default');
    console.log('ok - restored desktop defaults and user-controlled filter disclosure survive responsive changes');
  } finally { await desktop.close(); }
} finally {
  await browser.close();
}
