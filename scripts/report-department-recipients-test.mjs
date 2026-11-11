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
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/assets/css/styles.css"><body><main style="max-width:740px;margin:auto;padding:12px"><form id="report"><button id="submitWorkFormButton" type="button">Review Report</button></form><button id="language">Chinese</button></main>' });
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
  return { page, inputs: page.locator('[data-report-email-recipients] input[type=checkbox]'),
    async close() { assert.deepEqual(errors, []); await context.close(); } };
}
try {
  const f = await fixture();
  assert.equal(await f.inputs.count(), 27, 'Directory must not truncate to the selected-copy cap');
  assert.equal(await f.inputs.filter({ has: f.page.locator(':checked') }).count(), 0);
  assert.match(await f.page.locator('fieldset').innerText(), /Selected: 0 \/ 20/);
  await f.page.locator('[data-recipient-toggle]').click();
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
  await f.page.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await f.page.locator('.report-email-selected li').count(), 3, 'Large selections keep a bounded summary');
  await f.page.getByRole('button', { name: 'View all selected people', exact: true }).click();
  assert.equal(await f.page.locator('.report-email-choice:visible').count(), 20);
  assert.equal(await f.page.getByRole('button', { name: 'Selected people', exact: true }).getAttribute('aria-pressed'), 'true');
  await f.page.getByRole('button', { name: 'All people', exact: true }).click();
  checks += 3;
  for (const width of [320, 390]) {
    for (const theme of ['light', 'dark']) {
      await f.page.setViewportSize({ width, height: 844 });
      await f.page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      const layout = await f.inputs.evaluateAll((inputs) => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        targets: inputs.map((input) => { const { width, height, left, right } = input.closest('label').getBoundingClientRect(); return { width, height, left, right }; }) }));
      assert.equal(layout.targets.length, 27, 'The entire directory remains reachable on small screens');
      assert.ok(layout.scrollWidth <= layout.viewport, `${width}/${theme}: no horizontal overflow`);
      for (const target of layout.targets) assert.ok(target.width >= 44 && target.height >= 44 && target.left >= 0 && target.right <= width,
        `${width}/${theme}: whole recipient row touch target must be at least 44px: ${JSON.stringify(target)}`);
      await f.page.screenshot({ path: path.join(output, `full-directory-${width}-${theme}.png`), fullPage: true, animations: 'disabled' });
      checks += 3;
    }
  }
  await f.page.screenshot({ path: path.join(output, 'full-directory-phone.png'), fullPage: true, animations: 'disabled' });
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await f.page.setViewportSize({ width: 1280, height: 900 });
  await f.page.screenshot({ path: path.join(output, 'full-directory-desktop.png'), fullPage: true, animations: 'disabled' });
  await f.page.locator('#language').click();
  await f.page.waitForFunction(() => document.documentElement.lang === 'zh-Hans');
  assert.match(await f.page.locator('fieldset').innerText(), /已选择： 20 \/ 20/);
  await f.page.screenshot({ path: path.join(output, 'full-directory-chinese-desktop.png'), fullPage: true, animations: 'disabled' });
  await f.close(); checks += 14;

  // Compact by default; keyboard and filtering never change recipient intent.
  const compact = await fixture();
  const picker = compact.page.locator('[data-report-email-recipients]');
  const toggle = picker.locator('[data-recipient-toggle]');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await picker.locator('.report-email-panel').isVisible(), false);
  assert.ok((await picker.boundingBox()).height < 340, 'Self-only summary remains compact');
  await compact.page.screenshot({ path: path.join(output, 'picker-collapsed-phone.png'), fullPage: true, animations: 'disabled' });
  await toggle.click();
  const search = compact.page.getByRole('searchbox', { name: 'Find a person' });
  await search.fill('COLLEAGUE26@');
  assert.equal(await compact.page.locator('.report-email-choice:visible').count(), 1);
  await compact.inputs.nth(26).check();
  await search.fill('Department colleague 1');
  assert.equal(await compact.page.locator('.report-email-choice:visible').count(), 11);
  await compact.inputs.nth(1).check();
  assert.deepEqual(await compact.page.evaluate(() => window.test.picker.capture().pdfEmailRecipients), [users[26].email, users[1].email]);
  await search.fill('no matching person');
  assert.equal(await compact.page.locator('.report-email-choice:visible').count(), 0);
  assert.match(await picker.innerText(), /No matching people/);
  await compact.page.evaluate(() => {
    window.submits = 0;
    document.querySelector('#report').addEventListener('submit', (event) => { event.preventDefault(); window.submits += 1; });
  });
  await search.press('Enter');
  assert.equal(await compact.page.evaluate(() => window.submits), 0, 'Searching never submits the outer Report');
  await search.fill('');
  await compact.page.getByRole('button', { name: 'Selected people', exact: true }).click();
  assert.equal(await compact.page.locator('.report-email-choice:visible').count(), 2);
  await compact.inputs.nth(1).focus(); await compact.page.keyboard.press('Space');
  assert.equal(await compact.inputs.nth(26).evaluate((input) => input === document.activeElement), true);
  await compact.page.keyboard.press('Space');
  assert.equal(await compact.page.getByRole('button', { name: 'Selected people', exact: true }).evaluate((button) => button === document.activeElement), true);
  assert.equal(await compact.page.locator('.report-email-choice:visible').count(), 0);
  await compact.page.getByRole('button', { name: 'All people', exact: true }).click();
  await compact.inputs.nth(26).check(); await compact.inputs.nth(1).check();
  await compact.page.getByRole('button', { name: 'Selected people', exact: true }).click();

  await compact.page.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await toggle.evaluate((button) => button === document.activeElement), true);
  assert.equal(await compact.page.locator('.report-email-selected li').count(), 2);
  await compact.page.screenshot({ path: path.join(output, 'picker-selected-phone.png'), fullPage: true, animations: 'disabled' });
  await toggle.press('Enter');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  await compact.page.getByRole('button', { name: 'All people', exact: true }).click();
  assert.equal(await compact.page.locator('.report-email-choice:visible').count(), 27);
  await search.focus(); await search.press('Escape');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(await compact.page.evaluate(() => window.test.picker.capture().pdfEmailRecipients), [users[26].email, users[1].email]);
  await compact.page.getByRole('button', { name: 'Remove Department colleague 26 colleague26@example.invalid', exact: true }).click();
  assert.deepEqual(await compact.page.evaluate(() => window.test.picker.capture().pdfEmailRecipients), [users[1].email]);
  await toggle.click();
  await compact.page.getByRole('button', { name: 'Clear additional recipients', exact: true }).click();
  assert.deepEqual(await compact.page.evaluate(() => window.test.picker.capture().pdfEmailRecipientUsers), []);
  assert.equal(await compact.page.getByRole('button', { name: 'Done', exact: true }).evaluate((button) => button === document.activeElement), true);
  // The row, not a gigantic checkbox, is the whole touch target.
  const bounds = await compact.inputs.nth(0).evaluate((input) => ({ box: input.getBoundingClientRect().width, row: input.closest('label').getBoundingClientRect().height }));
  assert.equal(bounds.box, 22); assert.ok(bounds.row >= 44);
  await compact.page.locator('.report-email-choice').nth(0).locator('.report-email-person').click();
  assert.equal(await compact.inputs.nth(0).isChecked(), true);
  await compact.page.keyboard.press('Space');
  assert.equal(await compact.inputs.nth(0).isChecked(), false, 'Native keyboard checkbox behavior is preserved');
  await compact.close(); checks += 31;

  // Names are literal, long addresses wrap, and an eligible default is visible while closed.
  const longUser = { user_id: 900, name: '<img src=x onerror=alert(1)> A very long colleague name',
    email: 'averylongemailaddress.with.many.parts.for.layout@example.invalid' };
  const longOptions = { ...options, enabled: true, recipient_users: [longUser], recipients: [longUser.email], default_recipients: [longUser.email] };
  const long = await fixture(longOptions);
  assert.equal(await long.page.locator('.report-email-selected li').count(), 1);
  assert.equal(await long.page.locator('.report-email-selected img').count(), 0);
  assert.match(await long.page.locator('.report-email-selected').innerText(), /<img/);
  for (const width of [320, 390, 768, 1280]) {
    for (const theme of ['light', 'dark']) {
      await long.page.setViewportSize({ width, height: 900 });
      await long.page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      assert.equal(await long.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await long.page.locator('[data-recipient-toggle]').click();
      assert.equal(await long.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await long.page.screenshot({ path: path.join(output, 'picker-long-' + width + '-' + theme + '.png'), fullPage: true, animations: 'disabled' });
      await long.page.getByRole('button', { name: 'Done', exact: true }).click();
    }
  }
  await long.close(); checks += 19;
  const none = await fixture({ ...options, recipients: [], recipient_users: [] });
  assert.match(await none.page.locator('fieldset').innerText(), /No eligible additional recipients/);
  assert.equal(await none.page.locator('[data-recipient-toggle]').isVisible(), false);
  assert.equal(await none.page.evaluate(() => window.test.picker.valid()), true);
  await none.close(); checks += 3;

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
