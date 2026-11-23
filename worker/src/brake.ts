// The brake (admission control). On Workers Free, Cloudflare's daily limits belong to the whole
// account, which the Zap shares with the owner's other projects. Before each match starts (quick
// play, a room's start, a rematch) the Worker or the room reserves the typical cost of that match
// in one D1 row per UTC day (brake_days); a match whose reservation would take any sum past its
// share of a limit does not start, and the person reads when to come back. When the match ends,
// the room swaps its reservation for what it really spent (counted in room.ts with the helpers
// at the end of this file), and when the room expires it writes what it spent after its last swap.
// That costs 2 D1 rows written per match (the reservation and the swap) plus 1 per room (the
// expiry). A refusal writes 1 row, with its own cost in it.
//
// Three modes (BRAKE_MODE):
// * "free" (the default, also for any unknown value): each sum of the day must stay at or below
//   HEADROOM minus the reserve of that limit, where the reserve is the share the other projects
//   used over the last 14 days (BRAKE_RESERVE, 0.5 of each limit while that number is unknown).
// * "paid": the brake becomes a monthly bill ceiling on Workers Paid (BRAKE_MONTHLY_USD), priced
//   from the month's rows with the prices below. The reserve then stands for the other projects'
//   use of the amounts the plan includes.
// * "off": no reservation and no row at all.
// DEPLOY.md, section "The brake and when to move to Workers Paid", says which mode to pick.
//
// Everything here is plain TypeScript over the small SQL interface of privacy.ts, so the unit
// tests run the same statements on node:sqlite.

import { utcDate } from '../../shared/cycle-formats.ts';
import type { LimitInfo } from '../../shared/protocol.ts';
import type { SqlDb, SqlStatement } from './privacy.ts';

// -----------------------------------------------------------------------------------------------
// What is counted

/**
 * The meters, in the order of the D1 columns. doRequests are the Durable Object requests other
 * than incoming WebSocket messages (calls from the Worker, socket upgrades, alarms, close events);
 * doWsMessages the incoming WebSocket messages; doActiveMs the wall-clock time a room is billed
 * for: while its handlers run (see BusyClock).
 */
export const METERS = ['workerRequests', 'doRequests', 'doWsMessages', 'doRowsWritten', 'doActiveMs', 'd1RowsWritten', 'd1RowsRead'] as const;
export type Meter = (typeof METERS)[number];
export type Usage = Record<Meter, number>;

/** Column suffix of each meter in brake_days: r_<col> is reserved, s_<col> is spent. */
const COLUMN: Record<Meter, string> = {
  workerRequests: 'wreq',
  doRequests: 'doreq',
  doWsMessages: 'dows',
  doRowsWritten: 'dorows',
  doActiveMs: 'doms',
  d1RowsWritten: 'd1w',
  d1RowsRead: 'd1r',
};

export function emptyUsage(): Usage {
  return { workerRequests: 0, doRequests: 0, doWsMessages: 0, doRowsWritten: 0, doActiveMs: 0, d1RowsWritten: 0, d1RowsRead: 0 };
}

export function addUsage(a: Usage, b: Partial<Usage>): Usage {
  const out = { ...a };
  for (const m of METERS) out[m] += b[m] ?? 0;
  return out;
}

/** The limits the brake guards. */
export const LIMITS = ['workerRequests', 'doRequests', 'doRowsWritten', 'doGbSeconds', 'd1RowsWritten', 'd1RowsRead'] as const;
export type Limit = (typeof LIMITS)[number];

/**
 * Workers Free, per UTC day, for the whole account. Source: _local/pesquisa/research-notes.md
 * (Cloudflare docs read on 2026-11-20, 2026-11-21 and 2026-11-22): "Free 100k Worker
 * requests/day"; Durable Objects "Free: 100k req/day, 13,000 GB-s/day, 5M rows read, 100k rows
 * written/day" (the pricing page, 2026-11-22: requests "100,000 / day", duration "13,000 GB-s /
 * day"); "D1 Free: 5M rows read/day, 100k written/day". They reset at 00:00 UTC, 21h in Brasília.
 */
export const FREE_DAILY: Record<Limit, number> = {
  workerRequests: 100_000,
  doRequests: 100_000,
  doRowsWritten: 100_000,
  doGbSeconds: 13_000,
  d1RowsWritten: 100_000,
  d1RowsRead: 5_000_000,
};

/**
 * Memory every Durable Object is billed for, in GB, whatever it really uses: "Duration billing
 * charges for the 128 MB of memory your Durable Object is allocated, regardless of actual usage"
 * (Cloudflare's Durable Objects pricing page, read on 2026-11-22). Durable Object rows read are
 * not guarded: a room reads its few keys once per wake, a few hundred rows per match at most,
 * against 5 million a day.
 */
export const DO_MEMORY_GB = 0.125;
/** Milliseconds of a room billed for duration that make one GB-s. */
export const MS_PER_GB_SECOND = 1000 / DO_MEMORY_GB;

/**
 * CPU time one invocation of a room may use that its clock cannot see. Inside a Worker,
 * Date.now() moves only when I/O happens, so the CPU work after the last awaited I/O of an
 * invocation reads as no time at all. Workers Free allows 10 ms of CPU per invocation, and Durable
 * Objects "have the same per invocation CPU limits as any Workers do" (Cloudflare's Durable
 * Objects limits page, 2026-11-22), so each invocation adds this much. An invocation is a request,
 * an RPC call, a WebSocket message or close, an alarm, or the constructor of an instance.
 */
export const CPU_PER_INVOCATION_MS = 10;

/**
 * The time the estimates reserve for each invocation of a room (BRAKE_COST_SOLO and
 * BRAKE_COST_PER_PERSON doGbSeconds, project_docs/brake.md): what one took on the local site,
 * CPU_PER_INVOCATION_MS included (tests/sim/brake-measure.ts on 2026-11-22: 18.9 ms per Durable
 * Object request or message over a solo room's life, 12.5 ms in a room of 4 people; the larger,
 * rounded up), plus DURATION_MARGIN_MS.
 */
export const MEASURED_MS_PER_INVOCATION = 19;
/**
 * The safety margin per invocation, for what production adds to the local site: a call to D1 or
 * R2, or the commit of the room's storage writes, which the local site answers in about a
 * millisecond. 250 ms lets every invocation wait for such a round trip across regions, though most
 * of them (a move, a close) await none. An allowance, not a measurement: there is no production
 * site yet, and the ledger's real spend replaces it as matches end. Duration would bind before
 * rows written only above about 1.9 s per invocation (worker/dev/brake-table.ts).
 */
export const DURATION_MARGIN_MS = 250;

/** The duration an estimate reserves for this many invocations (Durable Object requests plus messages), in ms. */
export function durationEstimateMs(invocations: number): number {
  return invocations * (MEASURED_MS_PER_INVOCATION + DURATION_MARGIN_MS);
}

/** The Zap and the other projects together stay at or below this share of each Free limit (plan, section 14). */
export const HEADROOM = 0.8;
/** The other projects' share of each limit while their real use of the last 14 days is unknown (plan, section 14). */
export const DEFAULT_RESERVE = 0.5;

/**
 * How a limit reads the usage on Workers Free: every incoming WebSocket message counts as a
 * request there (the pricing page states the 20 to 1 ratio "for compute requests billing-only";
 * research-notes.md marks it as not confirmed for the Free daily limit, so the brake assumes it
 * does not apply), and the duration limit is read in milliseconds billed (doGbSeconds times
 * MS_PER_GB_SECOND).
 */
export function freeUnits(u: Usage, k: Limit): number {
  switch (k) {
    case 'workerRequests':
      return u.workerRequests;
    case 'doRequests':
      return u.doRequests + u.doWsMessages;
    case 'doRowsWritten':
      return u.doRowsWritten;
    case 'doGbSeconds':
      return u.doActiveMs;
    case 'd1RowsWritten':
      return u.d1RowsWritten;
    case 'd1RowsRead':
      return u.d1RowsRead;
  }
}

/** A Free limit in the units of freeUnits. */
export function freeLimitUnits(k: Limit): number {
  return k === 'doGbSeconds' ? FREE_DAILY[k] * MS_PER_GB_SECOND : FREE_DAILY[k];
}

/** What the Zap may use of each Free limit in one day, in the units of freeUnits: (HEADROOM - reserve) of it. */
export function freeCaps(reserve: Record<Limit, number>): Record<Limit, number> {
  const caps = {} as Record<Limit, number>;
  for (const k of LIMITS) caps[k] = Math.max(0, Math.floor((HEADROOM - reserve[k]) * freeLimitUnits(k)));
  return caps;
}

export function fitsFree(sums: Usage, est: Usage, caps: Record<Limit, number>): boolean {
  const u = addUsage(sums, est);
  return LIMITS.every((k) => freeUnits(u, k) <= caps[k]);
}

// -----------------------------------------------------------------------------------------------
// Workers Paid

/**
 * One line of the Workers Paid bill: what the $5 plan includes per month and the price of each
 * million beyond it, in US dollars, with where the number comes from.
 */
export interface PaidLine {
  included: number;
  usdPerMillion: number;
  source: string;
}

/** The monthly base price of Workers Paid. research-notes.md: "Workers Paid $5/mo: 10M req, 30M CPU-ms". */
export const PAID_BASE_USD = 5;

const NOTES = 'research-notes.md (Cloudflare docs, 2026-11-20)';
const DO_PRICING = 'https://developers.cloudflare.com/durable-objects/platform/pricing/ (read on 2026-11-22)';
const PRICING_2026_11_23 = 'https://developers.cloudflare.com/workers/platform/pricing/ read 2026-11-23 (DEPLOY.md, section 11)';

/**
 * The lines of the bill the Zap moves. Worker CPU time is not a line: the Worker cannot read its
 * own CPU time, and the 30 million CPU ms the plan includes give 3 ms to each of the 10 million
 * included requests, more than the API's routes need (a hash or two and a D1 call). Durable
 * Object and D1 storage stay far below the 5 GB included (one small row per room and per match).
 */
export const PAID_MONTHLY: Record<Limit, PaidLine> = {
  workerRequests: { included: 10_000_000, usdPerMillion: 0.3, source: `included: ${NOTES}; price: ${PRICING_2026_11_23}` },
  doRequests: { included: 1_000_000, usdPerMillion: 0.15, source: `${DO_PRICING}: "1 million / month, + $0.15/million"` },
  doRowsWritten: { included: 50_000_000, usdPerMillion: 1, source: `${NOTES}: "rows written 50M then $1/M"` },
  doGbSeconds: { included: 400_000, usdPerMillion: 12.5, source: `${DO_PRICING}: "400,000 GB-s / month, + $12.50/million GB-s"` },
  d1RowsWritten: { included: 50_000_000, usdPerMillion: 1, source: PRICING_2026_11_23 },
  d1RowsRead: { included: 25_000_000_000, usdPerMillion: 0.001, source: PRICING_2026_11_23 },
};

/**
 * WebSocket messages billed as one request on Workers Paid: "For compute requests billing-only, a
 * 20:1 ratio is applied to incoming WebSocket messages" (the pricing page, 2026-11-22).
 */
export const WS_MESSAGES_PER_BILLED_REQUEST = 20;

/** How a line of the Paid bill reads the usage. */
export function paidUnits(u: Usage, k: Limit): number {
  switch (k) {
    case 'doRequests':
      return u.doRequests + u.doWsMessages / WS_MESSAGES_PER_BILLED_REQUEST;
    case 'doGbSeconds':
      return u.doActiveMs / MS_PER_GB_SECOND;
    default:
      return freeUnits(u, k);
  }
}

/**
 * The other projects' use of each line in a month: their reserve share of the Free daily limit,
 * every day of the month. It comes out of the included amounts first.
 */
export function othersMonthly(reserve: Record<Limit, number>, daysInMonth: number): Record<Limit, number> {
  const out = {} as Record<Limit, number>;
  for (const k of LIMITS) out[k] = reserve[k] * FREE_DAILY[k] * daysInMonth;
  return out;
}

/**
 * Millions billed beyond the included amount: "This billable usage is rounded up to the next
 * billable unit before the corresponding rate is applied. For example, 500,000 GB-s of billable
 * compute duration is rounded up to 1,000,000 GB-s" (the pricing page, 2026-11-22). The page says
 * it of the Durable Objects lines; the brake rounds every line the same way, which can only make
 * the bill it expects higher.
 */
export function billedMillions(units: number, included: number): number {
  return Math.ceil(Math.max(0, units - included) / 1_000_000);
}

/** The estimated Workers Paid bill of a month in US dollars, for the Zap's usage plus the other projects'. */
export function monthlyCost(u: Usage, others: Record<Limit, number>): number {
  let usd = PAID_BASE_USD;
  for (const k of LIMITS) {
    const line = PAID_MONTHLY[k];
    usd = usd + line.usdPerMillion * billedMillions(paidUnits(u, k) + others[k], line.included);
  }
  return usd;
}

export function fitsPaid(sums: Usage, est: Usage, ceilingUsd: number, others: Record<Limit, number>): boolean {
  return monthlyCost(addUsage(sums, est), others) <= ceilingUsd;
}

/**
 * The lowest paid ceiling under which a match can start at all: the bill of a 31 day month with
 * the other projects' use alone. Below it the paid mode refuses every match.
 */
export function minimumCeiling(othersShare: Record<Limit, number>): number {
  return monthlyCost(emptyUsage(), othersMonthly(othersShare, 31));
}

// -----------------------------------------------------------------------------------------------
// Configuration

export type BrakeMode = 'free' | 'paid' | 'off';

/** The variables of wrangler.jsonc the brake reads. A JSON value may also come as a string (.dev.vars, --var). */
export interface BrakeEnv {
  BRAKE_MODE?: string;
  BRAKE_RESERVE?: unknown;
  BRAKE_MONTHLY_USD?: unknown;
  BRAKE_COST_SOLO?: unknown;
  BRAKE_COST_PER_PERSON?: unknown;
}

/** The keys of a cost estimate in the configuration: the meters, with the room's time in GB-s. */
export const ESTIMATE_KEYS = ['workerRequests', 'doRequests', 'doWsMessages', 'doRowsWritten', 'doGbSeconds', 'd1RowsWritten', 'd1RowsRead'] as const;

export interface BrakeConfig {
  mode: BrakeMode;
  /** The other projects' share of each Free daily limit for the free rule, at most HEADROOM. */
  reserve: Record<Limit, number>;
  /**
   * The same shares as entered, without that bound: in the paid mode they stand for the other
   * projects' monthly use, which may pass 0.8 of a Free daily limit on Workers Paid.
   */
  othersShare: Record<Limit, number>;
  /** The monthly bill ceiling of the paid mode, in US dollars, the $5 base included (never below it). */
  monthlyUsd: number;
  /** The typical cost of a match with one person (quick play, 2 against 2, paulista). */
  solo: Usage;
  /** What each person beyond the first adds to it. */
  perPerson: Usage;
  /** Values that were missing or invalid and fell back to a default. */
  problems: string[];
}

/**
 * Fallbacks for BRAKE_COST_SOLO and BRAKE_COST_PER_PERSON, the same values as wrangler.jsonc
 * (worker/test/brake.test.ts checks it). Measured on the local site: project_docs/brake.md. The
 * duration is durationEstimateMs of the requests and messages, in GB-s rounded up to a tenth.
 * Since milestone 7 each match also updates the public counters' row (privacy.ts
 * liveCountStatement): one D1 row written and the one it reads, once per match, so the solo
 * estimate carries LIVE_COUNTER_ROWS more of each than the measured 26 and 16.
 */
export const LIVE_COUNTER_ROWS = { d1RowsWritten: 1, d1RowsRead: 1 } as const;
export const DEFAULT_COST_SOLO: Record<(typeof ESTIMATE_KEYS)[number], number> = {
  workerRequests: 2,
  doRequests: 4,
  doWsMessages: 13,
  doRowsWritten: 26,
  doGbSeconds: 0.6,
  d1RowsWritten: 27,
  d1RowsRead: 17,
};
export const DEFAULT_COST_PER_PERSON: Record<(typeof ESTIMATE_KEYS)[number], number> = {
  workerRequests: 1,
  doRequests: 5,
  doWsMessages: 15,
  doRowsWritten: 22,
  doGbSeconds: 0.7,
  d1RowsWritten: 15,
  d1RowsRead: 9,
};
export const DEFAULT_MONTHLY_USD = 10;

function jsonValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function numberValue(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

function estimate(raw: unknown, fallback: Record<(typeof ESTIMATE_KEYS)[number], number>, name: string, problems: string[]): Usage {
  const v = jsonValue(raw);
  const obj = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  if (raw !== undefined && !obj) problems.push(`${name} is not an object`);
  const read = (k: (typeof ESTIMATE_KEYS)[number]): number => {
    const n = obj ? numberValue(obj[k]) : null;
    if (n !== null && n >= 0) return n;
    if (obj) problems.push(`${name}.${k} missing or invalid`);
    return fallback[k];
  };
  const out = emptyUsage();
  for (const k of ESTIMATE_KEYS) {
    if (k === 'doGbSeconds') out.doActiveMs = Math.ceil(read(k) * MS_PER_GB_SECOND);
    else out[k] = Math.ceil(read(k));
  }
  return out;
}

/** Reads the brake's variables. Anything missing or invalid falls back to the protective default and is listed in problems. */
export function brakeConfig(env: BrakeEnv): BrakeConfig {
  const problems: string[] = [];
  const rawMode = (env.BRAKE_MODE ?? '').trim();
  const mode: BrakeMode = rawMode === 'paid' || rawMode === 'off' ? rawMode : 'free';
  if (rawMode !== mode) problems.push(`BRAKE_MODE "${rawMode}" read as "free"`);

  // A share above HEADROOM is real (the other projects are that heavy): the free rule then gives
  // the Zap nothing of that line, and the paid mode prices the share as entered. Only a missing,
  // negative or non-numeric value falls back to DEFAULT_RESERVE.
  const reserve = {} as Record<Limit, number>;
  const othersShare = {} as Record<Limit, number>;
  const r = jsonValue(env.BRAKE_RESERVE);
  const rObj = r && typeof r === 'object' && !Array.isArray(r) ? (r as Record<string, unknown>) : null;
  if (env.BRAKE_RESERVE !== undefined && !rObj) problems.push('BRAKE_RESERVE is not an object');
  for (const k of LIMITS) {
    const n = rObj ? numberValue(rObj[k]) : null;
    if (n !== null && n >= 0) {
      othersShare[k] = n;
      reserve[k] = Math.min(n, HEADROOM);
      if (n >= HEADROOM && mode === 'free') {
        problems.push(`BRAKE_RESERVE.${k} ${n}${n > HEADROOM ? ` read as ${HEADROOM}` : ''}: the Zap gets nothing of that line on Workers Free, every match refused`);
      }
    } else {
      othersShare[k] = DEFAULT_RESERVE;
      reserve[k] = DEFAULT_RESERVE;
      problems.push(`BRAKE_RESERVE.${k} missing, negative or not a number: ${DEFAULT_RESERVE} used`);
    }
  }

  let monthlyUsd = numberValue(env.BRAKE_MONTHLY_USD);
  if (monthlyUsd === null) {
    if (mode === 'paid') problems.push('BRAKE_MONTHLY_USD missing or invalid');
    monthlyUsd = mode === 'paid' ? PAID_BASE_USD : DEFAULT_MONTHLY_USD;
  } else if (monthlyUsd < PAID_BASE_USD) {
    problems.push(`BRAKE_MONTHLY_USD below the $${PAID_BASE_USD} base`);
    monthlyUsd = PAID_BASE_USD;
  }
  if (mode === 'paid') {
    const least = minimumCeiling(othersShare);
    if (monthlyUsd < least) problems.push(`BRAKE_MONTHLY_USD ${monthlyUsd} is below the other projects' own bill (US$ ${least.toFixed(2)} in a 31 day month): every match refused`);
  }

  return {
    mode,
    reserve,
    othersShare,
    monthlyUsd,
    solo: estimate(env.BRAKE_COST_SOLO, DEFAULT_COST_SOLO, 'BRAKE_COST_SOLO', problems),
    perPerson: estimate(env.BRAKE_COST_PER_PERSON, DEFAULT_COST_PER_PERSON, 'BRAKE_COST_PER_PERSON', problems),
    problems,
  };
}

const problemsLogged = new Set<string>();

/**
 * Logs the configuration's problems once per isolate (the Worker and each room call it with the
 * configuration they read), so a fallback never goes unseen. The daily cron run lists them too.
 */
export function logBrakeProblems(cfg: BrakeConfig, log: (line: string) => void = console.error): void {
  const line = `brake config: ${cfg.problems.join('; ')}`;
  if (cfg.problems.length === 0 || problemsLogged.has(line)) return;
  problemsLogged.add(line);
  log(line);
}

/** The typical cost of a match with this many people at the table (at least one). */
export function matchEstimate(cfg: BrakeConfig, people: number): Usage {
  const extra = Math.max(0, Math.floor(people) - 1);
  const out = { ...cfg.solo };
  for (const m of METERS) out[m] += extra * cfg.perPerson[m];
  return out;
}

// -----------------------------------------------------------------------------------------------
// Days, months and when the brake lets go

/** The ledger row of a UTC day: its date. */
export function dayKey(now: number): string {
  return utcDate(now);
}

export type BrakePeriod = LimitInfo['period'];
export type { LimitInfo };

/** When the period that holds `now` ends: 00:00 UTC of the next day or of the 1st of the next month (21h in Brasília). */
export function resetAt(now: number, period: BrakePeriod): number {
  const d = new Date(now);
  return period === 'day' ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export function daysInMonth(now: number): number {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}


// -----------------------------------------------------------------------------------------------
// Test ledgers (local test sites only)

/**
 * A ledger of its own for a test on a local test site (x-zap-test-ledger: <16 hex>:<capacity>):
 * the "free" rule on a row named t-<id>, with room for `capacity` solo matches of every limit,
 * whatever the site's mode. The Worker honours the header only when TEST_RECORDS is "true" and
 * the request names a local host (index.ts), which production never does.
 */
export interface TestLedger {
  id: string;
  capacity: number;
}

export function parseTestLedger(header: string | null): TestLedger | null {
  const m = /^([0-9a-f]{16}):(\d{1,4})$/.exec(header ?? '');
  return m ? { id: m[1], capacity: Number(m[2]) } : null;
}

export const testLedgerKey = (l: TestLedger) => `t-${l.id}`;

// -----------------------------------------------------------------------------------------------
// The statements

/** What a refused quick play costs: its Worker request and the ledger row the refusal writes. */
export const REFUSAL_FROM_WORKER: Partial<Usage> = { workerRequests: 1, d1RowsWritten: 1 };
/** What a refused start or rematch costs: its WebSocket message and the ledger row the refusal writes. */
export const REFUSAL_FROM_ROOM: Partial<Usage> = { doWsMessages: 1, d1RowsWritten: 1 };

/** A reservation made for a match: the row it went to and what it reserved there. */
export interface Reservation {
  key: string;
  est: Usage;
}

/** The rule one admission checks, with the rows it reads. */
export type AdmitRule =
  | { kind: 'free'; caps: Record<Limit, number> }
  | { kind: 'paid'; ceilingUsd: number; others: Record<Limit, number> };

export interface AdmitPlan {
  /** The row the reservation goes to. */
  key: string;
  /** The rows whose sums the rule reads: the day itself, or every day of the month. */
  lo: string;
  hi: string;
  est: Usage;
  rule: AdmitRule;
  limit: LimitInfo;
}

/**
 * The plan of one admission, or null when the brake is off. A test ledger always follows the
 * "free" rule on its own row.
 */
export function admitPlan(cfg: BrakeConfig, people: number, now: number, ledger: TestLedger | null): AdmitPlan | null {
  const est = matchEstimate(cfg, people);
  if (ledger) {
    const one = matchEstimate(cfg, 1);
    const caps = {} as Record<Limit, number>;
    for (const k of LIMITS) caps[k] = ledger.capacity * freeUnits(one, k);
    const key = testLedgerKey(ledger);
    return { key, lo: key, hi: key, est, rule: { kind: 'free', caps }, limit: { period: 'day', resetAt: resetAt(now, 'day') } };
  }
  if (cfg.mode === 'off') return null;
  const day = dayKey(now);
  if (cfg.mode === 'free') {
    return { key: day, lo: day, hi: day, est, rule: { kind: 'free', caps: freeCaps(cfg.reserve) }, limit: { period: 'day', resetAt: resetAt(now, 'day') } };
  }
  const month = day.slice(0, 7);
  return {
    key: day,
    lo: `${month}-01`,
    hi: `${month}-31`,
    est,
    rule: { kind: 'paid', ceilingUsd: cfg.monthlyUsd, others: othersMonthly(cfg.othersShare, daysInMonth(now)) },
    limit: { period: 'month', resetAt: resetAt(now, 'month') },
  };
}

/** Collects bound values and answers their numbered placeholders. */
class Params {
  readonly values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `?${this.values.length}`;
  }
}

/** The SQL of one limit's use, over the sums m.<col> plus the estimate's placeholders. */
function useSql(k: Limit, e: Record<Meter, string>, rule: 'free' | 'paid'): string {
  const s = (m: Meter) => `(m.${COLUMN[m]} + ${e[m]})`;
  switch (k) {
    case 'workerRequests':
      return s('workerRequests');
    case 'doRequests':
      return rule === 'free' ? `(${s('doRequests')} + ${s('doWsMessages')})` : `(${s('doRequests')} + ${s('doWsMessages')} / ${WS_MESSAGES_PER_BILLED_REQUEST}.0)`;
    case 'doRowsWritten':
      return s('doRowsWritten');
    case 'doGbSeconds':
      return rule === 'free' ? s('doActiveMs') : `(${s('doActiveMs')} / ${MS_PER_GB_SECOND}.0)`;
    case 'd1RowsWritten':
      return s('d1RowsWritten');
    case 'd1RowsRead':
      return s('d1RowsRead');
  }
}

/** The admission test in SQL; the same arithmetic as fitsFree and fitsPaid, in the same order. */
function okSql(rule: AdmitRule, e: Record<Meter, string>, p: Params): string {
  if (rule.kind === 'free') return LIMITS.map((k) => `${useSql(k, e, 'free')} <= ${p.add(rule.caps[k])}`).join(' AND ');
  let cost = p.add(PAID_BASE_USD);
  for (const k of LIMITS) {
    const line = PAID_MONTHLY[k];
    // billedMillions: the excess in millions, rounded up (SQLite has no CEIL everywhere).
    const x = `(MAX(0, ${useSql(k, e, 'paid')} + ${p.add(rule.others[k])} - ${p.add(line.included)}) / 1000000.0)`;
    cost = `(${cost} + ${p.add(line.usdPerMillion)} * (CAST(${x} AS INTEGER) + (${x} > CAST(${x} AS INTEGER))))`;
  }
  return `${cost} <= ${p.add(rule.ceilingUsd)}`;
}

/**
 * The reservation in one statement: the sums of the rows the rule reads, the test, and the row
 * of `key` updated with the estimate when it fits, or with one more refusal when it does not. It
 * answers the row's ticket, which is `ticket` exactly when the match fits (allowanceGuard ties
 * the device's allowance to it in the same batch).
 *
 * A refusal still costs something (the request or the WebSocket message that asked, and this row
 * written), and no swap ever follows it: `refusal` is that cost, added to the spent sums only
 * when the match does not fit (REFUSAL_FROM_WORKER, REFUSAL_FROM_ROOM).
 */
export function admitStatement(db: SqlDb, plan: AdmitPlan, ticket: string, now: number, refusal: Partial<Usage> = {}): SqlStatement {
  const p = new Params();
  const key = p.add(plan.key);
  const lo = p.add(plan.lo);
  const hi = p.add(plan.hi);
  const tk = p.add(ticket);
  const at = p.add(now);
  const e = {} as Record<Meter, string>;
  for (const m of METERS) e[m] = p.add(plan.est[m]);
  const sums = METERS.map((m) => `COALESCE(SUM(r_${COLUMN[m]} + s_${COLUMN[m]}), 0) AS ${COLUMN[m]}`).join(', ');
  const ok = okSql(plan.rule, e, p);
  const no = METERS.map((m) => `(1 - c.ok) * ${p.add(Math.max(0, Math.round(refusal[m] ?? 0)))}`);
  const cols = [...METERS.map((m) => `r_${COLUMN[m]}`), ...METERS.map((m) => `s_${COLUMN[m]}`)];
  const sql = `WITH m AS (SELECT ${sums} FROM brake_days WHERE day BETWEEN ${lo} AND ${hi}),
c AS (SELECT CASE WHEN ${ok} THEN 1 ELSE 0 END AS ok FROM m)
INSERT INTO brake_days (day, matches, refused, ticket, ${cols.join(', ')}, updated_at)
SELECT ${key}, c.ok, 1 - c.ok, CASE WHEN c.ok = 1 THEN ${tk} END, ${METERS.map((m) => `c.ok * ${e[m]}`).join(', ')}, ${no.join(', ')}, ${at} FROM c WHERE 1
ON CONFLICT (day) DO UPDATE SET matches = matches + excluded.matches, refused = refused + excluded.refused, ticket = COALESCE(excluded.ticket, ticket), ${cols
    .map((c) => `${c} = ${c} + excluded.${c}`)
    .join(', ')}, updated_at = excluded.updated_at
RETURNING ticket`;
  return db.prepare(sql).bind(...p.values);
}

/** A condition for another statement of the same batch: the admission with this ticket went through. */
export function allowanceGuard(dayParam: string, ticketParam: string): string {
  return `EXISTS (SELECT 1 FROM brake_days WHERE day = ${dayParam} AND ticket = ${ticketParam})`;
}

/** Gives a reservation back (a match that did not start). Never takes a sum below zero. */
export function refundStatement(db: SqlDb, r: Reservation, now: number): SqlStatement {
  const sets = METERS.map((m, i) => `r_${COLUMN[m]} = MAX(0, r_${COLUMN[m]} - ?${i + 3})`).join(', ');
  return db.prepare(`UPDATE brake_days SET matches = MAX(0, matches - 1), ${sets}, updated_at = ?2 WHERE day = ?1`).bind(r.key, now, ...METERS.map((m) => r.est[m]));
}

/** The swap of a match's reservation for its real spend, or the spend of a room with no reservation open. */
export interface Settlement {
  key: string;
  /** The reservation being swapped, or null when there is none (a room that expires with spend left over). */
  reserved: Usage | null;
  spent: Usage;
}

/**
 * The swap: the row's reserved sums lose the reservation (never below zero) and its spent sums
 * gain the real spend. With matchId, it applies only while D1 has no row for that match yet, and
 * it goes in the same batch as that row (privacy.ts matchRowStatements), so a write tried again
 * after an answer was lost never counts twice.
 */
export function settleStatement(db: SqlDb, s: Settlement, now: number, matchId: string | null = null): SqlStatement {
  const p = new Params();
  const key = p.add(s.key);
  const at = p.add(now);
  const settled = p.add(s.reserved ? 1 : 0);
  const spent = METERS.map((m) => p.add(Math.max(0, Math.round(s.spent[m]))));
  const reserved = METERS.map((m) => p.add(s.reserved ? s.reserved[m] : 0));
  const guard = matchId === null ? '1' : `NOT EXISTS (SELECT 1 FROM matches WHERE id = ${p.add(matchId)})`;
  const sCols = METERS.map((m) => `s_${COLUMN[m]}`);
  const sql = `INSERT INTO brake_days (day, settled, ${sCols.join(', ')}, updated_at)
SELECT ${key}, ${settled}, ${spent.join(', ')}, ${at} WHERE ${guard}
ON CONFLICT (day) DO UPDATE SET settled = settled + excluded.settled, ${METERS.map((m, i) => `r_${COLUMN[m]} = MAX(0, r_${COLUMN[m]} - ${reserved[i]})`).join(', ')}, ${sCols
    .map((c) => `${c} = ${c} + excluded.${c}`)
    .join(', ')}, updated_at = excluded.updated_at`;
  return db.prepare(sql).bind(...p.values);
}

/** One ledger row as the owner and the tests read it. */
export interface LedgerRow {
  day: string;
  matches: number;
  settled: number;
  refused: number;
  reserved: Usage;
  spent: Usage;
}

export async function readLedger(db: SqlDb, key: string): Promise<LedgerRow | null> {
  const row = await db.prepare('SELECT * FROM brake_days WHERE day = ?').bind(key).first<Record<string, number | string>>();
  if (!row) return null;
  const reserved = emptyUsage();
  const spent = emptyUsage();
  for (const m of METERS) {
    reserved[m] = Number(row[`r_${COLUMN[m]}`]);
    spent[m] = Number(row[`s_${COLUMN[m]}`]);
  }
  return { day: String(row.day), matches: Number(row.matches), settled: Number(row.settled), refused: Number(row.refused), reserved, spent };
}

/** A fresh ticket for one admission. */
export function newTicket(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// -----------------------------------------------------------------------------------------------
// What a room counts

/** The brake's part of a room's stored state (StoredRoom.brake in room-core.ts). */
export interface RoomBrake {
  /** The test ledger the room was created with (local test sites only), or null. */
  ledger: TestLedger | null;
  /** The reservation of the match being played, until it is swapped for the real spend. */
  open: Reservation | null;
  /** What the room spent since the last swap: everything it received and wrote, and its time active. */
  meter: Usage;
}

export function newRoomBrake(ledger: TestLedger | null, open: Reservation | null = null, spent: Partial<Usage> = {}): RoomBrake {
  return { ledger, open, meter: addUsage(emptyUsage(), spent) };
}

/**
 * What a room writes to the ledger when it expires: what it spent since its last swap (the last
 * record's writes, closing sockets, the expiry and its deleted storage, the time all of it ran),
 * plus the ledger row itself, with the reservation of a match nobody finished, if any. One row per
 * room. Null when there is nothing to write: no reservation, and nothing counted or the brake not
 * counting (`counting` false: the brake off and no test ledger).
 */
export function expirySettlement(b: RoomBrake, counting: boolean, now: number): Settlement | null {
  if (!b.open && !(counting && METERS.some((m) => b.meter[m] > 0))) return null;
  return {
    key: b.open?.key ?? (b.ledger ? testLedgerKey(b.ledger) : dayKey(now)),
    reserved: b.open?.est ?? null,
    spent: addUsage(b.meter, { d1RowsWritten: 1 }),
  };
}

/**
 * The time a room is billed for. Cloudflare bills a Durable Object for duration "while the Durable
 * Object is actively running or is idle in memory but unable to hibernate", and not while it is
 * "idle and eligible for hibernation", "even before the runtime has hibernated them" (pricing
 * page, 2026-11-22). A room uses the hibernation API and keeps no timer, no outgoing socket and
 * no outgoing fetch, so it is billed only while its invocations run, from entry until the promise
 * they return settles (awaited I/O included), and while a promise it handed to ctx.waitUntil is
 * pending (the lifecycle page: hibernation needs that no "promise passed to
 * this.ctx.waitUntil() remains unfinished").
 *
 * The clock counts the union of those intervals: work that overlaps counts once, as duration "is
 * shared across all requests active on an Object at once". Each invocation adds
 * CPU_PER_INVOCATION_MS for the CPU time Date.now() does not see. take() hands over what was
 * counted and not taken yet, a busy period still running up to now, so the room puts it in the
 * meter it is about to store.
 */
export class BusyClock {
  private open = 0;
  /** Start of the busy period, or of its part not taken yet. */
  private from = 0;
  private untaken = 0;

  /** An invocation starts (invocation true), or a promise handed to waitUntil (false). */
  enter(now: number, invocation: boolean): void {
    if (this.open === 0) this.from = now;
    this.open++;
    if (invocation) this.untaken += CPU_PER_INVOCATION_MS;
  }

  /** The matching end: when nothing runs any more, the busy period closes. */
  leave(now: number): void {
    if (this.open === 0) return;
    this.open--;
    if (this.open === 0) this.untaken += Math.max(0, now - this.from);
  }

  /** Milliseconds counted and not taken yet; a busy period still running counts up to now. */
  take(now: number): number {
    let add = this.untaken;
    this.untaken = 0;
    if (this.open > 0) {
      add += Math.max(0, now - this.from);
      this.from = Math.max(this.from, now);
    }
    return add;
  }

  /** Whether an invocation or a waitUntil promise is running. */
  get busy(): boolean {
    return this.open > 0;
  }
}

/** What D1 reports for one statement (rows_read and rows_written are D1's; node:sqlite has none). */
interface D1Meta {
  meta?: { rows_read?: unknown; rows_written?: unknown };
}

const INNER = Symbol('inner');
type Wrapped = SqlStatement & { [INNER]: SqlStatement };

/**
 * A database that adds the rows D1 says each statement read and wrote to `count`. first() runs as
 * all(), since D1 gives the counts only with the results. Statements in a batch go to D1 as its
 * own objects.
 */
export function meteredDb(db: SqlDb, count: (written: number, read: number) => void): SqlDb {
  const take = (r: unknown) => {
    const m = (r as D1Meta | null)?.meta;
    if (m) count(Number(m.rows_written) || 0, Number(m.rows_read) || 0);
  };
  const wrap = (st: SqlStatement): Wrapped => ({
    [INNER]: st,
    bind: (...values: unknown[]) => wrap(st.bind(...values)),
    first: async <T>() => {
      const r = await st.all<T>();
      take(r);
      return r.results[0] ?? null;
    },
    all: async <T>() => {
      const r = await st.all<T>();
      take(r);
      return r;
    },
    run: async () => {
      const r = await st.run();
      take(r);
      return r;
    },
  });
  return {
    prepare: (query: string) => wrap(db.prepare(query)),
    batch: async (statements: SqlStatement[]) => {
      const res = await db.batch(statements.map((s) => (INNER in s ? (s as Wrapped)[INNER] : s)));
      for (const r of res) take(r);
      return res;
    },
  };
}
