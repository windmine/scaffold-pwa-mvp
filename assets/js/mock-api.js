import { get, getAll, put, remove } from './db.js';
import { uuid } from './utils.js';

const SESSION_KEY = 'scaffold-session';
const DEMO_USERS = [
  {
    id: 'user-worker-1',
    email: 'worker@example.com',
    password: 'Passw0rd!',
    fullName: 'Demo Worker',
    role: 'worker',
    workerClass: 'leader'
  },
  {
    id: 'user-supervisor-1',
    email: 'supervisor@example.com',
    password: 'Passw0rd!',
    fullName: 'Demo Supervisor',
    role: 'supervisor'
  }
];

const DEMO_SITES = [
  {
    id: 'site-1',
    name: 'Auckland Yard',
    address: '1 Demo Road, Auckland'
  },
  {
    id: 'site-2',
    name: 'CBD Tower Job',
    address: '99 Queen Street, Auckland'
  },
  {
    id: 'site-3',
    name: 'North Shore Warehouse',
    address: '15 Harbour Lane, Auckland'
  }
];

export async function initializeMockData() {
  const existingUsers = await getAll('users');
  if (!existingUsers.length) {
    await Promise.all(DEMO_USERS.map((user) => put('users', user)));
  }

  const existingSites = await getAll('sites');
  if (!existingSites.length) {
    await Promise.all(DEMO_SITES.map((site) => put('sites', site)));
  }
}

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setSession(user) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    role: user.role
  }));
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

export async function login(email, password) {
  const users = await getAll('users');
  const user = users.find((item) => item.email === email && item.password === password);
  if (!user) {
    throw new Error('Invalid email or password.');
  }
  setSession(user);
  return getSession();
}

export async function getSites() {
  const sites = await getAll('sites');
  return sites.sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveDraft(key, value) {
  await put('drafts', {
    key,
    value,
    updatedAt: new Date().toISOString()
  });
}

export async function getDraft(key) {
  const item = await get('drafts', key);
  return item?.value || null;
}

export async function clearDraft(key) {
  await remove('drafts', key);
}

export async function createAttendanceRecord(payload) {
  const syncStatus = payload.syncStatus || (navigator.onLine ? 'synced' : 'queued');
  const record = {
    id: payload.id || uuid(),
    type: 'attendance',
    userId: payload.userId,
    userName: payload.userName,
    siteId: payload.siteId,
    siteName: payload.siteName,
    action: payload.action,
    notes: payload.notes || '',
    photoDataUrl: payload.photoDataUrl || '',
    photoUrl: payload.photoUrl || '',
    location: payload.location || null,
    distanceFromSiteM: payload.distanceFromSiteM ?? null,
    withinSiteRadius: payload.withinSiteRadius ?? null,
    createdAt: payload.createdAt || new Date().toISOString(),
    syncStatus,
    syncError: payload.syncError || '',
    syncedAt: payload.syncedAt || '',
    backendRecordId: payload.backendRecordId || null,
    status: payload.status || 'pending'
  };

  await put('records', record);
  if (syncStatus === 'queued') {
    await put('queue', { id: record.id, kind: 'attendance', createdAt: record.createdAt });
  }
  return record;
}

export async function createTaskLog(payload) {
  const syncStatus = payload.syncStatus || (navigator.onLine ? 'synced' : 'queued');
  const record = {
    id: payload.id || uuid(),
    type: 'task',
    userId: payload.userId,
    userName: payload.userName,
    siteId: payload.siteId,
    siteName: payload.siteName,
    workDate: payload.workDate,
    hoursWorked: payload.hoursWorked || '',
    summary: payload.summary || '',
    safetyNotes: payload.safetyNotes || '',
    photoDataUrl: payload.photoDataUrl || '',
    photoDataUrls: payload.photoDataUrls || (payload.photoDataUrl ? [payload.photoDataUrl] : []),
    photoUrl: payload.photoUrl || '',
    photoUrls: payload.photoUrls || (payload.photoUrl ? [payload.photoUrl] : []),
    createdAt: payload.createdAt || new Date().toISOString(),
    syncStatus,
    syncError: payload.syncError || '',
    syncedAt: payload.syncedAt || '',
    backendRecordId: payload.backendRecordId || null,
    status: payload.status || 'pending'
  };

  await put('records', record);
  if (syncStatus === 'queued') {
    await put('queue', { id: record.id, kind: 'task', createdAt: record.createdAt });
  }
  return record;
}

export async function flushQueue() {
  if (!navigator.onLine) return { flushed: 0 };

  const queueItems = await getAll('queue');
  let flushed = 0;

  for (const item of queueItems) {
    const record = await get('records', item.id);
    if (record) {
      record.syncStatus = 'synced';
      record.syncedAt = new Date().toISOString();
      await put('records', record);
      flushed += 1;
    }
    await remove('queue', item.id);
  }

  await put('settings', { key: 'lastSyncAt', value: new Date().toISOString() });
  return { flushed };
}

export async function flushQueueWith(syncRecord) {
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
      const syncedRecord = await syncRecord(record, item);
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

      await put('records', record);
      await remove('queue', item.id);
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

export async function getLastSyncAt() {
  const item = await get('settings', 'lastSyncAt');
  return item?.value || null;
}

export async function getWorkerRecords(userId) {
  const records = await getAll('records');
  return records
    .filter((record) => record.userId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function getPendingApprovals() {
  const records = await getAll('records');
  return records
    .filter((record) => record.status === 'pending')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function getReviewedApprovals() {
  const records = await getAll('records');
  return records
    .filter((record) => record.status === 'approved' || record.status === 'rejected')
    .sort((a, b) => new Date(b.reviewedAt || b.createdAt) - new Date(a.reviewedAt || a.createdAt));
}

export async function getTaskLogRecords() {
  const records = await getAll('records');
  return records
    .filter((record) => record.type === 'task')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function decideRecord(recordId, decision) {
  const record = await get('records', recordId);
  if (!record) throw new Error('Record not found.');
  record.status = decision;
  record.reviewedAt = new Date().toISOString();
  await put('records', record);
  return record;
}
