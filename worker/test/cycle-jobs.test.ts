// Steps 3 to 5 of the daily cron (worker/src/cycle-jobs.ts) on node:sqlite with the real
// migrations and in-memory buckets: the export of linked seats (weights, one random group per
// person and export, no person in the file, reports, keyset pages, the D1 budget), the import of
// the cycle's flags (resolved to people inside D1, in order, idempotent) and priors, and all three
// off until the cycle exists.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FLAGS_KEY,
  MANIFEST_KEY,
  PRIORS_KEY,
  REPORT_REASONS,
  SCHEMAS,
  exportKey,
  receiptKey,
  utcDate,
  validateExport,
  validateReceipt,
  type ExportFile,
  type FlagOp,
  type FlagsFile,
  type PriorsFile,
  type Receipt,
} from '../../shared/cycle-formats.ts';
import { runDaily, type AlertTexts, type Bucket, type DailyDeps } from '../src/cron.ts';
import { EXPORT_MAX_REPORTS, RUN_STATEMENT_BUDGET, buildExport, exportJob, flagsJob, importFlags, priorsJob } from '../src/cycle-jobs.ts';
import { countingDb } from '../src/d1-budget.ts';
import { RETENTION_STATEMENTS, matchRowStatements, newPseudonym, type SqlDb } from '../src/privacy.ts';
import { deliver, queuedCalls } from '../src/room-calls.ts';
import { readingFor } from '../src/reading.ts';
import { sha256Hex } from '../src/auth.ts';
import { deviceCap } from '../../training/cycle/node/build.ts';
import { testDb, type TestDb } from './sqlite-db.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 22, 4);
const TODAY = utcDate(NOW);
const TEXTS: AlertTexts = { subject: 's', failed: 'f', stale: 'st', missing: 'm' };
const DEFAULT_PRIORS: PriorsFile = JSON.parse(readFileSync('shared/profile-priors-default.json', 'utf8'));

class Mem implements Bucket {
  readonly data = new Map<string, string>();
  readonly types = new Map<string, string | undefined>();
  async get(key: string) {
    const v = this.data.get(key);
    return v === undefined ? null : { size: new TextEncoder().encode(v).byteLength, text: async () => v };
  }
  async head(key: string) {
    const v = this.data.get(key);
    return v === undefined ? null : { size: v.length };
  }
  async put(key: string, body: string, opts?: { httpMetadata?: { contentType?: string } }) {
    this.data.set(key, body);
    this.types.set(key, opts?.httpMetadata?.contentType);
  }
  async list(opts: { prefix: string }) {
    return { objects: [...this.data.keys()].filter((k) => k.startsWith(opts.prefix)).sort().map((key) => ({ key })), truncated: false };
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.data.delete(k);
  }
}

const dev = (c: string) => c.repeat(64);
/** A valid UUID (version 4 layout) from a number. */
const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

function addDevice(db: TestDb, id: string, over: Record<string, unknown> = {}): string {
  const pseudonym = newPseudonym();
  const row = { id, created_at: NOW - 10 * DAY, verified_at: NOW, pseudonym, adult_at: NOW, last_seen: NOW, ...over };
  const cols = Object.keys(row);
  db.raw.prepare(`INSERT INTO devices (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...(Object.values(row) as (string | number | null)[]));
  return pseudonym;
}

async function addMatch(db: SqlDb, n: number, seats: { seat: number; device: string; verified?: boolean }[]): Promise<string> {
  const matchId = uuid(n);
  await db.batch(
    matchRowStatements(db, {
      matchId,
      startedAt: NOW - DAY,
      endedAt: NOW - DAY + 60_000,
      kind: 'solo2',
      variant: 'paulista',
      players: 4,
      aiVersion: 'v1',
      recordKey: `matches/v1/2026/11/21/${matchId}.json`,
      seats: seats.map((s) => ({ verified: true, ...s })),
    }),
  );
  return matchId;
}

function setup(opts: { cycle?: boolean } = {}) {
  const db = testDb();
  const events = new Mem();
  const models = new Mem();
  if (opts.cycle !== false) models.data.set(MANIFEST_KEY, '{"schema":"zap-manifest/1"}');
  const deps: DailyDeps = { db, events, models, mailer: null, texts: TEXTS, deliverCalls: async () => 0 };
  return { db, events, models, deps, ctx: (now = NOW) => ({ deps, now, date: utcDate(now) }) };
}

const exportOf = (events: Mem, date = TODAY): ExportFile => JSON.parse(events.data.get(exportKey(date))!);

describe('cycle jobs before the cycle exists', () => {
  it('are off without the models bucket or before the cycle wrote its manifest, and make no export', async () => {
    for (const s of [setup({ cycle: false }), { ...setup(), models: null }]) {
      const deps = { ...s.deps, models: s.models };
      addDevice(s.db, dev('a'));
      await addMatch(s.db, 1, [{ seat: 0, device: dev('a') }]);
      const ctx = { deps, now: NOW, date: TODAY };
      expect(await flagsJob(ctx)).toEqual({ status: 'off', error: null, sha256: null, applied: [], ignored: [], unresolved: [], reviewed: [] });
      expect(await priorsJob(ctx)).toEqual({ status: 'off', error: null, sha256: null, imported: false });
      expect(await exportJob(ctx)).toEqual({ status: 'off', error: null, key: null, rows: 0, reports: 0, partial: false, sha256: null });
      expect([...s.events.data.keys()]).toEqual([]);
      expect(s.db.raw.prepare('SELECT COUNT(*) AS n FROM export_groups').get()).toEqual({ n: 0 });
    }
  });
});

describe('daily export', () => {
  it('the open reports of one export, one D1 value, stay under half of the 2,000,000 bytes D1 allows', () => {
    // The widest row reportsStatement builds: a 12 digit id, the longest reason, a 36 character match id, a 16 hex group.
    const reason = [...REPORT_REASONS].sort((a, b) => b.length - a.length)[0];
    const row = JSON.stringify({ id: 999_999_999_999, day: '2026-11-23', reason, matchId: `${'f'.repeat(8)}-ffff-ffff-ffff-${'f'.repeat(12)}`, seat: 3, group: 'f'.repeat(16) });
    expect(EXPORT_MAX_REPORTS * (row.length + 1) + 1).toBeLessThan(1_000_000);
  });

  it('one row per linked seat with its weight and switches, one random group per person, no person in the file', async () => {
    const { db, events, ctx } = setup();
    const pa = addDevice(db, dev('a'));
    const pb = addDevice(db, dev('b'), { abandons: 3, open_data_opt_out: 1 });
    const pc = addDevice(db, dev('c'), { flagged: 1, no_adapt: 1, nickname: 'Tatu' });
    const m1 = await addMatch(db, 1, [{ seat: 0, device: dev('a') }, { seat: 2, device: dev('b'), verified: false }]);
    const m2 = await addMatch(db, 2, [{ seat: 1, device: dev('a'), verified: false }, { seat: 3, device: dev('c') }]);
    const m3 = await addMatch(db, 3, [{ seat: 0, device: dev('b') }]);
    // A report about b in m1 (its group shows), one about an AI seat, and a reviewed one (left out).
    db.raw.prepare("INSERT INTO reports (created_at, match_id, room_code, seat, reason, reporter, target) VALUES (?, ?, 'ABCDE', 2, 'nickname', ?, ?)").run(NOW - DAY, m1, pa, pb);
    db.raw.prepare("INSERT INTO reports (created_at, match_id, room_code, seat, reason, reporter, target) VALUES (?, ?, 'ABCDE', 1, 'other', ?, NULL)").run(NOW - 2 * DAY, m2, pc);
    db.raw.prepare("INSERT INTO reports (created_at, match_id, room_code, seat, reason, reporter, target, status) VALUES (?, ?, 'ABCDE', 1, 'other', ?, ?, 'reviewed')").run(NOW, m2, pc, pa);

    const res = await exportJob(ctx());
    const body = events.data.get(exportKey(TODAY))!;
    expect(res).toEqual({ status: 'ok', error: null, key: exportKey(TODAY), rows: 5, reports: 2, partial: false, sha256: await sha256Hex(body) });
    expect(events.types.get(exportKey(TODAY))).toBe('application/json; charset=utf-8');
    const file = exportOf(events);
    const checked = validateExport(file);
    expect(checked.ok, JSON.stringify(checked)).toBe(true);
    expect(file).toMatchObject({ schema: SCHEMAS.export, date: TODAY, createdAt: NOW, partial: false });
    const groups = new Map((db.raw.prepare('SELECT pseudonym, grp FROM export_groups WHERE export_date = ?').all(TODAY) as { pseudonym: string; grp: string }[]).map((r) => [r.pseudonym, r.grp]));
    expect(groups.size).toBe(3);
    expect(new Set(groups.values()).size).toBe(3);
    const rows = [...file.rows].sort((x, y) => (x.matchId + x.seat < y.matchId + y.seat ? -1 : 1));
    // b: 3 abandons over max(10, 2 seats) = 0.3 off; a seat without the seal counts half. c is flagged: weight 0.
    expect(rows).toEqual([
      { matchId: m1, seat: 0, weight: 1, flagged: false, openDataOptOut: false, noAdapt: false, group: groups.get(pa) },
      { matchId: m1, seat: 2, weight: 0.35, flagged: false, openDataOptOut: true, noAdapt: false, group: groups.get(pb) },
      { matchId: m2, seat: 1, weight: 0.5, flagged: false, openDataOptOut: false, noAdapt: false, group: groups.get(pa) },
      { matchId: m2, seat: 3, weight: 0, flagged: true, openDataOptOut: false, noAdapt: true, group: groups.get(pc) },
      { matchId: m3, seat: 0, weight: 0.7, flagged: false, openDataOptOut: true, noAdapt: false, group: groups.get(pb) },
    ]);
    expect([...file.reports].sort((x, y) => x.id - y.id)).toEqual([
      { id: 1, day: '2026-11-21', reason: 'nickname', matchId: m1, seat: 2, group: groups.get(pb) },
      { id: 2, day: '2026-11-20', reason: 'other', matchId: m2, seat: 1, group: null },
    ]);
    for (const hidden of [pa, pb, pc, dev('a'), dev('b'), dev('c'), 'Tatu', 'ABCDE']) expect(body, hidden).not.toContain(hidden);

    // The next day: new groups for everyone, unrelated to the day before.
    await exportJob(ctx(NOW + DAY));
    const next = exportOf(events, utcDate(NOW + DAY));
    const before = new Set(file.rows.map((r) => r.group));
    expect(next.rows.some((r) => before.has(r.group))).toBe(false);
    // A second run the same day keeps that day's groups.
    await exportJob(ctx(NOW + DAY + 3600_000));
    expect(new Set(exportOf(events, utcDate(NOW + DAY)).rows.map((r) => r.group))).toEqual(new Set(next.rows.map((r) => r.group)));
  });

  it('a weight never drops below half of the seat value, and an empty database gives an empty export', async () => {
    const { db, events, ctx } = setup();
    expect(await exportJob(ctx())).toMatchObject({ status: 'ok', rows: 0, reports: 0, partial: false });
    expect(exportOf(events)).toEqual({ schema: SCHEMAS.export, date: TODAY, createdAt: NOW, partial: false, rows: [], reports: [] });
    addDevice(db, dev('a'), { abandons: 40 });
    for (let i = 0; i < 12; i++) await addMatch(db, 100 + i, [{ seat: 0, device: dev('a'), verified: i % 2 === 0 }]);
    await exportJob(ctx());
    expect(new Set(exportOf(events).rows.map((r) => r.weight))).toEqual(new Set([0.5, 0.25]));
  });

  it('reads the seats in keyset pages and stops, marked partial, when the run would pass its D1 budget', async () => {
    const { db } = setup();
    const ids = ['a', 'b', 'c', 'd'].map((c) => (addDevice(db, dev(c)), dev(c)));
    for (let i = 0; i < 25; i++) await addMatch(db, 200 + i, [{ seat: i % 4, device: ids[i % 4] }, { seat: (i + 1) % 4, device: ids[(i + 1) % 4] }]);
    const all = await buildExport(db, TODAY, NOW, 45, 7);
    const file = JSON.parse(all.body) as ExportFile;
    expect(validateExport(file).ok).toBe(true);
    expect(all).toMatchObject({ rows: 50, partial: false });
    expect(new Set(file.rows.map((r) => `${r.matchId}:${r.seat}`)).size).toBe(50);
    // 2 statements (groups, reports) and pages of 7 rows: 8 pages for 50 rows.
    const counted = countingDb(db);
    await buildExport(counted, TODAY, NOW, 45, 7);
    expect(counted.statements).toBe(2 + 8);
    // A budget of 5 statements: 3 pages, 21 rows, partial.
    const cut = await buildExport(db, TODAY, NOW, 5, 7);
    expect(cut).toMatchObject({ rows: 21, partial: true });
    expect(validateExport(JSON.parse(cut.body)).ok).toBe(true);
    expect(JSON.parse((await buildExport(db, TODAY, NOW, 1, 7)).body)).toMatchObject({ partial: true, rows: [], reports: [] });
  });

  it('deletes exports older than 7 days', async () => {
    const { events, ctx } = setup();
    for (const d of [9, 8, 7, 1]) await exportJob(ctx(NOW - d * DAY));
    events.data.set('exports/notes.txt', 'x');
    await exportJob(ctx());
    expect([...events.data.keys()].sort()).toEqual(['exports/2026-11-15.json', 'exports/2026-11-21.json', 'exports/2026-11-22.json', 'exports/notes.txt']);
  });

  it('D1 statements of a whole daily run for 100, 10,000 and 100,000 linked seats stay within the budget', async () => {
    const measured: Record<string, unknown>[] = [];
    for (const seats of [100, 10_000, 100_000]) {
      // "same": the cycle's control files were imported the day before; "new": both changed and the
      // flag finds its person, the most statements a run can need.
      for (const files of ['same', 'new'] as const) {
        const { db, events, models } = setup();
        const people = Math.max(4, Math.round(seats / 50));
        const pseudonyms: string[] = [];
        db.raw.exec('BEGIN');
        const ins = db.raw.prepare('INSERT INTO devices (id, created_at, verified_at, pseudonym, adult_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)');
        for (let i = 0; i < people; i++) {
          const p = newPseudonym();
          pseudonyms.push(p);
          ins.run(i.toString(16).padStart(64, '0'), NOW, NOW, p, NOW, NOW);
        }
        const seat = db.raw.prepare('INSERT INTO match_seats (match_id, seat, pseudonym, verified) VALUES (?, ?, ?, 1)');
        for (let i = 0; i < seats; i++) seat.run(uuid(Math.floor(i / 2)), i % 2, pseudonyms[i % people]);
        db.raw.exec('COMMIT');
        const runOnce = async (now: number) => {
          const c = countingDb(db);
          const deps: DailyDeps = { db: c, events, models, mailer: null, texts: TEXTS, deliverCalls: async () => deliver(c, [], await queuedCalls(c), async () => undefined, now) };
          const t0 = performance.now();
          const r = await runDaily(deps, now);
          return { r, statements: c.statements, ms: performance.now() - t0 };
        };
        const yesterday = NOW - DAY;
        if (files === 'same') {
          models.data.set(FLAGS_KEY, JSON.stringify({ schema: SCHEMAS.flags, createdAt: yesterday, ops: [] }));
          models.data.set(PRIORS_KEY, JSON.stringify(DEFAULT_PRIORS));
        }
        await runOnce(yesterday);
        if (files === 'new') {
          const grp = (db.raw.prepare('SELECT grp FROM export_groups WHERE export_date = ? LIMIT 1').get(utcDate(yesterday)) as { grp: string }).grp;
          const flags: FlagsFile = { schema: SCHEMAS.flags, createdAt: NOW, ops: [{ ref: `${utcDate(yesterday)}:${grp}`, op: 'flag', reason: 'volume', evidence: 'matches 400', at: NOW }] };
          models.data.set(FLAGS_KEY, JSON.stringify(flags));
          models.data.set(PRIORS_KEY, JSON.stringify({ ...DEFAULT_PRIORS, createdAt: NOW }));
        }
        const { r, statements, ms } = await runOnce(NOW);
        const receipt: Receipt = JSON.parse(events.data.get(receiptKey(TODAY))!);
        expect(validateReceipt(receipt).ok).toBe(true);
        expect(r.failed).toEqual([]);
        expect(statements).toBeLessThanOrEqual(RUN_STATEMENT_BUDGET);
        expect(receipt.jobs.flags.status).toBe(files === 'new' ? 'ok' : 'skipped');
        if (files === 'new') expect(receipt.jobs.flags.applied).toHaveLength(1);
        if (seats < 100_000 || files === 'same') expect(receipt.jobs.export.partial).toBe(false);
        expect(validateExport(exportOf(events)).ok).toBe(true);
        measured.push({ seats, files, statements, retention: RETENTION_STATEMENTS, exportRows: receipt.jobs.export.rows, partial: receipt.jobs.export.partial, runMs: Math.round(ms) });
      }
    }
    console.log(`daily run, D1 statements: ${JSON.stringify(measured)}`);
  }, 180_000);
});

describe('flags from the cycle', () => {
  const D = '2026-11-21';
  const ref = (g: string) => `${D}:${g.repeat(16)}`;
  const flag = (g: string, at = NOW - 3600_000): FlagOp => ({ ref: ref(g), op: 'flag', reason: 'regular-times', evidence: 'cv 0.04 over 260 decisions', at });
  const review = (g: string, op: 'confirm' | 'clear', at = NOW - 1800_000): FlagOp => ({ ref: ref(g), op, at });
  const flagsOf = (db: TestDb) => db.raw.prepare('SELECT d.id AS id, f.ref AS ref, f.reason AS reason, f.created_at AS createdAt, f.reviewed_at AS reviewedAt, f.decision AS decision, d.flagged AS flagged FROM devices d LEFT JOIN flags f ON f.pseudonym = d.pseudonym ORDER BY d.id').all();

  function people(db: TestDb) {
    const p: Record<string, string> = {};
    p.a = addDevice(db, dev('a'));
    p.b = addDevice(db, dev('b'), { flagged: 1 });
    p.c = addDevice(db, dev('c'));
    p.e = addDevice(db, dev('e'));
    // a, b, c and e each have a group in the export of D; c also in the day before.
    for (const k of ['a', 'b', 'c', 'e']) db.raw.prepare('INSERT INTO export_groups (export_date, grp, pseudonym) VALUES (?, ?, ?)').run(D, k.repeat(16), p[k]);
    db.raw.prepare('INSERT INTO export_groups (export_date, grp, pseudonym) VALUES (?, ?, ?)').run('2026-11-20', 'c'.repeat(16), p.c);
    // b has an open flag from the moderation of milestone 5 (no ref); c had a flag that was cleared.
    db.raw.prepare("INSERT INTO flags (pseudonym, reason, created_at) VALUES (?, 'volume', ?)").run(p.b, NOW - 5 * DAY);
    db.raw.prepare("INSERT INTO flags (pseudonym, reason, created_at, reviewed_at, decision, ref) VALUES (?, 'volume', ?, ?, 'cleared', '2026-11-01:0123456789abcdef')").run(p.c, NOW - 20 * DAY, NOW - 19 * DAY);
    return p;
  }

  const p0 = (db: TestDb, k: string) => (db.raw.prepare('SELECT pseudonym FROM devices WHERE id = ?').get(dev(k)) as { pseudonym: string }).pseudonym;

  it('each flag finds its person inside D1, in order: applied, ignored, unresolved or reviewed', async () => {
    const db = testDb();
    people(db);
    const ops = [flag('a'), flag('b'), flag('c'), flag('f'), review('a', 'confirm'), flag('e'), review('9', 'clear'), { ...flag('c'), ref: `2026-11-20:${'c'.repeat(16)}` }];
    const lists = await importFlags(db, ops, 'f'.repeat(64), NOW);
    expect(lists).toEqual({ applied: [ref('c'), ref('e')], ignored: [ref('b'), `2026-11-20:${'c'.repeat(16)}`], unresolved: [ref('f'), ref('9')], reviewed: [ref('a')] });
    expect(flagsOf(db)).toEqual([
      { id: dev('a'), ref: ref('a'), reason: 'regular-times', createdAt: NOW - 3600_000, reviewedAt: NOW - 1800_000, decision: 'confirmed', flagged: 1 },
      { id: dev('b'), ref: null, reason: 'volume', createdAt: NOW - 5 * DAY, reviewedAt: null, decision: null, flagged: 1 },
      { id: dev('c'), ref: ref('c'), reason: 'regular-times', createdAt: NOW - 3600_000, reviewedAt: null, decision: null, flagged: 1 },
      { id: dev('e'), ref: ref('e'), reason: 'regular-times', createdAt: NOW - 3600_000, reviewedAt: null, decision: null, flagged: 1 },
    ]);
    expect(db.raw.prepare("SELECT sha256, body FROM cycle_imports WHERE name = 'flags'").get()).toEqual({ sha256: 'f'.repeat(64), body: null });

    // The whole list again with more operations: nothing applied twice, e and c cleared; a flag of c
    // 7 days after the clear (the cycle seeing the same 14 days again under a new group) is ignored,
    // and only one more than 15 days after the clear, for another reason, takes the place of the
    // cleared row; for the same reason it waits 90 days.
    const cRef = (date: string) => `${date}:${'c'.repeat(16)}`;
    db.raw.prepare('INSERT INTO export_groups (export_date, grp, pseudonym) VALUES (?, ?, ?)').run('2026-11-28', 'c'.repeat(16), p0(db, 'c'));
    db.raw.prepare('INSERT INTO export_groups (export_date, grp, pseudonym) VALUES (?, ?, ?)').run('2026-12-07', 'c'.repeat(16), p0(db, 'c'));
    const more = [...ops, review('e', 'clear', NOW - 600_000), review('c', 'clear', NOW - 500_000), { ...flag('c', NOW + 7 * DAY), ref: cRef('2026-11-28') }];
    const again = await importFlags(db, more, 'e'.repeat(64), NOW + 7 * DAY);
    expect(again).toEqual({ applied: [], ignored: [ref('b'), `2026-11-20:${'c'.repeat(16)}`, cRef('2026-11-28')], unresolved: [ref('f'), ref('9')], reviewed: [ref('a'), ref('c'), ref('e')] });
    expect(flagsOf(db)).toEqual([
      { id: dev('a'), ref: ref('a'), reason: 'regular-times', createdAt: NOW - 3600_000, reviewedAt: NOW - 1800_000, decision: 'confirmed', flagged: 1 },
      { id: dev('b'), ref: null, reason: 'volume', createdAt: NOW - 5 * DAY, reviewedAt: null, decision: null, flagged: 1 },
      { id: dev('c'), ref: ref('c'), reason: 'regular-times', createdAt: NOW - 3600_000, reviewedAt: NOW - 500_000, decision: 'cleared', flagged: 0 },
      { id: dev('e'), ref: ref('e'), reason: 'regular-times', createdAt: NOW - 3600_000, reviewedAt: NOW - 600_000, decision: 'cleared', flagged: 0 },
    ]);
    const same = [...more, { ...flag('c', NOW + 16 * DAY), ref: cRef('2026-12-07') }];
    const sameReason = await importFlags(db, same, '6'.repeat(64), NOW + 16 * DAY);
    expect(sameReason.applied).toEqual([]);
    expect(sameReason.ignored).toContain(cRef('2026-12-07'));
    expect(flagsOf(db)[2]).toMatchObject({ id: dev('c'), ref: ref('c'), decision: 'cleared', flagged: 0 });
    const later = [...more, { ...flag('c', NOW + 16 * DAY), ref: cRef('2026-12-07'), reason: 'volume' as const }];
    const third = await importFlags(db, later, '7'.repeat(64), NOW + 16 * DAY);
    expect(third.applied).toEqual([cRef('2026-12-07')]);
    expect(flagsOf(db)[2]).toEqual({ id: dev('c'), ref: cRef('2026-12-07'), reason: 'volume', createdAt: NOW + 16 * DAY, reviewedAt: null, decision: null, flagged: 1 });
    // Once more with the same list changes nothing.
    const before = flagsOf(db);
    await importFlags(db, later, 'd'.repeat(64), NOW + 16 * DAY + 1);
    expect(flagsOf(db)).toEqual(before);
  });

  it('a flag for the reason the owner cleared waits 90 days after the clear', async () => {
    const db = testDb();
    const p = people(db);
    // c: a volume flag cleared 19 days before NOW.
    const volume = (at: number, date = D): FlagOp => ({ ref: `${date}:${'c'.repeat(16)}`, op: 'flag', reason: 'volume', evidence: '310 matches in 7 days', at });
    expect((await importFlags(db, [volume(NOW)], '1'.repeat(64), NOW)).ignored).toEqual([ref('c')]);
    db.raw.prepare('INSERT INTO export_groups (export_date, grp, pseudonym) VALUES (?, ?, ?)').run('2027-01-31', 'c'.repeat(16), p.c);
    const late = volume(NOW + 72 * DAY, '2027-01-31');
    expect((await importFlags(db, [volume(NOW), late], '2'.repeat(64), NOW + 72 * DAY)).applied).toEqual([late.ref]);
    expect(flagsOf(db)[2]).toMatchObject({ id: dev('c'), ref: late.ref, reason: 'volume', decision: null, flagged: 1 });
  });

  it('a later review finds the flag by its ref after the group token expired; a deleted person is unresolved', async () => {
    const db = testDb();
    people(db);
    await importFlags(db, [flag('a'), flag('e')], '1'.repeat(64), NOW);
    db.raw.prepare('DELETE FROM export_groups').run();
    db.raw.prepare('DELETE FROM devices WHERE id = ?').run(dev('e'));
    db.raw.prepare('DELETE FROM flags WHERE ref = ?').run(ref('e'));
    const lists = await importFlags(db, [flag('a'), flag('e'), review('a', 'clear'), review('e', 'confirm')], '2'.repeat(64), NOW);
    expect(lists).toEqual({ applied: [], ignored: [], unresolved: [ref('e')], reviewed: [ref('a')] });
    expect((db.raw.prepare('SELECT flagged FROM devices WHERE id = ?').get(dev('a')) as { flagged: number }).flagged).toBe(0);
  });

  it('the daily step: off, skipped without a file or for the same file, failed for a bad one; a flag takes the person out of that day\'s export', async () => {
    const { db, events, models, deps } = setup();
    const pa = addDevice(db, dev('a'));
    addDevice(db, dev('b'));
    await addMatch(db, 1, [{ seat: 0, device: dev('a') }, { seat: 1, device: dev('b') }]);
    const day1 = await runDaily(deps, NOW - DAY);
    expect(day1.receipt.jobs.flags).toEqual({ status: 'skipped', error: null, sha256: null, applied: [], ignored: [], unresolved: [], reviewed: [] });
    const grp = (db.raw.prepare('SELECT grp FROM export_groups WHERE pseudonym = ?').get(pa) as { grp: string }).grp;
    const file: FlagsFile = { schema: SCHEMAS.flags, createdAt: NOW - 3600_000, ops: [{ ref: `${utcDate(NOW - DAY)}:${grp}`, op: 'flag', reason: 'volume', evidence: 'matches 412 in 7 days', at: NOW - 3600_000 }] };
    const body = JSON.stringify(file);
    models.data.set(FLAGS_KEY, body);
    const day2 = await runDaily(deps, NOW);
    expect(day2.failed).toEqual([]);
    expect(day2.receipt.jobs.flags).toEqual({ status: 'ok', error: null, sha256: await sha256Hex(body), applied: [`${utcDate(NOW - DAY)}:${grp}`], ignored: [], unresolved: [], reviewed: [] });
    const rows = exportOf(events).rows;
    expect(rows.filter((r) => r.flagged)).toHaveLength(1);
    expect(rows.find((r) => r.flagged)).toMatchObject({ seat: 0, weight: 0 });
    // The next day the same file is not imported again.
    const day3 = await runDaily(deps, NOW + DAY);
    expect(day3.receipt.jobs.flags).toMatchObject({ status: 'skipped', sha256: await sha256Hex(body), applied: [] });
    // A file that does not pass the checks fails the step and changes nothing.
    models.data.set(FLAGS_KEY, JSON.stringify({ ...file, ops: [{ ...file.ops[0], reason: 'bot' }] }));
    const day4 = await runDaily(deps, NOW + 2 * DAY);
    expect(day4.failed).toEqual(['flags']);
    expect(day4.receipt.jobs.flags.status).toBe('failed');
    expect(day4.receipt.jobs.flags.error).toMatch(/^control\/flags\.json refused: ops\[0\]\.reason/);
    expect(day4.receipt.jobs.export.status).toBe('ok');
    models.data.set(FLAGS_KEY, 'x'.repeat(600 * 1024));
    expect((await runDaily(deps, NOW + 3 * DAY)).receipt.jobs.flags.error).toMatch(/over 524288/);
  });
});

describe('priors from the cycle', () => {
  it('imports a changed, valid file once; the reading uses it; a bad file keeps the last good one', async () => {
    const { db, models, deps } = setup();
    addDevice(db, dev('a'));
    const ctx = { deps, now: NOW, date: TODAY };
    expect(await priorsJob(ctx)).toEqual({ status: 'skipped', error: null, sha256: null, imported: false });
    expect((await readingFor(db, dev('a'), NOW))!.priors).toBe('selfplay');
    const people: PriorsFile = { ...DEFAULT_PRIORS, createdAt: NOW - DAY, source: 'people', people: 140, numbers: { ...DEFAULT_PRIORS.numbers, raise: { mean: 0.41, strength: 37.5, people: 140 } } };
    const body = JSON.stringify(people);
    models.data.set(PRIORS_KEY, body);
    const sha = await sha256Hex(body);
    expect(await priorsJob(ctx)).toEqual({ status: 'ok', error: null, sha256: sha, imported: true });
    expect(db.raw.prepare("SELECT sha256, body, imported_at FROM cycle_imports WHERE name = 'priors'").get()).toEqual({ sha256: sha, body, imported_at: NOW });
    expect(await priorsJob({ ...ctx, now: NOW + DAY })).toEqual({ status: 'skipped', error: null, sha256: sha, imported: false });
    const r = (await readingFor(db, dev('a'), NOW))!;
    expect(r.priors).toBe('people');
    expect(r.numbers.find((n) => n.key === 'raise')!.population).toBe(0.41);
    // A file outside the format is refused: the step fails and the reading keeps the imported priors.
    models.data.set(PRIORS_KEY, JSON.stringify({ ...people, numbers: { ...people.numbers, raise: { mean: 1.2, strength: 3, people: 140 } } }));
    await expect(priorsJob(ctx)).rejects.toThrow(/control\/priors\.json refused: numbers\.raise\.mean/);
    expect((await readingFor(db, dev('a'), NOW))!.numbers.find((n) => n.key === 'raise')!.population).toBe(0.41);
  });
});

describe('the 2% cap per person, from the export alone', () => {
  it('one group per person lets the cycle cap a very active player without knowing who they are', async () => {
    const { db, events, ctx } = setup();
    db.raw.exec('BEGIN');
    const people: string[] = [];
    for (let i = 0; i < 61; i++) people.push(addDevice(db, `${i.toString(16).padStart(64, '0')}`));
    const seat = db.raw.prepare('INSERT INTO match_seats (match_id, seat, pseudonym, verified) VALUES (?, ?, ?, 1)');
    let m = 0;
    // 60 people with 5 seats each, and one with 400.
    for (let i = 0; i < 60; i++) for (let k = 0; k < 5; k++) seat.run(uuid(++m), 0, people[i]);
    for (let k = 0; k < 400; k++) seat.run(uuid(++m), 1, people[60]);
    db.raw.exec('COMMIT');
    await exportJob(ctx());
    const file = exportOf(events);
    expect(validateExport(file).ok).toBe(true);
    const sums = new Map<string, number>();
    for (const r of file.rows) sums.set(r.group, (sums.get(r.group) ?? 0) + r.weight);
    expect(sums.size).toBe(61);
    const heavy = [...sums].find(([, v]) => v === 400)![0];
    const total = [...sums.values()].reduce((a, b) => a + b, 0);
    expect(sums.get(heavy)! / total).toBeGreaterThan(0.5);
    // The cycle's own cap (training/cycle/node/build.ts) on these groups.
    const factor = deviceCap(sums, 0.02);
    const capped = new Map([...sums].map(([g, v]) => [g, v * factor.get(g)!]));
    const cappedTotal = [...capped.values()].reduce((a, b) => a + b, 0);
    expect(capped.get(heavy)! / cappedTotal).toBeLessThanOrEqual(0.02 + 1e-9);
    expect([...factor].filter(([g]) => g !== heavy).every(([, f]) => f === 1)).toBe(true);
  });
});
