// Helpers to play whole matches with simple policies: used by tests, benchmarks and analysis.

import type { MatchConfig } from './config.ts';
import { applyAction, expectedActor, legalMask, newMatch, type MatchInit, type MatchState } from './engine.ts';
import { deriveSeed, mulberry32 } from './rng.ts';

export type Policy = (s: MatchState, seat: number, mask: number) => number;

/** Picks a uniformly random legal action. */
export function randomPolicy(rand: () => number): Policy {
  return (_s, _seat, mask) => {
    let count = 0;
    for (let m = mask; m; m &= m - 1) count++;
    let k = Math.floor(rand() * count);
    for (let a = 0; a < 15; a++) {
      if (mask & (1 << a)) {
        if (k === 0) return a;
        k--;
      }
    }
    throw new Error('empty mask');
  };
}

/** Plays a match to the end, always letting the expected actor move. */
export function playMatch(config: MatchConfig, seed: string, policies: Policy[], init: MatchInit = {}, maxActions = 100_000): MatchState {
  const s = newMatch(config, seed, init);
  let guard = 0;
  while (!s.over) {
    const seat = expectedActor(s);
    const mask = legalMask(s, seat);
    applyAction(s, seat, policies[seat](s, seat, mask));
    if (++guard > maxActions) throw new Error('match did not end');
  }
  return s;
}

/** Seed for match i of a numbered series, derived from a base seed. */
export function seriesSeed(base: string, i: number): string {
  return deriveSeed(base, 0x73657273, i);
}

export function randomPolicies(n: number, seed: number): Policy[] {
  const rand = mulberry32(seed);
  return Array.from({ length: n }, () => randomPolicy(rand));
}
