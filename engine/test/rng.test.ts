import { createCipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { chachaBlock, createStream, deriveSeed, nextU32, randInt, seedWords, shuffledRange, wordsToHex } from '../src/rng.ts';

describe('ChaCha20', () => {
  it('matches the RFC 8439 section 2.3.2 test vector', () => {
    const key = seedWords('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    const out = new Array<number>(16);
    chachaBlock(key, 1, [0x09000000, 0x4a000000, 0x00000000], out);
    expect(wordsToHex(out)).toBe(
      '10f1e7e4d13b5915500fdd1fa32071c4c7d1f4c733c068030422aa9ac3d46c4ed2826446079faa0914c2d705d98b02a2b5129cd1de164eb9cbd083e8a2503c4e',
    );
  });

  it('matches the keystream of Node crypto for random keys and nonces', () => {
    for (let t = 0; t < 20; t++) {
      const key = Buffer.alloc(32, 0);
      for (let i = 0; i < 32; i++) key[i] = (t * 37 + i * 11) & 255;
      const nonce = [t * 7919, t ^ 0xabcdef, 12345 + t];
      const iv = Buffer.alloc(16);
      iv.writeUInt32LE(0, 0);
      nonce.forEach((w, i) => iv.writeUInt32LE(w >>> 0, 4 + 4 * i));
      const ks = createCipheriv('chacha20', key, iv).update(Buffer.alloc(64 * 3));
      const s = createStream(new Uint8Array(key), nonce);
      for (let i = 0; i < 48; i++) expect(nextU32(s)).toBe(ks.readUInt32LE(4 * i));
    }
  });
});

describe('draws', () => {
  it('randInt stays in range and is roughly uniform', () => {
    const s = createStream(deriveSeed('aa'.repeat(32), 1, 2));
    const counts = new Array(10).fill(0);
    for (let i = 0; i < 100_000; i++) {
      const v = randInt(s, 10);
      expect(v >= 0 && v < 10).toBe(true);
      counts[v]++;
    }
    for (const c of counts) expect(Math.abs(c - 10_000)).toBeLessThan(500);
  });

  it('shuffle is a permutation and deterministic', () => {
    const a = shuffledRange(createStream('bb'.repeat(32)), 40);
    const b = shuffledRange(createStream('bb'.repeat(32)), 40);
    expect([...a].sort((x, y) => x - y)).toEqual([...Array(40).keys()]);
    expect(a).toEqual(b);
    expect(shuffledRange(createStream('bc'.repeat(32)), 40)).not.toEqual(a);
  });

  it('every card lands in every position about equally often', () => {
    const pos = Array.from({ length: 40 }, () => new Array(40).fill(0));
    const N = 40_000;
    for (let i = 0; i < N; i++) {
      const d = shuffledRange(createStream(deriveSeed('cc'.repeat(32), 3, i)), 40);
      d.forEach((c, p) => pos[c][p]++);
    }
    // Expected 1,000 per cell; 6 standard deviations is about 190.
    for (const row of pos) for (const v of row) expect(Math.abs(v - N / 40)).toBeLessThan(190);
  });

  it('derived seeds differ by domain and index', () => {
    const p = 'dd'.repeat(32);
    const set = new Set([deriveSeed(p, 1, 0), deriveSeed(p, 1, 1), deriveSeed(p, 2, 0), deriveSeed(p, 2, 1)]);
    expect(set.size).toBe(4);
    expect(deriveSeed(p, 1, 0)).toBe(deriveSeed(p, 1, 0));
  });
});
