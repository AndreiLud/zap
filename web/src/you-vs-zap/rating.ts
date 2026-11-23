// The person's rating on the personal page (DATA-SPEC 5.3), computed in the browser from the
// person's own records: one rating for 1 against 1 and one for 2 against 2, with the AI seats as
// fixed anchors (shared/rating.ts) and only the person's rating moving.
//
// Anchors per (character, version, table size), from what was measured:
//
//   v1           Zap at MU_REF; its characters from facts ai.personasByVersion.v1.stats[id].vsZap
//   a release    (facts ai.releases.<v>, the versions shipped with the code, v2 today) Zap from its
//                head to head against v1 (releases.<v>.headToHeadV1), its characters from the
//                fresh deals of its calibration check (personasByVersion.<v>.freshCheck.vsZap, the
//                numbers the data page may cite), else its calibration stats
//   a cycle      (summary.versions, versions the weekly cycle promoted) Zap from anchors.v1, its
//                characters from personas.stats
//   heuristic    the tuned rules player plays every character: Zap v1's score against it, turned
//
// A seat whose version has none of these makes the match "sem referência": listed, not rated.
// openskill (dev dependency) is the oracle of web/test/rating.test.ts; the update itself is
// shared/rating.ts rateTeams, written out because the library alone weighs 16 KB gzip.

import type { PersonaId } from '../../../ai/src/personas.ts';
import { teamOf } from '../../../engine/src/engine.ts';
import { MU_REF, MU_START, SIGMA_ANCHOR, SIGMA_START, anchorMu, heuristicMu, rateTeams, type Rating, type TeamSize } from '../../../shared/rating.ts';
import { PERSONA_IDS, PERSONA_NAMES } from '../game-text.ts';
import { personWon, type PersonMatch } from './history.ts';

/** The reference version: Zap v1 is MU_REF by definition. */
export const REF_VERSION = 'v1';
/** The label of AI seats played by the tuned rules player (AI_MODE heuristic). */
export const HEURISTIC = 'heuristic';

/** What the anchors read from web/src/data/generated/facts-view.json (shape of facts.json). */
export interface AnchorFacts {
  ai: {
    strengthByVersion?: Record<string, { table?: Record<string, { overall?: { mean: number } | null } | null> | null } | null> | null;
    personasByVersion?: Record<
      string,
      { measuredAt?: string; stats?: Record<string, { vsZap?: number } | null> | null; freshCheck?: { vsZap?: Record<string, { mean: number } | null> | null } | null } | null
    > | null;
    releases?: Record<string, { headToHeadV1?: { mean: number } | null } | null> | null;
  };
}

/** What the anchors read from /api/summary (zap-summary/2 view): versions the cycle promoted. */
export interface AnchorSummary {
  versions: { version: string; anchors: Record<string, { mean: number }> | null; personas: { stats: Partial<Record<string, { vsZap: number }>> } | null }[];
}

export interface CastMember {
  id: PersonaId;
  name: string;
  mu: number;
}

export interface AnchorBook {
  /** The mu of an AI seat, or null when its version has no measurement. */
  seat(persona: PersonaId | null, version: string | null, size: TeamSize): number | null;
  /** The six characters of a version at their anchors, in display order; null when unmeasured. */
  cast(version: string, size: TeamSize): CastMember[] | null;
}

interface VersionScores {
  /** Zap of this version against a team of Zap v1 (0.5 for v1 itself). */
  zapVsV1: number;
  /** Each character's score as a team against a team of Zap of the same version. */
  vsZap: Partial<Record<PersonaId, number>>;
}

function scoresFromFacts(facts: AnchorFacts, version: string): VersionScores | null {
  const p = facts.ai.personasByVersion?.[version];
  const vsZap: Partial<Record<PersonaId, number>> = {};
  for (const id of PERSONA_IDS) {
    if (id === 'zap') continue;
    const fresh = p?.freshCheck?.vsZap?.[id]?.mean;
    const calib = p?.stats?.[id]?.vsZap;
    const v = typeof fresh === 'number' ? fresh : calib;
    if (typeof v === 'number' && Number.isFinite(v)) vsZap[id] = v;
  }
  if (version === REF_VERSION) return { zapVsV1: 0.5, vsZap };
  const h2h = facts.ai.releases?.[version]?.headToHeadV1?.mean;
  if (typeof h2h !== 'number' || !Number.isFinite(h2h)) return null;
  return { zapVsV1: h2h, vsZap };
}

function scoresFromSummary(summary: AnchorSummary | null, version: string): VersionScores | null {
  const v = summary?.versions.find((x) => x.version === version);
  const vs1 = v?.anchors?.[REF_VERSION]?.mean;
  if (!v || typeof vs1 !== 'number') return null;
  const vsZap: Partial<Record<PersonaId, number>> = {};
  for (const id of PERSONA_IDS) {
    const s = v.personas?.stats[id]?.vsZap;
    if (id !== 'zap' && typeof s === 'number') vsZap[id] = s;
  }
  return { zapVsV1: vs1, vsZap };
}

/** The anchors of every version the page can place: facts first, then the cycle's summary. */
export function anchorBook(facts: AnchorFacts, summary: AnchorSummary | null): AnchorBook {
  const tuned = facts.ai.strengthByVersion?.[REF_VERSION]?.table?.['zap-tuned']?.overall?.mean;
  const cache = new Map<string, VersionScores | null>();
  const scores = (version: string) => {
    if (!cache.has(version)) cache.set(version, scoresFromFacts(facts, version) ?? scoresFromSummary(summary, version));
    return cache.get(version)!;
  };
  const seat = (persona: PersonaId | null, version: string | null, size: TeamSize): number | null => {
    if (version === null) return null;
    if (version === HEURISTIC) return typeof tuned === 'number' ? heuristicMu(tuned, size) : null;
    const sc = scores(version);
    if (!sc) return null;
    const zapMu = anchorMu(sc.zapVsV1, size, MU_REF);
    const id = persona ?? 'zap';
    if (id === 'zap') return zapMu;
    const s = sc.vsZap[id];
    return s === undefined ? null : anchorMu(s, size, zapMu);
  };
  return {
    seat,
    cast(version, size) {
      const out: CastMember[] = [];
      for (const id of PERSONA_IDS) {
        const mu = seat(id, version, size);
        if (mu === null) return null;
        out.push({ id, name: PERSONA_NAMES[id], mu });
      }
      return out;
    },
  };
}

// ------------------------------------------------------------------------------------------------
// The person's rating, match by match

export interface RatingPoint {
  /** Rated match number of this size, from 1. */
  n: number;
  matchId: string;
  mu: number;
  sigma: number;
}

export interface SizeRating {
  size: TeamSize;
  /** The rating after each rated match, in end time order. */
  points: RatingPoint[];
  /** Quick play matches of this size left out: some seat's version has no anchor. */
  unrated: number;
  /** The rating now: the start before any rated match. */
  now: Rating;
}

/** The table size of a quick play match, or null for any other kind. */
export function sizeOf(m: PersonMatch): TeamSize | null {
  if (m.record.kind === 'solo1') return 1;
  if (m.record.kind === 'solo2') return 2;
  return null;
}

/**
 * The teams of one match with the person first ([person, partner?] against [opponents]), every AI
 * seat at its anchor; null when some seat has no anchor.
 */
export function matchTeams(m: PersonMatch, book: AnchorBook, size: TeamSize, person: Rating): [Rating[], Rating[]] | null {
  const r = m.record;
  const mine = teamOf(m.yourSeat);
  const us: Rating[] = [person];
  const them: Rating[] = [];
  for (const s of r.seats) {
    if (s.seat === m.yourSeat) continue;
    if (s.kind !== 'ai') return null;
    const mu = book.seat(s.persona, s.aiVersion ?? r.aiVersion, size);
    if (mu === null) return null;
    (teamOf(s.seat) === mine ? us : them).push({ mu, sigma: SIGMA_ANCHOR });
  }
  return [us, them];
}

/** Both ratings of the person, from the start (openskill's default) through every rated match. */
export function rateMatches(matches: readonly PersonMatch[], book: AnchorBook): Record<TeamSize, SizeRating> {
  const out: Record<TeamSize, SizeRating> = {
    1: { size: 1, points: [], unrated: 0, now: { mu: MU_START, sigma: SIGMA_START } },
    2: { size: 2, points: [], unrated: 0, now: { mu: MU_START, sigma: SIGMA_START } },
  };
  const ordered = [...matches].sort((a, b) => a.record.endedAt - b.record.endedAt || (a.matchId < b.matchId ? -1 : a.matchId > b.matchId ? 1 : 0));
  for (const m of ordered) {
    const size = sizeOf(m);
    if (size === null) continue;
    const acc = out[size];
    const teams = matchTeams(m, book, size, acc.now);
    if (!teams) {
      acc.unrated++;
      continue;
    }
    const rank = personWon(m) ? [0, 1] : [1, 0];
    acc.now = rateTeams(teams, rank)[0][0];
    acc.points.push({ n: acc.points.length + 1, matchId: m.matchId, mu: acc.now.mu, sigma: acc.now.sigma });
  }
  return out;
}
