// Security and cache headers (CLIENT-SPEC 17) and the ads-off build (16.2): the _headers the
// prerender writes from web/public/_headers, with the content security policy of head.ts. With ads
// off (the default in wrangler.jsonc) nothing in it names Google. Reads the built file too when a
// build exists (npm run build:web).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADS_CSP, CSP, buildHeaders, cspFor } from '../scripts/head.ts';
import { parseJsonc } from '../scripts/prerender.ts';

const root = join(import.meta.dirname, '..', '..');
const publicHeaders = readFileSync(join(root, 'web', 'public', '_headers'), 'utf8');
const wrangler = parseJsonc(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')) as { vars: Record<string, unknown> };
const adsOn = wrangler.vars.ADS_ENABLED === 'true';

/** Header blocks of a _headers file: path pattern to its header lines. */
function blocks(text: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) {
      current = new Map();
      out.set(line.trim(), current);
    } else if (current) {
      const i = line.indexOf(':');
      current.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
    }
  }
  return out;
}

const EXPECTED_CSP =
  "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

describe('headers', () => {
  const built = blocks(buildHeaders(publicHeaders, { adsEnabled: false }));

  it('every page: HSTS, no framing, no sniffing, the referrer policy and the full policy of CLIENT-SPEC 17', () => {
    const all = built.get('/*')!;
    expect(all.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    expect(all.get('x-frame-options')).toBe('DENY');
    expect(all.get('x-content-type-options')).toBe('nosniff');
    expect(all.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(all.get('content-security-policy')).toBe(EXPECTED_CSP);
    expect(CSP).toBe(EXPECTED_CSP);
    // One policy line only: the prerender replaced the public file's, it did not add a second.
    expect(buildHeaders(publicHeaders, { adsEnabled: false }).match(/Content-Security-Policy:/g)).toHaveLength(1);
  });

  it('hashed assets are immutable for a year; Open Graph images are kept for a day', () => {
    expect(built.get('/assets/*')!.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(built.get('/og/*')!.get('cache-control')).toBe('public, max-age=86400');
  });

  it('no inline script or style is allowed, and no third party but Turnstile', () => {
    expect(EXPECTED_CSP).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    const sources = EXPECTED_CSP.match(/https:\/\/[^\s;]+/g) ?? [];
    expect([...new Set(sources)]).toEqual(['https://challenges.cloudflare.com']);
  });

  it('ads off (wrangler.jsonc): no Google domain anywhere in the headers', () => {
    expect(adsOn).toBe(false);
    const text = buildHeaders(publicHeaders, { adsEnabled: adsOn });
    expect(text.toLowerCase()).not.toMatch(/google|doubleclick|gstatic/);
    expect(cspFor(false)).toBe(CSP);
  });

  it('ads on: Google sources are added to their directives only, from ADS_CSP', () => {
    const on = cspFor(true);
    for (const [directive, sources] of Object.entries(ADS_CSP)) {
      const d = on.split('; ').find((x) => x.startsWith(`${directive} `))!;
      for (const s of sources) expect(d.split(' ')).toContain(s);
    }
    expect(on).toContain("style-src 'self'");
    expect(on).toContain("frame-ancestors 'none'");
  });

  it('the built site, when there is one, names no Google domain and has no ads.txt', () => {
    // Only what holds for any build with ads off: the file may predate a change to the headers.
    const file = join(root, 'web', 'dist', '_headers');
    if (!existsSync(file)) return;
    const text = readFileSync(file, 'utf8');
    expect(blocks(text).get('/*')?.get('content-security-policy')).toBeTruthy();
    expect(text.toLowerCase()).not.toMatch(/google|doubleclick|gstatic/);
    expect(existsSync(join(root, 'web', 'dist', 'ads.txt'))).toBe(false);
  });
});
