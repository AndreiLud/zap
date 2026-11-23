// Finished matches waiting to be written by their room: the record (R2) and the rows (D1), kept in
// the room's storage under rec:<matchId> until both succeed and retried on the room's alarm. The
// logic runs over a small storage interface (the Durable Object's ctx.storage.kv), so the unit
// tests run it with a Map and node:sqlite.

import { matchRowStatements, seatStatementIndexes, type MatchRow, type SqlDb } from './privacy.ts';

/** A finished match waiting to be written: the record (R2) and the rows (D1). */
export interface PendingRecord {
  body: string;
  row: MatchRow;
  /** The record and the match row are written; only the seats left in row.seats are not. */
  seatsOnly?: boolean;
  /** Writes that found a seat's device missing from D1, and when to try again. */
  tries?: number;
  retryAt?: number;
}

export const RECORD_PREFIX = 'rec:';
/** A failed write is tried again this long after. */
export const RECORD_RETRY_MS = 60_000;
/** A seat whose device D1 does not have is tried this many more times, RECORD_RETRY_MS apart. */
export const SEAT_RETRIES = 5;

/** The part of a Durable Object's synchronous storage (ctx.storage.kv) used here. */
export interface RecordStore {
  get(key: string): unknown;
  put(key: string, value: string): void;
  delete(key: string): unknown;
  list(options: { prefix: string }): Iterable<[string, unknown]>;
}

export function pendingCount(kv: RecordStore): number {
  return [...kv.list({ prefix: RECORD_PREFIX })].length;
}

/**
 * Writes every pending record once: R2 first (`put`), then D1, so a D1 row never points to a
 * missing record. A record that ends while this runs is taken too. A seat whose device D1 does not
 * have right now (a recovery moving it to a new id, a deletion on its way) is kept for a few more
 * tries: Room.rekey() or Room.forget() fixes the record meanwhile (moveRecordSeats). Without this,
 * the person's seat link would be lost for good. Never throws: a failed write is tried again later.
 */
export async function flushPending(kv: RecordStore, db: SqlDb, put: (key: string, body: string) => Promise<unknown>, now: () => number): Promise<void> {
  const tried = new Set<string>();
  for (;;) {
    const next = [...kv.list({ prefix: RECORD_PREFIX })].filter(([key]) => !tried.has(key));
    if (next.length === 0) return;
    for (const [key, raw] of next) {
      tried.add(key);
      try {
        const p = JSON.parse(raw as string) as PendingRecord;
        if (p.retryAt !== undefined && p.retryAt > now()) continue;
        // R2 and D1 do not hold the room's input gate: a forget() or rekey() can rewrite the record
        // while they answer. Its version is then written in this same flush (the R2 put and the D1
        // rows are safe to repeat), never overwritten with the copy read above.
        if (!p.seatsOnly) await put(p.row.recordKey, p.body);
        const res = await db.batch(matchRowStatements(db, p.row));
        if (kv.get(key) !== raw) {
          tried.delete(key);
          continue;
        }
        const at = seatStatementIndexes(p.row);
        const missing = p.row.seats.filter((_, i) => res[at[i]]?.meta.changes === 0);
        const tries = (p.tries ?? 0) + 1;
        if (missing.length === 0 || tries > SEAT_RETRIES) {
          kv.delete(key);
        } else {
          // A waiting seat keeps its style counters: they are added when the seat is linked.
          const profiles = p.row.profiles?.filter((x) => missing.some((s) => s.seat === x.seat));
          // The brake's swap went in with the match row: the seats left over carry none.
          const kept: PendingRecord = { ...p, row: { ...p.row, seats: missing, profiles, brake: undefined }, seatsOnly: true, tries, retryAt: now() + RECORD_RETRY_MS };
          kv.put(key, JSON.stringify(kept));
        }
      } catch {
        // Tried again on the next alarm.
      }
    }
  }
}

/**
 * The room let go of a device (Room.letGo): its seats in the records waiting to be written move to
 * `to`, or go when `to` is null, with their style counters. A record that changed goes out at once.
 * Answers whether one did.
 */
export function moveRecordSeats(kv: RecordStore, device: string, to: string | null): boolean {
  let changed = false;
  for (const [key, raw] of kv.list({ prefix: RECORD_PREFIX })) {
    const p = JSON.parse(raw as string) as PendingRecord;
    if (!p.row.seats.some((s) => s.device === device) && !p.row.profiles?.some((x) => x.device === device)) continue;
    const seats = to ? p.row.seats.map((s) => (s.device === device ? { ...s, device: to } : s)) : p.row.seats.filter((s) => s.device !== device);
    const profiles = p.row.profiles && (to ? p.row.profiles.map((x) => (x.device === device ? { ...x, device: to } : x)) : p.row.profiles.filter((x) => x.device !== device));
    kv.put(key, JSON.stringify({ ...p, row: { ...p.row, seats, profiles }, retryAt: undefined }));
    changed = true;
  }
  return changed;
}
