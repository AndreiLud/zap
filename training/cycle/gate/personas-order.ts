// The characters' difficulty order of a candidate, measured again on fresh deals (gate rule 4).
//
// ai/bench/calibrate-personas.ts raises Otávio's temperature until he is the easiest on its own
// fixed deals (seed c3), so the order it reports holds by construction. This tool measures the six
// characters again with the calibrated knobs, on deals drawn from the cycle seed, each as a team
// against a team of Zap on the same model (measureStyle of ai/bench/persona-stats.ts, duplicate
// pairs over the four segments). The order fails only when it is reversed beyond noise:
//
//   Otávio: otavio.vsZap - min(bento, lia, ravi).vsZap > 1.645 se
//   Iara:   max(bento, lia, ravi).vsZap - iara.vsZap > 1.645 se
//
// with se = sqrt(se_a^2 + se_b^2) of the two scores compared (the shared deals correlate them, which
// this ignores, so se is on the large side). The file keeps the order fields gate-core reads
// (order.otavioEasiest, order.iaraHardestAfterZap), now meaning "not reversed beyond noise", and
// the margins, which the gate copies into its result and so into the model card.
//
// Usage: node training/cycle/gate/personas-order.ts --model FILE --calibration FILE --pairs N
//          --seed HEX --out FILE [--threads T] [--stats live|empty]
// --stats: how the characters play, as the gate's spec.stats (empty while AI_ADAPT is off). The
// numbers do not depend on --threads (ai/bench/persona-measure.ts).

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseModel } from '../../../ai/src/mlp.ts';
import type { Knobs } from '../../../ai/src/net-agent.ts';
import type { PersonaId } from '../../../ai/src/personas.ts';
import { measureStyles } from '../../../ai/bench/persona-measure.ts';

export const IDS: PersonaId[] = ['otavio', 'bento', 'lia', 'ravi', 'iara', 'zap'];
/** One-sided 95%: the order fails only when it is reversed by more than this many standard errors. */
export const Z = 1.645;

export interface Score {
  mean: number;
  se: number;
}

export interface Margin {
  /** How far the order is reversed (positive: reversed), in score points from 0 to 1. */
  diff: number;
  se: number;
  /** 95% interval of diff: diff ± 1.96 se. */
  ci95: [number, number];
  /** The order holds while diff <= Z se. */
  holds: boolean;
  against: PersonaId;
}

/** The two margins of the rule from the six scores against Zap. */
export function orderMargins(v: Record<string, Score>): { otavio: Margin; iara: Margin } {
  const mid: PersonaId[] = ['bento', 'lia', 'ravi'];
  const easiest = mid.reduce((a, b) => (v[b].mean < v[a].mean ? b : a));
  const hardest = mid.reduce((a, b) => (v[b].mean > v[a].mean ? b : a));
  const margin = (diff: number, a: Score, b: Score, against: PersonaId): Margin => {
    const se = Math.sqrt(a.se ** 2 + b.se ** 2);
    return { diff, se, ci95: [diff - 1.96 * se, diff + 1.96 * se], holds: diff <= Z * se, against };
  };
  return {
    otavio: margin(v.otavio.mean - v[easiest].mean, v.otavio, v[easiest], easiest),
    iara: margin(v[hardest].mean - v.iara.mean, v.iara, v[hardest], hardest),
  };
}

/** One line for the gate result and the card: the two margins in points, with their 95% intervals. */
export function describeMargins(m: { otavio: Margin; iara: Margin }, pairs: number): string {
  const pts = (x: number) => (100 * x).toFixed(1);
  const ci = (g: Margin) => `se ${pts(g.se)}, 95% from ${pts(g.ci95[0])} to ${pts(g.ci95[1])}`;
  return (
    `Otávio minus the easiest of Bento, Lia and Ravi (${m.otavio.against}): ${pts(m.otavio.diff)} points (${ci(m.otavio)}); ` +
    `the hardest of them (${m.iara.against}) minus Iara: ${pts(m.iara.diff)} points (${ci(m.iara)}); ` +
    `reversed beyond noise above ${Z} se; ${pairs} fresh pairs per segment.`
  );
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const modelFile = arg('model');
  const calFile = arg('calibration');
  const out = arg('out');
  const pairs = Number(arg('pairs') ?? 200);
  const seed = (arg('seed') ?? '').padEnd(64, '0').slice(0, 64);
  if (!modelFile || !calFile || !out || !/^[0-9a-f]{64}$/.test(seed) || !(pairs > 0)) {
    console.error('usage: personas-order.ts --model FILE --calibration FILE --pairs N --seed HEX --out FILE');
    process.exit(1);
  }
  const t0 = performance.now();
  parseModel(readFileSync(modelFile));
  const knobs = (JSON.parse(readFileSync(calFile, 'utf8')) as { knobs: Record<PersonaId, Knobs> }).knobs;
  const threads = Math.max(1, Number(arg('threads') ?? 1));
  const statsMode = arg('stats') === 'empty' ? 'empty' : 'live';
  const measured = await measureStyles(modelFile, IDS.map((id) => ({ key: id, knobs: knobs[id], pairs })), { threads, stats: statsMode, seed });
  const vsZap: Record<string, Score> = {};
  const stats: Record<string, unknown> = {};
  for (const id of IDS) {
    const m = measured[id];
    vsZap[id] = { mean: m.vsZap, se: m.vsZapSe };
    stats[id] = { ...m, logs: undefined, hands: m.logs.length, vsZapCi95: [m.vsZap - 1.96 * m.vsZapSe, m.vsZap + 1.96 * m.vsZapSe] };
  }
  const margins = orderMargins(vsZap);
  const report = {
    model: modelFile,
    calibration: calFile,
    seed,
    pairsPerSegment: pairs,
    statsMode,
    seconds: Math.round((performance.now() - t0) / 100) / 10,
    rule: 'the order fails only when it is reversed beyond noise (more than 1.645 standard errors of the difference)',
    order: { otavioEasiest: margins.otavio.holds, iaraHardestAfterZap: margins.iara.holds },
    margins,
    summary: describeMargins(margins, pairs),
    vsZap,
    stats,
  };
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ order: report.order, summary: report.summary, seconds: report.seconds }));
}
