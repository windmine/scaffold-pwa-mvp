import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';
import { browserApiRequest } from './check-hosted-report-workflow.mjs';

const origin = 'https://geo-attendance-system-db9ca.web.app';
const evidenceFile = resolve('docs/evidence/report-pdf-release-20260916/live-browser.json');
if (existsSync(evidenceFile)) throw new Error('evidence_exists');
const py = "import importlib.util,json; s=importlib.util.spec_from_file_location('demo','scripts/presentation-demo-live.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.read_private_handoff('demo-20260916')))";
const account = JSON.parse(execFileSync('python', ['-c', py], {
  encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
})).accounts.supervisor;
const evidence = { status: 'running', viewport: { width: 390, height: 844 }, pageErrors: 0, downloads: [] };
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ baseURL: origin, viewport: evidence.viewport, serviceWorkers: 'block' });
await context.route('**/*', async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin !== origin || (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())
      && !['/api/auth/login', '/api/auth/logout', '/api/auth/refresh'].includes(url.pathname))) return route.abort();
  return route.continue();
});
const page = await context.newPage();
page.on('pageerror', () => { evidence.pageErrors += 1; });
try {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.dataset.activeView === 'login'
    && document.querySelector('#syncIndicator')?.dataset.state !== 'checking');
  await page.locator('#emailInput').fill(account.email);
  await page.locator('#passwordInput').fill(account.password);
  await page.locator('#loginForm button[type="submit"]').click();
  await page.waitForFunction(() => document.body.dataset.activeView === 'supervisor');
  await page.locator('#passwordInput').evaluate((input) => { input.value = ''; });
  const me = await page.evaluate(browserApiRequest, { path: '/api/auth/me' });
  if (!me.ok || me.body.id !== 16 || me.body.department_id !== 2 || me.body.is_global_admin) throw new Error('scope_mismatch');
  await page.locator('#supervisorStatusFilter').selectOption('');
  await page.locator('#supervisorSearchInput').fill('demo-20260916');
  await page.waitForFunction(() => document.querySelectorAll('#reviewQueueList .record-form').length === 9);
  const collectionDownload = page.waitForEvent('download');
  await page.locator('#exportReportsPdfButton').click();
  const collection = await collectionDownload;
  const collectionPath = resolve('output/pdf/report-pdf-release-live.local/browser-collection.pdf');
  await collection.saveAs(collectionPath);
  evidence.downloads.push({ kind: 'collection', filename: collection.suggestedFilename(), bytes: readFileSync(collectionPath).length });
  await page.locator('#supervisorSearchInput').fill('walkway');
  await page.waitForFunction(() => document.querySelectorAll('#reviewQueueList .record-form').length === 1);
  await page.locator('#reviewQueueList .record-form').click();
  await page.locator('#reviewQueueActions select').selectOption('form-pdf');
  const singleDownload = page.waitForEvent('download');
  await page.locator('#reviewQueueActions').getByRole('button', { name: 'Export', exact: true }).click();
  const single = await singleDownload;
  const singlePath = resolve('output/pdf/report-pdf-release-live.local/browser-single.pdf');
  await single.saveAs(singlePath);
  evidence.downloads.push({ kind: 'single', filename: single.suggestedFilename(), bytes: readFileSync(singlePath).length });
  for (const path of [singlePath, collectionPath]) {
    if (!readFileSync(path).subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('invalid_download');
  }
  if (evidence.pageErrors !== 0 || !await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1)) {
    throw new Error('browser_layout_or_page_error');
  }
  evidence.status = 'passed';
} catch {
  evidence.status = 'failed';
  process.exitCode = 1;
} finally {
  await page.evaluate(browserApiRequest, { path: '/api/auth/logout', method: 'POST' }).catch(() => {});
  await context.close();
  await browser.close();
  evidence.completedAtUtc = new Date().toISOString();
  writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence));
}
