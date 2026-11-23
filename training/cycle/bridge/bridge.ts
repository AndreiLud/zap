// Node half of the local bridge between a local site (wrangler dev) and the cycle's S3 stand-in
// (contract 4.2). workerd runs only here, in the Node image; the Python half (cycle.py bridge
// push|pull) talks to the stand-in.
//
//   node training/cycle/bridge/bridge.ts export --state e2e   local zap-events (matches/, exports/,
//        receipts/) into .cache/bridge/e2e/events/, keys mirrored, unchanged etags skipped, match
//        records without the test mark left behind
//   node training/cycle/bridge/bridge.ts import --state e2e   .cache/bridge/e2e/models/ into local
//        zap-models, models and cards first, manifest.json last
//
// --state dev is .wrangler/state (site dev), --state e2e is .wrangler/e2e-state (site dev-e2e).
// worker/dev/local-r2.ts refuses any other folder and any other bucket.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLocalR2 } from '../../../worker/dev/local-r2.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const STATES = { dev: '.wrangler/state', e2e: '.wrangler/e2e-state' } as const;
export type StateName = keyof typeof STATES;
const EVENT_PREFIXES = ['matches/', 'exports/', 'receipts/'];

export function stateOf(name: string | undefined): StateName {
  if (name !== 'dev' && name !== 'e2e') throw new Error('--state must be dev or e2e');
  return name;
}

function bridgeDir(state: StateName): string {
  return resolve(ROOT, '.cache', 'bridge', state);
}

function safeKey(key: string): string {
  if (!key || key.startsWith('/') || key.split('/').includes('..')) throw new Error(`unsafe key ${key}`);
  return key;
}

/**
 * Whether an object of the local zap-events goes to the stand-in. A match record goes only when it
 * carries the test mark: a local site writes it (TEST_RECORDS), and records written before the mark
 * existed (zap-match/1) stay behind, so the test buckets hold nothing but marked records.
 */
export function carries(key: string, body: Uint8Array): boolean {
  if (!key.startsWith('matches/')) return true;
  try {
    return (JSON.parse(new TextDecoder().decode(body)) as { test?: unknown }).test === true;
  } catch {
    return false;
  }
}

export async function exportEvents(state: StateName): Promise<{ copied: number; unchanged: number; unmarked: number }> {
  const out = join(bridgeDir(state), 'events');
  const seenFile = join(bridgeDir(state), 'events-etags.json');
  const seen: Record<string, string> = existsSync(seenFile) ? JSON.parse(readFileSync(seenFile, 'utf8')) : {};
  const r2 = await openLocalR2(STATES[state], 'zap-events');
  let copied = 0;
  let unchanged = 0;
  let unmarked = 0;
  try {
    for (const prefix of EVENT_PREFIXES) {
      for (const o of await r2.list(prefix)) {
        const key = safeKey(o.key);
        const file = join(out, key);
        if (seen[key] === `unmarked:${o.etag}`) {
          unmarked++;
          continue;
        }
        if (seen[key] === o.etag && existsSync(file)) {
          unchanged++;
          continue;
        }
        const body = await r2.get(key);
        if (!body) continue;
        if (!carries(key, body)) {
          seen[key] = `unmarked:${o.etag}`;
          unmarked++;
          continue;
        }
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, body);
        seen[key] = o.etag;
        copied++;
      }
    }
  } finally {
    await r2.close();
  }
  mkdirSync(dirname(seenFile), { recursive: true });
  writeFileSync(seenFile, JSON.stringify(seen) + '\n');
  return { copied, unchanged, unmarked };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Models and cards first, manifest.json last, so the site never reads a manifest naming a missing file. */
export function importOrder(keys: string[]): string[] {
  const rank = (k: string) => (k.startsWith('models/') ? 0 : k.startsWith('cards/') ? 1 : k === 'manifest.json' ? 3 : 2);
  return [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export async function importModels(state: StateName): Promise<{ imported: number }> {
  const src = join(bridgeDir(state), 'models');
  const keys = walk(src)
    .map((p) => relative(src, p).split(sep).join('/'))
    .filter((k) => !k.startsWith('.'));
  const r2 = await openLocalR2(STATES[state], 'zap-models');
  let imported = 0;
  try {
    for (const key of importOrder(keys)) {
      const body = readFileSync(join(src, safeKey(key)));
      await r2.put(key, new Uint8Array(body), key.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/octet-stream');
      imported++;
    }
  } finally {
    await r2.close();
  }
  return { imported };
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  const [cmd] = process.argv.slice(2);
  const i = process.argv.indexOf('--state');
  let state: StateName;
  try {
    state = stateOf(i >= 0 ? process.argv[i + 1] : undefined);
  } catch (e) {
    console.error(`bridge: ${(e as Error).message}`);
    process.exit(2);
  }
  if (cmd === 'export') console.log(JSON.stringify({ state, ...(await exportEvents(state)) }));
  else if (cmd === 'import') console.log(JSON.stringify({ state, ...(await importModels(state)) }));
  else {
    console.error('usage: bridge.ts export|import --state dev|e2e');
    process.exit(1);
  }
}
