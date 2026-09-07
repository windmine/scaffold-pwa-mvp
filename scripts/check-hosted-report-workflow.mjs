import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

// Opt-in only. Operators provision three dedicated accounts; this runner never seeds,
// creates users, resets a database, deletes upload objects, or changes infrastructure.
// Required environment: HOSTED_REPORT_BASE_URL, HOSTED_REPORT_ALLOWED_HOST,
// HOSTED_REPORT_{SUPERVISOR,WORKER,SECOND_WORKER}_{EMAIL,PASSWORD}.
// Run: node scripts/check-hosted-report-workflow.mjs --allow-hosted-mutations --run-id NAME
// The default evidence directory is docs/evidence/hosted-report-NAME. An optional
// HOSTED_REPORT_EVIDENCE_DIR may select another NEW directory (never overwritten).

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), '..');
const delay = (milliseconds) => new Promise((complete) => setTimeout(complete, milliseconds));
let approvedOrigin = '';

function requireCondition(condition, code) {
  if (!condition) {
    const error = new Error(code);
    error.safeCode = code;
    throw error;
  }
}

function configuration() {
  const args = process.argv.slice(2);
  requireCondition(args.length === 3 && args[0] === '--allow-hosted-mutations'
    && args[1] === '--run-id', 'explicit_mutation_flag_and_run_id_required');
  const runId = args[2];
  requireCondition(/^[a-z0-9][a-z0-9_-]{3,39}$/.test(runId), 'invalid_run_id');
  const rawBase = process.env.HOSTED_REPORT_BASE_URL || '';
  const base = new URL(rawBase);
  requireCondition(base.protocol === 'https:' && !base.username && !base.password
    && base.pathname === '/' && !base.search && !base.hash, 'https_origin_only_required');
  requireCondition(base.host === process.env.HOSTED_REPORT_ALLOWED_HOST,
    'explicit_exact_host_allowlist_required');
  const accounts = Object.fromEntries(['SUPERVISOR', 'WORKER', 'SECOND_WORKER'].map((role) => {
    const email = process.env[`HOSTED_REPORT_${role}_EMAIL`] || '';
    const password = process.env[`HOSTED_REPORT_${role}_PASSWORD`] || '';
    requireCondition(email.includes('@') && password.length >= 8, 'dedicated_account_credentials_required');
    return [role, { email, password }];
  }));
  requireCondition(new Set(Object.values(accounts).map(({ email }) => email.toLowerCase())).size === 3,
    'three_distinct_accounts_required');
  const evidenceDir = resolve(process.env.HOSTED_REPORT_EVIDENCE_DIR
    || join(repoRoot, 'docs', 'evidence', `hosted-report-${runId}`));
  requireCondition(!existsSync(evidenceDir), 'evidence_directory_already_exists');
  return { runId, baseURL: base.origin, accounts, evidenceDir };
}

async function api(page, path, method = 'GET', body) {
  requireCondition(new URL(page.url()).origin === approvedOrigin, 'page_left_approved_origin');
  requireCondition(/^\/api\/[a-z0-9/?=&_.-]+$/i.test(path), 'api_path_not_allowed');
  return await page.evaluate(browserApiRequest, { path, method, body });
}

export async function browserApiRequest({ path, method = 'GET', body, timeoutMs = 30000 }) {
  const csrf = document.cookie.split(';').map((part) => part.trim())
    .find((part) => part.startsWith('geo_csrf_token='))?.slice('geo_csrf_token='.length);
  const response = await fetch(path, {
    method, credentials: 'include', signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'Content-Type': 'application/json',
      ...(method !== 'GET' && csrf ? { 'X-CSRF-Token': decodeURIComponent(csrf) } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, ok: response.ok, body: await response.json().catch(() => null) };
}

export function resolutionNoteLocator(container, note) {
  return container.locator('.report-supervisor-note').filter({ hasText: note });
}

async function poll(test, code, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await test();
    if (result) return result;
    await delay(1500);
  }
  requireCondition(false, code);
}

async function login(page, account, view) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  requireCondition(new URL(page.url()).origin === approvedOrigin, 'login_left_approved_origin');
  await page.waitForFunction(() => document.body.dataset.activeView === 'login'
    && document.querySelector('#syncIndicator')?.dataset.state !== 'checking');
  await page.locator('#emailInput').fill(account.email);
  await page.locator('#passwordInput').fill(account.password);
  await page.locator('#loginForm button[type="submit"]').click();
  await page.waitForFunction((expected) => document.body.dataset.activeView === expected, view);
  // Do not retain a password in the DOM of any subsequent screenshot.
  await page.locator('#passwordInput').evaluate((input) => { input.value = ''; });
  requireCondition(await page.evaluate(() => document.body.classList.contains('report-only-mode')),
    'production_default_report_only_shell_required');
  const current = await api(page, '/api/auth/me');
  requireCondition(current.ok, 'account_identity_read_failed');
  return current.body;
}

async function assertPhoneLayout(page) {
  requireCondition(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1),
    'phone_horizontal_overflow');
}

async function assertRenderedEvidence(container) {
  await poll(async () => await container.locator('img').evaluateAll((images) => images.length >= 2
    && images.every((image) => image.complete && image.naturalWidth > 0)), 'rendered_evidence_images_missing');
}

async function localRecords(page) {
  // Do not import source modules into a bundled production app: they have separate state.
  return await page.evaluate(async () => {
    const db = await new Promise((done, fail) => {
      const request = indexedDB.open('scaffold-pwa-local', 1);
      request.onsuccess = () => done(request.result);
      request.onerror = () => fail(request.error);
    });
    try {
      return await new Promise((done, fail) => {
        const request = db.transaction('records', 'readonly').objectStore('records').getAll();
        request.onsuccess = () => done(request.result);
        request.onerror = () => fail(request.error);
      });
    } finally {
      db.close();
    }
  });
}

function immutableContent(report) {
  return JSON.stringify({
    form_id: report.form_id, worker_id: report.worker_id, site_id: report.site_id,
    work_date: report.work_date, answers: report.answers, photo_urls: report.photo_urls,
    photo_metadata: report.photo_metadata, created_at: report.created_at,
    client_submission_id: report.client_submission_id,
    definition_version: report.definition_version, definition_schema_version: report.definition_schema_version,
    form_name: report.form_name, form_description: report.form_description, fields: report.fields,
    submission_purpose: report.submission_purpose
  });
}

async function verifyImages(page, paths) {
  return await page.evaluate(async (paths) => {
    const results = [];
    for (const path of paths) {
      const response = await fetch(path, {
        credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(30000)
      });
      const blob = await response.blob();
      let width = 0;
      let height = 0;
      if (response.ok && blob.type.startsWith('image/')) {
        const bitmap = await createImageBitmap(blob);
        width = bitmap.width;
        height = bitmap.height;
        bitmap.close();
      }
      const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
      results.push({ path, status: response.status, type: blob.type, width, height,
        sha256: [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('') });
    }
    return results;
  }, paths);
}

async function main() {
  let config;
  try {
    config = configuration();
  } catch (error) {
    console.error(`Hosted Report check refused: ${error.safeCode || 'invalid_configuration'}`);
    process.exitCode = 1;
    return;
  }
  approvedOrigin = config.baseURL;
  const nonce = randomUUID();
  const templateName = `TEST ONLY Report ${config.runId} ${nonce}`;
  const marker = `Synthetic PPE evidence ${nonce}`;
  const finalNote = `TEST ONLY replacement PPE issued ${nonce}`;
  const reportDate = new Date().toISOString().slice(0, 10);
  const evidence = {
    schemaVersion: 1, runId: config.runId, nonce, origin: config.baseURL,
    status: 'running', startedAtUtc: new Date().toISOString(),
    scope: 'Automated hosted Chromium, not a physical-phone or service-worker test',
    viewport: { width: 390, height: 844 }, checks: [],
    owned: { templateId: null, reportId: null, clientSubmissionId: null, uploadPaths: [] },
    cleanup: { reportTrashed: false, templateArchived: false, submissionOutcomeUnknown: false, failures: [] },
    scriptSha256: createHash('sha256').update(readFileSync(scriptPath)).digest('hex')
  };
  mkdirSync(dirname(config.evidenceDir), { recursive: true });
  mkdirSync(config.evidenceDir);
  const evidencePath = join(config.evidenceDir, 'evidence.json');
  const writeEvidence = () => writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  writeEvidence();
  let stage = 'browser_start';
  let browser;
  let supervisorPage;
  let workerPage;
  let secondPage;
  let workerContext;
  let identities;
  let submitted;
  let capturedPost;
  let templateCreateAttempted = false;
  let pageErrorCount = 0;
  const uploadResponses = [];
  const uploadPaths = new Set();
  const step = async (label, run) => {
    stage = label;
    const details = await run();
    evidence.checks.push({ name: label, status: 'passed', ...(details ? { details } : {}) });
    writeEvidence();
    console.log(`ok - ${label}`);
  };
  const ownedReport = (report) => report?.form_id === evidence.owned.templateId
    && report.worker_id === identities?.worker.id && report.answers?.issue_detail === marker
    && (!evidence.owned.clientSubmissionId
      || report.client_submission_id === evidence.owned.clientSubmissionId);
  try {
    browser = await chromium.launch({ headless: true });
    const pages = [];
    for (let index = 0; index < 3; index += 1) {
      const context = await browser.newContext({ baseURL: config.baseURL,
        viewport: evidence.viewport, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
      context.setDefaultTimeout(45000);
      const page = await context.newPage();
      page.on('pageerror', () => { pageErrorCount += 1; });
      pages.push(page);
    }
    [supervisorPage, workerPage, secondPage] = pages;
    workerContext = workerPage.context();
    workerPage.on('response', (response) => {
      const path = new URL(response.url()).pathname;
      if (response.request().method() === 'POST' && path === '/api/photo-uploads') {
        uploadResponses.push(response.json().then((payload) => {
          if (response.ok() && typeof payload.url === 'string' && /^\/uploads\/[a-z0-9_.-]+$/i.test(payload.url)) {
            uploadPaths.add(payload.url);
            evidence.owned.uploadPaths = [...uploadPaths];
            writeEvidence();
          }
        }).catch(() => {}));
      }
    });
    workerPage.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/form-submissions') {
        const body = request.postDataJSON();
        if (body?.answers?.issue_detail === marker) capturedPost = body;
      }
    });

    await step('hosted_database_migrations_and_gcs_ready', async () => {
      await supervisorPage.goto('/', { waitUntil: 'domcontentloaded' });
      const ready = await api(supervisorPage, '/api/health/ready');
      requireCondition(ready.ok && ready.body?.status === 'ok'
        && ['database', 'migrations', 'upload_storage'].every((key) => ready.body.checks?.[key] === 'ok')
        && ready.body.details?.upload_storage?.backend === 'gcs', 'current_backend_and_gcs_required');
      return { checks: ready.body.checks, uploadBackend: 'gcs' };
    });
    await step('three_dedicated_department_accounts', async () => {
      const supervisor = await login(supervisorPage, config.accounts.SUPERVISOR, 'supervisor');
      const worker = await login(workerPage, config.accounts.WORKER, 'worker');
      const secondWorker = await login(secondPage, config.accounts.SECOND_WORKER, 'worker');
      identities = { supervisor, worker, secondWorker };
      requireCondition(supervisor.role === 'supervisor' && !supervisor.is_global_admin
        && worker.role === 'worker' && worker.worker_class === 'normal'
        && secondWorker.role === 'worker' && secondWorker.worker_class === 'normal'
        && [supervisor, worker, secondWorker].every((user) => user.status === 'active'
          && user.department_id === supervisor.department_id)
        && new Set([supervisor.id, worker.id, secondWorker.id]).size === 3,
      'active_distinct_department_supervisor_and_normal_workers_required');
      for (const page of [workerPage, secondPage]) {
        const history = await api(page, '/api/my-form-submissions?purpose=report');
        requireCondition(history.ok && Array.isArray(history.body) && history.body.length === 0,
          'fresh_dedicated_workers_without_report_history_required');
      }
      evidence.owned.supervisorId = supervisor.id;
      evidence.owned.workerId = worker.id;
      evidence.owned.secondWorkerId = secondWorker.id;
      evidence.owned.departmentId = supervisor.department_id;
      return { departmentScoped: true, normalWorkers: 2 };
    });
    await step('create_nonce_bound_report_template', async () => {
      templateCreateAttempted = true;
      const result = await api(supervisorPage, '/api/supervisor/work-forms', 'POST', {
        name: templateName, description: `Disposable hosted workflow fixture ${nonce}`,
        template_purpose: 'report', fields: [
          { id: 'issue_detail', label: 'PPE issue', type: 'textarea', required: true },
          { id: 'report_signature', label: 'Worker signature', type: 'signature', required: true }
        ]
      });
      requireCondition(result.ok && Number.isInteger(result.body?.id), 'template_create_failed');
      evidence.owned.templateId = result.body.id;
      requireCondition(result.body.name === templateName && result.body.template_purpose === 'report'
        && result.body.department_id === identities.worker.department_id, 'template_ownership_mismatch');
    });
    await step('worker_ui_date_optional_site_photo_and_handwritten_signature', async () => {
      await workerPage.reload({ waitUntil: 'domcontentloaded' });
      await workerPage.locator('#workerView').waitFor({ state: 'visible' });
      await workerPage.locator('#workFormSelect').selectOption(String(evidence.owned.templateId));
      await workerPage.locator('#workFormField_issue_detail').fill(marker);
      await workerPage.locator('#workFormDate').fill('');
      await workerPage.locator('#submitWorkFormButton').click();
      requireCondition(await workerPage.locator('#workFormDate').evaluate((input) => input.required
        && input.matches(':invalid') && document.activeElement === input), 'required_report_date_not_enforced');
      await workerPage.locator('#workFormDate').fill(reportDate);
      requireCondition(await workerPage.locator('#workFormSite').evaluate((input) => !input.required
        && input.value === ''), 'optional_site_not_empty');
      const canvas = workerPage.locator('#workFormFields [data-signature-canvas]');
      await canvas.scrollIntoViewIfNeeded();
      const box = await canvas.boundingBox();
      requireCondition(box?.width > 100 && box.height > 40, 'signature_pad_missing');
      await workerPage.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.6);
      await workerPage.mouse.down();
      for (const [x, y] of [[0.3, 0.3], [0.45, 0.7], [0.6, 0.25], [0.8, 0.55]]) {
        await workerPage.mouse.move(box.x + box.width * x, box.y + box.height * y, { steps: 5 });
      }
      await workerPage.mouse.up();
      requireCondition(await canvas.getAttribute('data-signed') === 'true', 'pointer_signature_not_captured');
      const photo = await workerPage.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const draw = canvas.getContext('2d');
        draw.fillStyle = '#eab308';
        draw.fillRect(0, 0, 32, 32);
        draw.fillStyle = '#111827';
        draw.fillRect(8, 8, 16, 16);
        return canvas.toDataURL('image/png').split(',')[1];
      });
      await workerPage.locator('#workFormPhotos').setInputFiles({
        name: `synthetic-ppe-${config.runId}.png`, mimeType: 'image/png', buffer: Buffer.from(photo, 'base64')
      });
      await workerPage.locator('#workFormPhotoPreview img').waitFor({ state: 'visible' });
      await assertPhoneLayout(workerPage);
    });
    await step('offline_report_preserves_original_answers_and_evidence', async () => {
      await workerContext.setOffline(true);
      await workerPage.locator('#submitWorkFormButton').click();
      const queued = await poll(async () => (await localRecords(workerPage))
        .find((record) => record.formId === evidence.owned.templateId && record.syncStatus === 'queued'),
      'offline_report_not_queued');
      requireCondition(queued.ownerWorkerId === identities.worker.id && queued.workDate === reportDate
        && queued.answers?.issue_detail === marker
        && queued.capturedAnswers?.report_signature?.startsWith('data:image/')
        && queued.photoDataUrls?.length === 1 && queued.photoDataUrls[0].startsWith('data:image/'),
      'queued_original_evidence_missing');
      evidence.owned.clientSubmissionId = queued.clientSubmissionId;
      await workerPage.locator('.tab[data-tab-target="historyTab"]').click();
      const card = workerPage.locator('#historyList .record-form').filter({ hasText: marker });
      await card.waitFor({ state: 'visible' });
      requireCondition((await card.innerText()).includes('Queued'), 'offline_history_status_missing');
      await assertPhoneLayout(workerPage);
      await workerPage.screenshot({ path: join(config.evidenceDir, 'worker-queued.png'), fullPage: true });
    });
    await step('online_replay_uploads_evidence_and_submits_once', async () => {
      await workerContext.setOffline(false);
      submitted = await poll(async () => {
        const result = await api(workerPage, '/api/my-form-submissions?purpose=report');
        if (!result.ok) return false;
        const own = result.body.filter(ownedReport);
        requireCondition(own.length <= 1, 'duplicate_durable_reports_created');
        return own[0];
      }, 'online_report_replay_did_not_finish', 120000);
      evidence.owned.reportId = submitted.id;
      requireCondition(ownedReport(submitted) && submitted.site_id === null
        && submitted.work_date === reportDate && submitted.workflow_status === 'submitted'
        && submitted.submission_purpose === 'report' && submitted.photo_urls?.length === 1
        && /^\/uploads\/[a-z0-9_.-]+$/i.test(submitted.answers?.report_signature || '')
        && capturedPost?.client_submission_id === evidence.owned.clientSubmissionId,
      'durable_report_content_mismatch');
      await Promise.all(uploadResponses);
      const paths = [...submitted.photo_urls, submitted.answers.report_signature];
      requireCondition(paths.every((path) => /^\/uploads\/[a-z0-9_.-]+$/i.test(path)),
        'durable_evidence_paths_invalid');
      evidence.owned.uploadPaths = [...new Set([...uploadPaths, ...paths])];
      const images = await verifyImages(workerPage, paths);
      requireCondition(images.every((item) => item.status === 200 && item.width > 0 && item.height > 0),
        'worker_authenticated_upload_streaming_failed');
      return { images };
    });
    await step('second_worker_cannot_read_report_or_evidence', async () => {
      const history = await api(secondPage, '/api/my-form-submissions?purpose=report');
      requireCondition(history.ok && Array.isArray(history.body) && history.body.length === 0,
        'second_worker_history_leaked');
      const supervisorList = await api(secondPage, '/api/supervisor/form-submissions?purpose=report');
      requireCondition([401, 403].includes(supervisorList.status), 'worker_supervisor_endpoint_not_denied');
      const statuses = await secondPage.evaluate(async (paths) => {
        const statuses = [];
        for (const path of paths) {
          statuses.push((await fetch(path, {
            credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(30000)
          })).status);
        }
        return statuses;
      }, evidence.owned.uploadPaths);
      requireCondition(statuses.length === 2 && statuses.every((status) => [401, 403, 404].includes(status)),
        'second_worker_evidence_leaked');
      return { deniedUploadStatuses: statuses };
    });
    await step('supervisor_phone_filters_and_starts_review', async () => {
      await supervisorPage.reload({ waitUntil: 'domcontentloaded' });
      await supervisorPage.locator('#supervisorView').waitFor({ state: 'visible' });
      const filteredResponse = supervisorPage.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === 'GET' && url.pathname === '/api/supervisor/review-queue'
          && url.searchParams.get('workflow_status') === 'submitted'
          && url.searchParams.get('form_id') === String(evidence.owned.templateId)
          && url.searchParams.get('worker_id') === String(identities.worker.id)
          && url.searchParams.get('record_date') === reportDate;
      });
      await supervisorPage.locator('#supervisorTemplateFilter').selectOption(String(evidence.owned.templateId));
      await supervisorPage.locator('#supervisorWorkerFilter').selectOption(String(identities.worker.id));
      await supervisorPage.locator('#supervisorStatusFilter').selectOption('submitted');
      await supervisorPage.locator('#supervisorDateFilter').fill(reportDate);
      requireCondition((await filteredResponse).ok(), 'combined_supervisor_filters_failed');
      const card = supervisorPage.locator('#reviewQueueList .record-form').filter({ hasText: marker });
      await card.waitFor({ state: 'visible' });
      await card.click();
      await assertPhoneLayout(supervisorPage);
      await assertRenderedEvidence(supervisorPage.locator('#reviewQueueDetail'));
      const images = await verifyImages(supervisorPage, evidence.owned.uploadPaths);
      requireCondition(images.every((item) => item.status === 200 && item.width > 0),
        'supervisor_authenticated_upload_streaming_failed');
      const responsePromise = supervisorPage.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname === `/api/supervisor/form-submissions/${submitted.id}/transition`);
      await supervisorPage.locator('#reviewQueueActions').getByRole('button', { name: 'Start review', exact: true }).click();
      const response = await responsePromise;
      requireCondition(response.ok() && (await response.json()).workflow_status === 'in_review',
        'start_review_transition_failed');
    });
    await step('supervisor_requires_note_and_resolves_report', async () => {
      await supervisorPage.locator('#supervisorStatusFilter').selectOption('in_review');
      const card = supervisorPage.locator('#reviewQueueList .record-form').filter({ hasText: marker });
      await card.waitFor({ state: 'visible' });
      await card.click();
      await supervisorPage.locator('#reviewQueueActions').getByRole('button', { name: 'Resolve report', exact: true }).click();
      const note = supervisorPage.locator('#reportResolutionNote');
      await note.waitFor({ state: 'visible' });
      await supervisorPage.locator('#editPanelForm button[type="submit"]').click();
      requireCondition(await note.evaluate((field) => field.required && field.matches(':invalid')
        && document.activeElement === field), 'resolution_note_not_required');
      await note.fill(finalNote);
      const responsePromise = supervisorPage.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname === `/api/supervisor/form-submissions/${submitted.id}/transition`);
      await supervisorPage.locator('#editPanelForm button[type="submit"]').click();
      const response = await responsePromise;
      const resolved = await response.json();
      requireCondition(response.ok() && resolved.workflow_status === 'resolved'
        && resolved.supervisor_note === finalNote && resolved.reviewing_supervisor_id === identities.supervisor.id
        && resolved.review_started_at && resolved.resolved_at
        && immutableContent(resolved) === immutableContent(submitted), 'resolved_report_or_immutable_content_mismatch');
      await supervisorPage.locator('#supervisorStatusFilter').selectOption('resolved');
      await card.waitFor({ state: 'visible' });
      await card.click();
      await resolutionNoteLocator(supervisorPage.locator('#reviewQueueDetail'), finalNote).waitFor();
      await assertPhoneLayout(supervisorPage);
      // Scope the screenshot to our detail; never capture another Worker's queue cards.
      await supervisorPage.locator('#reviewQueueDetail').screenshot({ path: join(config.evidenceDir, 'supervisor-resolved.png') });
    });
    await step('worker_sees_final_note_and_idempotent_replay_keeps_original', async () => {
      await workerPage.reload({ waitUntil: 'domcontentloaded' });
      await workerPage.locator('#workerView').waitFor({ state: 'visible' });
      await workerPage.locator('.tab[data-tab-target="historyTab"]').click();
      const card = workerPage.locator('#historyList .record-form').filter({ hasText: marker });
      await card.waitFor({ state: 'visible' });
      const text = await card.innerText();
      requireCondition(text.includes('Resolved') && text.includes(finalNote) && text.includes(reportDate),
        'worker_final_report_note_missing');
      await assertRenderedEvidence(card);
      await assertPhoneLayout(workerPage);
      await workerPage.screenshot({ path: join(config.evidenceDir, 'worker-resolved.png'), fullPage: true });
      const replay = await api(workerPage, '/api/form-submissions', 'POST', capturedPost);
      requireCondition(replay.ok && replay.body.id === submitted.id && replay.body.workflow_status === 'resolved'
        && replay.body.supervisor_note === finalNote
        && immutableContent(replay.body) === immutableContent(submitted), 'durable_idempotent_replay_changed_report');
      const history = await api(workerPage, '/api/my-form-submissions?purpose=report');
      requireCondition(history.ok && history.body.filter(ownedReport).length === 1, 'replay_created_duplicate_report');
      requireCondition(pageErrorCount === 0, 'browser_page_errors_observed');
    });
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.failure = { checkpoint: stage, code: error.safeCode || 'browser_or_api_operation_failed' };
    console.error(`Hosted Report check failed: ${stage} (${evidence.failure.code})`);
    process.exitCode = 1;
  } finally {
    // Only nonce- and identity-bound fixture rows are eligible. Keep audit/recovery
    // history: soft-delete our Report and archive our Template, never purge a bin.
    // Closing this isolated context stops further retries. Never bring a failed
    // offline fixture online from cleanup, which could create a late Report.
    if (workerContext) await workerContext.close().catch(() => {});
    await Promise.allSettled(uploadResponses);
    // Browser cancellation is not a server rollback. If the final POST was sent
    // but its durable result is unknown, absence in one lookup is not cleanup proof.
    evidence.cleanup.submissionOutcomeUnknown = Boolean(capturedPost && !evidence.owned.reportId);
    if (supervisorPage && identities && templateCreateAttempted && !evidence.owned.templateId) {
      try {
        const templates = await api(supervisorPage, '/api/work-forms?purpose=report');
        requireCondition(templates.ok && Array.isArray(templates.body), 'cleanup_unknown_template_lookup_failed');
        const own = templates.body.filter((form) => form.name === templateName
          && form.department_id === identities.worker.department_id
          && form.created_by === identities.supervisor.id);
        requireCondition(own.length <= 1, 'cleanup_multiple_nonce_templates_requires_operator');
        if (own[0]) evidence.owned.templateId = own[0].id;
      } catch (error) {
        evidence.cleanup.failures.push(error.safeCode || 'cleanup_unknown_template_request_failed');
      }
    }
    if (supervisorPage && identities && evidence.owned.templateId) {
      try {
        const reports = await api(supervisorPage, '/api/supervisor/form-submissions?purpose=report');
        requireCondition(reports.ok && Array.isArray(reports.body), 'cleanup_report_lookup_failed');
        const own = reports.body.filter(ownedReport);
        requireCondition(own.length <= 1, 'cleanup_found_multiple_reports_requires_operator');
        for (const report of own) {
          evidence.owned.reportId = report.id;
          evidence.cleanup.submissionOutcomeUnknown = false;
          const deleted = await api(supervisorPage, `/api/supervisor/trash/form/${report.id}`, 'POST', {
            confirmed: true, reason: `Completed synthetic hosted workflow ${nonce}`
          });
          requireCondition(deleted.ok, 'cleanup_report_soft_delete_failed');
          evidence.cleanup.reportTrashed = true;
        }
        const remaining = await api(supervisorPage, '/api/supervisor/form-submissions?purpose=report');
        requireCondition(remaining.ok && !remaining.body.some(ownedReport), 'cleanup_report_still_visible');
      } catch (error) {
        evidence.cleanup.failures.push(error.safeCode || 'cleanup_report_request_failed');
      }
      try {
        const templates = await api(supervisorPage, '/api/work-forms?purpose=report');
        requireCondition(templates.ok && Array.isArray(templates.body), 'cleanup_template_lookup_failed');
        const own = templates.body.find((form) => form.id === evidence.owned.templateId
          && form.name === templateName && form.department_id === identities.worker.department_id);
        requireCondition(own, 'cleanup_template_ownership_unverified');
        const archived = await api(supervisorPage, `/api/supervisor/work-forms/${own.id}`, 'PATCH', {
          confirmed: true, status: 'archived'
        });
        requireCondition(archived.ok && archived.body.status === 'archived', 'cleanup_template_archive_failed');
        evidence.cleanup.templateArchived = true;
      } catch (error) {
        evidence.cleanup.failures.push(error.safeCode || 'cleanup_template_request_failed');
      }
    }
    if (evidence.cleanup.submissionOutcomeUnknown) {
      evidence.cleanup.failures.push('submission_outcome_unknown_requires_operator_recheck');
    }
    if (evidence.cleanup.failures.length) {
      evidence.status = 'failed';
      process.exitCode = 1;
    }
    evidence.completedAtUtc = new Date().toISOString();
    evidence.browserPageErrors = pageErrorCount;
    writeEvidence();
    if (browser) await browser.close();
  }
  console.log(`${evidence.checks.length} hosted Report checkpoints passed; status=${evidence.status}`);
  console.log(`Sanitized evidence: ${evidencePath}`);
  console.log(`Owned fixture IDs: template=${evidence.owned.templateId}, report=${evidence.owned.reportId}`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) await main();
