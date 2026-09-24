import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59984';
const privateToken = 'SharingOnlyFixtureToken_1234567890';
const privateLink = `${origin}/setup-password.html#token=${privateToken}`;
const html = `<!doctype html><html lang="en"><title>Invitation sharing test</title>
  <button id="opener">Open invitation</button>
  <dialog id="workerInvitationDialog" aria-labelledby="title">
    <h1 id="title">Worker invitation ready</h1>
    <p id="workerInvitationIdentity"></p><p id="workerInvitationExpiry"></p>
    <label>Private setup link<input id="workerInvitationLink" readonly></label>
    <p id="workerInvitationStatus" role="status"></p>
    <button id="shareWorkerInvitationButton" hidden>Share invitation</button>
    <button id="copyWorkerInvitationButton">Copy private link</button>
    <button id="closeWorkerInvitationButton">Done</button>
  </dialog></html>`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await context.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, origin, 'External requests are forbidden');
  if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
  assert.match(url.pathname, /^\/assets\/js\/(worker-invitation-dialog|i18n|utils)\.js$/,
    'Only local modules may load: sharing must not send network requests');
  return route.fulfill({ contentType: 'text/javascript', body: await readFile(path.join(root, url.pathname), 'utf8') });
});
const page = await context.newPage();
const status = page.locator('#workerInvitationStatus');
const share = page.locator('#shareWorkerInvitationButton');
const copy = page.locator('#copyWorkerInvitationButton');

async function prepare({ mode = 'success', clipboard = 'success' } = {}) {
  await page.goto(origin);
  await page.evaluate(async ({ mode, clipboard, privateToken }) => {
    window.fixture = { shareCalls: [], copied: [] };
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: mode === 'unsupported' ? undefined : (data) => {
        window.fixture.shareCalls.push({ data, userGesture: navigator.userActivation.isActive });
        if (mode === 'cancel') return Promise.reject(new DOMException('User cancelled', 'AbortError'));
        if (mode === 'reject') return Promise.reject(new DOMException('Target unavailable', 'NotAllowedError'));
        if (mode === 'throw') throw new TypeError('Unavailable');
        if (mode === 'pending') return new Promise((resolve, reject) => {
          window.fixture.finishShare = resolve;
          window.fixture.rejectShare = reject;
        });
        return Promise.resolve();
      }
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: clipboard === 'unsupported' ? undefined : {
        writeText: async (value) => {
          if (clipboard === 'reject') throw new DOMException('Denied', 'NotAllowedError');
          window.fixture.copied.push(value);
        }
      }
    });
    const ids = [
      'workerInvitationDialog', 'workerInvitationLink', 'workerInvitationIdentity',
      'workerInvitationExpiry', 'workerInvitationStatus', 'copyWorkerInvitationButton',
      'shareWorkerInvitationButton', 'closeWorkerInvitationButton'
    ];
    const els = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
    window.fixture.els = els;
    window.fixture.dialog = (await import('/assets/js/worker-invitation-dialog.js')).createWorkerInvitationDialog(els);
    window.fixture.invitation = {
      token: privateToken, user: { name: 'Invited Worker', email: 'worker@example.com' },
      expires_at: '2026-10-01T12:00:00Z'
    };
    window.fixture.dialog.show(window.fixture.invitation, document.getElementById('opener'));
  }, { mode, clipboard, privateToken });
  assert.equal(await status.textContent(), '');
  assert.deepEqual(await page.evaluate(() => window.fixture.shareCalls), [], 'Opening an invitation never shares it');
}

async function waitForStatus(message) {
  await page.waitForFunction((expected) => document.getElementById('workerInvitationStatus').textContent === expected, message);
}

try {
  await prepare();
  assert.equal(await share.isVisible(), true);
  assert.equal(await copy.evaluate((button) => button.classList.contains('secondary')), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'shareWorkerInvitationButton');
  await share.click();
  await waitForStatus('Sharing finished. Confirm the intended Worker received the link.');
  assert.deepEqual(await page.evaluate(() => window.fixture.shareCalls), [{
    data: {
      title: 'ReportFlow invitation',
      text: 'Private setup link for Invited Worker (worker@example.com). Open it to choose your password.',
      url: privateLink
    }, userGesture: true
  }]);
  assert.equal(await share.isEnabled(), true);
  assert.equal(await page.locator('#workerInvitationLink').inputValue(), privateLink);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0,
    'Private link is never persisted');
  console.log('ok - Share is user-triggered, carries the intended identity, and does not claim delivery');

  await prepare({ mode: 'cancel' });
  await share.click();
  await waitForStatus('Sharing cancelled.');
  assert.equal(await share.isEnabled(), true);
  assert.equal(await page.locator('#workerInvitationLink').inputValue(), privateLink);
  await copy.click();
  await waitForStatus('Link copied. Share it privately with this Worker.');
  assert.deepEqual(await page.evaluate(() => window.fixture.copied), [privateLink]);
  console.log('ok - cancelling Share is not success and Copy remains available');

  for (const mode of ['reject', 'throw']) {
    await prepare({ mode });
    await share.click();
    await waitForStatus('Sharing is unavailable. Copy the link and send it privately.');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'copyWorkerInvitationButton');
    assert.equal(await share.isEnabled(), true);
    await copy.click();
    await waitForStatus('Link copied. Share it privately with this Worker.');
    assert.deepEqual(await page.evaluate(() => window.fixture.copied), [privateLink]);
  }
  console.log('ok - rejected/throwing Share points to the working private Copy fallback');

  await prepare({ mode: 'unsupported' });
  assert.equal(await share.isVisible(), false);
  assert.equal(await copy.evaluate((button) => button.classList.contains('secondary')), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'copyWorkerInvitationButton');
  await copy.click();
  await waitForStatus('Link copied. Share it privately with this Worker.');
  assert.deepEqual(await page.evaluate(() => window.fixture.copied), [privateLink]);
  assert.deepEqual(await page.evaluate(() => window.fixture.shareCalls), []);
  console.log('ok - unsupported browsers keep Share hidden and still support Copy');

  await prepare({ mode: 'pending' });
  await share.click();
  assert.equal(await share.isDisabled(), true);
  await page.evaluate(() => {
    window.fixture.els.shareWorkerInvitationButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  assert.equal(await page.evaluate(() => window.fixture.shareCalls.length), 1);
  await page.evaluate(() => window.fixture.finishShare());
  await waitForStatus('Sharing finished. Confirm the intended Worker received the link.');
  assert.equal(await share.isEnabled(), true);
  console.log('ok - duplicate Share clicks are single-flight');

  for (const completion of ['resolve', 'reject']) {
    await prepare({ mode: 'pending' });
    await share.click();
    await page.evaluate(() => window.fixture.dialog.clear());
    assert.equal(await page.locator('#workerInvitationLink').inputValue(), '');
    assert.equal(await page.locator('#workerInvitationIdentity').textContent(), '');
    await page.evaluate(() => {
      window.fixture.dialog.show({
        ...window.fixture.invitation, token: 'ReplacementPrivateFixtureToken_123456',
        user: { name: 'Replacement Worker', email: 'replacement@example.com' }
      }, document.getElementById('opener'));
      window.fixture.els.shareWorkerInvitationButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    assert.equal(await share.isDisabled(), true, 'Outstanding native chooser stays single-flight across replacement');
    assert.equal(await page.evaluate(() => window.fixture.shareCalls.length), 1);
    await page.evaluate((completion) => {
      if (completion === 'resolve') window.fixture.finishShare();
      else window.fixture.rejectShare(new DOMException('Old target failed', 'NotAllowedError'));
    }, completion);
    await page.waitForFunction(() => !window.fixture.els.shareWorkerInvitationButton.disabled);
    assert.equal(await status.textContent(), '', 'Old result does not appear on the replacement invitation');
    assert.equal(await page.locator('#workerInvitationIdentity').textContent(), 'Replacement Worker — replacement@example.com');
    assert.match(await page.locator('#workerInvitationLink').inputValue(), /ReplacementPrivateFixtureToken_123456$/);
  }
  console.log('ok - late Share success/failure cannot restore secrets or update a replacement invitation');

  await prepare({ mode: 'pending' });
  await share.click();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await page.evaluate(() => window.fixture.finishShare());
  await page.waitForFunction(() => !window.fixture.els.shareWorkerInvitationButton.disabled);
  assert.equal(await page.locator('#workerInvitationDialog').isVisible(), false);
  assert.equal(await page.locator('#workerInvitationLink').inputValue(), '');
  assert.equal(await page.locator('#workerInvitationIdentity').textContent(), '');
  assert.equal(await status.textContent(), '');
  console.log('ok - pagehide clears the secret and ignores a late native Share result');

  for (const clipboard of ['reject', 'unsupported']) {
    await prepare({ mode: 'unsupported', clipboard });
    await copy.click();
    await waitForStatus('Copy is unavailable. Select and copy the link above.');
    assert.deepEqual(await page.evaluate(() => {
      const input = window.fixture.els.workerInvitationLink;
      return { focused: document.activeElement === input, selected: input.value.slice(input.selectionStart, input.selectionEnd) };
    }), { focused: true, selected: privateLink });
    await page.locator('#closeWorkerInvitationButton').click();
    assert.equal(await page.locator('#workerInvitationLink').inputValue(), '');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'opener');
  }
  console.log('ok - clipboard fallback selects the private link; Done clears it and restores focus');
} finally {
  await context.close();
  await browser.close();
}
