// Property-based tests: invariants that must hold in every reachable state, for every variant,
// table size and room option.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  A_RAISE,
  DECK_SIZE,
  HIDDEN,
  IllegalActionError,
  NUM_ACTIONS,
  actingSeats,
  applyAction,
  expectedActor,
  ladderOf,
  legalMask,
  makeConfig,
  mulberry32,
  newMatch,
  observe,
  onzeRunPoints,
  onzeValue,
  replay,
  type MatchConfig,
  type MatchState,
} from '../src/index.ts';

const optionsArb = fc.record({
  variant: fc.constantFrom('paulista' as const, 'mineiro' as const),
  players: fc.constantFrom(2 as const, 4 as const),
  ladder8: fc.boolean(),
  raiseAnyTime: fc.boolean(),
  bestOf: fc.constantFrom(1 as const, 3 as const),
  onzeSeesPartner: fc.boolean(),
  onzeTieToOpponents: fc.boolean(),
  ironHand: fc.constantFrom('blind' as const, 'normal' as const),
  faceDownFirstRound: fc.boolean(),
  allTieToMao: fc.boolean(),
  signals: fc.constantFrom('secret' as const, 'p25' as const, 'all' as const),
});

function toConfig(o: fc.Arbitrary<unknown> extends never ? never : any): MatchConfig {
  return makeConfig(o.variant, o.players, {
    ladder: o.variant === 'mineiro' && o.ladder8 ? 'mineiro8' : 'standard',
    raiseAnyTime: o.raiseAnyTime,
    bestOf: o.bestOf,
    onzeSeesPartner: o.onzeSeesPartner,
    onzeTieToOpponents: o.onzeTieToOpponents,
    ironHand: o.ironHand,
    faceDownFirstRound: o.faceDownFirstRound,
    allTieToMao: o.allTieToMao,
    signals: o.signals,
  });
}

const seedArb = fc.uint8Array({ minLength: 32, maxLength: 32 }).map((b) => Buffer.from(b).toString('hex'));

/** Plays a random match where any seat with a legal action may act (not only the expected one). */
function chaos(config: MatchConfig, seed: string, policySeed: number, onStep: (s: MatchState) => void): MatchState {
  const rand = mulberry32(policySeed);
  const s = newMatch(config, seed);
  let guard = 0;
  while (!s.over) {
    onStep(s);
    const seats = actingSeats(s);
    expect(seats.length).toBeGreaterThan(0);
    expect(seats).toContain(expectedActor(s));
    // Mostly the expected actor; sometimes someone else with a legal action.
    const seat = rand() < 0.8 ? expectedActor(s) : seats[Math.floor(rand() * seats.length)];
    const mask = legalMask(s, seat);
    const acts = [...Array(NUM_ACTIONS).keys()].filter((a) => mask & (1 << a));
    // Try an illegal action first now and then: it must throw and change nothing.
    if (rand() < 0.1) {
      const illegal = [...Array(NUM_ACTIONS + 2).keys()].map((a) => a - 1).filter((a) => !(a >= 0 && a < NUM_ACTIONS && mask & (1 << a)));
      const bad = illegal[Math.floor(rand() * illegal.length)];
      const before = JSON.stringify(s);
      expect(() => applyAction(s, seat, bad)).toThrow(IllegalActionError);
      expect(JSON.stringify(s)).toBe(before);
    }
    applyAction(s, seat, acts[Math.floor(rand() * acts.length)]);
    if (++guard > 20_000) throw new Error('match did not end');
  }
  onStep(s);
  return s;
}

function checkInvariants(s: MatchState): void {
  const h = s.hand;
  // No card appears twice among hands, table and vira; dealt cards are 3 per seat.
  const dealt = h.dealt.flat();
  if (h.vira >= 0) dealt.push(h.vira);
  expect(new Set(dealt).size).toBe(dealt.length);
  for (const c of dealt) expect(c >= 0 && c < DECK_SIZE).toBe(true);
  for (let seat = 0; seat < s.n; seat++) {
    const inHand = h.cards[seat].filter((c) => c >= 0);
    const played = h.rounds.flatMap((r) => r.plays).filter((p) => p.seat === seat).map((p) => p.card);
    expect([...inHand, ...played].sort((a, b) => a - b)).toEqual([...h.dealt[seat]].sort((a, b) => a - b));
  }
  // Scores stay below the target while the match goes on; values come from the ladder.
  if (!s.over) {
    expect(Math.max(...s.score)).toBeLessThan(12);
    const ladder = ladderOf(s.config);
    if (h.kind === 'onze') expect(h.value).toBe(onzeValue(s.config));
    else expect(h.value).toBe(ladder[h.step]);
  }
  // Only the expected actor can play a card.
  for (let seat = 0; seat < s.n; seat++) {
    if (seat !== expectedActor(s) || h.phase !== 'play') expect(legalMask(s, seat) & 0b111111).toBe(0);
  }
  // Mão de onze / de dez and mão de ferro: no raise for anyone.
  if (h.kind !== 'normal') for (let seat = 0; seat < s.n; seat++) expect(legalMask(s, seat) & (1 << A_RAISE)).toBe(0);
}

function checkHistory(s: MatchState): void {
  const ladder = ladderOf(s.config);
  let prev: [number, number] = [0, 0];
  let prevGames = 0;
  for (const hs of s.history) {
    const r = hs.result;
    if (r.reason === 'onzeRun') expect(r.points).toBe(onzeRunPoints(s.config));
    else if (r.winner >= 0) {
      if (hs.kind === 'onze') expect(r.points).toBe(onzeValue(s.config));
      else expect(ladder).toContain(r.points);
    } else expect(r.points).toBe(0);
    // Score only goes up within a game.
    // A new game starts after one is won: the score went back to 0 to 0 before this hand.
    const reset = Math.max(...prev) >= 12;
    expect(hs.gamesAfter[0] + hs.gamesAfter[1]).toBeGreaterThanOrEqual(prevGames);
    prevGames = hs.gamesAfter[0] + hs.gamesAfter[1];
    if (!reset) {
      expect(hs.scoreAfter[0]).toBeGreaterThanOrEqual(prev[0]);
      expect(hs.scoreAfter[1]).toBeGreaterThanOrEqual(prev[1]);
    }
    prev = hs.scoreAfter;
  }
  const need = s.config.options.bestOf === 3 ? 2 : 1;
  expect(s.games[s.winner]).toBe(need);
  expect(s.games[1 - s.winner]).toBeLessThan(need);
  if (s.config.variant === 'mineiro') for (const hs of s.history) expect(hs.scoreAfter.every((x) => x % 2 === 0) || hs.scoreAfter.some((x) => x >= 12)).toBe(true);
}

/** Cards a seat is allowed to know right now. */
function allowedCards(s: MatchState, seat: number): Set<number> {
  const h = s.hand;
  const ok = new Set<number>();
  if (h.vira >= 0) ok.add(h.vira);
  if (h.kind !== 'iron') for (const c of h.cards[seat]) if (c >= 0) ok.add(c);
  for (const r of h.rounds) for (const p of r.plays) if (!p.faceDown || p.seat === seat) ok.add(p.card);
  if (s.n === 4 && h.kind === 'onze' && s.config.options.onzeSeesPartner && (seat & 1) === h.onzeTeam) {
    for (const c of h.cards[(seat + 2) % 4]) if (c >= 0) ok.add(c);
  }
  return ok;
}

function checkObservation(s: MatchState): void {
  for (let seat = 0; seat < s.n; seat++) {
    const o = observe(s, seat);
    const ok = allowedCards(s, seat);
    const seen = [o.vira, ...o.hand, ...(o.partnerHand ?? []), ...o.rounds.flatMap((r) => r.plays.map((p) => p.card))].filter((c) => c >= 0);
    for (const c of seen) expect(ok.has(c)).toBe(true);
    if (s.hand.kind === 'iron') expect(o.hand.every((c) => c === -1 || c === HIDDEN)).toBe(true);
    for (const sig of o.signals) {
      const rec = s.hand.signals.find((x) => x.seat === sig.seat)!;
      expect((rec.seenBy >> seat) & 1).toBe(1);
    }
    const json = JSON.stringify(o);
    expect(json).not.toContain(s.seed);
    expect(json).not.toContain(s.hand.seed);
    expect(json).not.toContain('truthful');
    expect(json).not.toContain('dealt');
    expect(o.legal).toBe(legalMask(s, seat));
  }
}

describe('random matches keep every invariant', () => {
  it('for any seed, variant, table size and room option', () => {
    fc.assert(
      fc.property(optionsArb, seedArb, fc.integer(), (o, seed, ps) => {
        const config = toConfig(o);
        const s = chaos(config, seed, ps, (st) => {
          checkInvariants(st);
          checkObservation(st);
        });
        checkHistory(s);
      }),
      { numRuns: 300 },
    );
  });
});

describe('determinism', () => {
  it('the same seed and the same actions give the same match', () => {
    fc.assert(
      fc.property(optionsArb, seedArb, fc.integer(), (o, seed, ps) => {
        const config = toConfig(o);
        const a = chaos(config, seed, ps, () => {});
        const b = replay(config, seed, a.log);
        expect(JSON.stringify(b)).toBe(JSON.stringify(a));
        const c = chaos(config, seed, ps, () => {});
        expect(JSON.stringify(c)).toBe(JSON.stringify(a));
      }),
      { numRuns: 100 },
    );
  });

  it('a different seed deals different cards', () => {
    const config = makeConfig('paulista', 4);
    const a = newMatch(config, 'ab'.repeat(32));
    const b = newMatch(config, 'ac'.repeat(32));
    expect(a.hand.dealt).not.toEqual(b.hand.dealt);
  });

  it('a JSON round trip of the state keeps playing the same way', () => {
    const config = makeConfig('mineiro', 4);
    const a = newMatch(config, 'ef'.repeat(32));
    const rand = mulberry32(9);
    for (let i = 0; i < 40 && !a.over; i++) {
      const seat = expectedActor(a);
      const mask = legalMask(a, seat);
      const acts = [...Array(NUM_ACTIONS).keys()].filter((x) => mask & (1 << x));
      applyAction(a, seat, acts[Math.floor(rand() * acts.length)]);
    }
    const b = JSON.parse(JSON.stringify(a)) as MatchState;
    for (let i = 0; i < 200 && !a.over; i++) {
      const seat = expectedActor(a);
      const mask = legalMask(a, seat);
      const acts = [...Array(NUM_ACTIONS).keys()].filter((x) => mask & (1 << x));
      const pick = acts[Math.floor(rand() * acts.length)];
      applyAction(a, seat, pick);
      applyAction(b, seat, pick);
    }
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
