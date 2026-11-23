// What D1 keeps about people, and how it is linked, exported, moved and deleted.
//
// * devices.id is the SHA-256 of the device cookie secret; devices.pseudonym is a random 128-bit
//   id that exists only in D1. Game data carries only a match id and seat numbers; match_seats is
//   the one place that links a pseudonym to a seat.
// * Deleting a device removes, in one transaction, the device row and every row that points to
//   its pseudonym. The match records in R2 never contained the person, so nothing there changes.
//   The rooms the device sits in are told first (Room.forget), found through room_members and
//   open_rooms. A room that could not be told then is kept in room_calls (see room-calls.ts).
// * Nothing here ever stores an IP address.
//
// The functions take a minimal database interface that D1 satisfies, so the unit tests run the
// same SQL on node:sqlite.

import { CODE_ALPHABET } from '../../shared/protocol.ts';
import { utcDate } from '../../shared/cycle-formats.ts';
import { hex, sha256Hex } from './auth.ts';
import { COUNT_COLUMNS, mergeProfilesSql, profileStatement, type SeatProfile } from './profiles.ts';
import { settleStatement, type Settlement } from './brake.ts';

export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface SqlDb {
  prepare(query: string): SqlStatement;
  batch(statements: SqlStatement[]): Promise<{ meta: { changes: number }; results?: unknown[] }[]>;
}

/** Devices (and their links) are deleted after 12 months without playing; so are old reports and reviewed flags. */
export const RETENTION_MS = 365 * 24 * 3600_000;
/** The group tokens of the daily export (export_groups) are kept this many days, then the cycle's flags can no longer find their person. */
export const EXPORT_GROUP_DAYS = 30;
/** A reviewed flag keeps its ref ('<export date>:<group>' of the cycle) this many days after the review. */
export const FLAG_REF_DAYS = 30;
export const REPORT_REASONS = ['nickname', 'phrases', 'cheating', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

// -----------------------------------------------------------------------------------------------
// Random ids and codes

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** A new internal pseudonym: 128 random bits as 32 hex characters. */
export function newPseudonym(): string {
  return hex(randomBytes(16));
}

export const RECOVERY_LENGTH = 20;

/** A recovery code: 20 characters of the room-code alphabet (about 99 bits) in groups of 5. */
export function newRecoveryCode(): string {
  let s = '';
  while (s.length < RECOVERY_LENGTH) {
    for (const x of randomBytes(32)) {
      // 31 symbols: bytes from 248 up are dropped so every symbol is equally likely.
      if (x < 248 && s.length < RECOVERY_LENGTH) s += CODE_ALPHABET[x % CODE_ALPHABET.length];
    }
  }
  return s.match(/.{5}/g)!.join(' ');
}

/** The code as typed (any case, spaces or dashes) to its 20 characters, or null when it cannot be one. */
export function normalizeRecoveryCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const s = raw.toUpperCase().replace(/[\s-]+/g, '');
  return s.length === RECOVERY_LENGTH && [...s].every((c) => CODE_ALPHABET.includes(c)) ? s : null;
}

/** Only this hash is stored; the code itself is shown once and never kept. */
export function recoveryHash(normalized: string): Promise<string> {
  return sha256Hex(`zap-recovery:${normalized}`);
}

// -----------------------------------------------------------------------------------------------
// The device behind a human check

/**
 * The device a browser plays as once it passed the human check (POST /api/session). Its own
 * (`known`, from its cookie) when D1 still has that row: the check and the match allowance start
 * over. Otherwise a new row for `fresh`, the id of a new secret. A cookie whose device D1 no longer
 * has (deleted, moved to another browser by a recovery, or removed after 12 months) never gets its
 * id back, so nothing still kept under the old id (a room that missed the call, a match record
 * waiting in a room) can reach a new row. One statement decides, so a deletion running at the same
 * moment cannot bring the old id back either.
 */
export async function checkedDevice(db: SqlDb, known: string | null, fresh: string, now: number): Promise<string> {
  if (known !== null) {
    const kept = await db
      .prepare('UPDATE devices SET verified_at = ?2, matches_since_verify = 0, pseudonym = COALESCE(pseudonym, ?3), adult_at = ?2, last_seen = ?2 WHERE id = ?1')
      .bind(known, now, newPseudonym())
      .run();
    if (kept.meta.changes > 0) return known;
  }
  await db
    .prepare('INSERT INTO devices (id, created_at, verified_at, matches_since_verify, pseudonym, adult_at, last_seen) VALUES (?1, ?2, ?2, 0, ?3, ?2, ?2)')
    .bind(fresh, now, newPseudonym())
    .run();
  return fresh;
}

// -----------------------------------------------------------------------------------------------
// Matches

export interface MatchRow {
  matchId: string;
  startedAt: number;
  endedAt: number;
  kind: string;
  variant: string;
  players: number;
  aiVersion: string;
  recordKey: string;
  /** People at the table, by device id; the pseudonym is looked up inside D1 and never leaves it. */
  seats: { seat: number; device: string; verified: boolean }[];
  /** Style counters of those seats (profiles.ts), each added to D1 right before its seat is linked. */
  profiles?: SeatProfile[];
  /** The brake's swap of this match's reservation for its real spend (brake.ts), applied once with the match row. */
  brake?: Settlement;
  /**
   * Moves the people at the table made themselves (MoveInfo.ms not null), for the public counters
   * of GET /api/live (live_counts). A pending row saved before milestone 7 has none: 0.
   */
  humanDecisions?: number;
}

/**
 * The rows of a finished match. Written after the record is in R2; safe to repeat. Each seat
 * statement changes one row when the seat is linked, also when an earlier write already linked it
 * (the row stays as it was), and none when D1 does not have the device: the room keeps only those
 * seats waiting (pending-records.ts). A seat with style counters gets its profiles statement right
 * before its seat statement, so the counters are added once: only while the seat is not linked yet
 * (seatStatementIndexes gives where each seat statement is in the batch). The brake's swap, when
 * the row carries one, comes before everything else, then the public counters (live_counts).
 */
export function matchRowStatements(db: SqlDb, m: MatchRow): SqlStatement[] {
  // The brake's swap goes first: it applies only while D1 has no row for this match, which the
  // match row's statement writes, so a batch tried again never counts the spend twice.
  const out: SqlStatement[] = m.brake ? [settleStatement(db, m.brake, m.endedAt, m.matchId)] : [];
  // The public counters, by the same rule: one match and its people's moves, once.
  out.push(liveCountStatement(db, m));
  out.push(
    db
      .prepare(
        'INSERT INTO matches (id, started_at, ended_at, kind, variant, players, ai_version, record_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
      )
      .bind(m.matchId, m.startedAt, m.endedAt, m.kind, m.variant, m.players, m.aiVersion, m.recordKey),
  );
  for (const s of m.seats) {
    const p = m.profiles?.find((x) => x.seat === s.seat && x.device === s.device);
    if (p) out.push(profileStatement(db, m.matchId, p, m.endedAt));
    out.push(
      db
        .prepare(
          `INSERT INTO match_seats (match_id, seat, pseudonym, verified) SELECT ?1, ?2, pseudonym, ?3 FROM devices WHERE id = ?4 AND pseudonym IS NOT NULL
           ON CONFLICT (match_id, seat) DO UPDATE SET pseudonym = match_seats.pseudonym`,
        )
        .bind(m.matchId, s.seat, s.verified ? 1 : 0, s.device),
    );
  }
  return out;
}

/**
 * Adds a finished match and the moves its people made to the public counters (GET /api/live),
 * only while D1 has no row for the match: matchRowStatements puts it before the match row.
 */
export function liveCountStatement(db: SqlDb, m: Pick<MatchRow, 'matchId' | 'endedAt' | 'humanDecisions'>): SqlStatement {
  const n = m.humanDecisions;
  const decisions = typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : 0;
  return db
    .prepare('UPDATE live_counts SET matches = matches + 1, decisions = decisions + ?1, updated_at = ?2 WHERE id = 1 AND NOT EXISTS (SELECT 1 FROM matches WHERE id = ?3)')
    .bind(decisions, m.endedAt, m.matchId);
}

/** Where the statement of each seat of m.seats is in matchRowStatements(m), in seat order. */
export function seatStatementIndexes(m: MatchRow): number[] {
  const out: number[] = [];
  // After the brake's swap (when there is one), the counters and the match row.
  let i = m.brake ? 3 : 2;
  for (const s of m.seats) {
    if (m.profiles?.some((x) => x.seat === s.seat && x.device === s.device)) i++;
    out.push(i++);
  }
  return out;
}

// -----------------------------------------------------------------------------------------------
// Rooms a device is in

/**
 * The room records that this device sits in it, valid until `until` (an expiry is never moved
 * back). Written only while D1 has the device, so a deleted or moved id never comes back here;
 * changes is 0 when it does not. The room keeps `until` at or past its own expiry (Room).
 */
export function roomMemberStatement(db: SqlDb, code: string, device: string, until: number): SqlStatement {
  return db
    .prepare(
      `INSERT INTO room_members (code, device, expires_at) SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM devices WHERE id = ?2)
       ON CONFLICT (code, device) DO UPDATE SET expires_at = MAX(room_members.expires_at, excluded.expires_at)`,
    )
    .bind(code, device, until);
}

/** A room's listing (open_rooms) and the membership of everyone seated there, both valid until `until`. */
export function roomListingStatements(db: SqlDb, code: string, until: number, seated: string[]): SqlStatement[] {
  return [
    db.prepare('UPDATE open_rooms SET expires_at = ?1 WHERE code = ?2').bind(until, code),
    ...seated.map((device) => roomMemberStatement(db, code, device, until)),
  ];
}

/** Codes of the live rooms this device sits in or created: the rooms to tell when it is deleted or moved. */
export async function roomsOf(db: SqlDb, device: string, now: number): Promise<string[]> {
  const res = await db
    .prepare('SELECT code FROM room_members WHERE device = ?1 AND expires_at > ?2 UNION SELECT code FROM open_rooms WHERE device = ?1 AND expires_at > ?2')
    .bind(device, now)
    .all<{ code: string }>();
  return res.results.map((r) => r.code);
}

// -----------------------------------------------------------------------------------------------
// Deletion

const PSEUDONYM_OF = '(SELECT pseudonym FROM devices WHERE id = ?1)';

/**
 * Everything that links this device to anything, in the order the subqueries need: seat links,
 * reports made (deleted), reports about them (keep no target), flags, style counters, the daily
 * export's group tokens (so a flag from the cycle can no longer find them), rooms, the device row.
 * A room the device created stays listed with no creator, so the others at the table can still
 * reach it; it counts toward nobody's limit. Recoveries to this device still waiting to reach a
 * room go too (the Worker settles them first). The two room statements answer their rooms.
 */
export function deleteDeviceStatements(db: SqlDb, device: string): SqlStatement[] {
  return [
    db.prepare(`DELETE FROM match_seats WHERE pseudonym = ${PSEUDONYM_OF}`).bind(device),
    db.prepare(`DELETE FROM reports WHERE reporter = ${PSEUDONYM_OF}`).bind(device),
    db.prepare(`UPDATE reports SET target = NULL WHERE target = ${PSEUDONYM_OF}`).bind(device),
    db.prepare(`DELETE FROM flags WHERE pseudonym = ${PSEUDONYM_OF}`).bind(device),
    db.prepare(`DELETE FROM profiles WHERE pseudonym = ${PSEUDONYM_OF}`).bind(device),
    db.prepare(`DELETE FROM export_groups WHERE pseudonym = ${PSEUDONYM_OF}`).bind(device),
    db.prepare("UPDATE open_rooms SET device = '' WHERE device = ?1 RETURNING code, expires_at").bind(device),
    db.prepare('DELETE FROM room_members WHERE device = ?1 RETURNING code, expires_at').bind(device),
    db.prepare('DELETE FROM room_calls WHERE to_device = ?1').bind(device),
    db.prepare('DELETE FROM devices WHERE id = ?1').bind(device),
  ];
}

/**
 * Deletes the device in one transaction. Answers the codes of the live rooms D1 still listed for
 * it, so the Worker can tell a room the device joined after it read the list (roomsOf).
 */
export async function deleteDevice(db: SqlDb, device: string, now: number): Promise<string[]> {
  const res = await db.batch(deleteDeviceStatements(db, device));
  const rows = res.flatMap((r) => (r.results ?? []) as { code?: unknown; expires_at?: unknown }[]);
  return [...new Set(rows.flatMap((r) => (typeof r.code === 'string' && Number(r.expires_at) > now ? [r.code] : [])))];
}

// -----------------------------------------------------------------------------------------------
// Recovery

/**
 * Moves the device that holds this recovery code to a new device id (the hash of a new secret
 * given to this browser). The pseudonym and the history stay; the code is used up. When this
 * browser already had a device of its own, its history, its reports and flags, its style counters
 * (added into the recovered ones per segment), its export group tokens, and its choices to stay
 * out of open data or adaptation join the recovered one, and its row goes away, so nothing is
 * left behind unreachable. With "Don't adapt to me" on after the merge, no counters stay. The person declared being 18 or older for this request, so a row
 * without that declaration (or without a pseudonym, from before migration 0003) gets one.
 * One transaction. Returns the recovered device's former id, or null when no device has the code.
 */
export async function recoverDevice(db: SqlDb, opts: { codeHash: string; newId: string; currentId: string | null; now: number }): Promise<string | null> {
  const target = await db.prepare('SELECT id FROM devices WHERE recovery_hash = ?').bind(opts.codeHash).first<{ id: string }>();
  if (!target) return null;
  const cur = opts.currentId && opts.currentId !== target.id ? opts.currentId : '';
  const NEW = '(SELECT pseudonym FROM devices WHERE id = ?1)';
  const CUR = '(SELECT pseudonym FROM devices WHERE id = ?2)';
  const MOVED = 'EXISTS (SELECT 1 FROM devices WHERE id = ?1)';
  const FROM_CUR = (col: string) => `COALESCE((SELECT ${col} FROM devices WHERE id = ?2), 0)`;
  const stmts: SqlStatement[] = [
    db
      .prepare(
        `UPDATE devices SET id = ?1, recovery_hash = NULL, last_seen = ?2, verified_at = ?2, matches_since_verify = 0,
           pseudonym = COALESCE(pseudonym, ?5), adult_at = COALESCE(adult_at, ?2)
         WHERE id = ?3 AND recovery_hash = ?4`,
      )
      .bind(opts.newId, opts.now, target.id, opts.codeHash, newPseudonym()),
  ];
  if (cur) {
    stmts.push(
      db.prepare(`UPDATE match_seats SET pseudonym = ${NEW} WHERE pseudonym = ${CUR} AND ${MOVED}`).bind(opts.newId, cur),
      db.prepare(`UPDATE reports SET reporter = ${NEW} WHERE reporter = ${CUR} AND ${MOVED}`).bind(opts.newId, cur),
      db.prepare(`UPDATE reports SET target = ${NEW} WHERE target = ${CUR} AND ${MOVED}`).bind(opts.newId, cur),
      // An open or confirmed flag from this browser wins over a cleared one, so the flag that
      // matters stays reviewable.
      db
        .prepare(
          `DELETE FROM flags WHERE pseudonym = ${NEW} AND decision = 'cleared' AND ${MOVED}
             AND EXISTS (SELECT 1 FROM flags WHERE pseudonym = ${CUR} AND (decision IS NULL OR decision <> 'cleared'))`,
        )
        .bind(opts.newId, cur),
      // A flag on either side stays; when both still have one, the recovered device's flag is kept.
      db.prepare(`UPDATE OR IGNORE flags SET pseudonym = ${NEW} WHERE pseudonym = ${CUR} AND ${MOVED}`).bind(opts.newId, cur),
      db.prepare(`DELETE FROM flags WHERE pseudonym = ${CUR} AND ${MOVED}`).bind(opts.newId, cur),
      // Style counters add up per segment; this browser's rows then go.
      db.prepare(mergeProfilesSql(NEW, CUR, MOVED)).bind(opts.newId, cur),
      db.prepare(`DELETE FROM profiles WHERE pseudonym = ${CUR} AND ${MOVED}`).bind(opts.newId, cur),
      // Group tokens of the daily exports follow the person, so a flag from the cycle still finds
      // them. When both browsers had one in the same export, the recovered one's stays.
      db.prepare(`UPDATE OR IGNORE export_groups SET pseudonym = ${NEW} WHERE pseudonym = ${CUR} AND ${MOVED}`).bind(opts.newId, cur),
      db.prepare(`DELETE FROM export_groups WHERE pseudonym = ${CUR} AND ${MOVED}`).bind(opts.newId, cur),
      // An objection made in either browser still holds after the merge.
      db
        .prepare(
          `UPDATE devices SET abandons = abandons + ${FROM_CUR('abandons')}, flagged = MAX(flagged, ${FROM_CUR('flagged')}),
             open_data_opt_out = MAX(open_data_opt_out, ${FROM_CUR('open_data_opt_out')}), no_adapt = MAX(no_adapt, ${FROM_CUR('no_adapt')})
           WHERE id = ?1`,
        )
        .bind(opts.newId, cur),
      db.prepare(`DELETE FROM devices WHERE id = ?2 AND ${MOVED}`).bind(opts.newId, cur),
    );
  }
  // "Don't adapt to me" on (from either browser): no style counters are kept.
  stmts.push(db.prepare(`DELETE FROM profiles WHERE pseudonym = ${NEW} AND (SELECT no_adapt FROM devices WHERE id = ?1) = 1`).bind(opts.newId));
  // NULL, never '', when this browser had no device: '' marks rooms whose creator deleted their data.
  const either = [opts.newId, target.id, cur || null];
  stmts.push(
    db.prepare(`UPDATE open_rooms SET device = ?1 WHERE device IN (?2, ?3) AND ${MOVED}`).bind(...either),
    // Both browsers may sit in the same room: the new id keeps one row there, with the later expiry.
    db
      .prepare(
        `INSERT INTO room_members (code, device, expires_at)
           SELECT code, ?1, MAX(expires_at) FROM room_members WHERE device IN (?2, ?3) AND ${MOVED} GROUP BY code
         ON CONFLICT (code, device) DO UPDATE SET expires_at = MAX(room_members.expires_at, excluded.expires_at)`,
      )
      .bind(...either),
    db.prepare(`DELETE FROM room_members WHERE device IN (?2, ?3) AND ${MOVED}`).bind(...either),
    // An earlier recovery still waiting to reach a room now ends at the new id.
    db.prepare(`UPDATE room_calls SET to_device = ?1 WHERE to_device IN (?2, ?3) AND ${MOVED}`).bind(...either),
  );
  const res = await db.batch(stmts);
  return res[0].meta.changes === 1 ? target.id : null;
}

// -----------------------------------------------------------------------------------------------
// Retention (daily Cron Trigger)

export interface RetentionResult {
  devices: number;
  reports: number;
  flags: number;
  rooms: number;
  members: number;
  calls: number;
  exportGroups: number;
  profiles: number;
}

/** Statements runRetention sends (one batch); the daily job's D1 budget counts each one. */
export const RETENTION_STATEMENTS = 17;

/**
 * Devices not seen for 12 months go away with every link (as if they had asked to delete),
 * reports older than 12 months, flags reviewed more than 12 months ago, expired open rooms,
 * expired room memberships, waiting room calls whose room is gone, and the daily export's group
 * tokens older than 30 days. A reviewed flag also loses its ref ('<export date>:<group>') 30 days
 * after the review, so D1 links a group token of the cycle to a person for at most 30 days once a
 * flag is reviewed (a flag still waiting for review keeps it). One batch of set statements, so it
 * stays far below the per-invocation query limit.
 *
 * A person who left a match keeps the seat through the others' rematches without being seen, so a
 * room still in use may hold a stale device. Like a deletion, retention then queues a call for that
 * room (room_calls) before the rows that find it go, and the scheduled handler delivers the calls
 * right after. A room the device created stays listed with no creator, so the others can still
 * reach it.
 */
export async function runRetention(db: SqlDb, now: number): Promise<RetentionResult> {
  const cutoff = now - RETENTION_MS;
  const groupsBefore = utcDate(now - EXPORT_GROUP_DAYS * 86_400_000);
  const STALE_IDS = 'SELECT id FROM devices WHERE COALESCE(last_seen, created_at) < ?1';
  const STALE = 'SELECT pseudonym FROM devices WHERE COALESCE(last_seen, created_at) < ?1 AND pseudonym IS NOT NULL';
  // In order: what finds a stale device's rows goes last (the device row). A named step's changes are in the result.
  const steps: [keyof RetentionResult | null, SqlStatement][] = [
    [
      null,
      db
        .prepare(
          `INSERT INTO room_calls (code, device, to_device, created_at)
             SELECT code, device, NULL, ?2 FROM (
               SELECT code, device FROM room_members WHERE device IN (${STALE_IDS})
               UNION SELECT code, device FROM open_rooms WHERE device IN (${STALE_IDS})
             ) WHERE code IN (SELECT code FROM open_rooms WHERE expires_at > ?2)
           ON CONFLICT (code, device) DO UPDATE SET to_device = NULL, created_at = excluded.created_at`,
        )
        .bind(cutoff, now),
    ],
    // A recovery to a stale device that still waits for a room ends as a deletion there.
    [null, db.prepare(`UPDATE room_calls SET to_device = NULL WHERE to_device IN (${STALE_IDS})`).bind(cutoff)],
    [null, db.prepare(`DELETE FROM match_seats WHERE pseudonym IN (${STALE})`).bind(cutoff)],
    [null, db.prepare(`DELETE FROM reports WHERE reporter IN (${STALE})`).bind(cutoff)],
    [null, db.prepare(`UPDATE reports SET target = NULL WHERE target IN (${STALE})`).bind(cutoff)],
    [null, db.prepare(`DELETE FROM flags WHERE pseudonym IN (${STALE})`).bind(cutoff)],
    ['profiles', db.prepare(`DELETE FROM profiles WHERE pseudonym IN (${STALE})`).bind(cutoff)],
    ['exportGroups', db.prepare(`DELETE FROM export_groups WHERE export_date < ?2 OR pseudonym IN (${STALE})`).bind(cutoff, groupsBefore)],
    [null, db.prepare(`UPDATE open_rooms SET device = '' WHERE device IN (${STALE_IDS})`).bind(cutoff)],
    [null, db.prepare(`DELETE FROM room_members WHERE device IN (${STALE_IDS})`).bind(cutoff)],
    ['devices', db.prepare('DELETE FROM devices WHERE COALESCE(last_seen, created_at) < ?1').bind(cutoff)],
    ['reports', db.prepare('DELETE FROM reports WHERE created_at < ?1').bind(cutoff)],
    ['flags', db.prepare('DELETE FROM flags WHERE reviewed_at IS NOT NULL AND reviewed_at < ?1').bind(cutoff)],
    [null, db.prepare('UPDATE flags SET ref = NULL WHERE ref IS NOT NULL AND reviewed_at IS NOT NULL AND reviewed_at < ?1').bind(now - FLAG_REF_DAYS * 86_400_000)],
    ['rooms', db.prepare('DELETE FROM open_rooms WHERE expires_at <= ?1').bind(now)],
    ['members', db.prepare('DELETE FROM room_members WHERE expires_at <= ?1').bind(now)],
    ['calls', db.prepare('DELETE FROM room_calls WHERE code NOT IN (SELECT code FROM open_rooms WHERE expires_at > ?1)').bind(now)],
  ];
  const res = await db.batch(steps.map(([, st]) => st));
  const out: RetentionResult = { devices: 0, reports: 0, flags: 0, rooms: 0, members: 0, calls: 0, exportGroups: 0, profiles: 0 };
  steps.forEach(([name], i) => {
    if (name) out[name] = res[i].meta.changes;
  });
  return out;
}

// -----------------------------------------------------------------------------------------------
// The person's own data (GET /api/me/data)

interface DeviceDataRow {
  created_at: number;
  verified_at: number | null;
  matches_since_verify: number;
  flagged: number;
  blocked_until: number;
  pseudonym: string | null;
  adult_at: number | null;
  last_seen: number | null;
  nickname: string | null;
  nickname_hidden: number;
  open_data_opt_out: number;
  no_adapt: number;
  abandons: number;
  has_recovery: number;
}

export interface MyData {
  generatedAt: number;
  /** The internal pseudonym: the only id that links this device to its seats; it never leaves D1 except here. */
  pseudonym: string | null;
  device: {
    createdAt: number;
    lastSeen: number | null;
    adultAt: number | null;
    verifiedAt: number | null;
    matchesSinceVerify: number;
    flagged: boolean;
    blockedUntil: number;
    abandons: number;
    nickname: string | null;
    nicknameHidden: boolean;
    prefs: { openDataOptOut: boolean; noAdapt: boolean };
    hasRecoveryCode: boolean;
  };
  matches: { matchId: string; seat: number; startedAt: number; endedAt: number; kind: string; verified: boolean }[];
  openRooms: { code: string; createdAt: number; expiresAt: number; mode: string }[];
  /** Rooms this device sits in, kept while the room lasts (up to 25 h after its last use). */
  joinedRooms: { code: string; expiresAt: number }[];
  reportsMade: { createdAt: number; matchId: string | null; roomCode: string | null; seat: number; reason: string; status: string }[];
  /** Only the day of each report (UTC midnight): an exact time could point to the reporter in a small room. */
  reportsAboutYou: { createdAt: number; reason: string; status: string }[];
  /** ref: the cycle's "<export date>:<group>" for a flag raised by the training cycle, null otherwise. */
  flags: { reason: string | null; createdAt: number; reviewedAt: number | null; decision: string | null; ref: string | null }[];
  /** Style counters per rules segment (profiles.ts; the keys of ProfileCounts in shared/profile.ts, D as decisions). */
  profile: ({ segment: string; matches: number; decisions: number } & Record<(typeof COUNT_COLUMNS)[number][0], number>)[];
  /** The random group of this person in each daily export of the last 30 days. */
  exportGroups: { exportDate: string; group: string }[];
}

/**
 * Everything D1 keeps about this device, without the device id, the secret or the recovery hash
 * (only whether a code exists). Other people appear in nothing returned here.
 */
export async function myData(db: SqlDb, device: string, now: number): Promise<MyData | null> {
  const row = await db
    .prepare(
      `SELECT created_at, verified_at, matches_since_verify, flagged, blocked_until, pseudonym, adult_at, last_seen, nickname,
              nickname_hidden, open_data_opt_out, no_adapt, abandons, recovery_hash IS NOT NULL AS has_recovery
       FROM devices WHERE id = ?`,
    )
    .bind(device)
    .first<DeviceDataRow>();
  if (!row) return null;
  const p = row.pseudonym ?? '';
  const counts = COUNT_COLUMNS.map(([k, col]) => `${col} AS ${k}`).join(', ');
  const [matches, rooms, joined, made, about, flags, profile, groups] = await db.batch([
    db
      .prepare(
        `SELECT s.match_id AS matchId, s.seat AS seat, m.started_at AS startedAt, m.ended_at AS endedAt, m.kind AS kind, s.verified AS verified
         FROM match_seats s JOIN matches m ON m.id = s.match_id WHERE s.pseudonym = ? ORDER BY m.ended_at DESC`,
      )
      .bind(p),
    db.prepare('SELECT code, created_at AS createdAt, expires_at AS expiresAt, mode FROM open_rooms WHERE device = ? AND expires_at > ? ORDER BY created_at').bind(device, now),
    db.prepare('SELECT code, expires_at AS expiresAt FROM room_members WHERE device = ? AND expires_at > ? ORDER BY expires_at').bind(device, now),
    db
      .prepare('SELECT created_at AS createdAt, match_id AS matchId, room_code AS roomCode, seat, reason, status FROM reports WHERE reporter = ? ORDER BY created_at')
      .bind(p),
    db.prepare('SELECT (created_at / 86400000) * 86400000 AS createdAt, reason, status FROM reports WHERE target = ? ORDER BY created_at').bind(p),
    db.prepare('SELECT reason, created_at AS createdAt, reviewed_at AS reviewedAt, decision, ref FROM flags WHERE pseudonym = ?').bind(p),
    db.prepare(`SELECT segment, matches, decisions, ${counts} FROM profiles WHERE pseudonym = ? ORDER BY segment`).bind(p),
    db.prepare('SELECT export_date AS exportDate, grp AS "group" FROM export_groups WHERE pseudonym = ? ORDER BY export_date').bind(p),
  ]);
  const rows = <T>(r: { results?: unknown[] }) => (r.results ?? []) as T[];
  return {
    generatedAt: now,
    pseudonym: row.pseudonym,
    device: {
      createdAt: row.created_at,
      lastSeen: row.last_seen,
      adultAt: row.adult_at,
      verifiedAt: row.verified_at,
      matchesSinceVerify: row.matches_since_verify,
      flagged: row.flagged !== 0,
      blockedUntil: row.blocked_until,
      abandons: row.abandons,
      nickname: row.nickname,
      nicknameHidden: row.nickname_hidden !== 0,
      prefs: { openDataOptOut: row.open_data_opt_out !== 0, noAdapt: row.no_adapt !== 0 },
      hasRecoveryCode: row.has_recovery !== 0,
    },
    matches: rows<MyData['matches'][number] & { verified: number | boolean }>(matches).map((m) => ({ ...m, verified: Boolean(m.verified) })),
    openRooms: rows<MyData['openRooms'][number]>(rooms),
    joinedRooms: rows<MyData['joinedRooms'][number]>(joined),
    reportsMade: rows<MyData['reportsMade'][number]>(made),
    reportsAboutYou: rows<MyData['reportsAboutYou'][number]>(about),
    flags: rows<MyData['flags'][number]>(flags),
    profile: rows<MyData['profile'][number]>(profile),
    exportGroups: rows<MyData['exportGroups'][number]>(groups),
  };
}
