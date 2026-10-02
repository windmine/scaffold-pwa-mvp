const SCHEMA_VERSION = 1;
const MAX_STORED_LENGTH = 1024;
const FILTER_KEYS = new Set(['status', 'formId', 'workerId', 'date', 'sortOrder']);
const WORKFLOW_STATES = new Set(['', 'submitted', 'in_review', 'resolved']);
const SORT_ORDERS = new Set(['newest', 'oldest_waiting']);

function emptyFilters() {
  return { status: '', formId: '', workerId: '', date: '', sortOrder: 'newest' };
}

function identifier(value) {
  return (typeof value === 'number' || typeof value === 'string')
    && /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value))
    ? String(value) : '';
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}

function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return '';
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1] ? value : '';
}

function sanitizeFilters(filters) {
  if (!isRecord(filters)) return emptyFilters();
  // Deliberately copy only structured values. Search text and Report content never persist.
  return {
    status: WORKFLOW_STATES.has(filters.status) ? filters.status : '',
    formId: identifier(filters.formId),
    workerId: identifier(filters.workerId),
    date: calendarDate(filters.date),
    sortOrder: SORT_ORDERS.has(filters.sortOrder) ? filters.sortOrder : 'newest'
  };
}

function resolveStorage(storage) {
  return storage === undefined ? globalThis.window.localStorage : storage;
}

export function reportReviewPreferenceKey(user, departmentFocusId) {
  const ownerId = identifier(user?.id);
  const homeDepartmentId = identifier(user?.departmentId);
  if (user?.role !== 'supervisor' || !ownerId || !homeDepartmentId) return null;
  const globalAdmin = user.isGlobalAdmin === true;
  const focus = departmentFocusId === ''
    ? (globalAdmin ? 'all' : homeDepartmentId) : identifier(departmentFocusId);
  if (!focus || (!globalAdmin && focus !== homeDepartmentId)) return null;
  return `report-review-preferences:v${SCHEMA_VERSION}:supervisor:${ownerId}:home:${homeDepartmentId}:global:${Number(globalAdmin)}:department:${focus}`;
}

export function readReportReviewPreferences(user, departmentFocusId, { storage } = {}) {
  const fallback = () => ({ filters: emptyFilters(), available: true });
  const key = reportReviewPreferenceKey(user, departmentFocusId);
  if (!key) return fallback();
  let raw;
  try {
    raw = resolveStorage(storage).getItem(key);
  } catch {
    return { filters: emptyFilters(), available: false };
  }
  if (typeof raw !== 'string' || raw.length > MAX_STORED_LENGTH) return fallback();
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return fallback();
  }
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION
    || Object.keys(value).some((name) => !['schemaVersion', 'filters'].includes(name))
    || !isRecord(value.filters) || Object.keys(value.filters).some((name) => !FILTER_KEYS.has(name))) {
    return fallback();
  }
  return { filters: sanitizeFilters(value.filters), available: true };
}

export function writeReportReviewPreferences(user, departmentFocusId, filters, { storage } = {}) {
  const key = reportReviewPreferenceKey(user, departmentFocusId);
  if (!key) return false;
  try {
    resolveStorage(storage).setItem(key, JSON.stringify({
      schemaVersion: SCHEMA_VERSION, filters: sanitizeFilters(filters)
    }));
    return true;
  } catch {
    return false;
  }
}
