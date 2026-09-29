// Pure guard tests only: imports never launch a browser or contact a host.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertMutationAllowed, ownedWorker, ownedTemplate, ownedReport, readConfiguration } from './check-hosted-report-ux-release.mjs';

const baseURL = 'https://geo-attendance-system-db9ca.web.app';
const worker = { email: 'nonce-owned@example.invalid', name: 'TEST ONLY nonce', password: 'test-old-password', newPassword: 'test-new-password' };
const scope = { baseURL, supervisor: { password: 'test-supervisor-password' }, worker, workerId: 101, workerVerified: true,
  establishedVerified: true, invitationToken: 'synthetic-invitation-token', recoveryTokens: new Set(['synthetic-recovery-token']),
  templateId: 102, templateVerified: true, templateName: 'TEST ONLY nonce template', templateDescription: 'nonce description',
  fields: [{ id: 'ux_detail', label: 'Site observation', type: 'textarea', required: true }],
  reportId: 103, reportDate: '2026-09-29', marker: 'nonce marker', clientId: '00000000-0000-4000-8000-000000000001',
  uploadPaths: new Set(['/uploads/owned.png']), photoName: 'owned.png', photoBuffer: Buffer.from('synthetic raster'),
  allowSubmit: true, cleanupReason: 'nonce cleanup', cleanupReportVerified: true, cleanupWorkerVerified: true };
const request = (path, method, body, overrides = {}) => ({ url: new URL(path, baseURL).href, method, body, ...overrides });
const allowed = (req, changes = {}) => assert.doesNotThrow(() => assertMutationAllowed(req, { ...scope, ...changes }));
const refused = (req, changes = {}) => assert.throws(() => assertMutationAllowed(req, { ...scope, ...changes }));

for (const method of ['POST', 'DELETE']) {
  const recovery = request('/api/supervisor/users/101/password-recovery', method, {});
  allowed(recovery);
  for (const changes of [{ workerVerified: false }, { establishedVerified: false }, { workerId: 13 }, { workerId: 16 }]) refused(recovery, changes);
  for (const id of [13, 14, 16, 100]) refused(request(`/api/supervisor/users/${id}/password-recovery`, method, {}));
  refused(request('/api/supervisor/users/101/password-recovery', method, { password: worker.newPassword }));
}
console.log('ok - recovery operations require exact fresh established Worker ownership; existing presentation identities are denied');

const accept = request('/api/auth/worker-password-recovery/accept', 'POST', { token: 'synthetic-recovery-token', password: worker.newPassword });
allowed(accept);
refused(accept, { establishedVerified: false });
refused(accept, { recoveryTokens: new Set() });
refused(request('/api/auth/worker-password-recovery/accept', 'POST', { token: scope.invitationToken, password: worker.newPassword }));
refused(request('/api/auth/worker-password-recovery/accept', 'POST', { token: 'synthetic-recovery-token', password: worker.password }));
console.log('ok - recovery capabilities/passwords remain purpose-bound and cannot reset an unverified identity');

const creation = request('/api/supervisor/work-forms', 'POST', { name: scope.templateName, description: scope.templateDescription,
  department_id: 2, template_purpose: 'report', fields: scope.fields });
allowed(creation);
refused(creation, { templateAttempted: true });
refused({ ...creation, body: { ...creation.body, department_id: 1 } });
refused({ ...creation, body: { ...creation.body, fields: [] } });
allowed(request('/api/supervisor/work-forms/102', 'PATCH', { confirmed: true, status: 'archived' }));
refused(request('/api/supervisor/work-forms/102', 'PATCH', { confirmed: true, name: 'changed', status: 'archived' }));
refused(request('/api/supervisor/work-forms/7', 'PATCH', { confirmed: true, status: 'archived' }));
console.log('ok - only the nonce Template definition can be created once and only its lifecycle can be changed');

const post = request('/api/form-submissions', 'POST', { form_id: 102, expected_definition_version: 1, site_id: null,
  work_date: scope.reportDate, answers: { ux_detail: scope.marker }, photo_urls: ['/uploads/owned.png'], photo_metadata: [],
  client_submission_id: scope.clientId });
allowed(post);
refused(post, { allowSubmit: false });
refused(post, { workerVerified: false });
refused(post, { templateVerified: false });
refused({ ...post, body: { ...post.body, form_id: 7 } });
refused({ ...post, body: { ...post.body, answers: { ux_detail: scope.marker, foreign: 'x' } } });
refused({ ...post, body: { ...post.body, photo_urls: ['/uploads/not-owned.png'] } });
refused({ ...post, body: { ...post.body, worker_id: 13 } });
const multipart = Buffer.concat([Buffer.from('Content-Disposition: form-data; name="file"; filename="owned.png"\r\n\r\n'), scope.photoBuffer, Buffer.from('\r\n--boundary--')]);
allowed(request('/api/photo-uploads', 'POST', {}, { bytes: multipart }));
refused(request('/api/photo-uploads', 'POST', {}, { bytes: multipart }), { allowSubmit: false });
refused(request('/api/photo-uploads', 'POST', {}, { bytes: Buffer.from('not owned') }));
console.log('ok - uploads/Report submission require confirmation, owned original bytes, exact Template/answers and owned upload paths');

allowed(request('/api/supervisor/trash/form/103', 'POST', { confirmed: true, reason: scope.cleanupReason }));
refused(request('/api/supervisor/trash/form/103', 'POST', { confirmed: true, reason: scope.cleanupReason }), { cleanupReportVerified: false });
refused(request('/api/supervisor/trash/form/5', 'POST', { confirmed: true, reason: scope.cleanupReason }));
allowed(request('/api/supervisor/users/101/status', 'POST', { confirmed: true, status: 'resigned' }));
refused(request('/api/supervisor/users/101/status', 'POST', { confirmed: true, status: 'resigned' }), { cleanupWorkerVerified: false });
for (const path of ['/api/supervisor/users/13/status', '/api/supervisor/trash/form/103/purge', '/api/dev/seed']) {
  refused(request(path, 'POST', { confirmed: true, status: 'resigned' }));
}
refused(request('/api/auth/login', 'POST', { email: 'demo-20260916-alex@example.invalid', password: worker.password }));
refused(request('/api/auth/login', 'POST', { email: worker.email, password: worker.password }, { url: 'https://example.com/api/auth/login' }));
refused(request('/api/auth/login?token=forbidden', 'POST', { email: worker.email, password: worker.password }));
console.log('ok - cleanup is exact-owned soft-delete/archive/resign only; foreign identities, broad deletes and foreign origins are rejected');

const owned = { id: 101, email: worker.email, name: worker.name, department_id: 2, role: 'worker', worker_class: 'normal', is_global_admin: false };
assert.equal(ownedWorker(owned, scope), true);
for (const changes of [{ id: 13 }, { email: 'demo@example.invalid' }, { name: 'different' }, { department_id: 1 }, { role: 'supervisor' }, { is_global_admin: true }]) {
  assert.equal(ownedWorker({ ...owned, ...changes }, scope), false);
}
assert.equal(ownedTemplate({ id: 102, name: scope.templateName, description: scope.templateDescription,
  department_id: 2, created_by: 16, template_purpose: 'report' }, scope), true);
assert.equal(ownedReport({ id: 103, form_id: 102, worker_id: 101, submission_purpose: 'report',
  work_date: scope.reportDate, answers: { ux_detail: scope.marker }, client_submission_id: scope.clientId }, scope), true);
assert.throws(() => readConfiguration([], {}));
assert.throws(() => readConfiguration(['--allow-hosted-mutations', '--run-id', 'safe-run'], {
  HOSTED_REPORT_BASE_URL: 'https://example.com', HOSTED_REPORT_ALLOWED_HOST: 'example.com' }));
const source = readFileSync(resolve('scripts/check-hosted-report-ux-release.mjs'), 'utf8');
assert.match(source, /serviceWorkers: 'block'/);
assert.match(source, /maxRedirects: 0/);
assert.doesNotMatch(source, /\.screenshot\(|\.tracing\.|clipboard\.writeText\(/);
const wrapper = readFileSync(resolve('scripts/run-hosted-report-ux-release.py'), 'utf8');
assert.match(wrapper, /capture_output=True/);
assert.doesNotMatch(wrapper, /print\(result\.(stdout|stderr)/);
console.log('ok - ownership predicates, opt-in configuration and non-secret diagnostic design pass without network access');
console.log('PASS - hosted combined UX runner guard checks');
