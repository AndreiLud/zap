// Calibrates the characters for one model so each style shows up in the numbers and the difficulty
// order holds with a margin.
//
// 1. Zap is measured against itself (pairs per segment, seed c3, the four segments pooled).
// 2. Style shares by bisection, 7 steps of max(20, pairs / 2) pairs per segment, the three side by
//    side: Otávio asks for truco half as often as Zap, Bento bluffs 20 points more, Lia asks 30
//    points more. The share is the part of the bet decisions that follow the character's betting
//    style; card play always comes from the network.
// 3. All six are measured with 2 * pairs per segment, each as a team against a team of Zap.
// 4. The order with a margin: Otávio at least `margin` below the easiest of Bento, Lia and Ravi, and
//    Iara at least `margin` above the hardest of them. One lever per round for each side, then the
//    changed characters are measured again on the same deals, at most 8 rounds:
//    Otávio short: when Ravi is the easiest of the middle, Ravi plays more of his bet decisions with
//    the network (share down 0.15, not below 0.4: he still switches style hand by hand in the
//    rest); otherwise Otávio's temperature goes up 0.3, at most 2.4 (past that he stops being
//    cautious and just plays at random). Iara short: her style share goes down 0.1, then her
//    temperature 0.1, not below 0.4.
// 5. Style separation, where cheap: Iara is Zap with a calculating style in part of her bets, so the
//    two are hard to tell apart. Her share is tried at 0.45, 0.55 and 0.65 (one batch); the largest
//    that keeps her twice the margin above the middle and separates her from Zap by at least 5
//    points more is kept. Twice the margin, because the choice is made on the same deals it is
//    judged on: a share picked right at the margin lands below it on fresh deals (2026-11-22, v2:
//    a share chosen 3.8 points above the middle measured 0.7 points above it on the gate's deals).
//
// Usage: node ai/bench/calibrate-personas.ts <model.zapw> [pairs] [--out file.json] [--threads N]
//          [--stats live|empty] [--margin 0.03] [--adaptive-facts]
//   --stats           live (default): every player reads the public statistics of the match;
//                     empty: no evidence, as the room plays while AI_ADAPT is off.
//   --adaptive-facts  stores the difficulty order and the scores against Zap under
//                     ai.adaptation.personasV2 in facts.json (for an adaptive model; the
//                     characters then read the opponent too, and the order must still hold).

import { readFileSync, writeFileSync } from 'node:fs';
import { parseModel } from '../src/mlp.ts';
import type { Knobs } from '../src/net-agent.ts';
import { PERSONAS, type PersonaId } from '../src/personas.ts';
import { separation, type Separation, type StyleMeasure } from './persona-stats.ts';
import { STYLE_SEED, measureStyles, type StyleJob } from './persona-measure.ts';
import { arg, evalOut, modelHashes, numArg, provenance, requireSafetyNet, runOf, saveResult } from './bench-util.ts';

const modelPath = process.argv[2];
// The adaptive measurement calibrates the model as served: it needs its safety net.
if (process.argv.includes('--adaptive-facts')) requireSafetyNet(modelPath);
parseModel(readFileSync(modelPath));
const pairs = process.argv[3] && !process.argv[3].startsWith('--') ? Number(process.argv[3]) : 60;
const outPath = arg('out');
const threads = Math.max(1, numArg('threads', 1));
const stats = arg('stats', 'live') === 'empty' ? 'empty' : 'live';
const margin = numArg('margin', 0.03);
const t0 = performance.now();

const MID: PersonaId[] = ['bento', 'lia', 'ravi'];
const IDS: PersonaId[] = ['otavio', 'bento', 'lia', 'ravi', 'iara', 'zap'];
const RAVI_MIN_SHARE = 0.4;
const OTAVIO_MAX_TEMPERATURE = 2.4;
const IARA_MIN_TEMPERATURE = 0.4;
const IARA_TRIES = [0.45, 0.55, 0.65];
/** The least gain in separation from Zap that is worth a change of Iara's share. */
const IARA_MIN_SEPARATION_GAIN = 0.05;

const measure = (jobs: StyleJob[]) => measureStyles(modelPath, jobs, { threads, stats });
const round2 = (x: number) => Math.round(x * 100) / 100;
const defaults = Object.fromEntries(PERSONAS.map((p) => [p.id, p.knobs])) as Record<PersonaId, Knobs>;

const Z = (await measure([{ key: 'zap', knobs: defaults.zap, pairs }])).zap;
console.log(`zap: truco ${Z.trucoRate?.toFixed(3)} bluff ${Z.bluffRate?.toFixed(3)} run ${Z.runRate?.toFixed(3)}`);

interface Spec {
  id: PersonaId;
  stat: 'trucoRate' | 'bluffRate';
  target: number;
  /** Whether the statistic grows with the style share. */
  increasing: boolean;
}
const specs: Spec[] = [
  { id: 'otavio', stat: 'trucoRate', target: 0.5 * (Z.trucoRate ?? 0), increasing: false },
  { id: 'bento', stat: 'bluffRate', target: Math.min(0.9, (Z.bluffRate ?? 0) + 0.2), increasing: true },
  { id: 'lia', stat: 'trucoRate', target: Math.min(0.95, (Z.trucoRate ?? 0) + 0.3), increasing: true },
];

const result: Record<PersonaId, Knobs> = { ...defaults };
const reached: Record<string, number | null> = {};
// Bisection on the style share, from 0 (pure network) to 1 (every bet decision by style).
const lo: Record<string, number> = Object.fromEntries(specs.map((s) => [s.id, 0]));
const hi: Record<string, number> = Object.fromEntries(specs.map((s) => [s.id, 1]));
for (let step = 0; step < 7; step++) {
  const m = await measure(specs.map((s) => ({ key: s.id, knobs: { ...defaults[s.id], styleShare: (lo[s.id] + hi[s.id]) / 2 }, pairs: Math.max(20, Math.floor(pairs / 2)) })));
  for (const spec of specs) {
    const v = m[spec.id][spec.stat] ?? 0;
    reached[spec.id] = v;
    const mid = (lo[spec.id] + hi[spec.id]) / 2;
    if (v < spec.target === spec.increasing) lo[spec.id] = mid;
    else hi[spec.id] = mid;
  }
}
for (const spec of specs) {
  result[spec.id] = { ...defaults[spec.id], styleShare: (lo[spec.id] + hi[spec.id]) / 2 };
  console.log(`${spec.id}: share ${result[spec.id].styleShare.toFixed(2)}, ${spec.stat} ${reached[spec.id]?.toFixed(3)} (target ${spec.target.toFixed(3)})`);
}

const finalPairs = pairs * 2;
const final: Record<string, StyleMeasure> = await measure(IDS.map((id) => ({ key: id, knobs: result[id], pairs: finalPairs })));

interface Gaps {
  otavio: { gap: number; against: PersonaId };
  iara: { gap: number; against: PersonaId };
}
function gaps(f: Record<string, StyleMeasure>): Gaps {
  const easiest = MID.reduce((a, b) => (f[b].vsZap < f[a].vsZap ? b : a));
  const hardest = MID.reduce((a, b) => (f[b].vsZap > f[a].vsZap ? b : a));
  return { otavio: { gap: f[easiest].vsZap - f.otavio.vsZap, against: easiest }, iara: { gap: f.iara.vsZap - f[hardest].vsZap, against: hardest } };
}

const changes: string[] = [];
for (let round = 0; round < 8; round++) {
  const g = gaps(final);
  const changed: PersonaId[] = [];
  if (g.otavio.gap < margin) {
    if (g.otavio.against === 'ravi' && result.ravi.styleShare > RAVI_MIN_SHARE + 1e-9) {
      result.ravi = { ...result.ravi, styleShare: round2(Math.max(RAVI_MIN_SHARE, result.ravi.styleShare - 0.15)) };
      changes.push(`round ${round + 1}: Ravi easier than Otávio plus the margin; Ravi's style share ${result.ravi.styleShare}`);
      changed.push('ravi');
    } else if (result.otavio.temperature < OTAVIO_MAX_TEMPERATURE - 1e-9) {
      result.otavio = { ...result.otavio, temperature: round2(Math.min(OTAVIO_MAX_TEMPERATURE, result.otavio.temperature + 0.3)) };
      changes.push(`round ${round + 1}: Otávio not the easiest by the margin; his temperature ${result.otavio.temperature}`);
      changed.push('otavio');
    }
  }
  if (g.iara.gap < margin) {
    if (result.iara.styleShare > 1e-9) {
      result.iara = { ...result.iara, styleShare: round2(Math.max(0, result.iara.styleShare - 0.1)) };
      changes.push(`round ${round + 1}: Iara not the hardest by the margin; her style share ${result.iara.styleShare}`);
      changed.push('iara');
    } else if (result.iara.temperature > IARA_MIN_TEMPERATURE + 1e-9) {
      result.iara = { ...result.iara, temperature: round2(Math.max(IARA_MIN_TEMPERATURE, result.iara.temperature - 0.1)) };
      changes.push(`round ${round + 1}: Iara not the hardest by the margin; her temperature ${result.iara.temperature}`);
      changed.push('iara');
    }
  }
  if (!changed.length) break;
  console.log(changes.slice(-changed.length).join('\n'));
  Object.assign(final, await measure(changed.map((id) => ({ key: id, knobs: result[id], pairs: finalPairs }))));
}

// Separation of Iara from Zap, where it costs one batch.
const sepIaraZap = (m: StyleMeasure) => separation(m.logs, final.zap.logs).accuracy;
const iaraTries = IARA_TRIES.filter((s) => s > result.iara.styleShare + 1e-9 && result.iara.temperature >= 0.6 - 1e-9);
const iaraTried: { styleShare: number; vsZap: number; gap: number; separationFromZap: number }[] = [];
if (gaps(final).iara.gap >= 2 * margin && iaraTries.length) {
  const m = await measure(iaraTries.map((s) => ({ key: `iara@${s}`, knobs: { ...result.iara, styleShare: s }, pairs: finalPairs })));
  const start = sepIaraZap(final.iara);
  iaraTried.push({ styleShare: result.iara.styleShare, vsZap: final.iara.vsZap, gap: gaps(final).iara.gap, separationFromZap: start });
  let best = { share: result.iara.styleShare, sep: start };
  const maxMid = Math.max(...MID.map((id) => final[id].vsZap));
  for (const s of iaraTries) {
    const x = m[`iara@${s}`];
    const sep = sepIaraZap(x);
    iaraTried.push({ styleShare: s, vsZap: x.vsZap, gap: x.vsZap - maxMid, separationFromZap: sep });
    if (x.vsZap - maxMid >= 2 * margin && sep >= start + IARA_MIN_SEPARATION_GAIN && sep > best.sep) best = { share: s, sep };
  }
  if (best.share !== result.iara.styleShare) {
    result.iara = { ...result.iara, styleShare: best.share };
    final.iara = m[`iara@${best.share}`];
    changes.push(`separation: Iara's style share ${best.share} (separation from Zap ${best.sep.toFixed(3)})`);
    console.log(changes[changes.length - 1]);
  }
}

const sep: Record<string, Separation> = {};
for (let i = 0; i < IDS.length; i++) for (let j = i + 1; j < IDS.length; j++) sep[`${IDS[i]}-${IDS[j]}`] = separation(final[IDS[i]].logs, final[IDS[j]].logs);
const order = {
  otavioEasiest: final.otavio.vsZap < Math.min(...MID.map((id) => final[id].vsZap)),
  iaraHardestAfterZap: final.iara.vsZap > Math.max(...MID.map((id) => final[id].vsZap)),
};
const g = gaps(final);
const report = {
  measuredAt: new Date().toISOString(),
  model: modelPath,
  pairsPerSegment: finalPairs,
  seed: STYLE_SEED.slice(0, 2),
  statsMode: stats,
  threads,
  seconds: (performance.now() - t0) / 1000,
  knobs: result,
  targets: Object.fromEntries(specs.map((s) => [s.id, { stat: s.stat, target: s.target, reached: reached[s.id] }])),
  stats: Object.fromEntries(
    IDS.map((id) => {
      const f = final[id];
      return [id, { ...f, logs: undefined, vsZapCi95: [f.vsZap - 1.96 * f.vsZapSe, f.vsZap + 1.96 * f.vsZapSe], hands: f.logs.length }];
    }),
  ),
  styleSeparation: sep,
  order,
  margin: { required: margin, otavio: g.otavio, iara: g.iara, holds: g.otavio.gap >= margin && g.iara.gap >= margin },
  changes,
  iaraTried,
};
if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
if (process.argv.includes('--adaptive-facts')) {
  const personasV2 = {
    measuredAt: report.measuredAt,
    method: `ai/bench/calibrate-personas.ts on the adaptive model: style shares set by bisection, then each character measured as a team against a team of Zap on the same model, ${finalPairs} duplicate pairs per segment (seed c3), the four segments pooled; every player ${stats === 'live' ? 'reads the public statistics of the match' : 'plays with no evidence'}.`,
    model: report.model,
    note: `adaptive candidate ${runOf(modelPath)}, not the shipped v2 (ai.personasByVersion.v2)`,
    pairsPerSegment: report.pairsPerSegment,
    order,
    orderHolds: order.otavioEasiest && order.iaraHardestAfterZap,
    vsZap: Object.fromEntries(IDS.map((id) => [id, { mean: final[id].vsZap, se: final[id].vsZapSe }])),
    targets: report.targets,
    knobsFile: outPath ?? null,
    models: modelHashes({ adaptive: modelPath }),
  };
  saveResult(evalOut(modelPath, 'personas-v2'), { provenance: provenance({ adaptive: modelPath }), facts: { personasV2 } }, true);
}
console.log(JSON.stringify({ order, margin: report.margin, styleSeparation: sep, vsZap: Object.fromEntries(IDS.map((id) => [id, final[id].vsZap])) }, null, 2));
