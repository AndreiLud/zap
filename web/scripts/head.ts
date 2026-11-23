// Pure builders for the prerender (prerender.ts): the head of each page, the sitemap, robots.txt
// and the _headers file with the content security policy. No file access here, so the tests
// (web/test/prerender.test.ts) call them directly. CLIENT-SPEC 3.3 to 3.5 and 17.

import { INDEXED, PATH_ROUTES, ROUTE_PATHS, isLegalRoute, type Lang, type PathRoute } from '../src/routes.ts';

/** One language's dictionary: the shared file, the area files and the legal texts, merged. */
export type Dict = Record<string, string>;

export interface HeadOptions {
  /** Origin for absolute URLs (wrangler.jsonc vars PUBLIC_ORIGIN), no trailing slash. */
  origin: string;
  /** Hashed font URLs to preload, as served (/assets/...). */
  fonts: readonly string[];
  /**
   * The page's own chunks beyond the entry, as served: JavaScript modules (modulepreload) and their
   * stylesheets (preload as style). The data pages list their route chunk, its static imports and
   * the language's data texts, so the browser fetches them with the entry instead of one after
   * the other (the entry, then the route chunk, then the texts the route asks for).
   */
  modules?: readonly string[];
  styles?: readonly string[];
}

export const MARKER = '<!--zap:head-->';
/** Where the page's language puts its <noscript> text (locales/server.*.json server.noscript). */
export const NOSCRIPT = '<!--zap:noscript-->';
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/** Routes whose pages are not indexed but still get a file, canonical and hreflang. */
export function isIndexed(route: PathRoute): boolean {
  return INDEXED.includes(route);
}

function langCode(lang: Lang): 'pt-BR' | 'en' {
  return lang === 'pt' ? 'pt-BR' : 'en';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function need(dict: Dict, key: string): string {
  const v = dict[key];
  if (typeof v !== 'string' || !v) throw new Error(`missing locale key ${key}`);
  return v;
}

/** Title and description of a page: shell.meta.<route>.* or, for the legal pages and the You page, legal.<page>.*. */
export function metaFor(route: PathRoute, dict: Dict): { title: string; description: string } {
  if (isLegalRoute(route) || route === 'you') return { title: need(dict, `legal.${route}.metaTitle`), description: need(dict, `legal.${route}.description`) };
  return { title: need(dict, `shell.meta.${route}.title`), description: need(dict, `shell.meta.${route}.description`) };
}

export function absoluteUrl(origin: string, route: PathRoute, lang: Lang): string {
  return origin + ROUTE_PATHS[route][lang];
}

/**
 * The route whose Open Graph image and alt text a page uses: its own, except "You against Zap"
 * (M7), a personal page that is never indexed, which shares the image of the You page.
 */
export function ogRoute(route: PathRoute): PathRoute {
  return route === 'vs' ? 'you' : route;
}

/** The Open Graph image of a page (WP6 makes the 20 files): /og/<route>-<pt|en>.png. */
export function ogImage(origin: string, route: PathRoute, lang: Lang): string {
  return `${origin}/og/${ogRoute(route)}-${lang}.png`;
}

/** The <head> lines that replace the marker of web/index.html for one page in one language. */
export function buildHead(route: PathRoute, lang: Lang, dict: Dict, o: HeadOptions): string {
  const { title, description } = metaFor(route, dict);
  const url = absoluteUrl(o.origin, route, lang);
  const pt = absoluteUrl(o.origin, route, 'pt');
  const en = absoluteUrl(o.origin, route, 'en');
  const e = escapeHtml;
  const lines = [
    `<title>${e(title)}</title>`,
    `<meta name="description" content="${e(description)}">`,
  ];
  if (!isIndexed(route)) lines.push('<meta name="robots" content="noindex">');
  lines.push(
    `<link rel="canonical" href="${e(url)}">`,
    `<link rel="alternate" hreflang="pt-BR" href="${e(pt)}">`,
    `<link rel="alternate" hreflang="en" href="${e(en)}">`,
    `<link rel="alternate" hreflang="x-default" href="${e(pt)}">`,
    '<meta property="og:site_name" content="Zap">',
    '<meta property="og:type" content="website">',
    `<meta property="og:title" content="${e(title)}">`,
    `<meta property="og:description" content="${e(description)}">`,
    `<meta property="og:url" content="${e(url)}">`,
    `<meta property="og:image" content="${e(ogImage(o.origin, route, lang))}">`,
    `<meta property="og:image:width" content="${OG_WIDTH}">`,
    `<meta property="og:image:height" content="${OG_HEIGHT}">`,
    `<meta property="og:image:alt" content="${e(need(dict, `shell.og.alt.${ogRoute(route)}`))}">`,
    `<meta property="og:locale" content="${lang === 'pt' ? 'pt_BR' : 'en_US'}">`,
    `<meta property="og:locale:alternate" content="${lang === 'pt' ? 'en_US' : 'pt_BR'}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    '<meta name="theme-color" content="#F2EDE2" media="(prefers-color-scheme: light)">',
    '<meta name="theme-color" content="#111317" media="(prefers-color-scheme: dark)">',
    '<meta name="color-scheme" content="light dark">',
  );
  for (const f of o.fonts) lines.push(`<link rel="preload" href="${e(f)}" as="font" type="font/woff2" crossorigin>`);
  for (const m of o.modules ?? []) lines.push(`<link rel="modulepreload" crossorigin href="${e(m)}">`);
  for (const c of o.styles ?? []) lines.push(`<link rel="preload" href="${e(c)}" as="style" crossorigin>`);
  return lines.join('\n    ');
}

/** The built index.html with one page's head in place of the marker and its language on <html>. */
export function renderPage(template: string, lang: Lang, head: string, noscript = ''): string {
  if (!template.includes(MARKER)) throw new Error(`web/index.html has no ${MARKER} marker`);
  if (/<title>/i.test(template.replace(MARKER, ''))) throw new Error('web/index.html must not carry its own <title>');
  return template.replace(/<html lang="[^"]*">/, `<html lang="${langCode(lang)}">`).replace(MARKER, head).replace(NOSCRIPT, escapeHtml(noscript));
}

/** sitemap.xml: one <url> per indexed page and language, each with its three alternates. No lastmod. */
export function buildSitemap(origin: string): string {
  const urls: string[] = [];
  for (const route of PATH_ROUTES) {
    if (!isIndexed(route)) continue;
    const pt = absoluteUrl(origin, route, 'pt');
    const en = absoluteUrl(origin, route, 'en');
    for (const lang of ['pt', 'en'] as const) {
      urls.push(
        [
          '  <url>',
          `    <loc>${escapeHtml(absoluteUrl(origin, route, lang))}</loc>`,
          `    <xhtml:link rel="alternate" hreflang="pt-BR" href="${escapeHtml(pt)}"/>`,
          `    <xhtml:link rel="alternate" hreflang="en" href="${escapeHtml(en)}"/>`,
          `    <xhtml:link rel="alternate" hreflang="x-default" href="${escapeHtml(pt)}"/>`,
          '  </url>',
        ].join('\n'),
      );
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`;
}

export function buildRobots(origin: string): string {
  return `User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${origin}/sitemap.xml\n`;
}

/**
 * The content security policy (CLIENT-SPEC 17). 'self' covers the room socket (same origin ws and
 * wss). Turnstile is the only third party. No 'unsafe-inline' anywhere: the client never parses
 * markup with style attributes (web/test/no-inner-html.test.ts), and styles set from code go
 * through the CSSOM, which the policy allows.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  'frame-src https://challenges.cloudflare.com',
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Google's sources for the AdSense H5 games ads, appended only when ADS_ENABLED is "true". Check
 * them against Google's AdSense content security policy page before turning ads on (WP6, DEPLOY.md).
 */
export const ADS_CSP: Record<string, string[]> = {
  'script-src': ['https://pagead2.googlesyndication.com', 'https://*.googlesyndication.com', 'https://*.google.com', 'https://*.doubleclick.net'],
  'frame-src': ['https://googleads.g.doubleclick.net', 'https://*.googlesyndication.com', 'https://*.google.com'],
  'img-src': ['https://*.googlesyndication.com', 'https://*.google.com', 'https://*.doubleclick.net', 'https://*.gstatic.com'],
  'connect-src': ['https://*.googlesyndication.com', 'https://*.google.com', 'https://*.doubleclick.net'],
};

/** The policy with the ads sources when ads are on. */
export function cspFor(adsEnabled: boolean): string {
  if (!adsEnabled) return CSP;
  return CSP.split('; ')
    .map((d) => {
      const name = d.split(' ')[0];
      const extra = ADS_CSP[name];
      return extra ? `${d} ${extra.join(' ')}` : d;
    })
    .join('; ');
}

/**
 * The built _headers: web/public/_headers with the full policy in place of its
 * Content-Security-Policy line under /* (or added there when it has none).
 */
export function buildHeaders(publicHeaders: string, o: { adsEnabled: boolean }): string {
  const policy = `  Content-Security-Policy: ${cspFor(o.adsEnabled)}`;
  const lines = publicHeaders.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.trim() === '/*');
  if (start < 0) return `/*\n${policy}\n${publicHeaders}`;
  let end = lines.findIndex((l, i) => i > start && l.trim() !== '' && !/^\s/.test(l));
  if (end < 0) end = lines.length;
  const csp = lines.findIndex((l, i) => i > start && i < end && /^\s*Content-Security-Policy:/i.test(l));
  if (csp >= 0) lines[csp] = policy;
  else lines.splice(start + 1, 0, policy);
  return lines.join('\n').replace(/\n*$/, '\n');
}

/** Every page file the prerender writes, with its route and language. */
export function pages(): { route: PathRoute; lang: Lang; path: string }[] {
  const out: { route: PathRoute; lang: Lang; path: string }[] = [];
  for (const route of PATH_ROUTES) for (const lang of ['pt', 'en'] as const) out.push({ route, lang, path: ROUTE_PATHS[route][lang] });
  return out;
}
