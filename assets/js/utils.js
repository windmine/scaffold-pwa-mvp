export function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export const ATTENDANCE_LOCATION_MAX_AGE_MS = 5 * 60 * 1000;
export const MAX_UPLOAD_IMAGE_BYTES = 5 * 1024 * 1024;
export const UPLOAD_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function attendanceLocationIssue(location, workerId, now = Date.now()) {
  if (!location) return 'missing';
  if (workerId == null || String(location.ownerWorkerId || '') !== String(workerId)) return 'owner_mismatch';

  const capturedAt = new Date(location.capturedAt).getTime();
  if (!Number.isFinite(capturedAt)) return 'invalid_time';

  const ageMs = Number(now) - capturedAt;
  if (ageMs < -60 * 1000) return 'invalid_time';
  if (ageMs > ATTENDANCE_LOCATION_MAX_AGE_MS) return 'stale';
  return '';
}

export function uploadImageValidationError(file) {
  if (!file) return '';

  const type = String(file.type || '').toLowerCase();
  if (!UPLOAD_IMAGE_TYPES.has(type)) {
    return `${file.name || 'This photo'} must be a JPEG, PNG, or WebP image.`;
  }

  const size = Number(file.size || 0);
  if (!Number.isFinite(size) || size > MAX_UPLOAD_IMAGE_BYTES) {
    return `${file.name || 'This photo'} is larger than the 5 MB upload limit.`;
  }

  return '';
}

export function todayDateInput() {
  return dateInputValue(new Date());
}

export function dateInputValue(value) {
  if (!value) return '';

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  return new Intl.DateTimeFormat('en-NZ', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

export function roundCoordinate(value, decimalPlaces = 6) {
  const coordinate = Number(value);
  if (!Number.isFinite(coordinate)) return coordinate;
  return Number(coordinate.toFixed(decimalPlaces));
}

export function formatPhotoTakenLabel(file) {
  if (!file?.lastModified) return '';

  const date = new Date(file.lastModified);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('en-NZ', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

export function photoMetadataFromFile(file) {
  const takenAt = file?.lastModified ? new Date(file.lastModified) : null;
  const isValidDate = takenAt && !Number.isNaN(takenAt.getTime());

  return {
    name: file?.name || '',
    size: file?.size || 0,
    type: file?.type || '',
    last_modified: file?.lastModified || null,
    last_modified_iso: isValidDate ? takenAt.toISOString() : '',
    taken_at: isValidDate ? takenAt.toISOString() : '',
    taken_at_source: isValidDate ? 'file_last_modified' : '',
    takenAtLabel: formatPhotoTakenLabel(file)
  };
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function dataUrlToBlob(dataUrl) {
  const [header, payload] = String(dataUrl || '').split(',');
  const contentType = header.match(/data:(.*?);base64/)?.[1] || 'application/octet-stream';
  const binary = atob(payload || '');
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: contentType });
}
