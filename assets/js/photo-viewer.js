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
  const state = {
    sources: [],
    index: 0,
    title: ''
  };

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

    state.sources = cleanSources;
    state.index = Math.min(Math.max(index, 0), cleanSources.length - 1);
    state.title = title;

    render();
    viewer.classList.remove('hidden');
    body.classList.add('viewer-open');
    closeButton.focus();
  }

  function close() {
    viewer.classList.add('hidden');
    body.classList.remove('viewer-open');
    image.src = '';
  }

  function step(direction) {
    const count = state.sources.length;
    if (count < 2) return;

    state.index = (state.index + direction + count) % count;
    render();
  }

  function handleKeydown(event) {
    if (viewer.classList.contains('hidden')) return;

    if (event.key === 'Escape') {
      close();
    } else if (event.key === 'ArrowLeft') {
      step(-1);
    } else if (event.key === 'ArrowRight') {
      step(1);
    }
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
    closeButton.addEventListener('click', close);
    previousButton.addEventListener('click', () => step(-1));
    nextButton.addEventListener('click', () => step(1));
    viewer.addEventListener('click', (event) => {
      if (event.target.matches('[data-photo-viewer-close]')) {
        close();
      }
    });
    document.addEventListener('keydown', handleKeydown);
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
