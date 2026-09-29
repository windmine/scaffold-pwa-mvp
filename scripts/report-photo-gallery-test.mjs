import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Real history/i18n/CSS with fully intercepted transport. No user accounts,
// database, hosted writes or app-level reimplementation are involved.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59986';
const artifactDir = path.join(projectRoot, 'output', 'report-photo-gallery.local');
const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB8kAAAAASUVORK5CYII=';
const markup = `<!doctype html><html lang="en-NZ" data-theme="light"><head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/assets/css/styles.css">
  <style>main{width:100%;max-width:1100px;margin:0 auto;padding:12px;box-sizing:border-box}</style>
  </head><body class="report-only-mode"><main><h1>Report photo gallery</h1>
  <section id="workerView"><div id="historyList" class="records-list"></div></section>
  <section id="supervisorView" hidden><aside class="admin-desktop-nav">Reports</aside><div id="detailList" class="records-list"></div></section>
  <div hidden><div id="workerSummary"></div>
    <input id="historySearchInput"><select id="historyTypeFilter"><option value="form">Form</option></select>
    <select id="historyStatusFilter"><option value=""></option></select><input id="historyDateFilter" type="date">
    <span id="historyResultCount"></span><button id="refreshHistoryButton">Refresh</button>
    <button id="clearHistoryFiltersButton">Clear filters</button></div>
  <template id="recordTemplate"><article class="record-card"><div class="record-header"><div>
    <h3 class="record-title"></h3><p class="record-meta"></p></div><span class="badge"></span></div>
    <p class="record-detail"></p><div class="record-extra"></div><div class="record-actions hidden"></div>
  </article></template></main></body></html>`;

await mkdir(artifactDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const imageRequests = [];
const pageErrors = [];
await context.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, origin, 'The gallery regression cannot use external services');
  if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: markup });
  if (url.pathname.startsWith('/uploads/')) {
    imageRequests.push(url.pathname);
    if (url.pathname === '/uploads/unavailable.png') return route.fulfill({ status: 404, body: 'Not found' });
    // Distinct landscape illustrations make cropping/order visually reviewable;
    // they are intercepted display fixtures, not uploaded evidence or codecs.
    const number = Number(url.pathname.match(/photo-(\d+)/)?.[1] || 1);
    const colors = ['#166f92', '#9c5227', '#4d7764', '#805c8f', '#41629a', '#9e7140'];
    const color = colors[(number - 1) % colors.length];
    const body = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600" viewBox="0 0 900 600">
      <rect width="900" height="600" fill="${color}"/>
      <path d="M0 440 L180 280 L320 390 L500 190 L900 460 V600 H0Z" fill="#ffffff" opacity=".24"/>
      <circle cx="680" cy="140" r="66" fill="#ffffff" opacity=".5"/>
      <text x="450" y="340" fill="#ffffff" text-anchor="middle" font-family="sans-serif" font-size="150" font-weight="700">${number}</text>
      <text x="450" y="435" fill="#ffffff" text-anchor="middle" font-family="sans-serif" font-size="36">PHOTO FIXTURE</text>
    </svg>`;
    return route.fulfill({ contentType: 'image/svg+xml', body });
  }
  assert.match(url.pathname, /^\/assets\/(?:js\/[a-z\d-]+\.js|css\/styles\.css)$/);
  return route.fulfill({
    contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
    body: await readFile(path.join(projectRoot, url.pathname), 'utf8')
  });
});
const page = await context.newPage();
page.on('pageerror', (error) => pageErrors.push(error.message));
const history = page.locator('#historyList');
const details = page.locator('#detailList');

async function render({ count = 50, surface = 'worker', purpose = 'report', type = 'form', queued = false } = {}) {
  await page.evaluate((options) => window.fixture.render(options), { count, surface, purpose, type, queued });
  if (surface === 'worker') await history.locator('.record-disclosure-button').click();
  return surface === 'worker' ? history : details;
}

async function lastOpen() {
  return page.evaluate(() => window.fixture.opens.at(-1));
}

try {
  await page.goto(origin);
  await page.evaluate(async (png) => {
    const { createHistoryModule } = await import('/assets/js/history.js');
    const { setLanguage } = await import('/assets/js/i18n.js');
    const els = Object.fromEntries([...document.querySelectorAll('[id]')].map((node) => [node.id, node]));
    const worker = { id: 12, departmentId: 3, role: 'worker' };
    const supervisor = { id: 13, departmentId: 3, role: 'supervisor' };
    const state = { user: worker, sites: [], historyRecords: [] };
    const opens = [], closed = [], created = [], revoked = [], actions = [];
    let viewerSources = [];
    const photoViewer = {
      open(sources, index = 0, title = '', options) {
        viewerSources = [...sources];
        opens.push({ sources: [...sources], index, title, options,
          metadataUnchanged: !options?.reportGallery || options.photoMetadata === window.fixture.current.photoMetadata });
      },
      closeForSources(sources) {
        if (!sources.some((source) => viewerSources.includes(source))) return false;
        closed.push([...viewerSources]);
        viewerSources = [];
        return true;
      }
    };
    const originalCreate = URL.createObjectURL.bind(URL);
    const originalRevoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { const url = originalCreate(blob); created.push(url); return url; };
    URL.revokeObjectURL = (url) => { revoked.push(url); originalRevoke(url); };
    const blobs = Array.from({ length: 50 }, (_, index) => new Blob([
      Uint8Array.from(atob(png), (character) => character.charCodeAt(0)), String(index)
    ], { type: 'image/png' }));
    const module = createHistoryModule({
      els, state, reportOnly: true, photoViewer, canWorkerEditRecord: () => false,
      handleRetryQueuedRecord: () => actions.push('retry'),
      handleDiscardQueuedRecord: () => actions.push('discard'),
      handleSupervisorExportRecord: (_record, format) => actions.push(format)
    });
    const base = {
      id: 'form-20', backendRecordId: 20, type: 'form', userId: 12, departmentId: 3,
      userName: 'Test Worker', formName: 'Site inspection', submissionPurpose: 'report',
      siteId: 4, siteName: 'Test site', workDate: '2026-09-30', createdAt: '2026-09-29T22:00:00Z',
      syncStatus: 'synced', workflowStatus: 'in_review',
      fields: [{ id: 'answer', label: 'Observation', type: 'text' }, { id: 'sign', label: 'Worker signature', type: 'signature' }],
      answers: { answer: 'The access route is clear.', sign: `data:image/png;base64,${png}` },
      photoUrls: Array.from({ length: 50 }, (_, index) => `/uploads/photo-${String(index + 1).padStart(2, '0')}.png`),
      photoMetadata: Array.from({ length: 50 }, (_, index) => ({ taken_at: `2026-09-29T22:${String(index).padStart(2, '0')}:00Z` }))
    };
    const fixture = { module, state, base, worker, supervisor, photoViewer, opens, closed, created, revoked, blobs, actions, language: 'en' };
    fixture.render = ({ count = 50, surface = 'worker', purpose = 'report', type = 'form', queued = false } = {}) => {
      module.resetSession();
      state.user = surface === 'worker' ? worker : supervisor;
      state.departmentFocusId = null;
      els.workerView.hidden = surface !== 'worker';
      els.supervisorView.hidden = surface !== 'supervisor';
      els.workerView.classList.toggle('active', surface === 'worker');
      els.supervisorView.classList.toggle('active', surface === 'supervisor');
      document.body.classList.toggle('session-supervisor', surface === 'supervisor');
      const record = { ...base, type, submissionPurpose: purpose, photoUrls: base.photoUrls.slice(0, count) };
      if (queued) Object.assign(record, {
        id: 'local-report', backendRecordId: null, syncStatus: 'queued', photoBlobs: blobs.slice(0, count),
        photoUrls: ['/uploads/partial-upload.png'], syncError: 'No connection',
        capturedAnswers: { ...base.answers, answer: 'Original captured answer' }
      });
      fixture.current = record;
      if (surface === 'worker') {
        state.historyRecords = [record];
        module.renderFilteredHistory();
      } else {
        module.renderRecordsList(els.detailList, [record], { showExportActions: true });
      }
      setLanguage(fixture.language);
    };
    module.bindEvents();
    window.fixture = fixture;
    fixture.render();
  }, tinyPng);

  assert.equal(await history.locator('img').count(), 0, 'Collapsed Worker history must not allocate/decode evidence');
  assert.equal(imageRequests.length, 0);
  await history.locator('.record-disclosure-button').click();
  assert.equal(await history.locator('.report-photo-gallery').count(), 1);
  assert.equal(await history.locator('.record-photos img').count(), 6);
  assert.equal(await history.locator('.record-signatures img').count(), 1);
  assert.equal(await history.locator('.report-photo-gallery-open').textContent(), 'View all 50 photos');
  await history.locator('.record-photos img').evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
  assert.equal(imageRequests.length, 6, 'Only the six visible originals should be requested before viewer opening');
  const expectedSources = await page.evaluate(() => window.fixture.base.photoUrls);
  const expectedMetadata = await page.evaluate(() => window.fixture.base.photoMetadata);
  for (let index = 0; index < 6; index += 1) {
    await history.locator('.record-photos .photo-thumb').nth(index).click();
    const open = await lastOpen();
    assert.deepEqual(open.sources, expectedSources);
    assert.equal(open.index, index);
    assert.deepEqual(open.options, { reportGallery: true, photoMetadata: expectedMetadata });
    assert.equal(open.metadataUnchanged, true);
  }
  await history.locator('.report-photo-gallery-open').click();
  assert.equal((await lastOpen()).index, 0);
  assert.deepEqual((await lastOpen()).sources, expectedSources);
  assert.deepEqual((await lastOpen()).options.photoMetadata, expectedMetadata);
  assert.equal(await history.locator('.record-photos .photo-time').count(), 6);
  console.log('ok - collapsed Worker allocates no evidence; six numbered previews preserve full ordered 50-photo viewer and capture times');

  await history.locator('.record-signatures .photo-thumb').click();
  assert.equal((await lastOpen()).sources.length, 1);
  assert.notEqual((await lastOpen()).options?.reportGallery, true, 'Signatures must retain the normal viewer mode');
  for (const count of [0, 1, 6, 7, 50]) {
    const surface = await render({ count, surface: 'supervisor' });
    assert.equal(await surface.locator('.report-photo-gallery').count(), count ? 1 : 0);
    assert.equal(await surface.locator('.record-photos .photo-thumb').count(), Math.min(count, 6));
    assert.equal(await surface.locator('.report-photo-gallery-open').count(), count > 6 ? 1 : 0);
    assert.equal(await surface.locator('.record-signatures img').count(), 1);
    if (count) {
      assert.match(await surface.locator('.report-photo-gallery').textContent(), new RegExp(`\\b${count} photo`));
      const labels = await surface.locator('.record-photos .photo-thumb').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
      assert.equal(labels.every((label, index) => label?.includes(String(index + 1))), true);
    }
  }
  console.log('ok - zero/one/six/seven/fifty Supervisor photos use correct counts, capped thumbnails, numbered names and unchanged signatures');

  await page.evaluate(async () => {
    const { fixture } = window;
    fixture.current.photoUrls[0] = '/uploads/unavailable.png';
    fixture.module.renderRecordsList(document.querySelector('#detailList'), [fixture.current]);
    (await import('/assets/js/i18n.js')).setLanguage('en');
  });
  const failed = details.locator('.record-photos .photo-thumb').first();
  await failed.locator('.report-photo-gallery-unavailable').waitFor({ state: 'visible' });
  assert.match(await failed.getAttribute('aria-label'), /Photo 1 of 50.*Preview unavailable.*Open original/);
  assert.equal(await failed.locator('img').isHidden(), true);
  await failed.click();
  assert.equal((await lastOpen()).sources[0], '/uploads/unavailable.png');
  assert.equal((await lastOpen()).sources.length, 50);
  await page.evaluate(async () => (await import('/assets/js/i18n.js')).setLanguage('zh'));
  assert.doesNotMatch(await failed.getAttribute('aria-label'), /Photo|Preview unavailable|Open original/);
  assert.doesNotMatch(await failed.locator('.report-photo-gallery-unavailable').textContent(), /Preview unavailable|Tap to open/);
  await page.evaluate(async () => (await import('/assets/js/i18n.js')).setLanguage('en'));
  console.log('ok - unavailable thumbnail keeps a numbered translated fallback and access to the unchanged full original list');

  for (const [type, purpose] of [['form', 'daywork'], ['task', 'report']]) {
    await render({ surface: 'supervisor', type, purpose });
    assert.equal(await details.locator('.report-photo-gallery').count(), 0);
    assert.equal(await details.locator('.record-photos img').count(), 50);
    await details.locator('.record-photos .photo-thumb').nth(49).click();
    assert.equal((await lastOpen()).index, 49);
    assert.notEqual((await lastOpen()).options?.reportGallery, true);
  }
  console.log('ok - retained Daywork and non-form evidence remain unchanged with all photo buttons');

  await render({ queued: true });
  assert.equal(await history.locator('.record-photos img').count(), 6);
  assert.equal(await page.evaluate(() => window.fixture.created.length), 50);
  assert.equal(await page.evaluate(() => window.fixture.current.photoBlobs.every((blob, index) => blob === window.fixture.blobs[index])), true);
  await history.locator('.report-photo-gallery-open').click();
  const queuedOpen = await lastOpen();
  assert.deepEqual(queuedOpen.sources, await page.evaluate(() => window.fixture.created));
  assert.deepEqual(queuedOpen.options.photoMetadata, expectedMetadata);
  assert.equal(queuedOpen.metadataUnchanged, true);
  assert.match(await history.textContent(), /Original captured answer/);
  await history.getByRole('button', { name: 'Retry sync', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.fixture.actions), ['retry']);
  await page.evaluate(() => { window.fixture.detached = [...document.querySelectorAll('#historyList [data-photo-index], #historyList .report-photo-gallery-open')]; });
  await history.locator('.record-disclosure-button').click();
  assert.deepEqual(await page.evaluate(() => window.fixture.revoked), queuedOpen.sources);
  assert.deepEqual(await page.evaluate(() => window.fixture.closed.at(-1)), queuedOpen.sources);
  const opensBeforeDetached = await page.evaluate(() => window.fixture.opens.length);
  await page.evaluate(() => window.fixture.detached.forEach((button) => button.click()));
  assert.equal(await page.evaluate(() => window.fixture.opens.length), opensBeforeDetached);
  assert.equal(await history.locator('img').count(), 0);
  await history.locator('.record-disclosure-button').click();
  await history.locator('.report-photo-gallery-open').click();
  await page.evaluate(() => {
    window.fixture.detached = [...document.querySelectorAll('#historyList [data-photo-index], #historyList .report-photo-gallery-open')];
    window.fixture.module.resetSession();
  });
  assert.equal(await page.evaluate(() => window.fixture.created.length), 100);
  assert.equal(await page.evaluate(() => window.fixture.revoked.length), 100);
  assert.deepEqual(await page.evaluate(() => window.fixture.closed.at(-1)), await page.evaluate(() => window.fixture.created.slice(50)));
  const resetOpenCount = await page.evaluate(() => window.fixture.opens.length);
  await page.evaluate(() => window.fixture.detached.forEach((button) => button.click()));
  assert.equal(await page.evaluate(() => window.fixture.opens.length), resetOpenCount);
  assert.equal(await history.locator('img').count(), 0);
  console.log('ok - queued original Blobs retain identity and all ordered viewer sources; collapse/reset release 100 URLs and disable detached controls');

  for (const surface of ['worker', 'supervisor']) {
    await render({ surface });
    const container = surface === 'worker' ? history : details;
    const count = await page.evaluate(() => window.fixture.opens.length);
    await page.evaluate((selector) => {
      window.fixture.state.user = { id: 999, departmentId: 99, role: 'supervisor' };
      document.querySelector(`${selector} .report-photo-gallery-open`).click();
      document.querySelector(`${selector} [data-photo-index]`).click();
    }, surface === 'worker' ? '#historyList' : '#detailList');
    assert.equal(await page.evaluate(() => window.fixture.opens.length), count, 'A switched identity must not open old private gallery sources');
    await page.evaluate(() => window.fixture.module.resetSession());
    assert.equal(await container.locator('img').count(), 0);
  }
  console.log('ok - old Worker and Supervisor gallery controls do not open private evidence after an identity/scope change');

  await render({ surface: 'supervisor' });
  const beforeDepartmentSwitch = await page.evaluate(() => window.fixture.opens.length);
  await page.evaluate(() => {
    window.fixture.state.departmentFocusId = 99;
    document.querySelector('#detailList .report-photo-gallery-open').click();
    document.querySelector('#detailList [data-photo-index]').click();
  });
  assert.equal(await page.evaluate(() => window.fixture.opens.length), beforeDepartmentSwitch);
  console.log('ok - changing focused Department also invalidates existing gallery controls');

  let combinations = 0;
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const language of ['en', 'zh']) {
      for (const theme of ['light', 'dark']) {
        await page.evaluate(({ language: nextLanguage, theme: nextTheme }) => {
          window.fixture.language = nextLanguage;
          document.documentElement.dataset.theme = nextTheme;
        }, { language, theme });
        for (const surface of ['worker', 'supervisor']) {
          const container = await render({ surface });
          await page.evaluate(async () => (await import('/assets/js/i18n.js')).setLanguage(window.fixture.language));
          const gallery = container.locator('.report-photo-gallery');
          const viewAll = gallery.locator('.report-photo-gallery-open');
          assert.equal(await gallery.locator('img').count(), 6);
          if (language === 'zh') assert.doesNotMatch(await viewAll.textContent(), /View all|photos/);
          else assert.equal(await viewAll.textContent(), 'View all 50 photos');
          const bounds = await gallery.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return { width: rect.width, height: rect.height, overflow: document.documentElement.scrollWidth - innerWidth };
          });
          assert.ok(bounds.overflow <= 1, `${width}/${language}/${theme}/${surface}: horizontal overflow`);
          assert.ok(bounds.height < 700, `${width}/${language}/${theme}/${surface}: gallery is not compact`);
          await viewAll.scrollIntoViewIfNeeded();
          const button = await viewAll.boundingBox();
          assert.ok(button.width >= 44 && button.height >= 44, 'View all must remain a reachable 44px target');
          await viewAll.click();
          assert.equal((await lastOpen()).sources.length, 50);
          if (surface === 'supervisor') {
            const download = container.locator('.record-export-actions button');
            await download.scrollIntoViewIfNeeded();
            await download.click();
            assert.equal(await page.evaluate(() => window.fixture.actions.at(-1)), 'form-pdf');
          }
          await container.screenshot({ path: path.join(artifactDir, `${surface}-${width}-${language}-${theme}.png`) });
          combinations += 1;
        }
      }
    }
  }
  assert.equal(combinations, 32);
  assert.deepEqual(pageErrors, []);
  console.log(`ok - ${combinations} real-CSS Worker/Supervisor layouts at 320/390/768/1440px, EN/ZH and light/dark stay compact with reachable actions`);
  console.log(`Gallery screenshots: ${artifactDir}`);
} finally {
  await context.close();
  await browser.close();
}
