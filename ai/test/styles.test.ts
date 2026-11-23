import { describe, expect, it } from 'vitest';
import { makeConfig } from '../../engine/src/config.ts';
import { A_ACCEPT, A_RAISE, A_RUN, COVER_MASK, applyAction, expectedActor, newMatch, type MatchState } from '../../engine/src/engine.ts';
import { observe, type Observation } from '../../engine/src/observe.ts';
import { publicHistory } from '../../engine/src/public.ts';
import { mulberry32 } from '../../engine/src/rng.ts';
import { seriesSeed } from '../../engine/src/simulate.ts';
import { agentContext, type Agent, type Decision } from '../src/agent.ts';
import { handEstimate, BASE_PARAMS } from '../src/heuristic.ts';
import { FEINT_POOL, M6R_MIX, M6R_MIX_TEXT, M6_MIX, TRAINING_CHARACTERS, drawOpponent, parseMix, seatMatch, trainingFamilyOf } from '../src/league.ts';
import { NEUTRAL_KNOBS, NetAgent, policy } from '../src/net-agent.ts';
import { matchCounts, seatEvidence } from '../src/opponent-stats.ts';
import { PERSONAS } from '../src/personas.ts';
import {
  COVERS_A_LOT,
  EXTREMES,
  EvidencePhaseAgent,
  FEINT_STYLES,
  HELD_OUT_STYLES,
  M6_FAMILY,
  PhaseAgent,
  ScheduleAgent,
  PROXY_EXPLORERS,
  STYLE_KNOBS,
  explorerFactory,
  explorerLabel,
  explorerMatchInFamily,
  evidenceBeforeHands,
  heldOutStyles,
  inTrainingFamily,
  mixExtremes,
  realizedInFamily,
  sampleExtreme,
  schedulePhase,
  soloSpec,
  styleAgent,
  type ExplorerSpec,
} from '../src/styles.ts';
import { freshFamily, grid, searchPool } from '../bench/explorer-grid.ts';
import { loadV1 } from './model-helpers.ts';
import { RandomAgent } from '../src/agent.ts';

const v1 = loadV1();

/** Decisions of `agent` at every state where it is the expected actor in random matches. */
function decisions(agent: Agent, count: number, players: 2 | 4 = 2, options = {}): { obs: Observation; d: Decision }[] {
  const out: { obs: Observation; d: Decision }[] = [];
  const rand = mulberry32(5);
  for (let m = 0; m < count; m++) {
    const s: MatchState = newMatch(makeConfig('paulista', players, options), seriesSeed('a7'.repeat(32), m));
    const other = new RandomAgent();
    while (!s.over) {
      const seat = expectedActor(s);
      const obs = observe(s, seat);
      if ((seat & 1) === 0) {
        const d = agent.act(obs, rand, agentContext(s));
        out.push({ obs, d });
        applyAction(s, seat, d.action);
      } else applyAction(s, seat, other.act(obs, rand).action);
    }
  }
  return out;
}

const canRaise = (o: Observation) => o.phase === 'play' && (o.legal & (1 << A_RAISE)) !== 0 && (o.legal & 0b111) !== 0;

describe('extreme styles', () => {
  it('raisesAll raises whenever it may', () => {
    const ds = decisions(styleAgent(v1, 'raisesAll'), 30).filter((x) => canRaise(x.obs));
    expect(ds.length).toBeGreaterThan(20);
    for (const x of ds) expect(x.d.action).toBe(A_RAISE);
  });

  it('neverRaises never asks for truco nor raises again', () => {
    const ds = decisions(styleAgent(v1, 'neverRaises'), 30);
    for (const x of ds) expect(x.d.action).not.toBe(A_RAISE);
  });

  it('neverRuns never runs, runsAll always runs', () => {
    const facing = (o: Observation) => o.phase === 'raise' || o.phase === 'onze';
    const never = decisions(styleAgent(v1, 'neverRuns'), 60).filter((x) => facing(x.obs));
    expect(never.length).toBeGreaterThan(10);
    for (const x of never) expect(x.d.action).not.toBe(A_RUN);
    const always = decisions(styleAgent(v1, 'runsAll'), 60).filter((x) => facing(x.obs));
    expect(always.length).toBeGreaterThan(10);
    for (const x of always) expect(x.d.action).toBe(A_RUN);
  });

  it('bluffer raises with weak hands and seldom with strong ones', () => {
    const ds = decisions(styleAgent(v1, 'bluffer'), 40).filter((x) => canRaise(x.obs));
    const weak = ds.filter((x) => handEstimate(x.obs, BASE_PARAMS) < 0.4);
    expect(weak.length).toBeGreaterThan(10);
    for (const x of weak) expect(x.d.action).toBe(A_RAISE);
    const strong = ds.filter((x) => handEstimate(x.obs, BASE_PARAMS) > 0.8 && handEstimate(x.obs, BASE_PARAMS) < 0.97);
    for (const x of strong) expect(x.d.action).not.toBe(A_RAISE);
  });

  it('coversALot covers far more often than v1 when covering is allowed (same states)', () => {
    const states = decisions(new NetAgent(v1, NEUTRAL_KNOBS), 40, 2, { faceDownFirstRound: true }).filter((x) => (x.obs.legal & COVER_MASK) !== 0);
    expect(states.length).toBeGreaterThan(50);
    const x = new Float32Array(431);
    let covers = 0;
    let plain = 0;
    for (const { obs } of states) {
      const pa = policy(v1, obs, x, STYLE_KNOBS.coversALot).probs;
      const pb = policy(v1, obs, x, NEUTRAL_KNOBS).probs;
      covers += pa[3] + pa[4] + pa[5];
      plain += pb[3] + pb[4] + pb[5];
    }
    expect(covers / states.length).toBeGreaterThan(plain / states.length + 0.1);
  });

  it('mixtures interpolate thresholds; a mixture with coversALot keeps the other style', () => {
    const m = mixExtremes('raisesAll', 'runsAll', 0.5);
    expect(m.style!.raise[0]).toBeCloseTo((-1 + BASE_PARAMS.raise[0]) / 2, 12);
    expect(m.style!.accept[0]).toBeCloseTo((BASE_PARAMS.accept[0] + 2) / 2, 12);
    const c = mixExtremes('bluffer', 'coversALot', 0.25);
    expect(c.style).toEqual(STYLE_KNOBS.bluffer.style);
    expect(c.cover).toBeCloseTo(0.25 * COVERS_A_LOT, 12);
  });

  it('sampleExtreme is deterministic for a seed and covers single styles and mixtures', () => {
    const a = Array.from({ length: 50 }, ((r) => () => sampleExtreme(r))(mulberry32(9)));
    const b = Array.from({ length: 50 }, ((r) => () => sampleExtreme(r))(mulberry32(9)));
    expect(a.map((x) => x.label)).toEqual(b.map((x) => x.label));
    expect(a.some((x) => x.label.includes('+'))).toBe(true);
    expect(a.some((x) => (EXTREMES as readonly string[]).includes(x.label))).toBe(true);
  });
});

describe('PhaseAgent', () => {
  it('switches at hand k and forwards the context', () => {
    const seen: { who: string; hand: number; ctx: boolean }[] = [];
    const spy = (who: string): Agent => ({
      name: who,
      act: (obs, rand, ctx) => {
        seen.push({ who, hand: obs.handIndex, ctx: ctx !== undefined });
        return new RandomAgent().act(obs, rand);
      },
    });
    decisions(new PhaseAgent(spy('a'), spy('b'), 3), 5);
    expect(seen.length).toBeGreaterThan(20);
    for (const x of seen) {
      expect(x.who).toBe(x.hand < 3 ? 'a' : 'b');
      expect(x.ctx).toBe(true);
    }
  });
});

describe('league', () => {
  it('parses a mix and refuses one that does not add up to 1', () => {
    expect(parseMix('current=0.30,snapshots=0.10,v1=0.08,tuned=0.05,base=0.05,random=0.02,characters=0.16,extremes=0.14,switching=0.10')).toEqual(M6_MIX);
    expect(() => parseMix('current=0.5')).toThrow();
    expect(() => parseMix('current=0.5,nobody=0.5')).toThrow();
  });

  it('draws every kind, builds the same player for the same draw, and never draws current when excluded', () => {
    const p = { v1, v1Knobs: {}, tuned: BASE_PARAMS, snapshots: [v1] };
    const rand = mulberry32(4);
    const kinds = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const d = drawOpponent(M6_MIX, rand, p, i % 2 === 1);
      kinds.add(d.kind);
      if (i % 2 === 1) expect(d.kind).not.toBe('current');
      const a = d.make();
      const b = d.make();
      if (a !== 'learn') {
        expect(b).not.toBe(a);
        expect((b as Agent).name).toBe(a.name);
      }
    }
    expect(kinds.size).toBe(9);
  });

  it("draws the human model as its own kind, as opponent and as partner, and falls back without it", () => {
    const mix = parseMix('current=0.22,snapshots=0.10,v1=0.08,tuned=0.05,base=0.05,random=0.02,characters=0.16,extremes=0.14,human=0.08,switching=0.10');
    expect(mix.human).toBe(0.08);
    const human = loadV1();
    const p = { v1, v1Knobs: {}, tuned: BASE_PARAMS, snapshots: [v1], human };
    const rand = mulberry32(21);
    let opponents = 0;
    let partners = 0;
    for (let i = 0; i < 2000; i++) {
      const m = seatMatch(4, 0, mix, rand, p, 0.5, 0.2);
      m.labels.forEach((l) => {
        if (l === 'human:human') opponents++;
        if (l === 'partner:human:human') partners++;
      });
      m.seats.forEach((a) => {
        if (a !== 'learn' && a.name === 'human') expect((a as NetAgent).model).toBe(human);
      });
    }
    expect(opponents).toBeGreaterThan(100);
    expect(partners).toBeGreaterThan(5);
    const without = { ...p, human: undefined };
    const r2 = mulberry32(22);
    for (let i = 0; i < 500; i++) {
      expect(drawOpponent(mix, r2, without).kind).not.toBe('human');
      expect(drawOpponent(mix, r2, without, true).kind).not.toBe('current');
    }
  });

  it('a zero human share leaves every draw of the milestone 6 runs where it was', () => {
    // The kinds before 'human' existed, in their order; the kind depends only on the first draw.
    const old = ['current', 'snapshots', 'v1', 'tuned', 'base', 'random', 'characters', 'extremes', 'switching'] as const;
    const p = { v1, v1Knobs: {}, tuned: BASE_PARAMS, snapshots: [v1], human: v1 };
    for (const exclude of [false, true]) {
      const kinds = old.filter((k) => !(exclude && k === 'current'));
      const total = kinds.reduce((a, k) => a + M6_MIX[k], 0);
      for (let i = 0; i < 1000; i++) {
        const u = (i + 0.5) / 1000;
        let x = u * total;
        let want: string = kinds[kinds.length - 1];
        for (const k of kinds) {
          if (x < M6_MIX[k]) {
            want = k;
            break;
          }
          x -= M6_MIX[k];
        }
        expect(drawOpponent(M6_MIX, () => u, p, exclude).kind).toBe(want);
      }
    }
  });

  it('seats a 2 against 2 match with the learning team and drawn opponents', () => {
    const p = { v1, v1Knobs: {}, tuned: BASE_PARAMS, snapshots: [] };
    const rand = mulberry32(6);
    for (let i = 0; i < 200; i++) {
      const m = seatMatch(4, 1, M6_MIX, rand, p, 0.5, 0.2);
      expect(m.seats).toHaveLength(4);
      expect(m.seats.filter((x) => x === 'learn').length).toBeGreaterThanOrEqual(1);
      if (m.labels[0].startsWith('current')) expect(m.seats.filter((x, s) => (s & 1) === 0 && x === 'learn')).toHaveLength(2);
      else expect(m.seats[0]).not.toBe('learn');
    }
  });
});

describe('held-out styles', () => {
  it('trapper never asks for truco first and never runs, and raises again with a fair hand', () => {
    const ds = decisions(styleAgent(v1, 'trapper'), 80);
    const raises = ds.filter((x) => canRaise(x.obs));
    expect(raises.length).toBeGreaterThan(20);
    for (const x of raises) expect(x.d.action).not.toBe(A_RAISE);
    const facing = ds.filter((x) => x.obs.phase === 'raise');
    expect(facing.length).toBeGreaterThan(5);
    for (const x of facing) expect(x.d.action).not.toBe(A_RUN);
    expect(facing.some((x) => x.d.action === A_RAISE)).toBe(true);
  });

  it('coversAll covers more than coversALot on the same states', () => {
    const states = decisions(new NetAgent(v1, NEUTRAL_KNOBS), 40, 2, { faceDownFirstRound: true }).filter((x) => (x.obs.legal & COVER_MASK) !== 0);
    const x = new Float32Array(431);
    let all = 0;
    let lot = 0;
    for (const { obs } of states) {
      const pa = policy(v1, obs, x, STYLE_KNOBS.coversAll).probs;
      const pb = policy(v1, obs, x, STYLE_KNOBS.coversALot).probs;
      all += pa[3] + pa[4] + pa[5];
      lot += pb[3] + pb[4] + pb[5];
    }
    expect(all / states.length).toBeGreaterThan(lot / states.length + 0.1);
  });

  it('never sit in a training match: not extremes, not characters, not feint phases, never drawn by either league', () => {
    expect([...HELD_OUT_STYLES]).toEqual(['coversAll', 'coinFlip']);
    for (const id of HELD_OUT_STYLES) {
      expect((EXTREMES as readonly string[]).includes(id)).toBe(false);
      expect((TRAINING_CHARACTERS as readonly string[]).includes(id)).toBe(false);
      expect((FEINT_POOL as readonly string[]).includes(id)).toBe(false);
    }
    const p = { v1, v1Knobs: {}, tuned: BASE_PARAMS, snapshots: [v1] };
    for (const mix of [M6_MIX, M6R_MIX]) {
      const rand = mulberry32(12);
      for (let i = 0; i < 3000; i++) {
        const m = seatMatch(4, 0, mix, rand, p, 0.5, 0.2);
        for (const l of m.labels) for (const id of HELD_OUT_STYLES) expect(l.includes(id)).toBe(false);
      }
    }
  });

  it('trapper sat in no match of the milestone 6 league and is a feint phase of the feints one', () => {
    const p = { v1, v1Knobs: {}, tuned: BASE_PARAMS, snapshots: [v1] };
    const seen = (mix: typeof M6_MIX) => {
      const rand = mulberry32(14);
      let n = 0;
      for (let i = 0; i < 4000; i++) for (const l of seatMatch(4, 0, mix, rand, p, 0.5, 0.2).labels) if (l.includes('trapper')) n++;
      return n;
    };
    expect(seen(M6_MIX)).toBe(0);
    expect(seen(M6R_MIX)).toBeGreaterThan(20);
    expect(heldOutStyles(M6_FAMILY)).toEqual(['trapper', 'coversAll', 'coinFlip']);
    expect(heldOutStyles(trainingFamilyOf({ league_mix: M6R_MIX_TEXT }))).toEqual(['coversAll', 'coinFlip']);
  });

  it('coinFlip never raises for value: its raises do not depend on the hand', () => {
    const ds = decisions(styleAgent(v1, 'coinFlip'), 120).filter((x) => canRaise(x.obs));
    expect(ds.length).toBeGreaterThan(100);
    const strong = ds.filter((x) => handEstimate(x.obs, BASE_PARAMS) > 0.8);
    const weak = ds.filter((x) => handEstimate(x.obs, BASE_PARAMS) < 0.4);
    const rate = (xs: typeof ds) => xs.filter((x) => x.d.action === A_RAISE).length / xs.length;
    expect(strong.length).toBeGreaterThan(15);
    expect(weak.length).toBeGreaterThan(15);
    for (const xs of [strong, weak]) {
      expect(rate(xs)).toBeGreaterThan(0.1);
      expect(rate(xs)).toBeLessThan(0.55);
    }
  });

  it('every character trains, Iara included', () => {
    for (const p of PERSONAS) if (p.id !== 'zap') expect(TRAINING_CHARACTERS).toContain(p.id);
    const p = { v1, v1Knobs: {}, tuned: BASE_PARAMS, snapshots: [v1] };
    const rand = mulberry32(13);
    const seen = new Set<string>();
    for (let i = 0; i < 3000; i++) {
      const d = drawOpponent(M6_MIX, rand, p);
      if (d.kind === 'characters') seen.add(d.label);
    }
    expect([...seen].sort()).toEqual([...TRAINING_CHARACTERS].sort());
  });
});

describe('explorers', () => {
  it('EvidencePhaseAgent switches once its own seat has shown k betting events, and stays switched', () => {
    const seen: { who: string; evidence: number }[] = [];
    const spy = (who: string, inner: Agent): Agent => ({
      name: who,
      act: (obs, rand, ctx) => {
        seen.push({ who, evidence: seatEvidence(matchCounts(ctx!.history).seats[obs.seat]) });
        return inner.act(obs, rand, ctx);
      },
    });
    decisions(new EvidencePhaseAgent(spy('a', styleAgent(v1, 'raisesAll')), spy('b', styleAgent(v1, 'raisesAll')), 2), 8);
    expect(seen.some((x) => x.who === 'a')).toBe(true);
    expect(seen.some((x) => x.who === 'b')).toBe(true);
    for (const x of seen) if (x.who === 'a') expect(x.evidence).toBeLessThan(2);
  });

  it('the grid holds 1,008 explorers, most of them outside the training family; the proxies keep their labels', () => {
    const g = grid();
    expect(g).toHaveLength(1008);
    expect(new Set(g.map(explorerLabel)).size).toBe(1008);
    const inside = g.filter((e) => inTrainingFamily(e));
    expect(inside.length).toBe(5 * 4 * 5 * 2);
    expect(inTrainingFamily({ a: 'bluffer', b: 'raisesAll', k: 3, partner: 'same' })).toBe(true);
    expect(inTrainingFamily({ a: 'bluffer', b: 'raisesAll', k: 8, partner: 'same' })).toBe(false);
    expect(inTrainingFamily({ a: 'bluffer', b: 'raisesAll', k: 3, partner: 'same', trigger: 'evidence' })).toBe(false);
    expect(inTrainingFamily({ a: 'rock', b: 'bluffer', k: 2, partner: 'same' })).toBe(false);
    expect(PROXY_EXPLORERS.map(explorerLabel)[0]).toBe('rock>bluffer@2/same');
    expect(explorerLabel({ a: 'trapper', b: 'bluffer', k: 4, partner: 'v1', trigger: 'evidence' })).toBe('trapper>bluffer@e4/v1');
  });

  it('the explorer factory builds the schedule asked for', () => {
    const e = explorerFactory(v1, {}, { a: 'rock', b: 'bluffer', k: 4, partner: 'v1', trigger: 'evidence' });
    expect(e(0)).toBeInstanceOf(EvidencePhaseAgent);
    expect(e(2).name).toBe('zap');
    expect(explorerFactory(v1, {}, { a: 'rock', b: 'bluffer', k: 4, partner: 'same' })(2)).toBeInstanceOf(PhaseAgent);
  });
});

describe('the feints fine-tune and the fresh explorer family', () => {
  const p = { v1, v1Knobs: {}, tuned: BASE_PARAMS, snapshots: [v1] };

  it('the feints mix keeps the panel and character shares, adds feints, and parses from its text', () => {
    expect(parseMix(M6R_MIX_TEXT)).toEqual(M6R_MIX);
    for (const k of ['current', 'snapshots', 'v1', 'tuned', 'base', 'random', 'characters'] as const) expect(M6R_MIX[k]).toBe(M6_MIX[k]);
    expect(M6R_MIX.feints).toBe(0.12);
    expect(M6_MIX.feints).toBe(0);
    // Every panel member, every character and every styled kind is met.
    const rand = mulberry32(31);
    const kinds = new Set<string>();
    const chars = new Set<string>();
    for (let i = 0; i < 3000; i++) {
      const d = drawOpponent(M6R_MIX, rand, p);
      kinds.add(d.kind);
      if (d.kind === 'characters') chars.add(d.label);
    }
    expect([...kinds].sort()).toEqual(['base', 'characters', 'current', 'extremes', 'feints', 'random', 'snapshots', 'switching', 'tuned', 'v1']);
    expect([...chars].sort()).toEqual([...TRAINING_CHARACTERS].sort());
  });

  it('a feint fakes one phase from the pool, then switches by hand 1 to 8 or by 2 to 8 betting events; the partner is the same, v1 or its own', () => {
    const only = parseMix('feints=1');
    const rand = mulberry32(32);
    const triggers = new Set<string>();
    const partners = { same: 0, v1: 0, own: 0 };
    for (let i = 0; i < 1500; i++) {
      const d = drawOpponent(only, rand, p);
      const m = /^(\w+)>(\w+)@(e?)(\d+)\/(same|v1|own(?::(\w+)>(\w+)@(e?)(\d+))?)$/.exec(d.label)!;
      expect(m).not.toBeNull();
      expect(FEINT_POOL).toContain(m[1]);
      expect(FEINT_POOL).toContain(m[2]);
      expect(m[1]).not.toBe(m[2]);
      const k = Number(m[4]);
      if (m[3]) expect(k >= 2 && k <= 8).toBe(true);
      else expect(k >= 1 && k <= 8).toBe(true);
      triggers.add(`${m[3]}${k}`);
      const partner = m[5].startsWith('own') ? 'own' : (m[5] as 'same' | 'v1');
      partners[partner]++;
      const a = d.make() as Agent;
      expect(a instanceof PhaseAgent || a instanceof EvidencePhaseAgent).toBe(true);
      expect(d.mate).toBeDefined();
      const mate = d.mate!.make();
      if (partner === 'v1') expect(mate.name).toBe('zap');
      else expect(mate instanceof PhaseAgent || mate instanceof EvidencePhaseAgent).toBe(true);
      if (partner === 'same') expect(mate.name).toBe(a.name);
    }
    expect(triggers.size).toBe(15);
    for (const n of Object.values(partners)) expect(n).toBeGreaterThan(400);
    // In 2 against 2 the second opponent is the mate the draw decided.
    const r2 = mulberry32(33);
    for (let i = 0; i < 200; i++) {
      const m = seatMatch(4, 0, only, r2, p, 0.5, 0);
      expect(m.labels).toHaveLength(2);
      expect(m.labels[0].startsWith('feints:')).toBe(true);
      expect(m.seats[1]).not.toBe('learn');
      expect(m.seats[3]).not.toBe('learn');
    }
    // The feint ranges come from the players.
    const r3 = mulberry32(34);
    for (let i = 0; i < 300; i++) expect(drawOpponent(only, r3, { ...p, feintHands: [2, 2], feintEvidence: [5, 5] }).label).toMatch(/@(2|e5)\//);
  });

  it('ScheduleAgent plays three phases at its switch points, or goes back and forth', () => {
    const tag = (name: string): Agent => ({ name, act: () => ({ action: 0 }) });
    const used: string[] = [];
    const inner = new RandomAgent();
    const spy = (name: string): Agent => ({ name, act: (obs, rand) => (used.push(name), inner.act(obs, rand)) });
    const three = new ScheduleAgent([spy('a'), spy('b'), spy('c')], 'hand', { at: [3, 6] }, 'x');
    expect([0, 2, 3, 5, 6, 12].map((h) => three.phaseAt(h))).toEqual([0, 0, 1, 1, 2, 2]);
    const turns = new ScheduleAgent([tag('a'), tag('b')], 'evidence', { every: 2 }, 'y');
    expect([0, 1, 2, 3, 4, 5, 6].map((x) => turns.phaseAt(x))).toEqual([0, 0, 1, 1, 0, 0, 1]);
    expect(() => new ScheduleAgent([tag('a'), tag('b')], 'hand', { at: [3, 6] }, 'z')).toThrow();
    decisions(three, 6);
    expect(new Set(used)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('the original grid lies inside the feints family; the fresh family lies outside every family', () => {
    const feintsFamily = trainingFamilyOf({ league_mix: M6R_MIX_TEXT, switch_hands: '1,6', feint_hands: '1,8', feint_evidence: '2,8' });
    expect(feintsFamily).toEqual({ switching: { hands: [1, 6] }, feints: { hands: [1, 8], evidence: [2, 8] }, extremes: true });
    expect(trainingFamilyOf({ league_mix: 'current=0.30,snapshots=0.10,v1=0.08,tuned=0.05,base=0.05,random=0.02,characters=0.16,extremes=0.14,switching=0.10', switch_hands: '1,6' })).toEqual(M6_FAMILY);
    expect(trainingFamilyOf(null)).toEqual(M6_FAMILY);
    const g = grid();
    expect(g.every((e) => inTrainingFamily(e, feintsFamily))).toBe(true);
    expect(inTrainingFamily({ a: 'trapper', b: 'bluffer', k: 3, partner: 'v1' }, feintsFamily)).toBe(true);
    expect(inTrainingFamily({ a: 'trapper', b: 'bluffer', k: 3, partner: 'v1' })).toBe(false);
    const f = freshFamily();
    expect(f).toHaveLength(264);
    const labels = f.map(explorerLabel);
    expect(new Set(labels).size).toBe(264);
    for (const e of f) {
      expect(inTrainingFamily(e, feintsFamily)).toBe(false);
      expect(inTrainingFamily(e, M6_FAMILY)).toBe(false);
    }
    expect(new Set([...g.map(explorerLabel), ...labels]).size).toBe(1008 + 264);
    expect(searchPool('all')).toHaveLength(1272);
    expect(labels).toContain('rock>bluffer>rock@1,3/v1');
    expect(labels).toContain('rock<>bluffer@1/same');
    expect(labels).toContain('coinFlip>trapper@e4/same');
    expect(labels).toContain('rock>honest>rock@1,3/own:honest>rock>honest@1,3');
    // No late switch: until it they play as a training feint.
    for (const e of f) if (!e.cycle && e.k2 === undefined) expect([...HELD_OUT_STYLES].some((h) => e.a === h || e.b === h)).toBe(true);
    // A held-out style is never in a family; a mate switching outside the range or in three phases takes an 'own' explorer out.
    expect(inTrainingFamily({ a: 'coversAll', b: 'bluffer', k: 3, partner: 'same' }, feintsFamily)).toBe(false);
    expect(inTrainingFamily({ a: 'rock', b: 'bluffer', k: 3, partner: 'own', mate: { a: 'bluffer', b: 'rock', k: 3 } }, feintsFamily)).toBe(true);
    expect(inTrainingFamily({ a: 'rock', b: 'bluffer', k: 3, partner: 'own', mate: { a: 'bluffer', b: 'rock', k: 10 } }, feintsFamily)).toBe(false);
    for (const e of PROXY_EXPLORERS) expect(inTrainingFamily(e, feintsFamily)).toBe(true);
  });

  it('the explorer factory builds every shape of the fresh family, with its own schedule for the partner', () => {
    const own = freshFamily().find((e) => e.partner === 'own')!;
    const team = explorerFactory(v1, {}, own);
    expect(team(0)).toBeInstanceOf(ScheduleAgent);
    expect(team(2)).toBeInstanceOf(ScheduleAgent);
    expect((team(0) as ScheduleAgent).phases.map((x) => x.name)).toEqual([own.a, own.b, own.a]);
    expect((team(2) as ScheduleAgent).phases.map((x) => x.name)).toEqual([own.b, own.a, own.b]);
    const cyc = explorerFactory(v1, {}, { a: 'rock', b: 'bluffer', k: 2, cycle: true, partner: 'same' })(0) as ScheduleAgent;
    expect(cyc.every).toBe(2);
    expect(explorerFactory(v1, {}, { a: 'rock', b: 'bluffer', k: 12, trigger: 'evidence', partner: 'same' })(0)).toBeInstanceOf(EvidencePhaseAgent);
    expect(() => explorerFactory(v1, {}, { a: 'rock', b: 'bluffer', k: 3, partner: 'own' })).toThrow(/mate/);
    // Every fresh explorer plays a match without error.
    for (const e of freshFamily().filter((_, i) => i % 47 === 0)) {
      const make = explorerFactory(v1, {}, e);
      const s = newMatch(makeConfig('paulista', 4), seriesSeed('b1'.repeat(32), 1));
      const seats = [make(0), new RandomAgent(), make(2), new RandomAgent()];
      const r = mulberry32(3);
      while (!s.over) {
        const seat = expectedActor(s);
        applyAction(s, seat, seats[seat].act(observe(s, seat), r, agentContext(s)).action);
      }
    }
    expect(FEINT_STYLES).not.toContain('coversAll');
  });

  it('schedulePhase gives the phase the agents play, hand by hand, given the evidence before the hand', () => {
    const specs: ExplorerSpec[] = [
      { a: 'rock', b: 'raisesAll', k: 1, k2: 3, partner: 'own', mate: { a: 'raisesAll', b: 'rock', k: 1, k2: 3 } },
      { a: 'neverRuns', b: 'raisesAll', k: 1, cycle: true, partner: 'same' },
      { a: 'coinFlip', b: 'raisesAll', k: 4, trigger: 'evidence', partner: 'v1' },
      { a: 'raisesAll', b: 'honest', k: 3, partner: 'same' },
    ];
    let checked = 0;
    for (const e of specs) {
      const make = explorerFactory(v1, {}, e);
      for (let m = 0; m < 3; m++) {
        const played = new Map<string, string>();
        const seats = [0, 1, 2, 3].map((seat) => {
          if (seat & 1) return new RandomAgent();
          const agent = make(seat);
          const parts = agent instanceof ScheduleAgent ? agent.phases : agent instanceof PhaseAgent || agent instanceof EvidencePhaseAgent ? [agent.first, agent.second] : [];
          for (const p of parts) {
            const inner = p.act.bind(p);
            p.act = (obs, rand, ctx) => (played.set(`${seat}:${obs.handIndex}`, p.name), inner(obs, rand, ctx));
          }
          return agent;
        });
        const s = newMatch(makeConfig('paulista', 4), seriesSeed('c3'.repeat(32), m));
        const r = mulberry32(m + 1);
        while (!s.over) {
          const seat = expectedActor(s);
          applyAction(s, seat, seats[seat].act(observe(s, seat), r, agentContext(s)).action);
        }
        const E = evidenceBeforeHands(publicHistory(s));
        for (const [key, name] of played) {
          const [seat, hand] = key.split(':').map(Number);
          const sched = seat === 0 ? e : e.partner === 'own' ? e.mate! : e;
          expect(schedulePhase(sched, hand, E[seat][hand])).toBe(name);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(30);
  });

  it('realizedInFamily: the play of one seat that some training draw plays exactly', () => {
    const feints = trainingFamilyOf({ league_mix: M6R_MIX_TEXT, switch_hands: '1,6', feint_hands: '1,8', feint_evidence: '2,8' });
    const run = (xs: [string, number][]) => xs.flatMap(([id, n]) => Array<string>(n).fill(id));
    const flat = (n: number, e = 0) => Array<number>(n).fill(e);
    // One style: a feint whose switch never came covers any feint style for up to 8 hands, or while evidence stays below 8.
    expect(realizedInFamily(run([['rock', 8]]), flat(8, 9), feints)).toBe(true);
    expect(realizedInFamily(run([['rock', 9]]), flat(9, 7), feints)).toBe(true);
    expect(realizedInFamily(run([['rock', 9]]), flat(9, 8), feints)).toBe(false);
    expect(realizedInFamily(run([['bluffer', 12]]), flat(12, 20), feints)).toBe(true);
    expect(realizedInFamily(run([['rock', 9]]), flat(9, 0), M6_FAMILY)).toBe(false);
    expect(realizedInFamily(run([['rock', 6]]), flat(6, 0), M6_FAMILY)).toBe(false);
    expect(realizedInFamily(run([['neverRuns', 6]]), flat(6, 0), { ...M6_FAMILY, extremes: false })).toBe(true);
    expect(realizedInFamily(run([['neverRuns', 7]]), flat(7, 0), { ...M6_FAMILY, extremes: false })).toBe(false);
    // Two styles: the switch hand in the range, or set off by evidence in the range.
    expect(realizedInFamily(run([['rock', 8], ['honest', 2]]), flat(10), feints)).toBe(true);
    expect(realizedInFamily(run([['rock', 9], ['honest', 2]]), flat(11), feints)).toBe(false);
    expect(realizedInFamily(run([['rock', 9], ['honest', 2]]), [0, 0, 1, 1, 2, 3, 3, 4, 5, 6, 6], feints)).toBe(true);
    expect(realizedInFamily(run([['rock', 9], ['honest', 2]]), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], feints)).toBe(false);
    expect(realizedInFamily(run([['raisesAll', 6], ['runsAll', 2]]), flat(8), M6_FAMILY)).toBe(true);
    expect(realizedInFamily(run([['raisesAll', 7], ['runsAll', 2]]), flat(9), M6_FAMILY)).toBe(false);
    // Three styles, or a held-out style that played: no training draw.
    expect(realizedInFamily(run([['rock', 1], ['honest', 2], ['rock', 1]]), flat(4), feints)).toBe(false);
    expect(realizedInFamily(run([['coinFlip', 3]]), flat(3), feints)).toBe(false);
    expect(realizedInFamily(run([['rock', 3], ['coversAll', 1]]), flat(4), feints)).toBe(false);
  });

  it('explorerMatchInFamily: every match of a grid explorer is a training draw for the feints network; fresh schedules leave it once their distinct part plays', () => {
    const feints = trainingFamilyOf({ league_mix: M6R_MIX_TEXT, switch_hands: '1,6', feint_hands: '1,8', feint_evidence: '2,8' });
    const cases: { e: ExplorerSpec; check: (L: number, inFamily: boolean) => void }[] = [
      ...grid()
        .filter((_, i) => i % 97 === 0)
        .map((e) => ({ e, check: (_L: number, inFamily: boolean) => expect(inFamily).toBe(true) })),
      { e: { a: 'rock', b: 'raisesAll', k: 1, k2: 3, partner: 'same' }, check: (L, inFamily) => expect(inFamily).toBe(L <= 3) },
      { e: { a: 'rock', b: 'raisesAll', k: 1, cycle: true, partner: 'v1' }, check: (L, inFamily) => expect(inFamily).toBe(L <= 2) },
    ];
    const lengths = new Set<number>();
    for (const { e, check } of cases)
      for (const players of [2, 4] as const) {
        const spec = players === 2 ? soloSpec(e) : e;
        const make = explorerFactory(v1, {}, spec);
        for (let m = 0; m < 2; m++) {
          const team = m & 1;
          const seats = Array.from({ length: players }, (_, s) => ((s & 1) === team ? make(s) : new RandomAgent()));
          const s = newMatch(makeConfig('mineiro', players), seriesSeed('c4'.repeat(32), m));
          const r = mulberry32(m + 7);
          while (!s.over) {
            const seat = expectedActor(s);
            applyAction(s, seat, seats[seat].act(observe(s, seat), r, agentContext(s)).action);
          }
          const h = publicHistory(s);
          lengths.add(h.hands.length);
          check(h.hands.length, explorerMatchInFamily(spec, h, team, feints));
        }
      }
    expect(lengths.size).toBeGreaterThan(2);
  });
});
