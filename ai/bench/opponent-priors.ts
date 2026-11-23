// Measures the population priors of the opponent statistics (features v2), how long matches
// are, and how much evidence about the opponent a decision has.
//
// v1 Zap with its shipped knobs plays against the milestone 6 training league (ai/src/league.ts;
// 'current' and 'snapshots' are v1 Zap too, since no adaptive network exists yet), random room
// options in 25% of the matches. The public statistics of every seat of every match are pooled
// per segment:
//   raise = sum K / sum H, run = sum U / sum T, accept = sum A / sum T, reraise = sum X / sum T,
//   shown = sum S / sum Q, cover = sum V / sum W   (definitions in ai/src/opponent-stats.ts)
// The evidence n at the bet decisions of the v1 Zap seats gives nW, the median of n among bet
// decisions with n > 0, used by the training regularizer.
//
// Writes ai.adaptation.design, matchLength, evidence and priors in facts.json with --write-facts.
//
// Usage: node ai/bench/opponent-priors.ts [--matches 4000] [--seed 0b] [--threads 4]
//          [--out ai/models/opponent-priors.json] [--eval-out training/runs/m6-init/eval/priors.json] [--write-facts]

import { writeFileSync } from 'node:fs';
import { M6_MIX } from '../src/league.ts';
import { NUM_FEATURES_V2 } from '../src/features.ts';
import { PRIOR_KEYS, STATS_SIZE, validatePriors, type SeatCounts, type SegmentPriors } from '../src/opponent-stats.ts';
import { PRIORS_FILE, SEGMENTS, V1_MODEL, arg, flag, machine, numArg, quantile, saveResult, seedArg, sha256File, type Segment } from './bench-util.ts';
import { chunks, runTasks, type PriorsResult, type PriorsTask } from './parallel.ts';

const matches = numArg('matches', 4000);
const seedHex = arg('seed', '0b')!;
const seed = seedArg('seed', '0b');
const threads = numArg('threads', 4);
const out = arg('out', PRIORS_FILE)!;
const evalOut = arg('eval-out', 'training/runs/m6-init/eval/priors.json')!;
const ALPHA = 2;
const t0 = performance.now();

const tasks: PriorsTask[] = [];
for (const segment of SEGMENTS) {
  for (const c of chunks(0, matches, 50)) tasks.push({ type: 'priors', segment, baseSeed: seed, offset: c.offset, matches: c.count, randomOptions: 0.25, twoStyles: 0.5, partnerSwap: 0.2 });
}
const results = await runTasks(tasks, threads, (d, n) => {
  if (d % 20 === 0 || d === n) process.stderr.write(`priors: ${d}/${n} chunks\n`);
});

interface Pooled {
  counts: SeatCounts;
  hands: number[];
  evidence: number[];
  byHand: Record<string, number[]>;
  bets: number;
  labels: Record<string, number>;
}
const pooled = {} as Record<Segment, Pooled>;
tasks.forEach((t, i) => {
  const r: PriorsResult = results[i];
  const p = (pooled[t.segment] ??= { counts: { H: 0, K: 0, U: 0, A: 0, X: 0, S: 0, Q: 0, V: 0, W: 0 }, hands: [], evidence: [], byHand: {}, bets: 0, labels: {} });
  for (const k of Object.keys(p.counts) as (keyof SeatCounts)[]) p.counts[k] += r.counts[k];
  p.hands.push(...r.handsPerMatch);
  r.evidence.forEach((c, n) => (p.evidence[n] = (p.evidence[n] ?? 0) + c));
  for (const [h, row] of Object.entries(r.evidenceByHand)) {
    const dst = (p.byHand[h] ??= []);
    row.forEach((c, n) => (dst[n] = (dst[n] ?? 0) + c));
  }
  p.bets += r.betDecisions;
  for (const [l, c] of Object.entries(r.labels)) p.labels[l] = (p.labels[l] ?? 0) + c;
});

const segments = {} as Record<Segment, SegmentPriors & { observations: { H: number; T: number; Q: number; W: number } }>;
const matchLength = {} as Record<Segment, { mean: number; p10: number; p50: number; p90: number; matches: number }>;
const evidence = {} as Record<Segment, { betDecisions: number; share: number[]; atMost2: number; atMost4: number; medianPositive: number; medianByHand: Record<string, number> }>;

/** Median of a histogram (index = value) restricted to values >= from. */
function histMedian(h: number[], from = 0): number {
  const total = h.reduce((a, c, n) => a + (n >= from ? (c ?? 0) : 0), 0);
  let acc = 0;
  for (let n = from; n < h.length; n++) {
    acc += h[n] ?? 0;
    if (acc >= total / 2) return n;
  }
  return NaN;
}

const allEvidence: number[] = [];
for (const seg of SEGMENTS) {
  const p = pooled[seg];
  const c = p.counts;
  const T = c.U + c.A + c.X;
  segments[seg] = { raise: c.K / c.H, run: c.U / T, accept: c.A / T, reraise: c.X / T, shown: c.S / c.Q, cover: c.V / c.W, observations: { H: c.H, T, Q: c.Q, W: c.W } };
  const hs = p.hands;
  matchLength[seg] = { mean: hs.reduce((a, b) => a + b, 0) / hs.length, p10: quantile(hs, 0.1), p50: quantile(hs, 0.5), p90: quantile(hs, 0.9), matches: hs.length };
  const total = p.evidence.reduce((a, b) => a + (b ?? 0), 0);
  const share = Array.from({ length: 13 }, (_, n) => (n < 12 ? (p.evidence[n] ?? 0) / total : p.evidence.slice(12).reduce((a, b) => a + (b ?? 0), 0) / total));
  const cum = (k: number) => p.evidence.slice(0, k + 1).reduce((a, b) => a + (b ?? 0), 0) / total;
  evidence[seg] = {
    betDecisions: p.bets,
    share,
    atMost2: cum(2),
    atMost4: cum(4),
    medianPositive: histMedian(p.evidence, 1),
    medianByHand: Object.fromEntries(Object.entries(p.byHand).map(([h, row]) => [h, histMedian(row)])),
  };
  p.evidence.forEach((cnt, n) => (allEvidence[n] = (allEvidence[n] ?? 0) + (cnt ?? 0)));
}
for (let n = 0; n < allEvidence.length; n++) allEvidence[n] ??= 0;
const nW = histMedian(allEvidence, 1);
const allTotal = allEvidence.reduce((a, b) => a + b, 0);

const measuredAt = new Date().toISOString();
const method = `v1 Zap (${V1_MODEL}, shipped knobs) as the learning team against the milestone 6 league mix (current and snapshots replaced by v1 Zap; 2 against 2: second opponent the same player with chance 0.5, partner swap 0.2), random room options in 25% of the matches, ${matches} matches per segment, seed ${seedHex}. Counts of every seat of every match pooled per segment; only finished hands count.`;
const priorsFile = {
  version: 1,
  alpha: ALPHA,
  measuredAt,
  method,
  source: { model: V1_MODEL, sha256: sha256File(V1_MODEL), mix: 'M6 league (ai/src/league.ts M6_MIX), current and snapshots as v1 Zap' },
  seed: seedHex,
  matchesPerSegment: matches,
  segments,
};
validatePriors(priorsFile);
writeFileSync(out, JSON.stringify(priorsFile, null, 2) + '\n');
const priorsSha = sha256File(out);

const facts = {
  design: {
    measuredAt,
    method: 'Design constants of features v2 (ai/src/features.ts, ai/src/opponent-stats.ts).',
    featuresVersion: 'v2',
    inputs: NUM_FEATURES_V2,
    statsPerSeat: STATS_SIZE / 3,
    statsSlots: ['next seat', 'partner', 'previous seat'],
    rates: [...PRIOR_KEYS],
    counts: ['H normal hands', 'T answers to raises', 'Q cards shown in hands with a raise', 'W plays where covering was allowed'],
    countingRule: 'finished hands of the current match only, plain counts without decay; mão de onze decisions are not counted',
    alpha: ALPHA,
    countEncoding: 'min(1, ln(1 + n) / ln(33))',
  },
  matchLength: { measuredAt, method, segments: matchLength },
  evidence: {
    measuredAt,
    method: `${method} n = evidence behind a bet decision of v1 Zap: hands in which the raiser (when answering a raise) or the least known opponent asked for truco, plus the raises they answered.`,
    segments: evidence,
    pooled: { betDecisions: allTotal, share: Array.from({ length: 13 }, (_, n) => (n < 12 ? allEvidence[n] ?? 0 : allEvidence.slice(12).reduce((a, b) => a + b, 0)) / allTotal), medianPositive: nW },
    nW,
  },
  priors: { measuredAt, method, file: out, sha256: priorsSha, matchesPerSegment: matches, alpha: ALPHA, segments },
};

const report = { facts, labels: Object.fromEntries(SEGMENTS.map((s) => [s, pooled[s].labels])), seconds: (performance.now() - t0) / 1000, ...machine() };
saveResult(evalOut, report, flag('write-facts'));
console.log(JSON.stringify({ out, sha256: priorsSha, nW, matchLength, seconds: report.seconds }, null, 2));
