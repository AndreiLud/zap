// The brake (worker/src/brake.ts and allowance.ts admitMatch): the arithmetic of both modes, the
// day roll at 00:00 UTC, the SQL against the same arithmetic on node:sqlite with D1's statements,
// the admission tied to the allowance, the swap (never below zero, never twice), the room's
// meter, and the Worker's quick play route giving everything back when a start fails.

import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  BusyClock,
  CPU_PER_INVOCATION_MS,
  DEFAULT_COST_PER_PERSON,
  DEFAULT_COST_SOLO,
  DURATION_MARGIN_MS,
  FREE_DAILY,
  MEASURED_MS_PER_INVOCATION,
  LIMITS,
  METERS,
  MS_PER_GB_SECOND,
  addUsage,
  admitPlan,
  billedMillions,
  admitStatement,
  brakeConfig,
  dayKey,
  daysInMonth,
  durationEstimateMs,
  emptyUsage,
  fitsFree,
  fitsPaid,
  freeCaps,
  REFUSAL_FROM_ROOM,
  REFUSAL_FROM_WORKER,
  expirySettlement,
  logBrakeProblems,
  matchEstimate,
  meteredDb,
  minimumCeiling,
  monthlyCost,
  newRoomBrake,
  othersMonthly,
  parseTestLedger,
  readLedger,
  refundStatement,
  resetAt,
  settleStatement,
  type BrakeConfig,
  type Limit,
  type RoomBrake,
  type Usage,
} from '../src/brake.ts';
import { MATCHES_PER_CHECK, admitMatch, refundAdmission } from '../src/allowance.ts';
import { matchRowStatements, seatStatementIndexes, type MatchRow, type SqlDb, type SqlStatement } from '../src/privacy.ts';
import { credCookieName, credentialSubject, deviceCookieName, deviceIdFromSecret, newDeviceSecret, signCredential } from '../src/auth.ts';
import { testDb, type TestDb } from './sqlite-db.ts';

vi.mock('../src/cf/room.ts', () => ({ Room: class {} }));

/** wrangler.jsonc parsed: comments outside strings and trailing commas removed. */
function wranglerConfig(): Record<string, any> {
  const src = readFileSync('wrangler.jsonc', 'utf8');
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      const start = i;
      for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === '\\') i++;
      out += src.slice(start, i + 1);
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const usage = (u: Partial<Usage>): Usage => addUsage(emptyUsage(), u);
const T0 = Date.UTC(2026, 10, 22, 12, 0, 0);
const DEVICE = 'd'.repeat(64);

function seedDevice(db: TestDb, device = DEVICE, used = 0): void {
  db.raw
    .prepare('INSERT INTO devices (id, created_at, verified_at, matches_since_verify, pseudonym, adult_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(device, T0, T0, used, device.slice(0, 32), T0, T0);
}

function allowanceUsed(db: TestDb, device = DEVICE): number {
  return (db.raw.prepare('SELECT matches_since_verify AS n FROM devices WHERE id = ?').get(device) as { n: number }).n;
}

/** A configuration with the given mode and reserve (for both rules, unless othersShare is given), and the estimates of wrangler.jsonc. */
function config(over: Partial<BrakeConfig> = {}): BrakeConfig {
  const vars = wranglerConfig().vars;
  return { ...brakeConfig(vars), ...(over.reserve ? { othersShare: over.reserve } : {}), ...over };
}

describe('brake: configuration', () => {
  it('wrangler.jsonc reads without any problem in whatever mode DEPLOY.md set, and its estimates are the code\'s fallbacks', () => {
    const vars = wranglerConfig().vars;
    const cfg = brakeConfig(vars);
    // Any setting DEPLOY.md describes passes (free with the real reserve, paid, off); a fallback
    // or a paid ceiling that refuses every match does not.
    expect(cfg.problems).toEqual([]);
    expect(['free', 'paid', 'off']).toContain(vars.BRAKE_MODE);
    if (cfg.mode === 'paid') expect(cfg.monthlyUsd).toBeGreaterThan(minimumCeiling(cfg.othersShare));
    expect(vars.BRAKE_COST_SOLO).toEqual(DEFAULT_COST_SOLO);
    expect(vars.BRAKE_COST_PER_PERSON).toEqual(DEFAULT_COST_PER_PERSON);
    expect(cfg.solo.doActiveMs).toBe(DEFAULT_COST_SOLO.doGbSeconds * MS_PER_GB_SECOND);
    // The local sites run the paid arithmetic with a ceiling no day of tests reaches.
    const local = readFileSync('.dev.vars.example', 'utf8');
    expect(local).toMatch(/^BRAKE_MODE=paid$/m);
    expect(Number(/^BRAKE_MONTHLY_USD=(\d+)$/m.exec(local)?.[1])).toBeGreaterThanOrEqual(1000);
  });

  it('the duration estimate is the measured time plus the margin for every request and message, in GB-s rounded up to a tenth', () => {
    // 19 ms measured per invocation on the local site, CPU allowance included, plus 250 ms for production.
    expect(MEASURED_MS_PER_INVOCATION).toBeGreaterThanOrEqual(CPU_PER_INVOCATION_MS);
    expect(durationEstimateMs(1)).toBe(MEASURED_MS_PER_INVOCATION + DURATION_MARGIN_MS);
    for (const est of [DEFAULT_COST_SOLO, DEFAULT_COST_PER_PERSON]) {
      const ms = durationEstimateMs(est.doRequests + est.doWsMessages);
      expect(est.doGbSeconds).toBe(Math.ceil((ms / MS_PER_GB_SECOND) * 10) / 10);
      expect(est.doGbSeconds * MS_PER_GB_SECOND).toBeGreaterThanOrEqual(ms);
    }
    // A solo match reserves 0.6 GB-s and a room of 4 people 2.7 GB-s, where the model of a room
    // billed while awake reserved 12 and 30.
    const cfg = brakeConfig({});
    expect(matchEstimate(cfg, 1).doActiveMs / MS_PER_GB_SECOND).toBeCloseTo(0.6, 10);
    expect(matchEstimate(cfg, 4).doActiveMs / MS_PER_GB_SECOND).toBeCloseTo(2.7, 10);
  });

  it('anything missing or invalid falls back to the protective default and is listed', () => {
    const cfg = brakeConfig({ BRAKE_MODE: 'fast', BRAKE_RESERVE: { workerRequests: 0.3, doRequests: -1, doRowsWritten: 'x' }, BRAKE_COST_SOLO: '[1]' });
    expect(cfg.mode).toBe('free');
    expect(cfg.reserve.workerRequests).toBe(0.3);
    expect(cfg.reserve.doRequests).toBe(0.5);
    expect(cfg.reserve.doRowsWritten).toBe(0.5);
    expect(cfg.reserve.doGbSeconds).toBe(0.5);
    expect(cfg.solo.doRowsWritten).toBe(DEFAULT_COST_SOLO.doRowsWritten);
    expect(cfg.problems.join('\n')).toMatch(/BRAKE_MODE/);
    expect(cfg.problems.join('\n')).toMatch(/BRAKE_RESERVE\.doRequests/);
    expect(cfg.problems.join('\n')).not.toMatch(/BRAKE_RESERVE\.workerRequests/);
    expect(cfg.problems.join('\n')).toMatch(/BRAKE_COST_SOLO is not an object/);
    // A ceiling below the $5 base, or none, allows only the base in the paid mode.
    expect(brakeConfig({ BRAKE_MODE: 'paid', BRAKE_MONTHLY_USD: '3' }).monthlyUsd).toBe(5);
    expect(brakeConfig({ BRAKE_MODE: 'paid' }).monthlyUsd).toBe(5);
    // JSON as text, as .dev.vars or --var give it.
    const text = brakeConfig({ BRAKE_MODE: 'paid', BRAKE_MONTHLY_USD: '25', BRAKE_RESERVE: JSON.stringify({ workerRequests: 0.1, doRequests: 0.2, doRowsWritten: 0.3, doGbSeconds: 0.4, d1RowsWritten: 0, d1RowsRead: 0.8 }) });
    expect(text.monthlyUsd).toBe(25);
    expect(text.reserve).toEqual({ workerRequests: 0.1, doRequests: 0.2, doRowsWritten: 0.3, doGbSeconds: 0.4, d1RowsWritten: 0, d1RowsRead: 0.8 });
    expect(brakeConfig({ BRAKE_MODE: 'off' }).mode).toBe('off');
  });

  it('a reserve share above 0.8 is real: the free rule reads it as 0.8 and gives the Zap nothing of that line, the paid mode prices it as entered', () => {
    const shares = { workerRequests: 0.85, doRequests: 0.5, doRowsWritten: 0.5, doGbSeconds: 0.9, d1RowsWritten: 0.5, d1RowsRead: 0.5 };
    const free = brakeConfig({ BRAKE_MODE: 'free', BRAKE_RESERVE: shares });
    expect(free.reserve.workerRequests).toBe(0.8);
    expect(free.reserve.doGbSeconds).toBe(0.8);
    expect(free.othersShare.doGbSeconds).toBe(0.9);
    const caps = freeCaps(free.reserve);
    expect(caps.workerRequests).toBe(0);
    expect(caps.doGbSeconds).toBe(0);
    expect(caps.doRequests).toBe(30_000);
    expect(free.problems).toHaveLength(2);
    expect(free.problems.join('\n')).toMatch(/BRAKE_RESERVE\.doGbSeconds 0\.9 read as 0\.8: the Zap gets nothing of that line on Workers Free, every match refused/);
    // At exactly 0.8 it is the same, also listed.
    expect(brakeConfig({ BRAKE_MODE: 'free', BRAKE_RESERVE: { ...shares, workerRequests: 0.8, doGbSeconds: 0.5 } }).problems).toEqual([
      'BRAKE_RESERVE.workerRequests 0.8: the Zap gets nothing of that line on Workers Free, every match refused',
    ]);
    // Paid: the other projects' month is priced from 0.9 of the Free daily duration, every day.
    const paid = brakeConfig({ BRAKE_MODE: 'paid', BRAKE_MONTHLY_USD: '50', BRAKE_RESERVE: shares });
    expect(paid.problems).toEqual([]);
    const plan = admitPlan(paid, 1, T0, null)!;
    expect(plan.rule.kind === 'paid' && plan.rule.others.doGbSeconds).toBe(0.9 * 13_000 * 30);
  });

  it('paid: a ceiling below the other projects\' own bill refuses every match, and is listed', async () => {
    const half = Object.fromEntries(LIMITS.map((k) => [k, 0.5])) as Record<Limit, number>;
    // 1.55 million DO requests in a 31 day month, 0.55 million beyond the 1 million included,
    // billed as a whole million.
    expect(minimumCeiling(half)).toBeCloseTo(5 + 0.15, 10);
    // December has 31 days: the other projects' bill alone is the minimum, and any match passes it.
    const december = Date.UTC(2026, 11, 15, 12);
    for (const ceiling of ['5', '5.14']) {
      const cfg = brakeConfig({ BRAKE_MODE: 'paid', BRAKE_MONTHLY_USD: ceiling, BRAKE_RESERVE: half });
      expect(cfg.problems.join('\n')).toMatch(/below the other projects' own bill \(US\$ 5\.15 in a 31 day month\): every match refused/);
      const db = testDb();
      seedDevice(db);
      expect((await admitMatch(db, cfg, DEVICE, 1, december, null)).ok).toBe(false);
    }
    expect(brakeConfig({ BRAKE_MODE: 'paid', BRAKE_MONTHLY_USD: '5.15', BRAKE_RESERVE: half }).problems).toEqual([]);
    // The free and off modes have no ceiling to check.
    expect(brakeConfig({ BRAKE_MODE: 'free', BRAKE_MONTHLY_USD: '5', BRAKE_RESERVE: half }).problems).toEqual([]);
  });

  it('problems are logged once per isolate, and never when there are none', () => {
    const lines: string[] = [];
    logBrakeProblems(brakeConfig({ BRAKE_MODE: 'free', BRAKE_RESERVE: Object.fromEntries(LIMITS.map((k) => [k, 0.5])) }), (l) => lines.push(l));
    expect(lines).toEqual([]);
    const bad = brakeConfig({ BRAKE_MODE: 'paid' });
    logBrakeProblems(bad, (l) => lines.push(l));
    logBrakeProblems(bad, (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^brake config: .*BRAKE_MONTHLY_USD missing or invalid/);
  });

  it('a match with more people costs the solo estimate plus each further person', () => {
    const cfg = config();
    const four = matchEstimate(cfg, 4);
    for (const m of METERS) expect(four[m]).toBe(cfg.solo[m] + 3 * cfg.perPerson[m]);
    expect(matchEstimate(cfg, 0)).toEqual(cfg.solo);
  });
});

describe('brake: arithmetic', () => {
  it('free: the Zap keeps 80% of each daily limit minus the reserve, 30% with the default reserve', () => {
    const caps = freeCaps(config().reserve);
    expect(caps).toEqual({
      workerRequests: 30_000,
      doRequests: 30_000,
      doRowsWritten: 30_000,
      doGbSeconds: 3_900 * MS_PER_GB_SECOND,
      d1RowsWritten: 30_000,
      d1RowsRead: 1_500_000,
    });
    const none = freeCaps(Object.fromEntries(LIMITS.map((k) => [k, 0])) as Record<Limit, number>);
    expect(none.doRequests).toBe(80_000);
    const all = freeCaps(Object.fromEntries(LIMITS.map((k) => [k, 0.8])) as Record<Limit, number>);
    expect(Object.values(all)).toEqual(LIMITS.map(() => 0));
  });

  it('free: a sum may reach its cap but not pass it, and any one limit refuses', () => {
    const caps = freeCaps(config().reserve);
    const est = usage({ doRowsWritten: 60, doWsMessages: 50, doRequests: 10 });
    expect(fitsFree(usage({ doRowsWritten: 30_000 - 60 }), est, caps)).toBe(true);
    expect(fitsFree(usage({ doRowsWritten: 30_000 - 59 }), est, caps)).toBe(false);
    // Every incoming WebSocket message counts as a request on Workers Free.
    expect(fitsFree(usage({ doWsMessages: 29_940 }), est, caps)).toBe(true);
    expect(fitsFree(usage({ doWsMessages: 29_941 }), est, caps)).toBe(false);
    expect(fitsFree(usage({ doActiveMs: 3_900 * MS_PER_GB_SECOND }), usage({ doActiveMs: 1 }), caps)).toBe(false);
    expect(fitsFree(usage({ d1RowsRead: 1_500_000 }), usage({}), caps)).toBe(true);
  });

  it('paid: the bill is $5 until a line passes what the plan includes, WebSocket messages count 20 to 1, and the other projects use the included amounts first', () => {
    const none = Object.fromEntries(LIMITS.map((k) => [k, 0])) as Record<Limit, number>;
    expect(monthlyCost(emptyUsage(), none)).toBe(5);
    expect(monthlyCost(usage({ doRequests: 1_000_000, workerRequests: 10_000_000, doRowsWritten: 50_000_000 }), none)).toBe(5);
    expect(monthlyCost(usage({ doRequests: 3_000_000 }), none)).toBeCloseTo(5.3, 10);
    expect(monthlyCost(usage({ doWsMessages: 40_000_000 }), none)).toBeCloseTo(5.15, 10);
    // 1,400,000 GB-s, 1,000,000 beyond the 400,000 included: $12.50.
    expect(monthlyCost(usage({ doActiveMs: 1_400_000 * MS_PER_GB_SECOND }), none)).toBeCloseTo(17.5, 10);
    // The other projects at 50% of the Free daily limits for 30 days: 1.5 million DO requests, 0.5
    // million beyond the included 1 million, billed as a whole million.
    const others = othersMonthly(config().reserve, 30);
    expect(others.doRequests).toBe(1_500_000);
    expect(monthlyCost(emptyUsage(), others)).toBeCloseTo(5 + 0.15, 10);
    expect(fitsPaid(usage({ doRequests: 2_999_999 }), usage({ doRequests: 1 }), 5.3, none)).toBe(true);
    expect(fitsPaid(usage({ doRequests: 3_000_000 }), usage({ doRequests: 1 }), 5.3, none)).toBe(false);
  });
});

describe('brake: days', () => {
  it('the day ends at 00:00 UTC, 21h in Brasília, and the month on the 1st', () => {
    const last = Date.UTC(2026, 10, 22, 23, 59, 59, 999);
    const first = Date.UTC(2026, 10, 23);
    expect(dayKey(last)).toBe('2026-11-22');
    expect(dayKey(first)).toBe('2026-11-23');
    expect(resetAt(last, 'day')).toBe(first);
    expect(resetAt(first, 'day')).toBe(Date.UTC(2026, 10, 24));
    const brasilia = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: 'numeric', day: 'numeric', month: 'numeric' }).format(first);
    expect(brasilia).toMatch(/22\/11.*21/);
    expect(resetAt(Date.UTC(2026, 10, 30, 23, 59), 'month')).toBe(Date.UTC(2026, 11, 1));
    expect(resetAt(Date.UTC(2026, 11, 31, 12), 'month')).toBe(Date.UTC(2027, 0, 1));
    expect(daysInMonth(Date.UTC(2028, 1, 10))).toBe(29);
    expect(daysInMonth(T0)).toBe(30);
  });

  it('free: a day full at 23:59:59.999 UTC refuses, and at 00:00 UTC the new day starts from zero', async () => {
    const db = testDb();
    seedDevice(db);
    // Each match reserves half of the Zap's 30,000 DO rows of a day: two fit.
    const cfg = config({ solo: usage({ doRowsWritten: 15_000 }), perPerson: emptyUsage() });
    const late = Date.UTC(2026, 10, 22, 23, 59, 59, 0);
    expect((await admitMatch(db, cfg, DEVICE, 1, late, null)).ok).toBe(true);
    expect((await admitMatch(db, cfg, DEVICE, 1, late + 500, null)).ok).toBe(true);
    const full = await admitMatch(db, cfg, DEVICE, 1, late + 999, null);
    expect(full).toEqual({ ok: false, code: 'limit_reached', limit: { period: 'day', resetAt: Date.UTC(2026, 10, 23) } });
    const next = await admitMatch(db, cfg, DEVICE, 1, Date.UTC(2026, 10, 23), null);
    expect(next).toMatchObject({ ok: true, reservation: { key: '2026-11-23' } });
    expect((await readLedger(db, '2026-11-23'))!.matches).toBe(1);
    expect(await readLedger(db, '2026-11-22')).toMatchObject({ matches: 2, refused: 1 });
  });

  it('the swap of a match that started before 00:00 UTC goes to the day of its reservation', async () => {
    const db = testDb();
    seedDevice(db);
    const cfg = config();
    const a = await admitMatch(db, cfg, DEVICE, 1, Date.UTC(2026, 10, 22, 23, 58), null);
    if (!a.ok || !a.reservation) throw new Error('not admitted');
    expect(a.reservation.key).toBe('2026-11-22');
    const spent = usage({ doRowsWritten: 41, doWsMessages: 30, doActiveMs: 200_000 });
    await db.batch([settleStatement(db, { key: a.reservation.key, reserved: a.reservation.est, spent }, Date.UTC(2026, 10, 23, 0, 4), 'm1')]);
    const d = (await readLedger(db, '2026-11-22'))!;
    expect(d.reserved).toEqual(emptyUsage());
    expect(d.spent).toEqual(spent);
    expect(d.settled).toBe(1);
    expect(await readLedger(db, '2026-11-23')).toBeNull();
  });

  it('paid: the month\'s days add up, the previous month does not count', async () => {
    const db = testDb();
    seedDevice(db);
    const none = Object.fromEntries(LIMITS.map((k) => [k, 0])) as Record<Limit, number>;
    const cfg = config({ mode: 'paid', monthlyUsd: 5.3, reserve: none });
    // 2.9 million DO requests already spent this month over two days, 9 million last month.
    db.raw.prepare('INSERT INTO brake_days (day, s_doreq, updated_at) VALUES (?, ?, 0), (?, ?, 0), (?, ?, 0)').run('2026-11-01', 1_000_000, '2026-11-21', 1_900_000, '2026-10-31', 9_000_000);
    const big = { ...cfg, solo: usage({ doRequests: 100_000 }) };
    expect((await admitMatch(db, big, DEVICE, 1, T0, null)).ok).toBe(true);
    const refused = await admitMatch(db, big, DEVICE, 1, T0, null);
    expect(refused).toEqual({ ok: false, code: 'limit_reached', limit: { period: 'month', resetAt: Date.UTC(2026, 11, 1) } });
    // A new month starts from zero.
    expect((await admitMatch(db, big, DEVICE, 1, Date.UTC(2026, 11, 1), null)).ok).toBe(true);
  });
});

/** Runs one admission statement over a row holding `sums` (as spent) and answers whether it fitted. */
async function sqlFits(plan: ReturnType<typeof admitPlan>, sums: Usage): Promise<boolean> {
  const db = testDb();
  const cols = ['wreq', 'doreq', 'dows', 'dorows', 'doms', 'd1w', 'd1r'];
  db.raw.prepare(`INSERT INTO brake_days (day, ${cols.map((c) => `s_${c}`).join(', ')}, updated_at) VALUES (?, ${cols.map(() => '?').join(', ')}, 0)`).run(plan!.key, ...METERS.map((m) => sums[m]));
  const row = await admitStatement(db, plan!, 'abcdef0123456789', 1).first<{ ticket: string | null }>();
  return row?.ticket === 'abcdef0123456789';
}

describe('brake: the SQL agrees with the arithmetic', () => {
  const meter = (max: number) => fc.integer({ min: 0, max });
  const usageArb = (max: number) =>
    fc.record({
      workerRequests: meter(max),
      doRequests: meter(max),
      doWsMessages: meter(max),
      doRowsWritten: meter(max),
      doActiveMs: meter(max * 8000),
      d1RowsWritten: meter(max),
      d1RowsRead: meter(max * 50),
    });
  const reserveArb = fc.record(Object.fromEntries(LIMITS.map((k) => [k, fc.constantFrom(0, 0.1, 0.25, 0.5, 0.79, 0.8)])) as Record<Limit, fc.Arbitrary<number>>);

  it('free mode', async () => {
    await fc.assert(
      fc.asyncProperty(usageArb(40_000), usageArb(200), reserveArb, async (sums, est, reserve) => {
        const cfg = config({ mode: 'free', reserve, solo: est, perPerson: emptyUsage() });
        const plan = admitPlan(cfg, 1, T0, null)!;
        expect(await sqlFits(plan, sums)).toBe(fitsFree(sums, est, freeCaps(reserve)));
      }),
      { numRuns: 300 },
    );
  });

  it('paid mode', async () => {
    await fc.assert(
      fc.asyncProperty(usageArb(30_000_000), usageArb(2_000_000), reserveArb, fc.double({ min: 5, max: 400, noNaN: true }), async (sums, est, reserve, ceiling) => {
        const cfg = config({ mode: 'paid', reserve, monthlyUsd: ceiling, solo: est, perPerson: emptyUsage() });
        const plan = admitPlan(cfg, 1, T0, null)!;
        expect(await sqlFits(plan, sums)).toBe(fitsPaid(sums, est, ceiling, othersMonthly(reserve, daysInMonth(T0))));
      }),
      { numRuns: 300 },
    );
  });

  it('at the exact boundary of both modes', async () => {
    const cfg = config();
    const caps = freeCaps(cfg.reserve);
    const free = admitPlan(cfg, 1, T0, null)!;
    const edge = usage({ doRowsWritten: caps.doRowsWritten - cfg.solo.doRowsWritten });
    expect(await sqlFits(free, edge)).toBe(true);
    expect(await sqlFits(free, usage({ doRowsWritten: edge.doRowsWritten + 1 }))).toBe(false);
    const none = Object.fromEntries(LIMITS.map((k) => [k, 0])) as Record<Limit, number>;
    const paid = admitPlan(config({ mode: 'paid', reserve: none, monthlyUsd: 5.3, solo: usage({ doRequests: 1 }), perPerson: emptyUsage() }), 1, T0, null)!;
    expect(await sqlFits(paid, usage({ doRequests: 2_999_999 }))).toBe(true);
    expect(await sqlFits(paid, usage({ doRequests: 3_000_000 }))).toBe(false);
  });
});

describe('brake: admission with the allowance', () => {
  it('a refused match takes nothing: no allowance, no reservation, one more refusal', async () => {
    const db = testDb();
    seedDevice(db);
    const cfg = config({ reserve: Object.fromEntries(LIMITS.map((k) => [k, 0.8])) as Record<Limit, number> });
    const ans = await admitMatch(db, cfg, DEVICE, 1, T0, null);
    expect(ans).toEqual({ ok: false, code: 'limit_reached', limit: { period: 'day', resetAt: Date.UTC(2026, 10, 23) } });
    expect(allowanceUsed(db)).toBe(0);
    const row = (await readLedger(db, dayKey(T0)))!;
    expect(row).toMatchObject({ matches: 0, refused: 1, settled: 0 });
    expect(row.reserved).toEqual(emptyUsage());
    expect(row.spent).toEqual(emptyUsage());
  });

  it('a refusal counts what asking cost as spent, at once (no swap ever follows it); an admission does not', async () => {
    const db = testDb();
    seedDevice(db);
    const full = config({ reserve: Object.fromEntries(LIMITS.map((k) => [k, 0.8])) as Record<Limit, number> });
    await admitMatch(db, full, DEVICE, 1, T0, null, REFUSAL_FROM_ROOM);
    await admitMatch(db, full, DEVICE, 1, T0, null, REFUSAL_FROM_ROOM);
    await admitMatch(db, full, DEVICE, 1, T0, null, REFUSAL_FROM_WORKER);
    const row = (await readLedger(db, dayKey(T0)))!;
    expect(row.refused).toBe(3);
    expect(row.spent).toEqual(usage({ doWsMessages: 2, workerRequests: 1, d1RowsWritten: 3 }));
    expect(row.reserved).toEqual(emptyUsage());
    const ok = await admitMatch(db, config(), DEVICE, 1, T0, null, REFUSAL_FROM_ROOM);
    expect(ok.ok).toBe(true);
    const after = (await readLedger(db, dayKey(T0)))!;
    expect(after.spent).toEqual(row.spent);
    expect(after.reserved).toEqual(config().solo);
  });

  it('an admitted match takes one match and reserves its estimate for the people at the table', async () => {
    const db = testDb();
    seedDevice(db);
    const cfg = config();
    const ans = await admitMatch(db, cfg, DEVICE, 4, T0, null);
    expect(ans).toEqual({ ok: true, left: MATCHES_PER_CHECK - 1, reservation: { key: dayKey(T0), est: matchEstimate(cfg, 4) } });
    expect(allowanceUsed(db)).toBe(1);
    expect((await readLedger(db, dayKey(T0)))!.reserved).toEqual(matchEstimate(cfg, 4));
  });

  it('a device with no match left gets check_needed and the reservation goes back', async () => {
    const db = testDb();
    seedDevice(db, DEVICE, MATCHES_PER_CHECK);
    const ans = await admitMatch(db, config(), DEVICE, 1, T0, null);
    expect(ans).toEqual({ ok: false, code: 'check_needed' });
    expect(allowanceUsed(db)).toBe(MATCHES_PER_CHECK);
    const row = (await readLedger(db, dayKey(T0)))!;
    expect(row.matches).toBe(0);
    expect(row.reserved).toEqual(emptyUsage());
  });

  it('with the brake off nothing is written to the ledger', async () => {
    const db = testDb();
    seedDevice(db);
    const ans = await admitMatch(db, config({ mode: 'off' }), DEVICE, 1, T0, null);
    expect(ans).toEqual({ ok: true, left: MATCHES_PER_CHECK - 1, reservation: null });
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM brake_days').get()).toEqual({ n: 0 });
  });

  it('a test ledger follows the free rule on its own row, with room for its capacity in solo matches', async () => {
    const db = testDb();
    seedDevice(db);
    const ledger = parseTestLedger('0123456789abcdef:2')!;
    expect(ledger).toEqual({ id: '0123456789abcdef', capacity: 2 });
    expect(parseTestLedger('0123456789ABCDEF:2')).toBeNull();
    expect(parseTestLedger(null)).toBeNull();
    const cfg = config({ mode: 'off' });
    expect((await admitMatch(db, cfg, DEVICE, 1, T0, ledger)).ok).toBe(true);
    expect((await admitMatch(db, cfg, DEVICE, 1, T0, ledger)).ok).toBe(true);
    expect((await admitMatch(db, cfg, DEVICE, 1, T0, ledger)).ok).toBe(false);
    // Two people weigh more than one solo match.
    const two = parseTestLedger('fedcba9876543210:1')!;
    expect((await admitMatch(db, cfg, DEVICE, 2, T0, two)).ok).toBe(false);
    expect((await readLedger(db, 't-0123456789abcdef'))!.matches).toBe(2);
    expect(await readLedger(db, dayKey(T0))).toBeNull();
  });

  it('a start that did not happen gives back the match and the reservation, and giving back twice never goes below zero', async () => {
    const db = testDb();
    seedDevice(db);
    const cfg = config();
    const ans = await admitMatch(db, cfg, DEVICE, 1, T0, null);
    if (!ans.ok) throw new Error('not admitted');
    await refundAdmission(db, DEVICE, ans.reservation, T0 + 1);
    await refundAdmission(db, DEVICE, ans.reservation, T0 + 2);
    expect(allowanceUsed(db)).toBe(0);
    const row = (await readLedger(db, dayKey(T0)))!;
    expect(row.matches).toBe(0);
    expect(row.reserved).toEqual(emptyUsage());
  });
});

function match(id: string, brake: MatchRow['brake'], seats: MatchRow['seats'] = []): MatchRow {
  return { matchId: id, startedAt: T0, endedAt: T0 + 60_000, kind: 'solo', variant: 'paulista', players: 4, aiVersion: 'v1', recordKey: `k/${id}`, seats, brake };
}

describe('brake: the swap', () => {
  it('swaps once: written again with its match row (an answer lost), it changes nothing', async () => {
    const db = testDb();
    seedDevice(db);
    const cfg = config();
    const a = await admitMatch(db, cfg, DEVICE, 1, T0, null);
    const b = await admitMatch(db, cfg, DEVICE, 1, T0, null);
    if (!a.ok || !b.ok || !a.reservation) throw new Error('not admitted');
    const spent = usage({ workerRequests: 3, doRequests: 9, doWsMessages: 44, doRowsWritten: 48, doActiveMs: 250_000, d1RowsWritten: 12, d1RowsRead: 30 });
    const row = match('m1', { key: a.reservation.key, reserved: a.reservation.est, spent }, [{ seat: 0, device: DEVICE, verified: true }]);
    for (let i = 0; i < 3; i++) await db.batch(matchRowStatements(db, row));
    const d = (await readLedger(db, dayKey(T0)))!;
    expect(d.settled).toBe(1);
    expect(d.matches).toBe(2);
    // The other match's reservation is still there, untouched.
    expect(d.reserved).toEqual(cfg.solo);
    expect(d.spent).toEqual(spent);
    // The seat after the swap is linked (seatStatementIndexes counts the swap and the public counters).
    expect(seatStatementIndexes(row)).toEqual([3]);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM match_seats WHERE match_id = ?').get('m1')).toEqual({ n: 1 });
  });

  it('never leaves a negative sum: a swap or a refund bigger than what is reserved stops at zero', async () => {
    const db = testDb();
    const big = usage({ doRowsWritten: 1_000, doActiveMs: 9_000_000, workerRequests: 50 });
    await db.batch(matchRowStatements(db, match('m2', { key: '2026-11-22', reserved: big, spent: usage({ doRowsWritten: 7 }) })));
    await refundStatement(db, { key: '2026-11-22', est: big }, T0).run();
    const d = (await readLedger(db, '2026-11-22'))!;
    for (const m of METERS) {
      expect(d.reserved[m]).toBeGreaterThanOrEqual(0);
      expect(d.spent[m]).toBeGreaterThanOrEqual(0);
    }
    expect(d.matches).toBe(0);
    expect(d.spent.doRowsWritten).toBe(7);
    // Negative or fractional spend from a faulty count is written as zero or rounded.
    await settleStatement(db, { key: '2026-11-22', reserved: null, spent: usage({ doRowsWritten: -5, doActiveMs: 10.6 }) }, T0).run();
    const e = (await readLedger(db, '2026-11-22'))!;
    expect(e.spent.doRowsWritten).toBe(7);
    expect(e.spent.doActiveMs).toBe(11);
    expect(e.settled).toBe(1);
  });

  it('a room\'s expiry writes what it spent after its last swap, with its own row, and gives back a reservation nobody finished', async () => {
    const db = testDb();
    seedDevice(db);
    const cfg = config();
    const a = await admitMatch(db, cfg, DEVICE, 1, T0, null);
    if (!a.ok || !a.reservation) throw new Error('not admitted');
    // A match swapped at its end; afterwards the room spent more (the record's writes, a close, the expiry).
    const real = usage({ doRowsWritten: 20, doWsMessages: 12, doActiveMs: 50_000 });
    await db.batch(matchRowStatements(db, match('m1', { key: a.reservation.key, reserved: a.reservation.est, spent: real })));
    const after = newRoomBrake(null, null, { doRowsWritten: 6, doRequests: 2, doActiveMs: 20_000, d1RowsWritten: 4 });
    const left = expirySettlement(after, true, T0 + 86_400_000)!;
    expect(left).toEqual({ key: '2026-11-23', reserved: null, spent: addUsage(after.meter, { d1RowsWritten: 1 }) });
    await settleStatement(db, left, T0 + 86_400_000).run();
    expect((await readLedger(db, '2026-11-22'))!).toMatchObject({ matches: 1, settled: 1, spent: real, reserved: emptyUsage() });
    expect((await readLedger(db, '2026-11-23'))!).toMatchObject({ matches: 0, settled: 0, spent: left.spent });
    // A match nobody finished: its reservation goes back on its own day, with what it spent.
    const b = await admitMatch(db, cfg, DEVICE, 1, T0, null);
    if (!b.ok || !b.reservation) throw new Error('not admitted');
    const unfinished = expirySettlement(newRoomBrake(null, b.reservation, { doWsMessages: 3 }), true, T0 + 86_400_000)!;
    expect(unfinished.key).toBe('2026-11-22');
    await settleStatement(db, unfinished, T0 + 86_400_000).run();
    const day = (await readLedger(db, '2026-11-22'))!;
    expect(day).toMatchObject({ matches: 2, settled: 2, reserved: emptyUsage() });
    expect(day.spent.doWsMessages).toBe(real.doWsMessages + 3);
    // A test ledger's room writes to its own row; nothing to write without a reservation and with the brake off or nothing counted.
    const ledger = parseTestLedger('0123456789abcdef:5')!;
    expect(expirySettlement(newRoomBrake(ledger, null, { doRequests: 1 }), true, T0)!.key).toBe('t-0123456789abcdef');
    expect(expirySettlement(newRoomBrake(null, null, { doRequests: 1 }), false, T0)).toBeNull();
    expect(expirySettlement(newRoomBrake(null), true, T0)).toBeNull();
    // With the brake off, a reservation left from before still goes back.
    expect(expirySettlement(newRoomBrake(null, { key: '2026-11-22', est: cfg.solo }), false, T0)!.reserved).toEqual(cfg.solo);
  });

  it('property: any order of admissions, refunds, swaps (each tried up to three times) and expiries leaves the reserved sums equal to the open reservations and the spent sums to the real spend, never below zero', async () => {
    const cfg = config();
    await fc.assert(
      fc.asyncProperty(fc.array(fc.record({ people: fc.integer({ min: 1, max: 4 }), end: fc.constantFrom('swap', 'refund', 'open', 'expire'), tries: fc.integer({ min: 1, max: 3 }), rows: fc.integer({ min: 0, max: 400 }) }), { maxLength: 12 }), async (plan) => {
        const db = testDb();
        seedDevice(db);
        let open = emptyUsage();
        let spent = emptyUsage();
        let id = 0;
        for (const p of plan) {
          db.raw.prepare('UPDATE devices SET matches_since_verify = 0').run();
          const a = await admitMatch(db, cfg, DEVICE, p.people, T0, null);
          if (!a.ok || !a.reservation) throw new Error('not admitted');
          const real = usage({ doRowsWritten: p.rows, doWsMessages: p.rows >> 1 });
          if (p.end === 'refund') {
            await refundAdmission(db, DEVICE, a.reservation, T0);
          } else if (p.end === 'swap') {
            const row = match(`m${id++}`, { key: a.reservation.key, reserved: a.reservation.est, spent: real });
            for (let i = 0; i < p.tries; i++) await db.batch(matchRowStatements(db, row));
            spent = addUsage(spent, real);
          } else if (p.end === 'expire') {
            // A match nobody finished: its room's expiry swaps it (an alarm writes it once).
            const left = expirySettlement(newRoomBrake(null, a.reservation, real), true, T0)!;
            await settleStatement(db, left, T0).run();
            spent = addUsage(spent, left.spent);
          } else {
            open = addUsage(open, a.reservation.est);
          }
        }
        const d = await readLedger(db, dayKey(T0));
        expect(d?.reserved ?? emptyUsage()).toEqual(open);
        expect(d?.spent ?? emptyUsage()).toEqual(spent);
      }),
      { numRuns: 60 },
    );
  });
});

describe('brake: what a room counts', () => {
  it('active time: the union of what runs, from entry to settle, plus the CPU allowance of each invocation; idle gaps cost nothing', () => {
    const c = new BusyClock();
    expect(c.take(0)).toBe(0);
    // A message from 1,000 to 1,004 ms, then 10 s idle, then an alarm that awaits D1 for 30 ms.
    c.enter(1_000, true);
    c.leave(1_004);
    c.enter(11_004, true);
    c.leave(11_034);
    expect(c.busy).toBe(false);
    expect(c.take(20_000)).toBe(4 + 30 + 2 * CPU_PER_INVOCATION_MS);
    expect(c.take(30_000)).toBe(0);
    // Overlapping work counts once: a message from 0 to 50 ms whose waitUntil batch runs to 120 ms,
    // and a second message from 40 to 60 ms. Two invocations; the waitUntil promise is not one.
    c.enter(100_000, true);
    c.enter(100_000, false);
    c.enter(100_040, true);
    c.leave(100_050);
    c.leave(100_060);
    expect(c.busy).toBe(true);
    c.leave(100_120);
    expect(c.busy).toBe(false);
    expect(c.take(100_200)).toBe(120 + 2 * CPU_PER_INVOCATION_MS);
  });

  it('active time: a period still running is taken up to now, and the rest later, never twice', () => {
    const c = new BusyClock();
    c.enter(0, true);
    // The room stores its state at 25 ms: the meter it stores holds the time so far.
    expect(c.take(25)).toBe(25 + CPU_PER_INVOCATION_MS);
    expect(c.take(25)).toBe(0);
    c.leave(70);
    expect(c.take(5_000)).toBe(45);
    // An unmatched leave and a clock that goes back change nothing.
    c.leave(6_000);
    c.enter(7_000, false);
    c.leave(6_990);
    expect(c.take(8_000)).toBe(0);
  });

  it('active time: property, the total taken equals the union of the intervals plus the allowance, however often it is taken', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ start: fc.integer({ min: 0, max: 10_000 }), len: fc.integer({ min: 0, max: 500 }), invocation: fc.boolean() }), { maxLength: 20 }),
        fc.array(fc.integer({ min: 0, max: 11_000 }), { maxLength: 10 }),
        (spans, takes) => {
          // Events in time order: entries before exits at the same time, takes after both.
          const events: { t: number; kind: 0 | 1 | 2; invocation?: boolean }[] = [];
          for (const s of spans) {
            events.push({ t: s.start, kind: 0, invocation: s.invocation });
            events.push({ t: s.start + s.len, kind: 1 });
          }
          for (const t of takes) events.push({ t, kind: 2 });
          events.sort((a, b) => a.t - b.t || a.kind - b.kind);
          const c = new BusyClock();
          let total = 0;
          for (const e of events) {
            if (e.kind === 0) c.enter(e.t, e.invocation!);
            else if (e.kind === 1) c.leave(e.t);
            else total += c.take(e.t);
          }
          total += c.take(20_000);
          // The union of the intervals, computed directly.
          const sorted = [...spans].sort((a, b) => a.start - b.start);
          let union = 0;
          let end = -1;
          let from = -1;
          for (const s of sorted) {
            if (s.start > end) {
              if (end >= 0) union += end - from;
              from = s.start;
              end = s.start + s.len;
            } else end = Math.max(end, s.start + s.len);
          }
          if (end >= 0) union += end - from;
          expect(total).toBe(union + CPU_PER_INVOCATION_MS * spans.filter((s) => s.invocation).length);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('paid lines are billed in whole millions beyond what the plan includes', () => {
    expect(billedMillions(0, 400_000)).toBe(0);
    expect(billedMillions(400_000, 400_000)).toBe(0);
    expect(billedMillions(400_001, 400_000)).toBe(1);
    // The pricing page's example: 500,000 GB-s beyond the included amount bill as 1,000,000.
    expect(billedMillions(900_000, 400_000)).toBe(1);
    expect(billedMillions(1_400_000, 400_000)).toBe(1);
    expect(billedMillions(1_400_001, 400_000)).toBe(2);
  });

  it('the metered database adds the rows D1 reports, runs first() as all(), and sends D1 its own statements in a batch', async () => {
    const seen: unknown[] = [];
    const meta = { rows_written: 2, rows_read: 5 };
    const stmt = (sql: string): SqlStatement => {
      const s: SqlStatement & { sql: string } = {
        sql,
        bind: () => s,
        first: async () => {
          throw new Error('first() is not metered by D1');
        },
        all: async <T>() => ({ results: [{ x: 1 } as T], meta }),
        run: async () => ({ meta: { changes: 1, ...meta } }),
      };
      return s;
    };
    const inner: SqlDb = {
      prepare: stmt,
      batch: async (list) => {
        seen.push(...list);
        return list.map(() => ({ meta: { changes: 1, ...meta }, results: [] }));
      },
    };
    let written = 0;
    let read = 0;
    const db = meteredDb(inner, (w, r) => {
      written += w;
      read += r;
    });
    expect(await db.prepare('a').bind(1).first()).toEqual({ x: 1 });
    await db.prepare('b').run();
    await db.batch([db.prepare('c'), db.prepare('d')]);
    expect(written).toBe(8);
    expect(read).toBe(20);
    expect(seen.map((s) => (s as { sql: string }).sql)).toEqual(['c', 'd']);
  });
});

// -----------------------------------------------------------------------------------------------
// The Worker's routes

interface Handler {
  fetch(request: Request, env: unknown): Promise<Response>;
}

async function handler(): Promise<Handler> {
  const path = '../src/cf/index.ts';
  return ((await import(/* @vite-ignore */ path)) as { default: Handler }).default;
}

const SESSION_SECRET = 'test-only-0123456789abcdef0123456789abcdef';

/** A device with a credential, seeded in D1; answers its cookie header. */
async function person(db: TestDb, used = 0): Promise<{ device: string; cookie: string }> {
  const secret = newDeviceSecret();
  const device = await deviceIdFromSecret(secret);
  seedDevice(db, device, used);
  const now = Date.now();
  const token = await signCredential(SESSION_SECRET, { d: await credentialSubject(SESSION_SECRET, device), v: now, e: now + 3600_000 });
  return { device, cookie: `${deviceCookieName(false)}=${secret}; ${credCookieName(false)}=${token}` };
}

function env(
  db: TestDb,
  create: (...args: unknown[]) => Promise<{ ok: boolean; reason?: string }>,
  extra: Record<string, unknown> = {},
  forget: (device: string) => Promise<{ held: boolean } | void> = async () => ({ held: false }),
) {
  return {
    DB: db,
    ROOM: { idFromName: (c: string) => c, get: () => ({ create, forget }) },
    TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
    TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
    TURNSTILE_HOSTNAMES: '',
    SESSION_SECRET,
    PUBLIC_ORIGIN: 'http://localhost:8787',
    ...wranglerConfig().vars,
    ...extra,
  };
}

function play(cookie: string, origin = 'http://localhost:8787', headers: Record<string, string> = {}): Request {
  const text = JSON.stringify({ players: 4 });
  return new Request(`${origin}/api/play`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'content-length': String(text.length), cookie, ...headers },
    body: text,
  });
}

describe('Worker: the brake at quick play', () => {
  it('a room that fails to start gives back the match and the reservation', async () => {
    const db = testDb();
    const p = await person(db);
    const calls: unknown[][] = [];
    const res = await (await handler()).fetch(
      play(p.cookie),
      env(db, async (...args) => {
        calls.push(args);
        return { ok: false, reason: 'failed' };
      }),
    );
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(1);
    // The room was handed the reservation of the match it was to deal.
    const brake = calls[0][7] as { open: { key: string; est: Usage } };
    expect(brake.open.est).toEqual(config().solo);
    expect(allowanceUsed(db, p.device)).toBe(0);
    const row = (await readLedger(db, dayKey(Date.now())))!;
    expect(row.matches).toBe(0);
    expect(row.reserved).toEqual(emptyUsage());
  });

  it('a refused quick play answers 503 limit_reached with when to come back, and takes nothing', async () => {
    const db = testDb();
    const p = await person(db);
    let created = 0;
    const full = { BRAKE_RESERVE: Object.fromEntries(LIMITS.map((k) => [k, 0.8])) };
    const res = await (await handler()).fetch(
      play(p.cookie),
      env(
        db,
        async () => {
          created++;
          return { ok: true };
        },
        full,
      ),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; limit: { period: string; resetAt: number } };
    expect(body.error).toBe('limit_reached');
    expect(body.limit).toEqual({ period: 'day', resetAt: resetAt(Date.now(), 'day') });
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(created).toBe(0);
    expect(allowanceUsed(db, p.device)).toBe(0);
    // The refusal's own request and ledger row are counted at once.
    const row = (await readLedger(db, dayKey(Date.now())))!;
    expect(row).toMatchObject({ refused: 1, matches: 0 });
    expect(row.spent).toEqual(usage(REFUSAL_FROM_WORKER));
  });

  it('a room whose create() answer was lost keeps the reservation and gives it back itself, once; the Worker gives back only the match', async () => {
    const db = testDb();
    const p = await person(db);
    // The room stores the brake it was given, then its answer is lost; it answers the forget with held.
    let kept: RoomBrake | null = null;
    const res = await (await handler()).fetch(
      play(p.cookie),
      env(
        db,
        async (...args) => {
          kept = args[7] as RoomBrake;
          throw new Error('answer lost');
        },
        {},
        async () => ({ held: kept?.open !== null && kept !== null }),
      ),
    );
    expect(res.status).toBe(503);
    expect(allowanceUsed(db, p.device)).toBe(0);
    const key = dayKey(Date.now());
    const before = (await readLedger(db, key))!;
    expect(before.matches).toBe(1);
    expect(before.reserved).toEqual(config().solo);
    // The closed room expires and swaps the reservation: back to zero, exactly once.
    const left = expirySettlement(kept!, true, Date.now())!;
    await settleStatement(db, left, Date.now()).run();
    const after = (await readLedger(db, key))!;
    expect(after.reserved).toEqual(emptyUsage());
    expect(after).toMatchObject({ matches: 1, settled: 1 });
  });

  it('a room that never ran create() (held false) or did not answer the forget (held unknown): the reservation goes back once, or stays until the day ends', async () => {
    const db = testDb();
    const h = await handler();
    const lost = async () => {
      throw new Error('answer lost');
    };
    const a = await person(db);
    expect((await h.fetch(play(a.cookie), env(db, lost, {}, async () => ({ held: false })))).status).toBe(503);
    expect((await readLedger(db, dayKey(Date.now())))!).toMatchObject({ matches: 0, reserved: emptyUsage() });
    // A room on older code answers the forget with nothing: it held nothing of the brake.
    const b = await person(db);
    expect((await h.fetch(play(b.cookie), env(db, lost, {}, async () => undefined))).status).toBe(503);
    expect((await readLedger(db, dayKey(Date.now())))!).toMatchObject({ matches: 0, reserved: emptyUsage() });
    // No answer to the forget either: the room may hold the reservation, so it stays (never given back twice).
    const c = await person(db);
    const silent = await h.fetch(play(c.cookie), env(db, lost, {}, lost));
    expect(silent.status).toBe(503);
    expect(allowanceUsed(db, c.device)).toBe(0);
    expect((await readLedger(db, dayKey(Date.now())))!).toMatchObject({ matches: 1, reserved: config().solo });
  });

  it('honours a test ledger only on a local test site, and so does its read route', async () => {
    const db = testDb();
    const ok = async () => ({ ok: true });
    const id = '0123456789abcdef';
    const h = await handler();
    // Not a test site: the header is ignored, the day's ledger is used, the route does not exist.
    const a = await person(db);
    expect((await h.fetch(play(a.cookie, undefined, { 'x-zap-test-ledger': `${id}:0` }), env(db, ok))).status).toBe(200);
    expect(await readLedger(db, `t-${id}`)).toBeNull();
    expect((await h.fetch(new Request(`http://localhost:8787/api/test/ledger/${id}`), env(db, ok))).status).toBe(404);
    // A test site over http on a local host: capacity 0 refuses, and the row can be read.
    const b = await person(db);
    const res = await h.fetch(play(b.cookie, undefined, { 'x-zap-test-ledger': `${id}:0` }), env(db, ok, { TEST_RECORDS: 'true' }));
    expect(res.status).toBe(503);
    const read = await h.fetch(new Request(`http://localhost:8787/api/test/ledger/${id}`), env(db, ok, { TEST_RECORDS: 'true' }));
    expect(read.status).toBe(200);
    expect(((await read.json()) as { refused: number }).refused).toBe(1);
    // TEST_RECORDS on a public host (which production would never set): still no test ledger.
    const pub = await h.fetch(new Request(`https://zap.andreiludescher.com/api/test/ledger/${id}`), env(db, ok, { TEST_RECORDS: 'true' }));
    expect(pub.status).toBe(404);
  });
});
