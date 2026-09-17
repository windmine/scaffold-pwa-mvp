import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59989'; // Fully intercepted; never contacts an API.
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await context.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, origin, 'External requests are forbidden');
  if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated photo upload checks</title>' });
  assert.match(url.pathname, /^\/assets\/js\/[a-z\d-]+\.js$/);
  return route.fulfill({ contentType: 'text/javascript', body: await readFile(path.join(root, url.pathname), 'utf8') });
});
const page = await context.newPage();

async function prepare() {
  await page.goto(origin);
  await page.evaluate(async () => {
    const api = await import('/assets/js/api-client.js');
    const offline = await import('/assets/js/offline-submissions.js');
    const db = await import('/assets/js/db.js');
    const worker = { id: 7, role: 'worker', department_id: 2, name: 'Upload test Worker' };
    api.saveSession(worker);
    const dataUrl = 'data:image/png;base64,aW1hZ2U=';
    const checks = { attempts: 0, successful: 0, posts: [], decodes: 0, waits: [], progress: [] };
    let config = {};
    let activeId = '';
    let online = true;
    const expect = (condition, message) => { if (!condition) throw new Error(message); };
    const nativeAtob = window.atob.bind(window);
    window.atob = (...args) => { checks.decodes += 1; return nativeAtob(...args); };
    const nativeTimer = window.setTimeout.bind(window);
    window.setTimeout = (callback, milliseconds, ...args) => {
      checks.waits.push(milliseconds);
      if (config.switchOwner) api.saveSession({ ...worker, id: 8 });
      if (config.logout) localStorage.removeItem('geo_user');
      return nativeTimer(callback, 0, ...args); // Exercise requested delays without real waiting.
    };
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
    const savedEvidenceCount = (record) => (record?.photoUrls || []).length
      + Object.values(record?.answers || {}).flatMap((value) => Array.isArray(value)
        ? value.flatMap((row) => Object.values(row)) : [value])
        .filter((value) => typeof value === 'string' && value.startsWith('/uploads/')).length;
    window.fetch = async (url, options) => {
      if (url === '/api/photo-uploads') {
        checks.attempts += 1;
        const stored = await db.get('records', activeId);
        expect(savedEvidenceCount(stored) === (config.alreadyUploaded || 0) + checks.successful,
          'Every successful image must be checkpointed before the next request');
        expect(checks.decodes <= checks.successful + 1,
          'Decode only the next missing original, never all remaining photos');
        if (config.networkError) throw new TypeError('Simulated network failure');
        const blocked = config.always429 || checks.attempts === config.failAt;
        if (blocked) return new Response(JSON.stringify({ detail: 'Test upload blocked' }), {
          status: config.status || 429,
          headers: { ...(config.retryAfter == null ? {} : { 'Retry-After': config.retryAfter }), 'Content-Type': 'application/json' }
        });
        checks.successful += 1;
        return Response.json({ url: `/uploads/${activeId}-${(config.alreadyUploaded || 0) + checks.successful}.png` });
      }
      expect(url === '/api/form-submissions', 'Only the intended submission request is allowed');
      const body = JSON.parse(options.body);
      checks.posts.push(body);
      return Response.json({ id: 701, worker_id: 7, status: 'pending', photo_urls: body.photo_urls, answers: body.answers });
    };
    window.fixture = {
      api, offline, db, checks, expect,
      configure(id, options = {}) { activeId = id; config = options; },
      setOnline(value) { online = value; },
      record(id, count, signatures = false) {
        return {
          id, type: 'form', submissionPurpose: 'report', formId: 21, formName: 'Photo check',
          workDate: '2026-09-16', fields: signatures ? [
            { id: 'signed', type: 'signature' }, { id: 'crew_sign', type: 'signature', repeat: 'crew' }
          ] : [],
          answers: signatures ? { signed: dataUrl, crew: [{ crew_sign: dataUrl }, { crew_sign: dataUrl }] } : {},
          photoDataUrls: Array.from({ length: count }, () => dataUrl),
          photoMetadata: Array.from({ length: count }, (_, index) => ({ name: `Photo ${index + 1}` }))
        };
      },
      progress(value) {
        checks.progress.push(value);
        if (value.completed % 2) throw new Error('Detached UI');
        return Promise.reject(new Error('Async feedback failure'));
      }
    };
  });
}

try {
  await prepare();
  const batch = await page.evaluate(async () => {
    const f = window.fixture;
    f.configure('batch-50', { failAt: 31, retryAfter: '1' });
    const result = await f.offline.submitOfflineSubmission(f.record('batch-50', 50, true), { onUploadProgress: f.progress });
    f.expect(!result.queued, 'Fifty photos and three signatures should finish through one 429');
    f.expect(f.checks.posts.length === 1 && f.checks.posts[0].photo_urls.length === 50, 'Submit all fifty URLs exactly once');
    f.expect(f.checks.decodes === 53 && f.checks.attempts === 54, 'Retry the current Blob without redecoding it');
    f.expect(f.checks.progress.some((event) => event.phase === 'waiting' && event.completed === 30 && event.total === 53), 'Waiting progress includes completed signatures');
    f.expect(f.checks.progress.at(-1).completed === 53, 'Completed progress includes all evidence');
    f.expect((await f.db.getAll('queue')).length === 0, 'Finished batch leaves no queued record');
    return { attempts: f.checks.attempts, waits: f.checks.waits };
  });
  assert.deepEqual(batch, { attempts: 54, waits: [1000] });
  console.log('ok - 50 photos plus repeated signatures checkpoint sequentially, retry 429, and ignore broken progress callbacks');

  await prepare();
  await page.evaluate(async () => {
    const f = window.fixture;
    f.configure('offline-50');
    f.setOnline(false);
    const result = await f.offline.submitOfflineSubmission(f.record('offline-50', 50));
    f.expect(result.queued && f.checks.attempts === 0, 'Offline batch saves without network uploads');
    f.expect((await f.db.get('records', 'offline-50')).photoDataUrls.length === 50, 'All originals persist offline');
  });
  await prepare(); // Actual browser reload, same isolated IndexedDB.
  await page.evaluate(async () => {
    const f = window.fixture;
    f.configure('offline-50', { failAt: 36, status: 503 });
    const result = await f.offline.syncQueuedSubmissions({ purpose: 'report' });
    f.expect(result.failed === 1 && f.checks.successful === 35, 'Uncertain server error does not retry');
    const saved = await f.db.get('records', 'offline-50');
    f.expect(saved.photoUrls.length === 35 && saved.photoDataUrls.length === 50, 'Partial progress and every original survive');
  });
  await prepare();
  await page.evaluate(async () => {
    const f = window.fixture;
    f.configure('offline-50', { alreadyUploaded: 35 });
    const result = await f.offline.syncQueuedSubmissions({ purpose: 'report', onUploadProgress: f.progress });
    f.expect(result.flushed === 1 && f.checks.successful === 15 && f.checks.decodes === 15, 'Reload resumes only fifteen missing uploads');
    f.expect(f.checks.posts[0].photo_urls.length === 50, 'Resumed final payload preserves all fifty ordered URLs');
    f.expect(f.checks.progress[0].completed === 35 && f.checks.progress[0].total === 50, 'Resume progress starts from durable uploads');
  });
  console.log('ok - cold reload preserves fifty offline originals and resumes fifteen remaining photos after partial failure');

  for (const [id, config, attempts, waits] of [
    ['retry-exhausted', { always429: true, retryAfter: '1' }, 4, [1000, 1000, 1000]],
    ['wait-budget', { always429: true, retryAfter: '60' }, 3, [60000, 60000]],
    ['invalid-cooldown', { always429: true, retryAfter: 'nonsense' }, 1, []],
    ['long-cooldown', { always429: true, retryAfter: '61' }, 1, []],
    ['network-uncertain', { networkError: true }, 1, []],
    ['owner-changed', { always429: true, retryAfter: '1', switchOwner: true }, 1, [1000]],
    ['logged-out', { always429: true, retryAfter: '1', logout: true }, 1, [1000]]
  ]) {
    await prepare();
    const checked = await page.evaluate(async ({ id, config }) => {
      const f = window.fixture;
      f.configure(id, config);
      const result = await f.offline.submitOfflineSubmission(f.record(id, 1));
      f.expect(result.queued && f.checks.posts.length === 0, 'Stopped upload must remain queued without submission');
      if (config.switchOwner || config.logout) f.expect(result.record.syncBlockedReason === 'owner_mismatch', 'Recheck ownership after waiting');
      await f.db.remove('queue', id);
      await f.db.remove('records', id);
      return { attempts: f.checks.attempts, waits: f.checks.waits };
    }, { id, config });
    assert.deepEqual(checked, { attempts, waits }, id);
  }
  console.log('ok - bounded retry count/wait budget, malformed or long cooldowns, network uncertainty, logout and account changes safely retain the queue');

  for (const changeIdentity of ['none', 'switch', 'logout']) {
    await prepare();
    await page.evaluate(async (changeIdentity) => {
      const f = window.fixture;
      const id = `slow-active-${changeIdentity}`;
      f.configure(id);
      const NativeDate = Date;
      let clock = NativeDate.now();
      window.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [clock])); }
        static now() { return clock; }
      };
      let notifyStarted;
      const started = new Promise((resolve) => { notifyStarted = resolve; });
      let release;
      const blocked = new Promise((resolve) => { release = resolve; });
      let attempts = 0;
      let posted = 0;
      let released = false;
      window.fetch = async (url, options) => {
        if (url === '/api/photo-uploads') {
          attempts += 1;
          if (attempts === 1) { notifyStarted(); await blocked; }
          else f.expect(released, 'A queue sweep must not replay the long in-flight upload');
          return Response.json({ url: `/uploads/${id}-${attempts}.png` });
        }
        f.expect(url === '/api/form-submissions', 'Only a final Report request is allowed');
        posted += 1;
        const payload = JSON.parse(options.body);
        return Response.json({ id: 702, worker_id: 7, photo_urls: payload.photo_urls });
      };
      const pending = f.offline.submitOfflineSubmission(f.record(id, 3));
      await started;
      const initial = await f.db.get('records', id);
      clock += 180000; // The individual request outlives the persisted 2-minute lease.
      if (changeIdentity === 'switch') f.api.saveSession({ id: 8, role: 'worker', department_id: 2 });
      if (changeIdentity === 'logout') localStorage.removeItem('geo_user');
      const sweep = await f.offline.syncQueuedSubmissions({ purpose: 'report' });
      f.expect(changeIdentity === 'logout' ? sweep.noActiveWorker : sweep.skipped === 1,
        'Skip the active record even after its lease expires and identity changes');
      f.expect(attempts === 1 && (await f.db.get('records', id)).syncStartedAt === initial.syncStartedAt,
        'Queue sweeps must not upload or overwrite an active record');
      if (changeIdentity === 'none') {
        let duplicateError;
        try { await f.offline.submitOfflineSubmission(f.record(id, 3)); }
        catch (error) { duplicateError = error; }
        f.expect(duplicateError?.message.includes('already being saved'), 'Reject a duplicate explicit submission in this context');
      }
      released = true;
      release();
      const result = await pending;
      if (changeIdentity === 'none') f.expect(!result.queued && attempts === 3 && posted === 1,
        'Long upload completes each original and one Report exactly once');
      else {
        f.expect(result.queued && result.record.syncBlockedReason === 'owner_mismatch' && attempts === 1 && posted === 0,
          'After identity changes, checkpoint the successful upload but send nothing else');
        const saved = await f.db.get('records', id);
        f.expect(saved.ownerWorkerId === 7 && saved.photoUrls.length === 1, 'Keep original ownership and completed evidence');
      }
      await f.db.remove('queue', id);
      await f.db.remove('records', id);
    }, changeIdentity);
  }
  console.log('ok - clock-advanced >2-minute uploads cannot be replayed by queue sweeps or duplicate submits, including after account switch/logout');

  await prepare();
  await page.evaluate(async () => {
    const f = window.fixture;
    const id = 'renewed-upload-lease';
    f.configure(id);
    const NativeDate = Date;
    let clock = NativeDate.now();
    window.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [clock])); }
      static now() { return clock; }
    };
    let attempts = 0;
    let waitLeaseFresh = false;
    const nativeTimer = window.setTimeout.bind(window);
    window.setTimeout = (callback, milliseconds) => nativeTimer(async () => {
      const saved = await f.db.get('records', id);
      waitLeaseFresh = milliseconds === 60000 && saved.syncStartedAt === new Date(clock).toISOString();
      clock += milliseconds;
      callback();
    }, 0);
    window.fetch = async (url, options) => {
      const saved = await f.db.get('records', id);
      if (url === '/api/photo-uploads') {
        attempts += 1;
        if (attempts === 2) {
          f.expect(saved.syncStartedAt === new Date(clock).toISOString(), 'Successful evidence checkpoint renews the lease');
          clock += 130000;
          return new Response('{}', { status: 429, headers: { 'Retry-After': '60' } });
        }
        if (attempts === 3) f.expect(clock - new Date(saved.syncStartedAt).getTime() === 60000,
          'The long request renewed its lease before the bounded wait');
        clock += 70000;
        return Response.json({ url: `/uploads/${id}-${attempts}.png` });
      }
      f.expect(saved.syncStartedAt === new Date(clock).toISOString(), 'The last evidence checkpoint also renews the lease');
      const payload = JSON.parse(options.body);
      return Response.json({ id: 703, worker_id: 7, photo_urls: payload.photo_urls });
    };
    const result = await f.offline.submitOfflineSubmission(f.record(id, 2));
    f.expect(!result.queued && attempts === 3 && waitLeaseFresh, 'A multi-minute batch renews before every cooldown');
  });
  console.log('ok - durable evidence checkpoints and bounded rate-limit waits renew the cross-reload syncing lease');

  await prepare();
  await page.evaluate(async () => {
    const { api, expect } = window.fixture;
    for (const [header, body, expected] of [
      ['5', {}, 5], [null, { retry_after_seconds: 2 }, 2], ['invalid', { retry_after_seconds: 2 }, undefined],
      ['-1', {}, undefined], ['61', {}, undefined], ['0', {}, 0],
      [new Date(Date.now() + 30000).toUTCString(), {}, 30]
    ]) {
      window.fetch = async () => new Response(JSON.stringify(body), { status: 429,
        headers: header == null ? {} : { 'Retry-After': header } });
      try { await api.uploadPhoto(new Blob(['x'], { type: 'image/png' })); throw new Error('Expected a 429'); }
      catch (error) {
        expect(error.status === 429 && error.retryAfterSeconds === expected, `Validate upload cooldown ${header}`);
      }
    }
  });
  console.log('ok - upload-only Retry-After parsing accepts bounded seconds/date and rejects invalid values');
} finally {
  await context.close();
  await browser.close();
}
