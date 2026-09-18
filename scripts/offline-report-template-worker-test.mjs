import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59991'; // Intercepted only: no server or real network requests.
const worker = { id: 12, departmentId: 3, role: 'worker', status: 'active' };
let templates = [{
  id: 51, department_id: 3, name: 'Site inspection', description: 'Inspect the work area.',
  status: 'active', template_purpose: 'report', definition_version: 2,
  fields: [{ id: 'issue', type: 'text', label: 'Issue', required: true }]
}];
let apiStatus = 200;
let delayedResponse = null;
const markup = `<!doctype html><html lang="en"><body>
  <form id="workFormSubmissionForm">
    <select id="workFormSelect"><option value="">Select a Report Template</option></select>
    <input id="workFormDate" type="date"><select id="workFormSite"><option value=""></option></select>
    <div id="workFormFields"></div><input id="workFormPhotos" type="file" multiple>
    <div id="workFormPhotoPreview"></div><button id="submitWorkFormButton">Submit Report</button>
    <p id="workFormAutosaveStatus"></p><div id="workFormFeedback"></div>
  </form><button id="refreshHistoryButton">Refresh</button>
</body></html>`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await context.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, origin, 'No external requests are permitted');
  if (url.pathname === '/api/work-forms') {
    if (apiStatus === 0) return route.abort('internetdisconnected');
    const status = apiStatus;
    const body = JSON.stringify(
      apiStatus === 200 ? templates : { detail: 'Authorization unavailable' }
    );
    const delay = delayedResponse;
    delayedResponse = null;
    if (delay) {
      delay.started.resolve();
      await delay.finish.promise;
    }
    return route.fulfill({ status, contentType: 'application/json', body });
  }
  if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: markup });
  assert.match(url.pathname, /^\/assets\/js\/[a-z\d-]+\.js$/);
  return route.fulfill({ contentType: 'text/javascript', body: await readFile(path.join(projectRoot, url.pathname), 'utf8') });
});

async function openWorkerPage(page, user = worker) {
  await page.goto(origin);
  await page.evaluate(async (currentUser) => {
    const { createWorkerFormModule } = await import('/assets/js/worker-form.js');
    const els = Object.fromEntries([...document.querySelectorAll('[id]')].map((element) => [element.id, element]));
    const state = { user: currentUser, workForms: [], workFormPhotoFiles: [], workFormPhotoDataUrls: [], workFormPhotoMetadata: [] };
    const messages = [];
    const sources = [];
    let expired = false;
    const form = createWorkerFormModule({
      els, state, reportOnly: true, maxPhotos: 5,
      feedback: { clearLocal() {}, setButtonBusy() {} },
      photoViewer: { renderPreviews() {} }, findSiteByFormValue: () => null,
      renderStatusBanner: (message) => messages.push(message), syncQueueIfPossible: async () => {},
      renderWorkerSummary: async () => {}, renderHistory: async () => {},
      handleSessionExpired: () => { expired = true; },
      isBackendSessionError: (error) => [401, 403].includes(error?.status),
      onReportTemplateSourceChanged: (source) => sources.push(source)
    });
    form.bindEvents();
    window.fixture = { form, state, messages, sources, expired: () => expired };
    await form.refreshWorkForms();
  }, user);
}

async function checkAppSessionRestore(refreshStatus, currentUserStatus, expectSignedIn) {
  const appContext = await browser.newContext({ serviceWorkers: 'block' });
  const authRequests = [];
  await appContext.addInitScript(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
  });
  await appContext.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, origin, 'Session tests permit no external requests');
    if (url.pathname.startsWith('/api/')) {
      authRequests.push(url.pathname);
      const status = url.pathname === '/api/auth/refresh' ? refreshStatus
        : url.pathname === '/api/auth/me' ? currentUserStatus
          : url.pathname === '/api/work-forms' ? 0 : 200;
      if (status === 0) return route.abort('internetdisconnected');
      const body = status !== 200 ? { detail: 'Authentication rejected' }
        : url.pathname === '/api/auth/me' ? worker : [];
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (url.pathname === '/seed') return route.fulfill({ contentType: 'text/html', body: markup });
    const allowed = url.pathname === '/index.html' || url.pathname === '/manifest.webmanifest'
      || /^\/assets\/(js|css|icons)\/[a-z\d.-]+$/.test(url.pathname)
      || url.pathname === '/node_modules/leaflet/dist/leaflet-src.esm.js';
    assert.equal(allowed, true, `Unexpected local asset: ${url.pathname}`);
    const extension = path.extname(url.pathname);
    let body = await readFile(path.join(projectRoot, url.pathname));
    if (extension === '.js') {
      body = body.toString('utf8')
        .replaceAll("import L from 'leaflet';", "import * as L from '/node_modules/leaflet/dist/leaflet-src.esm.js';")
        .replace(/^import 'leaflet\/dist\/leaflet\.css';?\r?\n/gm, '');
    }
    return route.fulfill({ contentType: {
      '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
      '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json'
    }[extension] || 'application/octet-stream', body });
  });
  const page = await appContext.newPage();
  try {
    await page.goto(`${origin}/seed`);
    await page.evaluate(async ({ currentUser, savedTemplates }) => {
      const { saveSession } = await import('/assets/js/api-client.js');
      const { saveWorkerReportTemplateSnapshot } = await import('/assets/js/offline-report-template-snapshot.js');
      saveSession(currentUser);
      await saveWorkerReportTemplateSnapshot(currentUser, savedTemplates);
    }, { currentUser: worker, savedTemplates: templates });
    await page.goto(`${origin}/index.html`);
    if (expectSignedIn) {
      await page.locator('#workerView.active #workFormSelect option[value="51"]').waitFor({ state: 'attached', timeout: 10000 });
      assert.match(await page.locator('#reportTemplateAvailability').textContent(), /Using saved Report Templates/);
    } else {
      await page.getByText('Your saved backend session expired. Please sign in again.', { exact: true }).waitFor({ timeout: 10000 });
      assert.equal(await page.evaluate(() => localStorage.getItem('geo_user')), null);
      assert.equal(await page.evaluate(async (currentUser) => {
        const { loadWorkerReportTemplateSnapshot } = await import('/assets/js/offline-report-template-snapshot.js');
        return await loadWorkerReportTemplateSnapshot(currentUser);
      }, worker), null);
      assert.equal(authRequests.includes('/api/work-forms'), false);
    }
    if (refreshStatus === 403) assert.equal(authRequests.includes('/api/auth/me'), true);
  } finally {
    await appContext.close();
  }
}

async function checkSubmissionSessionReset(uploadStatus) {
  // Explicit module reset is a defensive contract test, not a claimed live
  // logout reproduction: the app itself blocks logout during submission.
  const originalWorker = { ...worker, id: 200 + uploadStatus };
  const replacementWorker = { ...worker, id: 1200 + uploadStatus };
  const page = await context.newPage();
  try {
    await openWorkerPage(page, originalWorker);
    await page.evaluate(async ({ currentWorker, status }) => {
      const api = await import('/assets/js/api-client.js');
      api.saveSession(currentWorker);
      const nativeFetch = window.fetch.bind(window);
      let release;
      const pendingUpload = new Promise((resolve) => { release = resolve; });
      window.fixture.releaseUpload = release;
      window.fetch = async (url, options) => {
        if (url !== '/api/photo-uploads') return nativeFetch(url, options);
        window.fixture.uploadStarted = true;
        await pendingUpload;
        return Response.json(status === 200 ? { url: '/uploads/previous-worker.png' }
          : { detail: 'Previous Worker session expired' }, { status });
      };
      window.fixture.selectPhoto = () => {
        const selected = new DataTransfer();
        selected.items.add(new File(['synthetic-photo'], 'fixture.png', { type: 'image/png' }));
        const picker = document.getElementById('workFormPhotos');
        picker.files = selected.files;
        picker.dispatchEvent(new Event('change', { bubbles: true }));
      };
    }, { currentWorker: originalWorker, status: uploadStatus });
    await page.locator('#workFormSelect').selectOption('51');
    await page.locator('#workFormField_issue').fill('Original Worker evidence');
    await page.evaluate(() => window.fixture.selectPhoto());
    await page.locator('#workFormAutosaveStatus.saved').waitFor();
    await page.locator('#submitWorkFormButton').click();
    await page.waitForFunction(() => window.fixture.uploadStarted);

    await page.evaluate(async (currentWorker) => {
      const { saveSession } = await import('/assets/js/api-client.js');
      window.fixture.form.clearSessionState();
      window.fixture.state.user = currentWorker;
      saveSession(currentWorker);
      await window.fixture.form.refreshWorkForms();
    }, replacementWorker);
    await page.locator('#workFormSelect').selectOption('51');
    await page.locator('#workFormField_issue').fill('Replacement Worker private draft');
    await page.evaluate(() => window.fixture.selectPhoto());
    await page.locator('#workFormAutosaveStatus.saved').waitFor();
    await page.evaluate(() => window.fixture.releaseUpload());
    await page.waitForFunction(async (oldWorkerId) => {
      const { getAll, get } = await import('/assets/js/db.js');
      const records = await getAll('records');
      return records.some((record) => record.ownerWorkerId === oldWorkerId && record.syncStatus === 'queued')
        && !await get('drafts', `work-form-draft:${oldWorkerId}:51`);
    }, originalWorker.id);
    const actual = await page.evaluate(async (currentWorker) => {
      const { getDraft } = await import('/assets/js/mock-api.js');
      return {
        issue: document.querySelector('#workFormField_issue')?.value,
        photos: window.fixture.state.workFormPhotoBlobs.length,
        expired: window.fixture.expired(),
        draftIssue: (await getDraft(`work-form-draft:${currentWorker.id}:51`))?.answers?.issue
      };
    }, replacementWorker);
    assert.deepEqual(actual, {
      issue: 'Replacement Worker private draft', photos: 1, expired: false,
      draftIssue: 'Replacement Worker private draft'
    });
    console.log(`ok - explicit module reset ignores previous Worker upload ${uploadStatus} completion without changing replacement draft`);
  } finally {
    await page.close();
  }
}

try {
  await checkSubmissionSessionReset(200);
  await checkSubmissionSessionReset(401);
  let page = await context.newPage();
  await openWorkerPage(page);
  assert.deepEqual(await page.locator('#workFormSelect option').allTextContents(), ['Select a Report Template', 'Site inspection']);
  await page.close();
  apiStatus = 0;
  page = await context.newPage();
  await openWorkerPage(page);
  assert.deepEqual(await page.locator('#workFormSelect option').allTextContents(), ['Select a Report Template', 'Site inspection']);
  assert.equal(await page.evaluate(() => window.fixture.form.hasOfflineTemplates()), true);
  console.log('ok - a new Worker page restores previously authenticated Templates when the API is unavailable');

  await page.locator('#workFormSelect').selectOption('51');
  await page.locator('#workFormField_issue').fill('Unsaved offline observation');
  apiStatus = 200;
  assert.equal(await page.evaluate(() => window.fixture.form.refreshAfterReconnect()), true);
  assert.equal(await page.locator('#workFormField_issue').inputValue(), 'Unsaved offline observation');
  assert.equal(await page.evaluate(() => window.fixture.form.hasOfflineTemplates()), false);
  console.log('ok - reconnect saves and restores current edits before replacing the downloaded Template');

  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  assert.equal(await page.evaluate(() => window.fixture.form.hasOfflineTemplates()), true);
  console.log('ok - an already-open page marks its authenticated Templates downloaded for reconnect revalidation');

  apiStatus = 0;
  await page.evaluate(() => window.fixture.form.refreshWorkForms());
  await page.locator('#workFormField_issue').fill('Keep this unsaved original observation');
  await page.evaluate(() => {
    window.originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'drafts') throw new DOMException('Draft storage full', 'QuotaExceededError');
      return window.originalPut.apply(this, args);
    };
  });
  templates = [{ ...templates[0], definition_version: 3, fields: [{ ...templates[0].fields[0], label: 'Updated issue' }] }];
  apiStatus = 200;
  assert.equal(await page.evaluate(() => window.fixture.form.refreshAfterReconnect()), false);
  assert.equal(await page.locator('#workFormField_issue').inputValue(), 'Keep this unsaved original observation');
  assert.equal(await page.evaluate(() => window.fixture.state.workForms[0].definition_version), 2);
  assert.equal(await page.evaluate(() => window.fixture.messages.some((message) => message.includes('were not refreshed'))), true);
  console.log('ok - a failed draft save pauses reconnect refresh without replacing the original fields or answers');

  await page.evaluate(() => { IDBObjectStore.prototype.put = window.originalPut; });
  assert.equal(await page.evaluate(() => window.fixture.form.refreshAfterReconnect()), true);
  assert.equal(await page.locator('#workFormField_issue').count(), 0);
  assert.match(await page.locator('#workFormFields').textContent(), /Issue: Keep this unsaved original observation/);
  assert.equal(await page.locator('#submitWorkFormButton').textContent(), 'Keep draft and start new report');
  assert.equal(await page.evaluate(async () => {
    const { getDraft } = await import('/assets/js/mock-api.js');
    return (await getDraft('work-form-draft:12:51')).definitionVersion;
  }), 2);
  console.log('ok - a newer online Definition preserves the original draft in the existing read-only recovery path');

  apiStatus = 403;
  await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }));
  assert.equal(await page.evaluate(() => window.fixture.form.refreshWorkForms()), false);
  assert.equal(await page.evaluate(() => window.fixture.expired()), true);
  assert.equal(await page.evaluate(async (currentUser) => {
    const { loadWorkerReportTemplateSnapshot } = await import('/assets/js/offline-report-template-snapshot.js');
    return await loadWorkerReportTemplateSnapshot(currentUser);
  }, worker), null);
  apiStatus = 0;
  await page.evaluate(() => window.fixture.form.refreshWorkForms());
  assert.deepEqual(await page.locator('#workFormSelect option').allTextContents(), ['Select a Report Template']);
  console.log('ok - explicit 403 invalidates downloaded Templates even when the browser reports offline');

  await page.close();
  apiStatus = 200;
  page = await context.newPage();
  await openWorkerPage(page);
  const olderResponse = { started: Promise.withResolvers(), finish: Promise.withResolvers() };
  delayedResponse = olderResponse;
  await page.evaluate(() => { window.olderRefresh = window.fixture.form.refreshWorkForms(); });
  await olderResponse.started.promise;
  templates = [{ ...templates[0], definition_version: 4, name: 'Latest inspection' }];
  await page.evaluate(() => window.fixture.form.refreshWorkForms());
  olderResponse.finish.resolve();
  await page.evaluate(() => window.olderRefresh);
  assert.equal(await page.evaluate(() => window.fixture.state.workForms[0].definition_version), 4);
  assert.equal(await page.evaluate(async (currentUser) => {
    const { loadWorkerReportTemplateSnapshot } = await import('/assets/js/offline-report-template-snapshot.js');
    return (await loadWorkerReportTemplateSnapshot(currentUser)).templates[0].definition_version;
  }, worker), 4);
  console.log('ok - a late older HTTP response cannot replace the latest visible or downloaded Definition');

  const previousSession = { started: Promise.withResolvers(), finish: Promise.withResolvers() };
  delayedResponse = previousSession;
  await page.evaluate(() => { window.previousSessionRefresh = window.fixture.form.refreshWorkForms(); });
  await previousSession.started.promise;
  await page.evaluate(async (currentUser) => {
    const { clearWorkerReportTemplateSnapshot } = await import('/assets/js/offline-report-template-snapshot.js');
    window.fixture.form.clearSessionState();
    window.fixture.state.user = { ...currentUser, id: 99 };
    await clearWorkerReportTemplateSnapshot(currentUser);
  }, worker);
  previousSession.finish.resolve();
  await page.evaluate(() => window.previousSessionRefresh);
  assert.deepEqual(await page.evaluate(() => window.fixture.state.workForms), []);
  assert.equal(await page.evaluate(async (currentUser) => {
    const { loadWorkerReportTemplateSnapshot } = await import('/assets/js/offline-report-template-snapshot.js');
    return await loadWorkerReportTemplateSnapshot(currentUser);
  }, worker), null);
  console.log('ok - a response from a cleared Worker session cannot restore its private Template list or snapshot');

  await checkAppSessionRestore(401, 0, false);
  await checkAppSessionRestore(403, 0, false);
  console.log('ok - offline app startup fails closed for explicit 401 and refresh 403 followed by unreachable /me');
  await checkAppSessionRestore(403, 200, true);
  await checkAppSessionRestore(0, 0, true);
  console.log('ok - validated /me recovery and network-only offline startup retain the exact Worker Template snapshot');
} finally {
  await context.close();
  await browser.close();
}
