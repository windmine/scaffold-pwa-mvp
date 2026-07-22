import { escapeHtml } from './utils.js';

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
    image.alt = `${title} ${index + 1}`;
    caption.textContent = count > 1
      ? `${title} ${index + 1} of ${count}`
      : title;
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

  function close() {
    if (!isOpen()) return;

    viewer.classList.add('hidden');
    body.classList.remove('viewer-open');
    image.src = '';
    restoreBackgroundInteraction();

    const focusTarget = restoreFocusTarget;
    restoreFocusTarget = null;
    if (focusTarget?.isConnected) focusElement(focusTarget);
  }

  function step(direction) {
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

  function renderPreviews(container, dataUrls, alt, metadata = []) {
    const urls = Array.isArray(dataUrls) ? dataUrls.filter(Boolean) : [];
    if (!urls.length) {
      container.classList.add('hidden');
      container.innerHTML = '';
      return;
    }

    container.classList.remove('hidden');
    container.innerHTML = urls
      .map((dataUrl, index) => `
        <button class="photo-thumb" type="button" data-photo-index="${index}">
          <img src="${dataUrl}" alt="${escapeHtml(`${alt} ${index + 1}`)}" />
          ${metadata[index]?.takenAtLabel ? `<span class="photo-time">${escapeHtml(metadata[index].takenAtLabel)}</span>` : ''}
        </button>
      `)
      .join('');

    container.querySelectorAll('[data-photo-index]').forEach((button) => {
      button.addEventListener('click', () => {
        open(urls, Number(button.dataset.photoIndex || 0), alt);
      });
    });
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
    open,
    renderPreview,
    renderPreviews,
    step
  };
}
