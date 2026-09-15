import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { readConfiguration, assertMutationAllowed, assertOwnedExport, safeFailureDetails, ensureRequiredField } from './check-hosted-report-improvements.mjs';

const runId = 'owned-stage-test';
const args = ['--allow-hosted-mutations', '--run-id', runId];
const env = {
  HOSTED_REPORT_BASE_URL: 'https://owned-stage.example.invalid',
  HOSTED_REPORT_ALLOWED_HOST: 'owned-stage.example.invalid',
  ...Object.fromEntries(['SUPERVISOR', 'WORKER', 'SECOND_WORKER'].flatMap((role) => [
    [`HOSTED_REPORT_${role}_EMAIL`, `release-${runId}-${role.toLowerCase()}@example.invalid`],
    [`HOSTED_REPORT_${role}_PASSWORD`, 'owned-fixture-password-at-least-32-characters']
  ]))
};
assert.equal(readConfiguration(args, env).baseURL, env.HOSTED_REPORT_BASE_URL);
for (const [inputArgs, inputEnv] of [
  [[], env],
  [args, { ...env, HOSTED_REPORT_ALLOWED_HOST: 'another.example.invalid' }],
  [args, { ...env, HOSTED_REPORT_BASE_URL: 'http://owned-stage.example.invalid' }],
  [args, { ...env, HOSTED_REPORT_BASE_URL: 'https://owned-stage.example.invalid/path' }],
  [args, { ...env, HOSTED_REPORT_WORKER_EMAIL: 'real-worker@example.com' }],
  [args, { ...env, HOSTED_REPORT_WORKER_PASSWORD: 'short' }],
  [['--allow-hosted-mutations', '--run-id', 'another-run'], env]
]) assert.throws(() => readConfiguration(inputArgs, inputEnv));
console.log('ok - hosted improvements requires explicit exact origin and run-bound dedicated credentials before execution');

const scope = {
  baseURL: env.HOSTED_REPORT_BASE_URL, accounts: readConfiguration(args, env).accounts,
  templateNames: new Set(['TEST ONLY owned nonce']), templateId: 42, reportId: 43,
  invitedId: 44, invitedEmail: 'nonce-invited@example.invalid', invitedName: 'TEST ONLY invited nonce',
  departmentId: 9, marker: 'unique synthetic answer', questionId: 'issue', tokens: new Set(['private-capability'])
};
for (const [method, path, body] of [
  ['POST', '/api/supervisor/work-forms', { name: 'TEST ONLY owned nonce', template_purpose: 'report' }],
  ['POST', '/api/supervisor/work-forms', { name: 'TEST ONLY owned nonce', description: 'UI default purpose', fields: [] }],
  ['PATCH', '/api/supervisor/work-forms/42', { name: 'TEST ONLY owned nonce', description: null, fields: [], expected_definition_version: 1, confirmed: true }],
  ['PATCH', '/api/supervisor/work-forms/42', { status: 'archived', confirmed: true }],
  ['POST', '/api/form-submissions', { form_id: 42, answers: { issue: scope.marker } }],
  ['POST', '/api/supervisor/trash/form/43', { confirmed: true }],
  ['POST', '/api/supervisor/users/44/status', { status: 'resigned', confirmed: true }],
  ['POST', '/api/supervisor/worker-invitations', { name: scope.invitedName, email: scope.invitedEmail, worker_class: 'normal', department_id: 9 }],
  ['POST', '/api/supervisor/users/44/invitation', undefined],
  ['POST', '/api/auth/worker-invitations/accept', { token: 'private-capability', password: 'owned-password' }],
  ['POST', '/api/auth/worker-invitations/inspect', { token: 'private-capability' }]
]) assert.doesNotThrow(() => assertMutationAllowed({ url: scope.baseURL + path, method, body }, scope));
for (const [method, path, body] of [
  ['POST', '/api/supervisor/work-forms', { name: 'Real Template', template_purpose: 'report' }],
  ['POST', '/api/supervisor/work-forms', { name: 'TEST ONLY owned nonce', template_purpose: 'daywork' }],
  ['POST', '/api/supervisor/work-forms', { name: 'TEST ONLY owned nonce', template_purpose: null }],
  ['PATCH', '/api/supervisor/work-forms/41', { status: 'archived' }],
  ['POST', '/api/form-submissions', { form_id: 42, answers: { issue: 'not ours' } }],
  ['POST', '/api/supervisor/trash/form/41', { confirmed: true }],
  ['POST', '/api/supervisor/users/41/status', { status: 'resigned' }],
  ['POST', '/api/auth/worker-invitations/accept', { token: 'other-token' }],
  ['POST', '/api/dev/seed', {}]
]) assert.throws(() => assertMutationAllowed({ url: scope.baseURL + path, method, body }, scope));
assert.throws(() => assertMutationAllowed({ url: 'https://another.example.invalid/api/auth/refresh', method: 'POST' }, scope));
console.log('ok - mutation boundary refuses non-owned rows, unexpected endpoints and foreign invitation capabilities');

const expected = { reportId: 43, templateId: 42, workerId: 7, questionId: 'issue', marker: 'our unique answer' };
const header = 'id,form_id,worker_id,answer_issue\r\n';
const csv = Buffer.from(`${header}43,42,7,our unique answer\r\n`);
assert.doesNotThrow(() => assertOwnedExport(csv, 'csv', expected, false));
assert.doesNotThrow(() => assertOwnedExport(Buffer.from(header), 'csv', expected, true));
assert.throws(() => assertOwnedExport(Buffer.from(`${csv}99,42,8,other answer\r\n`), 'csv', expected, false));
assert.throws(() => assertOwnedExport(csv, 'csv', expected, true));
assert.throws(() => assertOwnedExport(Buffer.from(`${header}99,42,7,our unique answer\r\n`), 'csv', expected, false));
console.log('ok - Find export checks reject ignored filters, extra Reports and wrong owned identities');

const pdf = (text) => execFileSync('python', ['-c',
  'import io,sys; from reportlab.pdfgen import canvas; b=io.BytesIO(); c=canvas.Canvas(b); c.drawString(20,700,sys.stdin.read()); c.save(); sys.stdout.buffer.write(b.getvalue())'],
{ input: text, timeout: 30000, windowsHide: true });
assert.doesNotThrow(() => assertOwnedExport(pdf('1 Reports Report #43 our unique answer'), 'pdf', expected, false));
assert.doesNotThrow(() => assertOwnedExport(pdf('0 Reports No Reports found'), 'pdf', expected, true));
assert.throws(() => assertOwnedExport(pdf('2 Reports Report #43 our unique answer Report #99 other answer'), 'pdf', expected, false));
assert.throws(() => assertOwnedExport(pdf('1 Reports Report #43 our unique answer'), 'pdf', expected, true));
console.log('ok - parsed PDF checks reject additional Reports and ignored no-match filters');

const secretError = new Error('Private URL https://example.invalid/#token=private-capability and password=private-password');
secretError.stack = 'private stack with account details';
assert.deepEqual(safeFailureDetails(secretError, 'private_template_create', 'create_set_required'), {
  checkpoint: 'private_template_create', operation: 'create_set_required', code: 'browser_or_api_operation_failed'
});
assert.equal(JSON.stringify(safeFailureDetails(secretError, 'private_template_create', 'create_set_required')).includes('private-capability'), false);
console.log('ok - precise progress evidence excludes error messages, stacks, URLs and credentials');

const builderSource = readFileSync(new URL('../assets/js/work-form-builder.js', import.meta.url), 'utf8');
const requiredMarkup = builderSource.match(/<label class="checkbox-field form-checkbox-field work-form-required-toggle">[\s\S]*?<\/label>/)?.[0]
  .replace("${field.required ? ' checked' : ''}", '');
assert.ok(requiredMarkup, 'Use the production custom Required control markup');
const styles = readFileSync(new URL('../assets/css/styles.css', import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html',
    body: `<!doctype html><html><head><style>${styles}</style></head><body><div id="required-fixture">${requiredMarkup}</div></body></html>` }));
  const page = await context.newPage();
  await page.goto('https://required-control-test.invalid/');
  const card = page.locator('#required-fixture');
  const required = card.locator('[data-field-property="required"]');
  await assert.rejects(required.check({ timeout: 300 }), /Timeout/,
    'Old hidden-native-input action must reproduce the hosted timeout');
  await ensureRequiredField(card);
  assert.equal(await required.isChecked(), true);
  await ensureRequiredField(card);
  assert.equal(await required.isChecked(), true, 'Already-required fields must not be toggled off');
  console.log('ok - production custom Required label is actionable and remains checked on repeat');
} finally { await browser.close(); }
