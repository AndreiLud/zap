// The AI players inside the Durable Objects. Models come from R2 (bucket zap-models, binding
// MODELS) through one store per isolate (worker/src/model-store.ts): the manifest is read at most
// every 5 minutes, every file is checked against its entry, and parsed models are shared by every
// room of the isolate. Two models ship in the bundle (ai/models/bootstrap/): v2, the default and
// the first fallback, and v1, the previous version, behind it; the tuned heuristic is the last
// fallback, so the game never stops. Each room gets its own runtime (worker/src/ai-select.ts),
// which keeps the versions its matches were pinned to.

import v2Bytes from '../../../ai/models/bootstrap/zap-v2.zapw';
import v2Manifest from '../../../ai/models/bootstrap/manifest-v2.json' with { type: 'json' };
import v1Bytes from '../../../ai/models/bootstrap/zap-v1.zapw';
import v1Manifest from '../../../ai/models/bootstrap/manifest.json' with { type: 'json' };
import tuned from '../../../ai/models/heuristic-tuned.json' with { type: 'json' };
import type { HeuristicParams } from '../../../ai/src/heuristic.ts';
import type { CalibratedKnobs } from '../../../ai/src/personas.ts';
import { createRuntime, previousBundled, type AiRuntime, type BundledModel } from '../ai-select.ts';
import { ModelStore, manifestTtlMs, type Bundled } from '../model-store.ts';
import { servedNow } from '../public-data.ts';
import type { Env } from './env.ts';

export { MAX_LIE_WITH_HUMAN, type AiRuntime, type MatchAi } from '../ai-select.ts';

/** The default bundled model: the version a room plays before the first manifest. */
const DEFAULT: Bundled = { label: v2Manifest.version, sha256: v2Manifest.sha256, bytes: new Uint8Array(v2Bytes as ArrayBuffer), personas: v2Manifest.personas as CalibratedKnobs };
/** The previous versions in the bundle, in fallback order. */
const PREVIOUS: Bundled[] = [{ label: v1Manifest.version, sha256: v1Manifest.sha256, bytes: new Uint8Array(v1Bytes as ArrayBuffer), personas: v1Manifest.personas as CalibratedKnobs }];

let store: ModelStore | null = null;
let previous: BundledModel[] | null = null;

/** The isolate's model store, made on first use with this Worker's bindings. */
function sharedStore(env: Env): ModelStore {
  store ??= new ModelStore(env.MODELS ? { get: (key, opts) => env.MODELS!.get(key, opts) } : null, DEFAULT, { ttlMs: manifestTtlMs(env), warn: (msg) => console.warn(msg) });
  return store;
}

/** A new runtime for one room. */
export function aiRuntime(env: Env): AiRuntime {
  previous ??= previousBundled(PREVIOUS, { ttlMs: manifestTtlMs(env), warn: (msg) => console.warn(msg) });
  return createRuntime(sharedStore(env), { mode: env.AI_MODE, adapt: env.AI_ADAPT, heuristic: tuned.params as HeuristicParams, previous });
}

/**
 * The version on the AI seats now and whether it reads the match, for GET /api/live: the manifest
 * of the isolate's model store, refreshed within its TTL (at most one manifest read per TTL), else
 * the bundled label; "heuristic" in that mode.
 */
export async function currentVersion(env: Env, now: number): Promise<{ current: string; adapt: boolean }> {
  const s = sharedStore(env);
  await s.refresh(now);
  return servedNow(env.AI_MODE, env.AI_ADAPT, s.manifest, { label: v2Manifest.version, features: v2Manifest.features, adapt: v2Manifest.adapt });
}
