const MAX_THUMBNAIL_EDGE = 320;

function aborted() {
  return new DOMException('Thumbnail no longer needed', 'AbortError');
}

function loadImage(source, signal) {
  return new Promise((resolve, reject) => {
    const image = document.createElement('img');
    const ownedUrl = source instanceof Blob ? URL.createObjectURL(source) : null;
    let settled = false;
    const release = () => {
      image.removeAttribute('src');
      if (ownedUrl) URL.revokeObjectURL(ownedUrl);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener('abort', cancel);
      if (error) {
        release();
        reject(error);
      } else {
        resolve({ image, width: image.naturalWidth, height: image.naturalHeight, release });
      }
    };
    const cancel = () => finish(aborted());
    image.decoding = 'async';
    image.onload = () => finish(image.naturalWidth && image.naturalHeight ? null : new Error('Empty image'));
    image.onerror = () => finish(new Error('Image preview unavailable'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    else image.src = ownedUrl || source;
  });
}

async function decodeImage(source, signal) {
  if (source instanceof Blob && typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(source);
      if (signal.aborted) {
        bitmap.close();
        throw aborted();
      }
      return { image: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch (error) {
      if (signal.aborted) throw error;
      // Some supported browser/image combinations need the ordinary image decoder.
    }
  }
  return loadImage(source, signal);
}

async function createThumbnail(source, signal) {
  const decoded = await decodeImage(source, signal);
  const canvas = document.createElement('canvas');
  try {
    if (signal.aborted) throw aborted();
    const scale = Math.min(1, MAX_THUMBNAIL_EDGE / Math.max(decoded.width, decoded.height));
    canvas.width = Math.max(1, Math.round(decoded.width * scale));
    canvas.height = Math.max(1, Math.round(decoded.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image preview unavailable');
    context.drawImage(decoded.image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.8));
    if (signal.aborted) throw aborted();
    if (!blob?.size) throw new Error('Image preview unavailable');
    return URL.createObjectURL(blob);
  } finally {
    decoded.release();
    canvas.width = 0;
    canvas.height = 0;
  }
}

// Transient display copies only: never replace the original evidence or store
// these URLs in a draft. At most one source is decoded at a time per gallery.
export function createReportPhotoThumbnailCache() {
  const entries = new Map();
  let listener = null;
  let running = false;
  let active = null;

  function notify(source, entry) {
    if (entries.get(source) !== entry) return;
    try {
      listener?.(source, { status: entry.status, url: entry.url });
    } catch {
      // A detached preview must never interfere with evidence capture or saving.
    }
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      while (true) {
        const next = [...entries].find(([, entry]) => entry.status === 'pending');
        if (!next) break;
        const [source, entry] = next;
        const controller = new AbortController();
        entry.status = 'preparing';
        active = { entry, controller };
        try {
          const url = await createThumbnail(source, controller.signal);
          if (entries.get(source) === entry) {
            entry.url = url;
            entry.status = 'ready';
            notify(source, entry);
          } else {
            URL.revokeObjectURL(url);
          }
        } catch {
          if (entries.get(source) === entry) {
            entry.status = 'unavailable';
            notify(source, entry);
          }
        } finally {
          active = null;
        }
      }
    } finally {
      running = false;
    }
  }

  function update(sources, onChange) {
    const wanted = new Set((Array.isArray(sources) ? sources : []).filter(Boolean));
    listener = onChange || null;
    for (const [source, entry] of entries) {
      if (wanted.has(source)) continue;
      entries.delete(source);
      if (active?.entry === entry) active.controller.abort();
      if (entry.url) URL.revokeObjectURL(entry.url);
    }
    for (const source of wanted) {
      if (!entries.has(source)) entries.set(source, { status: 'pending', url: '' });
      notify(source, entries.get(source));
    }
    void pump();
  }

  return { update, dispose: () => update([], null) };
}
