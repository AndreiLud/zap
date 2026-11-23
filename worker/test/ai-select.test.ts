// The room's choice of players: which model version each match plays (the control group of a
// test, the candidate only in opponent seats), the fallbacks, AI_MODE and AI_ADAPT, over the
// model store with a fake bucket; and the models of the Worker bundle (v2 by default, v1 behind it).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeConfig } from '../../engine/src/config.ts';
import { applyAction, expectedActor, newMatch } from '../../engine/src/engine.ts';
import { observe } from '../../engine/src/observe.ts';
import { mulberry32 } from '../../engine/src/rng.ts';
import { seriesSeed } from '../../engine/src/simulate.ts';
import { agentContext, type Agent } from '../../ai/src/agent.ts';
import { BASE_PARAMS } from '../../ai/src/heuristic.ts';
import { NetAgent } from '../../ai/src/net-agent.ts';
import { personaAgent } from '../../ai/src/personas.ts';
import { parseModel } from '../../ai/src/mlp.ts';
import { HEURISTIC, MAX_LIE_WITH_HUMAN, createRuntime, pickVersions, previousBundled, type AiRuntime } from '../src/ai-select.ts';
import { ModelStore, type Bundled } from '../src/model-store.ts';
import { validatePersonas, type ModelEntry } from '../../shared/cycle-formats.ts';
import type { PersonaId } from '../../ai/src/personas.ts';
import { MemBucket, bundled, bundledEntry, entryOf, manifest, sha, smallModel } from './model-fixtures.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 22);

/** A bucket where v2 is the previous version and v3 the candidate, in a test until a day from now. */
function testBucket(over: Record<string, unknown> = {}): { bucket: MemBucket; v2: Uint8Array; v3: Uint8Array } {
  const bucket = new MemBucket();
  const v2 = smallModel(2, 'v1');
  const v3 = smallModel(3, 'v2');
  bucket.putModel('v2', v2);
  bucket.putModel('v3', v3);
  bucket.putManifest(manifest({ v1: bundledEntry(), v2: entryOf(v2), v3: entryOf(v3) }, { current: 'v3', control: 'v2', controlShare: 0.3, controlUntil: NOW + DAY, ...over }));
  return { bucket, v2, v3 };
}

async function runtime(bucket: MemBucket | null, opts: { mode?: string; adapt?: string; now?: number } = {}): Promise<AiRuntime> {
  const store = new ModelStore(bucket, bundled(), { ttlMs: 300_000 });
  const rt = createRuntime(store, { mode: opts.mode, adapt: opts.adapt, heuristic: BASE_PARAMS, now: () => opts.now ?? NOW });
  await rt.refresh(opts.now ?? NOW);
  return rt;
}

/** Every action of agents made by `make` in the same matches (same deals and draws). */
function actions(make: () => Agent, matches = 6): number[] {
  const out: number[] = [];
  for (let m = 0; m < matches; m++) {
    const s = newMatch(makeConfig(m & 1 ? 'mineiro' : 'paulista', 2), seriesSeed('c4'.repeat(32), m));
    const agents = [make(), make()];
    const rand = mulberry32(m);
    while (!s.over) {
      const seat = expectedActor(s);
      const a = agents[seat].act(observe(s, seat), rand, agentContext(s)).action;
      out.push(a);
      applyAction(s, seat, a);
    }
  }
  return out;
}

describe('versions per match', () => {
  it('outside a test every seat plays the current version', async () => {
    const { bucket } = testBucket({ control: null, controlUntil: null });
    const rt = await runtime(bucket);
    expect(rt.label).toBe('v3');
    expect(rt.pick(true, () => 0)).toEqual({ opponents: 'v3', partners: 'v3', arm: null });
    expect(rt.pick(false, () => 0)).toEqual({ opponents: 'v3', partners: 'v3', arm: null });
  });

  it('during a test: control group, candidate group, and rooms with the candidate only facing people', async () => {
    const rt = await runtime(testBucket().bucket);
    expect(rt.pick(true, () => 0.29)).toEqual({ opponents: 'v2', partners: 'v2', arm: 'control' });
    expect(rt.pick(true, () => 0.3)).toEqual({ opponents: 'v3', partners: 'v2', arm: 'candidate' });
    expect(rt.pick(false, () => 0)).toEqual({ opponents: 'v3', partners: 'v2', arm: null });
  });

  it('no test once controlUntil passed; a control version that cannot be loaded never puts the candidate next to a person', async () => {
    const late = await runtime(testBucket().bucket, { now: NOW + DAY });
    expect(late.pick(true, () => 0)).toEqual({ opponents: 'v3', partners: 'v3', arm: null });
    const { bucket } = testBucket();
    bucket.putModel('v2', new Uint8Array([9, 9, 9]));
    const broken = await runtime(bucket);
    // The window is still open: the candidate only faces people, the partners play the bundled model, no arm.
    for (const solo of [true, false]) {
      for (const r of [0, 0.29, 0.3, 0.99]) {
        const ai = broken.pick(solo, () => r);
        expect(ai).toEqual({ opponents: 'v3', partners: bundled().label, arm: null });
        expect(ai.partners).not.toBe('v3');
      }
    }
    // Without the bundled model either, the partners play the tuned heuristic.
    const bare = createRuntime(new ModelStore(bucket, { ...bundled(), bytes: new Uint8Array([1, 2, 3]) }, { ttlMs: 300_000 }), { heuristic: BASE_PARAMS, now: () => NOW });
    await bare.refresh(NOW);
    expect(bare.pick(true, () => 0.5)).toEqual({ opponents: 'v3', partners: HEURISTIC, arm: null });
  });

  it('10,000 seeded draws at share 0.3 put a binomial share of quick play matches in the control group', async () => {
    const rt = await runtime(testBucket().bucket);
    const rand = mulberry32(2026);
    let control = 0;
    const n = 10_000;
    for (let i = 0; i < n; i++) {
      const ai = rt.pick(true, rand);
      if (ai.arm === 'control') control++;
      // The candidate is never the partners version.
      expect(ai.partners).toBe('v2');
    }
    const sd = Math.sqrt(n * 0.3 * 0.7);
    console.log(`control group: ${control} of ${n} (expected 3000, sd ${sd.toFixed(1)})`);
    expect(Math.abs(control - 3000)).toBeLessThan(4.5 * sd);
  });

  it('pickVersions is the table of contract 2.3', () => {
    const m = manifest({ v1: bundledEntry() }, { current: 'v3', control: 'v2', controlUntil: 10 });
    const all = () => true;
    expect(pickVersions(m, 9, true, () => 0.1, all).arm).toBe('control');
    expect(pickVersions(m, 10, true, () => 0.1, all).arm).toBeNull();
    expect(pickVersions(m, 9, true, () => 0.1, (v) => v !== 'v3').arm).toBeNull();
  });
});

describe('fallbacks', () => {
  it('a current version that fails to load falls back to the bundled model, with no group', async () => {
    const { bucket } = testBucket();
    bucket.putModel('v3', new Uint8Array(100));
    const rt = await runtime(bucket);
    expect(rt.label).toBe('v1');
    expect(rt.pick(true, () => 0)).toEqual({ opponents: 'v1', partners: 'v1', arm: null });
    expect(rt.agentFor('v1', 1, 'zap', false)).toBeInstanceOf(NetAgent);
  });

  it('without the bundled model either, the tuned heuristic plays', async () => {
    const store = new ModelStore(null, { ...bundled(), sha256: '0'.repeat(64) }, { ttlMs: 1 });
    const rt = createRuntime(store, { heuristic: BASE_PARAMS });
    await rt.refresh(NOW);
    expect(rt.label).toBe(HEURISTIC);
    expect(rt.pick(true, () => 0)).toEqual({ opponents: HEURISTIC, partners: HEURISTIC, arm: null });
    expect(rt.agentFor(HEURISTIC, 1, 'lia', false).name).toBe('heuristic:lia');
  });

  it('AI_MODE=heuristic plays the tuned heuristic in every seat, under the label heuristic', async () => {
    const rt = await runtime(testBucket().bucket, { mode: 'heuristic' });
    expect(rt.pick(true, () => 0)).toEqual({ opponents: HEURISTIC, partners: HEURISTIC, arm: null });
    expect(rt.agentFor('v3', 1, 'zap', false).name).toBe('heuristic:zap');
    expect(await rt.ensure({ opponents: 'v3', partners: 'v2', arm: 'candidate' })).toEqual({ opponents: HEURISTIC, partners: HEURISTIC, arm: null });
  });

  it('after a wake, ensure loads the pinned versions again, even after a rollback, and falls back when one fails', async () => {
    const pinned = { opponents: 'v3', partners: 'v2', arm: 'candidate' } as const;
    // A new isolate: no manifest yet, and the manifest now says the test was rolled back.
    const { bucket } = testBucket({ current: 'v2', control: null, controlUntil: null });
    const store = new ModelStore(bucket, bundled(), { ttlMs: 300_000 });
    const rt = createRuntime(store, { heuristic: BASE_PARAMS, now: () => NOW });
    expect(await rt.ensure(pinned)).toBe(pinned);
    expect(rt.agentFor('v3', 1, 'zap', false)).toBeInstanceOf(NetAgent);
    // A pinned version whose file is now broken: the bundled model replaces it, and the group goes.
    const bad = testBucket();
    bad.bucket.putModel('v3', new Uint8Array(5));
    const rt2 = createRuntime(new ModelStore(bad.bucket, bundled(), { ttlMs: 300_000 }), { heuristic: BASE_PARAMS, now: () => NOW });
    expect(await rt2.ensure(pinned)).toEqual({ opponents: 'v1', partners: 'v2', arm: null });
  });
});

describe('AI_ADAPT and the knobs', () => {
  it('a v2 file without a safety net is never played: the bundled model plays instead', async () => {
    const { bucket } = testBucket({ control: null, controlUntil: null });
    const bare = smallModel(5, 'v2-no-net');
    bucket.putModel('v3', bare);
    const e = entryOf(bare);
    e.adapt = { bmax: 0.1, nHalf: 2 };
    bucket.putManifest(manifest({ v1: bundledEntry(), v3: e }, { current: 'v3' }));
    const rt = await runtime(bucket, { adapt: 'on' });
    expect(rt.pick(true, () => 0).opponents).toBe('v1');
  });

  it('reads live statistics only with AI_ADAPT=on and a model with a safety net', async () => {
    const { v3 } = testBucket();
    const raw = parseModel(v3);
    const play = async (adapt: string | undefined) => {
      const rt = await runtime(testBucket({ control: null, controlUntil: null }).bucket, { adapt });
      return actions(() => rt.agentFor('v3', 0, 'zap', false));
    };
    const empty = actions(() => personaAgent(raw, 'zap', {}, { stats: 'empty', safety: 'model' }));
    const live = actions(() => personaAgent(raw, 'zap', {}, { stats: 'live', safety: 'model' }));
    expect(live).not.toEqual(empty);
    expect(await play('off')).toEqual(empty);
    expect(await play(undefined)).toEqual(empty);
    expect(await play('yes')).toEqual(empty);
    expect(await play('on')).toEqual(live);
  });

  it('caps signal lies next to a person, also for knobs the model does not carry', async () => {
    const rt = await runtime(testBucket({ control: null, controlUntil: null }).bucket);
    for (const v of ['v3', 'v1']) {
      const next = rt.agentFor(v, 2, 'bento', true) as NetAgent;
      const alone = rt.agentFor(v, 2, 'bento', false) as NetAgent;
      expect((next as unknown as { knobs: { signalLie: number } }).knobs.signalLie).toBeLessThanOrEqual(MAX_LIE_WITH_HUMAN);
      expect((alone as unknown as { knobs: { signalLie: number } }).knobs.signalLie).toBeGreaterThan(MAX_LIE_WITH_HUMAN);
    }
  });
});

// The bundle as worker/src/cf/ai-runtime.ts builds it: v2 the default, v1 the previous version.
const V2_MANIFEST = JSON.parse(readFileSync('ai/models/bootstrap/manifest-v2.json', 'utf8'));
const V2_BYTES = new Uint8Array(readFileSync('ai/models/bootstrap/zap-v2.zapw'));
const v2Bundled = (bytes: Uint8Array = V2_BYTES): Bundled => ({ label: V2_MANIFEST.version, sha256: V2_MANIFEST.sha256, bytes, personas: V2_MANIFEST.personas });
const PERSONA_IDS: PersonaId[] = ['otavio', 'bento', 'lia', 'ravi', 'iara', 'zap'];

async function bundleRuntime(bucket: MemBucket | null, opts: { v2?: Uint8Array; v1?: Uint8Array; adapt?: string; now?: number } = {}): Promise<{ rt: AiRuntime; store: ModelStore }> {
  const store = new ModelStore(bucket, v2Bundled(opts.v2), { ttlMs: 300_000 });
  const previous = previousBundled([{ ...bundled(), bytes: opts.v1 ?? bundled().bytes }], { ttlMs: 300_000 });
  const rt = createRuntime(store, { adapt: opts.adapt, heuristic: BASE_PARAMS, now: () => opts.now ?? NOW, previous });
  await rt.refresh(opts.now ?? NOW);
  return { rt, store };
}

/** The manifest entry of the bundled v2, as the cycle's init writes it. */
function v2Entry(): ModelEntry {
  const m = V2_MANIFEST;
  return { sha256: m.sha256, bytes: m.bytes, arch: 'mlp-v1', features: m.features, inputs: m.inputs, hidden: m.hidden, adapt: m.adapt ?? null, personas: m.personas, createdAt: 1_763_830_000_000 };
}

/** Full matches of one version's agents in 1 against 1 and 2 against 2; every action must be legal. */
function playLegal(rt: AiRuntime, version: string, matches = 4): number {
  let moves = 0;
  for (let m = 0; m < matches; m++) {
    const players = m & 1 ? 4 : 2;
    const s = newMatch(makeConfig(m & 2 ? 'mineiro' : 'paulista', players), seriesSeed('b2'.repeat(32), m));
    const agents = Array.from({ length: players }, (_, seat) => rt.agentFor(version, seat, PERSONA_IDS[(m + seat) % PERSONA_IDS.length], false));
    const rand = mulberry32(m + 1);
    while (!s.over) {
      const seat = expectedActor(s);
      const obs = observe(s, seat);
      const a = agents[seat].act(obs, rand, agentContext(s)).action;
      expect(obs.legal & (1 << a)).not.toBe(0);
      applyAction(s, seat, a);
      moves++;
    }
  }
  return moves;
}

describe('the bundled models: v2 by default, v1 behind it', () => {
  it('the bundled v2 matches its manifest, carries valid knobs, and ai-runtime.ts ships it as the default with v1 behind it', () => {
    expect(V2_MANIFEST.version).toBe('v2');
    expect(sha(V2_BYTES)).toBe(V2_MANIFEST.sha256);
    expect(V2_BYTES.byteLength).toBe(V2_MANIFEST.bytes);
    const h = parseModel(V2_BYTES).header;
    expect([h.features, h.inputs, h.hidden]).toEqual([V2_MANIFEST.features, V2_MANIFEST.inputs, V2_MANIFEST.hidden]);
    expect(validatePersonas(V2_MANIFEST.personas).ok).toBe(true);
    expect(Object.keys(V2_MANIFEST.personas).sort()).toEqual([...PERSONA_IDS].sort());
    const src = readFileSync('worker/src/cf/ai-runtime.ts', 'utf8');
    expect(src).toMatch(/import v2Bytes from '\.\.\/\.\.\/\.\.\/ai\/models\/bootstrap\/zap-v2\.zapw'/);
    expect(src).toMatch(/import v2Manifest from '\.\.\/\.\.\/\.\.\/ai\/models\/bootstrap\/manifest-v2\.json'/);
    expect(src).toMatch(/import v1Bytes from '\.\.\/\.\.\/\.\.\/ai\/models\/bootstrap\/zap-v1\.zapw'/);
    expect(src).toMatch(/const DEFAULT: Bundled = \{ label: v2Manifest\.version/);
    expect(src).toMatch(/const PREVIOUS: Bundled\[\] = \[\{ label: v1Manifest\.version/);
  });

  it('with no manifest every seat plays the bundled v2 with its calibrated knobs, and every move is legal', async () => {
    const { rt } = await bundleRuntime(null);
    expect(rt.label).toBe('v2');
    expect(rt.pick(true, () => 0)).toEqual({ opponents: 'v2', partners: 'v2', arm: null });
    expect(rt.pick(false, () => 0.9)).toEqual({ opponents: 'v2', partners: 'v2', arm: null });
    for (const id of PERSONA_IDS) {
      const a = rt.agentFor('v2', 1, id, false) as NetAgent;
      expect(a).toBeInstanceOf(NetAgent);
      expect(a.knobs).toEqual(V2_MANIFEST.personas[id]);
    }
    expect(playLegal(rt, 'v2')).toBeGreaterThan(100);
  });

  it('a manifest naming both bundled files reads neither from R2, and a match pinned to v1 or v2 keeps it after a wake', async () => {
    const bucket = new MemBucket();
    bucket.putManifest(manifest({ v1: bundledEntry(), v2: v2Entry() }, { current: 'v2' }));
    const { rt } = await bundleRuntime(bucket);
    expect(rt.pick(true, () => 0)).toEqual({ opponents: 'v2', partners: 'v2', arm: null });
    for (const pinned of [{ opponents: 'v2', partners: 'v2', arm: null }, { opponents: 'v2', partners: 'v1', arm: 'candidate' }, { opponents: 'v1', partners: 'v1', arm: 'control' }] as const) {
      // A new isolate after a wake: no manifest read yet.
      const fresh = createRuntime(new ModelStore(bucket, v2Bundled(), { ttlMs: 300_000 }), { heuristic: BASE_PARAMS, now: () => NOW, previous: previousBundled([bundled()], { ttlMs: 300_000 }) });
      expect(await fresh.ensure(pinned)).toBe(pinned);
      expect(playLegal(fresh, pinned.partners, 2)).toBeGreaterThan(0);
    }
    expect(bucket.gets.filter((g) => g.key.startsWith('models/'))).toEqual([]);
    // A match pinned to v1 in this room plays the bundled v1 with the knobs it ships with (its entry has none).
    expect(await rt.ensure({ opponents: 'v1', partners: 'v1', arm: null })).toEqual({ opponents: 'v1', partners: 'v1', arm: null });
    const v1 = rt.agentFor('v1', 1, 'otavio', false) as NetAgent;
    expect(v1.knobs).toEqual(bundled().personas.otavio);
    expect(bucket.gets.filter((g) => g.key.startsWith('models/'))).toEqual([]);
  });

  it('a pinned v1 with no manifest at all (the bucket is empty) still comes from the bundle', async () => {
    const fresh = createRuntime(new ModelStore(new MemBucket(), v2Bundled(), { ttlMs: 300_000 }), { heuristic: BASE_PARAMS, now: () => NOW, previous: previousBundled([bundled()], { ttlMs: 300_000 }) });
    const pinned = { opponents: 'v1', partners: 'v1', arm: null } as const;
    expect(await fresh.ensure(pinned)).toBe(pinned);
    expect(fresh.agentFor('v1', 0, 'zap', false)).toBeInstanceOf(NetAgent);
  });

  it('a bundled v2 that fails its check falls back to the bundled v1, then to the tuned heuristic', async () => {
    const broken = V2_BYTES.slice();
    broken[broken.length - 1] ^= 0xff;
    const { rt } = await bundleRuntime(null, { v2: broken });
    expect(rt.label).toBe('v1');
    expect(rt.pick(true, () => 0)).toEqual({ opponents: 'v1', partners: 'v1', arm: null });
    const a = rt.agentFor('v1', 1, 'bento', false) as NetAgent;
    expect(a.knobs).toEqual(bundled().personas.bento);
    expect(playLegal(rt, 'v1', 2)).toBeGreaterThan(0);
    // A current version whose R2 file fails falls back the same way.
    const bucket = new MemBucket();
    bucket.putModel('v3', new Uint8Array(64));
    bucket.putManifest(manifest({ v1: bundledEntry(), v2: v2Entry(), v3: entryOf(smallModel(7, 'v1')) }, { current: 'v3' }));
    expect((await bundleRuntime(bucket)).rt.pick(true, () => 0)).toEqual({ opponents: 'v2', partners: 'v2', arm: null });
    expect((await bundleRuntime(bucket, { v2: broken })).rt.pick(true, () => 0)).toEqual({ opponents: 'v1', partners: 'v1', arm: null });
    const none = (await bundleRuntime(null, { v2: broken, v1: new Uint8Array([1, 2, 3]) })).rt;
    expect(none.label).toBe(HEURISTIC);
    expect(none.pick(true, () => 0)).toEqual({ opponents: HEURISTIC, partners: HEURISTIC, arm: null });
    expect(none.agentFor('v2', 1, 'lia', false).name).toBe('heuristic:lia');
  });

  it('a manifest entry for v1 that disagrees with the bundled file is not served from the bundle', async () => {
    const bucket = new MemBucket();
    const bad = { ...bundledEntry(), inputs: 461 };
    bucket.putManifest(manifest({ v1: bad, v2: v2Entry() }, { current: 'v2' }));
    const { rt } = await bundleRuntime(bucket);
    expect(await rt.ensure({ opponents: 'v1', partners: 'v1', arm: null })).toEqual({ opponents: 'v2', partners: 'v2', arm: null });
  });

  it('AI_ADAPT changes nothing for the bundled v2: it was trained without the statistics', async () => {
    const off = (await bundleRuntime(null, { adapt: 'off' })).rt;
    const on = (await bundleRuntime(null, { adapt: 'on' })).rt;
    expect(parseModel(V2_BYTES).header.features).toBe('v2-empty');
    expect(actions(() => on.agentFor('v2', 0, 'zap', false))).toEqual(actions(() => off.agentFor('v2', 0, 'zap', false)));
  });
});
