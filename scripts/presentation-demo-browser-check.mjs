// Read-only live presentation verification. Credentials remain in process memory;
// no traces, HAR, storage-state files or login screenshots are recorded.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';
import { browserApiRequest } from './check-hosted-report-workflow.mjs';

const runId = 'demo-20260916';
const manifestPath = resolve(`docs/evidence/presentation-${runId}.json`);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const evidenceDir = resolve(`docs/evidence/presentation-${runId}-browser`);
const origin = 'https://geo-attendance-system-db9ca.web.app';
const proof = { runId, status: 'running', checkpoints: [], pageErrors: 0, serverErrors: 0, blockedWrites: 0 };
let stage = 'configuration';
function requireCondition(value, code) {
  if (!value) { const error = new Error(code); error.safeCode = code; throw error; }
}
requireCondition(manifest.runId === runId && manifest.origin === origin
  && manifest.existingRecordsUnchanged && Object.keys(manifest.reports).length === 9, 'manifest_not_ready');
const py = "import importlib.util,json; s=importlib.util.spec_from_file_location('demo','scripts/presentation-demo-live.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.read_private_handoff('demo-20260916')))";
const handoff = JSON.parse(execFileSync('python', ['-c', py], {
  encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
}));
requireCondition(handoff.origin === origin && handoff.runId === runId, 'private_handoff_scope_mismatch');
mkdirSync(evidenceDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const contexts = [];
async function session(key, viewport) {
  const context = await browser.newContext({ baseURL: origin, viewport, serviceWorkers: 'block' });
  contexts.push(context);
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin && url.protocol !== 'data:' && url.protocol !== 'blob:') return route.abort();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())
      && !['/api/auth/login', '/api/auth/refresh', '/api/auth/logout'].includes(url.pathname)) {
      proof.blockedWrites += 1;
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', () => { proof.pageErrors += 1; });
  page.on('response', (response) => { if (response.status() >= 500) proof.serverErrors += 1; });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.dataset.activeView === 'login'
    && document.querySelector('#syncIndicator')?.dataset.state !== 'checking');
  await page.locator('#emailInput').fill(handoff.accounts[key].email);
  await page.locator('#passwordInput').fill(handoff.accounts[key].password);
  await page.locator('#loginForm button[type="submit"]').click();
  await page.waitForFunction((view) => document.body.dataset.activeView === view,
    key === 'supervisor' ? 'supervisor' : 'worker');
  await page.locator('#passwordInput').evaluate((input) => { input.value = ''; });
  const me = await api(page, '/api/auth/me');
  requireCondition(me.id === manifest.accounts[key].id && me.department_id === manifest.departmentId
    && !me.is_global_admin, 'login_identity_scope_mismatch');
  return page;
}
async function api(page, path) {
  const result = await page.evaluate(browserApiRequest, { path });
  requireCondition(result.ok, 'read_only_api_failed');
  return result.body;
}
async function listCount(page, selector, count) {
  await page.waitForFunction(({ selector, count }) => document.querySelectorAll(selector).length === count,
    { selector, count });
}
async function layout(page) {
  requireCondition(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1),
    'horizontal_overflow');
}
try {
  stage = 'supervisor_api';
  const supervisor = await session('supervisor', { width: 1440, height: 1000 });
  const reports = await api(supervisor, '/api/supervisor/form-submissions?purpose=report');
  const ownIds = Object.values(manifest.reports).map((report) => report.id).sort((a, b) => a - b);
  requireCondition(JSON.stringify(reports.map((report) => report.id).sort((a, b) => a - b))
    === JSON.stringify(ownIds), 'report_ids_mismatch');
  for (const [key, expected] of Object.entries(manifest.reports)) {
    const actual = reports.find((report) => report.id === expected.id);
    requireCondition(actual.worker_id === manifest.accounts[expected.workerKey].id
      && actual.workflow_status === expected.workflow && actual.submission_purpose === 'report'
      && actual.client_submission_id === expected.clientSubmissionId
      && actual.work_date === expected.workDate, `report_mismatch_${key}`);
    if (expected.workflow === 'resolved') requireCondition(actual.supervisor_note?.includes('DEMO')
      && actual.review_started_at && actual.resolved_at, `final_note_missing_${key}`);
  }
  const forms = await api(supervisor, '/api/work-forms?purpose=report');
  requireCondition(Object.values(manifest.templates).every((expected) => forms.some((form) =>
    form.id === expected.id && form.name === expected.name && form.status === 'active')), 'templates_missing');
  const uploads = await supervisor.evaluate(async (paths) => {
    const results = [];
    for (const path of paths) {
      const response = await fetch(path, { credentials: 'include', cache: 'no-store' });
      const blob = await response.blob();
      const image = await createImageBitmap(blob);
      results.push({ path, status: response.status, type: blob.type, width: image.width, height: image.height });
      image.close();
    }
    return results;
  }, manifest.uploads.map((upload) => upload.path));
  requireCondition(uploads.every((upload) => upload.status === 200 && upload.width > 0), 'uploads_not_renderable');
  proof.uploads = uploads;
  proof.checkpoints.push('exact_nine_reports_three_active_templates_six_decodable_uploads');

  stage = 'supervisor_filters';
  await supervisor.locator('#supervisorStatusFilter').selectOption('');
  await supervisor.locator('#supervisorSearchInput').fill(runId);
  await listCount(supervisor, '#reviewQueueList .record-form', 9);
  for (const workflow of ['submitted', 'in_review', 'resolved']) {
    const refresh = supervisor.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === '/api/supervisor/review-queue'
        && url.searchParams.get('workflow_status') === workflow
        && url.searchParams.get('search') === runId;
    });
    await supervisor.locator('#supervisorStatusFilter').selectOption(workflow);
    requireCondition((await refresh).ok(), 'workflow_filter_request_failed');
    await listCount(supervisor, '#reviewQueueList .record-form', 3);
    const label = { submitted: 'Submitted', in_review: 'In review', resolved: 'Resolved' }[workflow];
    await supervisor.waitForFunction((label) => [...document.querySelectorAll('#reviewQueueList .record-form')]
      .every((card) => [...card.querySelectorAll('.badge')].some((badge) => badge.textContent.trim() === label)), label);
  }
  await supervisor.locator('#supervisorStatusFilter').selectOption('');
  await listCount(supervisor, '#reviewQueueList .record-form', 9);
  await supervisor.waitForFunction(() => [...document.querySelectorAll('#reviewQueueDetails img')]
    .every((image) => image.complete && image.naturalWidth > 0));
  await supervisor.locator('#reviewQueueDetails').screenshot({ path: resolve(evidenceDir, 'supervisor-reports.png') });
  await layout(supervisor);
  proof.checkpoints.push('desktop_find_and_three_per_workflow_filter');

  stage = 'resolved_detail';
  await supervisor.locator('#supervisorSearchInput').fill('walkway');
  await listCount(supervisor, '#reviewQueueList .record-form', 1);
  await supervisor.locator('#reviewQueueList .record-form').click();
  await supervisor.locator('#reviewQueueDetail .report-supervisor-note').waitFor();
  await supervisor.waitForFunction(() => {
    const images = [...document.querySelectorAll('#reviewQueueDetail img')];
    return images.length >= 2 && images.every((image) => image.complete && image.naturalWidth > 0);
  });
  await supervisor.locator('#reviewQueueDetail').screenshot({ path: resolve(evidenceDir, 'supervisor-toolbox-detail.png') });
  await supervisor.setViewportSize({ width: 390, height: 844 });
  await layout(supervisor);
  await supervisor.locator('#reviewQueueDetail').screenshot({ path: resolve(evidenceDir, 'supervisor-phone-detail.png') });
  proof.checkpoints.push('resolved_toolbox_sections_signatures_photo_and_final_note_desktop_and_phone');

  stage = 'export_readiness';
  proof.exports = await supervisor.evaluate(async (runId) => {
    const results = [];
    for (const extension of ['csv', 'pdf']) {
      const response = await fetch(`/api/supervisor/form-submissions/export.${extension}?purpose=report&search=${runId}`,
        { credentials: 'include', cache: 'no-store' });
      const bytes = new Uint8Array(await response.arrayBuffer());
      results.push({ extension, status: response.status, bytes: bytes.length,
        contentType: response.headers.get('content-type'),
        valid: extension === 'pdf' ? String.fromCharCode(...bytes.slice(0, 5)) === '%PDF-'
          : new TextDecoder().decode(bytes).includes(runId) });
    }
    return results;
  }, runId);
  requireCondition(proof.exports.every((item) => item.status === 200 && item.valid && item.bytes > 100),
    'current_live_export_failed');
  proof.checkpoints.push('current_deployed_csv_and_pdf_return_valid_downloads_new_pdf_style_not_deployed');

  stage = 'worker_isolation';
  for (const key of ['alex', 'jamie', 'taylor']) {
    const worker = await session(key, { width: 390, height: 844 });
    const history = await api(worker, '/api/my-form-submissions?purpose=report');
    requireCondition(history.length === 3 && history.every((report) => report.worker_id === manifest.accounts[key].id
      && ownIds.includes(report.id)), 'worker_history_isolation_failed');
    await worker.locator('.tab[data-tab-target="historyTab"]').click();
    await listCount(worker, '#historyList .record-form', 3);
    await layout(worker);
    if (key === 'alex') {
      await worker.waitForFunction(() => [...document.querySelectorAll('#historyList img')]
        .every((image) => image.complete && image.naturalWidth > 0));
      await worker.locator('#historyList').screenshot({ path: resolve(evidenceDir, 'worker-phone-my-reports.png') });
    }
    await worker.evaluate(browserApiRequest, { path: '/api/auth/logout', method: 'POST' });
  }
  proof.checkpoints.push('all_three_workers_see_only_own_three_reports_phone_layout');
  requireCondition((await api(supervisor, '/api/health/ready')).status === 'ok', 'final_readiness_failed');
  proof.checkpoints.push('final_live_readiness_healthy');
  requireCondition(proof.pageErrors === 0 && proof.serverErrors === 0 && proof.blockedWrites === 0,
    'browser_or_server_errors_observed');
  await supervisor.evaluate(browserApiRequest, { path: '/api/auth/logout', method: 'POST' });
  proof.status = 'passed';
} catch (error) {
  proof.status = 'failed';
  proof.failure = { stage, code: error.safeCode || 'browser_operation_failed' };
  process.exitCode = 1;
} finally {
  for (const context of contexts) {
    for (const page of context.pages()) {
      if (page.url().startsWith(origin)) await page.evaluate(browserApiRequest,
        { path: '/api/auth/logout', method: 'POST' }).catch(() => {});
    }
    await context.close().catch(() => {});
  }
  await browser.close();
  proof.completedAtUtc = new Date().toISOString();
  writeFileSync(resolve(evidenceDir, 'evidence.json'), `${JSON.stringify(proof, null, 2)}\n`);
  if (proof.status === 'passed') {
    manifest.browserVerification = { status: 'passed', completedAtUtc: proof.completedAtUtc,
      evidence: `docs/evidence/presentation-${runId}-browser/evidence.json` };
    manifest.status = 'ready_for_presentation';
    writeFileSync(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(`${manifestPath}.tmp`, manifestPath);
  }
  console.log(JSON.stringify({ status: proof.status, checkpoints: proof.checkpoints, failure: proof.failure }));
}
