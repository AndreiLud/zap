// The match allowance: after a human check, a device may start 10 matches (quick play, a room's
// start, a rematch) before it must pass the check again. Every start takes one match from D1 in a
// single conditional statement, so parallel requests and sockets opened earlier cannot overspend it.
//
// The brake (brake.ts) reserves the match's typical cost in the same batch: the allowance is taken
// only when the reservation went through, so a match the brake refuses costs the person nothing.

import { admitPlan, admitStatement, allowanceGuard, newTicket, refundStatement, type BrakeConfig, type LimitInfo, type Reservation, type TestLedger, type Usage } from './brake.ts';
import type { SqlDb, SqlStatement } from './privacy.ts';

/** A new human check is needed after this many matches started with one check. */
export const MATCHES_PER_CHECK = 10;

/** The statement that takes one match; with `ticket`, only when that admission of the brake went through in the same batch. */
function allowanceStatement(db: SqlDb, device: string, now: number, ticket: { key: string; ticket: string } | null): SqlStatement {
  const sql = `UPDATE devices SET matches_since_verify = matches_since_verify + 1, last_seen = ?1
       WHERE id = ?2 AND matches_since_verify < ?3 AND blocked_until <= ?1 AND verified_at IS NOT NULL AND adult_at IS NOT NULL${ticket ? ` AND ${allowanceGuard('?4', '?5')}` : ''}
       RETURNING matches_since_verify`;
  const values: unknown[] = [now, device, MATCHES_PER_CHECK];
  if (ticket) values.push(ticket.key, ticket.ticket);
  return db.prepare(sql).bind(...values);
}

/**
 * Takes one match from the device's allowance. Returns how many are left, or null when the device
 * has none: no check yet, no age declaration, blocked, or 10 matches already started.
 */
export async function reserveMatch(db: SqlDb, device: string, now: number): Promise<number | null> {
  const row = await allowanceStatement(db, device, now, null).first<{ matches_since_verify: number }>();
  return row ? MATCHES_PER_CHECK - row.matches_since_verify : null;
}

/** Gives back a match taken for a start that did not happen. */
export async function refundMatch(db: SqlDb, device: string): Promise<void> {
  await refundMatchStatement(db, device).run();
}

function refundMatchStatement(db: SqlDb, device: string): SqlStatement {
  return db.prepare('UPDATE devices SET matches_since_verify = matches_since_verify - 1 WHERE id = ? AND matches_since_verify > 0').bind(device);
}

export type Admission =
  | { ok: true; left: number; reservation: Reservation | null }
  | { ok: false; code: 'check_needed' }
  | { ok: false; code: 'limit_reached'; limit: LimitInfo };

/**
 * A match about to start with `people` at the table: the brake's reservation and one match of the
 * starter's allowance, in one batch. Refused by the brake: nothing is taken (the row counts one
 * more refusal, and `refusal` as spent: what asking cost). Admitted by the brake but the device
 * has no match left (a race with another start): the reservation goes back. With the brake off
 * and no test ledger, only the allowance.
 */
export async function admitMatch(
  db: SqlDb,
  cfg: BrakeConfig,
  device: string,
  people: number,
  now: number,
  ledger: TestLedger | null,
  refusal: Partial<Usage> = {},
): Promise<Admission> {
  const plan = admitPlan(cfg, people, now, ledger);
  if (!plan) {
    const left = await reserveMatch(db, device, now);
    return left === null ? { ok: false, code: 'check_needed' } : { ok: true, left, reservation: null };
  }
  const ticket = newTicket();
  const [brake, allowance] = await db.batch([admitStatement(db, plan, ticket, now, refusal), allowanceStatement(db, device, now, { key: plan.key, ticket })]);
  if ((brake.results?.[0] as { ticket?: string | null } | undefined)?.ticket !== ticket) return { ok: false, code: 'limit_reached', limit: plan.limit };
  const reservation: Reservation = { key: plan.key, est: plan.est };
  const row = allowance.results?.[0] as { matches_since_verify: number } | undefined;
  if (!row) {
    await refundStatement(db, reservation, now).run();
    return { ok: false, code: 'check_needed' };
  }
  return { ok: true, left: MATCHES_PER_CHECK - row.matches_since_verify, reservation };
}

/** Gives back what admitMatch took for a start that did not happen: the match of the allowance and the reservation. */
export async function refundAdmission(db: SqlDb, device: string, reservation: Reservation | null, now: number): Promise<void> {
  const stmts = [refundMatchStatement(db, device)];
  if (reservation) stmts.push(refundStatement(db, reservation, now));
  await db.batch(stmts);
}

/** Gives a reservation back alone (the starter's match was already given back, or never taken). */
export async function refundReservation(db: SqlDb, reservation: Reservation, now: number): Promise<void> {
  await refundStatement(db, reservation, now).run();
}
