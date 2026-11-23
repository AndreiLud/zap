// Models served from R2 (bucket zap-models, binding MODELS): the manifest cache and the checks a
// model file must pass before a room plays it. Pure: it works over any object store with R2's
// get (ObjectStore) and a clock given by the caller, so tests feed it fake buckets.
//
// * The manifest (manifest.json, zap-manifest/1) is read at most once per TTL with one conditional
//   get. A failed get, a body over 256 KB or an invalid manifest keeps the last good manifest;
//   with none, the bundled bootstrap plays. Concurrent refreshes share one promise.
// * A version is loaded from its manifest entry. A file whose SHA-256 equals the bundled file's is
//   never read from R2. Any other file is refused when it is missing, larger than 2 MB or not the
//   entry's size, has another SHA-256, does not parse, has an unknown architecture or features
//   version, disagrees with its entry (features, inputs, hidden sizes, safety net, version), or is a
//   features v2 file without a finite safety net (never played blind), or when the entry's persona
//   knobs are invalid. A refusal is remembered per SHA-256 for the life of the isolate and logged
//   once.
// * Parsed files are kept per isolate by SHA-256, at most MAX_PARSED; the bundled one always.

import { encoderFor } from '../../ai/src/features.ts';
import { parseModel, type Model } from '../../ai/src/mlp.ts';
import type { CalibratedKnobs } from '../../ai/src/personas.ts';
import { servesLiveStats } from '../../ai/src/safety.ts';
import {
  LIMITS,
  MANIFEST_KEY,
  MANIFEST_TTL_MS,
  modelKey,
  parseChecked,
  validateManifest,
  validatePersonas,
  type Manifest,
  type ModelEntry,
} from '../../shared/cycle-formats.ts';
import { hex } from './auth.ts';

/** What a get answers: R2 gives an object without a body when the condition (etagDoesNotMatch) fails. */
export interface StoredHead {
  size: number;
  etag: string;
}
export interface StoredBody extends StoredHead {
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}
export interface ObjectStore {
  get(key: string, opts?: { onlyIf?: { etagDoesNotMatch: string } }): Promise<StoredHead | StoredBody | null>;
}

const hasBody = (o: StoredHead | StoredBody): o is StoredBody => typeof (o as StoredBody).arrayBuffer === 'function';

/** The model shipped inside the Worker (ai/models/bootstrap/). */
export interface Bundled {
  label: string;
  sha256: string;
  bytes: Uint8Array;
  personas: CalibratedKnobs;
}

/** A version ready to play. */
export interface ServedModel {
  version: string;
  sha256: string;
  model: Model;
  knobs: CalibratedKnobs;
  /** The model may read live statistics: it reads none, or its file carries a finite safety net. */
  adaptOk: boolean;
}

export type LoadResult = { ok: true; served: ServedModel } | { ok: false; reason: string };
type Parsed = { ok: true; model: Model } | { ok: false; reason: string };

/** Parsed model files kept per isolate, besides the bundled one. */
export const MAX_PARSED = 4;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

/** The manifest cache TTL: 300 s, or MANIFEST_TTL_S (from 1 to 300) on a test site (TEST_RECORDS "true"). */
export function manifestTtlMs(env: { TEST_RECORDS?: string; MANIFEST_TTL_S?: string }): number {
  if (env.TEST_RECORDS !== 'true' || !env.MANIFEST_TTL_S) return MANIFEST_TTL_MS;
  const s = Number(env.MANIFEST_TTL_S);
  if (!Number.isFinite(s)) return MANIFEST_TTL_MS;
  return Math.round(Math.min(300, Math.max(1, s)) * 1000);
}

/** File checks that need only the bytes: size, hash, parse, architecture and features version. */
async function parseFile(bytes: Uint8Array, sha256: string): Promise<Parsed> {
  if (bytes.byteLength > LIMITS.model) return { ok: false, reason: `too large (${bytes.byteLength} bytes)` };
  if ((await sha256Hex(bytes)) !== sha256) return { ok: false, reason: 'hash mismatch' };
  let model: Model;
  try {
    model = parseModel(bytes);
  } catch (e) {
    return { ok: false, reason: `parse error: ${(e as Error).message}` };
  }
  if (model.header.arch !== 'mlp-v1') return { ok: false, reason: `unknown architecture ${String(model.header.arch)}` };
  try {
    encoderFor(model.header);
  } catch (e) {
    return { ok: false, reason: `unknown features: ${(e as Error).message}` };
  }
  return { ok: true, model };
}

const sameAdapt = (a: unknown, b: { bmax: number; nHalf: number } | null): boolean => {
  if (b === null) return a === undefined || a === null;
  const x = a as { bmax?: unknown; nHalf?: unknown } | null | undefined;
  return !!x && x.bmax === b.bmax && x.nHalf === b.nHalf;
};

/** Whether a parsed file is what its manifest entry says it is, and may be served. Null when it may. */
export function entryMismatch(model: Model, entry: ModelEntry, version: string): string | null {
  const h = model.header;
  if (h.features !== entry.features) return `features ${h.features}, entry ${entry.features}`;
  if (h.inputs !== entry.inputs) return `inputs ${h.inputs}, entry ${entry.inputs}`;
  if (h.hidden.length !== entry.hidden.length || h.hidden.some((x, i) => x !== entry.hidden[i])) return 'hidden sizes differ from the entry';
  if (!sameAdapt(h.meta?.adapt, entry.adapt)) return 'safety net differs from the entry';
  if (!servesLiveStats(h)) return 'features v2 without a finite safety net';
  if (h.meta?.version !== undefined && h.meta.version !== version) return `file says version ${String(h.meta.version)}`;
  const p = validatePersonas(entry.personas);
  if (!p.ok) return `persona knobs: ${p.errors[0]}`;
  return null;
}

/**
 * Checks a model file against its manifest entry (everything above). Never throws: a refusal says
 * why. For tests and tools; the store itself caches the byte checks per SHA-256.
 */
export async function checkModelFile(bytes: Uint8Array, entry: ModelEntry, version: string): Promise<Parsed> {
  if (bytes.byteLength !== entry.bytes) return { ok: false, reason: `size ${bytes.byteLength}, entry ${entry.bytes}` };
  const parsed = await parseFile(bytes, entry.sha256);
  if (!parsed.ok) return parsed;
  const bad = entryMismatch(parsed.model, entry, version);
  return bad ? { ok: false, reason: bad } : parsed;
}

export interface ModelStoreOptions {
  ttlMs: number;
  /** Logs a refusal or a manifest problem (console.warn in the Worker). Called once per cause. */
  warn?: (msg: string) => void;
}

/** The manifest and the parsed models of one isolate, shared by every room in it. */
export class ModelStore {
  /** The last good manifest; null before the first one. */
  manifest: Manifest | null = null;
  readonly bundled: Bundled;
  private readonly store: ObjectStore | null;
  private readonly ttlMs: number;
  private readonly warnFn: (msg: string) => void;
  private etag: string | null = null;
  private checkedAt = -Infinity;
  private refreshing: Promise<void> | null = null;
  private readonly parsed = new Map<string, Promise<Parsed>>();
  private readonly refused = new Map<string, string>();
  private readonly warned = new Set<string>();
  private bundledParse: Promise<Parsed> | null = null;
  /** R2 reads of model files (for tests). */
  fileReads = 0;
  /** Manifest gets (for tests). */
  manifestGets = 0;

  constructor(store: ObjectStore | null, bundled: Bundled, opts: ModelStoreOptions) {
    this.store = store;
    this.bundled = bundled;
    this.ttlMs = opts.ttlMs;
    this.warnFn = opts.warn ?? (() => undefined);
  }

  private warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warnFn(msg);
  }

  /** Reads the manifest when the TTL ran out (one conditional get); never throws. */
  refresh(now: number): Promise<void> {
    if (!this.store || now - this.checkedAt < this.ttlMs) return Promise.resolve();
    this.refreshing ??= this.fetchManifest(now).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async fetchManifest(now: number): Promise<void> {
    try {
      this.manifestGets++;
      const obj = await this.store!.get(MANIFEST_KEY, this.etag ? { onlyIf: { etagDoesNotMatch: this.etag } } : undefined);
      if (obj === null) {
        this.warnOnce('manifest:missing', 'models: no manifest.json; the bundled model plays');
        return;
      }
      // Not modified since the last good one.
      if (!hasBody(obj)) return;
      if (obj.size > LIMITS.manifest) {
        this.warnOnce(`manifest:size:${obj.etag}`, `models: manifest.json refused (${obj.size} bytes); keeping the last good one`);
        return;
      }
      const checked = parseChecked('manifest', await obj.text(), validateManifest);
      if (!checked.ok) {
        this.warnOnce(`manifest:bad:${obj.etag}`, `models: manifest.json refused (${checked.errors.slice(0, 3).join('; ')}); keeping the last good one`);
        return;
      }
      this.manifest = checked.value;
      this.etag = obj.etag;
    } catch (e) {
      this.warnOnce(`manifest:error:${(e as Error).message}`, `models: manifest.json could not be read (${(e as Error).message}); keeping the last good one`);
    } finally {
      this.checkedAt = now;
    }
  }

  /** The bundled file, checked against its own hash once. */
  private parseBundled(): Promise<Parsed> {
    this.bundledParse ??= parseFile(this.bundled.bytes, this.bundled.sha256).then((p) => {
      if (!p.ok) this.warnOnce('bundled', `models: the bundled model is refused (${p.reason}); the heuristic plays`);
      return p;
    });
    return this.bundledParse;
  }

  /** The bundled model under its own label and knobs, with no manifest involved. */
  async loadBundled(): Promise<LoadResult> {
    const p = await this.parseBundled();
    if (!p.ok) return p;
    return { ok: true, served: { version: this.bundled.label, sha256: this.bundled.sha256, model: p.model, knobs: this.bundled.personas, adaptOk: servesLiveStats(p.model.header) } };
  }

  private parseFromStore(version: string, entry: ModelEntry): Promise<Parsed> {
    const hit = this.parsed.get(entry.sha256);
    if (hit) {
      // Most recently used goes last.
      this.parsed.delete(entry.sha256);
      this.parsed.set(entry.sha256, hit);
      return hit;
    }
    const job = (async (): Promise<Parsed> => {
      if (!this.store) return { ok: false, reason: 'no model bucket' };
      this.fileReads++;
      const obj = await this.store.get(modelKey(version));
      if (obj === null || !hasBody(obj)) return { ok: false, reason: `missing ${modelKey(version)}` };
      if (obj.size > LIMITS.model) return { ok: false, reason: `too large (${obj.size} bytes)` };
      if (obj.size !== entry.bytes) return { ok: false, reason: `size ${obj.size}, entry ${entry.bytes}` };
      const bytes = new Uint8Array(await obj.arrayBuffer());
      if (bytes.byteLength !== entry.bytes) return { ok: false, reason: `size ${bytes.byteLength}, entry ${entry.bytes}` };
      return parseFile(bytes, entry.sha256);
    })().catch((e: unknown): Parsed => ({ ok: false, reason: `read failed: ${(e as Error).message}`, transient: true }) as Parsed);
    this.parsed.set(entry.sha256, job);
    void job.then((p) => {
      if (!p.ok) this.parsed.delete(entry.sha256);
      while (this.parsed.size > MAX_PARSED) this.parsed.delete(this.parsed.keys().next().value!);
    });
    return job;
  }

  private refuse(version: string, sha256: string, reason: string, remember: boolean): LoadResult {
    if (remember) this.refused.set(sha256, reason);
    this.warnOnce(`refused:${sha256}:${reason}`, `models: ${version} refused (${reason}); a fallback plays`);
    return { ok: false, reason };
  }

  /** Loads version v from its manifest entry (the bundled bytes when the hash matches). Never throws. */
  async load(version: string): Promise<LoadResult> {
    const entry = this.manifest?.models[version];
    if (!entry) {
      if (version === this.bundled.label) return this.loadBundled();
      return { ok: false, reason: `no manifest entry for ${version}` };
    }
    const known = this.refused.get(entry.sha256);
    if (known !== undefined) return { ok: false, reason: known };
    const bundled = entry.sha256 === this.bundled.sha256;
    const p = bundled ? await this.parseBundled() : await this.parseFromStore(version, entry);
    if (!p.ok) return this.refuse(version, entry.sha256, p.reason, !(p as { transient?: boolean }).transient);
    const bad = entryMismatch(p.model, entry, version);
    if (bad) return this.refuse(version, entry.sha256, bad, true);
    // An entry without knobs for the bundled file keeps the knobs that ship with it.
    const knobs = Object.keys(entry.personas).length === 0 && bundled ? this.bundled.personas : entry.personas;
    return { ok: true, served: { version, sha256: entry.sha256, model: p.model, knobs, adaptOk: servesLiveStats(p.model.header) } };
  }
}
