import { setTranslatableAttribute, setTranslatableText } from './i18n.js';
import { createReportPhotoThumbnailCache } from './report-photo-thumbnails.js';
import { escapeHtml } from './utils.js';

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
    title: ''
  };
  const inertBackground = new Map();
  const thumbnailCaches = new WeakMap();
  let bound = false;
  let restoreFocusTarget = null;

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

  function render() {
    const { sources, index, title } = state;
    const count = sources.length;

    image.src = sources[index] || '';
    setTranslatableAttribute(image, 'alt', `${title} ${index + 1}`);
    setTranslatableText(
      caption,
      count > 1 ? `${title} ${index + 1} of ${count}` : title
    );
    previousButton.disabled = count < 2;
    nextButton.disabled = count < 2;
  }

  function open(sources, index = 0, title = 'Photo') {
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

    render();
    viewer.classList.remove('hidden');
    body.classList.add('viewer-open');
    disableBackgroundInteraction();
    focusElement(closeButton);
  }

  function close({ restoreFocus = true } = {}) {
    viewer.classList.add('hidden');
    body.classList.remove('viewer-open');
    image.removeAttribute('src');
    setTranslatableAttribute(image, 'alt', '');
    setTranslatableText(caption, '');
    state.sources = [];
    state.index = 0;
    state.title = '';
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
      event.preventDefault();
      step(-1);
    } else if (event.key === 'ArrowRight') {
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
