// The rules page examples must say what the engine does (CLIENT-SPEC 10.6): the plain card order,
// the manilha for every vira, mineiro's fixed manilhas, the five cases of rounds and ties, and the
// truco example's values for accepting, running and raising, played out on the engine itself.

import { describe, expect, it } from 'vitest';
import { MINEIRO_MANILHAS, makeCard, rankOf, strengthTable, suitOf } from '../../engine/src/cards.ts';
import { makeConfig, type Variant } from '../../engine/src/config.ts';
import { A_ACCEPT, A_RAISE, A_RUN, TIE, applyAction, expectedActor, handWinner, newMatch, type GameEvent, type Round } from '../../engine/src/engine.ts';
import {
  DEMO_IDLE,
  LADDER_CARDS,
  MINEIRO_FIXED,
  ROUND_CASES,
  STRONG_FIRST,
  demoAnswer,
  demoCall,
  demoCanRaise,
  duel,
  ladder,
  onzeFacts,
  searchForVariant,
  variantFromSearch,
  viraExample,
  type TrucoDemo,
} from '../src/rules/logic.ts';

describe('card order', () => {
  it('lists the ten ranks strongest first: 3 2 A K J Q 7 6 5 4', () => {
    const names = ['4', '5', '6', '7', 'Q', 'J', 'K', 'A', '2', '3'];
    expect(STRONG_FIRST.map((r) => names[r]).join(' ')).toBe('3 2 A K J Q 7 6 5 4');
  });

  it('draws the plain ladder with cards that are plain in both variants', () => {
    const mineiro = strengthTable('mineiro', -1);
    expect(LADDER_CARDS.map(rankOf)).toEqual(STRONG_FIRST);
    for (const c of LADDER_CARDS) expect(mineiro[c], `card ${c}`).toBeLessThan(10);
  });

  it('the duel follows the engine strength for every pair of plain ranks, and the suit never counts', () => {
    for (let a = 0; a < 10; a++) {
      for (let b = 0; b < 10; b++) {
        const r = duel(a, b);
        expect(r).toBe(a > b ? 'a' : b > a ? 'b' : 'tie');
        // Any manilha rank other than a and b gives the same answer, whatever the suits.
        for (let m = 0; m < 10; m++) {
          if (m === a || m === b) continue;
          const s = strengthTable('paulista', m);
          for (let sa = 0; sa < 4; sa++) {
            const x = s[makeCard(a, sa)];
            const y = s[makeCard(b, 3 - sa)];
            expect(x > y ? 'a' : y > x ? 'b' : 'tie').toBe(r);
          }
        }
      }
    }
    expect(duel(6, 4)).toBe('a'); // K beats Q
    expect(duel(6, 6)).toBe('tie');
  });
});

describe('vira and manilha', () => {
  it('the manilha is the next rank, and after the 3 comes the 4', () => {
    expect(viraExample(2).manilhaRank).toBe(3); // vira 6, manilha 7
    expect(viraExample(9).manilhaRank).toBe(0); // vira 3, manilha 4
    expect(viraExample(9).wraps).toBe(true);
    expect(viraExample(2).wraps).toBe(false);
  });

  it('lists the four manilhas strongest first (zap, copas, espadilha, pica-fumo) and puts the rank on top of the order', () => {
    for (let v = 0; v < 10; v++) {
      const ex = viraExample(v);
      const s = strengthTable('paulista', ex.manilhaRank);
      expect(ex.manilhas.map(suitOf)).toEqual([3, 2, 1, 0]);
      expect(ex.manilhas.map((c) => s[c])).toEqual([13, 12, 11, 10]);
      expect(ex.order[0]).toBe(ex.manilhaRank);
      expect([...ex.order].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    }
  });

  it('mineiro has four fixed manilhas, strongest first: 4 of clubs, 7 of hearts, ace of spades, 7 of diamonds', () => {
    expect(MINEIRO_FIXED).toEqual([...MINEIRO_MANILHAS].reverse());
    expect(MINEIRO_FIXED).toEqual([makeCard(0, 3), makeCard(3, 2), makeCard(7, 1), makeCard(3, 0)]);
    const s = strengthTable('mineiro', -1);
    expect(MINEIRO_FIXED.map((c) => s[c])).toEqual([13, 12, 11, 10]);
  });
});

describe('rounds and ties', () => {
  const asRound = (m: 'us' | 'them' | 'tie'): Round => ({ leader: 0, plays: [], result: m === 'us' ? 0 : m === 'them' ? 1 : TIE, winnerSeat: -1 });

  it('each of the five cases gives the engine answer, and the hand ends where the table says', () => {
    expect(ROUND_CASES).toHaveLength(5);
    for (const c of ROUND_CASES) {
      const played = c.rounds.filter((m) => m !== null) as ('us' | 'them' | 'tie')[];
      const rounds = played.map(asRound);
      const want = c.winner === 'us' ? 0 : c.winner === 'them' ? 1 : -1;
      expect(handWinner(rounds), c.id).toBe(want);
      // One round fewer leaves the hand open: the last round shown is the one that decides.
      expect(handWinner(rounds.slice(0, -1)), c.id).toBe(-2);
    }
  });
});

describe('the truco example', () => {
  it('uses the ladders of the engine', () => {
    expect(ladder('paulista')).toEqual([1, 3, 6, 9, 12]);
    expect(ladder('mineiro')).toEqual([2, 4, 6, 10, 12]);
    expect(ladder('mineiro', true)).toEqual([2, 4, 8, 10, 12]);
    expect(ladder('paulista', true)).toEqual([1, 3, 6, 9, 12]);
  });

  it('accepting truco makes the hand worth 3 in paulista and 4 in mineiro; running gives 1 or 2', () => {
    const p = ladder('paulista');
    const m = ladder('mineiro');
    expect(demoAnswer(demoCall(), 'accept', p).end).toEqual({ kind: 'accept', by: 'them', value: 3 });
    expect(demoAnswer(demoCall(), 'accept', m).end).toEqual({ kind: 'accept', by: 'them', value: 4 });
    expect(demoAnswer(demoCall(), 'run', p).end).toEqual({ kind: 'run', by: 'them', points: 1 });
    expect(demoAnswer(demoCall(), 'run', m).end).toEqual({ kind: 'run', by: 'them', points: 2 });
  });

  it('a raise passes the answer back to the first caller, up to twelve', () => {
    const p = ladder('paulista');
    let d: TrucoDemo = demoCall();
    d = demoAnswer(d, 'raise', p);
    expect(d).toEqual({ pending: 2, caller: 'them', end: null });
    d = demoAnswer(d, 'raise', p);
    expect(d).toEqual({ pending: 3, caller: 'us', end: null });
    d = demoAnswer(d, 'raise', p);
    expect(d.pending).toBe(4);
    expect(demoCanRaise(d)).toBe(false);
    expect(demoAnswer(d, 'raise', p)).toBe(d);
    expect(demoAnswer(d, 'accept', p).end).toEqual({ kind: 'accept', by: 'us', value: 12 });
    expect(demoAnswer(DEMO_IDLE, 'accept', p)).toBe(DEMO_IDLE);
  });

  /** Plays the same answers on the engine: the first seat to act calls, the next seat answers. */
  function onEngine(variant: Variant, answers: ('accept' | 'run' | 'raise')[]): { value: number | null; points: number | null } {
    const events: GameEvent[] = [];
    const s = newMatch(makeConfig(variant, 2), 'b'.repeat(64), { dealer: 1, score: [0, 0] }, events);
    applyAction(s, expectedActor(s), A_RAISE, events);
    for (const a of answers) {
      const seat = expectedActor(s);
      applyAction(s, seat, a === 'accept' ? A_ACCEPT : a === 'run' ? A_RUN : A_RAISE, events);
    }
    const accept = events.filter((e) => e.t === 'accept').pop();
    const hand = events.find((e) => e.t === 'hand');
    return { value: accept && accept.t === 'accept' ? accept.value : null, points: hand && hand.t === 'hand' ? hand.points : null };
  }

  it('matches the engine for every sequence of answers', () => {
    const seqs: ('accept' | 'run' | 'raise')[][] = [
      ['accept'],
      ['run'],
      ['raise', 'accept'],
      ['raise', 'run'],
      ['raise', 'raise', 'accept'],
      ['raise', 'raise', 'run'],
      ['raise', 'raise', 'raise', 'accept'],
      ['raise', 'raise', 'raise', 'run'],
    ];
    for (const variant of ['paulista', 'mineiro'] as const) {
      const values = ladder(variant);
      for (const seq of seqs) {
        let d = demoCall();
        for (const a of seq) d = demoAnswer(d, a, values);
        const e = onEngine(variant, seq);
        if (d.end?.kind === 'accept') expect(d.end.value, `${variant} ${seq.join(' ')}`).toBe(e.value);
        if (d.end?.kind === 'run') expect(d.end.points, `${variant} ${seq.join(' ')}`).toBe(e.points);
      }
    }
  });
});

describe('mão de onze and the address', () => {
  it('reads the thresholds and values from the engine', () => {
    expect(onzeFacts('paulista')).toEqual({ threshold: 11, value: 3, run: 1 });
    expect(onzeFacts('mineiro')).toEqual({ threshold: 10, value: 4, run: 2 });
  });

  it('keeps the variant in ?variante= and paulista as the clean default', () => {
    expect(variantFromSearch('?variante=mineiro')).toBe('mineiro');
    expect(variantFromSearch('?variante=x')).toBe('paulista');
    expect(variantFromSearch('')).toBe('paulista');
    expect(searchForVariant('', 'mineiro')).toBe('?variante=mineiro');
    expect(searchForVariant('?variante=mineiro', 'paulista')).toBe('');
    expect(searchForVariant('?a=1', 'mineiro')).toBe('?a=1&variante=mineiro');
  });
});
