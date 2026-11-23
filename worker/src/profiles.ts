// Style counters per person and rules segment in D1 `profiles` (milestone 6): what the room adds
// at the end of each match, and how the rows read back as one ProfileCounts. The counting itself
// is shared/profile.ts (profileCounts); the reading shown on the You page (/voce) is reading.ts.
//
// The counters live only in D1, keyed by the pseudonym, which the statements look up from the
// device id inside D1. They are not written for a person with "Don't adapt to me" on, they go when
// it is switched on, and they go with the device (deletion, retention). See retention.md.

import type { Segment } from '../../ai/src/opponent-stats.ts';
import { emptyProfile, type ProfileCounts } from '../../shared/profile.ts';
import type { SqlDb, SqlStatement } from './privacy.ts';

/** The counts of one person's seat in a finished match, kept with the match until D1 has them. */
export interface SeatProfile {
  seat: number;
  /** devices.id of the person in that seat; the pseudonym is looked up inside D1. */
  device: string;
  segment: Segment;
  counts: ProfileCounts;
}

/** D1 column of each ProfileCounts key (matches and decisions apart). */
export const COUNT_COLUMNS = [
  ['H', 'h'],
  ['K', 'k'],
  ['U', 'u'],
  ['A', 'a'],
  ['X', 'x'],
  ['S', 's'],
  ['Q', 'q'],
  ['V', 'v'],
  ['W', 'w'],
  ['BC', 'bc'],
  ['BR', 'br'],
  ['G', 'g'],
  ['GT', 'gt'],
  ['TN', 'tn'],
  ['TL', 'tl'],
  ['TL2', 'tl2'],
] as const satisfies readonly (readonly [keyof ProfileCounts, string])[];

/** Every counter column of `profiles`, in table order. */
export const PROFILE_COLUMNS = ['matches', 'decisions', ...COUNT_COLUMNS.map(([, c]) => c)] as const;

const SUMS = PROFILE_COLUMNS.map((c) => `${c} = ${c} + excluded.${c}`).join(', ');

/**
 * Adds one seat's counts to the person's row for that segment (contract 2.5). It writes nothing
 * when D1 does not have the device, when the person switched "Don't adapt to me" on, or when the
 * seat is already linked (a flush repeated after a retry or a recovery counts once). It goes in
 * the batch right before that seat's match_seats statement, which is what links the seat.
 */
export function profileStatement(db: SqlDb, matchId: string, p: SeatProfile, at: number): SqlStatement {
  const c = p.counts;
  return db
    .prepare(
      `INSERT INTO profiles (pseudonym, segment, matches, decisions, h, k, u, a, x, s, q, v, w, bc, br, g, gt, tn, tl, tl2, updated_at)
       SELECT pseudonym, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20 FROM devices
       WHERE id = ?1 AND pseudonym IS NOT NULL AND no_adapt = 0
         AND NOT EXISTS (SELECT 1 FROM match_seats WHERE match_id = ?21 AND seat = ?22)
       ON CONFLICT (pseudonym, segment) DO UPDATE SET matches = matches + 1, decisions = decisions + excluded.decisions,
         h = h + excluded.h, k = k + excluded.k, u = u + excluded.u, a = a + excluded.a, x = x + excluded.x, s = s + excluded.s,
         q = q + excluded.q, v = v + excluded.v, w = w + excluded.w, bc = bc + excluded.bc, br = br + excluded.br,
         g = g + excluded.g, gt = gt + excluded.gt, tn = tn + excluded.tn, tl = tl + excluded.tl, tl2 = tl2 + excluded.tl2,
         updated_at = excluded.updated_at`,
    )
    .bind(p.device, p.segment, c.D, ...COUNT_COLUMNS.map(([k]) => c[k]), at, matchId, p.seat);
}

/** Deletes the person's counters ("Don't adapt to me" switched on): only while the device has the switch on. */
export function dropProfilesIfNoAdapt(db: SqlDb, device: string): SqlStatement {
  return db.prepare('DELETE FROM profiles WHERE pseudonym = (SELECT pseudonym FROM devices WHERE id = ?1 AND no_adapt = 1)').bind(device);
}

/**
 * Adds the counters of one pseudonym into another's, segment by segment (a recovery merging this
 * browser's history into the recovered one). `into` and `from` are SQL expressions that give the
 * two pseudonyms; `cond` limits it (the recovery's "the move happened").
 */
export function mergeProfilesSql(into: string, from: string, cond: string): string {
  const cols = PROFILE_COLUMNS.join(', ');
  return `INSERT INTO profiles (pseudonym, segment, ${cols}, updated_at)
            SELECT ${into}, segment, ${cols}, updated_at FROM profiles WHERE pseudonym = ${from} AND ${cond}
          ON CONFLICT (pseudonym, segment) DO UPDATE SET ${SUMS}, updated_at = MAX(updated_at, excluded.updated_at)`;
}

/** A profiles row as D1 gives it (lower case columns). */
export type ProfileRow = { segment: string } & Record<(typeof PROFILE_COLUMNS)[number], number>;

/** One row's counters as ProfileCounts. */
export function rowCounts(r: Partial<Record<(typeof PROFILE_COLUMNS)[number], unknown>>): ProfileCounts {
  const out = emptyProfile();
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  out.matches = num(r.matches);
  out.D = num(r.decisions);
  for (const [k, col] of COUNT_COLUMNS) out[k] = num(r[col]);
  return out;
}

/** The person's counters summed over the segments. */
export function sumRows(rows: Partial<Record<(typeof PROFILE_COLUMNS)[number], unknown>>[]): ProfileCounts {
  const out = emptyProfile();
  for (const r of rows) {
    const c = rowCounts(r);
    for (const k of Object.keys(out) as (keyof ProfileCounts)[]) out[k] += c[k];
  }
  return out;
}
