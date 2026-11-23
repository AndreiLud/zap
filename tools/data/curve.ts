// curve.json and headline.json: the training curve of every version the site has served (DATA-SPEC
// 2.1.3), from the runs named in tools/data/sources.json.
//
// For each row: every line of the run's metrics.jsonl with a duplicate evaluation against the
// tuned rules player (vs_heuristic), as { iteration, step, mean, half95, phase }. The evaluation on
// line `iteration` ran after that iteration's update (training/train.py), so it measures the model
// after iteration + 1 steps; `step` adds the lineage offset, so the x axis counts steps from the
// start of the lineage. The metrics keep only the mean, so half95 is the largest possible half
// width for that mean, 1.96 sqrt(mean (1 - mean) / pairs), with pairs = 4 segments * eval_pairs.
// `hands` sums the hands of the iterations before the snapshot (snapshot itN is written after N
// iterations), plus the parent's hands for a row that starts from another version.
//
// headline.json is imported by web/src/live.ts, so it stays tiny and holds no provenance: its
// provenance is this script's, recorded in curve.json.
//
// Usage: docker compose run --rm -T node node tools/data/curve.ts

import { statSync } from 'node:fs';
import { abs, isMain, provenance, readJson, readText, writeGenerated, type Provenance } from './lib/provenance.ts';
import { readSources, SOURCES_PATH, type CurveSource } from './lib/sources.ts';
import { round, Z95 } from './lib/stats.ts';

const SCRIPT = 'tools/data/curve.ts';

export interface CurvePoint {
  /** Line of metrics.jsonl (0 based). */
  iteration: number;
  /** Training steps since the start of the lineage after which the model was measured. */
  step: number;
  mean: number;
  half95: number;
  phase: 'imitation' | 'selfplay';
}

export interface CurveRow {
  version: string;
  run: string;
  from: string | null;
  snapshot: number;
  /** Steps of the parent lineage before this run's first step (the parent's snapshot), 0 without a parent. */
  offset: number;
  /** Duplicate pairs behind each point (4 segments times eval_pairs). */
  pairs: number;
  evalEvery: number;
  decisionsPerIteration: number;
  /** Imitation iterations at the start of the run (the shaded zone of the chart). */
  imitationIterations: number;
  /** Iterations the run trained (lines of metrics.jsonl). */
  iterations: number;
  /** Hands played behind the snapshot, the parent lineage's included. */
  hands: number;
  /** When the run's metrics.jsonl was last written (ISO). */
  trainedAt: string;
  /** The evaluation closest to the snapshot (the earlier one on a tie). */
  nearSnapshot: CurvePoint;
  points: CurvePoint[];
}

export interface Curve {
  provenance: Provenance;
  rows: CurveRow[];
}

export type Headline = Record<string, { trainingHands: number }>;

interface MetricsLine {
  iteration: number;
  mode: string;
  hands?: number;
  vs_heuristic?: number;
}

function metricsOf(run: string): MetricsLine[] {
  return readText(`${run}/metrics.jsonl`)
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as MetricsLine);
}

/** The input files of the curve: sources.json and each run's metrics and arguments. */
export function curveInputs(): string[] {
  return [SOURCES_PATH, SCRIPT, ...readSources().curve.flatMap((r) => [`${r.run}/metrics.jsonl`, `${r.run}/args.json`])];
}

export function buildCurveRow(src: CurveSource, parent: CurveRow | null): CurveRow {
  const lines = metricsOf(src.run);
  const args = readJson<Record<string, unknown>>(`${src.run}/args.json`);
  const evalPairs = Number(args.eval_pairs);
  const evalEvery = Number(args.eval_every);
  const decisions = Number(args.decisions);
  if (!(evalPairs > 0) || !(evalEvery > 0) || !(decisions > 0)) throw new Error(`${src.run}/args.json: eval_pairs, eval_every and decisions must be positive`);
  const iterations = lines.length;
  lines.forEach((l, i) => {
    if (l.iteration !== i) throw new Error(`${src.run}/metrics.jsonl: line ${i + 1} has iteration ${l.iteration}`);
  });
  if (src.snapshot > iterations) throw new Error(`${src.run}: snapshot ${src.snapshot} after the last iteration ${iterations}`);
  const offset = parent ? parent.snapshot + parent.offset : 0;
  const pairs = 4 * evalPairs;
  const points: CurvePoint[] = lines
    .filter((l) => typeof l.vs_heuristic === 'number')
    .map((l) => {
      const mean = l.vs_heuristic as number;
      return {
        iteration: l.iteration,
        step: offset + l.iteration + 1,
        mean: round(mean),
        half95: round(Z95 * Math.sqrt((mean * (1 - mean)) / pairs)),
        phase: l.mode === 'imitation' ? 'imitation' : 'selfplay',
      };
    });
  if (points.length === 0) throw new Error(`${src.run}: no evaluation against the tuned rules player`);
  let hands = 0;
  for (const l of lines) {
    if (l.iteration >= src.snapshot) continue;
    if (!Number.isInteger(l.hands)) throw new Error(`${src.run}: iteration ${l.iteration} has no hands`);
    hands += l.hands as number;
  }
  const target = offset + src.snapshot;
  const nearSnapshot = points.reduce((best, p) => (Math.abs(p.step - target) < Math.abs(best.step - target) ? p : best));
  return {
    version: src.version,
    run: src.run,
    from: src.from,
    snapshot: src.snapshot,
    offset,
    pairs,
    evalEvery,
    decisionsPerIteration: decisions,
    imitationIterations: Number(args.imitation_iters ?? 0),
    iterations,
    hands: hands + (parent?.hands ?? 0),
    trainedAt: statSync(abs(`${src.run}/metrics.jsonl`)).mtime.toISOString(),
    nearSnapshot,
    points,
  };
}

export function buildCurve(): { curve: Curve; headline: Headline } {
  const sources = readSources();
  const rows: CurveRow[] = [];
  for (const src of sources.curve) {
    const parent = src.from === null ? null : (rows.find((r) => r.version === src.from) ?? null);
    rows.push(buildCurveRow(src, parent));
  }
  const headline: Headline = Object.fromEntries(rows.map((r) => [r.version, { trainingHands: r.hands }]));
  const curve: Curve = {
    provenance: provenance(SCRIPT, curveInputs(), { outputs: ['web/src/data/generated/curve.json', 'web/src/data/generated/headline.json'] }),
    rows,
  };
  return { curve, headline };
}

if (isMain(import.meta.url)) {
  const { curve, headline } = buildCurve();
  console.log(`wrote ${writeGenerated('curve.json', curve)}`);
  console.log(`wrote ${writeGenerated('headline.json', headline)}`);
}
