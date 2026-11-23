// Build of the web client: `npm run build:web` runs this build into web/dist, then
// web/scripts/prerender.ts writes one HTML file per address with its own head, the sitemap,
// robots.txt and _headers, and checks the size budget. wrangler serves web/dist as static assets.
import { readFileSync } from 'node:fs';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { factsForPages } from '../tools/data/page-keys.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
const repo = fileURLToPath(new URL('..', import.meta.url));

/**
 * The data page and "You against Zap" replay matches with the engine's match code (replay,
 * applyAction, observe, the deal). The entry uses only constants and small helpers of the same
 * modules, and a module lives in one chunk only, so without this the match code would ship with
 * the entry to every page (DATA-SPEC 1.3, entry row). Imports of engine/, ai/ and shared/ made from
 * those two pages resolve to a second copy of the module (id suffix ?copy); the copy's own imports
 * stay copies, so Rollup bundles the whole copy into the pages' chunks and nothing of it into the
 * entry. The copies hold no state the two graphs share: the pages hand them plain data only.
 */
export function pageEngineCopy(): Plugin {
  const pages = ['web/src/data/', 'web/src/you-vs-zap/'].map((d) => repo + d.split('/').join(sep));
  const shared = ['engine/src/', 'ai/src/', 'shared/'].map((d) => repo + d.split('/').join(sep));
  const SUFFIX = '?copy';
  return {
    name: 'zap:page-engine-copy',
    apply: 'build',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || source.startsWith('\0')) return null;
      const from = importer.split('?')[0];
      if (!importer.endsWith(SUFFIX) && !pages.some((d) => from.startsWith(d))) return null;
      const r = await this.resolve(source, from, { ...options, skipSelf: true });
      if (!r || r.external) return r;
      const id = r.id.split('?')[0];
      if (!/\.tsx?$/.test(id) || !shared.some((d) => id.startsWith(d))) return r;
      return id + SUFFIX;
    },
  };
}

/** Keys of a generated file's provenance the pages never read (the tests read them from disk). */
const UNREAD_PROVENANCE = new Set(['command', 'node', 'cpu', 'commit']);
const HASH_KEYS = new Set(['sha256', 'manifestSha256']);

/** A generated file without its input hashes and without the machine that made it. */
export function trimGenerated(value: unknown, inProvenance = false): unknown {
  if (Array.isArray(value)) return value.map((v) => trimGenerated(v, inProvenance));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (HASH_KEYS.has(k) || (inProvenance && UNREAD_PROVENANCE.has(k))) continue;
    out[k] = trimGenerated(v, inProvenance || k === 'provenance');
  }
  return out;
}

/**
 * The files of web/src/data/generated/ keep their full provenance on disk (the stale test and the
 * method page read it). The pages read only its dates, paths, seed and model version, so the
 * bundle gets each file without the sha256 hashes, the command and the machine (DATA-SPEC 1.3).
 * facts-view.json also keeps on disk every measurement the method doc names; the bundle gets only
 * the keys the pages read (tools/data/page-keys.ts).
 */
export function generatedForPages(): Plugin {
  const dir = repo + 'web/src/data/generated/'.split('/').join(sep);
  return {
    name: 'zap:generated-for-pages',
    apply: 'build',
    enforce: 'pre',
    load(id) {
      const file = id.split('?')[0];
      if (!file.startsWith(dir) || !file.endsWith('.json')) return null;
      const json = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      return JSON.stringify(trimGenerated(file.endsWith(`${sep}facts-view.json`) ? factsForPages(json) : json));
    },
  };
}

export default defineConfig({
  root,
  base: '/',
  publicDir: 'public',
  plugins: [pageEngineCopy(), generatedForPages()],
  // Vite 8 transforms with oxc: JSX goes straight to preact's automatic runtime, no plugin needed.
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    // The prerender reads the hashed names (fonts to preload, chunks for the budget) from here.
    manifest: true,
    // Fonts and sounds stay files (immutable cache, preload), never data: URLs in the CSS or JS.
    assetsInlineLimit: (file: string) => (/\.(woff2|opus)$/.test(file) ? false : undefined),
  },
  server: { fs: { allow: ['..'] } },
});
