import { getAll, openDb } from './db.js';

const PREFIX = 'report-template-editor:';
const identifier = (value) => (typeof value === 'number' || typeof value === 'string')
  && /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? String(value) : '';
const DRAFT_KEYS = new Set(['id', 'kind', 'schemaVersion', 'ownerId', 'ownerDepartmentId',
  'departmentId', 'purpose', 'formId', 'baseVersion', 'name', 'description', 'builder',
  'savedAt', 'storeRevision', 'publicationState']);
const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
const validRevision = (value) => value === undefined
  || (Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER);

function isJsonData(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if ((!Array.isArray(value) && !isRecord(value)) || seen.has(value)) return false;
  seen.add(value);
  const valid = Object.values(value).every((item) => isJsonData(item, seen));
  seen.delete(value);
  return valid;
}

function readableRow(row, user) {
  return isRecord(row) && typeof row.key === 'string' && row.key.startsWith(PREFIX)
    && (row.deleted === undefined || row.deleted === false)
    && templateDraftBelongsTo(row.value, user) && row.key === templateDraftKey(row.value)
    && validRevision(row.storeRevision)
    && (row.storeRevision ?? 0) === (row.value.storeRevision ?? 0);
}

function draftConflict(conflictReason = 'invalid', row) {
  const error = new Error('This Template draft changed or was removed in another editor. Keep your input and reopen the saved draft.');
  error.code = 'TEMPLATE_DRAFT_CONFLICT';
  error.conflictReason = conflictReason;
  if (row?.publicationState === 'uncertain' || row?.value?.publicationState === 'uncertain') {
    error.publicationState = 'uncertain';
  }
  return error;
}

function assertCurrentRevision(row, draft, user) {
  const expected = draft.storeRevision ?? 0;
  if (!Number.isSafeInteger(expected) || expected < 0 || expected >= Number.MAX_SAFE_INTEGER) throw draftConflict();
  if (row === undefined) {
    if (expected !== 0) throw draftConflict('missing');
    return expected;
  }
  if (row?.deleted === true) throw draftConflict('removed', row);
  if (!readableRow(row, user) || row.key !== templateDraftKey(draft)) throw draftConflict('invalid', row);
  if ((row.storeRevision ?? 0) !== expected || row.value.baseVersion !== draft.baseVersion) {
    throw draftConflict('changed', row);
  }
  return expected;
}

export function templateDraftScope(user) {
  if (user?.role !== 'supervisor' || !identifier(user.id) || !identifier(user.departmentId)) return null;
  return { ownerId: identifier(user.id), ownerDepartmentId: identifier(user.departmentId) };
}

export function templateDraftKey(draft) {
  return `${PREFIX}${draft.ownerId}:${draft.ownerDepartmentId}:${draft.departmentId}:${draft.formId || 'new'}:${draft.id}`;
}

export function templateDraftBelongsTo(draft, user) {
  const scope = templateDraftScope(user);
  return Boolean(scope && isRecord(draft) && Object.keys(draft).every((key) => DRAFT_KEYS.has(key))
    && draft.kind === 'report-template-editor' && draft.schemaVersion === 1
    && draft.ownerId === scope.ownerId && draft.ownerDepartmentId === scope.ownerDepartmentId
    && typeof draft.departmentId === 'string' && identifier(draft.departmentId)
    && (user.isGlobalAdmin === true || draft.departmentId === scope.ownerDepartmentId)
    && draft.purpose === 'report' && typeof draft.id === 'string' && /^[a-zA-Z0-9-]+$/.test(draft.id)
    && (draft.formId === null ? draft.baseVersion === null
      : typeof draft.formId === 'string' && identifier(draft.formId)
        && Number.isSafeInteger(draft.baseVersion) && draft.baseVersion > 0)
    && typeof draft.name === 'string' && typeof draft.description === 'string'
    && isRecord(draft.builder) && Object.keys(draft.builder).every((key) => ['fields', 'rawText', 'rawDirty'].includes(key))
    && Array.isArray(draft.builder.fields) && draft.builder.fields.every((field) => isRecord(field) && isJsonData(field))
    && typeof draft.builder.rawText === 'string' && typeof draft.builder.rawDirty === 'boolean'
    && typeof draft.savedAt === 'string' && Number.isFinite(Date.parse(draft.savedAt))
    && new Date(draft.savedAt).toISOString() === draft.savedAt
    && validRevision(draft.storeRevision)
    && (draft.publicationState === undefined || draft.publicationState === 'uncertain'));
}

// The comparison and write share one readwrite transaction, including across tabs.
async function updateStoredRow(key, update) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction('drafts', 'readwrite');
    } catch (error) {
      db.close();
      reject(error);
      return;
    }
    let result;
    let failure;
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onerror = (event) => {
      failure ||= event?.target?.error || tx.error || new Error('Template draft storage failed.');
      db.close();
      reject(failure);
    };
    tx.onabort = () => { db.close(); reject(failure || tx.error || new Error('Template draft storage aborted.')); };
    const store = tx.objectStore('drafts');
    const request = store.get(key);
    request.onsuccess = () => {
      try {
        result = update(request.result);
        store.put(result);
      } catch (error) {
        failure = error;
        tx.abort();
      }
    };
  });
}

export function createTemplateDraftStore({
  listRows = () => getAll('drafts'), updateRow = updateStoredRow
} = {}) {
  async function saveTemplateDraft(draft, user) {
    if (!templateDraftBelongsTo(draft, user)) throw new Error('Template draft does not belong to this account.');
    const value = structuredClone(draft);
    const owner = { ...user };
    const row = await updateRow(templateDraftKey(value), (current) => {
      const storeRevision = assertCurrentRevision(current, value, owner) + 1;
      return {
        key: templateDraftKey(value), value: { ...value, storeRevision },
        storeRevision, deleted: false, updatedAt: value.savedAt
      };
    });
    return structuredClone(row.value);
  }

  async function listTemplateDrafts(user, departmentId = '') {
    if (!templateDraftScope(user) || (departmentId !== '' && !identifier(departmentId))) return [];
    const owner = { ...user };
    const rows = await listRows();
    if (!Array.isArray(rows)) throw new Error('Template draft storage returned an invalid result.');
    return rows.filter((row) => readableRow(row, owner)
      && (departmentId === '' || row.value.departmentId === String(departmentId)))
      .map(({ value }) => structuredClone(value))
      .sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
  }

  async function removeTemplateDraft(draft, user) {
    if (!templateDraftBelongsTo(draft, user)) throw new Error('Template draft does not belong to this account.');
    const value = structuredClone(draft);
    const owner = { ...user };
    await updateRow(templateDraftKey(value), (current) => ({
      key: templateDraftKey(value), value: null, deleted: true,
      storeRevision: assertCurrentRevision(current, value, owner) + 1, updatedAt: value.savedAt,
      ...(value.publicationState === 'uncertain' || current?.value?.publicationState === 'uncertain'
        ? { publicationState: 'uncertain' } : {})
    }));
  }

  return { saveTemplateDraft, listTemplateDrafts, removeTemplateDraft };
}

export const { saveTemplateDraft, listTemplateDrafts, removeTemplateDraft } = createTemplateDraftStore();
