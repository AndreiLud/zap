// Models served from R2: the manifest cache, the checks every file must pass, and the fallbacks
// (worker/src/model-store.ts), over a fake bucket with R2's conditional get.

import { describe, expect, it } from 'vitest';
import { LIMITS, MANIFEST_KEY, modelKey } from '../../shared/cycle-formats.ts';
import { MAX_PARSED, ModelStore, checkModelFile, manifestTtlMs } from '../src/model-store.ts';
import { MemBucket, bundled, bundledEntry, entryOf, manifest, sha, smallModel } from './model-fixtures.ts';

const TTL = 300_000;

function store(bucket: MemBucket | null, warnings: string[] = []): ModelStore {
  return new ModelStore(bucket, bundled(), { ttlMs: TTL, warn: (m) => warnings.push(m) });
}

/** A bucket with the bundled v1 and a v2 file published as the current version. */
function published(file: Uint8Array, entry = entryOf(file)): MemBucket {
  const b = new MemBucket();
  b.putModel('v2', file);
  b.putManifest(manifest({ v1: bundledEntry(), v2: entry }, { current: 'v2' }));
  return b;
}

describe('manifest cache', () => {
  it('reads the manifest once per TTL, with a conditional get, and shares concurrent refreshes', async () => {
    const b = published(smallModel(1, 'v1'));
    const s = store(b);
    await Promise.all([s.refresh(1000), s.refresh(1000), s.refresh(1001)]);
    expect(b.count(MANIFEST_KEY)).toBe(1);
    expect(s.manifest?.current).toBe('v2');
    await s.refresh(1000 + TTL - 1);
    expect(b.count(MANIFEST_KEY)).toBe(1);
    // After the TTL: one conditional get, answered without a body when nothing changed.
    await s.refresh(1000 + TTL);
    expect(b.gets.filter((g) => g.key === MANIFEST_KEY)).toEqual([
      { key: MANIFEST_KEY, body: true },
      { key: MANIFEST_KEY, body: false },
    ]);
    expect(s.manifest?.current).toBe('v2');
  });

  it('a failed get, an oversized body or an invalid manifest keeps the last good one', async () => {
    const warnings: string[] = [];
    const b = published(smallModel(2, 'v1'));
    const s = store(b, warnings);
    await s.refresh(0);
    const good = s.manifest;
    expect(good?.current).toBe('v2');
    b.failGets = 1;
    await s.refresh(TTL);
    expect(s.manifest).toBe(good);
    b.put(MANIFEST_KEY, `{"x":"${'a'.repeat(LIMITS.manifest)}"}`);
    await s.refresh(2 * TTL);
    expect(s.manifest).toBe(good);
    b.putManifest({ ...good, current: 'v9' });
    await s.refresh(3 * TTL);
    expect(s.manifest).toBe(good);
    b.put(MANIFEST_KEY, 'not json');
    await s.refresh(4 * TTL);
    expect(s.manifest).toBe(good);
    expect(warnings.join('\n')).toMatch(/could not be read/);
    expect(warnings.join('\n')).toMatch(/refused/);
    // A good new manifest is taken at the next refresh.
    b.putManifest({ ...good, current: 'v1' });
    await s.refresh(5 * TTL);
    expect(s.manifest?.current).toBe('v1');
  });

  it('without a manifest (or a bucket) the bundled model plays, without any R2 read', async () => {
    for (const b of [new MemBucket(), null]) {
      const s = store(b);
      await s.refresh(0);
      expect(s.manifest).toBeNull();
      const r = await s.load('v1');
      expect(r.ok && r.served.sha256).toBe(bundled().sha256);
      expect(r.ok && r.served.knobs).toEqual(bundled().personas);
      expect(s.fileReads).toBe(0);
    }
  });

  it('MANIFEST_TTL_S counts only on a test site, from 1 to 300 seconds', () => {
    expect(manifestTtlMs({})).toBe(300_000);
    expect(manifestTtlMs({ MANIFEST_TTL_S: '5' })).toBe(300_000);
    expect(manifestTtlMs({ TEST_RECORDS: 'true', MANIFEST_TTL_S: '5' })).toBe(5_000);
    expect(manifestTtlMs({ TEST_RECORDS: 'true', MANIFEST_TTL_S: '0' })).toBe(1_000);
    expect(manifestTtlMs({ TEST_RECORDS: 'true', MANIFEST_TTL_S: '9000' })).toBe(300_000);
    expect(manifestTtlMs({ TEST_RECORDS: 'true', MANIFEST_TTL_S: 'x' })).toBe(300_000);
    expect(manifestTtlMs({ TEST_RECORDS: 'false', MANIFEST_TTL_S: '5' })).toBe(300_000);
  });
});

describe('model files', () => {
  it('serves a good v1 and a v2 file with its safety net, with the entry knobs', async () => {
    const knobs = { zap: { ...bundled().personas.zap!, temperature: 0.5 } };
    for (const file of [smallModel(3, 'v1'), smallModel(4, 'v2')]) {
      const b = published(file, entryOf(file, knobs));
      const s = store(b);
      await s.refresh(0);
      const r = await s.load('v2');
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.served.version).toBe('v2');
      expect(r.served.knobs).toEqual(knobs);
      expect(r.served.adaptOk).toBe(true);
    }
  });

  it('the bundled file is never read from R2, whatever the version label', async () => {
    const b = new MemBucket();
    b.putManifest(manifest({ v1: bundledEntry() }));
    const s = store(b);
    await s.refresh(0);
    const r = await s.load('v1');
    expect(r.ok).toBe(true);
    expect(s.fileReads).toBe(0);
    expect(b.count(modelKey('v1'))).toBe(0);
    // An entry without knobs keeps the knobs that ship with the bundled file.
    expect(r.ok && r.served.knobs).toEqual(bundled().personas);
  });

  const refusals: [string, (b: MemBucket, file: Uint8Array) => void, RegExp][] = [
    ['bad hash', (b, f) => b.putModel('v2', f.map((x, i) => (i === f.length - 1 ? x ^ 1 : x))), /hash mismatch/],
    ['missing file', (b) => b.delete(modelKey('v2')), /missing/],
    ['oversized file', (b, f) => b.putModel('v2', new Uint8Array(LIMITS.model + 1).fill(7, 0, f.length)), /too large/],
    ['wrong size', (b, f) => b.putModel('v2', new Uint8Array([...f, 0])), /size/],
  ];
  for (const [name, spoil, why] of refusals) {
    it(`refuses a ${name} and remembers the refusal (one read)`, async () => {
      const file = smallModel(5, 'v1');
      const b = published(file);
      spoil(b, file);
      const warnings: string[] = [];
      const s = store(b, warnings);
      await s.refresh(0);
      const r = await s.load('v2');
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(why);
      const again = await s.load('v2');
      expect(again.ok).toBe(false);
      expect(s.fileReads).toBeLessThanOrEqual(1);
      expect(warnings.filter((w) => w.includes('v2 refused'))).toHaveLength(1);
    });
  }

  it('refuses an unknown architecture, unknown features, a v2 file without a safety net and a file that disagrees with its entry', async () => {
    const v1 = smallModel(6, 'v1');
    const cases: [string, Uint8Array, (e: ReturnType<typeof entryOf>) => void, RegExp][] = [
      ['architecture', patchHeader(v1, '"arch":"mlp-v1"', '"arch":"mlp-v9"'), () => undefined, /architecture/],
      ['features', patchHeader(v1, '"features":"v1"', '"features":"v7"'), () => undefined, /features/],
      ['v2 without safety net', smallModel(7, 'v2-no-net'), () => undefined, /without a finite safety net/],
      ['v2 without safety net, entry with one', smallModel(7, 'v2-no-net'), (e) => (e.adapt = { bmax: 0.1, nHalf: 2 }), /safety net/],
      ['features differ', v1, (e) => (e.features = 'v2-empty'), /features/],
      ['inputs differ', v1, (e) => (e.inputs = 461), /inputs/],
      ['hidden differs', v1, (e) => (e.hidden = [16, 9]), /hidden/],
      ['net differs', smallModel(8, 'v2'), (e) => (e.adapt = { bmax: 0.2, nHalf: 2 }), /safety net/],
      ['version differs', smallModel(9, 'v1', { version: 'v5' }), () => undefined, /version v5/],
      ['bad knobs', v1, (e) => (e.personas = { zap: { temperature: 1 } } as never), /persona/],
    ];
    for (const [name, file, edit, why] of cases) {
      const e = entryOf(file.length > 0 && name !== 'architecture' && name !== 'features' ? file : v1);
      e.sha256 = sha(file);
      e.bytes = file.byteLength;
      edit(e);
      const r = await checkModelFile(file, e, 'v2');
      expect(r.ok, name).toBe(false);
      expect(!r.ok && r.reason, name).toMatch(why);
    }
  });

  it('a version that fails through the store does not stop the others, and parsed files are kept up to MAX_PARSED', async () => {
    const b = new MemBucket();
    const entries: Record<string, ReturnType<typeof entryOf>> = { v1: bundledEntry() };
    for (let v = 2; v <= 7; v++) {
      const f = smallModel(20 + v, 'v1');
      b.putModel(`v${v}`, f);
      entries[`v${v}`] = entryOf(f);
    }
    b.putModel('v3', new Uint8Array([1, 2, 3]));
    b.putManifest(manifest(entries, { current: 'v7' }));
    const s = store(b);
    await s.refresh(0);
    for (let v = 2; v <= 7; v++) expect((await s.load(`v${v}`)).ok).toBe(v !== 3);
    const reads = s.fileReads;
    // The newest MAX_PARSED stay parsed; v2 was evicted and is read again.
    await s.load('v7');
    expect(s.fileReads).toBe(reads);
    await s.load('v2');
    expect(s.fileReads).toBe(reads + 1);
    expect(MAX_PARSED).toBe(4);
  });
});

/** The same file with one string of its JSON header replaced by another of the same length. */
function patchHeader(bytes: Uint8Array, from: string, to: string): Uint8Array {
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true);
  const text = new TextDecoder().decode(bytes.subarray(12, 12 + len));
  if (!text.includes(from) || from.length !== to.length) throw new Error('cannot patch the header');
  const out = bytes.slice();
  out.set(new TextEncoder().encode(text.replace(from, to)), 12);
  return out;
}
