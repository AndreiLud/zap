// Prints the brake's numbers for DEPLOY.md ("The brake and when to move to Workers Paid") from the
// code's own arithmetic (worker/src/brake.ts) and the estimates in wrangler.jsonc: what a match
// costs, how many matches a day the free mode admits, the plan's cost table (100, 1,000 and 10,000
// solo matches a day) against the Workers Free limits, and the Workers Paid bill of a month.
//
//   docker compose run --rm -T node node worker/dev/brake-table.ts

import { readFileSync } from 'node:fs';
import {
  FREE_DAILY,
  LIMITS,
  MS_PER_GB_SECOND,
  brakeConfig,
  durationEstimateMs,
  freeCaps,
  freeLimitUnits,
  freeUnits,
  matchEstimate,
  minimumCeiling,
  monthlyCost,
  othersMonthly,
  type Limit,
  type Usage,
} from '../src/brake.ts';

/** wrangler.jsonc without comments and trailing commas. */
function wranglerVars(): Record<string, unknown> {
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
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')).vars;
}

const cfg = brakeConfig(wranglerVars());
if (cfg.problems.length) console.log('configuration problems:', cfg.problems);
const estimate = matchEstimate(cfg, 1);
const room4 = matchEstimate(cfg, 4);
/**
 * The simulated people's matches were short (project_docs/brake.md). A match LONG times as long,
 * near the plan's premise of about 36 messages, multiplies what grows with it: messages, rows
 * written in the room, and the time its handlers run (durationEstimateMs of its requests and
 * messages, rounded up to a tenth of a GB-s like the estimate). What the room writes after the
 * match until it expires (TAIL_ROWS, measured the same on every solo room in
 * project_docs/brake.md) does not grow.
 */
const LONG = 3;
const TAIL_ROWS = 8;
const grow = (x: number, tail: number) => (x - tail) * LONG + tail;
const tenthGbS = (ms: number) => Math.ceil(ms / (MS_PER_GB_SECOND / 10)) * (MS_PER_GB_SECOND / 10);
const long: Usage = {
  ...estimate,
  doWsMessages: estimate.doWsMessages * LONG,
  doRowsWritten: grow(estimate.doRowsWritten, TAIL_ROWS),
  doActiveMs: tenthGbS(durationEstimateMs(estimate.doRequests + estimate.doWsMessages * LONG)),
};
const reserveAll = (r: number) => Object.fromEntries(LIMITS.map((k) => [k, r])) as Record<Limit, number>;
const int = (x: number) => Math.round(x).toLocaleString('en-US');
const pct = (x: number) => `${(100 * x).toFixed(x < 0.1 ? 1 : 0)}%`;
const usd = (x: number) => `US$ ${x.toFixed(2)}`;
const shown = (u: Usage, k: Limit) => (k === 'doGbSeconds' ? freeUnits(u, k) / MS_PER_GB_SECOND : freeUnits(u, k));
const scale = (u: Usage, n: number): Usage => Object.fromEntries(Object.entries(u).map(([k, v]) => [k, v * n])) as Usage;

console.log('One match, as the Workers Free limits count it:');
for (const k of LIMITS) {
  const d = k === 'doGbSeconds' ? 1 : 0;
  const ratio = freeUnits(room4, k) / Math.max(1, freeUnits(estimate, k));
  console.log(`  ${k}: solo ${shown(estimate, k).toFixed(d)}, solo ${LONG} times as long ${shown(long, k).toFixed(d)}, room of 4 ${shown(room4, k).toFixed(d)} (${ratio.toFixed(1)} solo matches)`);
}
const weight = Math.max(...LIMITS.map((k) => freeUnits(room4, k) / Math.max(1, freeUnits(estimate, k))));
console.log(`  a room of 4 weighs ${weight.toFixed(1)} solo matches on its heaviest limit`);

// How long each invocation could take before duration binds before every other limit, with the
// 50% reserve: the duration cap spread over the matches the next limit admits.
{
  const caps = freeCaps(reserveAll(0.5));
  const others = LIMITS.filter((k) => k !== 'doGbSeconds').map((k) => ({ k, n: Math.floor(caps[k] / Math.max(1, freeUnits(estimate, k))) })).sort((a, b) => a.n - b.n);
  const invocations = estimate.doRequests + estimate.doWsMessages;
  const perInvocation = caps.doGbSeconds / (others[0].n * invocations);
  console.log(
    `  duration binds before ${others[0].k} (${int(others[0].n)} solo matches a day, 50% reserve) only above ${int(perInvocation)} ms per Durable Object request or message ` +
      `(the estimate reserves ${int(estimate.doActiveMs / invocations)} ms)`,
  );
}

console.log(
  `\nPaid mode: the lowest BRAKE_MONTHLY_USD that lets any match start (the other projects' own bill in a 31 day month): ` +
    `${usd(minimumCeiling(cfg.othersShare))} with the reserve in wrangler.jsonc; with every share at 50% ${usd(minimumCeiling(reserveAll(0.5)))}, at 80% ${usd(minimumCeiling(reserveAll(0.8)))}`,
);

for (const [label, shape] of [['the estimate', estimate], [`matches ${LONG} times as long`, long]] as const) report(label, shape);

function report(label: string, solo: Usage): void {
  console.log(`\n=== ${label} ===`);
  console.log('Free mode: solo matches a day the brake admits (80% of each limit minus the reserve):');
  for (const r of [0.5, 0.3, 0.2, 0]) {
    const caps = freeCaps(reserveAll(r));
    const per = LIMITS.map((k) => ({ k, n: Math.floor(caps[k] / Math.max(1, freeUnits(solo, k))) })).sort((a, b) => a.n - b.n);
    console.log(`  reserve ${pct(r)}: ${int(per[0].n)} solo matches (limit that binds: ${per[0].k}; next: ${per[1].k} at ${int(per[1].n)})`);
  }

  console.log("The plan's table: solo matches a day against the Workers Free daily limits, and the Workers Paid bill of a 30 day month:");
  for (const n of [100, 1_000, 10_000]) {
    const day = scale(solo, n);
    const uses = LIMITS.map((k) => ({ k, share: freeUnits(day, k) / freeLimitUnits(k) }));
    const worst = uses.reduce((a, b) => (b.share > a.share ? b : a));
    const fitsWith = (r: number) => uses.every((u) => u.share <= 0.8 - r);
    const month = scale(solo, n * 30);
    console.log(
      `  ${int(n)}/day: DO rows ${int(freeUnits(day, 'doRowsWritten'))} (${pct(freeUnits(day, 'doRowsWritten') / FREE_DAILY.doRowsWritten)}), ` +
        `DO requests ${int(freeUnits(day, 'doRequests'))} (${pct(freeUnits(day, 'doRequests') / FREE_DAILY.doRequests)}), ` +
        `DO GB-s ${int(shown(day, 'doGbSeconds'))} (${pct(shown(day, 'doGbSeconds') / FREE_DAILY.doGbSeconds)}), ` +
        `Worker requests ${pct(freeUnits(day, 'workerRequests') / FREE_DAILY.workerRequests)}, D1 rows written ${pct(freeUnits(day, 'd1RowsWritten') / FREE_DAILY.d1RowsWritten)}; ` +
        `heaviest ${worst.k} ${pct(worst.share)}; Free with the 50% reserve: ${fitsWith(0.5) ? 'fits' : 'no'}, with others under 20%: ${fitsWith(0.2) ? 'fits' : 'no'}, alone: ${fitsWith(0) ? 'fits' : 'no'}; ` +
        `Paid: ${usd(monthlyCost(month, othersMonthly(reserveAll(0), 30)))} alone, ${usd(monthlyCost(month, othersMonthly(reserveAll(0.5), 30)))} with the others at 50%`,
    );
  }

  console.log('Paid mode: solo matches a month (30 days) under each ceiling, the others at 50% of the Free limits:');
  for (const ceiling of [10, 20, 50]) {
    let lo = 0;
    let hi = 10_000_000;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (monthlyCost(scale(solo, mid), othersMonthly(reserveAll(0.5), 30)) <= ceiling) lo = mid;
      else hi = mid - 1;
    }
    console.log(`  ${usd(ceiling)}: ${int(lo)} a month, about ${int(lo / 30)} a day`);
  }
}
