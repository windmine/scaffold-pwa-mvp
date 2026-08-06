import { get, put, remove } from './db.js';

const SNAPSHOT_SCHEMA_VERSION = 1;
const SNAPSHOT_KEY_PREFIX = 'worker-attendance-snapshot';

function workerScope(user) {
  const workerId = user?.id == null ? '' : String(user.id).trim();
  const departmentId = user?.departmentId == null ? '' : String(user.departmentId).trim();
  if (user?.role !== 'worker' || !workerId || !departmentId) return null;

  return { workerId, departmentId };
}

function snapshotKey(scope) {
  return [SNAPSHOT_KEY_PREFIX, scope.workerId, scope.departmentId]
    .map((part) => encodeURIComponent(part))
    .join(':');
}

function snapshotAttendanceRecord(record, scope) {
  if (
    record?.type !== 'attendance'
    || !['check_in', 'check_out'].includes(record.action)
    || !String(record.createdAt || '').trim()
    || (record.userId != null && String(record.userId) !== scope.workerId)
  ) {
    return null;
  }

  return {
    id: record.id,
    backendRecordId: record.backendRecordId,
    clientSubmissionId: String(record.clientSubmissionId || ''),
    type: 'attendance',
    userId: record.userId ?? scope.workerId,
    siteId: record.siteId,
    siteName: String(record.siteName || ''),
    action: record.action,
    entrySource: String(record.entrySource || 'worker'),
    createdAt: String(record.createdAt),
    status: String(record.status || 'pending'),
    syncStatus: 'synced',
    source: 'backend_snapshot'
  };
}

function snapshotAttendanceRecords(records, scope) {
  if (!Array.isArray(records)) return [];
  return records.map((record) => snapshotAttendanceRecord(record, scope)).filter(Boolean);
}

export async function saveWorkerAttendanceSnapshot(user, records) {
  const scope = workerScope(user);
  if (!scope || !Array.isArray(records)) return false;

  await put('settings', {
    key: snapshotKey(scope),
    value: {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      ownerWorkerId: scope.workerId,
      departmentId: scope.departmentId,
      records: snapshotAttendanceRecords(records, scope)
    }
  });
  return true;
}

export async function loadWorkerAttendanceSnapshot(user) {
  const scope = workerScope(user);
  if (!scope) return null;

  const stored = (await get('settings', snapshotKey(scope)))?.value;
  if (
    stored?.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
    || String(stored.ownerWorkerId || '') !== scope.workerId
    || String(stored.departmentId || '') !== scope.departmentId
    || !Array.isArray(stored.records)
  ) {
    return null;
  }

  return { records: snapshotAttendanceRecords(stored.records, scope) };
}

export async function clearWorkerAttendanceSnapshot(user) {
  const scope = workerScope(user);
  if (!scope) return false;
  await remove('settings', snapshotKey(scope));
  return true;
}
