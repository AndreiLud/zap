// Sweeps for in-match adaptation, in the duplicate format.
//
//   G (styled gain): mean over the 11 training styles X of score(model vs X) minus
//     score(same model with the statistics at no evidence vs X), pair by pair.
//   P (proxy explorer gain): mean over the 6 proxy explorers E of score(E vs model) minus
//     score(E vs the same model without statistics), pair by pair. How much a player that fakes
//     a pattern and then switches gains from the network reading it.
//
// Every opponent plays the same deals (same base seed and offsets), so pair i of every opponent
// shares its deal: pooled intervals treat each deal index as one cluster (ai/src/evaluate.ts
// pooledPairedSummary).
//
// --mode beta     one model per regularizer weight (end of short runs); rule of the design 10.1
// --mode safety   one adaptive model, a grid of safety net settings, in two stages:
//                 stage 1 plays every setting (--pairs per segment per opponent, offset 0);
//                 the shortlist is the finite settings with a stage 1 mean P of at most 0.5
//                 point, the 3 with the best G; stage 2 plays the shortlist and the empty arm
//                 again on new deals (--pairs2 per segment per opponent, offset --pairs). Rule:
//                 among stage 2 settings whose P has a 95% upper bound of at most 0.5 point, the
//                 best G (ties to the tighter setting). None: bmax 0.02, nHalf 4, flagged.
// --quick         one model, safety off, against Bento, Lia and the proxies (training panel)
//
// Writes ai.adaptation.regularizer (beta) or safetyNet (safety) in facts.json with --write-facts.
//
// Usage:
//   node ai/bench/adaptation-sweep.ts --mode beta --models a.zapw,b.zapw [--safety off] [--pairs 250] [--seed a5] [--threads 4] [--out file] [--write-facts]
//   node ai/bench/adaptation-sweep.ts --mode safety --model A.zapw --bmax 0.02,0.05,0.1,0.2,0.5,inf --nhalf 1,2,4 [--pairs 250] [--pairs2 1500] [--seed a5] [--threads 4] [--out file] [--write-facts]
//   node ai/bench/adaptation-sweep.ts --quick --model current.zapw [--pairs 100] [--threads 4]

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pooledPairedSummary, type PooledSummary } from '../src/evaluate.ts';
import type { NetOptions } from '../src/net-agent.ts';
import { PROXIES, TRAINING_STYLES } from './arms.ts';
import { SEGMENTS, arg, evalOut, flag, machine, modelHashes, numArg, provenance, readJson, round, runOf, saveResult, seedArg } from './bench-util.ts';
import { emptyDiag, mergeDiag, runPairTasks, type AgentSpec, type Diag, type PairJob } from './parallel.ts';

const seedHex = arg('seed', 'a5')!;
const seed = seedArg('seed', 'a5');
const threads = numArg('threads', 4);
const t0 = performance.now();
const progress = (d: number, n: number) => {
  if (d % 100 === 0 || d === n) process.stderr.write(`sweep: ${d}/${n} chunks, ${((performance.now() - t0) / 1000).toFixed(0)} s\n`);
};

interface Arm {
  name: string;
  spec: AgentSpec;
}

/** Scores per opponent (segments pooled in a fixed order, so index i is the same deal for every opponent). */
interface ArmScores {
  styles: Record<string, number[]>;
  proxies: Record<string, number[]>;
  diag: Diag;
}

/** Scores of each arm against the styles (arm first) and of the proxies against each arm (proxy first). */
async function playArms(arms: Arm[], styles: Record<string, AgentSpec>, proxies: Record<string, AgentSpec>, pairs: number, offset = 0): Promise<Map<string, ArmScores>> {
  const jobs: PairJob[] = [];
  for (const arm of arms) {
    for (const [x, spec] of Object.entries(styles)) for (const segment of SEGMENTS) jobs.push({ key: `${arm.name}|S|${x}|${segment}`, segment, baseSeed: seed, offset, pairs, a: arm.spec, b: spec });
    for (const [e, spec] of Object.entries(proxies)) for (const segment of SEGMENTS) jobs.push({ key: `${arm.name}|P|${e}|${segment}`, segment, baseSeed: seed, offset, pairs, a: spec, b: arm.spec });
  }
  const res = await runPairTasks(jobs, threads, 25, progress);
  const out = new Map<string, ArmScores>();
  for (const arm of arms) {
    const r: ArmScores = { styles: {}, proxies: {}, diag: emptyDiag() };
    for (const x of Object.keys(styles)) {
      r.styles[x] = SEGMENTS.flatMap((g) => res.get(`${arm.name}|S|${x}|${g}`)!.scores);
      for (const g of SEGMENTS) r.diag = mergeDiag(r.diag, res.get(`${arm.name}|S|${x}|${g}`)!.diag);
    }
    for (const e of Object.keys(proxies)) {
      r.proxies[e] = SEGMENTS.flatMap((g) => res.get(`${arm.name}|P|${e}|${g}`)!.scores);
      for (const g of SEGMENTS) r.diag = mergeDiag(r.diag, res.get(`${arm.name}|P|${e}|${g}`)!.diag);
    }
    out.set(arm.name, r);
  }
  return out;
}

const fmt = (p: PooledSummary) => ({ mean: round(p.mean, 5), se: round(p.se, 5), ci95: p.ci95.map((v) => round(v, 5)), upper95: round(p.upper95, 5), pairs: p.pairs, clusters: p.clusters, naiveSe: round(p.naiveSe, 5) });

/** G and P of one arm against its no-statistics arm, pooled with deal clusters. */
function gp(on: ArmScores, empty: ArmScores) {
  const G = pooledPairedSummary(Object.keys(on.styles).map((x) => ({ a: on.styles[x], b: empty.styles[x] })));
  const P = pooledPairedSummary(Object.keys(on.proxies).map((e) => ({ a: on.proxies[e], b: empty.proxies[e] })));
  return { G, P };
}

/** True when arm a's G is significantly below arm b's G (each against its own no-statistics arm; paired 95% interval of the difference entirely below 0). */
function belowG(a: { on: ArmScores; empty: ArmScores }, b: { on: ArmScores; empty: ArmScores }): boolean {
  const groups = Object.keys(a.on.styles).map((x) => ({
    a: a.on.styles[x].map((v, i) => v - a.empty.styles[x][i]),
    b: b.on.styles[x].map((v, i) => v - b.empty.styles[x][i]),
  }));
  return pooledPairedSummary(groups).ci95[1] < 0;
}

/** Safety net diagnostics per decision of the tracked arm (on the distribution each character plays). */
function diagView(d: Diag) {
  const per = (x: number) => (d.decisions ? round(x / d.decisions, 5) : 0);
  return { decisions: d.decisions, lambdaBelow1Share: per(d.lambdaBelow1), twoPassShare: per(d.twoPass), topChangedShare: per(d.topChanged), meanKlPlayed: d.decisions ? round(d.klApplied / d.decisions, 6) : 0, meanTvPlayed: per(d.tv) };
}

function klBuckets(run: string): Record<string, number> | null {
  const p = join(run, 'metrics.jsonl');
  if (!existsSync(p)) return null;
  const rows = readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.mode === 'ppo').slice(-10);
  if (!rows.length) return null;
  const keys = ['kl_adapt', 'kl_adapt_n0', 'kl_adapt_n1_2', 'kl_adapt_n3p'];
  return Object.fromEntries(keys.map((k) => [k, round(rows.reduce((a, r) => a + (r[k] ?? 0), 0) / rows.length, 6)]));
}

const measuredAt = new Date().toISOString();

if (flag('quick')) {
  const model = arg('model')!;
  const pairs = numArg('pairs', 100);
  const styles = { bento: TRAINING_STYLES.bento, lia: TRAINING_STYLES.lia };
  const arms: Arm[] = [
    { name: 'on', spec: { kind: 'net', model, knobs: 'zap', opts: { safety: 'off' } } },
    { name: 'empty', spec: { kind: 'net', model, knobs: 'zap', opts: { stats: 'empty' } } },
  ];
  const r = await playArms(arms, styles, PROXIES, pairs);
  const on = r.get('on')!;
  const empty = r.get('empty')!;
  const g = gp(on, empty);
  const mean = (a: number[], b: number[]) => round(a.reduce((s, v, i) => s + v - b[i], 0) / a.length, 5);
  const perOpponent = { ...Object.fromEntries(Object.keys(styles).map((k) => [k, mean(on.styles[k], empty.styles[k])])), ...Object.fromEntries(Object.keys(PROXIES).map((k) => [k, mean(on.proxies[k], empty.proxies[k])])) };
  console.log(JSON.stringify({ quick: { G: fmt(g.G), P: fmt(g.P), perOpponent, pairs, seconds: round((performance.now() - t0) / 1000, 1) } }));
} else if (arg('mode') === 'beta') {
  const models = arg('models')!.split(',');
  const pairs = numArg('pairs', 250);
  const safety = arg('safety', 'off') as 'off' | 'model';
  const out = arg('out', join(runOf(models[0]), '..', 'm6-sweep', 'eval', 'sweep-beta.json'))!;
  const arms: Arm[] = [];
  models.forEach((m, i) => {
    arms.push({ name: `on${i}`, spec: { kind: 'net', model: m, knobs: 'zap', opts: { safety } } });
    arms.push({ name: `empty${i}`, spec: { kind: 'net', model: m, knobs: 'zap', opts: { stats: 'empty' } } });
  });
  const r = await playArms(arms, TRAINING_STYLES, PROXIES, pairs);
  const rows = models.map((m, i) => {
    const run = runOf(m);
    const args = existsSync(join(run, 'args.json')) ? readJson<Record<string, unknown>>(join(run, 'args.json')) : {};
    const arm = { on: r.get(`on${i}`)!, empty: r.get(`empty${i}`)! };
    return { model: m, run, beta: Number(args.adapt_beta ?? NaN), arm, ...gp(arm.on, arm.empty), kl: klBuckets(run) };
  });
  const bestG = rows.reduce((b, x) => (x.G.mean > b.G.mean ? x : b), rows[0]);
  const eligible = rows.filter((x) => x.P.upper95 <= 0.01).sort((a, b) => b.beta - a.beta);
  const anyPositive = rows.some((x) => x.G.ci95[0] > 0);
  let chosen: number;
  let why: string;
  if (!anyPositive) {
    chosen = 0.1;
    why = 'No beta gave a styled gain significantly above 0, so the sweep is too short to tell: beta 0.1, a light brake that lets learning happen; exploitation stays guarded by the safety net and measured by the explorer test.';
  } else {
    const bestEligible = eligible.reduce((b, x) => (!b || x.G.mean > b.G.mean ? x : b), null as (typeof rows)[number] | null);
    const pick = bestEligible ? eligible.find((x) => !belowG(x.arm, bestEligible.arm)) : undefined;
    if (pick) {
      chosen = pick.beta;
      why = `Largest beta whose proxy explorer gain has a 95% upper bound of at most 1 point and whose styled gain is not significantly below the best such beta (${bestEligible!.beta}).`;
    } else {
      chosen = 0.1;
      why = 'No beta kept the proxy explorer gain under 1 point (95% upper bound): beta 0.1, with exploitation left to the safety net and the explorer test.';
    }
  }
  const argsFirst = existsSync(join(runOf(models[0]), 'args.json')) ? readJson<Record<string, unknown>>(join(runOf(models[0]), 'args.json')) : {};
  const facts = {
    regularizer: {
      measuredAt,
      method: `Short runs with the adaptive training line and different regularizer weights; each final model with the Zap knobs, safety net ${safety}, against the ${Object.keys(TRAINING_STYLES).length} training styles (G) and the ${Object.keys(PROXIES).length} proxy explorers (P), ${pairs} duplicate pairs per segment per opponent per arm (seed ${seedHex}), paired with the same model with the statistics at no evidence. Pooled intervals count each deal once across opponents (the opponents share the deals).`,
      beta: chosen,
      nW: argsFirst.adapt_nw !== undefined ? Number(argsFirst.adapt_nw) : null,
      rows: rows.map((x) => ({ beta: x.beta, model: x.model, G: fmt(x.G), P: fmt(x.P), kl: x.kl })),
      bestG: bestG.beta,
      why,
      models: modelHashes(Object.fromEntries(models.map((m, i) => [`beta${rows[i].beta}`, m]))),
    },
  };
  saveResult(out, { measuredAt, pairsPerSegment: pairs, seed: seedHex, seconds: (performance.now() - t0) / 1000, ...machine(), provenance: provenance(Object.fromEntries(models.map((m, i) => [`model${i}`, m]))), facts }, flag('write-facts'));
  console.log(JSON.stringify({ out, chosen, why, rows: facts.regularizer.rows }, null, 2));
} else if (arg('mode') === 'safety') {
  const model = arg('model')!;
  const pairs = numArg('pairs', 250);
  const pairs2 = numArg('pairs2', 1500);
  const bmaxes = arg('bmax', '0.02,0.05,0.1,0.2,0.5,inf')!.split(',').map((v) => (v === 'inf' ? Infinity : Number(v)));
  const nhalves = arg('nhalf', '1,2,4')!.split(',').map(Number);
  const out = arg('out', evalOut(model, 'sweep-safety'))!;
  interface Setting {
    name: string;
    bmax: number;
    nHalf: number | null;
    opts: NetOptions;
  }
  const settings: Setting[] = [];
  for (const b of bmaxes) {
    if (b === Infinity) settings.push({ name: 'off', bmax: Infinity, nHalf: null, opts: { safety: 'off' } });
    else for (const h of nhalves) settings.push({ name: `b${b}-h${h}`, bmax: b, nHalf: h, opts: { safety: { bmax: b, nHalf: h } } });
  }
  const finite = settings.filter((s) => Number.isFinite(s.bmax));
  if (!finite.length) throw new Error('the grid needs at least one finite bmax');
  // Tighter first: smaller bmax, then larger nHalf.
  const tighter = (a: Setting, b: Setting) => a.bmax - b.bmax || (b.nHalf ?? 0) - (a.nHalf ?? 0);
  const tightest = [...finite].sort(tighter)[0];
  const emptyArm: Arm = { name: 'empty', spec: { kind: 'net', model, knobs: 'zap', opts: { stats: 'empty' } } };
  const stage = async (list: Setting[], n: number, offset: number) => {
    const arms: Arm[] = list.map((s) => ({ name: s.name, spec: { kind: 'net', model, knobs: 'zap', opts: s.opts, track: true } }));
    const r = await playArms([...arms, emptyArm], TRAINING_STYLES, PROXIES, n, offset);
    const empty = r.get('empty')!;
    return list.map((s) => {
      const x = r.get(s.name)!;
      return { ...s, ...gp(x, empty), diag: diagView(x.diag) };
    });
  };
  const view = (x: Awaited<ReturnType<typeof stage>>[number]) => ({ setting: x.name, bmax: x.bmax === Infinity ? 'off' : x.bmax, nHalf: x.nHalf, G: fmt(x.G), P: fmt(x.P), ...x.diag });

  // Stage 1: every setting.
  const rows1 = await stage(settings, pairs, 0);
  let shortlist = rows1
    .filter((x) => Number.isFinite(x.bmax) && x.P.mean <= 0.005)
    .sort((a, b) => b.G.mean - a.G.mean || tighter(a, b))
    .slice(0, 3)
    .map((x) => settings.find((s) => s.name === x.name)!);
  const shortlistNote = shortlist.length ? 'finite settings with a stage 1 mean P of at most 0.5 point, the 3 with the best G' : 'no finite setting had a stage 1 mean P of at most 0.5 point: the tightest setting only';
  if (!shortlist.length) shortlist = [tightest];
  // Stage 2: the shortlist again, on new deals, with more pairs.
  const rows2 = pairs2 > 0 ? await stage(shortlist, pairs2, pairs) : [];
  const eligible = rows2.filter((x) => x.P.upper95 <= 0.005).sort((a, b) => b.G.mean - a.G.mean || tighter(a, b));
  let chosen: { bmax: number; nHalf: number };
  let flagged = false;
  let why: string;
  if (pairs2 <= 0) {
    chosen = { bmax: tightest.bmax, nHalf: tightest.nHalf! };
    flagged = true;
    why = 'Stage 2 was skipped (--pairs2 0): the tightest grid setting, flagged.';
  } else if (!eligible.length) {
    chosen = { bmax: 0.02, nHalf: 4 };
    flagged = true;
    why = 'No stage 2 setting kept the proxy explorer gain under 0.5 point (95% upper bound): bmax 0.02 with nHalf 4, flagged.';
  } else {
    const pick = eligible[0];
    chosen = { bmax: pick.bmax, nHalf: pick.nHalf! };
    why = `Among the stage 2 settings whose proxy explorer gain has a 95% upper bound of at most 0.5 point, the one with the best styled gain (${pick.name}; ties go to the tighter setting).`;
  }
  const facts = {
    safetyNet: {
      measuredAt,
      method: `The exported adaptive model (int8) with the Zap knobs under each safety net setting, against the ${Object.keys(TRAINING_STYLES).length} training styles (G) and the ${Object.keys(PROXIES).length} proxy explorers (P), paired pair by pair with the same model with the statistics at no evidence (seed ${seedHex}). Stage 1: every setting, ${pairs} duplicate pairs per segment per opponent per setting. Stage 2: the shortlist (${shortlistNote}) on new deals, ${pairs2} pairs per segment per opponent. Pooled intervals count each deal once across opponents (the opponents share the deals). The net bounds the distribution each character plays (knobs and temperature applied before it); lambdaBelow1Share, topChangedShare, meanKlPlayed and meanTvPlayed are per decision of the adaptive seats.`,
      model,
      bmax: chosen.bmax,
      nHalf: chosen.nHalf,
      flagged,
      why,
      rows: rows1.map(view),
      shortlist: shortlist.map((s) => s.name),
      stage2: rows2.map(view),
      models: modelHashes({ adaptive: model }),
    },
  };
  saveResult(out, { measuredAt, pairsPerSegment: pairs, pairsPerSegmentStage2: pairs2, seed: seedHex, seconds: (performance.now() - t0) / 1000, ...machine(), provenance: provenance({ adaptive: model }), facts }, flag('write-facts'));
  console.log(JSON.stringify({ out, chosen, flagged, why, shortlist: facts.safetyNet.shortlist }, null, 2));
} else {
  throw new Error('use --mode beta, --mode safety or --quick');
}
