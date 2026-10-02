import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => null, removeItem: () => {} };
globalThis.window = { location: { protocol: 'http:' } };
globalThis.document = { cookie: 'geo_csrf_token=fixture' };

const requests = [];
let reply = { status: 'not_found', client_submission_id: 'report-key', worker_id: 2, department_id: 3, submission: null };
let status = 200;
globalThis.fetch = async (url, options) => {
  requests.push({ url: new URL(url, 'http://localhost'), options });
  return new Response(JSON.stringify(reply), { status });
};

const api = await import('../assets/js/api-client.js');
assert.equal(typeof api.getMyReportSubmissionByClientId, 'function');
assert.deepEqual(await api.getMyReportSubmissionByClientId('report-key'), reply);
assert.equal(requests[0].url.pathname, '/api/my-form-submissions/by-client-id');
assert.deepEqual(Object.fromEntries(requests[0].url.searchParams), {
  client_submission_id: 'report-key', purpose: 'report'
});
assert.equal(requests[0].options.cache, 'no-store');
assert.equal(requests[0].options.credentials, 'include');
assert.ok(!requests[0].options.method || requests[0].options.method === 'GET');
console.log('ok - recovery lookup is authenticated, Report-scoped, read-only and never cached');

for (const key of ['', ' padded', 'trailing ', 'x'.repeat(121), 'bad\nkey', null, 12]) {
  const count = requests.length;
  await assert.rejects(() => api.getMyReportSubmissionByClientId(key), /Client Submission ID/);
  assert.equal(requests.length, count);
}
const encodedKey = 'old/key?quote"&percent%';
await api.getMyReportSubmissionByClientId(encodedKey);
assert.equal(requests.at(-1).url.searchParams.get('client_submission_id'), encodedKey);
console.log('ok - exact stable keys are encoded without normalization and invalid keys never make a request');

for (const failedStatus of [401, 403, 404, 409, 503]) {
  status = failedStatus;
  reply = { detail: { code: 'cannot_confirm_submission', message: 'Cannot confirm submission' } };
  await assert.rejects(() => api.getMyReportSubmissionByClientId('report-key'), (error) => {
    assert.equal(error.status, failedStatus);
    assert.equal(error.code, 'cannot_confirm_submission');
    return true;
  });
}
globalThis.fetch = async () => { throw new TypeError('Network unavailable'); };
await assert.rejects(() => api.getMyReportSubmissionByClientId('report-key'));
console.log('ok - missing old-backend route, authorization, server and network failures are never converted to absence');

globalThis.fetch = async (_url, options) => {
  assert.equal(JSON.parse(options.body).client_submission_id, 'same-stable-key');
  return Response.json({ id: 7, worker_id: 2, idempotent_replay: true });
};
const replay = await api.createFormSubmission({ client_submission_id: 'same-stable-key' });
assert.equal(replay.idempotent_replay, true);
console.log('ok - recovered Report submission preserves stable key and transient replay metadata');

globalThis.fetch = async (url, options) => {
  requests.push({ url: new URL(url, 'http://localhost'), options });
  return Response.json({ id: 7, worker_id: 2, uploaded_by: 2, url: '/uploads/example.png' });
};
const scope = { workerId: 2, departmentId: 3 };
const photo = new Blob(['fixture'], { type: 'image/png' });
await api.createFormSubmission({ client_submission_id: 'scoped-report' }, scope);
await api.uploadPhoto(photo, 'photo.png', scope);
for (const { options } of requests.slice(-2)) {
  assert.equal(options.headers['X-Report-Recovery-Worker'], '2');
  assert.equal(options.headers['X-Report-Recovery-Department'], '3');
  assert.equal(options.headers['X-CSRF-Token'], 'fixture');
  assert.equal(options.credentials, 'include');
}
await api.createFormSubmission({ client_submission_id: 'ordinary-report' });
await api.uploadPhoto(photo, 'ordinary.png');
for (const { options } of requests.slice(-2)) {
  assert.equal(options.headers['X-Report-Recovery-Worker'], undefined);
  assert.equal(options.headers['X-Report-Recovery-Department'], undefined);
}
console.log('ok - recovered photos/signatures and Report POST bind Worker/Department headers without changing ordinary calls');

for (const invalid of [{}, { workerId: 2 }, { workerId: 0, departmentId: 3 },
  { workerId: ' 2', departmentId: 3 }, { workerId: 2, departmentId: '03' }]) {
  const count = requests.length;
  await assert.rejects(() => api.createFormSubmission({}, invalid), /recovery.*scope/i);
  await assert.rejects(() => api.uploadPhoto(photo, 'bad-scope.png', invalid), /recovery.*scope/i);
  assert.equal(requests.length, count);
}
globalThis.fetch = async () => Response.json({ detail: {
  code: 'report_recovery_identity_mismatch',
  message: 'The authenticated Worker or Department no longer matches this recovered Report.'
} }, { status: 409 });
for (const request of [() => api.createFormSubmission({}, scope), () => api.uploadPhoto(photo, 'photo.png', scope)]) {
  await assert.rejects(request, (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'report_recovery_identity_mismatch');
    assert.match(error.message, /authenticated Worker/);
    return true;
  });
}
console.log('ok - invalid recovery scope never sends evidence and identity-mismatch errors retain their structured code');
