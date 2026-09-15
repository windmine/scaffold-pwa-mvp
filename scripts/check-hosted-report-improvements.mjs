import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { browserApiRequest } from './check-hosted-report-workflow.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), '..');

function requireCondition(condition, code) {
  if (!condition) {
    const error = new Error(code);
    error.safeCode = code;
    throw error;
  }
}

export function safeFailureDetails(error, checkpoint, operation) {
  return { checkpoint, ...(operation ? { operation } : {}),
    code: error.safeCode || 'browser_or_api_operation_failed' };
}

export async function ensureRequiredField(card) {
  const required = card.locator('[data-field-property="required"]');
  if (!await required.isChecked()) await card.locator('.work-form-required-toggle').click();
  requireCondition(await required.isChecked(), 'required_field_toggle_not_checked');
}

// No runtime work occurs during import. Credentials and invitation capabilities
// are process-only; never include them in evidence, screenshots or diagnostics.
export function readConfiguration(args = process.argv.slice(2), env = process.env) {
  requireCondition(args.length === 3 && args[0] === '--allow-hosted-mutations'
    && args[1] === '--run-id', 'explicit_mutation_flag_and_run_id_required');
  const runId = args[2];
  requireCondition(/^[a-z0-9][a-z0-9_-]{3,39}$/.test(runId), 'invalid_run_id');
  let base;
  try { base = new URL(env.HOSTED_REPORT_BASE_URL || ''); }
  catch { requireCondition(false, 'https_origin_only_required'); }
  requireCondition(base.protocol === 'https:' && !base.username && !base.password
    && base.pathname === '/' && !base.search && !base.hash, 'https_origin_only_required');
  requireCondition(base.host === env.HOSTED_REPORT_ALLOWED_HOST, 'exact_host_allowlist_required');
  const accounts = Object.fromEntries(['SUPERVISOR', 'WORKER', 'SECOND_WORKER'].map((role) => {
    const email = env[`HOSTED_REPORT_${role}_EMAIL`] || '';
    const password = env[`HOSTED_REPORT_${role}_PASSWORD`] || '';
    requireCondition(email === `release-${runId}-${role.toLowerCase()}@example.invalid`
      && password.length >= 32, 'run_bound_fixture_credentials_required');
    return [role, { email, password }];
  }));
  const evidenceDir = resolve(env.HOSTED_REPORT_IMPROVEMENTS_EVIDENCE_DIR
    || join(repoRoot, 'docs', 'evidence', `hosted-improvements-${runId}`));
  requireCondition(!existsSync(evidenceDir), 'new_evidence_directory_required');
  return { runId, baseURL: base.origin, accounts, evidenceDir };
}

export function assertMutationAllowed({ url, method, body = {} }, scope) {
  const target = new URL(url);
  requireCondition(target.origin === scope.baseURL, 'request_left_approved_origin');
  if (['GET', 'HEAD'].includes(method)) return;
  const path = target.pathname;
  const post = method === 'POST';
  const patch = method === 'PATCH';
  const accountEmails = Object.values(scope.accounts).map((account) => account.email);
  const allowed = (post && ['/api/auth/refresh', '/api/auth/logout'].includes(path))
    || (post && path === '/api/auth/login' && [...accountEmails, scope.invitedEmail].includes(body.email))
    || (post && ['/api/auth/worker-invitations/inspect', '/api/auth/worker-invitations/accept'].includes(path)
      && scope.tokens.has(body.token))
    || (post && path === '/api/supervisor/work-forms' && scope.templateNames.has(body.name)
      && (body.template_purpose === undefined || body.template_purpose === 'report')
      && (!body.department_id || body.department_id === scope.departmentId))
    || (patch && scope.templateId && path === `/api/supervisor/work-forms/${scope.templateId}`
      && (!body.name || scope.templateNames.has(body.name)) && (!body.status || body.status === 'archived'))
    || (post && path === '/api/form-submissions' && Number(body.form_id) === scope.templateId
      && body.answers?.[scope.questionId] === scope.marker)
    || (post && scope.reportId && path === `/api/supervisor/trash/form/${scope.reportId}` && body.confirmed === true)
    || (post && path === '/api/supervisor/worker-invitations' && body.name === scope.invitedName
      && body.email === scope.invitedEmail && (!body.department_id || body.department_id === scope.departmentId))
    || (post && scope.invitedId && path === `/api/supervisor/users/${scope.invitedId}/invitation`)
    || (post && scope.invitedId && path === `/api/supervisor/users/${scope.invitedId}/status`
      && body.status === 'resigned' && body.confirmed === true);
  requireCondition(allowed, 'mutation_outside_owned_fixture_boundary');
}

export function assertOwnedExport(bytes, format, expected, empty) {
  requireCondition(['csv', 'pdf'].includes(format), 'unsupported_export_format');
  let parsed;
  try {
    // Reuse the repository's existing pypdf dependency. Only document bytes go
    // through stdin; no credentials enter the child process or its output.
    const code = format === 'csv'
      ? 'import csv,io,json,sys; print(json.dumps(list(csv.DictReader(io.StringIO(sys.stdin.buffer.read().decode("utf-8-sig"))))))'
      : 'import io,json,sys; from pypdf import PdfReader; print(json.dumps("\\n".join(p.extract_text() or "" for p in PdfReader(io.BytesIO(sys.stdin.buffer.read())).pages)))';
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(path|systemroot|windir|pathext|temp|tmp|virtual_env|pythonpath|userprofile|localappdata|appdata)$/i.test(key)));
    parsed = JSON.parse(execFileSync('python', ['-c', code], {
      input: bytes, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env,
      stdio: ['pipe', 'pipe', 'pipe']
    }));
  } catch { requireCondition(false, 'export_document_parse_failed'); }
  if (format === 'csv') {
    requireCondition(empty ? parsed.length === 0 : parsed.length === 1
      && Number(parsed[0].id) === expected.reportId && Number(parsed[0].form_id) === expected.templateId
      && Number(parsed[0].worker_id) === expected.workerId && parsed[0][`answer_${expected.questionId}`] === expected.marker,
    'csv_find_did_not_export_exact_owned_report');
  } else {
    const contains = parsed.replace(/\s+/g, '').includes(expected.marker.replace(/\s+/g, ''));
    const reportIds = [...new Set([...parsed.matchAll(/\bReport\s*#(\d+)\b/gi)].map((match) => Number(match[1])))];
    requireCondition(empty ? !contains && reportIds.length === 0 && /No Reports found/.test(parsed)
      : contains && reportIds.length === 1 && reportIds[0] === expected.reportId,
    'pdf_find_did_not_match_owned_report');
  }
}

async function poll(read, code, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 500));
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
  const [response] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === path
      && response.request().method() === method), action()
  ]);
  return response;
}

// Separate from the baseline runner: this uses real service workers and never
// captures screenshots, traces, response bodies or invitation URLs as evidence.
export async function runImprovements(config) {
  const nonce = randomUUID();
  const prefix = `TEST ONLY improvements ${config.runId} ${nonce}`;
  const names = { create: `${prefix} create`, edit: `${prefix} edited`, server: `${prefix} current`, stale: `${prefix} stale` };
  const scope = { ...config, templateNames: new Set(Object.values(names)), tokens: new Set(),
    templateId: null, reportId: null, invitedId: null, departmentId: null, questionId: null,
    invitedEmail: `release-${config.runId}-${nonce}@example.invalid`, invitedName: `${prefix} invited`,
    marker: `Synthetic offline return ${nonce}` };
  const evidence = { schemaVersion: 1, runId: config.runId, nonce, origin: config.baseURL,
    startedAtUtc: new Date().toISOString(), status: 'running',
    scope: 'Opt-in owned hosted candidate UI and real-service-worker checks; not a physical-phone test',
    checks: [], owned: {}, cleanup: { failures: [], reportTrashed: false, templateArchived: false,
      invitedWorkerResigned: false, submissionOutcomeUnknown: false },
    scriptSha256: createHash('sha256').update(readFileSync(scriptPath)).digest('hex') };
  requireCondition(!existsSync(config.evidenceDir), 'new_evidence_directory_required');
  mkdirSync(dirname(config.evidenceDir), { recursive: true });
  mkdirSync(config.evidenceDir);
  const evidencePath = join(config.evidenceDir, 'evidence.json');
  const save = () => writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  save();
  let browser, supervisor, worker, secondWorker, workerContext, identities;
  let stage = 'start', operation = '', questionId, capturedReport, templateAttempted = false, invitationAttempted = false;
  let pageErrors = 0;
  const boundaryFailures = new Set();
  const contexts = [];
  const api = async (page, path, method = 'GET', body) => {
    requireCondition(new URL(page.url()).origin === config.baseURL, 'page_left_approved_origin');
    requireCondition(/^\/api\/[a-z0-9/?=&_.%-]+$/i.test(path), 'api_path_not_allowed');
    assertMutationAllowed({ url: new URL(path, config.baseURL).href, method, body }, scope);
    return await page.evaluate(browserApiRequest, { path, method, body });
  };
  const newContext = async () => {
    const context = await browser.newContext({ baseURL: config.baseURL,
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      serviceWorkers: 'allow', acceptDownloads: true });
    context.setDefaultTimeout(45000);
    context.on('page', (page) => {
      page.on('pageerror', () => { pageErrors += 1; });
      page.on('request', (request) => {
        if (request.method() !== 'POST') return;
        try {
          const body = request.postDataJSON();
          const path = new URL(request.url()).pathname;
          if (path === '/api/supervisor/work-forms' && scope.templateNames.has(body?.name)) templateAttempted = true;
          if (path === '/api/supervisor/worker-invitations' && body?.email === scope.invitedEmail) invitationAttempted = true;
          if (path === '/api/form-submissions' && body?.answers?.[scope.questionId] === scope.marker) capturedReport = body;
        } catch { /* Only a validated owned request may become replay evidence. */ }
      });
    });
    await context.route('**/*', async (route) => {
      try {
        const request = route.request();
        const body = ['GET', 'HEAD'].includes(request.method()) ? undefined : request.postDataJSON() || {};
        assertMutationAllowed({ url: request.url(), method: request.method(), body }, scope);
      } catch (error) {
        boundaryFailures.add(error.safeCode || 'unexpected_request_payload');
        await route.abort();
        return;
      }
      await route.continue();
    });
    contexts.push(context);
    return context;
  };
  const login = async (page, account, view) => {
    await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.dataset.activeView === 'login'
      && document.querySelector('#syncIndicator')?.dataset.state !== 'checking');
    await page.locator('#emailInput').fill(account.email);
    await page.locator('#passwordInput').fill(account.password);
    await page.locator('#loginForm button[type="submit"]').click();
    await page.waitForFunction((expected) => document.body.dataset.activeView === expected, view);
    await page.locator('#passwordInput').evaluate((input) => { input.value = ''; });
    const me = await api(page, '/api/auth/me');
    requireCondition(me.ok && me.body.email === account.email && me.body.role === view,
      'dedicated_account_identity_failed');
    return me.body;
  };
  const templateOwned = (row) => row?.department_id === scope.departmentId
    && row.created_by === identities?.supervisor.id && row.template_purpose === 'report'
    && scope.templateNames.has(row.name) && (!scope.templateId || row.id === scope.templateId);
  const invitedOwned = (row) => row?.email === scope.invitedEmail && row.name === scope.invitedName
    && row.role === 'worker' && !row.is_global_admin && row.department_id === scope.departmentId
    && (!scope.invitedId || row.id === scope.invitedId);
  const reportOwned = (row) => row?.form_id === scope.templateId && row.worker_id === identities?.worker.id
    && row.answers?.[questionId] === scope.marker
    && (!capturedReport?.client_submission_id || row.client_submission_id === capturedReport.client_submission_id);
  const template = async () => {
    const result = await api(supervisor, '/api/work-forms?purpose=report');
    requireCondition(result.ok && Array.isArray(result.body), 'template_list_failed');
    const rows = result.body.filter(templateOwned);
    requireCondition(rows.length === 1, 'exactly_one_owned_template_required');
    return rows[0];
  };
  const step = async (label, action) => {
    stage = label;
    operation = '';
    await action();
    requireCondition(boundaryFailures.size === 0, 'request_boundary_violation');
    evidence.checks.push({ name: label, status: 'passed' });
    save();
    console.log(`ok - ${label}`);
  };
  const progress = (code) => {
    operation = code;
    evidence.progress = { checkpoint: stage, operation: code, recordedAtUtc: new Date().toISOString() };
    save();
    console.log(`[hosted-progress] ${code}`);
  };
  try {
    browser = await chromium.launch({ headless: true });
    supervisor = await (await newContext()).newPage();
    workerContext = await newContext();
    worker = await workerContext.newPage();
    secondWorker = await (await newContext()).newPage();
    await step('exact_owned_accounts_and_current_gcs_backend', async () => {
      identities = {};
      for (const [role, page] of [['SUPERVISOR', supervisor], ['WORKER', worker], ['SECOND_WORKER', secondWorker]]) {
        const view = role === 'SUPERVISOR' ? 'supervisor' : 'worker';
        const identity = await login(page, config.accounts[role], view);
        requireCondition(identity.name === `TEST ONLY ${config.runId} ${role}` && identity.status === 'active'
          && !identity.is_global_admin && Number.isInteger(identity.id) && identity.id > 0
          && Number.isInteger(identity.department_id) && identity.department_id > 0,
        'provisioner_fixture_identity_required');
        identities[role === 'SECOND_WORKER' ? 'secondWorker' : role.toLowerCase()] = identity;
      }
      scope.departmentId = identities.supervisor.department_id;
      requireCondition(Object.values(identities).every((user) => user.department_id === scope.departmentId)
        && new Set(Object.values(identities).map((user) => user.id)).size === 3, 'distinct_same_department_fixtures_required');
      evidence.owned = { supervisorId: identities.supervisor.id, workerId: identities.worker.id,
        secondWorkerId: identities.secondWorker.id, departmentId: scope.departmentId };
      const ready = await api(supervisor, '/api/health/ready');
      requireCondition(ready.ok && ['database', 'migrations', 'upload_storage'].every((key) => ready.body?.checks?.[key] === 'ok')
        && ready.body?.details?.upload_storage?.backend === 'gcs', 'current_database_migrations_gcs_required');
    });
    await step('private_template_create_draft_survives_reload_before_explicit_publish', async () => {
      progress('create_open_workspace');
      await openWorkspace(supervisor, 'forms');
      progress('create_open_panel');
      await supervisor.locator('#addWorkFormButton').click();
      progress('create_fill_name');
      await supervisor.locator('#workFormNameInput').fill(names.create);
      progress('create_fill_description');
      await supervisor.locator('#workFormDescriptionInput').fill(`Unpublished description ${nonce}`);
      progress('create_add_field');
      await supervisor.locator('#addWorkFormFieldButton').click();
      progress('create_fill_field_label');
      await supervisor.locator('#workFormFieldCards [data-field-property="label"]').fill('Synthetic issue');
      progress('create_set_required');
      await ensureRequiredField(supervisor.locator('#workFormFieldCards'));
      progress('create_open_raw_editor');
      await supervisor.locator('#workFormAdvancedDetails summary').click();
      const raw = `text|Unapplied ${nonce}|required|id=unfinished\nnot finished yet`;
      progress('create_fill_unapplied_raw');
      await supervisor.locator('#workFormFieldsInput').fill(raw);
      progress('create_wait_saved_status');
      await supervisor.locator('#templateCreateDraftStatus').getByText('Template draft saved on this device.', { exact: true }).waitFor();
      progress('create_reload_saved_draft');
      await supervisor.reload({ waitUntil: 'domcontentloaded' });
      progress('create_open_workspace_after_reload');
      await openWorkspace(supervisor, 'forms');
      progress('create_continue_named_draft');
      await supervisor.locator('#templateDraftsList .record-card').filter({ hasText: names.create })
        .getByRole('button', { name: 'Continue Template draft', exact: true }).click();
      progress('create_wait_restored_panel');
      await supervisor.locator('#workFormCreatePanel').waitFor({ state: 'visible' });
      progress('create_check_restored_values');
      evidence.restoredCreateMatches = {
        name: await supervisor.locator('#workFormNameInput').inputValue() === names.create,
        description: await supervisor.locator('#workFormDescriptionInput').inputValue() === `Unpublished description ${nonce}`,
        raw: await supervisor.locator('#workFormFieldsInput').inputValue() === raw,
        fieldLabel: await supervisor.locator('#workFormFieldCards [data-field-property="label"]').inputValue() === 'Synthetic issue'
      };
      save();
      requireCondition(Object.values(evidence.restoredCreateMatches).every(Boolean), 'private_create_draft_content_lost');
      progress('create_check_unpublished_worker_visibility');
      const available = await api(secondWorker, '/api/work-forms?purpose=report');
      requireCondition(available.ok && !available.body.some((row) => scope.templateNames.has(row.name)),
        'unpublished_template_visible_to_worker');
      progress('create_attempt_submit_with_pending_raw');
      await supervisor.locator('#workFormSubmitButton').click();
      progress('create_wait_pending_raw_feedback');
      await supervisor.locator('#workFormRawFeedback').getByText(/Apply or discard the pending raw syntax/).waitFor();
      progress('create_discard_unapplied_raw');
      await supervisor.locator('#discardWorkFormRawButton').click();
      templateAttempted = true;
      progress('create_publish_template');
      const created = await responseTo(supervisor, '/api/supervisor/work-forms', 'POST',
        () => supervisor.locator('#workFormSubmitButton').click());
      progress('create_check_publish_response');
      requireCondition(created.ok(), 'template_create_rejected');
      const row = await created.json();
      requireCondition(templateOwned(row) && Number.isInteger(row.id), 'created_template_not_owned');
      scope.templateId = evidence.owned.templateId = row.id;
      questionId = scope.questionId = row.fields?.[0]?.id;
      requireCondition(typeof questionId === 'string' && /^[a-zA-Z0-9_-]+$/.test(questionId), 'created_question_id_unavailable');
      progress('create_wait_panel_closed');
      await supervisor.locator('#workFormCreatePanel').waitFor({ state: 'hidden' });
      progress('create_wait_draft_retired');
      await supervisor.locator('#templateDraftsPanel').waitFor({ state: 'hidden' });
      progress('create_wait_refresh_complete');
      await supervisor.waitForFunction(() => !document.querySelector('#workFormNameInput').disabled);
    });
    await step('private_template_edit_draft_survives_reload_and_publishes_once', async () => {
      progress('edit_read_original');
      const original = await template();
      progress('edit_open_current_card');
      await supervisor.locator('#workFormsList .record-card').filter({ hasText: names.create })
        .getByRole('button', { name: 'Edit', exact: true }).click();
      progress('edit_fill_name');
      await supervisor.locator('#editWorkFormName').fill(names.edit);
      progress('edit_fill_description');
      await supervisor.locator('#editWorkFormDescription').fill(`Saved edited description ${nonce}`);
      progress('edit_wait_saved');
      await supervisor.locator('#templateEditDraftStatus').getByText('Template draft saved on this device.', { exact: true }).waitFor();
      progress('edit_reload');
      await supervisor.reload({ waitUntil: 'domcontentloaded' });
      await openWorkspace(supervisor, 'forms');
      progress('edit_continue_draft');
      await supervisor.locator('#templateDraftsList .record-card').filter({ hasText: names.edit })
        .getByRole('button', { name: 'Continue Template draft', exact: true }).click();
      await supervisor.locator('#templateEditPanel').waitFor({ state: 'visible' });
      requireCondition(await supervisor.locator('#editWorkFormName').inputValue() === names.edit
        && await supervisor.locator('#editWorkFormDescription').inputValue() === `Saved edited description ${nonce}`,
      'private_edit_draft_content_lost');
      progress('edit_publish');
      const saved = await responseTo(supervisor, `/api/supervisor/work-forms/${scope.templateId}`, 'PATCH',
        () => supervisor.locator('#saveTemplateEditButton').click());
      requireCondition(saved.ok() && saved.request().postDataJSON().expected_definition_version === original.definition_version,
        'template_edit_missing_expected_version');
      await supervisor.locator('#templateEditPanel').waitFor({ state: 'hidden' });
      const current = await template();
      requireCondition(current.name === names.edit && current.definition_version > original.definition_version,
        'template_edit_not_durable');
      await supervisor.locator('#templateDraftsPanel').waitFor({ state: 'hidden' });
      await supervisor.waitForFunction(() => !document.querySelector('#workFormNameInput').disabled);
    });
    await step('stale_template_edit_returns_409_and_keeps_readonly_recovery', async () => {
      progress('stale_open_editor');
      const original = await template();
      await supervisor.locator('#workFormsList .record-card').filter({ hasText: names.edit })
        .getByRole('button', { name: 'Edit', exact: true }).click();
      await supervisor.locator('#editWorkFormName').fill(names.stale);
      await supervisor.locator('#templateEditDraftStatus').getByText('Template draft saved on this device.', { exact: true }).waitFor();
      progress('stale_publish_newer');
      const newer = await api(supervisor, `/api/supervisor/work-forms/${scope.templateId}`, 'PATCH', {
        name: names.server, expected_definition_version: original.definition_version, confirmed: true
      });
      requireCondition(newer.ok && newer.body.definition_version > original.definition_version, 'newer_template_edit_failed');
      progress('stale_reject_older');
      const rejected = await responseTo(supervisor, `/api/supervisor/work-forms/${scope.templateId}`, 'PATCH',
        () => supervisor.locator('#saveTemplateEditButton').click());
      const conflict = await rejected.json();
      requireCondition(rejected.status() === 409 && conflict.detail?.code === 'report_template_edit_version_conflict',
        'stale_template_edit_not_rejected');
      await supervisor.locator('#templateEditNotice').getByText(/not applied safely/).waitFor();
      requireCondition(await supervisor.locator('#saveTemplateEditButton').isDisabled(), 'stale_template_still_publishable');
      progress('stale_reload_and_restore');
      await supervisor.reload({ waitUntil: 'domcontentloaded' });
      await openWorkspace(supervisor, 'forms');
      await supervisor.locator('#templateDraftsList .record-card').filter({ hasText: names.stale })
        .getByRole('button', { name: 'Continue Template draft', exact: true }).click();
      await supervisor.locator('#templateEditPanel').waitFor({ state: 'visible' });
      requireCondition(await supervisor.locator('#editWorkFormName').inputValue() === names.stale
        && await supervisor.locator('#saveTemplateEditButton').isDisabled()
        && (await template()).name === names.server, 'stale_recovery_overwrote_published_template');
      await supervisor.locator('#closeTemplateEditButton').click();
      await supervisor.locator('#templateEditPanel').waitFor({ state: 'hidden' });
      await supervisor.waitForFunction(() => !document.querySelector('#workFormNameInput').disabled);
    });
    await step('private_invitation_reissue_password_setup_and_single_use', async () => {
      progress('invitation_open_staff_create');
      await openWorkspace(supervisor, 'people');
      await supervisor.locator('#addStaffUserButton').click();
      await supervisor.locator('#staffNameInput').fill(scope.invitedName);
      await supervisor.locator('#staffEmailInput').fill(scope.invitedEmail);
      requireCondition(!await supervisor.locator('#staffPasswordInput').isVisible(), 'supervisor_password_prompt_not_removed');
      invitationAttempted = true;
      progress('invitation_issue');
      const issued = await responseTo(supervisor, '/api/supervisor/worker-invitations', 'POST',
        () => supervisor.locator('#staffUserSubmitButton').click());
      requireCondition(issued.ok(), 'invitation_create_rejected');
      const invitation = await issued.json();
      requireCondition(invitedOwned(invitation.user) && invitation.user.password_setup_required === true,
        'created_invited_worker_not_owned');
      scope.invitedId = evidence.owned.invitedWorkerId = invitation.user.id;
      scope.tokens.add(invitation.token);
      await supervisor.locator('#workerInvitationDialog[open]').waitFor();
      const originalLink = new URL(await supervisor.locator('#workerInvitationLink').inputValue());
      requireCondition(originalLink.origin === config.baseURL && originalLink.pathname === '/setup-password.html'
        && !originalLink.search && originalLink.hash === `#token=${invitation.token}`, 'private_fragment_link_required');
      await supervisor.locator('#closeWorkerInvitationButton').click();
      requireCondition(!await supervisor.locator('#workerInvitationLink').inputValue(), 'closed_invitation_secret_not_cleared');
      const card = supervisor.locator('#staffUsersList .record-card').filter({ hasText: scope.invitedEmail });
      progress('invitation_reissue');
      await card.getByRole('button', { name: 'Create new setup link', exact: true }).click();
      const reissued = await responseTo(supervisor, `/api/supervisor/users/${scope.invitedId}/invitation`, 'POST',
        () => supervisor.locator('#confirmationDialogConfirmButton').click());
      requireCondition(reissued.ok(), 'invitation_reissue_failed');
      const replacement = await reissued.json();
      progress('invitation_inspect_replacement');
      requireCondition(invitedOwned(replacement.user) && replacement.token !== invitation.token, 'replacement_capability_not_rotated');
      scope.tokens.add(replacement.token);
      const invalidated = await api(supervisor, '/api/auth/worker-invitations/inspect', 'POST', { token: invitation.token });
      requireCondition(invalidated.status === 400, 'old_invitation_still_usable');
      await supervisor.locator('#workerInvitationDialog[open]').waitFor();
      const replacementLink = await supervisor.locator('#workerInvitationLink').inputValue();
      requireCondition(new URL(replacementLink).hash === `#token=${replacement.token}`, 'replacement_link_mismatch');
      await supervisor.locator('#closeWorkerInvitationButton').click();
      const setup = await supervisor.context().newPage();
      await setup.goto(replacementLink, { waitUntil: 'domcontentloaded' });
      await setup.locator('#setupPasswordForm').waitFor({ state: 'visible' });
      requireCondition(!new URL(setup.url()).hash && !new URL(setup.url()).search
        && (await setup.locator('#setupInvitationIdentity').innerText()).includes(scope.invitedEmail),
      'setup_address_or_identity_invalid');
      const password = `Owned-${randomUUID()}-${randomUUID().slice(0, 20)}`;
      await setup.locator('#setupPasswordInput').fill(password);
      await setup.locator('#setupPasswordConfirmInput').fill('mismatched-password');
      await setup.locator('#setupPasswordButton').click();
      await setup.locator('#setupPasswordStatus').getByText('Passwords do not match.', { exact: true }).waitFor();
      await setup.locator('#setupPasswordConfirmInput').fill(password);
      const acceptance = await responseTo(setup, '/api/auth/worker-invitations/accept', 'POST',
        () => setup.locator('#setupPasswordButton').click());
      requireCondition(acceptance.ok() && !acceptance.headers()['set-cookie'], 'setup_changed_authentication_cookies');
      await setup.locator('#setupPasswordStatus').getByText('Password set. You can now sign in to ReportFlow.', { exact: true }).waitFor();
      const me = await api(supervisor, '/api/auth/me');
      requireCondition(me.ok && me.body.id === identities.supervisor.id, 'setup_replaced_supervisor_session');
      const reused = await api(setup, '/api/auth/worker-invitations/accept', 'POST', { token: replacement.token, password });
      requireCondition(reused.status === 400, 'accepted_invitation_not_single_use');
      await setup.close();
      const invitedContext = await newContext();
      const invitedPage = await invitedContext.newPage();
      const signedIn = await login(invitedPage, { email: scope.invitedEmail, password }, 'worker');
      requireCondition(invitedOwned(signedIn) && signedIn.password_setup_required === false, 'invited_worker_cannot_sign_in');
      await invitedContext.close();
      scope.tokens.clear();
    });
    await step('downloaded_template_cold_offline_return_queues_and_replays_once', async () => {
      await worker.reload({ waitUntil: 'domcontentloaded' });
      await worker.locator('#workerView').waitFor({ state: 'visible' });
      await worker.locator('#workFormSelect').selectOption(String(scope.templateId));
      await worker.locator(`#workFormField_${questionId}`).fill(scope.marker);
      await worker.locator('#workFormDate').fill(new Date().toISOString().slice(0, 10));
      await worker.locator('#workFormSite').selectOption('');
      await worker.waitForFunction(async () => Boolean(navigator.serviceWorker.controller) && Boolean(await caches.match('/index.html')));
      await worker.locator('#reportTemplateAvailability').getByText(/saved.*offline/i).waitFor();
      await worker.locator('#workFormAutosaveStatus.saved').waitFor();
      await worker.close();
      requireCondition(workerContext.pages().length === 0, 'worker_pages_not_all_closed');
      await workerContext.setOffline(true);
      worker = await workerContext.newPage();
      const navigation = await worker.goto('/index.html', { waitUntil: 'domcontentloaded' });
      requireCondition(navigation?.fromServiceWorker(), 'cold_shell_not_served_by_real_service_worker');
      await worker.locator('.tab[data-tab-target="historyTab"]').click();
      const resume = worker.locator('#reportDraftsList .report-draft-card').filter({ hasText: names.server })
        .getByRole('button', { name: 'Continue draft', exact: true });
      await resume.waitFor();
      requireCondition(await resume.isEnabled(), 'cold_offline_draft_continue_disabled');
      await resume.click();
      await worker.locator(`#workFormField_${questionId}`).waitFor({ state: 'visible' });
      requireCondition(await worker.locator(`#workFormField_${questionId}`).inputValue() === scope.marker,
        'cold_offline_draft_answer_lost');
      await worker.locator('#submitWorkFormButton').click();
      await worker.locator('#workFormFeedback').getByText(/saved offline/i).waitFor();
      await workerContext.setOffline(false);
      await worker.evaluate(() => window.dispatchEvent(new Event('online')));
      await worker.locator('.tab[data-tab-target="historyTab"]').click();
      await worker.locator('#historyList .record-card').filter({ hasText: scope.marker })
        .getByText('Submitted', { exact: true }).waitFor({ timeout: 90000 });
      const durable = await poll(async () => {
        const result = await api(worker, '/api/my-form-submissions?purpose=report');
        return result.ok && result.body.find(reportOwned);
      }, 'durable_owned_report_missing');
      scope.reportId = evidence.owned.reportId = durable.id;
      requireCondition(capturedReport && durable.client_submission_id === capturedReport.client_submission_id,
        'captured_submission_identity_missing');
      evidence.owned.clientSubmissionId = durable.client_submission_id;
      const replay = await api(worker, '/api/form-submissions', 'POST', capturedReport);
      requireCondition(replay.ok && replay.body.id === durable.id, 'report_replay_created_duplicate');
      const history = await api(worker, '/api/my-form-submissions?purpose=report');
      requireCondition(history.ok && history.body.filter(reportOwned).length === 1, 'report_not_exactly_once');
      const privateHistory = await api(secondWorker, '/api/my-form-submissions?purpose=report');
      requireCondition(privateHistory.ok && !privateHistory.body.some((row) => row.id === durable.id), 'report_visible_to_second_worker');
    });
    await step('matching_and_empty_find_filter_actual_csv_and_pdf_downloads', async () => {
      await supervisor.reload({ waitUntil: 'domcontentloaded' });
      await openWorkspace(supervisor, 'review');
      for (const empty of [false, true]) {
        const search = empty ? `No matching report ${nonce}` : scope.marker;
        const [searched] = await Promise.all([
          supervisor.waitForResponse((response) => new URL(response.url()).pathname === '/api/supervisor/review-queue'
            && new URL(response.url()).searchParams.get('search') === search),
          supervisor.locator('#supervisorSearchInput').fill(search)
        ]);
        requireCondition(searched.ok(), 'find_query_failed');
        const result = await searched.json();
        requireCondition(empty ? result.items?.length === 0
          : result.items?.length === 1 && result.items[0].id === scope.reportId, 'find_inbox_not_exact_owned_report');
        if (!empty) await supervisor.locator('#reviewQueueList .review-queue-item').filter({ hasText: scope.marker }).waitFor();
        for (const [format, button] of [['csv', 'exportReportsCsvButton'], ['pdf', 'exportReportsPdfButton']]) {
          const [response, download] = await Promise.all([
            supervisor.waitForResponse((response) => new URL(response.url()).pathname === `/api/supervisor/form-submissions/export.${format}`),
            supervisor.waitForEvent('download'), supervisor.locator(`#${button}`).click()
          ]);
          requireCondition(response.ok() && new URL(response.url()).searchParams.get('search') === search,
            'export_did_not_use_owned_find_filter');
          assertOwnedExport(readFileSync(await download.path()), format, {
            reportId: scope.reportId, templateId: scope.templateId, workerId: identities.worker.id,
            questionId, marker: scope.marker
          }, empty);
        }
      }
      requireCondition(pageErrors === 0, 'browser_page_errors_observed');
    });
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.failure = safeFailureDetails(error, stage, operation);
    if (stage.startsWith('private_template_') && supervisor) {
      evidence.templateDiagnostics = await supervisor.evaluate(() => {
        const banner = document.querySelector('#statusBanner')?.textContent || '';
        const name = document.querySelector('#editWorkFormName');
        return {
          editorPanelExists: Boolean(document.querySelector('#templateEditPanel')),
          editorPanelHidden: document.querySelector('#templateEditPanel')?.hidden,
          nameInputExists: Boolean(name), nameInputDisabled: name?.disabled,
          nameInputVisible: Boolean(name?.getClientRects().length),
          createInputDisabled: document.querySelector('#workFormNameInput')?.disabled,
          currentTemplateUnavailable: banner.includes('Connect to load the current Report Template before editing.'),
          editorOpenFailed: banner.includes('Could not open Template draft.'),
          propertyFailure: banner.match(/Cannot read properties of (?:null|undefined) \(reading '[A-Za-z_]+'\)/)?.[0] || null,
          templateWorkspaceVisible: Boolean(document.querySelector('#adminFormsWorkspace')?.getClientRects().length)
        };
      }).catch(() => ({ unavailable: true }));
      save();
    }
    console.error(`Hosted improvements failed: ${stage}${operation ? `/${operation}` : ''} (${evidence.failure.code})`);
  } finally {
    // Stop this isolated Worker's pending retries. Never force a failed offline
    // context online during cleanup; a sent POST is not proof of server rollback.
    if (workerContext) await workerContext.close().catch(() => {});
    evidence.cleanup.submissionOutcomeUnknown = Boolean(capturedReport && !scope.reportId);
    const clean = async (label, action) => {
      try { await action(); }
      catch (error) { evidence.cleanup.failures.push(error.safeCode || label); }
    };
    if (supervisor && identities?.supervisor && scope.departmentId) {
      if (templateAttempted) await clean('owned_template_cleanup_failed', async () => {
        const owned = await template();
        scope.templateId = evidence.owned.templateId = owned.id;
        const reports = await api(supervisor, '/api/supervisor/form-submissions?purpose=report');
        requireCondition(reports.ok && Array.isArray(reports.body), 'cleanup_report_lookup_failed');
        const matches = reports.body.filter(reportOwned);
        requireCondition(matches.length <= 1, 'multiple_owned_reports_require_operator');
        for (const row of matches) {
          scope.reportId = evidence.owned.reportId = row.id;
          const trashed = await api(supervisor, `/api/supervisor/trash/form/${row.id}`, 'POST', {
            confirmed: true, reason: `Completed owned candidate verification ${nonce}`
          });
          requireCondition(trashed.ok, 'owned_report_soft_delete_failed');
          evidence.cleanup.reportTrashed = true;
          evidence.cleanup.submissionOutcomeUnknown = false;
        }
        const archived = await api(supervisor, `/api/supervisor/work-forms/${owned.id}`, 'PATCH', { confirmed: true, status: 'archived' });
        requireCondition(archived.ok && archived.body.status === 'archived', 'owned_template_archive_failed');
        evidence.cleanup.templateArchived = true;
      });
      if (invitationAttempted) await clean('owned_invited_worker_cleanup_failed', async () => {
        const users = await api(supervisor, '/api/supervisor/users');
        requireCondition(users.ok && Array.isArray(users.body), 'cleanup_staff_lookup_failed');
        const matches = users.body.filter(invitedOwned);
        requireCondition(matches.length === 1, 'owned_invited_worker_not_identified');
        scope.invitedId = evidence.owned.invitedWorkerId = matches[0].id;
        const resigned = await api(supervisor, `/api/supervisor/users/${scope.invitedId}/status`, 'POST', { status: 'resigned', confirmed: true });
        requireCondition(resigned.ok && resigned.body.status === 'resigned', 'owned_invited_worker_resign_failed');
        evidence.cleanup.invitedWorkerResigned = true;
      });
    }
    if (evidence.cleanup.submissionOutcomeUnknown) evidence.cleanup.failures.push('submission_outcome_unknown_requires_operator_recheck');
    if (boundaryFailures.size) evidence.cleanup.failures.push(...boundaryFailures);
    if (evidence.cleanup.failures.length) evidence.status = 'failed';
    scope.tokens.clear();
    await Promise.allSettled(contexts.map((context) => context.close()));
    if (browser) await browser.close();
    evidence.completedAtUtc = new Date().toISOString();
    evidence.browserPageErrors = pageErrors;
    save();
  }
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const result = await runImprovements(readConfiguration());
    console.log(`${result.checks.length} owned hosted improvement checkpoints; status=${result.status}`);
    if (result.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    console.error(`Hosted improvements refused: ${error.safeCode || 'invalid_configuration_or_evidence_path'}`);
    process.exitCode = 1;
  }
}
