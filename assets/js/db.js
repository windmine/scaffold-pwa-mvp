const DB_NAME = 'scaffold-pwa-local';
const DB_VERSION = 1;
// An already-open pre-Blob app must never replay a new Report without its
// photos. Keep its original database/schema intact, but isolate new Report
// work in a namespace that those clients do not know how to open.
const REPORT_DB_NAME = 'scaffold-pwa-report-evidence-v1';
const REPORT_STORES = new Set(['records', 'queue', 'drafts']);
const legacyDraftReads = new Map();

function isReport(record) {
  if (record?.type !== 'form') return false;
  const purpose = record.submissionPurpose || record.submission_purpose;
  return purpose ? purpose === 'report' : !/daywork|daily work/i.test(record.formName || '');
}

function isReportDraft(entry) {
  return entry?.value?.kind === 'work-form'
    && (entry.value.templatePurpose || entry.value.template_purpose) !== 'daywork';
}

function entryKey(storeName, value) {
  return storeName === 'drafts' ? value.key : value.id;
}

async function openReportDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(REPORT_DB_NAME, 1);
    request.onupgradeneeded = () => {
      for (const name of REPORT_STORES) {
        request.result.createObjectStore(name, { keyPath: name === 'drafts' ? 'key' : 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readStore(open, storeName, key, all = false) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = all ? tx.objectStore(storeName).getAll() : tx.objectStore(storeName).get(key);
    let value;
    req.onsuccess = () => { value = req.result; };
    tx.oncomplete = () => { db.close(); resolve(all ? value || [] : value); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || req.error || new Error('Read failed')); };
  });
}

async function writeStore(open, storeName, callback) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    let result;
    try { result = callback(tx.objectStore(storeName)); }
    catch (error) { tx.abort(); db.close(); reject(error); return; }
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error('Write failed')); };
  });
}

async function fingerprint(entry) {
  if (!entry) return null;
  const bytes = new TextEncoder().encode(JSON.stringify(entry));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sameLegacyValue(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every((key) => Object.hasOwn(right, key) && sameLegacyValue(left[key], right[key]));
}

async function cleanLegacyDraft(key, expectedFingerprint) {
  if (!expectedFingerprint) return;
  const previous = await readStore(openDb, 'drafts', key);
  if (!previous || await fingerprint(previous) !== expectedFingerprint) return;
  // The exact comparison and delete share one transaction. An old tab that
  // edits between the hash check and this transaction keeps its new draft.
  await writeStore(openDb, 'drafts', (store) => {
    const request = store.get(key);
    request.onsuccess = () => {
      if (sameLegacyValue(request.result, previous)) store.delete(key);
    };
  });
}

async function visibleIsolated(storeName, isolated, legacy) {
  if (!isolated) return legacy;
  if (!isolated.deleted) return isolated.value;
  // UUID Report/queue keys never need to resurrect. Draft keys are reused;
  // keep a genuinely newer draft made in a still-open old editor recoverable.
  if (storeName === 'drafts' && legacy
    && await fingerprint(legacy) !== isolated.legacyFingerprint) return legacy;
  return undefined;
}

export async function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains('users')) {
        db.createObjectStore('users', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('sites')) {
        db.createObjectStore('sites', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('records')) {
        const store = db.createObjectStore('records', { keyPath: 'id' });
        store.createIndex('byType', 'type', { unique: false });
        store.createIndex('byUserId', 'userId', { unique: false });
        store.createIndex('byStatus', 'status', { unique: false });
      }
      if (!db.objectStoreNames.contains('queue')) {
        db.createObjectStore('queue', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('drafts')) {
        db.createObjectStore('drafts', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function runTransaction(storeNames, mode, callback) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    const stores = Array.isArray(storeNames)
      ? Object.fromEntries(storeNames.map((name) => [name, tx.objectStore(name)]))
      : tx.objectStore(storeNames);

    let result;
    try {
      result = callback(stores, tx);
    } catch (error) {
      tx.abort();
      reject(error);
      return;
    }

    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Transaction aborted')); };
  });
}

export async function put(storeName, value) {
  if (!REPORT_STORES.has(storeName)) return writeStore(openDb, storeName, (store) => store.put(value));
  const key = entryKey(storeName, value);
  const existing = await readStore(openReportDb, storeName, key);
  let isolated = Boolean(existing);
  if (storeName === 'drafts') isolated ||= isReportDraft(value) || Boolean(value.value?.photoBlobs?.length);
  if (storeName === 'records') isolated ||= Boolean(value.photoBlobs?.length);
  if (storeName === 'records' && isReport(value)) {
    // Legacy base64 queues keep their existing replay location; they are safe
    // for old clients. New Reports, including zero-photo Reports, are isolated.
    isolated ||= Boolean(value.photoBlobs?.length) || !await readStore(openDb, storeName, key);
  }
  if (storeName === 'queue') isolated ||= Boolean(await readStore(openReportDb, 'records', key));
  if (!isolated) return writeStore(openDb, storeName, (store) => store.put(value));
  const legacyFingerprint = existing?.deleted && legacyDraftReads.has(key)
    ? legacyDraftReads.get(key) : existing?.legacyFingerprint ?? legacyDraftReads.get(key) ?? null;
  const envelope = { [storeName === 'drafts' ? 'key' : 'id']: key, reportStorageVersion: 1, value,
    ...(storeName === 'drafts' ? { legacyFingerprint } : {}) };
  await writeStore(openReportDb, storeName, (store) => store.put(envelope));
  if (storeName === 'drafts') {
    // The committed isolated copy is already durable. Failed old-copy cleanup
    // is harmless: reads prefer it, and its fingerprint prevents resurrection.
    await cleanLegacyDraft(key, legacyFingerprint).catch(() => {});
    legacyDraftReads.delete(key);
  }
}

export async function get(storeName, key) {
  const legacy = await readStore(openDb, storeName, key);
  if (!REPORT_STORES.has(storeName)) return legacy;
  const isolated = await readStore(openReportDb, storeName, key);
  const value = await visibleIsolated(storeName, isolated, legacy);
  if (storeName === 'drafts' && (!isolated || isolated.deleted)) {
    legacyDraftReads.set(key, await fingerprint(value));
  }
  return value;
}

export async function getAll(storeName) {
  const legacy = await readStore(openDb, storeName, undefined, true);
  if (!REPORT_STORES.has(storeName)) return legacy;
  const entries = new Map(legacy.map((entry) => [entryKey(storeName, entry), entry]));
  for (const isolated of await readStore(openReportDb, storeName, undefined, true)) {
    const key = entryKey(storeName, isolated);
    const value = await visibleIsolated(storeName, isolated, entries.get(key));
    if (value) {
      entries.set(key, value);
      if (storeName === 'drafts' && isolated.deleted) legacyDraftReads.set(key, await fingerprint(value));
    }
    else entries.delete(key);
  }
  return [...entries.values()];
}

export async function remove(storeName, key) {
  if (REPORT_STORES.has(storeName)) {
    const existing = await readStore(openReportDb, storeName, key);
    const isolatedRecord = storeName === 'queue' && await readStore(openReportDb, 'records', key);
    if (existing || isolatedRecord) {
      const legacyFingerprint = existing?.deleted && legacyDraftReads.has(key)
        ? legacyDraftReads.get(key) : existing?.legacyFingerprint ?? null;
      await writeStore(openReportDb, storeName, (store) => store.put({
        [storeName === 'drafts' ? 'key' : 'id']: key,
        reportStorageVersion: 1, deleted: true,
        ...(storeName === 'drafts' ? { legacyFingerprint } : {})
      }));
      if (storeName === 'drafts') {
        await cleanLegacyDraft(key, legacyFingerprint).catch(() => {});
        legacyDraftReads.delete(key);
      }
      return;
    }
  }
  return writeStore(openDb, storeName, (store) => store.delete(key));
}
