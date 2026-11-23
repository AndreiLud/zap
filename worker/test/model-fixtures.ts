// A fake zap-models bucket and model files for the tests of the model store and the room's
// version choice. The bucket answers gets like R2: a conditional get whose etag matches gives an
// object without a body.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { NUM_FEATURES } from '../../ai/src/features.ts';
import { modelBytes, randomLayers, widen } from '../../ai/test/model-helpers.ts';
import type { ModelMeta } from '../../ai/src/mlp.ts';
import { parseModel } from '../../ai/src/mlp.ts';
import type { CalibratedKnobs } from '../../ai/src/personas.ts';
import { MANIFEST_KEY, SCHEMAS, modelKey, type Manifest, type ModelEntry } from '../../shared/cycle-formats.ts';
import type { Bundled, ObjectStore, StoredBody, StoredHead } from '../src/model-store.ts';

export const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

const BUNDLED_MANIFEST = JSON.parse(readFileSync('ai/models/bootstrap/manifest.json', 'utf8')) as { version: string; sha256: string; personas: CalibratedKnobs };
const BUNDLED_BYTES = new Uint8Array(readFileSync('ai/models/bootstrap/zap-v1.zapw'));

/** The real bundled model, as ai-runtime.ts passes it. */
export function bundled(): Bundled {
  return { label: BUNDLED_MANIFEST.version, sha256: BUNDLED_MANIFEST.sha256, bytes: BUNDLED_BYTES, personas: BUNDLED_MANIFEST.personas };
}

/** The bundled model's manifest entry, as the cycle's init writes it. */
export function bundledEntry(createdAt = 1_763_700_000_000): ModelEntry {
  const h = parseModel(BUNDLED_BYTES).header;
  return { sha256: BUNDLED_MANIFEST.sha256, bytes: BUNDLED_BYTES.byteLength, arch: 'mlp-v1', features: h.features, inputs: h.inputs, hidden: h.hidden, adapt: null, personas: {}, createdAt };
}

/** A small model file: features v1, or v2 with or without a safety net. */
export function smallModel(seed: number, kind: 'v1' | 'v2' | 'v2-no-net', meta: ModelMeta = {}): Uint8Array {
  const base = randomLayers(seed, NUM_FEATURES, [16, 8]);
  if (kind === 'v1') return modelBytes(base, 'v1', 'i8', meta);
  return modelBytes(widen(base, seed + 1), 'v2', 'i8', kind === 'v2' ? { adapt: { bmax: 0.1, nHalf: 2 }, ...meta } : meta);
}

/** The manifest entry that describes a file truthfully. */
export function entryOf(bytes: Uint8Array, personas: CalibratedKnobs = {}): ModelEntry {
  const h = parseModel(bytes).header;
  const adapt = h.features === 'v2' && h.meta?.adapt ? { bmax: h.meta.adapt.bmax, nHalf: h.meta.adapt.nHalf } : null;
  return { sha256: sha(bytes), bytes: bytes.byteLength, arch: 'mlp-v1', features: h.features, inputs: h.inputs, hidden: [...h.hidden], adapt, personas, createdAt: 1_763_800_000_000 };
}

export function manifest(models: Record<string, ModelEntry>, over: Partial<Manifest> = {}): Manifest {
  return { schema: SCHEMAS.manifest, current: 'v1', control: null, controlShare: 0.3, controlUntil: null, updatedAt: 1_763_800_000_000, models, ...over };
}

/** In-memory bucket with R2's conditional get. */
export class MemBucket implements ObjectStore {
  readonly objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  /** Every get, in order: key and whether a body came back. */
  readonly gets: { key: string; body: boolean }[] = [];
  /** The next gets throw. */
  failGets = 0;
  private n = 0;

  put(key: string, body: Uint8Array | string): void {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    this.objects.set(key, { bytes, etag: `e${++this.n}` });
  }

  putModel(version: string, bytes: Uint8Array): void {
    this.put(modelKey(version), bytes);
  }

  putManifest(m: unknown): void {
    this.put(MANIFEST_KEY, JSON.stringify(m));
  }

  delete(key: string): void {
    this.objects.delete(key);
  }

  async get(key: string, opts?: { onlyIf?: { etagDoesNotMatch: string } }): Promise<StoredHead | StoredBody | null> {
    if (this.failGets > 0) {
      this.failGets--;
      throw new Error('network down');
    }
    const o = this.objects.get(key);
    if (!o) {
      this.gets.push({ key, body: false });
      return null;
    }
    if (opts?.onlyIf?.etagDoesNotMatch === o.etag) {
      this.gets.push({ key, body: false });
      return { size: o.bytes.byteLength, etag: o.etag };
    }
    this.gets.push({ key, body: true });
    const copy = o.bytes.slice();
    return {
      size: copy.byteLength,
      etag: o.etag,
      arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer,
      text: async () => new TextDecoder().decode(copy),
    };
  }

  /** Gets of one key. */
  count(key: string): number {
    return this.gets.filter((g) => g.key === key).length;
  }
}
