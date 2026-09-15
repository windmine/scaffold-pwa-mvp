import { get, put, remove } from './db.js';

const SNAPSHOT_SCHEMA_VERSION = 1;
const SNAPSHOT_KEY_PREFIX = 'worker-report-template-snapshot';
const FIELD_TYPES = new Set([
  'text', 'textarea', 'number', 'date', 'select', 'checkbox', 'signature',
  'section', 'time_range', 'formula', 'repeat'
]);

function positiveId(value) {
  if (!['string', 'number'].includes(typeof value)) return '';
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? String(number) : '';
}

function workerScope(user) {
  const workerId = positiveId(user?.id);
  const departmentId = positiveId(user?.departmentId);
  if (user?.role !== 'worker' || !workerId || !departmentId
    || (user.status != null && user.status !== 'active')) return null;
  return { workerId, departmentId };
}

function snapshotKey(scope) {
  return `${SNAPSHOT_KEY_PREFIX}:${scope.workerId}:${scope.departmentId}`;
}

function snapshotTemplate(template, scope) {
  if (!template || !positiveId(template.id) || template.status !== 'active'
    || positiveId(template.department_id) !== scope.departmentId
    || (template.departmentId !== undefined && positiveId(template.departmentId) !== scope.departmentId)
    || template.template_purpose !== 'report'
    || (template.templatePurpose !== undefined && template.templatePurpose !== 'report')
    || !positiveId(template.definition_version)
    || typeof template.name !== 'string' || !template.name.trim()
    || !Array.isArray(template.fields)
    || template.fields.some((field) => !field || typeof field !== 'object' || Array.isArray(field)
      || typeof field.id !== 'string' || !field.id.trim()
      || typeof field.label !== 'string' || !field.label.trim()
      || !FIELD_TYPES.has(field.type))) return null;
  try {
    return {
      id: template.id,
      department_id: template.department_id,
      name: template.name,
      description: typeof template.description === 'string' ? template.description : '',
      status: 'active',
      template_purpose: 'report',
      definition_version: Number(template.definition_version),
      fields: JSON.parse(JSON.stringify(template.fields))
    };
  } catch {
    return null;
  }
}

function snapshotTemplates(templates, scope) {
  return templates.map((template) => snapshotTemplate(template, scope)).filter(Boolean);
}

export function createWorkerReportTemplateSnapshotStore(storage = { get, put, remove }) {
  // All writes/removals for a scope are ordered. Clearing revokes immediately,
  // so even a failing delete or a delayed old write cannot restore that session.
  const operations = new Map();
  const generations = new Map();
  const revoked = new Set();
  const generation = (key) => generations.get(key) || 0;
  function enqueue(key, operation) {
    const next = (operations.get(key) || Promise.resolve()).catch(() => {}).then(operation);
    const settled = next.catch(() => {});
    operations.set(key, settled);
    void settled.then(() => { if (operations.get(key) === settled) operations.delete(key); });
    return next;
  }

  return {
    // Call only with an authenticated API list; callers fence HTTP response races.
    async save(user, templates, { isCurrent = () => true } = {}) {
      const scope = workerScope(user);
      if (!scope || !Array.isArray(templates)) return false;
      const key = snapshotKey(scope);
      const startedGeneration = generation(key);
      const record = {
        key,
        value: {
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          ownerWorkerId: scope.workerId,
          departmentId: scope.departmentId,
          savedAt: new Date().toISOString(),
          templates: snapshotTemplates(templates, scope)
        }
      };
      return enqueue(key, async () => {
        if (startedGeneration !== generation(key) || !isCurrent()) return false;
        await storage.put('settings', record);
        if (startedGeneration !== generation(key) || !isCurrent()) {
          await storage.remove('settings', key);
          return false;
        }
        revoked.delete(key);
        return true;
      });
    },
    async load(user) {
      const scope = workerScope(user);
      if (!scope) return null;
      const key = snapshotKey(scope);
      const startedGeneration = generation(key);
      await operations.get(key);
      if (startedGeneration !== generation(key) || revoked.has(key)) return null;
      const stored = (await storage.get('settings', key))?.value;
      if (startedGeneration !== generation(key) || revoked.has(key)) return null;
      if (stored?.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
        || stored.ownerWorkerId !== scope.workerId || stored.departmentId !== scope.departmentId
        || typeof stored.savedAt !== 'string' || !Number.isFinite(Date.parse(stored.savedAt))
        || !Array.isArray(stored.templates)) return null;
      return { savedAt: stored.savedAt, templates: snapshotTemplates(stored.templates, scope) };
    },
    async clear(user) {
      // An observed role/status change must still be able to remove the old scope.
      const scope = workerScope({ ...user, role: 'worker', status: 'active' });
      if (!scope) return false;
      const key = snapshotKey(scope);
      generations.set(key, generation(key) + 1);
      revoked.add(key);
      return enqueue(key, async () => {
        await storage.remove('settings', key);
        return true;
      });
    }
  };
}

const snapshots = createWorkerReportTemplateSnapshotStore();
export const saveWorkerReportTemplateSnapshot = snapshots.save;
export const loadWorkerReportTemplateSnapshot = snapshots.load;
export const clearWorkerReportTemplateSnapshot = snapshots.clear;
