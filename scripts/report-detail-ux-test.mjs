import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Real rendering, language and CSS; only callbacks and transport are fixtures.
// No hosted requests, real users, database or cloud mutations are permitted.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59961';
const output = path.join(root, 'output', 'report-detail-ux.local');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB8kAAAAASUVORK5CYII=';
const markup = `<!doctype html><html lang="en-NZ" data-theme="light"><head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/assets/css/styles.css">
  <style>main{width:100%;max-width:1100px;margin:0 auto;padding:12px;box-sizing:border-box}</style>
  </head><body class="report-only-mode"><main>
  <section id="workerView"><h1>My Reports</h1><div id="historyList" class="records-list"></div></section>
  <section id="supervisorView" hidden><h1>Reports</h1><div id="detailList" class="records-list"></div></section>
  <div hidden><button id="languageToggle" data-language-toggle>中文</button><div id="workerSummary"></div>
    <input id="historySearchInput"><select id="historyTypeFilter"><option value="form">Form</option></select>
    <select id="historyStatusFilter"><option value=""></option></select><input id="historyDateFilter" type="date">
    <span id="historyResultCount"></span><button id="refreshHistoryButton">Refresh</button>
    <button id="clearHistoryFiltersButton">Clear filters</button></div>
  <template id="recordTemplate"><article class="record-card"><div class="record-header"><div>
    <h3 class="record-title"></h3><p class="record-meta"></p></div><span class="badge"></span></div>
    <p class="record-detail"></p><div class="record-extra"></div><div class="record-actions hidden"></div>
  </article></template></main></body></html>`;

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
context.setDefaultTimeout(7000);
const errors = [];
let imageRequests = 0;
await context.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, origin, 'The detail UX regression cannot access external services');
  if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: markup });
  if (url.pathname.startsWith('/uploads/')) {
    imageRequests += 1;
    const number = Number(url.pathname.match(/photo-(\d+)/)?.[1] || 1);
    const colors = ['#166f92', '#9c5227', '#4d7764', '#805c8f', '#41629a', '#9e7140'];
    return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600">
      <rect width="900" height="600" fill="${colors[(number - 1) % colors.length]}"/>
      <path d="M0 440 L180 280 L320 390 L500 190 L900 460 V600 H0Z" fill="white" opacity=".24"/>
      <text x="450" y="340" fill="white" text-anchor="middle" font-family="sans-serif" font-size="150">${number}</text>
      <text x="450" y="435" fill="white" text-anchor="middle" font-family="sans-serif" font-size="36">LOCAL PHOTO FIXTURE</text></svg>` });
  }
  assert.match(url.pathname, /^\/assets\/(?:js\/[a-z\d-]+\.js|css\/styles\.css)$/);
  return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
    body: await readFile(path.join(root, url.pathname), 'utf8') });
});
const page = await context.newPage();
page.on('pageerror', (error) => errors.push(error.message));
const history = page.locator('#historyList');
const details = page.locator('#detailList');

async function render(options = {}) {
  await page.evaluate((value) => window.fixture.render(value), options);
  return options.surface === 'supervisor' ? details : history;
}

async function assertNoOverflow(label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(overflow <= 1, `${label}: unexpected horizontal overflow (${overflow}px)`);
}

async function assertTouchTarget(locator, label) {
  const bounds = await locator.boundingBox();
  assert.ok(bounds && bounds.width >= 44 && bounds.height >= 44, `${label}: at least 44px touch target required`);
}

try {
  await page.goto(origin);
  await page.evaluate(async (image) => {
    const { createHistoryModule } = await import('/assets/js/history.js');
    const { setLanguage, initLanguageToggle } = await import('/assets/js/i18n.js');
    const els = Object.fromEntries([...document.querySelectorAll('[id]')].map((node) => [node.id, node]));
    initLanguageToggle({ button: els.languageToggle });
    const worker = { id: 12, departmentId: 3, role: 'worker' };
    const supervisor = { id: 13, departmentId: 3, role: 'supervisor' };
    const state = { user: worker, sites: [], historyRecords: [] };
    const calls = [], opens = [], created = [], revoked = [];
    let sources = [];
    const photoViewer = {
      open(nextSources, index, title, options) {
        sources = nextSources;
        opens.push({ sources: [...nextSources], index, title, options });
      },
      closeForSources(owned) {
        if (!owned.some((source) => sources.includes(source))) return false;
        sources = [];
        return true;
      }
    };
    const originalCreate = URL.createObjectURL.bind(URL);
    const originalRevoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { const url = originalCreate(blob); created.push(url); return url; };
    URL.revokeObjectURL = (url) => { revoked.push(url); originalRevoke(url); };
    const blobs = Array.from({ length: 7 }, () => new Blob([
      Uint8Array.from(atob(image), (character) => character.charCodeAt(0))
    ], { type: 'image/png' }));
    const recordCall = (action, record, button) => calls.push({ action, id: record.id,
      key: record.clientSubmissionId, captured: record.capturedAnswers?.answer,
      samePhotoArray: record.photoBlobs === window.fixture.current.photoBlobs,
      connectedButton: button?.isConnected ?? null });
    const invokeAction = (action, record, button) => {
      recordCall(action, record, button);
      if (window.fixture.holdAction !== action) return;
      return new Promise((resolve, reject) => { window.fixture.heldAction = { resolve, reject }; })
        // Existing app callbacks own failure feedback; the renderer owns action locking.
        .catch((error) => window.fixture.handledActionErrors.push(error.message));
    };
    const module = createHistoryModule({ els, state, reportOnly: true, photoViewer,
      canWorkerEditRecord: () => false,
      handleRetryQueuedRecord: (record, button) => invokeAction('retry', record, button),
      handleRecoverQueuedReport: (record, button) => invokeAction('recover', record, button),
      handleDiscardQueuedRecord: (record, button) => invokeAction('discard', record, button),
      handleSupervisorExportRecord: (record, format) => calls.push({ action: format, id: record.id })
    });
    // Native PNG fixture keeps handwritten-signature presence visually reviewable.
    const signature = document.createElement('canvas');
    signature.width = 600;
    signature.height = 160;
    const ink = signature.getContext('2d');
    ink.strokeStyle = '#24364d';
    ink.lineWidth = 5;
    ink.lineCap = 'round';
    ink.beginPath();
    ink.moveTo(70, 118);
    ink.bezierCurveTo(125, 5, 160, 30, 128, 108);
    ink.bezierCurveTo(100, 162, 70, 102, 218, 76);
    ink.bezierCurveTo(179, 172, 247, 30, 270, 104);
    ink.bezierCurveTo(285, 127, 332, 45, 335, 100);
    ink.bezierCurveTo(360, 138, 390, 61, 425, 88);
    ink.moveTo(93, 133);
    ink.lineTo(475, 120);
    ink.stroke();
    const base = { id: 'form-20', backendRecordId: 20, type: 'form', userId: 12, departmentId: 3,
      userName: 'Test Worker', formName: 'Site inspection <safe>', submissionPurpose: 'report',
      siteId: 4, siteName: 'Harbour site', workDate: '2026-10-07', createdAt: '2026-10-06T22:00:00Z',
      syncStatus: 'synced', workflowStatus: 'resolved', supervisorNote: 'Pass <script>unsafe()</script>',
      reviewingSupervisorName: 'Review supervisor', reviewStartedAt: '2026-10-06T22:10:00Z', resolvedAt: '2026-10-06T22:30:00Z',
      fields: [{ id: 'answer', label: 'Observation', type: 'text' }, { id: 'sign', label: 'Worker signature', type: 'signature' }],
      answers: { answer: 'The access route is clear.', sign: signature.toDataURL('image/png') },
      photoUrls: Array.from({ length: 7 }, (_, index) => `/uploads/photo-${index + 1}.png`) };
    const fixture = { module, state, worker, supervisor, base, blobs, calls, opens, created, revoked,
      language: 'en', holdAction: '', heldAction: null, handledActionErrors: [] };
    fixture.render = ({ surface = 'worker', mode = 'resolved', purpose = 'report', override = {} } = {}) => {
      module.resetSession();
      state.user = surface === 'worker' ? worker : supervisor;
      state.departmentFocusId = null;
      els.workerView.hidden = surface !== 'worker';
      els.supervisorView.hidden = surface !== 'supervisor';
      els.workerView.classList.toggle('active', surface === 'worker');
      els.supervisorView.classList.toggle('active', surface === 'supervisor');
      document.body.classList.toggle('session-supervisor', surface === 'supervisor');
      const record = { ...base, submissionPurpose: purpose };
      if (mode !== 'resolved') Object.assign(record, { id: 'local-report', backendRecordId: null,
        clientSubmissionId: 'immutable-original-key', syncStatus: 'queued', workflowStatus: 'submitted',
        supervisorNote: '', reviewingSupervisorName: '', reviewStartedAt: null, resolvedAt: null,
        photoBlobs: blobs, photoUrls: ['/uploads/already-uploaded.png'],
        capturedAnswers: { ...base.answers, answer: 'Original captured answer' },
        answers: { answer: 'Normalized answer must not replace captured evidence' } });
      if (mode === 'failed') Object.assign(record, { syncError: 'This image could not be decoded. Replace the damaged photo.', retryCount: 1 });
      if (mode === 'syncing') record.syncStatus = 'syncing';
      if (mode === 'saved-copy') Object.assign(record, { isDraftRecovery: true, syncError: 'Saved recovery evidence.' });
      Object.assign(record, override);
      fixture.current = record;
      if (surface === 'worker') {
        state.historyRecords = [record];
        module.renderFilteredHistory();
      } else module.renderRecordsList(els.detailList, [record], { showExportActions: true });
      setLanguage(fixture.language);
    };
    window.fixture = fixture;
    module.bindEvents();
    fixture.render({ mode: 'failed' });
  }, png);

  const disclosure = history.locator('.record-disclosure-button');
  const recoveryActions = history.locator('.record-report-recovery-actions');
  assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
  assert.equal(await history.locator('img').count(), 0);
  assert.equal(imageRequests, 0);
  assert.equal(await page.evaluate(() => window.fixture.created.length), 0);
  assert.equal(await recoveryActions.getByRole('button', { name: 'Retry sync', exact: true }).isVisible(), true);
  assert.equal(await recoveryActions.getByRole('button', { name: 'Recover as draft', exact: true }).isVisible(), true);
  assert.equal(await history.getByRole('button', { name: 'Discard local copy', exact: true }).count(), 0);
  assert.equal(await recoveryActions.evaluate((node) => {
    const card = node.closest('.record-report-compact');
    const warning = card.querySelector('.record-report-cue');
    const detail = card.querySelector('.record-report-details');
    return Boolean(warning.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
      && Boolean(node.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING);
  }), true);
  console.log('ok - failed collapsed Report places Retry/Recover after warning and before evidence, without allocating photos or exposing Discard');

  await recoveryActions.getByRole('button', { name: 'Retry sync', exact: true }).click();
  await recoveryActions.getByRole('button', { name: 'Recover as draft', exact: true }).click();
  const callEvidence = await page.evaluate(() => window.fixture.calls);
  assert.deepEqual(callEvidence.map((call) => call.action), ['retry', 'recover']);
  for (const call of callEvidence) {
    assert.equal(call.id, 'local-report');
    assert.equal(call.key, 'immutable-original-key');
    assert.equal(call.captured, 'Original captured answer');
    assert.equal(call.samePhotoArray, true);
  }
  assert.equal(callEvidence[1].connectedButton, true);
  assert.equal(await history.locator('img').count(), 0);
  console.log('ok - promoted actions delegate original key, captured answers and untouched Blob evidence to existing callbacks');

  for (const [action, label, failure] of [['retry', 'Retry sync', false], ['recover', 'Recover as draft', true]]) {
    await page.evaluate((name) => { window.fixture.holdAction = name; window.fixture.heldAction = null; }, action);
    const before = await page.evaluate(() => window.fixture.calls.length);
    await recoveryActions.getByRole('button', { name: label, exact: true }).click();
    assert.equal(await recoveryActions.getAttribute('aria-busy'), 'true');
    assert.equal(await recoveryActions.locator('button:disabled').count(), 2);
    await page.evaluate(() => {
      document.querySelectorAll('.record-report-recovery-actions button').forEach((button) => {
        button.click();
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    });
    assert.equal(await page.evaluate(() => window.fixture.calls.length), before + 1, 'Both actions remain single-flight');
    await page.evaluate((shouldFail) => {
      window.fixture.holdAction = '';
      if (shouldFail) window.fixture.heldAction.reject(new Error('Handled fixture recovery failure'));
      else window.fixture.heldAction.resolve();
    }, failure);
    await page.waitForFunction(() => !document.querySelector('.record-report-recovery-actions').hasAttribute('aria-busy'));
    assert.equal(await recoveryActions.locator('button:disabled').count(), 0);
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
  }
  assert.deepEqual(await page.evaluate(() => window.fixture.handledActionErrors), ['Handled fixture recovery failure']);
  console.log('ok - deferred Retry/Recover lock both actions and restore them after completion or handled failure without a redraw');

  await disclosure.click();
  assert.equal(await history.getByRole('button', { name: 'Retry sync', exact: true }).count(), 1);
  assert.equal(await history.getByRole('button', { name: 'Recover as draft', exact: true }).count(), 1);
  assert.match(await history.locator('.record-report-details').textContent(), /Original captured answer/);
  assert.equal(await history.locator('.record-photos img').count(), 6);
  assert.equal(await history.locator('.record-signatures img').count(), 1);
  const discard = history.getByRole('button', { name: 'Discard local copy', exact: true });
  assert.match(await discard.getAttribute('class'), /secondary/);
  assert.match(await discard.getAttribute('class'), /danger-action/);
  assert.equal(await discard.evaluate((button) => Boolean(
    button.closest('.record-report-details').querySelector('.record-photos').compareDocumentPosition(button)
      & Node.DOCUMENT_POSITION_FOLLOWING
  )), true);
  await discard.click();
  assert.equal(await page.evaluate(() => window.fixture.calls.at(-1).action), 'discard');
  assert.equal(await page.evaluate(() => window.fixture.calls.at(-1).connectedButton), true);
  await history.locator('.report-photo-gallery-open').click();
  assert.equal(await page.evaluate(() => window.fixture.opens.at(-1).sources.length), 7);
  assert.equal(await page.evaluate(() => window.fixture.opens.at(-1).options.reportGallery), true);
  await history.locator('.record-signatures .photo-thumb').click();
  assert.equal(await page.evaluate(() => window.fixture.opens.at(-1).sources.length), 1);
  assert.equal(await page.evaluate(() => Boolean(window.fixture.opens.at(-1).options?.reportGallery)), false);
  await disclosure.click();
  assert.equal(await page.evaluate(() => window.fixture.created.length), 7);
  assert.equal(await page.evaluate(() => window.fixture.revoked.length), 7);
  assert.equal(await history.locator('img').count(), 0);
  console.log('ok - expansion keeps one recovery-action set, captured answers, signatures and complete gallery; secondary Discard delegates its existing confirmation handler');

  for (const [mode, override, expectedRetry, expectedRecovery] of [
    ['queued', {}, 0, 0], ['queued', { retryCount: 1 }, 1, 1],
    ['syncing', {}, 0, 0], ['saved-copy', {}, 0, 0], ['resolved', {}, 0, 0],
    ['failed', { backendRecordId: 88 }, 0, 0]
  ]) {
    await render({ mode, override });
    assert.equal(await history.getByRole('button', { name: 'Retry sync', exact: true }).count(), expectedRetry, `${mode}: retry eligibility`);
    assert.equal(await history.getByRole('button', { name: 'Recover as draft', exact: true }).count(), expectedRecovery, `${mode}: recovery eligibility`);
  }
  await render({ mode: 'queued' });
  await disclosure.click();
  assert.equal(await history.getByRole('button', { name: 'Retry sync', exact: true }).count(), 1);
  assert.equal(await history.getByRole('button', { name: 'Discard local copy', exact: true }).count(), 1);
  assert.equal(await history.getByRole('button', { name: 'Recover as draft', exact: true }).count(), 0);
  assert.match(await history.locator('.record-report-more-details').textContent(), /Saved on this device:/);
  assert.doesNotMatch(await history.locator('.record-report-more-details').textContent(), /Submitted:/);
  await render({ mode: 'saved-copy', override: { workflowStatus: 'resolved', supervisorNote: 'Do not present stale recovery metadata as a final note.' } });
  await disclosure.click();
  assert.doesNotMatch(await history.textContent(), /Final supervisor note:|Do not present stale recovery metadata/);
  assert.match(await history.locator('.record-report-more-details').textContent(), /Saved on this device:/);
  console.log('ok - only failed/retried queued Reports promote actions; healthy queued detail preserves Retry/Discard while syncing, saved copies and durable Reports cannot recover');

  for (const change of ['detach', 'reset', 'identity', 'department', 'role']) {
    await render({ mode: 'failed' });
    const before = await page.evaluate(() => window.fixture.calls.length);
    await page.evaluate((scopeChange) => {
      const { fixture } = window;
      const buttons = [...document.querySelectorAll('.record-report-recovery-actions button')];
      if (scopeChange === 'detach') document.querySelector('.record-report-compact').remove();
      if (scopeChange === 'reset') fixture.module.resetSession();
      if (scopeChange === 'identity') fixture.state.user = { ...fixture.worker, id: 99 };
      if (scopeChange === 'department') fixture.state.user = { ...fixture.worker, departmentId: 99 };
      if (scopeChange === 'role') fixture.state.user = { ...fixture.worker, role: 'supervisor' };
      buttons.forEach((button) => button.click());
    }, change);
    assert.equal(await page.evaluate(() => window.fixture.calls.length), before, `${change}: stale private action must not act`);
  }
  console.log('ok - detached/reset/switched identity, Department and role invalidate promoted private actions');

  for (const surface of ['worker', 'supervisor']) {
    const container = await render({ surface });
    if (surface === 'worker') await disclosure.click();
    const text = await container.textContent();
    assert.doesNotMatch(text, /Type:\s*Report|Sync:\s*synced|Report Template:/);
    assert.equal(text.split('Site inspection <safe>').length - 1, 1, `${surface}: Template title is not repeated`);
    assert.equal(text.split('Report Date: 2026-10-07').length - 1, 1, `${surface}: Report Date is not repeated`);
    assert.equal(text.split('Pass <script>unsafe()</script>').length - 1, 1, `${surface}: final note appears once`);
    assert.equal(await container.locator('script').count(), 0);
    assert.match(await container.innerText(), /The access route is clear\./);
    assert.match(await container.innerText(), /Pass <script>unsafe\(\)<\/script>/);
    const metadata = container.locator('details.record-report-more-details');
    const summary = metadata.locator('summary');
    assert.equal(await metadata.getAttribute('open'), null);
    assert.equal(await summary.textContent(), 'More details');
    assert.match(await metadata.textContent(), /Reviewing supervisor:.*Review supervisor/s);
    assert.match(await metadata.textContent(), /Submitted:.*Review started:.*Resolved:/s);
    assert.equal((await container.innerText()).includes('Submitted:'), false,
      'The former always-visible timestamp assertion must fail while More details is closed');
    assert.doesNotMatch(await container.innerText(), /Review supervisor|Review started:/);
    await summary.focus();
    await page.keyboard.press('Enter');
    assert.equal(await metadata.getAttribute('open'), '');
    assert.match(await container.innerText(), /Submitted:/,
      'The same rendered Report retains its submitted timestamp after opening More details');
    assert.match(await container.innerText(), /Review supervisor/);
    await page.keyboard.press('Space');
    assert.equal(await metadata.getAttribute('open'), null);
    assert.equal(await summary.evaluate((node) => node === document.activeElement), true);
  }
  // The missing-note fallback is system text; the identical words saved by a
  // Supervisor are user content and must not be translated or reinterpreted.
  const fallback = 'No supervisor note was recorded.';
  await page.evaluate(() => { window.fixture.language = 'zh'; });
  for (const surface of ['worker', 'supervisor']) {
    for (const savedLiteral of [false, true]) {
      const container = await render({ surface, override: { supervisorNote: savedLiteral ? fallback : '', reviewingSupervisorName: 'Pass', userName: 'Pass' } });
      if (surface === 'worker') await disclosure.click();
      const value = surface === 'worker'
        ? container.locator('.record-report-cue > span').nth(1)
        : container.locator('.report-supervisor-note [data-report-final-note]');
      assert.equal(await value.textContent(), savedLiteral ? fallback : '未记录主管备注。');
      assert.equal(await value.getAttribute('data-no-i18n'), savedLiteral ? '' : null);
      assert.equal((await container.textContent()).split(savedLiteral ? fallback : '未记录主管备注。').length - 1, 1);
      if (surface === 'supervisor') assert.equal(await container.locator('.record-meta [data-no-i18n]').textContent(), 'Pass');
      await container.locator('.record-report-more-details summary').click();
      assert.equal(await container.locator('.record-report-metadata [data-no-i18n]').textContent(), 'Pass');
      await page.evaluate(async () => (await import('/assets/js/i18n.js')).setLanguage('en'));
      assert.equal(await value.textContent(), fallback);
      await page.evaluate(async () => (await import('/assets/js/i18n.js')).setLanguage('zh'));
      assert.equal(await value.textContent(), savedLiteral ? fallback : '未记录主管备注。');
    }
  }
  await render({ surface: 'supervisor', override: { workDate: '' } });
  assert.equal(await details.locator('.record-report-date').textContent(), '未设置');
  assert.match(await details.locator('.record-meta').textContent(), /报告日期：/);
  await page.evaluate(() => { window.fixture.language = 'en'; });
  console.log('ok - Worker/Supervisor details deduplicate title/date/note, retain keyboard-accessible metadata, translate missing-note fallbacks and preserve literal notes/reviewer names');

  await render({ override: { supervisorNote: 'Keep the route clear and inspect every connection before the next shift. '.repeat(24) } });
  const cue = history.locator('.record-report-cue');
  const collapsedHeight = await cue.evaluate((node) => node.getBoundingClientRect().height);
  assert.equal(await cue.evaluate((node) => getComputedStyle(node).webkitLineClamp), '3');
  assert.equal(await cue.evaluate((node) => node.scrollHeight > node.clientHeight), true);
  await disclosure.click();
  assert.notEqual(await cue.evaluate((node) => getComputedStyle(node).webkitLineClamp), '3');
  assert.ok((await cue.evaluate((node) => node.getBoundingClientRect().height)) > collapsedHeight * 2);
  assert.equal(await cue.evaluate((node) => node.scrollHeight <= node.clientHeight + 1), true);
  await disclosure.click();
  assert.equal(await cue.evaluate((node) => getComputedStyle(node).webkitLineClamp), '3');
  assert.ok(Math.abs((await cue.evaluate((node) => node.getBoundingClientRect().height)) - collapsedHeight) <= 1);
  console.log('ok - a long final note is compact when closed, fully readable when expanded, and compact again after collapse');

  await render({ surface: 'supervisor', purpose: 'daywork' });
  assert.equal(await details.locator('.record-report-more-details').count(), 0);
  assert.match(await details.textContent(), /Type:\s*Report/);
  assert.match(await details.textContent(), /Sync:\s*synced/);
  assert.match(await details.textContent(), /Report Template:/);
  assert.equal(await details.locator('.record-photos img').count(), 7);
  assert.equal(await details.locator('.record-export-actions select').inputValue(), 'form-html');
  console.log('ok - retained Daywork detail, complete photo list and export default remain unchanged');

  let screenshots = 0;
  for (const { width, language, theme } of [
    { width: 320, language: 'en', theme: 'light' },
    { width: 390, language: 'zh', theme: 'dark' }
  ]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(({ nextLanguage, nextTheme }) => {
      window.fixture.language = nextLanguage;
      document.documentElement.dataset.theme = nextTheme;
    }, { nextLanguage: language, nextTheme: theme });
    for (const [surface, mode] of [['worker', 'failed'], ['worker', 'resolved'], ['supervisor', 'resolved']]) {
      const screenshotNote = 'Checked and resolved. Keep the access route clear.';
      const container = await render({ surface, mode, override: { formName: 'Site inspection',
        ...(mode === 'resolved' ? { supervisorNote: screenshotNote } : {}) } });
      if (surface === 'worker' && mode === 'resolved') await disclosure.click();
      if (mode === 'failed') {
        const buttons = recoveryActions.locator('button');
        assert.equal(await buttons.count(), 2);
        for (let index = 0; index < 2; index += 1) await assertTouchTarget(buttons.nth(index), `${width}/${language}: recovery action`);
        if (language === 'zh') assert.doesNotMatch(await recoveryActions.innerText(), /Retry sync|Recover as draft/);
      } else {
        const summary = container.locator('.record-report-more-details summary');
        await assertTouchTarget(summary, `${width}/${language}: More details`);
        if (language === 'zh') assert.doesNotMatch(await summary.innerText(), /More details/);
        // User-entered notes must remain literal while the chrome translates.
        assert.ok((await container.innerText()).includes(screenshotNote));
        await container.locator('img').evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
        if (surface === 'supervisor') {
          const date = container.locator('.record-report-date');
          assert.equal(await date.textContent(), '2026-10-07');
          assert.equal(await date.evaluate((node) => {
            const range = document.createRange();
            range.selectNodeContents(node);
            return range.getClientRects().length;
          }), 1, `${width}/${language}: the Report Date value must not split across lines`);
        }
      }
      await assertNoOverflow(`${width}/${language}/${theme}/${surface}/${mode}`);
      await container.screenshot({ path: path.join(output, `${surface}-${mode}-${width}-${language}-${theme}.png`) });
      screenshots += 1;
    }
  }
  assert.equal(screenshots, 6);
  assert.deepEqual(errors, []);
  console.log('ok - six 320px EN/light and 390px ZH/dark warning/resolved layouts have accessible controls, translated chrome and no horizontal overflow');
  console.log(`Report detail UX screenshots: ${output}`);
} finally {
  await context.close();
  await browser.close();
}
