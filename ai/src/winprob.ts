// Chance of winning the match from a score, by dynamic programming over hand outcomes.
// Used as the potential for training rewards (each hand is rewarded with the change in this
// chance) and on the data page ("when does accepting a truco pay off").

import type { MatchConfig } from '../../engine/src/config.ts';
import { TARGET_POINTS, onzeThreshold } from '../../engine/src/config.ts';

/**
 * Distribution of hand outcomes, from the point of view of a team that is not on a threshold.
 * normal[p] = chance that a given team scores p points in a normal hand (both teams below the
 * threshold), so sum over p of 2 * normal[p] + normalTie = 1.
 */
export interface OutcomeModel {
  normal: Record<number, number>;
  normalTie: number;
  /** Mão de onze / de dez, for the team on the threshold: run, win, lose, tie. */
  onzeRun: number;
  onzeWin: number;
  onzeLose: number;
  onzeTie: number;
  /** Both on the threshold. */
  ironTie: number;
}

export function defaultOutcomes(c: MatchConfig): OutcomeModel {
  const paulista = c.variant === 'paulista';
  const v = paulista ? [1, 3, 6, 9, 12] : c.options.ladder === 'mineiro8' ? [2, 4, 8, 10, 12] : [2, 4, 6, 10, 12];
  return {
    normal: { [v[0]]: 0.3, [v[1]]: 0.13, [v[2]]: 0.04, [v[3]]: 0.015, [v[4]]: 0.005 },
    normalTie: 0.02,
    onzeRun: 0.3,
    onzeWin: 0.4,
    onzeLose: 0.29,
    onzeTie: 0.01,
    ironTie: 0.01,
  };
}

/** game[a][b]: chance that the team with a points wins the current game against b points. */
export function gameTable(c: MatchConfig, m: OutcomeModel): number[][] {
  const T = TARGET_POINTS;
  const thr = onzeThreshold(c);
  const runPts = c.variant === 'paulista' ? 1 : 2;
  const onzePts = c.variant === 'paulista' ? 3 : 4;
  const g: number[][] = Array.from({ length: T }, () => new Array<number>(T).fill(0.5));
  const at = (a: number, b: number) => (a >= T ? 1 : b >= T ? 0 : g[a][b]);
  const tieToOpp = c.options.onzeTieToOpponents;
  const tieToMao = c.options.allTieToMao;
  // Higher totals first: every scoring outcome moves to a larger total.
  for (let total = 2 * (T - 1); total >= 0; total--) {
    for (let a = Math.min(T - 1, total); a >= 0 && total - a < T; a--) {
      const b = total - a;
      if (b < 0 || b >= T) continue;
      const aOn = a >= thr;
      const bOn = b >= thr;
      if (aOn && bOn) {
        // Iron hand (or a normal one with ironHand 'normal'): the winner takes the game in effect.
        g[a][b] = 0.5;
        continue;
      }
      if (aOn || bOn) {
        // Team on the threshold is "x" with x points; the other has y.
        const [x, y] = aOn ? [a, b] : [b, a];
        const lose = m.onzeLose + (tieToOpp ? m.onzeTie : 0);
        const tie = tieToOpp || tieToMao ? 0 : m.onzeTie;
        const win = m.onzeWin + (!tieToOpp && tieToMao ? m.onzeTie / 2 : 0);
        const lose2 = lose + (!tieToOpp && tieToMao ? m.onzeTie / 2 : 0);
        const px = (m.onzeRun * atX(x, y + runPts) + win * atX(x + onzePts, y) + lose2 * atX(x, y + onzePts)) / (1 - tie);
        g[a][b] = aOn ? px : 1 - px;
        continue;
      }
      let acc = 0;
      let mass = 0;
      for (const [k, p] of Object.entries(m.normal)) {
        const pts = Number(k);
        acc += p * at(a + pts, b) + p * at(a, b + pts);
        mass += 2 * p;
      }
      if (tieToMao) {
        // The "mao" alternates, so a tied hand goes to either team half of the time.
        const base = Math.min(...Object.keys(m.normal).map(Number));
        acc += (m.normalTie / 2) * (at(a + base, b) + at(a, b + base));
        mass += m.normalTie;
      }
      // A tied hand that nobody scores is replayed from the same score.
      g[a][b] = acc / mass;
    }
  }
  return g;

  function atX(x: number, y: number): number {
    // Chance for the team on the threshold, which has x points against y.
    if (x >= T) return 1;
    if (y >= T) return 0;
    return g[x][y];
  }
}

/** Chance of winning the match, for best of one or best of three. */
export function matchTable(c: MatchConfig, m: OutcomeModel = defaultOutcomes(c)): (a: number, b: number, ga: number, gb: number) => number {
  const g = gameTable(c, m);
  const G = (a: number, b: number) => (a >= TARGET_POINTS ? 1 : b >= TARGET_POINTS ? 0 : g[a][b]);
  if (c.options.bestOf === 1) return (a, b) => G(a, b);
  const start = G(0, 0);
  const M = (ga: number, gb: number): number => {
    if (ga >= 2) return 1;
    if (gb >= 2) return 0;
    return start * M(ga + 1, gb) + (1 - start) * M(ga, gb + 1);
  };
  return (a, b, ga, gb) => G(a, b) * M(ga + 1, gb) + (1 - G(a, b)) * M(ga, gb + 1);
}
