import { setTranslatableAttribute, setTranslatableText } from './i18n.js';
import { formatDateTime } from './utils.js';

const PREVIEW_LIMIT = 6;

// Display only: the complete, ordered originals remain owned by the Report.
// The caller owns Blob URLs and disposes this gallery when its record changes.
export function mountReportPhotoGallery(container, { sources, metadata = [], title, photoViewer, isCurrent }) {
  let active = true;
  const originals = [...sources];
  const current = () => active && container.isConnected && isCurrent();
  const open = (index) => {
    if (current()) photoViewer.open(originals, index, title, { reportGallery: true, photoMetadata: metadata });
  };
  const header = document.createElement('div');
  header.className = 'report-photo-gallery-header';
  const count = document.createElement('p');
  count.className = 'report-photo-gallery-count';
  setTranslatableText(count, `${originals.length} photos`);
  header.append(count);
  if (originals.length > PREVIEW_LIMIT) {
    const viewAll = document.createElement('button');
    viewAll.type = 'button';
    viewAll.className = 'ghost report-photo-gallery-open';
    setTranslatableText(viewAll, `View all ${originals.length} photos`);
    viewAll.addEventListener('click', () => open(0));
    header.append(viewAll);
  }
  const grid = document.createElement('div');
  grid.className = 'record-photos';
  originals.slice(0, PREVIEW_LIMIT).forEach((source, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'photo-thumb';
    button.dataset.photoIndex = String(index);
    setTranslatableAttribute(button, 'aria-label', `Open photo ${index + 1} of ${originals.length}`);
    const image = document.createElement('img');
    image.alt = '';
    image.decoding = 'async';
    const unavailable = document.createElement('span');
    unavailable.className = 'report-photo-gallery-unavailable';
    unavailable.hidden = true;
    setTranslatableText(unavailable, 'Preview unavailable. Tap to open original.');
    image.addEventListener('error', () => {
      if (!current()) return;
      image.hidden = true;
      unavailable.hidden = false;
      setTranslatableAttribute(button, 'aria-label', `Photo ${index + 1} of ${originals.length}. Preview unavailable. Open original.`);
    });
    image.src = source;
    button.append(image, unavailable);
    const takenAt = metadata[index]?.taken_at || metadata[index]?.last_modified_iso;
    if (takenAt) {
      const time = document.createElement('span');
      time.className = 'photo-time';
      time.textContent = formatDateTime(takenAt);
      button.append(time);
    }
    button.addEventListener('click', () => open(index));
    grid.append(button);
  });
  container.append(header, grid);
  return () => {
    active = false;
    grid.querySelectorAll('img').forEach((image) => image.removeAttribute('src'));
    container.replaceChildren();
  };
}
