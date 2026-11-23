// The brake bills a room only while its handlers run (worker/src/brake.ts BusyClock). That holds
// only while nothing keeps the room from hibernating between events. Cloudflare's lifecycle page
// (read on 2026-11-22) lists what does: setTimeout or setInterval callbacks, unfinished I/O or
// ctx.waitUntil promises, an open outbound connection, and the standard WebSocket API. This test
// reads the room and every module it imports, and checks that none of them uses any of these, and
// that the room's handlers and its waitUntil promises all go through the brake's clock.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOM = join(ROOT, 'worker', 'src', 'cf', 'room.ts');

/** Source without comments, so a sentence about setTimeout in a comment does not count. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** The room and every module it imports with a relative path (types included, they are cheap). */
function moduleGraph(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = resolve(dirname(file), m[1]);
      if (/\.(ts|js|mjs)$/.test(target) && existsSync(target)) queue.push(target);
    }
  }
  return [...seen].sort();
}

describe('the room can hibernate between events', () => {
  const files = moduleGraph(ROOM);

  it('reads the room and the modules it runs', () => {
    const rel = files.map((f) => f.slice(ROOT.length + 1));
    expect(rel).toContain('worker/src/cf/room.ts');
    expect(rel).toContain('worker/src/room-core.ts');
    expect(rel).toContain('worker/src/brake.ts');
    expect(rel.some((f) => f.startsWith('engine/src/'))).toBe(true);
    expect(rel.some((f) => f.startsWith('ai/src/'))).toBe(true);
  });

  it('no timers, no outbound connection, no standard WebSocket accept', () => {
    const banned: [string, RegExp][] = [
      ['setTimeout', /\bsetTimeout\s*\(/],
      ['setInterval', /\bsetInterval\s*\(/],
      ['scheduler.wait', /\bscheduler\s*\.\s*wait\s*\(/],
      ['an outbound WebSocket', /\bnew\s+WebSocket\s*\(/],
      ['a TCP socket', /cloudflare:sockets|\bconnect\s*\(\s*\{/],
      // The room's own fetch(request: Request) handler is a definition, not a call.
      ['an outbound fetch', /(?<![.\w])fetch\s*\((?!request: Request\))/],
      ['the standard WebSocket accept', /\.\s*accept\s*\(\s*\)/],
    ];
    const found: string[] = [];
    for (const f of files) {
      const src = code(f);
      for (const [what, re] of banned) if (re.test(src)) found.push(`${f.slice(ROOT.length + 1)}: ${what}`);
    }
    expect(found).toEqual([]);
  });

  it('sockets use the hibernation API', () => {
    const src = code(ROOM);
    expect(src).toMatch(/this\.ctx\.acceptWebSocket\(/);
  });

  it('every handler and every waitUntil promise is on the brake\'s clock', () => {
    const src = code(ROOM);
    // One ctx.waitUntil, inside keep(), which puts the promise on the clock.
    expect(src.match(/ctx\.waitUntil\(/g)?.length).toBe(1);
    expect(src).toMatch(/private keep\(p: Promise<unknown>\): void \{\s*this\.clock\.enter\(Date\.now\(\), false\);\s*this\.ctx\.waitUntil\(p\.finally\(\(\) => this\.clock\.leave\(Date\.now\(\)\)\)\);/);
    // The handlers Cloudflare calls, and the RPC methods the Worker calls, each run through timed().
    for (const name of ['fetch', 'webSocketMessage', 'webSocketClose', 'webSocketError', 'alarm', 'create', 'info', 'report', 'setNoAdapt', 'forget', 'rekey', 'expireForTest']) {
      const m = new RegExp(`\\n  ${name}\\([^)]*\\)(?::\\s*Promise<[^\\n]*>)?\\s*\\{\\s*return this\\.timed\\(`).exec(src);
      expect(m, `${name} runs through timed()`).not.toBeNull();
    }
    // No other public method: a new RPC method must be added above.
    const body = src.slice(src.indexOf('export class Room extends'));
    const publicMethods = [...body.matchAll(/\n  (?:async )?([a-zA-Z]+)\([^)]*\)(?::[^{]+)?\{/g)].map((m) => m[1]).filter((n) => n !== 'constructor');
    const privateOnes = new Set([...body.matchAll(/\n  private (?:async |readonly )?([a-zA-Z]+)/g)].map((m) => m[1]));
    expect(publicMethods.filter((n) => !privateOnes.has(n)).sort()).toEqual(['alarm', 'create', 'expireForTest', 'fetch', 'forget', 'info', 'rekey', 'report', 'setNoAdapt', 'webSocketClose', 'webSocketError', 'webSocketMessage']);
    // The constructor's setup is on the clock too.
    expect(src).toMatch(/this\.clock\.enter\(Date\.now\(\), true\);\s*ctx\.blockConcurrencyWhile\(/);
  });
});
