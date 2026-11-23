// Duplicate-format evaluation: every deal is played twice with the teams swapped, so the luck
// of the cards cancels out and what remains is the difference in play.

import type { MatchConfig } from '../../engine/src/config.ts';
import { applyAction, expectedActor, newMatch, type MatchState } from '../../engine/src/engine.ts';
import { observe } from '../../engine/src/observe.ts';
import { deriveSeed, mulberry32 } from '../../engine/src/rng.ts';
import { agentContext, type Agent } from './agent.ts';

/** Builds the agent for a seat. Team agents are created per match so they may keep state. */
export type AgentFactory = (seat: number) => Agent;

export interface MatchRecord {
  winner: number;
  hands: number;
  state?: MatchState;
}

/** Plays one match; agents[seat] decides for each seat. Returns the winning team. */
export function playAgents(config: MatchConfig, seed: string, agents: Agent[], policySeed: number, keepState = false): MatchRecord {
  const s = newMatch(config, seed);
  const rand = mulberry32(policySeed);
  let guard = 0;
  while (!s.over) {
    const seat = expectedActor(s);
    const obs = observe(s, seat);
    const d = agents[seat].act(obs, rand, agentContext(s));
    applyAction(s, seat, d.action);
    if (++guard > 100_000) throw new Error('match did not end');
  }
  return { winner: s.winner, hands: s.history.length, state: keepState ? s : undefined };
}

export interface DuplicateResult {
  pairs: number;
  /** Mean score of team A per match: 1 for a win, 0 for a loss. */
  mean: number;
  /** Standard error over pairs. */
  se: number;
  ci95: [number, number];
  /** Pairs where A won both, split, lost both. */
  both: number;
  split: number;
  none: number;
}

export function summarize(pairScores: readonly number[]): DuplicateResult {
  const n = pairScores.length;
  const mean = pairScores.reduce((a, b) => a + b, 0) / n;
  const variance = pairScores.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);
  const se = Math.sqrt(variance / n);
  return {
    pairs: n,
    mean,
    se,
    ci95: [mean - 1.96 * se, mean + 1.96 * se],
    both: pairScores.filter((x) => x === 1).length,
    split: pairScores.filter((x) => x === 0.5).length,
    none: pairScores.filter((x) => x === 0).length,
  };
}

/**
 * Scores of team A in `pairs` duplicate pairs, from pair index `offset` on. In the first match
 * of a pair, team A sits on the even seats; in the second, on the odd seats, with the same seed
 * and so the same cards per seat. Pair i always uses the same deal and the same policy seeds, so
 * two players measured with the same base seed meet the same deals, pair by pair. onMatch, when
 * given, sees each finished match and the seat parity of team A in it (it changes no result).
 */
export function pairScores(config: MatchConfig, baseSeed: string, pairs: number, teamA: AgentFactory, teamB: AgentFactory, offset = 0, onMatch?: (state: MatchState, teamA: number) => void): number[] {
  const n = config.players;
  const keep = onMatch !== undefined;
  const scores: number[] = [];
  for (let i = offset; i < offset + pairs; i++) {
    const seed = deriveSeed(baseSeed, 0x64757031, i);
    const m1 = playAgents(config, seed, Array.from({ length: n }, (_, s) => ((s & 1) === 0 ? teamA(s) : teamB(s))), 2 * i, keep);
    if (onMatch) onMatch(m1.state!, 0);
    const m2 = playAgents(config, seed, Array.from({ length: n }, (_, s) => ((s & 1) === 1 ? teamA(s) : teamB(s))), 2 * i + 1, keep);
    if (onMatch) onMatch(m2.state!, 1);
    scores.push(((m1.winner === 0 ? 1 : 0) + (m2.winner === 1 ? 1 : 0)) / 2);
  }
  return scores;
}

/** Plays `pairs` duplicate pairs (see pairScores) and summarizes them. */
export function duplicateSeries(config: MatchConfig, baseSeed: string, pairs: number, teamA: AgentFactory, teamB: AgentFactory, offset = 0): DuplicateResult {
  return summarize(pairScores(config, baseSeed, pairs, teamA, teamB, offset));
}

export interface PairedSummary {
  pairs: number;
  /** Mean of a[i] - b[i]. */
  mean: number;
  se: number;
  ci95: [number, number];
  /** One-sided 95% upper bound: mean + 1.645 se. */
  upper95: number;
}

/** Paired difference of two series measured on the same pairs (same base seed and offsets). */
export function pairedSummary(a: readonly number[], b: readonly number[]): PairedSummary {
  if (a.length !== b.length) throw new Error('paired series differ in length');
  const n = a.length;
  if (n === 0) return { pairs: 0, mean: NaN, se: NaN, ci95: [NaN, NaN], upper95: NaN };
  let mean = 0;
  for (let i = 0; i < n; i++) mean += a[i] - b[i];
  mean /= n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (a[i] - b[i] - mean) ** 2;
  const se = Math.sqrt(v / Math.max(1, n - 1) / n);
  return { pairs: n, mean, se, ci95: [mean - 1.96 * se, mean + 1.96 * se], upper95: mean + 1.645 * se };
}

/** A paired difference pooled over several opponents (see pooledPairedSummary). */
export interface PooledSummary extends PairedSummary {
  /** Deal indices: pairs per opponent. The standard error is computed over these clusters. */
  clusters: number;
  /** Standard error if every pair were independent, for comparison. */
  naiveSe: number;
}

/**
 * Paired difference a - b pooled over several opponents that were all measured on the same deals
 * (same base seed and offsets, so pair i of every opponent shares its deal and policy seeds). The
 * pairs of different opponents at the same index are correlated, so each index is one cluster:
 * the mean of a - b over the opponents at that index. The pooled mean is the mean of the cluster
 * means (every opponent has the same weight) and the standard error is computed over the
 * clusters. `pairs` is the number of pairs in all.
 */
export function pooledPairedSummary(groups: readonly { a: readonly number[]; b: readonly number[] }[]): PooledSummary {
  if (!groups.length) throw new Error('no groups to pool');
  const m = groups[0].a.length;
  for (const g of groups) if (g.a.length !== m || g.b.length !== m) throw new Error('pooled groups must have the same pairs');
  const cluster = new Array<number>(m).fill(0);
  const allA: number[] = [];
  const allB: number[] = [];
  for (const g of groups) {
    for (let i = 0; i < m; i++) cluster[i] += (g.a[i] - g.b[i]) / groups.length;
    allA.push(...g.a);
    allB.push(...g.b);
  }
  const c = pairedSummary(cluster, new Array<number>(m).fill(0));
  return { ...c, pairs: m * groups.length, clusters: m, naiveSe: pairedSummary(allA, allB).se };
}
