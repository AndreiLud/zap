// Calls from the Worker to the rooms a person is in, when they delete their data (Room.forget)
// or move it to another browser (Room.rekey). A failed call is tried once more at once. One that
// still fails is either reported to the person (a deletion, which then deletes nothing) or kept in
// D1's room_calls until the room answers or is gone: the room looks for its own waiting calls when
// it is next used (settleWaitingCalls), and the daily job tries every row again. Every call is
// safe to repeat.

import type { SqlDb, SqlStatement } from './privacy.ts';

export interface RoomCall {
  code: string;
  /** The ids the room must let go of. */
  from: string[];
  /** After a recovery, the id that takes their place; null after a deletion. */
  to: string | null;
}

/** Rooms called at the same time. */
export const CALLS_AT_ONCE = 20;
/** Waiting calls tried in one run of the daily job. */
export const QUEUE_BATCH = 200;

/** Makes every call, trying the failed ones once more. Answers the calls that still failed. */
export async function callEach(calls: RoomCall[], call: (c: RoomCall) => Promise<unknown>): Promise<RoomCall[]> {
  let pending = calls;
  for (let attempt = 0; attempt < 2 && pending.length > 0; attempt++) {
    const failed: RoomCall[] = [];
    for (let i = 0; i < pending.length; i += CALLS_AT_ONCE) {
      const chunk = pending.slice(i, i + CALLS_AT_ONCE);
      const res = await Promise.allSettled(chunk.map((c) => call(c)));
      failed.push(...chunk.filter((_, j) => res[j].status === 'rejected'));
    }
    pending = failed;
  }
  return pending;
}

/** Keeps calls for the daily job: one row per id and room, the latest call for it winning. */
export function queueStatements(db: SqlDb, calls: RoomCall[], now: number): SqlStatement[] {
  return calls.flatMap((c) =>
    c.from.map((device) =>
      db
        .prepare(
          'INSERT INTO room_calls (code, device, to_device, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (code, device) DO UPDATE SET to_device = excluded.to_device, created_at = excluded.created_at',
        )
        .bind(c.code, device, c.to, now),
    ),
  );
}

/**
 * The calls that went through leave the queue. Only the row that still holds the call delivered:
 * a later recovery may have moved its target meanwhile (recoverDevice), and that newer call stays.
 */
export function doneStatements(db: SqlDb, calls: RoomCall[]): SqlStatement[] {
  return calls.flatMap((c) =>
    c.from.map((device) => db.prepare('DELETE FROM room_calls WHERE code = ?1 AND device = ?2 AND to_device IS ?3').bind(c.code, device, c.to)),
  );
}

type CallRow = { code: string; device: string; to_device: string | null };

/** Rows to calls, one per room and target. */
function grouped(rows: CallRow[]): RoomCall[] {
  const calls = new Map<string, RoomCall>();
  for (const r of rows) {
    const key = `${r.code}:${r.to_device ?? ''}`;
    const c = calls.get(key);
    if (c) c.from.push(r.device);
    else calls.set(key, { code: r.code, from: [r.device], to: r.to_device });
  }
  return [...calls.values()];
}

/** Waiting calls, one per room and target: all of them (oldest first), or only the recoveries to this id. */
export async function queuedCalls(db: SqlDb, to?: string): Promise<RoomCall[]> {
  const res = await (to === undefined
    ? db.prepare('SELECT code, device, to_device FROM room_calls ORDER BY created_at, code, device LIMIT ?1').bind(QUEUE_BATCH)
    : db.prepare('SELECT code, device, to_device FROM room_calls WHERE to_device = ?1').bind(to)
  ).all<CallRow>();
  return grouped(res.results);
}

/**
 * Makes the calls (`call` reaches the room). One that still fails is kept in room_calls; a waiting
 * one (`queued`) that went through leaves it. Nothing better to do if D1 fails too: the room and
 * the daily job find what they can. Answers how many calls went through.
 */
export async function deliver(db: SqlDb, calls: RoomCall[], queued: RoomCall[], call: (c: RoomCall) => Promise<unknown>, now: number): Promise<number> {
  const failed = await callEach([...calls, ...queued], call);
  const stmts = [...doneStatements(db, queued.filter((c) => !failed.includes(c))), ...queueStatements(db, failed.filter((c) => !queued.includes(c)), now)];
  if (stmts.length > 0) await db.batch(stmts).catch(() => undefined);
  return calls.length + queued.length - failed.length;
}

/**
 * A room settles the calls still waiting for it, so a deletion or a recovery that could not reach
 * it takes effect the next time the room is used instead of at the daily job: `apply` lets go of
 * each id (or moves it), then each call leaves the queue as in deliver(). Answers the calls applied.
 */
export async function settleWaitingCalls(db: SqlDb, code: string, apply: (c: RoomCall) => void): Promise<RoomCall[]> {
  const rows = await db.prepare('SELECT code, device, to_device FROM room_calls WHERE code = ?1 ORDER BY created_at, device').bind(code).all<CallRow>();
  const calls = grouped(rows.results);
  for (const c of calls) apply(c);
  if (calls.length > 0) await db.batch(doneStatements(db, calls));
  return calls;
}
