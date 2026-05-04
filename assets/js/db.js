const DB_NAME = 'scaffold-pwa-local';
const DB_VERSION = 1;

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

    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

export async function put(storeName, value) {
  return runTransaction(storeName, 'readwrite', (store) => store.put(value));
}

export async function get(storeName, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAll(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function remove(storeName, key) {
  return runTransaction(storeName, 'readwrite', (store) => store.delete(key));
}
