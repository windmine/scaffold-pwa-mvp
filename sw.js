const CACHE_VERSION = 'leader-field-v79';
const APP_SHELL = [
  '/',
  '/index.html',
  '/offline.html',
  '/manifest.webmanifest',
  '/assets/css/styles.css',
  '/assets/js/app.js',
  '/assets/js/api-client.js',
  '/assets/js/date-inputs.js',
  '/assets/js/db.js',
  '/assets/js/history.js',
  '/assets/js/i18n.js',
  '/assets/js/mock-api.js',
  '/assets/js/offline-submissions.js',
  '/assets/js/photo-viewer.js',
  '/assets/js/site-map-picker.js',
  '/assets/js/staff-sites.js',
  '/assets/js/supervisor-analytics.js',
  '/assets/js/supervisor-map.js',
  '/assets/js/supervisor-review.js',
  '/assets/js/team-work-log.js',
  '/assets/js/utils.js',
  '/assets/js/worker-attendance.js',
  '/assets/js/worker-form.js',
  '/assets/js/worker-log.js',
  '/assets/js/worker-sites.js',
  '/assets/js/work-form-fields.js',
  '/assets/icons/leader-logo-export.png',
  '/assets/icons/leader-icon.svg',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png',
  '/assets/icons/maskable-512.png',
  '/assets/icons/apple-touch-icon.png'
];

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

function isCacheableResponse(response) {
  return response && response.ok && response.type === 'basic';
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);

  if (cached) return cached;

  const response = await fetch(request);

  if (isCacheableResponse(response)) {
    await cache.put(request, response.clone());
  }

  return response;
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)));
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
