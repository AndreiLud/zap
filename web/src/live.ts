// The live counters of the site (DATA-SPEC 2.4): GET /api/live (zap-live/1) for the Play page's
// "So far" strip and the data page's cover. The Play page asks once on mount. The data page
// polls every minute while the tab is visible with the poller of data/live-poll.ts, which lives in
// the data chunk: this module is in the entry chunk, so it keeps only the counters and one fetch.

import { useEffect, useState } from 'preact/hooks';
import headline from './data/generated/headline.json' with { type: 'json' };

export interface LiveCounters {
  /** Finished matches with at least one person, since launch (live.matches). */
  humanMatches: number;
  /** People against Zap (summary.json), zeros before the first summary. */
  humansVsZap: { matches: number; humanWins: number };
  /** Version label on the AI seats now (live.current). */
  aiVersion: string;
  /** Hands of training behind the version in play (headline.json); null for a version without a row. */
  trainingHands: number | null;
  /** When the server made this answer (ms). */
  updatedAt: number;
  /** Moves people made themselves in those matches (live.decisions). */
  decisions: number;
  /** In-match reading on for the version in play (live.adapt). */
  adapt: boolean;
}

const HANDS: Record<string, { trainingHands: number } | undefined> = headline;
const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** The counters of a zap-live/1 answer, or null when the body is not one. */
export function parseLive(json: unknown): LiveCounters | null {
  if (!json || typeof json !== 'object') return null;
  const a = json as Record<string, unknown>;
  const vs = a.humansVsZap as Record<string, unknown> | null;
  if (a.schema !== 'zap-live/1' || !count(a.at) || !count(a.matches) || !count(a.decisions) || typeof a.current !== 'string' || typeof a.adapt !== 'boolean') return null;
  if (vs !== null && (typeof vs !== 'object' || !count(vs.matches) || !count(vs.humanWins))) return null;
  return {
    humanMatches: a.matches,
    humansVsZap: vs ? { matches: vs.matches as number, humanWins: vs.humanWins as number } : { matches: 0, humanWins: 0 },
    aiVersion: a.current,
    trainingHands: HANDS[a.current]?.trainingHands ?? null,
    updatedAt: a.at,
    decisions: a.decisions,
    adapt: a.adapt,
  };
}

/** One request to /api/live; null when it fails or answers something else. */
export async function fetchLive(): Promise<LiveCounters | null> {
  try {
    const r = await fetch('/api/live', { headers: { accept: 'application/json' } });
    return r.ok ? parseLive(await r.json()) : null;
  } catch {
    return null;
  }
}

/** The counters, or null until /api/live answers (or when it fails). One request on mount. */
export function useLiveCounters(): LiveCounters | null {
  const [live, setLive] = useState<LiveCounters | null>(null);
  useEffect(() => {
    let on = true;
    void fetchLive().then((l) => on && setLive(l));
    return () => {
      on = false;
    };
  }, []);
  return live;
}
