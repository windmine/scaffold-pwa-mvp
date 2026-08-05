import { get, put, remove } from './db.js';

const SNAPSHOT_SCHEMA_VERSION = 1;
const SNAPSHOT_KEY_PREFIX = 'worker-site-snapshot';

function workerScope(user) {
  const workerId = user?.id == null ? '' : String(user.id).trim();
  const departmentId = user?.departmentId == null ? '' : String(user.departmentId).trim();
  if (user?.role !== 'worker' || !workerId || !departmentId) return null;

  return {
    workerId,
    departmentId
  };
}

function snapshotKey(scope) {
  return [SNAPSHOT_KEY_PREFIX, scope.workerId, scope.departmentId || 'none']
    .map((part) => encodeURIComponent(part))
    .join(':');
}

function snapshotSite(site, scope) {
  if (!site || site.id == null || String(site.id).trim() === '') return null;

  const latitude = Number(site.latitude);
  const longitude = Number(site.longitude);
  const allowedRadius = Number(site.allowed_radius_m ?? site.allowedRadiusM ?? 100);
  const departmentId = site.department_id ?? site.departmentId ?? null;

  if (
    !String(site.name || '').trim()
    || !Number.isFinite(latitude)
    || !Number.isFinite(longitude)
    || !Number.isFinite(allowedRadius)
    || (scope.departmentId && departmentId != null && String(departmentId) !== scope.departmentId)
  ) {
    return null;
  }

  return {
    id: site.id,
    name: String(site.name).trim(),
    address: site.address == null ? '' : String(site.address),
    latitude,
    longitude,
    allowed_radius_m: allowedRadius,
    department_id: departmentId
  };
}

function snapshotSites(sites, scope) {
  if (!Array.isArray(sites)) return [];
  return sites.map((site) => snapshotSite(site, scope)).filter(Boolean);
}

export async function saveWorkerSiteSnapshot(user, sites) {
  const scope = workerScope(user);
  if (!scope || !Array.isArray(sites)) return false;

  await put('settings', {
    key: snapshotKey(scope),
    value: {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      ownerWorkerId: scope.workerId,
      departmentId: scope.departmentId,
      savedAt: new Date().toISOString(),
      sites: snapshotSites(sites, scope)
    }
  });
  return true;
}

export async function loadWorkerSiteSnapshot(user) {
  const scope = workerScope(user);
  if (!scope) return null;

  const stored = (await get('settings', snapshotKey(scope)))?.value;
  if (
    stored?.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
    || String(stored.ownerWorkerId || '') !== scope.workerId
    || String(stored.departmentId || '') !== scope.departmentId
    || !Array.isArray(stored.sites)
  ) {
    return null;
  }

  return {
    savedAt: String(stored.savedAt || ''),
    sites: snapshotSites(stored.sites, scope)
  };
}

export async function clearWorkerSiteSnapshot(user) {
  const scope = workerScope(user);
  if (!scope) return false;

  await remove('settings', snapshotKey(scope));
  return true;
}
