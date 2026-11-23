// Measurements (a), (b) and (c) of in-match adaptation, in the duplicate format. Every paired
// difference uses the same base seed for both players, so the same deals and policy seeds, and
// is taken pair by pair. "1 point" is 0.01 of the mean match score. Every opponent plays the same
// deals, so pooled intervals count each deal index once across opponents (pooledPairedSummary).
//
//   --part styles    (a) adaptive, twin and ablated (and the second twin, with --twin2) against
//                    each style (the 11 training styles, trapper, and the held-out styles coversAll
//                    and coinFlip; trapper counts as held out for a network trained without the
//                    feints kind, styles.ts heldOutStyles): gains of adaptive over twin and over ablated, ablated over twin
//                    (is the no-evidence policy as good as the twin?), and the seed floor (second
//                    twin minus twin: how far two runs that differ only in their seeds land)
//   --part panel     (b) head to head: adaptive against twin, v1, random, base and tuned
//                    heuristics; twin against v1, random, base and tuned; with --twin2 also
//                    second twin against twin
//   --part ablation  (c) adaptive minus ablated per style (from the styles result), and adaptive
//                    against ablated and ablated against twin head to head; says whether the
//                    adaptive file may be served while adaptation is off (runbook step 10)
//
// The adaptive file must carry its safety net (meta.adapt): the arms play the model as served.
// Writes ai.adaptation.perStyle (styles), headToHead (panel; ablation adds its rows) and ablation
// in facts.json with --write-facts.
//
// Usage: node ai/bench/adaptation-eval.ts --part styles|panel|ablation --adaptive A.zapw --twin T.zapw
//          [--twin2 T2.zapw] [--pairs 1500] [--seed 5e] [--threads 4] [--styles <eval-styles.json>] [--out file] [--write-facts]
// Default output: <adaptive run>/eval/eval-<part>.json

import { dirname, join } from 'node:path';
import { pairedSummary, pooledPairedSummary, summarize, type PooledSummary } from '../src/evaluate.ts';
import { trainingFamilyOf } from '../src/league.ts';
import { heldOutStyles } from '../src/styles.ts';
import { EVAL_STYLES, PANEL, ablatedArm, adaptiveArm, twinArm } from './arms.ts';
import { SEGMENTS, arg, evalOut, flag, machine, modelHashes, modelProvenance, numArg, provenance, readJson, requireSafetyNet, round, saveResult, seedArg, type Segment } from './bench-util.ts';
import { runPairTasks, type AgentSpec, type PairJob } from './parallel.ts';

const part = arg('part');
if (part !== 'styles' && part !== 'panel' && part !== 'ablation') throw new Error('--part styles|panel|ablation');
const A = arg('adaptive');
const T = arg('twin');
const T2 = arg('twin2');
if (!A || !T) throw new Error('--adaptive and --twin are required');
requireSafetyNet(A);
const pairs = numArg('pairs', part === 'styles' ? 1500 : 1000);
const seedHex = arg('seed', '5e')!;
const seed = seedArg('seed', '5e');
const threads = numArg('threads', 4);
const out = arg('out', evalOut(A, `eval-${part}`))!;
const t0 = performance.now();
const progress = (d: number, n: number) => {
  if (d % 50 === 0 || d === n) process.stderr.write(`${part}: ${d}/${n} chunks, ${((performance.now() - t0) / 1000).toFixed(0)} s\n`);
};

const arms: Record<string, AgentSpec> = { adaptive: adaptiveArm(A), twin: twinArm(T), ablated: ablatedArm(A) };
if (T2) arms.twin2 = twinArm(T2, 'twin2');
const models: Record<string, string> = { adaptive: A, twin: T, ...(T2 ? { twin2: T2 } : {}) };

type Series = Record<Segment, number[]>;
const pooled = (s: Series) => SEGMENTS.flatMap((g) => s[g]);
const gain = (a: number[], b: number[]) => {
  const p = pairedSummary(a, b);
  return { mean: round(p.mean, 5), se: round(p.se, 5), ci95: p.ci95.map((v) => round(v, 5)), upper95: round(p.upper95, 5), pairs: p.pairs };
};
const pooledGain = (p: PooledSummary) => ({ mean: round(p.mean, 5), se: round(p.se, 5), ci95: p.ci95.map((v) => round(v, 5)), upper95: round(p.upper95, 5), pairs: p.pairs, clusters: p.clusters, naiveSe: round(p.naiveSe, 5) });
const score = (a: number[]) => {
  const s = summarize(a);
  return { mean: round(s.mean, 5), se: round(s.se, 5), ci95: s.ci95.map((v) => round(v, 5)), pairs: s.pairs };
};

async function play(rows: Record<string, { a: AgentSpec; b: AgentSpec }>): Promise<Record<string, Series>> {
  const jobs: PairJob[] = [];
  for (const [name, r] of Object.entries(rows)) for (const segment of SEGMENTS) jobs.push({ key: `${name}|${segment}`, segment, baseSeed: seed, offset: 0, pairs, a: r.a, b: r.b });
  const res = await runPairTasks(jobs, threads, 25, progress);
  const outRows: Record<string, Series> = {};
  for (const name of Object.keys(rows)) outRows[name] = Object.fromEntries(SEGMENTS.map((g) => [g, res.get(`${name}|${g}`)!.scores])) as Series;
  return outRows;
}

/** Pooled gain of arm a over arm b across the listed styles, with deal clusters. */
function poolStyles(scores: Record<string, Record<string, number[]>>, styles: string[], a: string, b: string) {
  if (!styles.length || !scores[styles[0]][a] || !scores[styles[0]][b]) return null;
  return pooledGain(pooledPairedSummary(styles.map((x) => ({ a: scores[x][a], b: scores[x][b] }))));
}

const measuredAt = new Date().toISOString();
const common = { adaptive: A, twin: T, twin2: T2 ?? null, pairsPerSegment: pairs, seed: seedHex, ...machine() };
/** Held out for this adaptive network: what its run's league never drew (args.json). */
const family = trainingFamilyOf(modelProvenance(A).run.args);
const heldOut: string[] = heldOutStyles(family);
const isHeldOut = (x: string) => heldOut.includes(x);
/**
 * The second twin measures how far two runs of the same recipe land apart by their seeds alone only
 * when both twins trained as long. After the feints fine-tune the twin has more iterations than the
 * second twin (which was not fine-tuned): second twin minus twin then mixes the seed with the extra
 * training, and no seed floor claim is made from it.
 */
const twinIterations = { twin: modelProvenance(T).iteration, twin2: T2 ? modelProvenance(T2).iteration : null };
const twinsAligned = !T2 || twinIterations.twin === twinIterations.twin2;
const twinsNote = twinsAligned ? '' : ` The twin has ${twinIterations.twin} training iterations and the second twin ${twinIterations.twin2}: second twin minus twin mixes the seeds with that extra training, so it is not a seed floor here (seedCheck makes no claim; the seed floor of two twins with the same training is kept in ai.adaptation.history).`;

if (part === 'styles') {
  const rows: Record<string, { a: AgentSpec; b: AgentSpec }> = {};
  for (const [x, spec] of Object.entries(EVAL_STYLES)) for (const [arm, a] of Object.entries(arms)) rows[`${arm}|${x}`] = { a, b: spec };
  const r = await play(rows);
  const styles: Record<string, unknown> = {};
  const scores: Record<string, Record<string, number[]>> = {};
  for (const x of Object.keys(EVAL_STYLES)) {
    const s = Object.fromEntries(Object.keys(arms).map((k) => [k, r[`${k}|${x}`]])) as Record<string, Series>;
    const p = Object.fromEntries(Object.keys(arms).map((k) => [k, pooled(s[k])])) as Record<string, number[]>;
    scores[x] = p;
    styles[x] = {
      adaptive: score(p.adaptive),
      twin: score(p.twin),
      ablated: score(p.ablated),
      ...(T2 ? { twin2: score(p.twin2) } : {}),
      gainVsTwin: gain(p.adaptive, p.twin),
      gainVsAblated: gain(p.adaptive, p.ablated),
      ablatedVsTwin: gain(p.ablated, p.twin),
      ...(T2 ? { seedFloor: gain(p.twin2, p.twin) } : {}),
      heldOut: isHeldOut(x),
      segments: Object.fromEntries(
        SEGMENTS.map((g) => [g, { adaptive: score(s.adaptive[g]).mean, twin: score(s.twin[g]).mean, ablated: score(s.ablated[g]).mean, gainVsTwin: gain(s.adaptive[g], s.twin[g]), gainVsAblated: gain(s.adaptive[g], s.ablated[g]) }]),
      ),
    };
  }
  const all = Object.keys(EVAL_STYLES);
  const pool = (list: string[]) => ({
    gainVsTwin: poolStyles(scores, list, 'adaptive', 'twin'),
    gainVsAblated: poolStyles(scores, list, 'adaptive', 'ablated'),
    ablatedVsTwin: poolStyles(scores, list, 'ablated', 'twin'),
    ...(T2 ? { seedFloor: poolStyles(scores, list, 'twin2', 'twin') } : {}),
  });
  const pooledAll = pool(all);
  // With one training run per arm, adaptive minus twin mixes what the statistics add with how far
  // two runs land apart by their seeds alone; the second twin measures the latter once.
  const seedCheck = T2 && !twinsAligned
    ? { method: 'Not checked: the two twins trained for different numbers of iterations.', twinIterations, exceedsSeedFloor: null, note: twinsNote.trim() }
    : T2
    ? {
        method: 'The pooled gain over the twin counts as beyond the seed floor when its 95% interval lies entirely above the size of the second twin minus twin difference (one draw of the run to run variation).',
        exceedsSeedFloor: pooledAll.gainVsTwin!.ci95[0] > Math.abs(pooledAll.seedFloor!.mean),
        note: 'one draw of the run to run spread; the comparison free of it is gainVsAblated',
      }
    : null;
  const facts = {
    perStyle: {
      measuredAt,
      method: `Duplicate format, ${pairs} pairs per segment per opponent per player (seed ${seedHex}), four segments with default rules. Players with the Zap knobs: adaptive (statistics live, safety net from the model file), twin (trained without statistics), ablated (adaptive with the statistics forced to no evidence: what the room plays while adaptation is off or with a person who opted out at the table)${T2 ? ' and a second twin trained with other seeds' : ''}, each as a team against a team of the style on v1. Gains are paired pair by pair on the same deals; pooled intervals count each deal once across opponents. ${heldOut.join(' and ')} never sat in a training match of the adaptive network${family.feints ? '; trapper sat in its training only as a phase of the feints kind (it was held out before the feints fine-tune)' : ''}.${twinsNote}`,
      heldOut,
      twinIterations,
      ...common,
      styles,
      pooled: { allStyles: pooledAll, trainingStyles: pool(all.filter((x) => !isHeldOut(x))), heldOutStyles: pool(all.filter(isHeldOut)) },
      seedCheck,
      models: modelHashes(models),
    },
  };
  saveResult(out, { ...common, measuredAt, seconds: (performance.now() - t0) / 1000, provenance: provenance(models), facts, scores }, flag('write-facts'));
  console.log(JSON.stringify({ out, pooled: facts.perStyle.pooled, seedCheck }, null, 2));
} else if (part === 'panel') {
  const rows: Record<string, { a: AgentSpec; b: AgentSpec }> = { 'adaptive-twin': { a: arms.adaptive, b: arms.twin } };
  if (T2) rows['twin2-twin'] = { a: arms.twin2, b: arms.twin };
  for (const [name, spec] of Object.entries(PANEL)) {
    rows[`adaptive-${name}`] = { a: arms.adaptive, b: spec };
    rows[`twin-${name}`] = { a: arms.twin, b: spec };
  }
  const r = await play(rows);
  const outRows: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(r)) {
    outRows[name] = { ...score(pooled(s)), segments: Object.fromEntries(SEGMENTS.map((g) => [g, score(s[g])])), pairsPerSegment: pairs, seed: seedHex, method: `duplicate format, ${pairs} pairs per segment, seed ${seedHex}; mean match score of the first player` };
  }
  const facts = {
    headToHead: {
      measuredAt,
      method: `Duplicate format, default rules, four segments pooled. Mean match score of the first player of each row (0.5 is even). adaptive, ablated and twin use the Zap knobs; twin2 is a second twin trained with other seeds; v1 is v1 Zap with its shipped knobs; heuristic is the base heuristic; tuned is the tuned heuristic.${twinsNote}`,
      adaptive: A,
      twin: T,
      rows: outRows,
      models: modelHashes(models),
    },
  };
  saveResult(out, { ...common, measuredAt, seconds: (performance.now() - t0) / 1000, provenance: provenance(models), facts }, flag('write-facts'));
  console.log(JSON.stringify({ out, rows: Object.fromEntries(Object.entries(outRows).map(([k, v]) => [k, (v as { mean: number }).mean])) }, null, 2));
} else {
  const stylesPath = arg('styles', join(dirname(out), 'eval-styles.json'))!;
  const st = readJson<{ scores: Record<string, Record<string, number[]>>; pairsPerSegment: number; seed: string; facts: { perStyle: { models: Record<string, { sha256: string }> } } }>(stylesPath);
  const shaA = modelHashes({ adaptive: A }).adaptive.sha256;
  if (st.facts?.perStyle?.models?.adaptive && st.facts.perStyle.models.adaptive.sha256 !== shaA) {
    throw new Error(`${stylesPath} measured another adaptive file (sha256 ${st.facts.perStyle.models.adaptive.sha256}); run the styles part again first`);
  }
  const perStyle: Record<string, unknown> = {};
  for (const [x, s] of Object.entries(st.scores)) perStyle[x] = gain(s.adaptive, s.ablated);
  const names = Object.keys(st.scores);
  const pooledAblation = poolStyles(st.scores, names, 'adaptive', 'ablated')!;
  const pooledAblatedTwin = poolStyles(st.scores, names, 'ablated', 'twin')!;
  const r = await play({ 'adaptive-ablated': { a: arms.adaptive, b: arms.ablated }, 'ablated-twin': { a: arms.ablated, b: arms.twin } });
  const h2h = (name: string, what: string) => {
    const s = r[name];
    return { ...score(pooled(s)), segments: Object.fromEntries(SEGMENTS.map((g) => [g, score(s[g])])), pairsPerSegment: pairs, seed: seedHex, method: `duplicate format, ${pairs} pairs per segment, seed ${seedHex}; ${what}` };
  };
  const rowAA = h2h('adaptive-ablated', 'mean match score of the adaptive network against itself with the statistics forced to no evidence');
  const rowAT = h2h('ablated-twin', 'mean match score of the adaptive network with the statistics forced to no evidence against the twin');
  // Runbook step 10: while AI_ADAPT is off, the room plays the ablated policy. It may serve the
  // adaptive file only if that policy is not worse than the twin by more than 1 point.
  const servesAdaptiveWhileOff = pooledAblatedTwin.ci95[0] > -0.01 && rowAT.ci95[0] > 0.5 - 0.01;
  const facts = {
    ablation: {
      measuredAt,
      method: `Gain of the adaptive network with statistics live over the same network with the statistics forced to no evidence, paired pair by pair on the deals of measurement (a) (${st.pairsPerSegment} pairs per segment per style, seed ${st.seed}), pooled over all styles with each deal counted once across styles; plus the head to head of the adaptive network against the ablated one, and of the ablated one against the twin.`,
      adaptive: A,
      pooledGain: pooledAblation,
      perStyle,
      headToHead: rowAA,
      offPolicy: {
        method: 'The ablated network is what the room plays while AI_ADAPT is off, and at a table with a person who opted out. Rule of runbook step 10: the adaptive file may be served while adaptation is off only if the ablated network is not worse than the twin, that is the 95% lower bound of the pooled per style gain of ablated over twin above -1 point and the 95% lower bound of its head to head score above 0.49. Otherwise the twin is served while adaptation is off.',
        pooledAblatedMinusTwin: pooledAblatedTwin,
        headToHead: rowAT,
        servesAdaptiveWhileOff,
      },
      models: modelHashes(models),
    },
    headToHead: { measuredAt, method: 'Duplicate format, default rules, four segments pooled. Mean match score of the first player of each row (0.5 is even).', adaptive: A, twin: T, rows: { 'adaptive-ablated': rowAA, 'ablated-twin': rowAT }, models: modelHashes(models) },
  };
  saveResult(out, { ...common, measuredAt, seconds: (performance.now() - t0) / 1000, provenance: provenance(models), facts }, flag('write-facts'));
  console.log(JSON.stringify({ out, pooledGain: pooledAblation, headToHead: rowAA.mean, ablatedTwin: { pooled: pooledAblatedTwin, headToHead: rowAT.mean }, servesAdaptiveWhileOff }, null, 2));
}
