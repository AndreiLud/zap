// The device cache of "You against Zap" (DATA-SPEC 5.1, web/src/you-vs-zap/records-cache.ts) on a
// small in-memory IndexedDB that keeps the parts of the API the cache uses (open with an upgrade,
// transactions that complete after their last request, get, put, clear, getAll, deleteDatabase
// with versionchange). The browser's own IndexedDB is exercised by the e2e suite.

import { describe, expect, it } from 'vitest';
import { DB_NAME, DB_VERSION, forgetRecords, openRecordsCache, type CachedRecord } from '../src/you-vs-zap/records-cache.ts';
import { playMatch } from './vs-fixtures.ts';

type Fn = (() => void) | null;

class Req<T = unknown> {
  result!: T;
  error: Error | null = null;
  onsuccess: Fn = null;
  onerror: Fn = null;
  onupgradeneeded: Fn = null;
  onblocked: Fn = null;
}

interface Stored {
  version: number;
  stores: Map<string, Map<IDBValidKey, unknown>>;
}

class Tx {
  oncomplete: Fn = null;
  onerror: Fn = null;
  onabort: Fn = null;
  error: Error | null = null;
  private pending = 0;
  private done = false;
  private db: Db;
  private names: string[];
  constructor(db: Db, names: string[]) {
    this.db = db;
    this.names = names;
    this.settle();
  }
  objectStore(name: string) {
    if (!this.names.includes(name)) throw new Error(`store ${name} not in transaction`);
    const data = this.db.data.stores.get(name)!;
    return {
      get: (key: IDBValidKey) => this.req(() => structuredClone(data.get(key))),
      put: (value: unknown, key: IDBValidKey) => this.req(() => (data.set(key, structuredClone(value)), key)),
      clear: () => this.req(() => data.clear()),
      getAll: () => this.req(() => [...data.values()].map((v) => structuredClone(v))),
    };
  }
  private req<T>(fn: () => T): Req<T> {
    if (this.done) throw new Error('transaction finished');
    const r = new Req<T>();
    this.pending++;
    queueMicrotask(() => {
      r.result = fn();
      r.onsuccess?.();
      this.pending--;
      this.settle();
    });
    return r;
  }
  private settle() {
    setTimeout(() => {
      if (this.pending > 0 || this.done) return;
      this.done = true;
      this.oncomplete?.();
    }, 0);
  }
}

class Db {
  closed = false;
  onversionchange: Fn = null;
  data: Stored;
  constructor(data: Stored) {
    this.data = data;
  }
  objectStoreNames = { contains: (n: string) => this.data.stores.has(n) };
  createObjectStore(n: string) {
    this.data.stores.set(n, new Map());
  }
  transaction(names: string | string[], _mode?: string) {
    if (this.closed) throw new Error('closed');
    return new Tx(this, Array.isArray(names) ? names : [names]);
  }
  close() {
    this.closed = true;
  }
}

class Factory {
  dbs = new Map<string, Stored>();
  conns: Db[] = [];
  open(name: string, version: number) {
    const r = new Req<Db>();
    setTimeout(() => {
      let data = this.dbs.get(name);
      const upgrade = !data || data.version < version;
      if (!data) {
        data = { version, stores: new Map() };
        this.dbs.set(name, data);
      }
      data.version = version;
      const db = new Db(data);
      this.conns.push(db);
      r.result = db;
      if (upgrade) r.onupgradeneeded?.();
      r.onsuccess?.();
    }, 0);
    return r;
  }
  deleteDatabase(name: string) {
    const r = new Req<undefined>();
    setTimeout(() => {
      for (const c of this.conns) if (!c.closed) c.onversionchange?.();
      if (this.conns.some((c) => !c.closed)) {
        r.onblocked?.();
        return;
      }
      this.dbs.delete(name);
      r.onsuccess?.();
    }, 0);
    return r;
  }
}

const asFactory = (f: Factory) => f as unknown as IDBFactory;
const item = (m: ReturnType<typeof playMatch>): CachedRecord => ({ yourSeat: m.yourSeat, record: m.record });

describe('records cache', () => {
  it('stores { yourSeat, record } by match id and reads them back', async () => {
    const f = new Factory();
    const cache = (await openRecordsCache(asFactory(f)))!;
    expect(cache).not.toBeNull();
    await cache.claim('pseudo-a');
    const a = playMatch({ seedChar: '1', rng: 1 });
    const b = playMatch({ seedChar: '2', rng: 2, yourSeat: 1 });
    await cache.put([item(a), item(b)]);
    const all = await cache.all();
    expect([...all.keys()].sort()).toEqual([a.matchId, b.matchId].sort());
    expect(all.get(b.matchId)).toEqual({ yourSeat: 1, record: b.record });
    const stored = f.dbs.get(DB_NAME)!;
    expect(stored.version).toBe(DB_VERSION);
    expect(stored.stores.get('records')!.get(a.matchId)).toEqual({ yourSeat: 0, record: a.record });
    expect(stored.stores.get('meta')!.get('owner')).toBe('pseudo-a');
    cache.close();
  });

  it('keeps the records for the same owner and clears both stores for another', async () => {
    const f = new Factory();
    const first = (await openRecordsCache(asFactory(f)))!;
    await first.claim('pseudo-a');
    const a = playMatch({ seedChar: '3', rng: 3 });
    await first.put([item(a)]);
    first.close();

    const again = (await openRecordsCache(asFactory(f)))!;
    await again.claim('pseudo-a');
    expect((await again.all()).size).toBe(1);
    await again.claim('pseudo-b');
    expect((await again.all()).size).toBe(0);
    expect(f.dbs.get(DB_NAME)!.stores.get('meta')!.get('owner')).toBe('pseudo-b');
    again.close();
  });

  it('forgets everything: the database is deleted, even with a connection open', async () => {
    const f = new Factory();
    const cache = (await openRecordsCache(asFactory(f)))!;
    await cache.claim('pseudo-a');
    await cache.put([item(playMatch({ seedChar: '4', rng: 4 }))]);
    expect(await forgetRecords(asFactory(f))).toBe(true);
    expect(f.dbs.has(DB_NAME)).toBe(false);
    const fresh = (await openRecordsCache(asFactory(f)))!;
    expect((await fresh.all()).size).toBe(0);
    fresh.close();
  });

  it('gives no cache without IndexedDB, and an empty one when a store fails', async () => {
    expect(await openRecordsCache(null)).toBeNull();
    expect(await forgetRecords(null)).toBe(false);
    const broken = { open: () => { throw new Error('blocked'); }, deleteDatabase: () => { throw new Error('blocked'); } } as unknown as IDBFactory;
    expect(await openRecordsCache(broken)).toBeNull();
    expect(await forgetRecords(broken)).toBe(false);

    const f = new Factory();
    const cache = (await openRecordsCache(asFactory(f)))!;
    cache.close();
    // A closed connection: every call fails inside and the page goes on without the cache.
    await expect(cache.claim('x')).resolves.toBeUndefined();
    await expect(cache.put([item(playMatch({ seedChar: '5', rng: 5 }))])).resolves.toBeUndefined();
    expect((await cache.all()).size).toBe(0);
  });

  it('skips stored values that are not records', async () => {
    const f = new Factory();
    const cache = (await openRecordsCache(asFactory(f)))!;
    await cache.claim('p');
    const m = playMatch({ seedChar: '6', rng: 6 });
    await cache.put([item(m)]);
    f.dbs.get(DB_NAME)!.stores.get('records')!.set('junk', { nothing: true });
    const all = await cache.all();
    expect([...all.keys()]).toEqual([m.matchId]);
    cache.close();
  });
});
