import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59992'; // All requests intercepted; no backend or real network.
const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB8kAAAAASUVORK5CYII=';
const markup = `<!doctype html><html><body>
  <div id="workerSummary"></div><div id="historyList"></div><div id="detailList"></div>
  <input id="historySearchInput"><select id="historyTypeFilter"><option value="form">Form</option></select>
  <select id="historyStatusFilter"><option value=""></option></select><input id="historyDateFilter" type="date">
  <span id="historyResultCount"></span>
  <button id="refreshHistoryButton">Refresh</button><button id="clearHistoryFiltersButton">Clear filters</button>
  <template id="recordTemplate"><article class="record-card"><div class="record-header"><div>
    <h3 class="record-title"></h3><p class="record-meta"></p></div><span class="badge"></span></div>
    <p class="record-detail"></p><div class="record-extra"></div><div class="record-actions hidden"></div>
  </article></template>
</body></html>`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
let imageRequests = 0;
await context.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, origin, 'Tests must not request external services');
  if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: markup });
  if (url.pathname.startsWith('/uploads/')) {
    imageRequests += 1;
    return route.fulfill({ contentType: 'image/png', body: Buffer.from(tinyPng, 'base64') });
  }
  assert.match(url.pathname, /^\/assets\/js\/[a-z\d-]+\.js$/);
  return route.fulfill({ contentType: 'text/javascript', body: await readFile(path.join(projectRoot, url.pathname), 'utf8') });
});
const page = await context.newPage();
try {
  await page.goto(origin);
  await page.evaluate(async (png) => {
    const { createHistoryModule, filterRecords } = await import('/assets/js/history.js');
    const els = Object.fromEntries([...document.querySelectorAll('[id]')].map((node) => [node.id, node]));
    const worker = { id: 12, departmentId: 3, role: 'worker' };
    const state = { user: worker, historyRecords: [], sites: [] };
    const calls = [];
    let viewerSources = [];
    const photoViewer = {
      open(sources) { viewerSources = sources; calls.push('open'); },
      closeForSources(sources) {
        if (!sources.some((source) => viewerSources.includes(source))) return false;
        viewerSources = [];
        calls.push('close');
        return true;
      }
    };
    const module = createHistoryModule({
      els, state, reportOnly: true, photoViewer,
      canWorkerEditRecord: () => false,
      handleRetryQueuedRecord: () => calls.push('retry'),
      handleSupervisorExportRecord: (_record, format) => calls.push(`export:${format}`),
      handleDiscardQueuedRecord: () => calls.push('discard')
    });
    const base = {
      id: 'form-20', backendRecordId: 20, type: 'form', userId: 12, departmentId: 3,
      userName: 'Test Worker', formName: 'Inspection <unsafe>', submissionPurpose: 'report',
      siteId: 4, siteName: 'Site <img src=x onerror=alert(1)>', workDate: '2026-09-18',
      createdAt: '2026-09-18T00:00:00Z', syncStatus: 'synced', workflowStatus: 'resolved',
      supervisorNote: 'Resolved <script>danger()</script>',
      fields: [{ id: 'answer', label: 'Area', type: 'text' }, { id: 'sign', label: 'Signature', type: 'signature' }],
      answers: { answer: 'Secret full answer searchable', sign: `data:image/png;base64,${png}` },
      photoUrls: Array.from({ length: 50 }, (_, index) => `/uploads/photo-${index + 1}.png`)
    };
    const created = [], revoked = [];
    const originalCreate = URL.createObjectURL.bind(URL);
    const originalRevoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { const url = originalCreate(blob); created.push(url); return url; };
    URL.revokeObjectURL = (url) => { revoked.push(url); originalRevoke(url); };
    const blob = new Blob([Uint8Array.from(atob(png), (character) => character.charCodeAt(0))], { type: 'image/png' });
    const render = (record = base) => {
      state.historyRecords = [record];
      module.renderFilteredHistory();
    };
    window.fixture = { module, filterRecords, state, worker, base, render, calls, created, revoked, blob, viewerSources: () => viewerSources };
    module.bindEvents();
    render();
  }, tinyPng);

  assert.equal(await page.locator('#historyList .record-report-compact').count(), 1);
  assert.equal(await page.locator('#historyList img').count(), 0);
  assert.equal(await page.locator('#historyList .record-report-details > *').count(), 0);
  assert.equal(imageRequests, 0);
  assert.equal(await page.locator('#historyList .record-title').textContent(), 'Inspection <unsafe>');
  assert.match(await page.locator('#historyList .record-meta').textContent(), /Report Date: 2026-09-18.*Site <img/);
  assert.equal(await page.locator('#historyList .record-report-summary').textContent(), '50 photos');
  assert.match(await page.locator('#historyList .record-report-cue').textContent(), /Final supervisor note: Resolved <script>/);
  assert.equal(await page.locator('#historyList script').count(), 0);
  assert.equal(await page.locator('#historyList').textContent().then((text) => text.includes('Secret full answer')), false);
  console.log('ok - compact 50-photo Report has summary/status/date/site/note and no eager evidence or unsafe HTML');

  await page.locator('#historySearchInput').fill('Secret full answer');
  await page.locator('.record-disclosure-button').click();
  assert.equal(await page.locator('.record-disclosure-button').getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('#historyList .record-photos img').count(), 50);
  assert.equal(await page.locator('#historyList .record-signatures img').count(), 1);
  assert.match(await page.locator('#historyList .record-report-details').textContent(), /Secret full answer searchable/);
  assert.equal(await page.locator('#historyList .record-title').count(), 1);
  await page.locator('.record-disclosure-button').click();
  assert.equal(await page.locator('#historyList img').count(), 0);
  assert.equal(await page.locator('#historyList .record-report-details > *').count(), 0);
  assert.equal(await page.locator('.record-disclosure-button').getAttribute('aria-expanded'), 'false');
  await page.locator('#historySearchInput').fill('');
  console.log('ok - accessible disclosure opens on first click after search blur, builds detail on demand and releases DOM on collapse');

  const filterChecks = await page.evaluate(() => {
    const { base, filterRecords } = window.fixture;
    return [
      filterRecords([base], { query: 'secret full answer', reportWorkflow: true }).length,
      filterRecords([base], { query: 'resolved <script>', status: 'resolved', reportWorkflow: true }).length,
      filterRecords([base], { query: 'secret full answer', status: 'in_review', reportWorkflow: true }).length
    ];
  });
  assert.deepEqual(filterChecks, [1, 1, 0]);
  console.log('ok - collapsed Reports retain full-answer/final-note search and workflow filtering');

  await page.evaluate(() => {
    const fixture = window.fixture;
    fixture.queued = { ...fixture.base, id: 'local-20', backendRecordId: null, syncStatus: 'queued',
      syncError: 'Template changed <img src=x>', syncBlockedReason: 'template_changed',
      photoBlobs: Array.from({ length: 50 }, () => fixture.blob),
      photoUrls: ['/uploads/already-uploaded.png'],
      capturedAnswers: { answer: 'Original captured answer', sign: fixture.base.answers.sign },
      answers: { answer: 'Normalized current answer' }
    };
    fixture.render(fixture.queued);
  });
  assert.equal(await page.locator('#historyList .badge').textContent(), 'Queued');
  assert.match(await page.locator('.record-report-cue').textContent(), /Sync needs attention.*Template changed <img/);
  assert.equal(await page.evaluate(() => window.fixture.created.length), 0);
  await page.locator('.record-disclosure-button').click();
  assert.equal(await page.evaluate(() => window.fixture.created.length), 50);
  assert.match(await page.locator('.record-report-details').textContent(), /Original captured answer/);
  assert.match(await page.locator('.record-report-details').textContent(), /Your original answers and evidence are kept below/);
  assert.equal(await page.getByRole('button', { name: 'Retry sync', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Discard local copy', exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Retry sync', exact: true }).click();
  await page.locator('.record-photos .photo-thumb').first().click();
  await page.locator('.record-disclosure-button').click();
  assert.equal(await page.evaluate(() => window.fixture.revoked.length), 50);
  assert.deepEqual(await page.evaluate(() => window.fixture.calls), ['retry', 'open', 'close']);
  assert.equal(await page.evaluate(() => window.fixture.queued.answers.answer), 'Normalized current answer');
  console.log('ok - queued partial-upload Blob photos allocate only on expand, preserve captured evidence and revoke/close on collapse');

  await page.locator('.record-disclosure-button').click();
  await page.evaluate(() => window.fixture.module.renderFilteredHistory());
  assert.equal(await page.evaluate(() => window.fixture.revoked.length), 100);
  assert.equal(await page.locator('#historyList img').count(), 0);
  await page.locator('.record-disclosure-button').click();
  await page.evaluate(() => {
    window.fixture.detachedDisclosure = document.querySelector('.record-disclosure-button');
    window.fixture.module.resetSession();
  });
  assert.equal(await page.evaluate(() => window.fixture.revoked.length), 150);
  assert.equal(await page.locator('#historyList .record-card').count(), 0);
  await page.evaluate(() => window.fixture.detachedDisclosure.click());
  assert.equal(await page.evaluate(() => window.fixture.created.length), 150);
  console.log('ok - re-render/reset releases every owned Blob URL and detached controls cannot restore private evidence');

  await page.evaluate(() => {
    const fixture = window.fixture;
    fixture.render({ ...fixture.base, userId: 99 });
  });
  assert.equal(await page.locator('#historyList .record-card').count(), 0);
  await page.evaluate(() => {
    const fixture = window.fixture;
    fixture.render({ ...fixture.base, departmentId: 4 });
  });
  assert.equal(await page.locator('#historyList .record-card').count(), 0);
  await page.evaluate(() => {
    const fixture = window.fixture;
    fixture.render();
    fixture.detachedDisclosure = document.querySelector('.record-disclosure-button');
    fixture.state.user = { ...fixture.worker, id: 99 };
    fixture.detachedDisclosure.click();
  });
  assert.equal(await page.locator('#historyList img').count(), 0);
  await page.evaluate(() => {
    window.fixture.state.user = null;
    window.fixture.module.renderFilteredHistory();
  });
  assert.match(await page.locator('#historyList').textContent(), /No records found yet/);
  console.log('ok - exact Worker/Department ownership, switched sessions and empty history do not reveal private detail');

  await page.evaluate(() => {
    const fixture = window.fixture;
    fixture.state.user = fixture.worker;
    fixture.render({ ...fixture.base, backendRecordId: null, isDraftRecovery: true, syncStatus: 'queued', photoUrls: [], siteId: null, siteName: 'Unassigned site' });
  });
  assert.equal(await page.locator('#historyList .record-report-summary').textContent(), '0 photos');
  assert.equal(await page.locator('#historyList .badge').textContent(), 'Saved draft');
  assert.doesNotMatch(await page.locator('#historyList .record-meta').textContent(), /Unassigned site/);
  assert.match(await page.locator('.record-report-cue').textContent(), /Saved copy/);
  await page.locator('.record-disclosure-button').click();
  assert.equal(await page.getByRole('button', { name: 'Retry sync', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Discard local copy', exact: true }).count(), 1);
  console.log('ok - zero-photo recovery cards keep recovery cue/discard, omit optional Site and do not retry drafts');

  await page.evaluate(() => {
    const fixture = window.fixture;
    fixture.module.renderRecordsList(document.getElementById('detailList'), [fixture.base]);
  });
  assert.equal(await page.locator('#detailList .record-report-compact').count(), 0);
  assert.equal(await page.locator('#detailList .record-photos img').count(), 50);
  await page.evaluate(() => {
    const fixture = window.fixture;
    fixture.module.renderRecordsList(document.getElementById('detailList'), [{ ...fixture.base, submissionPurpose: 'daywork' }], { compactReports: true });
  });
  assert.equal(await page.locator('#detailList .record-report-compact').count(), 0);
  assert.equal(await page.locator('#detailList .record-photos img').count(), 50);
  console.log('ok - Supervisor full detail and retained Daywork renderer remain full and unchanged');

  await page.evaluate(() => {
    const { module, base } = window.fixture;
    module.renderRecordsList(document.getElementById('detailList'), [base], { showExportActions: true });
  });
  const exportFormat = page.locator('#detailList .record-export-actions select');
  assert.equal(await exportFormat.inputValue(), 'form-pdf');
  assert.deepEqual(await exportFormat.locator('option').evaluateAll((options) => options.map((option) => option.value)), ['form-pdf', 'form-html', 'form-csv']);
  await page.locator('#detailList').getByRole('button', { name: 'Download PDF', exact: true }).click();
  for (const [format, label] of [['form-html', 'Download HTML'], ['form-csv', 'Download CSV']]) {
    await exportFormat.selectOption(format);
    await page.locator('#detailList').getByRole('button', { name: label, exact: true }).click();
  }
  assert.deepEqual(await page.evaluate(() => window.fixture.calls.filter((call) => call.startsWith('export:'))), ['export:form-pdf', 'export:form-html', 'export:form-csv']);
  await exportFormat.selectOption('form-pdf');
  await page.evaluate(async () => (await import('/assets/js/i18n.js')).setLanguage('zh'));
  assert.equal(await page.locator('#detailList .record-export-actions button').textContent(), '下载 PDF');
  await page.evaluate(async () => {
    (await import('/assets/js/i18n.js')).setLanguage('en');
    const { module, base } = window.fixture;
    module.renderRecordsList(document.getElementById('detailList'), [{ ...base, submissionPurpose: 'daywork' }], { showExportActions: true });
  });
  assert.equal(await exportFormat.inputValue(), 'form-html');
  assert.equal(await page.locator('#detailList .record-export-actions button').textContent(), 'Export');
  assert.equal(await exportFormat.locator('option[value="daywork-pdf"]').count(), 1);
  console.log('ok - Report downloads default to PDF, keep HTML/CSV and translation, and leave Daywork defaults unchanged');

  await page.evaluate(() => {
    const fixture = window.fixture;
    fixture.selectionCalls = [];
    fixture.module.renderRecordsList(document.getElementById('detailList'), [fixture.base, { ...fixture.base, id: 'form-21', backendRecordId: 21 }], {
      summaryOnly: true, selectedRecordKey: 'form:20',
      onRecordSelect: (record) => fixture.selectionCalls.push(`open:${record.id}`),
      onRecordFocus: (record) => fixture.selectionCalls.push(`focus:${record.id}`)
    });
  });
  await page.locator('#detailList [role="option"]').first().focus();
  await page.keyboard.press('ArrowDown');
  assert.deepEqual(await page.evaluate(() => window.fixture.selectionCalls), ['focus:form-21']);
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.fixture.selectionCalls), ['focus:form-21', 'open:form-21']);
  assert.equal(await page.locator('#detailList img').count(), 0);
  console.log('ok - mobile review arrows move selection without opening detail; Enter still activates');

  const translatedCues = await page.evaluate(async () => {
    const { setLanguage } = await import('/assets/js/i18n.js');
    const fixture = window.fixture;
    fixture.render({ ...fixture.base, syncStatus: 'queued', syncError: 'Report Template changed. Review the saved report and submit a new report with the current template.' });
    setLanguage('zh');
    const error = document.querySelector('.record-report-cue').textContent;
    fixture.render({ ...fixture.base, supervisorNote: 'Pass' });
    setLanguage('zh');
    const literalNote = document.querySelector('.record-report-cue [data-no-i18n]').textContent;
    setLanguage('en');
    return { error, literalNote };
  });
  assert.doesNotMatch(translatedCues.error, /Sync needs attention|Report Template changed/);
  assert.match(translatedCues.error, /模板/);
  assert.equal(translatedCues.literalNote, 'Pass');
  console.log('ok - compact system-error cues translate independently and Supervisor-written final notes remain literal');

  const viewerChecks = await page.evaluate(async () => {
    const { createPhotoViewer } = await import('/assets/js/photo-viewer.js');
    const viewerNode = document.createElement('div');
    viewerNode.className = 'hidden';
    viewerNode.innerHTML = '<img><p></p><button>Close</button><button>Previous</button><button>Next</button>';
    document.body.append(viewerNode);
    const [closeButton, previousButton, nextButton] = viewerNode.querySelectorAll('button');
    const viewer = createPhotoViewer({ viewer: viewerNode, image: viewerNode.querySelector('img'), caption: viewerNode.querySelector('p'), closeButton, previousButton, nextButton });
    viewer.open(['/uploads/owned.png']);
    const unrelated = viewer.closeForSources(['/uploads/other.png'], { restoreFocus: false });
    const stillOpen = !viewerNode.classList.contains('hidden');
    const owned = viewer.closeForSources(['/uploads/owned.png'], { restoreFocus: false });
    const closed = viewerNode.classList.contains('hidden') && !viewerNode.querySelector('img').hasAttribute('src');
    viewerNode.remove();
    return { unrelated, stillOpen, owned, closed };
  });
  assert.deepEqual(viewerChecks, { unrelated: false, stillOpen: true, owned: true, closed: true });
  console.log('ok - preview cleanup closes only its own viewer sources and releases the displayed image');
} finally {
  await context.close();
  await browser.close();
}
