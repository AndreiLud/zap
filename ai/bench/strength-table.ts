// Strength table: duplicate matches between pairs of players, per variant and table size, with
// 95% confidence intervals. Each row is "A against B": A's average score per match (1 win, 0
// loss) over duplicate pairs, so 50% means equal strength.
//
// Usage: node ai/bench/strength-table.ts --model <zap.zapw> [--tuned ai/models/heuristic-tuned.json]
//        [--pairs 1000] [--rows zap-tuned,zap-heuristic,...] [--out file.json] [--write-facts]
//        [--facts-key ai.strength] [--v1 ai/models/bootstrap/zap-v1.zapw]
//   Players: random, heuristic (base), tuned, zap (the model with its Zap knobs), the characters of
//   the model with their default knobs, and v1 (the first shipped model with its Zap knobs, for
//   the row zap-v1: a new version against v1 head to head).
//   --facts-key  where --write-facts stores the report (a dotted path; ai.strength by default), so a
//                new version's table does not replace v1's.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { makeConfig } from '../../engine/src/config.ts';
import { RandomAgent, type Agent } from '../src/agent.ts';
import { duplicateSeries, summarize } from '../src/evaluate.ts';
import { BASE_PARAMS, HeuristicAgent, type HeuristicParams } from '../src/heuristic.ts';
import { parseModel } from '../src/mlp.ts';
import { personaAgent, type PersonaId } from '../src/personas.ts';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const modelBytes = readFileSync(arg('model')!);
const model = parseModel(modelBytes);
const v1Path = arg('v1', 'ai/models/bootstrap/zap-v1.zapw')!;
const tunedPath = arg('tuned', 'ai/models/heuristic-tuned.json')!;
let tuned: HeuristicParams | null = null;
try {
  tuned = JSON.parse(readFileSync(tunedPath, 'utf8')).params as HeuristicParams;
} catch {
  tuned = null;
}
const pairs = Number(arg('pairs', '1000'));
const seed = arg('seed', '5d'.repeat(32))!;

const players: Record<string, () => Agent> = {
  random: () => new RandomAgent(),
  heuristic: () => new HeuristicAgent(BASE_PARAMS, 'heuristic'),
  zap: () => personaAgent(model, 'zap'),
};
if (tuned) players.tuned = () => new HeuristicAgent(tuned!, 'tuned');
for (const id of ['otavio', 'bento', 'lia', 'ravi', 'iara'] as PersonaId[]) players[id] = () => personaAgent(model, id);
let v1: ReturnType<typeof parseModel> | null = null;
players.v1 = () => personaAgent((v1 ??= parseModel(readFileSync(v1Path))), 'zap');

const defaultRows = ['zap-random', 'heuristic-random', 'zap-heuristic', ...(tuned ? ['tuned-heuristic', 'zap-tuned'] : [])];
const rows = (arg('rows') ?? defaultRows.join(',')).split(',');

const table: Record<string, unknown> = {};
const t0 = performance.now();
for (const row of rows) {
  const [a, b] = row.split('-');
  if (!players[a] || !players[b]) throw new Error(`unknown player in ${row}`);
  const segs: Record<string, ReturnType<typeof summarize>> = {};
  const pooled: number[] = [];
  for (const variant of ['paulista', 'mineiro'] as const) {
    for (const n of [2, 4] as const) {
      const config = makeConfig(variant, n);
      const r = duplicateSeries(config, seed, pairs, players[a], players[b]);
      segs[`${variant}-${n === 4 ? '2x2' : '1x1'}`] = r;
      for (let i = 0; i < r.both; i++) pooled.push(1);
      for (let i = 0; i < r.split; i++) pooled.push(0.5);
      for (let i = 0; i < r.none; i++) pooled.push(0);
    }
  }
  const all = summarize(pooled);
  table[row] = { overall: all, segments: segs };
  const pct = (x: number) => (100 * x).toFixed(1);
  console.log(
    `${row.padEnd(20)} ${pct(all.mean)}% [${pct(all.ci95[0])}, ${pct(all.ci95[1])}]  ` +
      Object.entries(segs)
        .map(([k, v]) => `${k} ${pct(v.mean)}±${pct(1.96 * v.se)}`)
        .join('  '),
  );
}
const report = {
  measuredAt: new Date().toISOString(),
  pairsPerSegment: pairs,
  model: arg('model'),
  sha256: createHash('sha256').update(modelBytes).digest('hex'),
  seed: seed.slice(0, 2),
  ...(rows.some((r) => r.split('-').includes('v1')) ? { v1: v1Path } : {}),
  seconds: (performance.now() - t0) / 1000,
  table,
};
const out = arg('out');
if (out) writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
if (process.argv.includes('--write-facts')) {
  const p = new URL('../../facts.json', import.meta.url);
  let facts: Record<string, any> = {};
  try {
    facts = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    facts = {};
  }
  // Read, change one key, write at once: other benches and teams write other keys of the file.
  const path = arg('facts-key', 'ai.strength')!.split('.');
  let node: Record<string, any> = facts;
  for (const k of path.slice(0, -1)) node = node[k] = node[k] && typeof node[k] === 'object' ? node[k] : {};
  node[path[path.length - 1]] = report;
  writeFileSync(p, JSON.stringify(facts, null, 2) + '\n');
}
