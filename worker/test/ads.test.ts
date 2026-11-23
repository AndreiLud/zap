// Ads in test mode (CLIENT-SPEC 16, worker/src/ads.ts): off by default, /api/config answers
// `ads: null` and /ads.txt 404; on with a valid client id, both say so. The Worker's handler is
// imported by a computed path, with the Durable Object class replaced by a stub (as in
// worker-calls.test.ts).

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_INTERVAL_S, MIN_INTERVAL_S, adsSettings, adsTxt } from '../src/ads.ts';

vi.mock('../src/cf/room.ts', () => ({ Room: class {} }));

interface Handler {
  fetch(request: Request, env: unknown): Promise<Response>;
}

async function handler(): Promise<Handler> {
  const path = '../src/cf/index.ts';
  return ((await import(/* @vite-ignore */ path)) as { default: Handler }).default;
}

const CLIENT = 'ca-pub-0123456789012345';
const ON = { ADS_ENABLED: 'true', ADS_CLIENT_ID: CLIENT, ADS_TEST_MODE: 'true', ADS_MIN_INTERVAL_S: '120' };

function env(vars: Record<string, string> = {}) {
  return {
    TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
    PUBLIC_ORIGIN: 'https://zap.andreiludescher.com',
    PRIVACY_CONTACT: '',
    ADS_ENABLED: 'false',
    ADS_CLIENT_ID: '',
    ADS_TEST_MODE: 'false',
    ADS_MIN_INTERVAL_S: '120',
    ASSETS: { fetch: async () => new Response('<!doctype html><title>app</title>', { headers: { 'content-type': 'text/html' } }) },
    ...vars,
  };
}

/** wrangler.jsonc without comments and trailing commas. */
function wrangler(): { assets: { run_worker_first: string[] }; vars: Record<string, unknown> } {
  const src = readFileSync('wrangler.jsonc', 'utf8');
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      const start = i;
      for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === '\\') i++;
      out += src.slice(start, i + 1);
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

describe('ads settings', () => {
  it('off unless ADS_ENABLED is "true" and the client id is an AdSense id', () => {
    expect(adsSettings({})).toBeNull();
    expect(adsSettings({ ...ON, ADS_ENABLED: 'false' })).toBeNull();
    expect(adsSettings({ ...ON, ADS_ENABLED: 'TRUE' })).toBeNull();
    expect(adsSettings({ ...ON, ADS_CLIENT_ID: '' })).toBeNull();
    expect(adsSettings({ ...ON, ADS_CLIENT_ID: 'pub-0123456789012345' })).toBeNull();
    expect(adsSettings({ ...ON, ADS_CLIENT_ID: 'ca-pub-012345678901234' })).toBeNull();
    expect(adsSettings({ ...ON, ADS_CLIENT_ID: 'ca-pub-0123456789012345"><script>' })).toBeNull();
    expect(adsSettings(ON)).toEqual({ client: CLIENT, test: true, minIntervalS: 120 });
  });

  it('test mode only with "true"; the interval defaults to 120 s and never goes under 30 s', () => {
    expect(adsSettings({ ...ON, ADS_TEST_MODE: 'false' })!.test).toBe(false);
    expect(adsSettings({ ...ON, ADS_TEST_MODE: '' })!.test).toBe(false);
    expect(adsSettings({ ...ON, ADS_MIN_INTERVAL_S: '' })!.minIntervalS).toBe(DEFAULT_INTERVAL_S);
    expect(adsSettings({ ...ON, ADS_MIN_INTERVAL_S: 'soon' })!.minIntervalS).toBe(DEFAULT_INTERVAL_S);
    expect(adsSettings({ ...ON, ADS_MIN_INTERVAL_S: '5' })!.minIntervalS).toBe(MIN_INTERVAL_S);
    expect(adsSettings({ ...ON, ADS_MIN_INTERVAL_S: '300' })!.minIntervalS).toBe(300);
  });

  it('ads.txt names Google as a direct seller for the publisher id, only when on', () => {
    expect(adsTxt(ON)).toBe('google.com, pub-0123456789012345, DIRECT, f08c47fec0942fa0\n');
    expect(adsTxt({ ...ON, ADS_ENABLED: 'false' })).toBeNull();
  });

  it('wrangler.jsonc keeps ads off, sends /ads.txt to the Worker first, and the site has no ads.txt file', () => {
    const w = wrangler();
    expect(w.vars.ADS_ENABLED).toBe('false');
    expect(adsSettings(w.vars as Record<string, string>)).toBeNull();
    expect(w.assets.run_worker_first).toContain('/ads.txt');
    expect(existsSync('web/public/ads.txt')).toBe(false);
  });
});

describe('the Worker with ads off and on', () => {
  it('off: /api/config answers ads null and /ads.txt answers 404', async () => {
    const h = await handler();
    const cfg = await h.fetch(new Request('http://localhost:8787/api/config'), env());
    expect(cfg.status).toBe(200);
    const body = (await cfg.json()) as Record<string, unknown>;
    expect(body.ads).toBeNull();
    expect(body.adsEnabled).toBe(false);
    const txt = await h.fetch(new Request('http://localhost:8787/ads.txt'), env());
    expect(txt.status).toBe(404);
    expect(txt.headers.get('content-type')).toMatch(/^text\/plain/);
  });

  it('on: /api/config carries client, test and interval, and /ads.txt the line as text/plain', async () => {
    const h = await handler();
    const body = (await (await h.fetch(new Request('http://localhost:8787/api/config'), env(ON))).json()) as Record<string, unknown>;
    expect(body.ads).toEqual({ client: CLIENT, test: true, minIntervalS: 120 });
    expect(body.adsEnabled).toBe(true);
    const txt = await h.fetch(new Request('http://localhost:8787/ads.txt'), env(ON));
    expect(txt.status).toBe(200);
    expect(txt.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await txt.text()).toBe('google.com, pub-0123456789012345, DIRECT, f08c47fec0942fa0\n');
  });

  it('ADS_ENABLED "true" with an invalid client id stays off', async () => {
    const h = await handler();
    const e = env({ ...ON, ADS_CLIENT_ID: 'ca-pub-123' });
    expect(((await (await h.fetch(new Request('http://localhost:8787/api/config'), e)).json()) as Record<string, unknown>).ads).toBeNull();
    expect((await h.fetch(new Request('http://localhost:8787/ads.txt'), e)).status).toBe(404);
  });

  it('the invite page points at the room image of its language', async () => {
    const h = await handler();
    const pt = await (await h.fetch(new Request('http://localhost:8787/s/K7QXM'), env())).text();
    const en = await (await h.fetch(new Request('http://localhost:8787/en/s/K7QXM'), env())).text();
    expect(pt).toContain('<meta property="og:image" content="https://zap.andreiludescher.com/og/room-pt.png">');
    expect(en).toContain('<meta property="og:image" content="https://zap.andreiludescher.com/og/room-en.png">');
    expect(pt).toContain('<meta property="og:image:width" content="1200">');
    for (const f of ['room-pt.png', 'room-en.png']) expect(existsSync(`web/public/og/${f}`)).toBe(true);
  });
});
