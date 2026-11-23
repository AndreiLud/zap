// The head of every prerendered page, the sitemap, robots.txt and the built _headers
// (web/scripts/head.ts, prerender.ts; CLIENT-SPEC 3.3 to 3.5 and 17).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CSP, buildHead, buildHeaders, buildRobots, buildSitemap, ogRoute, pages, renderPage } from '../scripts/head.ts';
import { loadDict, parseJsonc } from '../scripts/prerender.ts';
import { outputFile } from '../src/routes.ts';

const root = join(import.meta.dirname, '..', '..');
const ORIGIN = 'https://zap.andreiludescher.com';
const FONTS = ['/assets/figtree-latin-wght-abc123.woff2', '/assets/bricolage-grotesque-latin-full-def456.woff2'];
const dicts = { pt: loadDict('pt'), en: loadDict('en') };

describe('prerender heads', () => {
  it('writes 20 pages, one per route and language', () => {
    const files = pages().map((p) => outputFile(p.path));
    expect(files.sort()).toEqual(
      [
        'index.html',
        'en/index.html',
        'jogar.html',
        'en/play.html',
        'jogar/guiada.html',
        'en/play/guided.html',
        'regras.html',
        'en/rules.html',
        'dados.html',
        'en/data.html',
        'voce.html',
        'en/you.html',
        'voce-contra-o-zap.html',
        'en/you-vs-zap.html',
        'privacidade.html',
        'en/privacy.html',
        'termos.html',
        'en/terms.html',
        'como-verificamos.html',
        'en/how-we-verify.html',
      ].sort(),
    );
  });

  it('gives every page its title, description, canonical, three alternates, Open Graph and font preloads', () => {
    for (const p of pages()) {
      const head = buildHead(p.route, p.lang, dicts[p.lang], { origin: ORIGIN, fonts: FONTS });
      const url = `${ORIGIN}${p.path}`;
      expect(head, p.path).toMatch(/<title>[^<]+ · Zap<\/title>|<title>Zap · [^<]+<\/title>/);
      expect(head).toMatch(/<meta name="description" content="[^"]{20,}">/);
      expect(head).toContain(`<link rel="canonical" href="${url}">`);
      expect(head.match(/rel="alternate" hreflang=/g)).toHaveLength(3);
      expect(head).toMatch(/hreflang="x-default" href="https:\/\/zap\.andreiludescher\.com\/(?!en)/);
      expect(head).toContain(`<meta property="og:url" content="${url}">`);
      expect(head).toContain(`<meta property="og:image" content="${ORIGIN}/og/${ogRoute(p.route)}-${p.lang}.png">`);
      expect(head).toContain('<meta property="og:image:width" content="1200">');
      expect(head).toContain('<meta property="og:image:height" content="630">');
      expect(head).toMatch(/<meta property="og:image:alt" content="Zap: [^"]+">/);
      expect(head).toContain(`<meta property="og:locale" content="${p.lang === 'pt' ? 'pt_BR' : 'en_US'}">`);
      expect(head).toContain('<meta name="twitter:card" content="summary_large_image">');
      expect(head.match(/name="theme-color"/g)).toHaveLength(2);
      expect(head).toContain('<meta name="color-scheme" content="light dark">');
      for (const f of FONTS) expect(head).toContain(`<link rel="preload" href="${f}" as="font" type="font/woff2" crossorigin>`);
      const noindex = p.route === 'you' || p.route === 'vs';
      expect(head.includes('<meta name="robots" content="noindex">'), `${p.path} noindex`).toBe(noindex);
    }
  });

  it('matches the example of the spec for the Play page in Portuguese', () => {
    const head = buildHead('play', 'pt', dicts.pt, { origin: ORIGIN, fonts: [] });
    expect(head).toContain('<title>Jogar · Zap</title>');
    expect(head).toContain('<meta name="description" content="Escolha a mesa: 2 contra 2, 1 contra 1 ou uma sala com amigos, no truco paulista ou mineiro.">');
    expect(head).toContain('<link rel="alternate" hreflang="pt-BR" href="https://zap.andreiludescher.com/jogar">');
    expect(head).toContain('<link rel="alternate" hreflang="en" href="https://zap.andreiludescher.com/en/play">');
    expect(head).toContain('<link rel="alternate" hreflang="x-default" href="https://zap.andreiludescher.com/jogar">');
    expect(head).toContain('<meta property="og:locale:alternate" content="en_US">');
  });

  it('uses the legal texts for the legal pages and the You page', () => {
    expect(buildHead('privacy', 'en', dicts.en, { origin: ORIGIN, fonts: [] })).toContain('<title>Privacy · Zap</title>');
    expect(buildHead('you', 'pt', dicts.pt, { origin: ORIGIN, fonts: [] })).toContain('<title>Você · Zap</title>');
  });

  it('puts the head in place of the marker and the language on <html>', () => {
    const template = '<!doctype html>\n<html lang="pt-BR">\n<head>\n<!--zap:head-->\n</head><body><div id="app"></div></body></html>';
    const out = renderPage(template, 'en', '<title>Play · Zap</title>');
    expect(out).toContain('<html lang="en">');
    expect(out).toContain('<title>Play · Zap</title>');
    expect(out).not.toContain('<!--zap:head-->');
    expect(() => renderPage('<html lang="pt-BR"><head></head></html>', 'pt', '')).toThrow(/marker/);
    // The source page carries the marker and no title of its own.
    const source = readFileSync(join(root, 'web', 'index.html'), 'utf8');
    expect(source).toContain('<!--zap:head-->');
    expect(source).not.toMatch(/<title>/);
    // Its <noscript> text comes from the page's language (locales/server.*.json), not from the source page.
    expect(source).toContain('<noscript><!--zap:noscript--></noscript>');
    expect(renderPage(source, 'en', '', dicts.en['server.noscript'] as string)).toContain('<noscript>Zap needs JavaScript to play.</noscript>');
    expect(renderPage(source, 'pt', '', dicts.pt['server.noscript'] as string)).toContain('<noscript>O Zap precisa de JavaScript para jogar.</noscript>');
  });
});

describe('sitemap and robots', () => {
  it('lists 16 addresses, each with its three alternates and no lastmod', () => {
    const xml = buildSitemap(ORIGIN);
    expect(xml.match(/<url>/g)).toHaveLength(16);
    expect(xml.match(/<xhtml:link /g)).toHaveLength(48);
    expect(xml).not.toContain('lastmod');
    expect(xml).not.toContain('/voce');
    expect(xml).toContain(`<loc>${ORIGIN}/dados</loc>`);
    expect(xml).toContain(`<loc>${ORIGIN}/</loc>`);
    expect(xml).toContain(`<loc>${ORIGIN}/en/how-we-verify</loc>`);
  });

  it('allows everything but the API', () => {
    expect(buildRobots(ORIGIN)).toBe(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${ORIGIN}/sitemap.xml\n`);
  });
});

describe('headers', () => {
  const publicHeaders = readFileSync(join(root, 'web', 'public', '_headers'), 'utf8');

  it('replaces the policy of the public file with the full one, ads off: no Google source', () => {
    const out = buildHeaders(publicHeaders, { adsEnabled: false });
    expect(out).toContain(`  Content-Security-Policy: ${CSP}`);
    expect(out.match(/Content-Security-Policy:/g)).toHaveLength(1);
    expect(out.toLowerCase()).not.toContain('google');
    expect(out).toContain('X-Frame-Options: DENY');
    expect(CSP).toContain("frame-ancestors 'none'");
    expect(CSP).toContain("style-src 'self';");
    expect(CSP).not.toContain('unsafe-inline');
    expect(CSP).toContain("script-src 'self' https://challenges.cloudflare.com");
  });

  it('adds the policy under /* when the public file has none', () => {
    const out = buildHeaders('/*\n  X-Content-Type-Options: nosniff\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n', { adsEnabled: false });
    expect(out.split('\n')[1]).toBe(`  Content-Security-Policy: ${CSP}`);
    expect(out).toContain('/assets/*\n  Cache-Control');
  });

  it('reads the build settings from wrangler.jsonc', () => {
    const w = parseJsonc(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')) as { vars: Record<string, unknown> };
    expect(w.vars.PUBLIC_ORIGIN).toBe(ORIGIN);
    expect(w.vars.ADS_ENABLED).toBe('false');
  });
});
