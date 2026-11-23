// The site's addresses in both languages, and the route each address names. No DOM access: the
// app imports it, and so does the Node prerender (web/scripts/prerender.ts), which writes one HTML
// file per address with its own head. Erasable TypeScript only, so Node runs it as it is.
//
// Portuguese lives at the root and English under /en/. A table keeps its old address,
// /?sala=CODE (/en/?sala=CODE), because invites (/s/CODE), saved links and the tests use it.

import { CODE_PATTERN } from '../../shared/protocol.ts';

export type Lang = 'pt' | 'en';
export type RouteName = 'start' | 'play' | 'guided' | 'room' | 'rules' | 'data' | 'you' | 'vs' | 'privacy' | 'terms' | 'verify' | 'notFound';
/** Routes with an address of their own (the room lives on the start address; not found has none). */
export type PathRoute = Exclude<RouteName, 'room' | 'notFound'>;
export interface Route {
  name: RouteName;
  /** The room code, only for 'room'. */
  code?: string;
}

export const ROUTE_PATHS: Record<PathRoute, { pt: string; en: string }> = {
  start: { pt: '/', en: '/en/' },
  play: { pt: '/jogar', en: '/en/play' },
  guided: { pt: '/jogar/guiada', en: '/en/play/guided' },
  rules: { pt: '/regras', en: '/en/rules' },
  data: { pt: '/dados', en: '/en/data' },
  you: { pt: '/voce', en: '/en/you' },
  /** "You against Zap": the person's own numbers, computed on the device (M7, never indexed). */
  vs: { pt: '/voce-contra-o-zap', en: '/en/you-vs-zap' },
  privacy: { pt: '/privacidade', en: '/en/privacy' },
  terms: { pt: '/termos', en: '/en/terms' },
  verify: { pt: '/como-verificamos', en: '/en/how-we-verify' },
};

export const PATH_ROUTES = Object.keys(ROUTE_PATHS) as PathRoute[];

/** Pages in the sitemap with index, follow (the data page since M7). */
export const INDEXED: readonly PathRoute[] = ['start', 'play', 'guided', 'rules', 'data', 'privacy', 'terms', 'verify'];

/** The legal pages, rendered from locales/legal.*.json (loaded on demand). */
export const LEGAL_ROUTES = ['privacy', 'terms', 'verify'] as const;
export type LegalRoute = (typeof LEGAL_ROUTES)[number];

export function isLegalRoute(name: RouteName): name is LegalRoute {
  return (LEGAL_ROUTES as readonly string[]).includes(name);
}

/** File written by the prerender for a path: '/' to 'index.html', '/en/' to 'en/index.html', '/jogar' to 'jogar.html'. */
export function outputFile(path: string): string {
  if (path.endsWith('/')) return `${path.slice(1)}index.html`;
  return `${path.slice(1)}.html`;
}

/** The language an address asks for: /en and /en/... are English, anything else Portuguese. */
export function langFromPath(pathname: string): Lang {
  return pathname === '/en' || pathname.startsWith('/en/') ? 'en' : 'pt';
}

/** Normalizes what a person typed as a room code; null when it cannot be one. */
export function cleanCode(raw: string): string | null {
  const c = raw.trim().toUpperCase().replace(/[\s-]/g, '');
  return CODE_PATTERN.test(c) ? c : null;
}

/** The address without its language prefix and trailing slashes: '/en/play/' gives '/play', '/' gives ''. */
function rest(pathname: string): string {
  const p = pathname.replace(/\/+$/, '');
  if (p === '/en') return '';
  return p.startsWith('/en/') ? p.slice(3) : p;
}

/**
 * The route an address names. Slugs of the other language still resolve (/en/jogar opens 'play'
 * in English; the app then rewrites the address with replaceState). A room is any start address
 * with a valid ?sala= code.
 */
export function routeFromPath(pathname: string, search: string): { name: RouteName; code?: string; lang: Lang } {
  const lang = langFromPath(pathname);
  const r = rest(pathname);
  if (r === '' || r === '/index.html') {
    const code = cleanCode(new URLSearchParams(search).get('sala') ?? '');
    return code ? { name: 'room', code, lang } : { name: 'start', lang };
  }
  for (const name of PATH_ROUTES) {
    if (name === 'start') continue;
    const paths = ROUTE_PATHS[name];
    if (r === paths.pt || r === rest(paths.en)) return { name, lang };
  }
  return { name: 'notFound', lang };
}

/**
 * The address of a route in a language. 'notFound' has no address of its own: it gives the start
 * address (the app keeps the unknown path with withLang instead).
 */
export function pathFor(route: { name: RouteName; code?: string }, lang: Lang): string {
  if (route.name === 'room') return `${ROUTE_PATHS.start[lang]}?sala=${route.code ?? ''}`;
  if (route.name === 'notFound') return ROUTE_PATHS.start[lang];
  return ROUTE_PATHS[route.name][lang];
}

/** The same address in the other language prefix, for a path no route names ('/x' and '/en/x'). */
export function withLang(pathname: string, lang: Lang): string {
  const r = rest(pathname);
  return lang === 'en' ? `/en${r || '/'}` : r || '/';
}
