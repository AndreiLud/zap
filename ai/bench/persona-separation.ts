// Style separation of the characters with its intervals, for a model and the knobs it ships with.
//
// ai/bench/calibrate-personas.ts reports styleSeparation for each pair of characters, measured on
// the hands of its final measurement (each character as a team against a team of Zap, seed c3,
// the four segments pooled). This bench plays that final measurement again with the knobs as
// bundled (measureStyles of ai/bench/persona-measure.ts gives the same deals, the same policy seeds
// and the same hand order, whatever the threads) and reports, per pair, the accuracy of the
// nearest-centroid classifier, its number of test windows and its 95% Wilson interval
// (ai/bench/persona-stats.ts separation). It also reports whether each accuracy equals the one the
// calibration stored, which shows the hands are the same.
//
// With --write-facts it adds <facts key>.styleSeparationCi95 (read, modify and write of that one
// child, right before saving); nothing else in facts.json changes.
//
// Usage: node ai/bench/persona-separation.ts [--model ai/models/bootstrap/zap-v2.zapw]
//          [--manifest ai/models/bootstrap/manifest-v2.json] [--pairs 400] [--stats empty]
//          [--threads 2] [--facts-key ai.personasByVersion.v2] [--write-facts]

import { readFileSync, writeFileSync } from 'node:fs';
import type { Knobs } from '../src/net-agent.ts';
import type { PersonaId } from '../src/personas.ts';
import { FACTS_FILE, arg, flag, numArg, readJson, sha256File } from './bench-util.ts';
import { STYLE_SEED, measureStyles } from './persona-measure.ts';
import { separation } from './persona-stats.ts';

const IDS: PersonaId[] = ['otavio', 'bento', 'lia', 'ravi', 'iara', 'zap'];
const model = arg('model', 'ai/models/bootstrap/zap-v2.zapw')!;
const manifestPath = arg('manifest', 'ai/models/bootstrap/manifest-v2.json')!;
const pairs = numArg('pairs', 400);
const stats = arg('stats', 'empty') === 'live' ? 'live' : 'empty';
const threads = numArg('threads', 2);
const factsKey = arg('facts-key', 'ai.personasByVersion.v2')!;
const t0 = performance.now();

const manifest = readJson<{ sha256: string; personas: Record<PersonaId, Knobs> }>(manifestPath);
const sha = sha256File(model);
if (sha !== manifest.sha256) throw new Error(`${model} is not the file of ${manifestPath}`);
const measured = await measureStyles(model, IDS.map((id) => ({ key: id, knobs: manifest.personas[id], pairs })), { threads, stats, seed: STYLE_SEED });

const at = (o: any, path: string) => path.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
const stored = at(readJson(FACTS_FILE), factsKey) as { styleSeparation?: Record<string, number>; stats?: Record<string, { vsZap: number }> } | undefined;
const r4 = (x: number) => Math.round(x * 10000) / 10000;
const rows: Record<string, { accuracy: number; testWindows: number; ci95: [number, number]; storedAccuracy: number | null; sameAsStored: boolean | null }> = {};
for (let i = 0; i < IDS.length; i++)
  for (let j = i + 1; j < IDS.length; j++) {
    const key = `${IDS[i]}-${IDS[j]}`;
    const s = separation(measured[IDS[i]].logs, measured[IDS[j]].logs);
    const old = stored?.styleSeparation?.[key] ?? null;
    rows[key] = { accuracy: s.accuracy, testWindows: s.testWindows, ci95: [r4(s.ci95[0]), r4(s.ci95[1])], storedAccuracy: old, sameAsStored: old === null ? null : Math.abs(old - s.accuracy) < 1e-12 };
  }
const vsZapSame = IDS.every((id) => stored?.stats?.[id] === undefined || Math.abs(stored.stats[id].vsZap - measured[id].vsZap) < 1e-12);
const atTarget = Object.values(rows).filter((r) => r.accuracy >= 0.8).length;
const lowerAtTarget = Object.values(rows).filter((r) => r.ci95[0] >= 0.8).length;
const upperBelow = Object.values(rows).filter((r) => r.ci95[1] < 0.8).length;
const value = {
  measuredAt: new Date().toISOString(),
  method: `ai/bench/persona-separation.ts: the final measurement of the calibration played again with the knobs of ${manifestPath} on ${model} (each character as a team against a team of Zap, ${pairs} duplicate pairs per segment, seed c3, the four segments pooled, statistics ${stats}), then for each pair of characters the nearest-centroid accuracy over windows of 20 hands (trained on even windows, tested on odd ones, ai/bench/persona-stats.ts) with its number of test windows and its 95% Wilson interval, the windows counted as independent. sameAsStored: the accuracy equals the one in styleSeparation, so the hands are those of the calibration.`,
  model,
  sha256: sha,
  pairsPerSegment: pairs,
  target: 0.8,
  atTarget: { pairs: Object.keys(rows).length, accuracyAtLeast80: atTarget, lowerBoundAtLeast80: lowerAtTarget, upperBoundBelow80: upperBelow },
  vsZapSameAsStored: vsZapSame,
  pairs: rows,
};
if (flag('write-facts')) {
  if (!Object.values(rows).every((r) => r.sameAsStored !== false) || !vsZapSame) throw new Error('the hands differ from the calibration: not written');
  const facts = JSON.parse(readFileSync(FACTS_FILE, 'utf8'));
  const parent = at(facts, factsKey);
  if (!parent || typeof parent !== 'object') throw new Error(`${factsKey} is missing in ${FACTS_FILE}`);
  parent.styleSeparationCi95 = value;
  writeFileSync(FACTS_FILE, JSON.stringify(facts, null, 2) + '\n');
}
console.log(JSON.stringify({ ...value, seconds: Math.round((performance.now() - t0) / 100) / 10, wroteFacts: flag('write-facts') }, null, 2));
