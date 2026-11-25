// The two public answers "You against Zap" reads (YouVsZapPage.tsx): /api/live for the version in
// play and whether it reads during the match, /api/summary for the anchors of versions the cycle
// promoted. A module of its own so the tests can check the requests without the page.
//
// Both ask with no-cache, as the data page and the Play page do (live.ts, data/load.ts): the
// browser asks the network every time and never shows a copy it kept, even one an older Worker
// sent with the zone's four hour cache-control; the Cloudflare location's cache still answers.

import { normalizeSummary } from '../../../shared/summary-view.ts';
import type { AnySummary, SummaryV2 } from '../../../shared/cycle-formats.ts';

export interface Served {
  version: string;
  adapt: boolean;
}

/** The version on the AI seats and whether it reads during the match (zap-live/1), or null. */
export async function fetchLive(): Promise<Served | null> {
  try {
    const res = await fetch('/api/live', { credentials: 'same-origin', cache: 'no-cache' });
    if (!res.ok) return null;
    const j = (await res.json()) as { schema?: unknown; current?: unknown; adapt?: unknown };
    if (j.schema !== 'zap-live/1' || typeof j.current !== 'string') return null;
    return { version: j.current, adapt: j.adapt === true };
  } catch {
    return null;
  }
}

/** summary.json as served (/api/summary), in its zap-summary/2 view; null when there is none. */
export async function fetchSummary(): Promise<SummaryV2 | null> {
  try {
    const res = await fetch('/api/summary', { credentials: 'same-origin', cache: 'no-cache' });
    if (!res.ok) return null;
    const j = (await res.json()) as AnySummary;
    if (j?.schema !== 'zap-summary/1' && j?.schema !== 'zap-summary/2') return null;
    return normalizeSummary(j);
  } catch {
    return null;
  }
}
