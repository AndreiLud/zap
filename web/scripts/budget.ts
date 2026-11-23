// The size budget of the table path (CLIENT-SPEC 18): the JavaScript and CSS a phone downloads to
// open /?sala=CODE, measured from the Vite manifest as gzip -9 sizes of the entry chunk, the table
// chunk and everything they import statically. The prerender runs it after every build and fails
// the build above budget. Also runnable alone: node web/scripts/budget.ts [web/dist].
//
// Milestone 7 adds the rows of DATA-SPEC 1.3 (m7Rows): what M7 adds to the entry and to the
// table's own chunks, measured from M8's final build; the data page beyond the entry as it opens
// (its locale file and the generated JSON included) and scrolled to the end (replays.json apart);
// replays.json; the personal page beyond the entry and the chunks it shares with the data page;
// and the CSS of both pages, as they open and scrolled to the end.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export const BUDGET = { js: 120_000, css: 25_000 } as const;

/** The table's module, the dynamic entry that main.tsx starts loading at once on ?sala=. */
export const TABLE_ENTRY = 'src/table/Table.tsx';

interface ManifestChunk {
  file: string;
  src?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
  assets?: string[];
}
export type Manifest = Record<string, ManifestChunk>;

export interface BudgetFile {
  file: string;
  raw: number;
  gzip: number;
}

export interface BudgetReport {
  js: { files: BudgetFile[]; gzip: number; budget: number };
  css: { files: BudgetFile[]; gzip: number; budget: number };
  /** The rows of DATA-SPEC 1.3 (empty when the build has no data page). */
  m7: M7Row[];
  ok: boolean;
}

/** One budget row of DATA-SPEC 1.3: what it measures, the gzip -9 bytes, and its limit. */
export interface M7Row {
  name: string;
  gzip: number;
  limit: number;
  files: string[];
}

/**
 * M8's final build, gzip -9, the base of M7's growth rows. M8's performance run C (17:03 on
 * 2026-11-22, _local/m8/performance.md) came before M8's last review fixes, so where a later build
 * shows the chunk as M8 left it, that build is the base: actions 14,224 and index 21,396 and the
 * table's own chunk 19,321 from the build of 00:43 on 2026-11-23 (_local/m7/wp2-build-web.log),
 * after M8's last change and before M7 touched the entry's or the table's modules (only Term.tsx,
 * in the entry, by about 0.1 KB); jsxRuntime 32,281 from run C, since in that later build it also
 * carried data page code.
 */
export const M8_BASE = { entryJs: 32_281 + 21_396 + 14_224, tableOwnJs: 19_321 } as const;

/**
 * DATA-SPEC 1.3. The table row counts the table's own chunks; the entry row covers what both paths
 * share. /dados and the CSS are measured as the pages open: the route chunk, its static imports and
 * the data texts. What loads only when the reader comes near it or asks for it (replays.json and
 * F23's viewer, the plan's four chapters with sim.json, parts/chapters-load.ts, and the personal
 * page's replay) is apart, as the spec sets replays.json apart; those rows keep the spec's limits.
 * Two more rows guard the pages scrolled to the end, at limits above the spec's that wait for the
 * owner's approval: the JavaScript at 82,500, the 82,000 the integration raised it to (M7 DEVIATIONS,
 * integration item 4) plus the review fixes of 2026-11-23 to the reading chapter (the network
 * without reading head to head against its twin, the explorer titles scoped to the explorers
 * measured, the control named by the file it trained against), which took it to 82,212; the CSS at
 * 11,500, since six smaller files gzip to more than one (review fixes, M7 DEVIATIONS).
 */
export const M7_BUDGET = { entryGrowth: 2_000, tableGrowth: 500, data: 60_000, dataAll: 82_500, replays: 12_000, vs: 30_000, css: 8_000, cssAll: 11_500 } as const;

export const DATA_ENTRY = 'src/pages/Data.tsx';
export const VS_ENTRY = 'src/pages/YouVsZap.tsx';
export const REPLAYS = 'src/data/generated/replays.json';
const DATA_LOCALES = ['../locales/data.pt-BR.json', '../locales/data.en.json'];

/** Keys of the chunks a page loads for these roots: the roots and their static imports, recursively. */
export function staticClosure(manifest: Manifest, roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const visit = (key: string) => {
    if (seen.has(key) || !manifest[key]) return;
    seen.add(key);
    for (const k of manifest[key].imports ?? []) visit(k);
  };
  roots.forEach(visit);
  return [...seen];
}

/** The keys the table path starts from: the HTML entry and the table chunk. */
export function tableRoots(manifest: Manifest): string[] {
  const entries = Object.keys(manifest).filter((k) => manifest[k].isEntry);
  if (!entries.length) throw new Error('the manifest has no entry chunk');
  if (!manifest[TABLE_ENTRY]) throw new Error(`the manifest has no ${TABLE_ENTRY} chunk: is the table still a lazy chunk?`);
  return [...entries, TABLE_ENTRY];
}

/** The keys a page may load: its static closure plus every dynamic import reachable from it, recursively. */
export function reachable(manifest: Manifest, roots: readonly string[], skip: ReadonlySet<string> = new Set()): string[] {
  const seen = new Set<string>();
  const visit = (key: string) => {
    if (seen.has(key) || skip.has(key) || !manifest[key]) return;
    seen.add(key);
    for (const k of [...(manifest[key].imports ?? []), ...(manifest[key].dynamicImports ?? [])]) visit(k);
  };
  roots.forEach(visit);
  return [...seen];
}

/** The rows of DATA-SPEC 1.3 for a build that has the data page; [] otherwise. */
export function m7Rows(dist: string, manifest: Manifest): M7Row[] {
  if (!manifest[DATA_ENTRY]) return [];
  const cache = new Map<string, number>();
  const gz = (file: string) => {
    let n = cache.get(file);
    if (n === undefined) {
      n = gzipSync(readFileSync(join(dist, file)), { level: 9 }).length;
      cache.set(file, n);
    }
    return n;
  };
  const jsOf = (keys: Iterable<string>) => [...new Set([...keys].map((k) => manifest[k].file).filter((f) => f.endsWith('.js')))];
  const cssOf = (keys: Iterable<string>) => [...new Set([...keys].flatMap((k) => manifest[k].css ?? []))];
  const sum = (files: string[]) => files.reduce((a, f) => a + gz(f), 0);
  const row = (name: string, files: string[], limit: number, base = 0): M7Row => ({ name, gzip: sum(files) - base, limit, files: files.sort() });

  const entries = Object.keys(manifest).filter((k) => manifest[k].isEntry);
  const entryKeys = new Set(staticClosure(manifest, entries));
  const entryFiles = new Set(jsOf(entryKeys));
  const entryCss = new Set(cssOf(entryKeys));
  const beyond = (keys: string[]) => jsOf(keys).filter((f) => !entryFiles.has(f));
  const rows: M7Row[] = [row('entry chunk and its imports, growth over M8', [...entryFiles], M7_BUDGET.entryGrowth, M8_BASE.entryJs)];
  if (manifest[TABLE_ENTRY]) {
    rows.push(row('table chunks beyond the entry, growth over M8', beyond(staticClosure(manifest, [TABLE_ENTRY])), M7_BUDGET.tableGrowth, M8_BASE.tableOwnJs));
  }
  // The data page: what it loads as it opens beyond the entry, its larger locale file included;
  // then everything it can load as the reader scrolls, replays.json apart (its own row).
  const replays = new Set(Object.keys(manifest).filter((k) => k === REPLAYS));
  const locales = DATA_LOCALES.filter((k) => manifest[k]);
  const bigLocale = locales.sort((a, b) => gz(manifest[b].file) - gz(manifest[a].file))[0];
  const openKeys = staticClosure(manifest, [DATA_ENTRY, ...(bigLocale ? [bigLocale] : [])]).filter((k) => !entryKeys.has(k));
  // The entry is loaded already: its own lazy routes are not the data page's.
  const dataKeys = reachable(manifest, [DATA_ENTRY, ...(bigLocale ? [bigLocale] : [])], new Set([...entryKeys, ...replays, ...locales.filter((k) => k !== bigLocale)]));
  rows.push(row('/dados as it opens beyond the entry (locale and generated data included)', beyond(openKeys), M7_BUDGET.data));
  rows.push(row('/dados scrolled to the end beyond the entry (chapters and replay viewer included, replays.json apart)', beyond(dataKeys), M7_BUDGET.dataAll));
  for (const k of replays) rows.push(row('replays.json', [manifest[k].file], M7_BUDGET.replays));
  const openCss = new Set(cssOf(openKeys));
  const allCss = new Set(cssOf(dataKeys));
  if (manifest[VS_ENTRY]) {
    const vsKeys = reachable(manifest, [VS_ENTRY], new Set([...entryKeys, ...replays, ...locales]));
    const shared = new Set(jsOf(dataKeys));
    rows.push(row('/voce-contra-o-zap beyond the entry and the chunks shared with /dados', beyond(vsKeys).filter((f) => !shared.has(f)), M7_BUDGET.vs));
    for (const c of cssOf(staticClosure(manifest, [VS_ENTRY]))) openCss.add(c);
    for (const c of cssOf(vsKeys)) allCss.add(c);
  }
  rows.push(row('CSS of both data pages as they open, beyond the entry', [...openCss].filter((f) => !entryCss.has(f)), M7_BUDGET.css));
  rows.push(row('CSS of both data pages scrolled to the end, beyond the entry', [...allCss].filter((f) => !entryCss.has(f)), M7_BUDGET.cssAll));
  return rows;
}

export function measure(dist: string, manifest: Manifest): BudgetReport {
  const keys = staticClosure(manifest, tableRoots(manifest));
  const js = new Set<string>();
  const css = new Set<string>();
  for (const k of keys) {
    const c = manifest[k];
    if (c.file.endsWith('.js')) js.add(c.file);
    for (const f of c.css ?? []) css.add(f);
  }
  const sizes = (files: Set<string>): BudgetFile[] =>
    [...files].sort().map((file) => {
      const buf = readFileSync(join(dist, file));
      return { file, raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length };
    });
  const jsFiles = sizes(js);
  const cssFiles = sizes(css);
  const sum = (xs: BudgetFile[]) => xs.reduce((a, f) => a + f.gzip, 0);
  const report: BudgetReport = {
    js: { files: jsFiles, gzip: sum(jsFiles), budget: BUDGET.js },
    css: { files: cssFiles, gzip: sum(cssFiles), budget: BUDGET.css },
    m7: m7Rows(dist, manifest),
    ok: false,
  };
  report.ok = report.js.gzip <= BUDGET.js && report.css.gzip <= BUDGET.css && report.m7.every((r) => r.gzip <= r.limit);
  return report;
}

export function readManifest(dist: string): Manifest {
  return JSON.parse(readFileSync(join(dist, '.vite', 'manifest.json'), 'utf8')) as Manifest;
}

export function formatReport(r: BudgetReport): string {
  const line = (f: BudgetFile) => `  ${f.file}: ${f.raw} bytes, ${f.gzip} gzip`;
  return [
    `table path JavaScript: ${r.js.gzip} bytes gzip -9 (budget ${r.js.budget})`,
    ...r.js.files.map(line),
    `table path CSS: ${r.css.gzip} bytes gzip -9 (budget ${r.css.budget})`,
    ...r.css.files.map(line),
    ...r.m7.map((m) => `M7 ${m.name}: ${m.gzip} bytes gzip -9 (budget ${m.limit})${m.gzip > m.limit ? ' OVER' : ''}`),
    r.ok ? 'budget: ok' : 'budget: OVER',
  ].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = resolve(process.argv[2] ?? fileURLToPath(new URL('../dist/', import.meta.url)));
  const r = measure(dist, readManifest(dist));
  console.log(formatReport(r));
  if (!r.ok) process.exit(1);
}
