// Bets: the ladders, who may raise and when, the three answers (accept, run, raise again),
// team alternation and the cap at 12. Every expectation comes from project_docs/rules.md,
// section "Bets" (and the rules table for the ladders).

import { describe, expect, it } from 'vitest';
import {
  COVER_MASK,
  IllegalActionError,
  PLAY_MASK,
  SIGNAL_MASK,
  applyAction,
  expectedActor,
  ladderOf,
  legalMask,
  makeConfig,
  parseAction,
  parseCard,
  parseCards,
  setHandCards,
  type GameEvent,
  type MatchState,
  type RuleOptions,
  type Variant,
} from '../../src/index.ts';
import { act, rig } from '../helpers.ts';

type Players = 2 | 4;

interface LadderCase {
  name: string;
  variant: Variant;
  options: Partial<RuleOptions>;
  /** Hand value by step, straight from the spec. */
  values: readonly number[];
}

const LADDERS: LadderCase[] = [
  { name: 'paulista', variant: 'paulista', options: {}, values: [1, 3, 6, 9, 12] },
  { name: 'mineiro', variant: 'mineiro', options: {}, values: [2, 4, 6, 10, 12] },
  { name: 'mineiro8', variant: 'mineiro', options: { ladder: 'mineiro8' }, values: [2, 4, 8, 10, 12] },
];
const PAULISTA = LADDERS[0];
const MINEIRO = LADDERS[1];
const TABLES: Players[] = [2, 4];
const tableName = (n: Players): string => (n === 2 ? '1 against 1' : '2 against 2');

// No card below is a manilha in paulista with the default vira 5d (sixes) or in mineiro
// (4c, 7h, As, 7d), and the vira 5d is not in any hand.

/** Seat 0 holds the three threes and leads every round, so team 0 wins rounds 1 and 2. */
const TEAM0_WINS: Record<Players, string[]> = {
  2: ['3c 3h 3s', '4s 5s 7s'],
  4: ['3c 3h 3s', '4s 5s 7s', '4h 5h Qh', '5c Qs Js'],
};

/** Playing slot r in round r: round 1 to team 0, round 2 to seat 1 (who leads round 3), round 3 to team 0. */
const SPLIT: Record<Players, string[]> = {
  2: ['3c 4d 3h', '4s 2s 5s'],
  4: ['3c 4d 3h', '4s 2s 5s', '4h 5h Qh', '5c Qs Js'],
};

function deal(n: Players, lad: LadderCase = PAULISTA, options: Partial<RuleOptions> = {}, cards: string[] = TEAM0_WINS[n]): MatchState {
  return rig({ variant: lad.variant, players: n, options: { ...lad.options, ...options }, cards });
}

const bit = (name: string): number => 1 << parseAction(name);
const RAISE = bit('raise');
const ACCEPT = bit('accept');
const RUN = bit('run');
const ANSWER = ACCEPT | RUN;

const team = (seat: number): number => seat % 2;
const allSeats = (s: MatchState): number[] => [...Array(s.n).keys()];
const can = (s: MatchState, seat: number, name: string): boolean => (legalMask(s, seat) & bit(name)) !== 0;
/** Seats that may raise right now. */
const raisers = (s: MatchState): number[] => allSeats(s).filter((x) => (legalMask(s, x) & RAISE) !== 0);
/** Seats that may accept right now. */
const accepters = (s: MatchState): number[] => allSeats(s).filter((x) => (legalMask(s, x) & ACCEPT) !== 0);
/** Seats that may run right now. */
const runners = (s: MatchState): number[] => allSeats(s).filter((x) => (legalMask(s, x) & RUN) !== 0);
const teamSeats = (s: MatchState, t: number): number[] => allSeats(s).filter((x) => team(x) === t);

function expectIllegal(s: MatchState, seat: number, name: string): void {
  const before = JSON.stringify(s);
  expect(() => applyAction(s, seat, parseAction(name))).toThrow(IllegalActionError);
  expect(JSON.stringify(s)).toBe(before);
}

function handEvent(ev: GameEvent[]): Extract<GameEvent, { t: 'hand' }> {
  const e = ev.find((x) => x.t === 'hand');
  if (!e || e.t !== 'hand') throw new Error('the hand did not end');
  return e;
}

/** Every seat plays slot r, in seat order (with TEAM0_WINS seat 0 leads every round). */
function playRound(s: MatchState, r: number): GameEvent[] {
  return act(s, ...allSeats(s).map((seat): [number, string] => [seat, `play${r}`]));
}

/** An opponent of `seat`: the next seat in play order. */
const nextOpponent = (s: MatchState, seat: number): number => (seat + 1) % s.n;

/** Raise-again chains: who raises at steps 1, 2, 3 and 4, always alternating teams. */
const CHAINS: Record<Players, number[][]> = {
  2: [[0, 1, 0, 1]],
  // Each player of each team takes part; the second chain has the original raiser answering
  // (and raising again) after the re-raise.
  4: [
    [0, 1, 2, 3],
    [0, 3, 0, 1],
    [0, 1, 0, 3],
  ],
};

/** Climb by accepted raises, one per turn: who raises, who accepts, then the raiser plays. */
const CLIMB: Record<Players, { raiser: number; answerer: number; play: string }[]> = {
  2: [
    { raiser: 0, answerer: 1, play: 'play0' },
    { raiser: 1, answerer: 0, play: 'play0' },
    { raiser: 0, answerer: 1, play: 'play1' },
    { raiser: 1, answerer: 0, play: 'play1' },
  ],
  4: [
    { raiser: 0, answerer: 3, play: 'play0' },
    { raiser: 1, answerer: 0, play: 'play0' },
    { raiser: 2, answerer: 1, play: 'play0' },
    { raiser: 3, answerer: 2, play: 'play0' },
  ],
};

// ---------------------------------------------------------------------------------------------

describe('ladders', () => {
  it('paulista 1, 3, 6, 9, 12; mineiro 2, 4, 6, 10, 12; mineiro8 2, 4, 8, 10, 12', () => {
    for (const lad of LADDERS) {
      for (const n of TABLES) {
        expect(ladderOf(makeConfig(lad.variant, n, lad.options))).toEqual(lad.values);
      }
    }
  });

  for (const lad of LADDERS) {
    for (const n of TABLES) {
      it(`${lad.name}, ${tableName(n)}: a hand starts at step 0 and, with no raise, is worth ${lad.values[0]}`, () => {
        const s = deal(n, lad);
        expect(s.hand.step).toBe(0);
        expect(s.hand.value).toBe(lad.values[0]);
        playRound(s, 0);
        const h = handEvent(playRound(s, 1));
        expect(h).toMatchObject({ winner: 0, points: lad.values[0], reason: 'rounds' });
        expect(s.score).toEqual([lad.values[0], 0]);
      });
    }
  }
});

describe('raising on your own turn (default)', () => {
  for (const lad of [PAULISTA, MINEIRO]) {
    for (const n of TABLES) {
      it(`${lad.name}, ${tableName(n)}: only the player whose turn it is may raise, at every turn of a round`, () => {
        const s = deal(n, lad);
        for (let seat = 0; seat < n; seat++) {
          expect(expectedActor(s)).toBe(seat);
          expect(raisers(s)).toEqual([seat]);
          act(s, [seat, 'play0']);
        }
        // Round 2: seat 0 won round 1 and leads again.
        expect(raisers(s)).toEqual([0]);
      });

      it(`${lad.name}, ${tableName(n)}: a raise out of turn is illegal and changes nothing`, () => {
        const s = deal(n, lad);
        for (let seat = 1; seat < n; seat++) expectIllegal(s, seat, 'raise');
        act(s, [0, 'play0']);
        // Seat 0 already played its card this turn: the turn moved on.
        expectIllegal(s, 0, 'raise');
        for (let seat = 2; seat < n; seat++) expectIllegal(s, seat, 'raise');
      });

      it(`${lad.name}, ${tableName(n)}: the player on turn may raise in the third round, before playing`, () => {
        const s = deal(n, lad, {}, SPLIT[n]);
        playRound(s, 0);
        // Round 2: seat 0 leads and loses to seat 1's two.
        playRound(s, 1);
        expect(expectedActor(s)).toBe(1);
        expect(raisers(s)).toEqual([1]);
        const ev = act(s, [1, 'raise']);
        expect(ev).toContainEqual({ t: 'raise', seat: 1, step: 1, value: lad.values[1] });
        act(s, [0, 'accept']);
        expect(expectedActor(s)).toBe(1);
        expect(legalMask(s, 1) & PLAY_MASK).not.toBe(0);
      });
    }
  }

  for (const n of TABLES) {
    it(`${tableName(n)}: the player on turn in the second round may raise before playing`, () => {
      const s = deal(n);
      playRound(s, 0);
      expect(expectedActor(s)).toBe(0);
      expect(can(s, 0, 'raise')).toBe(true);
      const ev = act(s, [0, 'raise']);
      expect(ev).toContainEqual({ t: 'raise', seat: 0, step: 1, value: 3 });
    });
  }
});

describe('raising at any time (raiseAnyTime)', () => {
  for (const lad of [PAULISTA, MINEIRO]) {
    for (const n of TABLES) {
      it(`${lad.name}, ${tableName(n)}: before any raise, every player may raise, also out of turn`, () => {
        const s = deal(n, lad, { raiseAnyTime: true });
        expect(raisers(s)).toEqual(allSeats(s));
        act(s, [0, 'play0']);
        expect(raisers(s)).toEqual(allSeats(s));
      });

      it(`${lad.name}, ${tableName(n)}: a player out of turn raises and the other team answers`, () => {
        const s = deal(n, lad, { raiseAnyTime: true });
        const raiser = n - 1; // team 1, while seat 0 is on turn
        const ev = act(s, [raiser, 'raise']);
        expect(ev).toContainEqual({ t: 'raise', seat: raiser, step: 1, value: lad.values[1] });
        expect(accepters(s)).toEqual(teamSeats(s, 0));
        expect(runners(s)).toEqual(teamSeats(s, 0));
        expect(team(expectedActor(s))).toBe(0);
      });

      it(`${lad.name}, ${tableName(n)}: a player who already played this round may still raise`, () => {
        const s = deal(n, lad, { raiseAnyTime: true });
        act(s, [0, 'play0']);
        expect(expectedActor(s)).toBe(1);
        const ev = act(s, [0, 'raise']);
        expect(ev).toContainEqual({ t: 'raise', seat: 0, step: 1, value: lad.values[1] });
        expect(accepters(s)).toEqual(teamSeats(s, 1));
      });

      it(`${lad.name}, ${tableName(n)}: after a team's raise is accepted only the other team may raise, on any turn`, () => {
        const s = deal(n, lad, { raiseAnyTime: true });
        act(s, [0, 'raise'], [1, 'accept']);
        for (let seat = 0; seat < n; seat++) {
          expect(raisers(s)).toEqual(teamSeats(s, 1));
          act(s, [seat, 'play0']);
        }
        expect(raisers(s)).toEqual(teamSeats(s, 1));
        // Now a player of team 1 raises out of turn (seat 0 leads round 2) and it is accepted.
        act(s, [n - 1, 'raise'], [0, 'accept']);
        expect(raisers(s)).toEqual(teamSeats(s, 0));
      });
    }
  }

  it('2 against 2: while a raise is pending, neither the raiser nor the partner can raise', () => {
    const s = deal(4, PAULISTA, { raiseAnyTime: true });
    act(s, [0, 'raise']);
    expectIllegal(s, 0, 'raise');
    expectIllegal(s, 2, 'raise');
    expect(raisers(s)).toEqual([1, 3]);
  });

  for (const n of TABLES) {
    it(`${tableName(n)}: in the third round a player who has no card left may still raise out of turn`, () => {
      // SPLIT: seat 1 wins round 2, leads round 3 and plays its last card first.
      const s = deal(n, PAULISTA, { raiseAnyTime: true }, SPLIT[n]);
      playRound(s, 0);
      playRound(s, 1);
      act(s, [1, 'play2']);
      expect(s.hand.cards[1].every((c) => c < 0)).toBe(true);
      expect(expectedActor(s)).not.toBe(1);
      expect(can(s, 1, 'raise')).toBe(true);
      const ev = act(s, [1, 'raise']);
      expect(ev).toContainEqual({ t: 'raise', seat: 1, step: 1, value: 3 });
      expect(accepters(s)).toEqual(teamSeats(s, 0));
    });
  }
});

describe('bets belong to one hand', () => {
  for (const n of TABLES) {
    it(`${tableName(n)}: the next hand starts at step 0 and both teams may raise again`, () => {
      for (const anyTime of [false, true]) {
        const s = deal(n, PAULISTA, { raiseAnyTime: anyTime });
        act(s, [0, 'raise'], [1, 'accept']);
        playRound(s, 0);
        handEvent(playRound(s, 1));
        expect(s.score).toEqual([3, 0]);
        expect(s.hand.step).toBe(0);
        expect(s.hand.value).toBe(1);
        expect(s.hand.phase).toBe('play');
        expect(raisers(s)).toEqual(anyTime ? allSeats(s) : [expectedActor(s)]);
      }
    });
  }
});

describe('teams alternate', () => {
  for (const lad of [PAULISTA, MINEIRO]) {
    for (const n of TABLES) {
      it(`${lad.name}, ${tableName(n)}: after a team's raise is accepted, that team cannot raise on its turns but the other team can`, () => {
        const s = deal(n, lad);
        act(s, [0, 'raise'], [1, 'accept']);
        // Seat 0 is still on turn but its team made the last accepted raise.
        expect(expectedActor(s)).toBe(0);
        expect(raisers(s)).toEqual([]);
        expectIllegal(s, 0, 'raise');
        for (let seat = 0; seat < n; seat++) {
          expect(raisers(s)).toEqual(team(seat) === 1 ? [seat] : []);
          act(s, [seat, 'play0']);
        }
        // Round 2, seat 0 leads: still no raise for team 0.
        expect(raisers(s)).toEqual([]);
        act(s, [0, 'play1']);
        expect(raisers(s)).toEqual([1]);
        act(s, [1, 'raise'], [0, 'accept']);
        expect(s.hand.step).toBe(2);
      });

      it(`${lad.name}, ${tableName(n)}: after a raise again is accepted, the team that raised again may not raise next, the other may`, () => {
        const s = deal(n, lad);
        act(s, [0, 'raise'], [1, 'raise'], [0, 'accept']);
        expect(s.hand.step).toBe(2);
        // The last accepted raise came from team 1, so seat 0 (on turn) may raise to step 3.
        expect(expectedActor(s)).toBe(0);
        expect(raisers(s)).toEqual([0]);
        act(s, [0, 'play0']);
        // Seat 1 (team 1) is on turn and may not raise.
        expect(raisers(s)).toEqual([]);
        expectIllegal(s, 1, 'raise');
      });
    }
  }
});

describe('no skipping and the cap at 12', () => {
  for (const lad of LADDERS) {
    for (const n of TABLES) {
      it(`${lad.name}, ${tableName(n)}: accepted raises climb one step at a time up to 12 and the hand is worth the last accepted value`, () => {
        const s = deal(n, lad);
        const events: GameEvent[] = [];
        CLIMB[n].forEach(({ raiser, answerer, play }, i) => {
          const k = i + 1;
          expect(expectedActor(s)).toBe(raiser);
          const r = act(s, [raiser, 'raise']);
          expect(r).toEqual([{ t: 'raise', seat: raiser, step: k, value: lad.values[k] }]);
          // Not yet accepted: the hand is still worth the previous step.
          expect(s.hand.step).toBe(k - 1);
          expect(s.hand.value).toBe(lad.values[k - 1]);
          const a = act(s, [answerer, 'accept']);
          expect(a).toEqual([{ t: 'accept', seat: answerer, step: k, value: lad.values[k] }]);
          expect(s.hand.step).toBe(k);
          expect(s.hand.value).toBe(lad.values[k]);
          // After acceptance, the player whose turn it was still plays.
          expect(expectedActor(s)).toBe(raiser);
          events.push(...act(s, [raiser, play]));
        });
        // TEAM0_WINS gives rounds 1 and 2 to team 0. In 1 against 1 the climb already played
        // both rounds; in 2 against 2 it played round 1.
        if (n === 4) events.push(...playRound(s, 1));
        expect(handEvent(events)).toMatchObject({ winner: 0, points: lad.values[4], reason: 'rounds' });
      });

      it(`${lad.name}, ${tableName(n)}: after 12 is accepted nobody may raise for the rest of the hand`, () => {
        const s = deal(n, lad);
        CHAINS[n][0].forEach((seat) => act(s, [seat, 'raise']));
        act(s, [nextOpponent(s, CHAINS[n][0][3]), 'accept']);
        expect(s.hand.value).toBe(12);
        for (let seat = 0; seat < n; seat++) {
          expect(raisers(s)).toEqual([]);
          act(s, [seat, 'play0']);
        }
        expect(raisers(s)).toEqual([]);
        expectIllegal(s, 0, 'raise');
      });

      it(`${lad.name}, ${tableName(n)}: with raiseAnyTime, after 12 is accepted nobody may raise either`, () => {
        const s = deal(n, lad, { raiseAnyTime: true });
        CHAINS[n][0].forEach((seat) => act(s, [seat, 'raise']));
        act(s, [nextOpponent(s, CHAINS[n][0][3]), 'accept']);
        for (let seat = 0; seat < n; seat++) {
          expect(raisers(s)).toEqual([]);
          act(s, [seat, 'play0']);
        }
        expect(raisers(s)).toEqual([]);
        for (let seat = 0; seat < n; seat++) expectIllegal(s, seat, 'raise');
      });

      it(`${lad.name}, ${tableName(n)}: while 12 is pending the answering team may accept or run but not raise again`, () => {
        const s = deal(n, lad);
        const chain = CHAINS[n][0];
        chain.forEach((seat) => act(s, [seat, 'raise']));
        const answering = teamSeats(s, 1 - team(chain[3]));
        expect(accepters(s)).toEqual(answering);
        expect(runners(s)).toEqual(answering);
        expect(raisers(s)).toEqual([]);
        for (const seat of answering) expectIllegal(s, seat, 'raise');
      });
    }
  }
});

describe('a pending raise freezes the play', () => {
  for (const lad of [PAULISTA, MINEIRO]) {
    for (const n of TABLES) {
      it(`${lad.name}, ${tableName(n)}: while a raise waits for an answer nobody can play a card, face up or down`, () => {
        const s = deal(n, lad);
        act(s, [0, 'raise']);
        for (const seat of allSeats(s)) expect(legalMask(s, seat) & (PLAY_MASK | COVER_MASK)).toBe(0);
        for (const seat of allSeats(s)) expectIllegal(s, seat, 'play0');
        // A raise again keeps the play frozen.
        act(s, [1, 'raise']);
        for (const seat of allSeats(s)) expect(legalMask(s, seat) & (PLAY_MASK | COVER_MASK)).toBe(0);
        expectIllegal(s, 0, 'play0');
      });

      it(`${lad.name}, ${tableName(n)}: in the second round a pending raise also blocks the face-down card`, () => {
        const s = deal(n, lad);
        playRound(s, 0);
        expect(can(s, 0, 'cover1')).toBe(true);
        act(s, [0, 'raise']);
        expectIllegal(s, 0, 'cover1');
        expectIllegal(s, 0, 'play1');
        act(s, [1, 'accept']);
        expect(can(s, 0, 'cover1')).toBe(true);
      });

      it(`${lad.name}, ${tableName(n)}: with raiseAnyTime an out-of-turn raise stops the player on turn from playing`, () => {
        const s = deal(n, lad, { raiseAnyTime: true });
        act(s, [1, 'raise']);
        expect(legalMask(s, 0) & (PLAY_MASK | COVER_MASK)).toBe(0);
        expectIllegal(s, 0, 'play0');
      });

      it(`${lad.name}, ${tableName(n)}: expectedActor during a pending raise is a player of the other team`, () => {
        const s = deal(n, lad);
        act(s, [0, 'raise']);
        expect(team(expectedActor(s))).toBe(1);
        expect(legalMask(s, expectedActor(s)) & ANSWER).toBe(ANSWER);
        act(s, [expectedActor(s), 'raise']);
        expect(team(expectedActor(s))).toBe(0);
        expect(legalMask(s, expectedActor(s)) & ANSWER).toBe(ANSWER);
        act(s, [expectedActor(s), 'accept']);
        expect(expectedActor(s)).toBe(0);
      });
    }
  }

  it('2 against 2: expectedActor during a mid-round raise is an opponent of the raiser', () => {
    const s = deal(4);
    act(s, [0, 'play0'], [1, 'raise']);
    expect(team(expectedActor(s))).toBe(0);
  });

  it('2 against 2, raiseAnyTime: expectedActor during an out-of-turn raise is an opponent of the raiser', () => {
    for (const raiser of [1, 2, 3]) {
      const s = deal(4, PAULISTA, { raiseAnyTime: true });
      act(s, [raiser, 'raise']);
      expect(team(expectedActor(s))).toBe(1 - team(raiser));
    }
  });

  for (const lad of [PAULISTA, MINEIRO]) {
    it(`${lad.name}, 2 against 2: while a raise waits for an answer nobody can signal; signals come back after the answer`, () => {
      const s = deal(4, lad);
      expect(can(s, 1, 'signal:zap')).toBe(true);
      expect(can(s, 2, 'signal:nada')).toBe(true);
      act(s, [0, 'raise']);
      for (const seat of allSeats(s)) expect(legalMask(s, seat) & SIGNAL_MASK).toBe(0);
      expectIllegal(s, 1, 'signal:zap');
      expectIllegal(s, 2, 'signal:nada');
      expectIllegal(s, 0, 'signal:tres');
      act(s, [3, 'raise']);
      for (const seat of allSeats(s)) expect(legalMask(s, seat) & SIGNAL_MASK).toBe(0);
      act(s, [2, 'accept']);
      expect(can(s, 1, 'signal:zap')).toBe(true);
      expect(can(s, 2, 'signal:nada')).toBe(true);
    });
  }
});

describe('answering a raise', () => {
  for (const n of TABLES) {
    it(`${tableName(n)}: accept and run are illegal when no raise is pending`, () => {
      const s = deal(n);
      for (const seat of allSeats(s)) {
        expect(legalMask(s, seat) & ANSWER).toBe(0);
        expectIllegal(s, seat, 'accept');
        expectIllegal(s, seat, 'run');
      }
      act(s, [0, 'raise'], [1, 'accept']);
      for (const seat of allSeats(s)) expect(legalMask(s, seat) & ANSWER).toBe(0);
      expectIllegal(s, 0, 'accept');
      expectIllegal(s, 1, 'run');
    });

    it(`${tableName(n)}: the raiser cannot answer their own raise`, () => {
      const s = deal(n);
      act(s, [0, 'raise']);
      expect(legalMask(s, 0) & (ANSWER | RAISE)).toBe(0);
      expectIllegal(s, 0, 'accept');
      expectIllegal(s, 0, 'run');
      expectIllegal(s, 0, 'raise');
    });
  }

  it('1 against 1: the opponent may accept, run or raise again', () => {
    const s = deal(2);
    act(s, [0, 'raise']);
    expect(legalMask(s, 1) & (ANSWER | RAISE)).toBe(ANSWER | RAISE);
  });

  for (const lad of [PAULISTA, MINEIRO]) {
    for (const answerer of [1, 3]) {
      const other = answerer === 1 ? 3 : 1;
      it(`${lad.name}, 2 against 2: seat ${answerer} may accept for its team and then the first answer counts`, () => {
        const s = deal(4, lad);
        act(s, [0, 'raise']);
        expect(accepters(s)).toEqual([1, 3]);
        expect(runners(s)).toEqual([1, 3]);
        const ev = act(s, [answerer, 'accept']);
        expect(ev).toContainEqual({ t: 'accept', seat: answerer, step: 1, value: lad.values[1] });
        expect(s.hand.value).toBe(lad.values[1]);
        expect(legalMask(s, other) & ANSWER).toBe(0);
        expectIllegal(s, other, 'accept');
        expectIllegal(s, other, 'run');
        expect(expectedActor(s)).toBe(0);
      });

      it(`${lad.name}, 2 against 2: seat ${answerer} may run for its team`, () => {
        const s = deal(4, lad);
        act(s, [0, 'raise']);
        const ev = act(s, [answerer, 'run']);
        expect(ev).toContainEqual({ t: 'run', seat: answerer });
        expect(handEvent(ev)).toMatchObject({ winner: 0, points: lad.values[0], reason: 'run' });
        expect(s.score).toEqual([lad.values[0], 0]);
      });

      it(`${lad.name}, 2 against 2: seat ${answerer} may raise again, and then its partner cannot answer`, () => {
        const s = deal(4, lad);
        act(s, [0, 'raise']);
        const ev = act(s, [answerer, 'raise']);
        expect(ev).toContainEqual({ t: 'raise', seat: answerer, step: 2, value: lad.values[2] });
        expect(legalMask(s, other) & (ANSWER | RAISE)).toBe(0);
        expectIllegal(s, other, 'accept');
        expectIllegal(s, other, 'run');
        expectIllegal(s, other, 'raise');
        expect(accepters(s)).toEqual([0, 2]);
      });
    }

    it(`${lad.name}, 2 against 2: the raiser's partner cannot accept, run or raise again`, () => {
      const s = deal(4, lad);
      act(s, [0, 'raise']);
      expect(legalMask(s, 2) & (ANSWER | RAISE)).toBe(0);
      expectIllegal(s, 2, 'accept');
      expectIllegal(s, 2, 'run');
      expectIllegal(s, 2, 'raise');
    });

    it(`${lad.name}, 2 against 2: the raiser's partner cannot answer a mid-round raise either`, () => {
      const s = deal(4, lad);
      act(s, [0, 'play0'], [1, 'raise']);
      expect(accepters(s)).toEqual([0, 2]);
      expect(legalMask(s, 3) & (ANSWER | RAISE)).toBe(0);
      expectIllegal(s, 3, 'accept');
      expectIllegal(s, 3, 'run');
    });

    it(`${lad.name}, 2 against 2: after a run, the other opponent can no longer answer`, () => {
      const s = deal(4, lad);
      act(s, [0, 'raise'], [1, 'run']);
      // A new hand was dealt with no pending bet.
      expect(legalMask(s, 3) & ANSWER).toBe(0);
      expectIllegal(s, 3, 'accept');
      expectIllegal(s, 3, 'run');
      expect(s.score).toEqual([lad.values[0], 0]);
    });

    it(`${lad.name}, 2 against 2, raiseAnyTime: an out-of-turn raise is answered by either opponent, never by the raiser's partner`, () => {
      const s = deal(4, lad, { raiseAnyTime: true });
      act(s, [3, 'raise']);
      expect(accepters(s)).toEqual([0, 2]);
      expect(runners(s)).toEqual([0, 2]);
      expect(legalMask(s, 1) & (ANSWER | RAISE)).toBe(0);
      expectIllegal(s, 1, 'accept');
      act(s, [2, 'accept']);
      expect(legalMask(s, 0) & ANSWER).toBe(0);
      expectIllegal(s, 0, 'accept');
    });
  }
});

describe('accept: the hand takes the new value and the player on turn still plays', () => {
  for (const lad of LADDERS) {
    for (const n of TABLES) {
      for (let k = 1; k <= 4; k++) {
        it(`${lad.name}, ${tableName(n)}: a hand accepted at step ${k} is worth ${lad.values[k]} to the team that wins it`, () => {
          const s = deal(n, lad);
          const chain = CHAINS[n][0];
          for (let i = 0; i < k; i++) act(s, [chain[i], 'raise']);
          const answerer = nextOpponent(s, chain[k - 1]);
          const ev = act(s, [answerer, 'accept']);
          expect(ev).toContainEqual({ t: 'accept', seat: answerer, step: k, value: lad.values[k] });
          expect(s.hand.step).toBe(k);
          expect(s.hand.value).toBe(lad.values[k]);
          expect(expectedActor(s)).toBe(0);
          playRound(s, 0);
          const h = handEvent(playRound(s, 1));
          expect(h).toMatchObject({ winner: 0, points: lad.values[k], reason: 'rounds' });
        });
      }
    }
  }

  for (const n of TABLES) {
    it(`${tableName(n)}: after the opponent accepts, the raiser on turn plays and nobody else can`, () => {
      for (const answerer of teamSeats(deal(n), 1)) {
        const s = deal(n);
        act(s, [0, 'raise'], [answerer, 'accept']);
        expect(expectedActor(s)).toBe(0);
        expect(legalMask(s, 0) & PLAY_MASK).not.toBe(0);
        for (let seat = 1; seat < n; seat++) expect(legalMask(s, seat) & PLAY_MASK).toBe(0);
        const ev = act(s, [0, 'play0']);
        expect(ev[0]).toMatchObject({ t: 'play', seat: 0 });
        expect(expectedActor(s)).toBe(1);
      }
    });

    it(`${tableName(n)}: after a chain of raises again is accepted, the player whose turn it was plays`, () => {
      for (const chain of CHAINS[n]) {
        for (let k = 2; k <= 4; k++) {
          const s = deal(n);
          for (let i = 0; i < k; i++) act(s, [chain[i], 'raise']);
          act(s, [nextOpponent(s, chain[k - 1]), 'accept']);
          expect(expectedActor(s)).toBe(0);
          expect(legalMask(s, 0) & PLAY_MASK).not.toBe(0);
        }
      }
    });

    it(`${tableName(n)}, raiseAnyTime: after an out-of-turn raise is accepted, the player on turn plays`, () => {
      for (let raiser = 1; raiser < n; raiser++) {
        const s = deal(n, PAULISTA, { raiseAnyTime: true });
        act(s, [raiser, 'raise'], [nextOpponent(s, raiser), 'accept']);
        expect(expectedActor(s)).toBe(0);
        expect(legalMask(s, 0) & PLAY_MASK).not.toBe(0);
        for (let seat = 1; seat < n; seat++) expect(legalMask(s, seat) & PLAY_MASK).toBe(0);
      }
    });

    it(`${tableName(n)}, raiseAnyTime: a raise by a player who already played does not take the turn away`, () => {
      const s = deal(n, PAULISTA, { raiseAnyTime: true });
      act(s, [0, 'play0'], [0, 'raise'], [1, 'accept']);
      expect(expectedActor(s)).toBe(1);
      expect(legalMask(s, 1) & PLAY_MASK).not.toBe(0);
      expect(legalMask(s, 0) & PLAY_MASK).toBe(0);
    });
  }

  it('2 against 2: a mid-round raise accepted by either opponent leaves the raiser on turn', () => {
    for (const answerer of [0, 2]) {
      const s = deal(4);
      act(s, [0, 'play0'], [1, 'raise'], [answerer, 'accept']);
      expect(expectedActor(s)).toBe(1);
      expect(legalMask(s, 1) & PLAY_MASK).not.toBe(0);
      act(s, [1, 'play0']);
      expect(expectedActor(s)).toBe(2);
    }
  });
});

describe('run: the raising team scores the value before the raise', () => {
  for (const lad of LADDERS) {
    for (const n of TABLES) {
      for (let k = 1; k <= 4; k++) {
        it(`${lad.name}, ${tableName(n)}: running from a raise again to step ${k} gives the raisers ${lad.values[k - 1]}`, () => {
          for (const chain of CHAINS[n]) {
            const s = deal(n, lad);
            for (let i = 0; i < k; i++) act(s, [chain[i], 'raise']);
            const raiser = chain[k - 1];
            const runner = nextOpponent(s, raiser);
            const ev = act(s, [runner, 'run']);
            expect(ev).toContainEqual({ t: 'run', seat: runner });
            const h = handEvent(ev);
            expect(h).toMatchObject({ winner: team(raiser), points: lad.values[k - 1], reason: 'run' });
            const expected: [number, number] = [0, 0];
            expected[team(raiser)] = lad.values[k - 1];
            expect(s.score).toEqual(expected);
            expect(h.score).toEqual(expected);
          }
        });

        it(`${lad.name}, ${tableName(n)}: running from a raise to step ${k} after accepted raises gives the raisers ${lad.values[k - 1]}`, () => {
          const s = deal(n, lad);
          const climb = CLIMB[n];
          for (let i = 0; i < k - 1; i++) act(s, [climb[i].raiser, 'raise'], [climb[i].answerer, 'accept'], [climb[i].raiser, climb[i].play]);
          const { raiser, answerer } = climb[k - 1];
          const ev = act(s, [raiser, 'raise'], [answerer, 'run']);
          const h = handEvent(ev);
          expect(h).toMatchObject({ winner: team(raiser), points: lad.values[k - 1], reason: 'run' });
          const expected: [number, number] = [0, 0];
          expected[team(raiser)] = lad.values[k - 1];
          expect(s.score).toEqual(expected);
        });
      }

      it(`${lad.name}, ${tableName(n)}: a run ends the hand and the next hand starts again at step 0`, () => {
        const s = deal(n, lad);
        const before = s.handIndex;
        act(s, [0, 'raise'], [1, 'raise'], [0, 'run']);
        expect(s.handIndex).toBe(before + 1);
        expect(s.history).toHaveLength(1);
        expect(s.history[0].result).toEqual({ winner: 1, points: lad.values[1], reason: 'run' });
        expect(s.hand.phase).toBe('play');
        expect(s.hand.step).toBe(0);
        expect(s.hand.value).toBe(lad.values[0]);
        expect(s.hand.rounds.flatMap((r) => r.plays)).toEqual([]);
        for (const seat of allSeats(s)) expect(legalMask(s, seat) & ANSWER).toBe(0);
      });

      it(`${lad.name}, ${tableName(n)}: the raisers score on a run even when the other team won the rounds so far`, () => {
        // SPLIT: team 1 wins round 2 and seat 1 leads round 3; team 0 raises in round 3 and team 1 runs.
        const s = deal(n, lad, {}, SPLIT[n]);
        playRound(s, 0);
        playRound(s, 1);
        expect(expectedActor(s)).toBe(1);
        act(s, [1, 'play2']);
        // In 2 against 2 seat 2 (team 0) is next; in 1 against 1 seat 0 is next.
        const raiser = n === 4 ? 2 : 0;
        expect(expectedActor(s)).toBe(raiser);
        const ev = act(s, [raiser, 'raise'], [nextOpponent(s, raiser), 'run']);
        expect(handEvent(ev)).toMatchObject({ winner: 0, points: lad.values[0], reason: 'run' });
      });
    }
  }
});

describe('raise again', () => {
  for (const lad of LADDERS) {
    for (const n of TABLES) {
      it(`${lad.name}, ${tableName(n)}: raises again chain up to 12 with the right team answering each step`, () => {
        for (const chain of CHAINS[n]) {
          const s = deal(n, lad);
          chain.forEach((raiser, i) => {
            const k = i + 1;
            const ev = act(s, [raiser, 'raise']);
            expect(ev).toContainEqual({ t: 'raise', seat: raiser, step: k, value: lad.values[k] });
            expect(ev.filter((e) => e.t === 'raise')).toHaveLength(1);
            // Raise again accepts the pending step: the hand is now worth step k - 1.
            expect(s.hand.step).toBe(k - 1);
            expect(s.hand.value).toBe(lad.values[k - 1]);
            const answering = teamSeats(s, 1 - team(raiser));
            expect(accepters(s)).toEqual(answering);
            expect(runners(s)).toEqual(answering);
            // Raising again is possible only while the next step is at most 4.
            expect(raisers(s)).toEqual(k < 4 ? answering : []);
            for (const seat of teamSeats(s, team(raiser))) expect(legalMask(s, seat) & (ANSWER | RAISE)).toBe(0);
            expect(team(expectedActor(s))).toBe(1 - team(raiser));
          });
          const answerer = nextOpponent(s, chain[3]);
          const ev = act(s, [answerer, 'accept']);
          expect(ev).toContainEqual({ t: 'accept', seat: answerer, step: 4, value: 12 });
          expect(s.hand.value).toBe(12);
        }
      });
    }
  }

  for (const lad of [PAULISTA, MINEIRO]) {
    it(`${lad.name}, 2 against 2: after a raise again, the original raiser may answer it`, () => {
      for (const reraiser of [1, 3]) {
        const s = deal(4, lad);
        act(s, [0, 'raise'], [reraiser, 'raise']);
        expect(accepters(s)).toEqual([0, 2]);
        const ev = act(s, [0, 'accept']);
        expect(ev).toContainEqual({ t: 'accept', seat: 0, step: 2, value: lad.values[2] });
        expect(s.hand.value).toBe(lad.values[2]);
      }
    });

    it(`${lad.name}, 2 against 2: after a raise again, the original raiser's partner may answer it`, () => {
      const s = deal(4, lad);
      act(s, [0, 'raise'], [3, 'raise']);
      const ev = act(s, [2, 'run']);
      expect(handEvent(ev)).toMatchObject({ winner: 1, points: lad.values[1], reason: 'run' });
    });

    it(`${lad.name}, 1 against 1: the original raiser answers a raise again`, () => {
      const s = deal(2, lad);
      act(s, [0, 'raise'], [1, 'raise']);
      expect(accepters(s)).toEqual([0]);
      expect(raisers(s)).toEqual([0]);
      expect(legalMask(s, 1) & (ANSWER | RAISE)).toBe(0);
      act(s, [0, 'accept']);
      expect(s.hand.value).toBe(lad.values[2]);
    });
  }

  for (const n of TABLES) {
    it(`${tableName(n)}, raiseAnyTime: raise again works the same after an out-of-turn raise`, () => {
      const s = deal(n, PAULISTA, { raiseAnyTime: true });
      const raiser = n - 1;
      act(s, [raiser, 'raise']);
      const ev = act(s, [0, 'raise']);
      expect(ev).toContainEqual({ t: 'raise', seat: 0, step: 2, value: 6 });
      expect(accepters(s)).toEqual(teamSeats(s, 1));
      act(s, [raiser, 'accept']);
      expect(s.hand.value).toBe(6);
      expect(expectedActor(s)).toBe(0);
      // The last accepted raise came from team 0.
      expect(raisers(s)).toEqual(teamSeats(s, 1));
    });
  }
});

describe('raises exist only in normal hands', () => {
  for (const lad of [PAULISTA, MINEIRO]) {
    const threshold = lad.variant === 'paulista' ? 11 : 10;
    for (const n of TABLES) {
      it(`${lad.name}, ${tableName(n)}: nobody may raise in a mão de ${threshold === 11 ? 'onze' : 'dez'}, even with raiseAnyTime`, () => {
        const s = rig({ variant: lad.variant, players: n, options: { raiseAnyTime: true }, cards: TEAM0_WINS[n], score: [threshold, 0] });
        expect(raisers(s)).toEqual([]);
        act(s, [0, 'accept']);
        expect(raisers(s)).toEqual([]);
        expectIllegal(s, 0, 'raise');
        expectIllegal(s, 1, 'raise');
      });

      it(`${lad.name}, ${tableName(n)}: nobody may raise in a mão de ferro, but with ironHand 'normal' the hand has bets`, () => {
        const iron = rig({ variant: lad.variant, players: n, options: { raiseAnyTime: true }, cards: TEAM0_WINS[n], score: [threshold, threshold] });
        expect(raisers(iron)).toEqual([]);
        const normal = rig({ variant: lad.variant, players: n, options: { ironHand: 'normal' }, cards: TEAM0_WINS[n], score: [threshold, threshold] });
        expect(raisers(normal)).toEqual([0]);
        const ev = act(normal, [0, 'raise']);
        expect(ev).toContainEqual({ t: 'raise', seat: 0, step: 1, value: lad.values[1] });
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------
// The public record of bets (engine/src/public.ts reads it)

describe('public record of bets', () => {
  it('truco, accept, raise, raise again and run give the exact list', () => {
    const s = deal(2);
    act(s, [0, 'raise'], [1, 'accept'], [0, 'play0'], [1, 'raise'], [0, 'raise'], [1, 'run']);
    expect(s.history).toHaveLength(1);
    const h = s.history[0];
    expect(h.result.reason).toBe('run');
    expect(h.bets).toEqual([
      { seat: 0, kind: 'raise', step: 1, answer: false, round: 0, played: 0 },
      { seat: 1, kind: 'accept', step: 1, answer: true, round: 0, played: 0 },
      { seat: 1, kind: 'raise', step: 2, answer: false, round: 0, played: 1 },
      { seat: 0, kind: 'raise', step: 3, answer: true, round: 0, played: 1 },
      { seat: 1, kind: 'run', step: 3, answer: true, round: 0, played: 1 },
    ]);
    // step: one accept plus one raise in answer.
    expect(h.step).toBe(2);
    // The next hand starts with an empty record.
    expect(s.hand.bets).toEqual([]);
  });

  it('a raise in a later round records the round and the cards already on the table', () => {
    const s = deal(4);
    playRound(s, 0);
    act(s, [0, 'play1'], [1, 'raise'], [2, 'accept']);
    expect(s.hand.bets).toEqual([
      { seat: 1, kind: 'raise', step: 1, answer: false, round: 1, played: 1 },
      { seat: 2, kind: 'accept', step: 1, answer: true, round: 1, played: 1 },
    ]);
  });

  it('mão de onze: playing and running are recorded with step 0', () => {
    const play = rig({ cards: TEAM0_WINS[2], score: [11, 0] });
    act(play, [0, 'accept']);
    expect(play.hand.bets).toEqual([{ seat: 0, kind: 'onzePlay', step: 0, answer: false, round: 0, played: 0 }]);
    const run = rig({ cards: TEAM0_WINS[2], score: [11, 0] });
    act(run, [0, 'run']);
    expect(run.history[0].bets).toEqual([{ seat: 0, kind: 'onzeRun', step: 0, answer: false, round: 0, played: 0 }]);
    expect(run.history[0].result.reason).toBe('onzeRun');
  });

  it('setHandCards refuses a hand that already has a bet', () => {
    const s = deal(2);
    act(s, [0, 'raise'], [1, 'accept']);
    expect(() => setHandCards(s, [parseCards('3c 3h 3s'), parseCards('4s 5s 7s')], parseCard('5d'))).toThrow();
  });
});
