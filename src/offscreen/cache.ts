// IndexedDB cache of generated speech, keyed by hash(text, voice, speed).
// Samples are stored as Float32Array (structured clone), not number[].

const DB_NAME = 'voicebox-reader';
const DB_VERSION = 2;
const STORE = 'audio-cache';
const MAX_AGE_MS = 48 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;

interface Entry {
  key: string;
  audio: Float32Array;
  timestamp: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // v1 stored audio as number[] under weak keys; start clean.
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      const store = db.createObjectStore(STORE, { keyPath: 'key' });
      store.createIndex('timestamp', 'timestamp', { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

export async function cacheKey(text: string, voice: string, speed: number): Promise<string> {
  const data = new TextEncoder().encode(`${voice}|${speed}|${text}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 32);
}

export async function cacheGet(key: string): Promise<Float32Array | null> {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => {
        const entry = req.result as Entry | undefined;
        resolve(entry && Date.now() - entry.timestamp < MAX_AGE_MS ? entry.audio : null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function cachePut(key: string, audio: Float32Array): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.put({ key, audio, timestamp: Date.now() } satisfies Entry);

    const countReq = store.count();
    countReq.onsuccess = () => {
      let excess = countReq.result - MAX_ENTRIES;
      if (excess <= 0) return;
      excess += 50; // evict in batches, oldest first
      const cursorReq = store.index('timestamp').openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor && excess > 0) {
          cursor.delete();
          excess--;
          cursor.continue();
        }
      };
    };
  } catch {
    // A failed cache write never blocks playback.
  }
}

export async function cacheClear(): Promise<number> {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const countReq = store.count();
      let n = 0;
      countReq.onsuccess = () => {
        n = countReq.result;
        store.clear();
      };
      tx.oncomplete = () => resolve(n);
      tx.onerror = () => resolve(0);
    });
  } catch {
    return 0;
  }
}
