// Common interface of every player the server can seat: baselines, heuristics and the network.
// Agents only ever receive an Observation, the same view a person has, plus the public history of
// the match so far (what everyone at the table saw), so they cannot cheat.

import type { MatchState } from '../../engine/src/engine.ts';
import type { Observation } from '../../engine/src/observe.ts';
import { publicHistory, type PublicHistory } from '../../engine/src/public.ts';
import type { SegmentPriors } from './opponent-stats.ts';

export interface Decision {
  /** Engine action (by hand slot). */
  action: number;
  /** Estimated chance that this seat's team wins the match, when the agent has one. */
  winProb?: number;
}

/** What an agent may know beyond its own Observation: public facts only. */
export interface AgentContext {
  /** Public facts of the match so far (engine/src/public.ts). The same for every seat. */
  history: PublicHistory;
  /** Bit mask of seats whose statistics must read as "no evidence" (the person switched on "Don't adapt to me"). */
  noStats?: number;
  /**
   * Off: per absolute seat, a prior that replaces the population prior of that seat's in-match
   * statistics (a person's profile, for the match's segment); see encodeStats. No harness sets it:
   * agentContext never does, so the room, self-play and the benches all read the population prior.
   */
  seatPriors?: readonly (SegmentPriors | null)[];
}

export interface Agent {
  readonly name: string;
  act(obs: Observation, rand: () => number, ctx?: AgentContext): Decision;
}

/** Built by the harness (room, self-play, evaluation), never by an agent. */
export function agentContext(s: MatchState, noStats = 0): AgentContext {
  return { history: publicHistory(s), noStats };
}

export function pickUniform(mask: number, rand: () => number): number {
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
}

export class RandomAgent implements Agent {
  readonly name = 'random';
  act(obs: Observation, rand: () => number, _ctx?: AgentContext): Decision {
    return { action: pickUniform(obs.legal, rand) };
  }
}
