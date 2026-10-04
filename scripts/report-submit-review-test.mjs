import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59977'; // All requests are intercepted; no hosted mutation is possible.
const output = path.join(root, 'output', 'report-submit-review.local');
const markup = `<!doctype html><html lang="en" data-theme="light"><head>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/assets/css/styles.css">
</head><body class="report-only-mode"><main style="padding:12px"><article class="card">
  <h2>New Report</h2><form id="workFormSubmissionForm" class="form-grid">
  <div id="workFormEditor" class="form-grid">
    <label>Report Template<select id="workFormSelect"></select></label>
    <div class="report-context-fields form-grid"><label>Report Date<input id="workFormDate" type="date"></label>
    <label>Site (optional)<select id="workFormSite"><option value="">Unassigned site</option><option value="9">Harbour Site</option></select></label></div>
    <div id="workFormFields" class="dynamic-fields"></div>
    <label class="report-photo-field">Photos<input id="workFormPhotos" type="file" multiple>
      <small>JPEG, PNG, or WebP; maximum 5 MB each.</small><small id="workFormPhotoLimit"></small></label>
    <div id="workFormPhotoSelectionFeedback" role="status" hidden></div>
    <div id="workFormPhotoPreview" class="photo-preview hidden"></div>
    <button id="submitWorkFormButton">Review &amp; submit</button>
  </div>
  <section id="workFormReviewPanel" class="report-submit-review" hidden aria-labelledby="workFormReviewHeading">
    <h3 id="workFormReviewHeading" tabindex="-1">Review &amp; submit</h3>
    <p class="muted">Check the details below. Submitted Reports cannot be edited.</p>
    <div id="workFormReviewSummary"></div>
    <p id="workFormReviewPhotoWarning" class="report-review-warning" hidden>Some selected files were not added. Go back to see details.</p>
    <div class="report-review-actions"><button id="workFormReviewBackButton" type="button" class="ghost">Back to edit</button>
    <button id="confirmWorkFormSubmitButton" type="button">Submit Report</button></div>
  </section>
  <p id="workFormPhotoStatus" class="muted" role="status"></p>
  <p id="workFormAutosaveStatus" class="autosave-status" role="status"></p>
  <div id="workFormFeedback" role="status"></div>
  </form></article><button id="refreshHistoryButton">Refresh</button></main>
  <div id="photoViewer" class="hidden" role="dialog" aria-modal="true">
    <button id="photoViewerClose" type="button">Close</button><button id="photoViewerPrevious" type="button">Previous</button>
    <img id="photoViewerImage"><p id="photoViewerCaption"></p><button id="photoViewerNext" type="button">Next</button>
  </div></body></html>`;

const fields = [
  { id: 'notes', type: 'textarea', label: 'What happened?', required: true },
  { id: 'checked', type: 'checkbox', label: 'Area checked' },
  { id: 'signature', type: 'signature', label: 'Worker signature', required: true },
  { id: 'witness', type: 'signature', label: 'Witness signature' }
];

async function fixture(browser, options = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const errors = [];
  const unexpected = [];
  const traffic = { posts: [], uploads: [], version: 2, fields, release: null, hold: false };
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
      return route.fulfill({ json: [{ id: 51, department_id: 3, name: 'Site condition Report', status: 'active',
        template_purpose: 'report', definition_version: traffic.version, fields: traffic.fields }] });
    }
    if (url.pathname === '/api/photo-uploads') {
      assert.equal(route.request().method(), 'POST');
      traffic.uploads.push(route.request().postDataBuffer());
      return route.fulfill({ json: { url: `/uploads/review-evidence-${traffic.uploads.length}.png` } });
    }
    if (url.pathname === '/api/form-submissions') {
      const body = route.request().postDataJSON();
      traffic.posts.push(body);
      if (traffic.hold) await new Promise((resolve) => { traffic.release = resolve; });
      return route.fulfill({ json: { id: 701, worker_id: 12, form_id: 51, status: 'submitted', submission_purpose: 'report',
        photo_urls: body.photo_urls, answers: body.answers, work_date: body.work_date } });
    }
    if (!/^\/assets\/js\/[a-z\d-]+\.js$/.test(url.pathname)) {
      unexpected.push(`${route.request().method()} ${url.pathname}`);
      return route.abort();
    }
    let body = await readFile(path.resolve(root, url.pathname.slice(1)), 'utf8');
    if (url.pathname === '/assets/js/worker-form.js') {
      const boundary = 'async function processPhotoChange(selectedFiles, token, draftState, scope) {';
      assert.ok(body.includes(boundary), 'Controlled photo-preparation boundary must remain exact');
      body = body.replace(boundary, `${boundary}
        if (window.photoGate) { window.photoGateEntered = true; await window.photoGate; }`);
      const waitBoundary = 'async function waitForDraftPhotos(draftState) {';
      assert.ok(body.includes(waitBoundary), 'Controlled confirmation-await boundary must remain exact');
      body = body.replace(waitBoundary, `${waitBoundary}
        if (window.confirmationGate) { window.confirmationGateEntered = true; await window.confirmationGate; }`);
    }
    if (url.pathname === '/assets/js/db.js') {
      const boundary = 'export async function put(storeName, value) {';
      assert.ok(body.includes(boundary), 'Controlled durable-write boundary must remain exact');
      body = body.replace(boundary, `${boundary}
        if (window.failRecordWrites && storeName === 'records') throw new Error('Device storage is temporarily unavailable.');`);
    }
    return route.fulfill({ contentType: 'text/javascript', body });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  await page.evaluate(async ({ selectedFields, requireSignature }) => {
    const { createWorkerFormModule } = await import('/assets/js/worker-form.js');
    const { createPhotoViewer } = await import('/assets/js/photo-viewer.js');
    const api = await import('/assets/js/api-client.js');
    const db = await import('/assets/js/db.js');
    const user = { id: 12, departmentId: 3, role: 'worker', status: 'active', fullName: 'Test Worker' };
    api.saveSession(user);
    const els = Object.fromEntries([...document.querySelectorAll('[id]')].map((element) => [element.id, element]));
    const state = { user, workForms: [], workFormPhotoFiles: [], workFormPhotoBlobs: [], workFormPhotoDataUrls: [], workFormPhotoMetadata: [] };
    const messages = [];
    const photoViewer = createPhotoViewer({ viewer: els.photoViewer, image: els.photoViewerImage, caption: els.photoViewerCaption,
      closeButton: els.photoViewerClose, previousButton: els.photoViewerPrevious, nextButton: els.photoViewerNext });
    photoViewer.bindEvents();
    const form = createWorkerFormModule({ els, state, reportOnly: true, maxPhotos: 50,
      feedback: {
        clearLocal(element) { element?.replaceChildren(); },
        setButtonBusy(button, busy, text) {
          if (busy) { button.dataset.idleText = button.textContent; button.textContent = text; }
          else if (button.dataset.idleText) { button.textContent = button.dataset.idleText; delete button.dataset.idleText; }
        }
      }, photoViewer,
      findSiteByFormValue: (value) => String(value) === '9' ? { id: 9, name: 'Harbour Site' } : null,
      renderStatusBanner: (message, _warning, config = {}) => {
        messages.push(message);
        if (config.local) config.local.textContent = message;
        config.field?.focus();
      },
      syncQueueIfPossible: async () => {}, renderWorkerSummary: async () => {}, renderHistory: async () => {},
      handleSessionExpired() {}, isBackendSessionError: () => false });
    form.bindEvents();
    window.fixture = { form, state, els, messages, photoViewer, db, fields: selectedFields };
    await form.refreshWorkForms();
    els.workFormSelect.value = '51';
    await form.renderSelectedWorkForm();
    els.workFormDate.value = '2026-09-29';
    els.workFormSite.value = '9';
    window.addPhoto = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 1024; canvas.height = 768;
      const drawing = canvas.getContext('2d');
      drawing.fillStyle = '#28aab6'; drawing.fillRect(0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const file = new File([blob], 'site-evidence.png', { type: 'image/png', lastModified: 1790640000000 });
      window.originalPhoto = file;
      const transfer = new DataTransfer(); transfer.items.add(file);
      els.workFormPhotos.files = transfer.files;
      els.workFormPhotos.dispatchEvent(new Event('change', { bubbles: true }));
    };
    window.sign = () => {
      const canvas = document.querySelector('#workFormField_signature');
      if (!canvas) return;
      const drawing = canvas.getContext('2d');
      drawing.beginPath(); drawing.moveTo(20, 30); drawing.lineTo(100, 80); drawing.lineTo(180, 20); drawing.stroke();
      canvas.dataset.signed = 'true';
      canvas.dispatchEvent(new Event('input', { bubbles: true }));
    };
    if (!requireSignature) {
      // Most test groups use complete evidence; validation gets its own blank-pad group.
      window.sign();
    }
  }, { selectedFields: fields, requireSignature: Boolean(options.blankSignature) });
  return { context, page, traffic, async close() {
    traffic.release?.();
    await context.close();
    assert.deepEqual(errors, [], 'No unhandled browser errors');
    assert.deepEqual(unexpected, [], 'Only isolated local resources and mocked Report APIs were used');
  } };
}

async function fill(page, text = 'Loose fitting beside access gate. Keep walkway clear.') {
  await page.locator('#workFormField_notes').fill(text);
  if (!await page.locator('#workFormField_checked').isChecked()) {
    await page.locator('label').filter({ has: page.locator('#workFormField_checked') }).click();
  }
}

async function review(page) {
  await page.locator('#submitWorkFormButton').click();
  await page.locator('#workFormReviewPanel').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#confirmWorkFormSubmitButton').disabled);
}

async function storage(page) {
  return page.evaluate(async () => ({
    records: await window.fixture.db.getAll('records'),
    queue: await window.fixture.db.getAll('queue'),
    draft: await (await import('/assets/js/mock-api.js')).getDraft('work-form-draft:12:51')
  }));
}

async function assertUnsubmitted(fixtureToCheck) {
  assert.equal(fixtureToCheck.traffic.posts.length, 0, 'Review never creates a durable Report');
  assert.equal(fixtureToCheck.traffic.uploads.length, 0, 'Review never uploads photos or signatures');
  const saved = await storage(fixtureToCheck.page);
  assert.equal(saved.records.length, 0, 'Review never creates local submission records');
  assert.equal(saved.queue.length, 0, 'Review never queues a submission');
  return saved;
}

const browser = await chromium.launch({ headless: true });
try {
  await mkdir(output, { recursive: true });
  const validation = await fixture(browser, { blankSignature: true });
  try {
    await validation.page.locator('#workFormDate').fill('');
    await validation.page.locator('#submitWorkFormButton').click();
    assert.equal(await validation.page.locator('#workFormReviewPanel').isVisible(), false);
    await validation.page.locator('#workFormDate').fill('2026-09-29');
    await validation.page.locator('#submitWorkFormButton').click();
    assert.equal(await validation.page.locator('#workFormReviewPanel').isVisible(), false);
    await fill(validation.page);
    await validation.page.locator('#submitWorkFormButton').click();
    await validation.page.waitForFunction(() => window.fixture.messages.some((message) => /signature/i.test(message)));
    assert.equal(await validation.page.locator('#workFormReviewPanel').isVisible(), false, 'A required blank signature prevents review');
    await assertUnsubmitted(validation);
    await validation.page.evaluate(() => window.sign());
    await review(validation.page);
    await assertUnsubmitted(validation);
    console.log('ok - Report Date, required answers and required signatures are validated before entering review');
  } finally { await validation.close(); }

  const editing = await fixture(browser);
  try {
    const unsafeAnswer = '<img src=x onerror="window.answerInjected=true"> Keep original evidence.';
    await fill(editing.page, unsafeAnswer);
    await editing.page.evaluate(async () => {
      await window.addPhoto();
      await window.fixture.form.flushPendingDrafts();
      window.originalInput = document.querySelector('#workFormField_notes');
      window.originalSignature = document.querySelector('#workFormField_signature');
      window.originalSignatureData = window.originalSignature.toDataURL();
    });
    await review(editing.page);
    const saved = await assertUnsubmitted(editing);
    assert.equal(saved.draft.answers.notes, unsafeAnswer);
    assert.equal(saved.draft.photoBlobs.length, 1, 'Review flushes the original draft, not a submission');
    const summary = await editing.page.locator('#workFormReviewSummary').innerText();
    assert.match(summary, /2026|29/);
    assert.match(summary, /Harbour Site/);
    assert.ok(summary.includes(unsafeAnswer), 'Answer text is visibly reviewable');
    assert.match(summary, /What happened\?/);
    assert.match(summary, /Area checked/);
    assert.match(summary, /photo/i);
    assert.match(summary, /1/);
    assert.match(summary, /Worker signature/);
    assert.match(summary, /Witness signature/);
    assert.equal(await editing.page.evaluate(() => Boolean(window.answerInjected)), false, 'User answers never become executable markup');
    assert.equal(await editing.page.locator('#workFormEditor').isVisible(), false);
    assert.equal(await editing.page.locator('#workFormReviewSummary img').count(), 1, 'Only the provided signature is shown; photos use a count');
    assert.equal(await editing.page.evaluate(() => document.activeElement.id), 'workFormReviewHeading', 'Review has a stable keyboard focus target');
    assert.equal(await editing.page.locator('#workFormAutosaveStatus').isVisible(), true);

    for (const width of [320, 390]) for (const language of ['en', 'zh']) for (const theme of ['light', 'dark']) {
      await editing.page.setViewportSize({ width, height: 844 });
      await editing.page.evaluate(async ({ language: nextLanguage, theme: nextTheme }) => {
        document.documentElement.dataset.theme = nextTheme;
        (await import('/assets/js/i18n.js')).setLanguage(nextLanguage);
      }, { language, theme });
      const layout = await editing.page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(layout.scroll <= layout.width, `${width}px/${language}/${theme}: review must not overflow horizontally (${layout.scroll}/${layout.width})`);
      assert.equal(await editing.page.locator('#confirmWorkFormSubmitButton').isVisible(), true);
      if (language === 'zh') assert.match(await editing.page.locator('#confirmWorkFormSubmitButton').innerText(), /[\u3400-\u9fff]/);
      await editing.page.screenshot({ path: path.join(output, `review-${width}-${language}-${theme}.png`), fullPage: true, animations: 'disabled' });
    }
    await editing.page.evaluate(async () => (await import('/assets/js/i18n.js')).setLanguage('en'));
    await editing.page.locator('#workFormReviewBackButton').click();
    assert.equal(await editing.page.locator('#workFormReviewPanel').isVisible(), false);
    const retained = await editing.page.evaluate(() => ({
      input: window.originalInput === document.querySelector('#workFormField_notes'),
      canvas: window.originalSignature === document.querySelector('#workFormField_signature'),
      signature: window.originalSignatureData === document.querySelector('#workFormField_signature').toDataURL(),
      photo: window.originalPhoto === window.fixture.state.workFormPhotoBlobs[0],
      focus: document.activeElement.id
    }));
    assert.deepEqual(retained, { input: true, canvas: true, signature: true, photo: true, focus: 'submitWorkFormButton' },
      'Back restores the original editable surface, exact signature/photo objects, and sensible focus');
    await fill(editing.page, 'Corrected: fitting secured and walkway clear.');
    await editing.page.locator('#workFormDate').fill('2026-09-28');
    await editing.page.locator('#workFormSite').selectOption('');
    await review(editing.page);
    const corrected = await editing.page.locator('#workFormReviewSummary').innerText();
    assert.match(corrected, /Corrected: fitting secured/);
    assert.ok(!corrected.includes(unsafeAnswer), 'Returning to review builds the updated snapshot');
    assert.ok(!corrected.includes('Harbour Site'));
    await assertUnsubmitted(editing);
    editing.traffic.hold = true;
    await editing.page.evaluate(() => {
      const button = document.querySelector('#confirmWorkFormSubmitButton');
      button.click(); button.click();
      document.querySelector('#workFormSubmissionForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await editing.page.waitForFunction(() => window.fixture.state.submittingWorkForm);
    const submissionDeadline = Date.now() + 15000;
    while (!editing.traffic.posts.length && Date.now() < submissionDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(editing.traffic.posts.length, 1, 'Repeated confirmation cannot create duplicate Reports');
    assert.equal(editing.traffic.uploads.length, 2, 'Only the original photo and provided signature are uploaded');
    assert.equal(editing.traffic.posts[0].answers.notes, 'Corrected: fitting secured and walkway clear.');
    assert.equal(editing.traffic.posts[0].work_date, '2026-09-28');
    assert.equal(editing.traffic.posts[0].site_id, null);
    assert.equal(await editing.page.locator('#confirmWorkFormSubmitButton').isDisabled(), true);
    editing.traffic.release();
    await editing.page.waitForFunction(() => !window.fixture.state.submittingWorkForm);
    assert.equal(await editing.page.locator('#workFormReviewPanel').isVisible(), false);
    assert.equal((await storage(editing.page)).draft, null);
    console.log('ok - compact review shows safe answers/context/evidence, Back preserves originals, and one confirmation submits the corrected snapshot once');
  } finally { await editing.close(); }

  const pending = await fixture(browser);
  try {
    await fill(pending.page);
    await pending.page.evaluate(async () => {
      window.photoGate = new Promise((resolve) => { window.releasePhoto = resolve; });
      await window.addPhoto();
    });
    await pending.page.waitForFunction(() => window.photoGateEntered);
    await pending.page.locator('#submitWorkFormButton').click();
    assert.equal(await pending.page.locator('#workFormReviewPanel').isVisible(), false, 'Review cannot omit a still-preparing selected photo');
    await assertUnsubmitted(pending);
    await pending.page.evaluate(() => { window.releasePhoto(); window.photoGate = null; });
    await pending.page.locator('#workFormReviewPanel').waitFor({ state: 'visible' });
    assert.equal((await storage(pending.page)).draft.photoBlobs.length, 1);
    assert.match(await pending.page.locator('#workFormReviewSummary').innerText(), /1/);
    await assertUnsubmitted(pending);
    console.log('ok - review waits for selected photos and the protected draft before rendering its snapshot');
  } finally { await pending.close(); }

  const offline = await fixture(browser);
  try {
    await fill(offline.page, 'Offline inspection remains editable until confirmed.');
    await offline.page.evaluate(async () => { await window.addPhoto(); await window.fixture.form.flushPendingDrafts(); });
    await offline.context.setOffline(true);
    await offline.page.waitForFunction(() => !navigator.onLine);
    await review(offline.page);
    await assertUnsubmitted(offline);
    await offline.page.locator('#confirmWorkFormSubmitButton').click();
    // Playwright's predicate loop does not poll a Promise's resolved false value.
    // Wait on synchronous completion state, then inspect the durable stores.
    await offline.page.waitForFunction(() => !window.fixture.state.submittingWorkForm
      && window.fixture.messages.some((message) => /saved offline and queued/.test(message)));
    const queued = await storage(offline.page);
    assert.equal(queued.records.length, 1);
    assert.equal(queued.queue.length, 1);
    assert.equal(queued.records[0].answers.notes, 'Offline inspection remains editable until confirmed.');
    assert.equal(queued.records[0].photoBlobs.length, 1);
    assert.ok(queued.records[0].answers.signature.startsWith('data:image/'));
    assert.equal(offline.traffic.uploads.length, 0);
    assert.equal(offline.traffic.posts.length, 0);
    assert.equal(await offline.page.locator('#workFormReviewPanel').isVisible(), false);
    console.log('ok - offline review stays a draft and only explicit confirmation creates one intact queued Report');
  } finally { await offline.close(); }

  const changedSite = await fixture(browser);
  try {
    await fill(changedSite.page, 'Site options can refresh while selected photos prepare.');
    await changedSite.page.evaluate(async () => {
      window.photoGate = new Promise((resolve) => { window.releasePhoto = resolve; });
      await window.addPhoto();
    });
    await changedSite.page.waitForFunction(() => window.photoGateEntered);
    await changedSite.page.locator('#submitWorkFormButton').click();
    await changedSite.page.evaluate(() => {
      document.querySelector('#workFormSite').replaceChildren(new Option('Unassigned site', ''));
      window.releasePhoto(); window.photoGate = null;
    });
    await changedSite.page.locator('#workFormReviewPanel').waitFor({ state: 'visible' });
    const summary = await changedSite.page.locator('#workFormReviewSummary').innerText();
    assert.ok(!summary.includes('Harbour Site'), 'Review must not retain a Site captured before asynchronous photo preparation');
    assert.match(summary, /No site selected/);
    await assertUnsubmitted(changedSite);
    await changedSite.page.locator('#confirmWorkFormSubmitButton').click();
    await changedSite.page.waitForFunction(() => !window.fixture.state.submittingWorkForm && document.querySelector('#workFormReviewPanel').hidden);
    assert.equal(changedSite.traffic.posts.length, 1);
    assert.equal(changedSite.traffic.posts[0].site_id, null, 'Submission matches the Site shown in the completed review');
    console.log('ok - Site changes during photo preparation are reflected consistently in review and submitted context');
  } finally { await changedSite.close(); }

  const failed = await fixture(browser);
  try {
    await fill(failed.page, 'Keep this Report through a storage failure.');
    await failed.page.evaluate(async () => { await window.addPhoto(); await window.fixture.form.flushPendingDrafts(); });
    await review(failed.page);
    await failed.page.evaluate(() => { window.failRecordWrites = true; });
    await failed.page.locator('#confirmWorkFormSubmitButton').click();
    await failed.page.waitForFunction(() => !window.fixture.state.submittingWorkForm && window.fixture.messages.some((message) => /storage is temporarily unavailable/.test(message)));
    const retained = await assertUnsubmitted(failed);
    assert.equal(retained.draft.answers.notes, 'Keep this Report through a storage failure.');
    assert.equal(retained.draft.photoBlobs.length, 1);
    if (await failed.page.locator('#workFormReviewPanel').isVisible()) await failed.page.locator('#workFormReviewBackButton').click();
    assert.equal(await failed.page.locator('#workFormField_notes').inputValue(), 'Keep this Report through a storage failure.');
    assert.equal(await failed.page.evaluate(() => window.fixture.state.workFormPhotoBlobs[0] === window.originalPhoto), true);
    assert.equal(await failed.page.locator('#workFormField_signature').getAttribute('data-signed'), 'true');
    await failed.page.evaluate(() => { window.failRecordWrites = false; });
    await review(failed.page);
    await failed.page.locator('#confirmWorkFormSubmitButton').click();
    await failed.page.waitForFunction(() => !window.fixture.state.submittingWorkForm && document.querySelector('#workFormReviewPanel').hidden);
    assert.equal(failed.traffic.posts.length, 1);
    console.log('ok - a failed durable save retains answers/photos/signature and the user can retry successfully');
  } finally { await failed.close(); }

  const guarded = await fixture(browser);
  try {
    await fill(guarded.page, 'This is the reviewed answer.');
    await review(guarded.page);
    await guarded.page.evaluate(() => {
      document.querySelector('#workFormField_notes').value = 'This changed without an input event.';
      document.querySelector('#confirmWorkFormSubmitButton').click();
    });
    await guarded.page.locator('#workFormEditor').waitFor({ state: 'visible' });
    await assertUnsubmitted(guarded);
    assert.equal(await guarded.page.locator('#workFormField_notes').inputValue(), 'This changed without an input event.');
    assert.match(await guarded.page.locator('#workFormFeedback').innerText(), /review.*again/i);
    await review(guarded.page);
    assert.match(await guarded.page.locator('#workFormReviewSummary').innerText(), /This changed without an input event/);
    const update = await guarded.page.evaluate(() => window.fixture.form.prepareForAppUpdate());
    assert.equal(update.safe, true, 'The hidden editable surface remains available to draft protection before an app update');
    assert.equal((await storage(guarded.page)).draft.answers.notes, 'This changed without an input event.');
    await guarded.page.evaluate(() => document.querySelector('#confirmWorkFormSubmitButton').click());
    await assertUnsubmitted(guarded);
    await guarded.page.evaluate(() => window.fixture.form.cancelAppUpdatePreparation());
    await guarded.page.locator('#workFormReviewBackButton').click();
    assert.equal(await guarded.page.locator('#workFormField_notes').inputValue(), 'This changed without an input event.');
    console.log('ok - silent editor changes require a fresh review and app-update preparation protects the current draft');
  } finally { await guarded.close(); }

  const finalRace = await fixture(browser);
  try {
    await fill(finalRace.page, 'Final confirmation must recheck asynchronous changes.');
    await review(finalRace.page);
    await finalRace.page.evaluate(() => {
      window.confirmationGate = new Promise((resolve) => { window.releaseConfirmation = resolve; });
      document.querySelector('#confirmWorkFormSubmitButton').click();
    });
    await finalRace.page.waitForFunction(() => window.confirmationGateEntered);
    await finalRace.page.evaluate(() => {
      document.querySelector('#workFormSite').replaceChildren(new Option('Unassigned site', ''));
      window.releaseConfirmation(); window.confirmationGate = null;
    });
    await finalRace.page.waitForFunction(() => !window.fixture.state.submittingWorkForm && document.querySelector('#workFormReviewPanel').hidden);
    await assertUnsubmitted(finalRace);
    assert.equal(await finalRace.page.locator('#workFormField_notes').inputValue(), 'Final confirmation must recheck asynchronous changes.');
    assert.match(await finalRace.page.locator('#workFormFeedback').innerText(), /review.*again/i);
    console.log('ok - context changed during final confirmation awaits requires a fresh review, without an upload or queued record');
  } finally { await finalRace.close(); }

  const pendingReset = await fixture(browser);
  try {
    await fill(pendingReset.page, 'A previous session cannot finish preparing a review.');
    await pendingReset.page.evaluate(async () => {
      window.photoGate = new Promise((resolve) => { window.releasePhoto = resolve; });
      await window.addPhoto();
    });
    await pendingReset.page.waitForFunction(() => window.photoGateEntered);
    await pendingReset.page.locator('#submitWorkFormButton').click();
    await pendingReset.page.evaluate(async () => {
      window.fixture.form.clearSessionState();
      window.releasePhoto(); window.photoGate = null;
      await new Promise(requestAnimationFrame);
    });
    assert.equal(await pendingReset.page.locator('#workFormReviewPanel').isVisible(), false);
    assert.equal(await pendingReset.page.evaluate(() => window.fixture.state.workFormPhotoBlobs.length), 0);
    await assertUnsubmitted(pendingReset);
    console.log('ok - resetting a session cancels an in-flight review preparation and its unfinished photos');
  } finally { await pendingReset.close(); }

  for (const reason of ['session', 'template', 'reconnect']) {
    const stale = await fixture(browser);
    try {
      await fill(stale.page, 'Never submit an outdated confirmation.');
      await review(stale.page);
      if (reason === 'session') await stale.page.evaluate(() => window.fixture.form.clearSessionState());
      if (reason === 'template') {
        stale.traffic.version = 3;
        stale.traffic.fields = [...fields, { id: 'updated', type: 'text', label: 'New question' }];
        await stale.page.evaluate(() => window.fixture.form.refreshWorkForms());
      }
      if (reason === 'reconnect') {
        await stale.context.setOffline(true);
        await stale.page.waitForFunction(() => !navigator.onLine && window.fixture.form.hasOfflineTemplates());
        await stale.context.setOffline(false);
        await stale.page.waitForFunction(() => navigator.onLine);
        await stale.page.evaluate(() => window.fixture.form.refreshAfterReconnect());
      }
      assert.equal(await stale.page.locator('#workFormReviewPanel').isVisible(), false, `${reason} invalidates an already-visible review`);
      await stale.page.evaluate(() => document.querySelector('#confirmWorkFormSubmitButton').click());
      await assertUnsubmitted(stale);
      console.log(`ok - ${reason} changes invalidate stale confirmation without submitting or queuing`);
    } finally { await stale.close(); }
  }
} finally {
  await browser.close();
}
