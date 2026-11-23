// Tunes the heuristic's parameters by search: each generation tries random changes around the
// current best and keeps one only if it beats the current best in duplicate matches with a
// margin of two standard errors. A final run on fresh deals measures the tuned version
// against the base one.
//
// Usage: node ai/bench/tune-heuristic.ts [generations] [pairsPerSegment] [--out ai/models/heuristic-tuned.json] [--from previous.json]

import { readFileSync, writeFileSync } from 'node:fs';
import { makeConfig } from '../../engine/src/config.ts';
import { mulberry32 } from '../../engine/src/rng.ts';
import { duplicateSeries, summarize } from '../src/evaluate.ts';
import { BASE_PARAMS, HeuristicAgent, paramsToVector, vectorToParams } from '../src/heuristic.ts';

const generations = Number(process.argv[2] ?? 40);
const pairs = Number(process.argv[3] ?? 300);
const outIdx = process.argv.indexOf('--out');
const outPath = outIdx > 0 ? process.argv[outIdx + 1] : 'ai/models/heuristic-tuned.json';
const SEGMENTS = [
  makeConfig('paulista', 2),
  makeConfig('paulista', 4),
  makeConfig('mineiro', 2),
  makeConfig('mineiro', 4),
];
const SEED = '7e'.repeat(32);
// Step size per parameter, in the order of paramsToVector.
const SIGMA = [0.3, 0.5, 0.4, 0.3, 0.3, 0.3, 0.3, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.06, 0.05, 0.05, 0.6, 0.6, 0.05, 0.05];

function evaluate(a: number[], b: number[], offset: number, n: number) {
  const pa = vectorToParams(a);
  const pb = vectorToParams(b);
  const scores: number[] = [];
  for (const config of SEGMENTS) {
    const r = duplicateSeries(config, SEED, n, () => new HeuristicAgent(pa), () => new HeuristicAgent(pb), offset);
    // Rebuild per-pair scores from the counts to pool the segments.
    for (let i = 0; i < r.both; i++) scores.push(1);
    for (let i = 0; i < r.split; i++) scores.push(0.5);
    for (let i = 0; i < r.none; i++) scores.push(0);
  }
  return summarize(scores);
}

const rand = mulberry32(20261121);
const gauss = () => {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
};

const fromIdx = process.argv.indexOf('--from');
let best = fromIdx > 0 ? paramsToVector(JSON.parse(readFileSync(process.argv[fromIdx + 1], 'utf8')).params) : paramsToVector(BASE_PARAMS);
const searchSeedOffset = fromIdx > 0 ? 10_000_000 : 1_000_000;
if (best.length !== SIGMA.length) throw new Error(`sigma has ${SIGMA.length} entries, params have ${best.length}`);
const history: unknown[] = [];
const t0 = performance.now();
let offset = searchSeedOffset;
for (let g = 0; g < generations; g++) {
  let accepted = false;
  for (let k = 0; k < 6; k++) {
    const cand = best.map((x, i) => x + SIGMA[i] * gauss() * (rand() < 0.4 ? 1 : 0));
    const r = evaluate(cand, best, offset, pairs);
    offset += pairs;
    if (r.mean - 2 * r.se > 0.5) {
      best = cand;
      accepted = true;
      history.push({ generation: g, mean: r.mean, se: r.se });
      console.log(`gen ${g}: accepted, ${(100 * r.mean).toFixed(1)}% over previous best (se ${(100 * r.se).toFixed(1)})`);
      break;
    }
  }
  if (!accepted) console.log(`gen ${g}: no improvement`);
}

// Final measurement on fresh deals, never used during the search.
const finalPairs = pairs * 8;
const final = evaluate(best, paramsToVector(BASE_PARAMS), 50_000_000, finalPairs);
const report = {
  measuredAt: new Date().toISOString(),
  method: `random search, ${generations} generations, ${pairs} duplicate pairs per segment per candidate; final check on ${finalPairs} fresh pairs per segment`,
  params: vectorToParams(best),
  vsBase: { mean: final.mean, se: final.se, ci95: final.ci95, pairs: final.pairs },
  seconds: (performance.now() - t0) / 1000,
  history,
};
writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
console.log(`tuned vs base on fresh deals: ${(100 * final.mean).toFixed(1)}% [${(100 * final.ci95[0]).toFixed(1)}, ${(100 * final.ci95[1]).toFixed(1)}], ${final.pairs} pairs`);
