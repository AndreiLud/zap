// The zap-summary/2 view of summary.json for the pages (GET /api/summary answers the file as
// stored, in either schema). This module imports types only, so a page chunk can use it without
// the validators of shared/cycle-formats.ts and the AI code they need; cycle-formats.ts re-exports
// normalizeSummary.

import type { AnySummary, SummaryV2 } from './cycle-formats.ts';

/** SCHEMAS.summary2 of shared/cycle-formats.ts (the type keeps the two equal). */
const SUMMARY_V2: SummaryV2['schema'] = 'zap-summary/2';

/**
 * A zap-summary/2 view of any valid summary (like normalizeRecord): a zap-summary/1 file had no
 * twin, characters or data per version, no seed noise, no scoreboard and no disagreements.
 */
export function normalizeSummary(s: AnySummary): SummaryV2 {
  if (s.schema === SUMMARY_V2) return s;
  return {
    schema: SUMMARY_V2,
    generatedAt: s.generatedAt,
    minPeople: s.minPeople,
    training: s.training,
    humansVsZap: s.humansVsZap,
    versions: s.versions.map((v) => ({ ...v, twin: null, personas: null, data: null })),
    ab: s.ab,
    layers: s.layers,
    cells: s.cells,
    playerTypes: s.playerTypes,
    seedNoise: null,
    scoreboard: [],
    disagreements: null,
  };
}
