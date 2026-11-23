// The device cache of "You against Zap" (DATA-SPEC 5.1): copies of the person's match records in
// IndexedDB, so the page opens fast and a record is fetched from the server only once. Records
// never change, so a cached record is never fetched again.
//
//   database zap-you, version 1
//     records  key matchId, value { yourSeat, record }
//     meta     key "owner", value the pseudonym of /api/me/data
//
// When the owner differs from the pseudonym the server gives now (a recovery code, a deletion on
// another tab), both stores are cleared before anything is read. Every call is in try and catch:
// without IndexedDB (private windows, blocked storage) the page simply fetches on each visit.
// Deleting the person's data on the You page (/voce) deletes the whole database (forgetRecords).

import type { AnyMatchRecord } from '../../../shared/match-record.ts';

export const DB_NAME = 'zap-you';
export const DB_VERSION = 1;
const RECORDS = 'records';
const META = 'meta';
const OWNER = 'owner';

export interface CachedRecord {
  yourSeat: number;
  record: AnyMatchRecord;
}

export interface RecordsCache {
  /** Makes the cache belong to this pseudonym: clears both stores when another owner filled them. */
  claim(owner: string): Promise<void>;
  /** Every cached record by match id (empty on any failure). */
  all(): Promise<Map<string, CachedRecord>>;
  /** Stores records; failures are ignored (the page has them in memory). */
  put(items: readonly CachedRecord[]): Promise<void>;
  /** Closes the connection (before a deletion of the database). */
  close(): void;
}

/** A request as a promise. */
function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb request failed'));
  });
}

/** A transaction's end as a promise. */
function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('indexeddb transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('indexeddb transaction aborted'));
  });
}

function factoryOr(f: IDBFactory | null | undefined): IDBFactory | null {
  if (f !== undefined) return f;
  try {
    return typeof indexedDB === 'undefined' ? null : indexedDB;
  } catch {
    return null;
  }
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb open failed'));
    req.onblocked = () => reject(new Error('indexeddb open blocked'));
  });
}

/** Opens the cache, or null when this browser gives no IndexedDB. */
export async function openRecordsCache(factory?: IDBFactory | null): Promise<RecordsCache | null> {
  const f = factoryOr(factory);
  if (!f) return null;
  let db: IDBDatabase;
  try {
    db = await openDb(f);
  } catch {
    return null;
  }
  // A deletion elsewhere (another tab) asks this connection to go.
  db.onversionchange = () => db.close();
  let closed = false;
  return {
    async claim(owner) {
      try {
        const tx = db.transaction([RECORDS, META], 'readwrite');
        const end = finished(tx);
        const meta = tx.objectStore(META);
        const was = await done(meta.get(OWNER));
        if (was !== owner) {
          tx.objectStore(RECORDS).clear();
          meta.put(owner, OWNER);
        }
        await end;
      } catch {
        // Unusable cache: reads come back empty and the page fetches.
      }
    },
    async all() {
      const out = new Map<string, CachedRecord>();
      try {
        const tx = db.transaction(RECORDS, 'readonly');
        const end = finished(tx);
        const values = (await done(tx.objectStore(RECORDS).getAll())) as unknown[];
        await end;
        for (const v of values) {
          const c = v as Partial<CachedRecord> | null;
          if (c && typeof c.yourSeat === 'number' && c.record && typeof c.record.matchId === 'string') out.set(c.record.matchId, { yourSeat: c.yourSeat, record: c.record });
        }
      } catch {
        out.clear();
      }
      return out;
    },
    async put(items) {
      if (items.length === 0) return;
      try {
        const tx = db.transaction(RECORDS, 'readwrite');
        const end = finished(tx);
        const store = tx.objectStore(RECORDS);
        for (const it of items) store.put({ yourSeat: it.yourSeat, record: it.record }, it.record.matchId);
        await end;
      } catch {
        // Full or blocked storage: the records stay in memory for this visit.
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } catch {
        // Already closed.
      }
    },
  };
}

/**
 * Deletes the whole database ("Esquecer as partidas guardadas neste aparelho", and the deletion of
 * the person's data). Resolves true once it is gone, false when the browser refused or has none.
 * A deletion blocked by an open connection still completes when that connection closes.
 */
export function forgetRecords(factory?: IDBFactory | null): Promise<boolean> {
  const f = factoryOr(factory);
  if (!f) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const req = f.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}
