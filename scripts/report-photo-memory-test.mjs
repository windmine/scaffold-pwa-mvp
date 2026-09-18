import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

// Real IndexedDB and immutable photo bytes; API transport is entirely mocked.
// Use PHOTO_EVIDENCE_MODE=legacy for a like-for-like base64 comparison.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'output/report-photo-memory.local');
const mode = process.env.PHOTO_EVIDENCE_MODE || 'blob';
assert.ok(['blob', 'legacy'].includes(mode));
const origin = 'http://127.0.0.1:59988';
const result = { startedAt: new Date().toISOString(), mode, syntheticOnly: true,
  transport: 'fully mocked; no server requests', phases: [], processMemory: [] };
const browser = await chromium.launch({ headless: true, args: ['--enable-precise-memory-info'] });
const context = await browser.newContext();
await context.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, origin, 'No external traffic permitted');
  if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Photo memory regression</title>' });
  assert.match(url.pathname, /^\/assets\/js\/[a-z\d-]+\.js$/);
  return route.fulfill({ contentType: 'text/javascript', body: await readFile(path.join(root, url.pathname), 'utf8') });
});
const page = await context.newPage();
const browserCdp = await browser.newBrowserCDPSession();
const runFile = promisify(execFile);
let memoryReadInFlight = false;
async function sampleProcessMemory(label) {
  if (memoryReadInFlight || process.platform !== 'win32') return;
  memoryReadInFlight = true;
  try {
    const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
    const ids = processInfo.map((item) => Number(item.id)).filter(Number.isInteger);
    const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-Command',
      `$sample = Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue; [pscustomobject]@{ workingSetBytes = ($sample | Measure-Object WorkingSet64 -Sum).Sum; privateBytes = ($sample | Measure-Object PrivateMemorySize64 -Sum).Sum; processes = @($sample).Count } | ConvertTo-Json -Compress`],
    { windowsHide: true, timeout: 10000 });
    result.processMemory.push({ label, elapsedMs: Date.now() - Date.parse(result.startedAt), ...JSON.parse(stdout) });
  } catch (error) { result.processMemoryWarning = error.name; }
  finally { memoryReadInFlight = false; }
}
const memoryTimer = setInterval(() => { void sampleProcessMemory('periodic'); }, 3000);

async function phase(name, work) {
  let timer;
  const started = performance.now();
  console.log(`starting - ${name}`);
  try {
    const details = await Promise.race([work(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${name}: exceeded 90 seconds`)), 90000);
    })]);
    result.phases.push({ name, elapsedMs: Math.round(performance.now() - started), ...details });
    await sampleProcessMemory(name);
    console.log(`ok - ${name}: ${result.phases.at(-1).elapsedMs} ms`);
  } finally { clearTimeout(timer); }
}

async function prepare() {
  await page.goto(origin);
  await page.evaluate(async (mode) => {
    const api = await import('/assets/js/api-client.js');
    const offline = await import('/assets/js/offline-submissions.js');
    const db = await import('/assets/js/db.js');
    const { dataUrlToBlob } = await import('/assets/js/utils.js');
    api.saveSession({ id: 77, name: 'Synthetic volume Worker', role: 'worker', department_id: 2 });
    let online = true;
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
    const expected = JSON.parse(sessionStorage.getItem('volumeExpected') || '[]');
    const counters = { uploads: 0, successes: 0, posts: 0, hashChecks: 0, heapPeakBytes: 0, base64Decodes: 0 };
    const config = { start: 0, failAt: 0 };
    const expect = (condition, message) => { if (!condition) throw new Error(message); };
    const sampleHeap = () => { counters.heapPeakBytes = Math.max(counters.heapPeakBytes, performance.memory?.usedJSHeapSize || 0); };
    const nativeAtob = window.atob.bind(window);
    window.atob = (...args) => { counters.base64Decodes += 1; return nativeAtob(...args); };
    const hash = async (blob) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const photos = (record) => mode === 'blob' ? record.photoBlobs : record.photoDataUrls;
    const asBlob = (source) => source instanceof Blob ? source : dataUrlToBlob(source);
    window.fetch = async (url, options) => {
      expect(url.startsWith('/api/'), 'No non-API requests in upload transport');
      if (url === '/api/photo-uploads') {
        counters.uploads += 1;
        const index = config.start + counters.successes;
        const file = options.body.get('file');
        expect(file instanceof Blob && file.size === expected[index].bytes, 'Upload contains the original real Blob');
        expect(await hash(file) === expected[index].sha256, `Original/order mismatch at photo ${index + 1}`);
        counters.hashChecks += 1;
        sampleHeap();
        if (counters.uploads === config.failAt) return new Response('{}', { status: 503 });
        counters.successes += 1;
        return Response.json({ url: `/uploads/volume-photo-${index + 1}.png` });
      }
      expect(url === '/api/form-submissions', 'Unexpected mutation');
      counters.posts += 1;
      const body = JSON.parse(options.body);
      expect(body.photo_urls.length === 50, 'Final Report includes all 50 photos');
      expect(body.photo_urls.every((url, index) => url === `/uploads/volume-photo-${index + 1}.png`), 'Final URLs preserve original order');
      expect(body.photo_metadata.every((item, index) => item.name === expected[index].name), 'Metadata preserves original order');
      return Response.json({ id: 707, worker_id: 77, photo_urls: body.photo_urls, photo_metadata: body.photo_metadata });
    };
    window.fixture = { api, offline, db, hash, expected, counters, config, expect, asBlob, photos, sampleHeap, mode,
      setOnline(value) { online = value; } };
  }, mode);
}

try {
  await prepare();
  await phase('generate fifty valid distinct PNGs and persist offline', () => page.evaluate(async () => {
    const f = window.fixture;
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 768;
    const ctx = canvas.getContext('2d');
    const sources = [];
    const expected = [];
    for (let index = 0; index < 50; index += 1) {
      const pixels = ctx.createImageData(canvas.width, canvas.height);
      let random = (index + 1) * 2654435761 >>> 0;
      for (let p = 0; p < pixels.data.length; p += 4) {
        random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
        pixels.data[p] = random & 255;
        pixels.data[p + 1] = (random >>> 8) & 255;
        pixels.data[p + 2] = (random >>> 16) & 255;
        pixels.data[p + 3] = 255;
      }
      ctx.putImageData(pixels, 0, 0);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const bitmap = await createImageBitmap(blob);
      f.expect(bitmap.width === 512 && bitmap.height === 768, 'Every original is a valid decodable PNG');
      bitmap.close();
      expected.push({ name: `synthetic-${index + 1}.png`, bytes: blob.size, sha256: await f.hash(blob) });
      sources.push(f.mode === 'blob' ? blob : await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob);
      }));
      f.sampleHeap();
    }
    const totalBytes = expected.reduce((total, image) => total + image.bytes, 0);
    f.expect(totalBytes === 67691622, 'Exact original 64.56 MiB baseline fixture must be unchanged');
    f.expect(new Set(expected.map((image) => image.sha256)).size === 50, 'Every original is distinct');
    sessionStorage.setItem('volumeExpected', JSON.stringify(expected));
    const record = { id: 'volume-fixture-50', type: 'form', submissionPurpose: 'report', formId: 21,
      formName: 'Synthetic volume report', workDate: '2026-09-16', fields: [], answers: {},
      [f.mode === 'blob' ? 'photoBlobs' : 'photoDataUrls']: sources,
      photoMetadata: expected.map((image) => ({ name: image.name, size: image.bytes, type: 'image/png' })) };
    let started = performance.now();
    await f.db.put('drafts', { key: 'volume-draft', value: record });
    const draftSaveMs = Math.round(performance.now() - started);
    f.setOnline(false);
    started = performance.now();
    const submitted = await f.offline.submitOfflineSubmission(record, { draftKey: 'volume-draft' });
    const offlineSaveMs = Math.round(performance.now() - started);
    f.expect(submitted.queued && f.counters.uploads === 0, 'Offline save performs no uploads');
    const stored = await f.db.get('records', record.id);
    f.expect(f.photos(stored).length === 50, 'IndexedDB preserves every original');
    if (f.mode === 'blob') f.expect(stored.photoDataUrls.length === 0, 'No base64 evidence copies are generated');
    f.sampleHeap();
    return { count: 50, totalBytes, draftSaveMs, offlineSaveMs, originalHashes: expected.map((image) => image.sha256),
      heapPeakBytes: f.counters.heapPeakBytes, indexedDbOriginals: true };
  }));

  await prepare();
  await phase('cold reload and 25-upload durable partial replay', () => page.evaluate(async () => {
    const f = window.fixture;
    f.config.failAt = 26;
    const synced = await f.offline.syncQueuedSubmissions({ purpose: 'report', onUploadProgress: f.sampleHeap });
    f.expect(synced.failed === 1 && f.counters.successes === 25 && f.counters.posts === 0, 'Stop safely after exactly 25 successful originals');
    const stored = await f.db.get('records', 'volume-fixture-50');
    f.expect(f.photos(stored).length === 50 && stored.photoUrls.length === 25, 'Keep 50 originals and 25 checkpoint URLs');
    f.expect(stored.photoUrls.every((url, index) => url === `/uploads/volume-photo-${index + 1}.png`), 'Partial checkpoint order is exact');
    return { ...f.counters, queued: true, durableUploaded: 25 };
  }));

  await prepare();
  await phase('second cold reload, hash all persisted originals, resume remaining 25', () => page.evaluate(async () => {
    const f = window.fixture;
    let stored = await f.db.get('records', 'volume-fixture-50');
    f.expect(stored.photoUrls.length === 25, 'Reload restores the completed checkpoint');
    for (const [index, source] of f.photos(stored).entries()) {
      f.expect(await f.hash(f.asBlob(source)) === f.expected[index].sha256, 'Reloaded original hash/order match');
    }
    stored = null;
    f.config.start = 25;
    const synced = await f.offline.syncQueuedSubmissions({ purpose: 'report', onUploadProgress: f.sampleHeap });
    f.expect(synced.flushed === 1 && f.counters.successes === 25 && f.counters.posts === 1, 'Replay only missing uploads and finalize once');
    f.expect((await f.db.getAll('queue')).length === 0, 'Completed replay leaves no queue item');
    const finished = await f.db.get('records', 'volume-fixture-50');
    f.expect(finished.photoUrls.length === 50 && f.photos(finished).length === 50 && finished.backendRecordId === 707, 'History keeps all originals and durable server ID');
    if (f.mode === 'blob') f.expect(f.counters.base64Decodes === 0, 'Blob replay never generates or decodes base64');
    return { ...f.counters, reloadedOriginalHashChecks: 50, finalReportCount: 1, finalPhotoCount: 50, queueEmpty: true };
  }));
  result.status = 'passed';
} catch (error) {
  result.status = 'failed';
  result.error = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  clearInterval(memoryTimer);
  await sampleProcessMemory('final');
  result.completedAt = new Date().toISOString();
  result.memoryLimits = 'Sampled Chromium process sums/JS heap, not exact peak. Desktop headless, 512x768 images, 64.56 MiB total; not physical phone, 50x5 MiB worst case, rendered gallery, network or GCS validation.';
  result.peakSampledWorkingSetBytes = Math.max(0, ...result.processMemory.map((sample) => sample.workingSetBytes || 0));
  result.peakSampledPrivateBytes = Math.max(0, ...result.processMemory.map((sample) => sample.privateBytes || 0));
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, `result-${mode}.json`), `${JSON.stringify(result, null, 2)}\n`);
  await context.close();
  await browser.close();
  console.log(JSON.stringify(result, null, 2));
}
