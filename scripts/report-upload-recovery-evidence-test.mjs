import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59963'; // Fully intercepted browser; no API, backend or external requests.
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const requests = [];
const responses = new Map();
await context.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, origin, 'Recovery evidence must not contact another origin');
  if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Recovery evidence tests</title>' });
  if (url.pathname.startsWith('/uploads/')) {
    requests.push(url.pathname);
    if (responses.has(url.pathname)) return route.fulfill(responses.get(url.pathname));
    return route.fulfill({ status: url.pathname.includes('missing') ? 404 : url.pathname.includes('denied') ? 403 : 500,
      contentType: 'application/json', body: '{}' });
  }
  assert.match(url.pathname, /^\/assets\/js\/[a-z\d-]+\.js$/);
  return route.fulfill({ contentType: 'text/javascript', body: await readFile(path.join(root, url.pathname), 'utf8') });
});
const page = await context.newPage();

try {
  await page.goto(origin);
  await page.evaluate(async () => {
    const { prepareReportRecoveryDraft, validateReportRecoveryLookup } = await import('/assets/js/report-upload-recovery.js');
    const worker = { id: 12, role: 'worker', departmentId: 3 };
    const original = { id: 'failed-evidence', clientSubmissionId: 'original-client-key', type: 'form', submissionPurpose: 'report',
      ownerWorkerId: 12, userId: 12, departmentId: 3, formId: 51, formName: 'Inspection', definitionVersion: 1,
      fields: [{ id: 'notes', type: 'textarea', label: 'Notes' }], answers: { notes: 'Retain this answer' },
      workDate: '2026-10-01', syncStatus: 'queued', syncError: 'Upload failed', photoMetadata: [] };
    const counts = { active: 0, peak: 0, decoded: 0, closed: 0 };
    const nativeBitmap = window.createImageBitmap.bind(window);
    window.createImageBitmap = async (...args) => {
      counts.active += 1;
      counts.peak = Math.max(counts.peak, counts.active);
      counts.decoded += 1;
      try {
        const bitmap = await nativeBitmap(...args);
        const close = bitmap.close.bind(bitmap);
        bitmap.close = () => { counts.closed += 1; counts.active -= 1; close(); };
        return bitmap;
      } catch (error) { counts.active -= 1; throw error; }
    };
    window.evidenceFixture = {
      counts, original, worker, nativeBitmap, validateReportRecoveryLookup,
      prepare(overrides = {}, options) { return prepareReportRecoveryDraft({ ...original, ...overrides }, worker, options); },
      async raster(type = 'image/png', color = '#1f6088') {
        const canvas = document.createElement('canvas');
        canvas.width = 2; canvas.height = 2;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 2, 2);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, type));
        canvas.width = canvas.height = 0;
        return blob;
      },
      async hash(blob) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].join(','); },
      dataUrl(blob) { return new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); }); },
      fromBase64(base64, type) { return new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type }); }
    };
  });

  const disguised = await page.evaluate(async () => {
    const f = window.evidenceFixture;
    const gif = f.fromBase64('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'image/png');
    const native = await f.nativeBitmap(gif); native.close();
    const result = await f.prepare({ photoBlobs: [gif] });
    return { count: result.value.photoBlobs.length, omitted: result.value.uploadRecovery.omittedPhotos };
  });
  assert.equal(disguised.count, 0, 'Decodable GIF bytes disguised as PNG must not be recovered as a valid photo');
  assert.equal(disguised.omitted.length, 1);
  console.log('ok - actual file format is checked instead of trusting a decodable image MIME label');

  const supported = await page.evaluate(async () => {
    const f = window.evidenceFixture;
    const photos = [await f.raster('image/jpeg'), await f.raster('image/png'), await f.raster('image/webp')];
    const hashes = await Promise.all(photos.map((photo) => f.hash(photo)));
    const result = await f.prepare({ photoBlobs: photos, photoMetadata: photos.map((photo, index) => ({ name: `original-${index}`, type: photo.type })) });
    return { hashes, recoveredHashes: await Promise.all(result.value.photoBlobs.map((photo) => f.hash(photo))),
      names: result.value.photoMetadata.map((item) => item.name), omitted: result.value.uploadRecovery.omittedPhotos,
      counts: { ...f.counts } };
  });
  assert.deepEqual(supported.recoveredHashes, supported.hashes);
  assert.deepEqual(supported.names, ['original-0', 'original-1', 'original-2']);
  assert.deepEqual(supported.omitted, []);
  assert.equal(supported.counts.peak, 1);
  assert.equal(supported.counts.active, 0);
  assert.equal(supported.counts.decoded, supported.counts.closed);
  console.log('ok - JPEG, PNG and WebP originals remain byte-identical and decode serially with released bitmaps');

  const animated = await page.evaluate(async () => {
    const f = window.evidenceFixture;
    const text = (value) => new TextEncoder().encode(value);
    const concat = (...items) => {
      const joined = new Uint8Array(items.reduce((size, item) => size + item.length, 0));
      let offset = 0;
      for (const item of items) { joined.set(item, offset); offset += item.length; }
      return joined;
    };
    const uint = (value, size = 4, little = false) => {
      const bytes = new Uint8Array(size);
      for (let index = 0; index < size; index += 1) bytes[little ? index : size - index - 1] = (value >>> (8 * index)) & 255;
      return bytes;
    };
    const crc = (bytes) => {
      let value = 0xffffffff;
      for (const byte of bytes) {
        value ^= byte;
        for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
      }
      return (value ^ 0xffffffff) >>> 0;
    };
    const pngChunk = (name, data) => concat(uint(data.length), text(name), data, uint(crc(concat(text(name), data))));
    const png = new Uint8Array(await (await f.raster('image/png')).arrayBuffer());
    const pngChunks = [];
    for (let offset = 8; offset + 12 <= png.length;) {
      const size = new DataView(png.buffer).getUint32(offset);
      pngChunks.push({ name: new TextDecoder().decode(png.slice(offset + 4, offset + 8)), data: png.slice(offset + 8, offset + 8 + size) });
      offset += size + 12;
    }
    const ihdr = pngChunks.find((item) => item.name === 'IHDR').data;
    const idat = concat(...pngChunks.filter((item) => item.name === 'IDAT').map((item) => item.data));
    const frameControl = (sequence) => concat(uint(sequence), uint(2), uint(2), uint(0), uint(0), uint(1, 2), uint(10, 2), new Uint8Array([0, 0]));
    const apng = new Blob([concat(png.slice(0, 8), pngChunk('IHDR', ihdr), pngChunk('acTL', concat(uint(2), uint(0))),
      pngChunk('fcTL', frameControl(0)), pngChunk('IDAT', idat), pngChunk('fcTL', frameControl(1)),
      pngChunk('fdAT', concat(uint(2), idat)), pngChunk('IEND', new Uint8Array()))], { type: 'image/png' });
    const webp = new Uint8Array(await (await f.raster('image/webp')).arrayBuffer());
    const webpChildren = [];
    for (let offset = 12; offset + 8 <= webp.length;) {
      const size = new DataView(webp.buffer).getUint32(offset + 4, true);
      const name = new TextDecoder().decode(webp.slice(offset, offset + 4));
      if (['ALPH', 'VP8 ', 'VP8L'].includes(name)) webpChildren.push(webp.slice(offset, offset + 8 + size + size % 2));
      offset += 8 + size + size % 2;
    }
    const webpChunk = (name, data) => concat(text(name), uint(data.length, 4, true), data, new Uint8Array(data.length % 2));
    const webpFrame = concat(uint(0, 3, true), uint(0, 3, true), uint(1, 3, true), uint(1, 3, true), uint(100, 3, true), uint(0, 1), ...webpChildren);
    const webpBody = concat(text('WEBP'), webpChunk('VP8X', concat(uint(2, 1), uint(0, 3), uint(1, 3, true), uint(1, 3, true))),
      webpChunk('ANIM', new Uint8Array(6)), webpChunk('ANMF', webpFrame), webpChunk('ANMF', webpFrame));
    const animatedWebp = new Blob([concat(text('RIFF'), uint(webpBody.length, 4, true), webpBody)], { type: 'image/webp' });
    for (const blob of [apng, animatedWebp]) { const bitmap = await f.nativeBitmap(blob); bitmap.close(); }
    f.animated = { apng, webp: animatedWebp };
    const result = await f.prepare({ photoBlobs: [apng, animatedWebp] });
    return { count: result.value.photoBlobs.length, omitted: result.value.uploadRecovery.omittedPhotos };
  });
  assert.equal(animated.count, 0, 'Animated PNG and WebP must not pass just because the browser can decode their first frame');
  assert.deepEqual(animated.omitted.map((item) => item.reason), ['Animated images are not supported.', 'Animated images are not supported.']);
  console.log('ok - real animated PNG and WebP are rejected before first-frame decoding can disguise them');

  const malformed = await page.evaluate(async () => {
    const f = window.evidenceFixture;
    const changes = [
      { capturedAnswers: [] }, { capturedAnswers: 'not answers' }, { capturedAnswers: null },
      { fields: [null] }, { fields: [{ id: {}, type: 'signature' }] }, { fields: [{ id: 'signature', type: null }] },
      { fields: [{ id: 'duplicate', type: 'text' }, { id: 'duplicate', type: 'signature' }] },
      { id: ' source-with-whitespace ' }, { id: 15 }, { clientSubmissionId: '' },
      { clientSubmissionId: ' original-client-key ' }, { clientSubmissionId: 99 }
    ];
    const outcomes = [];
    for (const change of changes) {
      try { await f.prepare(change); outcomes.push({ rejected: false }); }
      catch (error) { outcomes.push({ rejected: true, message: error.message }); }
    }
    return outcomes;
  });
  assert.ok(malformed.every((item) => item.rejected && item.message === 'This saved Report cannot be recovered safely. The original copy is unchanged.'),
    'Malformed selected answers, fields and identifiers must fail closed with an actionable message');
  console.log('ok - selected answer snapshots, field descriptors and source/client identifiers are validated before recovery');

  const invalidSignatures = await page.evaluate(async () => {
    const f = window.evidenceFixture;
    const values = ['data:image/png;base64,bm90YW5pbWFnZQ==',
      'data:image/png;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
      await f.dataUrl(f.animated.apng), await f.dataUrl(f.animated.webp), 14, { signature: 'not an image' }];
    const outcomes = [];
    for (const value of values) {
      try { await f.prepare({ fields: [{ id: 'signature', type: 'signature' }], capturedAnswers: { signature: value } }); outcomes.push(false); }
      catch (error) { outcomes.push(error.message === 'Could not restore a saved signature. The original copy is unchanged.'); }
    }
    return outcomes;
  });
  assert.ok(invalidSignatures.every(Boolean), 'Invalid local signatures must not be restored as signed or silently discarded');
  console.log('ok - local signature bytes and values are validated before the editor can consider them signed');

  const serverRejected = await page.evaluate(async () => {
    const f = window.evidenceFixture, blob = await f.raster();
    const result = await f.prepare({ photoBlobs: [blob, blob, blob],
      photoMetadata: ['first', 'rejected', 'third'].map((name) => ({ name })),
      failedPhotoUpload: { index: 1, status: 422, message: 'Server-only raster validation failed' } });
    return { count: result.value.photoBlobs.length, names: result.value.photoMetadata.map((item) => item.name),
      omitted: result.value.uploadRecovery.omittedPhotos };
  });
  assert.equal(serverRejected.count, 2, 'A confirmed server rejection cannot be negated by successful browser decoding');
  assert.deepEqual(serverRejected.names, ['first', 'third']);
  assert.deepEqual(serverRejected.omitted, [{ index: 1, name: 'rejected', reason: 'Photo was rejected by the server. Add a replacement.' }]);
  console.log('ok - confirmed server-rejected photo index is omitted without losing later valid photos');

  const invalidPhotos = await page.evaluate(async () => {
    const f = window.evidenceFixture, good = await f.raster();
    const photos = [good, new Blob(['broken'], { type: 'image/png' }), new Blob([], { type: 'image/png' }),
      new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: 'image/png' }),
      new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' }),
      new Blob([await good.arrayBuffer()], { type: 'image/gif' }), good];
    const result = await f.prepare({ photoBlobs: photos, photoMetadata: photos.map((_, index) => ({ name: `original-${index}`, taken_at: String(index) })) });
    return { count: result.value.photoBlobs.length, names: result.value.photoMetadata.map((item) => item.name),
      dates: result.value.photoMetadata.map((item) => item.taken_at), omitted: result.value.uploadRecovery.omittedPhotos,
      hash: await f.hash(good), hashes: await Promise.all(result.value.photoBlobs.map((blob) => f.hash(blob))) };
  });
  assert.equal(invalidPhotos.count, 2);
  assert.deepEqual(invalidPhotos.names, ['original-0', 'original-6']);
  assert.deepEqual(invalidPhotos.dates, ['0', '6']);
  assert.deepEqual(invalidPhotos.hashes, [invalidPhotos.hash, invalidPhotos.hash]);
  assert.deepEqual(invalidPhotos.omitted.map((item) => item.index), [1, 2, 3, 4, 5]);
  assert.equal(invalidPhotos.omitted[2].reason, 'File exceeds 5 MB.');
  console.log('ok - corrupt, empty, oversized, truncated and unsupported-MIME photos are individually omitted with ordered metadata');

  const validPng = await page.evaluate(async () => window.evidenceFixture.dataUrl(await window.evidenceFixture.raster()));
  responses.set('/uploads/valid.png', { contentType: 'image/png', body: Buffer.from(validPng.split(',')[1], 'base64') });
  responses.set('/uploads/corrupt.png', { contentType: 'image/png', body: 'not an image' });
  const signatureRecovery = await page.evaluate(async (dataUrl) => {
    const f = window.evidenceFixture;
    const fields = [{ id: 'notes', type: 'text' }, { id: 'signature', type: 'signature' },
      { id: 'rows', type: 'repeat' }, { id: 'witness', type: 'signature', repeat: 'rows' }];
    const capturedAnswers = { notes: '/uploads/ordinary-answer-is-not-a-request.png', signature: dataUrl,
      rows: [{ witness: dataUrl }, { witness: '/uploads/valid.png' }] };
    const originalAnswers = structuredClone(capturedAnswers);
    const result = await f.prepare({ fields, capturedAnswers });
    return { answers: result.value.answers, sourceUnchanged: JSON.stringify(capturedAnswers) === JSON.stringify(originalAnswers) };
  }, validPng);
  assert.equal(signatureRecovery.answers.signature, validPng);
  assert.equal(signatureRecovery.answers.rows[0].witness, validPng);
  assert.equal(signatureRecovery.answers.rows[1].witness, validPng);
  assert.equal(signatureRecovery.sourceUnchanged, true);
  assert.deepEqual(requests, ['/uploads/valid.png']);
  console.log('ok - original and repeated signatures survive, downloaded signatures restore locally, ordinary URL answers never fetch');

  const safeFailures = await page.evaluate(async () => {
    const f = window.evidenceFixture;
    const values = ['/uploads/corrupt.png', '/uploads/missing-signature.png', '/uploads/denied-signature.png',
      '/uploads/temporarily-unavailable.png', 'https://elsewhere.invalid/uploads/private.png', '/api/private',
      '/uploads/valid.png?token=private', '/uploads/valid.png#private'];
    const outcomes = [];
    for (const signature of values) {
      try { await f.prepare({ fields: [{ id: 'signature', type: 'signature' }], answers: { signature } }); outcomes.push({ rejected: false }); }
      catch (error) { outcomes.push({ rejected: true, message: error.message, status: error.status || null }); }
    }
    return outcomes;
  });
  assert.ok(safeFailures.every((item) => item.rejected));
  assert.equal(safeFailures[0].message, 'Could not restore a saved signature. The original copy is unchanged.');
  assert.equal(safeFailures[2].status, 403);
  assert.deepEqual(requests.slice(1), ['/uploads/corrupt.png', '/uploads/missing-signature.png', '/uploads/denied-signature.png', '/uploads/temporarily-unavailable.png']);
  console.log('ok - invalid or unavailable signatures fail closed; cross-origin, non-upload, query and fragment URLs never fetch');

  const fallback = await page.evaluate(async () => {
    const f = window.evidenceFixture, good = await f.raster();
    const rescued = await f.prepare({ photoBlobs: [good, good], photoUrls: [null, '/uploads/valid.png'],
      failedPhotoUpload: { index: 1, status: 415, message: 'Reject original' }, photoMetadata: [{ name: 'local' }, { name: 'uploaded', url: '/uploads/valid.png' }] });
    const missing = await f.prepare({ photoBlobs: [null, good], photoUrls: ['/uploads/missing-photo.png'] });
    const failures = [];
    for (const photoUrl of ['/uploads/denied-photo.png', '/uploads/unavailable-photo.png']) {
      try { await f.prepare({ photoUrls: [photoUrl] }); failures.push(false); }
      catch { failures.push(true); }
    }
    const transient = await f.prepare({ photoBlobs: [good], failedPhotoUpload: { index: 0, status: 429, message: 'Retry later' } });
    return { rescuedCount: rescued.value.photoBlobs.length, rescuedOmissions: rescued.value.uploadRecovery.omittedPhotos,
      recoveredHash: await f.hash(rescued.value.photoBlobs[1]), expectedHash: await f.hash(good),
      names: rescued.value.photoMetadata.map((item) => item.name), keepsUploadUrl: 'url' in rescued.value.photoMetadata[1],
      missingCount: missing.value.photoBlobs.length, missingOmissions: missing.value.uploadRecovery.omittedPhotos,
      failures, transientCount: transient.value.photoBlobs.length };
  });
  assert.equal(fallback.rescuedCount, 2);
  assert.deepEqual(fallback.rescuedOmissions, []);
  assert.equal(fallback.recoveredHash, fallback.expectedHash);
  assert.deepEqual(fallback.names, ['local', 'uploaded']);
  assert.equal(fallback.keepsUploadUrl, false);
  assert.equal(fallback.missingCount, 1);
  assert.deepEqual(fallback.missingOmissions.map((item) => item.reason), ['Photo is no longer available.']);
  assert.ok(fallback.failures.every(Boolean));
  assert.equal(fallback.transientCount, 1);
  console.log('ok - valid uploaded copies rescue rejected originals; only definite missing photos may be omitted on download failure');

  const lookupScope = await page.evaluate(() => {
    const f = window.evidenceFixture;
    const valid = { status: 'not_found', client_submission_id: f.original.clientSubmissionId, submission: null, worker_id: 12, department_id: 3 };
    const passed = f.validateReportRecoveryLookup(valid, f.original, f.worker).status;
    const failures = [
      { ...valid, worker_id: undefined }, { ...valid, department_id: undefined }, { ...valid, worker_id: 99 },
      { ...valid, department_id: 4 }, { ...valid, status: 'deleted', worker_id: 99 },
      { ...valid, status: 'submitted', submission: { id: 100, worker_id: 12, client_submission_id: f.original.clientSubmissionId,
        form_id: 51, submission_purpose: 'report' }, department_id: 4 }
    ].map((result) => {
      try { f.validateReportRecoveryLookup(result, f.original, f.worker); return false; }
      catch { return true; }
    });
    return { passed, failures };
  });
  assert.equal(lookupScope.passed, 'not_found');
  assert.ok(lookupScope.failures.every(Boolean));
  console.log('ok - every authoritative lookup outcome proves the active Worker and Department scope');
} finally {
  await context.close();
  await browser.close();
}
