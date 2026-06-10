import type { TranscriptEvent } from "./protocol";

// Local-first transcript store. A revisit paints from IndexedDB immediately
// and reconciles with the server via a `?after=<offset>` delta instead of
// re-downloading megabytes of history. Hand-rolled (no idb dep) and very
// defensive: every failure path (iOS private mode, quota, blocked upgrade)
// degrades silently to the network-only behavior.

const DB_NAME = "hark";
const DB_VERSION = 1;
const STORE = "transcripts";
const MAX_SESSIONS = 30;
const SAVE_DEBOUNCE_MS = 1000;

export interface CachedTranscript {
  sessionId: string;
  events: TranscriptEvent[];
  // Byte cursor the events were reconciled at. Streamed tail events appended
  // after this cursor are also in `events`; the next delta re-delivers them
  // and the merge dedupes by uuid.
  offset: number;
  // Uuid of the last uuid-bearing event at `offset` — the server's
  // continuity marker for rewrite detection.
  lastUuid: string | null;
  savedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("indexeddb unavailable"));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "sessionId" });
          store.createIndex("savedAt", "savedAt");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("idb open failed"));
      req.onblocked = () => reject(new Error("idb blocked"));
    });
    // Failures surface as null loads / dropped saves, not unhandled
    // rejections.
    dbPromise.catch(() => {});
  }
  return dbPromise;
}

export async function loadTranscript(
  sessionId: string,
): Promise<CachedTranscript | null> {
  try {
    const db = await openDb();
    return await new Promise<CachedTranscript | null>((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(sessionId);
      req.onsuccess = () => {
        const v = req.result as CachedTranscript | undefined;
        resolve(
          v && Array.isArray(v.events) && typeof v.offset === "number"
            ? v
            : null,
        );
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

const pendingSaves = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Debounced save (~1s per session) — live streams call this on every
 * appended event; only the trailing state hits disk.
 */
export function saveTranscript(
  sessionId: string,
  events: TranscriptEvent[],
  offset: number,
  lastUuid: string | null,
): void {
  const existing = pendingSaves.get(sessionId);
  if (existing) clearTimeout(existing);
  pendingSaves.set(
    sessionId,
    setTimeout(() => {
      pendingSaves.delete(sessionId);
      void persist({ sessionId, events, offset, lastUuid, savedAt: Date.now() });
    }, SAVE_DEBOUNCE_MS),
  );
}

export async function purgeTranscript(sessionId: string): Promise<void> {
  const pending = pendingSaves.get(sessionId);
  if (pending) {
    clearTimeout(pending);
    pendingSaves.delete(sessionId);
  }
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(sessionId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    /* nothing to purge */
  }
}

async function persist(entry: CachedTranscript): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
    void pruneOldest(db);
  } catch {
    /* quota / private mode — cache is best-effort */
  }
}

// Keep the store bounded: drop the least-recently-saved sessions past
// MAX_SESSIONS.
async function pruneOldest(db: IDBDatabase): Promise<void> {
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const countReq = store.count();
      countReq.onsuccess = () => {
        let excess = countReq.result - MAX_SESSIONS;
        if (excess <= 0) return;
        const cursorReq = store.index("savedAt").openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor || excess <= 0) return;
          cursor.delete();
          excess--;
          cursor.continue();
        };
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    /* best-effort */
  }
}
