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
assert.equal(runner.shouldAssertNonblockingStartup('', 1), false);
assert.equal(runner.shouldAssertNonblockingStartup('', 50), false);
assert.equal(runner.shouldAssertNonblockingStartup('1', 50), true);
assert.throws(() => runner.shouldAssertNonblockingStartup('1', 1), /nonblocking_startup_requires_50_photos/);
for (const value of ['0', 'true', 'yes']) {
  assert.throws(() => runner.shouldAssertNonblockingStartup(value, 50), /nonblocking_startup_requires_explicit_1/);
}
const wrapperProbe = String.raw`
import importlib.util, json
from pathlib import Path
spec = importlib.util.spec_from_file_location('release_wrapper', 'scripts/run-hosted-report-release.py')
wrapper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wrapper)
accounts = {key: {'id': identifier, 'departmentId': 2,
    'role': 'supervisor' if key == 'supervisor' else 'worker',
    'email': key + '@example.invalid', 'password': 'synthetic-only-password'}
    for key, identifier in [('supervisor', 16), ('alex', 13), ('jamie', 14)]}
fixture = {'runId': wrapper.DEMO_RUN_ID, 'origin': wrapper.LIVE,
    'departmentId': 2, 'accounts': accounts}
args = (wrapper.LIVE, 'unit-only', 50, Path('unused-local-evidence'), fixture, fixture)
assert wrapper.child_environment(*args)['HOSTED_REPORT_ASSERT_NONBLOCKING_STARTUP'] == ''
assert wrapper.child_environment(*args, assert_nonblocking_startup=True)['HOSTED_REPORT_ASSERT_NONBLOCKING_STARTUP'] == '1'
try:
    wrapper.child_environment(wrapper.LIVE, 'unit-only', 1, Path('unused-local-evidence'),
        fixture, fixture, assert_nonblocking_startup=True)
    raise AssertionError('one-photo option accepted')
except RuntimeError as error:
    assert str(error) == 'nonblocking_startup_requires_50_photos'
print(json.dumps({'passed': True}))
`;
assert.deepEqual(JSON.parse(execFileSync('python', ['-c', wrapperProbe], {
  encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe']
})), { passed: true });
console.log('ok - nonblocking startup is explicit, requires50photos and survives wrapper environment sanitization');
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
const expectedPhotoNames = Array.from({ length: 50 }, (_, index) => `synthetic-ppe-unit-${String(index + 1).padStart(2, '0')}.png`);
const multipart = (filename) => Buffer.from(`--unit\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\nsynthetic-bytes\r\n--unit--\r\n`);
const observedUploads = [{ filename: 'signature-worker-form-field.png', path: '/uploads/signature.png' },
  ...expectedPhotoNames.map((filename, index) => ({ filename, path: `/uploads/photo-${index + 1}.png` }))];
const completedPhotoPaths = new Set();
for (const [index, upload] of observedUploads.entries()) {
  if (runner.isExpectedPhotoUpload(multipart(upload.filename), expectedPhotoNames)) completedPhotoPaths.add(upload.path);
  if (index === 24) {
    assert.equal(index + 1, 25, 'Old all-upload cutoff has reached 25 including the signature');
    assert.equal(completedPhotoPaths.size, 24);
    assert.equal(completedPhotoPaths.size >= 25, false, 'Signature must not consume a photo checkpoint slot');
  }
  if (index === 25) assert.equal(completedPhotoPaths.size, 25);
}
assert.equal(completedPhotoPaths.size, 50);
assert.equal(runner.isExpectedPhotoUpload(null, expectedPhotoNames), false);
assert.equal(runner.isExpectedPhotoUpload(multipart('unowned-photo.png'), expectedPhotoNames), false);
console.log('ok - signature-first uploads cannot trigger the 25-photo interruption after only 24 photos');
const resumeWaits = [];
await runner.reloadForQueuedReplay({
  reload: async (options) => { resumeWaits.push({ kind: 'reload', ...options }); },
  locator: (selector) => ({ waitFor: async (options) => {
    resumeWaits.push({ kind: selector, ...options });
    // The old default 45s surface wait expired during an allowed 60s cooldown.
    assert.ok(options.timeout > 60000);
  } })
});
assert.deepEqual(resumeWaits, [
  { kind: 'reload', waitUntil: 'domcontentloaded', timeout: 45000 },
  { kind: '#workerView', state: 'visible', timeout: 300000 }
]);
await assert.rejects(runner.reloadForQueuedReplay({ reload: async () => { throw new Error('private browser diagnostic'); } }),
  (error) => error.safeCode === 'partial_replay_document_reload_failed');
await assert.rejects(runner.reloadForQueuedReplay({ reload: async () => {},
  locator: () => ({ waitFor: async () => { throw new Error('private browser diagnostic'); } }) }),
  (error) => error.safeCode === 'partial_replay_worker_surface_timeout');
console.log('ok - replay reload has a bounded five-minute surface wait and distinct sanitized failure codes');
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
  for (const blocksUntilUpload of [false, true]) {
    const replay = await browser.newContext();
    const replayPage = await replay.newPage();
    let armed = false;
    let completedUploads = 0;
    let queuedChecks = 0;
    await replayPage.route('**/*', async (route) => {
      if (new URL(route.request().url()).pathname === '/api/photo-uploads') {
        completedUploads += 1;
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html>
        <section id="workerView" ${blocksUntilUpload && armed ? 'hidden' : ''}>
          <section id="queueSyncStatus" data-state="syncing"><p id="queueSyncMessage" role="status">Uploading26of51</p>
            <progress id="queueSyncProgress" value="26" max="51"></progress></section>
          <button class="tab" data-tab-target="historyTab" onclick="historyTab.hidden=false;formTab.hidden=true">My Reports</button>
          <button class="tab" data-tab-target="formTab" onclick="historyTab.hidden=true;formTab.hidden=false">New Report</button>
          <section id="historyTab" hidden>Owned queued Report</section><section id="formTab"><select id="workFormSelect"><option>Owned Template</option></select></section>
        </section>${armed ? `<script>
          const data = new FormData(); data.append('file', new Blob(['synthetic']), ${JSON.stringify(expectedPhotoNames[25])});
          fetch('/api/photo-uploads', {method:'POST', body:data}).then(() => {
            window.uploadDone = true; workerView.hidden = false;
          }).catch(() => { window.uploadAborted = true; });
        </script>` : ''}` });
    });
    try {
      await replayPage.goto('https://hosted-replay-test.invalid/');
      armed = true;
      const checkQueued = async () => { queuedChecks += 1; assert.equal(completedUploads, 0); };
      if (blocksUntilUpload) {
        await assert.rejects(runner.assertNonblockingQueuedReplay(replayPage, expectedPhotoNames.slice(25),
          checkQueued, { timeoutMs: 500 }), (error) => error.safeCode === 'nonblocking_worker_surface_timeout');
        await replayPage.waitForFunction(() => window.uploadAborted === true);
        assert.equal(completedUploads, 0, 'Failed verification must abort rather than forward the owned upload');
        assert.equal(queuedChecks, 0);
        await replayPage.evaluate(() => fetch('/api/photo-uploads', { method: 'POST', body: 'after-helper' }));
        assert.equal(completedUploads, 1, 'Failure must remove only its own temporary route');
      } else {
        const proof = await runner.assertNonblockingQueuedReplay(replayPage, expectedPhotoNames.slice(25), checkQueued);
        assert.equal(proof.uploadHeldDuringAssertions, true);
        assert.equal(proof.newReportOpened, true);
        assert.equal(proof.queuedOriginalsPreserved, true);
        assert.deepEqual(proof.visibleProgress, { value: 26, max: 51 });
        assert.ok(proof.workerVisibleWithinMs <= 15000);
        assert.equal(queuedChecks, 1);
        await replayPage.waitForFunction(() => window.uploadDone === true);
        assert.equal(completedUploads, 1, 'Success releases exactly one owned upload through the original route');
        assert.equal(await replayPage.locator('#formTab').isVisible(), true);
      }
    } finally { await replay.close(); }
  }
  await assert.rejects(runner.assertNonblockingQueuedReplay({}, expectedPhotoNames, async () => {}, { timeoutMs: 15001 }),
    /nonblocking_startup_timeout_out_of_bounds/);
  console.log('ok - held replay proves usable Worker/progress/New Report; timeout aborts and removes its client-only route');
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
  console.log('14 hosted runner checks passed; no network requests reached a server');
} finally {
  await browser.close();
}
