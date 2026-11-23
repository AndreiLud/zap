// Card order, round resolution, hand winner and dealing order, checked against
// project_docs/rules.md (sections "Cards", "Dealing and turns" and "Who wins the hand").
// Every expected value below is written from the spec, never read from the engine tables.

import { describe, expect, it } from 'vitest';
import {
  TIE,
  cardToString,
  expectedActor,
  handWinner,
  legalMask,
  makeConfig,
  newMatch,
  parseCard,
  parseCards,
  setHandCards,
  type GameEvent,
  type MatchState,
  type Round,
  type RuleOptions,
  type Variant,
} from '../../src/index.ts';
import { SEED, act, rig } from '../helpers.ts';

// ---------------------------------------------------------------------------------------------
// The spec's card order, written independently of the engine.

/** "Ranks, weakest first: 4, 5, 6, 7, Q, J, K, A, 2, 3." */
const RANK_ORDER = ['4', '5', '6', '7', 'Q', 'J', 'K', 'A', '2', '3'];
/** "Suits in manilha order, weakest first: diamonds, spades, hearts, clubs." */
const SUIT_ORDER = ['d', 's', 'h', 'c'];
const ALL_CARDS = RANK_ORDER.flatMap((r) => SUIT_ORDER.map((s) => r + s));
/** Mineiro fixed manilhas, weakest first: pica-fumo, espadilha, copas, zap. */
const MINEIRO_MANILHAS = ['7d', 'As', '7h', '4c'];

const VARIANTS = ['paulista', 'mineiro'] as const;
const TABLES = [2, 4] as const;
const tableName = (n: number): string => (n === 2 ? '1 against 1' : '2 against 2');
/** Step 0 of each ladder: the value of a hand nobody raised. */
const BASE: Record<Variant, number> = { paulista: 1, mineiro: 2 };
/** Default paulista vira in these tests: the sixes are the manilhas. */
const DEFAULT_VIRA = '5d';

/** "the four cards of the next rank are the manilhas" (after 3 comes 4). */
function manilhaRankAfter(vira: string): string {
  return RANK_ORDER[(RANK_ORDER.indexOf(vira.slice(0, -1)) + 1) % RANK_ORDER.length];
}

/** Spec strength level of a card: plain cards 0 to 9 by rank, manilhas 100 to 103 by suit order. */
function level(variant: Variant, vira: string | null, card: string): number {
  const rank = card.slice(0, -1);
  if (variant === 'paulista') {
    if (rank === manilhaRankAfter(vira!)) return 100 + SUIT_ORDER.indexOf(card.slice(-1));
  } else {
    const i = MINEIRO_MANILHAS.indexOf(card);
    if (i >= 0) return 100 + i;
  }
  return RANK_ORDER.indexOf(rank);
}

/** Cards grouped by equal spec strength, weakest group first; the vira is not in any group. */
function strengthGroups(variant: Variant, vira: string | null): string[][] {
  const byLevel = new Map<number, string[]>();
  for (const c of ALL_CARDS) {
    if (c === vira) continue;
    const l = level(variant, vira, c);
    byLevel.set(l, [...(byLevel.get(l) ?? []), c]);
  }
  return [...byLevel.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
}

/** Pairs of cards whose order in a hand's strength table differs from the spec order. */
function tableMismatches(strength: readonly number[], variant: Variant, vira: string | null): string[] {
  const wrong: string[] = [];
  for (const a of ALL_CARDS) {
    for (const b of ALL_CARDS) {
      const got = Math.sign(strength[parseCard(a)] - strength[parseCard(b)]);
      const want = Math.sign(level(variant, vira, a) - level(variant, vira, b));
      if (got !== want) wrong.push(`${a} vs ${b}: got ${got}, spec ${want}`);
    }
  }
  return wrong;
}

// ---------------------------------------------------------------------------------------------
// Helpers to deal and play.

type RoundEvent = Extract<GameEvent, { t: 'round' }>;
type HandEvent = Extract<GameEvent, { t: 'hand' }>;
type PlayEvent = Extract<GameEvent, { t: 'play' }>;
type DealEvent = Extract<GameEvent, { t: 'deal' }>;

const roundEvents = (ev: GameEvent[]): RoundEvent[] => ev.filter((e): e is RoundEvent => e.t === 'round');
const playEvents = (ev: GameEvent[]): PlayEvent[] => ev.filter((e): e is PlayEvent => e.t === 'play');
const handEvent = (ev: GameEvent[]): HandEvent | undefined => ev.find((e): e is HandEvent => e.t === 'hand');
const dealEvent = (ev: GameEvent[]): DealEvent | undefined => ev.find((e): e is DealEvent => e.t === 'deal');

function viraFor(variant: Variant, vira?: string): string | undefined {
  return variant === 'paulista' ? (vira ?? DEFAULT_VIRA) : undefined;
}

/** Hands for rig(): the given cards first in each seat's slots, the rest filled with unused cards. */
function fill(perSeat: string[][], vira?: string): string[] {
  const used = new Set(perSeat.flat());
  if (vira) used.add(vira);
  const spare = ALL_CARDS.filter((c) => !used.has(c));
  return perSeat.map((cards) => {
    const h = cards.slice();
    while (h.length < 3) h.push(spare.shift()!);
    return h.join(' ');
  });
}

/** The expected actor plays its next unplayed slot (face down when cover is set). */
function playNext(s: MatchState, cover = false): GameEvent[] {
  const seat = expectedActor(s);
  const slot = s.hand.cards[seat].findIndex((c) => c >= 0);
  return act(s, [seat, `${cover ? 'cover' : 'play'}${slot}`]);
}

/** Plays the current hand to its end, every seat playing its slots in order. */
function playOut(s: MatchState): GameEvent[] {
  const index = s.hand.index;
  const ev: GameEvent[] = [];
  for (let guard = 0; s.hand.index === index && !s.over; guard++) {
    if (guard > 12) throw new Error('hand did not end');
    ev.push(...playNext(s));
  }
  return ev;
}

interface FirstRound {
  result: number;
  winnerSeat: number;
  order: number[];
  s: MatchState;
}

/**
 * Deals cards[seat] as each seat's first card and plays round 1 in turn order.
 * A card written as '~6c' is played face down.
 */
function firstRound(cards: string[], o: { variant?: Variant; vira?: string; dealer?: number; options?: Partial<RuleOptions> } = {}): FirstRound {
  const variant = o.variant ?? 'paulista';
  const vira = viraFor(variant, o.vira);
  const s = rig({
    variant,
    players: cards.length as 2 | 4,
    cards: fill(cards.map((c) => [c.replace('~', '')]), vira),
    vira,
    dealer: o.dealer,
    options: o.options,
  });
  const ev: GameEvent[] = [];
  for (let k = 0; k < cards.length; k++) {
    const seat = expectedActor(s);
    ev.push(...act(s, [seat, cards[seat].startsWith('~') ? 'cover0' : 'play0']));
  }
  const r = roundEvents(ev);
  expect(r).toHaveLength(1);
  return { result: r[0].result, winnerSeat: r[0].winnerSeat, order: playEvents(ev).map((p) => p.seat), s };
}

// Planned hands: round i ends with plan[i] (team 0, team 1 or 'T' for a tie). Slot i of every seat
// holds its card for round i. Ranks chosen so none is a manilha (paulista vira 5d: sixes).
type Res = 0 | 1 | 'T';
const HIGH: Record<Variant, string[]> = { paulista: ['3', '2', 'A'], mineiro: ['3', '2', 'K'] };
const LOW: Record<Variant, string[]> = { paulista: ['4', 'Q', 'J'], mineiro: ['5', '6', 'Q'] };

/** Seats that hold the high card of round i: the round winner, or one player of each team on a tie. */
function highSeats(res: Res, i: number, players: number): number[] {
  if (players === 2) return res === 'T' ? [0, 1] : [res];
  if (res === 'T') return [[1, 2], [0, 3], [2, 3]][i];
  return [res + 2 * (i % 2)]; // the winning partner alternates from round to round
}

/** Expected round winner seat for planned round i (-1 on a tie). */
function plannedWinnerSeat(res: Res, i: number, players: number): number {
  return res === 'T' ? -1 : highSeats(res, i, players)[0];
}

function planDeal(variant: Variant, players: number, plan: Res[]): string[] {
  const hands: string[][] = Array.from({ length: players }, () => []);
  for (let i = 0; i < 3; i++) {
    const high = highSeats(plan[i] ?? 'T', i, players);
    for (let seat = 0; seat < players; seat++) {
      hands[seat].push((high.includes(seat) ? HIGH[variant][i] : LOW[variant][i]) + SUIT_ORDER[seat]);
    }
  }
  return hands.map((h) => h.join(' '));
}

const resultOf = (r: Res): number => (r === 'T' ? TIE : r);
const planName = (plan: Res[]): string => plan.map((r) => (r === 'T' ? 'tie' : `team ${r}`)).join(', ');

/** Every sequence of round results that a real hand can produce, with the spec's hand winner. */
const REACHABLE: [Res[], 0 | 1 | 'nobody'][] = [
  [[0, 0], 0],
  [[1, 1], 1],
  [[0, 'T'], 0],
  [[1, 'T'], 1],
  [['T', 0], 0],
  [['T', 1], 1],
  [[0, 1, 0], 0],
  [[0, 1, 1], 1],
  [[0, 1, 'T'], 0],
  [[1, 0, 0], 0],
  [[1, 0, 1], 1],
  [[1, 0, 'T'], 1],
  [['T', 'T', 0], 0],
  [['T', 'T', 1], 1],
  [['T', 'T', 'T'], 'nobody'],
];

// ---------------------------------------------------------------------------------------------
// Card order

describe('card order, paulista', () => {
  it.each(ALL_CARDS)('vira %s: the hand strength table orders every pair of cards as the spec says', (vira) => {
    const s = rig({ cards: fill([[], []], vira), vira });
    expect(cardToString(s.hand.vira)).toBe(vira);
    expect(tableMismatches(s.hand.strength, 'paulista', vira)).toEqual([]);
  });

  it.each(ALL_CARDS)('vira %s: in played rounds each card beats the next weaker one, and plain cards of one rank tie', (vira) => {
    const groups = strengthGroups('paulista', vira);
    // 9 plain ranks plus 4 manilhas, one card each.
    expect(groups).toHaveLength(13);
    for (const g of groups.slice(9)) expect(g).toHaveLength(1);
    const wrong: string[] = [];
    for (let i = 1; i < groups.length; i++) {
      // Use different suits of the weaker group so every plain card is exercised.
      for (const lo of groups[i - 1]) {
        const hi = groups[i][0];
        const a = firstRound([lo, hi], { vira });
        if (a.result !== 1 || a.winnerSeat !== 1) wrong.push(`${lo} then ${hi}: ${a.result}/${a.winnerSeat}`);
        const b = firstRound([hi, lo], { vira });
        if (b.result !== 0 || b.winnerSeat !== 0) wrong.push(`${hi} then ${lo}: ${b.result}/${b.winnerSeat}`);
      }
    }
    for (const g of groups.slice(0, 9)) {
      for (let x = 0; x < g.length; x++) {
        for (let y = x + 1; y < g.length; y++) {
          const t = firstRound([g[x], g[y]], { vira });
          if (t.result !== TIE || t.winnerSeat !== -1) wrong.push(`${g[x]} vs ${g[y]} should tie: ${t.result}/${t.winnerSeat}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it.each([
    ['4h', '5', '3'],
    ['5h', '6', '3'],
    ['6h', '7', '3'],
    ['7h', 'Q', '3'],
    ['Qh', 'J', '3'],
    ['Jh', 'K', '3'],
    ['Kh', 'A', '3'],
    ['Ah', '2', '3'],
    ['2h', '3', '2'],
    ['3h', '4', '3'],
  ])('vira %s: the %s cards are the manilhas, clubs > hearts > spades > diamonds > best plain card (%s)', (vira, m, best) => {
    const zap = m + 'c';
    const copas = m + 'h';
    const espadilha = m + 's';
    const picafumo = m + 'd';
    const bestPlain = best + 'c';
    for (const [hi, lo] of [
      [zap, copas],
      [copas, espadilha],
      [espadilha, picafumo],
      [picafumo, bestPlain],
      [zap, bestPlain],
    ]) {
      expect(firstRound([lo, hi], { vira }).result, `${hi} beats ${lo}`).toBe(1);
      expect(firstRound([hi, lo], { vira }).result, `${hi} beats ${lo}`).toBe(0);
    }
  });

  it('vira 3: after 3 comes 4, so the 4 of diamonds (pica-fumo) beats the 3 of clubs', () => {
    expect(firstRound(['3c', '4d'], { vira: '3h' }).result).toBe(1);
  });

  it('vira 3: the other threes stay plain and tie with each other', () => {
    expect(firstRound(['3c', '3d'], { vira: '3h' }).result).toBe(TIE);
  });

  it('vira 2: the threes are manilhas, so the 2 is the best plain card and beats the ace', () => {
    expect(firstRound(['Ac', '2s'], { vira: '2h' }).result).toBe(1);
    expect(firstRound(['2s', '3d'], { vira: '2h' }).result).toBe(1);
  });

  it('vira Q: the jacks (the rank after Q) are manilhas, and the K stays plain below them', () => {
    expect(firstRound(['Kc', 'Jd'], { vira: 'Qh' }).result).toBe(1);
    expect(firstRound(['Kc', 'Ks'], { vira: 'Qh' }).result).toBe(TIE);
  });

  it('the vira itself cannot be dealt to anyone', () => {
    expect(() => rig({ cards: ['6c 4d 4s', '3c 3d 3h'], vira: '6c' })).toThrow();
  });
});

describe('card order, mineiro', () => {
  it('the strength table orders every pair of cards as the spec says, with no vira', () => {
    const s = rig({ variant: 'mineiro', cards: fill([[], []]) });
    expect(s.hand.vira).toBe(-1);
    expect(tableMismatches(s.hand.strength, 'mineiro', null)).toEqual([]);
  });

  it('in played rounds: 4c > 7h > As > 7d > 3 > 2 > A > K > J > Q > 7 > 6 > 5 > 4, each beating the next', () => {
    const groups = strengthGroups('mineiro', null);
    expect(groups).toHaveLength(14);
    expect(groups.slice(10).map((g) => g.join())).toEqual(['7d', 'As', '7h', '4c']);
    const wrong: string[] = [];
    for (let i = 1; i < groups.length; i++) {
      for (const lo of groups[i - 1]) {
        const hi = groups[i][0];
        const a = firstRound([lo, hi], { variant: 'mineiro' });
        if (a.result !== 1 || a.winnerSeat !== 1) wrong.push(`${lo} then ${hi}: ${a.result}/${a.winnerSeat}`);
        const b = firstRound([hi, lo], { variant: 'mineiro' });
        if (b.result !== 0 || b.winnerSeat !== 0) wrong.push(`${hi} then ${lo}: ${b.result}/${b.winnerSeat}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('plain cards of one rank tie whatever the suit, for every rank', () => {
    const wrong: string[] = [];
    for (const g of strengthGroups('mineiro', null).slice(0, 10)) {
      for (let x = 0; x < g.length; x++) {
        for (let y = x + 1; y < g.length; y++) {
          const t = firstRound([g[x], g[y]], { variant: 'mineiro' });
          if (t.result !== TIE || t.winnerSeat !== -1) wrong.push(`${g[x]} vs ${g[y]}: ${t.result}/${t.winnerSeat}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('the other fours, sevens and aces are plain cards', () => {
    // Plain 4s are the weakest cards: they lose to a 5.
    for (const four of ['4d', '4s', '4h']) expect(firstRound([four, '5d'], { variant: 'mineiro' }).result).toBe(1);
    // Plain 7s sit between the 6 and the Q.
    for (const seven of ['7s', '7c']) {
      expect(firstRound([seven, '6d'], { variant: 'mineiro' }).result).toBe(0);
      expect(firstRound([seven, 'Qd'], { variant: 'mineiro' }).result).toBe(1);
    }
    // Plain aces sit between the K and the 2, and lose to the espadilha.
    for (const ace of ['Ad', 'Ah', 'Ac']) {
      expect(firstRound([ace, 'Kd'], { variant: 'mineiro' }).result).toBe(0);
      expect(firstRound([ace, '2d'], { variant: 'mineiro' }).result).toBe(1);
      expect(firstRound([ace, 'As'], { variant: 'mineiro' }).result).toBe(1);
    }
    expect(firstRound(['7s', '7c'], { variant: 'mineiro' }).result).toBe(TIE);
    expect(firstRound(['4d', '4h'], { variant: 'mineiro' }).result).toBe(TIE);
    expect(firstRound(['Ac', 'Ad'], { variant: 'mineiro' }).result).toBe(TIE);
  });

  it('the weakest manilha (7d) beats the best plain card (a 3)', () => {
    expect(firstRound(['3c', '7d'], { variant: 'mineiro' }).result).toBe(1);
    expect(firstRound(['7d', '3c'], { variant: 'mineiro' }).result).toBe(0);
  });
});

describe('card order in naturally dealt hands', () => {
  for (const variant of VARIANTS) {
    for (const players of TABLES) {
      it(`${variant}, ${tableName(players)}: every dealt hand follows the spec card order${variant === 'paulista' ? ' for its vira' : ' with no vira'}`, () => {
        for (let k = 1; k <= 30; k++) {
          const seed = k.toString(16).padStart(64, '0');
          const s = newMatch(makeConfig(variant, players), seed);
          // Two hands per match: the first deal and the automatic next deal.
          for (let hand = 0; hand < 2; hand++) {
            const h = s.hand;
            expect(h.dealt).toHaveLength(players);
            if (variant === 'paulista') {
              expect(h.vira).toBeGreaterThanOrEqual(0);
              expect(h.vira).toBeLessThan(40);
              expect(h.dealt.flat()).not.toContain(h.vira);
              expect(tableMismatches(h.strength, variant, cardToString(h.vira))).toEqual([]);
            } else {
              expect(h.vira).toBe(-1);
              expect(tableMismatches(h.strength, variant, null)).toEqual([]);
            }
            if (h.kind !== 'normal') break;
            playOut(s);
          }
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Round resolution

describe('round resolution, 1 against 1', () => {
  for (const variant of VARIANTS) {
    it(`${variant}: the stronger card wins when the opener plays it`, () => {
      const r = firstRound(['Kc', 'Jd'], { variant });
      expect([r.result, r.winnerSeat]).toEqual([0, 0]);
    });

    it(`${variant}: the stronger card wins when the second player plays it`, () => {
      const r = firstRound(['Jd', 'Kc'], { variant });
      expect([r.result, r.winnerSeat]).toEqual([1, 1]);
    });

    it(`${variant}: the stronger card wins when the mão is seat 1`, () => {
      const r = firstRound(['3c', '2d'], { variant, dealer: 0 });
      expect(r.order).toEqual([1, 0]);
      expect([r.result, r.winnerSeat]).toEqual([0, 0]);
    });

    it(`${variant}: a manilha beats a three`, () => {
      const manilha = variant === 'paulista' ? '6d' : '7d';
      expect(firstRound(['3c', manilha], { variant }).result).toBe(1);
    });

    it(`${variant}: plain cards of the same rank tie, whatever the suits`, () => {
      for (const [a, b] of [
        ['3c', '3d'],
        ['Kh', 'Ks'],
        ['5s', '5h'],
      ]) {
        const r = firstRound([a, b], { variant });
        expect([r.result, r.winnerSeat], `${a} vs ${b}`).toEqual([TIE, -1]);
      }
    });
  }
});

describe('round resolution, 2 against 2', () => {
  for (const variant of VARIANTS) {
    it.each([0, 1, 2, 3])(`${variant}: the strongest card wins wherever it sits (seat %i)`, (seat) => {
      const cards = ['4d', 'Qs', 'Jh', 'Kc'];
      cards[seat] = '3h';
      const r = firstRound(cards, { variant });
      expect(r.order).toEqual([0, 1, 2, 3]);
      expect([r.result, r.winnerSeat]).toEqual([seat % 2, seat]);
    });

    it.each([
      [0, 1],
      [0, 3],
      [1, 2],
      [2, 3],
    ])(`${variant}: the top rank shared by seats %i and %i of different teams ties the round`, (a, b) => {
      const cards = ['Qd', 'Qs', 'Qh', 'Qc'];
      cards[a] = '3c';
      cards[b] = '3d';
      const r = firstRound(cards, { variant });
      expect([r.result, r.winnerSeat]).toEqual([TIE, -1]);
    });

    it(`${variant}: the top rank held by three players, two of them partners, still ties the round`, () => {
      const r = firstRound(['3c', '3d', '3h', 'Ks'], { variant });
      expect([r.result, r.winnerSeat]).toEqual([TIE, -1]);
    });

    it(`${variant}: all four plain cards of one rank tie the round`, () => {
      const r = firstRound(['Kd', 'Ks', 'Kh', 'Kc'], { variant });
      expect([r.result, r.winnerSeat]).toEqual([TIE, -1]);
    });

    it(`${variant}: a tie below the top card does not matter, the top card wins`, () => {
      const r = firstRound(['2c', '2d', '3h', 'Ks'], { variant });
      expect([r.result, r.winnerSeat]).toEqual([0, 2]);
    });

    it(`${variant}: top rank shared by partners 0 and 2: team 0 wins, seat 0 (first to play it) is the round winner`, () => {
      const r = firstRound(['3c', '2d', '3h', '2s'], { variant });
      expect([r.result, r.winnerSeat]).toEqual([0, 0]);
    });

    it(`${variant}: top rank shared by partners 1 and 3: team 1 wins, seat 1 is the round winner`, () => {
      const r = firstRound(['2c', '3d', '2h', '3s'], { variant });
      expect([r.result, r.winnerSeat]).toEqual([1, 1]);
    });

    it(`${variant}: partners sharing the top rank when seat 2 opens: seat 2 played it first and is the round winner`, () => {
      // Dealer 1, so seat 2 is the mão and plays 2, 3, 0, 1.
      const r = firstRound(['3c', '2d', '3h', '2s'], { variant, dealer: 1 });
      expect(r.order).toEqual([2, 3, 0, 1]);
      expect([r.result, r.winnerSeat]).toEqual([0, 2]);
      expect(expectedActor(r.s)).toBe(2);
    });

    it(`${variant}: partners sharing the top rank when seat 3 opens: seat 3 played it first and is the round winner`, () => {
      const r = firstRound(['2c', '3d', '2h', '3s'], { variant, dealer: 2 });
      expect(r.order).toEqual([3, 0, 1, 2]);
      expect([r.result, r.winnerSeat]).toEqual([1, 3]);
      expect(expectedActor(r.s)).toBe(3);
    });

    it(`${variant}: partners holding the two best manilhas: the zap wins the round for the partner who played it`, () => {
      const [zap, copas] = variant === 'paulista' ? ['6c', '6h'] : ['4c', '7h'];
      const r = firstRound([copas, '3d', zap, '3s'], { variant });
      expect([r.result, r.winnerSeat]).toEqual([0, 2]);
    });
  }
});

describe('face-down cards', () => {
  // Paulista vira 5d: the sixes are manilhas, 6c is the zap, fours are the weakest cards.
  // Mineiro: 4c is the zap, 4d, 4s and 4h are the weakest cards.
  const ZAP: Record<Variant, string> = { paulista: '6c', mineiro: '4c' };

  for (const variant of VARIANTS) {
    const zap = ZAP[variant];

    it(`${variant}, 1 against 1: a face-down zap loses to the weakest face-up card`, () => {
      const s = rig({ variant, cards: [`3c ${zap} 2d`, '4d 4s 2s'], vira: viraFor(variant) });
      act(s, [0, 'play0'], [1, 'play0']);
      const ev = act(s, [0, 'cover1'], [1, 'play1']);
      const r = roundEvents(ev)[0];
      expect([r.result, r.winnerSeat]).toEqual([1, 1]);
    });

    it(`${variant}, 1 against 1: a face-down card loses also when played second`, () => {
      const s = rig({ variant, cards: [`4d ${zap} 2s`, '3c 4s 2d'], vira: viraFor(variant) });
      // Seat 1 wins round 1 and opens round 2 face up with a four; seat 0 covers its zap.
      act(s, [0, 'play0'], [1, 'play0']);
      const ev = act(s, [1, 'play1'], [0, 'cover1']);
      const r = roundEvents(ev)[0];
      expect([r.result, r.winnerSeat]).toEqual([1, 1]);
    });

    it(`${variant}, 1 against 1: two face-down cards tie`, () => {
      const s = rig({ variant, cards: [`3c ${zap} 2d`, '4d 4s 2s'], vira: viraFor(variant) });
      act(s, [0, 'play0'], [1, 'play0']);
      const ev = act(s, [0, 'cover1'], [1, 'cover1']);
      const r = roundEvents(ev)[0];
      expect([r.result, r.winnerSeat]).toEqual([TIE, -1]);
      // r1 won by team 0 and r2 tied: team 0 takes the hand after two rounds.
      expect(handEvent(ev)?.winner).toBe(0);
    });

    // 2 against 2: seat 0 wins round 1 with the 3 and opens round 2.
    const four = (): MatchState => {
      const s = rig({ variant, cards: [`3c ${zap} 2d`, 'Qd 4s 2s', 'Qs 3h 2h', 'Qh 4h 2c'], vira: viraFor(variant) });
      act(s, [0, 'play0'], [1, 'play0'], [2, 'play0'], [3, 'play0']);
      expect(expectedActor(s)).toBe(0);
      return s;
    };

    it(`${variant}, 2 against 2: four face-down cards tie`, () => {
      const ev = act(four(), [0, 'cover1'], [1, 'cover1'], [2, 'cover1'], [3, 'cover1']);
      const r = roundEvents(ev)[0];
      expect([r.result, r.winnerSeat]).toEqual([TIE, -1]);
    });

    it(`${variant}, 2 against 2: a face-down zap loses to the face-up cards, the best face-up card wins`, () => {
      const ev = act(four(), [0, 'cover1'], [1, 'play1'], [2, 'play1'], [3, 'play1']);
      const r = roundEvents(ev)[0];
      expect([r.result, r.winnerSeat]).toEqual([0, 2]);
    });

    it(`${variant}, 2 against 2: partners who both play face down lose to the opponents' weakest face-up cards`, () => {
      const ev = act(four(), [0, 'cover1'], [1, 'play1'], [2, 'cover1'], [3, 'play1']);
      const r = roundEvents(ev)[0];
      // 4s and 4h share the top, both from team 1: team 1 wins, seat 1 played first.
      expect([r.result, r.winnerSeat]).toEqual([1, 1]);
    });

    it(`${variant}, 2 against 2: three face-down cards lose to the one face-up four`, () => {
      const ev = act(four(), [0, 'cover1'], [1, 'cover1'], [2, 'cover1'], [3, 'play1']);
      const r = roundEvents(ev)[0];
      expect([r.result, r.winnerSeat]).toEqual([1, 3]);
    });

    it(`${variant}, 1 against 1, faceDownFirstRound: a face-down card in round 1 loses to the opener's weakest card`, () => {
      const r = firstRound(['4d', `~${zap}`], { variant, options: { faceDownFirstRound: true } });
      expect([r.result, r.winnerSeat]).toEqual([0, 0]);
    });

    it(`${variant}, 2 against 2, faceDownFirstRound: the opener's four beats three face-down cards`, () => {
      const r = firstRound(['4d', `~${zap}`, '~3c', '~3h'], { variant, options: { faceDownFirstRound: true } });
      expect([r.result, r.winnerSeat]).toEqual([0, 0]);
    });

    it(`${variant}, 2 against 2, faceDownFirstRound: two face-down cards behind the opener's card never beat it`, () => {
      const r = firstRound(['Qd', '~3s', 'Kh', '~2c'], { variant, options: { faceDownFirstRound: true } });
      expect([r.result, r.winnerSeat]).toEqual([0, 2]);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Who opens each round

describe('who opens each round', () => {
  for (const variant of VARIANTS) {
    for (const players of TABLES) {
      it.each(REACHABLE.map(([plan]) => [planName(plan), plan] as const))(
        `${variant}, ${tableName(players)}, rounds %s: the mão opens round 1, a round winner opens the next round, after a tie the opener of the tied round opens again; play goes seat by seat`,
        (_name, plan) => {
          for (let dealer = 0; dealer < players; dealer++) {
            const s = rig({ variant, players, dealer, cards: planDeal(variant, players, plan as Res[]) });
            const ev = playOut(s);
            const expectedOrder: number[] = [];
            let opener = (dealer + 1) % players;
            plan.forEach((res, i) => {
              for (let k = 0; k < players; k++) expectedOrder.push((opener + k) % players);
              if (res !== 'T') opener = plannedWinnerSeat(res, i, players);
            });
            expect(playEvents(ev).map((p) => p.seat), `dealer ${dealer}`).toEqual(expectedOrder);
            expect(
              roundEvents(ev).map((r) => [r.result, r.winnerSeat]),
              `dealer ${dealer}`,
            ).toEqual(plan.map((res, i) => [resultOf(res), plannedWinnerSeat(res, i, players)]));
          }
        },
      );
    }
  }

  it('1 against 1: the second player wins round 1 and opens round 2', () => {
    const s = rig({ cards: ['4s Kd Jd', '3c Kc Jc'] });
    act(s, [0, 'play0'], [1, 'play0']);
    expect(expectedActor(s)).toBe(1);
    expect(legalMask(s, 0) & 0b111111).toBe(0);
  });

  it('1 against 1: the winner of round 2 opens round 3', () => {
    const s = rig({ cards: ['3c 4d Kd', '4s 3d Kc'] });
    act(s, [0, 'play0'], [1, 'play0'], [0, 'play1'], [1, 'play1']);
    expect(expectedActor(s)).toBe(1);
    expect(legalMask(s, 0) & 0b111111).toBe(0);
  });

  it('1 against 1: after round 1 is tied, the mão (seat 1 when seat 0 deals) opens round 2', () => {
    const s = rig({ dealer: 0, cards: ['3c Kd Jd', '3d Kc Jc'] });
    expect(expectedActor(s)).toBe(1);
    act(s, [1, 'play0'], [0, 'play0']);
    expect(s.hand.rounds[0].result).toBe(TIE);
    expect(expectedActor(s)).toBe(1);
  });

  it('2 against 2: after a tie between seats 1 and 2, seat 0 who opened the tied round opens again', () => {
    const s = rig({ cards: ['4d Kd Jd', '3c Kc Jc', '3h Kh Jh', '5s Ks Js'] });
    act(s, [0, 'play0'], [1, 'play0'], [2, 'play0'], [3, 'play0']);
    expect(s.hand.rounds[0].result).toBe(TIE);
    expect(expectedActor(s)).toBe(0);
    for (const seat of [1, 2, 3]) expect(legalMask(s, seat) & 0b111111).toBe(0);
  });

  it('2 against 2: after rounds 1 and 2 are tied, the opener of round 2 (the mão, seat 2) opens round 3', () => {
    const s = rig({ dealer: 1, cards: ['3c 2c Kd', '3d 2d Kc', '4s 5s Ks', '4h 5h Qh'] });
    act(s, [2, 'play0'], [3, 'play0'], [0, 'play0'], [1, 'play0']);
    expect(expectedActor(s)).toBe(2);
    act(s, [2, 'play1'], [3, 'play1'], [0, 'play1'], [1, 'play1']);
    expect(s.hand.rounds.slice(0, 2).map((r) => r.result)).toEqual([TIE, TIE]);
    expect(expectedActor(s)).toBe(2);
  });

  it('2 against 2: the partner of the mão wins round 1 and opens round 2, then play goes 2, 3, 0, 1', () => {
    const s = rig({ cards: ['4d Kd Jd', '5c Kc Jc', '3s Ks Js', 'Qh Kh Jh'] });
    act(s, [0, 'play0'], [1, 'play0'], [2, 'play0'], [3, 'play0']);
    expect(expectedActor(s)).toBe(2);
    const order: number[] = [];
    for (let k = 0; k < 4; k++) {
      order.push(expectedActor(s));
      playNext(s);
    }
    expect(order).toEqual([2, 3, 0, 1]);
  });
});

// ---------------------------------------------------------------------------------------------
// Who wins the hand

const R = (result: number): Round => ({ leader: 0, plays: [], result, winnerSeat: result === TIE ? -1 : result });
const NOBODY = -1;
const GOES_ON = -2;

describe('handWinner: all 27 combinations of three round results', () => {
  // [r1, r2, r3, expected], written from "Who wins the hand".
  const TABLE: [Res, Res, Res, 0 | 1 | 'nobody', string][] = [
    [0, 0, 0, 0, 'decided after two rounds'],
    [0, 0, 1, 0, 'decided after two rounds'],
    [0, 0, 'T', 0, 'decided after two rounds'],
    [0, 1, 0, 0, 'r3 decides'],
    [0, 1, 1, 1, 'r3 decides'],
    [0, 1, 'T', 0, 'tied r3 goes to the winner of r1'],
    [0, 'T', 0, 0, 'decided after two rounds'],
    [0, 'T', 1, 0, 'decided after two rounds'],
    [0, 'T', 'T', 0, 'decided after two rounds'],
    [1, 0, 0, 0, 'r3 decides'],
    [1, 0, 1, 1, 'r3 decides'],
    [1, 0, 'T', 1, 'tied r3 goes to the winner of r1'],
    [1, 1, 0, 1, 'decided after two rounds'],
    [1, 1, 1, 1, 'decided after two rounds'],
    [1, 1, 'T', 1, 'decided after two rounds'],
    [1, 'T', 0, 1, 'decided after two rounds'],
    [1, 'T', 1, 1, 'decided after two rounds'],
    [1, 'T', 'T', 1, 'decided after two rounds'],
    ['T', 0, 0, 0, 'r1 tied, r2 decides'],
    ['T', 0, 1, 0, 'r1 tied, r2 decides'],
    ['T', 0, 'T', 0, 'r1 tied, r2 decides'],
    ['T', 1, 0, 1, 'r1 tied, r2 decides'],
    ['T', 1, 1, 1, 'r1 tied, r2 decides'],
    ['T', 1, 'T', 1, 'r1 tied, r2 decides'],
    ['T', 'T', 0, 0, 'r1 and r2 tied, r3 decides'],
    ['T', 'T', 1, 1, 'r1 and r2 tied, r3 decides'],
    ['T', 'T', 'T', 'nobody', 'all three tied, nobody scores'],
  ];

  it('the table covers every combination exactly once', () => {
    expect(new Set(TABLE.map((r) => r.slice(0, 3).join())).size).toBe(27);
  });

  it.each(TABLE)('r1 %s, r2 %s, r3 %s: %s (%s)', (r1, r2, r3, want) => {
    const got = handWinner([R(resultOf(r1)), R(resultOf(r2)), R(resultOf(r3))]);
    expect(got).toBe(want === 'nobody' ? NOBODY : want);
  });
});

describe('handWinner: after one or two rounds', () => {
  const TWO: [Res, Res, 0 | 1 | 'goes on'][] = [
    [0, 0, 0],
    [0, 1, 'goes on'],
    [0, 'T', 0],
    [1, 0, 'goes on'],
    [1, 1, 1],
    [1, 'T', 1],
    ['T', 0, 0],
    ['T', 1, 1],
    ['T', 'T', 'goes on'],
  ];

  it.each(TWO)('r1 %s, r2 %s: %s', (r1, r2, want) => {
    const w = want === 'goes on' ? GOES_ON : want;
    expect(handWinner([R(resultOf(r1)), R(resultOf(r2))])).toBe(w);
    // An unfinished third round changes nothing.
    expect(handWinner([R(resultOf(r1)), R(resultOf(r2)), R(-1)])).toBe(w);
  });

  it.each([0, 1, TIE])('one finished round (%s) never decides the hand', (r1) => {
    expect(handWinner([R(r1)])).toBe(GOES_ON);
    expect(handWinner([R(r1), R(-1)])).toBe(GOES_ON);
  });

  it('no finished round: the hand goes on', () => {
    expect(handWinner([])).toBe(GOES_ON);
    expect(handWinner([R(-1)])).toBe(GOES_ON);
  });
});

describe('hand winner through played hands', () => {
  for (const variant of VARIANTS) {
    for (const players of TABLES) {
      it.each(REACHABLE.map(([plan, want]) => [planName(plan), want === 'nobody' ? 'nobody' : `team ${want}`, want, plan] as const))(
        `${variant}, ${tableName(players)}: rounds %s give the hand to %s`,
        (_name, _label, want, plan) => {
          const s = rig({ variant, players, cards: planDeal(variant, players, plan as Res[]) });
          const value = s.hand.value;
          expect(value).toBe(BASE[variant]);
          const ev = playOut(s);
          expect(roundEvents(ev).map((r) => r.result)).toEqual(plan.map(resultOf));
          // The hand ends as soon as it is decided: two rounds when two suffice.
          expect(playEvents(ev)).toHaveLength(plan.length * players);
          const hand = handEvent(ev)!;
          expect(hand).toBeDefined();
          const score: [number, number] = [0, 0];
          if (want === 'nobody') {
            expect(hand.winner).toBe(-1);
            expect(hand.points).toBe(0);
          } else {
            expect(hand.winner).toBe(want);
            expect(hand.points).toBe(value);
            score[want] = value;
          }
          expect(hand.score).toEqual(score);
          expect(s.score).toEqual(score);
          expect(s.history).toHaveLength(1);
          expect(s.history[0].result.winner).toBe(want === 'nobody' ? -1 : want);
          expect(s.history[0].result.points).toBe(want === 'nobody' ? 0 : value);
          // The next hand is dealt.
          expect(s.hand.index).toBe(1);
        },
      );
    }
  }

  it('the early end after two rounds leaves the third cards in hand and deals the next hand', () => {
    const s = rig({ cards: ['3c 2c Kc', '4d 4s Kd'] });
    const ev = act(s, [0, 'play0'], [1, 'play0'], [0, 'play1'], [1, 'play1']);
    expect(handEvent(ev)?.winner).toBe(0);
    expect(dealEvent(ev)?.hand).toBe(1);
    const played = s.history[0].rounds.flatMap((r) => r.plays.map((p) => cardToString(p.card)));
    expect(played.sort()).toEqual(['2c', '3c', '4d', '4s']);
  });

  it('a round won by the other team in round 2 keeps the hand going into round 3', () => {
    const s = rig({ cards: ['3c 4d Kc', '4s 3d Kd'] });
    const ev = act(s, [0, 'play0'], [1, 'play0'], [0, 'play1'], [1, 'play1']);
    expect(handEvent(ev)).toBeUndefined();
    expect(s.hand.index).toBe(0);
    expect(expectedActor(s)).toBe(1);
  });
});

describe('all three rounds tied: room options', () => {
  const allTied = (players: number): string[] =>
    players === 2 ? ['3c 2c Kc', '3d 2d Kd'] : ['3c 2c Kc', '3d 2d Kd', '3h 2h Kh', '3s 2s Ks'];

  for (const variant of VARIANTS) {
    for (const players of TABLES) {
      it(`${variant}, ${tableName(players)}: by default nobody scores`, () => {
        const s = rig({ variant, players, cards: allTied(players) });
        const hand = handEvent(playOut(s))!;
        expect([hand.winner, hand.points]).toEqual([-1, 0]);
        expect(s.score).toEqual([0, 0]);
      });

      for (let dealer = 0; dealer < players; dealer++) {
        const mao = (dealer + 1) % players;
        it(`${variant}, ${tableName(players)}, allTieToMao, mão seat ${mao}: the team of the mão takes the hand value`, () => {
          const s = rig({ variant, players, dealer, options: { allTieToMao: true }, cards: allTied(players) });
          const hand = handEvent(playOut(s))!;
          expect([hand.winner, hand.points]).toEqual([mao % 2, BASE[variant]]);
          const score: [number, number] = [0, 0];
          score[mao % 2] = BASE[variant];
          expect(s.score).toEqual(score);
        });
      }

      it(`${variant}, ${tableName(players)}, allTieToMao after an accepted truco: the mão's team takes the raised value`, () => {
        const s = rig({ variant, players, dealer: 0, options: { allTieToMao: true }, cards: allTied(players) });
        // Seat 1 is the mão and asks for truco before playing; seat 0 accepts.
        act(s, [1, 'raise'], [0, 'accept']);
        const hand = handEvent(playOut(s))!;
        expect([hand.winner, hand.points]).toEqual([1, variant === 'paulista' ? 3 : 4]);
      });

      it(`${variant}, ${tableName(players)}: onzeTieToOpponents does nothing in a normal hand`, () => {
        const s = rig({ variant, players, options: { onzeTieToOpponents: true }, cards: allTied(players) });
        const hand = handEvent(playOut(s))!;
        expect([hand.winner, hand.points]).toEqual([-1, 0]);
      });
    }

    const threshold = variant === 'paulista' ? 11 : 10;
    const onzeValue = variant === 'paulista' ? 3 : 4;

    it(`${variant}, mão de ${threshold === 11 ? 'onze' : 'dez'} all tied with onzeTieToOpponents: the team not on the threshold takes ${onzeValue}`, () => {
      const s = rig({ variant, players: 2, score: [threshold, 2], options: { onzeTieToOpponents: true }, cards: allTied(2) });
      act(s, [0, 'accept']);
      const hand = handEvent(playOut(s))!;
      expect([hand.winner, hand.points]).toEqual([1, onzeValue]);
      expect(s.score).toEqual([threshold, 2 + onzeValue]);
    });

    it(`${variant}, mão de ${threshold === 11 ? 'onze' : 'dez'} all tied with both options: onzeTieToOpponents comes first`, () => {
      const s = rig({ variant, players: 2, score: [threshold, 2], options: { onzeTieToOpponents: true, allTieToMao: true }, cards: allTied(2) });
      act(s, [0, 'accept']);
      const hand = handEvent(playOut(s))!;
      expect([hand.winner, hand.points]).toEqual([1, onzeValue]);
    });

    it(`${variant}, mão de ${threshold === 11 ? 'onze' : 'dez'} all tied with allTieToMao only: the team of the mão takes ${onzeValue}`, () => {
      // Team 1 is on the threshold, seat 0 (team 0) is the mão.
      const s = rig({ variant, players: 2, score: [2, threshold], options: { allTieToMao: true }, cards: allTied(2) });
      act(s, [1, 'accept']);
      const hand = handEvent(playOut(s))!;
      expect([hand.winner, hand.points]).toEqual([0, onzeValue]);
    });

    it(`${variant}, mão de ${threshold === 11 ? 'onze' : 'dez'} all tied with no option: nobody scores`, () => {
      const s = rig({ variant, players: 2, score: [threshold, 2], cards: allTied(2) });
      act(s, [0, 'accept']);
      const hand = handEvent(playOut(s))!;
      expect([hand.winner, hand.points]).toEqual([-1, 0]);
      expect(s.score).toEqual([threshold, 2]);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Points scored equal the hand value

describe('points scored equal the hand value', () => {
  const LADDERS: [string, Variant, Partial<RuleOptions>, number[]][] = [
    ['paulista', 'paulista', {}, [1, 3, 6, 9, 12]],
    ['mineiro', 'mineiro', {}, [2, 4, 6, 10, 12]],
    ['mineiro with mineiro8', 'mineiro', { ladder: 'mineiro8' }, [2, 4, 8, 10, 12]],
  ];
  /** A plan per step, with the hand winner the spec gives it. */
  const WIN_PLANS: [Res[], 0 | 1][] = [
    [[0, 0], 0],
    [[1, 1], 1],
    [[0, 1, 0], 0],
    [['T', 1], 1],
    [[1, 0, 'T'], 1],
  ];

  for (const [name, variant, options, ladder] of LADDERS) {
    for (const players of TABLES) {
      it.each([0, 1, 2, 3, 4])(`${name}, ${tableName(players)}: a hand at step %i is worth its ladder value and the winner scores exactly that`, (step) => {
        const [plan, winner] = WIN_PLANS[step];
        const s = rig({ variant, players, options, cards: planDeal(variant, players, plan) });
        // Seats 0 and 1 raise in turn up to the step, then the other one accepts.
        for (let k = 0; k < step; k++) act(s, [k % 2, 'raise']);
        if (step > 0) act(s, [step % 2, 'accept']);
        expect(s.hand.value).toBe(ladder[step]);
        const ev = playOut(s);
        const hand = handEvent(ev)!;
        expect(hand.winner).toBe(winner);
        expect(hand.points).toBe(ladder[step]);
        const score: [number, number] = [0, 0];
        score[winner] = ladder[step];
        expect(hand.score).toEqual(score);
        expect(s.history.at(-1)!.scoreAfter).toEqual(score);
      });
    }
  }

  it('the winning team adds the hand value to the score it already had', () => {
    const s = rig({ cards: planDeal('paulista', 2, [1, 1]), score: [4, 7] });
    act(s, [0, 'raise'], [1, 'accept']);
    playOut(s);
    expect(s.score).toEqual([4, 10]);
  });
});

// ---------------------------------------------------------------------------------------------
// Dealer rotation and the mão

describe('dealer rotation and the mão', () => {
  const CYCLE: Res[][] = [[0, 0], [1, 'T'], ['T', 'T', 'T'], [1, 0, 1]];

  for (const variant of VARIANTS) {
    for (const players of TABLES) {
      for (let first = 0; first < players; first++) {
        it(`${variant}, ${tableName(players)}, first dealer seat ${first}: the deal passes to the next seat each hand and the seat after the dealer opens`, () => {
          const s = rig({ variant, players, dealer: first, cards: planDeal(variant, players, CYCLE[0]) });
          const hands = 2 * players + 1;
          for (let k = 0; k < hands; k++) {
            const dealer = (first + k) % players;
            const mao = (dealer + 1) % players;
            expect(s.hand.index).toBe(k);
            expect(s.hand.kind).toBe('normal');
            expect([s.hand.dealer, s.hand.mao], `hand ${k}`).toEqual([dealer, mao]);
            if (k > 0) setHandCards(s, planDeal(variant, players, CYCLE[k % CYCLE.length]).map(parseCards), variant === 'paulista' ? parseCard(DEFAULT_VIRA) : -1);
            expect(expectedActor(s)).toBe(mao);
            for (let seat = 0; seat < players; seat++) if (seat !== mao) expect(legalMask(s, seat) & 0b111111, `seat ${seat}`).toBe(0);
            const ev = playOut(s);
            expect(playEvents(ev)[0].seat).toBe(mao);
            expect(s.history[k].dealer).toBe(dealer);
            expect(s.history[k].mao).toBe(mao);
            const deal = dealEvent(ev)!;
            expect(deal).toBeDefined();
            expect([deal.hand, deal.dealer, deal.mao]).toEqual([k + 1, (dealer + 1) % players, (dealer + 2) % players]);
          }
        });
      }
    }
  }

  for (const variant of VARIANTS) {
    for (const players of TABLES) {
      it(`${variant}, ${tableName(players)}: with engine-dealt hands the deal still rotates and the mão opens`, () => {
        const s = newMatch(makeConfig(variant, players), SEED, { dealer: 0 });
        for (let k = 0; k < 4; k++) {
          const dealer = k % players;
          expect([s.hand.dealer, s.hand.mao]).toEqual([dealer, (dealer + 1) % players]);
          if (s.hand.kind === 'normal') expect(expectedActor(s)).toBe((dealer + 1) % players);
          else break;
          playOut(s);
        }
      });
    }
  }

  it('newMatch with an explicit dealer makes the next seat the mão of the first hand', () => {
    for (const players of TABLES) {
      for (let d = 0; d < players; d++) {
        const s = newMatch(makeConfig('paulista', players), SEED, { dealer: d });
        expect([s.hand.dealer, s.hand.mao, expectedActor(s)]).toEqual([d, (d + 1) % players, (d + 1) % players]);
      }
    }
  });

  for (const variant of VARIANTS) {
    it(`${variant}, best of three: the deal keeps passing to the next seat when a new game starts`, () => {
      const start = variant === 'paulista' ? 9 : 8;
      const s = rig({ variant, players: 2, dealer: 1, score: [start, 0], options: { bestOf: 3 }, cards: planDeal(variant, 2, [0, 0]) });
      act(s, [0, 'raise'], [1, 'accept']);
      playOut(s);
      expect(s.games).toEqual([1, 0]);
      expect(s.score).toEqual([0, 0]);
      expect(s.over).toBe(false);
      expect([s.hand.dealer, s.hand.mao]).toEqual([0, 1]);
    });
  }
});
