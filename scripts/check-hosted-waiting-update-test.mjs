import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { runWaitingUpdateProbe } from './check-hosted-waiting-update.mjs';

// Real browser/SW lifecycle against an owned loopback server only, using the
// repository's actual service-worker runtime. No provider/production requests.
const runtime = readFileSync(new URL('./sw-runtime.js', import.meta.url), 'utf8');
const shell = ['/', '/index.html'];
const worker = (version) => Buffer.from(`const CACHE_VERSION = "probe-${version}";\nconst APP_SHELL = ${JSON.stringify(shell)};\n${runtime}`);
const html = (version) => Buffer.from(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body data-active-view="login" class="${version === 'new' ? 'report-only-mode' : ''}">
<h1>${version} anonymous test shell</h1><button id="updateButton" hidden>Update App</button>
<script>
let updating = false;
const button = document.getElementById('updateButton');
navigator.serviceWorker.addEventListener('controllerchange', () => { if (updating) location.reload(); });
function watch(registration) {
  const installing = registration.installing;
  if (installing) installing.addEventListener('statechange', () => {
    if (installing.state === 'installed' && navigator.serviceWorker.controller) button.hidden = false;
  });
}
navigator.serviceWorker.register('/sw.js').then((registration) => {
  if (registration.waiting && navigator.serviceWorker.controller) button.hidden = false;
  registration.addEventListener('updatefound', () => watch(registration));
  watch(registration);
});
button.addEventListener('click', async () => {
  const registration = await navigator.serviceWorker.getRegistration('/');
  updating = true;
  registration.waiting.postMessage({type:'SKIP_WAITING'});
});
</script></body></html>`);
let version = 'old';
let unsafeRequests = 0;
const server = createServer((request, response) => {
  if (request.method !== 'GET') unsafeRequests += 1;
  response.setHeader('Cache-Control', 'no-store');
  const isWorker = request.url === '/sw.js';
  response.setHeader('Content-Type', isWorker ? 'application/javascript' : 'text/html');
  response.end(isWorker ? worker(version) : html(version));
});
const temporary = mkdtempSync(join(tmpdir(), 'hosted-update-local-'));
await new Promise((done) => server.listen(0, '127.0.0.1', done));
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const evidence = await runWaitingUpdateProbe({ origin, evidencePath: join(temporary, 'proof.json'),
    expectedSw: worker('new'), expectedIndex: html('new'), allowLocalhostHttp: true,
    timeoutMs: 30000, intervalMs: 100,
    onArmed() { version = 'new'; }
  });
  assert.equal(evidence.status, 'passed', JSON.stringify(evidence.failure));
  assert.equal(evidence.checks.length, 4);
  assert.equal(evidence.original.registration.oldControllerStillControls, true);
  assert.equal(evidence.waiting.registration.oldControllerStillControls, true);
  assert.equal(evidence.waiting.registration.waiting, 'installed');
  assert.equal(evidence.updated.reportOnly, true);
  assert.equal(evidence.coldOffline.responseFromServiceWorker, true);
  assert.equal(unsafeRequests, 0);
  console.log('ok - real loopback old-client / waiting-update / user-activation / cold-offline regression');
} finally {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  const resolved = realpathSync(temporary);
  assert.ok(resolved.startsWith(`${resolve(tmpdir())}${sep}hosted-update-local-`));
  rmSync(resolved, { recursive: true, force: true });
}
