// Quick sanity check of the baselines in the duplicate format.
// Usage: node ai/bench/quick-baselines.ts [pairs]
import { makeConfig } from '../../engine/src/config.ts';
import { RandomAgent } from '../src/agent.ts';
import { duplicateSeries } from '../src/evaluate.ts';
import { HeuristicAgent } from '../src/heuristic.ts';

const pairs = Number(process.argv[2] ?? 500);
const BASE = '1b'.repeat(32);
const heuristic = () => new HeuristicAgent();
const random = () => new RandomAgent();
for (const variant of ['paulista', 'mineiro'] as const) {
  for (const players of [2, 4] as const) {
    const config = makeConfig(variant, players);
    const t0 = performance.now();
    const hr = duplicateSeries(config, BASE, pairs, heuristic, random);
    const hh = duplicateSeries(config, BASE, pairs, heuristic, heuristic);
    const sec = (performance.now() - t0) / 1000;
    const f = (r: { mean: number; ci95: [number, number] }) => `${(100 * r.mean).toFixed(1)}% [${(100 * r.ci95[0]).toFixed(1)}, ${(100 * r.ci95[1]).toFixed(1)}]`;
    console.log(`${variant} ${players === 4 ? '2x2' : '1x1'}: heuristic vs random ${f(hr)} | heuristic vs itself ${f(hh)} | ${sec.toFixed(1)} s`);
  }
}
