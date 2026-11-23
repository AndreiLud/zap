// The promotion gate (contract 3.8). The cycle (zapcycle/gate.py) writes the spec; this plays the
// duplicate pairs with the pair runner of ai/bench/parallel.ts and writes the result (zap-gate/1).
//
// Usage: node training/cycle/gate/gate.ts --spec SPEC.json --out RESULT.json
//
// Order of the deals (all from spec.seed): the SPRT uses pair offsets from 0 to its cap per
// segment, the segment test the next segments.pairs offsets, the panel the ones after that. Every
// panel member meets the candidate and the current version on the same deals.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runPairTasks, type AgentSpec, type PairJob } from '../../../ai/bench/parallel.ts';
import { SEGMENTS, decide, orderFromCalibration, panelTest, runSprt, segmentTest, sprtPlan, type PanelEntry, type Segment, type SegmentEntry, type SprtSpec } from './gate-core.ts';

export interface GateSpec {
  candidate: { version: string; file: string; sha256: string };
  current: { version: string; file: string; sha256: string };
  panel: { member: string; agent: AgentSpec }[];
  seed: string;
  threads: number;
  stats: 'empty' | 'live';
  sprt: SprtSpec;
  segments: { pairs: number; margin: number };
  panelTest: { pairs: number; margin: number };
  personas: { file: string };
}

export interface GateResult {
  schema: 'zap-gate/1';
  candidate: { version: string; sha256: string };
  current: { version: string; sha256: string };
  seed: string;
  stats: 'empty' | 'live';
  sprt: Awaited<ReturnType<typeof runSprt>>;
  segments: Record<Segment, SegmentEntry>;
  panel: PanelEntry[];
  personas: { orderHolds: boolean; source: string };
  pass: boolean;
  reasons: string[];
  seconds: number;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** A network plays with the knobs of Zap and the statistics mode of the spec. */
function withStats(a: AgentSpec, stats: 'empty' | 'live'): AgentSpec {
  return a.kind === 'net' ? { ...a, knobs: a.knobs ?? 'zap', opts: { ...(a.opts ?? {}), stats } } : a;
}

export function checkSpec(s: GateSpec): void {
  if (!/^[0-9a-f]{64}$/.test(s.seed)) throw new Error('spec.seed must be 64 hex characters');
  if (s.sprt.batchPairs < 4 || s.sprt.capPairs < s.sprt.batchPairs) throw new Error('spec.sprt: batchPairs at least 4 and at most capPairs');
  if (s.segments.pairs < 1 || s.panelTest.pairs < 1) throw new Error('spec: pairs must be positive');
  const names = new Set<string>();
  for (const p of s.panel) {
    if (names.has(p.member)) throw new Error(`spec.panel: ${p.member} twice`);
    names.add(p.member);
  }
}

export async function runGate(spec: GateSpec, onProgress?: (msg: string) => void): Promise<GateResult> {
  checkSpec(spec);
  const t0 = performance.now();
  for (const side of [spec.candidate, spec.current]) {
    if (sha256(side.file) !== side.sha256) throw new Error(`${side.version}: ${side.file} does not match its SHA-256`);
  }
  const cand = withStats({ kind: 'net', model: spec.candidate.file, knobs: 'zap', name: spec.candidate.version }, spec.stats);
  const cur = withStats({ kind: 'net', model: spec.current.file, knobs: 'zap', name: spec.current.version }, spec.stats);
  const threads = Math.max(1, spec.threads);

  const sprtOut = await runSprt(spec.sprt, async (round, offset, perSegment) => {
    const jobs: PairJob[] = SEGMENTS.map((g) => ({ key: g, segment: g, baseSeed: spec.seed, offset, pairs: perSegment, a: cand, b: cur }));
    const res = await runPairTasks(jobs, threads);
    onProgress?.(`sprt round ${round + 1}`);
    return Object.fromEntries(SEGMENTS.map((g) => [g, res.get(g)!.scores])) as Record<Segment, number[]>;
  });

  const plan = sprtPlan(spec.sprt);
  const segOffset = plan.rounds * plan.perSegment;
  const segJobs: PairJob[] = SEGMENTS.map((g) => ({ key: g, segment: g, baseSeed: spec.seed, offset: segOffset, pairs: spec.segments.pairs, a: cand, b: cur }));
  const segRes = await runPairTasks(segJobs, threads);
  const segments = Object.fromEntries(SEGMENTS.map((g) => [g, segmentTest(segRes.get(g)!.scores, spec.segments.margin)])) as Record<Segment, SegmentEntry>;
  onProgress?.('segments');

  const panelOffset = segOffset + spec.segments.pairs;
  const panelJobs: PairJob[] = [];
  for (const p of spec.panel) {
    const member = withStats(p.agent, spec.stats);
    for (const g of SEGMENTS) {
      panelJobs.push({ key: `${p.member}|candidate|${g}`, segment: g, baseSeed: spec.seed, offset: panelOffset, pairs: spec.panelTest.pairs, a: cand, b: member });
      panelJobs.push({ key: `${p.member}|current|${g}`, segment: g, baseSeed: spec.seed, offset: panelOffset, pairs: spec.panelTest.pairs, a: cur, b: member });
    }
  }
  const panelRes = await runPairTasks(panelJobs, threads);
  const side = (member: string, who: string) => Object.fromEntries(SEGMENTS.map((g) => [g, panelRes.get(`${member}|${who}|${g}`)!.scores])) as Record<Segment, number[]>;
  const panel = spec.panel.map((p) => panelTest(p.member, side(p.member, 'candidate'), side(p.member, 'current'), spec.panelTest.margin));
  onProgress?.('panel');

  const order = JSON.parse(readFileSync(spec.personas.file, 'utf8')) as { summary?: unknown };
  const orderHolds = orderFromCalibration(order);
  // The order file of training/cycle/gate/personas-order.ts carries its margins in one line.
  const source = (typeof order.summary === 'string' ? `${spec.personas.file}: ${order.summary}` : spec.personas.file).slice(0, 500);
  const { pass, reasons } = decide(sprtOut, segments, panel, orderHolds, spec.sprt, spec.segments.margin, spec.panelTest.margin);
  return {
    schema: 'zap-gate/1',
    candidate: { version: spec.candidate.version, sha256: spec.candidate.sha256 },
    current: { version: spec.current.version, sha256: spec.current.sha256 },
    seed: spec.seed,
    stats: spec.stats,
    sprt: sprtOut,
    segments,
    panel,
    personas: { orderHolds, source },
    pass,
    reasons,
    seconds: Math.round((performance.now() - t0) / 100) / 10,
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const specPath = arg('spec');
  const out = arg('out');
  if (!specPath || !out) {
    console.error('usage: gate.ts --spec SPEC.json --out RESULT.json');
    process.exit(1);
  }
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as GateSpec;
  const result = await runGate(spec, (m) => console.error(m));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ pass: result.pass, sprt: result.sprt.decision, pairs: result.sprt.pairs, reasons: result.reasons, seconds: result.seconds }));
}
