/**
 * IndexedDB persistence for the command log.
 *
 * Deliberately thin, and deliberately incapable of throwing. Everything interesting —
 * encoding, decoding, version and shape validation — lives in `serialize.ts`, which is pure
 * and unit-tested. What remains here is three storage calls that cannot be usefully unit
 * tested in node, so they are covered end to end instead.
 *
 * **Nothing in here may reject or throw into the drawing path.** Storage can be unavailable
 * (private browsing, disabled site data, a full disk), and autosave failing is a degraded
 * feature, never a broken app. Every function resolves, with failure meaning "no save" or
 * "save not written".
 */

const DB_NAME = "paintpad";
const DB_VERSION = 1;
const STORE = "documents";
/** A single slot. Multiple saved documents would be a feature, not a prerequisite. */
const KEY = "current";

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDatabase(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    // Absent in node and in some privacy modes.
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }

    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });

  return dbPromise;
}

/** Run a transaction body, resolving null if storage is unusable or the request fails. */
function withStore<T>(
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return openDatabase().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        let request: IDBRequest<T>;
        try {
          request = body(db.transaction(STORE, mode).objectStore(STORE));
        } catch {
          // A transaction can throw synchronously once the database is closing.
          resolve(null);
          return;
        }
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      }),
  );
}

/**
 * A synchronous last-gasp slot.
 *
 * IndexedDB is asynchronous, and a transaction started while the page is unloading usually
 * never commits — so a flush-on-hide would appear to work and silently lose the work anyway.
 * `localStorage.setItem` is synchronous and does complete, which makes it the right place for
 * that one final write. It is deliberately *only* a fallback: the debounced history lives in
 * IndexedDB, where size is not the constraint.
 */
const FALLBACK_KEY = "paintpad.flush";

/**
 * The stored save as raw JSON, or null if there is none or it cannot be read.
 *
 * A pending fallback wins over IndexedDB, because it was written later — it holds whatever the
 * document looked like at the moment the page went away.
 *
 * It is deliberately **not** consumed here. An earlier version removed it on read, which was
 * one-shot: React's StrictMode invokes the boot effect twice, so the first read took the
 * fallback and the second — the one that actually survives — fell through to a stale
 * IndexedDB save and quietly restored the wrong document. `saveDocument` clears the fallback
 * once the durable store holds something at least as new.
 */
export async function loadDocument(): Promise<string | null> {
  try {
    const pending = localStorage.getItem(FALLBACK_KEY);
    if (pending !== null) return pending;
  } catch {
    // Storage disabled entirely; fall through to IndexedDB.
  }

  const value = await withStore<unknown>("readonly", (store) => store.get(KEY));
  return typeof value === "string" ? value : null;
}

/**
 * Write the save. Silently does nothing if storage is unavailable or full.
 *
 * Clears the fallback only once IndexedDB has actually taken the write, since that write is
 * what makes the fallback redundant. Clearing it on a failed write would discard the only
 * durable copy.
 */
export async function saveDocument(json: string): Promise<void> {
  const written = await withStore<IDBValidKey>("readwrite", (store) => store.put(json, KEY));
  if (written === null) return;
  try {
    localStorage.removeItem(FALLBACK_KEY);
  } catch {
    // Ignore.
  }
}

/**
 * Write synchronously, for use while the page is being hidden or unloaded.
 *
 * Best-effort: if the document is too large for localStorage this throws and is swallowed,
 * leaving only the asynchronous write to be relied on.
 */
export function flushSave(json: string): void {
  try {
    localStorage.setItem(FALLBACK_KEY, json);
  } catch {
    // Quota exceeded, or storage disabled.
  }
}

/** Discard the save. Used by Clear so a reload does not resurrect what was just cleared. */
export async function clearDocument(): Promise<void> {
  try {
    localStorage.removeItem(FALLBACK_KEY);
  } catch {
    // Ignore.
  }
  await withStore("readwrite", (store) => store.delete(KEY));
}

/**
 * Drop the cached connection.
 *
 * Only needed by tests: IndexedDB persists for the origin across page loads, so without this
 * a wiped database would still be served from the open connection.
 */
export async function resetStorageForTests(): Promise<void> {
  const db = await openDatabase();
  db?.close();
  dbPromise = null;
}