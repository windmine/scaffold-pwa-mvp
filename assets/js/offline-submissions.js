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

function isAuthError(error) {
  return error?.status === 401 || error?.status === 403;
}

export function normaliseRecordPhotoUrls(record) {
  const urls = Array.isArray(record.photoUrls) ? [...record.photoUrls] : [];
  if (record.photoUrl && !urls.includes(record.photoUrl)) {
    urls.unshift(record.photoUrl);
  }
  return urls.filter(Boolean);
}

function photoFilenameFor(record, file, index = 0, dataUrl = '') {
  if (file?.name) return file.name;
  const extension = (dataUrl || record.photoDataUrl || '').match(/^data:image\/([a-z0-9+.-]+);base64,/i)?.[1] || 'jpg';
  const suffix = index ? `-${index + 1}` : '';
  return `${record.type || 'record'}-${record.id || uuid()}${suffix}.${extension.replace('jpeg', 'jpg')}`;
}

async function uploadRecordPhotos(record, files = []) {
  const existingUrls = normaliseRecordPhotoUrls(record);
  if (existingUrls.length) {
    record.photoUrls = existingUrls;
    record.photoUrl = existingUrls[0];
    return existingUrls;
  }

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

  if (!sources.length) return [];

  const uploadedUrls = [];
  for (const [index, item] of sources.entries()) {
    const uploaded = await uploadPhoto(item.source, photoFilenameFor(record, item.file, index, item.dataUrl));
    uploadedUrls.push(uploaded.url);
  }

  record.photoUrls = uploadedUrls;
  record.photoUrl = uploadedUrls[0] || '';
  return uploadedUrls;
}

async function uploadRecordPhoto(record, file = null) {
  const urls = await uploadRecordPhotos(record, file ? [file] : []);
  return urls[0] || null;
}

function isSignatureDataUrl(value) {
  return typeof value === 'string' && value.startsWith('data:image/');
}

async function uploadSignatureAnswers(record) {
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
    photo_url: record.photoUrl || null
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
    photo_urls: photoUrls
  };
}

function toBackendFormSubmissionPayload(record) {
  return {
    form_id: Number(record.formId),
    site_id: getBackendSiteId(record.siteId),
    work_date: record.workDate || null,
    answers: record.answers || {},
    photo_urls: normaliseRecordPhotoUrls(record)
  };
}

function normaliseLocalSubmission(record) {
  const createdAt = record.createdAt || new Date().toISOString();

  return {
    id: record.id || uuid(),
    photoDataUrl: '',
    photoDataUrls: [],
    photoUrl: '',
    photoUrls: [],
    syncStatus: record.syncStatus || 'queued',
    syncError: record.syncError || '',
    syncedAt: record.syncedAt || '',
    backendRecordId: record.backendRecordId || null,
    status: record.status || 'pending',
    createdAt,
    ...record
  };
}

function markQueued(record, error = null) {
  record.syncStatus = 'queued';
  record.syncError = error?.message || record.syncError || '';
}

function applySyncedResponse(record, syncedRecord) {
  record.syncStatus = 'synced';
  record.syncError = '';
  record.syncedAt = new Date().toISOString();

  if (syncedRecord?.id) {
    record.backendRecordId = syncedRecord.id;
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

  if (record.syncStatus === 'queued') {
    await put('queue', {
      id: record.id,
      kind: record.type,
      createdAt: record.createdAt
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
  if (record.type === 'attendance') {
    await uploadRecordPhoto(record, options.photoFiles?.[0] || null);
    return await createBackendAttendance(toBackendAttendancePayload(record));
  }

  if (record.type === 'task') {
    await uploadRecordPhotos(record, options.photoFiles || []);
    return await createBackendTaskLog(toBackendTaskLogPayload(record));
  }

  if (record.type === 'form') {
    await uploadSignatureAnswers(record);
    await uploadRecordPhotos(record, options.photoFiles || []);
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
  if (record.type === 'form') return 'Form submitted for approval.';
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
    return retry
      ? 'Form saved locally. Backend sync will retry when you reconnect.'
      : 'Form saved offline and queued for later sync.';
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
    try {
      const syncedRecord = await syncSubmission(localRecord, options);
      applySyncedResponse(localRecord, syncedRecord);
      result = {
        record: localRecord,
        offline: false,
        queued: false,
        message: syncedSubmissionMessage(localRecord)
      };
    } catch (error) {
      if (isAuthError(error)) throw error;
      markQueued(localRecord, error);
      result = {
        record: localRecord,
        offline: true,
        queued: true,
        message: queuedSubmissionMessage(localRecord, true)
      };
    }
  } else {
    markQueued(localRecord);
  }

  await persistLocalSubmission(localRecord);
  if (draftKey) await clearSubmissionDraft(draftKey);
  return result;
}

export async function syncQueuedSubmissions() {
  if (!navigator.onLine) return { flushed: 0, failed: 0 };

  const queueItems = await getAll('queue');
  let flushed = 0;
  let failed = 0;

  for (const item of queueItems) {
    const record = await get('records', item.id);
    if (!record) {
      await remove('queue', item.id);
      continue;
    }

    try {
      const syncedRecord = await syncSubmission(record);
      applySyncedResponse(record, syncedRecord);
      await persistLocalSubmission(record);
      flushed += 1;
    } catch (error) {
      record.syncError = error.message || 'Sync failed';
      await put('records', record);
      failed += 1;
    }
  }

  await put('settings', { key: 'lastSyncAt', value: new Date().toISOString() });
  return { flushed, failed };
}
