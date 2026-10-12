// Real Worker history renderer with synthetic, already-mapped API records.
// All browser traffic is intercepted; this is not a phone or network benchmark.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59984';
const args = process.argv.slice(2);
const full = args.includes('--full');
const outputIndex = args.indexOf('--output');
const output = outputIndex < 0 ? null : args[outputIndex + 1];
assert.ok(outputIndex < 0 || output, '--output requires a path');
const sizes = full ? [100, 1000, 5000] : [100, 1000];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB8kAAAAASUVORK5CYII=', 'base64');
const markup = `<!doctype html><html><head><link rel="stylesheet" href="/assets/css/styles.css"></head><body class="report-only-mode">
  <div id="workerSummary"></div><section id="workerView"><section id="historyTab"><div id="historyList" class="records-list"></div></section></section>
  <input id="historySearchInput"><select id="historyTypeFilter"><option value="form">Form</option></select>
  <select id="historyStatusFilter"><option value=""></option><option value="resolved">Resolved</option></select>
  <input id="historyDateFilter" type="date"><span id="historyResultCount"></span>
  <button id="refreshHistoryButton">Refresh</button><button id="clearHistoryFiltersButton">Clear filters</button>
  <template id="recordTemplate"><article class="record-card"><div class="record-header"><div>
    <h3 class="record-title"></h3><p class="record-meta"></p></div><span class="badge"></span></div>
    <p class="record-detail"></p><div class="record-extra"></div><div class="record-actions hidden"></div>
  </article></template></body></html>`;

const browser = await chromium.launch({ headless: true });
const evidence = {
  generatedAt: new Date().toISOString(),
  profile: full ? 'full' : 'ci',
  scope: 'Actual history.js renderer, filters and app CSS in a minimal page; synthetic mapped records; intercepted assets/images; no backend/network/phone capacity claim.',
  environment: { node: process.version, chromium: browser.version(), platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model },
  testSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
  sourceSha256: createHash('sha256').update(await readFile(path.join(root, 'assets/js/history.js'))).digest('hex'),
  styleSha256: createHash('sha256').update(await readFile(path.join(root, 'assets/css/styles.css'))).digest('hex'),
  policy: 'Correctness, no eager images, cleanup and a 30-second runaway ceiling are gates. Observed timings/heap are diagnostic, not service-level limits.',
  scenarios: []
};
try {
  for (const count of sizes) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    let imageRequests = 0;
    const failures = [];
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) {
        failures.push(`Unexpected origin: ${url.origin}`);
        return route.abort();
      }
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: markup });
      if (url.pathname === '/assets/css/styles.css') return route.fulfill({ contentType: 'text/css', body: await readFile(path.join(root, url.pathname), 'utf8') });
      if (/^\/uploads\/synthetic-\d+-[a-z]+\.png$/.test(url.pathname)) {
        imageRequests += 1;
        return route.fulfill({ contentType: 'image/png', body: png });
      }
      assert.match(url.pathname, /^\/assets\/js\/[a-z\d-]+\.js$/);
      return route.fulfill({ contentType: 'text/javascript', body: await readFile(path.join(root, url.pathname), 'utf8') });
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => failures.push(error.message));
    page.setDefaultTimeout(30000);
    try {
      await page.goto(origin);
      const prepared = await page.evaluate(async (size) => {
        const { createHistoryModule } = await import('/assets/js/history.js');
        const els = Object.fromEntries([...document.querySelectorAll('[id]')].map((node) => [node.id, node]));
        const worker = { id: 12, departmentId: 3, role: 'worker' };
        const fields = [
          ...Array.from({ length: 12 }, (_, index) => ({ id: `answer${index}`, label: `Inspection answer ${index}`, type: 'text' })),
          { id: 'sign', label: 'Worker signature', type: 'signature' },
          { id: 'crew', label: 'Crew checks', type: 'repeat' },
          { id: 'person', label: 'Person', type: 'text', repeat: 'crew' },
          { id: 'crewSign', label: 'Crew signature', type: 'signature', repeat: 'crew' }
        ];
        const records = Array.from({ length: size }, (_, index) => ({
          id: `form-${index + 1}`, backendRecordId: index + 1, type: 'form', userId: 12, departmentId: 3,
          userName: 'Synthetic Worker', formName: `Inspection ${index + 1}`, formId: 2,
          submissionPurpose: 'report', siteId: 4, siteName: 'Synthetic Site', workDate: '2026-10-01',
          createdAt: new Date(Date.UTC(2026, 9, 1) + index * 60000).toISOString(), syncStatus: 'synced',
          workflowStatus: index % 3 === 0 ? 'resolved' : 'submitted',
          supervisorNote: index % 3 === 0 ? 'Synthetic final note. '.repeat(8) : '',
          fields: structuredClone(fields),
          answers: {
            ...Object.fromEntries(Array.from({ length: 12 }, (_, field) => [`answer${field}`, `Row ${index + 1}. ${'Synthetic inspection answer. '.repeat(8)}`])),
            answer0: index === size - 1 ? 'unique-last-answer-needle' : 'Ordinary answer',
            sign: `/uploads/synthetic-${index + 1}-sign.png`,
            crew: [{ person: 'Synthetic Person', crewSign: `/uploads/synthetic-${index + 1}-crew.png` }]
          },
          photoUrls: [`/uploads/synthetic-${index + 1}-first.png`, `/uploads/synthetic-${index + 1}-second.png`],
          photoMetadata: [{ originalName: 'synthetic-first.png' }, { originalName: 'synthetic-second.png' }]
        }));
        const state = { user: worker, historyRecords: records, sites: [] };
        const module = createHistoryModule({
          els, state, reportOnly: true, photoViewer: { closeForSources: () => false, open: () => {} },
          canWorkerEditRecord: () => false
        });
        module.bindEvents();
        window.volumeFixture = { module, state, worker };
        return { mappedPayloadBytes: new TextEncoder().encode(JSON.stringify(records)).length };
      }, count);
      const render = async () => page.evaluate(() => {
        const start = performance.now();
        window.volumeFixture.module.renderFilteredHistory();
        // Include synchronous layout work, not just DOM insertion.
        const height = document.getElementById('historyList').offsetHeight;
        return { milliseconds: performance.now() - start, height, cards: document.querySelectorAll('#historyList .record-card').length,
          elements: document.querySelectorAll('#historyList *').length, images: document.querySelectorAll('#historyList img').length };
      });
      const first = await render();
      const repeat = await render();
      for (const result of [first, repeat]) {
        assert.equal(result.cards, count);
        assert.equal(result.images, 0);
        assert.ok(result.milliseconds < 30000, 'Renderer exceeded runaway ceiling');
      }
      assert.equal(imageRequests, 0, 'Collapsed history must not fetch evidence');
      const session = await context.newCDPSession(page);
      const heapBeforeSearch = await session.send('Runtime.getHeapUsage');
      const searchMilliseconds = await page.evaluate(() => {
        const start = performance.now();
        const input = document.getElementById('historySearchInput');
        input.value = 'unique-last-answer-needle';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('historyList').offsetHeight;
        return performance.now() - start;
      });
      assert.equal(await page.locator('#historyList .record-card').count(), 1, 'Full-answer search must find the final record');
      assert.equal(await page.locator('.record-title').textContent(), `Inspection ${count}`);
      await page.locator('.record-disclosure-button').click();
      assert.equal(await page.locator('#historyList .record-photos img').count(), 2);
      assert.equal(await page.locator('#historyList .record-signatures img').count(), 2);
      await page.waitForFunction(() => [...document.querySelectorAll('#historyList img')].every((img) => img.complete && img.naturalWidth > 0));
      assert.equal(imageRequests, 4);
      await page.locator('.record-disclosure-button').click();
      assert.equal(await page.locator('#historyList img').count(), 0);
      // Existing exact Worker/Department checks must still hold at scale.
      await page.evaluate(() => {
        const fixture = window.volumeFixture;
        fixture.state.user = { ...fixture.worker, id: 13 };
        fixture.module.renderFilteredHistory();
      });
      assert.equal(await page.locator('#historyList .record-card').count(), 0);
      await page.evaluate(() => {
        const fixture = window.volumeFixture;
        fixture.state.user = { ...fixture.worker, departmentId: 99 };
        fixture.module.renderFilteredHistory();
      });
      assert.equal(await page.locator('#historyList .record-card').count(), 0);
      await page.evaluate(() => window.volumeFixture.module.resetSession());
      assert.equal(await page.evaluate(() => window.volumeFixture.state.historyRecords.length), 0);
      assert.equal(await page.locator('#historyList .record-card').count(), 0);
      assert.deepEqual(failures, []);
      const result = { reports: count, ...prepared, firstRender: first, repeatRender: repeat,
        searchMilliseconds, heapBeforeSearchBytes: heapBeforeSearch.usedSize, imageRequestsAfterOneExpansion: imageRequests,
        correctness: 'passed', noEagerImages: true, finalRecordSearch: true, exactWorkerAndDepartmentScopeAndReset: true };
      evidence.scenarios.push(result);
      console.log(`ok - ${count} Reports: first ${first.milliseconds.toFixed(1)} ms, repeat ${repeat.milliseconds.toFixed(1)} ms, search ${searchMilliseconds.toFixed(1)} ms; no eager images; evidence and scope checks passed`);
    } finally {
      await context.close();
    }
  }
  evidence.status = 'passed';
} finally {
  await browser.close();
  if (output) {
    await mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  }
}
