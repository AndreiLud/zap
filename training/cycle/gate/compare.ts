// Head to head of two model files in duplicate pairs, pooled over the four segments (contract
// 3.7): the candidate against its twin, and the twin against the second twin (seed floor).
//
// Usage: node training/cycle/gate/compare.ts --a A.zapw --b B.zapw --pairs N --seed HEX64 [--threads T] [--stats empty|live] [--out FILE]
// Prints {pairs, mean, lo, hi}: mean score of A, with its 95% interval.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runPairTasks, type AgentSpec, type PairJob } from '../../../ai/bench/parallel.ts';
import { summarize } from '../../../ai/src/evaluate.ts';
import { SEGMENTS } from '../../../ai/src/opponent-stats.ts';

export async function compare(a: string, b: string, pairs: number, seed: string, threads: number, stats: 'empty' | 'live'): Promise<{ pairs: number; mean: number; lo: number; hi: number }> {
  if (!/^[0-9a-f]{64}$/.test(seed)) throw new Error('--seed takes 64 hex characters');
  const spec = (model: string, name: string): AgentSpec => ({ kind: 'net', model, knobs: 'zap', name, opts: { stats } });
  const jobs: PairJob[] = SEGMENTS.map((g) => ({ key: g, segment: g, baseSeed: seed, offset: 0, pairs, a: spec(a, 'a'), b: spec(b, 'b') }));
  const res = await runPairTasks(jobs, threads);
  const s = summarize(SEGMENTS.flatMap((g) => res.get(g)!.scores));
  return { pairs: s.pairs, mean: s.mean, lo: s.ci95[0], hi: s.ci95[1] };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = arg('a');
  const b = arg('b');
  const seed = arg('seed');
  if (!a || !b || !seed) {
    console.error('usage: compare.ts --a A.zapw --b B.zapw --pairs N --seed HEX64 [--threads T] [--stats empty|live] [--out FILE]');
    process.exit(1);
  }
  const stats = arg('stats') === 'live' ? 'live' : 'empty';
  const r = await compare(a, b, Number(arg('pairs') ?? 100), seed, Number(arg('threads') ?? 1), stats);
  const out = arg('out');
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(r, null, 2) + '\n');
  }
  console.log(JSON.stringify(r));
}
