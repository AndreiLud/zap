// The public history of a match (engine/src/public.ts): only what everyone at the table saw,
// the same for every seat, cached without changing the result, and rebuilt identically by replay.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  NUM_ACTIONS,
  actingSeats,
  applyAction,
  buildPublicHistory,
  expectedActor,
  legalMask,
  makeConfig,
  mulberry32,
  newMatch,
  publicHistory,
  replay,
  type BetRecord,
  type HandSummary,
  type MatchConfig,
  type MatchState,
  type PublicHand,
  type PublicHistory,
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

type Opts = typeof optionsArb extends fc.Arbitrary<infer T> ? T : never;

function toConfig(o: Opts): MatchConfig {
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

/** A random match where any seat with a legal action may act, as in properties.test.ts. Bets are made more often. */
function chaos(config: MatchConfig, seed: string, policySeed: number, onStep: (s: MatchState) => void): MatchState {
  const rand = mulberry32(policySeed);
  const s = newMatch(config, seed);
  let guard = 0;
  while (!s.over) {
    onStep(s);
    const seats = actingSeats(s);
    const seat = rand() < 0.8 ? expectedActor(s) : seats[Math.floor(rand() * seats.length)];
    const mask = legalMask(s, seat);
    const acts = [...Array(NUM_ACTIONS).keys()].filter((a) => mask & (1 << a));
    applyAction(s, seat, acts[Math.floor(rand() * acts.length)]);
    if (++guard > 20_000) throw new Error('match did not end');
  }
  onStep(s);
  return s;
}

/** The engine's own hands (finished, then the current one) next to their public versions. */
function pairs(s: MatchState, p: PublicHistory): { pub: PublicHand; vira: number; plays: { seat: number; card: number; faceDown: boolean }[][] }[] {
  const out = p.hands.map((pub, i) => {
    const h: HandSummary = s.history[i];
    return { pub, vira: h.vira, plays: h.rounds.map((r) => r.plays) };
  });
  if (p.current) out.push({ pub: p.current, vira: s.hand.vira, plays: s.hand.rounds.map((r) => r.plays) });
  return out;
}

const FORBIDDEN_KEYS = ['seed', 'dealt', 'cards', 'signal', 'signals', 'truthful', 'seenBy', 'strength', 'rng', 'raiser', 'lastRaiseTeam', 'hand'];

function keysOf(x: unknown, out: Set<string>): void {
  if (Array.isArray(x)) for (const v of x) keysOf(v, out);
  else if (x && typeof x === 'object') {
    for (const [k, v] of Object.entries(x)) {
      out.add(k);
      keysOf(v, out);
    }
  }
}

function checkBets(bets: readonly BetRecord[], step: number, reason: string | null, kind: string, onzeTeam: number): void {
  const accepted = bets.filter((b) => b.kind === 'accept' || (b.kind === 'raise' && b.answer)).length;
  expect(accepted).toBe(step);
  if (reason !== null) expect(reason === 'run').toBe(bets.length > 0 && bets[bets.length - 1].kind === 'run');
  const onze = bets.filter((b) => b.kind === 'onzePlay' || b.kind === 'onzeRun');
  if (kind === 'onze' && reason !== null) {
    expect(onze).toHaveLength(1);
    expect(onze[0].seat & 1).toBe(onzeTeam);
    expect(bets[0]).toBe(onze[0]);
  } else if (kind !== 'onze') expect(onze).toHaveLength(0);
  for (const b of bets) {
    expect(b.round >= 0 && b.round <= 2).toBe(true);
    if (b.kind === 'raise') expect(b.step >= 1 && b.step <= 4).toBe(true);
  }
}

function checkPublic(s: MatchState): void {
  const p = publicHistory(s);
  // (6) The cached result equals a computation from scratch.
  expect(JSON.stringify(p)).toBe(JSON.stringify(buildPublicHistory(s)));
  expect(p.hands).toHaveLength(s.history.length);
  expect(p.current === null).toBe(s.over);
  const json = JSON.stringify({ hands: p.hands, current: p.current });
  // (3) No private field and no seed.
  const keys = new Set<string>();
  keysOf({ hands: p.hands, current: p.current }, keys);
  for (const k of FORBIDDEN_KEYS) expect(keys.has(k)).toBe(false);
  expect(json).not.toContain(s.seed);
  for (const h of s.history) expect(json).not.toContain(h.seed);
  expect(json).not.toContain(s.hand.seed);
  for (const { pub, vira, plays } of pairs(s, p)) {
    expect(pub.vira).toBe(vira);
    // Cards anyone may know in this hand: the vira and the cards played face up.
    const publicCards = new Set<number>();
    if (vira >= 0) publicCards.add(vira);
    pub.rounds.forEach((r, ri) => {
      expect(r.plays).toHaveLength(plays[ri].length);
      r.plays.forEach((pp, pi) => {
        const real = plays[ri][pi];
        expect(pp.seat).toBe(real.seat);
        expect(pp.faceDown).toBe(real.faceDown);
        // (2) Face down reads -1 for everyone.
        if (real.faceDown) expect(pp.card).toBe(-1);
        // (1) A card shown is the one this seat played face up.
        else {
          expect(pp.card).toBe(real.card);
          publicCards.add(real.card);
        }
      });
    });
    // (4) Every card in the public hand was public to every seat.
    const cards = [pub.vira, ...pub.rounds.flatMap((r) => r.plays.map((x) => x.card))].filter((c) => c >= 0);
    for (const c of cards) expect(publicCards.has(c)).toBe(true);
  }
  // (7) Bet invariants for every finished hand and the current one.
  s.history.forEach((h) => checkBets(h.bets, h.step, h.result.reason, h.kind, h.onzeTeam));
  if (!s.over) checkBets(s.hand.bets, s.hand.step, null, s.hand.kind, s.hand.onzeTeam);
}

describe('public history', () => {
  it('holds only public facts, caches without changing the result, and keeps the bet invariants', () => {
    fc.assert(
      fc.property(optionsArb, seedArb, fc.integer(), (o, seed, ps) => {
        const config = toConfig(o);
        const s = chaos(config, seed, ps, checkPublic);
        // (5) A replay of the log gives the same public history.
        expect(JSON.stringify(publicHistory(replay(config, seed, s.log)))).toBe(JSON.stringify(publicHistory(s)));
      }),
      { numRuns: 300 },
    );
  });

  it('is the same object for every seat and changes only when a hand ends', () => {
    const s = newMatch(makeConfig('paulista', 4), 'ab'.repeat(32));
    const rand = mulberry32(3);
    const first = publicHistory(s).hands;
    while (s.history.length === 0) {
      const seat = expectedActor(s);
      const mask = legalMask(s, seat);
      const acts = [...Array(NUM_ACTIONS).keys()].filter((a) => mask & (1 << a));
      applyAction(s, seat, acts[Math.floor(rand() * acts.length)]);
    }
    const after = publicHistory(s).hands;
    expect(after).toBe(first);
    expect(after).toHaveLength(1);
    expect(publicHistory(s).hands[0]).toBe(after[0]);
  });
});
