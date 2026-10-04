// Offline only: synthetic scopes/credentials, pure guards, and source inspection.
// Importing the runner must never launch a browser or issue a hosted request.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const originalLaunch = chromium.launch;
const originalFetch = globalThis.fetch;
chromium.launch = () => { throw new Error('browser_launch_forbidden_in_guard_tests'); };
globalThis.fetch = () => { throw new Error('network_forbidden_in_guard_tests'); };

try {
  const { assertMutationAllowed, ownedReport, ownedWorker, ownedTemplate, readConfiguration } =
    await import('./check-hosted-report-october-release.mjs');
  const baseURL = 'https://geo-attendance-system-db9ca.web.app';
  const supervisorEmail = 'demo-20260916-supervisor@example.invalid';
  const worker = { email: 'nonce-owned@example.invalid', name: 'TEST ONLY OCT synthetic', password: 'synthetic-worker-password' };
  const first = { id: 103, marker: 'Recovered owned marker', photoCount: 7, recovery: true,
    clientId: '00000000-0000-4000-8000-000000000001' };
  const second = { id: 104, marker: 'Second owned marker', photoCount: 0, recovery: false,
    clientId: '00000000-0000-4000-8000-000000000002' };
  const photos = Array.from({ length: 8 }, (_, index) => ({ name: `owned-${index}.png`, buffer: Buffer.from(`synthetic-raster-${index}`) }));
  const urls = photos.slice(1).map((item) => `/uploads/${item.name}`);
  const scope = { baseURL, supervisor: { password: 'synthetic-supervisor-password' }, worker, workerId: 101,
    workerVerified: true, invitationToken: 'synthetic-invitation-token', templateId: 102, templateVerified: true,
    templateName: 'TEST ONLY OCT synthetic Template', templateDescription: 'Exact nonce-owned description',
    fields: [{ id: 'ux_detail', label: 'Observation', type: 'textarea', required: true }], reportDate: '2026-10-05',
    reportPlans: [first, second], photos, uploadPaths: new Set(urls), verifiedReportIds: new Set([103, 104]),
    allowSubmit: true, uploadPhase: 'recovered', currentPlan: first,
    finalNote: 'Exact final synthetic note', cleanupReason: 'Exact owned cleanup',
    cleanupTemplateVerified: true, cleanupWorkerVerified: true };
  const recoveryHeaders = { 'x-report-recovery-worker': '101', 'x-report-recovery-department': '2' };
  const request = (path, method = 'POST', body = {}, overrides = {}) => ({ url: new URL(path, baseURL).href, method, body, ...overrides });
  const allowed = (req, changes = {}) => assert.doesNotThrow(() => assertMutationAllowed(req, { ...scope, ...changes }));
  const refused = (req, changes = {}) => assert.throws(() => assertMutationAllowed(req, { ...scope, ...changes }));
  const altered = (req, changes) => ({ ...req, body: { ...req.body, ...changes } });
  let groups = 0;
  const check = (name, action) => { action(); groups += 1; console.log(`ok - ${name}`); };

  check('configuration requires exact approved origin, private Supervisor, new evidence path and opt-in run', () => {
    const args = ['--allow-hosted-mutations', '--run-id', 'october-guard'];
    const evidenceDir = resolve(`docs/evidence/hosted-october-guard-${randomUUID()}`);
    const env = { HOSTED_OCTOBER_ORIGIN: baseURL, HOSTED_REPORT_ALLOWED_HOST: new URL(baseURL).host,
      HOSTED_OCTOBER_EVIDENCE_DIR: evidenceDir, HOSTED_OCTOBER_SUPERVISOR_EMAIL: supervisorEmail,
      HOSTED_OCTOBER_SUPERVISOR_PASSWORD: scope.supervisor.password };
    const config = readConfiguration(args, env);
    assert.equal(config.baseURL, baseURL);
    assert.equal(config.evidenceDir, evidenceDir);
    assert.equal(config.runId, 'october-guard');
    assert.deepEqual(Object.keys(config.supervisor).sort(), ['email', 'password']);
    const preview = 'https://geo-attendance-system-db9ca--october-guard-abc.web.app';
    assert.equal(readConfiguration(args, { ...env, HOSTED_OCTOBER_ORIGIN: preview,
      HOSTED_REPORT_ALLOWED_HOST: new URL(preview).host }).baseURL, preview);
    for (const argv of [[], args.slice(1), [...args, '--extra'], ['--allow-hosted-mutations', '--run-id', '../foreign']]) {
      assert.throws(() => readConfiguration(argv, env));
    }
    for (const changes of [
      { HOSTED_OCTOBER_ORIGIN: 'https://foreign.example' }, { HOSTED_OCTOBER_ORIGIN: baseURL.replace('https:', 'http:') },
      { HOSTED_OCTOBER_ORIGIN: `${baseURL}/api` }, { HOSTED_OCTOBER_ORIGIN: `${baseURL}?token=secret` },
      { HOSTED_REPORT_ALLOWED_HOST: 'foreign.example' }, { HOSTED_OCTOBER_SUPERVISOR_EMAIL: worker.email },
      { HOSTED_OCTOBER_SUPERVISOR_PASSWORD: 'short' }, { HOSTED_OCTOBER_EVIDENCE_DIR: resolve('docs/evidence') },
      { HOSTED_OCTOBER_EVIDENCE_DIR: resolve('outside-evidence') },
    ]) assert.throws(() => readConfiguration(args, { ...env, ...changes }));
  });

  check('only exact Supervisor/owned Worker sessions and one nonce invitation are allowed', () => {
    const login = request('/api/auth/login', 'POST', { email: supervisorEmail, password: scope.supervisor.password });
    allowed(login);
    allowed(altered(login, { email: worker.email, password: worker.password }));
    refused(altered(login, { email: 'demo-20260916-alex@example.invalid', password: worker.password }));
    refused(altered(login, { password: 'wrong' }));
    refused(altered(login, { is_global_admin: true }));
    for (const path of ['/api/auth/logout', '/api/auth/refresh']) {
      allowed(request(path));
      refused(request(path, 'POST', { user_id: 13 }));
    }
    const invite = request('/api/supervisor/worker-invitations', 'POST', {
      email: worker.email, name: worker.name, worker_class: 'normal', department_id: 2,
    });
    allowed(invite);
    refused(invite, { inviteAttempted: true });
    for (const body of [{ email: supervisorEmail }, { name: 'foreign' }, { worker_class: 'leader' },
      { department_id: 1 }, { password: worker.password }, { role: 'supervisor' }]) refused(altered(invite, body));
    const acceptance = request('/api/auth/worker-invitations/accept', 'POST', {
      token: scope.invitationToken, password: worker.password,
    });
    allowed(acceptance);
    refused(acceptance, { workerVerified: false });
    refused(acceptance, { workerId: 13 });
    refused(altered(acceptance, { token: 'foreign-token' }));
    refused(altered(acceptance, { password: 'different-password' }));
  });

  check('Template creation/archive stays definition-exact, one-shot, and cleanup-verified', () => {
    const creation = request('/api/supervisor/work-forms', 'POST', { name: scope.templateName, description: scope.templateDescription,
      department_id: 2, template_purpose: 'report', fields: scope.fields });
    allowed(creation);
    refused(creation, { templateAttempted: true });
    for (const body of [{ name: 'foreign' }, { description: 'foreign' }, { department_id: 1 },
      { template_purpose: 'daywork' }, { fields: [] }, { confirmed: true }]) refused(altered(creation, body));
    const archive = request('/api/supervisor/work-forms/102', 'PATCH', { status: 'archived', confirmed: true });
    allowed(archive);
    refused(archive, { templateVerified: false });
    refused(archive, { cleanupTemplateVerified: false });
    refused({ ...archive, url: `${baseURL}/api/supervisor/work-forms/7` });
    refused(altered(archive, { name: 'edited' }));
    refused(altered(archive, { status: 'active' }));
  });

  check('photo writes require exact original bytes, filename, active phase and recovered identity', () => {
    const multipart = (item) => Buffer.concat([
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="${item.name}"\r\n\r\n`),
      item.buffer, Buffer.from('\r\n--boundary--'),
    ]);
    const photo = request('/api/photo-uploads', 'POST', {}, { bytes: multipart(photos[1]), headers: recoveryHeaders });
    allowed(photo);
    allowed({ ...photo, bytes: multipart(photos[0]), headers: {} }, { uploadPhase: 'reject_original' });
    for (const changes of [{ allowSubmit: false }, { templateVerified: false }, { workerVerified: false },
      { workerId: 16 }, { uploadPhase: 'none' }]) refused(photo, changes);
    for (const headers of [{}, { ...recoveryHeaders, 'x-report-recovery-worker': '13' },
      { ...recoveryHeaders, 'x-report-recovery-department': '1' }, { 'x-report-recovery-worker': '101' }]) refused({ ...photo, headers });
    refused({ ...photo, bytes: Buffer.from('not an owned raster') });
    refused({ ...photo, bytes: multipart({ ...photos[1], name: 'foreign.png' }) });
    refused({ ...photo, bytes: Buffer.concat([multipart(photos[1]), Buffer.alloc(4096)]) });
  });

  const reportBody = { form_id: 102, site_id: null, work_date: scope.reportDate, answers: { ux_detail: first.marker },
    photo_urls: urls, photo_metadata: [], client_submission_id: first.clientId, expected_definition_version: 1 };
  const report = request('/api/form-submissions', 'POST', reportBody, { headers: recoveryHeaders });
  check('recovered Report preserves original key and cannot POST unknown original source or foreign content', () => {
    allowed(report);
    for (const changes of [{ allowSubmit: false }, { workerVerified: false }, { templateVerified: false },
      { currentPlan: null }, { currentPlan: second }, { uploadPhase: 'reject_original' }, { uploadPhase: 'none' }]) refused(report, changes);
    for (const body of [{ answers: { ux_detail: 'Original failed source marker' } }, { form_id: 7 },
      { work_date: '2026-10-04' }, { site_id: 5 }, { expected_definition_version: 2 },
      { client_submission_id: second.clientId }, { client_submission_id: 'not-a-uuid' },
      { answers: { ux_detail: first.marker, foreign: 'extra' } }, { photo_urls: urls.slice(1) },
      { photo_urls: [...urls.slice(1), urls[1]] }, { photo_urls: [...urls.slice(1), '/uploads/foreign.png'] },
      { worker_id: 13 }, { submission_purpose: 'daywork' }]) refused(altered(report, body));
    const missingOriginalKey = { ...first, clientId: null };
    refused(report, { reportPlans: [missingOriginalKey, second], currentPlan: missingOriginalKey });
    for (const headers of [{}, { ...recoveryHeaders, 'x-report-recovery-worker': '16' },
      { ...recoveryHeaders, 'x-report-recovery-department': '02' }, { 'x-report-recovery-worker': '101' }]) refused({ ...report, headers });
    const ordinary = altered(report, { answers: { ux_detail: second.marker }, photo_urls: [], client_submission_id: second.clientId });
    allowed({ ...ordinary, headers: {} }, { currentPlan: second, uploadPhase: 'none' });
    refused(altered(ordinary, { client_submission_id: first.clientId }), { currentPlan: second, uploadPhase: 'none' });
  });

  check('explicit endpoint probes bind verified durable first key, exact configured body and recovery headers', () => {
    const replayBody = { ...reportBody, answers: { ux_detail: 'Original failed source marker' } };
    for (const headers of [recoveryHeaders, { ...recoveryHeaders, 'x-report-recovery-department': '1' },
      { 'x-report-recovery-worker': '101' }]) {
      const endpointProbe = { body: replayBody, headers };
      const changes = { allowSubmit: false, currentPlan: null, endpointProbe };
      const replay = request('/api/form-submissions', 'POST', replayBody, { headers });
      allowed(replay, changes);
      refused(replay, { ...changes, endpointProbe: null });
      refused(replay, { ...changes, workerVerified: false });
      refused(replay, { ...changes, verifiedReportIds: new Set([second.id]) });
      refused(replay, { ...changes, reportPlans: [{ ...first, clientId: second.clientId }, second] });
      refused(altered(replay, { client_submission_id: second.clientId }), changes);
      refused(altered(replay, { answers: { ux_detail: 'unconfigured edit' } }), changes);
      refused(altered(replay, { form_id: 7 }), changes);
      refused({ ...replay, headers: { ...headers, 'x-report-recovery-worker': '16' } }, changes);
      refused({ ...replay, headers: { ...headers, 'x-report-recovery-department': 'unknown' } }, changes);
    }
  });

  check('workflow changes and cleanup require exact verified Report/Worker/Template identities', () => {
    const start = request('/api/supervisor/form-submissions/103/transition', 'POST', { status: 'in_review' });
    const resolved = altered(start, { status: 'resolved', supervisor_note: scope.finalNote });
    allowed(start, { transitionReportId: first.id });
    allowed(resolved, { transitionReportId: first.id });
    refused(start);
    refused(start, { transitionReportId: first.id, verifiedReportIds: new Set() });
    for (const body of [{ status: 'approved' }, { status: 'rejected' }, { confirmed: true }]) refused(altered(start, body), { transitionReportId: first.id });
    refused(altered(resolved, { supervisor_note: 'foreign note' }), { transitionReportId: first.id });
    refused({ ...start, url: `${baseURL}/api/supervisor/form-submissions/5/transition` }, { transitionReportId: first.id });
    const trash = request('/api/supervisor/trash/form/103', 'POST', { confirmed: true, reason: scope.cleanupReason });
    allowed(trash, { cleanupReportId: first.id });
    refused(trash);
    refused(trash, { cleanupReportId: first.id, verifiedReportIds: new Set() });
    refused(altered(trash, { reason: 'foreign cleanup' }), { cleanupReportId: first.id });
    refused({ ...trash, url: `${baseURL}/api/supervisor/trash/form/5` }, { cleanupReportId: first.id });
    const resign = request('/api/supervisor/users/101/status', 'POST', { status: 'resigned', confirmed: true });
    allowed(resign);
    refused(resign, { cleanupWorkerVerified: false });
    refused(resign, { workerVerified: false });
    refused(altered(resign, { status: 'active' }));
    for (const id of [13, 14, 16, 20]) refused({ ...resign, url: `${baseURL}/api/supervisor/users/${id}/status` });
  });

  check('foreign origins, mutation queries, password recovery, purge and unrelated writes are denied', () => {
    for (const method of ['GET', 'HEAD', 'POST']) {
      refused(request('/api/auth/refresh', method, {}, { url: 'https://foreign.example/api/auth/refresh' }));
      refused(request('/api/auth/refresh', method, {}, { url: baseURL.replace('https://', 'https://user:secret@') + '/api/auth/refresh' }));
    }
    allowed(request('/api/my-form-submissions?purpose=report', 'GET'));
    refused(request('/api/auth/refresh?force=true'));
    for (const path of ['/api/supervisor/users/101/password-recovery', '/api/supervisor/users/13/password-recovery',
      '/api/auth/worker-password-recovery/accept', '/api/supervisor/trash/form/103/purge',
      '/api/supervisor/trash/form/103/restore', '/api/supervisor/users/101/invitation',
      '/api/dev/seed', '/api/supervisor/users', '/api/attendance', '/api/task-logs']) {
      for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) refused(request(path, method));
    }
    refused({ ...report, method: 'PUT' });
    refused(request('/uploads/owned.png', 'DELETE'));
  });

  check('ownership predicates require nonce content and scope and exclude retained presentation identities', () => {
    const ownedStaff = { id: 101, email: worker.email, name: worker.name, department_id: 2,
      role: 'worker', worker_class: 'normal', is_global_admin: false };
    assert.equal(ownedWorker(ownedStaff, scope), true);
    for (const changes of [{ id: 13 }, { id: 105 }, { email: supervisorEmail }, { name: 'foreign' },
      { department_id: 1 }, { role: 'supervisor' }, { worker_class: 'leader' }, { is_global_admin: true }]) {
      assert.equal(ownedWorker({ ...ownedStaff, ...changes }, scope), false);
    }
    const ownedForm = { id: 102, name: scope.templateName, description: scope.templateDescription,
      department_id: 2, created_by: 16, template_purpose: 'report' };
    assert.equal(ownedTemplate(ownedForm, scope), true);
    for (const changes of [{ id: 7 }, { id: 105 }, { name: 'foreign' }, { description: 'foreign' },
      { department_id: 1 }, { created_by: 13 }, { template_purpose: 'daywork' }]) {
      assert.equal(ownedTemplate({ ...ownedForm, ...changes }, scope), false);
    }
    const ownedRow = { id: 103, form_id: 102, worker_id: 101, submission_purpose: 'report', work_date: scope.reportDate,
      answers: { ux_detail: first.marker }, client_submission_id: first.clientId };
    assert.equal(ownedReport(ownedRow, scope), true);
    for (const changes of [{ id: 21 }, { id: 105 }, { form_id: 7 }, { worker_id: 13 },
      { submission_purpose: 'daywork' }, { work_date: '2026-10-04' }, { answers: { ux_detail: second.marker } },
      { client_submission_id: second.clientId }]) assert.equal(ownedReport({ ...ownedRow, ...changes }, scope), false);
    assert.equal(ownedReport(ownedRow, { ...scope, reportPlans: [{ ...first, clientId: null }] }), false);
    assert.equal(ownedReport(null, scope), false);
  });

  check('runner source stores sanitized evidence only and never records credentials, traces or screenshots', () => {
    const source = readFileSync(resolve('scripts/check-hosted-report-october-release.mjs'), 'utf8');
    assert.match(source, /serviceWorkers: 'block'/);
    assert.match(source, /maxRedirects: 0/);
    assert.match(source, /redirect: 'error'/);
    assert.match(source, /finally \{/);
    assert.match(source, /submission_outcome_unknown_requires_operator/);
    assert.match(source, /scope\.worker\.password = ''/);
    assert.match(source, /scope\.invitationToken = ''/);
    assert.doesNotMatch(source, /\.screenshot\(|\.tracing\.|recordVideo|recordHar|clipboard\.writeText\(/);
    assert.doesNotMatch(source, /writeFileSync\((?!join\(config\.evidenceDir, 'evidence\.(?:json|txt)')/);
    assert.equal((source.match(/writeFileSync\(/g) || []).length, 2);
    assert.doesNotMatch(source, /(?:writeFile|appendFile|unlink|rm)\w*\([^\n]*(?:assets\/|backend\/|index\.html|sw\.js)/);
    assert.doesNotMatch(source, /console\.(?:log|error)\([^\n]*(?:password|invitationToken|\.headers|\.body|\.text\()/);
    assert.doesNotMatch(source, /evidence\.[^=\n]*=\s*(?:scope\.worker\.password|scope\.invitationToken|scope\.supervisor)/);
    const wrapper = readFileSync(resolve('scripts/run-hosted-report-october-release.py'), 'utf8');
    assert.match(wrapper, /capture_output=True/);
    assert.doesNotMatch(wrapper, /print\(result\.(?:stdout|stderr)/);
    assert.doesNotMatch(wrapper, /subprocess\.run\([\s\S]*?timeout\s*=/);
  });

  console.log(`PASS - ${groups} offline October hosted guard groups`);
} finally {
  chromium.launch = originalLaunch;
  globalThis.fetch = originalFetch;
}
