import { describe, expect, it } from 'vitest';
import { makeConfig } from '../../engine/src/config.ts';
import { applyAction, expectedActor, newMatch, type MatchState } from '../../engine/src/engine.ts';
import { observe, type Observation } from '../../engine/src/observe.ts';
import { buildPublicHistory, publicHistory } from '../../engine/src/public.ts';
import { mulberry32 } from '../../engine/src/rng.ts';
import { seriesSeed } from '../../engine/src/simulate.ts';
import { RandomAgent } from '../src/agent.ts';
import { quantize } from '../src/features.ts';
import {
  SEGMENTS,
  STATS_SIZE,
  countHands,
  decisionEvidence,
  encodeCount,
  encodeStats,
  matchCounts,
  segmentOf,
  validatePriors,
  validateSegmentPriors,
  type MatchCounts,
  type SegmentPriors,
} from '../src/opponent-stats.ts';
import { TEST_PRIORS } from './model-helpers.ts';
import { act, rig } from '../../engine/test/helpers.ts';

const P = TEST_PRIORS;

/** Paulista 1 against 1, faceDownFirstRound on: truco by seat 0, accepted; seat 1 covers in round 1; seat 0 wins rounds 1 and 2. */
function scripted(): MatchState {
  const s = rig({ cards: ['3c 3h 3s', '4s 5s 7s'], options: { faceDownFirstRound: true } });
  act(s, [0, 'raise'], [1, 'accept'], [0, 'play0'], [1, 'cover0'], [0, 'play1'], [1, 'play1']);
  return s;
}

function* randomMatches(count: number, seed = 'e1') {
  let k = 0;
  for (const variant of ['paulista', 'mineiro'] as const) {
    for (const players of [2, 4] as const) {
      const config = makeConfig(variant, players, { faceDownFirstRound: k % 2 === 0, raiseAnyTime: k % 3 === 0 });
      for (let m = 0; m < count; m++) {
        const s = newMatch(config, seriesSeed(seed.repeat(32), k++));
        const rand = mulberry32(k);
        const agent = new RandomAgent();
        while (!s.over) {
          yield s;
          const seat = expectedActor(s);
          applyAction(s, seat, agent.act(observe(s, seat), rand).action);
        }
        yield s;
      }
    }
  }
}

describe('opponent statistics: counts', () => {
  it('count a scripted hand exactly', () => {
    const s = scripted();
    expect(s.history).toHaveLength(1);
    const m = countHands(publicHistory(s));
    expect(m.hands).toBe(1);
    expect(m.seats[0]).toEqual({ H: 1, K: 1, U: 0, A: 0, X: 0, S: (2 * 9) / 13, Q: 2, V: 0, W: 1 });
    expect(m.seats[1]).toEqual({ H: 1, K: 0, U: 0, A: 1, X: 0, S: 0, Q: 0, V: 1, W: 2 });
  });

  it('encode the scripted hand from the other seat, shrunk towards the priors', () => {
    const s = scripted();
    const obs = observe(s, 1);
    const out = new Float32Array(STATS_SIZE);
    encodeStats(out, 0, obs, matchCounts(publicHistory(s)), 0, P);
    const p = P.segments['paulista-2'];
    const a = P.alpha;
    const expected = [
      (1 + a * p.raise) / (1 + a),
      p.run,
      p.accept,
      p.reraise,
      ((2 * 9) / 13 + a * p.shown) / (2 + a),
      (0 + a * p.cover) / (1 + a),
      encodeCount(1),
      0,
      encodeCount(2),
      encodeCount(1),
    ];
    expected.forEach((v, i) => expect(out[i]).toBeCloseTo(v, 6));
    // 1 against 1: the partner and previous slots read the priors and zero counts.
    const empty = [p.raise, p.run, p.accept, p.reraise, p.shown, p.cover, 0, 0, 0, 0];
    for (let r = 1; r < 3; r++) empty.forEach((v, i) => expect(out[r * 10 + i]).toBeCloseTo(v, 6));
  });

  it('read exactly the priors and zero counts with no history, per segment', () => {
    for (const seg of SEGMENTS) {
      const [variant, players] = seg.split('-');
      const s = newMatch(makeConfig(variant as 'paulista' | 'mineiro', Number(players) as 2 | 4), 'ab'.repeat(32));
      const obs = observe(s, expectedActor(s));
      const live = new Float32Array(STATS_SIZE);
      const none = new Float32Array(STATS_SIZE);
      encodeStats(live, 0, obs, matchCounts(publicHistory(s)), 0, P);
      encodeStats(none, 0, obs, null, 0, P);
      quantize(live);
      quantize(none);
      expect(Array.from(live)).toEqual(Array.from(none));
      const p = P.segments[seg];
      const q = (v: number) => Math.fround(Math.round(Math.fround(v) * 255) / 255);
      expect(Array.from(none.slice(0, 10))).toEqual([p.raise, p.run, p.accept, p.reraise, p.shown, p.cover, 0, 0, 0, 0].map(q));
      expect(segmentOf(obs.variant, obs.players)).toBe(seg);
    }
  });

  it('noStats seats and missing evidence read empty; slots follow the relative seats', () => {
    let checked = 0;
    for (const s of randomMatches(4)) {
      if (s.history.length < 2 || s.over) continue;
      const h = publicHistory(s);
      const m = matchCounts(h);
      for (let seat = 0; seat < s.n; seat++) {
        const obs = observe(s, seat);
        const live = new Float32Array(STATS_SIZE);
        const none = new Float32Array(STATS_SIZE);
        encodeStats(none, 0, obs, null, 0, P);
        // Every other seat hidden: the whole block is empty.
        encodeStats(live, 0, obs, m, 0b1111, P);
        expect(Array.from(live)).toEqual(Array.from(none));
        // Each slot shows the right seat: hide one seat at a time.
        for (let r = 1; r <= (s.n === 2 ? 1 : 3); r++) {
          const target = (seat + r) % s.n;
          const one = new Float32Array(STATS_SIZE);
          encodeStats(one, 0, obs, m, ~(1 << target), P);
          for (let rr = 1; rr <= 3; rr++) {
            const slot = Array.from(one.slice((rr - 1) * 10, rr * 10));
            const emptySlot = Array.from(none.slice((rr - 1) * 10, rr * 10));
            if (rr !== r) expect(slot).toEqual(emptySlot);
          }
        }
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('the incremental cache equals a computation from scratch, and every value stays in [0, 1]', () => {
    for (const s of randomMatches(3, 'e2')) {
      const cached = matchCounts(publicHistory(s));
      const scratch = countHands(buildPublicHistory(s));
      expect(cached).toEqual(scratch);
      const obs = observe(s, s.over ? 0 : expectedActor(s));
      const out = new Float32Array(STATS_SIZE);
      encodeStats(out, 0, obs, cached, 0, P);
      for (const v of out) expect(v >= 0 && v <= 1).toBe(true);
    }
  });
});

describe('opponent statistics: seat priors (the profile hook, off)', () => {
  /** A prior far from the population one, with answers that add up to 1. */
  const profile: SegmentPriors = { raise: 0.9, run: 0.1, accept: 0.7, reraise: 0.2, shown: 0.2, cover: 0.6 };

  it('without seat priors, or with null and the population prior itself, nothing changes', () => {
    for (const s of randomMatches(2, 'e3')) {
      const obs = observe(s, s.over ? 0 : expectedActor(s));
      const m = matchCounts(publicHistory(s));
      const plain = new Float32Array(STATS_SIZE);
      const hooked = new Float32Array(STATS_SIZE);
      encodeStats(plain, 0, obs, m, 0, P);
      encodeStats(hooked, 0, obs, m, 0, P, [null, undefined, null, null]);
      expect(Array.from(hooked)).toEqual(Array.from(plain));
      const pop = P.segments[segmentOf(obs.variant, obs.players)];
      encodeStats(hooked, 0, obs, m, 0, P, Array.from({ length: obs.players }, () => pop));
      expect(Array.from(hooked)).toEqual(Array.from(plain));
    }
  });

  it("replace the population prior of one seat's live slot only, with the same weight", () => {
    const s = scripted();
    const obs = observe(s, 1);
    const m = matchCounts(publicHistory(s));
    const out = new Float32Array(STATS_SIZE);
    encodeStats(out, 0, obs, m, 0, P, [profile, null]);
    const a = P.alpha;
    const expected = [
      (1 + a * profile.raise) / (1 + a),
      profile.run,
      profile.accept,
      profile.reraise,
      ((2 * 9) / 13 + a * profile.shown) / (2 + a),
      (0 + a * profile.cover) / (1 + a),
      encodeCount(1),
      0,
      encodeCount(2),
      encodeCount(1),
    ];
    expected.forEach((v, i) => expect(out[i]).toBeCloseTo(v, 6));
    // The empty slots of 1 against 1 keep the population prior.
    const p = P.segments['paulista-2'];
    const empty = [p.raise, p.run, p.accept, p.reraise, p.shown, p.cover, 0, 0, 0, 0];
    for (let r = 1; r < 3; r++) empty.forEach((v, i) => expect(out[r * 10 + i]).toBeCloseTo(v, 6));
  });

  it('never reach the no-evidence block: no history, a masked seat, a missing seat', () => {
    for (const s of randomMatches(2, 'e4')) {
      if (s.over) continue;
      const obs = observe(s, expectedActor(s));
      const seatPriors = Array.from({ length: obs.players }, () => profile);
      const none = new Float32Array(STATS_SIZE);
      const hooked = new Float32Array(STATS_SIZE);
      encodeStats(none, 0, obs, null, 0, P);
      encodeStats(hooked, 0, obs, null, 0, P, seatPriors);
      expect(Array.from(hooked)).toEqual(Array.from(none));
      encodeStats(hooked, 0, obs, matchCounts(publicHistory(s)), 0b1111, P, seatPriors);
      expect(Array.from(hooked)).toEqual(Array.from(none));
    }
  });

  it('validate a seat prior like a segment of the priors', () => {
    expect(validateSegmentPriors(profile)).toEqual(profile);
    expect(() => validateSegmentPriors({ ...profile, run: 0.5 })).toThrow();
    expect(() => validateSegmentPriors({ ...profile, cover: 0 })).toThrow();
    expect(() => validateSegmentPriors(null)).toThrow();
  });
});

describe('opponent statistics: evidence', () => {
  const counts = (e: number[]): MatchCounts => ({ hands: 3, seats: e.map((k) => ({ H: 3, K: k, U: 0, A: 0, X: 0, S: 0, Q: 0, V: 0, W: 0 })) });
  const base = { players: 4, seat: 0, phase: 'play', raiser: -1 } as unknown as Observation;

  it('is about the raiser when answering a raise', () => {
    expect(decisionEvidence({ ...base, phase: 'raise', raiser: 3 }, counts([5, 1, 7, 4]), 0)).toBe(4);
    expect(decisionEvidence({ ...base, phase: 'raise', raiser: 1 }, counts([5, 1, 7, 4]), 0)).toBe(1);
  });

  it('is the least known opponent otherwise, with noStats seats at 0', () => {
    expect(decisionEvidence(base, counts([5, 2, 7, 4]), 0)).toBe(2);
    expect(decisionEvidence({ ...base, seat: 1 }, counts([5, 2, 7, 4]), 0)).toBe(5);
    expect(decisionEvidence(base, counts([5, 2, 7, 4]), 1 << 3)).toBe(0);
    expect(decisionEvidence(base, null, 0)).toBe(0);
  });

  it('counts answers too: K + U + A + X', () => {
    const m: MatchCounts = { hands: 2, seats: [{ H: 2, K: 1, U: 1, A: 1, X: 1, S: 0, Q: 0, V: 0, W: 0 }, { H: 2, K: 0, U: 0, A: 0, X: 0, S: 0, Q: 0, V: 0, W: 0 }] };
    expect(decisionEvidence({ ...base, players: 2, seat: 1 } as Observation, m, 0)).toBe(4);
  });
});

describe('priors', () => {
  it('validate the shape', () => {
    expect(validatePriors(P)).toEqual(P);
    expect(() => validatePriors({ ...P, alpha: 0 })).toThrow();
    expect(() => validatePriors({ ...P, segments: { ...P.segments, 'mineiro-4': undefined } })).toThrow();
    expect(() => validatePriors({ ...P, segments: { ...P.segments, 'paulista-2': { ...P.segments['paulista-2'], run: 0.5 } } })).toThrow();
    expect(() => validatePriors({ ...P, segments: { ...P.segments, 'paulista-2': { ...P.segments['paulista-2'], cover: 1 } } })).toThrow();
  });
});
