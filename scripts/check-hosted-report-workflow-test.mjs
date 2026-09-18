import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { browserApiRequest, resolutionNoteLocator } from './check-hosted-report-workflow.mjs';
import * as runner from './check-hosted-report-workflow.mjs';

// This test never starts the hosted runner or accesses a real origin/account.
const historySource = readFileSync(new URL('../assets/js/history.js', import.meta.url), 'utf8');
const paragraph = historySource.match(/finalSupervisorNote \? `(<p class="report-supervisor-note">[^`]+<\/p>)`/);
assert.ok(paragraph, 'Production resolution-note markup must be located rather than duplicated');
const note = 'TEST ONLY resolution-note selector regression';
const markup = paragraph[1].replace('${escapeHtml(finalSupervisorNote)}', note);
assert.equal(runner.hostedPhotoCount(''), 1);
assert.equal(runner.hostedPhotoCount('1'), 1);
assert.equal(runner.hostedPhotoCount('50'), 50);
for (const value of ['0', '51', '2', '1.5', '50oops']) {
  assert.throws(() => runner.hostedPhotoCount(value), /hosted_photo_count_must_be_1_or_50/);
}
console.log('ok - hosted photo count defaults to one and only allows the explicit 50-photo stress option');
assert.equal(runner.allowExistingReportHistory(''), false);
assert.equal(runner.allowExistingReportHistory('1'), true);
assert.throws(() => runner.allowExistingReportHistory('yes'), /existing_history_requires_explicit_1/);
const baselineReports = [{ id: 5, worker_id: 13, submission_purpose: 'report', answers: { a: 'original' }, workflow_status: 'resolved' }];
const baseline = runner.reportHistorySnapshot(baselineReports, 13);
assert.equal(baseline[0].id, 5);
assert.match(baseline[0].sha256, /^[a-f0-9]{64}$/);
assert.notDeepEqual(runner.reportHistorySnapshot([{ ...baselineReports[0], workflow_status: 'submitted' }], 13), baseline);
assert.notDeepEqual(runner.reportHistorySnapshot([{ ...baselineReports[0], answers: { a: 'changed' } }], 13), baseline);
assert.throws(() => runner.reportHistorySnapshot(baselineReports, 14), /worker_history_scope_or_identity_mismatch/);
assert.throws(() => runner.reportHistorySnapshot([...baselineReports, ...baselineReports], 13), /worker_history_scope_or_identity_mismatch/);
console.log('ok - retained Report baselines are opt-in, owner-scoped and hash both workflow and evidence');
for (const photoCount of [1, 50]) {
  const fixtureCode = String.raw`
import base64, io, json, sys
sys.path.insert(0, 'backend')
from PIL import Image
from app.use_cases.report_pdf import build_report_pdf
from report_pdf_layout_test import report_fixture
count = int(sys.stdin.read())
images = {}
names = [f'synthetic-ppe-unit-{index:02d}.png' for index in range(1, count + 1)]
for index, name in enumerate(names):
    picture = Image.new('RGB', (32, 32), (40 + index * 3, 179, 8))
    output = io.BytesIO()
    picture.save(output, format='PNG')
    images['/uploads/' + name] = output.getvalue()
signature = io.BytesIO()
signature_size = [960, 360] if count == 50 else [80, 40]
Image.new('RGBA', tuple(signature_size), (20, 30, 40, 160)).save(signature, format='PNG')
images['/uploads/signature.png'] = signature.getvalue()
expected = {'reportId': 9001, 'marker': 'Unit fixture marker', 'finalNote': 'Unit final note',
    'photoNames': names, 'signatureDimensions': signature_size}
item = report_fixture(id=9001, fields=[
    {'id': 'issue_detail', 'label': 'PPE issue', 'type': 'textarea'},
    {'id': 'report_signature', 'label': 'Worker signature', 'type': 'signature'}],
    answers={'issue_detail': expected['marker'], 'report_signature': '/uploads/signature.png'},
    photo_urls=['/uploads/' + name for name in names], photo_metadata=[{'name': name} for name in names],
    supervisor_note=expected['finalNote'])
pdf = build_report_pdf([item], image_loader=images.get)
print(json.dumps({'pdf': base64.b64encode(pdf).decode(), 'expected': expected}))
`;
  const fixture = JSON.parse(execFileSync('python', ['-c', fixtureCode], {
    input: String(photoCount), encoding: 'utf8', windowsHide: true, timeout: 30000,
    maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe']
  }));
  const bytes = Buffer.from(fixture.pdf, 'base64');
  const parsed = runner.assertOwnedReportPdf(bytes, fixture.expected);
  assert.equal(parsed.photoPaints, photoCount);
  assert.equal(parsed.distinctPhotoRasters, photoCount);
  assert.equal(parsed.signaturePaints, 1);
  assert.deepEqual(parsed.signatureRasterDimensions, photoCount === 50 ? [696, 261] : [80, 40]);
  assert.equal(parsed.a4Pages, parsed.pages);
  assert.deepEqual(parsed.reportIds, [9001]);
  assert.throws(() => runner.assertOwnedReportPdf(bytes, { ...fixture.expected, reportId: 9002 }), /owned_report_pdf_validation_failed/);
  assert.throws(() => runner.assertOwnedReportPdf(bytes, { ...fixture.expected, photoNames: ['missing-caption.png'] }), /owned_report_pdf_validation_failed/);
  assert.throws(() => runner.assertOwnedReportPdf(bytes, { ...fixture.expected, signatureDimensions: [81, 40] }), /owned_report_pdf_validation_failed/);
  console.log(`ok - owned ${photoCount}-photo PDF validates A4, ${parsed.pages} numbered pages, exact Report, captions and signature`);
}
const browser = await chromium.launch({ headless: true });
let requestCount = 0;
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  // Set an intercepted, non-routable document so normal cookie access is available.
  await context.route('**/*', (route) => {
    requestCount += 1;
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><body></body>' });
  });
  const page = await context.newPage();
  await page.goto('https://hosted-runner-test.invalid/');
  await page.setContent(`<section id="reviewQueueDetail">${markup}</section>`);
  const detail = page.locator('#reviewQueueDetail');
  assert.equal(await detail.getByText(note, { exact: true }).count(), 0,
    'Old exact-note selector must reproduce its mismatch against actual production markup');
  const scopedNote = resolutionNoteLocator(detail, note);
  assert.equal(await scopedNote.count(), 1);
  assert.equal(await scopedNote.innerText(), `Final supervisor note: ${note}`);
  assert.equal(await resolutionNoteLocator(detail, 'unrelated note').count(), 0);
  console.log('ok - resolved-note locator matches actual labelled markup and rejects unrelated notes');

  await page.setContent(`<details id="reportReviewFilters"><summary>Filters</summary><input></details>
    <button id="reviewQueueBackButton" hidden>Back to Reports</button>
    <article id="compact"><h3>Nonce Template</h3><div class="record-actions"><button class="record-disclosure-button" aria-expanded="false">Show details</button></div><div hidden class="record-report-details">Private full answer</div></article>`);
  await page.evaluate(() => {
    const back = document.querySelector('#reviewQueueBackButton');
    back.addEventListener('click', () => { back.hidden = true; });
    const disclosure = document.querySelector('.record-disclosure-button');
    disclosure.addEventListener('click', () => {
      disclosure.setAttribute('aria-expanded', 'true');
      document.querySelector('.record-report-details').hidden = false;
    });
  });
  await runner.expandWorkerReport(page.locator('#compact'));
  await runner.expandWorkerReport(page.locator('#compact'));
  assert.equal(await page.locator('.record-disclosure-button').getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('.record-report-details').isVisible(), true);
  await page.locator('#reviewQueueBackButton').evaluate((button) => { button.hidden = false; });
  await runner.showSupervisorFilters(page);
  assert.equal(await page.locator('#reportReviewFilters').evaluate((element) => element.open), true);
  assert.equal(await page.locator('#reviewQueueBackButton').isVisible(), false);
  console.log('ok - compact-card expansion and mobile Back/filter navigation are explicit and idempotent');

  await page.evaluate(async () => {
    const db = await new Promise((done, fail) => {
      const request = indexedDB.open('scaffold-pwa-local', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('records', { keyPath: 'id' });
      request.onsuccess = () => done(request.result);
      request.onerror = () => fail(request.error);
    });
    await new Promise((done, fail) => {
      const transaction = db.transaction('records', 'readwrite');
      transaction.objectStore('records').put({ id: 'blob', photoBlobs: [new Blob(['original bytes'], { type: 'image/png' })], photoUrls: ['/uploads/one.png'] });
      transaction.objectStore('records').put({ id: 'legacy', photoDataUrls: ['data:image/png;base64,b3JpZ2luYWwgYnl0ZXM='] });
      transaction.oncomplete = done;
      transaction.onerror = () => fail(transaction.error);
    });
    db.close();
  });
  const records = await page.evaluate(runner.readLocalRecordEvidence);
  const blobRecord = records.find((record) => record.id === 'blob');
  const legacyRecord = records.find((record) => record.id === 'legacy');
  assert.equal(blobRecord.photoEvidence.storage, 'blob');
  assert.equal(legacyRecord.photoEvidence.storage, 'data-url');
  assert.deepEqual(blobRecord.photoEvidence.sha256, legacyRecord.photoEvidence.sha256);
  assert.equal(blobRecord.photoEvidence.sha256.length, 1);
  assert.match(blobRecord.photoEvidence.sha256[0], /^[a-f0-9]{64}$/);
  assert.deepEqual(blobRecord.photoUrls, ['/uploads/one.png']);
  assert.equal('photoBlobs' in blobRecord, false);
  assert.equal('photoDataUrls' in legacyRecord, false);
  console.log('ok - IndexedDB Blob and legacy evidence hashes match without serializing original photos');

  assert.equal(await page.evaluate(async () => (await indexedDB.databases())
    .some((database) => database.name === 'scaffold-pwa-report-evidence-v1')), false,
  'Read-only fallback must not create the absent isolated database');
  await page.evaluate(async () => {
    const db = await new Promise((done, fail) => {
      const request = indexedDB.open('scaffold-pwa-report-evidence-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('records', { keyPath: 'id' });
      request.onsuccess = () => done(request.result);
      request.onerror = () => fail(request.error);
    });
    await new Promise((done, fail) => {
      const transaction = db.transaction('records', 'readwrite');
      const store = transaction.objectStore('records');
      store.put({ id: 'blob', reportStorageVersion: 1, value: { id: 'blob', photoBlobs: [new Blob(['isolated original'])] } });
      store.put({ id: 'legacy', reportStorageVersion: 1, deleted: true });
      store.put({ id: 'new', reportStorageVersion: 1, value: { id: 'new', photoBlobs: [new Blob(['new original'])] } });
      transaction.oncomplete = done;
      transaction.onerror = () => fail(transaction.error);
    });
    db.close();
  });
  const isolatedRecords = await page.evaluate(runner.readLocalRecordEvidence);
  assert.equal(isolatedRecords.length, 2);
  assert.equal(isolatedRecords.some((record) => record.id === 'legacy'), false);
  assert.notDeepEqual(isolatedRecords.find((record) => record.id === 'blob').photoEvidence.sha256, blobRecord.photoEvidence.sha256);
  assert.equal(isolatedRecords.find((record) => record.id === 'new').photoEvidence.storage, 'blob');
  console.log('ok - isolated Report evidence overrides legacy copies and respects deletion tombstones');

  await page.evaluate(() => {
    window.fetch = (_path, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  });
  const startedAt = Date.now();
  await assert.rejects(page.evaluate(browserApiRequest, { path: '/api/test-only', timeoutMs: 20 }),
    /TimeoutError|timed out/i);
  assert.ok(Date.now() - startedAt < 2000, 'Stalled browser fetch must be aborted promptly');
  console.log('ok - stalled API fetch is aborted, not left beyond the polling deadline');

  await page.evaluate(() => {
    document.cookie = 'geo_csrf_token=test-only-csrf; Secure; SameSite=Strict; Path=/';
    window.fetch = async (path, options) => ({
      status: 200, ok: true,
      json: async () => ({ path, method: options.method, credentials: options.credentials,
        csrf: options.headers['X-CSRF-Token'], payload: JSON.parse(options.body), hasSignal: !!options.signal })
    });
  });
  const result = await page.evaluate(browserApiRequest, {
    path: '/api/test-only', method: 'POST', body: { fixture: 'synthetic' }
  });
  assert.deepEqual(result, { status: 200, ok: true, body: {
    path: '/api/test-only', method: 'POST', credentials: 'include', csrf: 'test-only-csrf',
    payload: { fixture: 'synthetic' }, hasSignal: true
  } });
  assert.equal(requestCount, 1, 'Only the locally fulfilled fake document request is allowed');
  console.log('ok - bounded API wrapper preserves same-origin session, CSRF, and JSON payload');
  console.log('10 hosted runner checks passed; no network requests reached a server');
} finally {
  await browser.close();
}
