import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { chromium } from 'playwright';
import { approvedOrigin, evidenceDirectory, forwardWithoutRedirects, safeFailure } from './check-hosted-onboarding-release.mjs';
import { browserApiRequest, showSupervisorFilters } from './check-hosted-report-workflow.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const demoEmail = 'demo-20260916-supervisor@example.invalid';
function requireCondition(condition, code) {
  if (!condition) { const error = new Error(code); error.safeCode = code; throw error; }
}
const exactKeys = (body, keys) => body && typeof body === 'object' && !Array.isArray(body)
  && Object.keys(body).every((key) => keys.includes(key));

export function readConfiguration(args = process.argv.slice(2), env = process.env) {
  requireCondition(args.length === 3 && args[0] === '--allow-hosted-mutations' && args[1] === '--run-id',
    'explicit_mutation_flag_and_run_id_required');
  requireCondition(/^[a-z0-9][a-z0-9_-]{3,39}$/.test(args[2]), 'invalid_run_id');
  const baseURL = approvedOrigin(env.HOSTED_REPORT_BASE_URL || '');
  requireCondition(new URL(baseURL).host === env.HOSTED_REPORT_ALLOWED_HOST, 'exact_host_allowlist_required');
  requireCondition(env.HOSTED_REPORT_SUPERVISOR_EMAIL === demoEmail
    && env.HOSTED_REPORT_SUPERVISOR_PASSWORD?.length >= 8, 'exact_demo_supervisor_required');
  return { runId: args[2], baseURL, evidenceDir: evidenceDirectory(env.HOSTED_UX_EVIDENCE_DIR),
    supervisor: { email: demoEmail, password: env.HOSTED_REPORT_SUPERVISOR_PASSWORD } };
}

export function ownedWorker(row, scope) {
  return Boolean(row && Number.isInteger(row.id) && row.id > 20 && (!scope.workerId || row.id === scope.workerId)
    && row.email === scope.worker.email && row.name === scope.worker.name && row.department_id === 2
    && row.role === 'worker' && row.worker_class === 'normal' && !row.is_global_admin);
}
export function ownedTemplate(row, scope) {
  return Boolean(row && Number.isInteger(row.id) && row.id > 15 && (!scope.templateId || row.id === scope.templateId)
    && row.name === scope.templateName && row.description === scope.templateDescription
    && row.department_id === 2 && row.created_by === 16 && row.template_purpose === 'report');
}
export function ownedReport(row, scope) {
  return Boolean(row && Number.isInteger(row.id) && row.form_id === scope.templateId && row.worker_id === scope.workerId
    && row.submission_purpose === 'report' && row.work_date === scope.reportDate
    && row.answers?.ux_detail === scope.marker && (!scope.clientId || row.client_submission_id === scope.clientId));
}

// All writes, including those initiated by the application, are independently
// constrained to exact nonce-owned fixtures. GETs still require the fixed origin.
export function assertMutationAllowed({ url, method, body = {}, bytes }, scope) {
  const target = new URL(url);
  requireCondition(target.origin === scope.baseURL && !target.username && !target.password, 'request_left_approved_origin');
  if (['GET', 'HEAD'].includes(method)) return;
  requireCondition(!target.search, 'mutation_query_refused');
  const path = target.pathname;
  const post = method === 'POST';
  const ownWorker = scope.workerVerified && Number.isInteger(scope.workerId) && scope.workerId > 20;
  const session = post && ['/api/auth/refresh', '/api/auth/logout'].includes(path) && exactKeys(body, []);
  const login = post && path === '/api/auth/login' && exactKeys(body, ['email', 'password'])
    && ((body.email === demoEmail && body.password === scope.supervisor.password)
      || (body.email === scope.worker.email && [scope.worker.password, scope.worker.newPassword].includes(body.password)));
  const invite = post && path === '/api/supervisor/worker-invitations' && !scope.inviteAttempted
    && body.email === scope.worker.email && body.name === scope.worker.name && body.worker_class === 'normal'
    && body.department_id === 2 && exactKeys(body, ['email', 'name', 'worker_class', 'department_id']);
  const invitation = post && ['/api/auth/worker-invitations/inspect', '/api/auth/worker-invitations/accept'].includes(path)
    && ownWorker && scope.invitationToken && body.token === scope.invitationToken
    && exactKeys(body, path.endsWith('/accept') ? ['token', 'password'] : ['token'])
    && (!path.endsWith('/accept') || body.password === scope.worker.password);
  const recovery = ownWorker && scope.establishedVerified
    && path === `/api/supervisor/users/${scope.workerId}/password-recovery`
    && ['POST', 'DELETE'].includes(method) && exactKeys(body, []);
  const recoverAccept = post && ownWorker && scope.establishedVerified
    && ['/api/auth/worker-password-recovery/inspect', '/api/auth/worker-password-recovery/accept'].includes(path)
    && scope.recoveryTokens.has(body.token)
    && exactKeys(body, path.endsWith('/accept') ? ['token', 'password'] : ['token'])
    && (!path.endsWith('/accept') || body.password === scope.worker.newPassword);
  const template = post && path === '/api/supervisor/work-forms' && !scope.templateAttempted
    && body.name === scope.templateName && body.description === scope.templateDescription
    && body.template_purpose === 'report' && body.department_id === 2
    && JSON.stringify(body.fields) === JSON.stringify(scope.fields)
    && exactKeys(body, ['name', 'description', 'template_purpose', 'department_id', 'fields']);
  const lifecycle = method === 'PATCH' && scope.templateVerified
    && path === `/api/supervisor/work-forms/${scope.templateId}`
    && ['active', 'archived'].includes(body.status) && body.confirmed === true && exactKeys(body, ['status', 'confirmed']);
  const photo = post && path === '/api/photo-uploads' && scope.allowSubmit && scope.templateVerified && ownWorker
    && Buffer.isBuffer(bytes) && scope.photoBuffer?.length > 0
    && bytes.length < scope.photoBuffer.length + 4096 && bytes.includes(scope.photoBuffer)
    && bytes.subarray(0, bytes.indexOf('\r\n\r\n')).toString('utf8').includes(`filename="${scope.photoName}"`);
  const report = post && path === '/api/form-submissions' && scope.allowSubmit && scope.templateVerified && ownWorker
    && body.form_id === scope.templateId && body.work_date === scope.reportDate && body.site_id === null
    && body.answers?.ux_detail === scope.marker && exactKeys(body.answers, ['ux_detail'])
    && body.expected_definition_version === 1 && typeof body.client_submission_id === 'string'
    && /^[a-f0-9-]{36}$/.test(body.client_submission_id)
    && (!scope.clientId || scope.clientId === body.client_submission_id)
    && body.photo_urls?.length === 1 && scope.uploadPaths.has(body.photo_urls[0])
    && exactKeys(body, ['form_id', 'site_id', 'work_date', 'answers', 'photo_urls', 'photo_metadata', 'client_submission_id', 'expected_definition_version']);
  const trash = post && scope.cleanupReportVerified && path === `/api/supervisor/trash/form/${scope.reportId}`
    && body.confirmed === true && body.reason === scope.cleanupReason && exactKeys(body, ['confirmed', 'reason']);
  const resign = post && ownWorker && scope.cleanupWorkerVerified && path === `/api/supervisor/users/${scope.workerId}/status`
    && body.status === 'resigned' && body.confirmed === true && exactKeys(body, ['status', 'confirmed']);
  requireCondition(session || login || invite || invitation || recovery || recoverAccept || template || lifecycle
    || photo || report || trash || resign, 'mutation_outside_owned_fixture_boundary');
}

async function poll(read, code, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await read();
    if (result) return result;
    await new Promise((done) => setTimeout(done, 300));
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
async function responseTo(page, path, method, action) {
  const [response] = await Promise.all([page.waitForResponse((item) => new URL(item.url()).pathname === path
    && item.request().method() === method), action()]);
  return response;
}

export async function searchTemplateLibrary(page, templateId, search) {
  const card = page.locator(`[data-template-id="${templateId}"]`);
  // Visibility of the workspace precedes its asynchronous catalog render.
  // Wait for the owned catalog entry before testing the initialized search UI.
  await card.waitFor();
  await page.locator('#workFormSearchInput').fill(search);
  requireCondition(await page.locator('#workFormsList article').count() === 1, 'template_name_search_not_exact');
  requireCondition(await page.locator('#workFormSearchInput').inputValue() === search
    && await card.count() === 1, 'template_search_not_preserved');
  return card;
}

export async function runUxRelease(config) {
  const nonce = randomUUID();
  const scope = { ...config, workerId: null, templateId: null, reportId: null, clientId: null,
    worker: { name: `TEST ONLY UX ${config.runId} ${nonce}`, email: `ux-${config.runId}-${nonce}@example.invalid`,
      password: `Owned-${randomUUID()}`, newPassword: `Reset-${randomUUID()}` },
    templateName: `TEST ONLY UX ${config.runId} ${nonce}`, templateDescription: `Owned release UX ${nonce}`,
    fields: [{ id: 'ux_detail', label: 'Site observation', type: 'textarea', required: true }],
    marker: `Synthetic UX evidence ${nonce}`, reportDate: '2026-09-29',
    cleanupReason: `Completed owned UX release ${nonce}`, recoveryTokens: new Set(), uploadPaths: new Set(),
    photoName: `ux-${nonce}.png`, inviteAttempted: false, templateAttempted: false, allowSubmit: false };
  requireCondition(scope.worker.name.length <= 120 && scope.templateName.length <= 160, 'fixture_name_too_long');
  const evidence = { schemaVersion: 1, runId: config.runId, nonce, origin: config.baseURL,
    startedAtUtc: new Date().toISOString(), status: 'running', checks: [], owned: {},
    scope: 'Real Firebase-proxy Chromium at 390px; new nonce-owned Worker only; not physical-phone or maximum-size-photo certification',
    scriptSha256: createHash('sha256').update(readFileSync(scriptPath)).digest('hex'),
    cleanup: { reportTrashed: false, templateArchived: false, workerResigned: false, failures: [] } };
  evidenceDirectory(config.evidenceDir);
  mkdirSync(dirname(config.evidenceDir), { recursive: true });
  mkdirSync(config.evidenceDir);
  const save = () => writeFileSync(join(config.evidenceDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  save();
  let browser, supervisor, supervisorContext, worker, workerContext, stage = 'start', pageErrors = 0;
  const contexts = [], boundaryFailures = new Set(), writes = { photos: 0, reports: 0 };
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
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const bytes = request.postDataBuffer();
        const body = ['GET', 'HEAD'].includes(request.method()) || path === '/api/photo-uploads'
          ? undefined : request.postDataJSON() || {};
        assertMutationAllowed({ url: request.url(), method: request.method(), body, bytes }, scope);
        if (request.method() === 'POST') {
          if (path === '/api/supervisor/worker-invitations') scope.inviteAttempted = true;
          if (path === '/api/supervisor/work-forms') scope.templateAttempted = true;
          if (path === '/api/form-submissions') { writes.reports += 1; scope.clientId = body.client_submission_id; }
          if (path === '/api/photo-uploads') {
            writes.photos += 1;
            const response = await route.fetch({ maxRedirects: 0, timeout: 45000 });
            requireCondition(new URL(response.url()).origin === config.baseURL
              && (response.status() < 300 || response.status() >= 400), 'network_redirect_refused');
            if (response.ok()) {
              const data = await response.json();
              requireCondition(/^\/uploads\/[a-zA-Z0-9_.-]+$/.test(data.url || ''), 'uploaded_path_invalid');
              scope.uploadPaths.add(data.url);
            }
            await route.fulfill({ response });
            return;
          }
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
    scope.workerId = matches[0].id;
    scope.workerVerified = true;
    if (established) scope.establishedVerified = true;
    evidence.owned.workerId = scope.workerId;
    return matches[0];
  };
  const verifyTemplate = async () => {
    const matches = (await rows('/api/work-forms?purpose=report')).filter((row) => row.name === scope.templateName);
    requireCondition(matches.length === 1 && ownedTemplate(matches[0], scope), 'exact_owned_template_required');
    scope.templateId = matches[0].id;
    scope.templateVerified = true;
    evidence.owned.templateId = scope.templateId;
    return matches[0];
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
  const recoveryAction = async (action) => {
    await verifyWorker(); // Mandatory durable ownership check before every issuance/revocation/reset.
    await openWorkspace(supervisor, 'people');
    await supervisor.locator('#staffSearchInput').fill(scope.worker.email);
    const button = supervisor.locator(`[data-password-recovery-user-id="${scope.workerId}"]`)
      .filter({ hasText: action === 'revoke' ? 'Revoke recovery link' : /Create recovery link|Replace recovery link/ });
    const path = `/api/supervisor/users/${scope.workerId}/password-recovery`;
    const response = await responseTo(supervisor, path, action === 'revoke' ? 'DELETE' : 'POST', async () => {
      await button.click();
      await supervisor.locator('#confirmationDialogConfirmButton').click();
    });
    requireCondition(response.ok() && /no-store/.test(response.headers()['cache-control'] || ''), 'recovery_action_failed');
    if (action === 'revoke') return null;
    const result = await response.json();
    requireCondition(ownedWorker(result.user, scope) && result.user.status === 'active'
      && result.user.password_setup_required === false && result.delivery_method === 'manual'
      && /^[A-Za-z0-9_-]{32,200}$/.test(result.token), 'recovery_response_not_owned');
    const lifetime = Date.parse(result.expires_at) - Date.now();
    requireCondition(lifetime > 0 && lifetime <= 3601000, 'recovery_expiry_out_of_bounds');
    scope.recoveryTokens.add(result.token);
    await supervisor.locator('#workerInvitationDialog[open]').waitFor();
    const link = new URL(await supervisor.locator('#workerInvitationLink').inputValue());
    requireCondition(link.origin === config.baseURL && link.pathname === '/recover-password.html'
      && !link.search && link.hash === `#token=${result.token}`, 'recovery_fragment_link_invalid');
    requireCondition(await supervisor.locator('#copyWorkerInvitationButton').isVisible(), 'private_copy_control_missing');
    // Do not write a capability to the OS clipboard or invoke an external sharing destination.
    await supervisor.locator('#closeWorkerInvitationButton').click();
    requireCondition(!await supervisor.locator('#workerInvitationLink').inputValue(), 'closed_recovery_token_retained');
    return result.token;
  };
  const draftSnapshot = () => worker.evaluate(async ({ workerId, templateId }) => {
    const { getDraft } = await import('/assets/js/mock-api.js');
    const draft = await getDraft(`work-form-draft:${workerId}:${templateId}`);
    if (!draft) return null;
    const hashes = [];
    for (const blob of draft.photoBlobs || []) hashes.push([...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join(''));
    return { answer: draft.answers?.ux_detail, date: draft.workDate, hashes };
  }, { workerId: scope.workerId, templateId: scope.templateId });

  try {
    browser = await chromium.launch({ headless: true });
    supervisorContext = await newContext();
    supervisor = await supervisorContext.newPage();
    await step('hosted_readiness_and_exact_demo_supervisor', async () => {
      await login(supervisor, config.supervisor, 'supervisor');
      const me = await api(supervisor, '/api/auth/me');
      requireCondition(me.ok && me.body.id === 16 && me.body.email === demoEmail && me.body.department_id === 2
        && me.body.role === 'supervisor' && !me.body.is_global_admin && me.body.status === 'active', 'exact_demo_supervisor_required');
      const ready = await api(supervisor, '/api/health/ready');
      requireCondition(ready.ok && ['database', 'migrations', 'upload_storage'].every((key) => ready.body.checks?.[key] === 'ok')
        && ready.body.details?.upload_storage?.backend === 'gcs', 'hosted_ready_gcs_required');
      evidence.owned.departmentId = 2;
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
      workerContext = await newContext();
      worker = await workerContext.newPage();
      await login(worker, scope.worker, 'worker');
      const me = await api(worker, '/api/auth/me');
      requireCondition(me.ok && ownedWorker(me.body, scope), 'owned_worker_login_identity_failed');
    });
    await step('template_library_search_lifecycle_and_preview', async () => {
      await supervisor.reload({ waitUntil: 'domcontentloaded' });
      await supervisor.locator('#supervisorView').waitFor({ state: 'visible' });
      await openWorkspace(supervisor, 'forms');
      requireCondition(await supervisor.locator('#workFormStatusFilter').inputValue() === 'active', 'template_default_not_active');
      const card = await searchTemplateLibrary(supervisor, scope.templateId, nonce);
      requireCondition((await card.locator('.template-library-summary').innerText()).includes('1 field'), 'compact_template_summary_missing');
      await card.getByRole('button', { name: 'Preview', exact: true }).click();
      requireCondition(await card.locator('[data-work-form-preview]').isVisible()
        && (await card.innerText()).includes('Site observation'), 'template_preview_missing');
      await card.getByRole('button', { name: 'Archive', exact: true }).click();
      await poll(async () => !(await card.count()), 'archived_template_still_in_active');
      await supervisor.locator('#workFormStatusFilter').selectOption('archived');
      await card.waitFor();
      await card.getByRole('button', { name: 'Activate', exact: true }).click();
      await poll(async () => !(await card.count()), 'activated_template_still_archived');
      await supervisor.locator('#workFormStatusFilter').selectOption('active');
      await card.waitFor();
      await supervisor.locator('#workFormSearchInput').fill(scope.templateDescription);
      requireCondition(await card.count() === 1, 'template_description_search_failed');
      requireCondition((await verifyTemplate()).status === 'active', 'template_reactivation_not_durable');
    });
    await step('mixed_photo_selection_lightweight_preview_and_original_draft', async () => {
      await worker.reload({ waitUntil: 'domcontentloaded' });
      await worker.locator('#workerView').waitFor({ state: 'visible' });
      await worker.locator('#workFormSelect').selectOption(String(scope.templateId));
      await worker.locator('#workFormField_ux_detail').fill(scope.marker);
      await worker.locator('#workFormDate').fill(scope.reportDate);
      const image = await worker.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 768;
        const draw = canvas.getContext('2d'); draw.fillStyle = '#1b65d8'; draw.fillRect(0, 0, 1024, 768);
        draw.fillStyle = '#ffda3a'; draw.fillRect(30, 40, 350, 160);
        return canvas.toDataURL('image/png').split(',')[1];
      });
      scope.photoBuffer = Buffer.from(image, 'base64');
      const originalHash = createHash('sha256').update(scope.photoBuffer).digest('hex');
      await worker.locator('#workFormPhotos').setInputFiles([
        { name: 'unsupported.pdf', mimeType: 'application/pdf', buffer: Buffer.from('Synthetic non-image') },
        { name: scope.photoName, mimeType: 'image/png', buffer: scope.photoBuffer },
        { name: 'oversized.png', mimeType: 'image/png', buffer: Buffer.alloc(5 * 1024 * 1024 + 1) }
      ]);
      await worker.locator('#workFormPhotoSelectionFeedback').waitFor({ state: 'visible' });
      const rejected = await worker.locator('[data-photo-rejected-name]').allTextContents();
      requireCondition(JSON.stringify(rejected) === JSON.stringify(['unsupported.pdf', 'oversized.png']), 'mixed_batch_rejections_incorrect');
      await poll(() => worker.locator('#workFormPhotoPreview img').evaluateAll((images) => images.length === 1
        && images[0].complete && !images[0].hidden && images[0].naturalWidth <= 320 && images[0].naturalHeight <= 320),
      'lightweight_thumbnail_not_ready');
      const draft = await poll(async () => {
        const snapshot = await draftSnapshot();
        return snapshot?.answer === scope.marker && snapshot.hashes[0] === originalHash ? snapshot : false;
      }, 'draft_original_photo_hash_mismatch');
      requireCondition(writes.photos === 0 && writes.reports === 0, 'evidence_uploaded_before_confirmation');
      return { acceptedPhotos: 1, rejectedFiles: 2, originalSha256: draft.hashes[0], thumbnailMaxEdge: 320 };
    });
    await step('compact_review_back_and_explicit_submission_boundary', async () => {
      await worker.locator('#submitWorkFormButton').click();
      await worker.locator('#workFormReviewPanel').waitFor({ state: 'visible' });
      const review = await worker.locator('#workFormReviewSummary').innerText();
      requireCondition([scope.reportDate, scope.marker, 'No site selected', 'Photos'].every((part) => review.includes(part)), 'review_summary_incomplete');
      requireCondition(writes.photos === 0 && writes.reports === 0, 'review_uploaded_or_submitted_early');
      const before = await api(worker, '/api/my-form-submissions?purpose=report');
      requireCondition(before.ok && before.body.length === 0, 'report_exists_before_confirmation');
      await worker.locator('#workFormReviewBackButton').click();
      requireCondition(await worker.locator('#workFormField_ux_detail').inputValue() === scope.marker, 'review_back_lost_answer');
      await worker.locator('#submitWorkFormButton').click();
      await worker.locator('#workFormReviewPanel').waitFor({ state: 'visible' });
      scope.allowSubmit = true;
      await worker.locator('#confirmWorkFormSubmitButton').click();
      const report = await poll(async () => {
        const response = await api(worker, '/api/my-form-submissions?purpose=report');
        return response.ok && response.body.find((row) => ownedReport(row, scope));
      }, 'confirmed_report_not_durable');
      scope.allowSubmit = false;
      scope.reportId = report.id;
      evidence.owned.reportId = report.id;
      requireCondition(writes.photos === 1 && writes.reports === 1 && report.photo_urls.length === 1, 'confirmation_not_exactly_once');
    });
    await step('structured_review_filters_reload_and_workflow_shortcuts', async () => {
      await supervisor.reload({ waitUntil: 'domcontentloaded' });
      await supervisor.locator('#supervisorView').waitFor({ state: 'visible' });
      await openWorkspace(supervisor, 'review');
      await showSupervisorFilters(supervisor);
      await supervisor.locator('#supervisorTemplateFilter').selectOption(String(scope.templateId));
      await supervisor.locator('#supervisorWorkerFilter').selectOption(String(scope.workerId));
      await supervisor.locator('#supervisorDateFilter').fill(scope.reportDate);
      await supervisor.locator('[data-report-workflow-shortcut="submitted"]').click();
      await supervisor.locator('#supervisorSearchInput').fill(scope.marker);
      await poll(async () => await supervisor.locator('#reviewQueueList .record-form').count() === 1, 'owned_filtered_report_missing');
      await supervisor.reload({ waitUntil: 'domcontentloaded' });
      await supervisor.locator('#supervisorView').waitFor({ state: 'visible' });
      await openWorkspace(supervisor, 'review');
      await poll(() => supervisor.locator('#supervisorTemplateFilter').isEnabled(), 'review_filter_catalog_not_ready');
      const filters = await supervisor.evaluate(() => Object.fromEntries(['supervisorTemplateFilter', 'supervisorWorkerFilter',
        'supervisorDateFilter', 'supervisorStatusFilter', 'supervisorSearchInput', 'supervisorSortOrder'].map((id) => [id, document.getElementById(id).value])));
      requireCondition(filters.supervisorTemplateFilter === String(scope.templateId) && filters.supervisorWorkerFilter === String(scope.workerId)
        && filters.supervisorDateFilter === scope.reportDate && filters.supervisorStatusFilter === 'submitted'
        && filters.supervisorSearchInput === '' && filters.supervisorSortOrder === 'newest', 'structured_filters_not_restored_or_search_persisted');
      const stored = await supervisor.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('report-review-preferences:'))
        .map((key) => JSON.parse(localStorage.getItem(key))));
      requireCondition(stored.length > 0 && !JSON.stringify(stored).includes(scope.marker)
        && stored.every((entry) => Object.keys(entry.filters).every((key) => ['status', 'formId', 'workerId', 'date', 'sortOrder'].includes(key))
          && (entry.filters.sortOrder === undefined || ['newest', 'oldest_waiting'].includes(entry.filters.sortOrder))),
      'private_search_or_unstructured_values_persisted');
      requireCondition(stored.some((entry) => entry.filters.formId === String(scope.templateId)
        && entry.filters.workerId === String(scope.workerId) && entry.filters.date === scope.reportDate
        && entry.filters.status === 'submitted' && entry.filters.sortOrder === 'newest'), 'current_review_sort_not_persisted');
      await supervisor.locator('[data-report-workflow-shortcut="in_review"]').click();
      await poll(async () => await supervisor.locator('#reviewQueueList .record-form').count() === 0, 'in_review_shortcut_not_applied');
      requireCondition(await supervisor.locator('#supervisorTemplateFilter').inputValue() === String(scope.templateId)
        && await supervisor.locator('#supervisorWorkerFilter').inputValue() === String(scope.workerId), 'shortcut_cleared_other_filters');
      await supervisor.locator('[data-report-workflow-shortcut="submitted"]').click();
      await poll(async () => await supervisor.locator('#reviewQueueList .record-form').count() === 1, 'submitted_shortcut_not_restored');
    });
    await step('private_recovery_replace_revoke_and_expiry', async () => {
      await supervisor.reload({ waitUntil: 'domcontentloaded' });
      await supervisor.locator('#supervisorView').waitFor({ state: 'visible' });
      const first = await recoveryAction('create');
      const second = await recoveryAction('create');
      requireCondition(first !== second, 'replacement_token_not_rotated');
      const replaced = await api(supervisor, '/api/auth/worker-password-recovery/inspect', 'POST', { token: first });
      requireCondition(replaced.status === 400, 'replaced_link_still_works');
      await recoveryAction('revoke');
      const revoked = await api(supervisor, '/api/auth/worker-password-recovery/inspect', 'POST', { token: second });
      requireCondition(revoked.status === 400, 'revoked_link_still_works');
      scope.acceptToken = await recoveryAction('create');
    });
    await step('cookie_free_reset_preserves_supervisor_and_worker_draft', async () => {
      await verifyWorker();
      await worker.locator('#workFormSelect').selectOption(String(scope.templateId));
      const draftMarker = `Unfinished after submission ${nonce}`;
      await worker.locator('#workFormField_ux_detail').fill(draftMarker);
      await poll(async () => (await draftSnapshot())?.answer === draftMarker, 'unfinished_draft_not_saved');
      const draftBefore = JSON.stringify(await draftSnapshot());
      const recoveryPage = await supervisorContext.newPage();
      await recoveryPage.goto(`/recover-password.html#token=${scope.acceptToken}`, { waitUntil: 'domcontentloaded' });
      await recoveryPage.locator('#recoveryPasswordForm').waitFor({ state: 'visible' });
      requireCondition(!new URL(recoveryPage.url()).hash && !new URL(recoveryPage.url()).search
        && (await recoveryPage.locator('#recoveryIdentity').innerText()).includes(scope.worker.email), 'recovery_page_identity_or_fragment_failed');
      const cookies = async () => JSON.stringify((await supervisorContext.cookies(config.baseURL))
        .filter((cookie) => ['__session', 'geo_csrf_token', 'geo_access_token'].includes(cookie.name))
        .map(({ name, value }) => ({ name, value })).sort((a, b) => a.name.localeCompare(b.name)));
      const beforeCookies = await cookies();
      const beforeIdentity = await recoveryPage.evaluate(() => localStorage.getItem('geo_user'));
      await recoveryPage.locator('#recoveryPasswordInput').fill(scope.worker.newPassword);
      await recoveryPage.locator('#recoveryPasswordConfirmInput').fill(scope.worker.newPassword);
      const response = await responseTo(recoveryPage, '/api/auth/worker-password-recovery/accept', 'POST',
        () => recoveryPage.locator('#recoveryPasswordButton').click());
      requireCondition(response.ok() && !response.headers()['set-cookie'] && !await response.request().headerValue('cookie')
        && /no-store/.test(response.headers()['cache-control'] || ''), 'reset_not_cookie_free');
      await recoveryPage.locator('#recoveryPasswordStatus').getByText('Password reset. You can now sign in to ReportFlow.', { exact: true }).waitFor();
      requireCondition(await cookies() === beforeCookies && await recoveryPage.evaluate(() => localStorage.getItem('geo_user')) === beforeIdentity,
        'reset_changed_supervisor_browser_identity');
      const supervisorMe = await api(supervisor, '/api/auth/me');
      requireCondition(supervisorMe.ok && supervisorMe.body.id === 16, 'supervisor_session_lost');
      const old = await api(worker, '/api/auth/me');
      const refresh = await api(worker, '/api/auth/refresh', 'POST');
      requireCondition(old.status === 401 && refresh.status === 401, 'old_worker_session_not_revoked');
      const password = await api(worker, '/api/auth/login', 'POST', { email: scope.worker.email, password: scope.worker.password });
      requireCondition([400, 401].includes(password.status), 'old_password_still_works');
      const reused = await api(supervisor, '/api/auth/worker-password-recovery/accept', 'POST', {
        token: scope.acceptToken, password: scope.worker.newPassword });
      requireCondition(reused.status === 400, 'recovery_not_single_use');
      requireCondition(JSON.stringify(await draftSnapshot()) === draftBefore, 'reset_changed_device_draft');
      await worker.reload({ waitUntil: 'domcontentloaded' });
      await login(worker, { email: scope.worker.email, password: scope.worker.newPassword }, 'worker');
      const me = await api(worker, '/api/auth/me');
      requireCondition(me.ok && ownedWorker(me.body, scope), 'new_password_login_failed');
      await worker.locator('#workFormSelect').selectOption(String(scope.templateId));
      await poll(async () => await worker.locator('#workFormField_ux_detail').inputValue() === draftMarker, 'draft_not_restored_after_relogin');
      await recoveryPage.close();
    });
    await step('phone_layout_and_clean_browser_errors', async () => {
      for (const page of [supervisor, worker]) requireCondition(await page.evaluate(() => document.documentElement.scrollWidth
        <= window.innerWidth + 1), 'phone_horizontal_overflow');
      requireCondition(pageErrors === 0, 'browser_page_errors_observed');
    });
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.failure = { checkpoint: stage, code: safeFailure(error) };
  } finally {
    // Closing the only submission context prevents new client retries. A sent
    // request is still not a rollback: unknown outcomes remain explicit failures.
    if (workerContext) await workerContext.close().catch(() => {});
    scope.allowSubmit = false;
    const cleanup = async (name, action) => {
      try { await action(); } catch (error) { evidence.cleanup.failures.push({ name, code: safeFailure(error) }); }
      save();
    };
    if (supervisor && scope.templateAttempted) await cleanup('owned_template_and_report', async () => {
      const template = await verifyTemplate();
      const reports = (await rows('/api/supervisor/form-submissions?purpose=report')).filter((row) => ownedReport(row, scope));
      requireCondition(reports.length <= 1, 'multiple_owned_reports_require_operator');
      if (writes.reports && !reports.length && !scope.reportId) requireCondition(false, 'submission_outcome_unknown_requires_operator');
      for (const report of reports) {
        scope.reportId = report.id; evidence.owned.reportId = report.id; scope.cleanupReportVerified = true;
        const trashed = await api(supervisor, `/api/supervisor/trash/form/${report.id}`, 'POST', {
          confirmed: true, reason: scope.cleanupReason });
        requireCondition(trashed.ok, 'owned_report_soft_delete_failed');
        evidence.cleanup.reportTrashed = true;
      }
      requireCondition(!(await rows('/api/supervisor/form-submissions?purpose=report')).some((row) => ownedReport(row, scope)),
        'owned_report_still_visible');
      const archived = await api(supervisor, `/api/supervisor/work-forms/${template.id}`, 'PATCH', { status: 'archived', confirmed: true });
      requireCondition(archived.ok && archived.body.status === 'archived', 'owned_template_archive_failed');
      evidence.cleanup.templateArchived = true;
    });
    if (supervisor && scope.inviteAttempted) await cleanup('owned_worker', async () => {
      await verifyWorker({ established: false });
      scope.cleanupWorkerVerified = true;
      const resigned = await api(supervisor, `/api/supervisor/users/${scope.workerId}/status`, 'POST', { status: 'resigned', confirmed: true });
      requireCondition(resigned.ok && ownedWorker(resigned.body, scope) && resigned.body.status === 'resigned', 'owned_worker_resign_failed');
      evidence.cleanup.workerResigned = true;
    });
    if (boundaryFailures.size) evidence.cleanup.failures.push(...[...boundaryFailures].map((code) => ({ name: 'request_boundary', code })));
    if (evidence.cleanup.failures.length) evidence.status = 'failed';
    evidence.browserPageErrors = pageErrors;
    evidence.completedAtUtc = new Date().toISOString();
    scope.worker.password = ''; scope.worker.newPassword = ''; scope.invitationToken = ''; scope.acceptToken = '';
    scope.recoveryTokens.clear();
    await Promise.allSettled(contexts.map((context) => context.close()));
    if (browser) await browser.close().catch(() => {});
    save();
  }
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const result = await runUxRelease(readConfiguration());
    console.log(JSON.stringify({ status: result.status, checkpoints: result.checks.length }));
    if (result.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ status: 'refused', code: safeFailure(error) }));
    process.exitCode = 1;
  }
}
