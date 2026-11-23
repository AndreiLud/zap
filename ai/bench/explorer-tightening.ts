// Net tightening check of the explorer test: how much did a tighter safety net take off what one
// explorer gets out of the reading? Two attempts of ai/bench/explorer.ts measure an explorer against
// two exports on different deals, so their difference mixes the change of net with deal noise.
// Here the explorer of one stored fresh result (--fresh, an explorer-fresh-<N>.json) plays again on
// exactly its deals (its seed, offset and pairs per segment) against two exports of the same
// network with different safety nets: the file that result measured (--adaptive) and --other. Four
// players: each file as served (statistics live, its own safety net, Zap knobs) and each file with
// the statistics at no evidence (ablated).
//   adaptation part of a file = score vs that file minus score vs its ablated network, pair by pair
//   diff = adaptation part (--adaptive) minus adaptation part (--other), pair by pair
// The two ablated networks play the same weights, and a safety net cannot move play without
// evidence, so they should score alike on every pair: ablatedSame says whether they did, and when
// it is true the base part (ablated vs twin) is the same for both nets and the diff is all in the
// adaptation part. The replay against --adaptive must give the stored adaptation part again
// (reproduces). Only the result's chosen explorer is played.
//
// Writes <eval>/explorer-tightening-<attempt>.json with facts for "explorer.netTightening", and
// with --write-facts writes that key of facts.json.
//
// Usage:
//   node ai/bench/explorer-tightening.ts --adaptive A --other B --fresh <explorer-fresh-N.json> [--threads 3] [--write-facts]

import { pairedSummary } from '../src/evaluate.ts';
import { explorerLabel, soloSpec, type ExplorerSpec } from '../src/styles.ts';
import { ablatedArm, adaptiveArm } from './arms.ts';
import { SEGMENTS, arg, evalOut, flag, loadModel, machine, modelHashes, numArg, provenance, readJson, requireSafetyNet, round, saveResult, segmentConfig, sha256File } from './bench-util.ts';
import { runPairTasks, type AgentSpec, type PairJob } from './parallel.ts';

const A = arg('adaptive');
const B = arg('other');
const FRESH = arg('fresh');
if (!A || !B || !FRESH) throw new Error('--adaptive, --other and --fresh are required');
requireSafetyNet(A);
requireSafetyNet(B);
const threads = numArg('threads', 3);
const t0 = performance.now();
const measuredAt = new Date().toISOString();
const fmt = (p: ReturnType<typeof pairedSummary>) => ({ mean: round(p.mean, 5), se: round(p.se, 5), ci95: p.ci95.map((v) => round(v, 5)), upper95: round(p.upper95, 5), pairs: p.pairs });
const adaptOf = (path: string) => (loadModel(path).header.meta?.adapt ?? null) as { bmax: number; nHalf: number } | null;
const pts = (x: number) => (100 * x).toFixed(2);

interface Fresh {
  attempt: { attempt: number; explorer: string };
  seed: string;
  offset: number;
  pairsPerSegment: number;
  facts: { explorer: { chosen: ExplorerSpec; split: { adaptationPart: ReturnType<typeof fmt> }; models: { adaptive: { path: string; sha256: string } } } };
}
const fresh = readJson<Fresh>(FRESH);
const e = fresh.facts.explorer.chosen;
const label = explorerLabel(e);
const shaA = sha256File(A);
const shaB = sha256File(B);
if (fresh.facts.explorer.models.adaptive.sha256 !== shaA) throw new Error(`${FRESH} measured ${fresh.facts.explorer.models.adaptive.path} (SHA-256 ${fresh.facts.explorer.models.adaptive.sha256.slice(0, 8)}), not ${A} (${shaA.slice(0, 8)})`);
if (shaA === shaB) throw new Error('--adaptive and --other are the same file');
if (loadModel(A).header.features !== loadModel(B).header.features) throw new Error('--adaptive and --other have different features');
// The result's own deals: its seed (two hex characters repeated, as seedArg makes it), offset and pairs.
const seed = /^[0-9a-f]{64}$/.test(fresh.seed) ? fresh.seed : fresh.seed.repeat(32);
const { offset, pairsPerSegment: pairs } = fresh;

const arms = { adaptiveA: adaptiveArm(A), ablatedA: ablatedArm(A), adaptiveB: adaptiveArm(B), ablatedB: ablatedArm(B) } satisfies Record<string, AgentSpec>;
type Arm = keyof typeof arms;
const jobs: PairJob[] = [];
for (const [arm, spec] of Object.entries(arms))
  for (const segment of SEGMENTS) {
    // In 1 against 1 there is no partner: the fresh stage plays the 'same' option there.
    const me = segmentConfig(segment).players === 2 ? soloSpec(e) : e;
    jobs.push({ key: `${arm}|${segment}`, segment, baseSeed: seed, offset, pairs, a: { kind: 'explorer', spec: me }, b: spec });
  }
const res = await runPairTasks(jobs, threads, Math.max(8, Math.min(32, pairs)), (d, n) => {
  if (d % 100 === 0 || d === n) process.stderr.write(`explorer-tightening: ${d}/${n} chunks, ${((performance.now() - t0) / 1000).toFixed(0)} s\n`);
});
const pooled = (arm: Arm) => SEGMENTS.flatMap((g) => res.get(`${arm}|${g}`)!.scores);
const s = { adaptiveA: pooled('adaptiveA'), ablatedA: pooled('ablatedA'), adaptiveB: pooled('adaptiveB'), ablatedB: pooled('ablatedB') };
const partA = s.adaptiveA.map((x, i) => x - s.ablatedA[i]);
const partB = s.adaptiveB.map((x, i) => x - s.ablatedB[i]);
const adaptationA = fmt(pairedSummary(s.adaptiveA, s.ablatedA));
const adaptationB = fmt(pairedSummary(s.adaptiveB, s.ablatedB));
const diff = fmt(pairedSummary(partA, partB));
const ablatedDiff = fmt(pairedSummary(s.ablatedA, s.ablatedB));
const ablatedSame = s.ablatedA.every((x, i) => x === s.ablatedB[i]);
const stored = fresh.facts.explorer.split.adaptationPart;
const reproduces = adaptationA.mean === stored.mean && adaptationA.ci95.every((v, i) => v === stored.ci95[i]);
const mean = (xs: number[]) => round(xs.reduce((a, b) => a + b, 0) / xs.length, 5);
const adaptA = adaptOf(A);
const adaptB = adaptOf(B);
const net = (a: { bmax: number; nHalf: number } | null) => (a ? `Bmax ${a.bmax}, nHalf ${a.nHalf}` : 'none');

const facts = {
  'explorer.netTightening': {
    measuredAt,
    method: `The explorer of ${FRESH} (attempt ${fresh.attempt.attempt}, ${label}) played again on exactly its deals (seed ${fresh.seed}, pairs ${offset} to ${offset + pairs - 1} per segment, ${pairs * SEGMENTS.length} pairs pooled, duplicate format) against four players: ${A} (safety net ${net(adaptA)}) as served and with the statistics at no evidence, and ${B} (safety net ${net(adaptB)}) as served and with the statistics at no evidence, all with the Zap knobs. Adaptation part of a file: score against it minus score against its ablated network, pair by pair. diff: the adaptation part against ${A} minus the one against ${B}, pair by pair (95% interval, standard error over the pooled pairs). ablatedSame: the two ablated networks scored the same on every pair (same weights; a safety net cannot move play without evidence), so the base part is the same for both nets. reproduces: the replay against ${A} gives the adaptation part stored in ${FRESH} again. ${threads} threads.`,
    explorer: label,
    spec: e,
    fresh: { file: FRESH, attempt: fresh.attempt.attempt, seed: fresh.seed, offset, pairsPerSegment: pairs },
    adaptive: { path: A, sha256: shaA, adapt: adaptA, adaptationPart: adaptationA, stored, reproduces, scoreVsAdaptive: mean(s.adaptiveA), scoreVsAblated: mean(s.ablatedA) },
    other: { path: B, sha256: shaB, adapt: adaptB, adaptationPart: adaptationB, scoreVsAdaptive: mean(s.adaptiveB), scoreVsAblated: mean(s.ablatedB) },
    diff,
    ablatedSame,
    ablatedDiff,
    summary: `On the same deals the adaptation part of ${label} is ${pts(adaptationA.mean)} points (from ${pts(adaptationA.ci95[0])} to ${pts(adaptationA.ci95[1])}, upper bound ${pts(adaptationA.upper95)}) against the file with ${net(adaptA)} and ${pts(adaptationB.mean)} (from ${pts(adaptationB.ci95[0])} to ${pts(adaptationB.ci95[1])}, upper bound ${pts(adaptationB.upper95)}) against the file with ${net(adaptB)}: a difference of ${pts(diff.mean)} points (from ${pts(diff.ci95[0])} to ${pts(diff.ci95[1])}).${ablatedSame ? ' The two ablated networks scored the same on every pair, so the base part did not change.' : ' The two ablated networks did not score the same on every pair.'}`,
    models: modelHashes({ adaptive: A, other: B }),
  },
};
const out = arg('out', evalOut(A, `explorer-tightening-${fresh.attempt.attempt}`))!;
saveResult(out, { stage: 'tightening', measuredAt, seconds: (performance.now() - t0) / 1000, threads, ...machine(), provenance: provenance({ adaptive: A, other: B }), facts }, flag('write-facts'));
console.log(JSON.stringify({ out, explorer: label, adaptive: { adapt: adaptA, adaptationPart: adaptationA, reproduces }, other: { adapt: adaptB, adaptationPart: adaptationB }, diff, ablatedSame, ablatedDiff }, null, 2));
