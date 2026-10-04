import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { chromium } from 'playwright';
import { approvedOrigin, evidenceDirectory, forwardWithoutRedirects, safeFailure } from './check-hosted-onboarding-release.mjs';
import { browserApiRequest, showSupervisorFilters } from './check-hosted-report-workflow.mjs';
import { ownedWorker, ownedTemplate } from './check-hosted-report-ux-release.mjs';

export { ownedWorker, ownedTemplate };
const scriptPath = fileURLToPath(import.meta.url);
const demoEmail = 'demo-20260916-supervisor@example.invalid';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function requireCondition(condition, code) {
  if (!condition) { const error = new Error(code); error.safeCode = code; throw error; }
}
const exactKeys = (body, keys) => body && typeof body === 'object' && !Array.isArray(body)
  && Object.keys(body).every((key) => keys.includes(key));

export function readConfiguration(args = process.argv.slice(2), env = process.env) {
  requireCondition(args.length === 3 && args[0] === '--allow-hosted-mutations' && args[1] === '--run-id',
    'explicit_mutation_flag_and_run_id_required');
  requireCondition(/^[a-z0-9][a-z0-9_-]{3,39}$/.test(args[2]), 'invalid_run_id');
  const baseURL = approvedOrigin(env.HOSTED_OCTOBER_ORIGIN || '');
  requireCondition(new URL(baseURL).host === env.HOSTED_REPORT_ALLOWED_HOST, 'exact_host_allowlist_required');
  requireCondition(env.HOSTED_OCTOBER_SUPERVISOR_EMAIL === demoEmail
    && env.HOSTED_OCTOBER_SUPERVISOR_PASSWORD?.length >= 8, 'exact_demo_supervisor_required');
  return { runId: args[2], baseURL, evidenceDir: evidenceDirectory(env.HOSTED_OCTOBER_EVIDENCE_DIR),
    supervisor: { email: demoEmail, password: env.HOSTED_OCTOBER_SUPERVISOR_PASSWORD } };
}

export function ownedReport(row, scope) {
  return Boolean(row && Number.isInteger(row.id) && row.id > 21 && row.form_id === scope.templateId
    && row.worker_id === scope.workerId && row.submission_purpose === 'report' && row.work_date === scope.reportDate
    && scope.reportPlans.some((plan) => plan.clientId && row.client_submission_id === plan.clientId
      && row.answers?.ux_detail === plan.marker && (!plan.id || row.id === plan.id)));
}

export function assertMutationAllowed({ url, method, body = {}, bytes, headers = {} }, scope) {
  const target = new URL(url);
  requireCondition(target.origin === scope.baseURL && !target.username && !target.password, 'request_left_approved_origin');
  if (['GET', 'HEAD'].includes(method)) return;
  requireCondition(!target.search, 'mutation_query_refused');
  const path = target.pathname;
  const post = method === 'POST';
  const ownWorker = scope.workerVerified && Number.isInteger(scope.workerId) && scope.workerId > 20;
  const recoveryHeaders = headers['x-report-recovery-worker'] === String(scope.workerId)
    && headers['x-report-recovery-department'] === '2';
  const session = post && ['/api/auth/refresh', '/api/auth/logout'].includes(path) && exactKeys(body, []);
  const login = post && path === '/api/auth/login' && exactKeys(body, ['email', 'password'])
    && ((body.email === demoEmail && body.password === scope.supervisor.password)
      || (body.email === scope.worker.email && body.password === scope.worker.password));
  const invite = post && path === '/api/supervisor/worker-invitations' && !scope.inviteAttempted
    && body.email === scope.worker.email && body.name === scope.worker.name && body.worker_class === 'normal'
    && body.department_id === 2 && exactKeys(body, ['email', 'name', 'worker_class', 'department_id']);
  const invitation = post && path === '/api/auth/worker-invitations/accept' && ownWorker
    && scope.invitationToken && body.token === scope.invitationToken && body.password === scope.worker.password
    && exactKeys(body, ['token', 'password']);
  const template = post && path === '/api/supervisor/work-forms' && !scope.templateAttempted
    && body.name === scope.templateName && body.description === scope.templateDescription
    && body.template_purpose === 'report' && body.department_id === 2
    && JSON.stringify(body.fields) === JSON.stringify(scope.fields)
    && exactKeys(body, ['name', 'description', 'template_purpose', 'department_id', 'fields']);
  const archive = method === 'PATCH' && scope.templateVerified && scope.cleanupTemplateVerified
    && path === `/api/supervisor/work-forms/${scope.templateId}`
    && body.status === 'archived' && body.confirmed === true && exactKeys(body, ['status', 'confirmed']);
  const photo = post && path === '/api/photo-uploads' && scope.allowSubmit && scope.templateVerified && ownWorker
    && ['reject_original', 'recovered'].includes(scope.uploadPhase)
    && (scope.uploadPhase !== 'recovered' || recoveryHeaders)
    && Buffer.isBuffer(bytes) && scope.photos.some((item) => item.buffer.length > 0
      && bytes.length < item.buffer.length + 4096 && bytes.includes(item.buffer)
      && bytes.subarray(0, bytes.indexOf('\r\n\r\n')).toString('utf8').includes(`filename="${item.name}"`));
  const plan = scope.reportPlans.find((item) => item.marker === body.answers?.ux_detail);
  // Endpoint probes are exact replays of an already verified owned Report;
  // even a broken identity guard cannot create a new or foreign fixture.
  const probe = post && path === '/api/form-submissions' && ownWorker && scope.endpointProbe
    && scope.verifiedReportIds.has(scope.reportPlans[0].id)
    && JSON.stringify(body) === JSON.stringify(scope.endpointProbe.body)
    && body.client_submission_id === scope.reportPlans[0].clientId
    && ['x-report-recovery-worker', 'x-report-recovery-department'].every((key) =>
      headers[key] === scope.endpointProbe.headers[key]);
  const report = post && path === '/api/form-submissions' && scope.allowSubmit && scope.templateVerified && ownWorker
    && plan && scope.currentPlan === plan && body.form_id === scope.templateId && body.work_date === scope.reportDate
    && body.site_id === null && exactKeys(body.answers, ['ux_detail']) && body.expected_definition_version === 1
    && typeof body.client_submission_id === 'string' && uuid.test(body.client_submission_id)
    && (!plan.clientId || plan.clientId === body.client_submission_id)
    && (!plan.recovery || (recoveryHeaders && scope.uploadPhase === 'recovered' && plan.clientId))
    && Array.isArray(body.photo_urls) && body.photo_urls.length === plan.photoCount
    && new Set(body.photo_urls).size === plan.photoCount && body.photo_urls.every((path) => scope.uploadPaths.has(path))
    && exactKeys(body, ['form_id', 'site_id', 'work_date', 'answers', 'photo_urls', 'photo_metadata',
      'client_submission_id', 'expected_definition_version']);
  const transition = post && scope.transitionReportId && scope.verifiedReportIds.has(scope.transitionReportId)
    && path === `/api/supervisor/form-submissions/${scope.transitionReportId}/transition`
    && ((body.status === 'in_review' && exactKeys(body, ['status']))
      || (body.status === 'resolved' && body.supervisor_note === scope.finalNote && exactKeys(body, ['status', 'supervisor_note'])));
  const trash = post && scope.cleanupReportId && scope.verifiedReportIds.has(scope.cleanupReportId)
    && path === `/api/supervisor/trash/form/${scope.cleanupReportId}`
    && body.confirmed === true && body.reason === scope.cleanupReason && exactKeys(body, ['confirmed', 'reason']);
  const resign = post && ownWorker && scope.cleanupWorkerVerified && path === `/api/supervisor/users/${scope.workerId}/status`
    && body.status === 'resigned' && body.confirmed === true && exactKeys(body, ['status', 'confirmed']);
  requireCondition(session || login || invite || invitation || template || archive || photo || report || probe || transition || trash || resign,
    'mutation_outside_owned_fixture_boundary');
}

async function poll(read, code, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await read();
    if (result) return result;
    await new Promise((done) => setTimeout(done, 250));
  }
  requireCondition(false, code);
}
async function openWorkspace(page, workspace) {
  const desktop = page.locator(`.admin-desktop-nav [data-admin-workspace-target="${workspace}"]`);
  if (await desktop.isVisible()) await desktop.click();
  else {
    await page.locator('#adminMobileMenuButton').click();
    await page.locator(`#adminWorkspaceDrawer [data-admin-workspace-target="${workspace}"]`).click();
  }
  await page.locator(`[data-admin-workspace-panel="${workspace}"]`).waitFor({ state: 'visible' });
}

export async function runOctoberRelease(config) {
  const nonce = randomUUID();
  const first = { marker: `Recovered October evidence ${nonce}`, photoCount: 7, recovery: true, clientId: null, id: null };
  const second = { marker: `Second October evidence ${nonce}`, photoCount: 0, recovery: false, clientId: null, id: null };
  const scope = { ...config, workerId: null, templateId: null,
    worker: { name: `TEST ONLY OCT ${config.runId} ${nonce}`, email: `oct-${config.runId}-${nonce}@example.invalid`,
      password: `Owned-${randomUUID()}` },
    templateName: `TEST ONLY OCT ${config.runId} ${nonce}`, templateDescription: `Owned October release ${nonce}`,
    fields: [{ id: 'ux_detail', label: 'Site observation', type: 'textarea', required: true }],
    originalMarker: `Original October evidence ${nonce}`, reportDate: '2026-10-05',
    finalNote: `Verified synthetic October report ${nonce}`, cleanupReason: `Completed owned October release ${nonce}`,
    reportPlans: [first, second], photos: [], uploadPaths: new Set(), verifiedReportIds: new Set(),
    inviteAttempted: false, templateAttempted: false, allowSubmit: false, uploadPhase: 'none', currentPlan: null };
  requireCondition(scope.worker.name.length <= 120 && scope.templateName.length <= 160, 'fixture_name_too_long');
  const evidence = { schemaVersion: 1, runId: config.runId, nonce, origin: config.baseURL,
    startedAtUtc: new Date().toISOString(), status: 'running', checks: [], owned: { departmentId: 2, reportIds: [] },
    scope: 'Real Firebase-proxy Chromium at 390px. Two new nonce-owned Reports. Not physical-phone or maximum-size-photo certification.',
    injectedFaults: ['Browser storage estimate reports low headroom only during photo selection; native writes are unchanged.',
      'Original first photo upload receives an intercepted HTTP 415 before reaching the host. Recovered uploads and all lookup/submission/review requests reach the real backend.'],
    scriptSha256: createHash('sha256').update(readFileSync(scriptPath)).digest('hex'),
    cleanup: { reportsTrashed: [], templateArchived: false, workerResigned: false, failures: [] } };
  evidenceDirectory(config.evidenceDir);
  mkdirSync(dirname(config.evidenceDir), { recursive: true });
  mkdirSync(config.evidenceDir);
  const save = () => {
    writeFileSync(join(config.evidenceDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    writeFileSync(join(config.evidenceDir, 'evidence.txt'), `October hosted verification: ${evidence.status}\nRun: ${config.runId}\nOrigin: ${config.baseURL}\n`
      + evidence.checks.map((check) => `PASS ${check.name}\n`).join('')
      + `Cleanup failures: ${evidence.cleanup.failures.length}\n`
      + 'Injected faults: storage estimate and first upload HTTP415 only. Not physical-phone/capacity certification.\n');
  };
  save();
  let browser, supervisor, worker, workerContext, sourceId, recoveryKey, stage = 'start', pageErrors = 0;
  const contexts = [], boundaryFailures = new Set();
  const writes = { rejectedUploads: 0, realUploads: 0, reports: 0, transitions: 0, endpointProbes: 0 };
  const lookupResults = [], submittedKeys = new Set();
  const api = async (page, path, method = 'GET', body) => {
    requireCondition(new URL(page.url()).origin === config.baseURL && /^\/api\/[a-z0-9/?=&_.%-]+$/i.test(path), 'api_path_outside_boundary');
    assertMutationAllowed({ url: new URL(path, config.baseURL).href, method, body }, scope);
    return page.evaluate(browserApiRequest, { path, method, body });
  };
  const newContext = async () => {
    const context = await browser.newContext({ baseURL: config.baseURL, viewport: { width: 390, height: 844 },
      isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    context.setDefaultTimeout(45000);
    context.setDefaultNavigationTimeout(45000);
    context.on('page', (page) => page.on('pageerror', () => { pageErrors += 1; }));
    await context.route('**/*', async (route) => {
      try {
        const request = route.request(), target = new URL(request.url()), path = target.pathname;
        const bytes = request.postDataBuffer(), headers = request.headers();
        const body = ['GET', 'HEAD'].includes(request.method()) || path === '/api/photo-uploads'
          ? undefined : request.postDataJSON() || {};
        assertMutationAllowed({ url: request.url(), method: request.method(), body, bytes, headers }, scope);
        if (request.method() === 'POST') {
          if (path === '/api/supervisor/worker-invitations') scope.inviteAttempted = true;
          if (path === '/api/supervisor/work-forms') scope.templateAttempted = true;
          if (path.endsWith('/transition')) writes.transitions += 1;
          if (path === '/api/form-submissions') {
            if (scope.endpointProbe) writes.endpointProbes += 1;
            else {
              scope.currentPlan.clientId = body.client_submission_id;
              scope.currentPlan.payload = structuredClone(body);
              submittedKeys.add(body.client_submission_id);
              writes.reports += 1;
            }
          }
          if (path === '/api/photo-uploads' && scope.uploadPhase === 'reject_original') {
            requireCondition(bytes.includes(scope.photos[0].buffer), 'only_first_photo_may_receive_injected_failure');
            writes.rejectedUploads += 1;
            await route.fulfill({ status: 415, contentType: 'application/json',
              body: JSON.stringify({ detail: 'This image could not be decoded. Replace the damaged photo.' }) });
            return;
          }
        }
        if ((request.method() === 'POST' && ['/api/photo-uploads', '/api/form-submissions'].includes(path))
          || (request.method() === 'GET' && path === '/api/my-form-submissions/by-client-id')) {
          const response = await route.fetch({ maxRedirects: 0, timeout: 45000 });
          requireCondition(new URL(response.url()).origin === config.baseURL
            && (response.status() < 300 || response.status() >= 400), 'network_redirect_refused');
          if (path === '/api/photo-uploads') {
            writes.realUploads += 1;
            if (response.ok()) {
              const data = await response.json();
              requireCondition(/^\/uploads\/[a-zA-Z0-9_.-]+$/.test(data.url || ''), 'uploaded_path_invalid');
              scope.uploadPaths.add(data.url);
            }
          } else if (path === '/api/form-submissions') {
            if (!scope.endpointProbe && response.ok()) {
              const data = await response.json();
              requireCondition(data.idempotent_replay === false, 'new_report_not_identified_as_first_submission');
            }
          } else {
            const data = response.ok() ? await response.json() : null;
            requireCondition(first.clientId && target.searchParams.get('client_submission_id') === first.clientId
              && target.searchParams.get('purpose') === 'report' && response.ok()
              && data.client_submission_id === first.clientId && data.worker_id === scope.workerId && data.department_id === 2
              && ['not_found', 'submitted', 'deleted'].includes(data.status)
              && /no-store/.test(response.headers()['cache-control'] || ''), 'real_recovery_lookup_identity_failed');
            lookupResults.push(data.status);
          }
          await route.fulfill({ response });
          return;
        }
        await forwardWithoutRedirects(route, config.baseURL);
      } catch (error) {
        boundaryFailures.add(safeFailure(error));
        await route.abort().catch(() => {});
      }
    });
    contexts.push(context);
    return context;
  };
  const step = async (name, action) => {
    stage = name;
    const details = await action();
    requireCondition(!boundaryFailures.size, 'request_boundary_violation');
    evidence.checks.push({ name, status: 'passed', ...(details ? { details } : {}) });
    save();
  };
  const rows = async (path) => {
    const result = await api(supervisor, path);
    requireCondition(result.ok && Array.isArray(result.body), 'owned_fixture_lookup_failed');
    return result.body;
  };
  const verifyWorker = async ({ established = true } = {}) => {
    const matches = (await rows('/api/supervisor/users')).filter((row) => row.email === scope.worker.email);
    requireCondition(matches.length === 1 && ownedWorker(matches[0], scope) && matches[0].status === 'active'
      && (!established || matches[0].password_setup_required === false), 'exact_owned_worker_required');
    scope.workerId = matches[0].id; scope.workerVerified = true; evidence.owned.workerId = scope.workerId;
    return matches[0];
  };
  const verifyTemplate = async () => {
    const matches = (await rows('/api/work-forms?purpose=report')).filter((row) => row.name === scope.templateName);
    requireCondition(matches.length === 1 && ownedTemplate(matches[0], scope), 'exact_owned_template_required');
    scope.templateId = matches[0].id; scope.templateVerified = true; evidence.owned.templateId = scope.templateId;
    return matches[0];
  };
  const verifyReports = async () => {
    const records = (await rows('/api/supervisor/form-submissions?purpose=report')).filter((row) => ownedReport(row, scope));
    requireCondition(records.length <= 2 && new Set(records.map((row) => row.client_submission_id)).size === records.length,
      'multiple_owned_reports_require_operator');
    for (const row of records) {
      const plan = scope.reportPlans.find((plan) => plan.clientId === row.client_submission_id);
      plan.id = row.id; scope.verifiedReportIds.add(row.id);
    }
    evidence.owned.reportIds = [...scope.verifiedReportIds];
    return records;
  };
  const login = async (page, account, role) => {
    await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
    await page.locator('#loginView').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#syncIndicator')?.dataset.state !== 'checking');
    await page.locator('#emailInput').fill(account.email);
    await page.locator('#passwordInput').fill(account.password);
    await page.locator('#loginSubmitButton').click();
    await page.waitForFunction((expected) => document.body.dataset.activeView === expected, role);
    await page.locator('#passwordInput').evaluate((input) => { input.value = ''; });
  };
  const storageSnapshot = () => worker.evaluate(async ({ sourceId, recoveryKey, originalMarker }) => {
    const db = await import('/assets/js/db.js');
    const records = await db.getAll('records');
    const source = sourceId ? await db.get('records', sourceId)
      : records.find((row) => row.capturedAnswers?.ux_detail === originalMarker || row.answers?.ux_detail === originalMarker);
    const digest = async (blobs) => Promise.all((blobs || []).map(async (blob) => [...new Uint8Array(
      await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map((byte) => byte.toString(16).padStart(2, '0')).join('')));
    const draft = recoveryKey ? (await db.get('drafts', recoveryKey))?.value : null;
    return { source: source ? { id: source.id, clientId: source.clientSubmissionId ?? source.client_submission_id ?? source.id,
      failedPhotoUpload: source.failedPhotoUpload, hashes: await digest(source.photoBlobs), isDraftRecovery: source.isDraftRecovery,
      recoveredToDraft: source.recoveredToDraft, answer: source.capturedAnswers?.ux_detail, workDate: source.workDate } : null,
    queueIds: (await db.getAll('queue')).map((row) => row.id),
    draft: draft ? { answer: draft.answers?.ux_detail, hashes: await digest(draft.photoBlobs), workDate: draft.workDate,
      recovery: draft.uploadRecovery } : null };
  }, { sourceId, recoveryKey, originalMarker: scope.originalMarker });
  const submitEditor = async () => {
    await worker.locator('#submitWorkFormButton').click();
    await worker.locator('#workFormReviewPanel').waitFor({ state: 'visible' });
    await worker.waitForFunction(() => !document.querySelector('#confirmWorkFormSubmitButton')?.disabled);
    await worker.locator('#confirmWorkFormSubmitButton').click();
  };
  const selectReport = async (id) => {
    const card = supervisor.locator(`#reviewQueueList [data-record-key="form:${id}"]`);
    if (!await card.isVisible() && await supervisor.locator('#reviewQueueBackButton').isVisible()) {
      await supervisor.locator('#reviewQueueBackButton').click();
    }
    await card.click();
  };
  const openNote = async () => {
    await selectReport(first.id);
    await supervisor.locator('#reviewQueueActions').getByRole('button', { name: /^(Resolve report|Continue note)$/ }).first().click();
    await supervisor.locator('#reportNotePanel').waitFor({ state: 'visible' });
    await supervisor.waitForFunction(() => {
      const field = document.querySelector('#reportResolutionNote');
      return field && !field.disabled && !field.readOnly && !field.closest('[inert]');
    });
  };
  const gallery = async (page, container) => {
    const photos = container.locator('.report-photo-gallery');
    await photos.waitFor();
    requireCondition(await photos.locator('img').count() === 6, 'gallery_not_six_previews');
    await photos.getByRole('button', { name: 'View all 7 photos', exact: true }).click();
    await page.locator('#photoViewer.photo-viewer-report-gallery').waitFor({ state: 'visible' });
    for (let index = 0; index < 7; index++) {
      await poll(() => page.locator('#photoViewerImage').evaluate((image) => image.complete && image.naturalWidth > 0), 'gallery_original_not_loaded');
      requireCondition((await page.locator('#photoViewerCaption').innerText()).includes(`${index + 1} of 7`), 'gallery_order_counter_incorrect');
      if (index < 6) await page.locator('#nextPhotoButton').click();
    }
    await page.locator('#photoViewer .photo-viewer-zoom').click();
    requireCondition(await page.locator('#photoViewer .photo-viewer-zoom').getAttribute('aria-pressed') === 'true', 'gallery_zoom_failed');
    await page.locator('#photoViewer .photo-viewer-zoom').click();
    await page.locator('#closePhotoViewerButton').click();
    await page.locator('#photoViewer').waitFor({ state: 'hidden' });
  };

  try {
    browser = await chromium.launch({ headless: true });
    supervisor = await (await newContext()).newPage();
    await step('hosted_readiness_and_exact_demo_supervisor', async () => {
      await login(supervisor, config.supervisor, 'supervisor');
      const me = await api(supervisor, '/api/auth/me'), ready = await api(supervisor, '/api/health/ready');
      requireCondition(me.ok && me.body.id === 16 && me.body.email === demoEmail && me.body.department_id === 2
        && me.body.role === 'supervisor' && !me.body.is_global_admin && me.body.status === 'active', 'exact_demo_supervisor_required');
      requireCondition(ready.ok && ['database', 'migrations', 'upload_storage'].every((key) => ready.body.checks?.[key] === 'ok')
        && ready.body.details?.upload_storage?.backend === 'gcs', 'hosted_ready_gcs_required');
    });
    await step('new_nonce_owned_worker_and_template', async () => {
      const invite = await api(supervisor, '/api/supervisor/worker-invitations', 'POST', {
        email: scope.worker.email, name: scope.worker.name, worker_class: 'normal', department_id: 2 });
      requireCondition(invite.ok && ownedWorker(invite.body.user, scope) && invite.body.user.password_setup_required === true,
        'new_invitation_not_owned');
      scope.workerId = invite.body.user.id;
      await verifyWorker({ established: false });
      scope.invitationToken = invite.body.token;
      requireCondition(/^[A-Za-z0-9_-]{32,200}$/.test(scope.invitationToken), 'invitation_capability_missing');
      const setup = await api(supervisor, '/api/auth/worker-invitations/accept', 'POST', {
        token: scope.invitationToken, password: scope.worker.password });
      requireCondition(setup.ok, 'owned_worker_setup_failed');
      await verifyWorker();
      const template = await api(supervisor, '/api/supervisor/work-forms', 'POST', {
        name: scope.templateName, description: scope.templateDescription, department_id: 2, template_purpose: 'report', fields: scope.fields });
      requireCondition(template.ok && ownedTemplate(template.body, scope), 'new_template_not_owned');
      scope.templateId = template.body.id;
      await verifyTemplate();
      workerContext = await newContext(); worker = await workerContext.newPage();
      await login(worker, scope.worker, 'worker');
      const me = await api(worker, '/api/auth/me');
      requireCondition(me.ok && ownedWorker(me.body, scope), 'owned_worker_login_identity_failed');
    });
    await step('injected_low_estimate_cancel_and_explicit_original_photo_acceptance', async () => {
      await worker.locator('#workFormSelect').selectOption(String(scope.templateId));
      await worker.locator('#workFormField_ux_detail').fill(scope.originalMarker);
      await worker.locator('#workFormDate').fill(scope.reportDate);
      const images = await worker.evaluate(() => Array.from({ length: 8 }, (_, index) => {
        const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
        const draw = canvas.getContext('2d'); draw.fillStyle = `hsl(${index * 43} 75% 45%)`; draw.fillRect(0, 0, 320, 240);
        draw.fillStyle = '#fff'; draw.font = '40px sans-serif'; draw.fillText(`OCT ${index + 1}`, 30, 100);
        return canvas.toDataURL('image/png').split(',')[1];
      }));
      scope.photos = images.map((image, index) => ({ name: `oct-${nonce}-${index + 1}.png`, buffer: Buffer.from(image, 'base64') }));
      await worker.evaluate(() => {
        window.octoberNativeEstimate = navigator.storage.estimate.bind(navigator.storage);
        window.octoberEstimateCalls = 0;
        Object.defineProperty(navigator.storage, 'estimate', { configurable: true, value: async () => {
          window.octoberEstimateCalls += 1; return { quota: 1000000, usage: 999999 };
        } });
      });
      const files = scope.photos.map((photo) => ({ ...photo, mimeType: 'image/png' }));
      await worker.locator('#workFormPhotos').setInputFiles(files);
      await worker.locator('#confirmationDialog').waitFor({ state: 'visible' });
      requireCondition(await worker.locator('#confirmationDialogTitle').innerText() === 'Check photo storage', 'storage_warning_missing');
      await worker.waitForFunction(() => document.activeElement?.id === 'confirmationDialogCancelButton');
      await worker.getByRole('button', { name: 'Choose fewer photos', exact: true }).click();
      await worker.locator('#confirmationDialog').waitFor({ state: 'hidden' });
      requireCondition(await worker.locator('#workFormPhotoPreview img').count() === 0, 'cancelled_photos_appended');
      await worker.locator('#workFormPhotos').setInputFiles(files);
      await worker.getByRole('button', { name: 'Add photos anyway', exact: true }).click();
      await poll(async () => await worker.locator('#workFormPhotoPreview img').count() === 8, 'accepted_photos_missing');
      await worker.evaluate(() => Object.defineProperty(navigator.storage, 'estimate', { configurable: true, value: window.octoberNativeEstimate }));
      requireCondition(writes.realUploads === 0 && writes.reports === 0, 'photos_uploaded_before_confirmation');
      return { injectedEstimateOnly: true, acceptedPhotos: 8, cancelledPhotos: 8 };
    });
    await step('injected_first_upload_rejection_creates_real_local_failed_report', async () => {
      scope.allowSubmit = true; scope.uploadPhase = 'reject_original';
      await submitEditor();
      const snapshot = await poll(async () => {
        const result = await storageSnapshot();
        return result.source?.failedPhotoUpload && result.queueIds.includes(result.source.id) ? result : false;
      }, 'failed_local_report_not_retained');
      sourceId = snapshot.source.id; first.clientId = snapshot.source.clientId;
      requireCondition(uuid.test(first.clientId) && snapshot.source.hashes.length === 8
        && snapshot.source.hashes.every((hash, index) => hash === createHash('sha256').update(scope.photos[index].buffer).digest('hex')),
      'failed_source_identity_or_originals_not_preserved');
      requireCondition(writes.rejectedUploads > 0 && writes.realUploads === 0 && writes.reports === 0, 'injected_failure_reached_server');
      recoveryKey = `work-form-recovery:${scope.workerId}:2:${sourceId}`;
      evidence.owned.clientSubmissionIds = [first.clientId];
      return { injectedHttpStatus: 415, realUploads: 0, realReportPosts: 0, sourceOriginals: 8 };
    });
    await step('real_backend_identity_lookup_and_atomic_recover_as_draft', async () => {
      await worker.locator('button.tab[data-tab-target="historyTab"]').click();
      const card = worker.locator('#historyList .record-form').filter({ hasText: scope.templateName }).first();
      const disclosure = card.locator('.record-disclosure-button');
      if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click();
      await worker.getByRole('button', { name: 'Recover as draft', exact: true }).click();
      const snapshot = await poll(async () => {
        const result = await storageSnapshot(); return result.draft ? result : false;
      }, 'recovery_draft_not_saved');
      requireCondition(lookupResults.includes('not_found') && snapshot.source.isDraftRecovery
        && snapshot.source.recoveredToDraft === recoveryKey && !snapshot.queueIds.includes(sourceId)
        && snapshot.source.hashes.length === 8 && snapshot.draft.answer === scope.originalMarker
        && snapshot.draft.workDate === scope.reportDate && snapshot.draft.recovery.clientSubmissionId === first.clientId
        && snapshot.draft.recovery.omittedPhotos.length === 1
        && snapshot.draft.recovery.omittedPhotos[0].name === scope.photos[0].name
        && JSON.stringify(snapshot.draft.hashes) === JSON.stringify(snapshot.source.hashes.slice(1)), 'atomic_recovery_identity_or_evidence_failed');
      scope.uploadPhase = 'recovered';
      if (!await worker.locator('#workFormField_ux_detail').isVisible()) {
        await worker.locator('#reportDraftsList .report-draft-card').filter({ hasText: 'Recovered upload draft.' })
          .getByRole('button', { name: 'Continue draft', exact: true }).click();
      }
      await poll(async () => await worker.locator('#workFormField_ux_detail').inputValue() === scope.originalMarker,
        'recovered_editor_not_restored');
      requireCondition(await worker.locator('#workFormPhotoPreview img').count() === 7 && writes.reports === 0,
        'recovery_itself_submitted_or_lost_photos');
      return { realLookup: 'not_found', retainedOriginals: 7, omittedRejectedPhotos: 1, sourceRetainedReadOnly: true };
    });
    await step('recovered_report_real_uploads_and_original_submission_key', async () => {
      await worker.locator('#workFormField_ux_detail').fill(first.marker);
      scope.currentPlan = first;
      await submitEditor();
      const reports = await poll(async () => { const result = await verifyReports(); return result.length === 1 ? result : false; },
        'recovered_report_not_durable', 90000);
      const report = reports[0];
      requireCondition(report.client_submission_id === first.clientId && report.photo_urls.length === 7
        && writes.reports === 1 && writes.realUploads === 7 && lookupResults.filter((status) => status === 'not_found').length >= 2,
      'recovered_upload_key_count_or_recheck_failed');
      scope.allowSubmit = false; scope.currentPlan = null;
      return { realUploads: 7, realReportPosts: 1, preservedClientSubmissionId: true, realLookupCount: lookupResults.length };
    });
    await step('worker_compact_gallery_seven_real_originals', async () => {
      await worker.reload({ waitUntil: 'domcontentloaded' });
      await worker.locator('#workerView').waitFor({ state: 'visible' });
      await worker.locator('button.tab[data-tab-target="historyTab"]').click();
      const card = worker.locator('#historyList .record-form').filter({ hasText: scope.templateName })
        .filter({ has: worker.locator('.record-disclosure-button') });
      // The recovered source is intentionally retained; select the durable card by its Submitted state.
      const durable = card.filter({ hasText: 'Submitted' }).first();
      await durable.locator('.record-disclosure-button').click();
      await gallery(worker, durable);
      return { compactPreviews: 6, fullGalleryOriginals: 7 };
    });
    await step('second_real_report_establishes_owned_ordering_pair', async () => {
      await worker.locator('button.tab[data-tab-target="formTab"]').click();
      await worker.locator('#workFormSelect').selectOption(String(scope.templateId));
      await worker.locator('#workFormField_ux_detail').fill(second.marker);
      await worker.locator('#workFormDate').fill(scope.reportDate);
      requireCondition(await worker.locator('#workFormPhotoPreview img').count() === 0, 'second_report_unexpected_photos');
      scope.currentPlan = second; scope.allowSubmit = true; scope.uploadPhase = 'none';
      await submitEditor();
      const reports = await poll(async () => { const result = await verifyReports(); return result.length === 2 ? result : false; },
        'second_report_not_durable');
      requireCondition(writes.reports === 2 && reports.every((row) => row.workflow_status === 'submitted'), 'owned_pair_not_submitted_once');
      scope.allowSubmit = false; scope.currentPlan = null;
      evidence.owned.clientSubmissionIds = scope.reportPlans.map((plan) => plan.clientId);
    });
    await step('real_same_key_immutable_winner_and_recovery_identity_rejection', async () => {
      await verifyReports();
      const replayBody = { ...first.payload, answers: { ux_detail: scope.originalMarker } };
      const probe = async (headers) => {
        scope.endpointProbe = { body: replayBody, headers };
        assertMutationAllowed({ url: `${scope.baseURL}/api/form-submissions`, method: 'POST', body: replayBody, headers }, scope);
        try {
          return await worker.evaluate(async ({ body, headers }) => {
            const csrf = document.cookie.split(';').map((part) => part.trim())
              .find((part) => part.startsWith('geo_csrf_token='))?.slice('geo_csrf_token='.length);
            const response = await fetch('/api/form-submissions', { method: 'POST', credentials: 'include', redirect: 'error',
              signal: AbortSignal.timeout(30000), headers: { 'Content-Type': 'application/json', ...headers,
                ...(csrf ? { 'X-CSRF-Token': decodeURIComponent(csrf) } : {}) }, body: JSON.stringify(body) });
            return { status: response.status, body: await response.json() };
          }, scope.endpointProbe);
        } finally { scope.endpointProbe = null; }
      };
      // Wrong Department and missing Department must be checked before replay.
      // No foreign account ID is sent and the key already belongs to this Worker.
      for (const headers of [
        { 'x-report-recovery-worker': String(scope.workerId), 'x-report-recovery-department': '1' },
        { 'x-report-recovery-worker': String(scope.workerId) }
      ]) {
        const rejected = await probe(headers);
        requireCondition(rejected.status === 409 && rejected.body.detail?.code === 'report_recovery_identity_mismatch',
          'recovery_identity_header_not_rejected');
      }
      const replay = await probe({ 'x-report-recovery-worker': String(scope.workerId), 'x-report-recovery-department': '2' });
      requireCondition(replay.status === 200 && replay.body.id === first.id && replay.body.idempotent_replay === true
        && replay.body.answers?.ux_detail === first.marker && replay.body.client_submission_id === first.clientId,
      'same_key_replay_changed_immutable_winner');
      const lookup = await api(worker, `/api/my-form-submissions/by-client-id?purpose=report&client_submission_id=${first.clientId}`);
      requireCondition(lookup.ok && lookup.body.status === 'submitted' && lookup.body.submission?.id === first.id
        && !Object.hasOwn(lookup.body.submission, 'idempotent_replay') && (await verifyReports()).length === 2,
      'real_exact_key_lookup_or_replay_metadata_failed');
      return { immutableWinnerReplayed: true, identityRejections: 2, exactSubmittedLookup: true, createdReportsUnchanged: 2 };
    });
    await step('oldest_waiting_real_backend_order_preference_and_shortcuts', async () => {
      await supervisor.reload({ waitUntil: 'domcontentloaded' });
      await supervisor.locator('#supervisorView').waitFor({ state: 'visible' });
      await openWorkspace(supervisor, 'review'); await showSupervisorFilters(supervisor);
      await supervisor.locator('#supervisorTemplateFilter').selectOption(String(scope.templateId));
      await supervisor.locator('#supervisorWorkerFilter').selectOption(String(scope.workerId));
      await supervisor.locator('#supervisorDateFilter').fill(scope.reportDate);
      await supervisor.locator('[data-report-workflow-shortcut=""]').click();
      await supervisor.locator('#supervisorSortOrder').selectOption('oldest_waiting');
      const queue = await api(supervisor, `/api/supervisor/review-queue?purpose=report&form_id=${scope.templateId}&worker_id=${scope.workerId}&sort_order=oldest_waiting`);
      requireCondition(queue.ok && queue.body.sort_order === 'oldest_waiting' && queue.body.items?.length === 2
        && JSON.stringify(queue.body.items.map((row) => row.id)) === JSON.stringify([first.id, second.id]), 'backend_oldest_order_not_exact');
      const pagePath = `/api/supervisor/review-queue?purpose=report&form_id=${scope.templateId}&worker_id=${scope.workerId}&sort_order=oldest_waiting&page_size=1`;
      const page1 = await api(supervisor, pagePath);
      requireCondition(page1.ok && page1.body.items.length === 1 && page1.body.items[0].id === first.id
        && page1.body.has_more && typeof page1.body.next_cursor === 'string', 'real_oldest_first_page_failed');
      const page2 = await api(supervisor, `${pagePath}&cursor=${encodeURIComponent(page1.body.next_cursor)}`);
      requireCondition(page2.ok && page2.body.items.length === 1 && page2.body.items[0].id === second.id
        && !page2.body.has_more && page2.body.next_cursor === null && page2.body.snapshot_at === page1.body.snapshot_at
        && JSON.stringify(page2.body.counts) === JSON.stringify(page1.body.counts), 'real_oldest_second_page_failed');
      const mismatch = await api(supervisor, `${pagePath}&workflow_status=submitted&cursor=${encodeURIComponent(page1.body.next_cursor)}`);
      requireCondition(mismatch.status === 400, 'oldest_cursor_filter_mismatch_not_rejected');
      const order = () => supervisor.locator('#reviewQueueList [data-record-key]').evaluateAll((cards) => cards.map((card) => card.dataset.recordKey));
      await poll(async () => JSON.stringify(await order()) === JSON.stringify([`form:${first.id}`, `form:${second.id}`]), 'ui_oldest_order_not_exact');
      await supervisor.reload({ waitUntil: 'domcontentloaded' });
      await supervisor.locator('#supervisorView').waitFor({ state: 'visible' }); await openWorkspace(supervisor, 'review');
      await poll(async () => await supervisor.locator('#supervisorSortOrder').inputValue() === 'oldest_waiting'
        && JSON.stringify(await order()) === JSON.stringify([`form:${first.id}`, `form:${second.id}`]), 'oldest_preference_not_restored');
      await supervisor.locator('[data-report-workflow-shortcut="submitted"]').click();
      requireCondition(await supervisor.locator('#supervisorSortOrder').inputValue() === 'oldest_waiting'
        && await supervisor.locator('#supervisorTemplateFilter').inputValue() === String(scope.templateId)
        && await supervisor.locator('#supervisorWorkerFilter').inputValue() === String(scope.workerId), 'shortcut_lost_order_or_owned_filters');
      await supervisor.locator('[data-report-workflow-shortcut=""]').click();
      return { sortOrder: 'oldest_waiting', reportIdsInOrder: [first.id, second.id], reloadPreference: true,
        realPages: 2, pageSize: 1, filterCursorMismatchStatus: 400 };
    });
    await step('supervisor_compact_gallery_and_real_start_review', async () => {
      await selectReport(first.id);
      await gallery(supervisor, supervisor.locator('#reviewQueueDetails'));
      await verifyReports(); scope.transitionReportId = first.id;
      const response = await api(supervisor, `/api/supervisor/form-submissions/${first.id}/transition`, 'POST', { status: 'in_review' });
      requireCondition(response.ok, 'owned_start_review_failed');
      await supervisor.reload({ waitUntil: 'domcontentloaded' });
      await supervisor.locator('#supervisorView').waitFor({ state: 'visible' }); await openWorkspace(supervisor, 'review');
      await poll(async () => JSON.stringify(await supervisor.locator('#reviewQueueList [data-record-key]').evaluateAll(
        (cards) => cards.map((card) => card.dataset.recordKey))) === JSON.stringify([`form:${second.id}`, `form:${first.id}`]),
      'workflow_rank_not_prioritized_over_age');
      return { realWorkflow: 'in_review', submittedBeforeInReview: true };
    });
    await step('private_supervisor_note_close_reload_and_explicit_real_resolution', async () => {
      const snapshotPath = `/api/supervisor/review-queue?purpose=report&form_id=${scope.templateId}&worker_id=${scope.workerId}&sort_order=oldest_waiting&page_size=1`;
      const snapshot = await api(supervisor, snapshotPath);
      requireCondition(snapshot.ok && snapshot.body.items[0]?.id === second.id && snapshot.body.next_cursor,
        'transition_snapshot_first_page_failed');
      const unfinished = `  Unfinished synthetic note ${nonce}\nKeep this device-local until explicit resolution.  `;
      await openNote();
      await supervisor.locator('#reportResolutionNote').fill(unfinished);
      await supervisor.locator('#closeReportNoteButton').click();
      await supervisor.locator('#reportNotePanel').waitFor({ state: 'hidden' });
      await poll(() => supervisor.evaluate(async (text) => (await (await import('/assets/js/db.js')).getAll('drafts'))
        .some((row) => String(row.key).startsWith('report-resolution-note:v1:') && !row.deleted
          && (row.value?.text === text || row.text === text)), unfinished), 'private_note_not_saved');
      await openNote();
      requireCondition(await supervisor.locator('#reportResolutionNote').inputValue() === unfinished, 'closed_note_not_restored');
      await supervisor.locator('#closeReportNoteButton').click();
      await supervisor.reload({ waitUntil: 'domcontentloaded' });
      await supervisor.locator('#supervisorView').waitFor({ state: 'visible' }); await openWorkspace(supervisor, 'review');
      await openNote();
      requireCondition(await supervisor.locator('#reportResolutionNote').inputValue() === unfinished && writes.transitions === 1,
        'reloaded_note_lost_or_submitted_early');
      await supervisor.locator('#reportResolutionNote').fill(scope.finalNote);
      await supervisor.locator('#resolveReportNoteButton').click();
      const report = await poll(async () => (await verifyReports()).find((row) => row.id === first.id && row.workflow_status === 'resolved'),
        'explicit_resolution_not_durable');
      requireCondition(report.supervisor_note === scope.finalNote && writes.transitions === 2, 'final_note_not_exact_or_resolution_duplicated');
      const afterTransition = await api(supervisor, `${snapshotPath}&cursor=${encodeURIComponent(snapshot.body.next_cursor)}`);
      requireCondition(afterTransition.ok && afterTransition.body.items.length === 1 && afterTransition.body.items[0].id === first.id
        && afterTransition.body.items[0].workflow_status === 'resolved' && !afterTransition.body.has_more
        && afterTransition.body.snapshot_at === snapshot.body.snapshot_at
        && JSON.stringify(afterTransition.body.counts) === JSON.stringify(snapshot.body.counts),
      'legal_transition_did_not_preserve_snapshot_traversal');
      scope.transitionReportId = null;
      return { closeRestored: true, reloadRestored: true, draftTransitions: 0, explicitResolutions: 1,
        realTransitionBetweenPagesPreservedSnapshot: true, serializedWorkflowIsCurrent: true,
        limitation: 'Does not induce a database transaction timestamped before the snapshot but committed later.' };
    });
    await step('phone_layout_and_clean_browser_errors', async () => {
      for (const page of [supervisor, worker]) requireCondition(await page.evaluate(() => document.documentElement.scrollWidth
        <= window.innerWidth + 1), 'phone_horizontal_overflow');
      requireCondition(pageErrors === 0, 'browser_page_errors_observed');
    });
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed'; evidence.failure = { checkpoint: stage, code: safeFailure(error) };
  } finally {
    // Stop browser retries before exact reconciliation. A sent-but-unknown request
    // is not a rollback; every forwarded submission key must resolve durably.
    if (workerContext) await workerContext.close().catch(() => {});
    scope.allowSubmit = false; scope.currentPlan = null; scope.transitionReportId = null;
    const cleanup = async (name, action) => {
      try { await action(); } catch (error) { evidence.cleanup.failures.push({ name, code: safeFailure(error) }); }
      save();
    };
    if (supervisor && scope.templateAttempted) await cleanup('owned_template_and_reports', async () => {
      const template = await verifyTemplate(), reports = await verifyReports();
      requireCondition([...submittedKeys].every((key) => reports.some((row) => row.client_submission_id === key)),
        'submission_outcome_unknown_requires_operator');
      const snapshotPath = `/api/supervisor/review-queue?purpose=report&form_id=${scope.templateId}&worker_id=${scope.workerId}&sort_order=oldest_waiting&page_size=1`;
      let snapshot;
      if (reports.length === 2) {
        try {
          snapshot = await api(supervisor, snapshotPath);
          requireCondition(snapshot.ok && snapshot.body.items?.length === 1 && snapshot.body.counts?.total === 2
            && snapshot.body.has_more && snapshot.body.next_cursor, 'cleanup_snapshot_first_page_failed');
        } catch (error) {
          evidence.cleanup.failures.push({ name: 'oldest_cursor_cleanup_probe', code: safeFailure(error) });
        }
      }
      let staleCursorChecked = false;
      for (const report of reports) {
        scope.cleanupReportId = report.id;
        const trashed = await api(supervisor, `/api/supervisor/trash/form/${report.id}`, 'POST', { confirmed: true, reason: scope.cleanupReason });
        requireCondition(trashed.ok, 'owned_report_soft_delete_failed'); evidence.cleanup.reportsTrashed.push(report.id);
        if (!staleCursorChecked && snapshot?.ok && snapshot.body.next_cursor) {
          staleCursorChecked = true;
          try {
            const stale = await api(supervisor, `${snapshotPath}&cursor=${encodeURIComponent(snapshot.body.next_cursor)}`);
            requireCondition(stale.status === 409 && stale.body.detail?.code === 'report_review_order_changed',
              'owned_trash_did_not_invalidate_oldest_cursor');
            evidence.checks.push({ name: 'real_owned_soft_trash_invalidates_oldest_snapshot', status: 'passed',
              details: { status: 409, code: 'report_review_order_changed',
                limitation: 'Real matching-set removal, not the locally controlled pre-snapshot late-commit transition race.' } });
          } catch (error) {
            // A failed verification must not interrupt disposal of owned fixtures.
            evidence.cleanup.failures.push({ name: 'oldest_cursor_cleanup_probe', code: safeFailure(error) });
          }
        }
      }
      scope.cleanupReportId = null;
      requireCondition((await verifyReports()).length === 0, 'owned_report_still_visible');
      scope.cleanupTemplateVerified = true;
      const archived = await api(supervisor, `/api/supervisor/work-forms/${template.id}`, 'PATCH', { status: 'archived', confirmed: true });
      requireCondition(archived.ok && archived.body.status === 'archived', 'owned_template_archive_failed');
      evidence.cleanup.templateArchived = true;
    });
    if (supervisor && scope.inviteAttempted) await cleanup('owned_worker', async () => {
      await verifyWorker({ established: false }); scope.cleanupWorkerVerified = true;
      const resigned = await api(supervisor, `/api/supervisor/users/${scope.workerId}/status`, 'POST', { status: 'resigned', confirmed: true });
      requireCondition(resigned.ok && ownedWorker(resigned.body, scope) && resigned.body.status === 'resigned', 'owned_worker_resign_failed');
      evidence.cleanup.workerResigned = true;
    });
    if (boundaryFailures.size) evidence.cleanup.failures.push(...[...boundaryFailures].map((code) => ({ name: 'request_boundary', code })));
    if (evidence.cleanup.failures.length) evidence.status = 'failed';
    evidence.browserPageErrors = pageErrors; evidence.requests = writes;
    evidence.completedAtUtc = new Date().toISOString(); scope.worker.password = ''; scope.invitationToken = '';
    await Promise.allSettled(contexts.map((context) => context.close()));
    if (browser) await browser.close().catch(() => {});
    save();
  }
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const result = await runOctoberRelease(readConfiguration());
    console.log(JSON.stringify({ status: result.status, checkpoints: result.checks.length }));
    if (result.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ status: 'refused', code: safeFailure(error) })); process.exitCode = 1;
  }
}
