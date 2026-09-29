import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59984'; // Every request is intercepted; no server or live account.
const output = path.join(root, 'output', 'password-recovery.local');
const token = 'recovery_private_capability_01234567890123456789';
const replacementToken = 'replacement_private_capability_01234567890123456789';
const password = 'Private-recovered-password!';
const success = 'Password reset. You can now sign in to ReportFlow.';
const invalid = 'This recovery link is invalid or expired. If you just reset your password, try signing in; otherwise ask your supervisor for a new link.';
const missing = 'Open the complete private recovery link from your supervisor.';
const uncertain = 'We could not confirm whether your password changed. Try signing in with the new password first. If it does not work, retry here or ask your supervisor for a new link.';
const worker = { name: 'Recovery <img src=x onerror=alert(1)> Worker', email: 'worker@example.invalid', department_name: 'Mutual', expires_at: '2030-10-01T12:00:00Z' };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function snapshot(page, context) {
  return {
    state: await page.evaluate(async () => {
      const records = await new Promise((resolve, reject) => {
        const open = indexedDB.open('isolated-recovery-saved-work', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          const read = database.transaction('drafts').objectStore('drafts').getAll();
          read.onsuccess = () => { resolve(read.result); database.close(); };
          read.onerror = () => reject(read.error);
        };
      });
      return { local: { ...localStorage }, session: { ...sessionStorage }, records };
    }),
    cookies: await context.cookies()
  };
}

async function fixture(browser, options = {}) {
  const context = await browser.newContext({ viewport: { width: options.width || 390, height: 844 }, serviceWorkers: 'block' });
  const errors = [];
  const consoleMessages = [];
  const unexpected = [];
  const requests = { inspect: [], accept: [], urls: [], headers: [] };
  const gates = { inspect: deferred(), accept: deferred() };
  if (!options.holdInspect) gates.inspect.resolve();
  if (!options.holdAccept) gates.accept.resolve();
  let inspectFailure = options.inspectFailure || 0;
  let acceptFailure = options.acceptFailure || 0;
  await context.addInitScript(() => {
    window.recoveryFetches = [];
    const original = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const request = { path: String(input), credentials: init.credentials, cache: init.cache,
        referrerPolicy: init.referrerPolicy, url: window.location.href, settled: false };
      window.recoveryFetches.push(request);
      try { return await original(input, init); }
      finally { request.settled = true; }
    };
  });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.urls.push(request.url());
    if (url.origin !== origin) {
      unexpected.push(request.url());
      return route.abort();
    }
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated recovery test</title>' });
    if (url.pathname.startsWith('/api/auth/worker-password-recovery/')) {
      const action = url.pathname.split('/').at(-1);
      if (!['inspect', 'accept'].includes(action)) throw new Error('Unexpected recovery action');
      requests[action].push(request.postDataJSON());
      requests.headers.push(await request.allHeaders());
      const first = request.postDataJSON().token === token;
      if (first) await gates[action].promise;
      const failure = action === 'inspect' ? inspectFailure : acceptFailure;
      if (failure === 'network') return route.abort('internetdisconnected');
      if (failure) return json({ detail: `Never reflect private token ${token} or password ${password}` }, failure);
      return json(action === 'inspect' ? { ...worker, ...(first ? {} : { name: 'Replacement Worker', email: 'replacement@example.invalid' }) }
        : { message: 'Password updated.' });
    }
    const allowed = ['/recover-password.html', '/assets/js/recover-password.js', '/assets/js/i18n.js', '/assets/css/styles.css', '/assets/icons/reportflow-icon.svg'];
    if (!allowed.includes(url.pathname)) {
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.abort();
    }
    const file = path.join(root, url.pathname.slice(1));
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    return route.fulfill({ contentType: types[path.extname(file)], body: await readFile(file), headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => consoleMessages.push(message.text()));
  await page.goto(`${origin}/fixture`);
  await page.evaluate(async ({ language, theme, identity }) => {
    localStorage.setItem('leader-language', language || 'en');
    localStorage.setItem('leader-theme', theme || 'light');
    if (identity !== undefined) localStorage.setItem('geo_user', identity);
    localStorage.setItem('unfinished-draft-sentinel', 'Keep this unfinished form');
    sessionStorage.setItem('unfinished-template-sentinel', 'Keep this Template edit');
    await new Promise((resolve, reject) => {
      const open = indexedDB.open('isolated-recovery-saved-work', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('drafts', { keyPath: 'id' });
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction('drafts', 'readwrite');
        transaction.objectStore('drafts').put({ id: 'report-draft', content: 'original-photo-and-signature-evidence', workerId: 77 });
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  }, options);
  await context.addCookies([
    { name: '__session', value: 'existing-other-account-cookie', url: origin, httpOnly: true },
    { name: 'geo_csrf_token', value: 'existing-csrf-cookie', url: origin }
  ]);
  const before = await snapshot(page, context);
  return { context, page, requests, gates, before,
    setInspectFailure(value) { inspectFailure = value; },
    setAcceptFailure(value) { acceptFailure = value; },
    async open({ visible = true, capability = token } = {}) {
      await page.goto(`${origin}/recover-password.html?next=https%3A%2F%2Fexample.invalid#token=${capability}`);
      if (visible) await page.locator('#recoveryPasswordForm').waitFor({ state: 'visible' });
      await page.waitForFunction(() => !window.location.hash && !window.location.search);
    },
    async close() {
      gates.inspect.resolve(); gates.accept.resolve();
      assert.ok(!requests.urls.some((value) => value.includes(token) || value.includes(password)), 'No secret appears in a request URL');
      assert.ok(!consoleMessages.some((value) => value.includes(token) || value.includes(password)), 'No secret appears in console output');
      const safeBody = await page.locator('body').innerText();
      assert.ok(!safeBody.includes(token) && !safeBody.includes(password), 'No server error echoes submitted credentials');
      await context.close();
      assert.deepEqual(errors, [], 'No unhandled browser errors');
      assert.deepEqual(unexpected, [], 'No unexpected API or external request');
    }
  };
}

async function submit(page, value = password, confirm = value) {
  await page.locator('#recoveryPasswordInput').fill(value);
  await page.locator('#recoveryPasswordConfirmInput').fill(confirm);
  await page.locator('#recoveryPasswordButton').click();
}

async function statusIs(page, value) {
  await page.locator('#recoveryPasswordStatus').getByText(value, { exact: true }).waitFor();
}

async function waitRequest(page, action, settled = false) {
  await page.waitForFunction(({ ending, finished }) => window.recoveryFetches.some((entry) => entry.path.endsWith(ending) && (!finished || entry.settled)), { ending: `/${action}`, finished: settled });
  if (settled) await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function assertNoPrivateFields(page) {
  assert.equal(await page.locator('#recoveryPasswordForm').isVisible(), false);
  assert.equal(await page.locator('#recoveryPasswordInput').inputValue(), '');
  assert.equal(await page.locator('#recoveryPasswordConfirmInput').inputValue(), '');
  assert.equal(await page.locator('#recoveryIdentity').innerText(), '');
  assert.equal(await page.locator('#recoveryExpiry').isVisible(), false);
}

async function checkSuccess(browser) {
  for (const identity of [undefined, '{malformed-cached-account', JSON.stringify({ id: 77, role: 'supervisor', email: 'other@example.invalid' })]) {
    const f = await fixture(browser, { identity, holdAccept: true });
    try {
      await f.open();
      assert.equal(await f.page.locator('#recoveryIdentity').innerText(), `${worker.name} — ${worker.email} — ${worker.department_name}`);
      assert.equal(await f.page.locator('#recoveryIdentity img').count(), 0, 'Server identity is literal text, never markup');
      assert.equal(await f.page.locator('#recoveryExpiryTime').getAttribute('datetime'), worker.expires_at.replace('Z', '.000Z'));
      await submit(f.page);
      await waitRequest(f.page, 'accept');
      await f.page.evaluate(() => document.querySelector('#recoveryPasswordForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })));
      assert.equal(f.requests.accept.length, 1, 'Repeated clicks cannot issue another reset');
      assert.equal(await f.page.locator('#recoveryPasswordButton').isDisabled(), true);
      f.gates.accept.resolve();
      await statusIs(f.page, success);
      await assertNoPrivateFields(f.page);
      assert.match(await f.page.locator('#recoverySessionHelp').innerText(), /old sessions are signed out.*other account.*unchanged/);
      assert.equal(await f.page.locator('a[href="/index.html"]').isVisible(), true);
      assert.equal(new URL(f.page.url()).pathname, '/recover-password.html', 'No auto-login or navigation');
      assert.deepEqual(f.requests.accept, [{ token, password }]);
      await f.page.evaluate(() => document.querySelector('#recoveryPasswordForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })));
      assert.equal(f.requests.accept.length, 1, 'A consumed capability cannot be replayed by a hidden form');
      assert.deepEqual(await snapshot(f.page, f.context), f.before, 'Saved identity, cookies and all draft sentinels stay byte-for-byte unchanged');
      const fetches = await f.page.evaluate(() => window.recoveryFetches);
      for (const request of fetches) {
        assert.equal(request.credentials, 'omit');
        assert.equal(request.cache, 'no-store');
        assert.equal(request.referrerPolicy, 'no-referrer');
        assert.equal(new URL(request.url).hash, '');
        assert.equal(new URL(request.url).search, '');
      }
      for (const headers of f.requests.headers) {
        assert.equal(headers.cookie, undefined, 'The recovery API never receives the browser session cookie');
        assert.equal(headers.referer, undefined);
      }
    } finally { await f.close(); }
  }
  console.log('ok - clean, malformed and shared-account recovery is single-use, private and leaves identities/cookies/device drafts unchanged');
}

async function checkPasswordValidation(browser) {
  const f = await fixture(browser);
  try {
    await f.open();
    await submit(f.page, password, 'Different-password!');
    await statusIs(f.page, 'Passwords do not match.');
    for (const value of ['short', '😀😀😀😀']) {
      await f.page.locator('#recoveryPasswordInput').fill(value);
      await f.page.locator('#recoveryPasswordConfirmInput').fill(value);
      await f.page.evaluate(() => document.querySelector('#recoveryPasswordForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })));
      await statusIs(f.page, 'Password must be at least 8 characters.');
    }
    await submit(f.page, '密'.repeat(25));
    await statusIs(f.page, 'Password must be at most 72 UTF-8 bytes.');
    assert.equal(f.requests.accept.length, 0);
    await submit(f.page, '密'.repeat(24));
    await statusIs(f.page, success);
    assert.equal(f.requests.accept.length, 1, 'The exact 72-byte boundary is accepted');
    console.log('ok - mismatch, Unicode character minimum and UTF-8 byte maximum are checked before requests');
  } finally { await f.close(); }
}

async function checkInvalidLinks(browser) {
  for (const capability of ['', 'too-short', 'not.a.valid.capability'.repeat(3)]) {
    const f = await fixture(browser);
    try {
      await f.open({ visible: false, capability });
      await statusIs(f.page, missing);
      assert.equal(f.requests.inspect.length, 0);
      assert.equal(f.requests.accept.length, 0);
      await assertNoPrivateFields(f.page);
    } finally { await f.close(); }
  }
  for (const action of ['inspect', 'accept']) {
    for (const failure of [400, 404, 409, 410]) {
      const f = await fixture(browser, { [`${action}Failure`]: failure });
      try {
        await f.open({ visible: action === 'accept' });
        if (action === 'accept') await submit(f.page);
        await statusIs(f.page, invalid);
        await assertNoPrivateFields(f.page);
        assert.equal(await f.page.locator('#recoveryPasswordRetryButton').isVisible(), false);
        await f.page.evaluate(() => document.querySelector('#recoveryPasswordForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })));
        assert.equal(f.requests.accept.length, action === 'accept' ? 1 : 0);
      } finally { await f.close(); }
    }
  }
  console.log('ok - malformed, expired, used and revoked links clear secrets and cannot be submitted or silently retried');
}

async function checkRetry(browser) {
  for (const failure of ['network', 429, 503]) {
    const f = await fixture(browser, { inspectFailure: failure });
    try {
      await f.open({ visible: false });
      await f.page.locator('#recoveryPasswordRetryButton').waitFor({ state: 'visible' });
      await assertNoPrivateFields(f.page);
      f.setInspectFailure(0);
      await f.page.locator('#recoveryPasswordRetryButton').click();
      await f.page.locator('#recoveryPasswordForm').waitFor({ state: 'visible' });
      assert.equal(f.requests.inspect.length, 2);
    } finally { await f.close(); }
  }
  for (const failure of ['network', 429, 422, 503]) {
    const f = await fixture(browser, { acceptFailure: failure });
    try {
      await f.open();
      await submit(f.page);
      const expected = failure === 429 ? 'Too many attempts. Wait a little before trying again.'
        : failure === 422 ? 'Check your new password. Use at least 8 characters, up to 72 UTF-8 bytes.' : uncertain;
      await statusIs(f.page, expected);
      assert.equal(await f.page.locator('#recoveryPasswordForm').isVisible(), true);
      assert.equal(await f.page.locator('#recoveryPasswordButton').isEnabled(), true);
      assert.equal(await f.page.locator('#recoveryPasswordInput').inputValue(), password);
      assert.equal(f.requests.accept.length, 1, 'No automatic password reset retry');
      f.setAcceptFailure(0);
      await f.page.locator('#recoveryPasswordButton').click();
      await statusIs(f.page, success);
      assert.equal(f.requests.accept.length, 2);
      assert.deepEqual(await snapshot(f.page, f.context), f.before);
    } finally { await f.close(); }
  }
  console.log('ok - offline/rate-limit/server failures allow deliberate retries; uncertain reset outcomes explain sign-in first');
}

async function checkRetiredResponses(browser) {
  for (const stage of ['inspect', 'accept']) {
    for (const replacement of [false, true]) {
      const f = await fixture(browser, { [stage === 'inspect' ? 'holdInspect' : 'holdAccept']: true });
      try {
        await f.open({ visible: stage !== 'inspect' });
        if (stage === 'accept') await submit(f.page);
        await waitRequest(f.page, stage);
        if (replacement) {
          await f.page.evaluate((next) => { window.location.hash = `token=${next}`; }, replacementToken);
          await f.page.locator('#recoveryIdentity').getByText(/Replacement Worker/).waitFor();
          f.gates[stage].resolve();
          await waitRequest(f.page, stage, true);
          assert.match(await f.page.locator('#recoveryIdentity').innerText(), /replacement@example\.invalid/);
          assert.equal(await f.page.locator('#recoveryPasswordInput').inputValue(), '');
          assert.equal(await f.page.locator('#recoveryPasswordForm').isVisible(), true);
          assert.equal(new URL(f.page.url()).hash, '');
          await submit(f.page);
          await statusIs(f.page, success);
          assert.equal(f.requests.accept.at(-1).token, replacementToken);
        } else {
          await f.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
          f.gates[stage].resolve();
          await waitRequest(f.page, stage, true);
          await statusIs(f.page, missing);
          await assertNoPrivateFields(f.page);
          await f.page.evaluate(() => document.querySelector('#recoveryPasswordForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })));
          assert.equal(f.requests.accept.length, stage === 'accept' ? 1 : 0);
        }
        assert.deepEqual(await snapshot(f.page, f.context), f.before);
      } finally { await f.close(); }
    }
  }
  const f = await fixture(browser, { holdAccept: true });
  try {
    await f.open();
    await submit(f.page);
    await waitRequest(f.page, 'accept');
    await f.page.evaluate(() => localStorage.setItem('geo_user', 'another-account-selected-during-reset'));
    f.gates.accept.resolve();
    await statusIs(f.page, success);
    assert.equal(await f.page.evaluate(() => localStorage.getItem('geo_user')), 'another-account-selected-during-reset');
    console.log('ok - hash replacement, pagehide and a concurrent account switch cannot be overwritten by stale responses');
  } finally { await f.close(); }
}

async function checkLayouts(browser) {
  for (const width of [320, 390]) for (const language of ['en', 'zh']) for (const theme of ['light', 'dark']) {
    const f = await fixture(browser, { width, language, theme });
    try {
      await f.open();
      assert.equal(await f.page.locator('html').getAttribute('data-theme'), theme);
      assert.equal(await f.page.locator('html').getAttribute('data-language'), language);
      if (language === 'zh') assert.match(await f.page.locator('#recoveryPasswordButton').innerText(), /[\u3400-\u9fff]/);
      const layout = await f.page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
        targets: ['#recoveryLanguageButton', '#recoveryPasswordButton', '#recoveryPasswordInput', '#recoveryPasswordConfirmInput'].map((selector) => {
          const { x, width, height } = document.querySelector(selector).getBoundingClientRect();
          return { selector, x, width, height };
        }) }));
      assert.ok(layout.scroll <= layout.width, `${width}/${language}/${theme}: no horizontal overflow`);
      for (const target of layout.targets) {
        assert.ok(target.x >= 0 && target.x + target.width <= width + 1, `${target.selector} fits the phone`);
        assert.ok(target.width >= 44 && target.height >= 44, `${target.selector} keeps a 44px touch target`);
      }
      await f.page.screenshot({ path: path.join(output, `recovery-${width}-${language}-${theme}.png`), fullPage: true, animations: 'disabled' });
    } finally { await f.close(); }
  }
  console.log('ok - 320/390px English/Chinese light/dark recovery layouts stay readable with accessible targets');
}

const browser = await chromium.launch({ headless: true });
try {
  await mkdir(output, { recursive: true });
  await checkSuccess(browser);
  await checkPasswordValidation(browser);
  await checkInvalidLinks(browser);
  await checkRetry(browser);
  await checkRetiredResponses(browser);
  await checkLayouts(browser);
  console.log('Password recovery page checks passed (six groups, isolated Chromium, mocked transport, no live resets).');
} finally { await browser.close(); }
