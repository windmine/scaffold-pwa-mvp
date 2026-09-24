import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';
import { browserApiRequest, showSupervisorFilters } from './check-hosted-report-workflow.mjs';

// Release-bound read-only compatibility probe: existing live static frontend,
// only API/uploads forwarded to the exact zero-traffic candidate. Auth-only
// writes; no Report, Template, account, upload or infrastructure mutation.
const live = 'https://geo-attendance-system-db9ca.web.app';
const candidate = 'https://onboarding-20260925---geo-backend-eitdijn7cq-ts.a.run.app';
const evidencePath = resolve('docs/evidence/report-release-20260925/old-client-candidate.json');
const outputDir = resolve('output/report-release-20260925.local/old-client-candidate-artifacts');
if (existsSync(evidencePath) || existsSync(outputDir)) throw new Error('New evidence paths required');
mkdirSync(dirname(evidencePath), { recursive: true });
mkdirSync(dirname(outputDir), { recursive: true });
mkdirSync(outputDir);
const evidence = { status: 'running', startedAtUtc: new Date().toISOString(),
  liveFrontend: live, backendCandidate: candidate, viewport: { width: 390, height: 844 },
  scope: 'Read-only existing demo Reports; old live frontend with only API/uploads forwarded to the zero-traffic candidate; auth-only writes',
  checks: [], requests: [], blockedRequests: [], pageErrors: 0 };
const save = () => writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
const requireCondition = (condition, code) => { if (!condition) { const error = new Error(code); error.safeCode = code; throw error; } };
const step = async (name, run) => { stage = name; const details = await run(); evidence.checks.push({ name, status: 'passed', details }); save(); console.log(`ok - ${name}`); };
let stage = 'start';
let browser;
let context;
let page;
let routeFailure = '';
let account;
save();
try {
  // Decrypt only the exact retained demo handoff in memory. Never echo raw child
  // output or place passwords, cookies or private links in evidence/arguments.
  const py = "import importlib.util,json; s=importlib.util.spec_from_file_location('demo','scripts/presentation-demo-live.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.read_private_handoff('demo-20260916')))";
  const handoff = JSON.parse(execFileSync('python', ['-c', py], { encoding: 'utf8', windowsHide: true,
    timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }));
  const manifest = JSON.parse(readFileSync('docs/evidence/presentation-demo-20260916.json', 'utf8'));
  account = handoff.accounts?.supervisor;
  requireCondition(handoff.runId === 'demo-20260916' && handoff.origin === live
    && manifest.runId === handoff.runId && manifest.origin === live && manifest.departmentId === 2
    && manifest.accounts.supervisor.id === 16 && manifest.accounts.supervisor.departmentId === 2
    && manifest.accounts.supervisor.role === 'supervisor' && !manifest.accounts.supervisor.isGlobalAdmin
    && account?.email === manifest.accounts.supervisor.email
    && typeof account.password === 'string' && account.password.length >= 8,
  'exact_demo_supervisor_handoff_required');
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ baseURL: live, viewport: evidence.viewport, isMobile: true,
    hasTouch: true, serviceWorkers: 'block' });
  context.setDefaultTimeout(45000);
  context.setDefaultNavigationTimeout(45000);
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const backend = /^\/(api|uploads)\//.test(url.pathname);
    const authWrite = method === 'POST' && ['/api/auth/login', '/api/auth/refresh', '/api/auth/logout'].includes(url.pathname);
    if (url.origin !== live || (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !authWrite)) {
      evidence.blockedRequests.push({ origin: url.origin, path: url.pathname, method });
      return route.abort();
    }
    try {
      const target = backend ? `${candidate}${url.pathname}${url.search}` : url.href;
      const response = await route.fetch({ url: target, maxRedirects: 0, timeout: 45000 });
      requireCondition(new URL(response.url()).origin === (backend ? candidate : live), 'response_left_exact_allowlist');
      requireCondition(response.status() < 300 || response.status() >= 400, 'unexpected_redirect');
      evidence.requests.push({ surface: backend ? 'candidate' : 'live-static', method,
        path: url.pathname, status: response.status(), atUtc: new Date().toISOString() });
      await route.fulfill({ response });
    } catch (error) {
      routeFailure ||= error.safeCode || 'allowed_request_fetch_failed';
      await route.abort().catch(() => {});
    }
  });
  page = await context.newPage();
  page.on('pageerror', () => { evidence.pageErrors += 1; });
  await step('old_live_shell_and_candidate_readiness', async () => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const ready = await page.evaluate(browserApiRequest, { path: '/api/health/ready' });
    requireCondition(ready.ok && ready.body.status === 'ok'
      && ['database', 'migrations', 'upload_storage'].every((name) => ready.body.checks[name] === 'ok')
      && ready.body.details.upload_storage.backend === 'gcs', 'candidate_readiness_failed');
    const shell = await page.evaluate(async () => {
      const response = await fetch('/sw.js', { cache: 'no-store' });
      const text = await response.text();
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return { cache: text.match(/leader-field-[a-f0-9]+/)?.[0],
        sha256: [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('') };
    });
    requireCondition(shell.cache === 'leader-field-ed9e6cddf6aa', 'frontend_is_not_expected_old_live_release');
    return { readiness: ready.body.checks, uploadBackend: 'gcs', oldShell: shell };
  });
  await step('old_ui_auth_and_exact_demo_supervisor_scope', async () => {
    await page.waitForFunction(() => document.body.dataset.activeView === 'login'
      && document.querySelector('#syncIndicator')?.dataset.state !== 'checking');
    await page.locator('#emailInput').fill(account.email);
    await page.locator('#passwordInput').fill(account.password);
    await page.locator('#loginForm button[type="submit"]').click();
    await page.waitForFunction(() => document.body.dataset.activeView === 'supervisor');
    await page.locator('#passwordInput').evaluate((input) => { input.value = ''; });
    const me = await page.evaluate(browserApiRequest, { path: '/api/auth/me' });
    requireCondition(me.ok && me.body.id === 16 && me.body.department_id === 2
      && me.body.role === 'supervisor' && !me.body.is_global_admin, 'demo_supervisor_scope_mismatch');
    return { userId: 16, departmentId: 2, globalAdmin: false };
  });
  await step('old_ui_filters_exact_demo_collection_and_streams_report5_evidence', async () => {
    await showSupervisorFilters(page);
    await page.locator('#supervisorStatusFilter').selectOption('');
    await page.locator('#supervisorSearchInput').fill('demo-20260916');
    await page.waitForFunction(() => document.querySelectorAll('#reviewQueueList .record-form').length === 9);
    const keys = await page.locator('#reviewQueueList .record-form').evaluateAll((cards) => cards.map((card) => card.dataset.recordKey).sort());
    requireCondition(JSON.stringify(keys) === JSON.stringify(Array.from({ length: 9 }, (_, index) => `form:${index + 5}`).sort()), 'demo_report_collection_scope_mismatch');
    await page.locator('#reviewQueueList .record-form[data-record-key="form:5"]').click();
    const detail = page.locator('#reviewQueueDetail');
    requireCondition((await detail.innerText()).includes('DEMO-T01 walkway briefing'), 'report5_answers_missing');
    const images = detail.locator('img');
    requireCondition(await images.count() >= 2, 'report5_photo_or_signature_missing');
    for (const image of await images.all()) {
      await image.scrollIntoViewIfNeeded();
      await image.evaluate((element) => element.decode());
    }
    const imageProof = await images.evaluateAll((elements) => elements.map((image) => ({
      path: new URL(image.currentSrc).pathname, width: image.naturalWidth, height: image.naturalHeight
    })));
    requireCondition(imageProof.every((image) => image.path.startsWith('/uploads/') && image.width > 0), 'report5_evidence_stream_failed');
    await detail.screenshot({ path: join(outputDir, 'report5-old-ui.png'), animations: 'disabled' });
    return { reportIds: keys, imageProof, answersPresent: true };
  });
  requireCondition(!routeFailure && evidence.blockedRequests.length === 0 && evidence.pageErrors === 0, 'browser_request_or_page_errors');
  requireCondition(evidence.requests.some((item) => item.surface === 'candidate' && item.path.startsWith('/uploads/'))
    && evidence.requests.filter((item) => item.path.startsWith('/api/')).every((item) => item.surface === 'candidate'), 'candidate_routing_incomplete');
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.failure = { checkpoint: stage, code: error.safeCode || 'browser_or_api_operation_failed',
    ...(routeFailure ? { routeFailure } : {}) };
  process.exitCode = 1;
} finally {
  if (page) await page.evaluate(browserApiRequest, { path: '/api/auth/logout', method: 'POST' }).catch(() => {});
  account = null;
  if (context) await context.close();
  if (browser) await browser.close();
  evidence.completedAtUtc = new Date().toISOString();
  evidence.authOnlyWrites = evidence.requests.filter((item) => !['GET', 'HEAD', 'OPTIONS'].includes(item.method))
    .every((item) => ['/api/auth/login', '/api/auth/refresh', '/api/auth/logout'].includes(item.path));
  save();
  console.log(JSON.stringify({ status: evidence.status, failure: evidence.failure, checks: evidence.checks.length,
    candidateRequests: evidence.requests.filter((item) => item.surface === 'candidate').length,
    blockedRequests: evidence.blockedRequests.length, pageErrors: evidence.pageErrors, authOnlyWrites: evidence.authOnlyWrites }));
}
