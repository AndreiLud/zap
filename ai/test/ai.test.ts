import { describe, expect, it } from 'vitest';
import { makeConfig } from '../../engine/src/config.ts';
import { applyAction, expectedActor, legalMask, newMatch } from '../../engine/src/engine.ts';
import { observe } from '../../engine/src/observe.ts';
import { mulberry32 } from '../../engine/src/rng.ts';
import { seriesSeed } from '../../engine/src/simulate.ts';
import { RandomAgent, agentContext } from '../src/agent.ts';
import { NUM_FEATURES, encode, fromCanonical, toCanonical, toCanonicalAction } from '../src/features.ts';
import { BASE_PARAMS, HeuristicAgent, paramsToVector, vectorToParams } from '../src/heuristic.ts';
import { buildModelFile, forward, maskedSoftmax, parseModel, type RawLayer } from '../src/mlp.ts';
import { NEUTRAL_KNOBS, NetAgent, policy } from '../src/net-agent.ts';
import { PERSONAS, personaAgent } from '../src/personas.ts';
import { gameTable, matchTable } from '../src/winprob.ts';
import { strengthTable } from '../../engine/src/cards.ts';
import { NUM_FEATURES_V2 } from '../src/features.ts';
import { makeModel, widen } from './model-helpers.ts';

function randomModel(seed: number, hidden = [32, 16]) {
  const rand = mulberry32(seed);
  const dims = [NUM_FEATURES, ...hidden];
  const layers: RawLayer[] = [];
  const mk = (name: string, rows: number, cols: number) => ({
    name,
    rows,
    cols,
    weight: Float32Array.from({ length: rows * cols }, () => (rand() - 0.5) * 0.4),
    bias: Float32Array.from({ length: rows }, () => (rand() - 0.5) * 0.1),
  });
  for (let i = 0; i < hidden.length; i++) layers.push(mk(`trunk.${i}`, dims[i + 1], dims[i]));
  layers.push(mk('policy', 15, hidden[hidden.length - 1]));
  layers.push(mk('value', 1, hidden[hidden.length - 1]));
  return { layers, base: { arch: 'mlp-v1' as const, features: 'v1' as const, inputs: NUM_FEATURES, hidden, policy: 15, value: 1 } };
}

/** Visits states of random matches in every variant and table size. */
function* states(count: number) {
  let k = 0;
  for (const variant of ['paulista', 'mineiro'] as const) {
    for (const players of [2, 4] as const) {
      const config = makeConfig(variant, players);
      for (let m = 0; m < count; m++) {
        const s = newMatch(config, seriesSeed('a1'.repeat(32), k++));
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

describe('model files', () => {
  it('a written f32 model reads back exactly, also from a Node Buffer', () => {
    const { layers, base } = randomModel(1);
    const bytes = buildModelFile(base, layers, 'f32');
    const m = parseModel(Buffer.from(bytes));
    expect(Array.from(m.trunk[0].wf!.slice(0, 50))).toEqual(Array.from(layers[0].weight.slice(0, 50)));
    expect(Array.from(m.value.bias)).toEqual(Array.from(layers[3].bias));
  });

  it('int8 weights give nearly the same outputs as f32', () => {
    const { layers, base } = randomModel(2);
    const f32 = parseModel(buildModelFile(base, layers, 'f32'));
    const i8 = parseModel(buildModelFile(base, layers, 'i8'));
    const x = new Float32Array(NUM_FEATURES);
    let worst = 0;
    for (const s of states(3)) {
      const obs = observe(s, expectedActor(s));
      encode(obs, x);
      const a = Array.from(forward(f32, x).logits);
      const b = Array.from(forward(i8, x).logits);
      for (let i = 0; i < 15; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
    }
    expect(worst).toBeLessThan(0.05);
  });

  it('rejects other files', () => {
    expect(() => parseModel(new Uint8Array(16))).toThrow();
  });
});

describe('features', () => {
  it('have a fixed size and stay within 0 and 1', () => {
    const x = new Float32Array(NUM_FEATURES);
    for (const s of states(5)) {
      for (let seat = 0; seat < s.n; seat++) {
        encode(observe(s, seat), x);
        for (let i = 0; i < NUM_FEATURES; i++) {
          expect(x[i] >= 0 && x[i] <= 1).toBe(true);
        }
      }
    }
  });

  it('canonical actions map back to the same legal engine actions', () => {
    for (const s of states(5)) {
      const seat = expectedActor(s);
      const obs = observe(s, seat);
      const strength = strengthTable(obs.variant, obs.manilhaRank);
      const c = toCanonical(obs, strength);
      let back = 0;
      for (let a = 0; a < 15; a++) if (c.mask & (1 << a)) back |= 1 << fromCanonical(a, c);
      expect(back).toBe(obs.legal);
      for (let a = 0; a < 15; a++) if (obs.legal & (1 << a)) expect(fromCanonical(toCanonicalAction(a, c), c)).toBe(a);
    }
  });

  it('two seats with the same view get the same features (no hidden input)', () => {
    // Swapping the unseen cards of other players must not change a seat's features.
    const config = makeConfig('paulista', 4);
    const s = newMatch(config, 'c4'.repeat(32), { dealer: 3 });
    const x1 = new Float32Array(NUM_FEATURES);
    const x2 = new Float32Array(NUM_FEATURES);
    encode(observe(s, 0), x1);
    const t = s.hand.cards[1];
    s.hand.cards[1] = s.hand.cards[3];
    s.hand.cards[3] = t;
    encode(observe(s, 0), x2);
    expect(Array.from(x2)).toEqual(Array.from(x1));
  });
});

describe('agents only choose legal actions', () => {
  it('heuristic, tuned-style heuristic and network', () => {
    const { layers, base } = randomModel(3);
    const net = new NetAgent(parseModel(buildModelFile(base, layers, 'i8')));
    const varied = new HeuristicAgent(vectorToParams(paramsToVector(BASE_PARAMS).map((v, i) => (i === 19 ? 0.3 : i === 23 ? 0.7 : v))));
    const agents = [new HeuristicAgent(), varied, net];
    const rand = mulberry32(5);
    for (const s of states(4)) {
      for (const agent of agents) {
        const seat = expectedActor(s);
        const obs = observe(s, seat);
        const d = agent.act(obs, rand);
        expect(legalMask(s, seat) & (1 << d.action)).not.toBe(0);
      }
    }
  });
});

describe('characters', () => {
  it('every character only chooses legal actions', () => {
    const { layers, base } = randomModel(4);
    const model = parseModel(buildModelFile(base, layers, 'i8'));
    const agents = PERSONAS.map((p) => personaAgent(model, p.id));
    const rand = mulberry32(8);
    for (const s of states(3)) {
      const seat = expectedActor(s);
      const obs = observe(s, seat);
      for (const agent of agents) expect(legalMask(s, seat) & (1 << agent.act(obs, rand).action)).not.toBe(0);
    }
  });
});

describe('masked softmax', () => {
  it('gives zero to illegal actions and sums to one', () => {
    const p = maskedSoftmax([1, 2, 3, 4], 0b1010, 1, new Float64Array(4));
    expect(p[0]).toBe(0);
    expect(p[2]).toBe(0);
    expect(p[1] + p[3]).toBeCloseTo(1, 12);
  });
});

describe('chance of winning the match', () => {
  for (const variant of ['paulista', 'mineiro'] as const) {
    it(`${variant}: symmetric, 50% at 0 to 0, rising with my score`, () => {
      const c = makeConfig(variant, 4);
      const g = gameTable(c, {
        normal: variant === 'paulista' ? { 1: 0.3, 3: 0.13, 6: 0.04, 9: 0.015, 12: 0.005 } : { 2: 0.3, 4: 0.13, 6: 0.04, 10: 0.015, 12: 0.005 },
        normalTie: 0.02,
        onzeRun: 0.3,
        onzeWin: 0.4,
        onzeLose: 0.29,
        onzeTie: 0.01,
        ironTie: 0.01,
      });
      expect(g[0][0]).toBeCloseTo(0.5, 9);
      for (let a = 0; a < 12; a++) for (let b = 0; b < 12; b++) expect(g[a][b] + g[b][a]).toBeCloseTo(1, 9);
      for (let a = 0; a < 10; a++) expect(g[a + 1][0]).toBeGreaterThanOrEqual(g[a][0]);
      const m3 = matchTable(makeConfig(variant, 4, { bestOf: 3 }));
      expect(m3(0, 0, 0, 0)).toBeCloseTo(0.5, 9);
      expect(m3(0, 0, 1, 0)).toBeGreaterThan(0.5);
    });
  }
});

describe('agent context', () => {
  it('a v1 network plays the same with and without the context', () => {
    const { layers, base } = randomModel(11);
    const model = parseModel(buildModelFile(base, layers, 'i8'));
    const a = new NetAgent(model);
    const b = new NetAgent(model);
    const ra = mulberry32(3);
    const rb = mulberry32(3);
    for (const s of states(2)) {
      const obs = observe(s, expectedActor(s));
      expect(a.act(obs, ra, agentContext(s))).toEqual(b.act(obs, rb));
    }
  });

  it('a v2 network with zero statistics columns gives the logits and actions of its v1 network', () => {
    const { layers } = randomModel(12);
    const v1 = makeModel(layers, 'v1');
    const v2 = makeModel(widen(layers), 'v2');
    const x1 = new Float32Array(NUM_FEATURES);
    const x2 = new Float32Array(NUM_FEATURES_V2);
    const a = new NetAgent(v1);
    const b = new NetAgent(v2);
    const ra = mulberry32(4);
    const rb = mulberry32(4);
    let worst = 0;
    for (const s of states(2)) {
      const obs = observe(s, expectedActor(s));
      const ctx = agentContext(s);
      const p1 = policy(v1, obs, x1, NEUTRAL_KNOBS, 0, ctx);
      const p2 = policy(v2, obs, x2, NEUTRAL_KNOBS, 0, ctx);
      for (let i = 0; i < 15; i++) worst = Math.max(worst, Math.abs(p1.probs[i] - p2.probs[i]));
      expect(Math.abs(p1.winProb - p2.winProb)).toBeLessThan(1e-6);
      expect(b.act(obs, rb, ctx)).toEqual(a.act(obs, ra, ctx));
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it('a v2 network plays the same with and without the context in the first hand', () => {
    const { layers } = randomModel(13);
    const v2 = makeModel(widen(layers, 5), 'v2', 'f32', { adapt: { bmax: 0.1, nHalf: 2 } });
    const a = new NetAgent(v2);
    const b = new NetAgent(v2);
    const ra = mulberry32(6);
    const rb = mulberry32(6);
    let moves = 0;
    for (const s of states(2)) {
      if (s.history.length > 0) continue;
      const obs = observe(s, expectedActor(s));
      expect(a.act(obs, ra, agentContext(s))).toEqual(b.act(obs, rb));
      moves++;
    }
    expect(moves).toBeGreaterThan(30);
  });

  it('with random statistics weights, later hands read the opponent and stay within the budget', () => {
    const { layers } = randomModel(14);
    const v2 = makeModel(widen(layers, 7), 'v2', 'f32', { adapt: { bmax: 0.05, nHalf: 2 } });
    const agent = new NetAgent(v2);
    const rand = mulberry32(8);
    let twoPass = 0;
    for (const s of states(3)) {
      const obs = observe(s, expectedActor(s));
      agent.act(obs, rand, agentContext(s));
      const a = agent.lastAdapt!;
      expect(a).not.toBeNull();
      if (a.passes === 2) {
        twoPass++;
        expect(a.klApplied).toBeLessThanOrEqual(a.budget + 1e-9);
        expect(a.n).toBeGreaterThan(0);
      } else expect(a.lambda === 0 || a.kl === 0).toBe(true);
    }
    expect(twoPass).toBeGreaterThan(10);
  });

  it('the budget bounds what each character plays: KL of the played distribution from the one it plays without statistics', () => {
    const { layers } = randomModel(15);
    const v2 = makeModel(widen(layers, 9), 'v2', 'f32', { adapt: { bmax: 0.05, nHalf: 2 } });
    const x = new Float32Array(NUM_FEATURES_V2);
    const x0 = new Float32Array(NUM_FEATURES_V2);
    let checked = 0;
    for (const p of PERSONAS) {
      for (const s of states(2)) {
        const obs = observe(s, expectedActor(s));
        const out = policy(v2, obs, x, p.knobs, 0, agentContext(s), {}, x0);
        if (!out.adapt || out.adapt.passes !== 2) continue;
        // The same character with the statistics at no evidence.
        const base = policy(v2, obs, x, p.knobs, 0, agentContext(s), { stats: 'empty' }, x0).probs;
        let kl = 0;
        let tv = 0;
        for (let a = 0; a < out.probs.length; a++) {
          if (out.probs[a] > 0) kl += out.probs[a] * Math.log(out.probs[a] / base[a]);
          tv += Math.abs(out.probs[a] - base[a]) / 2;
        }
        expect(kl).toBeLessThanOrEqual(out.adapt.budget + 1e-6);
        expect(kl).toBeCloseTo(out.adapt.klApplied, 6);
        expect(tv).toBeCloseTo(out.adapt.tv, 6);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('a table with a seat in the noStats mask plays the no-evidence policy with evidence 0', () => {
    const { layers } = randomModel(16);
    const v2 = makeModel(widen(layers, 11), 'v2', 'f32', { adapt: { bmax: 0.5, nHalf: 1 } });
    const x = new Float32Array(NUM_FEATURES_V2);
    const x0 = new Float32Array(NUM_FEATURES_V2);
    let later = 0;
    for (const s of states(2)) {
      const obs = observe(s, expectedActor(s));
      const masked = policy(v2, obs, x, PERSONAS.find((p) => p.id === 'zap')!.knobs, 0, agentContext(s, 1 << ((obs.seat + 1) % s.config.players)), {}, x0);
      const empty = policy(v2, obs, x, PERSONAS.find((p) => p.id === 'zap')!.knobs, 0, agentContext(s), { stats: 'empty' }, x0);
      expect(masked.n).toBe(0);
      expect(Array.from(masked.probs)).toEqual(Array.from(empty.probs));
      if (s.history.length > 0) later++;
    }
    expect(later).toBeGreaterThan(50);
  });
});
