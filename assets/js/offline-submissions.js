import {
  createAttendance as createBackendAttendance,
  createTaskLog as createBackendTaskLog,
  createFormSubmission as createBackendFormSubmission,
  uploadPhoto
} from './api-client.js';
import { get, getAll, put, remove } from './db.js';
import { dataUrlToBlob, uuid } from './utils.js';

const SUBMISSION_DRAFT_KEYS = {
  attendance: 'attendance-form',
  task: 'task-form'
};

const QUEUED_SYNC_STATUSES = new Set(['queued', 'syncing']);
const STALE_SYNCING_AFTER_MS = 2 * 60 * 1000;

let syncQueuePromise = null;

function isAuthError(error) {
  return error?.status === 401 || error?.status === 403;
}

function nowIso() {
  return new Date().toISOString();
}

export function normaliseRecordPhotoUrls(record) {
  const urls = Array.isArray(record.photoUrls) ? [...record.photoUrls] : [];
  if (record.photoUrl && !urls.includes(record.photoUrl)) {
    urls.unshift(record.photoUrl);
  }
  return urls.filter(Boolean);
}

export function normaliseRecordPhotoMetadata(record) {
  const photoUrls = normaliseRecordPhotoUrls(record);
  const metadata = Array.isArray(record.photoMetadata) ? record.photoMetadata : [];

  return photoUrls.map((url, index) => ({
    ...(metadata[index] || {}),
    url
  }));
}

function photoFilenameFor(record, file, index = 0, dataUrl = '') {
  if (file?.name) return file.name;
  const extension = (dataUrl || record.photoDataUrl || '').match(/^data:image\/([a-z0-9+.-]+);base64,/i)?.[1] || 'jpg';
  const suffix = index ? `-${index + 1}` : '';
  return `${record.type || 'record'}-${record.id || uuid()}${suffix}.${extension.replace('jpeg', 'jpg')}`;
}

async function uploadRecordPhotos(record, files = [], options = {}) {
  const fileList = Array.from(files || []);
  const dataUrls = Array.isArray(record.photoDataUrls)
    ? record.photoDataUrls.filter(Boolean)
    : (record.photoDataUrl ? [record.photoDataUrl] : []);

  const sources = fileList.length
    ? fileList.map((file, index) => ({
      source: file,
      file,
      dataUrl: dataUrls[index] || ''
    }))
    : dataUrls.map((dataUrl) => ({
      source: dataUrlToBlob(dataUrl),
      file: null,
      dataUrl
    }));

  const uploadedUrls = normaliseRecordPhotoUrls(record);
  if (!sources.length || uploadedUrls.length >= sources.length) {
    record.photoUrls = uploadedUrls;
    record.photoUrl = uploadedUrls[0] || '';
    return uploadedUrls;
  }

  for (const [index, item] of sources.entries()) {
    if (uploadedUrls[index]) continue;

    const uploaded = await uploadPhoto(item.source, photoFilenameFor(record, item.file, index, item.dataUrl));
    uploadedUrls[index] = uploaded.url;
    record.photoUrls = uploadedUrls.filter(Boolean);
    record.photoUrl = record.photoUrls[0] || '';
    if (Array.isArray(record.photoMetadata)) {
      record.photoMetadata[index] = {
        ...(record.photoMetadata[index] || {}),
        url: uploaded.url
      };
    }
    await options.onProgress?.(record);
  }

  record.photoUrls = uploadedUrls.filter(Boolean);
  record.photoUrl = uploadedUrls[0] || '';
  return record.photoUrls;
}

async function uploadRecordPhoto(record, file = null, options = {}) {
  const urls = await uploadRecordPhotos(record, file ? [file] : [], options);
  return urls[0] || null;
}

function isSignatureDataUrl(value) {
  return typeof value === 'string' && value.startsWith('data:image/');
}

async function uploadSignatureAnswers(record, options = {}) {
  if (!record.answers || !record.fields?.length) return record.answers || {};

  const answers = { ...record.answers };
  const signatureFields = record.fields.filter((field) => field.type === 'signature');

  for (const field of signatureFields) {
    const value = answers[field.id];
    if (!isSignatureDataUrl(value)) continue;

    const uploaded = await uploadPhoto(
      dataUrlToBlob(value),
      `signature-${record.userId || 'worker'}-${record.formId || 'form'}-${field.id}-${record.id || Date.now()}.png`
    );
    answers[field.id] = uploaded.url;
    record.answers = answers;
    await options.onProgress?.(record);
  }

  record.answers = answers;
  return answers;
}

function getBackendSiteId(siteId) {
  if (!siteId) return null;

  const directId = Number(siteId);
  return Number.isInteger(directId) ? directId : null;
}

function toBackendAttendancePayload(record) {
  return {
    record_type: record.action,
    latitude: record.location.latitude,
    longitude: record.location.longitude,
    accuracy: record.location.accuracy,
    site_id: getBackendSiteId(record.siteId),
    note: record.notes || null,
    photo_url: record.photoUrl || null,
    client_submission_id: record.clientSubmissionId || record.id
  };
}

function toBackendTaskLogPayload(record) {
  const photoUrls = normaliseRecordPhotoUrls(record);

  return {
    description: record.summary,
    site_id: getBackendSiteId(record.siteId),
    work_date: record.workDate || null,
    hours_worked: record.hoursWorked ? Number(record.hoursWorked) : null,
    safety_notes: record.safetyNotes || null,
    photo_url: photoUrls[0] || null,
    photo_urls: photoUrls,
    client_submission_id: record.clientSubmissionId || record.id
  };
}

function toBackendFormSubmissionPayload(record) {
  return {
    form_id: Number(record.formId),
    site_id: getBackendSiteId(record.siteId),
    work_date: record.workDate || null,
    answers: record.answers || {},
    photo_urls: normaliseRecordPhotoUrls(record),
    photo_metadata: normaliseRecordPhotoMetadata(record),
    client_submission_id: record.clientSubmissionId || record.id
  };
}

function normaliseLocalSubmission(record) {
  const createdAt = record.createdAt || new Date().toISOString();
  const id = record.id || uuid();

  return {
    photoDataUrl: '',
    photoDataUrls: [],
    photoMetadata: [],
    photoUrl: '',
    photoUrls: [],
    ...record,
    syncStatus: record.syncStatus || 'queued',
    syncError: record.syncError || '',
    syncStartedAt: record.syncStartedAt || '',
    lastSyncAttemptAt: record.lastSyncAttemptAt || '',
    retryCount: record.retryCount || 0,
    syncBlockedByAuth: Boolean(record.syncBlockedByAuth),
    syncedAt: record.syncedAt || '',
    backendRecordId: record.backendRecordId || null,
    status: record.status || 'pending',
    createdAt,
    id,
    clientSubmissionId: record.clientSubmissionId || record.client_submission_id || id
  };
}

function markQueued(record, error = null) {
  record.syncStatus = 'queued';
  record.syncStartedAt = '';
  record.syncBlockedByAuth = false;

  if (error) {
    record.syncError = error.message || 'Sync failed';
    record.lastSyncAttemptAt = nowIso();
    record.retryCount = Number(record.retryCount || 0) + 1;
  } else {
    record.syncError = record.syncError || '';
  }
}

function markSyncing(record) {
  record.syncStatus = 'syncing';
  record.syncError = '';
  record.syncStartedAt = nowIso();
  record.lastSyncAttemptAt = record.syncStartedAt;
  record.syncBlockedByAuth = false;
}

function markAuthBlocked(record, error) {
  record.syncStatus = 'queued';
  record.syncStartedAt = '';
  record.syncBlockedByAuth = true;
  record.syncError = error?.message || 'Sign in again to sync queued submissions.';
  record.lastSyncAttemptAt = nowIso();
  record.retryCount = Number(record.retryCount || 0) + 1;
}

function isStaleSyncingRecord(record) {
  if (record.syncStatus !== 'syncing') return true;
  if (!record.syncStartedAt) return true;

  const startedAt = new Date(record.syncStartedAt).getTime();
  return Number.isNaN(startedAt) || Date.now() - startedAt > STALE_SYNCING_AFTER_MS;
}

function applySyncedResponse(record, syncedRecord) {
  record.syncStatus = 'synced';
  record.syncError = '';
  record.syncStartedAt = '';
  record.syncBlockedByAuth = false;
  record.syncedAt = new Date().toISOString();

  if (syncedRecord?.id) {
    record.backendRecordId = syncedRecord.id;
  }
  if (syncedRecord?.client_submission_id) {
    record.clientSubmissionId = syncedRecord.client_submission_id;
  }
  if (syncedRecord?.status) {
    record.status = syncedRecord.status;
  }
  if (syncedRecord?.distance_from_site_m != null) {
    record.distanceFromSiteM = syncedRecord.distance_from_site_m;
  }
  if (syncedRecord?.within_site_radius != null) {
    record.withinSiteRadius = syncedRecord.within_site_radius;
  }
  if (syncedRecord?.photo_url) {
    record.photoUrl = syncedRecord.photo_url;
  }
  if (syncedRecord?.photo_urls) {
    record.photoUrls = syncedRecord.photo_urls;
    record.photoUrl = syncedRecord.photo_urls[0] || record.photoUrl || '';
  }
  if (syncedRecord?.photo_metadata) {
    record.photoMetadata = syncedRecord.photo_metadata;
  }
  if (syncedRecord?.answers) {
    record.answers = syncedRecord.answers;
  }
  if (syncedRecord?.fields) {
    record.fields = syncedRecord.fields;
  }

  return record;
}

async function persistLocalSubmission(record) {
  await put('records', record);

  if (QUEUED_SYNC_STATUSES.has(record.syncStatus) && !record.backendRecordId) {
    await put('queue', {
      id: record.id,
      kind: record.type,
      createdAt: record.createdAt,
      syncStartedAt: record.syncStartedAt || ''
    });
  } else {
    await remove('queue', record.id);
  }

  return record;
}

async function clearSubmissionDraft(draftKey) {
  await remove('drafts', draftKey);
}

async function syncSubmission(record, options = {}) {
  if (record.backendRecordId) {
    return {
      id: record.backendRecordId,
      status: record.status,
      photo_url: record.photoUrl || null,
      photo_urls: normaliseRecordPhotoUrls(record),
      photo_metadata: normaliseRecordPhotoMetadata(record),
      answers: record.answers,
      client_submission_id: record.clientSubmissionId || record.id
    };
  }

  const uploadOptions = {
    onProgress: options.onProgress
  };

  if (record.type === 'attendance') {
    await uploadRecordPhoto(record, options.photoFiles?.[0] || null, uploadOptions);
    return await createBackendAttendance(toBackendAttendancePayload(record));
  }

  if (record.type === 'task') {
    await uploadRecordPhotos(record, options.photoFiles || [], uploadOptions);
    return await createBackendTaskLog(toBackendTaskLogPayload(record));
  }

  if (record.type === 'form') {
    await uploadSignatureAnswers(record, uploadOptions);
    await uploadRecordPhotos(record, options.photoFiles || [], uploadOptions);
    return await createBackendFormSubmission(toBackendFormSubmissionPayload(record));
  }

  throw new Error('Unsupported queued record type.');
}

function syncedSubmissionMessage(record) {
  if (record.type === 'attendance') {
    const label = record.action === 'check_in' ? 'Check in' : 'Check out';
    return record.status === 'approved'
      ? `${label} saved to the backend and approved automatically.`
      : `${label} saved to the backend for supervisor review.`;
  }

  if (record.type === 'task') return 'Task log submitted for approval.';
  if (record.type === 'form') return `${record.formName || 'Form'} submitted for approval.`;
  return 'Submission synced.';
}

function queuedSubmissionMessage(record, retry = false) {
  if (record.type === 'attendance') {
    const label = record.action === 'check_in' ? 'Check in' : 'Check out';
    return retry
      ? `${label} saved locally. Backend sync will retry when you reconnect.`
      : `${label} saved offline and queued for later sync.`;
  }

  if (record.type === 'task') {
    return retry
      ? 'Task log saved locally. Backend sync will retry when you reconnect.'
      : 'Task log saved offline and queued for later sync.';
  }

  if (record.type === 'form') {
    const label = record.formName || 'Form';
    return retry
      ? `${label} saved locally. Backend sync will retry when you reconnect.`
      : `${label} saved offline and queued for later sync.`;
  }

  return retry
    ? 'Submission saved locally. Backend sync will retry when you reconnect.'
    : 'Submission saved offline and queued for later sync.';
}

export async function submitOfflineSubmission(record, options = {}) {
  const localRecord = normaliseLocalSubmission(record);
  const draftKey = options.draftKey ?? SUBMISSION_DRAFT_KEYS[localRecord.type];
  let result = {
    record: localRecord,
    offline: true,
    queued: true,
    message: queuedSubmissionMessage(localRecord)
  };

  if (navigator.onLine) {
    let authError = null;

    try {
      markSyncing(localRecord);
      await persistLocalSubmission(localRecord);
      const syncedRecord = await syncSubmission(localRecord, {
        ...options,
        onProgress: persistLocalSubmission
      });
      applySyncedResponse(localRecord, syncedRecord);
      result = {
        record: localRecord,
        offline: false,
        queued: false,
        message: syncedSubmissionMessage(localRecord)
      };
    } catch (error) {
      if (isAuthError(error)) {
        markAuthBlocked(localRecord, error);
        authError = error;
      } else {
        markQueued(localRecord, error);
      }
      result = {
        record: localRecord,
        offline: true,
        queued: true,
        message: authError
          ? 'Submission saved locally. Sign in again to sync it.'
          : queuedSubmissionMessage(localRecord, true)
      };
    }

    await persistLocalSubmission(localRecord);
    if (draftKey) await clearSubmissionDraft(draftKey);
    if (authError) throw authError;
    return result;
  } else {
    markQueued(localRecord);
  }

  await persistLocalSubmission(localRecord);
  if (draftKey) await clearSubmissionDraft(draftKey);
  return result;
}

async function flushQueuedSubmissions() {
  if (!navigator.onLine) return { flushed: 0, failed: 0 };

  const queueItems = await getAll('queue');
  let flushed = 0;
  let failed = 0;
  let skipped = 0;
  let authBlocked = false;

  for (const item of queueItems) {
    const record = await get('records', item.id);
    if (!record) {
      await remove('queue', item.id);
      continue;
    }

    if (record.backendRecordId || record.syncStatus === 'synced') {
      await remove('queue', item.id);
      continue;
    }

    if (record.syncStatus === 'syncing' && !isStaleSyncingRecord(record)) {
      skipped += 1;
      continue;
    }

    const localRecord = normaliseLocalSubmission(record);

    try {
      markSyncing(localRecord);
      await persistLocalSubmission(localRecord);

      const syncedRecord = await syncSubmission(localRecord, {
        onProgress: persistLocalSubmission
      });
      applySyncedResponse(localRecord, syncedRecord);
      await persistLocalSubmission(localRecord);
      flushed += 1;
    } catch (error) {
      if (isAuthError(error)) {
        markAuthBlocked(localRecord, error);
        authBlocked = true;
      } else {
        markQueued(localRecord, error);
      }
      await persistLocalSubmission(localRecord);
      failed += 1;
      if (authBlocked) break;
    }
  }

  await put('settings', { key: 'lastSyncAt', value: new Date().toISOString() });
  return { flushed, failed, skipped, authBlocked };
}

export async function syncQueuedSubmissions() {
  if (syncQueuePromise) return syncQueuePromise;

  syncQueuePromise = flushQueuedSubmissions().finally(() => {
    syncQueuePromise = null;
  });

  return syncQueuePromise;
}
