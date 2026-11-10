import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { reportEmailOptions, reportEmailSelection, reportEmailSelectionStale } from '../assets/js/report-email-recipients.js';

const root = path.resolve('.');
const origin = 'http://127.0.0.1:59991';
const output = path.join(root, 'output/report-department-recipients.local');
const users = Array.from({ length: 27 }, (_, index) => ({ user_id: index + 100,
  name: `Department colleague ${index}`, email: `colleague${String(index).padStart(2, '0')}@example.invalid` }));
const options = { source: 'department_users', enabled: false, version: 3, max_selected_recipients: 20,
  recipient_users: users, recipients: users.map((user) => user.email), default_recipients: [], default_recipient_unavailable: false };
const saved = { pdfEmailRecipients: [users[1].email], pdfEmailRecipientUsers: [{ user_id: users[1].user_id, email: users[1].email }], expectedPdfEmailVersion: 3 };
let checks = 0;
assert.deepEqual(reportEmailOptions({ pdf_email_options: options }), options);
assert.deepEqual(reportEmailSelection(options, saved), saved);
assert.equal(reportEmailSelectionStale(options, saved), false, 'Disabled default does not disable choices');
const changed = (recipient_users) => ({ ...options, recipient_users, recipients: recipient_users.map((user) => user.email) });
for (const current of [
  changed(users.filter((user) => user.user_id !== users[1].user_id)),
  changed(users.map((user) => user.user_id === users[1].user_id ? { ...user, email: 'changed@example.invalid' } : user)),
  changed(users.map((user) => user.user_id === users[1].user_id ? { ...user, user_id: 900 } : user)),
  { ...options, version: 4 }
]) assert.equal(reportEmailSelectionStale(current, saved), true, 'Removed/moved/resigned, changed email, reassigned address, and changed settings all require review');
assert.equal(reportEmailSelectionStale(options, { ...saved, pdfEmailRecipientUsers: undefined }), true, 'Old email-only selections cannot silently bind to new accounts');
assert.equal(reportEmailSelectionStale(options, { pdfEmailRecipients: [], expectedPdfEmailVersion: 1 }), false);
assert.equal(reportEmailSelectionStale(null, { pdfEmailRecipients: [] }), true, 'Old backend cannot guarantee self-only');
assert.equal(reportEmailSelectionStale(null, {}), false, 'Old unselected forms keep prior flow');
assert.equal(reportEmailOptions({ pdf_email_options: { ...options, recipient_users: [] } }), null, 'Incomplete directory fails closed');
checks += 12;

const browser = await chromium.launch({ headless: true });
await mkdir(output, { recursive: true });
async function fixture(initial = options, restored = null) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const errors = [];
  context.setDefaultTimeout(5000);
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, origin, 'No external requests');
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/assets/css/styles.css"><body><main style="max-width:740px;margin:auto;padding:12px"><form id="report"><button id="submitWorkFormButton" type="button">Review Report</button></form><button id="language">Chinese</button></main>' });
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    assert.match(url.pathname, /^\/assets\/(?:js\/[a-z\d-]+\.js|css\/styles\.css)$/);
    return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(path.join(root, url.pathname), 'utf8') });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  await page.evaluate(async ({ initial, restored }) => {
    const { mountReportEmailRecipients } = await import('/assets/js/report-email-recipients.js');
    const { initLanguageToggle } = await import('/assets/js/i18n.js');
    const { saveDraft, getDraft } = await import('/assets/js/mock-api.js');
    window.changed = 0;
    window.test = { picker: mountReportEmailRecipients(document.querySelector('#report'), { pdf_email_options: initial }, 'author@example.invalid', restored, () => { window.changed += 1; }), saveDraft, getDraft };
    initLanguageToggle({ button: document.querySelector('#language') });
  }, { initial, restored });
  return { page, inputs: page.locator('[data-report-email-recipients] input'),
    async close() { assert.deepEqual(errors, []); await context.close(); } };
}
try {
  const f = await fixture();
  assert.equal(await f.inputs.count(), 27, 'Directory must not truncate to the selected-copy cap');
  assert.equal(await f.inputs.filter({ has: f.page.locator(':checked') }).count(), 0);
  assert.match(await f.page.locator('fieldset').innerText(), /up to 20.*full Department list/);
  await f.inputs.nth(26).check();
  assert.deepEqual(await f.page.evaluate(() => window.test.picker.capture().pdfEmailRecipientUsers), [{ user_id: 126, email: users[26].email }]);
  await f.inputs.nth(26).uncheck();
  for (let index = 0; index < 20; index += 1) await f.inputs.nth(index).check();
  assert.equal(await f.inputs.nth(20).isDisabled(), true, 'Cap is explicit and enforced, all choices stay visible');
  assert.equal(await f.inputs.nth(19).isDisabled(), false, 'Selected choices can still be removed');
  await f.inputs.nth(0).uncheck();
  assert.equal(await f.inputs.nth(26).isDisabled(), false);
  await f.inputs.nth(26).check();
  await f.page.evaluate(async () => {
    await window.test.saveDraft('department-recipient-test', { kind: 'work-form', templatePurpose: 'report', ...window.test.picker.capture() });
    const saved = await window.test.getDraft('department-recipient-test');
    window.test.picker.restore(saved);
  });
  assert.equal(await f.inputs.nth(26).isChecked(), true);
  assert.equal(await f.inputs.nth(0).isChecked(), false);
  assert.equal((await f.page.evaluate(() => window.test.picker.capture())).pdfEmailRecipientUsers.length, 20);
  await f.page.screenshot({ path: path.join(output, 'full-directory-phone.png'), fullPage: true });
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await f.page.setViewportSize({ width: 1280, height: 900 });
  await f.page.screenshot({ path: path.join(output, 'full-directory-desktop.png'), fullPage: true });
  await f.page.locator('#language').click();
  await f.page.waitForFunction(() => document.documentElement.lang === 'zh-Hans');
  assert.match(await f.page.locator('fieldset').innerText(), /20.*完整部门名单/);
  await f.page.screenshot({ path: path.join(output, 'full-directory-chinese-desktop.png'), fullPage: true });
  await f.close(); checks += 14;

  for (const mutation of ['removed', 'email_changed', 'email_reassigned', 'version_changed']) {
    const f = await fixture(options, saved);
    let current = options;
    if (mutation === 'removed') current = changed(users.filter((user) => user.user_id !== 101));
    if (mutation === 'email_changed') current = changed(users.map((user) => user.user_id === 101 ? { ...user, email: 'new@example.invalid' } : user));
    if (mutation === 'email_reassigned') current = changed(users.map((user) => user.user_id === 101 ? { ...user, user_id: 901 } : user));
    if (mutation === 'version_changed') current = { ...options, version: 4 };
    await f.page.evaluate((current) => window.test.picker.refresh({ pdf_email_options: current }), current);
    assert.equal(await f.page.evaluate(() => window.test.picker.valid()), false);
    assert.deepEqual(await f.page.evaluate(() => window.test.picker.capture()), saved, 'Refresh never modifies intent');
    assert.match(await f.page.locator('fieldset').innerText(), /colleague01@example.invalid/);
    assert.equal(await f.inputs.count(), 0, 'No new choice while old selection needs review');
    await f.page.getByRole('button', { name: 'Review updated recipients' }).click();
    assert.equal(await f.page.evaluate(() => window.test.picker.valid()), true);
    const reviewed = await f.page.evaluate(() => window.test.picker.capture());
    assert.deepEqual(reviewed.pdfEmailRecipients, mutation === 'version_changed' ? saved.pdfEmailRecipients : []);
    assert.deepEqual(reviewed.pdfEmailRecipientUsers, mutation === 'version_changed' ? saved.pdfEmailRecipientUsers : []);
    await f.close(); checks += 7;
  }
  const unavailable = await fixture(null, saved);
  assert.equal(await unavailable.page.evaluate(() => window.test.picker.valid()), false);
  assert.equal(await unavailable.page.getByRole('button', { name: 'Review updated recipients' }).count(), 0);
  assert.deepEqual(await unavailable.page.evaluate(() => window.test.picker.capture()), saved);
  await unavailable.close(); checks += 3;
  const malformed = await fixture({ ...options, recipient_users: [] });
  assert.equal(await malformed.page.evaluate(() => window.test.picker.valid()), false);
  assert.match(await malformed.page.locator('fieldset').innerText(), /unavailable/);
  const blockedDraft = await malformed.page.evaluate(() => window.test.picker.capture());
  assert.equal(blockedDraft.pdfEmailOptionsUnavailable, true);
  await malformed.page.evaluate(() => window.test.picker.refresh({}));
  assert.equal(await malformed.page.evaluate(() => window.test.picker.valid()), false, 'Removing broken advertised options cannot downgrade an open editor');
  await malformed.close();
  const blockedReload = await fixture(null, blockedDraft);
  assert.equal(await blockedReload.page.evaluate(() => window.test.picker.valid()), false, 'Unavailable intent survives saving/reloading');
  await blockedReload.close(); checks += 5;
  console.log(`Department recipient checks passed: ${checks}; all requests intercepted.`);
} finally { await browser.close(); }
