import { dataUrlToBlob, MAX_UPLOAD_IMAGE_BYTES, UPLOAD_IMAGE_TYPES } from './utils.js';

const MAX_REPORT_PHOTOS = 50;
const UNSAFE_RECOVERY_MESSAGE = 'This saved Report cannot be recovered safely. The original copy is unchanged.';

function recoveryError(message, code = 'REPORT_RECOVERY_UNAVAILABLE', status) {
  return Object.assign(new Error(message), { code, ...(status ? { status } : {}) });
}

function positiveId(value) {
  return /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
}

function boundedKey(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 120 && value.trim() === value;
}

function answerObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function clientSubmissionIdFor(record) {
  const value = record.clientSubmissionId ?? record.client_submission_id ?? record.id;
  if (!boundedKey(value) || (record.clientSubmissionId != null && record.client_submission_id != null
    && record.clientSubmissionId !== record.client_submission_id)) return '';
  return value;
}

function validFields(fields) {
  if (!Array.isArray(fields)) return false;
  const ids = new Set();
  return fields.every((field) => {
    if (!answerObject(field) || typeof field.id !== 'string' || !field.id.trim()
      || typeof field.type !== 'string' || !field.type.trim() || ids.has(field.id)
      || (field.repeat != null && typeof field.repeat !== 'string')) return false;
    ids.add(field.id);
    return true;
  });
}

export function isRecoverableQueuedReport(record, worker) {
  return worker?.role === 'worker' && positiveId(worker.id) && positiveId(worker.departmentId)
    && record?.type === 'form'
    && (record.submissionPurpose || record.submission_purpose) === 'report'
    && positiveId(record.formId)
    && String(record.ownerWorkerId ?? record.userId) === String(worker.id)
    && (record.departmentId == null || String(record.departmentId) === String(worker.departmentId))
    && (record.department_id == null || String(record.department_id) === String(worker.departmentId))
    && record.syncStatus === 'queued' && !record.backendRecordId && !record.isDraftRecovery
    && Boolean(record.syncError || Number(record.retryCount) > 0);
}

export function reportRecoveryDraftKey(record, worker) {
  const sourceId = record?.id;
  if (!boundedKey(sourceId) || !positiveId(worker?.id) || !positiveId(worker?.departmentId)) {
    throw recoveryError(UNSAFE_RECOVERY_MESSAGE);
  }
  return `work-form-recovery:${worker.id}:${worker.departmentId}:${sourceId}`;
}

export function validateReportRecoveryLookup(result, record, worker) {
  const clientId = clientSubmissionIdFor(record);
  if (!clientId || clientId.length > 120 || !result || result.client_submission_id !== clientId
    || String(result.worker_id) !== String(worker.id) || String(result.department_id) !== String(worker.departmentId)
    || !['not_found', 'submitted', 'deleted'].includes(result.status)) {
    throw recoveryError('Could not confirm whether this Report was submitted. Your saved copy is unchanged.');
  }
  if (result.status === 'submitted') {
    const saved = result.submission;
    if (!saved || !positiveId(saved.id) || String(saved.worker_id) !== String(worker.id)
      || saved.client_submission_id !== clientId || saved.submission_purpose !== 'report'
      || String(saved.form_id) !== String(record.formId)) {
      throw recoveryError('Could not confirm whether this Report was submitted. Your saved copy is unchanged.');
    }
  } else if (result.submission !== null) {
    throw recoveryError('Could not confirm whether this Report was submitted. Your saved copy is unchanged.');
  }
  return result;
}

async function downloadEvidence(source, assertCurrent) {
  let url;
  try { url = new URL(source, window.location.href); } catch { /* Fail closed below. */ }
  if (!url || url.origin !== window.location.origin || !/^\/uploads\/[^/]+$/.test(url.pathname)
    || url.search || url.hash || url.username || url.password) {
    throw recoveryError('A saved evidence link cannot be recovered safely. The original copy is unchanged.');
  }
  assertCurrent();
  let response;
  try {
    response = await fetch(url.href, { credentials: 'include', cache: 'no-store', redirect: 'error' });
  } catch {
    throw recoveryError('Could not download saved evidence. Reconnect and try Recover as draft again.');
  }
  assertCurrent();
  if (!response.ok) {
    throw recoveryError('Could not download saved evidence. Your original copy is unchanged.',
      [404, 410].includes(response.status) ? 'REPORT_RECOVERY_MISSING_PHOTO' : 'REPORT_RECOVERY_UNAVAILABLE', response.status);
  }
  const blob = await response.blob();
  assertCurrent();
  return blob;
}

function asLocalBlob(source) {
  if (source instanceof Blob) return source;
  if (typeof source === 'string' && /^data:image\//i.test(source)) {
    if (source.length > Math.ceil(MAX_UPLOAD_IMAGE_BYTES * 4 / 3) + 256) {
      throw recoveryError('File exceeds 5 MB.', 'REPORT_RECOVERY_INVALID_PHOTO');
    }
    try { return dataUrlToBlob(source); } catch { /* Invalid local evidence, not a network failure. */ }
  }
  throw recoveryError('Photo is missing or unreadable.', 'REPORT_RECOVERY_INVALID_PHOTO');
}

function rasterHeaderIssue(bytes) {
  const hasBytes = (offset, expected) => expected.every((value, index) => bytes[offset + index] === value);
  const chunkName = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const unreadable = 'Photo is empty or unreadable.';
  const animated = 'Animated images are not supported.';
  const isPng = hasBytes(0, [137, 80, 78, 71, 13, 10, 26, 10]);
  const isJpeg = hasBytes(0, [255, 216, 255]);
  const isWebp = hasBytes(0, [82, 73, 70, 70]) && hasBytes(8, [87, 69, 66, 80]);
  if (isPng) {
    let seenImageData = false, frameControls = 0;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const size = view.getUint32(offset), name = chunkName(offset + 4);
      if (size > bytes.length - offset - 12) return unreadable;
      if (offset === 8 && (name !== 'IHDR' || size !== 13)) return unreadable;
      if (name === 'acTL') {
        if (size !== 8 || !view.getUint32(offset + 8)) return unreadable;
        if (view.getUint32(offset + 8) > 1) return animated;
      }
      if (name === 'fcTL') {
        if (size !== 26) return unreadable;
        // A separate default image adds a frame, even when acTL declares only
        // one animated frame. A genuinely one-frame APNG remains valid.
        if (seenImageData || ++frameControls > 1) return animated;
      }
      if (name === 'IDAT') seenImageData = true;
      if (name === 'IEND') return size === 0 && seenImageData ? '' : unreadable;
      offset += size + 12;
    }
    return unreadable;
  }
  if (isWebp) {
    if (bytes.length < 12) return unreadable;
    const end = view.getUint32(4, true) + 8;
    if (end > bytes.length || end < 12) return unreadable;
    let frames = 0, animatedContainer = false;
    for (let offset = 12; offset < end;) {
      if (offset + 8 > end) return unreadable;
      const size = view.getUint32(offset + 4, true), name = chunkName(offset);
      if (size > end - offset - 8 || size + (size % 2) > end - offset - 8) return unreadable;
      if (name === 'VP8X') {
        if (size !== 10) return unreadable;
        animatedContainer ||= Boolean(bytes[offset + 8] & 2);
      }
      if (name === 'ANIM') animatedContainer = true;
      if (name === 'ANMF' && ++frames > 1) return animated;
      offset += size + 8 + size % 2;
    }
    return animatedContainer && !frames ? unreadable : '';
  }
  if (isJpeg) {
    // JPEG has no animation container. Multi-picture JPEG (MPO) is not an
    // accepted server raster format; inspect marker payloads, not compressed
    // byte strings that can coincidentally resemble an MPF header.
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 255) return unreadable;
      while (bytes[offset] === 255) offset += 1;
      const marker = bytes[offset++];
      if (marker === 218) return '';
      if (marker === 217 || marker === undefined) return unreadable;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) return unreadable;
      const size = view.getUint16(offset);
      if (size < 2 || size > bytes.length - offset) return unreadable;
      if (marker === 226 && size >= 6 && hasBytes(offset + 2, [77, 80, 70, 0])) return 'Multi-picture images are not supported.';
      offset += size;
    }
    return unreadable;
  }
  return 'Use JPEG, PNG, or WebP.';
}

async function validatePhoto(blob) {
  if (!UPLOAD_IMAGE_TYPES.has(String(blob.type || '').toLowerCase())) return 'Use JPEG, PNG, or WebP.';
  if (blob.size > MAX_UPLOAD_IMAGE_BYTES) return 'File exceeds 5 MB.';
  if (!blob.size) return 'Photo is empty or unreadable.';
  const headerIssue = rasterHeaderIssue(new Uint8Array(await blob.arrayBuffer()));
  if (headerIssue) return headerIssue;
  // Decode serially and release each bitmap before the next. Never re-encode
  // originals or retain decoded fifty-photo galleries in the recovery path.
  if (typeof createImageBitmap === 'function') {
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob);
      return bitmap.width > 0 && bitmap.height > 0 ? '' : 'Photo is empty or unreadable.';
    } catch {
      return 'Photo is empty or unreadable.';
    } finally { bitmap?.close(); }
  }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve(image.naturalWidth > 0 && image.naturalHeight > 0 ? '' : 'Photo is empty or unreadable.');
      image.onerror = () => resolve('Photo is empty or unreadable.');
      image.src = url;
    });
  } finally { URL.revokeObjectURL(url); }
}

function blobDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(recoveryError('Could not restore a saved signature. The original copy is unchanged.'));
    reader.readAsDataURL(blob);
  });
}

async function restoreSignatures(fields, answers, assertCurrent) {
  // Only captured signature fields may cause downloads. Ordinary answer text,
  // including URLs, remains literal user data and never becomes a request.
  for (const field of fields) {
    if (field.type !== 'signature') continue;
    if (field.repeat && answers[field.repeat] != null && !Array.isArray(answers[field.repeat])) {
      throw recoveryError('Could not restore a saved signature. The original copy is unchanged.');
    }
    const parents = field.repeat
      ? (Array.isArray(answers[field.repeat]) ? answers[field.repeat] : []) : [answers];
    for (const parent of parents) {
      if (!answerObject(parent)) throw recoveryError('Could not restore a saved signature. The original copy is unchanged.');
      const value = parent?.[field.id];
      if (value == null || value === '') continue;
      if (typeof value !== 'string') throw recoveryError('Could not restore a saved signature. The original copy is unchanged.');
      assertCurrent();
      const local = /^data:image\//i.test(value);
      let blob;
      if (local) {
        try { blob = asLocalBlob(value); }
        catch { throw recoveryError('Could not restore a saved signature. The original copy is unchanged.'); }
      } else blob = await downloadEvidence(value, assertCurrent);
      if (await validatePhoto(blob)) {
        throw recoveryError('Could not restore a saved signature. The original copy is unchanged.');
      }
      assertCurrent();
      // Keep the original captured bytes/string when valid. Only previously
      // uploaded signatures need a data URL for the existing signature editor.
      if (!local) parent[field.id] = await blobDataUrl(blob);
      assertCurrent();
    }
  }
}

export async function prepareReportRecoveryDraft(record, worker, { assertCurrent = () => {} } = {}) {
  const key = reportRecoveryDraftKey(record, worker);
  const clientSubmissionId = clientSubmissionIdFor(record);
  const selectedAnswers = record.capturedAnswers === undefined ? record.answers : record.capturedAnswers;
  if (!clientSubmissionId || !validFields(record.fields) || !answerObject(selectedAnswers)) {
    throw recoveryError(UNSAFE_RECOVERY_MESSAGE);
  }
  const answers = structuredClone(selectedAnswers);
  const fields = structuredClone(record.fields);
  await restoreSignatures(fields, answers, assertCurrent);
  const originals = Array.isArray(record.photoBlobs) && record.photoBlobs.length ? record.photoBlobs
    : Array.isArray(record.photoDataUrls) && record.photoDataUrls.length ? record.photoDataUrls
      : record.photoDataUrl ? [record.photoDataUrl] : [];
  const urls = Array.isArray(record.photoUrls) ? [...record.photoUrls] : [];
  if (record.photoUrl && !urls.includes(record.photoUrl)) urls.unshift(record.photoUrl);
  const photoBlobs = [], photoMetadata = [], omittedPhotos = [];
  for (let index = 0; index < Math.max(originals.length, urls.length); index += 1) {
    assertCurrent();
    const rejectedByServer = record.failedPhotoUpload?.index === index
      && [400, 413, 415, 422].includes(record.failedPhotoUpload.status);
    const serverRejectionReason = 'Photo was rejected by the server. Add a replacement.';
    let blob, reason;
    if (rejectedByServer) reason = serverRejectionReason;
    else if (originals[index]) {
      try { blob = asLocalBlob(originals[index]); reason = await validatePhoto(blob); }
      catch (error) { reason = error.message; }
    } else reason = 'Photo is missing or unreadable.';
    if ((!blob || reason) && urls[index]) {
      try {
        blob = await downloadEvidence(urls[index], assertCurrent);
        reason = await validatePhoto(blob);
        if (reason && rejectedByServer) reason = serverRejectionReason;
      } catch (error) {
        // Only definite missing evidence may be omitted. Network/auth failures
        // must keep the original queue intact instead of losing a valid photo.
        if (error.code !== 'REPORT_RECOVERY_MISSING_PHOTO') throw error;
        reason = rejectedByServer ? serverRejectionReason : 'Photo is no longer available.';
      }
    }
    assertCurrent();
    if (!reason && photoBlobs.length >= MAX_REPORT_PHOTOS) reason = 'Would exceed the 50-photo limit.';
    if (reason) {
      omittedPhotos.push({ index, name: originals[index]?.name || record.photoMetadata?.[index]?.name || `Photo ${index + 1}`, reason });
      continue;
    }
    photoBlobs.push(blob);
    const metadata = { ...(record.photoMetadata?.[index] || {}) };
    delete metadata.url;
    photoMetadata.push(metadata);
  }
  assertCurrent();
  const recoveredAt = new Date().toISOString();
  return { key, value: {
    kind: 'work-form', schemaVersion: 1, ownerWorkerId: worker.id, departmentId: worker.departmentId,
    templatePurpose: 'report', formId: record.formId, formName: record.formName || 'Report',
    definitionVersion: record.definitionVersion ?? null, fields, siteId: record.siteId == null ? '' : String(record.siteId),
    workDate: record.workDate || '', answers, photoBlobs, photoDataUrls: [], photoMetadata, savedAt: recoveredAt,
    uploadRecovery: { sourceRecordId: String(record.id), clientSubmissionId, ownerWorkerId: worker.id,
      departmentId: worker.departmentId, formId: record.formId, recoveredAt, omittedPhotos }
  }, updatedAt: recoveredAt };
}
