import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = 'http://127.0.0.1:59986';
const markup = `<!doctype html><form id="workFormSubmissionForm">
  <select id="workFormSelect"></select><input id="workFormDate" type="date">
  <select id="workFormSite"><option value=""></option></select><div id="workFormFields"></div>
  <input id="workFormPhotos" type="file" multiple><div id="workFormPhotoPreview"></div>
  <button id="submitWorkFormButton">Submit Report</button><p id="workFormAutosaveStatus"></p>
  <div id="workFormFeedback"></div></form><button id="refreshHistoryButton">Refresh</button>`;
const browser = await chromium.launch({ headless: true });
try {
  for (const pendingSelection of [true, false]) {
    const context = await browser.newContext();
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, origin, 'No external requests');
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: markup });
      if (url.pathname === '/api/work-forms') return route.fulfill({ contentType: 'application/json', body: JSON.stringify([{
        id: 51, department_id: 3, name: 'Submission lock', status: 'active', template_purpose: 'report', definition_version: 2,
        fields: [{ id: 'replacement', type: 'text', label: 'Replacement' }]
      }]) });
      assert.match(url.pathname, /^\/assets\/js\/[a-z\d-]+\.js$/);
      let body = await readFile(path.resolve(url.pathname.slice(1)), 'utf8');
      if (url.pathname === '/assets/js/db.js') {
        const boundary = 'await writeStore(openReportDb, storeName, (store) => store.put(envelope));';
        assert.ok(body.includes(boundary), 'Controlled pre-commit boundary must remain exact');
        body = body.replace(boundary, `if (storeName === 'drafts' && window.pauseDraftWrite) {
          window.writePaused = true; await window.pauseDraftWrite;
        } ${boundary}`);
      }
      return route.fulfill({ contentType: 'text/javascript', body });
    });
    const page = await context.newPage();
    try {
      await page.goto(origin);
      await page.evaluate(async () => {
        const { createWorkerFormModule } = await import('/assets/js/worker-form.js');
        const api = await import('/assets/js/api-client.js');
        const user = { id: 12, departmentId: 3, role: 'worker', status: 'active' };
        api.saveSession(user);
        const els = Object.fromEntries([...document.querySelectorAll('[id]')].map((element) => [element.id, element]));
        const state = { user, workForms: [], workFormPhotoFiles: [], workFormPhotoDataUrls: [], workFormPhotoMetadata: [] };
        const messages = [];
        window.posts = [];
        const pendingResponse = new Promise((resolve) => { window.releaseSubmission = resolve; });
        const nativeFetch = window.fetch.bind(window);
        window.fetch = async (url, options) => {
          if (url !== '/api/form-submissions') return nativeFetch(url, options);
          const body = JSON.parse(options.body);
          window.posts.push(body);
          await pendingResponse;
          return Response.json({ id: 701, worker_id: 12, status: 'pending', photo_urls: [], answers: body.answers });
        };
        const form = createWorkerFormModule({ els, state, reportOnly: true, maxPhotos: 50,
          feedback: { clearLocal() {}, setButtonBusy() {} }, photoViewer: { renderPreviews() {} },
          findSiteByFormValue: () => null, renderStatusBanner: (message) => messages.push(message),
          syncQueueIfPossible: async () => {}, renderWorkerSummary: async () => {}, renderHistory: async () => {},
          handleSessionExpired() {}, isBackendSessionError: () => false });
        form.bindEvents();
        window.fixture = { form, state, els, messages };
        await form.refreshWorkForms();
        els.workFormSelect.value = '51';
        await form.renderSelectedWorkForm();
        els.workFormDate.value = '2026-09-18';
      });
      await page.locator('#workFormField_replacement').fill('first snapshot');
      if (pendingSelection) {
        await page.evaluate(() => {
          window.pauseDraftWrite = new Promise((resolve) => { window.releaseDraft = resolve; });
          window.pendingRender = window.fixture.form.renderSelectedWorkForm();
        });
        await page.waitForFunction(() => window.writePaused);
      }
      await page.locator('#workFormField_replacement').fill('latest replacement');
      await page.evaluate(() => { window.originalInput = document.querySelector('#workFormField_replacement'); });
      await page.locator('#submitWorkFormButton').click();
      if (pendingSelection) await page.evaluate(() => window.releaseDraft());
      await page.waitForFunction(() => window.posts.length === 1);
      if (pendingSelection) await page.evaluate(() => window.pendingRender);
      else await page.evaluate(() => window.fixture.form.renderSelectedWorkForm());
      const locked = await page.evaluate(() => ({
        sameInput: window.originalInput === document.querySelector('#workFormField_replacement'),
        disabled: document.querySelector('#workFormField_replacement').disabled,
        submitting: window.fixture.state.submittingWorkForm,
        answers: window.posts[0].answers,
        date: window.posts[0].work_date
      }));
      assert.equal(locked.sameInput, true, 'External Template render replaced fields while Report submission owned the surface');
      assert.equal(locked.disabled, true);
      assert.equal(locked.submitting, true);
      assert.deepEqual(locked.answers, { replacement: 'latest replacement' });
      assert.equal(locked.date, '2026-09-18');
      await page.evaluate(() => window.releaseSubmission());
      await page.waitForFunction(() => !window.fixture.state.submittingWorkForm);
      assert.equal(await page.locator('#workFormSelect').isEnabled(), true);
      await page.locator('#workFormSelect').selectOption('51');
      await page.locator('#workFormField_replacement').waitFor();
      assert.equal(await page.locator('#workFormField_replacement').inputValue(), '');
      assert.equal(await page.locator('#workFormField_replacement').isEnabled(), true);
      console.log(`ok - ${pendingSelection ? 'pending' : 'new'} external Template render cannot replace a submitting Report; successful submit still resets normally`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
