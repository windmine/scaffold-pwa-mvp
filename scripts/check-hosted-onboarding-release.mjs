import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { browserApiRequest } from './check-hosted-report-workflow.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), '..');
const project = 'geo-attendance-system-db9ca';
const demoEmail = 'demo-20260916-supervisor@example.invalid';

function requireCondition(condition, code) {
  if (!condition) {
    const error = new Error(code);
    error.safeCode = code;
    throw error;
  }
}

export function safeFailure(error) {
  return /^[a-z_]+$/.test(error?.safeCode || '') ? error.safeCode : 'browser_or_api_operation_failed';
}

export function approvedOrigin(raw) {
  const escaped = project.replaceAll('-', '\\-');
  requireCondition(new RegExp(`^https://${escaped}(?:--[a-z0-9](?:[a-z0-9-]{0,100}[a-z0-9])?)?\\.web\\.app/?$`).test(raw),
    'exact_live_or_project_preview_required');
  return new URL(raw).origin;
}

export function evidenceDirectory(raw) {
  requireCondition(typeof raw === 'string' && raw.length > 0, 'evidence_directory_required');
  const directory = resolve(raw);
  const evidenceRoot = realpathSync(join(root, 'docs', 'evidence'));
  const within = (path) => {
    const pathPart = relative(evidenceRoot, path);
    return pathPart !== '' && !pathPart.startsWith('..') && !isAbsolute(pathPart);
  };
  requireCondition(within(directory) && !existsSync(directory), 'new_repository_evidence_subdirectory_required');
  let ancestor = dirname(directory);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const physicalAncestor = realpathSync(ancestor);
  requireCondition(physicalAncestor === evidenceRoot || within(physicalAncestor), 'evidence_symlink_escape_refused');
  return directory;
}

export function readConfiguration(args = process.argv.slice(2), env = process.env) {
  requireCondition(args.length === 3 && args[0] === '--allow-hosted-mutations'
    && args[1] === '--run-id', 'explicit_mutation_flag_and_run_id_required');
  const runId = args[2];
  requireCondition(/^[a-z0-9][a-z0-9_-]{3,39}$/.test(runId), 'invalid_run_id');
  const baseURL = approvedOrigin(env.HOSTED_REPORT_BASE_URL || '');
  requireCondition(new URL(baseURL).host === env.HOSTED_REPORT_ALLOWED_HOST, 'exact_host_allowlist_required');
  requireCondition(env.HOSTED_REPORT_SUPERVISOR_EMAIL === demoEmail
    && env.HOSTED_REPORT_SUPERVISOR_PASSWORD?.length >= 8, 'exact_demo_supervisor_required');
  return { runId, baseURL, evidenceDir: evidenceDirectory(env.HOSTED_ONBOARDING_EVIDENCE_DIR),
    supervisor: { email: demoEmail, password: env.HOSTED_REPORT_SUPERVISOR_PASSWORD } };
}

export function ownedWorker(row, fixture) {
  return Boolean(row && Number.isInteger(row.id) && row.id > 16
    && row.email === fixture.email && row.name === fixture.name
    && row.department_id === 2 && row.role === 'worker' && row.worker_class === 'normal'
    && !row.is_global_admin && (!fixture.id || row.id === fixture.id));
}

function exactKeys(body, allowed) {
  return body && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).every((key) => allowed.includes(key));
}

// Every network mutation is checked independently of UI state. No real account,
// Report, Template, upload, password reset, reissue or deletion is permitted.
export function assertMutationAllowed({ url, method, body = {} }, scope) {
  const target = new URL(url);
  requireCondition(target.origin === scope.baseURL, 'request_left_approved_origin');
  requireCondition(!target.username && !target.password, 'request_credentials_in_url_refused');
  if (['GET', 'HEAD'].includes(method)) return;
  requireCondition(!target.search && method === 'POST', 'mutation_method_or_query_refused');
  const path = target.pathname;
  const fixture = scope.fixtures.find((item) => item.email === body.email);
  const accepted = scope.fixtures.find((item) => item.token && item.token === body.token);
  const login = path === '/api/auth/login' && exactKeys(body, ['email', 'password'])
    && ((body.email === scope.supervisor.email && body.password === scope.supervisor.password)
      || (fixture && body.password === fixture.password));
  const continuation = path === '/api/auth/login/after-setup' && fixture && body.password === fixture.password
    && body.only_if_signed_out === true && exactKeys(body, ['email', 'password', 'only_if_signed_out']);
  const invite = path === '/api/supervisor/worker-invitations' && fixture && !fixture.attempted
    && body.name === fixture.name && ['normal', undefined].includes(body.worker_class)
    && [2, null, undefined].includes(body.department_id)
    && exactKeys(body, ['email', 'name', 'worker_class', 'department_id']);
  const inspect = path === '/api/auth/worker-invitations/inspect' && accepted && exactKeys(body, ['token']);
  const accept = path === '/api/auth/worker-invitations/accept' && accepted && body.password === accepted.password
    && exactKeys(body, ['token', 'password']);
  const cleanup = scope.fixtures.some((item) => item.id > 16 && item.cleanupVerified
    && path === `/api/supervisor/users/${item.id}/status` && body.status === 'resigned'
    && body.confirmed === true && exactKeys(body, ['status', 'confirmed']));
  const session = ['/api/auth/refresh', '/api/auth/logout'].includes(path) && exactKeys(body, []);
  requireCondition(login || continuation || invite || inspect || accept || cleanup || session,
    'mutation_outside_owned_fixture_boundary');
}

export async function forwardWithoutRedirects(route, baseURL) {
  // Playwright does not invoke route handlers again for a redirect. A 307/308
  // could otherwise forward a password/capability outside the checked origin.
  const response = await route.fetch({ maxRedirects: 0, timeout: 45000 });
  requireCondition(new URL(response.url()).origin === baseURL, 'response_left_approved_origin');
  requireCondition(response.status() < 300 || response.status() >= 400, 'network_redirect_refused');
  await route.fulfill({ response });
}

async function responseTo(page, path, action) {
  const [response] = await Promise.all([page.waitForResponse((item) =>
    new URL(item.url()).pathname === path && item.request().method() === 'POST'), action()]);
  return response;
}

export async function runOnboarding(config) {
  const nonce = randomUUID();
  const fixtures = ['existing', 'clean'].map((kind) => ({ kind, id: null, token: '', attempted: false,
    cleanupVerified: false, name: `TEST ONLY onboarding ${config.runId} ${nonce} ${kind}`,
    email: `onboarding-${config.runId}-${nonce}-${kind}@example.invalid`,
    password: `Owned-${randomUUID()}-${randomUUID().slice(0, 12)}` }));
  requireCondition(fixtures.every((fixture) => fixture.name.length <= 120), 'fixture_name_too_long');
  const scope = { ...config, fixtures };
  const evidence = { schemaVersion: 1, runId: config.runId, nonce, origin: config.baseURL,
    startedAtUtc: new Date().toISOString(), status: 'running',
    scope: 'Real Firebase-proxy phone-width Chromium checks; private manual handoff only; not physical-phone verification',
    checks: [], owned: [], cleanup: { resignedWorkerIds: [], failures: [] },
    scriptSha256: createHash('sha256').update(readFileSync(scriptPath)).digest('hex') };
  evidenceDirectory(config.evidenceDir);
  mkdirSync(dirname(config.evidenceDir), { recursive: true });
  mkdirSync(config.evidenceDir);
  const evidencePath = join(config.evidenceDir, 'evidence.json');
  const save = (initial = false) => writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`,
    { encoding: 'utf8', flag: initial ? 'wx' : 'w' });
  save(true);
  let browser, supervisor, supervisorContext, stage = 'start', pageErrors = 0, baselineIdentity;
  const contexts = [];
  const boundaries = new Set();
  const api = async (page, path, method = 'GET', body) => {
    requireCondition(new URL(page.url()).origin === config.baseURL && /^\/api\/[a-z0-9/?=&_.%-]+$/i.test(path),
      'api_page_or_path_outside_boundary');
    assertMutationAllowed({ url: new URL(path, config.baseURL).href, method, body }, scope);
    return page.evaluate(browserApiRequest, { path, method, body });
  };
  const newContext = async () => {
    const context = await browser.newContext({ baseURL: config.baseURL, viewport: { width: 390, height: 844 },
      isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    context.setDefaultTimeout(45000);
    context.setDefaultNavigationTimeout(45000);
    context.on('page', (page) => page.on('pageerror', () => { pageErrors += 1; }));
    // Block service workers for complete interception of mutation boundaries.
    // The separate release shell/update verifier owns service-worker coverage.
    await context.route('**/*', async (route) => {
      try {
        const request = route.request();
        const body = ['GET', 'HEAD'].includes(request.method()) ? undefined : request.postDataJSON() || {};
        assertMutationAllowed({ url: request.url(), method: request.method(), body }, scope);
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/supervisor/worker-invitations') {
          fixtures.find((item) => item.email === body.email).attempted = true;
        }
        await forwardWithoutRedirects(route, config.baseURL);
      } catch (error) {
        boundaries.add(safeFailure(error));
        await route.abort();
        return;
      }
    });
    contexts.push(context);
    return context;
  };
  const step = async (name, action) => {
    stage = name;
    await action();
    requireCondition(boundaries.size === 0, 'request_boundary_violation');
    evidence.checks.push({ name, status: 'passed' });
    save();
  };
  const staff = async () => {
    const users = await api(supervisor, '/api/supervisor/users');
    requireCondition(users.ok && Array.isArray(users.body), 'staff_lookup_failed');
    return users.body;
  };
  const identitySnapshot = (row) => JSON.stringify({ id: row.id, email: row.email, name: row.name,
    role: row.role, worker_class: row.worker_class, department_id: row.department_id,
    is_global_admin: row.is_global_admin, status: row.status, password_setup_required: row.password_setup_required });
  const requireSupervisor = async () => {
    const me = await api(supervisor, '/api/auth/me');
    requireCondition(me.ok && me.body.id === 16 && me.body.email === demoEmail && me.body.role === 'supervisor'
      && me.body.department_id === 2 && !me.body.is_global_admin, 'exact_demo_supervisor_identity_failed');
    if (baselineIdentity) requireCondition(identitySnapshot(me.body) === baselineIdentity, 'demo_supervisor_identity_changed');
    return me.body;
  };
  const cookieSnapshot = async () => (await supervisorContext.cookies(config.baseURL))
    .filter((cookie) => ['__session', 'geo_csrf_token', 'geo_access_token'].includes(cookie.name))
    .sort((left, right) => left.name.localeCompare(right.name)).map(({ name, value }) => ({ name, value }));
  const createInvite = async (fixture) => {
    await supervisor.locator('#addStaffUserButton').click();
    await supervisor.locator('#staffNameInput').fill(fixture.name);
    await supervisor.locator('#staffEmailInput').fill(fixture.email);
    requireCondition(!await supervisor.locator('#staffPasswordInput').isVisible(), 'supervisor_password_input_visible');
    const response = await responseTo(supervisor, '/api/supervisor/worker-invitations',
      () => supervisor.locator('#staffUserSubmitButton').click());
    requireCondition(response.ok(), 'owned_invitation_creation_failed');
    const invitation = await response.json();
    requireCondition(ownedWorker(invitation.user, fixture) && invitation.user.password_setup_required === true
      && invitation.delivery_method === 'manual' && /^[A-Za-z0-9_-]{32,200}$/.test(invitation.token),
    'created_invited_worker_not_owned');
    fixture.id = invitation.user.id;
    fixture.token = invitation.token;
    evidence.owned.push({ kind: fixture.kind, workerId: fixture.id, departmentId: 2 });
    save();
    await supervisor.locator('#workerInvitationDialog[open]').waitFor();
    const link = new URL(await supervisor.locator('#workerInvitationLink').inputValue());
    requireCondition(link.origin === config.baseURL && link.pathname === '/setup-password.html'
      && !link.search && link.hash === `#token=${fixture.token}`, 'private_fragment_link_required');
    const nativeShareAvailable = await supervisor.evaluate(() => typeof navigator.share === 'function');
    requireCondition(await supervisor.locator('#shareWorkerInvitationButton').isVisible() === nativeShareAvailable
      && await supervisor.locator('#copyWorkerInvitationButton').isVisible(), 'share_copy_availability_mismatch');
    evidence.nativeShareAvailable = nativeShareAvailable;
    // Never click Share or Copy: no OS chooser/send and no secret clipboard writes.
    await supervisor.locator('#closeWorkerInvitationButton').click();
    requireCondition(!await supervisor.locator('#workerInvitationLink').inputValue(), 'closed_invitation_secret_not_cleared');
    return link.href;
  };
  const fillSetup = async (page, link, fixture) => {
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await page.locator('#setupPasswordForm').waitFor({ state: 'visible' });
    requireCondition(!new URL(page.url()).hash && !new URL(page.url()).search
      && (await page.locator('#setupInvitationIdentity').innerText()).includes(fixture.email), 'setup_identity_or_fragment_failed');
    await page.locator('#setupLinkHelp > summary').click();
    requireCondition(await page.locator('#setupLinkHelp .compact-help-content').isVisible(), 'setup_help_unavailable');
    await page.locator('#setupLinkHelp > summary').click();
    await page.locator('#setupPasswordInput').fill(fixture.password);
    await page.locator('#setupPasswordConfirmInput').fill(fixture.password);
  };
  const singleUse = async (page, fixture) => {
    const reused = await api(page, '/api/auth/worker-invitations/accept', 'POST',
      { token: fixture.token, password: fixture.password });
    requireCondition(reused.status === 400, 'invitation_was_not_single_use');
  };
  try {
    browser = await chromium.launch({ headless: true });
    supervisorContext = await newContext();
    supervisor = await supervisorContext.newPage();
    await step('phone_login_recovery_help_and_exact_demo_identity', async () => {
      await supervisor.goto('/index.html', { waitUntil: 'domcontentloaded' });
      await supervisor.waitForFunction(() => document.body.dataset.activeView === 'login'
        && document.querySelector('#syncIndicator')?.dataset.state !== 'checking');
      await supervisor.locator('#passwordRecoveryHelp > summary').waitFor({ state: 'visible' });
      await supervisor.locator('#passwordRecoveryHelp > summary').click();
      requireCondition((await supervisor.locator('#passwordRecoveryHelp').innerText()).includes('handled by your supervisor'),
        'supervisor_assisted_recovery_guidance_missing');
      await supervisor.locator('#passwordRecoveryHelp > summary').click();
      await supervisor.locator('#signInHelp > summary').click();
      requireCondition(await supervisor.locator('#signInHelp .compact-help-content').isVisible(), 'sign_in_help_missing');
      await supervisor.locator('#signInHelp > summary').click();
      await supervisor.locator('#emailInput').fill(config.supervisor.email);
      await supervisor.locator('#passwordInput').fill(config.supervisor.password);
      await supervisor.locator('#loginSubmitButton').click();
      await supervisor.waitForFunction(() => document.body.dataset.activeView === 'supervisor');
      baselineIdentity = identitySnapshot(await requireSupervisor());
      await supervisor.locator('#passwordInput').evaluate((input) => { input.value = ''; });
      const menu = supervisor.locator('.admin-desktop-nav [data-admin-workspace-target="people"]');
      if (await menu.isVisible()) await menu.click();
      else {
        await supervisor.locator('#adminMobileMenuButton').click();
        await supervisor.locator('#adminWorkspaceDrawer [data-admin-workspace-target="people"]').click();
      }
      await supervisor.locator('[data-admin-workspace-panel="people"]').waitFor({ state: 'visible' });
    });
    await step('manual_private_invitation_share_and_copy_availability', async () => {
      for (const fixture of fixtures) fixture.link = await createInvite(fixture);
    });
    await step('same_browser_password_setup_preserves_supervisor_session', async () => {
      const fixture = fixtures[0];
      const setup = await supervisorContext.newPage();
      await fillSetup(setup, fixture.link, fixture);
      const beforeCookies = JSON.stringify(await cookieSnapshot());
      const beforeIdentity = await setup.evaluate(() => localStorage.getItem('geo_user'));
      requireCondition(beforeIdentity !== null, 'existing_saved_identity_required');
      const accepted = await responseTo(setup, '/api/auth/worker-invitations/accept',
        () => setup.getByRole('button', { name: 'Set password', exact: true }).click());
      requireCondition(accepted.ok() && !accepted.headers()['set-cookie'], 'acceptance_changed_authentication_cookies');
      await setup.locator('#setupPasswordStatus').getByText('Password set. You can now sign in to ReportFlow.', { exact: true }).waitFor();
      requireCondition(JSON.stringify(await cookieSnapshot()) === beforeCookies
        && await setup.evaluate(() => localStorage.getItem('geo_user')) === beforeIdentity, 'setup_changed_existing_browser_identity');
      const guarded = await responseTo(setup, '/api/auth/login/after-setup', () => api(setup,
        '/api/auth/login/after-setup', 'POST', { email: fixture.email, password: fixture.password, only_if_signed_out: true }));
      requireCondition(guarded.status() === 409 && !guarded.headers()['set-cookie'], 'guarded_route_replaced_existing_session');
      requireCondition(JSON.stringify(await cookieSnapshot()) === beforeCookies, 'guarded_route_changed_existing_cookies');
      await requireSupervisor();
      await singleUse(setup, fixture);
      const row = (await staff()).find((user) => user.id === fixture.id);
      requireCondition(ownedWorker(row, fixture) && row.password_setup_required === false, 'existing_context_worker_setup_not_durable');
      await setup.close();
    });
    await step('clean_browser_password_setup_continues_directly_into_worker', async () => {
      const fixture = fixtures[1];
      const context = await newContext();
      const setup = await context.newPage();
      await fillSetup(setup, fixture.link, fixture);
      const acceptancePromise = setup.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/worker-invitations/accept');
      const continuation = await responseTo(setup, '/api/auth/login/after-setup',
        () => setup.getByRole('button', { name: 'Set password and continue', exact: true }).click());
      const accepted = await acceptancePromise;
      requireCondition(accepted.ok() && !accepted.headers()['set-cookie'] && continuation.ok(), 'clean_browser_continuation_failed');
      await setup.waitForURL(`${config.baseURL}/index.html`);
      await setup.waitForFunction(() => document.body.dataset.activeView === 'worker');
      const me = await api(setup, '/api/auth/me');
      const saved = await setup.evaluate(() => JSON.parse(localStorage.getItem('geo_user') || 'null'));
      requireCondition(me.ok && ownedWorker(me.body, fixture) && me.body.password_setup_required === false
        && saved?.id === fixture.id && saved?.email === fixture.email, 'continued_worker_identity_mismatch');
      requireCondition(await setup.locator('#workerView').isVisible() && !await setup.locator('#loginView').isVisible(),
        'continuation_returned_to_login');
      await singleUse(setup, fixture);
      await requireSupervisor();
      await context.close();
    });
    await step('existing_demo_identity_unchanged_and_no_browser_errors', async () => {
      await requireSupervisor();
      requireCondition(pageErrors === 0, 'browser_page_error_detected');
    });
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.failure = { checkpoint: stage, code: safeFailure(error) };
  } finally {
    // Close worker/setup pages before cleanup so no late acceptance can race it.
    for (const context of contexts) if (context !== supervisorContext) await context.close().catch(() => {});
    if (supervisorContext) for (const page of supervisorContext.pages()) {
      if (page !== supervisor) await page.close().catch(() => {});
    }
    for (const fixture of fixtures.filter((item) => item.attempted)) {
      try {
        await requireSupervisor();
        const matches = (await staff()).filter((row) => ownedWorker(row, fixture));
        requireCondition(matches.length === 1, 'owned_worker_outcome_unknown_requires_operator_recheck');
        fixture.id = matches[0].id;
        fixture.cleanupVerified = true;
        if (!evidence.owned.some((row) => row.workerId === fixture.id)) {
          evidence.owned.push({ kind: fixture.kind, workerId: fixture.id, departmentId: 2 });
        }
        const resigned = await api(supervisor, `/api/supervisor/users/${fixture.id}/status`, 'POST', { status: 'resigned', confirmed: true });
        requireCondition(resigned.ok && ownedWorker(resigned.body, fixture) && resigned.body.status === 'resigned', 'owned_worker_resign_failed');
        const verified = (await staff()).find((row) => row.id === fixture.id);
        requireCondition(ownedWorker(verified, fixture) && verified.status === 'resigned', 'owned_worker_resign_not_durable');
        evidence.cleanup.resignedWorkerIds.push(fixture.id);
      } catch (error) { evidence.cleanup.failures.push({ kind: fixture.kind, code: safeFailure(error) }); }
    }
    if (boundaries.size) evidence.cleanup.failures.push(...[...boundaries].map((code) => ({ kind: 'request_boundary', code })));
    if (evidence.cleanup.failures.length) evidence.status = 'failed';
    for (const fixture of fixtures) { fixture.password = ''; fixture.token = ''; fixture.link = ''; }
    await Promise.allSettled(contexts.map((context) => context.close()));
    if (browser) await browser.close().catch(() => {});
    evidence.completedAtUtc = new Date().toISOString();
    evidence.browserPageErrors = pageErrors;
    save();
  }
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const result = await runOnboarding(readConfiguration());
    console.log(JSON.stringify({ status: result.status, checkpoints: result.checks.length }));
    if (result.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ status: 'refused', code: safeFailure(error) }));
    process.exitCode = 1;
  }
}
