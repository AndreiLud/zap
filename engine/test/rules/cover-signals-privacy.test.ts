// Face-down cards, partner signals and what each seat is allowed to see.
// Every expectation here comes from project_docs/rules.md: the "Face-down card" and "Signals" rows
// of the defaults table, and the sections "Face-down cards", "Signals (2 against 2)" and "Match".

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  A_ACCEPT,
  A_COVER0,
  A_RAISE,
  A_RUN,
  A_SIGNAL0,
  COVER_MASK,
  IllegalActionError,
  PLAY_MASK,
  SIGNALS,
  SIGNAL_MASK,
  TIE,
  applyAction,
  cardToString,
  eventsFor,
  expectedActor,
  ladderOf,
  legalActions,
  legalMask,
  makeConfig,
  mulberry32,
  newMatch,
  observe,
  onzeThreshold,
  parseAction,
  parseCard,
  parseCards,
  replay,
  type GameEvent,
  type MatchState,
  type RuleOptions,
  type SignalName,
  type Variant,
} from '../../src/index.ts';
import { act, rig } from '../helpers.ts';

// ---------------------------------------------------------------------------------------------
// Shared helpers

const VARIANTS: Variant[] = ['paulista', 'mineiro'];
const TABLES: (2 | 4)[] = [2, 4];
const MODES: RuleOptions['signals'][] = ['secret', 'p25', 'all'];
const ALL_SIX = 0b111111;

// Cards that are plain in both variants with the default paulista vira (5d, manilhas are the
// sixes): no 6, no 5d, no 4c, 7h, As or 7d. Strengths are fixed, so the outcome of each round is known.
//   1 against 1: r1 3c beats 2h (seat 0); r2 Jh beats 5c (seat 1); r3 Kh beats Qc (seat 1).
//   2 against 2: r1 3c wins (seat 0); r2 Jh wins (seat 1); r3, led by seat 1, Kh wins (seat 1).
const NEUTRAL2 = ['3c 5c Qc', '2h Jh Kh'];
const NEUTRAL4 = ['3c 5c Qc', '2h Jh Kh', '5h Qd Jd', '4h 5s Qs'];
const neutral = (players: 2 | 4): string[] => (players === 2 ? NEUTRAL2 : NEUTRAL4);

/** Face-up steps that play the whole neutral hand from seat 0 as the mão. */
function neutralSteps(players: 2 | 4): [number, string][] {
  if (players === 2) {
    return [
      [0, 'play0'], [1, 'play0'],
      [0, 'play1'], [1, 'play1'],
      [1, 'play2'], [0, 'play2'],
    ];
  }
  return [
    [0, 'play0'], [1, 'play0'], [2, 'play0'], [3, 'play0'],
    [0, 'play1'], [1, 'play1'], [2, 'play1'], [3, 'play1'],
    [1, 'play2'], [2, 'play2'], [3, 'play2'], [0, 'play2'],
  ];
}

const coverBits = (s: MatchState, seat: number): number => (legalMask(s, seat) & COVER_MASK) >> A_COVER0;
const playBits = (s: MatchState, seat: number): number => legalMask(s, seat) & PLAY_MASK;
const signalBits = (s: MatchState, seat: number): number => (legalMask(s, seat) & SIGNAL_MASK) >> A_SIGNAL0;
const seatsOf = (s: MatchState): number[] => [...Array(s.n).keys()];
const partner = (seat: number): number => (seat + 2) % 4;

function expectIllegal(s: MatchState, seat: number, name: string): void {
  const before = JSON.stringify(s);
  expect(() => applyAction(s, seat, parseAction(name))).toThrow(IllegalActionError);
  expect(JSON.stringify(s)).toBe(before);
}

function seedOf(tag: string, i: number): string {
  return createHash('sha256').update(`${tag}:${i}`).digest('hex');
}

/** rules.md, "Face-down cards": who may play face down right now. */
function coverAllowedBySpec(s: MatchState, seat: number): boolean {
  const h = s.hand;
  if (s.over || h.phase !== 'play' || seat !== expectedActor(s)) return false;
  if (h.kind === 'iron') return false;
  if (h.round > 0) return true;
  return s.config.options.faceDownFirstRound && seat !== h.mao;
}

/** Cover bits mirror the play bits (every card still in hand) when allowed, and are empty otherwise. */
function checkCoverRule(s: MatchState): void {
  for (const seat of seatsOf(s)) {
    if (coverAllowedBySpec(s, seat)) {
      expect(playBits(s, seat)).not.toBe(0);
      expect(coverBits(s, seat)).toBe(playBits(s, seat));
    } else {
      expect(coverBits(s, seat)).toBe(0);
    }
  }
}

/** rules.md, "Signals": who may send a signal right now. */
function signalAllowedBySpec(s: MatchState, seat: number): boolean {
  const h = s.hand;
  if (s.n !== 4 || s.over) return false;
  if (h.kind === 'iron' || h.phase !== 'play') return false;
  if (h.signals.some((x) => x.seat === seat)) return false;
  return !h.rounds.some((r) => r.plays.some((p) => p.seat === seat));
}

function checkSignalRule(s: MatchState): void {
  for (const seat of seatsOf(s)) expect(signalBits(s, seat)).toBe(signalAllowedBySpec(s, seat) ? ALL_SIX : 0);
}

/** Cards a seat may know (rules.md): vira, own cards (not in a mão de ferro), face-up plays, own face-down plays, onze partner. */
function allowedCards(s: MatchState, seat: number): Set<number> {
  const h = s.hand;
  const ok = new Set<number>();
  if (h.vira >= 0) ok.add(h.vira);
  if (h.kind !== 'iron') for (const c of h.cards[seat]) if (c >= 0) ok.add(c);
  for (const r of h.rounds) for (const p of r.plays) if (!p.faceDown || p.seat === seat) ok.add(p.card);
  if (s.n === 4 && h.kind === 'onze' && s.config.options.onzeSeesPartner && (seat & 1) === h.onzeTeam) {
    for (const c of h.cards[partner(seat)]) if (c >= 0) ok.add(c);
  }
  return ok;
}

/** Everything observe() must hide from a seat. */
function checkObservationPrivacy(s: MatchState, seat: number): void {
  const o = observe(s, seat);
  const ok = allowedCards(s, seat);
  const shown = [o.vira, ...o.hand, ...(o.partnerHand ?? []), ...o.rounds.flatMap((r) => r.plays.map((p) => p.card))].filter((c) => c >= 0);
  for (const c of shown) expect(ok.has(c)).toBe(true);
  for (const r of o.rounds) for (const p of r.plays) if (p.faceDown && p.seat !== seat) expect(p.card).toBe(-1);
  // Signals: exactly the ones this seat saw, in order, and nothing about truth or who caught them.
  const expected = s.hand.signals.filter((x) => (x.seenBy >> seat) & 1).map((x) => ({ seat: x.seat, signal: x.signal }));
  expect(o.signals).toEqual(expected);
  for (const sig of o.signals) expect(Object.keys(sig).sort()).toEqual(['seat', 'signal']);
  const json = JSON.stringify(o);
  expect(json).not.toContain(s.seed);
  expect(json).not.toContain(s.hand.seed);
  expect(json).not.toContain('truthful');
  expect(json).not.toContain('dealt');
  expect(json).not.toContain('"rng"');
  expect(json).not.toContain('"log"');
  if (s.config.options.signals !== 'all') expect(json).not.toContain('seenBy');
}

/** What eventsFor() must give one seat for a batch of raw events (rules.md, privacy rules). */
function checkEventsFor(ev: readonly GameEvent[], s: MatchState, seat: number): void {
  const mode = s.config.options.signals;
  const before = JSON.stringify(ev);
  const out = eventsFor(ev, seat, s.config.options);
  expect(JSON.stringify(ev)).toBe(before); // the raw batch is not modified
  const expected: GameEvent[] = [];
  for (const e of ev) {
    if (e.t === 'play' && e.faceDown && e.seat !== seat) expected.push({ ...e, card: -1 });
    else if (e.t === 'signal') {
      if ((e.seenBy >> seat) & 1) expected.push({ ...e, seenBy: mode === 'all' ? e.seenBy : 0 });
    } else expected.push(e);
  }
  expect(out).toEqual(expected);
  expect(JSON.stringify(out)).not.toContain('truthful');
}

/** Random play where any seat that may signal sometimes does, also out of turn. */
function randomStep(s: MatchState, rand: () => number): GameEvent[] {
  const signalers = seatsOf(s).filter((x) => signalBits(s, x) !== 0);
  let seat: number;
  let a: number;
  if (signalers.length > 0 && rand() < 0.4) {
    seat = signalers[Math.floor(rand() * signalers.length)];
    a = A_SIGNAL0 + Math.floor(rand() * 6);
  } else {
    seat = expectedActor(s);
    let acts = legalActions(s, seat).filter((x) => x < A_SIGNAL0);
    // Mostly play cards, so matches last many hands: raises and runs only now and then.
    if (acts.some((x) => x !== A_RUN && x !== A_RAISE) && rand() < 0.85) acts = acts.filter((x) => x !== A_RUN && x !== A_RAISE);
    a = acts[Math.floor(rand() * acts.length)];
  }
  const ev: GameEvent[] = [];
  applyAction(s, seat, a, ev);
  return ev;
}

// ---------------------------------------------------------------------------------------------
// Face-down cards: when they are allowed

describe('face-down cards: first round is closed by default', () => {
  for (const variant of VARIANTS) {
    for (const players of TABLES) {
      it(`nobody may play face down in the first round (${variant}, ${players} players)`, () => {
        const s = rig({ variant, players, cards: neutral(players) });
        for (let seat = 0; seat < players; seat++) {
          expect(expectedActor(s)).toBe(seat);
          expect(s.hand.round).toBe(0);
          expect(playBits(s, seat)).toBe(0b111);
          expect(coverBits(s, seat)).toBe(0);
          for (const slot of [0, 1, 2]) expectIllegal(s, seat, `cover${slot}`);
          act(s, [seat, 'play0']);
        }
        expect(s.hand.round).toBe(1);
      });
    }
  }
});

describe('face-down cards: allowed in the second and third rounds', () => {
  for (const variant of VARIANTS) {
    for (const players of TABLES) {
      it(`the player on turn may cover any card left in hand in rounds 2 and 3 (${variant}, ${players} players)`, () => {
        const s = rig({ variant, players, cards: neutral(players) });
        let checkedLater = 0;
        for (const step of neutralSteps(players)) {
          checkCoverRule(s);
          if (s.hand.round > 0) {
            expect(coverBits(s, step[0])).toBe(playBits(s, step[0]));
            expect(coverBits(s, step[0])).not.toBe(0);
            checkedLater++;
          }
          act(s, step);
        }
        expect(checkedLater).toBe(players * 2);
        expect(s.history).toHaveLength(1);
      });

      it(`covers in rounds 2 and 3 are played and recorded face down (${variant}, ${players} players)`, () => {
        const s = rig({ variant, players, cards: neutral(players) });
        if (players === 2) {
          act(s, [0, 'play0'], [1, 'play0']);
          const ev = act(s, [0, 'cover1']);
          expect(ev).toContainEqual({ t: 'play', seat: 0, card: parseCard('5c'), faceDown: true, slot: 1 });
          act(s, [1, 'play1']); // Jh beats the face-down card
          act(s, [1, 'cover2'], [0, 'play2']); // Qc beats the face-down Kh
          const hs = s.history[0];
          expect(hs.rounds[1].plays[0]).toEqual({ seat: 0, card: parseCard('5c'), faceDown: true });
          expect(hs.rounds[1].result).toBe(1);
          expect(hs.rounds[2].plays[0]).toEqual({ seat: 1, card: parseCard('Kh'), faceDown: true });
          expect(hs.rounds[2].result).toBe(0);
          expect(hs.result.winner).toBe(0);
        } else {
          act(s, [0, 'play0'], [1, 'play0'], [2, 'play0'], [3, 'play0']);
          act(s, [0, 'cover1'], [1, 'play1'], [2, 'play1'], [3, 'play1']); // Jh wins round 2
          act(s, [1, 'cover2'], [2, 'play2'], [3, 'cover2'], [0, 'play2']); // Jd wins round 3
          const hs = s.history[0];
          expect(hs.rounds[1].plays[0]).toEqual({ seat: 0, card: parseCard('5c'), faceDown: true });
          expect(hs.rounds[1].winnerSeat).toBe(1);
          expect(hs.rounds[2].plays.filter((p) => p.faceDown).map((p) => p.seat)).toEqual([1, 3]);
          expect(hs.rounds[2].winnerSeat).toBe(2);
          expect(hs.result.winner).toBe(0);
        }
      });
    }
  }

  it('covering an empty slot is illegal', () => {
    const s = rig({ players: 2, cards: NEUTRAL2 });
    act(s, [0, 'play0'], [1, 'play0']);
    expect(coverBits(s, 0)).toBe(0b110);
    expectIllegal(s, 0, 'cover0');
  });

  it('nobody may cover out of turn in rounds 2 and 3', () => {
    const s = rig({ players: 4, cards: NEUTRAL4 });
    act(s, [0, 'play0'], [1, 'play0'], [2, 'play0'], [3, 'play0']);
    expect(expectedActor(s)).toBe(0);
    for (const seat of [1, 2, 3]) {
      expect(coverBits(s, seat)).toBe(0);
      expectIllegal(s, seat, 'cover1');
    }
  });

  it('nobody may cover while a raise waits for an answer, and the cover comes back after the answer', () => {
    const s = rig({ players: 2, cards: NEUTRAL2 });
    act(s, [0, 'play0'], [1, 'play0'], [0, 'raise']);
    expect(s.hand.phase).toBe('raise');
    for (const seat of [0, 1]) expect(coverBits(s, seat)).toBe(0);
    expectIllegal(s, 0, 'cover1');
    act(s, [1, 'accept']);
    expect(coverBits(s, 0)).toBe(0b110);
  });
});

describe('face-down cards: faceDownFirstRound', () => {
  for (const variant of VARIANTS) {
    for (const players of TABLES) {
      it(`everyone except the player who opens the hand may cover in round 1 (${variant}, ${players} players)`, () => {
        const s = rig({ variant, players, options: { faceDownFirstRound: true }, cards: neutral(players) });
        expect(s.hand.mao).toBe(0);
        for (let seat = 0; seat < players; seat++) {
          expect(expectedActor(s)).toBe(seat);
          if (seat === 0) {
            expect(coverBits(s, 0)).toBe(0);
            expectIllegal(s, 0, 'cover0');
          } else {
            expect(coverBits(s, seat)).toBe(0b111);
          }
          checkCoverRule(s);
          act(s, [seat, 'play0']);
        }
        // Rounds 2 and 3 stay open to everyone, the mão included.
        expect(expectedActor(s)).toBe(0);
        expect(coverBits(s, 0)).toBe(0b110);
      });
    }
  }

  it('the exception follows the mão, not seat 0 (1 against 1, seat 0 deals)', () => {
    const s = rig({ players: 2, dealer: 0, options: { faceDownFirstRound: true }, cards: NEUTRAL2 });
    expect(s.hand.mao).toBe(1);
    expect(expectedActor(s)).toBe(1);
    expect(coverBits(s, 1)).toBe(0);
    expectIllegal(s, 1, 'cover0');
    act(s, [1, 'play0']);
    expect(coverBits(s, 0)).toBe(0b111);
  });

  it('the exception follows the mão, not seat 0 (2 against 2, seat 1 deals)', () => {
    const s = rig({ players: 4, dealer: 1, options: { faceDownFirstRound: true }, cards: NEUTRAL4 });
    expect(s.hand.mao).toBe(2);
    expect(coverBits(s, 2)).toBe(0);
    act(s, [2, 'play0']);
    for (const seat of [3, 0, 1]) {
      expect(coverBits(s, seat)).toBe(0b111);
      act(s, [seat, 'play0']);
    }
  });

  it('without the option the same non-mão seat may not cover in round 1', () => {
    const s = rig({ players: 2, cards: NEUTRAL2 });
    act(s, [0, 'play0']);
    expect(coverBits(s, 1)).toBe(0);
    expectIllegal(s, 1, 'cover0');
  });

  for (const variant of VARIANTS) {
    it(`a first round cover is worth nothing: the weakest real card beats a covered zap (${variant})`, () => {
      const zap = variant === 'paulista' ? '6c' : '4c';
      const s = rig({ variant, players: 2, options: { faceDownFirstRound: true }, cards: ['4h 5c Qc', `${zap} Jh Kh`] });
      act(s, [0, 'play0'], [1, 'cover0']);
      const r = s.hand.rounds[0];
      expect(r.plays[1]).toEqual({ seat: 1, card: parseCard(zap), faceDown: true });
      expect(r.result).toBe(0);
      expect(r.winnerSeat).toBe(0);
    });
  }
});

describe('face-down cards: worth nothing', () => {
  for (const variant of VARIANTS) {
    it(`a covered manilha loses to the weakest plain card (${variant})`, () => {
      const zap = variant === 'paulista' ? '6c' : '4c';
      const s = rig({ variant, players: 2, cards: [`3c ${zap} Qc`, '2h 4h Kh'] });
      act(s, [0, 'play0'], [1, 'play0'], [0, 'cover1'], [1, 'play1']);
      const r = s.hand.rounds[1];
      expect(r.result).toBe(1);
      expect(r.winnerSeat).toBe(1);
    });

    it(`two face-down cards tie, so the winner of round 1 takes the hand (${variant})`, () => {
      const s = rig({ variant, players: 2, cards: NEUTRAL2 });
      act(s, [0, 'play0'], [1, 'play0'], [0, 'cover1'], [1, 'cover1']);
      const hs = s.history[0];
      expect(hs.rounds[1].result).toBe(TIE);
      expect(hs.result.winner).toBe(0);
      expect(hs.result.reason).toBe('rounds');
    });
  }
});

describe('face-down cards: mão de onze / de dez and mão de ferro', () => {
  for (const variant of VARIANTS) {
    for (const players of TABLES) {
      for (const faceDownFirstRound of [false, true]) {
        it(`a mão de onze follows the normal rule (${variant}, ${players} players, faceDownFirstRound ${faceDownFirstRound})`, () => {
          const thr = onzeThreshold(makeConfig(variant, players));
          const s = rig({ variant, players, score: [thr, 0], options: { faceDownFirstRound }, cards: neutral(players) });
          expect(s.hand.kind).toBe('onze');
          expect(s.hand.phase).toBe('onze');
          for (const seat of seatsOf(s)) expect(coverBits(s, seat)).toBe(0);
          act(s, [0, 'accept']);
          for (const step of neutralSteps(players)) {
            checkCoverRule(s);
            const seat = step[0];
            if (s.hand.round > 0) expect(coverBits(s, seat)).not.toBe(0);
            else if (faceDownFirstRound && seat !== 0) expect(coverBits(s, seat)).toBe(0b111);
            else expect(coverBits(s, seat)).toBe(0);
            act(s, step);
          }
          expect(s.history[0].kind).toBe('onze');
        });

        it(`a mão de ferro never allows face down (${variant}, ${players} players, faceDownFirstRound ${faceDownFirstRound})`, () => {
          const thr = onzeThreshold(makeConfig(variant, players));
          const s = rig({ variant, players, score: [thr, thr], options: { faceDownFirstRound }, cards: neutral(players) });
          expect(s.hand.kind).toBe('iron');
          let checked = 0;
          for (const step of neutralSteps(players)) {
            for (const seat of seatsOf(s)) expect(coverBits(s, seat)).toBe(0);
            expectIllegal(s, step[0], `cover${step[1].slice(-1)}`);
            checked++;
            act(s, step);
            if (s.over) break;
          }
          expect(checked).toBeGreaterThanOrEqual(players * 2);
          expect(s.history[0].kind).toBe('iron');
        });
      }

      it(`with ironHand 'normal', both teams on the threshold play a regular hand with covers (${variant}, ${players} players)`, () => {
        const thr = onzeThreshold(makeConfig(variant, players));
        const s = rig({ variant, players, score: [thr, thr], options: { ironHand: 'normal', faceDownFirstRound: true }, cards: neutral(players) });
        expect(s.hand.kind).toBe('normal');
        expect(coverBits(s, 0)).toBe(0);
        act(s, [0, 'play0']);
        expect(coverBits(s, 1)).toBe(0b111);
        for (let seat = 1; seat < players; seat++) act(s, [seat, 'play0']);
        expect(coverBits(s, 0)).toBe(0b110);
      });
    }
  }
});

describe('face-down cards: the rule holds in random hands', () => {
  for (const variant of VARIANTS) {
    for (const players of TABLES) {
      it(`every reachable state follows the face-down rule (${variant}, ${players} players)`, () => {
        const thr = onzeThreshold(makeConfig(variant, players));
        const scores: [number, number][] = [[0, 0], [thr, 0], [0, thr], [thr, thr]];
        let covers = 0;
        let i = 0;
        for (const faceDownFirstRound of [false, true]) {
          for (const ironHand of ['blind', 'normal'] as const) {
            for (const score of scores) {
              for (let k = 0; k < 6; k++, i++) {
                const config = makeConfig(variant, players, { faceDownFirstRound, ironHand });
                const s = newMatch(config, seedOf(`cover-${variant}-${players}`, i), { score });
                const rand = mulberry32(i + 1);
                const start = s.hand.index;
                let guard = 0;
                while (!s.over && s.hand.index === start) {
                  checkCoverRule(s);
                  const h = s.hand;
                  let seat = expectedActor(s);
                  let a: number;
                  if (h.phase === 'onze' || h.phase === 'raise') a = A_ACCEPT;
                  else {
                    const acts = legalActions(s, seat).filter((x) => x < 6 || (x === A_RAISE && rand() < 0.1));
                    a = acts[Math.floor(rand() * acts.length)];
                    if (a >= A_COVER0 && a < A_COVER0 + 3) {
                      covers++;
                      // The spec decides, not the mask: a cover must be allowed for this seat now.
                      expect(coverAllowedBySpec(s, seat)).toBe(true);
                    }
                  }
                  if (h.phase === 'onze') seat = seatsOf(s).find((x) => legalMask(s, x) & (1 << A_ACCEPT))!;
                  applyAction(s, seat, a);
                  if (++guard > 100) throw new Error('hand did not end');
                }
                checkCoverRule(s);
              }
            }
          }
        }
        expect(covers).toBeGreaterThan(20);
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Face-down cards: privacy

describe('face-down cards: identity is never shown to anyone else', () => {
  for (const variant of VARIANTS) {
    it(`1 against 1: the opponent sees a face-down play as -1 in observe() and eventsFor() (${variant})`, () => {
      const s = rig({ variant, players: 2, cards: NEUTRAL2 });
      act(s, [0, 'play0'], [1, 'play0']);
      const ev = act(s, [0, 'cover1']);
      const covered = parseCard('5c');
      const raw = ev.find((e) => e.t === 'play');
      expect(raw).toEqual({ t: 'play', seat: 0, card: covered, faceDown: true, slot: 1 });

      const toOpp = eventsFor(ev, 1, s.config.options);
      expect(toOpp).toEqual([{ t: 'play', seat: 0, card: -1, faceDown: true, slot: 1 }]);
      const toOwner = eventsFor(ev, 0, s.config.options);
      expect(toOwner).toEqual([{ t: 'play', seat: 0, card: covered, faceDown: true, slot: 1 }]);
      expect(ev[0]).toEqual(raw); // eventsFor did not modify the raw batch

      const o = observe(s, 1);
      expect(o.rounds[1].plays[0]).toEqual({ seat: 0, card: -1, faceDown: true });
      const shown = [o.vira, ...o.hand, ...(o.partnerHand ?? []), ...o.rounds.flatMap((r) => r.plays.map((p) => p.card))];
      expect(shown).not.toContain(covered);
      expect(o.handCounts).toEqual([1, 2]);
      checkObservationPrivacy(s, 0);
      checkObservationPrivacy(s, 1);
    });

    it(`2 against 2: the partner and both opponents get -1, the owner gets the card (${variant})`, () => {
      const s = rig({ variant, players: 4, cards: NEUTRAL4 });
      act(s, [0, 'play0'], [1, 'play0'], [2, 'play0'], [3, 'play0']);
      const ev = act(s, [0, 'cover1']);
      const covered = parseCard('5c');
      for (const seat of [1, 2, 3]) {
        expect(eventsFor(ev, seat, s.config.options)).toEqual([{ t: 'play', seat: 0, card: -1, faceDown: true, slot: 1 }]);
        const o = observe(s, seat);
        expect(o.rounds[1].plays[0]).toEqual({ seat: 0, card: -1, faceDown: true });
        expect([o.vira, ...o.hand, ...o.rounds.flatMap((r) => r.plays.map((p) => p.card))]).not.toContain(covered);
      }
      expect(eventsFor(ev, 0, s.config.options)).toEqual([{ t: 'play', seat: 0, card: covered, faceDown: true, slot: 1 }]);
    });

    it(`the rest of the hand never reveals the covered card to other seats (${variant})`, () => {
      const s = rig({ variant, players: 4, cards: NEUTRAL4 });
      act(s, [0, 'play0'], [1, 'play0'], [2, 'play0'], [3, 'play0']);
      const ev = act(s, [0, 'cover1'], [1, 'play1'], [2, 'play1'], [3, 'play1'], [1, 'cover2'], [2, 'play2'], [3, 'cover2'], [0, 'play2']);
      expect(ev.some((e) => e.t === 'hand')).toBe(true);
      const coveredBy: Record<number, number> = { 0: parseCard('5c'), 1: parseCard('Kh'), 3: parseCard('Qs') };
      for (let seat = 0; seat < 4; seat++) {
        const out = eventsFor(ev, seat, s.config.options);
        for (const e of out) {
          if (e.t !== 'play' || !e.faceDown) continue;
          expect(e.card).toBe(e.seat === seat ? coveredBy[e.seat] : -1);
        }
        checkEventsFor(ev, s, seat);
      }
    });

    it(`a face-down card in the last hand of the match stays hidden after the match ends (${variant})`, () => {
      const truco = ladderOf(makeConfig(variant, 2))[1];
      const s = rig({ variant, players: 2, score: [12 - truco, 0], cards: NEUTRAL2 });
      act(s, [0, 'raise'], [1, 'accept'], [0, 'play0'], [1, 'play0'], [0, 'play2']);
      const ev = act(s, [1, 'cover2']);
      expect(s.over).toBe(true);
      expect(s.winner).toBe(0);
      expect(eventsFor(ev, 0, s.config.options).find((e) => e.t === 'play')).toEqual({ t: 'play', seat: 1, card: -1, faceDown: true, slot: 2 });
      const o = observe(s, 0);
      const fd = o.rounds.flatMap((r) => r.plays).filter((p) => p.faceDown);
      for (const p of fd) expect(p.card).toBe(-1);
      expect([o.vira, ...o.hand, ...o.rounds.flatMap((r) => r.plays.map((p) => p.card))]).not.toContain(parseCard('Kh'));
    });

    it(`in a mão de onze the partner who sees the hand still gets -1 for the face-down play (${variant})`, () => {
      const thr = onzeThreshold(makeConfig(variant, 4));
      const s = rig({ variant, players: 4, score: [thr, 0], cards: NEUTRAL4 });
      act(s, [2, 'accept'], [0, 'play0'], [1, 'play0'], [2, 'play0'], [3, 'play0']);
      const ev = act(s, [0, 'cover1']);
      const o = observe(s, 2);
      expect(o.partnerHand).not.toBeNull();
      expect(o.partnerHand).not.toContain(parseCard('5c'));
      expect(o.rounds[1].plays[0]).toEqual({ seat: 0, card: -1, faceDown: true });
      expect(eventsFor(ev, 2, s.config.options)[0]).toEqual({ t: 'play', seat: 0, card: -1, faceDown: true, slot: 1 });
    });
  }

  it("the owner still sees which card they played face down in observe() (identity is hidden only from others)", () => {
    const s = rig({ players: 2, cards: NEUTRAL2 });
    act(s, [0, 'play0'], [1, 'play0'], [0, 'cover1']);
    const o = observe(s, 0);
    expect(o.rounds[1].plays[0]).toEqual({ seat: 0, card: parseCard('5c'), faceDown: true });
  });
});

// ---------------------------------------------------------------------------------------------
// Signals: when they may be sent

describe('signals: never in 1 against 1', () => {
  for (const variant of VARIANTS) {
    for (const signals of MODES) {
      it(`no seat ever has a signal action (${variant}, signals ${signals})`, () => {
        const s = rig({ variant, players: 2, options: { signals }, cards: NEUTRAL2 });
        for (const step of neutralSteps(2)) {
          for (const seat of [0, 1]) expect(signalBits(s, seat)).toBe(0);
          expectIllegal(s, 0, 'signal:zap');
          expectIllegal(s, 1, 'signal:nada');
          act(s, step);
        }
        expect(s.history[0].signals).toEqual([]);
      });
    }
  }

  it('random 1 against 1 matches never offer a signal', () => {
    for (const variant of VARIANTS) {
      for (let i = 0; i < 6; i++) {
        const s = newMatch(makeConfig(variant, 2, { signals: MODES[i % 3] }), seedOf('one-v-one', i));
        const rand = mulberry32(i + 7);
        for (let k = 0; k < 400 && !s.over; k++) {
          for (const seat of [0, 1]) expect(signalBits(s, seat)).toBe(0);
          randomStep(s, rand);
        }
        for (const hs of s.history) expect(hs.signals).toEqual([]);
      }
    }
  });
});

describe('signals: availability in 2 against 2', () => {
  for (const variant of VARIANTS) {
    for (const signals of MODES) {
      it(`at the start of a hand every seat may send any of the six signals, also out of turn (${variant}, ${signals})`, () => {
        const s = rig({ variant, players: 4, options: { signals }, cards: NEUTRAL4 });
        expect(expectedActor(s)).toBe(0);
        for (const seat of [0, 1, 2, 3]) expect(signalBits(s, seat)).toBe(ALL_SIX);
      });
    }
  }

  it('a signal out of turn does not take the turn or change the phase', () => {
    const s = rig({ players: 4, cards: NEUTRAL4 });
    const ev = act(s, [2, 'signal:zap']);
    expect(ev.map((e) => e.t)).toEqual(['signal']);
    expect(expectedActor(s)).toBe(0);
    expect(s.hand.turn).toBe(0);
    expect(s.hand.phase).toBe('play');
    expect(s.hand.rounds[0].plays).toEqual([]);
    expect(playBits(s, 0)).toBe(0b111);
    expect(s.hand.signals).toHaveLength(1);
    expect(s.hand.signals[0].seat).toBe(2);
    expect(s.hand.signals[0].signal).toBe(SIGNALS.indexOf('zap'));
  });

  it('a signal by the player on turn does not replace their play', () => {
    const s = rig({ players: 4, cards: NEUTRAL4 });
    act(s, [0, 'signal:tres']);
    expect(expectedActor(s)).toBe(0);
    expect(playBits(s, 0)).toBe(0b111);
    act(s, [0, 'play0']);
    expect(expectedActor(s)).toBe(1);
  });

  for (const variant of VARIANTS) {
    it(`one signal per player per hand (${variant})`, () => {
      const s = rig({ variant, players: 4, cards: NEUTRAL4 });
      act(s, [2, 'signal:tres']);
      expect(signalBits(s, 2)).toBe(0);
      expectIllegal(s, 2, 'signal:nada');
      expectIllegal(s, 2, 'signal:tres');
      for (const seat of [0, 1, 3]) expect(signalBits(s, seat)).toBe(ALL_SIX);
      act(s, [1, 'signal:nada'], [0, 'signal:copas'], [3, 'signal:zap']);
      for (const seat of [0, 1, 2, 3]) expect(signalBits(s, seat)).toBe(0);
      expect(s.hand.signals.map((x) => x.seat)).toEqual([2, 1, 0, 3]);
    });
  }

  it('the limit is per hand: the next hand opens the signals again', () => {
    const s = rig({ players: 4, cards: NEUTRAL4 });
    act(s, [2, 'signal:tres'], ...neutralSteps(4));
    expect(s.history).toHaveLength(1);
    expect(s.history[0].signals.map((x) => x.seat)).toEqual([2]);
    expect(s.hand.index).toBe(1);
    expect(s.hand.signals).toEqual([]);
    for (const seat of [0, 1, 2, 3]) expect(signalBits(s, seat)).toBe(ALL_SIX);
    act(s, [2, 'signal:nada']);
    expect(s.hand.signals.map((x) => x.seat)).toEqual([2]);
  });

  it('a player may not signal after playing their first card, even without having signaled', () => {
    const s = rig({ players: 4, cards: NEUTRAL4 });
    act(s, [0, 'play0']);
    expect(signalBits(s, 0)).toBe(0);
    expectIllegal(s, 0, 'signal:zap');
    for (const seat of [1, 2, 3]) expect(signalBits(s, seat)).toBe(ALL_SIX);
    act(s, [1, 'play0']);
    // Seat 3 has not played yet and signals while seat 2 is on turn.
    expect(expectedActor(s)).toBe(2);
    act(s, [3, 'signal:espadilha']);
    expect(expectedActor(s)).toBe(2);
    act(s, [2, 'play0']);
    expect(signalBits(s, 2)).toBe(0);
    act(s, [3, 'play0']);
    // Round 2: everyone has played a card, nobody may signal any more this hand.
    expect(s.hand.round).toBe(1);
    for (const seat of [0, 1, 2, 3]) {
      expect(signalBits(s, seat)).toBe(0);
      expectIllegal(s, seat, 'signal:nada');
    }
  });

  it('with faceDownFirstRound, a first card played face down also closes the signal', () => {
    const s = rig({ players: 4, options: { faceDownFirstRound: true }, cards: NEUTRAL4 });
    act(s, [0, 'play0']);
    expect(signalBits(s, 1)).toBe(ALL_SIX);
    act(s, [1, 'cover0']);
    expect(signalBits(s, 1)).toBe(0);
    expectIllegal(s, 1, 'signal:nada');
    for (const seat of [2, 3]) expect(signalBits(s, seat)).toBe(ALL_SIX);
  });

  it('the last player of round 1 may still signal before their card', () => {
    const s = rig({ players: 4, cards: NEUTRAL4 });
    act(s, [0, 'play0'], [1, 'play0'], [2, 'play0']);
    expect(signalBits(s, 3)).toBe(ALL_SIX);
    act(s, [3, 'signal:picafumo'], [3, 'play0']);
    expect(s.hand.round).toBe(1);
    expect(s.hand.signals.map((x) => x.seat)).toEqual([3]);
  });

  it('nobody may signal while a raise waits for an answer', () => {
    const s = rig({ players: 4, cards: NEUTRAL4 });
    act(s, [0, 'raise']);
    expect(s.hand.phase).toBe('raise');
    for (const seat of [0, 1, 2, 3]) {
      expect(signalBits(s, seat)).toBe(0);
      expectIllegal(s, seat, 'signal:zap');
    }
    // Raise again keeps the bet pending.
    act(s, [3, 'raise']);
    expect(s.hand.phase).toBe('raise');
    for (const seat of [0, 1, 2, 3]) expect(signalBits(s, seat)).toBe(0);
    act(s, [2, 'accept']);
    expect(s.hand.phase).toBe('play');
    for (const seat of [0, 1, 2, 3]) expect(signalBits(s, seat)).toBe(ALL_SIX);
  });

  it('nobody may signal while a raise made out of turn (raiseAnyTime) waits for an answer', () => {
    const s = rig({ players: 4, options: { raiseAnyTime: true }, cards: NEUTRAL4 });
    act(s, [3, 'raise']);
    expect(s.hand.phase).toBe('raise');
    for (const seat of [0, 1, 2, 3]) expect(signalBits(s, seat)).toBe(0);
    act(s, [0, 'accept']);
    for (const seat of [0, 1, 2, 3]) expect(signalBits(s, seat)).toBe(ALL_SIX);
  });

  for (const variant of VARIANTS) {
    for (const team of [0, 1]) {
      it(`nobody may signal while the mão de onze decision is pending, everyone may after it (${variant}, team ${team} on the threshold)`, () => {
        const thr = onzeThreshold(makeConfig(variant, 4));
        const score: [number, number] = team === 0 ? [thr, 0] : [0, thr];
        const s = rig({ variant, players: 4, score, cards: NEUTRAL4 });
        expect(s.hand.kind).toBe('onze');
        expect(s.hand.phase).toBe('onze');
        for (const seat of [0, 1, 2, 3]) {
          expect(signalBits(s, seat)).toBe(0);
          expectIllegal(s, seat, 'signal:zap');
        }
        act(s, [team + 2, 'accept']);
        expect(s.hand.phase).toBe('play');
        for (const seat of [0, 1, 2, 3]) expect(signalBits(s, seat)).toBe(ALL_SIX);
        act(s, [1, 'signal:nada'], [2, 'signal:tres']);
        expect(s.hand.signals.map((x) => x.seat)).toEqual([1, 2]);
      });
    }

    it(`never in a mão de ferro (${variant})`, () => {
      const thr = onzeThreshold(makeConfig(variant, 4));
      const s = rig({ variant, players: 4, score: [thr, thr], options: { signals: 'all' }, cards: NEUTRAL4 });
      expect(s.hand.kind).toBe('iron');
      for (const step of neutralSteps(4)) {
        for (const seat of [0, 1, 2, 3]) expect(signalBits(s, seat)).toBe(0);
        for (const seat of [0, 1, 2, 3]) expectIllegal(s, seat, 'signal:nada');
        act(s, step);
        if (s.over) break;
      }
      expect(s.history[0].signals).toEqual([]);
    });

    it(`with ironHand 'normal' both teams on the threshold may signal (${variant})`, () => {
      const thr = onzeThreshold(makeConfig(variant, 4));
      const s = rig({ variant, players: 4, score: [thr, thr], options: { ironHand: 'normal' }, cards: NEUTRAL4 });
      expect(s.hand.kind).toBe('normal');
      for (const seat of [0, 1, 2, 3]) expect(signalBits(s, seat)).toBe(ALL_SIX);
    });
  }

  it('random 2 against 2 matches follow the signal rule at every step', () => {
    let sent = 0;
    let i = 0;
    for (const variant of VARIANTS) {
      for (const ironHand of ['blind', 'normal'] as const) {
        for (const raiseAnyTime of [false, true]) {
          for (let k = 0; k < 4; k++, i++) {
            const config = makeConfig(variant, 4, { ironHand, raiseAnyTime, signals: MODES[i % 3], faceDownFirstRound: k % 2 === 1 });
            const s = newMatch(config, seedOf('signal-rule', i));
            const rand = mulberry32(i + 11);
            for (let n = 0; n < 2000 && !s.over; n++) {
              checkSignalRule(s);
              const ev = randomStep(s, rand);
              sent += ev.filter((e) => e.t === 'signal').length;
            }
            checkSignalRule(s);
          }
        }
      }
    }
    expect(sent).toBeGreaterThan(200);
  });
});

// ---------------------------------------------------------------------------------------------
// Signals: truthfulness

type TruthCase = [variant: Variant, vira: string | null, cards: string, signal: SignalName, truthful: boolean, why: string];

const TRUTH: TruthCase[] = [
  // Paulista, vira 5d: the sixes are manilhas.
  ['paulista', '5d', '6c 4d 5s', 'zap', true, '6c is the zap'],
  ['paulista', '5d', '6h 4d 5s', 'zap', false, 'copas is not the zap'],
  ['paulista', '5d', '4c 7h As', 'zap', false, 'mineiro manilhas are plain in paulista'],
  ['paulista', '5d', '6h 4d 5s', 'copas', true, '6h is copas'],
  ['paulista', '5d', '6c 6s 6d', 'copas', false, 'three other manilhas, not copas'],
  ['paulista', '5d', '6s Kd 5s', 'espadilha', true, '6s is espadilha'],
  ['paulista', '5d', '6h Kd 5s', 'espadilha', false, 'copas is not espadilha'],
  ['paulista', '5d', '6d Kd 5s', 'picafumo', true, '6d is pica-fumo'],
  ['paulista', '5d', '6s Kd 5s', 'picafumo', false, 'espadilha is not pica-fumo'],
  ['paulista', '5d', '3d 4s 5h', 'tres', true, 'a plain three'],
  ['paulista', '5d', '2c 6c Kd', 'tres', false, 'a manilha but no three'],
  ['paulista', '5d', '6c 3s 7c', 'tres', true, 'a plain three next to the zap'],
  ['paulista', '5d', '4d 5s Kh', 'nada', true, 'no manilha and no three'],
  ['paulista', '5d', '4c 7h As', 'nada', true, 'mineiro manilhas are plain in paulista'],
  ['paulista', '5d', '6d 4s 5h', 'nada', false, 'holds a manilha'],
  ['paulista', '5d', '3h 4s 5h', 'nada', false, 'holds a three'],
  // Paulista, vira 2d: the threes are the manilhas, so no three is a plain three.
  ['paulista', '2d', '3c 4d 5d', 'zap', true, '3c is the zap'],
  ['paulista', '2d', '3h 4d 5d', 'copas', true, '3h is copas'],
  ['paulista', '2d', '3s 4d 5d', 'espadilha', true, '3s is espadilha'],
  ['paulista', '2d', '3d 4s 5h', 'picafumo', true, '3d is pica-fumo'],
  ['paulista', '2d', '6c 4d 5d', 'zap', false, 'sixes are plain with vira 2'],
  ['paulista', '2d', '3d 4s 5h', 'tres', false, 'every three is a manilha'],
  ['paulista', '2d', '3c 3h 3s', 'tres', false, 'three threes, all manilhas'],
  ['paulista', '2d', '3h 4d 5d', 'nada', false, 'the three is a manilha'],
  ['paulista', '2d', '2s 4s 5h', 'nada', true, 'twos are plain'],
  // Paulista, vira 3d: after 3 comes 4, the fours are the manilhas and threes are plain.
  ['paulista', '3d', '4c 5d 6d', 'zap', true, '4c is the zap'],
  ['paulista', '3d', '4d 5s 6s', 'picafumo', true, '4d is pica-fumo'],
  ['paulista', '3d', '5c 6c 7c', 'zap', false, 'no four of clubs'],
  ['paulista', '3d', '3c 5d 6d', 'tres', true, 'threes are plain with vira 3'],
  ['paulista', '3d', '3c 5d 6d', 'nada', false, 'holds a three'],
  ['paulista', '3d', '5c 6c 7c', 'nada', true, 'no four and no three'],
  // Paulista, vira Kd: the aces are the manilhas.
  ['paulista', 'Kd', 'Ac 4d 5d', 'zap', true, 'Ac is the zap'],
  ['paulista', 'Kd', 'Ah 4d 5d', 'copas', true, 'Ah is copas'],
  ['paulista', 'Kd', 'As 4d 5d', 'espadilha', true, 'As is espadilha'],
  ['paulista', 'Kd', '4c 5d 6d', 'zap', false, '4c is plain in paulista'],
  ['paulista', 'Kd', '4c 7h 7d', 'nada', true, 'mineiro manilhas are plain here'],
  ['paulista', 'Kd', '4c Ah 7d', 'nada', false, 'holds a manilha'],
  // Paulista, vira 7c: the queens are the manilhas.
  ['paulista', '7c', 'Qd 4d 5d', 'picafumo', true, 'Qd is pica-fumo'],
  ['paulista', '7c', 'Qc 3d 5d', 'tres', true, 'a plain three next to the zap'],
  ['paulista', '7c', 'Qc 3d 5d', 'nada', false, 'holds a manilha and a three'],
  // Mineiro: fixed manilhas, no vira.
  ['mineiro', null, '4c 5d 6d', 'zap', true, '4c is the zap'],
  ['mineiro', null, '4h 5d 6d', 'zap', false, '4h is plain'],
  ['mineiro', null, '6c 5d Qd', 'zap', false, 'no vira, sixes are plain'],
  ['mineiro', null, '7h 5d 6d', 'copas', true, '7h is copas'],
  ['mineiro', null, '7c 5d 6d', 'copas', false, '7c is plain'],
  ['mineiro', null, 'Ah 5d 6d', 'copas', false, 'Ah is plain'],
  ['mineiro', null, 'As 5d 6d', 'espadilha', true, 'As is espadilha'],
  ['mineiro', null, 'Ac 5d 6d', 'espadilha', false, 'Ac is plain'],
  ['mineiro', null, '7d 5d 6d', 'picafumo', true, '7d is pica-fumo'],
  ['mineiro', null, '7s 5d 6d', 'picafumo', false, '7s is plain'],
  ['mineiro', null, '3c 5d 6d', 'tres', true, 'threes are plain'],
  ['mineiro', null, '4c 7h As', 'tres', false, 'manilhas only'],
  ['mineiro', null, '4d 7s Ac', 'nada', true, 'plain four, seven and ace'],
  ['mineiro', null, '2c 2d Kc', 'nada', true, 'no manilha and no three'],
  ['mineiro', null, '4c 5d 6d', 'nada', false, 'holds the zap'],
  ['mineiro', null, '7d 5c 6c', 'nada', false, 'holds pica-fumo'],
  ['mineiro', null, '3d 5c 6c', 'nada', false, 'holds a three'],
];

/** Deals `mine` to `seat`, fills the other seats with unused cards, sends one signal and returns the record. */
function sendSignal(variant: Variant, vira: string | null, mine: string, sig: SignalName, seat: number) {
  const used = new Set(parseCards(mine));
  if (vira) used.add(parseCard(vira));
  const free = [...Array(40).keys()].filter((c) => !used.has(c));
  const cards: string[] = [];
  for (let i = 0, k = 0; i < 4; i++) {
    if (i === seat) cards.push(mine);
    else {
      cards.push(free.slice(k, k + 3).map(cardToString).join(' '));
      k += 3;
    }
  }
  const s = rig({ variant, players: 4, vira: vira ?? undefined, cards });
  act(s, [seat, `signal:${sig}`]);
  expect(s.hand.signals).toHaveLength(1);
  return { s, rec: s.hand.signals[0] };
}

describe('signals: truthfulness is recorded in hand.signals[].truthful', () => {
  TRUTH.forEach(([variant, vira, cards, sig, truthful, why], i) => {
    const seat = i % 4;
    it(`${variant}${vira ? ` vira ${vira}` : ''}: '${sig}' with ${cards} is ${truthful ? 'true' : 'a lie'} (${why}; seat ${seat})`, () => {
      const { rec } = sendSignal(variant, vira, cards, sig, seat);
      expect(rec.seat).toBe(seat);
      expect(rec.signal).toBe(SIGNALS.indexOf(sig));
      expect(rec.truthful).toBe(truthful);
    });
  });

  it('every signal is legal whatever the cards: a lie is allowed', () => {
    for (const sig of SIGNALS) {
      const { s, rec } = sendSignal('paulista', '5d', '4d 5s Kh', sig, 1);
      expect(rec.truthful).toBe(sig === 'nada');
      expect(s.hand.signals[0].signal).toBe(SIGNALS.indexOf(sig));
    }
  });

  for (const variant of VARIANTS) {
    it(`only the signaler's own cards count, not the partner's (${variant})`, () => {
      const zap = variant === 'paulista' ? '6c' : '4c';
      const s = rig({ variant, players: 4, cards: ['4d 5s Kh', '2h Jh Kd', `${zap} 3h Qd`, '4h 5h Qs'] });
      act(s, [0, 'signal:zap'], [2, 'signal:zap'], [1, 'signal:tres'], [3, 'signal:tres']);
      expect(s.hand.signals.map((x) => [x.seat, x.truthful])).toEqual([[0, false], [2, true], [1, false], [3, false]]);
    });
  }

  it('the records stay in the hand history after the hand ends', () => {
    const s = rig({ players: 4, cards: NEUTRAL4 });
    act(s, [1, 'signal:nada'], [0, 'signal:tres'], [3, 'signal:zap']);
    const records = JSON.parse(JSON.stringify(s.hand.signals));
    act(s, ...neutralSteps(4));
    expect(s.history[0].signals).toEqual(records);
    expect(records.map((x: { truthful: boolean }) => x.truthful)).toEqual([true, true, false]);
  });
});

// ---------------------------------------------------------------------------------------------
// Signals: who sees them

/** Sends all four signals at the start of hand 0 of a fresh match, in an order that depends on i. */
function fourSignals(variant: Variant, signals: RuleOptions['signals'], tag: string, i: number) {
  const s = newMatch(makeConfig(variant, 4, { signals }), seedOf(tag, i));
  const order = [0, 1, 2, 3].map((k) => (k + i) % 4);
  if (i % 2) order.reverse();
  const ev: GameEvent[] = [];
  for (const seat of order) applyAction(s, seat, A_SIGNAL0 + ((i + seat) % 6), ev);
  return { s, ev };
}

describe('signals: visibility', () => {
  for (const variant of VARIANTS) {
    it(`'secret': the signaler and the partner see it, opponents never (${variant})`, () => {
      for (let i = 0; i < 150; i++) {
        const { s } = fourSignals(variant, 'secret', 'secret', i);
        for (const r of s.hand.signals) expect(r.seenBy).toBe((1 << r.seat) | (1 << partner(r.seat)));
        for (let seat = 0; seat < 4; seat++) {
          expect(observe(s, seat).signals.map((x) => x.seat).sort()).toEqual([seat, partner(seat)].sort());
        }
      }
    });

    it(`'all': every seat sees every signal (${variant})`, () => {
      for (let i = 0; i < 50; i++) {
        const { s } = fourSignals(variant, 'all', 'all', i);
        for (const r of s.hand.signals) expect(r.seenBy).toBe(0b1111);
        for (let seat = 0; seat < 4; seat++) {
          expect(observe(s, seat).signals).toEqual(s.hand.signals.map((x) => ({ seat: x.seat, signal: x.signal })));
        }
      }
    });

    it(`'p25': each opponent catches about 25% of the signals, independently, and the partner always sees (${variant})`, () => {
      const N = 1000;
      let draws = 0;
      let caught = 0;
      let both = 0;
      let neither = 0;
      const perPair = new Map<string, [number, number]>();
      for (let i = 0; i < N; i++) {
        const { s } = fourSignals(variant, 'p25', `p25-${variant}`, i);
        for (const r of s.hand.signals) {
          expect(r.seenBy >> 4).toBe(0);
          expect((r.seenBy >> r.seat) & 1).toBe(1);
          expect((r.seenBy >> partner(r.seat)) & 1).toBe(1);
          const opp = [(r.seat + 1) % 4, (r.seat + 3) % 4].map((x) => (r.seenBy >> x) & 1);
          for (let k = 0; k < 2; k++) {
            const key = `${r.seat}->${(r.seat + 1 + 2 * k) % 4}`;
            const cur = perPair.get(key) ?? [0, 0];
            perPair.set(key, [cur[0] + opp[k], cur[1] + 1]);
          }
          draws += 2;
          caught += opp[0] + opp[1];
          if (opp[0] && opp[1]) both++;
          if (!opp[0] && !opp[1]) neither++;
        }
      }
      const signals = draws / 2;
      // Binomial tolerances of about five standard deviations.
      expect(Math.abs(caught / draws - 0.25)).toBeLessThan(0.025);
      expect(Math.abs(both / signals - 1 / 16)).toBeLessThan(0.02);
      expect(Math.abs(neither / signals - 9 / 16)).toBeLessThan(0.04);
      expect(perPair.size).toBe(8);
      for (const [, [c, n]] of perPair) expect(Math.abs(c / n - 0.25)).toBeLessThan(0.065);
    });
  }

  it("'p25' observe().signals lists only the signals the seat caught, in the order they were sent", () => {
    let partial = 0;
    for (let i = 0; i < 100; i++) {
      const { s } = fourSignals('paulista', 'p25', 'p25-observe', i);
      for (let seat = 0; seat < 4; seat++) {
        const seen = s.hand.signals.filter((x) => (x.seenBy >> seat) & 1).map((x) => ({ seat: x.seat, signal: x.signal }));
        expect(observe(s, seat).signals).toEqual(seen);
        if (seen.length > 2 && seen.length < 4) partial++;
        checkObservationPrivacy(s, seat);
      }
    }
    expect(partial).toBeGreaterThan(0);
  });
});

describe('signals: eventsFor()', () => {
  /** A p25 match where seat 0 signals and seat 1 catches it while seat 3 does not. */
  function caughtByOneOpponent() {
    for (let i = 0; i < 500; i++) {
      const s = newMatch(makeConfig('paulista', 4), seedOf('events', i));
      const ev = act(s, [0, 'signal:copas']);
      const seenBy = s.hand.signals[0].seenBy;
      if (((seenBy >> 1) & 1) === 1 && ((seenBy >> 3) & 1) === 0) return { s, ev };
    }
    throw new Error('no seed found');
  }

  it("'p25': the catching opponent gets the signal without seenBy, the other opponent gets nothing", () => {
    const { s, ev } = caughtByOneOpponent();
    const o = s.config.options;
    expect(ev).toEqual([{ t: 'signal', seat: 0, signal: SIGNALS.indexOf('copas'), seenBy: 0b0111 }]);
    expect(eventsFor(ev, 1, o)).toEqual([{ t: 'signal', seat: 0, signal: SIGNALS.indexOf('copas'), seenBy: 0 }]);
    expect(eventsFor(ev, 3, o)).toEqual([]);
    // The signaler is not told who caught it, and neither is the partner.
    expect(eventsFor(ev, 0, o)).toEqual([{ t: 'signal', seat: 0, signal: SIGNALS.indexOf('copas'), seenBy: 0 }]);
    expect(eventsFor(ev, 2, o)).toEqual([{ t: 'signal', seat: 0, signal: SIGNALS.indexOf('copas'), seenBy: 0 }]);
  });

  it("'secret': opponents never receive the event, the team gets it without seenBy", () => {
    const s = rig({ players: 4, options: { signals: 'secret' }, cards: NEUTRAL4 });
    const ev = act(s, [3, 'signal:nada']);
    const o = s.config.options;
    expect(eventsFor(ev, 0, o)).toEqual([]);
    expect(eventsFor(ev, 2, o)).toEqual([]);
    for (const seat of [1, 3]) expect(eventsFor(ev, seat, o)).toEqual([{ t: 'signal', seat: 3, signal: SIGNALS.indexOf('nada'), seenBy: 0 }]);
  });

  it("'all': every seat receives the event with the full seenBy", () => {
    const s = rig({ players: 4, options: { signals: 'all' }, cards: NEUTRAL4 });
    const ev = act(s, [1, 'signal:zap']);
    for (let seat = 0; seat < 4; seat++) {
      expect(eventsFor(ev, seat, s.config.options)).toEqual([{ t: 'signal', seat: 1, signal: SIGNALS.indexOf('zap'), seenBy: 0b1111 }]);
    }
  });

  it('dropping an uncaught signal keeps every other event of the batch, in order', () => {
    const { s } = caughtByOneOpponent();
    // One batch with plays and a signal from seat 3 that some opponents may not catch.
    const ev: GameEvent[] = [];
    for (const [seat, name] of [[0, 'play0'], [1, 'play0'], [3, 'signal:nada'], [2, 'play0'], [3, 'play0']] as [number, string][]) {
      applyAction(s, seat, parseAction(name), ev);
    }
    for (let seat = 0; seat < 4; seat++) checkEventsFor(ev, s, seat);
    const sig = ev.find((e) => e.t === 'signal')!;
    for (let seat = 0; seat < 4; seat++) {
      const out = eventsFor(ev, seat, s.config.options);
      const sawIt = sig.t === 'signal' && (sig.seenBy >> seat) & 1;
      expect(out.length).toBe(sawIt ? ev.length : ev.length - 1);
      expect(out.filter((e) => e.t !== 'signal')).toEqual(ev.filter((e) => e.t !== 'signal'));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// observe() and eventsFor() in random matches

describe('privacy in random matches', () => {
  for (const variant of VARIANTS) {
    for (const players of TABLES) {
      it(`observe() never leaks seeds, hidden cards, truth flags or uncaught signals (${variant}, ${players} players)`, () => {
        let i = 0;
        let faceDowns = 0;
        let signals = 0;
        for (const mode of MODES) {
          for (const faceDownFirstRound of [false, true]) {
            for (const ironHand of ['blind', 'normal'] as const) {
              for (let k = 0; k < 2; k++, i++) {
                const config = makeConfig(variant, players, { signals: mode, faceDownFirstRound, ironHand });
                const s = newMatch(config, seedOf(`privacy-${variant}-${players}`, i));
                const rand = mulberry32(1000 + i);
                for (let n = 0; n < 3000 && !s.over; n++) {
                  for (let seat = 0; seat < players; seat++) checkObservationPrivacy(s, seat);
                  const ev = randomStep(s, rand);
                  for (let seat = 0; seat < players; seat++) checkEventsFor(ev, s, seat);
                  faceDowns += ev.filter((e) => e.t === 'play' && e.faceDown).length;
                  signals += ev.filter((e) => e.t === 'signal').length;
                }
                expect(s.over).toBe(true);
                for (let seat = 0; seat < players; seat++) checkObservationPrivacy(s, seat);
              }
            }
          }
        }
        expect(faceDowns).toBeGreaterThan(10);
        if (players === 4) expect(signals).toBeGreaterThan(50);
        else expect(signals).toBe(0);
      });
    }
  }

  it('observe() shows a seat only its own cards in a normal 2 against 2 hand', () => {
    const s = rig({ players: 4, cards: NEUTRAL4 });
    for (let seat = 0; seat < 4; seat++) {
      const o = observe(s, seat);
      expect(o.hand).toEqual(parseCards(NEUTRAL4[seat]));
      expect(o.partnerHand).toBeNull();
      expect(o.handCounts).toEqual([3, 3, 3, 3]);
    }
  });

  it('observe() never carries the truthful flag, even after lies and true signals', () => {
    for (const signals of MODES) {
      const s = rig({ players: 4, options: { signals }, cards: NEUTRAL4 });
      act(s, [0, 'signal:tres'], [1, 'signal:zap'], [2, 'signal:nada'], [3, 'signal:copas']);
      expect(s.hand.signals.map((x) => x.truthful)).toEqual([true, false, true, false]);
      for (let seat = 0; seat < 4; seat++) {
        const json = JSON.stringify(observe(s, seat));
        expect(json).not.toContain('truthful');
        expect(json).not.toContain(s.seed);
        expect(json).not.toContain(s.hand.seed);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Determinism of the interception draws

describe('signals: interception draws are part of the deterministic replay', () => {
  for (const variant of VARIANTS) {
    it(`replay() of the log rebuilds the same seenBy for every signal (${variant})`, () => {
      let opponentDraws = 0;
      let opponentCatches = 0;
      for (let i = 0; i < 25; i++) {
        const config = makeConfig(variant, 4, { signals: 'p25' });
        const seed = seedOf(`replay-${variant}`, i);
        const s = newMatch(config, seed);
        const rand = mulberry32(500 + i);
        for (let n = 0; n < 3000 && !s.over; n++) randomStep(s, rand);
        const r = replay(config, seed, s.log);
        expect(r.history.map((h) => h.signals)).toEqual(s.history.map((h) => h.signals));
        expect(r.hand.signals).toEqual(s.hand.signals);
        expect(JSON.stringify(r)).toBe(JSON.stringify(s));
        for (const hs of s.history) {
          for (const x of hs.signals) {
            for (const o of [(x.seat + 1) % 4, (x.seat + 3) % 4]) {
              opponentDraws++;
              opponentCatches += (x.seenBy >> o) & 1;
            }
          }
        }
      }
      // The check is meaningful only if both outcomes happened.
      expect(opponentCatches).toBeGreaterThan(0);
      expect(opponentCatches).toBeLessThan(opponentDraws);
    });
  }

  it('the same seed and the same actions give the same draws; the draws do vary across seeds', () => {
    const patterns = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const a = fourSignals('mineiro', 'p25', 'same-seed', i).s.hand.signals;
      const b = fourSignals('mineiro', 'p25', 'same-seed', i).s.hand.signals;
      expect(b).toEqual(a);
      patterns.add(a.map((x) => x.seenBy).join(','));
    }
    expect(patterns.size).toBeGreaterThan(5);
  });

  it('a JSON round trip in the middle of a hand keeps drawing the same interceptions', () => {
    for (let i = 0; i < 30; i++) {
      const s = newMatch(makeConfig('paulista', 4), seedOf('round-trip', i), { dealer: 3 });
      act(s, [2, 'signal:zap']);
      const copy = JSON.parse(JSON.stringify(s)) as MatchState;
      const rest: [number, string][] = [[0, 'signal:nada'], [0, 'play0'], [3, 'signal:tres'], [1, 'signal:copas']];
      act(s, ...rest);
      act(copy, ...rest);
      expect(copy.hand.signals).toEqual(s.hand.signals);
    }
  });

  it("signals in one hand do not change the next hand's deal or its interception draws", () => {
    for (let i = 0; i < 20; i++) {
      const config = makeConfig('paulista', 4);
      const seed = seedOf('next-hand', i);
      const withSignals = newMatch(config, seed);
      const without = newMatch(config, seed);
      act(withSignals, [1, 'signal:zap'], [3, 'signal:nada'], [0, 'signal:tres']);
      // Play hand 0 the same way in both: the expected actor plays its first card, face up.
      for (const s of [withSignals, without]) {
        while (s.hand.index === 0 && !s.over) {
          const seat = expectedActor(s);
          const slot = s.hand.cards[seat].findIndex((c) => c >= 0);
          applyAction(s, seat, slot);
        }
      }
      expect(withSignals.hand.index).toBe(1);
      expect(withSignals.score).toEqual(without.score);
      expect(withSignals.hand.seed).toBe(without.hand.seed);
      expect(withSignals.hand.dealt).toEqual(without.hand.dealt);
      expect(withSignals.hand.vira).toBe(without.hand.vira);
      act(withSignals, [2, 'signal:copas'], [1, 'signal:espadilha']);
      act(without, [2, 'signal:copas'], [1, 'signal:espadilha']);
      expect(withSignals.hand.signals).toEqual(without.hand.signals);
    }
  });
});

