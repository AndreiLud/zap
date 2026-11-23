// Rule-based players used as baselines and as the fallback when no model is available.
//
// The hand estimate is a logistic score of the remaining cards (each card's chance of beating a
// random unseen card), the rounds already won or lost, the round on the table and the partner's
// signal. Bets compare that estimate with thresholds. Card play wins rounds as cheaply as
// possible. All numbers live in HeuristicParams, so the tuned heuristic is the same code with
// parameters found by search (ai/bench/tune-heuristic.ts).

import { DECK_SIZE, strengthTable } from '../../engine/src/cards.ts';
import { A_ACCEPT, A_COVER0, A_PLAY0, A_RAISE, A_RUN, A_SIGNAL0, SIGNAL_MASK } from '../../engine/src/engine.ts';
import { HIDDEN, type Observation } from '../../engine/src/observe.ts';
import type { Agent, AgentContext, Decision } from './agent.ts';

export interface HeuristicParams {
  /** Logistic weights: bias, best card, second card, third card, rounds won minus lost, table advantage, partner signal. */
  w: number[];
  /** Raise thresholds on the estimate, by current step 0..3. */
  raise: number[];
  /** Accept thresholds by proposed step 1..4. */
  accept: number[];
  /** Raise-again thresholds by proposed step 1..3. */
  reraise: number[];
  /** Play the mão de onze or de dez when the estimate is above this. */
  onze: number;
  /** Chance of raising with an estimate below bluffBelow. */
  bluff: number;
  bluffBelow: number;
  /** Leading the first round: 0 lowest, 1 middle, 2 highest card. */
  lead1: number;
  /** Leading a later round: 0 lowest, 2 highest card. */
  leadLater: number;
  /** Chance of sending a true signal (2 against 2). */
  signalTruth: number;
  /** Extra estimate per point of the opponent's score near the end (risk taking when behind). */
  behind: number;
}

export const BASE_PARAMS: HeuristicParams = {
  w: [-0.3, 3.0, 2.0, 1.0, 1.6, 1.4, 0.6],
  raise: [0.72, 0.78, 0.84, 0.9],
  accept: [0.45, 0.5, 0.55, 0.6],
  reraise: [0.8, 0.86, 0.92],
  onze: 0.5,
  bluff: 0,
  bluffBelow: 0.3,
  lead1: 2,
  leadLater: 2,
  signalTruth: 1,
  behind: 0,
};

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

interface View {
  strength: number[];
  /** My remaining cards (ids), strongest first; empty in a blind hand. */
  mine: number[];
  /** Remaining slots in slot order. */
  slots: number[];
  blind: boolean;
  /** For each strength class: chance that an unseen card is weaker, counting ties as half. */
  beat: number[];
}

function view(obs: Observation): View {
  const strength = strengthTable(obs.variant, obs.manilhaRank);
  const slots: number[] = [];
  for (let i = 0; i < 3; i++) if (obs.hand[i] !== -1) slots.push(i);
  const blind = obs.hand.some((c) => c === HIDDEN);
  const mine = blind ? [] : slots.map((s) => obs.hand[s]).sort((a, b) => strength[b] - strength[a]);
  const known = new Set<number>(mine);
  if (obs.vira >= 0) known.add(obs.vira);
  for (const r of obs.rounds) for (const p of r.plays) if (p.card >= 0) known.add(p.card);
  if (obs.partnerHand) for (const c of obs.partnerHand) if (c >= 0) known.add(c);
  const counts = new Array<number>(14).fill(0);
  let unseen = 0;
  for (let c = 0; c < DECK_SIZE; c++) {
    if (!known.has(c)) {
      counts[strength[c]]++;
      unseen++;
    }
  }
  const beat = new Array<number>(14).fill(0);
  let below = 0;
  for (let st = 0; st < 14; st++) {
    beat[st] = unseen ? (below + counts[st] / 2) / unseen : 0.5;
    below += counts[st];
  }
  return { strength, mine, slots, blind, beat };
}

/** Best card on the table this round: its strength (face down is -1) and whether my team holds it. */
function tableBest(obs: Observation, v: View): { best: number; mine: boolean; tied: boolean; plays: number } {
  const cur = obs.rounds[obs.round];
  let best = -2;
  let teams = 0;
  for (const p of cur?.plays ?? []) {
    const st = p.faceDown ? -1 : v.strength[p.card];
    if (st > best) {
      best = st;
      teams = 1 << (p.seat & 1);
    } else if (st === best) teams |= 1 << (p.seat & 1);
  }
  const myTeam = obs.seat & 1;
  return { best, mine: teams === 1 << myTeam, tied: teams === 3, plays: cur?.plays.length ?? 0 };
}

/** Estimated chance that my team wins this hand. */
export function handEstimate(obs: Observation, p: HeuristicParams, v = view(obs)): number {
  const myTeam = obs.seat & 1;
  let won = 0;
  let lost = 0;
  for (let r = 0; r < obs.round; r++) {
    const res = obs.rounds[r].result;
    if (res === myTeam) won++;
    else if (res === 1 - myTeam) lost++;
  }
  let cards = v.mine.map((c) => v.beat[v.strength[c]]);
  if (obs.partnerHand) {
    const partner = obs.partnerHand.filter((c) => c >= 0).map((c) => v.beat[v.strength[c]]);
    cards = cards.concat(partner).sort((a, b) => b - a).slice(0, 3);
  }
  const s = [0.5, 0.5, 0.5];
  // Cards already played no longer help: missing cards count as weak.
  for (let i = 0; i < 3; i++) s[i] = v.blind ? 0.5 : i < cards.length ? cards[i] : 0.2;
  const t = tableBest(obs, v);
  let tableAdv = 0;
  if (t.plays > 0) tableAdv = t.mine ? 1 : t.tied ? 0 : -1;
  let signal = 0;
  if (obs.players === 4) {
    const partner = (obs.seat + 2) % 4;
    const sig = obs.signals.find((x) => x.seat === partner);
    if (sig) signal = sig.signal <= 3 ? 1 : sig.signal === 4 ? 0.5 : -0.5;
  }
  const w = p.w;
  const x = w[0] + w[1] * (s[0] - 0.5) + w[2] * (s[1] - 0.5) + w[3] * (s[2] - 0.5) + w[4] * (won - lost) + w[5] * tableAdv + w[6] * signal;
  const oppScore = obs.score[1 - myTeam];
  const urgency = p.behind * Math.max(0, oppScore - obs.score[myTeam]) / 12;
  return sigmoid(x) + urgency;
}

function lowest(v: View): number {
  return v.mine[v.mine.length - 1];
}

function slotOf(obs: Observation, card: number): number {
  return obs.hand.indexOf(card);
}

function chooseCard(obs: Observation, p: HeuristicParams, v: View): number {
  const legalPlays = obs.legal & 0b111;
  if (v.blind) {
    for (const s of v.slots) if (legalPlays & (1 << s)) return A_PLAY0 + s;
  }
  const t = tableBest(obs, v);
  const myTeam = obs.seat & 1;
  const lastToPlay = t.plays === obs.players - 1;
  if (t.plays === 0) {
    // Leading the round.
    const mode = obs.round === 0 ? p.lead1 : p.leadLater;
    const idx = mode >= 2 ? 0 : mode >= 1 ? Math.floor((v.mine.length - 1) / 2) : v.mine.length - 1;
    return A_PLAY0 + slotOf(obs, v.mine[idx]);
  }
  // Partner already winning: keep strong cards when I am last, or when the partner's card is a manilha.
  if (t.mine && (lastToPlay || t.best >= 10)) return discard(obs, v);
  // Win as cheaply as possible.
  const winners = v.mine.filter((c) => v.strength[c] > t.best);
  if (winners.length > 0) {
    const cheapest = winners[winners.length - 1];
    return A_PLAY0 + slotOf(obs, cheapest);
  }
  // Cannot win: tie if the first round was won by us (a later tie keeps the first round winner).
  const ties = v.mine.filter((c) => v.strength[c] === t.best);
  if (ties.length > 0 && obs.round > 0 && obs.rounds[0].result === myTeam) return A_PLAY0 + slotOf(obs, ties[0]);
  return discard(obs, v);
}

function discard(obs: Observation, v: View): number {
  const card = lowest(v);
  const slot = slotOf(obs, card);
  // Hide a worthless card face down when allowed and it would lose anyway.
  if (obs.legal & (1 << (A_COVER0 + slot)) && v.strength[card] <= 3) return A_COVER0 + slot;
  return A_PLAY0 + slot;
}

function chooseSignal(obs: Observation, p: HeuristicParams, v: View, rand: () => number): number {
  let truth = 5; // nothing
  const best = v.mine[0];
  if (best !== undefined && v.strength[best] >= 10) truth = 13 - v.strength[best];
  else if (v.mine.some((c) => v.strength[c] === 9)) truth = 4;
  let sig = truth;
  if (rand() >= p.signalTruth) {
    sig = Math.floor(rand() * 5);
    if (sig >= truth) sig++;
  }
  return A_SIGNAL0 + sig;
}

export function heuristicDecision(obs: Observation, p: HeuristicParams, rand: () => number): Decision {
  const legal = obs.legal;
  const v = view(obs);
  if (obs.phase === 'onze') {
    return { action: handEstimate(obs, p, v) > p.onze ? A_ACCEPT : A_RUN };
  }
  if (obs.phase === 'raise') {
    const e = handEstimate(obs, p, v);
    const proposal = obs.step + 1;
    if (legal & (1 << A_RAISE) && e > p.reraise[proposal - 1]) return { action: A_RAISE };
    return { action: e > p.accept[proposal - 1] ? A_ACCEPT : A_RUN };
  }
  // Play phase: signal first, then maybe raise, then a card.
  if (legal & SIGNAL_MASK && (legal & 0b111) !== 0 && !obs.signals.some((s) => s.seat === obs.seat)) {
    return { action: chooseSignal(obs, p, v, rand) };
  }
  if (legal & (1 << A_RAISE) && (legal & 0b111) !== 0) {
    const e = handEstimate(obs, p, v);
    if (e > p.raise[obs.step] || (e < p.bluffBelow && rand() < p.bluff)) return { action: A_RAISE };
  }
  if ((legal & 0b111111) === 0) throw new Error('heuristic asked to act without a card to play');
  return { action: chooseCard(obs, p, v) };
}

export class HeuristicAgent implements Agent {
  readonly name: string;
  readonly params: HeuristicParams;
  constructor(params: HeuristicParams = BASE_PARAMS, name = 'heuristic') {
    this.params = params;
    this.name = name;
  }
  /** The context is not used: the heuristic reads only the current hand. */
  act(obs: Observation, rand: () => number, _ctx?: AgentContext): Decision {
    return heuristicDecision(obs, this.params, rand);
  }
}

/** Flattens parameters to a vector for search, and back. */
export function paramsToVector(p: HeuristicParams): number[] {
  return [...p.w, ...p.raise, ...p.accept, ...p.reraise, p.onze, p.bluff, p.bluffBelow, p.lead1, p.leadLater, p.signalTruth, p.behind];
}

export function vectorToParams(x: readonly number[]): HeuristicParams {
  let i = 0;
  const take = (k: number) => x.slice(i, (i += k));
  return {
    w: take(7),
    raise: take(4),
    accept: take(4),
    reraise: take(3),
    onze: x[i++],
    bluff: Math.min(1, Math.max(0, x[i++])),
    bluffBelow: x[i++],
    lead1: Math.round(Math.min(2, Math.max(0, x[i++]))),
    leadLater: Math.round(Math.min(2, Math.max(0, x[i++]))),
    signalTruth: Math.min(1, Math.max(0, x[i++])),
    behind: x[i++],
  };
}
