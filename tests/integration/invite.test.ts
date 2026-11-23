// Invite links /s/CODE and /en/s/CODE: their own preview (Open Graph) and the hand-off to the
// room page. Needs a running site: BASE=http://dev:8787.

import { describe, expect, it } from 'vitest';
import serverEn from '../../locales/server.en.json' with { type: 'json' };
import serverPt from '../../locales/server.pt-BR.json' with { type: 'json' };
import { BASE, randomCode } from './helpers.ts';

/** The page's words, from the same locale keys the Worker reads (locales/server.*.json). */
const titleOf = (code: string, en: boolean) => (en ? serverEn : serverPt)['server.invite.title'].replace('{code}', code);

async function page(path: string, init: RequestInit = {}): Promise<{ status: number; type: string | null; html: string; headers: Headers }> {
  const r = await fetch(BASE + path, { redirect: 'manual', ...init });
  return { status: r.status, type: r.headers.get('content-type'), html: await r.text(), headers: r.headers };
}

/** Every <meta> tag as attribute maps (the page is small and machine-made, so a regex is enough). */
function metas(html: string): Map<string, string>[] {
  const out: Map<string, string>[] = [];
  for (const m of html.matchAll(/<meta\s+([^>]*?)\/?>/g)) {
    const attrs = new Map<string, string>();
    for (const a of m[1].matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)) attrs.set(a[1].toLowerCase(), a[2]);
    out.push(attrs);
  }
  return out;
}

function meta(html: string, key: string): string | undefined {
  return metas(html).find((m) => m.get('property') === key || m.get('name') === key || m.get('http-equiv') === key)?.get('content');
}

function checkPreview(html: string, code: string, en: boolean): void {
  const title = titleOf(code, en);
  const home = en ? '/en/' : '/';
  expect(html.startsWith('<!doctype html>')).toBe(true);
  expect(html).toContain(`<html lang="${en ? 'en' : 'pt-BR'}">`);
  expect(html).toContain(`<title>${title}</title>`);
  expect(meta(html, 'og:title')).toBe(title);
  expect(meta(html, 'og:description')).toBe((en ? serverEn : serverPt)['server.invite.description']);
  expect(meta(html, 'description')).toBe(meta(html, 'og:description'));
  expect(meta(html, 'og:type')).toBe('website');
  expect(meta(html, 'og:locale')).toBe(en ? 'en_US' : 'pt_BR');
  expect(meta(html, 'robots')).toBe('noindex');
  const url = new URL(meta(html, 'og:url')!);
  expect(url.protocol).toBe('https:');
  expect(url.pathname).toBe(`${en ? '/en' : ''}/s/${code}`);
  expect(url.search).toBe('');
  const image = new URL(meta(html, 'og:image')!);
  expect(image.protocol).toBe('https:');
  expect(image.origin).toBe(url.origin);
  expect(image.pathname).toMatch(/\.(png|jpe?g|webp)$/);
  // The hand-off goes to the room page on the same site, in the same language.
  expect(meta(html, 'refresh')).toBe(`0; url=${home}?sala=${code}`);
  expect(html).toContain(`<a href="${home}?sala=${code}">${title}</a>`);
  // Descriptions follow the writing rules: no dashes used as pauses.
  for (const m of metas(html)) for (const v of m.values()) expect(v).not.toMatch(/[\u2013\u2014]| - /);
}

describe.skipIf(!BASE)('invite pages', () => {
  it('/s/CODE has its own preview in Portuguese and sends to the room page', async () => {
    const code = randomCode();
    const r = await page(`/s/${code}`);
    expect(r.status).toBe(200);
    expect(r.type).toMatch(/^text\/html/);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    // Its own policy: no script, style or form, only its own preview image.
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    checkPreview(r.html, code, false);
  });

  it('/en/s/CODE has its own preview in English and sends to the English room page', async () => {
    const code = randomCode();
    const r = await page(`/en/s/${code}`);
    expect(r.status).toBe(200);
    checkPreview(r.html, code, true);
  });

  it('accepts a lower-case code and a trailing slash, and shows the code in capitals', async () => {
    const code = randomCode();
    for (const path of [`/s/${code.toLowerCase()}`, `/s/${code}/`, `/en/s/${code.toLowerCase()}/`]) {
      const r = await page(path);
      expect(r.status, path).toBe(200);
      checkPreview(r.html, code, path.startsWith('/en/'));
    }
  });

  it('answers 404 for codes with letters or digits outside the alphabet', async () => {
    for (const bad of ['ABCD0', 'OOOOO', 'IIIII', 'LLLLL', '1ABCD', 'abcdo', 'abcdl']) {
      for (const prefix of ['/s/', '/en/s/']) {
        const r = await page(prefix + bad);
        expect(r.status, prefix + bad).toBe(404);
        expect(r.html).not.toContain(bad);
        // The refusal carries the same security headers as every other answer of the Worker.
        expect(r.type).toBe('text/plain; charset=utf-8');
        expect(r.headers.get('x-content-type-options')).toBe('nosniff');
        expect(r.headers.get('strict-transport-security')).toMatch(/^max-age=/);
        expect(r.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
      }
    }
  });

  it('never reflects the query string or the Host header', async () => {
    const code = randomCode();
    const evil = '"><script>alert(1)</script><x a="';
    const r = await page(`/s/${code}?sala=${encodeURIComponent(evil)}&x=${encodeURIComponent('<img src=x onerror=alert(2)>')}`, {
      headers: { 'x-forwarded-host': 'evil.example' },
    });
    expect(r.status).toBe(200);
    expect(r.html).not.toContain('<script');
    expect(r.html).not.toContain('alert(');
    expect(r.html).not.toContain('evil.example');
    expect(r.html).not.toContain('onerror');
    // Every attribute value is plain text: no raw angle brackets or quotes inside.
    for (const m of metas(r.html)) for (const v of m.values()) expect(v).not.toMatch(/[<>]/);
    checkPreview(r.html, code, false);
  });
});
