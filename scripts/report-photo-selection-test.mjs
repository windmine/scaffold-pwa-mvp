import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59978'; // Fully intercepted; never contacts a live API.
const output = path.join(root, 'output', 'report-photo-selection.local');
const maxBytes = 5 * 1024 * 1024;
const markup = `<!doctype html><html lang="en" data-theme="light"><head>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/assets/css/styles.css">
</head><body class="report-only-mode"><main style="padding:12px"><article class="card">
  <h2>New Report</h2><form id="workFormSubmissionForm" class="form-grid">
  <label>Report Template<select id="workFormSelect"></select></label>
  <div class="report-context-fields form-grid"><label>Report Date<input id="workFormDate" type="date"></label>
  <label>Site (optional)<select id="workFormSite"><option value=""></option></select></label></div>
  <div id="workFormFields" class="dynamic-fields"></div>
  <label class="report-photo-field">Photos<input id="workFormPhotos" type="file" multiple>
    <small>JPEG, PNG, or WebP; maximum 5 MB each.</small><small id="workFormPhotoLimit"></small>
    <small>Select again to add more photos.</small></label>
  <p id="workFormPhotoStatus" class="muted" role="status"></p>
  <div id="workFormPhotoSelectionFeedback" class="report-photo-selection-feedback" role="status" aria-live="polite" hidden></div>
  <div id="workFormPhotoPreview" class="photo-preview hidden"></div>
  <div class="work-form-submit-row"><button id="submitWorkFormButton">Submit Report</button>
  <p id="workFormAutosaveStatus" class="autosave-status"></p></div>
  <div id="workFormFeedback"></div></form></article><button id="refreshHistoryButton">Refresh</button></main>
  <div id="photoViewer" class="hidden" role="dialog" aria-modal="true">
    <button id="photoViewerClose" type="button">Close</button>
    <button id="photoViewerPrevious" type="button">Previous</button>
    <img id="photoViewerImage"><p id="photoViewerCaption"></p>
    <button id="photoViewerNext" type="button">Next</button>
  </div></body></html>`;

async function initialize(page) {
  await page.evaluate(async () => {
    const { createWorkerFormModule } = await import('/assets/js/worker-form.js');
    const { createPhotoViewer } = await import('/assets/js/photo-viewer.js');
    const api = await import('/assets/js/api-client.js');
    const user = { id: 12, departmentId: 3, role: 'worker', status: 'active' };
    api.saveSession(user);
    const els = Object.fromEntries([...document.querySelectorAll('[id]')].map((element) => [element.id, element]));
    const state = { user, workForms: [], workFormPhotoFiles: [], workFormPhotoBlobs: [], workFormPhotoDataUrls: [], workFormPhotoMetadata: [] };
    const messages = [];
    const photoViewer = createPhotoViewer({ viewer: els.photoViewer, image: els.photoViewerImage,
      caption: els.photoViewerCaption, closeButton: els.photoViewerClose,
      previousButton: els.photoViewerPrevious, nextButton: els.photoViewerNext });
    photoViewer.bindEvents();
    const form = createWorkerFormModule({ els, state, reportOnly: true, maxPhotos: 50,
      feedback: { clearLocal(element) { element?.replaceChildren(); }, setButtonBusy() {} }, photoViewer,
      findSiteByFormValue: () => null, renderStatusBanner: (message) => messages.push(message),
      syncQueueIfPossible: async () => {}, renderWorkerSummary: async () => {}, renderHistory: async () => {},
      handleSessionExpired() {}, isBackendSessionError: () => false });
    form.bindEvents();
    window.fixture = { form, state, els, messages, photoViewer };
    await form.refreshWorkForms();
    els.workFormSelect.value = '51';
    await form.renderSelectedWorkForm();
    els.workFormDate.value = '2026-09-29';
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 768;
    const drawing = canvas.getContext('2d');
    drawing.fillStyle = '#149cbb';
    drawing.fillRect(0, 0, canvas.width, canvas.height);
    drawing.fillStyle = '#fabb11';
    drawing.fillRect(100, 120, 680, 400);
    window.imageBytes = {};
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, type));
      window.imageBytes[type] = new Uint8Array(await blob.arrayBuffer());
    }
    window.originalFiles = new Map();
    window.dispatchPhotoBatch = (descriptions) => {
      const transfer = new DataTransfer();
      for (const [index, description] of descriptions.entries()) {
        const type = description.type || 'image/png';
        const encoded = window.imageBytes[type] || new Uint8Array([1, 2, 3]);
        const bytes = description.size ? new Uint8Array(description.size) : encoded;
        if (description.size) bytes.set(encoded.subarray(0, bytes.length));
        const file = new File([bytes], description.name, { type, lastModified: description.lastModified || 1790640000000 + index * 1000 });
        window.originalFiles.set(description.name, file);
        transfer.items.add(file);
      }
      els.workFormPhotos.files = transfer.files;
      els.workFormPhotos.dispatchEvent(new Event('change', { bubbles: true }));
    };
    window.blobHash = async (blob) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
      .map((part) => part.toString(16).padStart(2, '0')).join('');
  });
}

async function fixture(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const errors = [];
  const unexpected = [];
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      unexpected.push(url.href);
      return route.abort();
    }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: markup });
    if (url.pathname === '/assets/css/styles.css') return route.fulfill({ contentType: 'text/css', body: await readFile(path.join(root, 'assets/css/styles.css')) });
    if (url.pathname === '/api/work-forms') {
      assert.equal(url.searchParams.get('purpose'), 'report');
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify([{
        id: 51, department_id: 3, name: 'Photo selection', status: 'active', template_purpose: 'report', definition_version: 2,
        fields: [{ id: 'notes', type: 'text', label: 'Notes' }]
      }]) });
    }
    if (!/^\/assets\/js\/[a-z\d-]+\.js$/.test(url.pathname)) {
      unexpected.push(`${route.request().method()} ${url.pathname}`);
      return route.abort();
    }
    return route.fulfill({ contentType: 'text/javascript', body: await readFile(path.resolve(root, url.pathname.slice(1)), 'utf8') });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  await initialize(page);
  return { page, async close() {
    await context.close();
    assert.deepEqual(errors, [], 'No unhandled browser errors');
    assert.deepEqual(unexpected, [], 'Only isolated fixture resources and read-only Template API are used');
  } };
}

async function select(page, descriptions) {
  await page.evaluate(async (files) => {
    window.dispatchPhotoBatch(files);
    await window.fixture.form.flushPendingDrafts();
  }, descriptions);
}

async function snapshot(page) {
  return page.evaluate(async () => {
    const { state, els } = window.fixture;
    return {
      photos: await Promise.all(state.workFormPhotoBlobs.map(async (blob) => ({ type: blob.type, size: blob.size, hash: await window.blobHash(blob) }))),
      metadata: state.workFormPhotoMetadata,
      rejected: [...els.workFormPhotoSelectionFeedback.querySelectorAll('[data-photo-rejected-name]')].map((element) => element.textContent),
      reasons: [...els.workFormPhotoSelectionFeedback.querySelectorAll('[data-photo-rejected-reason]')].map((element) => element.textContent),
      feedback: els.workFormPhotoSelectionFeedback.textContent,
      inputValue: els.workFormPhotos.value,
      removeDisabled: [...els.workFormPhotoPreview.querySelectorAll('[data-remove-report-photo]')].some((button) => button.disabled)
    };
  });
}

const browser = await chromium.launch({ headless: true });
try {
  await mkdir(output, { recursive: true });
  const mixed = await fixture(browser);
  try {
    await select(mixed.page, [{ name: 'existing.jpg', type: 'image/jpeg' }]);
    const original = await snapshot(mixed.page);
    const unsafeName = '<img src=x onerror="window.photoNameInjected=true">.heic';
    const longName = `${'very-long-rejected-photo-'.repeat(12)}.png`;
    await select(mixed.page, [
      { name: unsafeName, type: 'image/heic' },
      { name: 'kept.jpg', type: 'image/jpeg' },
      { name: longName, size: maxBytes + 1 },
      { name: 'kept.webp', type: 'image/webp' }
    ]);
    const selected = await snapshot(mixed.page);
    assert.deepEqual(selected.metadata.map((item) => item.name), ['existing.jpg', 'kept.jpg', 'kept.webp']);
    assert.deepEqual(selected.photos[0], original.photos[0], 'Previously selected original is unchanged');
    assert.deepEqual(selected.rejected, [unsafeName, longName], 'Every rejected filename remains legible and in selection order');
    assert.match(selected.reasons[0], /JPEG|PNG|WebP/);
    assert.match(selected.reasons[1], /5\s*MB/);
    assert.equal(selected.inputValue, '', 'Input resets so the same file can be selected again');
    assert.equal(selected.removeDisabled, false, 'Partial rejection does not lock removal');
    assert.equal(await mixed.page.evaluate(() => Boolean(window.photoNameInjected || document.querySelector('#workFormPhotoSelectionFeedback img'))), false,
      'Rejected filenames are rendered as text, never executable markup');
    assert.equal(await mixed.page.evaluate(() => window.fixture.state.workFormPhotoBlobs.every((blob, index) =>
      blob === window.originalFiles.get(window.fixture.state.workFormPhotoMetadata[index].name))), true,
    'Accepted originals retain their exact File objects during selection');
    await mixed.page.waitForFunction(() => {
      const images = [...document.querySelectorAll('#workFormPhotoPreview .photo-thumb img')];
      return images.length === 3 && images.every((image) => !image.hidden && image.complete && image.naturalWidth > 0);
    });
    for (const width of [320, 390]) for (const language of ['en', 'zh']) for (const theme of ['light', 'dark']) {
      await mixed.page.setViewportSize({ width, height: 844 });
      await mixed.page.evaluate(async ({ language: nextLanguage, theme: nextTheme }) => {
        document.documentElement.dataset.theme = nextTheme;
        (await import('/assets/js/i18n.js')).setLanguage(nextLanguage);
      }, { language, theme });
      const layout = await mixed.page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(layout.scroll <= layout.width, `${width}px/${language}/${theme}: long and HTML-looking filenames do not overflow (${layout.scroll}/${layout.width})`);
      assert.equal(await mixed.page.locator('#workFormPhotoSelectionFeedback').isVisible(), true);
      const localized = await snapshot(mixed.page);
      assert.deepEqual(localized.rejected, [unsafeName, longName]);
      if (language === 'zh') assert.ok(localized.reasons.every((reason) => /[\u3400-\u9fff]/.test(reason)));
      const placeholders = mixed.page.locator('#workFormPhotoPreview .photo-thumb-placeholder');
      assert.equal(await placeholders.count(), 3, 'Each accepted photo has a transient preview placeholder');
      for (const placeholder of await placeholders.all()) {
        assert.equal(await placeholder.evaluate((element) => element.hidden), true);
        assert.equal(await placeholder.isVisible(), false, `${width}px/${language}/${theme}: completed previews hide their placeholders`);
        assert.equal(await placeholder.evaluate((element) => getComputedStyle(element).display), 'none', 'Author CSS must not override hidden placeholders');
      }
      const filename = `mixed-${width}-${language}${theme === 'dark' ? '-dark' : ''}.png`;
      await mixed.page.screenshot({ path: path.join(output, filename), fullPage: true, animations: 'disabled' });
    }
    await mixed.page.evaluate(async () => (await import('/assets/js/i18n.js')).setLanguage('en'));
    console.log('ok - mixed selection keeps valid originals and lists unsupported/oversized filenames safely');

    await select(mixed.page, [{ name: 'Remove', type: 'text/plain' }, { name: 'too-large.png', size: maxBytes + 1 }]);
    const rejected = await snapshot(mixed.page);
    assert.deepEqual(rejected.photos, selected.photos, 'All-rejected selection cannot discard existing originals');
    assert.deepEqual(rejected.metadata, selected.metadata);
    assert.deepEqual(rejected.rejected, ['Remove', 'too-large.png']);
    await select(mixed.page, []);
    assert.deepEqual(await snapshot(mixed.page), rejected, 'Cancelling the picker is a no-op, including the last rejection summary');
    await mixed.page.evaluate(async () => (await import('/assets/js/i18n.js')).setLanguage('zh'));
    const translated = await snapshot(mixed.page);
    assert.deepEqual(translated.rejected, rejected.rejected, 'Switching language cannot translate user-supplied filenames');
    assert.ok(translated.reasons.every((reason) => /[\u3400-\u9fff]/.test(reason)), 'Each rejection reason translates');
    await mixed.page.evaluate(async () => (await import('/assets/js/i18n.js')).setLanguage('en'));
    console.log('ok - all-rejected/cancel selections preserve evidence, controls and translated rejection details');

    await mixed.page.locator('#workFormPhotoPreview [data-photo-index="1"]').click();
    const opened = await mixed.page.evaluate(async () => {
      const image = window.fixture.els.photoViewerImage;
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight, hash: await window.blobHash(await (await fetch(image.src)).blob()) };
    });
    assert.equal(opened.width, 1024);
    assert.equal(opened.height, 768);
    assert.equal(opened.hash, selected.photos[1].hash, 'Opening a thumbnail uses the original evidence, not its display copy');
    await mixed.page.locator('#photoViewerClose').click();
    await mixed.page.locator('[data-remove-report-photo="1"]').click();
    await mixed.page.evaluate(() => window.fixture.form.flushPendingDrafts());
    const removed = await snapshot(mixed.page);
    assert.deepEqual(removed.photos, [selected.photos[0], selected.photos[2]]);
    assert.deepEqual(removed.metadata, [selected.metadata[0], selected.metadata[2]], 'Removal keeps metadata aligned with originals');
    await mixed.page.reload();
    await initialize(mixed.page);
    const restored = await snapshot(mixed.page);
    assert.deepEqual(restored.photos, removed.photos, 'Cold draft restoration preserves every original byte, type and size');
    assert.deepEqual(restored.metadata, removed.metadata);
    assert.deepEqual(restored.rejected, [], 'Rejection notices are transient, not evidence persisted into the draft');
    await select(mixed.page, [{ name: 'after-reload.png' }]);
    const appended = await snapshot(mixed.page);
    assert.deepEqual(appended.photos.slice(0, 2), removed.photos);
    assert.deepEqual(appended.metadata.map((item) => item.name), ['existing.jpg', 'kept.webp', 'after-reload.png']);
    console.log('ok - full-size viewing, removal, cold draft restoration and later additions preserve original bytes and metadata');
  } finally {
    await mixed.close();
  }

  const limits = await fixture(browser);
  try {
    await select(limits.page, Array.from({ length: 49 }, (_, index) => ({ name: `original-${index + 1}.png` })));
    await select(limits.page, [
      { name: 'unsupported-before-valid.heic', type: 'image/heic' },
      { name: 'oversized-before-valid.png', size: maxBytes + 1 },
      { name: 'last-valid.png', size: maxBytes },
      { name: 'over-limit.png' },
      { name: 'unsupported-after-limit.gif', type: 'image/gif' }
    ]);
    const result = await snapshot(limits.page);
    assert.equal(result.photos.length, 50);
    assert.equal(result.metadata.at(-1).name, 'last-valid.png', 'Rejected files do not consume the last available slot');
    assert.equal(result.photos.at(-1).size, maxBytes, 'The documented 5 MB boundary is inclusive');
    assert.deepEqual(result.rejected, ['unsupported-before-valid.heic', 'oversized-before-valid.png', 'over-limit.png', 'unsupported-after-limit.gif']);
    assert.match(result.reasons[2], /50/);
    assert.match(result.reasons[3], /JPEG|PNG|WebP/, 'Unsupported files retain their real rejection reason even when the Report is full');
    await select(limits.page, [{ name: 'also-over-limit.png' }]);
    const full = await snapshot(limits.page);
    assert.deepEqual(full.photos, result.photos);
    assert.deepEqual(full.rejected, ['also-over-limit.png']);
    assert.match(full.reasons[0], /50/);
    assert.equal(await limits.page.locator('#workFormPhotoPreview [data-remove-report-photo]').count(), 50);
    console.log('ok - validation precedes capacity, exactly 5 MB is accepted, and every over-limit selection is explained');
  } finally {
    await limits.close();
  }

  const concurrent = await fixture(browser);
  try {
    await concurrent.page.evaluate(async () => {
      window.dispatchPhotoBatch([{ name: 'batch-one.png' }, { name: 'bad-one.heic', type: 'image/heic' }]);
      window.dispatchPhotoBatch([{ name: 'batch-two.jpg', type: 'image/jpeg' }]);
      await window.fixture.form.flushPendingDrafts();
    });
    const result = await snapshot(concurrent.page);
    assert.deepEqual(result.metadata.map((item) => item.name), ['batch-one.png', 'batch-two.jpg']);
    assert.equal(result.removeDisabled, false);
    assert.deepEqual(result.rejected, [], 'The latest completed batch replaces the prior batch result');
    await select(concurrent.page, Array.from({ length: 47 }, (_, index) => ({ name: `filler-${index + 1}.png` })));
    await concurrent.page.evaluate(async () => {
      window.dispatchPhotoBatch([{ name: 'first-final-slot.png' }]);
      window.dispatchPhotoBatch([{ name: 'second-final-slot.png' }]);
      await window.fixture.form.flushPendingDrafts();
    });
    const full = await snapshot(concurrent.page);
    assert.equal(full.photos.length, 50, 'Concurrent batches share the same Report capacity');
    assert.equal(full.metadata.at(-1).name, 'first-final-slot.png');
    assert.deepEqual(full.rejected, ['second-final-slot.png']);
    console.log('ok - concurrent picker events serialize valid selections and share the 50-photo limit');
  } finally {
    await concurrent.close();
  }

  const stale = await fixture(browser);
  try {
    await stale.page.evaluate(async () => {
      window.dispatchPhotoBatch([{ name: 'stale.png' }, { name: 'stale.heic', type: 'image/heic' }]);
      window.fixture.form.clearSessionState();
      await new Promise(requestAnimationFrame);
    });
    const result = await snapshot(stale.page);
    assert.deepEqual(result.photos, []);
    assert.deepEqual(result.metadata, []);
    assert.deepEqual(result.rejected, [], 'A reset session cannot receive stale rejection messages');
    assert.equal(await stale.page.locator('#workFormPhotoPreview .photo-thumb').count(), 0);
    assert.equal(await stale.page.evaluate(async () => Boolean(await (await import('/assets/js/mock-api.js')).getDraft('work-form-draft:12:51'))), false,
      'A queued photo selection cannot save evidence after its Worker session is reset');
    console.log('ok - session reset invalidates queued photo work, previews, feedback and draft writes');
  } finally {
    await stale.close();
  }
} finally {
  await browser.close();
}
