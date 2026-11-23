// Self-play throughput: the same job (training/src/selfplay.ts, milestone 6 league) with the v1
// model and with a v2 model of the same shape, alternating, twice each. The v2 worker must reach
// at least 0.85 of the recorded decisions per second of the v1 worker.
//
// Writes ai.adaptation.selfplayThroughput in facts.json with --write-facts.
//
// Usage: node ai/bench/selfplay-throughput.ts --v1 ai/models/bootstrap/zap-v1.zapw --v2 training/runs/m6-init/warm-v2.zapw
//          [--decisions 30000] [--seed 6a] [--out file] [--write-facts]

import { mkdirSync, rmSync } from 'node:fs';
import { runJob, type Job } from '../../training/src/selfplay.ts';
import { M6_MIX } from '../src/league.ts';
import { TUNED_PARAMS, V1_MANIFEST, V1_MODEL, arg, evalOut, flag, loadModel, machine, numArg, readJson, round, saveResult, seedArg } from './bench-util.ts';

const v1 = arg('v1', V1_MODEL)!;
const v2 = arg('v2');
if (!v2) throw new Error('--v2 is required');
const decisions = numArg('decisions', 30000);
const seedHex = arg('seed', '6a')!;
const seed = seedArg('seed', '6a');
const out = arg('out', evalOut(v2, 'selfplay-throughput'))!;
mkdirSync('.cache/tmp', { recursive: true });

function job(model: string, tag: string): Job {
  return {
    model,
    out: `.cache/tmp/throughput-${tag}.bin`,
    decisions,
    seed,
    league: [],
    mix: M6_MIX,
    twoStyles: 0.5,
    partnerSwap: 0.2,
    fourPlayers: 0.5,
    mineiro: 0.5,
    randomOptions: 0.25,
    heuristicParams: readJson(TUNED_PARAMS).params,
    v1Model: V1_MODEL,
    v1Manifest: V1_MANIFEST,
    switchHands: [1, 6],
    // As in training (train.py --no-stats-share default).
    noStatsShare: 0.15,
  };
}

const runs: { model: 'v1' | 'v2'; decisionsPerSecond: number; seconds: number }[] = [];
for (let i = 0; i < 2; i++) {
  for (const [name, path] of [['v1', v1], ['v2', v2]] as const) {
    const t0 = performance.now();
    const r = runJob(job(path, name));
    const sec = (performance.now() - t0) / 1000;
    runs.push({ model: name, decisionsPerSecond: r.decisions / sec, seconds: sec });
    process.stderr.write(`${name}: ${Math.round(r.decisions / sec)} decisions per second\n`);
    rmSync(`.cache/tmp/throughput-${name}.bin`, { force: true });
    rmSync(`.cache/tmp/throughput-${name}.bin.json`, { force: true });
  }
}
const mean = (m: 'v1' | 'v2') => runs.filter((r) => r.model === m).reduce((a, r) => a + r.decisionsPerSecond, 0) / 2;
const ratio = mean('v2') / mean('v1');
const measuredAt = new Date().toISOString();
const facts = {
  selfplayThroughput: {
    measuredAt,
    method: `One self-play worker (training/src/selfplay.ts) on one core, the same job (milestone 6 league, 15% of the matches without statistics for the learning seats, ${decisions} recorded decisions, seed ${seedHex}) with a v1 model and with a v2 model of the same shape (training writes f32 files, so both should be f32), alternating, twice each; recorded decisions per second.`,
    v1: { model: v1, weights: loadModel(v1).header.tensors[0].dtype, decisionsPerSecond: Math.round(mean('v1')) },
    v2: { model: v2, weights: loadModel(v2).header.tensors[0].dtype, decisionsPerSecond: Math.round(mean('v2')) },
    ratio: round(ratio, 4),
    requirement: 0.85,
    pass: ratio >= 0.85,
    runs: runs.map((r) => ({ ...r, decisionsPerSecond: Math.round(r.decisionsPerSecond), seconds: round(r.seconds, 2) })),
    ...machine(),
  },
};
saveResult(out, { measuredAt, facts }, flag('write-facts'));
console.log(JSON.stringify(facts.selfplayThroughput, null, 2));
