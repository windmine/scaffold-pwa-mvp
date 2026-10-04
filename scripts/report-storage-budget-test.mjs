import assert from 'node:assert/strict';
import {
  reportEvidenceBytes, assessReportPhotoStorage, estimateReportPhotoStorage, isStorageQuotaError
} from '../assets/js/report-storage-budget.js';

const MIB = 1024 * 1024;
const ample = { quota: 1000 * MIB, usage: 100 * MIB };
let groups = 0;
async function check(name, run) { await run(); groups += 1; console.log(`PASS ${name}`); }

await check('Blob originals and legacy data URLs are measured without reading bytes', () => {
  const first = new Blob(['abc']);
  const second = new Blob(['世界']);
  for (const blob of [first, second]) {
    for (const method of ['arrayBuffer', 'bytes', 'text', 'stream', 'slice']) {
      Object.defineProperty(blob, method, { value: () => { throw new Error('Must not read photo bytes'); } });
    }
  }
  const legacy = 'data:image/jpeg;base64,YWJj';
  assert.equal(reportEvidenceBytes([first, second, legacy]), 3 + 6 + legacy.length * 2);
  assert.equal(reportEvidenceBytes([first, first]), 6, 'Separate stored copies each cost space');
});

await check('Malformed legacy strings count storage; remote and temporary URLs do not', () => {
  for (const source of ['data:', 'data:not-a-valid-image', 'DATA:image/jpeg;base64,%%%', 'data:,hello%20world']) {
    assert.equal(reportEvidenceBytes([source]), source.length * 2);
  }
  for (const sources of [undefined, null, {}, 'data:image/png;base64,AAAA']) assert.equal(reportEvidenceBytes(sources), 0);
  assert.equal(reportEvidenceBytes([null, undefined, {}, { size: 50 * MIB }, -1,
    '', '/uploads/file.jpg', 'https://example.invalid/file.jpg', 'blob:https://example.invalid/abc']), 0);
});

await check('Small known batches return exact advisory copy and write headroom', () => {
  assert.deepEqual(assessReportPhotoStorage({ estimate: ample, incomingBytes: 2 * MIB, existingBytes: 3 * MIB }), {
    warning: null, incomingBytes: 2 * MIB, totalBytes: 5 * MIB,
    availableBytes: 900 * MIB, requiredBytes: 30 * MIB, estimateKnown: true
  });
});

await check('Large batch and total thresholds are inclusive and independent', () => {
  assert.equal(assessReportPhotoStorage({ estimate: ample, incomingBytes: 20 * MIB - 1 }).warning, null);
  assert.equal(assessReportPhotoStorage({ estimate: ample, incomingBytes: 20 * MIB }).warning, 'large');
  assert.equal(assessReportPhotoStorage({ estimate: ample, incomingBytes: 1, existingBytes: 50 * MIB - 2 }).warning, null);
  assert.equal(assessReportPhotoStorage({ estimate: ample, incomingBytes: 1, existingBytes: 50 * MIB - 1 }).warning, 'large');
});

await check('Low-space threshold, usage ratio and required headroom warn independently', () => {
  assert.equal(assessReportPhotoStorage({ estimate: { quota: 60 * MIB, usage: 10 * MIB } }).warning, null);
  assert.equal(assessReportPhotoStorage({ estimate: { quota: 60 * MIB, usage: 10 * MIB + 1 } }).warning, 'low');
  assert.equal(assessReportPhotoStorage({ estimate: { quota: 1000 * MIB, usage: 800 * MIB - 1 } }).warning, null);
  assert.equal(assessReportPhotoStorage({ estimate: { quota: 1000 * MIB, usage: 800 * MIB } }).warning, 'low');
  assert.equal(assessReportPhotoStorage({ estimate: { quota: 100 * MIB, usage: 20 * MIB },
    incomingBytes: 30 * MIB }).warning, 'large', 'Exact required headroom is not below the requirement');
  assert.equal(assessReportPhotoStorage({ estimate: { quota: 100 * MIB, usage: 20 * MIB + 1 },
    incomingBytes: 30 * MIB }).warning, 'low');
  const overQuota = assessReportPhotoStorage({ estimate: { quota: MIB, usage: 2 * MIB } });
  assert.equal(overQuota.availableBytes, 0);
  assert.equal(overQuota.warning, 'low');
});

await check('Absent and malformed estimates never claim known available storage', () => {
  const invalid = [undefined, null, {}, [], 20, { quota: 100 }, { usage: 0 },
    ...[0, -1, NaN, Infinity, -Infinity, '100', null].map((quota) => ({ quota, usage: 0 })),
    ...[-1, NaN, Infinity, -Infinity, '0', null].map((usage) => ({ quota: 100, usage }))];
  for (const estimate of invalid) {
    const small = assessReportPhotoStorage({ estimate, incomingBytes: 1 });
    assert.equal(small.warning, null);
    assert.equal(small.estimateKnown, false);
    assert.equal(small.availableBytes, null);
    assert.equal(assessReportPhotoStorage({ estimate, incomingBytes: 20 * MIB }).warning, 'unknown');
    assert.equal(assessReportPhotoStorage({ estimate, existingBytes: 50 * MIB }).warning, 'unknown');
  }
  for (const key of ['quota', 'usage']) {
    const estimate = Object.defineProperty({ quota: 100 * MIB, usage: 0 }, key,
      { get() { throw new Error('Unreadable estimate'); } });
    assert.equal(assessReportPhotoStorage({ estimate, incomingBytes: 20 * MIB }).warning, 'unknown');
  }
});

await check('Invalid byte values are not coerced and oversized arithmetic stays finite', () => {
  for (const bytes of [-1, NaN, Infinity, -Infinity, '100', null, {}, undefined]) {
    const result = assessReportPhotoStorage({ estimate: ample, incomingBytes: bytes, existingBytes: bytes });
    assert.equal(result.incomingBytes, 0);
    assert.equal(result.totalBytes, 0);
    assert.equal(result.requiredBytes, 20 * MIB);
  }
  const result = assessReportPhotoStorage({ incomingBytes: Number.MAX_VALUE, existingBytes: Number.MAX_VALUE });
  assert.equal(result.totalBytes, Number.MAX_SAFE_INTEGER);
  assert.equal(result.requiredBytes, Number.MAX_SAFE_INTEGER);
  assert.equal(result.warning, 'unknown');
});

await check('Estimator binds the browser method and never requests persistence or cleanup', async () => {
  let calls = 0;
  const storage = {
    estimate() { assert.equal(this, storage); calls += 1; return Promise.resolve(ample); },
    persist() { throw new Error('Must not request persistence'); },
    persisted() { throw new Error('Must not request persistence status'); },
    clear() { throw new Error('Must not clear storage'); }
  };
  const result = await estimateReportPhotoStorage([new Blob(['abc'])], [new Blob(['abcd'])], { storage });
  assert.equal(calls, 1);
  assert.equal(result.incomingBytes, 3);
  assert.equal(result.totalBytes, 7);
  assert.equal(result.estimateKnown, true);
});

await check('Unsupported, denied, throwing and rejected estimators degrade to unknown', async () => {
  const large = [new Blob([new Uint8Array(20 * MIB)])];
  const storages = [undefined, null, {}, { estimate: false },
    { estimate() { throw new Error('Denied'); } },
    { estimate() { return Promise.reject(new Error('Denied')); } },
    { estimate() { return { quota: '100', usage: 0 }; } },
    Object.defineProperty({}, 'estimate', { get() { throw new Error('Denied getter'); } })];
  for (const storage of storages) {
    const result = await estimateReportPhotoStorage(large, [], { storage });
    assert.equal(result.warning, 'unknown');
    assert.equal(result.estimateKnown, false);
  }
  const options = Object.defineProperty({}, 'storage', { get() { throw new Error('Denied storage getter'); } });
  assert.equal((await estimateReportPhotoStorage(large, [], options)).warning, 'unknown');
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, get() { throw new Error('Denied navigator'); } });
    assert.equal((await estimateReportPhotoStorage(large, [])).warning, 'unknown');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: undefined });
    assert.equal((await estimateReportPhotoStorage([], [])).warning, null);
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  }
});

await check('A hung estimate times out and late rejections are handled', async () => {
  let rejectEstimate;
  const storage = { estimate() { return new Promise((_resolve, reject) => { rejectEstimate = reject; }); } };
  const result = await estimateReportPhotoStorage([], [], { storage, timeoutMs: 5 });
  assert.equal(result.estimateKnown, false);
  rejectEstimate(new Error('Late denied estimate'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await estimateReportPhotoStorage([], [], { storage: { estimate: () => ample }, timeoutMs: 0 })).estimateKnown, true);
});

await check('Quota recognition uses exact names, cautious legacy codes and bounded causes', () => {
  const quota = new DOMException('Quota exceeded', 'QuotaExceededError');
  for (const error of [quota, { name: 'QuotaExceededError', code: 22 },
    { name: 'NS_ERROR_DOM_QUOTA_REACHED', code: 1014 }, { name: 'QUOTA_EXCEEDED_ERR', code: 22 },
    new Error('Save failed', { cause: quota }), { cause: { cause: { cause: { cause: quota } } } }]) {
    assert.equal(isStorageQuotaError(error), true);
  }
  for (const error of [null, undefined, 'QuotaExceededError', new Error('QuotaExceededError'),
    new DOMException('No storage access', 'SecurityError'), { code: 22 }, { code: 1014 },
    { name: 'Error', code: 22 }, { name: 'NS_ERROR_DOM_QUOTA_REACHED', code: 22 },
    { name: 'QUOTA_EXCEEDED_ERR', code: '22' }, { name: 'quotaexceedederror' },
    { cause: { cause: { cause: { cause: { cause: quota } } } } }]) {
    assert.equal(isStorageQuotaError(error), false);
  }
  const cyclic = {}; cyclic.cause = cyclic;
  assert.equal(isStorageQuotaError(cyclic), false);
  assert.equal(isStorageQuotaError(Object.defineProperty({}, 'cause', { get() { throw new Error('Denied cause'); } })), false);
});

console.log(`Report storage budget: ${groups} groups passed.`);
