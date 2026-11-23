// The nine shout files made by tools/audio/make-shouts.sh (CLIENT-SPEC 15.3): Ogg Opus, small, and
// exactly the bytes recorded in tools/audio/SHA256SUMS.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SHOUTS, SHOUT_URLS } from '../src/sound/shouts.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const sfxDir = `${root}web/src/sfx/`;
const audioDir = `${root}tools/audio/`;

const NAMES = ['truco', 'seis', 'oito', 'nove', 'dez', 'doze', 'desce', 'corro', 'zap'];

function bytes(name: string): Buffer {
  return readFileSync(`${sfxDir}${name}.opus`);
}

describe('shout files', () => {
  it('are the nine shouts, no more, no less', () => {
    const files = readdirSync(sfxDir).filter((f) => f.endsWith('.opus'));
    expect(files.sort()).toEqual(NAMES.map((n) => `${n}.opus`).sort());
    expect([...SHOUTS].sort()).toEqual([...NAMES].sort());
    const listed = readFileSync(`${audioDir}shouts.txt`, 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('#'))
      .map((l) => l.split('|')[0]);
    expect(listed).toEqual(NAMES);
  });

  it('each starts with OggS and has OpusHead at byte 28 (mono)', () => {
    for (const n of NAMES) {
      const b = bytes(n);
      expect(b.subarray(0, 4).toString('latin1'), n).toBe('OggS');
      expect(b.subarray(28, 36).toString('latin1'), n).toBe('OpusHead');
      expect(b[36], `${n} version`).toBe(1);
      expect(b[37], `${n} channels`).toBe(1);
    }
  });

  it('each is at most 8,192 bytes and all together at most 65,536', () => {
    let total = 0;
    for (const n of NAMES) {
      const size = bytes(n).length;
      expect(size, n).toBeLessThanOrEqual(8192);
      expect(size, n).toBeGreaterThan(1000);
      total += size;
    }
    expect(total).toBeLessThanOrEqual(65536);
  });

  it('match tools/audio/SHA256SUMS', () => {
    const lines = readFileSync(`${audioDir}SHA256SUMS`, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(9);
    const sums = new Map(
      lines.map((l) => {
        const m = /^([0-9a-f]{64}) {2}\.\/([a-z]+)\.opus$/.exec(l);
        expect(m, l).not.toBeNull();
        return [m![2], m![1]] as const;
      }),
    );
    for (const n of NAMES) expect(createHash('sha256').update(bytes(n)).digest('hex'), n).toBe(sums.get(n));
  });

  it('are imported by URL from web/src/sfx', () => {
    for (const n of NAMES) expect(String(SHOUT_URLS[n as keyof typeof SHOUT_URLS])).toMatch(new RegExp(`/web/src/sfx/${n}\\.opus$`));
  });
});
