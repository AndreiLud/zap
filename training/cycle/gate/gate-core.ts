// Pure parts of the promotion gate (contract 3.8): the sequential test in rounds, the
// non-inferiority test per segment, the panel test, the decision and its reasons. gate.ts plays
// the pairs; everything here works on score arrays, so the tests can feed known cases.

import { summarize, pooledPairedSummary } from '../../../ai/src/evaluate.ts';
import { sprt } from '../../../ai/src/stats.ts';
import { SEGMENTS, type Segment } from '../../../ai/src/opponent-stats.ts';

export { SEGMENTS, type Segment };

export const Z_ONE_SIDED_95 = 1.645;

export interface SprtSpec {
  p0: number;
  p1: number;
  alpha: number;
  beta: number;
  batchPairs: number;
  capPairs: number;
}

export interface SprtOutcome {
  decision: 'accept' | 'reject' | 'inconclusive';
  llr: number;
  lower: number;
  upper: number;
  pairs: number;
  mean: number;
  perSegment: Record<Segment, { pairs: number; mean: number }>;
}

/** Pairs per segment in one round, and the number of rounds the cap allows. */
export function sprtPlan(s: SprtSpec): { perSegment: number; rounds: number } {
  const perSegment = Math.max(1, Math.floor(s.batchPairs / SEGMENTS.length));
  const rounds = Math.max(1, Math.floor(s.capPairs / (perSegment * SEGMENTS.length)));
  return { perSegment, rounds };
}

/** Scores of one round: `perSegment` new pairs in each segment, from pair offset round * perSegment. */
export type RoundRunner = (round: number, offset: number, perSegment: number) => Promise<Record<Segment, number[]>>;

/**
 * Sequential test of the candidate against the current version: rounds of new duplicate pairs in
 * each segment, the four segments pooled, the SPRT of ai/src/stats.ts after each round; stop on
 * accept or reject, inconclusive at the cap.
 */
export async function runSprt(s: SprtSpec, runRound: RoundRunner): Promise<SprtOutcome> {
  const { perSegment, rounds } = sprtPlan(s);
  const pooled: number[] = [];
  const bySeg = Object.fromEntries(SEGMENTS.map((g) => [g, [] as number[]])) as Record<Segment, number[]>;
  let res = sprt([], s.p0, s.p1, s.alpha, s.beta);
  for (let r = 0; r < rounds; r++) {
    const scores = await runRound(r, r * perSegment, perSegment);
    for (const g of SEGMENTS) {
      bySeg[g].push(...scores[g]);
      pooled.push(...scores[g]);
    }
    res = sprt(pooled, s.p0, s.p1, s.alpha, s.beta);
    if (res.decision !== 'continue') break;
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0.5);
  return {
    decision: res.decision === 'continue' ? 'inconclusive' : res.decision,
    llr: res.llr,
    lower: res.lower,
    upper: res.upper,
    pairs: pooled.length,
    mean: mean(pooled),
    perSegment: Object.fromEntries(SEGMENTS.map((g) => [g, { pairs: bySeg[g].length, mean: mean(bySeg[g]) }])) as SprtOutcome['perSegment'],
  };
}

export interface SegmentEntry {
  pairs: number;
  mean: number;
  lo95: number;
  pass: boolean;
}

/** Non-inferiority in one segment: lo95 = mean - 0.5 - 1.645 se; pass when lo95 > -margin. */
export function segmentTest(scores: readonly number[], margin: number): SegmentEntry {
  if (!scores.length) return { pairs: 0, mean: 0.5, lo95: -1, pass: false };
  const s = summarize(scores);
  const lo95 = s.mean - 0.5 - Z_ONE_SIDED_95 * s.se;
  return { pairs: scores.length, mean: s.mean, lo95, pass: lo95 > -margin };
}

export interface PanelEntry {
  member: string;
  pairs: number;
  candidate: { mean: number; lo: number; hi: number };
  current: { mean: number; lo: number; hi: number };
  diff: { mean: number; lo95: number };
  pass: boolean;
}

function interval(scores: number[]): { mean: number; lo: number; hi: number } {
  const s = summarize(scores);
  return { mean: s.mean, lo: s.ci95[0], hi: s.ci95[1] };
}

/**
 * One panel member, played by the candidate and by the current version on the same deals in each
 * segment: the paired difference pooled over the segments (pooledPairedSummary of
 * ai/src/evaluate.ts), lo95 = mean - 1.645 se; pass when lo95 > -margin.
 */
export function panelTest(member: string, candidate: Record<Segment, number[]>, current: Record<Segment, number[]>, margin: number): PanelEntry {
  const groups = SEGMENTS.map((g) => ({ a: candidate[g], b: current[g] }));
  const d = pooledPairedSummary(groups);
  const lo95 = d.mean - Z_ONE_SIDED_95 * d.se;
  const all = (r: Record<Segment, number[]>) => SEGMENTS.flatMap((g) => r[g]);
  return { member, pairs: d.pairs, candidate: interval(all(candidate)), current: interval(all(current)), diff: { mean: d.mean, lo95 }, pass: lo95 > -margin };
}

const pts = (x: number) => `${(100 * x).toFixed(1)} points`;

/** The gate's decision: every rule must pass. One plain sentence per failed rule. */
export function decide(s: SprtOutcome, segments: Record<Segment, SegmentEntry>, panel: PanelEntry[], orderHolds: boolean, sprtSpec: SprtSpec, segmentMargin: number, panelMargin: number): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (s.decision === 'reject') reasons.push(`The sequential test stopped for no gain after ${s.pairs} pairs (mean ${s.mean.toFixed(3)}; the gain it looks for is ${pts(sprtSpec.p1 - sprtSpec.p0)}).`);
  if (s.decision === 'inconclusive') reasons.push(`The sequential test reached its cap of ${s.pairs} pairs without a decision (mean ${s.mean.toFixed(3)}).`);
  for (const g of SEGMENTS) {
    const e = segments[g];
    if (!e.pass) reasons.push(`In ${g} the candidate may be more than ${pts(segmentMargin)} worse than the current version (lower bound ${pts(e.lo95)}).`);
  }
  for (const p of panel) {
    if (!p.pass) reasons.push(`Against ${p.member} the candidate may score more than ${pts(panelMargin)} below the current version (lower bound ${pts(p.diff.lo95)}).`);
  }
  if (!orderHolds) reasons.push('The difficulty order of the characters does not hold (Otávio must be the easiest and Iara the hardest after Zap).');
  return { pass: s.decision === 'accept' && reasons.length === 0, reasons };
}

/** orderHolds from the file written by ai/bench/calibrate-personas.ts --out. */
export function orderFromCalibration(json: unknown): boolean {
  const o = (json as { order?: { otavioEasiest?: unknown; iaraHardestAfterZap?: unknown } } | null)?.order;
  return o?.otavioEasiest === true && o?.iaraHardestAfterZap === true;
}
