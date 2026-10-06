// IndexedDB cache of generated speech, keyed by hash(text, voice, speed).
//
// Budgeted by BYTES, not entry count (a long sentence is ~1MB of float audio, so
// "500 entries" used to mean up to ~500MB on disk). Audio is stored as 16-bit
// PCM (half the size and I/O of Float32; 16-bit is CD quality and the model
// output is 24kHz speech, so the rounding noise sits ~90dB below the signal).
//
// Two stores: `audio` holds the samples, `meta` holds one tiny {key, timestamp,
// bytes} record per entry so eviction never has to read audio back.

const DB_NAME = 'voicebox-reader';
const DB_VERSION = 3;
const AUDIO = 'audio-pcm';
const META = 'audio-meta';
const MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const MAX_CACHE_BYTES = 96 * 1024 * 1024;
/** Re-check the budget every N writes (a scan of the small meta store). */
const BUDGET_CHECK_EVERY = 8;

interface AudioEntry {
  key: string;
  pcm: Int16Array;
  timestamp: number;
}
interface MetaEntry {
  key: string;
  timestamp: number;
  bytes: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let writesSinceCheck = 0;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Earlier versions stored Float32 audio in 'audio-cache'; drop it, it was unbounded.
      if (db.objectStoreNames.contains('audio-cache')) db.deleteObjectStore('audio-cache');
      if (!db.objectStoreNames.contains(AUDIO)) db.createObjectStore(AUDIO, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: 'key' }).createIndex('timestamp', 'timestamp', { unique: false });
      }
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

function toPcm(audio: Float32Array): Int16Array {
  const out = new Int16Array(audio.length);
  for (let i = 0; i < audio.length; i++) {
    const v = audio[i];
    out[i] = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32767);
  }
  return out;
}

function fromPcm(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}

export async function cacheGet(key: string): Promise<Float32Array | null> {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const req = db.transaction(AUDIO, 'readonly').objectStore(AUDIO).get(key);
      req.onsuccess = () => {
        const entry = req.result as AudioEntry | undefined;
        resolve(entry && Date.now() - entry.timestamp < MAX_AGE_MS ? fromPcm(entry.pcm) : null);
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
    const pcm = toPcm(audio);
    const timestamp = Date.now();
    const tx = db.transaction([AUDIO, META], 'readwrite');
    tx.objectStore(AUDIO).put({ key, pcm, timestamp } satisfies AudioEntry);
    tx.objectStore(META).put({ key, timestamp, bytes: pcm.byteLength } satisfies MetaEntry);
    if (++writesSinceCheck >= BUDGET_CHECK_EVERY) {
      writesSinceCheck = 0;
      enforceBudget(tx);
    }
  } catch {
    // A failed cache write never blocks playback.
  }
}

/** Delete expired entries, then oldest-first until under the byte budget. */
function enforceBudget(tx: IDBTransaction): void {
  const meta = tx.objectStore(META);
  const audio = tx.objectStore(AUDIO);
  const all: MetaEntry[] = [];
  const req = meta.index('timestamp').openCursor();
  req.onsuccess = () => {
    const cursor = req.result;
    if (cursor) {
      all.push(cursor.value as MetaEntry);
      cursor.continue();
      return;
    }
    // `all` is oldest first.
    let total = all.reduce((n, e) => n + e.bytes, 0);
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const e of all) {
      if (e.timestamp < cutoff || total > MAX_CACHE_BYTES * 0.9) {
        total -= e.bytes;
        meta.delete(e.key);
        audio.delete(e.key);
      } else {
        break;
      }
    }
  };
}

export async function cacheClear(): Promise<number> {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const tx = db.transaction([AUDIO, META], 'readwrite');
      const countReq = tx.objectStore(META).count();
      let n = 0;
      countReq.onsuccess = () => {
        n = countReq.result;
        tx.objectStore(AUDIO).clear();
        tx.objectStore(META).clear();
      };
      tx.oncomplete = () => resolve(n);
      tx.onerror = () => resolve(0);
    });
  } catch {
    return 0;
  }
}
