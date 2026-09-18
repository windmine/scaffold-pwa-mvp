import { dataUrlToBlob } from './utils.js';

// Original evidence stays as immutable Blobs in IndexedDB. Object URLs belong
// only to the currently displayed surface and must never be persisted.
export function reportPhotoSources(record) {
  if (Array.isArray(record?.photoBlobs) && record.photoBlobs.length) return [...record.photoBlobs];
  if (Array.isArray(record?.photoDataUrls) && record.photoDataUrls.length) return record.photoDataUrls.filter(Boolean);
  if (record?.photoDataUrl) return [record.photoDataUrl];
  const urls = Array.isArray(record?.photoUrls) ? [...record.photoUrls] : [];
  if (record?.photoUrl && !urls.includes(record.photoUrl)) urls.unshift(record.photoUrl);
  return urls.filter(Boolean);
}

export function restoreReportPhotoEvidence(record) {
  if (Array.isArray(record?.photoBlobs) && record.photoBlobs.length) return record;
  const legacySources = Array.isArray(record?.photoDataUrls)
    ? record.photoDataUrls.filter(Boolean) : (record?.photoDataUrl ? [record.photoDataUrl] : []);
  if (!legacySources.length) return record;
  // A restored legacy draft is normalized in memory only. Its old durable copy
  // remains intact until the ordinary draft save succeeds. Never re-encode.
  const photoBlobs = [];
  for (const source of legacySources) photoBlobs.push(dataUrlToBlob(source));
  return { ...record, photoBlobs, photoDataUrls: [], photoDataUrl: '' };
}

export function createPhotoPreviewSources(sources) {
  const ownedUrls = [];
  const dispose = () => {
    for (const url of ownedUrls.splice(0)) URL.revokeObjectURL(url);
  };
  try {
    const urls = (Array.isArray(sources) ? sources : []).filter(Boolean).map((source) => {
      if (!(source instanceof Blob)) return source;
      const url = URL.createObjectURL(source);
      ownedUrls.push(url);
      return url;
    });
    return { urls, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
