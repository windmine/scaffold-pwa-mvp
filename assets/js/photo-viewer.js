import { setTranslatableAttribute, setTranslatableText } from './i18n.js';
import { createReportPhotoThumbnailCache } from './report-photo-thumbnails.js';
import { escapeHtml, formatDateTime } from './utils.js';

let nextPreviewDescriptionId = 0;

export function createPhotoViewer({
  viewer,
  image,
  caption,
  closeButton,
  previousButton,
  nextButton,
  body = document.body
}) {
  const ownerDocument = viewer.ownerDocument || document;
  const stage = viewer.querySelector('.photo-viewer-stage');
  const zoomButton = viewer.querySelector('.photo-viewer-zoom');
  const errorMessage = viewer.querySelector('.photo-viewer-error');
  const timestamp = viewer.querySelector('.photo-viewer-timestamp');
  const focusableSelector = [
    'a[href]',
    'area[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    'iframe',
    'object',
    'embed',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');
  const state = {
    sources: [],
    index: 0,
    title: '',
    photoMetadata: [],
    reportGallery: false,
    zoomed: false
  };
  const inertBackground = new Map();
  const thumbnailCaches = new WeakMap();
  let bound = false;
  let restoreFocusTarget = null;
  let swipe = null;

  function isOpen() {
    return !viewer.classList.contains('hidden');
  }

  function focusElement(element) {
    if (!element || typeof element.focus !== 'function') return;

    try {
      element.focus({ preventScroll: true });
    } catch {
      element.focus();
    }
  }

  function getFocusableElements() {
    return Array.from(viewer.querySelectorAll(focusableSelector))
      .filter((element) => (
        element.tabIndex >= 0
        && !element.closest('[hidden], .hidden, [inert]')
        && element.getAttribute('aria-hidden') !== 'true'
      ));
  }

  function disableBackgroundInteraction() {
    let current = viewer;

    while (current && current !== body) {
      const parent = current.parentElement;
      if (!parent) break;

      Array.from(parent.children).forEach((sibling) => {
        if (sibling === current || inertBackground.has(sibling)) return;

        inertBackground.set(sibling, {
          hadAttribute: sibling.hasAttribute('inert'),
          attributeValue: sibling.getAttribute('inert'),
          propertyValue: 'inert' in sibling ? sibling.inert : undefined
        });
        sibling.setAttribute('inert', '');
        if ('inert' in sibling) sibling.inert = true;
      });

      current = parent;
    }
  }

  function restoreBackgroundInteraction() {
    inertBackground.forEach((previous, element) => {
      if ('inert' in element && previous.propertyValue !== undefined) {
        element.inert = previous.propertyValue;
      }

      if (previous.hadAttribute) {
        element.setAttribute('inert', previous.attributeValue ?? '');
      } else {
        element.removeAttribute('inert');
      }
    });
    inertBackground.clear();
  }

  function resetZoom() {
    state.zoomed = false;
    swipe = null;
    viewer.classList.remove('photo-viewer-zoomed');
    image.style.removeProperty('width');
    image.style.removeProperty('height');
    if (stage) {
      stage.scrollLeft = 0;
      stage.scrollTop = 0;
    }
    if (zoomButton) {
      zoomButton.setAttribute('aria-pressed', 'false');
      setTranslatableText(zoomButton, 'Zoom in');
    }
  }

  function setImageAvailability(loaded) {
    if (zoomButton) zoomButton.disabled = !loaded;
    if (errorMessage) {
      errorMessage.hidden = loaded || !state.reportGallery;
      setTranslatableText(errorMessage, loaded ? '' : 'Photo could not be loaded.');
    }
  }

  function toggleZoom() {
    if (!state.reportGallery || !stage || !image.naturalWidth || !image.naturalHeight) return;
    if (state.zoomed) {
      resetZoom();
      return;
    }

    const scale = Math.min(stage.clientWidth / image.naturalWidth, stage.clientHeight / image.naturalHeight);
    if (!scale) return;
    state.zoomed = true;
    swipe = null;
    viewer.classList.add('photo-viewer-zoomed');
    image.style.width = `${Math.round(image.naturalWidth * scale * 2)}px`;
    image.style.height = `${Math.round(image.naturalHeight * scale * 2)}px`;
    zoomButton.setAttribute('aria-pressed', 'true');
    setTranslatableText(zoomButton, 'Fit photo');
    stage.scrollLeft = Math.max(0, (stage.scrollWidth - stage.clientWidth) / 2);
    stage.scrollTop = Math.max(0, (stage.scrollHeight - stage.clientHeight) / 2);
  }

  function canSwipe() {
    return isOpen() && state.reportGallery && !state.zoomed && state.sources.length > 1
      && Math.abs((ownerDocument.defaultView?.visualViewport?.scale || 1) - 1) < 0.01;
  }

  function handleTouchStart(event) {
    if (!canSwipe() || event.touches.length !== 1) {
      swipe = null;
      return;
    }
    const touch = event.touches[0];
    swipe = { id: touch.identifier, x: touch.clientX, y: touch.clientY, at: event.timeStamp };
  }

  function handleTouchMove(event) {
    if (!swipe) return;
    const touch = event.touches[0];
    // Never take over a vertical scroll, pinch, or native browser zoom gesture.
    if (!canSwipe() || event.touches.length !== 1 || touch.identifier !== swipe.id
      || Math.abs(touch.clientY - swipe.y) > Math.max(20, Math.abs(touch.clientX - swipe.x))) swipe = null;
  }

  function handleTouchEnd(event) {
    const started = swipe;
    swipe = null;
    if (!started || !canSwipe() || event.touches.length || event.changedTouches.length !== 1) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - started.x;
    const dy = touch.clientY - started.y;
    if (touch.identifier === started.id && event.timeStamp - started.at <= 800
      && Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  }

  function render() {
    const { sources, index, title } = state;
    const count = sources.length;

    resetZoom();
    if (errorMessage) {
      errorMessage.hidden = true;
      setTranslatableText(errorMessage, '');
    }
    if (zoomButton) zoomButton.disabled = true;
    image.src = sources[index] || '';
    if (image.complete && image.naturalWidth) setImageAvailability(true);
    setTranslatableAttribute(image, 'alt', `${title} ${index + 1}`);
    setTranslatableText(
      caption,
      count > 1 ? `${title} ${index + 1} of ${count}` : title
    );
    if (timestamp) {
      const metadata = state.reportGallery ? state.photoMetadata[index] : null;
      const takenAt = metadata?.taken_at || metadata?.last_modified_iso;
      const validTime = takenAt && Number.isFinite(new Date(takenAt).getTime());
      timestamp.hidden = !validTime;
      timestamp.textContent = validTime ? formatDateTime(takenAt) : '';
    }
    previousButton.disabled = count < 2;
    nextButton.disabled = count < 2;
  }

  function open(sources, index = 0, title = 'Photo', options = {}) {
    const cleanSources = Array.isArray(sources) ? sources.filter(Boolean) : [];
    if (!cleanSources.length) return;

    if (!isOpen()) {
      const activeElement = ownerDocument.activeElement;
      restoreFocusTarget = activeElement && !viewer.contains(activeElement)
        ? activeElement
        : null;
    }

    state.sources = cleanSources;
    state.index = Math.min(Math.max(index, 0), cleanSources.length - 1);
    state.title = title;
    state.reportGallery = options.reportGallery === true;
    state.photoMetadata = state.reportGallery && Array.isArray(options.photoMetadata)
      ? sources.flatMap((source, sourceIndex) => source ? [options.photoMetadata[sourceIndex]] : []) : [];
    viewer.classList.toggle('photo-viewer-report-gallery', state.reportGallery);
    if (zoomButton) zoomButton.hidden = !state.reportGallery || !stage;
    if (stage) {
      stage.tabIndex = state.reportGallery ? 0 : -1;
      setTranslatableAttribute(stage, 'aria-label', title);
    }

    render();
    viewer.classList.remove('hidden');
    body.classList.add('viewer-open');
    disableBackgroundInteraction();
    focusElement(closeButton);
  }

  function close({ restoreFocus = true } = {}) {
    resetZoom();
    viewer.classList.add('hidden');
    viewer.classList.remove('photo-viewer-report-gallery');
    body.classList.remove('viewer-open');
    image.removeAttribute('src');
    setTranslatableAttribute(image, 'alt', '');
    setTranslatableText(caption, '');
    state.sources = [];
    state.index = 0;
    state.title = '';
    state.photoMetadata = [];
    if (timestamp) {
      timestamp.hidden = true;
      timestamp.textContent = '';
    }
    state.reportGallery = false;
    if (stage) stage.tabIndex = -1;
    if (zoomButton) zoomButton.hidden = true;
    if (errorMessage) {
      errorMessage.hidden = true;
      setTranslatableText(errorMessage, '');
    }
    previousButton.disabled = true;
    nextButton.disabled = true;
    restoreBackgroundInteraction();

    const focusTarget = restoreFocusTarget;
    restoreFocusTarget = null;
    if (restoreFocus && focusTarget?.isConnected) focusElement(focusTarget);
  }

  function closeForSources(sources, options = {}) {
    if (!Array.isArray(sources) || !sources.some((source) => state.sources.includes(source))) return false;
    close(options);
    return true;
  }

  function step(direction) {
    if (!isOpen()) return;
    const count = state.sources.length;
    if (count < 2) return;

    state.index = (state.index + direction + count) % count;
    render();
  }

  function handleKeydown(event) {
    if (!isOpen()) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      const focusableElements = getFocusableElements();
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeElement = ownerDocument.activeElement;

      if (!firstElement) {
        event.preventDefault();
        focusElement(closeButton);
      } else if (event.shiftKey && (activeElement === firstElement || !viewer.contains(activeElement))) {
        event.preventDefault();
        focusElement(lastElement);
      } else if (!event.shiftKey && (activeElement === lastElement || !viewer.contains(activeElement))) {
        event.preventDefault();
        focusElement(firstElement);
      }
    } else if (event.key === 'ArrowLeft') {
      if (state.zoomed && event.target === stage) return;
      event.preventDefault();
      step(-1);
    } else if (event.key === 'ArrowRight') {
      if (state.zoomed && event.target === stage) return;
      event.preventDefault();
      step(1);
    }
  }

  function handleFocusIn(event) {
    if (!isOpen() || viewer.contains(event.target)) return;

    focusElement(getFocusableElements()[0] || closeButton);
  }

  function renderPreviews(container, dataUrls, alt, metadata = [], options = {}) {
    const urls = Array.isArray(dataUrls) ? dataUrls.filter(Boolean) : [];
    const lightweight = options.lightweight === true;
    if (!urls.length || !lightweight) thumbnailCaches.get(container)?.dispose();
    if (!urls.length) {
      container.classList.add('hidden');
      container.innerHTML = '';
      return;
    }

    container.classList.remove('hidden');
    container.innerHTML = urls
      .map((dataUrl, index) => `
        <button class="photo-thumb" type="button" data-photo-index="${index}">
          <img ${index >= 8 ? 'loading="lazy" ' : ''}decoding="async" ${lightweight ? 'hidden' : `src="${escapeHtml(dataUrl)}"`} alt="${escapeHtml(`${alt} ${index + 1}`)}" />
          ${lightweight ? '<span class="photo-thumb-placeholder"></span>' : ''}
          ${metadata[index]?.takenAtLabel ? `<span class="photo-time">${escapeHtml(metadata[index].takenAtLabel)}</span>` : ''}
        </button>
      `)
      .join('');

    container.querySelectorAll('[data-photo-index]').forEach((button) => {
      if (lightweight) {
        setTranslatableAttribute(button, 'aria-label', `${alt} ${Number(button.dataset.photoIndex || 0) + 1}`);
        button.querySelector('.photo-thumb-placeholder').id = `report-photo-preview-description-${++nextPreviewDescriptionId}`;
      }
      button.addEventListener('click', () => {
        open(urls, Number(button.dataset.photoIndex || 0), alt);
      });
    });

    if (lightweight) {
      let cache = thumbnailCaches.get(container);
      if (!cache) {
        cache = createReportPhotoThumbnailCache();
        thumbnailCaches.set(container, cache);
      }
      const sources = Array.isArray(options.sources) ? options.sources.filter(Boolean) : urls;
      const buttons = [...container.querySelectorAll('[data-photo-index]')];
      cache.update(sources, (source, preview) => {
        sources.forEach((entry, index) => {
          if (entry !== source) return;
          const button = buttons[index];
          if (!button || !container.contains(button)) return;
          const thumbnail = button.querySelector('img');
          const placeholder = button.querySelector('.photo-thumb-placeholder');
          const ready = preview.status === 'ready';
          const unavailable = preview.status === 'unavailable';
          button.classList.toggle('photo-thumb-preview-failed', unavailable);
          // The image's alt is hidden while pending or unavailable. Keep a
          // numbered accessible button name and describe the fallback separately.
          if (ready) button.removeAttribute('aria-describedby');
          else button.setAttribute('aria-describedby', placeholder.id);
          thumbnail.hidden = !ready;
          placeholder.hidden = ready;
          if (ready) thumbnail.src = preview.url;
          else setTranslatableText(placeholder, unavailable
            ? 'Preview unavailable. Tap to open original.' : 'Preparing preview…');
        });
      });
    }
  }

  function renderPreview(container, dataUrl, alt, metadata = []) {
    renderPreviews(container, dataUrl ? [dataUrl] : [], alt, metadata);
  }

  function bindEvents() {
    if (bound) return;
    bound = true;

    closeButton.addEventListener('click', close);
    previousButton.addEventListener('click', () => step(-1));
    nextButton.addEventListener('click', () => step(1));
    zoomButton?.addEventListener('click', toggleZoom);
    image.addEventListener('load', () => { if (isOpen()) setImageAvailability(true); });
    image.addEventListener('error', () => { if (isOpen()) setImageAvailability(false); });
    stage?.addEventListener('touchstart', handleTouchStart, { passive: true });
    stage?.addEventListener('touchmove', handleTouchMove, { passive: true });
    stage?.addEventListener('touchend', handleTouchEnd, { passive: true });
    stage?.addEventListener('touchcancel', () => { swipe = null; }, { passive: true });
    ownerDocument.defaultView?.addEventListener('resize', () => {
      if (isOpen() && state.zoomed) resetZoom();
    });
    viewer.addEventListener('click', (event) => {
      if (event.target.matches('[data-photo-viewer-close]')) {
        close();
      }
    });
    ownerDocument.addEventListener('keydown', handleKeydown);
    ownerDocument.addEventListener('focusin', handleFocusIn);
  }

  return {
    bindEvents,
    close,
    closeForSources,
    open,
    renderPreview,
    renderPreviews,
    step
  };
}
