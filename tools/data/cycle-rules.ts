// cycle-rules.json: the rules of the weekly cycle that the data page states in words (DATA-SPEC
// 2.1.4): the promotion duel, the test window with people, the marks at which each part turns on,
// and the smallest group a public number may come from. Read from the production config, never
// typed into the page.
//
// Usage: docker compose run --rm -T node node tools/data/cycle-rules.ts

import { isMain, provenance, readText, writeGenerated, type Provenance } from './lib/provenance.ts';
import { parseToml, tomlNumber, tomlString, type TomlValue } from './lib/toml-lite.ts';

const SCRIPT = 'tools/data/cycle-rules.ts';
export const PROD_TOML = 'training/cycle/config/prod.toml';
/** MIN_PEOPLE lives in the cycle's summary builder (training/cycle/zapcycle/summary.py). */
export const SUMMARY_PY = 'training/cycle/zapcycle/summary.py';

export interface CycleRules {
  provenance: Provenance;
  gate: { p0: number; p1: number; alpha: number; beta: number; segment_margin: number; panel_margin: number; batch_pairs: number; segment_pairs: number; panel_pairs: number; stats: string };
  ab: { share: number; days: number; rollback_drop: number; min_matches_per_arm: number };
  thresholds: Record<string, number>;
  schedule: { weekday: number; time: string; timezone: string; new_matches: number };
  train: { iters: number; decisions: number };
  MIN_PEOPLE: number;
}

export function minPeople(): number {
  const m = /^MIN_PEOPLE\s*=\s*(\d+)\s*$/m.exec(readText(SUMMARY_PY));
  if (!m) throw new Error(`${SUMMARY_PY}: no line "MIN_PEOPLE = <integer>"`);
  return Number(m[1]);
}

export function buildCycleRules(): CycleRules {
  const doc = parseToml(readText(PROD_TOML));
  const num = (section: string, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, tomlNumber(doc, section, k)]));
  const thresholds: Record<string, number> = {};
  for (const [k, v] of Object.entries(doc.thresholds ?? {}) as [string, TomlValue][]) {
    if (typeof v !== 'number') throw new Error(`[thresholds] ${k} must be a number`);
    thresholds[k] = v;
  }
  if (Object.keys(thresholds).length === 0) throw new Error(`${PROD_TOML}: [thresholds] is empty`);
  return {
    provenance: provenance(SCRIPT, [PROD_TOML, SUMMARY_PY, SCRIPT, 'tools/data/lib/toml-lite.ts']),
    gate: {
      ...(num('gate', ['p0', 'p1', 'alpha', 'beta', 'segment_margin', 'panel_margin', 'batch_pairs', 'segment_pairs', 'panel_pairs']) as Omit<CycleRules['gate'], 'stats'>),
      stats: tomlString(doc, 'gate', 'stats'),
    },
    ab: num('ab', ['share', 'days', 'rollback_drop', 'min_matches_per_arm']) as CycleRules['ab'],
    thresholds,
    schedule: {
      weekday: tomlNumber(doc, 'schedule', 'weekday'),
      time: tomlString(doc, 'schedule', 'time'),
      timezone: tomlString(doc, 'schedule', 'timezone'),
      new_matches: tomlNumber(doc, 'schedule', 'new_matches'),
    },
    train: num('train', ['iters', 'decisions']) as CycleRules['train'],
    MIN_PEOPLE: minPeople(),
  };
}

if (isMain(import.meta.url)) {
  const out = writeGenerated('cycle-rules.json', buildCycleRules());
  console.log(`wrote ${out}`);
}
