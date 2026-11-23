// The facts behind the rules page and the quick rules dialog, computed with the engine so the
// examples can never disagree with the game: card order, the manilha for each vira, the fixed
// mineiro manilhas, who takes the hand after ties, and the bet ladder. No DOM here; the unit test
// web/test/rules-logic.test.ts checks every answer against the engine.

import { MINEIRO_MANILHAS, NUM_RANKS, SUIT_HEARTS, makeCard, manilhaRankForVira, manilhasOf, strengthTable } from '../../../engine/src/cards.ts';
import { MAX_STEP, ladderOf, makeConfig, onzeRunPoints, onzeThreshold, onzeValue, type Variant } from '../../../engine/src/config.ts';

/** Rank indices (engine order, 0 is the 4), strongest first: 3 2 A K J Q 7 6 5 4. */
export const STRONG_FIRST: readonly number[] = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0];

/**
 * One card per rank for the picture of the plain order, strongest first. The suits rotate and avoid
 * the four mineiro manilhas (4 of clubs, 7 of hearts, ace of spades, 7 of diamonds), so the same
 * picture is true in both variants.
 */
const LADDER_SUITS = [3, 2, 0, 1, 3, 2, 1, 0, 3, 2];
export const LADDER_CARDS: readonly number[] = STRONG_FIRST.map((r, i) => makeCard(r, LADDER_SUITS[i]));

export type DuelResult = 'a' | 'b' | 'tie';

/**
 * Which of two plain cards wins, by rank only (outside the manilhas the suit does not count). The
 * strengths come from the engine's table for a hand whose manilha is neither rank.
 */
export function duel(a: number, b: number): DuelResult {
  let m = 0;
  while (m === a || m === b) m++;
  const s = strengthTable('paulista', m);
  // Different suits on purpose: two cards of one rank still tie.
  const sa = s[makeCard(a, 0)];
  const sb = s[makeCard(b, 1)];
  return sa > sb ? 'a' : sb > sa ? 'b' : 'tie';
}

export interface ViraExample {
  vira: number;
  manilhaRank: number;
  /** After the 3 the order wraps back to the 4. */
  wraps: boolean;
  /** The four manilhas, strongest first: zap (clubs), copas, espadilha (spades), pica-fumo (diamonds). */
  manilhas: number[];
  /** The ten ranks in this hand's order, strongest first: the manilha rank, then the rest. */
  order: number[];
}

/** The paulista hand for a vira of the given rank (the picture uses a vira of hearts). */
export function viraExample(viraRank: number): ViraExample {
  const vira = makeCard(viraRank, SUIT_HEARTS);
  const manilhaRank = manilhaRankForVira(vira);
  return {
    vira,
    manilhaRank,
    wraps: viraRank === NUM_RANKS - 1,
    manilhas: manilhasOf('paulista', manilhaRank).reverse(),
    order: [manilhaRank, ...STRONG_FIRST.filter((r) => r !== manilhaRank)],
  };
}

/** Mineiro's fixed manilhas, strongest first: 4 of clubs, 7 of hearts, ace of spades, 7 of diamonds. */
export const MINEIRO_FIXED: readonly number[] = MINEIRO_MANILHAS.slice().reverse();

/** Bet values by step (index 0 is the starting value). `eight` is mineiro's room option 2, 4, 8, 10, 12. */
export function ladder(variant: Variant, eight = false): readonly number[] {
  return ladderOf(makeConfig(variant, 4, variant === 'mineiro' && eight ? { ladder: 'mineiro8' } : {}));
}

/** Threshold of the mão de onze (paulista 11) or mão de dez (mineiro 10), its value and the points for running. */
export function onzeFacts(variant: Variant): { threshold: number; value: number; run: number } {
  const c = makeConfig(variant, 4);
  return { threshold: onzeThreshold(c), value: onzeValue(c), run: onzeRunPoints(c) };
}

// ---------------------------------------------------------------------------------------------
// Rounds: the five cases of the hand winner (engine handWinner)

export type RoundMark = 'us' | 'them' | 'tie' | null;

export interface RoundCase {
  id: 'two' | 'firstTie' | 'laterTie' | 'twoTies' | 'allTie';
  /** Results of rounds 1, 2 and 3 from one team's view; null when the round is not played. */
  rounds: readonly [RoundMark, RoundMark, RoundMark];
  winner: 'us' | 'them' | 'nobody';
}

export const ROUND_CASES: readonly RoundCase[] = [
  { id: 'two', rounds: ['us', 'us', null], winner: 'us' },
  { id: 'firstTie', rounds: ['tie', 'them', null], winner: 'them' },
  { id: 'laterTie', rounds: ['us', 'tie', null], winner: 'us' },
  { id: 'twoTies', rounds: ['tie', 'tie', 'us'], winner: 'us' },
  { id: 'allTie', rounds: ['tie', 'tie', 'tie'], winner: 'nobody' },
];

// ---------------------------------------------------------------------------------------------
// The truco example: a call, then accept, run or raise, alternating teams up to 12

export type Side = 'us' | 'them';

export interface TrucoDemo {
  /** Step proposed and waiting for an answer (1 is truco, up to 4), or 0 when nothing waits. */
  pending: number;
  /** Team whose call waits for the answer (or made the last call). */
  caller: Side;
  /** How the last call was answered, once it was. */
  end: { kind: 'accept'; by: Side; value: number } | { kind: 'run'; by: Side; points: number } | null;
}

export const DEMO_IDLE: TrucoDemo = { pending: 0, caller: 'us', end: null };

/** "Pedir truco": we call, they answer. */
export function demoCall(): TrucoDemo {
  return { pending: 1, caller: 'us', end: null };
}

/** The answering team may raise again only while the next step exists (12 is the top). */
export function demoCanRaise(d: TrucoDemo): boolean {
  return d.pending > 0 && d.pending + 1 <= MAX_STEP;
}

/**
 * An answer to the pending call. Accepting makes the hand worth the proposed value; running gives
 * the caller the value from before the call; raising accepts the call and proposes the next step,
 * and now the first caller's team answers.
 */
export function demoAnswer(d: TrucoDemo, answer: 'accept' | 'run' | 'raise', values: readonly number[]): TrucoDemo {
  if (d.pending === 0) return d;
  const by: Side = d.caller === 'us' ? 'them' : 'us';
  if (answer === 'accept') return { pending: 0, caller: d.caller, end: { kind: 'accept', by, value: values[d.pending] } };
  if (answer === 'run') return { pending: 0, caller: d.caller, end: { kind: 'run', by, points: values[d.pending - 1] } };
  if (!demoCanRaise(d)) return d;
  return { pending: d.pending + 1, caller: by, end: null };
}

// ---------------------------------------------------------------------------------------------
// The variant in the address (?variante=mineiro)

export function variantFromSearch(search: string): Variant {
  return new URLSearchParams(search).get('variante') === 'mineiro' ? 'mineiro' : 'paulista';
}

/** The query for a variant: paulista is the default and keeps the address clean. */
export function searchForVariant(search: string, v: Variant): string {
  const p = new URLSearchParams(search);
  if (v === 'mineiro') p.set('variante', 'mineiro');
  else p.delete('variante');
  const q = p.toString();
  return q ? `?${q}` : '';
}
