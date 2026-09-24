import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59983'; // All requests are intercepted; no running server or live account is used.
const output = path.join(root, 'output', 'setup-continuation.local');
const token = 'setup_test_private_capability_01234567890123456789';
const replacementToken = 'replacement_private_capability_01234567890123456789';
const password = 'Isolated-setup-password!';
const worker = { id: 73, department_id: 2, department_name: 'Mutual', role: 'worker',
  worker_class: 'normal', name: 'Setup test Worker', email: 'setup@example.invalid', status: 'active' };
const otherUser = { ...worker, id: 74, role: 'supervisor', name: 'Existing Supervisor', email: 'existing@example.invalid' };
const setPasswordStatus = 'Password set. You can now sign in to ReportFlow.';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(browser, options = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const errors = [];
  const unexpected = [];
  const requests = { inspect: [], accept: [], login: [], api: [] };
  const acceptGate = deferred();
  const loginGate = deferred();
  let acceptFailure = options.acceptFailure || 0;
  let loginFailure = options.loginFailure || 0;
  let inspectFailure = options.inspectFailure || 0;
  if (!options.holdAccept) acceptGate.resolve();
  if (!options.holdLogin) loginGate.resolve();
  await context.addInitScript(({ unreadableStorage }) => {
    window.setupTestFetches = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const entry = { path: String(input), credentials: init.credentials, cache: init.cache,
        referrerPolicy: init.referrerPolicy, settled: false };
      window.setupTestFetches.push(entry);
      try { return await originalFetch(input, init); }
      finally { entry.settled = true; }
    };
    if (unreadableStorage && window.location.pathname === '/setup-password.html') {
      Storage.prototype.getItem = () => { throw new DOMException('Storage blocked for isolated test', 'SecurityError'); };
    }
  }, { unreadableStorage: Boolean(options.unreadableStorage) });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push(url.origin);
      return route.abort();
    }
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated setup test</title>' });
    if (url.pathname.startsWith('/api/')) requests.api.push(`${request.method()} ${url.pathname}`);
    if (url.pathname === '/api/auth/worker-invitations/inspect') {
      const body = request.postDataJSON();
      requests.inspect.push(body);
      if (inspectFailure) return json({ detail: 'This invitation is invalid or expired.' }, inspectFailure);
      return json({ name: body.token === replacementToken ? 'Replacement Worker' : worker.name,
        email: body.token === replacementToken ? 'replacement@example.invalid' : worker.email,
        department_name: worker.department_name });
    }
    if (url.pathname === '/api/auth/worker-invitations/accept') {
      requests.accept.push(request.postDataJSON());
      await acceptGate.promise;
      if (acceptFailure) return json({ detail: acceptFailure === 400 ? 'This invitation is invalid or expired.' : 'Cannot complete setup right now. Try again.' }, acceptFailure);
      return json({ message: 'Password set. You can now sign in.' });
    }
    if (url.pathname === '/api/auth/login/after-setup') {
      requests.login.push(request.postDataJSON());
      await loginGate.promise;
      if (loginFailure === 'network') return route.abort('internetdisconnected');
      if (loginFailure === 409) return json({ detail: { code: 'browser_session_present', message: 'An account is already signed in in this browser.' } }, 409);
      if (loginFailure) return json({ detail: 'Cannot sign in right now.' }, loginFailure);
      return json({ user: worker });
    }
    if (['/api/auth/refresh', '/api/auth/me'].includes(url.pathname)) return json(worker);
    if (url.pathname === '/api/departments') return json([{ id: 2, name: 'Mutual' }]);
    if (['/api/sites', '/api/work-forms', '/api/my-form-submissions'].includes(url.pathname)) return json([]);
    if (url.pathname.startsWith('/api/')) {
      unexpected.push(`${request.method()} ${url.pathname}`);
      return json({ detail: 'Unexpected isolated setup API request' }, 500);
    }
    const file = path.resolve(root, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    assert.ok(file.startsWith(`${root}${path.sep}`), 'Only repository files may be served');
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
  await page.evaluate(({ existingIdentity, legacyToken }) => {
    localStorage.setItem('leader-theme', 'light');
    if (existingIdentity !== undefined) localStorage.setItem('geo_user', existingIdentity);
    if (legacyToken) localStorage.setItem('geo_token', legacyToken);
  }, options);
  if (options.csrfCookie) await context.addCookies([{ name: 'geo_csrf_token', value: 'existing-browser-token', url: origin }]);
  return { context, page, errors, unexpected, requests, acceptGate, loginGate,
    setAcceptFailure(value) { acceptFailure = value; },
    setLoginFailure(value) { loginFailure = value; },
    setInspectFailure(value) { inspectFailure = value; },
    async open() {
      await page.goto(`${origin}/setup-password.html#token=${token}&next=https%3A%2F%2Fexample.invalid%2F`);
      await page.locator('#setupPasswordForm').waitFor({ state: 'visible' });
      assert.equal(new URL(page.url()).hash, '', 'Private token is removed from the address bar before inspection');
      assert.equal(new URL(page.url()).search, '', 'Setup does not retain a redirect/query parameter');
      assert.match(await page.locator('#setupInvitationIdentity').innerText(), /setup@example\.invalid/);
    },
    async close() {
      acceptGate.resolve(); loginGate.resolve();
      await context.close();
      assert.deepEqual(errors, [], 'No unhandled browser errors');
      assert.deepEqual(unexpected, [], 'No unexpected or external requests');
    } };
}

async function fillAndSubmit(page) {
  await page.locator('#setupPasswordInput').fill(password);
  await page.locator('#setupPasswordConfirmInput').fill(password);
  await page.locator('#setupPasswordButton').click();
}

async function waitRequest(page, suffix) {
  await page.waitForFunction((ending) => window.setupTestFetches.some((entry) => entry.path.endsWith(ending)), suffix);
}

async function drainRequest(page, suffix) {
  await page.waitForFunction((ending) => window.setupTestFetches.some((entry) => entry.path.endsWith(ending) && entry.settled), suffix);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function assertFinishedWithoutContinuation(f) {
  await f.page.locator('#setupPasswordStatus').getByText(setPasswordStatus, { exact: true }).waitFor();
  assert.equal(await f.page.locator('#setupPasswordForm').isVisible(), false);
  assert.equal(await f.page.locator('#setupPasswordInput').inputValue(), '');
  assert.equal(await f.page.locator('#setupPasswordConfirmInput').inputValue(), '');
  assert.equal(await f.page.locator('#setupContinuationHelp').isVisible(), true);
  assert.equal(await f.page.locator('a[href="/index.html"]').isVisible(), true);
  assert.equal(new URL(f.page.url()).pathname, '/setup-password.html');
  assert.equal(f.requests.accept.length, 1);
  await f.page.evaluate(() => document.querySelector('#setupPasswordForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await f.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  assert.equal(f.requests.accept.length, 1, 'A successful acceptance is never replayed by the hidden form');
}

async function checkCleanContinuation(browser) {
  const f = await fixture(browser, { legacyToken: 'old-local-bearer-value', holdAccept: true, holdLogin: true });
  try {
    await f.open();
    assert.equal(await f.page.locator('#setupPasswordButton').innerText(), 'Set password and continue');
    await fillAndSubmit(f.page);
    await waitRequest(f.page, '/accept');
    assert.equal(await f.page.locator('#setupPasswordButton').isDisabled(), true);
    await f.page.evaluate(() => document.querySelector('#setupPasswordForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(f.requests.accept.length, 1, 'Double submission cannot duplicate activation');
    f.acceptGate.resolve();
    await waitRequest(f.page, '/login/after-setup');
    assert.equal(await f.page.locator('#setupPasswordInput').inputValue(), '', 'Accepted password is cleared from the DOM before continuation');
    assert.equal(await f.page.locator('#setupPasswordConfirmInput').inputValue(), '');
    const fetches = await f.page.evaluate(() => window.setupTestFetches);
    for (const suffix of ['/inspect', '/accept']) {
      const request = fetches.find((entry) => entry.path.endsWith(suffix));
      assert.equal(request.credentials, 'omit', 'Capability acceptance never changes an existing cookie session');
      assert.equal(request.cache, 'no-store');
      assert.equal(request.referrerPolicy, 'no-referrer');
    }
    assert.equal(fetches.find((entry) => entry.path.endsWith('/login/after-setup')).credentials, 'include');
    assert.deepEqual(f.requests.login, [{ email: worker.email, password, only_if_signed_out: true }]);
    assert.deepEqual(f.requests.accept, [{ token, password }]);
    f.loginGate.resolve();
    await f.page.waitForURL(`${origin}/index.html`);
    await f.page.waitForFunction(() => document.body.dataset.activeView === 'worker');
    const storage = await f.page.evaluate(() => ({ user: JSON.parse(localStorage.getItem('geo_user')), token: localStorage.getItem('geo_token'),
      all: Object.keys(localStorage).map((key) => localStorage.getItem(key)).join('\n') }));
    assert.equal(storage.user.id, worker.id);
    assert.equal(storage.user.departmentId, worker.department_id);
    assert.equal(storage.token, null, 'Legacy bearer data is removed through the shared saveSession boundary');
    assert.ok(!storage.all.includes(password) && !storage.all.includes(token), 'Private setup credentials are not saved to device storage');
    assert.equal(f.requests.login.length, 1);
    console.log('ok - clean setup continues directly to Worker with a guarded cookie login and fixed app destination');
  } finally { await f.close(); }
}

async function checkExistingBrowserState(browser) {
  const cases = [
    ['cached account', { existingIdentity: JSON.stringify(otherUser) }],
    ['malformed cached account', { existingIdentity: '{incomplete-json' }],
    ['empty cached account', { existingIdentity: '' }],
    ['observable CSRF cookie', { csrfCookie: true }],
    ['unreadable device storage', { unreadableStorage: true }]
  ];
  for (const [name, options] of cases) {
    const f = await fixture(browser, options);
    try {
      await f.open();
      assert.equal(await f.page.locator('#setupPasswordButton').innerText(), 'Set password', `${name}: no promise of automatic account switching`);
      await fillAndSubmit(f.page);
      await assertFinishedWithoutContinuation(f);
      assert.equal(f.requests.login.length, 0, `${name}: do not attempt a replacement login`);
      if ('existingIdentity' in options) assert.equal(await f.page.evaluate(() => localStorage.getItem('geo_user')), options.existingIdentity);
      if (options.csrfCookie) assert.equal((await f.context.cookies()).find((cookie) => cookie.name === 'geo_csrf_token')?.value, 'existing-browser-token');
      console.log(`ok - ${name}: activation is allowed without replacing browser identity`);
    } finally { await f.close(); }
  }
}

async function checkContinuationFailure(browser) {
  for (const failure of [409, 'network', 503, 404]) {
    const f = await fixture(browser, { loginFailure: failure });
    try {
      await f.open();
      await fillAndSubmit(f.page);
      await assertFinishedWithoutContinuation(f);
      assert.equal(f.requests.login.length, 1);
      assert.equal(await f.page.evaluate(() => localStorage.getItem('geo_user')), null);
      assert.equal(await f.page.locator('#setupPasswordRetryButton').isVisible(), false, 'Login failure must not offer to replay consumed invitation setup');
      console.log(`ok - continuation ${failure}: password success stays clear and normal sign-in remains available`);
    } finally { await f.close(); }
  }
}

async function checkAcceptanceFailure(browser) {
  const f = await fixture(browser, { acceptFailure: 503, existingIdentity: JSON.stringify(otherUser) });
  try {
    await f.open();
    await fillAndSubmit(f.page);
    await f.page.locator('#setupPasswordStatus').getByText('Cannot complete setup right now. Try again.', { exact: true }).waitFor();
    assert.equal(await f.page.locator('#setupPasswordForm').isVisible(), true);
    assert.equal(await f.page.locator('#setupPasswordInput').inputValue(), password);
    assert.equal(await f.page.locator('#setupPasswordButton').isEnabled(), true);
    assert.equal(f.requests.login.length, 0);
    f.setAcceptFailure(0);
    await f.page.locator('#setupPasswordButton').click();
    await f.page.locator('#setupPasswordStatus').getByText(setPasswordStatus, { exact: true }).waitFor();
    assert.equal(f.requests.accept.length, 2);
    assert.deepEqual(f.requests.accept[1], { token, password });
    console.log('ok - unaccepted invitation retains editable password and capability for a deliberate retry');
  } finally { await f.close(); }
  const invalid = await fixture(browser, { acceptFailure: 400 });
  try {
    await invalid.open();
    await fillAndSubmit(invalid.page);
    await invalid.page.locator('#setupPasswordStatus').getByText(/invitation is invalid or expired/).waitFor();
    assert.equal(await invalid.page.locator('#setupPasswordForm').isVisible(), false);
    assert.equal(await invalid.page.locator('#setupPasswordInput').inputValue(), '');
    assert.equal(await invalid.page.locator('#setupInvitationIdentity').innerText(), '');
    assert.equal(invalid.requests.login.length, 0);
    console.log('ok - revoked/expired acceptance clears secrets and cannot trigger continuation');
  } finally { await invalid.close(); }
}

async function checkLateResponsePrivacy(browser) {
  for (const stage of ['accept', 'login']) {
    const f = await fixture(browser, stage === 'accept' ? { holdAccept: true } : { holdLogin: true });
    try {
      await f.open();
      await fillAndSubmit(f.page);
      const ending = stage === 'accept' ? '/accept' : '/login/after-setup';
      await waitRequest(f.page, ending);
      await f.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
      f.acceptGate.resolve(); f.loginGate.resolve();
      await drainRequest(f.page, ending);
      assert.equal(new URL(f.page.url()).pathname, '/setup-password.html');
      assert.equal(await f.page.locator('#setupPasswordInput').inputValue(), '');
      assert.equal(await f.page.locator('#setupPasswordConfirmInput').inputValue(), '');
      assert.equal(await f.page.locator('#setupInvitationIdentity').innerText(), '');
      assert.equal(await f.page.evaluate(() => localStorage.getItem('geo_user')), null);
      if (stage === 'accept') assert.equal(f.requests.login.length, 0);
      console.log(`ok - late ${stage} after pagehide cannot restore identity, password, or navigation`);
    } finally { await f.close(); }
  }
  const replaced = await fixture(browser, { holdLogin: true });
  try {
    await replaced.open();
    await fillAndSubmit(replaced.page);
    await waitRequest(replaced.page, '/login/after-setup');
    await replaced.page.evaluate((next) => { window.location.hash = `token=${next}`; }, replacementToken);
    await replaced.page.locator('#setupInvitationIdentity').getByText(/Replacement Worker/).waitFor();
    replaced.loginGate.resolve();
    await drainRequest(replaced.page, '/login/after-setup');
    assert.equal(new URL(replaced.page.url()).pathname, '/setup-password.html');
    assert.equal(await replaced.page.evaluate(() => localStorage.getItem('geo_user')), null);
    assert.match(await replaced.page.locator('#setupInvitationIdentity').innerText(), /replacement@example\.invalid/);
    assert.equal(await replaced.page.locator('#setupPasswordForm').isVisible(), true);
    console.log('ok - replacement invitation is not overwritten by a stale continuation response');
  } finally { await replaced.close(); }
  const owner = await fixture(browser, { holdLogin: true });
  try {
    await owner.open();
    await fillAndSubmit(owner.page);
    await waitRequest(owner.page, '/login/after-setup');
    await owner.page.evaluate((value) => localStorage.setItem('geo_user', value), JSON.stringify(otherUser));
    owner.loginGate.resolve();
    await assertFinishedWithoutContinuation(owner);
    assert.equal(await owner.page.evaluate(() => localStorage.getItem('geo_user')), JSON.stringify(otherUser));
    console.log('ok - an account appearing during continuation is not overwritten in local storage');
  } finally { await owner.close(); }
}

async function assertLayout(page, selectors, label) {
  const layout = await page.evaluate((items) => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth,
    boxes: items.map((selector) => {
      const node = document.querySelector(selector);
      const { x, width, height } = node.getBoundingClientRect();
      return { selector, x, width, height };
    }) }), selectors);
  assert.ok(layout.scrollWidth <= layout.width, `${label}: no horizontal overflow`);
  for (const box of layout.boxes) {
    assert.ok(box.x >= 0 && box.x + box.width <= layout.width + 1, `${label}: ${box.selector} fits the phone`);
    assert.ok(box.width >= 44 && box.height >= 44, `${label}: ${box.selector} preserves a 44px touch target`);
  }
}

async function checkRecoveryAndPhoneLayouts(browser) {
  const f = await fixture(browser);
  try {
    await f.page.goto(`${origin}/index.html`);
    await f.page.waitForFunction(() => document.body.dataset.activeView === 'login');
    const recovery = f.page.locator('#passwordRecoveryHelp');
    assert.equal(await recovery.isVisible(), true, 'Recovery entry is visible without opening another help disclosure');
    assert.equal(await recovery.evaluate((element) => Boolean(element.parentElement.closest('details'))), false);
    assert.equal(await recovery.locator('summary').innerText(), 'Forgot password?');
    const before = f.requests.api.length;
    await recovery.locator('summary').focus();
    await f.page.keyboard.press('Enter');
    assert.equal(await recovery.evaluate((element) => element.open), true);
    assert.match(await recovery.innerText(), /supervisor/i);
    assert.match(await recovery.innerText(), /private/i);
    assert.match(await recovery.innerText(), /emails are not available/i, 'Guidance truthfully says recovery email is not sent');
    assert.equal(f.requests.api.length, before, 'Opening recovery guidance does not call a reset or email API');
    for (const width of [320, 390]) {
      await f.page.setViewportSize({ width, height: 844 });
      for (const language of ['en', 'zh']) {
        if (await f.page.evaluate(() => document.documentElement.dataset.language) !== language) await f.page.locator('#languageToggleButton').click();
        await assertLayout(f.page, ['#loginSubmitButton', '#passwordRecoveryHelp > summary'], `recovery-${width}-${language}`);
        if (language === 'zh') assert.match(await recovery.locator('summary').innerText(), /[\u3400-\u9fff]/);
        await f.page.mouse.move(1, 1);
        await f.page.screenshot({ path: path.join(output, `recovery-${width}-${language}.png`), fullPage: true, animations: 'disabled' });
      }
    }
    await f.page.evaluate(() => localStorage.setItem('leader-language', 'en'));
    await f.open();
    const linkHelp = f.page.locator('#setupLinkHelp');
    assert.equal(await linkHelp.evaluate((element) => element.open), false);
    await linkHelp.locator('summary').focus();
    await f.page.keyboard.press('Enter');
    assert.match(await linkHelp.innerText(), /expired|already used/);
    await f.page.keyboard.press('Space');
    assert.equal(await linkHelp.evaluate((element) => element.open), false);
    for (const width of [320, 390]) {
      await f.page.setViewportSize({ width, height: 844 });
      for (const language of ['en', 'zh']) {
        if (await f.page.evaluate(() => document.documentElement.dataset.language) !== language) await f.page.locator('#setupLanguageButton').click();
        await assertLayout(f.page, ['#setupLanguageButton', '#setupPasswordButton'], `setup-${width}-${language}`);
        await f.page.evaluate(() => window.scrollTo(0, 0));
        const primary = await f.page.locator('#setupPasswordButton').boundingBox();
        assert.ok(primary.y + primary.height <= 844, 'Setup primary action fits the first phone screen');
        if (language === 'zh') assert.match(await f.page.locator('#setupPasswordButton').innerText(), /[\u3400-\u9fff]/);
        await f.page.mouse.move(1, 1);
        await f.page.screenshot({ path: path.join(output, `setup-${width}-${language}.png`), fullPage: true, animations: 'disabled' });
      }
    }
    console.log('ok - visible supervisor-assisted recovery and setup layouts work at 320/390px in English/Chinese');
  } finally { await f.close(); }
}

const browser = await chromium.launch({ headless: true });
try {
  await mkdir(output, { recursive: true });
  await checkCleanContinuation(browser);
  await checkExistingBrowserState(browser);
  await checkContinuationFailure(browser);
  await checkAcceptanceFailure(browser);
  await checkLateResponsePrivacy(browser);
  await checkRecoveryAndPhoneLayouts(browser);
  console.log('Setup continuation checks passed (isolated Chromium; mocked transport, no live email/account changes).');
} finally { await browser.close(); }
