// Steps 3 to 5 of the daily cron (worker/src/cron.ts), the Worker's half of the training cycle's
// human layers (contract sections 1.6 to 1.9 and 2.4 to 2.6):
//
//   3 flags   import control/flags.json: each flag of the cycle finds its person through the
//             export's group token inside D1, and takes them out of training at once
//   4 priors  import control/priors.json, the population priors of "How Zap reads you"
//   5 export  exports/YYYY-MM-DD.json in zap-events: one row per linked seat, with a random group
//             per person that is new in every export; exports older than 7 days are deleted
//
// All three stay off until the cycle exists (its manifest.json in zap-models): before that nobody
// reads an export, so none is made. No pseudonym, device id, nickname, room code or IP ever leaves
// D1 here: D1 builds the export rows itself (json_object, group_concat), and the flags import
// resolves the cycle's refs to people with SQL.

import {
  EXPORTS_PREFIX,
  EXPORT_KEEP_DAYS,
  FLAGS_KEY,
  LIMITS,
  MANIFEST_KEY,
  PRIORS_KEY,
  REPORT_REASONS,
  SCHEMAS,
  exportKey,
  parseChecked,
  utcDate,
  validateFlags,
  validatePriorsFile,
  type FlagOp,
  type ReceiptJobs,
} from '../../shared/cycle-formats.ts';
import { ABANDON_MAX_CUT } from '../../shared/weights.ts';
import { sha256Hex } from './auth.ts';
import { JSON_TYPE, listKeys, type Bucket, type DailyDeps } from './cron.ts';
import { countingDb, type CountingDb } from './d1-budget.ts';
import type { SqlDb } from './privacy.ts';

/** The largest share of weight abandons take from a person's moves (shared/weights.ts; the personal page says it). */
export { ABANDON_MAX_CUT };

/** What every job gets: the day's date (UTC) and time, and the bindings. */
export interface JobContext {
  deps: DailyDeps;
  now: number;
  date: string;
}

export type { Bucket };

const DAY_MS = 86_400_000;
/**
 * A flag of the cycle that arrives less than this long after the owner cleared the person's last
 * flag is ignored: the cycle looks back 14 days ([human.flags] lookback_days) and gives the person
 * a new group in every export, so it would otherwise raise the same evidence again under a new ref
 * and undo the human review. Keep it above lookback_days.
 */
export const CLEARED_GRACE_MS = 15 * DAY_MS;
/**
 * A flag for the same reason as the one the owner cleared waits longer: a person whose play keeps
 * a pattern (much volume, say) would otherwise be flagged again, and taken out of training, every
 * 15 to 21 days. Other reasons still count from CLEARED_GRACE_MS.
 */
export const CLEARED_SAME_REASON_GRACE_MS = 90 * DAY_MS;
/** The whole daily run stays at or below this many D1 statements (Workers Free allows 50). */
export const RUN_STATEMENT_BUDGET = 45;
/** Export rows per D1 statement (keyset pages on match_id, seat). */
export const EXPORT_PAGE_ROWS = 5000;
/**
 * Open reports in one export, newest first; more makes the export partial. They travel as one D1
 * value (json_group_array), and a D1 string or row holds at most 2,000,000 bytes: at this cap the
 * widest report row keeps that value under half of it (worker/test/cycle-jobs.test.ts).
 */
export const EXPORT_MAX_REPORTS = 5_000;

const OFF_FLAGS: ReceiptJobs['flags'] = { status: 'off', error: null, sha256: null, applied: [], ignored: [], unresolved: [], reviewed: [] };
const OFF_PRIORS: ReceiptJobs['priors'] = { status: 'off', error: null, sha256: null, imported: false };
const OFF_EXPORT: ReceiptJobs['export'] = { status: 'off', error: null, key: null, rows: 0, reports: 0, partial: false, sha256: null };

/** The cycle exists once it wrote its manifest (training/cycle init); until then the three jobs are off. */
async function cycleOn(ctx: JobContext): Promise<Bucket | null> {
  const models = ctx.deps.models;
  if (!models) return null;
  return (await models.head(MANIFEST_KEY)) ? models : null;
}

/** The text of a control file and its SHA-256, or null when the cycle has not written it. */
async function controlFile(models: Bucket, key: string, limit: number): Promise<{ body: string; sha256: string } | null> {
  const obj = await models.get(key);
  if (!obj) return null;
  if (obj.size > limit) throw new Error(`${key}: ${obj.size} bytes, over ${limit}`);
  const body = await obj.text();
  return { body, sha256: await sha256Hex(body) };
}

async function importedSha(db: SqlDb, name: 'flags' | 'priors'): Promise<string | null> {
  const row = await db.prepare('SELECT sha256 FROM cycle_imports WHERE name = ?1').bind(name).first<{ sha256: string }>();
  return row?.sha256 ?? null;
}

function importStatement(db: SqlDb, name: 'flags' | 'priors', sha256: string, body: string | null, now: number) {
  return db
    .prepare(
      'INSERT INTO cycle_imports (name, sha256, body, imported_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (name) DO UPDATE SET sha256 = excluded.sha256, body = excluded.body, imported_at = excluded.imported_at',
    )
    .bind(name, sha256, body, now);
}

const errorsText = (errors: string[]) => errors.slice(0, 3).join('; ');

// -----------------------------------------------------------------------------------------------
// Step 3: flags

/** A person's row in D1 flags, as the import sees it (no pseudonym: a number per person in this import). */
interface FlagState {
  ref: string | null;
  reason: string | null;
  createdAt: number | null;
  reviewedAt: number | null;
  decision: string | null;
  changed: boolean;
}

export type RefStatus = 'applied' | 'ignored' | 'unresolved' | 'reviewed';

/**
 * Applies the cycle's flag operations in order (contract 1.9) and answers the status of every ref
 * in them. D1 gives, for each ref it can resolve (through flags.ref, or through export_groups for
 * that export date and group), a number for the person and their current flags row; the pseudonym
 * itself stays in D1. Every operation is idempotent, so the whole list runs again whenever the file
 * changes. One read and one batch of three writes.
 */
export async function importFlags(db: SqlDb, ops: FlagOp[], sha256: string, now: number): Promise<Record<RefStatus, string[]>> {
  const refs = [...new Set(ops.map((o) => o.ref))];
  type Resolved = { ref: string; person: number; flagRef: string | null; reason: string | null; createdAt: number | null; reviewedAt: number | null; decision: string | null };
  const found = await db
    .prepare(
      `WITH r AS (SELECT DISTINCT value AS ref FROM json_each(?1)),
       res AS (
         SELECT r.ref AS ref, COALESCE(
           (SELECT f.pseudonym FROM flags f WHERE f.ref = r.ref),
           (SELECT e.pseudonym FROM export_groups e WHERE e.export_date = substr(r.ref, 1, 10) AND e.grp = substr(r.ref, 12))) AS p
         FROM r
       )
       SELECT res.ref AS ref, dense_rank() OVER (ORDER BY res.p) AS person, f.ref AS flagRef, f.reason AS reason,
              f.created_at AS createdAt, f.reviewed_at AS reviewedAt, f.decision AS decision
       FROM res LEFT JOIN flags f ON f.pseudonym = res.p
       WHERE res.p IS NOT NULL`,
    )
    .bind(JSON.stringify(refs))
    .all<Resolved>();
  const personOf = new Map<string, number>();
  const people = new Map<number, FlagState | null>();
  for (const r of found.results) {
    personOf.set(r.ref, r.person);
    if (!people.has(r.person)) {
      people.set(r.person, r.flagRef !== null || r.createdAt !== null ? { ref: r.flagRef, reason: r.reason, createdAt: r.createdAt, reviewedAt: r.reviewedAt, decision: r.decision, changed: false } : null);
    }
  }
  const status = new Map<string, RefStatus>();
  for (const op of ops) {
    const p = personOf.get(op.ref);
    const st = p === undefined ? undefined : people.get(p);
    if (op.op === 'flag') {
      if (p === undefined) {
        if (!status.has(op.ref)) status.set(op.ref, 'unresolved');
      } else if (st && st.ref === op.ref) {
        // Applied by an earlier import (or earlier in this list).
        status.set(op.ref, st.reviewedAt === null ? 'applied' : 'reviewed');
      } else if (st && st.decision !== 'cleared') {
        // An open or confirmed flag (any review other than a clear counts as confirmed).
        status.set(op.ref, 'ignored');
      } else if (st && st.reviewedAt !== null && op.at - st.reviewedAt < (st.reason === op.reason ? CLEARED_SAME_REASON_GRACE_MS : CLEARED_GRACE_MS)) {
        // Cleared by the owner less than 15 days before (90 for the same reason): the same
        // evidence, or the same pattern, judged already.
        status.set(op.ref, 'ignored');
      } else {
        // No flag, or one cleared long enough before: this flag takes its place.
        people.set(p, { ref: op.ref, reason: op.reason, createdAt: op.at, reviewedAt: null, decision: null, changed: true });
        status.set(op.ref, 'applied');
      }
    } else if (st && st.ref === op.ref) {
      if (st.reviewedAt === null) {
        st.reviewedAt = op.at;
        st.decision = op.op === 'confirm' ? 'confirmed' : 'cleared';
        st.changed = true;
      }
      status.set(op.ref, 'reviewed');
    } else if (!status.has(op.ref)) {
      status.set(op.ref, 'unresolved');
    }
  }
  const changed = [...people.values()].filter((s): s is FlagState => s !== null && s.changed && s.ref !== null);
  const rows = JSON.stringify(changed.map((s) => ({ ref: s.ref, reason: s.reason, createdAt: s.createdAt, reviewedAt: s.reviewedAt, decision: s.decision })));
  const writes = [];
  if (changed.length > 0) {
    writes.push(
      // The final row of each person the list changed, found again by its ref inside D1.
      db
        .prepare(
          `INSERT INTO flags (pseudonym, reason, created_at, ref, reviewed_at, decision)
           SELECT p, reason, createdAt, ref, reviewedAt, decision FROM (
             SELECT COALESCE(
                 (SELECT f.pseudonym FROM flags f WHERE f.ref = json_extract(j.value, '$.ref')),
                 (SELECT e.pseudonym FROM export_groups e
                   WHERE e.export_date = substr(json_extract(j.value, '$.ref'), 1, 10) AND e.grp = substr(json_extract(j.value, '$.ref'), 12))) AS p,
               json_extract(j.value, '$.reason') AS reason, json_extract(j.value, '$.createdAt') AS createdAt,
               json_extract(j.value, '$.ref') AS ref, json_extract(j.value, '$.reviewedAt') AS reviewedAt, json_extract(j.value, '$.decision') AS decision
             FROM json_each(?1) j
           ) WHERE p IS NOT NULL
           ON CONFLICT (pseudonym) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at, ref = excluded.ref,
             reviewed_at = excluded.reviewed_at, decision = excluded.decision`,
        )
        .bind(rows),
      // Out of training while a flag is open or confirmed; back in once it is cleared.
      db
        .prepare(
          `UPDATE devices SET flagged = CASE WHEN (SELECT f.decision FROM flags f WHERE f.pseudonym = devices.pseudonym) = 'cleared' THEN 0 ELSE 1 END
           WHERE pseudonym IN (SELECT pseudonym FROM flags WHERE ref IN (SELECT json_extract(value, '$.ref') FROM json_each(?1)))`,
        )
        .bind(rows),
    );
  }
  writes.push(importStatement(db, 'flags', sha256, null, now));
  await db.batch(writes);
  const out: Record<RefStatus, string[]> = { applied: [], ignored: [], unresolved: [], reviewed: [] };
  for (const ref of refs) out[status.get(ref) ?? 'unresolved'].push(ref);
  return out;
}

export async function flagsJob(ctx: JobContext): Promise<ReceiptJobs['flags']> {
  const models = await cycleOn(ctx);
  if (!models) return OFF_FLAGS;
  const file = await controlFile(models, FLAGS_KEY, LIMITS.flags);
  if (!file) return { ...OFF_FLAGS, status: 'skipped' };
  // The same file as the last import: nothing to do (that day's receipt has its lists).
  if ((await importedSha(ctx.deps.db, 'flags')) === file.sha256) return { ...OFF_FLAGS, status: 'skipped', sha256: file.sha256 };
  const checked = parseChecked('flags', file.body, validateFlags);
  if (!checked.ok) throw new Error(`control/flags.json refused: ${errorsText(checked.errors)}`);
  const lists = await importFlags(ctx.deps.db, checked.value.ops, file.sha256, ctx.now);
  return { status: 'ok', error: null, sha256: file.sha256, ...lists };
}

// -----------------------------------------------------------------------------------------------
// Step 4: priors

export async function priorsJob(ctx: JobContext): Promise<ReceiptJobs['priors']> {
  const models = await cycleOn(ctx);
  if (!models) return OFF_PRIORS;
  const file = await controlFile(models, PRIORS_KEY, LIMITS.priors);
  if (!file) return { ...OFF_PRIORS, status: 'skipped' };
  if ((await importedSha(ctx.deps.db, 'priors')) === file.sha256) return { ...OFF_PRIORS, status: 'skipped', sha256: file.sha256 };
  const checked = parseChecked('priors', file.body, validatePriorsFile);
  if (!checked.ok) throw new Error(`control/priors.json refused: ${errorsText(checked.errors)}`);
  await importStatement(ctx.deps.db, 'priors', file.sha256, file.body, ctx.now).run();
  return { status: 'ok', error: null, sha256: file.sha256, imported: true };
}

// -----------------------------------------------------------------------------------------------
// Step 5: export

/** One group token per person with linked seats, new for this export date (a second run that day keeps them). */
export function groupsStatement(db: SqlDb, date: string) {
  return db
    .prepare(
      `INSERT OR IGNORE INTO export_groups (export_date, grp, pseudonym)
       SELECT ?1, lower(hex(randomblob(8))), pseudonym FROM (SELECT DISTINCT pseudonym FROM match_seats WHERE pseudonym IS NOT NULL)`,
    )
    .bind(date);
}

/** Open reports, newest first, as one JSON array; the target only as its group in this export. */
export function reportsStatement(db: SqlDb, date: string) {
  const reasons = REPORT_REASONS.map((r) => `'${r}'`).join(', ');
  const OPEN = `status = 'open' AND reason IN (${reasons}) AND seat BETWEEN 0 AND 3 AND created_at IS NOT NULL`;
  return db
    .prepare(
      `SELECT json_group_array(json_object(
                'id', r.id, 'day', strftime('%Y-%m-%d', r.created_at / 1000, 'unixepoch'), 'reason', r.reason,
                'matchId', CASE WHEN length(r.match_id) = 36 THEN lower(r.match_id) END, 'seat', r.seat, 'group', g.grp)) AS reports,
              count(*) AS n, (SELECT count(*) FROM reports WHERE ${OPEN}) AS total
       FROM (SELECT * FROM reports WHERE ${OPEN} ORDER BY id DESC LIMIT ?2) r
       LEFT JOIN export_groups g ON g.export_date = ?1 AND g.pseudonym = r.target`,
    )
    .bind(date, EXPORT_MAX_REPORTS);
}

/**
 * One page of export rows after (match_id, seat), built by D1 as JSON text joined with commas
 * (contract 1.6): weight 0 when flagged, else v * (1 - min(ABANDON_MAX_CUT, abandons / max(10, seats))) with v
 * 1 for a verified seat and 0.5 otherwise, seats the count of that person's linked seats. The
 * count is read only for people with abandons (the factor is 1 without them), which keeps the rows
 * D1 reads close to the rows written.
 */
export function pageStatement(db: SqlDb, date: string, after: { matchId: string; seat: number }, limit = EXPORT_PAGE_ROWS) {
  const bool = (col: string) => `json(CASE WHEN ${col} THEN 'true' ELSE 'false' END)`;
  return db
    .prepare(
      `WITH page AS MATERIALIZED (
         SELECT match_id, seat, pseudonym, verified FROM match_seats
         WHERE pseudonym IS NOT NULL AND (match_id, seat) > (?2, ?3) ORDER BY match_id, seat LIMIT ?4
       ),
       tail AS MATERIALIZED (SELECT match_id, seat FROM page ORDER BY match_id DESC, seat DESC LIMIT 1)
       SELECT group_concat(x.row, ',') AS part, count(x.row) AS rows,
              (SELECT count(*) FROM page) AS n,
              (SELECT match_id FROM tail) AS lastMatch, (SELECT seat FROM tail) AS lastSeat,
              EXISTS (SELECT 1 FROM match_seats WHERE pseudonym IS NOT NULL AND (match_id, seat) > (SELECT match_id, seat FROM tail)) AS more
       FROM (
         SELECT json_object(
           'matchId', p.match_id, 'seat', p.seat,
           'weight', CASE WHEN d.flagged != 0 THEN 0 ELSE round(
             (CASE WHEN p.verified = 1 THEN 1.0 ELSE 0.5 END)
             * (CASE WHEN d.abandons <= 0 THEN 1.0
                ELSE 1 - min(${ABANDON_MAX_CUT}, d.abandons * 1.0 / max(10, (SELECT count(*) FROM match_seats m WHERE m.pseudonym = p.pseudonym))) END), 3) END,
           'flagged', ${bool('d.flagged != 0')}, 'openDataOptOut', ${bool('d.open_data_opt_out != 0')}, 'noAdapt', ${bool('d.no_adapt != 0')},
           'group', g.grp) AS row
         FROM page p
         JOIN devices d ON d.pseudonym = p.pseudonym
         JOIN export_groups g ON g.export_date = ?1 AND g.pseudonym = p.pseudonym
       ) x`,
    )
    .bind(date, after.matchId, after.seat, limit);
}

interface Page {
  part: string | null;
  rows: number;
  n: number;
  lastMatch: string | null;
  lastSeat: number | null;
  more: number;
}

/** The export file of one run, as text, and its counts (contract 1.6). */
export async function buildExport(
  db: SqlDb,
  date: string,
  now: number,
  budget: number,
  pageRows = EXPORT_PAGE_ROWS,
): Promise<{ body: string; rows: number; reports: number; partial: boolean }> {
  let left = budget;
  let partial = false;
  if (left < 2) {
    // Not even the groups and the reports fit: an empty export that says so.
    return { body: exportBody(date, now, true, [], '[]'), rows: 0, reports: 0, partial: true };
  }
  const [, rep] = await db.batch([groupsStatement(db, date), reportsStatement(db, date)]);
  left -= 2;
  const r = ((rep.results ?? []) as { reports: string | null; n: number; total: number }[])[0];
  const reportsJson = r?.reports ?? '[]';
  const reports = Number(r?.n ?? 0);
  if (Number(r?.total ?? 0) > reports) partial = true;
  const parts: string[] = [];
  let rows = 0;
  let after = { matchId: '', seat: -1 };
  for (;;) {
    if (left < 1) {
      partial = true;
      break;
    }
    const p = (await pageStatement(db, date, after, pageRows).first<Page>())!;
    left--;
    if (p.part) parts.push(p.part);
    rows += Number(p.rows);
    if (!p.more || p.lastMatch === null || p.lastSeat === null) break;
    after = { matchId: p.lastMatch, seat: Number(p.lastSeat) };
  }
  return { body: exportBody(date, now, partial, parts, reportsJson), rows, reports, partial };
}

function exportBody(date: string, now: number, partial: boolean, parts: string[], reports: string): string {
  return `{"schema":${JSON.stringify(SCHEMAS.export)},"date":${JSON.stringify(date)},"createdAt":${now},"partial":${partial},"rows":[${parts.join(',')}],"reports":${reports}}`;
}

export async function exportJob(ctx: JobContext): Promise<ReceiptJobs['export']> {
  if (!(await cycleOn(ctx))) return OFF_EXPORT;
  // The run's statements so far (the scheduled handler counts them all); a database that does
  // not count is counted from here.
  const db: CountingDb = countingDb(ctx.deps.db);
  const built = await buildExport(db, ctx.date, ctx.now, RUN_STATEMENT_BUDGET - db.statements);
  const key = exportKey(ctx.date);
  await ctx.deps.events.put(key, built.body, { httpMetadata: { contentType: JSON_TYPE } });
  const sha256 = await sha256Hex(built.body);
  // Exports older than 7 days go (the cycle keeps only the newest one it downloaded).
  const cutoff = utcDate(ctx.now - EXPORT_KEEP_DAYS * DAY_MS);
  const old = (await listKeys(ctx.deps.events, EXPORTS_PREFIX)).filter((k) => {
    const m = /^exports\/(\d{4}-\d{2}-\d{2})\.json$/.exec(k);
    return m !== null && m[1] < cutoff;
  });
  if (old.length > 0) await ctx.deps.events.delete(old);
  return { status: 'ok', error: null, key, rows: built.rows, reports: built.reports, partial: built.partial, sha256 };
}
