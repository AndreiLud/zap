// The Open Graph images (CLIENT-SPEC 21.1, WP6): 20 files in web/public/og, one per route with a
// page file and the room invite, in both languages; each a PNG of 1200 by 630 of at most 150,000
// bytes. The page heads (web/scripts/head.ts) and the invite page (worker/src/cf/index.ts) point at
// them. Made by tools/og/shoot.mjs from web/og.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OG_HEIGHT, OG_WIDTH, ogImage, pages } from '../scripts/head.ts';

const dir = join(import.meta.dirname, '..', 'public', 'og');
const ROUTES = ['start', 'play', 'guided', 'rules', 'data', 'you', 'privacy', 'terms', 'verify', 'room'];
const NAMES = ROUTES.flatMap((r) => [`${r}-pt.png`, `${r}-en.png`]);

/** Width and height from a PNG's IHDR chunk, after checking the signature. */
function pngSize(buf: Buffer): { width: number; height: number } {
  expect([...buf.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(buf.subarray(12, 16).toString('latin1')).toBe('IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('Open Graph images', () => {
  it('the 20 files exist and nothing else is in the folder', () => {
    expect(readdirSync(dir).sort()).toEqual([...NAMES].sort());
  });

  it.each(NAMES)('%s is a 1200 by 630 PNG of at most 150,000 bytes', (name) => {
    const file = join(dir, name);
    const { width, height } = pngSize(readFileSync(file));
    expect(width).toBe(OG_WIDTH);
    expect(height).toBe(OG_HEIGHT);
    expect(statSync(file).size).toBeLessThanOrEqual(150_000);
  });

  it('every page head points at an image that exists', () => {
    for (const p of pages()) {
      const url = ogImage('https://zap.andreiludescher.com', p.route, p.lang);
      expect(existsSync(join(dir, url.slice(url.lastIndexOf('/') + 1)))).toBe(true);
    }
  });
});
