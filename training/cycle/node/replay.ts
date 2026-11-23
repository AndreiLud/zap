// Replays a match record with the rules engine and calls back once per logged action, with what
// the acting seat saw just before it. Shared by the decision tables (build.ts) and the human
// layers (training/cycle/node/human/).

import type { MatchConfig } from '../../../engine/src/config.ts';
import { applyAction, newMatch, type MatchState } from '../../../engine/src/engine.ts';
import { observe, type Observation } from '../../../engine/src/observe.ts';

export interface ReplayMove {
  ms: number | null;
  auto: boolean;
  winProb: number | null;
}

export interface ReplayInput {
  config: MatchConfig;
  seed: string;
  log: readonly number[];
  moves: readonly ReplayMove[];
}

export type DecisionFn = (obs: Observation, i: number, seat: number, action: number, move: ReplayMove, hand: number) => void;

/** Calls fn for every action of the log, in order; returns the final state. */
export function forEachDecision(record: ReplayInput, fn: DecisionFn): MatchState {
  const s = newMatch(record.config, record.seed);
  for (let i = 0; i < record.log.length; i++) {
    const packed = record.log[i];
    const seat = packed >> 4;
    const action = packed & 15;
    const obs = observe(s, seat);
    fn(obs, i, seat, action, record.moves[i], s.handIndex);
    applyAction(s, seat, action);
  }
  return s;
}
