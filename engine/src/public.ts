// The public history of a match: what every seat at the table has seen so far, the same for
// all of them. Cards played face down read -1 for everyone, the owner included, and the cards a
// seat kept in hand are never listed. The AI reads opponents from this summary
// (ai/src/opponent-stats.ts), so nothing private can reach that code.

import { manilhaRankForVira } from './cards.ts';
import type { RuleOptions, Variant } from './config.ts';
import type { BetRecord, HandKind, HandResult, HandSummary, MatchState, Round } from './engine.ts';

export interface HistoryPlay {
  seat: number;
  /** Card id when played face up; -1 when face down, for every viewer, the owner included. */
  card: number;
  faceDown: boolean;
}

export interface HistoryRound {
  leader: number;
  plays: HistoryPlay[];
  result: number;
  winnerSeat: number;
}

export interface PublicHand {
  index: number;
  dealer: number;
  mao: number;
  /** -1 in mineiro. */
  vira: number;
  /** -1 in mineiro; paulista: manilhaRankForVira(vira). */
  manilhaRank: number;
  kind: HandKind;
  onzeTeam: number;
  /** Copies of the hand's betting events. */
  bets: BetRecord[];
  rounds: HistoryRound[];
  /** null while the hand is played. */
  result: HandResult | null;
  scoreAfter: [number, number] | null;
  gamesAfter: [number, number] | null;
}

export interface PublicHistory {
  variant: Variant;
  players: 2 | 4;
  options: RuleOptions;
  /** Finished hands, oldest first. Cached and shared between callers: read only. */
  hands: readonly PublicHand[];
  /** The hand being played; null once the match is over. */
  current: PublicHand | null;
}

function publicRounds(rounds: readonly Round[]): HistoryRound[] {
  return rounds.map((r) => ({
    leader: r.leader,
    plays: r.plays.map((p) => ({ seat: p.seat, card: p.faceDown ? -1 : p.card, faceDown: p.faceDown })),
    result: r.result,
    winnerSeat: r.winnerSeat,
  }));
}

function copyBets(bets: readonly BetRecord[]): BetRecord[] {
  return bets.map((b) => ({ seat: b.seat, kind: b.kind, step: b.step, answer: b.answer, round: b.round, played: b.played }));
}

function finishedHand(variant: Variant, h: HandSummary): PublicHand {
  return {
    index: h.index,
    dealer: h.dealer,
    mao: h.mao,
    vira: h.vira,
    manilhaRank: variant === 'paulista' ? manilhaRankForVira(h.vira) : -1,
    kind: h.kind,
    onzeTeam: h.onzeTeam,
    bets: copyBets(h.bets),
    rounds: publicRounds(h.rounds),
    result: { winner: h.result.winner, points: h.result.points, reason: h.result.reason },
    scoreAfter: [h.scoreAfter[0], h.scoreAfter[1]],
    gamesAfter: [h.gamesAfter[0], h.gamesAfter[1]],
  };
}

function currentHand(s: MatchState): PublicHand | null {
  if (s.over) return null;
  const h = s.hand;
  return {
    index: h.index,
    dealer: h.dealer,
    mao: h.mao,
    vira: h.vira,
    manilhaRank: h.manilhaRank,
    kind: h.kind,
    onzeTeam: h.onzeTeam,
    bets: copyBets(h.bets),
    rounds: publicRounds(h.rounds),
    result: null,
    scoreAfter: null,
    gamesAfter: null,
  };
}

// The history array only grows during a match (replay and cloneMatch make a new array), so the
// converted hands are kept per array and only the new summaries are converted on each call.
const cache = new WeakMap<HandSummary[], PublicHand[]>();

/** The public history of the match so far. Finished hands are cached: treat the result as read only. */
export function publicHistory(s: MatchState): PublicHistory {
  let hands = cache.get(s.history);
  if (!hands) {
    hands = [];
    cache.set(s.history, hands);
  }
  for (let i = hands.length; i < s.history.length; i++) hands.push(finishedHand(s.config.variant, s.history[i]));
  return { variant: s.config.variant, players: s.config.players, options: { ...s.config.options }, hands, current: currentHand(s) };
}

/** The same without the cache, for tests. */
export function buildPublicHistory(s: MatchState): PublicHistory {
  return {
    variant: s.config.variant,
    players: s.config.players,
    options: { ...s.config.options },
    hands: s.history.map((h) => finishedHand(s.config.variant, h)),
    current: currentHand(s),
  };
}
