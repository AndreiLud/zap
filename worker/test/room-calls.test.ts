// Calls to the rooms of a person who deletes or moves their data: a failed call is tried once
// more, the rooms are called a few at a time, and the calls that still fail come back. Waiting
// calls (D1 room_calls, on node:sqlite with the real migrations) leave the queue only as they were
// delivered, whether the Worker or the room itself delivers them.

import { describe, expect, it } from 'vitest';
import { CALLS_AT_ONCE, callEach, deliver, queueStatements, queuedCalls, settleWaitingCalls, type RoomCall } from '../src/room-calls.ts';
import { testDb, type TestDb } from './sqlite-db.ts';

const calls = (n: number): RoomCall[] => Array.from({ length: n }, (_, i) => ({ code: `R${String(i).padStart(4, '0')}`, from: ['x'], to: null }));

describe('room calls', () => {
  it('tries a failed call once more and answers only the ones that failed twice', async () => {
    const tries = new Map<string, number>();
    const all = calls(5);
    const failed = await callEach(all, async (c) => {
      const n = (tries.get(c.code) ?? 0) + 1;
      tries.set(c.code, n);
      // R0001 fails once, R0003 always; the others work at once.
      if (c.code === 'R0003' || (c.code === 'R0001' && n === 1)) throw new Error('busy');
    });
    expect(failed).toEqual([all[3]]);
    expect(Object.fromEntries(tries)).toEqual({ R0000: 1, R0001: 2, R0002: 1, R0003: 2, R0004: 1 });
    expect(await callEach([], async () => {})).toEqual([]);
  });

  it('calls the rooms a few at a time', async () => {
    let open = 0;
    let most = 0;
    const failed = await callEach(calls(3 * CALLS_AT_ONCE + 7), async () => {
      open++;
      most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, 1));
      open--;
    });
    expect(failed).toEqual([]);
    expect(most).toBe(CALLS_AT_ONCE);
  });
});

const NOW = Date.UTC(2026, 10, 21, 12);
const dev = (c: string) => c.repeat(64);
const A = dev('a');
const B = dev('b');
const C = dev('c');
const D = dev('d');
const E = dev('e');

/** What recoverDevice does to waiting calls when the person recovers again (B to C). */
function recoverAgain(db: TestDb, from: string, to: string): void {
  db.raw.prepare('UPDATE room_calls SET to_device = ? WHERE to_device = ?').run(to, from);
}

const rows = (db: TestDb) => db.raw.prepare('SELECT code, device, to_device FROM room_calls ORDER BY code, device').all();

describe('waiting room calls', () => {
  it('a call delivered leaves the queue, one that fails stays, and a newer recovery written meanwhile is kept', async () => {
    const db = testDb();
    await db.batch(queueStatements(db, [{ code: 'RRRRR', from: [A], to: B }, { code: 'SSSSS', from: [D], to: null }, { code: 'TTTTT', from: [D], to: null }], NOW));
    const queued = await queuedCalls(db);
    const called: string[] = [];
    // The daily job read (RRRRR, A, to B); while it calls the room, the person recovers again from B to C.
    await deliver(
      db,
      [{ code: 'NEWRM', from: [D], to: null }],
      queued,
      async (c) => {
        called.push(`${c.code}:${c.to === null ? '' : c.to.slice(0, 1)}`);
        if (c.code === 'RRRRR') recoverAgain(db, B, C);
        if (c.code === 'TTTTT' || c.code === 'NEWRM') throw new Error('busy');
      },
      NOW + 1,
    );
    expect(called.sort()).toEqual(['NEWRM:', 'NEWRM:', 'RRRRR:b', 'SSSSS:', 'TTTTT:', 'TTTTT:']);
    expect(rows(db)).toEqual([
      // The newer call (to C) is not the one delivered, so it stays for the next try.
      { code: 'NEWRM', device: D, to_device: null },
      { code: 'RRRRR', device: A, to_device: C },
      { code: 'TTTTT', device: D, to_device: null },
    ]);
    // Delivered as it now stands, it leaves.
    await deliver(db, [], await queuedCalls(db), async () => {}, NOW + 2);
    expect(rows(db)).toEqual([]);
  });

  it('a room settles its own waiting calls, in order, and keeps one rewritten while it applied them', async () => {
    const db = testDb();
    await db.batch(queueStatements(db, [{ code: 'RRRRR', from: [A, D], to: B }], NOW));
    await db.batch(queueStatements(db, [{ code: 'RRRRR', from: [E], to: null }, { code: 'OTHER', from: [A], to: B }], NOW + 1));
    const applied: RoomCall[] = [];
    const calls = await settleWaitingCalls(db, 'RRRRR', (c) => {
      applied.push(c);
      // A recovery from B to C lands while the room applies the calls.
      if (c.to === B) recoverAgain(db, B, C);
    });
    expect(applied).toEqual([
      { code: 'RRRRR', from: [A, D], to: B },
      { code: 'RRRRR', from: [E], to: null },
    ]);
    expect(calls).toEqual(applied);
    // The forget of E left; the calls now going to C stay (for this room and the other one).
    expect(rows(db)).toEqual([
      { code: 'OTHER', device: A, to_device: C },
      { code: 'RRRRR', device: A, to_device: C },
      { code: 'RRRRR', device: D, to_device: C },
    ]);
    // Nothing waits for a room with no calls; a failing D1 answers an error for the room to try later.
    expect(await settleWaitingCalls(db, 'EMPTY', () => expect.unreachable())).toEqual([]);
    const broken = { ...db, prepare: () => ({ bind: () => ({ all: () => Promise.reject(new Error('D1 down')) }) }) } as unknown as TestDb;
    await expect(settleWaitingCalls(broken, 'RRRRR', () => {})).rejects.toThrow('D1 down');
  });
});
