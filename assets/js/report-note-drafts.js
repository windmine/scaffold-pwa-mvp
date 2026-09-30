import { openDb } from './db.js';

const PREFIX = 'report-resolution-note:v1:';
const SCHEMA_VERSION = 1;
const CONTEXT_KEYS = ['ownerId', 'ownerDepartmentId', 'globalAdmin', 'departmentId', 'reportId'];
const ROW_KEYS = ['key', 'schemaVersion', 'context', 'revision', 'text', 'savedAt', 'deleted', 'finalized'];
// Matches ReportWorkflowUpdate.supervisor_note. Never truncate unfinished text.
export const REPORT_NOTE_MAX_LENGTH = 1000;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function identifier(value) {
  if ((typeof value !== 'number' && typeof value !== 'string')
    || !/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) return '';
  return String(value);
}

function plainRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
}

function exactKeys(value, keys) {
  if (!plainRecord(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length && ownKeys.every((key) => keys.includes(key)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}

export function reportNoteContext(user, record, departmentFocusId = '') {
  if (user?.role !== 'supervisor' || record?.type !== 'form' || record.durability !== 'durable') return null;
  const purposes = [record.submissionPurpose, record.submission_purpose].filter((value) => value !== undefined);
  if (!purposes.length || purposes.some((purpose) => purpose !== 'report')) return null;
  const ownerId = identifier(user.id);
  const ownerDepartmentId = identifier(user.departmentId);
  const departmentId = identifier(record.departmentId);
  const reportId = identifier(record.backendRecordId);
  const globalAdmin = user.isGlobalAdmin === true;
  const focus = departmentFocusId === '' ? '' : identifier(departmentFocusId);
  if (!ownerId || !ownerDepartmentId || !departmentId || !reportId
    || (record.department_id !== undefined && identifier(record.department_id) !== departmentId)
    || (departmentFocusId !== '' && !focus) || (focus && focus !== departmentId)
    || (!globalAdmin && departmentId !== ownerDepartmentId)) return null;
  return Object.freeze({ ownerId, ownerDepartmentId, globalAdmin, departmentId, reportId });
}

function validatedContext(context) {
  if (!exactKeys(context, CONTEXT_KEYS) || typeof context.globalAdmin !== 'boolean'
    || CONTEXT_KEYS.filter((key) => key !== 'globalAdmin').some((key) => (
      typeof context[key] !== 'string' || identifier(context[key]) !== context[key]
    )) || (!context.globalAdmin && context.ownerDepartmentId !== context.departmentId)) {
    throw failure('REPORT_NOTE_CONTEXT', 'The Report note context is invalid.');
  }
  // Capture the original authorized scope before awaiting storage. UI session
  // guards are separate; an in-flight save must not follow a later scope change.
  return Object.freeze(Object.fromEntries(CONTEXT_KEYS.map((key) => [key, context[key]])));
}

function contextKey(context) {
  return `${PREFIX}supervisor:${context.ownerId}:home:${context.ownerDepartmentId}:global:${Number(context.globalAdmin)}:department:${context.departmentId}:report:${context.reportId}`;
}

export function reportNoteDraftKey(context) {
  return contextKey(validatedContext(context));
}

function snapshot(row) {
  return row ? {
    revision: row.revision, text: row.text, savedAt: row.savedAt,
    deleted: row.deleted, finalized: row.finalized
  } : { revision: 0, text: '', savedAt: '', deleted: true, finalized: false };
}

function validateRow(row, context, key) {
  if (row === undefined) return snapshot();
  if (!exactKeys(row, ROW_KEYS) || row.key !== key || row.schemaVersion !== SCHEMA_VERSION
    || !exactKeys(row.context, CONTEXT_KEYS) || CONTEXT_KEYS.some((name) => row.context[name] !== context[name])
    || !Number.isSafeInteger(row.revision) || row.revision < 1
    || typeof row.text !== 'string' || row.text.length > REPORT_NOTE_MAX_LENGTH
    || typeof row.savedAt !== 'string' || !Number.isFinite(Date.parse(row.savedAt))
    || new Date(row.savedAt).toISOString() !== row.savedAt
    || typeof row.deleted !== 'boolean' || typeof row.finalized !== 'boolean'
    || (row.deleted && row.text !== '') || (row.finalized && !row.deleted)) {
    throw failure('REPORT_NOTE_MALFORMED', 'The saved Report note could not be read safely.');
  }
  return snapshot(row);
}

function expectedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw failure('REPORT_NOTE_REVISION', 'The expected Report note revision is invalid.');
  }
  return value;
}

async function readNativeRow(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction('drafts', 'readonly'); }
    catch (error) { db.close(); reject(error); return; }
    const request = tx.objectStore('drafts').get(key);
    let row;
    request.onsuccess = () => { row = request.result; };
    tx.oncomplete = () => { db.close(); resolve(row); };
    tx.onerror = tx.onabort = () => {
      db.close(); reject(tx.error || request.error || new Error('Report note read failed.'));
    };
  });
}

async function updateNativeRow(key, update) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction('drafts', 'readwrite'); }
    catch (error) { db.close(); reject(error); return; }
    const store = tx.objectStore('drafts');
    const request = store.get(key);
    let nextRow;
    let updateError;
    request.onsuccess = () => {
      try {
        // Reading, comparing and writing share one transaction, including across
        // tabs. An old editor cannot overwrite a newer save or deletion.
        nextRow = update(request.result);
        store.put(nextRow);
      } catch (error) {
        updateError = error;
        tx.abort();
      }
    };
    tx.oncomplete = () => { db.close(); resolve(nextRow); };
    tx.onerror = tx.onabort = () => {
      db.close(); reject(updateError || tx.error || request.error || new Error('Report note save failed.'));
    };
  });
}

export function createReportNoteDraftStore({ readRow = readNativeRow, updateRow = updateNativeRow } = {}) {
  async function loadNoteDraft(inputContext) {
    const context = validatedContext(inputContext);
    const key = contextKey(context);
    return validateRow(await readRow(key), context, key);
  }

  async function changeNote(inputContext, revision, { text, deleted, finalized }) {
    const context = validatedContext(inputContext);
    const key = contextKey(context);
    const expected = expectedRevision(revision);
    const row = await updateRow(key, (previous) => {
      const current = validateRow(previous, context, key);
      if (current.finalized) throw failure('REPORT_NOTE_FINALIZED', 'This Report note has already been finalized.');
      if (current.revision !== expected) throw failure('REPORT_NOTE_CONFLICT', 'This Report note changed in another editor.');
      if (current.revision === Number.MAX_SAFE_INTEGER) throw failure('REPORT_NOTE_REVISION', 'The Report note revision limit was reached.');
      return {
        key, schemaVersion: SCHEMA_VERSION, context, revision: current.revision + 1,
        text, savedAt: new Date().toISOString(), deleted, finalized
      };
    });
    return validateRow(row, context, key);
  }

  async function saveNoteDraft(context, { text, expectedRevision: revision } = {}) {
    if (typeof text !== 'string' || text.length > REPORT_NOTE_MAX_LENGTH) {
      throw failure('REPORT_NOTE_LENGTH', `Report notes must be text of no more than ${REPORT_NOTE_MAX_LENGTH} characters.`);
    }
    return changeNote(context, revision, { text, deleted: false, finalized: false });
  }

  async function clearNoteDraft(context, { expectedRevision: revision, finalized = false } = {}) {
    if (typeof finalized !== 'boolean') throw failure('REPORT_NOTE_CONTEXT', 'The Report note finalization flag is invalid.');
    return changeNote(context, revision, { text: '', deleted: true, finalized });
  }

  return { loadNoteDraft, saveNoteDraft, clearNoteDraft };
}

const defaultStore = createReportNoteDraftStore();
export const { loadNoteDraft, saveNoteDraft, clearNoteDraft } = defaultStore;
