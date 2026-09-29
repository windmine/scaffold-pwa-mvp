// Import/config/allowlist checks only; never decrypt credentials or use network.
import assert from 'node:assert/strict';
import { approvedCandidate, assertReadOnlyRequest, newOwnedPath, readConfiguration } from './check-release-old-client.mjs';

const candidate = 'https://recovery-20260929---geo-backend-eitdijn7cq-ts.a.run.app';
assert.equal(approvedCandidate(candidate), candidate);
const stage = 'https://geo-report-stage-ux20260929-eitdijn7cq-ts.a.run.app';
for (const origin of [
  'https://geo-backend-eitdijn7cq-ts.a.run.app', stage,
  'https://recovery-20260929---geo-backend-other-ts.a.run.app',
  'https://example.com', `${candidate}/`, `${candidate}?secret=not-allowed`, `${candidate}#token`,
  candidate.replace('https://', 'https://user:secret@'), candidate.replace('https://', 'http://'),
  candidate.replace('.app', '.app:443')
]) assert.throws(() => approvedCandidate(origin));
console.log('ok - only explicit project-tagged backend is accepted; untagged live/staging/foreign hosts/URL credentials rejected');

const args = ['--candidate-origin', candidate, '--expected-live-cache', 'leader-field-0643513b54a8',
  '--evidence', 'docs/evidence/guard-not-created/old-client.json', '--output-dir', 'output/guard-not-created/old-client'];
const config = readConfiguration(args);
assert.equal(config.expectedLiveCache, 'leader-field-0643513b54a8');
assert.equal(config.candidate, candidate);
for (const bad of [[], args.slice(0, -2), [...args, '--extra', 'no'], args.map((item) => item === '--output-dir' ? '--evidence' : item),
  args.map((item) => item === 'leader-field-0643513b54a8' ? 'latest' : item)]) assert.throws(() => readConfiguration(bad));
for (const path of ['../outside.json', 'docs/evidence', 'AGENTS.md', 'output/not-evidence.json']) {
  assert.throws(() => newOwnedPath(path, 'docs/evidence', { file: true }));
}
assert.throws(() => newOwnedPath('output', 'output'));
assert.throws(() => newOwnedPath('docs/evidence/new-proof.txt', 'docs/evidence', { file: true }));
console.log('ok - all four release arguments required; expected cache explicit; evidence/output must be new confined paths');

const live = 'https://geo-attendance-system-db9ca.web.app';
const account = { email: 'demo-20260916-supervisor@example.invalid', password: 'synthetic-password' };
const check = (path, method, body = {}) => assertReadOnlyRequest({ url: new URL(path, live).href, method, body }, account);
for (const path of ['/api/health/ready', '/api/supervisor/form-submissions?purpose=report', '/uploads/fixture.png', '/sw.js']) check(path, 'GET');
check('/api/auth/login', 'POST', account);
check('/api/auth/refresh', 'POST');
check('/api/auth/logout', 'POST');
for (const path of ['/api/supervisor/users/13/password-recovery', '/api/photo-uploads', '/api/form-submissions', '/api/supervisor/work-forms']) {
  assert.throws(() => check(path, 'POST'));
}
assert.throws(() => check('/api/auth/login', 'POST', { ...account, email: 'other@example.invalid' }));
assert.throws(() => check('/api/auth/login', 'POST', { ...account, password: 'different' }));
assert.throws(() => check('/api/auth/refresh', 'POST', { token: 'forbidden' }));
assert.throws(() => check('/api/auth/logout?token=forbidden', 'POST'));
assert.throws(() => check('https://example.com/index.html', 'GET'));
assert.throws(() => check('/api/auth/login', 'PATCH', account));
console.log('ok - read-only route guard permits only exact Supervisor login and cookie refresh/logout writes');
console.log('PASS - reusable old-client release guard checks');
