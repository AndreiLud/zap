// Rule tests for the mão de onze (paulista) and mão de dez (mineiro), the mão de ferro, three tied
// rounds and the end of a game or match. Expected values come from project_docs/rules.md.

import { describe, expect, it } from 'vitest';
import {
  HIDDEN,
  IllegalActionError,
  TIE,
  applyAction,
  eventsFor,
  expectedActor,
  legalActions,
  legalMask,
  makeConfig,
  newMatch,
  observe,
  parseAction,
  parseCards,
  parseCard,
  setHandCards,
  type GameEvent,
  type MatchState,
  type RuleOptions,
  type Variant,
} from '../../src/index.ts';
import { SEED, act, rig } from '../helpers.ts';

// ---------------------------------------------------------------------------------------------
// Values from the rules table, written out instead of read from the engine.

const RULE = {
  paulista: { threshold: 11, onzeValue: 3, onzeRun: 1, start: 1, truco: 3 },
  mineiro: { threshold: 10, onzeValue: 4, onzeRun: 2, start: 2, truco: 4 },
} as const;

const VARIANTS: Variant[] = ['paulista', 'mineiro'];
const SIZES: (2 | 4)[] = [2, 4];
const SIZE_NAME = { 2: '1 against 1', 4: '2 against 2' } as const;

const ACCEPT = parseAction('accept');
const RUN = parseAction('run');
const PLAY_BITS = 0b111;
const COVER_BITS = 0b111 << parseAction('cover0');
const SIGNAL_BITS = 0b111111 << parseAction('signal:zap');

// ---------------------------------------------------------------------------------------------
// Card sets

/** Two manilhas and a three: wins the first two rounds against the weak hands below. */
const STRONG = { paulista: '6c 6h 3d', mineiro: '4c 7h 3d' } as const;
/** No manilha (paulista with the default vira 5d, so sixes are manilhas; mineiro fixed manilhas). */
const WEAK = {
  paulista: ['4d 4s 5s', '4h 4c 5h', '5c 7d 7s'],
  mineiro: ['5d 5s 6s', '5h 6h Qd', '5c 6c Qs'],
} as const;

/** Cards where the strong hand sits at `strongSeat` and every other seat holds a weak hand. */
function decisive(variant: Variant, players: 2 | 4, strongSeat: number): string[] {
  const out: string[] = [];
  let w = 0;
  for (let seat = 0; seat < players; seat++) out.push(seat === strongSeat ? STRONG[variant] : WEAK[variant][w++]);
  return out;
}

/** Same ranks for every seat in every slot: each round ties (shared by both teams). */
const TIE_CARDS = ['5d 6d Qd', '5s 6s Qs', '5h 6h Qh', '5c 6c Qc'];
/** Vira for the tie set in paulista: manilhas are the aces, so 5, 6 and Q stay plain. */
const TIE_VIRA = 'Kd';

// ---------------------------------------------------------------------------------------------
// Helpers

interface Setup {
  variant: Variant;
  players: 2 | 4;
  score?: [number, number];
  games?: [number, number];
  dealer?: number;
  options?: Partial<RuleOptions>;
}

/** A match where the strong hand sits at `strongSeat`. */
function decisiveMatch(o: Setup, strongSeat: number): MatchState {
  return rig({ ...o, cards: decisive(o.variant, o.players, strongSeat) });
}

/** A match where all three rounds tie. */
function tieMatch(o: Setup): MatchState {
  return rig({ ...o, cards: TIE_CARDS.slice(0, o.players), vira: o.variant === 'paulista' ? TIE_VIRA : undefined });
}

/** Re-rigs the current (fresh) hand of an existing match. */
function rigHand(s: MatchState, cards: string[], vira?: string): void {
  const v = s.config.variant === 'paulista' ? parseCard(vira ?? '5d') : -1;
  setHandCards(s, cards.map(parseCards), v);
}

function can(s: MatchState, seat: number, name: string): boolean {
  return ((legalMask(s, seat) >> parseAction(name)) & 1) === 1;
}

function seats(s: MatchState): number[] {
  return [...Array(s.n).keys()];
}

/** Every seat plays the card in `slot` face up, starting from `leader`. */
function playRound(s: MatchState, leader: number, slot: number, ev: GameEvent[] = []): GameEvent[] {
  for (let i = 0; i < s.n; i++) applyAction(s, (leader + i) % s.n, parseAction(`play${slot}`), ev);
  return ev;
}

/**
 * Plays a decisive hand from `decisive()` with the mão at seat `mao`: the strong seat wins the first
 * two rounds. Returns the events.
 */
function playDecisive(s: MatchState, mao: number, strongSeat: number): GameEvent[] {
  const ev: GameEvent[] = [];
  playRound(s, mao, 0, ev);
  playRound(s, strongSeat, 1, ev);
  return ev;
}

/** Plays the three tied rounds of `tieMatch()`. After each tie the mão leads again. */
function playAllTied(s: MatchState, mao: number): GameEvent[] {
  const ev: GameEvent[] = [];
  for (let slot = 0; slot < 3; slot++) playRound(s, mao, slot, ev);
  return ev;
}

function handEvent(ev: GameEvent[]): Extract<GameEvent, { t: 'hand' }> {
  const e = ev.find((x) => x.t === 'hand');
  if (!e || e.t !== 'hand') throw new Error('no hand event');
  return e;
}

function eventsOf<T extends GameEvent['t']>(ev: GameEvent[], t: T): Extract<GameEvent, { t: T }>[] {
  return ev.filter((x) => x.t === t) as Extract<GameEvent, { t: T }>[];
}

function expectIllegal(s: MatchState, seat: number, name: string): void {
  const before = JSON.stringify(s);
  expect(() => applyAction(s, seat, parseAction(name))).toThrow(IllegalActionError);
  expect(JSON.stringify(s)).toBe(before);
}

/** Nobody may raise, checked for every seat. */
function expectNoRaise(s: MatchState): void {
  for (const seat of seats(s)) expect(can(s, seat, 'raise'), `seat ${seat} may raise`).toBe(false);
}

const teamSeats = (players: 2 | 4, team: number) => (players === 2 ? [team] : [team, team + 2]);

// =============================================================================================
// Mão de onze (paulista) and mão de dez (mineiro)

describe.each(VARIANTS)('%s: hand on the threshold', (variant) => {
  const R = RULE[variant];
  const name = variant === 'paulista' ? 'mão de onze' : 'mão de dez';

  describe.each(SIZES)(`${name}, %s players`, (players) => {
    it(`a team at ${R.threshold} faces a ${name}: decision pending, worth ${R.onzeValue}`, () => {
      for (const team of [0, 1]) {
        const score: [number, number] = team === 0 ? [R.threshold, 4] : [4, R.threshold];
        const s = decisiveMatch({ variant, players, score }, 0);
        const o = observe(s, 0);
        expect(o.kind).toBe('onze');
        expect(o.onzeTeam).toBe(team);
        expect(o.phase).toBe('onze');
        expect(o.value).toBe(R.onzeValue);
      }
    });

    it(`one point below the threshold (${R.threshold - 1}) is a normal hand`, () => {
      const s = decisiveMatch({ variant, players, score: [R.threshold - 1, R.threshold - 1] }, 0);
      const o = observe(s, 0);
      expect(o.kind).toBe('normal');
      expect(o.phase).toBe('play');
      expect(o.value).toBe(R.start);
      expect(can(s, 0, 'raise')).toBe(true);
    });

    it('the decision comes before any card: nobody may play or cover a card', () => {
      const s = decisiveMatch({ variant, players, score: [R.threshold, 3] }, 0);
      for (const seat of seats(s)) expect(legalMask(s, seat) & (PLAY_BITS | COVER_BITS)).toBe(0);
      expectIllegal(s, 0, 'play0');
      expectIllegal(s, 0, 'cover0');
    });

    it('every player of the team on the threshold may play or run; the opponents have no action at all', () => {
      for (const team of [0, 1]) {
        const score: [number, number] = team === 0 ? [R.threshold, 3] : [3, R.threshold];
        const s = decisiveMatch({ variant, players, score }, 0);
        for (const seat of seats(s)) {
          if (seat % 2 === team) {
            expect(can(s, seat, 'accept'), `seat ${seat} accept`).toBe(true);
            expect(can(s, seat, 'run'), `seat ${seat} run`).toBe(true);
            expect(can(s, seat, 'raise'), `seat ${seat} raise`).toBe(false);
          } else {
            expect(legalMask(s, seat), `seat ${seat}`).toBe(0);
            expect(legalActions(s, seat)).toEqual([]);
          }
        }
        expect(expectedActor(s) % 2).toBe(team);
      }
    });

    it('the opponents cannot decide for the team on the threshold', () => {
      const s = decisiveMatch({ variant, players, score: [R.threshold, 3] }, 0);
      for (const seat of teamSeats(players, 1)) {
        expectIllegal(s, seat, 'accept');
        expectIllegal(s, seat, 'run');
      }
    });

    it(`playing makes the hand worth ${R.onzeValue}: the opponents score ${R.onzeValue} when they win it`, () => {
      const s = decisiveMatch({ variant, players, score: [R.threshold, 2] }, 1);
      const ev = act(s, [0, 'accept']);
      expect(eventsOf(ev, 'onze')).toEqual([{ t: 'onze', seat: 0, play: true }]);
      expect(observe(s, 1).phase).toBe('play');
      expect(observe(s, 1).value).toBe(R.onzeValue);
      const h = handEvent(playDecisive(s, 0, 1));
      expect(h.winner).toBe(1);
      expect(h.points).toBe(R.onzeValue);
      expect(s.score).toEqual([R.threshold, 2 + R.onzeValue]);
      expect(s.over).toBe(false);
      expect(s.history[0]).toMatchObject({ kind: 'onze', onzeTeam: 0, result: { winner: 1, points: R.onzeValue } });
    });

    it(`playing and winning gives the team on the threshold ${R.onzeValue} points and the game`, () => {
      const s = decisiveMatch({ variant, players, score: [R.threshold, 2] }, 0);
      act(s, [0, 'accept']);
      const ev = playDecisive(s, 0, 0);
      const h = handEvent(ev);
      expect(h.winner).toBe(0);
      expect(h.points).toBe(R.onzeValue);
      expect(s.over).toBe(true);
      expect(s.winner).toBe(0);
      expect(eventsOf(ev, 'match')).toEqual([{ t: 'match', winner: 0 }]);
    });

    it(`running gives the other team ${R.onzeRun} and ends the hand before any card`, () => {
      for (const team of [0, 1]) {
        const score: [number, number] = team === 0 ? [R.threshold, 4] : [4, R.threshold];
        const s = decisiveMatch({ variant, players, score }, 0);
        const decider = teamSeats(players, team)[players === 4 ? 1 : 0];
        const ev = act(s, [decider, 'run']);
        expect(eventsOf(ev, 'onze')).toEqual([{ t: 'onze', seat: decider, play: false }]);
        const h = handEvent(ev);
        expect(h.winner).toBe(1 - team);
        expect(h.points).toBe(R.onzeRun);
        expect(eventsOf(ev, 'play')).toEqual([]);
        const expected: [number, number] = team === 0 ? [R.threshold, 4 + R.onzeRun] : [4 + R.onzeRun, R.threshold];
        expect(s.score).toEqual(expected);
        expect(s.history).toHaveLength(1);
        expect(s.history[0].rounds.flatMap((r) => r.plays)).toEqual([]);
        // The team is still on the threshold: the next hand is again a mão de onze / de dez.
        expect(s.hand.index).toBe(1);
        expect(s.hand.kind).toBe('onze');
        expect(s.hand.onzeTeam).toBe(team);
      }
    });

    it('running when the other team is one hand from the threshold leads to a mão de ferro', () => {
      const other = R.threshold - R.onzeRun;
      const s = decisiveMatch({ variant, players, score: [R.threshold, other] }, 0);
      act(s, [0, 'run']);
      expect(s.score).toEqual([R.threshold, R.threshold]);
      expect(s.hand.kind).toBe('iron');
      expect(s.over).toBe(false);
    });

    it('the other team reaching 12 by winning the hand ends the game in its favor', () => {
      const other = 12 - R.onzeValue;
      const s = decisiveMatch({ variant, players, score: [R.threshold, other] }, 1);
      act(s, [0, 'accept']);
      playDecisive(s, 0, 1);
      expect(s.over).toBe(true);
      expect(s.winner).toBe(1);
      expect(s.score[1]).toBeGreaterThanOrEqual(12);
    });

    it('nobody may raise in this hand, neither the team on the threshold nor the opponents, at any moment', () => {
      for (const raiseAnyTime of [false, true]) {
        const s = decisiveMatch({ variant, players, score: [R.threshold, 3], options: { raiseAnyTime } }, 1);
        expectNoRaise(s);
        act(s, [0, 'accept']);
        expectNoRaise(s);
        for (const seat of seats(s)) expectIllegal(s, seat, 'raise');
        // Through every card of the hand.
        for (let i = 0; i < s.n; i++) {
          expectNoRaise(s);
          applyAction(s, i, parseAction('play0'));
        }
        for (let i = 0; i < s.n; i++) {
          const seat = (1 + i) % s.n;
          expectNoRaise(s);
          applyAction(s, seat, parseAction('play1'));
        }
        expect(s.score[1]).toBe(3 + R.onzeValue);
      }
    });

    it('after the decision, play and run are no longer offered and the mão opens the first round', () => {
      const s = decisiveMatch({ variant, players, score: [R.threshold, 3] }, 0);
      act(s, [0, 'accept']);
      for (const seat of seats(s)) {
        expect(can(s, seat, 'accept')).toBe(false);
        expect(can(s, seat, 'run')).toBe(false);
      }
      expect(observe(s, 0).turn).toBe(0);
      expect(expectedActor(s)).toBe(0);
      expect(legalMask(s, 0) & PLAY_BITS).toBe(PLAY_BITS);
    });

    it('a face-down card is not allowed in the first round and is allowed in the second and third', () => {
      const s = tieMatch({ variant, players, score: [R.threshold, 3] });
      act(s, [0, 'accept']);
      for (let i = 0; i < s.n; i++) {
        expect(legalMask(s, i) & COVER_BITS, `round 1 seat ${i}`).toBe(0);
        applyAction(s, i, parseAction('play0'));
      }
      expect(observe(s, 0).round).toBe(1);
      for (let i = 0; i < s.n; i++) {
        expect(legalMask(s, i) & COVER_BITS, `round 2 seat ${i}`).toBe(0b110 << parseAction('cover0'));
        applyAction(s, i, parseAction('play1'));
      }
      expect(observe(s, 0).round).toBe(2);
      for (let i = 0; i < s.n; i++) {
        expect(legalMask(s, i) & COVER_BITS, `round 3 seat ${i}`).toBe(0b100 << parseAction('cover0'));
        if (i < s.n - 1) applyAction(s, i, parseAction('cover2'));
      }
    });

    it('a face-down card in the second round keeps its identity from everyone else', () => {
      const s = tieMatch({ variant, players, score: [R.threshold, 3] });
      act(s, [0, 'accept']);
      playRound(s, 0, 0);
      const ev = act(s, [0, 'cover1']);
      const card = parseCards(TIE_CARDS[0])[1];
      expect(eventsFor(ev, 0, s.config.options)[0]).toMatchObject({ t: 'play', card, faceDown: true });
      for (const seat of seats(s).slice(1)) {
        expect(eventsFor(ev, seat, s.config.options)[0]).toMatchObject({ t: 'play', card: -1, faceDown: true });
        expect(observe(s, seat).rounds[1].plays[0]).toEqual({ seat: 0, card: -1, faceDown: true });
      }
    });

    it('with faceDownFirstRound, a face-down card is allowed in the first round except for the player who opens', () => {
      const s = decisiveMatch({ variant, players, score: [R.threshold, 3], options: { faceDownFirstRound: true } }, 0);
      act(s, [0, 'accept']);
      expect(legalMask(s, 0) & COVER_BITS).toBe(0);
      act(s, [0, 'play0']);
      expect(legalMask(s, 1) & COVER_BITS).toBe(COVER_BITS);
    });

    it('the decision is recorded in the action log and the hand replays the same way', () => {
      const s = decisiveMatch({ variant, players, score: [R.threshold, 3] }, 0);
      act(s, [0, 'run']);
      expect(s.log).toEqual([0 * 16 + RUN]);
      const t = decisiveMatch({ variant, players, score: [R.threshold, 3] }, 0);
      const seat = players - 2;
      act(t, [seat, 'accept']);
      expect(t.log).toEqual([seat * 16 + ACCEPT]);
    });
  });

  // ---- 2 against 2 only

  describe(`${name}, 2 against 2 only`, () => {
    it('either partner decides: the partner of the mão may play for the team', () => {
      const s = decisiveMatch({ variant, players: 4, score: [R.threshold, 3] }, 0);
      const ev = act(s, [2, 'accept']);
      expect(eventsOf(ev, 'onze')).toEqual([{ t: 'onze', seat: 2, play: true }]);
      expect(observe(s, 0).phase).toBe('play');
      expect(expectedActor(s)).toBe(0);
    });

    it('the first decision counts: after one partner plays, the other cannot run', () => {
      const s = decisiveMatch({ variant, players: 4, score: [R.threshold, 3] }, 0);
      act(s, [2, 'accept']);
      expectIllegal(s, 0, 'run');
      expectIllegal(s, 0, 'accept');
      expect(s.score).toEqual([R.threshold, 3]);
    });

    it('the first decision counts: when one partner runs, the hand ends at once', () => {
      const s = decisiveMatch({ variant, players: 4, score: [R.threshold, 3] }, 0);
      const ev = act(s, [0, 'run']);
      expect(handEvent(ev).points).toBe(R.onzeRun);
      expect(s.score).toEqual([R.threshold, 3 + R.onzeRun]);
      expect(s.history).toHaveLength(1);
      expect(s.history[0].result.points).toBe(R.onzeRun);
      expect(s.hand.index).toBe(1);
    });

    it('when the mão is an opponent, the mão waits for the decision and then opens the hand', () => {
      // Dealer 0: the mão is seat 1 (team 1); team 0 is on the threshold.
      const s = decisiveMatch({ variant, players: 4, score: [R.threshold, 3], dealer: 0 }, 1);
      expect(observe(s, 1).mao).toBe(1);
      expect(legalMask(s, 1)).toBe(0);
      expect(legalMask(s, 3)).toBe(0);
      expect(can(s, 0, 'accept')).toBe(true);
      expect(can(s, 2, 'accept')).toBe(true);
      act(s, [2, 'accept']);
      expect(expectedActor(s)).toBe(1);
      expect(legalMask(s, 1) & PLAY_BITS).toBe(PLAY_BITS);
    });

    it('signals are not allowed while the decision is pending, and are allowed after it', () => {
      const s = decisiveMatch({ variant, players: 4, score: [R.threshold, 3], options: { signals: 'all' } }, 0);
      for (const seat of seats(s)) expect(legalMask(s, seat) & SIGNAL_BITS, `seat ${seat}`).toBe(0);
      expectIllegal(s, 1, 'signal:nada');
      expectIllegal(s, 0, 'signal:zap');
      act(s, [0, 'accept']);
      for (const seat of seats(s)) expect(legalMask(s, seat) & SIGNAL_BITS, `seat ${seat}`).toBe(SIGNAL_BITS);
      act(s, [1, 'signal:nada']);
      expect(s.hand.signals).toHaveLength(1);
    });

    it('with onzeSeesPartner (default), the team on the threshold sees the partner cards before deciding', () => {
      const cards = decisive(variant, 4, 0);
      const s = rig({ variant, players: 4, score: [R.threshold, 3], cards });
      expect(s.config.options.onzeSeesPartner).toBe(true);
      expect(observe(s, 0).partnerHand).toEqual(parseCards(cards[2]));
      expect(observe(s, 2).partnerHand).toEqual(parseCards(cards[0]));
      expect(observe(s, 1).partnerHand).toBeNull();
      expect(observe(s, 3).partnerHand).toBeNull();
    });

    it('the opponents of the team on the threshold never see partner cards', () => {
      const cards = decisive(variant, 4, 0);
      const s = rig({ variant, players: 4, score: [3, R.threshold], cards });
      expect(observe(s, 1).partnerHand).toEqual(parseCards(cards[3]));
      expect(observe(s, 3).partnerHand).toEqual(parseCards(cards[1]));
      expect(observe(s, 0).partnerHand).toBeNull();
      expect(observe(s, 2).partnerHand).toBeNull();
    });

    it("the partner's remaining cards stay visible during the whole hand", () => {
      const cards = decisive(variant, 4, 1);
      const s = rig({ variant, players: 4, score: [R.threshold, 3], cards });
      act(s, [0, 'accept']);
      expect(observe(s, 2).partnerHand).toEqual(parseCards(cards[0]));
      act(s, [0, 'play0'], [1, 'play0']);
      const p0 = parseCards(cards[0]);
      const p2 = parseCards(cards[2]);
      // Seat 0 played its first card; seat 2 sees the two that are left.
      expect(observe(s, 2).partnerHand?.filter((c) => c >= 0)).toEqual([p0[1], p0[2]]);
      expect(observe(s, 0).partnerHand?.filter((c) => c >= 0)).toEqual(p2);
      act(s, [2, 'play0'], [3, 'play0']);
      expect(observe(s, 0).partnerHand?.filter((c) => c >= 0)).toEqual([p2[1], p2[2]]);
      expect(observe(s, 1).partnerHand).toBeNull();
      expect(observe(s, 3).partnerHand).toBeNull();
    });

    it('with onzeSeesPartner false, nobody sees the partner cards', () => {
      const s = decisiveMatch({ variant, players: 4, score: [R.threshold, 3], options: { onzeSeesPartner: false } }, 0);
      for (const seat of seats(s)) expect(observe(s, seat).partnerHand).toBeNull();
      act(s, [0, 'accept']);
      for (const seat of seats(s)) expect(observe(s, seat).partnerHand).toBeNull();
    });

    it('in a normal hand nobody sees the partner cards', () => {
      const s = decisiveMatch({ variant, players: 4, score: [R.threshold - 1, 3] }, 0);
      for (const seat of seats(s)) expect(observe(s, seat).partnerHand).toBeNull();
    });
  });

  it(`${name}, 1 against 1: there is no partner, so no partner cards are shown`, () => {
    const s = decisiveMatch({ variant, players: 2, score: [R.threshold, 3] }, 0);
    expect(observe(s, 0).partnerHand).toBeNull();
    expect(observe(s, 1).partnerHand).toBeNull();
    act(s, [0, 'accept']);
    expect(observe(s, 0).partnerHand).toBeNull();
  });
});

it('mineiro mão de dez with the mineiro8 ladder is still worth 4 and running still gives 2', () => {
  const s = decisiveMatch({ variant: 'mineiro', players: 2, score: [10, 2], options: { ladder: 'mineiro8' } }, 1);
  expect(observe(s, 0).value).toBe(4);
  act(s, [0, 'accept']);
  playDecisive(s, 0, 1);
  expect(s.score).toEqual([10, 6]);
  const t = decisiveMatch({ variant: 'mineiro', players: 2, score: [10, 2], options: { ladder: 'mineiro8' } }, 1);
  act(t, [0, 'run']);
  expect(t.score).toEqual([10, 4]);
});

// =============================================================================================
// Mão de ferro

describe.each(VARIANTS)('%s: mão de ferro (both teams on the threshold)', (variant) => {
  const R = RULE[variant];
  const both: [number, number] = [R.threshold, R.threshold];

  describe.each(SIZES)('%s players', (players) => {
    it('is a mão de ferro by default (ironHand blind), with no decision phase', () => {
      const s = decisiveMatch({ variant, players, score: both }, 0);
      expect(s.config.options.ironHand).toBe('blind');
      const o = observe(s, 0);
      expect(o.kind).toBe('iron');
      expect(o.phase).toBe('play');
      for (const seat of seats(s)) {
        expect(can(s, seat, 'accept')).toBe(false);
        expect(can(s, seat, 'run')).toBe(false);
      }
      expect(expectedActor(s)).toBe(0);
      expect(legalMask(s, 0) & PLAY_BITS).toBe(PLAY_BITS);
    });

    it('nobody sees their own cards: every slot is HIDDEN for every seat', () => {
      const s = decisiveMatch({ variant, players, score: both }, 0);
      for (const seat of seats(s)) {
        const o = observe(s, seat);
        expect(o.hand).toEqual([HIDDEN, HIDDEN, HIDDEN]);
        expect(o.partnerHand).toBeNull();
        expect(o.handCounts).toEqual(Array(players).fill(3));
      }
    });

    it('a card is revealed to everyone when played, and the remaining ones stay hidden', () => {
      const cards = decisive(variant, players, 0);
      const s = rig({ variant, players, score: both, cards });
      const ev = act(s, [0, 'play1']);
      const card = parseCards(cards[0])[1];
      const play = eventsOf(ev, 'play')[0];
      expect(play).toMatchObject({ seat: 0, card, faceDown: false, slot: 1 });
      for (const seat of seats(s)) {
        const o = observe(s, seat);
        expect(o.rounds[0].plays).toEqual([{ seat: 0, card, faceDown: false }]);
        expect(eventsFor(ev, seat, s.config.options).find((e) => e.t === 'play')).toMatchObject({ card });
      }
      expect(observe(s, 0).hand).toEqual([HIDDEN, -1, HIDDEN]);
      for (const seat of seats(s).slice(1)) expect(observe(s, seat).hand).toEqual([HIDDEN, HIDDEN, HIDDEN]);
    });

    it('nobody may raise, at any moment, even with raiseAnyTime', () => {
      for (const raiseAnyTime of [false, true]) {
        const s = tieMatch({ variant, players, score: both, options: { raiseAnyTime } });
        for (let slot = 0; slot < 3; slot++) {
          for (let i = 0; i < s.n; i++) {
            expectNoRaise(s);
            applyAction(s, i, parseAction(`play${slot}`));
          }
        }
        expectNoRaise(s);
      }
    });

    it('no face-down card in any round, even with faceDownFirstRound', () => {
      for (const faceDownFirstRound of [false, true]) {
        const s = tieMatch({ variant, players, score: both, options: { faceDownFirstRound } });
        for (let slot = 0; slot < 3; slot++) {
          for (let i = 0; i < s.n; i++) {
            expect(legalMask(s, i) & COVER_BITS, `round ${slot + 1} seat ${i}`).toBe(0);
            if (i === s.n - 1 && slot === 2) expectIllegal(s, i, 'cover2');
            applyAction(s, i, parseAction(`play${slot}`));
          }
        }
      }
    });

    it(`the hand is worth the starting value ${R.start}, so the winner reaches 12 and takes the game`, () => {
      for (const winnerSeat of [0, 1]) {
        const s = decisiveMatch({ variant, players, score: both }, winnerSeat);
        expect(observe(s, 0).value).toBe(R.start);
        const ev = playDecisive(s, 0, winnerSeat);
        const h = handEvent(ev);
        expect(h.winner).toBe(winnerSeat);
        expect(h.points).toBe(R.start);
        expect(s.score[winnerSeat]).toBe(12);
        expect(s.over).toBe(true);
        expect(s.winner).toBe(winnerSeat);
      }
    });

    it('three tied rounds: nobody scores by default and the next hand is again a mão de ferro', () => {
      const s = tieMatch({ variant, players, score: both });
      const h = handEvent(playAllTied(s, 0));
      expect(h.winner).toBe(-1);
      expect(s.score).toEqual(both);
      expect(s.over).toBe(false);
      expect(s.hand.kind).toBe('iron');
    });

    it('three tied rounds with onzeTieToOpponents: the option does not apply, nobody scores', () => {
      const s = tieMatch({ variant, players, score: both, options: { onzeTieToOpponents: true } });
      playAllTied(s, 0);
      expect(s.score).toEqual(both);
      expect(s.over).toBe(false);
    });

    it('three tied rounds with allTieToMao: the team of the mão takes the hand and the game', () => {
      for (const dealer of [players - 1, 0]) {
        const mao = (dealer + 1) % players;
        const s = tieMatch({ variant, players, score: both, dealer, options: { allTieToMao: true } });
        const h = handEvent(playAllTied(s, mao));
        expect(h.winner).toBe(mao % 2);
        expect(h.points).toBe(R.start);
        expect(s.over).toBe(true);
        expect(s.winner).toBe(mao % 2);
      }
    });

    it('three tied rounds with allTieToMao and onzeTieToOpponents: the team of the mão takes it', () => {
      const s = tieMatch({ variant, players, score: both, options: { allTieToMao: true, onzeTieToOpponents: true } });
      playAllTied(s, 0);
      expect(s.winner).toBe(0);
    });

    it("ironHand 'normal' plays a regular hand: cards visible, raises allowed, starting value", () => {
      const cards = decisive(variant, players, 0);
      const s = rig({ variant, players, score: both, cards, options: { ironHand: 'normal' } });
      const o = observe(s, 0);
      expect(o.kind).toBe('normal');
      expect(o.phase).toBe('play');
      expect(o.value).toBe(R.start);
      expect(o.hand).toEqual(parseCards(cards[0]));
      for (const seat of seats(s)) expect(observe(s, seat).partnerHand).toBeNull();
      expect(can(s, 0, 'raise')).toBe(true);
      const ev = act(s, [0, 'raise'], [1, 'accept']);
      expect(eventsOf(ev, 'accept')[0].value).toBe(R.truco);
      playDecisive(s, 0, 0);
      expect(s.score[0]).toBe(R.threshold + R.truco);
      expect(s.over).toBe(true);
      expect(s.winner).toBe(0);
    });

    it("ironHand 'normal' allows a face-down card from the second round", () => {
      const s = tieMatch({ variant, players, score: both, options: { ironHand: 'normal' } });
      playRound(s, 0, 0);
      expect(legalMask(s, 0) & COVER_BITS).not.toBe(0);
    });
  });

  it('2 against 2: no signals in a mão de ferro, at any moment, even when everyone sees signals', () => {
    const s = tieMatch({ variant, players: 4, score: both, options: { signals: 'all' } });
    for (let slot = 0; slot < 3; slot++) {
      for (let i = 0; i < 4; i++) {
        for (const seat of seats(s)) expect(legalMask(s, seat) & SIGNAL_BITS, `seat ${seat}`).toBe(0);
        if (slot === 0) expectIllegal(s, (i + 1) % 4, 'signal:zap');
        applyAction(s, i, parseAction(`play${slot}`));
      }
    }
  });

  it("2 against 2: ironHand 'normal' allows signals", () => {
    const s = tieMatch({ variant, players: 4, score: both, options: { ironHand: 'normal', signals: 'all' } });
    expect(legalMask(s, 1) & SIGNAL_BITS).toBe(SIGNAL_BITS);
  });
});

// =============================================================================================
// Three tied rounds

describe.each(VARIANTS)('%s: all three rounds tied', (variant) => {
  const R = RULE[variant];

  describe.each(SIZES)('%s players', (players) => {
    it('in a normal hand nobody scores by default and the next hand is dealt', () => {
      const s = tieMatch({ variant, players, score: [4, 5] });
      const ev = playAllTied(s, 0);
      expect(eventsOf(ev, 'round').map((r) => r.result)).toEqual([TIE, TIE, TIE]);
      const h = handEvent(ev);
      expect(h.winner).toBe(-1);
      expect(h.points).toBe(0);
      expect(s.score).toEqual([4, 5]);
      expect(s.hand.index).toBe(1);
    });

    it('in a normal hand after an accepted truco nobody scores by default', () => {
      const s = tieMatch({ variant, players, score: [4, 5] });
      act(s, [0, 'raise'], [1, 'accept']);
      playAllTied(s, 0);
      expect(s.score).toEqual([4, 5]);
    });

    it('allTieToMao: the team of the mão takes the hand value, whichever seat is the mão', () => {
      for (const dealer of [players - 1, 0]) {
        const mao = (dealer + 1) % players;
        const s = tieMatch({ variant, players, score: [4, 5], dealer, options: { allTieToMao: true } });
        expect(observe(s, 0).mao).toBe(mao);
        const h = handEvent(playAllTied(s, mao));
        expect(h.winner).toBe(mao % 2);
        expect(h.points).toBe(R.start);
        const expected: [number, number] = [4, 5];
        expected[mao % 2] += R.start;
        expect(s.score).toEqual(expected);
      }
    });

    it('allTieToMao after an accepted truco: the team of the mão takes the raised value', () => {
      const s = tieMatch({ variant, players, score: [4, 5], options: { allTieToMao: true } });
      act(s, [0, 'raise'], [1, 'accept']);
      playAllTied(s, 0);
      expect(s.score).toEqual([4 + R.truco, 5]);
    });

    it('onzeTieToOpponents does nothing in a normal hand: nobody scores', () => {
      const s = tieMatch({ variant, players, score: [4, 5], options: { onzeTieToOpponents: true } });
      playAllTied(s, 0);
      expect(s.score).toEqual([4, 5]);
    });

    it('in a mão de onze / de dez nobody scores by default', () => {
      const s = tieMatch({ variant, players, score: [R.threshold, 5] });
      act(s, [0, 'accept']);
      const h = handEvent(playAllTied(s, 0));
      expect(h.winner).toBe(-1);
      expect(s.score).toEqual([R.threshold, 5]);
      expect(s.hand.kind).toBe('onze');
    });

    it(`onzeTieToOpponents: in a mão de onze / de dez the team not on the threshold takes ${R.onzeValue}`, () => {
      for (const team of [0, 1]) {
        const score: [number, number] = team === 0 ? [R.threshold, 5] : [5, R.threshold];
        const s = tieMatch({ variant, players, score, options: { onzeTieToOpponents: true } });
        act(s, [team, 'accept']);
        const h = handEvent(playAllTied(s, 0));
        expect(h.winner).toBe(1 - team);
        expect(h.points).toBe(R.onzeValue);
        expect(s.score[1 - team]).toBe(5 + R.onzeValue);
        expect(s.score[team]).toBe(R.threshold);
      }
    });

    it('onzeTieToOpponents takes precedence over allTieToMao when the mão is on the threshold team', () => {
      const s = tieMatch({ variant, players, score: [R.threshold, 5], options: { onzeTieToOpponents: true, allTieToMao: true } });
      act(s, [0, 'accept']);
      playAllTied(s, 0);
      expect(s.score).toEqual([R.threshold, 5 + R.onzeValue]);
      expect(s.over).toBe(false);
    });

    it('allTieToMao alone in a mão de onze / de dez: the team of the mão takes the hand value', () => {
      // Mão on the threshold team: it takes the value and the game.
      const s = tieMatch({ variant, players, score: [R.threshold, 5], options: { allTieToMao: true } });
      act(s, [0, 'accept']);
      playAllTied(s, 0);
      expect(s.over).toBe(true);
      expect(s.winner).toBe(0);
      // Mão on the other team: it takes the value.
      const t = tieMatch({ variant, players, score: [5, R.threshold], options: { allTieToMao: true } });
      act(t, [1, 'accept']);
      playAllTied(t, 0);
      expect(t.score).toEqual([5 + R.onzeValue, R.threshold]);
    });

    it('onzeTieToOpponents can give the game to the team not on the threshold', () => {
      const other = 12 - R.onzeValue;
      const s = tieMatch({ variant, players, score: [R.threshold, other], options: { onzeTieToOpponents: true } });
      act(s, [0, 'accept']);
      playAllTied(s, 0);
      expect(s.over).toBe(true);
      expect(s.winner).toBe(1);
    });
  });
});

// =============================================================================================
// End of the game and of the match

describe.each(VARIANTS)('%s: end of the game and of the match', (variant) => {
  const R = RULE[variant];

  describe.each(SIZES)('%s players', (players) => {
    it('newMatch takes score, dealer and games from the init and deals the first hand accordingly', () => {
      const config = makeConfig(variant, players, { bestOf: 3 });
      const ev: GameEvent[] = [];
      const dealer = 1;
      const s = newMatch(config, SEED, { score: [R.threshold, 2], dealer, games: [1, 0] }, ev);
      expect(s.score).toEqual([R.threshold, 2]);
      expect(s.games).toEqual([1, 0]);
      const o = observe(s, 0);
      expect(o.score).toEqual([R.threshold, 2]);
      expect(o.games).toEqual([1, 0]);
      expect(o.dealer).toBe(dealer);
      expect(o.mao).toBe((dealer + 1) % players);
      expect(o.kind).toBe('onze');
      expect(o.onzeTeam).toBe(0);
      expect(ev).toEqual([
        expect.objectContaining({ t: 'deal', hand: 0, dealer, mao: (dealer + 1) % players, kind: 'onze', onzeTeam: 0 }),
      ]);
      const t = newMatch(config, SEED, { score: [R.threshold, R.threshold] });
      expect(t.hand.kind).toBe('iron');
      const u = newMatch(config, SEED, { score: [R.threshold - 1, R.threshold - 1] });
      expect(u.hand.kind).toBe('normal');
    });

    it('the game ends when a team reaches exactly 12', () => {
      const start = 12 - R.truco;
      const s = decisiveMatch({ variant, players, score: [start, 0] }, 0);
      act(s, [0, 'raise'], [1, 'accept']);
      const ev = playDecisive(s, 0, 0);
      expect(s.score[0]).toBe(12);
      expect(s.over).toBe(true);
      expect(s.winner).toBe(0);
      expect(eventsOf(ev, 'game')).toHaveLength(1);
      expect(eventsOf(ev, 'game')[0].winner).toBe(0);
      expect(eventsOf(ev, 'match')).toEqual([{ t: 'match', winner: 0 }]);
    });

    it('the game ends when a team goes past 12', () => {
      // From threshold - 1 (not a mão de onze / de dez) a truco takes the team past 12.
      const start = R.threshold - 1;
      const s = decisiveMatch({ variant, players, score: [0, start] }, 1);
      act(s, [0, 'raise'], [1, 'accept']);
      playDecisive(s, 0, 1);
      expect(s.score[1]).toBe(start + R.truco);
      expect(s.score[1]).toBeGreaterThan(12);
      expect(s.over).toBe(true);
      expect(s.winner).toBe(1);
    });

    it('below 12 the game goes on, and reaching the threshold makes the next hand a mão de onze / de dez', () => {
      const s = decisiveMatch({ variant, players, score: [R.threshold - R.start, 0] }, 0);
      const ev = playDecisive(s, 0, 0);
      expect(s.score).toEqual([R.threshold, 0]);
      expect(s.over).toBe(false);
      expect(eventsOf(ev, 'game')).toEqual([]);
      expect(eventsOf(ev, 'deal')).toEqual([expect.objectContaining({ t: 'deal', hand: 1, kind: 'onze', onzeTeam: 0 })]);
    });

    it('once the match is over nobody may act and observe() reports the winner', () => {
      const s = decisiveMatch({ variant, players, score: [R.threshold, 0] }, 0);
      act(s, [0, 'accept']);
      playDecisive(s, 0, 0);
      expect(s.over).toBe(true);
      expect(expectedActor(s)).toBe(-1);
      for (const seat of seats(s)) {
        expect(legalMask(s, seat)).toBe(0);
        const o = observe(s, seat);
        expect(o.over).toBe(true);
        expect(o.winner).toBe(0);
      }
      expectIllegal(s, s.hand.turn, 'play0');
    });

    it('best of 1 (default): one game decides the match', () => {
      const s = decisiveMatch({ variant, players, score: [12 - R.truco, 0] }, 0);
      expect(s.config.options.bestOf).toBe(1);
      act(s, [0, 'raise'], [1, 'accept']);
      playDecisive(s, 0, 0);
      expect(s.over).toBe(true);
      expect(s.winner).toBe(0);
    });

    it('best of 3: winning the first game resets the score to 0 to 0 and the match goes on', () => {
      const s = decisiveMatch({ variant, players, score: [12 - R.truco, 5], options: { bestOf: 3 } }, 0);
      act(s, [0, 'raise'], [1, 'accept']);
      const ev = playDecisive(s, 0, 0);
      expect(eventsOf(ev, 'game')).toEqual([{ t: 'game', winner: 0, games: [1, 0] }]);
      expect(eventsOf(ev, 'match')).toEqual([]);
      expect(s.over).toBe(false);
      expect(s.winner).toBe(-1);
      expect(s.games).toEqual([1, 0]);
      expect(s.score).toEqual([0, 0]);
      expect(observe(s, 0).score).toEqual([0, 0]);
      expect(s.hand.kind).toBe('normal');
      expect(s.hand.value).toBe(R.start);
      expect(actingSeatsAny(s)).toBe(true);
      // The deal passes to the next seat as after any other hand.
      expect(s.hand.dealer).toBe(0);
      expect(s.hand.mao).toBe(1 % players);
    });

    it('best of 3: winning a mão de onze / de dez wins the game, then the next hand is normal at 0 to 0', () => {
      const s = decisiveMatch({ variant, players, score: [3, R.threshold], options: { bestOf: 3 } }, 1);
      act(s, [1, 'accept']);
      playDecisive(s, 0, 1);
      expect(s.games).toEqual([0, 1]);
      expect(s.score).toEqual([0, 0]);
      expect(s.over).toBe(false);
      expect(s.hand.kind).toBe('normal');
    });

    it('best of 3: winning a mão de ferro wins the game, then the next hand is normal at 0 to 0', () => {
      const s = decisiveMatch({ variant, players, score: [R.threshold, R.threshold], options: { bestOf: 3 } }, 0);
      playDecisive(s, 0, 0);
      expect(s.games).toEqual([1, 0]);
      expect(s.score).toEqual([0, 0]);
      expect(s.over).toBe(false);
      expect(s.hand.kind).toBe('normal');
    });

    it('best of 3: one game each leaves the match open', () => {
      const s = decisiveMatch({ variant, players, score: [0, 12 - R.truco], games: [1, 0], options: { bestOf: 3 } }, 1);
      act(s, [0, 'raise'], [1, 'accept']);
      playDecisive(s, 0, 1);
      expect(s.games).toEqual([1, 1]);
      expect(s.score).toEqual([0, 0]);
      expect(s.over).toBe(false);
    });

    it('best of 3: the second game won ends the match', () => {
      for (const [games, winner] of [
        [[1, 0], 0],
        [[1, 1], 1],
        [[0, 1], 1],
      ] as [[number, number], number][]) {
        const score: [number, number] = winner === 0 ? [12 - R.truco, 4] : [4, 12 - R.truco];
        const s = decisiveMatch({ variant, players, score, games, options: { bestOf: 3 } }, winner);
        act(s, [0, 'raise'], [1, 'accept']);
        const ev = playDecisive(s, 0, winner);
        const g: [number, number] = [games[0], games[1]];
        g[winner]++;
        expect(s.games).toEqual(g);
        expect(s.over).toBe(true);
        expect(s.winner).toBe(winner);
        expect(eventsOf(ev, 'match')).toEqual([{ t: 'match', winner }]);
        for (const seat of seats(s)) expect(legalMask(s, seat)).toBe(0);
      }
    });

    it('best of 3: a full match from 0 to 0 ends after two games won by the same team', () => {
      const s = decisiveMatch({ variant, players, score: [12 - R.truco, 0], options: { bestOf: 3 } }, 0);
      act(s, [0, 'raise'], [1, 'accept']);
      playDecisive(s, 0, 0);
      expect(s.games).toEqual([1, 0]);
      expect(s.over).toBe(false);
      // Second game: play hands until team 0 reaches 12, controlling every deal.
      let guard = 0;
      while (!s.over) {
        const mao = s.hand.mao;
        const strong = mao % 2 === 0 ? mao : (mao + 1) % players;
        rigHand(s, decisive(variant, players, strong));
        if (s.hand.kind === 'onze') act(s, [s.hand.onzeTeam === 0 ? strong : (strong + 1) % players, 'accept']);
        playDecisive(s, mao, strong);
        if (++guard > 20) throw new Error('match did not end');
      }
      expect(s.games).toEqual([2, 0]);
      expect(s.winner).toBe(0);
    });
  });
});

function actingSeatsAny(s: MatchState): boolean {
  return seats(s).some((seat) => legalMask(s, seat) !== 0);
}
