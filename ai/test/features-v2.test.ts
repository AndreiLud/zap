import { describe, expect, it } from 'vitest';
import { makeConfig } from '../../engine/src/config.ts';
import { applyAction, expectedActor, newMatch } from '../../engine/src/engine.ts';
import { observe } from '../../engine/src/observe.ts';
import { mulberry32 } from '../../engine/src/rng.ts';
import { seriesSeed } from '../../engine/src/simulate.ts';
import { RandomAgent, agentContext } from '../src/agent.ts';
import { NUM_FEATURES, NUM_FEATURES_V2, STATS_OFFSET, encode, encoderFor, encoderInfo, quantize } from '../src/features.ts';
import { STATS_SIZE } from '../src/opponent-stats.ts';
import { TEST_PRIORS } from './model-helpers.ts';

function* states(count: number) {
  let k = 0;
  for (const variant of ['paulista', 'mineiro'] as const) {
    for (const players of [2, 4] as const) {
      for (let m = 0; m < count; m++) {
        const s = newMatch(makeConfig(variant, players), seriesSeed('f2'.repeat(32), k++));
        const rand = mulberry32(k);
        while (!s.over) {
          yield s;
          const seat = expectedActor(s);
          applyAction(s, seat, new RandomAgent().act(observe(s, seat), rand).action);
        }
      }
    }
  }
}

const header = (features: string, inputs: number, priors: unknown = TEST_PRIORS) => ({ features, inputs, meta: priors === null ? {} : { priors } }) as never;

describe('features v2', () => {
  it('start with the v1 features and add 30 statistics in [0, 1]', () => {
    const v2 = encoderFor(header('v2', NUM_FEATURES_V2));
    expect(v2.size).toBe(461);
    expect(STATS_OFFSET).toBe(431);
    const x1 = new Float32Array(NUM_FEATURES);
    const x2 = new Float32Array(NUM_FEATURES_V2);
    let live = 0;
    for (const s of states(3)) {
      const obs = observe(s, expectedActor(s));
      encode(obs, x1);
      quantize(x1);
      v2.encode(obs, x2, agentContext(s), 'live');
      expect(Array.from(x2.slice(0, NUM_FEATURES))).toEqual(Array.from(x1));
      for (const v of x2) expect(v >= 0 && v <= 1).toBe(true);
      const x0 = new Float32Array(NUM_FEATURES_V2);
      v2.emptyCopy(obs, x2, x0);
      if (x0.some((v, i) => v !== x2[i])) live++;
      expect(Array.from(x0.slice(0, NUM_FEATURES))).toEqual(Array.from(x1));
    }
    expect(live).toBeGreaterThan(100);
  });

  it('without a context, or with stats empty, read the no-evidence block', () => {
    const v2 = encoderFor(header('v2', NUM_FEATURES_V2));
    const info = encoderInfo('v2', TEST_PRIORS);
    const a = new Float32Array(NUM_FEATURES_V2);
    const b = new Float32Array(NUM_FEATURES_V2);
    for (const s of states(1)) {
      const obs = observe(s, expectedActor(s));
      v2.encode(obs, a, undefined, 'live');
      v2.encode(obs, b, agentContext(s), 'empty');
      expect(Array.from(b)).toEqual(Array.from(a));
      const seg = `${obs.variant}-${obs.players}` as keyof typeof info.empty;
      expect(Array.from(a.slice(STATS_OFFSET, STATS_OFFSET + STATS_SIZE))).toEqual(info.empty[seg]);
    }
  });

  it('with any seat in the noStats mask, read the no-evidence block for everyone (x equals x0)', () => {
    const v2 = encoderFor(header('v2', NUM_FEATURES_V2));
    const x = new Float32Array(NUM_FEATURES_V2);
    const x0 = new Float32Array(NUM_FEATURES_V2);
    const live = new Float32Array(NUM_FEATURES_V2);
    let differs = 0;
    for (const s of states(2)) {
      const me = expectedActor(s);
      const obs = observe(s, me);
      v2.encode(obs, live, agentContext(s), 'live');
      for (let seat = 0; seat < s.config.players; seat++) {
        v2.encode(obs, x, agentContext(s, 1 << seat), 'live');
        v2.emptyCopy(obs, x, x0);
        expect(Array.from(x)).toEqual(Array.from(x0));
        if (live.some((v, i) => v !== x[i])) differs++;
      }
    }
    // The mask changed the input wherever the live statistics held evidence.
    expect(differs).toBeGreaterThan(100);
  });

  it('seat priors reach only the statistics block, never a masked table, and agentContext never sets them', () => {
    const v2 = encoderFor(header('v2', NUM_FEATURES_V2));
    const profile = { raise: 0.9, run: 0.1, accept: 0.7, reraise: 0.2, shown: 0.2, cover: 0.6 };
    const plain = new Float32Array(NUM_FEATURES_V2);
    const hooked = new Float32Array(NUM_FEATURES_V2);
    let changed = 0;
    for (const s of states(2)) {
      const obs = observe(s, expectedActor(s));
      const ctx = agentContext(s);
      expect(ctx.seatPriors).toBeUndefined();
      const seatPriors = Array.from({ length: s.config.players }, () => profile);
      v2.encode(obs, plain, ctx, 'live');
      v2.encode(obs, hooked, { ...ctx, seatPriors }, 'live');
      expect(Array.from(hooked.slice(0, STATS_OFFSET))).toEqual(Array.from(plain.slice(0, STATS_OFFSET)));
      if (hooked.some((v, i) => v !== plain[i])) changed++;
      // A table with a seat in the noStats mask reads the no-evidence block, seat priors or not.
      v2.encode(obs, plain, agentContext(s, 1), 'live');
      v2.encode(obs, hooked, { ...agentContext(s, 1), seatPriors }, 'live');
      expect(Array.from(hooked)).toEqual(Array.from(plain));
    }
    expect(changed).toBeGreaterThan(100);
  });

  it('v2-empty ignores the context', () => {
    const twin = encoderFor(header('v2-empty', NUM_FEATURES_V2));
    const v2 = encoderFor(header('v2', NUM_FEATURES_V2));
    expect(twin.usesStats).toBe(false);
    const a = new Float32Array(NUM_FEATURES_V2);
    const b = new Float32Array(NUM_FEATURES_V2);
    for (const s of states(1)) {
      const obs = observe(s, expectedActor(s));
      twin.encode(obs, a, agentContext(s), 'live');
      v2.encode(obs, b, undefined, 'live');
      expect(Array.from(a)).toEqual(Array.from(b));
    }
  });

  it('v2-self reads the seat itself, the next seat and the partner: the slots v2 gives the previous seat', () => {
    const self = encoderFor(header('v2-self', NUM_FEATURES_V2));
    const v2 = encoderFor(header('v2', NUM_FEATURES_V2));
    expect(self.usesStats).toBe(true);
    const a = new Float32Array(NUM_FEATURES_V2);
    const b = new Float32Array(NUM_FEATURES_V2);
    const v1 = new Float32Array(NUM_FEATURES);
    let live = 0;
    for (const s of states(2)) {
      const n = s.config.players;
      const me = expectedActor(s);
      const obs = observe(s, me);
      self.encode(obs, a, agentContext(s), 'live');
      v2.encode(observe(s, (me + n - 1) % n), b, agentContext(s), 'live');
      expect(Array.from(a.slice(STATS_OFFSET))).toEqual(Array.from(b.slice(STATS_OFFSET)));
      encode(obs, v1);
      quantize(v1);
      expect(Array.from(a.slice(0, NUM_FEATURES))).toEqual(Array.from(v1));
      // Seat priors stay a v2 hook: v2-self ignores them.
      const c = new Float32Array(NUM_FEATURES_V2);
      self.encode(obs, c, { ...agentContext(s), seatPriors: Array.from({ length: n }, () => ({ raise: 0.9, run: 0.1, accept: 0.8, reraise: 0.1, shown: 0.9, cover: 0.9 })) }, 'live');
      expect(Array.from(c)).toEqual(Array.from(a));
      const x0 = new Float32Array(NUM_FEATURES_V2);
      self.emptyCopy(obs, a, x0);
      if (x0.some((v, i) => v !== a[i])) live++;
    }
    expect(live).toBeGreaterThan(100);
    expect(encoderInfo('v2-self', TEST_PRIORS).statsSize).toBe(30);
  });

  it('v1 ignores the context and keeps 431 inputs', () => {
    const v1 = encoderFor(header('v1', NUM_FEATURES, null));
    expect(v1.size).toBe(431);
    expect(v1.usesStats).toBe(false);
  });

  it('encoderFor refuses an unknown version, missing or bad priors, and the wrong size', () => {
    expect(() => encoderFor(header('v3', NUM_FEATURES_V2))).toThrow(/unknown/);
    expect(() => encoderFor(header('v2', NUM_FEATURES_V2, null))).toThrow(/priors/);
    expect(() => encoderFor(header('v2', NUM_FEATURES_V2, { ...TEST_PRIORS, alpha: -1 }))).toThrow(/alpha/);
    expect(() => encoderFor(header('v2', NUM_FEATURES))).toThrow(/inputs/);
    expect(() => encoderFor(header('v1', NUM_FEATURES_V2))).toThrow(/inputs/);
  });

  it('encoderInfo gives the sizes and a quantized empty block per segment', () => {
    const info = encoderInfo('v2-empty', TEST_PRIORS);
    expect(info.size).toBe(461);
    expect(info.statsOffset).toBe(431);
    expect(info.statsSize).toBe(30);
    for (const block of Object.values(info.empty)) {
      expect(block).toHaveLength(30);
      for (const v of block) expect(Math.round(v * 255)).toBeCloseTo(v * 255, 3);
    }
    expect(encoderInfo('v1', null).statsSize).toBe(0);
  });
});
