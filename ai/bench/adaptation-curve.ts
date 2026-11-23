// The reading curve: how much the adaptive network changes its play as the match goes on and
// evidence about the opponent builds up. Per decision of the adaptive seats (NetAgent.lastAdapt),
// grouped by hand number (1 to 9, then 10 or later) and by decision type (bet decisions apart):
// mean KL applied (size of the adjustment, nats), share of decisions whose most likely action
// changed, mean total variation (probability moved), mean evidence n, count. All of them compare
// the distribution actually played (Zap knobs and temperature) with the one Zap plays without
// statistics. The adaptive file must carry its safety net (meta.adapt).
//
// Writes ai.adaptation.readingCurve in facts.json with --write-facts.
//
// Usage: node ai/bench/adaptation-curve.ts --model A.zapw [--matches 300] [--seed c9] [--threads 4] [--out file] [--write-facts]
// matches: per segment per opponent; the adaptive team sits on even seats in even matches.

import { adaptiveArm } from './arms.ts';
import { SEGMENTS, arg, evalOut, flag, machine, modelHashes, numArg, provenance, requireSafetyNet, round, saveResult, seedArg } from './bench-util.ts';
import { chunks, runTasks, type AgentSpec, type CurveCell, type CurveTask } from './parallel.ts';

const model = arg('model');
if (!model) throw new Error('--model is required');
requireSafetyNet(model);
const matches = numArg('matches', 300);
const seedHex = arg('seed', 'c9')!;
const seed = seedArg('seed', 'c9');
const threads = numArg('threads', 4);
const out = arg('out', evalOut(model, 'curve'))!;
const t0 = performance.now();

const opponents: Record<string, AgentSpec> = {
  otavio: { kind: 'character', id: 'otavio' },
  bento: { kind: 'character', id: 'bento' },
  lia: { kind: 'character', id: 'lia' },
  ravi: { kind: 'character', id: 'ravi' },
  raisesAll: { kind: 'style', id: 'raisesAll' },
  neverRuns: { kind: 'style', id: 'neverRuns' },
  bluffer: { kind: 'style', id: 'bluffer' },
  v1: { kind: 'character', id: 'zap' },
};

const tasks: CurveTask[] = [];
for (const [name, spec] of Object.entries(opponents)) {
  for (const segment of SEGMENTS) for (const c of chunks(0, matches, 25)) tasks.push({ type: 'curve', key: name, segment, baseSeed: seed, offset: c.offset, matches: c.count, model: adaptiveArm(model), opponent: spec });
}
const res = await runTasks(tasks, threads, (d, n) => {
  if (d % 50 === 0 || d === n) process.stderr.write(`curve: ${d}/${n} chunks\n`);
});

const HANDS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10+'];
const sum = (a: CurveCell, b: CurveCell): CurveCell => ({ decisions: a.decisions + b.decisions, klApplied: a.klApplied + b.klApplied, tv: a.tv + b.tv, changed: a.changed + b.changed, n: a.n + b.n, lambdaBelow1: a.lambdaBelow1 + b.lambdaBelow1 });
const zero = (): CurveCell => ({ decisions: 0, klApplied: 0, tv: 0, changed: 0, n: 0, lambdaBelow1: 0 });
const acc: Record<string, Record<string, CurveCell>> = {};
tasks.forEach((t, i) => {
  const a = (acc[t.key] ??= {});
  for (const [k, c] of Object.entries(res[i])) a[k] = sum(a[k] ?? zero(), c);
});
const view = (c: CurveCell) => ({
  decisions: c.decisions,
  meanKl: c.decisions ? round(c.klApplied / c.decisions, 6) : null,
  meanTv: c.decisions ? round(c.tv / c.decisions, 5) : null,
  changedShare: c.decisions ? round(c.changed / c.decisions, 5) : null,
  meanN: c.decisions ? round(c.n / c.decisions, 3) : null,
  cutShare: c.decisions ? round(c.lambdaBelow1 / c.decisions, 5) : null,
});
const styles: Record<string, unknown> = {};
for (const [name, cells] of Object.entries(acc)) {
  const bet: Record<string, unknown> = {};
  const other: Record<string, unknown> = {};
  const all: Record<string, unknown> = {};
  for (const h of HANDS) {
    const b = cells[`${h}:bet`] ?? zero();
    const o = cells[`${h}:other`] ?? zero();
    bet[h] = view(b);
    other[h] = view(o);
    all[h] = view(sum(b, o));
  }
  styles[name] = { all, bet, other };
}
const measuredAt = new Date().toISOString();
const facts = {
  readingCurve: {
    measuredAt,
    method: `The adaptive network with the Zap knobs and the safety net of the model file played ${matches} matches per segment against each opponent (seed ${seedHex}), default rules. For every decision of the adaptive seats: KL of the distribution played (Zap knobs and temperature) from the one Zap plays with the statistics at no evidence (meanKl, nats), total variation between them (meanTv), whether the most likely action changed (changedShare), the evidence n behind the decision (meanN), and whether the safety net cut the move (cutShare). By hand number of the match; bet decisions (truco, answers, mão de onze) apart.`,
    model,
    matchesPerSegment: matches,
    seed: seedHex,
    styles,
    models: modelHashes({ adaptive: model }),
  },
};
saveResult(out, { measuredAt, seconds: (performance.now() - t0) / 1000, ...machine(), provenance: provenance({ adaptive: model }), facts }, flag('write-facts'));
console.log(JSON.stringify({ out, seconds: (performance.now() - t0) / 1000, sample: (styles as Record<string, { bet: unknown }>).bento?.bet }, null, 2));
