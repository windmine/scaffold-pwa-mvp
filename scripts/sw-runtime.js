/* global APP_SHELL, CACHE_VERSION */

const NETWORK_ONLY_PREFIXES = [
  '/api',
  '/auth',
  '/photo-uploads',
  '/uploads',
  '/supervisor',
  '/attendance',
  '/my-records',
  '/task-logs',
  '/task-templates',
  '/team-work-log-members',
  '/team-work-logs',
  '/my-team-work-logs',
  '/work-forms',
  '/form-submissions',
  '/sites',
  '/dev',
  '/health'
];

function pathMatchesPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isNetworkOnlyRequest(request) {
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return true;

  return NETWORK_ONLY_PREFIXES.some((prefix) => pathMatchesPrefix(url.pathname, prefix));
}

function isCacheableStaticRequest(request) {
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return false;
  if (isNetworkOnlyRequest(request)) return false;

  return (
    request.destination === 'script'
    || request.destination === 'style'
    || request.destination === 'image'
    || request.destination === 'font'
    || request.destination === 'manifest'
    || APP_SHELL.includes(url.pathname)
  );
}

function responseContentMatchesRequest(request, response) {
  const contentType = response.headers.get('content-type') || '';
  const pathname = new URL(request.url).pathname;

  if (request.destination === 'style' || pathname.endsWith('.css')) {
    return contentType.includes('text/css');
  }

  if (request.destination === 'script' || pathname.endsWith('.js')) {
    return contentType.includes('javascript') || contentType.includes('ecmascript');
  }

  if (request.destination === 'image' || /\.(png|jpe?g|gif|webp|svg|ico)$/i.test(pathname)) {
    return contentType.startsWith('image/');
  }

  if (request.destination === 'manifest' || pathname.endsWith('.webmanifest')) {
    return contentType.includes('application/manifest+json') || contentType.includes('application/json');
  }

  if (pathname === '/' || pathname.endsWith('.html')) {
    return contentType.includes('text/html');
  }

  return true;
}

function isCacheableResponse(response, request) {
  return response && response.ok && response.type === 'basic' && responseContentMatchesRequest(request, response);
}

function appShellRequest(path) {
  const headers = {};

  if (path.endsWith('.css')) {
    headers.Accept = 'text/css,*/*;q=0.1';
  }

  return new Request(path, { cache: 'reload', headers });
}

async function cacheAppShell() {
  const cache = await caches.open(CACHE_VERSION);

  await Promise.all(APP_SHELL.map(async (path) => {
    const request = appShellRequest(path);
    const response = await fetch(request);

    if (!isCacheableResponse(response, request)) {
      throw new Error(`Refused to cache unexpected app shell response for ${path}`);
    }

    await cache.put(request, response);
  }));
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);

  if (cached) return cached;

  const response = await fetch(request);

  if (isCacheableResponse(response, request)) {
    await cache.put(request, response.clone());
  }

  return response;
}

self.addEventListener('install', (event) => {
  event.waitUntil(cacheAppShell());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE_VERSION);
        return cache.match('/offline.html');
      })
    );
    return;
  }

  if (isNetworkOnlyRequest(request)) {
    event.respondWith(fetch(request));
    return;
  }

  if (!isCacheableStaticRequest(request)) {
    return;
  }

  event.respondWith(cacheFirst(request));
});
