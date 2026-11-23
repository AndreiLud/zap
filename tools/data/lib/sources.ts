// tools/data/sources.json: the only place that names the runs and the model behind the data page
// (DATA-SPEC 2.1). Read and checked here, so every script fails the same way on a bad file.

import { readJson } from './provenance.ts';

export const SOURCES_PATH = 'tools/data/sources.json';

export interface CurveSource {
  version: string;
  run: string;
  /** The snapshot itN of the run that became this version (written after N iterations). */
  snapshot: number;
  /** The version this run started from (its snapshot is the offset of this lineage), or null. */
  from: string | null;
}

export interface Sources {
  storyModel: { version: string; path: string; manifest: string; stats: 'live' | 'empty' };
  curve: CurveSource[];
  sim: { seed: string; matchesPerSegment: number; personaMatchesPerSegment: number; threads: number };
}

export function readSources(): Sources {
  const s = readJson<Sources>(SOURCES_PATH);
  const m = s.storyModel;
  if (!m || typeof m.version !== 'string' || typeof m.path !== 'string' || typeof m.manifest !== 'string') throw new Error('sources.json: storyModel needs version, path and manifest');
  if (m.stats !== 'live' && m.stats !== 'empty') throw new Error('sources.json: storyModel.stats must be "live" or "empty"');
  if (!Array.isArray(s.curve) || s.curve.length === 0) throw new Error('sources.json: curve needs at least one row');
  const seen = new Set<string>();
  for (const row of s.curve) {
    if (typeof row.version !== 'string' || typeof row.run !== 'string' || !Number.isInteger(row.snapshot) || row.snapshot <= 0) throw new Error(`sources.json: bad curve row ${JSON.stringify(row)}`);
    if (row.from !== null && !seen.has(row.from)) throw new Error(`sources.json: curve row ${row.version} starts from ${row.from}, which must be an earlier row`);
    if (seen.has(row.version)) throw new Error(`sources.json: version ${row.version} appears twice in curve`);
    seen.add(row.version);
  }
  const sim = s.sim;
  if (!/^[0-9a-f]{2}$/.test(sim.seed)) throw new Error('sources.json: sim.seed takes two hex characters');
  for (const k of ['matchesPerSegment', 'personaMatchesPerSegment', 'threads'] as const) {
    if (!Number.isInteger(sim[k]) || sim[k] <= 0) throw new Error(`sources.json: sim.${k} must be a positive integer`);
  }
  if (sim.matchesPerSegment >= 1_000_000 || sim.personaMatchesPerSegment >= 1_000_000) throw new Error('sources.json: at most 999,999 matches per segment (the seed index leaves room for 1,000,000)');
  return s;
}
