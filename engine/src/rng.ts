// Deterministic random stream for shuffles and draws: the ChaCha20 block function (RFC 8439)
// used as a keystream generator. The key is a 256-bit seed. The server creates the match seed
// with a cryptographic generator; every hand seed is derived from it, so revealing one hand
// seed after the hand ends reveals nothing about the other hands.
//
// The stream is a plain object (arrays and numbers) so match state can be cloned with
// structuredClone and stored as JSON.

export interface ChaChaStream {
  key: number[]; // 8 words
  nonce: number[]; // 3 words
  counter: number;
  buf: number[]; // 16 words of the current block
  pos: number; // next unread word in buf
}

const C0 = 0x61707865;
const C1 = 0x3320646e;
const C2 = 0x79622d32;
const C3 = 0x6b206574;

/** Computes one ChaCha20 block (20 rounds) into out (16 unsigned 32-bit words). */
export function chachaBlock(key: readonly number[], counter: number, nonce: readonly number[], out: number[]): void {
  const j0 = C0, j1 = C1, j2 = C2, j3 = C3;
  const j4 = key[0] | 0, j5 = key[1] | 0, j6 = key[2] | 0, j7 = key[3] | 0;
  const j8 = key[4] | 0, j9 = key[5] | 0, j10 = key[6] | 0, j11 = key[7] | 0;
  const j12 = counter | 0, j13 = nonce[0] | 0, j14 = nonce[1] | 0, j15 = nonce[2] | 0;
  let x0 = j0, x1 = j1, x2 = j2, x3 = j3, x4 = j4, x5 = j5, x6 = j6, x7 = j7;
  let x8 = j8, x9 = j9, x10 = j10, x11 = j11, x12 = j12, x13 = j13, x14 = j14, x15 = j15;
  let t: number;
  for (let i = 0; i < 10; i++) {
    // column rounds
    x0 = (x0 + x4) | 0; t = x12 ^ x0; x12 = (t << 16) | (t >>> 16);
    x8 = (x8 + x12) | 0; t = x4 ^ x8; x4 = (t << 12) | (t >>> 20);
    x0 = (x0 + x4) | 0; t = x12 ^ x0; x12 = (t << 8) | (t >>> 24);
    x8 = (x8 + x12) | 0; t = x4 ^ x8; x4 = (t << 7) | (t >>> 25);
    x1 = (x1 + x5) | 0; t = x13 ^ x1; x13 = (t << 16) | (t >>> 16);
    x9 = (x9 + x13) | 0; t = x5 ^ x9; x5 = (t << 12) | (t >>> 20);
    x1 = (x1 + x5) | 0; t = x13 ^ x1; x13 = (t << 8) | (t >>> 24);
    x9 = (x9 + x13) | 0; t = x5 ^ x9; x5 = (t << 7) | (t >>> 25);
    x2 = (x2 + x6) | 0; t = x14 ^ x2; x14 = (t << 16) | (t >>> 16);
    x10 = (x10 + x14) | 0; t = x6 ^ x10; x6 = (t << 12) | (t >>> 20);
    x2 = (x2 + x6) | 0; t = x14 ^ x2; x14 = (t << 8) | (t >>> 24);
    x10 = (x10 + x14) | 0; t = x6 ^ x10; x6 = (t << 7) | (t >>> 25);
    x3 = (x3 + x7) | 0; t = x15 ^ x3; x15 = (t << 16) | (t >>> 16);
    x11 = (x11 + x15) | 0; t = x7 ^ x11; x7 = (t << 12) | (t >>> 20);
    x3 = (x3 + x7) | 0; t = x15 ^ x3; x15 = (t << 8) | (t >>> 24);
    x11 = (x11 + x15) | 0; t = x7 ^ x11; x7 = (t << 7) | (t >>> 25);
    // diagonal rounds
    x0 = (x0 + x5) | 0; t = x15 ^ x0; x15 = (t << 16) | (t >>> 16);
    x10 = (x10 + x15) | 0; t = x5 ^ x10; x5 = (t << 12) | (t >>> 20);
    x0 = (x0 + x5) | 0; t = x15 ^ x0; x15 = (t << 8) | (t >>> 24);
    x10 = (x10 + x15) | 0; t = x5 ^ x10; x5 = (t << 7) | (t >>> 25);
    x1 = (x1 + x6) | 0; t = x12 ^ x1; x12 = (t << 16) | (t >>> 16);
    x11 = (x11 + x12) | 0; t = x6 ^ x11; x6 = (t << 12) | (t >>> 20);
    x1 = (x1 + x6) | 0; t = x12 ^ x1; x12 = (t << 8) | (t >>> 24);
    x11 = (x11 + x12) | 0; t = x6 ^ x11; x6 = (t << 7) | (t >>> 25);
    x2 = (x2 + x7) | 0; t = x13 ^ x2; x13 = (t << 16) | (t >>> 16);
    x8 = (x8 + x13) | 0; t = x7 ^ x8; x7 = (t << 12) | (t >>> 20);
    x2 = (x2 + x7) | 0; t = x13 ^ x2; x13 = (t << 8) | (t >>> 24);
    x8 = (x8 + x13) | 0; t = x7 ^ x8; x7 = (t << 7) | (t >>> 25);
    x3 = (x3 + x4) | 0; t = x14 ^ x3; x14 = (t << 16) | (t >>> 16);
    x9 = (x9 + x14) | 0; t = x4 ^ x9; x4 = (t << 12) | (t >>> 20);
    x3 = (x3 + x4) | 0; t = x14 ^ x3; x14 = (t << 8) | (t >>> 24);
    x9 = (x9 + x14) | 0; t = x4 ^ x9; x4 = (t << 7) | (t >>> 25);
  }
  out[0] = (x0 + j0) >>> 0; out[1] = (x1 + j1) >>> 0; out[2] = (x2 + j2) >>> 0; out[3] = (x3 + j3) >>> 0;
  out[4] = (x4 + j4) >>> 0; out[5] = (x5 + j5) >>> 0; out[6] = (x6 + j6) >>> 0; out[7] = (x7 + j7) >>> 0;
  out[8] = (x8 + j8) >>> 0; out[9] = (x9 + j9) >>> 0; out[10] = (x10 + j10) >>> 0; out[11] = (x11 + j11) >>> 0;
  out[12] = (x12 + j12) >>> 0; out[13] = (x13 + j13) >>> 0; out[14] = (x14 + j14) >>> 0; out[15] = (x15 + j15) >>> 0;
}

/** Reads a 32-byte seed (Uint8Array or 64-char hex) as 8 little-endian words. */
export function seedWords(seed: Uint8Array | string): number[] {
  const bytes = typeof seed === 'string' ? hexToBytes(seed) : seed;
  if (bytes.length !== 32) throw new Error('seed must have 32 bytes');
  const w = new Array<number>(8);
  for (let i = 0; i < 8; i++) {
    w[i] = (bytes[4 * i] | (bytes[4 * i + 1] << 8) | (bytes[4 * i + 2] << 16) | (bytes[4 * i + 3] << 24)) >>> 0;
  }
  return w;
}

export function wordsToHex(words: readonly number[]): string {
  let s = '';
  for (const w of words) {
    for (let b = 0; b < 4; b++) s += ((w >>> (8 * b)) & 0xff).toString(16).padStart(2, '0');
  }
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2 !== 0) throw new Error('bad hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function createStream(seed: Uint8Array | string, nonce: readonly number[] = [0, 0, 0]): ChaChaStream {
  return { key: seedWords(seed), nonce: [nonce[0] >>> 0, nonce[1] >>> 0, nonce[2] >>> 0], counter: 0, buf: new Array<number>(16).fill(0), pos: 16 };
}

export function nextU32(s: ChaChaStream): number {
  if (s.pos >= 16) {
    chachaBlock(s.key, s.counter, s.nonce, s.buf);
    s.counter = (s.counter + 1) >>> 0;
    s.pos = 0;
  }
  return s.buf[s.pos++];
}

/** Uniform integer in [0, n) without modulo bias (rejection sampling). */
export function randInt(s: ChaChaStream, n: number): number {
  if (n <= 0 || n > 0x100000000) throw new Error('bad range');
  const limit = Math.floor(0x100000000 / n) * n;
  let u = nextU32(s);
  while (u >= limit) u = nextU32(s);
  return u % n;
}

/** Fisher-Yates shuffle of 0..n-1. */
export function shuffledRange(s: ChaChaStream, n: number): number[] {
  const a = new Array<number>(n);
  for (let i = 0; i < n; i++) a[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = randInt(s, i + 1);
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/**
 * Derives a child seed (64-char hex) from a parent seed: the first 8 words of the ChaCha20
 * block keyed by the parent, with the domain and index in the nonce. ChaCha20 is a PRF, so
 * one child seed says nothing about the parent or about its siblings.
 */
export function deriveSeed(parent: Uint8Array | string, domain: number, index: number): string {
  const out = new Array<number>(16);
  chachaBlock(seedWords(parent), 0, [domain >>> 0, index >>> 0, 0x7a6170], out);
  return wordsToHex(out.slice(0, 8));
}

/** Cryptographically random 32-byte seed as hex (Web Crypto, available in browsers, Workers and Node). */
export function randomSeed(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

/** Fast seeded PRNG for policies in simulations (not for dealing): mulberry32. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
