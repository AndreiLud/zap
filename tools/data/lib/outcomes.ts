// The hand outcome model of ai/src/winprob.ts fitted on simulated hands, and the break-even chance
// of figure aceitar-truco (DATA-SPEC 2.1.5 and 4.6, F15).

import { ladderOf, onzeThreshold, type MatchConfig } from '../../../engine/src/config.ts';
import { matchTable, type OutcomeModel } from '../../../ai/src/winprob.ts';

/** Counts of hand outcomes, summed over matches (any order). */
export interface OutcomeCounts {
  /** Normal hands (both teams below the threshold). */
  normalHands: number;
  /** For each points value: normal hands in which one team scored it (each hand counted for the team that scored). */
  scored: Record<string, number>;
  /** Normal hands in which nobody scored. */
  normalTies: number;
  /** Hands of kind onze, from the team on the threshold. */
  onze: { n: number; run: number; win: number; lose: number; tie: number };
  /** Hands of kind iron. */
  iron: { n: number; tie: number };
}

export const emptyOutcomeCounts = (): OutcomeCounts => ({ normalHands: 0, scored: {}, normalTies: 0, onze: { n: 0, run: 0, win: 0, lose: 0, tie: 0 }, iron: { n: 0, tie: 0 } });

export function mergeOutcomeCounts(into: OutcomeCounts, from: OutcomeCounts): void {
  into.normalHands += from.normalHands;
  into.normalTies += from.normalTies;
  for (const [k, v] of Object.entries(from.scored)) into.scored[k] = (into.scored[k] ?? 0) + v;
  for (const k of ['n', 'run', 'win', 'lose', 'tie'] as const) into.onze[k] += from.onze[k];
  into.iron.n += from.iron.n;
  into.iron.tie += from.iron.tie;
}

/**
 * The OutcomeModel of the counts: normal[v] is the share of team observations (two per normal hand)
 * in which the team scored v, so the sum of 2 normal[v] plus normalTie is 1; the onze shares are
 * over hands of kind onze from the team on the threshold; ironTie over hands of kind iron.
 */
export function fitOutcomes(config: MatchConfig, c: OutcomeCounts): OutcomeModel {
  if (c.normalHands === 0) throw new Error('fitOutcomes: no normal hands');
  const ladder = ladderOf(config);
  for (const k of Object.keys(c.scored)) {
    if (!ladder.includes(Number(k))) throw new Error(`fitOutcomes: a normal hand scored ${k}, which is not on the ladder ${ladder.join(', ')}`);
  }
  const normal: Record<number, number> = {};
  for (const v of ladder) normal[v] = (c.scored[String(v)] ?? 0) / (2 * c.normalHands);
  const share = (k: number, n: number) => (n > 0 ? k / n : 0);
  return {
    normal,
    normalTie: c.normalTies / c.normalHands,
    onzeRun: share(c.onze.run, c.onze.n),
    onzeWin: share(c.onze.win, c.onze.n),
    onzeLose: share(c.onze.lose, c.onze.n),
    onzeTie: share(c.onze.tie, c.onze.n),
    ironTie: share(c.iron.tie, c.iron.n),
  };
}

/**
 * breakEven[a][b], for both scores below the threshold: the smallest chance of winning the hand for
 * which accepting a truco loses less match chance than running. With W the chance of winning the
 * match at games 0 to 0 and L0, L1 the first two ladder values:
 *   p*(a, b) = (W(a, b + L0) - W(a, b + L1)) / (W(a + L1, b) - W(a, b + L1)),
 * kept between 0 and 1.
 */
export function breakEvenTable(config: MatchConfig, m: OutcomeModel): number[][] {
  const W = matchTable(config, m);
  const [L0, L1] = ladderOf(config);
  const thr = onzeThreshold(config);
  const out: number[][] = [];
  for (let a = 0; a < thr; a++) {
    const row: number[] = [];
    for (let b = 0; b < thr; b++) {
      const run = W(a, b + L0, 0, 0);
      const lose = W(a, b + L1, 0, 0);
      const win = W(a + L1, b, 0, 0);
      const den = win - lose;
      if (!(den > 0)) throw new Error(`breakEven: accepting changes nothing at ${a} to ${b}`);
      row.push(Math.min(1, Math.max(0, (run - lose) / den)));
    }
    out.push(row);
  }
  return out;
}
