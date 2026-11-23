// The two public endpoints of the data page (_local/m7/DATA-SPEC.md 2.2), answered without a
// credential and only with aggregates:
// * GET /api/live (zap-live/1): the site's counters (live_counts, one row with no person in it),
//   the version on the AI seats, whether it reads the match, and humansVsZap from summary.json;
// * GET /api/summary: the training cycle's summary.json as stored, once it passes validateSummary,
//   which refuses any number built from a group of fewer than MIN_PEOPLE people (cells, scoreboard
//   rows, people counts, disagreements). humansVsZap, the owner's one exception, is a total.
// Both are cached per location with the Cache API (worker/src/cf/index.ts), so the storage behind
// them is read at most once per period; local test sites skip the cache.
//
// Pure over SqlDb, strings and a cache interface, so the unit tests run it on node:sqlite.

import { isSafetyNet } from '../../ai/src/safety.ts';
import { parseChecked, validateSummary, type AnySummary, type Manifest } from '../../shared/cycle-formats.ts';
import type { SqlDb } from './privacy.ts';

export const LIVE_SCHEMA = 'zap-live/1';
/** Cache periods in seconds: the counters every minute, the summary every 5 minutes. */
export const LIVE_MAX_AGE_S = 60;
export const SUMMARY_MAX_AGE_S = 300;

export interface Live {
  schema: typeof LIVE_SCHEMA;
  /** ms, when this answer was made. */
  at: number;
  /** Finished matches with at least one person, every kind, since launch. */
  matches: number;
  /** Moves people made themselves (MoveInfo.ms not null) in those matches. */
  decisions: number;
  /** Version label on the AI seats now: the manifest's current, else the bundled label; "heuristic" in that mode. */
  current: string;
  /** The in-match reading is on for that version. */
  adapt: boolean;
  /** From summary.json; null without a valid one. */
  humansVsZap: { matches: number; humanWins: number } | null;
}

export type SummaryCheck = { ok: true; body: string; summary: AnySummary } | { ok: false; reason: 'missing' | 'invalid'; errors: string[] };

/** summary.json as read from the bucket (null when it is not there): size first, then the format. */
export function checkSummaryBody(body: string | null): SummaryCheck {
  if (body === null) return { ok: false, reason: 'missing', errors: [] };
  const c = parseChecked('summary', body, validateSummary);
  return c.ok ? { ok: true, body, summary: c.value } : { ok: false, reason: 'invalid', errors: c.errors };
}

/** The public counters (migration 0008_live.sql); zeros before the row exists. */
export async function liveCounts(db: SqlDb): Promise<{ matches: number; decisions: number }> {
  const row = await db.prepare('SELECT matches, decisions FROM live_counts WHERE id = 1').first<{ matches: number; decisions: number }>();
  return { matches: Number(row?.matches ?? 0), decisions: Number(row?.decisions ?? 0) };
}

/** The answer of GET /api/live. */
export async function liveAnswer(db: SqlDb, summaryBody: string | null, current: string, adapt: boolean, now: number): Promise<Live> {
  const counts = await liveCounts(db);
  const s = checkSummaryBody(summaryBody);
  return {
    schema: LIVE_SCHEMA,
    at: now,
    matches: counts.matches,
    decisions: counts.decisions,
    current,
    adapt,
    humansVsZap: s.ok ? { matches: s.summary.humansVsZap.matches, humanWins: s.summary.humansVsZap.humanWins } : null,
  };
}

/** The bundled default model as the Worker ships it (ai/models/bootstrap/manifest-v2.json). */
export interface BundledInfo {
  label: string;
  features: string;
  adapt: unknown;
}

/**
 * The version on the AI seats now and whether it reads the match: "heuristic" (never reading) when
 * AI_MODE is heuristic; else the manifest's current version, or the bundled label before the first
 * manifest. The reading is on only with AI_ADAPT "on" and a features v2 model with a safety net
 * (the rooms' rule, worker/src/ai-select.ts and ai/src/safety.ts).
 */
export function servedNow(mode: string | undefined, adaptVar: string | undefined, manifest: Manifest | null, bundled: BundledInfo): { current: string; adapt: boolean } {
  if (mode === 'heuristic') return { current: 'heuristic', adapt: false };
  const entry = manifest ? manifest.models[manifest.current] : null;
  const current = manifest ? manifest.current : bundled.label;
  const info = entry ?? (current === bundled.label ? bundled : null);
  const adapt = adaptVar === 'on' && info !== null && info.features === 'v2' && isSafetyNet(info.adapt);
  return { current, adapt };
}

/** The part of the Cache API used here (caches.default in the Worker). */
export interface PublicCache {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, res: Response): Promise<void>;
}

/**
 * An answer through the cache: a stored one when the location has it, else a fresh one, stored
 * for its own max-age (the response's cache-control) while it is sent. Without a cache (local test
 * sites) every request makes a fresh answer.
 */
export async function throughCache(cache: PublicCache | null, key: Request, make: () => Promise<Response>, keep: (p: Promise<unknown>) => void): Promise<Response> {
  if (cache) {
    const hit = await cache.match(key).catch(() => undefined);
    if (hit) return hit;
  }
  const res = await make();
  // Only a public answer is kept: a failure (no-store) is made again on the next request.
  if (cache && (res.headers.get('cache-control') ?? '').startsWith('public')) keep(cache.put(key, res.clone()).catch(() => undefined));
  return res;
}

/** The cache-control of a public answer: shared caches and the browser may keep it this long. */
export const publicCacheControl = (maxAgeS: number): string => `public, max-age=${maxAgeS}`;

const warned = new Set<string>();

/** Logs a refused summary.json once per isolate and file (its etag). */
export function warnSummaryOnce(tag: string, errors: string[], warn: (msg: string) => void = (m) => console.warn(m)): void {
  if (warned.has(tag)) return;
  warned.add(tag);
  warn(`public: summary.json refused (${errors.slice(0, 3).join('; ') || 'unknown reason'}); /api/summary answers no_summary`);
}
