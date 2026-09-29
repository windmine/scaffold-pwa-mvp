import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { assertRenderedEvidence } from './check-hosted-report-workflow.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59957'; // Every request intercepted; no real API or uploads.
const source = await readFile(path.join(root, 'index.html'), 'utf8');
const start = source.indexOf('    <div id="photoViewer"');
assert.ok(start > 0);
const viewerMarkup = source.slice(start, source.indexOf('    <template', start));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const imageRequests = [];
await context.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, origin, 'External requests are forbidden');
  if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html>
    <meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/assets/css/styles.css">
    <button id="opener">Open photos</button><div id="alreadyInert" inert>Other panel</div>${viewerMarkup}` });
  if (url.pathname.startsWith('/uploads/')) {
    imageRequests.push(url.pathname);
    if (url.pathname === '/uploads/broken.png') return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="#3d638b"/></svg>' });
  }
  assert.match(url.pathname, /^\/assets\/(js\/[a-z\d-]+\.js|css\/styles\.css)$/);
  return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
    body: await readFile(path.join(root, url.pathname), 'utf8') });
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

async function prepare({ oldMarkup = false } = {}) {
  await page.goto(origin);
  await page.evaluate(async (legacy) => {
    const { createPhotoViewer } = await import('/assets/js/photo-viewer.js');
    const byId = (id) => document.getElementById(id);
    if (legacy) {
      const stage = document.querySelector('.photo-viewer-stage');
      stage.replaceWith(byId('photoViewerImage'));
      document.querySelector('.photo-viewer-zoom').remove();
    }
    const viewer = createPhotoViewer({ viewer: byId('photoViewer'), image: byId('photoViewerImage'),
      caption: byId('photoViewerCaption'), closeButton: byId('closePhotoViewerButton'),
      previousButton: byId('previousPhotoButton'), nextButton: byId('nextPhotoButton') });
    viewer.bindEvents();
    viewer.bindEvents();
    window.fixture = { viewer, sources: Object.freeze(Array.from({ length: 50 }, (_, index) => `/uploads/photo-${index + 1}.png`)) };
    byId('opener').addEventListener('click', () => viewer.open(window.fixture.sources, 0, 'Report photo', { reportGallery: true }));
  }, oldMarkup);
}

async function waitImage() {
  await page.waitForFunction(() => {
    const image = document.getElementById('photoViewerImage');
    return image.complete && image.naturalWidth > 0;
  });
}

async function swipe({ dx = -120, dy = 0, pinch = false, cancel = false } = {}) {
  return page.evaluate(({ dx, dy, pinch, cancel }) => {
    const stage = document.querySelector('.photo-viewer-stage');
    const point = (x, y, identifier = 1) => new Touch({ identifier, target: stage, clientX: x, clientY: y });
    const dispatch = (type, touches, changedTouches = touches) => {
      const event = new TouchEvent(type, { bubbles: true, cancelable: true, touches, changedTouches });
      stage.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const initial = point(180, 180);
    const end = point(180 + dx, 180 + dy);
    const prevented = [dispatch('touchstart', [initial])];
    if (pinch) prevented.push(dispatch('touchstart', [initial, point(220, 200, 2)]));
    prevented.push(dispatch('touchmove', pinch ? [end, point(240, 220, 2)] : [end]));
    if (cancel) prevented.push(dispatch('touchcancel', [], [end]));
    prevented.push(dispatch('touchend', [], [end]));
    return prevented.some(Boolean);
  }, { dx, dy, pinch, cancel });
}

async function current() {
  return page.locator('#photoViewerCaption').textContent();
}

try {
  await prepare();
  imageRequests.length = 0;
  await page.locator('#opener').click();
  await waitImage();
  assert.equal(await current(), 'Report photo 1 of 50');
  assert.deepEqual(imageRequests, ['/uploads/photo-1.png'], 'Opening 50 sources requests only the viewed original');
  assert.equal(await page.locator('#photoViewer img').count(), 1);
  assert.equal(await page.locator('.photo-viewer-zoom').isVisible(), true);
  assert.equal(await page.locator('#closePhotoViewerButton').evaluate((el) => el === document.activeElement), true);
  assert.equal(await page.locator('#opener').evaluate((el) => el.inert), true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.locator('#nextPhotoButton').evaluate((el) => el === document.activeElement), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#closePhotoViewerButton').evaluate((el) => el === document.activeElement), true);
  assert.equal(await page.locator('#photoViewerCaption').getAttribute('aria-live'), 'polite');
  await page.keyboard.press('ArrowRight');
  await waitImage();
  assert.equal(await current(), 'Report photo 2 of 50');
  assert.deepEqual(imageRequests, ['/uploads/photo-1.png', '/uploads/photo-2.png']);
  assert.equal(await swipe(), false, 'Swipe handlers do not prevent native touch defaults');
  assert.equal(await current(), 'Report photo 3 of 50');
  await swipe({ dx: 120 });
  assert.equal(await current(), 'Report photo 2 of 50');
  for (const gesture of [{ dx: 8 }, { dx: -30, dy: 100 }, { dx: -120, dy: 95 }, { pinch: true }, { cancel: true }]) {
    await swipe(gesture);
    assert.equal(await current(), 'Report photo 2 of 50', 'Short, vertical, diagonal, pinch and cancelled gestures do not navigate');
  }
  const client = await context.newCDPSession(page);
  const stageBox = await page.locator('.photo-viewer-stage').boundingBox();
  const touchY = stageBox.y + stageBox.height / 2;
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: stageBox.x + stageBox.width * 0.8, y: touchY }] });
  for (const portion of [0.6, 0.4, 0.2]) await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove', touchPoints: [{ x: stageBox.x + stageBox.width * portion, y: touchY }]
  });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal(await current(), 'Report photo 3 of 50', 'Browser-dispatched touch swipe navigates with production touch-action CSS');
  await client.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
  await swipe();
  assert.equal(await current(), 'Report photo 3 of 50', 'Browser-zoomed viewport never turns pan gestures into navigation');
  await client.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
  await client.detach();
  await page.keyboard.press('ArrowLeft');
  console.log('ok - Report-only one-original loading, arrows, fit swipe, native gesture isolation and modal focus');

  await waitImage();
  await page.locator('.photo-viewer-zoom').click();
  assert.equal(await page.locator('.photo-viewer-zoom').textContent(), 'Fit photo');
  assert.equal(await page.locator('.photo-viewer-zoom').getAttribute('aria-pressed'), 'true');
  const zoom = await page.locator('.photo-viewer-stage').evaluate((stage) => ({
    width: stage.clientWidth, scroll: stage.scrollWidth,
    imageWidth: stage.querySelector('img').getBoundingClientRect().width,
    x: stage.scrollLeft, touchAction: getComputedStyle(stage).touchAction,
  }));
  assert.ok(zoom.scroll > zoom.width && zoom.x > 0);
  assert.ok(Math.abs(zoom.imageWidth - zoom.width * 2) < 2, 'Zoom is twice the fit size');
  assert.match(zoom.touchAction, /pan-x|manipulation/);
  await swipe();
  assert.equal(await current(), 'Report photo 2 of 50', 'Panning zoomed evidence never changes photo');
  await page.locator('.photo-viewer-stage').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await current(), 'Report photo 2 of 50', 'Focused zoom stage preserves native keyboard pan');
  await page.locator('#nextPhotoButton').click();
  await waitImage();
  assert.equal(await current(), 'Report photo 3 of 50');
  assert.equal(await page.locator('.photo-viewer-zoom').textContent(), 'Zoom in');
  assert.equal(await page.locator('.photo-viewer-stage').evaluate((el) => el.scrollLeft), 0);
  await page.locator('.photo-viewer-zoom').click();
  await page.locator('.photo-viewer-zoom').click();
  assert.equal(await page.locator('.photo-viewer-zoom').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#photoViewerImage').getAttribute('style'), '');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#photoViewer').isVisible(), false);
  assert.equal(await page.locator('#photoViewerImage').getAttribute('src'), null);
  assert.equal(await page.locator('#opener').evaluate((el) => el === document.activeElement && !el.inert), true);
  assert.equal(await page.locator('#alreadyInert').evaluate((el) => el.inert), true);
  console.log('ok - accessible 2× zoom/fit, scroll pan, per-photo reset, Escape and exact background/focus restoration');

  await page.locator('#opener').click();
  await waitImage();
  await page.locator('.photo-viewer-zoom').click();
  assert.equal(await page.evaluate(() => window.fixture.viewer.closeForSources(['/uploads/unrelated.png'])), false);
  assert.equal(await page.evaluate(() => window.fixture.viewer.closeForSources(['/uploads/photo-50.png'])), true);
  assert.equal(await page.locator('#photoViewerImage').getAttribute('src'), null);
  assert.equal(await page.locator('#photoViewerImage').getAttribute('style'), '');
  await page.evaluate(() => window.fixture.viewer.open(['/uploads/broken.png'], 0, 'Report photo', { reportGallery: true }));
  await page.locator('.photo-viewer-error:not([hidden])').waitFor();
  assert.equal(await page.locator('.photo-viewer-error').textContent(), 'Photo could not be loaded.');
  assert.equal(await page.locator('.photo-viewer-error').getAttribute('role'), 'status');
  assert.equal(await page.locator('.photo-viewer-zoom').isDisabled(), true);
  assert.equal(await page.locator('#previousPhotoButton').isDisabled(), true);
  assert.equal(await page.locator('#nextPhotoButton').isDisabled(), true);
  const metadataDate = '2026-09-29T01:24:00Z';
  const formattedDate = await page.evaluate(async (value) => {
    const { formatDateTime } = await import('/assets/js/utils.js');
    const metadata = Array.from({ length: 50 }, () => ({}));
    metadata[6] = { taken_at: value };
    window.fixture.viewer.open(window.fixture.sources, 5, 'Report photo', { reportGallery: true, photoMetadata: metadata });
    return formatDateTime(value);
  }, metadataDate);
  assert.equal(await page.locator('.photo-viewer-timestamp').isVisible(), false);
  await page.locator('#nextPhotoButton').click();
  assert.equal(await current(), 'Report photo 7 of 50');
  assert.equal(await page.locator('.photo-viewer-timestamp').textContent(), formattedDate);
  assert.equal(await page.locator('.photo-viewer-timestamp').isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.photo-viewer-timestamp').textContent(), '');
  assert.equal(await page.locator('.photo-viewer-timestamp').getAttribute('hidden'), '');
  await page.evaluate((date) => window.fixture.viewer.open(window.fixture.sources, 0, 'Legacy photo', {
    photoMetadata: [{ taken_at: date }],
  }), metadataDate);
  assert.equal(await page.locator('.photo-viewer-timestamp').isVisible(), false);
  await page.evaluate(() => window.fixture.viewer.open(window.fixture.sources, 49, 'Report photo', { reportGallery: true }));
  await waitImage();
  assert.equal(await page.locator('.photo-viewer-error').isVisible(), false);
  await page.locator('#nextPhotoButton').click();
  assert.equal(await current(), 'Report photo 1 of 50');
  await page.locator('#previousPhotoButton').click();
  assert.equal(await current(), 'Report photo 50 of 50');
  assert.equal(await page.evaluate(() => Object.isFrozen(window.fixture.sources) && window.fixture.sources.length === 50), true);
  console.log('ok - source-owner cleanup, accessible failed-image feedback, recovery and unmutated wraparound');

  const longTitle = 'Site safety inspection report for plant and equipment operation at ground level and on elevated work platforms - Extremely long construction site name Auckland city central redevelopment';
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1280, height: 900 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate((title) => window.fixture.viewer.open(window.fixture.sources, 0, title, { reportGallery: true }), longTitle);
    await waitImage();
    const layout = await page.locator('#photoViewer').evaluate((viewer) => ({
      width: window.innerWidth, height: window.innerHeight,
      stageBottom: viewer.querySelector('.photo-viewer-stage').getBoundingClientRect().bottom,
      actionsTop: viewer.querySelector('.photo-viewer-actions').getBoundingClientRect().top,
      buttons: [...viewer.querySelectorAll('button')].filter((el) => !el.hidden).map((el) => {
        const { x, y, width, height } = el.getBoundingClientRect();
        return { x, y, width, height };
      })
    }));
    assert.ok(layout.stageBottom <= layout.actionsTop, 'Long captions never cause the stage to overlap the actions');
    for (const button of layout.buttons) {
      assert.ok(button.width >= 44 && button.height >= 44, 'Controls retain 44px targets');
      assert.ok(button.x >= 0 && button.y >= 0 && button.x + button.width <= layout.width + 1
        && button.y + button.height <= layout.height + 1, 'All controls stay inside phone/landscape/desktop viewport');
    }
  }
  await page.evaluate(() => window.fixture.viewer.open(window.fixture.sources, 0, 'Legacy photo'));
  assert.equal(await page.locator('.photo-viewer-zoom').isVisible(), false);
  await swipe();
  assert.equal(await current(), 'Legacy photo 1 of 50');
  await page.keyboard.press('ArrowRight');
  assert.equal(await current(), 'Legacy photo 2 of 50');
  await prepare({ oldMarkup: true });
  await page.evaluate(() => window.fixture.viewer.open(window.fixture.sources, 0, 'Old markup'));
  await waitImage();
  await page.keyboard.press('ArrowRight');
  assert.equal(await current(), 'Old markup 2 of 50');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#photoViewer').isVisible(), false);
  console.log('ok - responsive controls, non-Report gesture isolation and backwards-compatible optional markup');

  await prepare();
  imageRequests.length = 0;
  await page.evaluate(async () => {
    const { mountReportPhotoGallery } = await import('/assets/js/report-photo-gallery.js');
    const container = document.createElement('section');
    container.id = 'evidence';
    const gallery = document.createElement('div');
    gallery.className = 'report-photo-gallery';
    const signature = document.createElement('img');
    signature.src = '/uploads/signature.png';
    signature.alt = 'Signature';
    signature.style.maxWidth = '100%';
    container.append(gallery, signature);
    document.body.append(container);
    const viewed = [];
    document.getElementById('photoViewerImage').addEventListener('load', (event) => viewed.push(event.target.getAttribute('src')));
    window.fixture.viewed = viewed;
    window.fixture.disposeGallery = mountReportPhotoGallery(gallery, {
      sources: window.fixture.sources, title: 'Report photo', photoViewer: window.fixture.viewer, isCurrent: () => true,
    });
  });
  assert.equal(await page.locator('#evidence img').count(), 7, 'Six previews plus separate signature');
  await assertRenderedEvidence(page.locator('#evidence'), 51);
  assert.deepEqual(await page.evaluate(() => window.fixture.viewed),
    Array.from({ length: 50 }, (_, index) => `/uploads/photo-${index + 1}.png`), 'Real gallery and viewer expose all originals in exact source order');
  assert.equal(await page.locator('#photoViewer').isVisible(), false);
  assert.equal(await page.locator('#photoViewerImage').getAttribute('src'), null);
  assert.equal(await page.locator('.report-photo-gallery-open').evaluate((el) => el === document.activeElement), true);
  await page.evaluate(() => window.fixture.disposeGallery());
  assert.equal(await page.locator('.report-photo-gallery img').count(), 0);
  assert.equal(new Set(imageRequests.filter((url) => url.startsWith('/uploads/photo-'))).size, 50);
  assert.deepEqual(errors, []);
  console.log('ok - real six-preview gallery, separate signature, hosted evidence verifier and all 50 ordered originals');

  await prepare(); // Discard the integration fixture; its evidence is not part of the screenshot surface.
  const screenshotDir = path.join(root, 'output', 'report-photo-gallery.local');
  await mkdir(screenshotDir, { recursive: true });
  async function screenshot(name, width) {
    const bounds = await page.locator('.photo-viewer-panel').evaluate((panel) => ({
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      ...Object.fromEntries(['left', 'top', 'right', 'bottom'].map((key) => [key, panel.getBoundingClientRect()[key]])),
    }));
    assert.ok(Math.abs(bounds.viewportWidth - width) <= 1, 'Screenshot uses the intended CSS viewport, not an expanded fixture viewport');
    assert.ok(bounds.documentWidth <= bounds.viewportWidth, 'No wide integration fixture remains');
    assert.ok(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= bounds.viewportWidth && bounds.bottom <= bounds.viewportHeight,
      'Viewer panel stays completely inside the intended screenshot viewport');
    await page.screenshot({ path: path.join(screenshotDir, name) });
  }
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const language of ['en', 'zh']) {
      for (const theme of ['light', 'dark']) {
        await page.evaluate(async ({ language, theme }) => {
          const { setLanguage } = await import('/assets/js/i18n.js');
          setLanguage(language);
          document.documentElement.dataset.theme = theme;
          window.fixture.viewer.open(window.fixture.sources, 0, 'Report photo', { reportGallery: true });
        }, { language, theme });
        await waitImage();
        await screenshot(`viewer-${width}-${language}-${theme}-fit.png`, width);
        await page.locator('.photo-viewer-zoom').click();
        await screenshot(`viewer-${width}-${language}-${theme}-zoom.png`, width);
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log('ok - 16 fit/zoom phone screenshots saved for EN/ZH and light/dark visual review');
} finally {
  await context.close();
  await browser.close();
}
