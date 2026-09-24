import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { approvedOrigin, assertMutationAllowed, evidenceDirectory, forwardWithoutRedirects, ownedWorker, readConfiguration, safeFailure } from './check-hosted-onboarding-release.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const origin = 'https://geo-attendance-system-db9ca.web.app';
const args = ['--allow-hosted-mutations', '--run-id', 'local-onboarding-guard'];
const directory = join(root, 'docs', 'evidence', `test-not-created-${randomUUID()}`);
const env = { HOSTED_REPORT_BASE_URL: origin, HOSTED_REPORT_ALLOWED_HOST: new URL(origin).host,
  HOSTED_REPORT_SUPERVISOR_EMAIL: 'demo-20260916-supervisor@example.invalid',
  HOSTED_REPORT_SUPERVISOR_PASSWORD: 'local-not-a-live-secret', HOSTED_ONBOARDING_EVIDENCE_DIR: directory };
assert.equal(readConfiguration(args, env).baseURL, origin);
assert.equal(approvedOrigin('https://geo-attendance-system-db9ca--release-20260925-abcdef.web.app/'),
  'https://geo-attendance-system-db9ca--release-20260925-abcdef.web.app');
for (const url of ['http://geo-attendance-system-db9ca.web.app', `${origin}:443`, `${origin}/path`, `${origin}?token=secret`,
  `${origin}#secret`, 'https://user@geo-attendance-system-db9ca.web.app', 'https://geo-attendance-system-db9ca.web.app.evil.invalid',
  'https://geo-attendance-system-db9ca--.web.app', 'https://another-project.web.app', 'https://GEO-attendance-system-db9ca.web.app']) {
  assert.throws(() => approvedOrigin(url));
}
for (const [input, config] of [[[], env], [args, { ...env, HOSTED_REPORT_ALLOWED_HOST: 'wrong.invalid' }],
  [args, { ...env, HOSTED_REPORT_SUPERVISOR_EMAIL: 'other@example.invalid' }],
  [args, { ...env, HOSTED_REPORT_SUPERVISOR_PASSWORD: 'short' }],
  [['--allow-hosted-mutations', '--run-id', '../escape'], env]]) {
  assert.throws(() => readConfiguration(input, config));
}
console.log('ok - explicit mutation consent, run id, exact project origin and demo Supervisor are mandatory');

assert.equal(evidenceDirectory(directory), directory);
for (const path of ['', root, join(root, 'docs', 'evidence'), join(root, 'output', 'outside-evidence')]) {
  assert.throws(() => evidenceDirectory(path));
}
console.log('ok - evidence must use a new repository evidence subdirectory');

const fixture = { id: 51, name: 'TEST ONLY nonce owned Worker', email: 'nonce-owned@example.invalid',
  password: 'owned-worker-password', token: 'owned-invitation-token', attempted: false, cleanupVerified: false };
const other = { ...fixture, id: 52, email: 'second-owned@example.invalid', name: 'TEST ONLY second nonce',
  password: 'second-owned-password', token: 'second-owned-token' };
const scope = { baseURL: origin, supervisor: { email: env.HOSTED_REPORT_SUPERVISOR_EMAIL, password: env.HOSTED_REPORT_SUPERVISOR_PASSWORD },
  fixtures: [fixture, other] };
const row = { id: 51, name: fixture.name, email: fixture.email, department_id: 2, role: 'worker', worker_class: 'normal', is_global_admin: false };
assert.equal(ownedWorker(row, fixture), true);
for (const patch of [{ id: 16 }, { id: 50 }, { name: 'Real Worker' }, { email: 'other@example.invalid' },
  { department_id: 1 }, { role: 'supervisor' }, { is_global_admin: true }, { worker_class: 'leader' }]) {
  assert.equal(ownedWorker({ ...row, ...patch }, fixture), false);
}
console.log('ok - cleanup ownership requires exact id, nonce name/email, Department and ordinary Worker role');

const check = (method, path, body) => assertMutationAllowed({ url: origin + path, method, body }, scope);
for (const [method, path, body] of [
  ['GET', '/api/auth/me'], ['POST', '/api/auth/refresh', {}], ['POST', '/api/auth/logout', {}],
  ['POST', '/api/auth/login', { ...scope.supervisor }],
  ['POST', '/api/auth/login', { email: fixture.email, password: fixture.password }],
  ['POST', '/api/auth/login/after-setup', { email: fixture.email, password: fixture.password, only_if_signed_out: true }],
  ['POST', '/api/supervisor/worker-invitations', { name: fixture.name, email: fixture.email, worker_class: 'normal', department_id: 2 }],
  ['POST', '/api/supervisor/worker-invitations', { name: fixture.name, email: fixture.email }],
  ['POST', '/api/auth/worker-invitations/inspect', { token: fixture.token }],
  ['POST', '/api/auth/worker-invitations/accept', { token: fixture.token, password: fixture.password }]
]) assert.doesNotThrow(() => check(method, path, body));
for (const [method, path, body] of [
  ['POST', '/api/auth/login', { email: 'real-worker@example.com', password: fixture.password }],
  ['POST', '/api/auth/login/after-setup', { email: fixture.email, password: fixture.password, only_if_signed_out: false }],
  ['POST', '/api/auth/login/after-setup', { email: fixture.email, password: fixture.password }],
  ['POST', '/api/supervisor/worker-invitations', { name: 'Someone Else', email: fixture.email }],
  ['POST', '/api/supervisor/worker-invitations', { name: fixture.name, email: fixture.email, department_id: 3 }],
  ['POST', '/api/supervisor/worker-invitations', { name: fixture.name, email: fixture.email, role: 'supervisor' }],
  ['POST', '/api/auth/worker-invitations/accept', { token: 'foreign-token', password: fixture.password }],
  ['POST', '/api/auth/worker-invitations/accept', { token: fixture.token, password: other.password }],
  ['POST', '/api/supervisor/users/51/status', { status: 'resigned', confirmed: true }],
  ['POST', '/api/supervisor/users/16/status', { status: 'resigned', confirmed: true }],
  ['POST', '/api/supervisor/users/51/invitation', {}], ['DELETE', '/api/supervisor/users/51', {}],
  ['POST', '/api/form-submissions', {}], ['POST', '/api/dev/seed', {}], ['POST', '/api/auth/refresh?extra=1', {}]
]) assert.throws(() => check(method, path, body));
fixture.attempted = true;
assert.throws(() => check('POST', '/api/supervisor/worker-invitations', { name: fixture.name, email: fixture.email }));
fixture.cleanupVerified = true;
assert.doesNotThrow(() => check('POST', '/api/supervisor/users/51/status', { status: 'resigned', confirmed: true }));
assert.throws(() => check('POST', '/api/supervisor/users/51/status', { status: 'active', confirmed: true }));
assert.throws(() => assertMutationAllowed({ url: 'https://foreign.invalid/api/auth/me', method: 'GET' }, scope));
console.log('ok - mutation allowlist rejects duplicates, foreign accounts/tokens, resets, Reports, Templates and unverified cleanup');

assert.equal(safeFailure(new Error('token=private-password-or-url')), 'browser_or_api_operation_failed');
assert.equal(safeFailure({ safeCode: 'invalid payload contains a token' }), 'browser_or_api_operation_failed');
assert.equal(safeFailure({ safeCode: 'owned_worker_resign_failed' }), 'owned_worker_resign_failed');
console.log('ok - diagnostics omit exception text, URLs, tokens, passwords and stacks');

for (const status of [301, 302, 303, 307, 308]) {
  let fulfilled = false;
  await assert.rejects(forwardWithoutRedirects({
    fetch: async (options) => {
      assert.deepEqual(options, { maxRedirects: 0, timeout: 45000 });
      return { status: () => status, url: () => `${origin}/api/auth/login` };
    }, fulfill: async () => { fulfilled = true; }
  }, origin), /network_redirect_refused/);
  assert.equal(fulfilled, false);
}
await assert.rejects(forwardWithoutRedirects({ fetch: async () => ({ status: () => 200,
  url: () => 'https://foreign.invalid/api/auth/login' }) }, origin), /response_left_approved_origin/);
const safeResponse = { status: () => 200, url: () => `${origin}/api/auth/login` };
await forwardWithoutRedirects({ fetch: async () => safeResponse,
  fulfill: async (options) => assert.equal(options.response, safeResponse) }, origin);
console.log('ok - redirects cannot forward credential bodies; only exact-origin responses are fulfilled');
