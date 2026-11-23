// After `vite build`: one HTML file per address with its own head (title, description, canonical,
// hreflang, Open Graph, font preloads), sitemap.xml, robots.txt, _headers with the content security
// policy, then the size budget (CLIENT-SPEC 3.3). Crawlers and link previews do not run
// JavaScript, so each route needs its own head in its own file; the body stays the app's mount
// point and the client renders everything.
//
// Run by `npm run build:web`. Reads PUBLIC_ORIGIN and ADS_ENABLED from the vars of wrangler.jsonc,
// so the build and the Worker cannot disagree. Exits non zero on any failure.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { outputFile } from '../src/routes.ts';
import { DATA_ENTRY, formatReport, measure, readManifest, staticClosure, VS_ENTRY, type Manifest } from './budget.ts';
import { buildHead, buildHeaders, buildRobots, buildSitemap, pages, renderPage, type Dict } from './head.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = join(root, 'web', 'dist');

/** JSON with comments (wrangler.jsonc): drops // and block comments and trailing commas outside strings. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 2;
      if (i < 2) break;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function readJson(path: string): Record<string, string> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
}

/** One language's dictionary: pt-BR.json or en.json, every area file and the legal texts. */
export function loadDict(lang: 'pt' | 'en'): Dict {
  const suffix = lang === 'pt' ? 'pt-BR' : 'en';
  const dir = join(root, 'locales');
  const dict: Dict = {};
  for (const name of readdirSync(dir).sort()) {
    if (name.endsWith(`.${suffix}.json`) || name === `${suffix}.json`) Object.assign(dict, readJson(join(dir, name)));
  }
  return dict;
}

/** Hashed URLs of the two fonts, from the manifest (or the built assets when the manifest lists no fonts). */
function fontUrls(manifest: Manifest): string[] {
  const files = new Set<string>();
  for (const c of Object.values(manifest)) {
    if (c.file.endsWith('.woff2')) files.add(c.file);
    for (const a of c.assets ?? []) if (a.endsWith('.woff2')) files.add(a);
  }
  if (files.size === 0) for (const f of readdirSync(join(dist, 'assets'))) if (f.endsWith('.woff2')) files.add(`assets/${f}`);
  const pick = (stem: string) => {
    const f = [...files].find((x) => x.includes(stem));
    if (!f) throw new Error(`font ${stem} not found in the build`);
    return `/${f}`;
  };
  return [pick('figtree-latin-wght'), pick('bricolage-grotesque-latin-full')];
}

/** The data texts of a language, as the manifest names them (i18n.ts loadData imports them). */
const DATA_LOCALE: Record<'pt' | 'en', string> = { pt: '../locales/data.pt-BR.json', en: '../locales/data.en.json' };

/**
 * What a data page loads after the entry, to preload from its HTML: its route chunk with every
 * static import the entry does not already bring, the language's data texts, and their CSS. Empty
 * for every other page (they stay light; the table path has its own preloads from Vite).
 */
export function pagePreloads(manifest: Manifest, route: string, lang: 'pt' | 'en'): { modules: string[]; styles: string[] } {
  const root = route === 'data' ? DATA_ENTRY : route === 'vs' ? VS_ENTRY : null;
  if (!root || !manifest[root]) return { modules: [], styles: [] };
  const entries = Object.keys(manifest).filter((k) => manifest[k].isEntry);
  const entry = new Set(staticClosure(manifest, entries));
  const keys = staticClosure(manifest, [root, ...(manifest[DATA_LOCALE[lang]] ? [DATA_LOCALE[lang]] : [])]).filter((k) => !entry.has(k));
  const modules = [...new Set(keys.map((k) => manifest[k].file).filter((f) => f.endsWith('.js')))].map((f) => `/${f}`);
  const entryCss = new Set(entries.flatMap((k) => staticClosure(manifest, [k])).flatMap((k) => manifest[k].css ?? []));
  const styles = [...new Set(keys.flatMap((k) => manifest[k].css ?? []))].filter((c) => !entryCss.has(c)).map((c) => `/${c}`);
  return { modules, styles };
}

function write(rel: string, text: string): void {
  const path = join(dist, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function main(): void {
  const wrangler = parseJsonc(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')) as { vars?: Record<string, unknown> };
  const origin = String(wrangler.vars?.PUBLIC_ORIGIN ?? '').replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+$/.test(origin)) throw new Error(`PUBLIC_ORIGIN in wrangler.jsonc is not an https origin: "${origin}"`);
  const adsEnabled = wrangler.vars?.ADS_ENABLED === 'true';

  const template = readFileSync(join(dist, 'index.html'), 'utf8');
  const manifest = readManifest(dist);
  const fonts = fontUrls(manifest);
  const dicts = { pt: loadDict('pt'), en: loadDict('en') };

  const written: string[] = [];
  for (const p of pages()) {
    const file = outputFile(p.path);
    write(file, renderPage(template, p.lang, buildHead(p.route, p.lang, dicts[p.lang], { origin, fonts, ...pagePreloads(manifest, p.route, p.lang) }), String(dicts[p.lang]['server.noscript'] ?? '')));
    written.push(file);
  }
  write('sitemap.xml', buildSitemap(origin));
  write('robots.txt', buildRobots(origin));
  const publicHeaders = join(root, 'web', 'public', '_headers');
  write('_headers', buildHeaders(existsSync(publicHeaders) ? readFileSync(publicHeaders, 'utf8') : '', { adsEnabled }));
  console.log(`prerender: ${written.length} pages, sitemap.xml, robots.txt, _headers (ads ${adsEnabled ? 'on' : 'off'})`);

  const report = measure(dist, manifest);
  console.log(formatReport(report));
  if (!report.ok) {
    console.error('prerender: the table path is over its size budget (CLIENT-SPEC 18)');
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (e) {
    console.error(`prerender: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
