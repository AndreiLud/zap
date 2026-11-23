// Merges result files of the milestone 6 benches into facts.json, under ai.adaptation. Each file
// (written under training/runs/<run>/eval/ by the benches, by training/tests/check_warm_start.py
// and by training/report_runs.py) holds a `facts` object: values by key, each with measuredAt and
// method. Folders are read in name order. The keys that measure the served adaptive model must all
// name the same file (sha256 in models.adaptive); otherwise the command says which and exits 1.
// The safety sweep measures the export without a net, so it is not compared.
//
// Usage: node ai/bench/adaptation-facts.ts <file.json | folder> [...] [--facts facts.json] [--dry-run]

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FACTS_FILE, arg, flag, readJson, writeAdaptationFacts, type FactsResult } from './bench-util.ts';

const factsPath = arg('facts', FACTS_FILE)!;
const inputs = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--facts');
if (!inputs.length) throw new Error('usage: adaptation-facts.ts <file.json | folder> [...]');
const files: string[] = [];
for (const p of inputs) {
  if (statSync(p).isDirectory()) {
    for (const f of readdirSync(p).sort()) if (f.endsWith('.json')) files.push(join(p, f));
  } else files.push(p);
}
const merged: Record<string, string> = {};
// Which adaptive model file each key measured (facts carry models.adaptive.sha256): the keys that
// describe the served model must all name the same file.
const adaptive: Record<string, string> = {};
for (const f of files) {
  const r = readJson<Partial<FactsResult>>(f);
  if (!r.facts || typeof r.facts !== 'object') continue;
  for (const [k, v] of Object.entries(r.facts)) {
    if (!flag('dry-run')) writeAdaptationFacts(k, v, factsPath);
    merged[k] = f;
    const sha = (v as { models?: { adaptive?: { sha256?: string } } }).models?.adaptive?.sha256;
    if (sha && k !== 'regularizer' && k !== 'safetyNet') adaptive[k] = sha;
  }
}
const hashes = [...new Set(Object.values(adaptive))];
console.log(JSON.stringify({ facts: factsPath, merged, dryRun: flag('dry-run'), adaptiveModel: hashes.length === 1 ? hashes[0] : null, mismatch: hashes.length > 1 ? adaptive : null }, null, 2));
if (hashes.length > 1) {
  process.stderr.write('warning: these keys measured different adaptive model files; run the older ones again on the final file\n');
  process.exitCode = 1;
}
