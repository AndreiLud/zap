// Which AI plays in a room, and which model version: the part of worker/src/cf/ai-runtime.ts that
// needs no bundled file, so tests can feed it any store and any model.
//
// Versions per match (milestone 6): the room asks pick() at the start of each match and keeps the
// answer for the whole match (StoredMatch.ai), so a new manifest, a rollback or a wake from
// hibernation never changes the version in the middle of a match. During a test of a new version
// (manifest control set, before controlUntil, both versions loaded), a quick play match goes to
// the control group with chance controlShare (every AI the previous version) and otherwise to the
// candidate group (the opponents are the new version, the AI partner the previous one); a room
// with friends plays the new version only in opponent seats. So the candidate never sits next to a
// person, and a person's AI partner is always the previous version.
//
// Fallback for one version: its R2 file, then the bundled models in order (the default one, then
// the previous versions shipped beside it: v2, then v1), then the tuned heuristic (label
// "heuristic"). A manifest entry whose SHA-256 is one of the previous bundled files is served from
// the bundle, never read from R2, like the default one. AI_MODE=heuristic plays the tuned
// heuristic in every seat. AI_ADAPT (default off): with "on", a features v2 model reads the public
// statistics of the match; the store only serves a v2 file that carries a finite safety net
// (worker/src/model-store.ts), and anything else plays its no-evidence policy.

import type { Agent } from '../../ai/src/agent.ts';
import { HeuristicAgent, type HeuristicParams } from '../../ai/src/heuristic.ts';
import type { Knobs } from '../../ai/src/net-agent.ts';
import { persona as personaOf, personaAgent, type CalibratedKnobs, type PersonaId } from '../../ai/src/personas.ts';
import { LIMITS, type Manifest, type MatchAi } from '../../shared/cycle-formats.ts';
import { ModelStore, entryMismatch, type Bundled, type LoadResult, type ModelStoreOptions, type ServedModel } from './model-store.ts';

export type { MatchAi } from '../../shared/cycle-formats.ts';

/** With a person as partner, an AI lies in at most 10% of its signals. */
export const MAX_LIE_WITH_HUMAN = 0.1;

/** Largest model file the room accepts. */
export const MAX_MODEL_BYTES = LIMITS.model;

/** Label of the tuned heuristic in records. */
export const HEURISTIC = 'heuristic';

export interface AiRuntime {
  /** The current version label, for RoomCore.create (display only). */
  readonly label: string;
  /** The manifest within its TTL; loads the current and the control versions. Never throws. */
  refresh(now: number): Promise<void>;
  /** The versions of a new match. Synchronous: uses only versions already loaded (refresh first). */
  pick(solo: boolean, rand: () => number): MatchAi;
  /** After a wake: loads the versions a match was pinned to; answers a fallback with arm null if one fails. */
  ensure(ai: MatchAi): Promise<MatchAi>;
  agentFor(version: string, seat: number, persona: PersonaId, partnerHuman: boolean): Agent;
}

/** What the runtime needs from the store (worker/src/model-store.ts ModelStore). */
export interface ModelSource {
  readonly manifest: Manifest | null;
  readonly bundled: { label: string };
  refresh(now: number): Promise<void>;
  load(version: string): Promise<LoadResult>;
  loadBundled(): Promise<LoadResult>;
}

/** A model shipped in the bundle behind the default one (a previous version): the next fallback. */
export interface BundledModel {
  readonly label: string;
  readonly sha256: string;
  /** The bundled file under its own label and knobs, parsed once per isolate (ModelStore.loadBundled). */
  loadBundled(): Promise<LoadResult>;
}

/** The previous bundled files as fallbacks: each checked and parsed once by a store without a bucket. */
export function previousBundled(files: readonly Bundled[], opts: ModelStoreOptions): BundledModel[] {
  return files.map((b) => {
    const store = new ModelStore(null, b, opts);
    return { label: b.label, sha256: b.sha256, loadBundled: () => store.loadBundled() };
  });
}

export interface RuntimeOptions {
  mode?: string;
  adapt?: string;
  heuristic: HeuristicParams;
  /** Clock for ensure() after a wake (refresh() gets its time from the caller). */
  now?: () => number;
  /** Bundled models behind the source's own bundled one, in fallback order. */
  previous?: readonly BundledModel[];
}

/** Whether a test of a new version runs now (2.3). */
export function testRunning(m: Manifest | null, now: number, loaded: (v: string) => boolean): m is Manifest & { control: string; controlUntil: number } {
  return !!m && m.control !== null && m.controlUntil !== null && now < m.controlUntil && loaded(m.current) && loaded(m.control);
}

/**
 * The versions of one match (2.3): no test, current everywhere; test and quick play, control
 * everywhere with chance controlShare, else the candidate facing the person and control as the
 * partner; test and a room, the candidate only facing people.
 */
export function pickVersions(m: Manifest, now: number, solo: boolean, rand: () => number, loaded: (v: string) => boolean): MatchAi {
  if (!testRunning(m, now, loaded)) return { opponents: m.current, partners: m.current, arm: null };
  if (!solo) return { opponents: m.current, partners: m.control, arm: null };
  return rand() < m.controlShare ? { opponents: m.control, partners: m.control, arm: 'control' } : { opponents: m.current, partners: m.control, arm: 'candidate' };
}

/** The players of one room, over the isolate's model store. */
export function createRuntime(src: ModelSource, opts: RuntimeOptions): AiRuntime {
  const heuristicMode = opts.mode === 'heuristic';
  const clock = opts.now ?? Date.now;
  /** Every version this room loaded: kept while the room lives, so a pinned version never goes away. */
  const served = new Map<string, ServedModel>();
  /** The bundled models in fallback order: the source's own, then the previous versions. */
  const chain: { label: string; loadBundled(): Promise<LoadResult> }[] = [{ label: src.bundled.label, loadBundled: () => src.loadBundled() }, ...(opts.previous ?? [])];
  /** Labels of the bundled models this room loaded. */
  const bundledOk = new Set<string>();
  let now = 0;

  const loaded = (v: string) => served.has(v);
  const fallback = () => chain.find((b) => bundledOk.has(b.label))?.label ?? HEURISTIC;

  async function loadOneBundled(b: (typeof chain)[number]): Promise<boolean> {
    if (bundledOk.has(b.label)) return true;
    const r = await b.loadBundled();
    if (r.ok) {
      // A version the manifest names with this label stays: the manifest says which file it is.
      if (!served.has(b.label)) served.set(b.label, r.served);
      bundledOk.add(b.label);
    }
    return r.ok;
  }

  /** The first bundled model that loads, in chain order (parsed once per isolate by the store). */
  async function loadBundled(): Promise<void> {
    for (const b of chain) if (await loadOneBundled(b)) return;
  }

  async function load(v: string): Promise<boolean> {
    const entry = src.manifest?.models[v];
    // Loaded already, unless the bundle gave this label a file the manifest's entry does not name
    // (a local test profile whose candidate v2 is not the bundled v2).
    const have = served.get(v);
    if (have && (!entry || have.sha256 === entry.sha256)) return true;
    // An entry for one of the previous bundled files: served from the bundle with the entry's
    // checks and knobs, no R2 read (the store does the same for its own bundled file).
    const prev = entry ? opts.previous?.find((b) => b.sha256 === entry.sha256) : undefined;
    if (entry && prev) {
      const r = await prev.loadBundled();
      if (r.ok && entryMismatch(r.served.model, entry, v) === null) {
        const knobs = Object.keys(entry.personas).length === 0 ? r.served.knobs : entry.personas;
        served.set(v, { ...r.served, version: v, knobs });
        return true;
      }
    }
    const r = await src.load(v);
    if (r.ok) served.set(v, r.served);
    return r.ok;
  }

  const current = () => src.manifest?.current ?? src.bundled.label;

  return {
    get label() {
      if (heuristicMode) return HEURISTIC;
      return loaded(current()) ? current() : fallback();
    },

    async refresh(t: number) {
      now = t;
      if (heuristicMode) return;
      await src.refresh(t);
      const m = src.manifest;
      const want = m ? [m.current, ...(m.control !== null ? [m.control] : [])] : [];
      await Promise.all(want.map(load));
      // The bundled model is the first fallback, always at hand (parsed once per isolate).
      await loadBundled();
    },

    pick(solo, rand) {
      if (heuristicMode) return { opponents: HEURISTIC, partners: HEURISTIC, arm: null };
      const m = src.manifest;
      if (!m || !loaded(m.current)) {
        const f = fallback();
        return { opponents: f, partners: f, arm: null };
      }
      // A test is open but the previous version did not load in this isolate: the candidate may
      // still face people, never sit next to them; partners play the fallback (bundled, then the
      // heuristic), and the match belongs to no arm.
      if (m.control !== null && m.controlUntil !== null && now < m.controlUntil && !loaded(m.control)) return { opponents: m.current, partners: fallback(), arm: null };
      return pickVersions(m, now, solo, rand, loaded);
    },

    async ensure(ai) {
      if (heuristicMode) return ai.opponents === HEURISTIC && ai.partners === HEURISTIC ? ai : { opponents: HEURISTIC, partners: HEURISTIC, arm: null };
      const fix = async (v: string): Promise<string> => {
        if (v === HEURISTIC || served.has(v)) return v;
        const own = chain.find((b) => b.label === v);
        if (own && !src.manifest?.models[v]) {
          if (await loadOneBundled(own)) return v;
        }
        // After a wake the isolate may have no manifest yet: the entry of a pinned version is in it (entries are never removed).
        if (!src.manifest?.models[v]) await src.refresh(clock());
        if (await load(v)) return v;
        await loadBundled();
        return fallback();
      };
      const opponents = await fix(ai.opponents);
      const partners = await fix(ai.partners);
      if (opponents === ai.opponents && partners === ai.partners) return ai;
      return { opponents, partners, arm: null };
    },

    agentFor(version, _seat, persona, partnerHuman) {
      const s = heuristicMode || version === HEURISTIC ? undefined : (served.get(version) ?? served.get(fallback()));
      if (!s) return new HeuristicAgent(opts.heuristic, `heuristic:${persona}`);
      let knobs: CalibratedKnobs = s.knobs;
      // The knobs of this model, or the character's defaults when the model has none for it.
      const k = (knobs[persona] ?? personaOf(persona).knobs) as Knobs;
      if (partnerHuman && k.signalLie > MAX_LIE_WITH_HUMAN) knobs = { ...knobs, [persona]: { ...k, signalLie: MAX_LIE_WITH_HUMAN } };
      // Fails closed: only "on" with a model that may read statistics reads them.
      const stats = opts.adapt === 'on' && s.adaptOk ? 'live' : 'empty';
      return personaAgent(s.model, persona, knobs, { stats, safety: 'model' });
    },
  };
}
