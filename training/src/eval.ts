// Duplicate evaluation of a model file against the baselines, per variant and table size.
// Usage: node training/src/eval.ts --model <file.zapw> [--pairs 400] [--seed hex] [--against heuristic|random|v1|<file.zapw>] [--params tuned.json]
//        node training/src/eval.ts --model <file.zapw> --panel [--pairs 100] [--params tuned.json] [--threads 4]
//        node training/src/eval.ts --model <file.zapw> --served <adaptive.zapw> [--pairs 100] [--threads 3]
// --panel plays the training panel (base heuristic, tuned heuristic, v1 Zap with its shipped knobs)
// on worker threads and prints one line with the three pooled means.
// --served plays the adaptive file as the room serves it (Zap knobs, statistics live, its safety
// net) and the same file with the statistics at no evidence, on the same deals, and prints both
// pooled means and the paired difference (what the reading gives the model under test): the
// periodic check of the trained explorer (train.py --eval-served).
// The model under test plays with neutral knobs; a v2 model reads the match statistics.

import { readFileSync } from 'node:fs';
import { makeConfig } from '../../engine/src/config.ts';
import { RandomAgent, type Agent } from '../../ai/src/agent.ts';
import { duplicateSeries } from '../../ai/src/evaluate.ts';
import { HeuristicAgent, vectorToParams, type HeuristicParams } from '../../ai/src/heuristic.ts';
import { parseModel } from '../../ai/src/mlp.ts';
import { NEUTRAL_KNOBS, NetAgent } from '../../ai/src/net-agent.ts';
import { personaAgent, type CalibratedKnobs } from '../../ai/src/personas.ts';
import { pairedSummary } from '../../ai/src/evaluate.ts';
import { ablatedArm, adaptiveArm } from '../../ai/bench/arms.ts';
import { SEGMENTS, V1_MANIFEST, V1_MODEL, requireSafetyNet } from '../../ai/bench/bench-util.ts';
import { runPairTasks, type AgentSpec, type PairJob } from '../../ai/bench/parallel.ts';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const modelPath = arg('model')!;
const model = parseModel(readFileSync(modelPath));
const pairs = Number(arg('pairs', '400'));
const seed = arg('seed', '3e'.repeat(32))!;
const against = arg('against', 'heuristic')!;
const params = arg('params');

function tuned(): HeuristicParams | undefined {
  if (!params) return undefined;
  const raw = JSON.parse(readFileSync(params, 'utf8'));
  return Array.isArray(raw) ? vectorToParams(raw) : (raw.params ?? raw);
}

function opponent(): () => Agent {
  if (against === 'random') return () => new RandomAgent();
  if (against === 'heuristic') {
    const p = tuned();
    return () => new HeuristicAgent(p);
  }
  if (against === 'v1') {
    const v1 = parseModel(readFileSync(V1_MODEL));
    const knobs = (JSON.parse(readFileSync(V1_MANIFEST, 'utf8')).personas ?? {}) as CalibratedKnobs;
    return () => personaAgent(v1, 'zap', knobs);
  }
  const other = parseModel(readFileSync(against));
  return () => new NetAgent(other);
}

const t0 = performance.now();
const served = arg('served');
if (served) {
  requireSafetyNet(served);
  const me: AgentSpec = { kind: 'net', model: modelPath, knobs: NEUTRAL_KNOBS, name: 'net' };
  const arms: Record<string, AgentSpec> = { on: adaptiveArm(served), ablated: ablatedArm(served) };
  const jobs: PairJob[] = [];
  for (const [name, spec] of Object.entries(arms)) for (const segment of SEGMENTS) jobs.push({ key: `${name}|${segment}`, segment, baseSeed: seed, offset: 0, pairs, a: me, b: spec });
  const res = await runPairTasks(jobs, Number(arg('threads', '3')), 25);
  const pooled = (name: string) => SEGMENTS.flatMap((g) => res.get(`${name}|${g}`)!.scores);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const reading = pairedSummary(pooled('on'), pooled('ablated'));
  console.log(JSON.stringify({ served: { on: mean(pooled('on')), ablated: mean(pooled('ablated')), reading: { mean: reading.mean, se: reading.se } }, pairs, seconds: (performance.now() - t0) / 1000 }));
} else if (process.argv.includes('--panel')) {
  const me: AgentSpec = { kind: 'net', model: modelPath, knobs: NEUTRAL_KNOBS, name: 'net' };
  const panel: Record<string, AgentSpec> = { base: { kind: 'heuristic', params: 'base' }, tuned: { kind: 'heuristic', params: 'tuned' }, v1: { kind: 'character', id: 'zap' } };
  const jobs: PairJob[] = [];
  for (const [name, spec] of Object.entries(panel)) for (const segment of SEGMENTS) jobs.push({ key: `${name}|${segment}`, segment, baseSeed: seed, offset: 0, pairs, a: me, b: spec });
  const res = await runPairTasks(jobs, Number(arg('threads', '4')), 25);
  const out: Record<string, { mean: number; segments: Record<string, number> }> = {};
  for (const name of Object.keys(panel)) {
    const segments: Record<string, number> = {};
    let sum = 0;
    for (const segment of SEGMENTS) {
      const sc = res.get(`${name}|${segment}`)!.scores;
      segments[segment] = sc.reduce((a, b) => a + b, 0) / sc.length;
      sum += segments[segment];
    }
    out[name] = { mean: sum / SEGMENTS.length, segments };
  }
  console.log(JSON.stringify({ panel: out, pairs, seconds: (performance.now() - t0) / 1000 }));
} else {
  const results: Record<string, unknown> = {};
  const opp = opponent();
  let sum = 0;
  for (const variant of ['paulista', 'mineiro'] as const) {
    for (const players of [2, 4] as const) {
      const config = makeConfig(variant, players);
      const r = duplicateSeries(config, seed, pairs, () => new NetAgent(model, NEUTRAL_KNOBS), opp);
      results[`${variant}-${players === 4 ? '2x2' : '1x1'}`] = r;
      sum += r.mean;
    }
  }
  console.log(JSON.stringify({ against, pairs, mean: sum / 4, seconds: (performance.now() - t0) / 1000, results }));
}
