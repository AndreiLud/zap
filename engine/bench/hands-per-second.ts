// Measures random self-play speed of the rules engine on one core: hands per second for each
// variant and table size.
// Usage: node engine/bench/hands-per-second.ts [seconds-per-case] [--json] [--write-facts]
// --write-facts stores the result under "engine.speed" in facts.json.

import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { makeConfig, type Variant } from '../src/config.ts';
import { applyAction, expectedActor, legalMask, newMatch } from '../src/engine.ts';
import { mulberry32 } from '../src/rng.ts';
import { seriesSeed } from '../src/simulate.ts';

const seconds = Number(process.argv[2] ?? 5);
const asJson = process.argv.includes('--json');
const BASE = '7a6170000000000000000000000000000000000000000000000000000000000b';

function popPick(mask: number, r: number): number {
  let count = 0;
  for (let m = mask; m; m &= m - 1) count++;
  let k = Math.floor(r * count);
  for (let a = 0; a < 15; a++) {
    if (mask & (1 << a)) {
      if (k === 0) return a;
      k--;
    }
  }
  return -1;
}

function run(variant: Variant, players: 2 | 4, ms: number) {
  const config = makeConfig(variant, players);
  const rand = mulberry32(12345);
  let hands = 0;
  let actions = 0;
  let matches = 0;
  const t0 = performance.now();
  let now = t0;
  while (now - t0 < ms) {
    for (let k = 0; k < 20; k++) {
      const s = newMatch(config, seriesSeed(BASE, matches++));
      while (!s.over) {
        const seat = expectedActor(s);
        applyAction(s, seat, popPick(legalMask(s, seat), rand()));
        actions++;
      }
      hands += s.history.length;
    }
    now = performance.now();
  }
  const sec = (now - t0) / 1000;
  return { variant, players, matches, hands, actions, seconds: sec, handsPerSecond: Math.round(hands / sec), actionsPerSecond: Math.round(actions / sec) };
}

// Warm up the JIT, then measure.
for (const v of ['paulista', 'mineiro'] as const) for (const p of [2, 4] as const) run(v, p, 300);
const results = [];
for (const v of ['paulista', 'mineiro'] as const) {
  for (const p of [2, 4] as const) {
    const r = run(v, p, seconds * 1000);
    results.push(r);
    if (!asJson) console.log(`${v} ${p === 4 ? '2x2' : '1x1'}: ${r.handsPerSecond.toLocaleString('en-US')} hands/s, ${r.actionsPerSecond.toLocaleString('en-US')} actions/s (${r.hands} hands in ${r.seconds.toFixed(1)} s)`);
  }
}
const report = {
  measuredAt: new Date().toISOString(),
  node: process.version,
  cpu: cpus()[0]?.model ?? 'unknown',
  method: 'uniformly random legal actions, default rules, one core, full match history recorded',
  results,
  minHandsPerSecond: Math.min(...results.map((r) => r.handsPerSecond)),
};
if (asJson) console.log(JSON.stringify(report, null, 2));
if (process.argv.includes('--write-facts')) {
  const path = new URL('../../facts.json', import.meta.url);
  let facts: Record<string, any> = {};
  try {
    facts = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    facts = {};
  }
  facts.engine = { ...(facts.engine ?? {}), speed: report };
  writeFileSync(path, JSON.stringify(facts, null, 2) + '\n');
  console.log('facts.json updated');
}
