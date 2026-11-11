import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { inspectOfflineReadiness, readinessScope } from '../assets/js/offline-readiness.js';

const worker = { id: 7, departmentId: 2, role: 'worker', status: 'active' };
const snapshot = { templates: [{ id: 1 }], savedAt: '2026-11-11T01:00:00Z' };
const good = { getSavedUser: () => worker, loadSnapshot: async () => snapshot,
  probeStorage: async () => true, checkShell: async () => true, timeoutMs: 20 };
assert.equal((await inspectOfflineReadiness(worker, good)).ready, true);
for (const failure of [
  { getSavedUser: () => ({ ...worker, id: 8 }) },
  { getSavedUser: () => ({ ...worker, departmentId: 3 }) },
  { getSavedUser: () => null },
  { loadSnapshot: async () => null },
  { loadSnapshot: async () => ({ ...snapshot, templates: [] }) },
  { probeStorage: async () => { throw new Error('quota'); } },
  { probeStorage: () => new Promise(() => {}) },
  { checkShell: async () => false }
]) assert.equal((await inspectOfflineReadiness(worker, { ...good, ...failure })).ready, false);
assert.equal(readinessScope({ ...worker, role: 'supervisor' }), '');
assert.equal(readinessScope({ ...worker, status: 'resigned' }), '');
let calls = 0;
assert.equal((await inspectOfflineReadiness(worker, { ...good,
  getSavedUser: () => ++calls === 1 ? worker : null })).ready, false);
console.log('PASS readiness truth table, timeout and identity fence');

const origin = 'http://127.0.0.1:59953';
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, origin, 'No external traffic');
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body:
      '<section id="panel"><button id="button">Check</button><p id="status"></p><ul id="details"></ul></section>' });
    assert.match(url.pathname, /^\/assets\/js\/[a-z0-9-]+\.js$/);
    return route.fulfill({ contentType: 'text/javascript', body: await readFile(path.resolve(url.pathname.slice(1)), 'utf8') });
  });
  await page.goto(origin);
  const result = await page.evaluate(async () => {
    const db = await import('/assets/js/db.js');
    const readiness = await import('/assets/js/offline-readiness.js');
    const snapshots = await import('/assets/js/offline-report-template-snapshot.js');
    const user = { id: 7, departmentId: 2, role: 'worker', status: 'active' };
    const template = { id: 1, department_id: 2, name: 'Synthetic only', status: 'active',
      template_purpose: 'report', definition_version: 1, fields: [] };
    await snapshots.saveWorkerReportTemplateSnapshot(user, [template]);
    await db.put('settings', { key: 'preserved', value: 'original' });
    await db.put('drafts', { key: 'synthetic', value: { kind: 'work-form', templatePurpose: 'report', note: 'original' } });
    const before = JSON.stringify(await db.getAll('drafts'));
    const good = await readiness.inspectOfflineReadiness(user, {
      getSavedUser: () => user, checkShell: async () => true
    });
    const wrong = await readiness.inspectOfflineReadiness({ ...user, departmentId: 3 }, {
      getSavedUser: () => ({ ...user, departmentId: 3 }), checkShell: async () => true
    });
    const noController = await readiness.checkOfflineShell({ controller: null }, 10);
    const silent = await readiness.checkOfflineShell({ controller: { postMessage() {} } }, 10);
    const controller = { postMessage(data, ports) {
      ports[0].postMessage({ type: 'OFFLINE_READINESS_RESULT', ready: true, cacheVersion: 'leader-field-test' });
    } };
    const validShell = await readiness.checkOfflineShell({ controller }, 100);
    let current = user, finish;
    const ui = readiness.createOfflineReadiness({ panel: document.querySelector('#panel'),
      button: document.querySelector('#button'), status: document.querySelector('#status'),
      details: document.querySelector('#details'), getUser: () => current, getSavedUser: () => current,
      inspect: () => new Promise((resolve) => { finish = resolve; }) });
    const pending = ui.check();
    current = null; ui.clear(); finish(good); await pending;
    const cleared = document.querySelector('#panel').hidden && !document.querySelector('#status').textContent;
    current = user;
    const failedUi = readiness.createOfflineReadiness({ panel: document.querySelector('#panel'),
      button: document.querySelector('#button'), status: document.querySelector('#status'),
      details: document.querySelector('#details'), getUser: () => current, getSavedUser: () => current,
      inspect: async () => { throw new Error('Unexpected check failure'); } });
    await failedUi.check();
    const failureRecovered = !document.querySelector('#button').disabled
      && document.querySelector('#panel').dataset.state === 'attention';
    let finishScope;
    const scopeUi = readiness.createOfflineReadiness({ panel: document.querySelector('#panel'),
      button: document.querySelector('#button'), status: document.querySelector('#status'),
      details: document.querySelector('#details'), getUser: () => current, getSavedUser: () => current,
      inspect: () => new Promise((resolve) => { finishScope = resolve; }) });
    const scopePending = scopeUi.check();
    current = { ...user, departmentId: 3 }; finishScope(good); await scopePending;
    const scopeCleared = document.querySelector('#panel').hidden;
    const names = ['scaffold-pwa-local' , 'scaffold-pwa-report-evidence-v1',
      'scaffold-pwa-report-recovery-v1', 'scaffold-pwa-report-recipients-v1'];
    let residualProbes = 0;
    for (const name of names) {
      const opened = await new Promise((resolve, reject) => {
        const req = indexedDB.open(name); req.onsuccess = () => resolve(req.result); req.onerror = reject;
      });
      for (const store of opened.objectStoreNames) {
        const keys = await new Promise((resolve) => {
          const req = opened.transaction(store).objectStore(store).getAllKeys(); req.onsuccess = () => resolve(req.result);
        });
        residualProbes += keys.filter((key) => String(key).startsWith('offline-readiness-probe:')).length;
      }
      opened.close();
    }
    return { good, wrong, noController, silent, validShell, cleared, failureRecovered, scopeCleared, residualProbes,
      unchanged: before === JSON.stringify(await db.getAll('drafts')),
      setting: (await db.get('settings', 'preserved')).value };
  });
  assert.equal(result.good.ready, true);
  assert.equal(result.good.templateCount, 1);
  assert.equal(result.wrong.templates, false);
  assert.equal(result.noController, false);
  assert.equal(result.silent, false);
  assert.equal(result.validShell, true);
  assert.equal(result.cleared, true);
  assert.equal(result.failureRecovered, true);
  assert.equal(result.scopeCleared, true);
  assert.equal(result.residualProbes, 0);
  assert.equal(result.unchanged, true);
  assert.equal(result.setting, 'original');
  console.log('PASS real IndexedDB probes, scoped snapshots, shell protocol, UI stale-result fence and data preservation');
  await context.close();

  // Render the exact production panel, stylesheet and translations. This is
  // isolated component QA, not an authenticated backend or physical-phone test.
  const html = await readFile('index.html', 'utf8');
  const panelMarkup = html.match(/<section id="offlineReadiness"[\s\S]*?<\/section>/)?.[0];
  assert.ok(panelMarkup);
  const output = path.resolve('output/offline-readiness.local');
  await mkdir(output, { recursive: true });
  for (const [width, language, theme] of [[320, 'en', 'light'], [390, 'zh', 'dark'], [1200, 'en', 'light']]) {
    const visual = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const p = await visual.newPage();
    await p.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, origin, 'Visual fixture cannot contact external services');
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body:
        `<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/assets/css/styles.css"></head><body class="report-only-mode session-worker"><main class="card" style="max-width:760px;margin:16px auto;padding:16px"><h1>ReportFlow</h1>${panelMarkup}</main></body></html>` });
      assert.match(url.pathname, /^\/assets\/(js|css)\/[a-z0-9-]+\.(js|css)$/);
      return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
        body: await readFile(path.resolve(url.pathname.slice(1)), 'utf8') });
    });
    await p.goto(origin);
    await p.evaluate(async ({ language }) => {
      const { createOfflineReadiness } = await import('/assets/js/offline-readiness.js');
      const { setLanguage, applyLanguage } = await import('/assets/js/i18n.js');
      setLanguage(language);
      const user = { id: 7, departmentId: 2, role: 'worker', status: 'active' };
      const ui = createOfflineReadiness({ panel: document.querySelector('#offlineReadiness'),
        button: document.querySelector('#checkOfflineReadiness'), status: document.querySelector('#offlineReadinessStatus'),
        details: document.querySelector('#offlineReadinessDetails'), getUser: () => user, getSavedUser: () => user,
        translate: applyLanguage, formatTime: () => '11 Nov 2026, 2:00 pm NZDT',
        inspect: async () => ({ identity: true, templates: true, storage: true, shell: true, ready: true,
          templateCount: 12, savedAt: '2026-11-11T01:00:00Z', checkedAt: '2026-11-11T01:02:00Z' }) });
      await ui.check();
    }, { language });
    const button = p.locator('#checkOfflineReadiness');
    const summary = p.locator('#offlineReadiness summary');
    assert.ok(await button.isEnabled());
    for (const target of [button, summary]) {
      const box = await target.boundingBox();
      assert.ok(box.width >= 44 && box.height >= 44, `Touch target ${width}: ${JSON.stringify(box)}`);
    }
    assert.equal(await p.locator('#offlineReadiness details').getAttribute('open'), null);
    await summary.click();
    assert.equal(await p.locator('#offlineReadiness details').getAttribute('open'), '');
    const text = await p.locator('#offlineReadiness').innerText();
    assert.ok(text.includes('12') && text.includes('11 Nov 2026'));
    if (language === 'zh') {
      assert.match(text, /[\u4e00-\u9fff]/);
      for (const english of ['Before going offline', 'Check this device', 'Offline checks passed',
        'Worker identity saved', 'Small device storage', 'This check is for this browser']) assert.ok(!text.includes(english), english);
    } else assert.match(text, /Offline checks passed on this device/);
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No overflow at ${width}`);
    await p.screenshot({ path: path.join(output, `${width}-${language}-${theme}-details.png`), fullPage: true });
    await summary.focus();
    await p.keyboard.press('Enter');
    assert.equal(await p.locator('#offlineReadiness details').getAttribute('open'), null);
    await p.screenshot({ path: path.join(output, `${width}-${language}-${theme}-compact.png`), fullPage: true });
    await visual.close();
    console.log(`PASS final readiness markup/CSS/i18n ${width}px ${language} ${theme}, touch, overflow and details keyboard interaction`);
  }
} finally { await browser.close(); }
