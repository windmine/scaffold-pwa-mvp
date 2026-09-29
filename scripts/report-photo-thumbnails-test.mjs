import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59979'; // Fully intercepted; no API or external requests.
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await context.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, origin, 'External requests are forbidden');
  if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html>
    <style>.hidden,[hidden]{display:none!important}.photo-thumb{width:140px;height:140px}</style>
    <div id="gallery"></div><div id="viewer" class="hidden"><img id="original"><p id="caption"></p>
    <button id="close">Close</button><button id="previous">Previous</button><button id="next">Next</button></div>` });
  assert.match(url.pathname, /^\/assets\/js\/[a-z\d-]+\.js$/);
  return route.fulfill({ contentType: 'text/javascript', body: await readFile(path.join(root, url.pathname), 'utf8') });
});
const page = await context.newPage();

async function prepare() {
  await page.goto(origin);
  await page.evaluate(async () => {
    const { createPhotoViewer } = await import('/assets/js/photo-viewer.js');
    const { createPhotoPreviewSources } = await import('/assets/js/report-photo-evidence.js');
    const byId = (id) => document.getElementById(id);
    const viewer = createPhotoViewer({ viewer: byId('viewer'), image: byId('original'), caption: byId('caption'),
      closeButton: byId('close'), previousButton: byId('previous'), nextButton: byId('next') });
    viewer.bindEvents();
    const nativeBitmap = window.createImageBitmap.bind(window);
    const nativeCreate = URL.createObjectURL.bind(URL);
    const nativeRevoke = URL.revokeObjectURL.bind(URL);
    const allocated = new Map();
    const counts = { active: 0, peak: 0, decoded: 0, released: 0 };
    const controls = { hold: null, started: false };
    URL.createObjectURL = (blob) => {
      const url = nativeCreate(blob);
      allocated.set(url, blob);
      return url;
    };
    URL.revokeObjectURL = (url) => { allocated.delete(url); nativeRevoke(url); };
    window.createImageBitmap = async (...args) => {
      counts.active += 1;
      counts.peak = Math.max(counts.peak, counts.active);
      counts.decoded += 1;
      controls.started = true;
      try {
        if (controls.hold) await controls.hold;
        const bitmap = await nativeBitmap(...args);
        const close = bitmap.close.bind(bitmap);
        bitmap.close = () => { counts.released += 1; close(); };
        return bitmap;
      } finally { counts.active -= 1; }
    };
    const originalHandles = [];
    window.fixture = {
      viewer, gallery: byId('gallery'), allocated, counts, controls, nativeBitmap,
      expect(condition, message) { if (!condition) throw new Error(message); },
      async photo(width = 1600, height = 900) {
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#174869'; ctx.fillRect(10, 10, width - 20, height - 20);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        canvas.width = 0; canvas.height = 0;
        return blob;
      },
      async hash(blob) {
        return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].join(',');
      },
      render(sources, options = {}) {
        const originals = createPhotoPreviewSources(sources);
        originalHandles.push(originals);
        viewer.renderPreviews(byId('gallery'), originals.urls, 'Report photo', [], { lightweight: true, sources, ...options });
        return originals.urls;
      },
      clear() {
        viewer.close();
        viewer.renderPreviews(byId('gallery'), [], 'Report photo');
        originalHandles.splice(0).forEach((entry) => entry.dispose());
      }
    };
  });
}

async function ready(count) {
  await page.waitForFunction((expected) => [...document.querySelectorAll('#gallery img')]
    .filter((image) => image.hasAttribute('src')).length === expected, count);
}

try {
  await prepare();
  await page.evaluate(async () => {
    const f = window.fixture;
    f.photos = [await f.photo(), await f.photo(600, 1600)];
    f.hashes = await Promise.all(f.photos.map((photo) => f.hash(photo)));
    let release;
    f.controls.hold = new Promise((resolve) => { release = resolve; });
    f.originals = f.render(f.photos);
    f.expect([...f.gallery.querySelectorAll('img')].every((image) => !image.hasAttribute('src')),
      'Gallery renders synchronously without assigning full-resolution images to thumbnails');
    f.expect(f.gallery.textContent.includes('Preparing preview'), 'Preparing placeholders are visible');
    f.expect(f.gallery.querySelector('button').getAttribute('aria-label') === 'Report photo 1',
      'Pending preview buttons have numbered accessible names despite their hidden image alt');
    f.gallery.querySelector('button').click();
    f.expect(document.getElementById('original').src === f.originals[0], 'Original can open before its thumbnail is ready');
    f.viewer.close();
    f.controls.hold = null;
    release();
  });
  await ready(2);
  await page.evaluate(async () => {
    const f = window.fixture;
    f.thumbnails = [...f.gallery.querySelectorAll('img')].map((image) => image.src);
    for (const [index, url] of f.thumbnails.entries()) {
      f.expect(!f.originals.includes(url), 'Thumbnail URL differs from original URL');
      const blob = f.allocated.get(url);
      const bitmap = await f.nativeBitmap(blob);
      f.expect(bitmap.width === (index ? 120 : 320) && bitmap.height === (index ? 320 : 180),
        'Thumbnail raster is capped at 320px and keeps the original aspect ratio');
      bitmap.close();
      f.expect(await f.hash(f.photos[index]) === f.hashes[index], 'Original bytes remain exactly unchanged');
    }
    f.expect(f.counts.peak === 1 && f.counts.released === 2, 'Original rasters decode serially and are explicitly released');
    f.photos.push(await f.photo(1000, 1000));
    f.render(f.photos);
    f.expect(f.gallery.querySelector('img').src === f.thumbnails[0], 'Adding photos reuses retained thumbnails immediately');
  });
  await ready(3);
  await page.evaluate(() => {
    const f = window.fixture;
    f.expect(f.counts.decoded === 3, 'Adding one photo decodes only the new original');
    f.render([f.photos[1], f.photos[2]]);
    f.expect(!f.allocated.has(f.thumbnails[0]), 'Removing a photo revokes its thumbnail URL');
    f.expect(f.gallery.querySelector('img').src === f.thumbnails[1] && f.counts.decoded === 3,
      'Removing/reordering photos preserves cached thumbnails without redecoding');
    f.clear();
    f.expect(f.allocated.size === 0, 'Clearing the editor revokes all owned preview and original URLs');
  });
  console.log('ok - bounded lightweight previews, byte-exact originals, original viewer and retained-preview caching');

  await prepare();
  await page.evaluate(async () => {
    const f = window.fixture;
    f.originals = f.render([new Blob(['not a raster'], { type: 'image/png' }), await f.photo()]);
  });
  await ready(1);
  await page.waitForFunction(() => document.querySelector('.photo-thumb-preview-failed'));
  await page.evaluate(async () => {
    const f = window.fixture;
    const failed = f.gallery.querySelector('.photo-thumb-preview-failed');
    f.expect(failed.textContent.includes('Preview unavailable. Tap to open original.'), 'Failure gives an accessible original-opening fallback');
    const description = document.getElementById(failed.getAttribute('aria-describedby'));
    f.expect(description?.textContent === 'Preview unavailable. Tap to open original.', 'Accessible description references the visible fallback');
    const { setLanguage } = await import('/assets/js/i18n.js');
    setLanguage('zh');
    f.expect(failed.getAttribute('aria-label') === '报告照片 1' && description.textContent === '预览不可用。点按可打开原图。',
      'Existing failed previews translate both their accessible name and description on language change');
    setLanguage('en');
    f.expect(failed.getAttribute('aria-label') === 'Report photo 1' && description.textContent === 'Preview unavailable. Tap to open original.',
      'Preview accessibility text also restores when returning to English');
    failed.click();
    f.expect(document.getElementById('original').src === f.originals[0], 'Failure does not remove the original');
    f.clear();
    f.expect(f.allocated.size === 0, 'Decoder failures release temporary object URLs');
  });
  console.log('ok - a failed preview does not block later thumbnails or remove original evidence');

  await prepare();
  await page.evaluate(async () => {
    const f = window.fixture;
    f.oldPhoto = await f.photo();
    f.newPhoto = await f.photo(900, 1600);
    let release;
    f.controls.hold = new Promise((resolve) => { release = resolve; });
    f.render([f.oldPhoto]);
    f.clear();
    f.render([f.newPhoto]);
    f.controls.hold = null;
    release();
  });
  await ready(1);
  await page.evaluate(async () => {
    const f = window.fixture;
    const image = f.gallery.querySelector('img');
    const bitmap = await f.nativeBitmap(f.allocated.get(image.src));
    f.expect(bitmap.width === 180 && bitmap.height === 320, 'A stale decode cannot replace a new editor thumbnail');
    bitmap.close();
    f.expect(f.counts.decoded === 2 && f.counts.released === 2 && f.counts.peak === 1,
      'Cancellation closes stale decoded bitmaps and keeps the pipeline serial');
    f.clear();
    f.expect(f.allocated.size === 0, 'Cancellation/reset leaves no owned object URLs');
  });
  console.log('ok - editor reset cancels stale callbacks and releases stale decoded images');

  await prepare();
  await page.evaluate(async () => {
    const f = window.fixture;
    window.createImageBitmap = undefined;
    f.photos = [await f.photo()];
    f.render(f.photos);
  });
  await ready(1);
  await page.evaluate(async () => {
    const f = window.fixture;
    const image = f.gallery.querySelector('img');
    const bitmap = await f.nativeBitmap(f.allocated.get(image.src));
    f.expect(bitmap.width === 320 && bitmap.height === 180, 'Image-decoder fallback still produces small rasters');
    bitmap.close();
    f.expect(f.allocated.size === 2, 'Fallback retains only the original viewer URL and small thumbnail URL');
    f.viewer.renderPreviews(f.gallery, ['data:image/png;base64,aW1hZ2U='], 'Signature');
    f.expect(f.gallery.querySelector('img').getAttribute('src') === 'data:image/png;base64,aW1hZ2U=',
      'Legacy/signature preview behavior is unchanged without the lightweight option');
    f.clear();
    f.expect(f.allocated.size === 0, 'Switching away from lightweight previews releases their cache');
  });
  console.log('ok - browser decoder fallback and unchanged legacy/signature previews');

  await prepare();
  await page.evaluate(async () => {
    const f = window.fixture;
    const original = await f.photo(2400, 1600);
    f.photos = Array.from({ length: 50 }, () => original.slice(0, original.size, original.type));
    f.hashBefore = await f.hash(original);
    f.render(f.photos);
  });
  await ready(50);
  await page.evaluate(async () => {
    const f = window.fixture;
    f.expect(f.counts.decoded === 50 && f.counts.peak === 1 && f.counts.released === 50,
      'Fifty larger synthetic originals are processed serially with every raster released');
    f.expect(await f.hash(f.photos[49]) === f.hashBefore, 'Fifty-photo preview preparation leaves original bytes untouched');
    f.expect([...f.gallery.querySelectorAll('img')].every((image) => f.allocated.get(image.src)?.size < 20000),
      'Thumbnail display copies remain small for this synthetic large-image fixture');
    f.clear();
    f.expect(f.allocated.size === 0, 'Fifty-photo clear releases all display resources');
  });
  console.log('ok - fifty 2400×1600 synthetic originals use one decoded raster at a time');
} finally {
  await context.close();
  await browser.close();
}
