/**
 * IndexedDB-backed storage for raw sample buffers of recent measurements.
 *
 * Why not localStorage? A single 60-second run at 100 kHz = 6M samples ×
 * 5 B/sample = 30 MB — far over localStorage's ~5 MB per-origin cap.
 * IndexedDB comfortably holds hundreds of MB and stores typed arrays
 * natively via structured clone (no base64 blow-up).
 *
 * Design:
 *  - Single database `ppk-web` (version 1), one object store `raw`
 *    keyed by the measurement's `id` (matches `RecentMeasurement.id`).
 *  - Value shape: `{ current: Blob, digital: Blob, sampleRateHz }`.
 *    Blobs are stored (not TypedArrays) so IDB persists them as opaque
 *    binary — cheaper to serialize and no ambiguity about backing buffer.
 *  - All ops swallow errors and resolve to null / false. A misbehaving
 *    disk should never take down the UI.
 */

const DB_NAME = "ppk-web";
/**
 * Baseline schema version. If a user's DB is already at a *higher* version
 * (e.g. from a previous session that self-healed), we don't force it down —
 * we open version-less and only bump if the store is missing.
 */
const DB_MIN_VERSION = 2;
const STORE = "raw";

export interface RawRecord {
  current: Float32Array;
  digital: Uint8Array;
  sampleRateHz: number;
}

interface StoredValue {
  current: Blob;
  digital: Blob;
  sampleRateHz: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openInternal(version?: number): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req =
        version === undefined
          ? indexedDB.open(DB_NAME)
          : indexedDB.open(DB_NAME, version);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

/**
 * Open the DB and guarantee the `raw` object store exists.
 *
 * Strategy (in order):
 *  1. Open version-less to discover the current version without forcing a
 *     downgrade (opening at a lower version than the existing DB throws
 *     VersionError — this is what broke the previous implementation).
 *  2. If the store is missing, bump `version + 1` to trigger
 *     `onupgradeneeded` and create it.
 *  3. If we couldn't even open (empty state), create at `DB_MIN_VERSION`.
 *  4. Last-resort repair: delete and recreate the whole DB.
 */
function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    // Step 1: probe without forcing a version.
    let db = await openInternal();
    if (!db) {
      // Empty state or blocked — try to create at the baseline version.
      db = await openInternal(DB_MIN_VERSION);
      if (!db) return null;
    }

    // Step 2: ensure store exists; upgrade if not.
    if (!db.objectStoreNames.contains(STORE)) {
      const nextVersion = db.version + 1;
      db.close();
      db = await openInternal(nextVersion);
      if (!db) return null;
    }

    // Step 3: last-resort repair.
    if (!db.objectStoreNames.contains(STORE)) {
      db.close();
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(DB_NAME);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });
      db = await openInternal(DB_MIN_VERSION);
      if (!db || !db.objectStoreNames.contains(STORE)) return null;
    }
    return db;
  })();
  return dbPromise;
}

function tx(
  db: IDBDatabase,
  mode: IDBTransactionMode,
): { store: IDBObjectStore; done: Promise<boolean> } {
  const t = db.transaction(STORE, mode);
  const store = t.objectStore(STORE);
  const done = new Promise<boolean>((resolve) => {
    t.oncomplete = () => resolve(true);
    t.onerror = () => resolve(false);
    t.onabort = () => resolve(false);
  });
  return { store, done };
}

/** Write a raw record. Returns true on success. */
export async function putRaw(id: string, rec: RawRecord): Promise<boolean> {
  const db = await openDb();
  if (!db) {
    console.warn("[rawStore] putRaw: could not open IndexedDB");
    return false;
  }
  const value: StoredValue = {
    current: new Blob([rec.current.buffer as ArrayBuffer], {
      type: "application/octet-stream",
    }),
    digital: new Blob([rec.digital.buffer as ArrayBuffer], {
      type: "application/octet-stream",
    }),
    sampleRateHz: rec.sampleRateHz,
  };
  try {
    const { store, done } = tx(db, "readwrite");
    store.put(value, id);
    const ok = await done;
    if (!ok) console.warn("[rawStore] putRaw: transaction failed for id", id);
    return ok;
  } catch (err) {
    console.warn("[rawStore] putRaw threw", err);
    return false;
  }
}

/** Read a raw record. Returns null if missing or on any error. */
export async function getRaw(id: string): Promise<RawRecord | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const { store } = tx(db, "readonly");
    const req = store.get(id);
    const value = await new Promise<StoredValue | undefined>((resolve) => {
      req.onsuccess = () => resolve(req.result as StoredValue | undefined);
      req.onerror = () => resolve(undefined);
    });
    if (!value || !value.current || !value.digital) return null;
    const [curBuf, digBuf] = await Promise.all([
      value.current.arrayBuffer(),
      value.digital.arrayBuffer(),
    ]);
    return {
      current: new Float32Array(curBuf),
      digital: new Uint8Array(digBuf),
      sampleRateHz: value.sampleRateHz,
    };
  } catch {
    return null;
  }
}

/** Delete a single raw record. */
export async function deleteRaw(id: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const { store, done } = tx(db, "readwrite");
    store.delete(id);
    await done;
  } catch {
    /* ignore */
  }
}

/** Delete many raw records in a single transaction. */
export async function deleteManyRaw(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDb();
  if (!db) return;
  try {
    const { store, done } = tx(db, "readwrite");
    for (const id of ids) store.delete(id);
    await done;
  } catch {
    /* ignore */
  }
}

/** Delete every raw record (used by "Clear all"). */
export async function clearAllRaw(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const { store, done } = tx(db, "readwrite");
    store.clear();
    await done;
  } catch {
    /* ignore */
  }
}

/**
 * Return every id currently present in the store. Used at boot to prune
 * IDB entries whose metadata was lost from localStorage.
 */
export async function listRawIds(): Promise<string[]> {
  const db = await openDb();
  if (!db) return [];
  try {
    const { store } = tx(db, "readonly");
    const req = store.getAllKeys();
    return await new Promise<string[]>((resolve) => {
      req.onsuccess = () => resolve((req.result as IDBValidKey[]).map(String));
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}
