import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59983';
const token = 'SyntheticInvitationToken_12345678901234567890';
const index = await readFile(path.join(root, 'index.html'), 'utf8');
const dialogHtml = index.match(/<dialog\b[^>]*id="workerInvitationDialog"[\s\S]*?<\/dialog>/)[0];
const browser = await chromium.launch({ headless: true });
let checks = 0;

async function fixture({ outcome = 'accepted', pending = false, mode = 'invitation', attempted = false, language = 'en' } = {}) {
  const requests = [], errors = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    assert.equal(url.origin, origin, 'No external requests');
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body:
      `<!doctype html><html><title>Local invitation test</title><button id="opener">Open</button>${dialogHtml}</html>` });
    if (url.pathname === '/api/supervisor/users/2/invitation/email') {
      assert.equal(request.method(), 'POST');
      assert.deepEqual(request.postDataJSON(), { token }, 'Only the setup token is sent; recipient and URL are server-owned');
      assert.equal(request.headers()['x-csrf-token'], 'synthetic-csrf');
      requests.push('send');
      if (pending) await held;
      if (outcome === 'network') return route.abort('failed');
      if (outcome === 'unavailable') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({
        detail: { code: 'INVITATION_EMAIL_UNAVAILABLE', message: 'Unavailable' }
      }) });
      if (outcome === 'rejected') return route.fulfill({ status: 403, contentType: 'application/json', body: '{"detail":"Forbidden"}' });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ user_id: 2,
        invitation_id: outcome === 'mismatch' ? 999 : 7, recipient: 'worker@example.invalid',
        email_status: outcome === 'mismatch' ? 'accepted' : outcome,
        email_attempted_at: '2026-10-20T12:00:00Z', email_accepted_at: outcome === 'accepted' ? '2026-10-20T12:00:01Z' : null
      }) });
    }
    assert.match(url.pathname, /^\/assets\/js\/(worker-invitation-dialog|api-client|i18n|utils)\.js$/);
    return route.fulfill({ contentType: 'text/javascript', body: await readFile(path.join(root, url.pathname), 'utf8') });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  await page.evaluate(async ({ token, mode, attempted, language }) => {
    document.cookie = 'geo_csrf_token=synthetic-csrf; path=/';
    if (language === 'zh') (await import('/assets/js/i18n.js')).setLanguage('zh');
    const ids = [...document.querySelectorAll('[id]')].map((node) => node.id);
    const els = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
    const { createWorkerInvitationDialog } = await import('/assets/js/worker-invitation-dialog.js');
    const { emailWorkerInvitation } = await import('/assets/js/api-client.js');
    window.fixture = { current: true, copied: [] };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (value) => window.fixture.copied.push(value)
    } });
    window.fixture.dialog = createWorkerInvitationDialog(els, { sendInvitationEmail: emailWorkerInvitation });
    window.fixture.invitation = { token, delivery_method: 'manual', user: { id: 2, invitation_id: 7,
      email: 'worker@example.invalid', name: 'Worker', invitation_email_status: attempted ? 'accepted' : 'not_sent',
      invitation_email_attempted_at: attempted ? '2026-10-20T12:00:00Z' : null }, expires_at: '2030-01-01T12:00:00Z' };
    window.fixture.show = (nextMode = mode) => window.fixture.dialog.show(window.fixture.invitation,
      document.getElementById('opener'), { mode: nextMode, isCurrent: () => window.fixture.current });
    window.fixture.show();
  }, { token, mode, attempted, language });
  return { page, requests, release, send: page.locator('#sendWorkerInvitationEmailButton'),
    status: page.locator('#workerInvitationEmailStatus'),
    async close() { release(); await context.close(); assert.deepEqual(errors, []); }
  };
}

try {
  {
    const f = await fixture({ pending: true });
    assert.equal(f.requests.length, 0, 'Opening never sends');
    assert.equal(await f.send.isEnabled(), true);
    await f.send.click();
    await f.page.waitForFunction(() => document.getElementById('sendWorkerInvitationEmailButton').disabled);
    await f.send.evaluate((button) => button.click());
    f.release();
    await f.status.filter({ hasText: 'Delivery is not confirmed.' }).waitFor();
    assert.equal(f.requests.length, 1, 'Double-click makes one request');
    assert.equal(await f.send.isDisabled(), true);
    await f.page.locator('#copyWorkerInvitationButton').click();
    assert.deepEqual(await f.page.evaluate(() => window.fixture.copied), [`${origin}/setup-password.html#token=${token}`]);
    assert.equal(await f.page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].some((value) => value.includes(window.fixture.invitation.token))), false);
    await f.close(); checks += 1;
  }
  for (const outcome of ['failed', 'unknown', 'network', 'mismatch', 'rejected', 'unavailable']) {
    const f = await fixture({ outcome });
    await f.send.click();
    const expected = { failed: 'Email was not sent.', unknown: 'Do not send again.', network: 'Do not send again.',
      mismatch: 'Do not send again.', rejected: 'Refresh Staff', unavailable: 'email is unavailable.' }[outcome];
    await f.status.filter({ hasText: expected }).waitFor();
    assert.equal(await f.send.isDisabled(), outcome !== 'unavailable');
    assert.equal(await f.page.locator('#copyWorkerInvitationButton').isEnabled(), true);
    assert.equal(f.requests.length, 1);
    await f.close(); checks += 1;
  }
  for (const mode of ['recovery', 'invitation']) {
    const f = await fixture({ mode, attempted: true });
    assert.equal(mode === 'recovery' ? await f.send.isHidden() : await f.send.isDisabled(), true);
    assert.equal(f.requests.length, 0);
    await f.close(); checks += 1;
  }
  {
    const f = await fixture({ pending: true });
    await f.send.click();
    await f.page.locator('#closeWorkerInvitationButton').click();
    await f.page.evaluate(() => { window.fixture.invitation.user.invitation_id = 8; window.fixture.show(); });
    assert.equal(await f.send.isDisabled(), true, 'Reopening cannot start another request while the previous send is pending');
    f.release();
    await f.page.waitForFunction(() => !document.getElementById('sendWorkerInvitationEmailButton').disabled);
    assert.equal(await f.status.textContent(), 'No email has been sent.', 'Late result cannot overwrite the new invitation');
    assert.equal(f.requests.length, 1);
    await f.close(); checks += 1;
  }
  {
    const f = await fixture({ pending: true });
    await f.send.click();
    await f.page.evaluate(() => { window.fixture.current = false; });
    f.release();
    await f.page.locator('#workerInvitationDialog').waitFor({ state: 'hidden' });
    assert.equal(await f.page.locator('#workerInvitationLink').inputValue(), '');
    assert.equal(f.requests.length, 1);
    await f.close(); checks += 1;
  }
  {
    const f = await fixture({ language: 'zh' });
    await f.send.click();
    await f.page.waitForFunction(() => document.getElementById('workerInvitationEmailStatus').textContent.includes('邮件服务器'));
    assert.equal(await f.send.isDisabled(), true);
    await f.close(); checks += 1;
  }
  console.log(`Invitation email browser checks passed: ${checks}; all requests intercepted, no real email.`);
} finally {
  await browser.close();
}
