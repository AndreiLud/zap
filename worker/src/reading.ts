// "How Zap reads you" (GET /api/me/reading, contract 1.13): the person's style counters from D1
// `profiles`, summed over the rules segments and read against the population priors the training
// cycle imported (cycle_imports "priors", from control/priors.json) or, before any import, the
// bundled default priors, at the person's own mix of segments. The math is shared/profile.ts
// readProfile: a number shows only after 10 observations, when its 80% interval is narrower than
// 30 points. Two D1 reads in one batch, no write.

import defaultPriors from '../../shared/profile-priors-default.json' with { type: 'json' };
import { parseChecked, validatePriorsFile, type PriorsFile, type Reading } from '../../shared/cycle-formats.ts';
import { readProfile, type SegmentCounts } from '../../shared/profile.ts';
import { SEGMENTS, type Segment } from '../../ai/src/opponent-stats.ts';
import type { SqlDb } from './privacy.ts';
import { PROFILE_COLUMNS, rowCounts, sumRows } from './profiles.ts';

const BUNDLED = defaultPriors as PriorsFile;

/** The last imported body read and its parsed priors (one per isolate; the body changes once a week at most). */
let cached: { body: string; priors: PriorsFile } | null = null;

/** The imported priors when D1 has a valid body, else the bundled default. */
export function priorsFrom(body: string | null | undefined): PriorsFile {
  if (!body) return BUNDLED;
  if (cached?.body === body) return cached.priors;
  const checked = parseChecked('priors', body, validatePriorsFile);
  const priors = checked.ok ? checked.value : BUNDLED;
  cached = { body, priors };
  return priors;
}

/** The reading of this device's person, or null when D1 does not have the device. */
export async function readingFor(db: SqlDb, device: string, now: number): Promise<Reading | null> {
  const cols = PROFILE_COLUMNS.map((c) => `p.${c} AS ${c}`).join(', ');
  const [rows, imported] = await db.batch([
    db.prepare(`SELECT d.no_adapt AS noAdapt, p.segment AS segment, ${cols} FROM devices d LEFT JOIN profiles p ON p.pseudonym = d.pseudonym WHERE d.id = ?1`).bind(device),
    db.prepare("SELECT body FROM cycle_imports WHERE name = 'priors'"),
  ]);
  const found = (rows.results ?? []) as ({ noAdapt: number; segment: string | null } & Record<(typeof PROFILE_COLUMNS)[number], number | null>)[];
  if (found.length === 0) return null;
  const noAdapt = found[0].noAdapt !== 0;
  const body = ((imported.results ?? []) as { body: string | null }[])[0]?.body ?? null;
  const kept = found.filter((r) => r.segment !== null && (SEGMENTS as readonly string[]).includes(r.segment));
  const perSegment: SegmentCounts = Object.fromEntries(kept.map((r) => [r.segment as Segment, rowCounts(r)]));
  return readProfile(sumRows(kept), priorsFrom(body), { noAdapt, now, perSegment });
}
