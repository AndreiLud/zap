// Betting styles of the simulated players (training/cycle/sim/run.ts): a few clear ways to play,
// so the cycle's profile, priors and flag tools have patterns to find. Card play follows the base
// heuristic; the style decides bets, answers and covers from the hand strength estimate
// (ai/src/heuristic.ts handEstimate). Every answer is a legal action of the observation.

import { A_ACCEPT, A_COVER0, A_PLAY0, A_RAISE, A_RUN, A_SIGNAL0 } from '../../../engine/src/engine.ts';
import type { Observation } from '../../../engine/src/observe.ts';
import { BASE_PARAMS, handEstimate, heuristicDecision } from '../../../ai/src/heuristic.ts';

export const STYLES = ['cautious', 'bluffer', 'aggressive', 'caller', 'coverer', 'random', 'metronome'] as const;
export type Style = (typeof STYLES)[number];

const has = (mask: number, a: number) => (mask & (1 << a)) !== 0;
const legalList = (mask: number) => [...Array(15).keys()].filter((a) => has(mask, a));

function pick(list: number[], rand: () => number): number {
  return list[Math.floor(rand() * list.length)];
}

/** The base heuristic's move, kept only when legal (it always is); signals are rare. */
function baseMove(obs: Observation, rand: () => number): number {
  const a = heuristicDecision(obs, BASE_PARAMS, rand).action;
  return has(obs.legal, a) ? a : pick(legalList(obs.legal), rand);
}

/** The action a simulated player of this style takes. */
export function styleMove(style: Style, obs: Observation, rand: () => number): number {
  const legal = obs.legal;
  const acts = legalList(legal);
  if (acts.length === 1) return acts[0];
  if (style === 'random') {
    // Mostly cards, like a person clicking around; a signal or a bet now and then.
    const cards = acts.filter((a) => a < A_RAISE);
    return pick(cards.length > 0 && rand() < 0.8 ? cards : acts, rand);
  }
  const est = handEstimate(obs, BASE_PARAMS);
  const answering = obs.phase === 'raise' || obs.phase === 'onze';
  if (answering && has(legal, A_ACCEPT)) {
    const accept: Record<Exclude<Style, 'random'>, boolean> = {
      cautious: est > 0.62,
      bluffer: est > 0.35 || rand() < 0.3,
      aggressive: est > 0.15,
      caller: true,
      coverer: est > 0.45,
      metronome: est > 0.45,
    };
    const reraise = has(legal, A_RAISE) && ((style === 'aggressive' && est > 0.4) || (style === 'bluffer' && rand() < 0.25));
    if (reraise) return A_RAISE;
    if (accept[style] || !has(legal, A_RUN)) return A_ACCEPT;
    return A_RUN;
  }
  if (obs.phase === 'play' && has(legal, A_RAISE) && obs.kind === 'normal') {
    const raise: Record<Exclude<Style, 'random'>, boolean> = {
      cautious: est > 0.82,
      bluffer: est < 1 / 3 ? rand() < 0.6 : est > 0.7,
      aggressive: rand() < 0.55,
      caller: est > 0.9,
      coverer: est > 0.75,
      metronome: est > 0.72,
    };
    if (raise[style]) return A_RAISE;
  }
  if (style === 'coverer') {
    const covers = acts.filter((a) => a >= A_COVER0 && a < A_RAISE);
    if (covers.length > 0 && rand() < 0.7) return pick(covers, rand);
  }
  const a = baseMove(obs, rand);
  // Bets and signals were decided above: the base move only places a card when it can.
  if (a === A_RAISE || a >= A_SIGNAL0) {
    const cards = acts.filter((x) => x >= A_PLAY0 && x < A_RAISE);
    if (cards.length > 0) return pick(cards, rand);
  }
  return a;
}
