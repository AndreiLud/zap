// Match records a room keeps until R2 and D1 have them (pending-records.ts), on node:sqlite with
// the real migrations and a Map for the room's storage. A forget() or rekey() that lands while R2
// or D1 answers (they do not hold the room's input gate) must win over the copy the flush read.

import { describe, expect, it } from 'vitest';
import { RECORD_PREFIX, RECORD_RETRY_MS, SEAT_RETRIES, flushPending, moveRecordSeats, pendingCount, type PendingRecord, type RecordStore } from '../src/pending-records.ts';
import { newPseudonym, type SqlDb } from '../src/privacy.ts';
import { testDb, type TestDb } from './sqlite-db.ts';

const NOW = Date.UTC(2026, 10, 21, 12);
const dev = (c: string) => c.repeat(64);
const X = dev('a');
const TO = dev('b');
const OTHER = dev('c');

class Kv implements RecordStore {
  readonly m = new Map<string, unknown>();
  get(key: string) {
    return this.m.get(key);
  }
  put(key: string, value: string) {
    this.m.set(key, value);
  }
  delete(key: string) {
    return this.m.delete(key);
  }
  *list({ prefix }: { prefix: string }): Iterable<[string, unknown]> {
    for (const e of [...this.m].sort(([a], [b]) => (a < b ? -1 : 1))) if (e[0].startsWith(prefix)) yield e;
  }
  record(id: string): PendingRecord | undefined {
    const raw = this.m.get(RECORD_PREFIX + id) as string | undefined;
    return raw === undefined ? undefined : (JSON.parse(raw) as PendingRecord);
  }
}

function addDevice(db: TestDb, id: string): string {
  const pseudonym = newPseudonym();
  db.raw.prepare('INSERT INTO devices (id, created_at, pseudonym, adult_at, last_seen) VALUES (?, ?, ?, ?, ?)').run(id, NOW, pseudonym, NOW, NOW);
  return pseudonym;
}

function pending(kv: Kv, id: string, seats: string[]): void {
  const p: PendingRecord = {
    body: JSON.stringify({ matchId: id }),
    row: {
      matchId: id,
      startedAt: NOW - 60_000,
      endedAt: NOW,
      kind: 'mixed',
      variant: 'paulista',
      players: 2,
      aiVersion: 'v1',
      recordKey: `matches/v1/x/${id}.json`,
      seats: seats.map((device, seat) => ({ seat, device, verified: true })),
    },
  };
  kv.put(RECORD_PREFIX + id, JSON.stringify(p));
}

const seatRows = (db: TestDb) => db.raw.prepare('SELECT match_id, seat, pseudonym FROM match_seats ORDER BY match_id, seat').all();

/** A D1 whose batch first lets `during` run (a call landing while D1 answers). */
function slowDb(db: TestDb, during: () => void): SqlDb {
  let once = false;
  return {
    prepare: (q) => db.prepare(q),
    batch: async (stmts) => {
      if (!once) {
        once = true;
        during();
      }
      return db.batch(stmts);
    },
  };
}

describe('pending match records', () => {
  it('writes R2 then D1 and drops the record; a seat whose device D1 lacks waits a few tries, then goes', async () => {
    const db = testDb();
    const kv = new Kv();
    const po = addDevice(db, OTHER);
    pending(kv, 'm1', [OTHER, X]);
    const put: string[] = [];
    let t = NOW;
    await flushPending(kv, db, async (key) => void put.push(key), () => t);
    expect(put).toEqual(['matches/v1/x/m1.json']);
    expect(seatRows(db)).toEqual([{ match_id: 'm1', seat: 0, pseudonym: po }]);
    // X is not in D1: only its seat waits, without writing R2 again.
    expect(kv.record('m1')).toMatchObject({ seatsOnly: true, tries: 1, retryAt: NOW + RECORD_RETRY_MS, row: { seats: [{ seat: 1, device: X }] } });
    await flushPending(kv, db, async (key) => void put.push(key), () => t);
    expect(kv.record('m1')!.tries).toBe(1);
    for (let i = 0; i < SEAT_RETRIES; i++) {
      t += RECORD_RETRY_MS;
      await flushPending(kv, db, async (key) => void put.push(key), () => t);
    }
    expect(pendingCount(kv)).toBe(0);
    expect(put).toHaveLength(1);
  });

  it('a recovery that lands while R2 answers: the seat is written under the new id in the same flush', async () => {
    const db = testDb();
    const kv = new Kv();
    // D1 already moved X to TO (recoverDevice runs before the rooms are told).
    const pt = addDevice(db, TO);
    pending(kv, 'm1', [X]);
    await flushPending(kv, db, async () => void moveRecordSeats(kv, X, TO), () => NOW);
    expect(pendingCount(kv)).toBe(0);
    expect(seatRows(db)).toEqual([{ match_id: 'm1', seat: 0, pseudonym: pt }]);
  });

  it('a recovery that lands while D1 answers: the record keeps the new id, never the old one', async () => {
    const db = testDb();
    const kv = new Kv();
    const pt = addDevice(db, TO);
    pending(kv, 'm1', [X]);
    const put: string[] = [];
    await flushPending(kv, slowDb(db, () => moveRecordSeats(kv, X, TO)), async (key) => void put.push(key), () => NOW);
    expect(pendingCount(kv)).toBe(0);
    expect(seatRows(db)).toEqual([{ match_id: 'm1', seat: 0, pseudonym: pt }]);
    // Repeating the R2 put is harmless; nothing about X is left in the room's storage.
    expect(put).toEqual(['matches/v1/x/m1.json', 'matches/v1/x/m1.json']);
    expect(JSON.stringify([...kv.m])).not.toContain(X);
  });

  it('a deletion that lands while D1 answers: the deleted id does not come back into the room', async () => {
    const db = testDb();
    const kv = new Kv();
    const po = addDevice(db, OTHER);
    // D1 already deleted X; the room is told while the flush waits for D1.
    pending(kv, 'm1', [OTHER, X]);
    await flushPending(kv, slowDb(db, () => moveRecordSeats(kv, X, null)), async () => {}, () => NOW);
    expect(JSON.stringify([...kv.m])).not.toContain(X);
    expect(pendingCount(kv)).toBe(0);
    expect(seatRows(db)).toEqual([{ match_id: 'm1', seat: 0, pseudonym: po }]);
  });

  it('moving seats touches only the records that hold the device and sends them out at once', () => {
    const kv = new Kv();
    pending(kv, 'm1', [X, OTHER]);
    pending(kv, 'm2', [OTHER]);
    kv.put(RECORD_PREFIX + 'm1', JSON.stringify({ ...kv.record('m1')!, retryAt: NOW + RECORD_RETRY_MS, tries: 2 }));
    const before = kv.get(RECORD_PREFIX + 'm2');
    expect(moveRecordSeats(kv, X, TO)).toBe(true);
    expect(kv.record('m1')).toMatchObject({ tries: 2, row: { seats: [{ seat: 0, device: TO }, { seat: 1, device: OTHER }] } });
    expect(kv.record('m1')!.retryAt).toBeUndefined();
    expect(kv.get(RECORD_PREFIX + 'm2')).toBe(before);
    expect(moveRecordSeats(kv, X, null)).toBe(false);
    expect(moveRecordSeats(kv, OTHER, null)).toBe(true);
    expect(kv.record('m2')!.row.seats).toEqual([]);
    expect(kv.record('m1')!.row.seats).toEqual([{ seat: 0, device: TO, verified: true }]);
  });
});
