// What one seat is allowed to know. Every message the server sends is built from observe()
// and eventsFor(), so hidden cards, seeds and other seats' signals never leave the server.

import type { RuleOptions, Variant } from './config.ts';
import { legalMask, type GameEvent, type HandKind, type HandPhase, type MatchState } from './engine.ts';

/** In a mão de ferro the player does not see their own cards: the slot is shown as HIDDEN. */
export const HIDDEN = -2;

export interface PublicPlay {
  seat: number;
  /** Card id, or -1 when another seat played it face down (the owner still sees it). */
  card: number;
  faceDown: boolean;
}

export interface PublicRound {
  leader: number;
  plays: PublicPlay[];
  result: number;
  winnerSeat: number;
}

export interface Observation {
  seat: number;
  players: number;
  variant: Variant;
  options: RuleOptions;
  score: [number, number];
  games: [number, number];
  handIndex: number;
  dealer: number;
  mao: number;
  vira: number;
  manilhaRank: number;
  kind: HandKind;
  onzeTeam: number;
  phase: HandPhase;
  step: number;
  value: number;
  lastRaiseTeam: number;
  raiser: number;
  turn: number;
  round: number;
  rounds: PublicRound[];
  /** Own cards by slot: card id, -1 if already played, HIDDEN in a blind hand. */
  hand: number[];
  /** Partner's remaining cards, only for the team on the threshold of a mão de onze or de dez. */
  partnerHand: number[] | null;
  /** Cards left in each seat's hand. */
  handCounts: number[];
  /** Signals this seat saw, in order. */
  signals: { seat: number; signal: number }[];
  /** Bit mask of this seat's legal actions. */
  legal: number;
  over: boolean;
  winner: number;
}

export function observe(s: MatchState, seat: number): Observation {
  const h = s.hand;
  const blind = h.kind === 'iron';
  const own = h.cards[seat].map((c) => (c < 0 ? -1 : blind ? HIDDEN : c));
  let partnerHand: number[] | null = null;
  if (s.n === 4 && h.kind === 'onze' && s.config.options.onzeSeesPartner && (seat & 1) === h.onzeTeam && !s.over) {
    partnerHand = h.cards[(seat + 2) % 4].slice();
  }
  return {
    seat,
    players: s.n,
    variant: s.config.variant,
    options: { ...s.config.options },
    score: [s.score[0], s.score[1]],
    games: [s.games[0], s.games[1]],
    handIndex: h.index,
    dealer: h.dealer,
    mao: h.mao,
    vira: h.vira,
    manilhaRank: h.manilhaRank,
    kind: h.kind,
    onzeTeam: h.onzeTeam,
    phase: h.phase,
    step: h.step,
    value: h.value,
    lastRaiseTeam: h.lastRaiseTeam,
    raiser: h.raiser,
    turn: h.turn,
    round: h.round,
    rounds: h.rounds.map((r) => ({
      leader: r.leader,
      plays: r.plays.map((p) => ({ seat: p.seat, card: p.faceDown && p.seat !== seat ? -1 : p.card, faceDown: p.faceDown })),
      result: r.result,
      winnerSeat: r.winnerSeat,
    })),
    hand: own,
    partnerHand,
    handCounts: h.cards.map((cs) => cs.filter((c) => c >= 0).length),
    signals: h.signals.filter((x) => (x.seenBy >> seat) & 1).map((x) => ({ seat: x.seat, signal: x.signal })),
    legal: legalMask(s, seat),
    over: s.over,
    winner: s.winner,
  };
}

/**
 * Removes from a batch of events what this seat may not see: the identity of face-down cards
 * played by others and signals it did not catch. Who caught a signal is never sent, except
 * when every signal is public.
 */
export function eventsFor(events: readonly GameEvent[], seat: number, options: RuleOptions): GameEvent[] {
  const out: GameEvent[] = [];
  for (const e of events) {
    if (e.t === 'play' && e.faceDown && e.seat !== seat) {
      out.push({ ...e, card: -1 });
    } else if (e.t === 'signal') {
      if ((e.seenBy >> seat) & 1) out.push({ ...e, seenBy: options.signals === 'all' ? e.seenBy : 0 });
    } else {
      out.push(e);
    }
  }
  return out;
}
