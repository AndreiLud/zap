// The data behind the four chapters of the plan (DATA-SPEC 4.6 to 4.9, WP6), shaped from the
// generated files, facts-view.json and the run time summary. Pure functions with no JSX, so
// web/test/data-chapters.test.ts checks every rule here on fixtures; the chapter components only
// format and draw what these return.
//
// Run time data arrives as load.ts's SummaryState: still loading, no summary yet (GET /api/summary
// answers 404 no_summary until the weekly cycle publishes its first one), unavailable (DATA-SPEC
// 3.9) or the zap-summary/2 view.

import type { CardResult, Interval, SummaryV2 } from '../../../../shared/cycle-formats.ts';
import type { Key } from '../../i18n.ts';
import { apart, wilson, type Est } from '../words.ts';
import type { Finding } from '../findings.ts';
import type { SummaryState } from '../load.ts';

// ------------------------------------------------------------------------------------------------
// Run time inputs

/** The summary as the page has it (load.ts). */
export type SummaryLoad = SummaryState;

export function summaryOf(load: SummaryLoad): SummaryV2 | null {
  return load.kind === 'ready' ? load.summary : null;
}

const VERSION = /^v(\d+)$/;

/** A version label's number ("v12" is 12); labels that are not versions sort first. */
export function versionNumber(v: string): number {
  const m = VERSION.exec(v);
  return m ? Number(m[1]) : -1;
}

export function isVersion(v: string | null | undefined): v is string {
  return !!v && VERSION.test(v);
}

/**
 * The version on the AI seats now: what /api/live says when it is a version label, else the
 * version the build serves (facts-view served.version). "heuristic" (AI_MODE heuristic) has no
 * numbers of its own, so the served file's numbers stand in.
 */
export function servedVersion(liveVersion: string | null | undefined, built: string): string {
  return isVersion(liveVersion) ? liveVersion : built;
}

// ------------------------------------------------------------------------------------------------
// facts-view.json, the parts this chapter reads (WP1 writes it; see tools/data/facts-view.ts)

export interface Overall {
  mean: number;
  ci95: [number, number];
  pairs: number;
}

export interface StrengthBlock {
  measuredAt: string;
  pairsPerSegment: number;
  table: Record<string, { overall: Overall } | undefined>;
}

export interface PersonaStatsView {
  trucoRate: number;
  bluffRate: number;
  runRate: number;
  reraiseRate: number;
  signalTruth: number;
  vsZap: number;
  vsZapSe: number;
  vsZapCi95?: [number, number];
  hands: number;
}

export interface FreshVsZap {
  pairsPerSegment: number;
  vsZap: Record<string, { mean: number; ci95: [number, number] } | undefined>;
}

export interface PersonasBlock {
  measuredAt: string;
  pairsPerSegment: number;
  stats: Record<string, PersonaStatsView | undefined>;
  freshCheck?: FreshVsZap;
}

export interface FactsView {
  provenance: { measuredAt: string };
  served: { version: string; readsOpponents: boolean };
  ai: {
    strengthByVersion: Record<string, StrengthBlock | undefined>;
    personasByVersion: Record<string, PersonasBlock | undefined>;
    releases: Record<string, { date: string; version: string; gate?: { pass: boolean } } | undefined>;
    bootstrapModel: { version: string; createdAt: string; previous?: { version: string; createdAt: string } };
    adaptation?: { switchOnCheck?: { measuredAt: string; personas?: { freshCheck?: FreshVsZap } } | null } | null;
  };
}

const estOf = (o: Overall): Est & { pairs: number } => ({ mean: o.mean, lo: o.ci95[0], hi: o.ci95[1], pairs: o.pairs });
const estOfInterval = (i: Interval): Est => ({ mean: i.mean, lo: i.lo, hi: i.hi });

// ------------------------------------------------------------------------------------------------
// F16 strength against fixed rivals, by version

/** The rivals of F16, in row order: the three fixed players and v1, the version every gate meets. */
export const RIVALS = ['random', 'heuristic', 'tuned', 'v1'] as const;
export type Rival = (typeof RIVALS)[number];

export interface VersionStrength {
  version: string;
  rows: Partial<Record<Rival, Est & { pairs?: number }>>;
  /** Where the numbers come from (facts.json with its date, or the gate through the summary). */
  source: 'facts' | 'summary';
  measuredAt: number | null;
  /** Duplicate pairs behind each row (facts), or null (the summary keeps intervals only). */
  pairs: number | null;
}

const FACT_ROW: Record<Rival, string> = { random: 'zap-random', heuristic: 'zap-heuristic', tuned: 'zap-tuned', v1: 'zap-v1' };
const ANCHOR_ROW: Record<Rival, 'random' | 'base' | 'tuned' | 'v1'> = { random: 'random', heuristic: 'base', tuned: 'tuned', v1: 'v1' };

/**
 * Every version with numbers against the rivals, oldest first. facts.json holds the versions the
 * project measured itself (v1 and the bundled v2, 4,000 pairs each); the summary's anchors (the
 * gate's panel) add the versions the weekly cycle promotes. A version never meets itself.
 */
export function versionStrengths(fv: Pick<FactsView, 'ai'>, summary: SummaryV2 | null): VersionStrength[] {
  const out = new Map<string, VersionStrength>();
  for (const [version, block] of Object.entries(fv.ai.strengthByVersion)) {
    if (!block || !isVersion(version)) continue;
    const rows: VersionStrength['rows'] = {};
    let pairs: number | null = null;
    for (const r of RIVALS) {
      if (r === version) continue;
      const cell = block.table[FACT_ROW[r]];
      if (!cell) continue;
      rows[r] = estOf(cell.overall);
      pairs ??= cell.overall.pairs;
    }
    if (Object.keys(rows).length > 0) out.set(version, { version, rows, source: 'facts', measuredAt: Date.parse(block.measuredAt), pairs });
  }
  for (const v of summary?.versions ?? []) {
    if (out.has(v.version) || !v.anchors) continue;
    const rows: VersionStrength['rows'] = {};
    for (const r of RIVALS) {
      if (r === v.version) continue;
      const a = v.anchors[ANCHOR_ROW[r]];
      if (a) rows[r] = estOfInterval(a);
    }
    if (Object.keys(rows).length > 0) out.set(v.version, { version: v.version, rows, source: 'summary', measuredAt: v.promotedAt, pairs: null });
  }
  return [...out.values()].sort((a, b) => versionNumber(a.version) - versionNumber(b.version));
}

/** Which series each version wears in F16: the one in play 1, the two newest others 2 and 0, the rest 0 quiet. */
export function versionSeries(versions: readonly string[], inPlay: string): Map<string, { series: 0 | 1 | 2; shape: 'circle' | 'square' | 'diamond'; labeled: boolean }> {
  const out = new Map<string, { series: 0 | 1 | 2; shape: 'circle' | 'square' | 'diamond'; labeled: boolean }>();
  const others = versions.filter((v) => v !== inPlay).sort((a, b) => versionNumber(b) - versionNumber(a));
  if (versions.includes(inPlay)) out.set(inPlay, { series: 1, shape: 'circle', labeled: true });
  others.forEach((v, i) => {
    if (i === 0) out.set(v, { series: 2, shape: 'square', labeled: true });
    else if (i === 1) out.set(v, { series: 0, shape: 'diamond', labeled: true });
    else out.set(v, { series: 0, shape: 'circle', labeled: false });
  });
  return out;
}

// ------------------------------------------------------------------------------------------------
// F17 people against Zap: by mode, and week by week

export interface ModeRow {
  key: string;
  variant: 'paulista' | 'mineiro';
  players: 2 | 4;
  aiVersion: string;
  partnerVersion: string | null;
  people: number;
  matches: number;
  wins: number;
  est: Est;
}

/** The scoreboard rows (each with at least the public minimum of people), with Wilson intervals. */
export function modeRows(summary: SummaryV2): ModeRow[] {
  return summary.scoreboard
    .filter((r) => r.matches > 0)
    .map((r) => ({
      key: `${r.variant}-${r.players}-${r.aiVersion}-${r.partnerVersion ?? 'solo'}`,
      variant: r.variant,
      players: r.players,
      aiVersion: r.aiVersion,
      partnerVersion: r.partnerVersion,
      people: r.people,
      matches: r.matches,
      wins: r.humanWins,
      est: wilson(r.humanWins, r.matches),
    }))
    .sort((a, b) => (a.variant === b.variant ? a.players - b.players || versionNumber(b.aiVersion) - versionNumber(a.aiVersion) : a.variant === 'paulista' ? -1 : 1));
}

/** F17 by mode: where people win most, when its interval is apart from where they win least. */
export function modesTitle(rows: readonly ModeRow[]): { key: Key; row: ModeRow | null } {
  if (rows.length < 2) return { key: 'data.f17.modes.h.one', row: rows[0] ?? null };
  const sorted = [...rows].sort((a, b) => b.est.mean - a.est.mean);
  const top = sorted[0];
  const low = sorted[sorted.length - 1];
  if (apart(top.est, low.est)) return { key: 'data.f17.modes.h.top', row: top };
  return { key: 'data.f17.modes.h.same', row: null };
}

export interface WeekSeries {
  key: string;
  variant: 'paulista' | 'mineiro';
  players: 2 | 4;
  points: { week: string; index: number; matches: number; wins: number; est: Est }[];
}

/** Weekly people's win share by mode, from summary.cells (wins rounded from the published rate). */
export function weekSeries(summary: SummaryV2): { weeks: string[]; series: WeekSeries[] } {
  const weeks = [...new Set(summary.cells.map((c) => c.week))].sort();
  const by = new Map<string, WeekSeries>();
  for (const c of summary.cells) {
    if (c.matches <= 0) continue;
    const key = `${c.variant}-${c.players}`;
    let s = by.get(key);
    if (!s) {
      s = { key, variant: c.variant, players: c.players, points: [] };
      by.set(key, s);
    }
    const wins = Math.round(c.humanWinRate * c.matches);
    s.points.push({ week: c.week, index: weeks.indexOf(c.week), matches: c.matches, wins, est: wilson(wins, c.matches) });
  }
  const order = (s: WeekSeries) => (s.variant === 'paulista' ? 0 : 2) + (s.players === 2 ? 0 : 1);
  const series = [...by.values()].sort((a, b) => order(a) - order(b));
  for (const s of series) s.points.sort((a, b) => a.index - b.index);
  return { weeks, series };
}

/** F17 week by week: the first week against the last, every mode pooled; a change only when apart. */
export function weeksTitle(series: readonly WeekSeries[], weeks: readonly string[]): Key {
  const at = (w: string) => {
    const pts = series.flatMap((s) => s.points.filter((p) => p.week === w));
    const n = pts.reduce((a, p) => a + p.matches, 0);
    const k = pts.reduce((a, p) => a + p.wins, 0);
    return wilson(k, n);
  };
  if (weeks.length < 2) return 'data.f17.weeks.h.same';
  const first = at(weeks[0]);
  const last = at(weeks[weeks.length - 1]);
  if (!apart(first, last)) return 'data.f17.weeks.h.same';
  return last.mean > first.mean ? 'data.f17.weeks.h.up' : 'data.f17.weeks.h.down';
}

// ------------------------------------------------------------------------------------------------
// F18 human data against the twin

export interface TwinRow {
  version: string;
  est: Est;
  pairs: number;
  validMatches: number;
  people: number | null;
}

/** Versions trained with people's games that have a twin comparison, oldest first. */
export function twinRows(summary: SummaryV2): TwinRow[] {
  return summary.versions
    .filter((v) => (v.data?.validMatches ?? 0) > 0 && v.twin)
    .map((v) => ({ version: v.version, est: estOfInterval(v.twin!), pairs: v.twin!.pairs, validMatches: v.data!.validMatches, people: v.data!.people }))
    .sort((a, b) => versionNumber(a.version) - versionNumber(b.version));
}

// ------------------------------------------------------------------------------------------------
// F19 version history

export interface HistoryItem {
  version: string;
  /** When it went live (ms), or null when no source says. */
  date: number | null;
  result: CardResult;
  /** Games won against the tuned rules player. */
  tuned: Est | null;
  data: { validMatches: number; people: number | null } | null;
  ab: SummaryV2['ab'];
  inPlay: boolean;
}

/** Every version the site served, newest first: the summary's list joined with facts.json's releases. */
export function historyItems(fv: Pick<FactsView, 'ai'>, summary: SummaryV2 | null, inPlay: string): HistoryItem[] {
  const items = new Map<string, HistoryItem>();
  const tunedOf = (v: string): Est | null => {
    const cell = fv.ai.strengthByVersion[v]?.table['zap-tuned'];
    return cell ? estOf(cell.overall) : null;
  };
  // The bundled versions facts.json knows: the first model, and every release with its gate.
  const bm = fv.ai.bootstrapModel;
  const first = bm.previous && versionNumber(bm.previous.version) < versionNumber(bm.version) ? bm.previous : bm;
  const firstVersion = Object.keys(fv.ai.strengthByVersion).filter(isVersion).sort((a, b) => versionNumber(a) - versionNumber(b))[0];
  if (firstVersion && !fv.ai.releases[firstVersion]) {
    items.set(firstVersion, {
      version: firstVersion,
      date: first.version === firstVersion ? Date.parse(first.createdAt) : null,
      result: 'bootstrap',
      tuned: tunedOf(firstVersion),
      data: null,
      ab: null,
      inPlay: firstVersion === inPlay,
    });
  }
  for (const [version, rel] of Object.entries(fv.ai.releases)) {
    if (!rel || !isVersion(version)) continue;
    items.set(version, {
      version,
      date: Date.parse(rel.date),
      result: rel.gate?.pass === false ? 'rejected' : 'promoted',
      tuned: tunedOf(version),
      data: null,
      ab: null,
      inPlay: version === inPlay,
    });
  }
  for (const v of summary?.versions ?? []) {
    const known = items.get(v.version);
    const tuned = tunedOf(v.version) ?? (v.anchors?.tuned ? estOfInterval(v.anchors.tuned) : null);
    items.set(v.version, {
      version: v.version,
      date: v.promotedAt || known?.date || null,
      result: v.result,
      tuned,
      data: v.data,
      ab: summary?.ab && summary.ab.version === v.version ? summary.ab : null,
      inPlay: v.version === inPlay,
    });
  }
  return [...items.values()].filter((i) => i.result !== 'rejected').sort((a, b) => versionNumber(b.version) - versionNumber(a.version));
}

// ------------------------------------------------------------------------------------------------
// F21, the "Responder" view

/**
 * Whether Zap runs less as the bet grows: the share that does not run at the truco step against
 * the highest step with enough answers, every hand strength pooled; a direction only when apart.
 */
export function answerTitle(answerMap: readonly (readonly { n: number; p: number }[])[], minN = 200): Key {
  const steps = answerMap[0]?.length ?? 0;
  const pool = (s: number) => {
    const n = answerMap.reduce((a, row) => a + (row[s]?.n ?? 0), 0);
    const k = answerMap.reduce((a, row) => a + (row[s] ? row[s].n * row[s].p : 0), 0);
    return { n, est: wilson(k, n) };
  };
  const first = pool(0);
  let top = -1;
  for (let s = steps - 1; s > 0; s--) {
    if (pool(s).n >= minN) {
      top = s;
      break;
    }
  }
  if (first.n < minN || top < 0) return 'data.f21.h.answer.same';
  const last = pool(top);
  if (!apart(first.est, last.est)) return 'data.f21.h.answer.same';
  return last.est.mean > first.est.mean ? 'data.f21.h.answer.more' : 'data.f21.h.answer.less';
}

// ------------------------------------------------------------------------------------------------
// F15 the break even chance, on the scores a variant can reach

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * Scores a team can hold below the threshold: multiples of the greatest common divisor of every
 * value a hand can give (the ladder, the threshold hand and the points for running from it).
 * Mineiro moves in twos, so its odd scores never happen and the figure leaves them out.
 */
export function reachableScores(values: readonly number[], threshold: number): number[] {
  const g = values.reduce((a, v) => gcd(a, v), 0) || 1;
  const out: number[] = [];
  for (let s = 0; s < threshold; s += g) out.push(s);
  return out;
}

/** The grid of F15 restricted to the reachable scores ([your score][their score]). */
export function breakEvenGrid(grid: readonly (readonly number[])[], scores: readonly number[]): (number | null)[][] {
  return scores.map((a) => scores.map((b) => grid[a]?.[b] ?? null));
}

// ------------------------------------------------------------------------------------------------
// F24 to F26, the layers that turn on with people

/** The layers F24 lists, in order (adaptation and flags are not public parts). */
export const PUBLIC_LAYERS = ['humanModel', 'priors', 'playerTypes', 'ranking', 'openData'] as const;
export type PublicLayer = (typeof PUBLIC_LAYERS)[number];

export interface Thresholds {
  human_model_matches: number;
  human_model_devices: number;
  priors_people: number;
  player_types_devices: number;
  ranking_people: number;
  ranking_matches_each: number;
  open_data_matches: number;
}

export interface LayerMeter {
  /** What is counted. */
  unit: 'matches' | 'people';
  /** The count; null when it is not public (people under the minimum) or not known yet. */
  value: number | null;
  needed: number;
}

export interface LayerState {
  key: PublicLayer;
  on: boolean;
  meters: LayerMeter[];
  /** Ranking: people needed and games each (its mark is said in words). */
  each?: { people: number; matches: number };
}

/**
 * The meters of each public layer from summary.layers.<key>.progress; a mark the summary leaves out
 * comes from the cycle's thresholds (cycle-rules.json). Without a summary every count is unknown.
 */
export function layerStates(summary: SummaryV2 | null, th: Thresholds): LayerState[] {
  const prog = (k: PublicLayer) => summary?.layers[k]?.progress ?? {};
  const num = (v: number | null | undefined) => (v === undefined || v === null ? null : v);
  const need = (v: number | null | undefined, fallback: number) => (typeof v === 'number' && v > 0 ? v : fallback);
  const on = (k: PublicLayer) => summary?.layers[k]?.on ?? false;
  const hm = prog('humanModel');
  const pr = prog('priors');
  const pt = prog('playerTypes');
  const rk = prog('ranking');
  const od = prog('openData');
  const rankPeople = need(rk.peopleNeeded, th.ranking_people);
  const rankEach = need(rk.matchesEach, th.ranking_matches_each);
  return [
    {
      key: 'humanModel',
      on: on('humanModel'),
      meters: [
        { unit: 'matches', value: num(hm.matches), needed: need(hm.matchesNeeded, th.human_model_matches) },
        { unit: 'people', value: num(hm.people), needed: need(hm.peopleNeeded, th.human_model_devices) },
      ],
    },
    { key: 'priors', on: on('priors'), meters: [{ unit: 'people', value: num(pr.people), needed: need(pr.peopleNeeded, th.priors_people) }] },
    { key: 'playerTypes', on: on('playerTypes'), meters: [{ unit: 'people', value: num(pt.people), needed: need(pt.peopleNeeded, th.player_types_devices) }] },
    {
      key: 'ranking',
      on: on('ranking'),
      meters: [{ unit: 'matches', value: num(rk.matches), needed: rankPeople * rankEach }],
      each: { people: rankPeople, matches: rankEach },
    },
    { key: 'openData', on: on('openData'), meters: [{ unit: 'matches', value: num(od.matches), needed: need(od.matchesNeeded, th.open_data_matches) }] },
  ];
}

// ------------------------------------------------------------------------------------------------
// F25 player types

export const TYPE_KEYS = ['raise', 'run', 'accept', 'reraise', 'shown', 'cover', 'bluff', 'signalTruth'] as const;

const logit = (p: number) => Math.log(Math.min(1 - 1e-6, Math.max(1e-6, p)) / (1 - Math.min(1 - 1e-6, Math.max(1e-6, p))));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/**
 * The people's average of each reading number, from the published types: the share weighted mean
 * in logit space (where the cycle fits the types), accept as 1 minus run and reraise as the cycle
 * publishes it. The types' own population reference is not published.
 */
export function typesAverage(types: readonly { share: number; center: Record<string, number> }[]): Record<(typeof TYPE_KEYS)[number], number> {
  const total = types.reduce((a, t) => a + t.share, 0) || 1;
  const avg = (k: string) => sigmoid(types.reduce((a, t) => a + t.share * logit(t.center[k] ?? 0.5), 0) / total);
  const out = {} as Record<(typeof TYPE_KEYS)[number], number>;
  for (const k of TYPE_KEYS) if (k !== 'accept') out[k] = avg(k);
  out.accept = Math.max(0, 1 - out.run - out.reraise);
  return out;
}

// ------------------------------------------------------------------------------------------------
// F27 paulista against mineiro

export interface VariantCell {
  wins: number;
  n: number;
}

/** summary.cells pooled over weeks, by variant and table size (wins rounded from the rate). */
export function variantCells(summary: SummaryV2): Record<'paulista' | 'mineiro', { two: VariantCell | null; four: VariantCell | null; all: VariantCell | null }> {
  const pool = (variant: 'paulista' | 'mineiro', players?: 2 | 4): VariantCell | null => {
    const cells = summary.cells.filter((c) => c.variant === variant && (players === undefined || c.players === players) && c.matches > 0);
    if (cells.length === 0) return null;
    return { wins: cells.reduce((a, c) => a + Math.round(c.humanWinRate * c.matches), 0), n: cells.reduce((a, c) => a + c.matches, 0) };
  };
  return {
    paulista: { two: pool('paulista', 2), four: pool('paulista', 4), all: pool('paulista') },
    mineiro: { two: pool('mineiro', 2), four: pool('mineiro', 4), all: pool('mineiro') },
  };
}

// ------------------------------------------------------------------------------------------------
// F22 the characters

export interface CharacterNumbers {
  id: string;
  rates: { trucoRate: number; bluffRate: number; runRate: number; signalTruth: number } | null;
  /** Games won as a team against a team of Zap, with its 95% interval. */
  vsZap: Est | null;
  /** The interval came from a margin bound (the summary keeps the pairs only): "margem de até". */
  bound: boolean;
}

export interface CharacterSet {
  /** Where the numbers come from, for the footer. */
  source: 'summary' | 'facts' | 'adaptive';
  version: string;
  pairs: number | null;
  measuredAt: number | null;
  chars: CharacterNumbers[];
}

/**
 * The characters of the version in play (DATA-SPEC F22 with _local/m6/claims.md 10): the cycle's
 * card through the summary when it has them; else facts.json, rates from the calibration and the
 * score against Zap from the fresh deals of the gate. While the reading is on, the score against
 * Zap comes from the adaptive network's check with the statistics live (claims.md 13).
 */
export function characterSet(fv: Pick<FactsView, 'ai'>, summary: SummaryV2 | null, version: string, reads: boolean, ids: readonly string[]): CharacterSet | null {
  const card = summary?.versions.find((v) => v.version === version)?.personas;
  if (card && Object.keys(card.stats).length > 0) {
    const m = (p: number) => 1.96 * Math.sqrt((p * (1 - p)) / Math.max(1, card.pairs));
    return {
      source: 'summary',
      version,
      pairs: card.pairs,
      measuredAt: summary?.versions.find((v) => v.version === version)?.promotedAt ?? null,
      chars: ids.map((id) => {
        const s = card.stats[id as keyof typeof card.stats];
        return {
          id,
          rates: s ? { trucoRate: s.trucoRate, bluffRate: s.bluffRate, runRate: s.runRate, signalTruth: s.signalTruth } : null,
          vsZap: s ? { mean: s.vsZap, lo: Math.max(0, s.vsZap - m(s.vsZap)), hi: Math.min(1, s.vsZap + m(s.vsZap)) } : null,
          bound: true,
        };
      }),
    };
  }
  const block = fv.ai.personasByVersion[version];
  if (!block) return null;
  const adaptive = reads ? fv.ai.adaptation?.switchOnCheck?.personas?.freshCheck : undefined;
  const fresh = adaptive ?? block.freshCheck;
  return {
    source: adaptive ? 'adaptive' : 'facts',
    version,
    pairs: fresh ? fresh.pairsPerSegment * 4 : block.pairsPerSegment * 4,
    measuredAt: Date.parse(adaptive ? fv.ai.adaptation!.switchOnCheck!.measuredAt : block.measuredAt),
    chars: ids.map((id) => {
      const s = block.stats[id];
      const f = fresh?.vsZap[id];
      const vsZap: Est | null = f
        ? { mean: f.mean, lo: f.ci95[0], hi: f.ci95[1] }
        : s
          ? { mean: s.vsZap, lo: s.vsZapCi95?.[0] ?? s.vsZap - 1.96 * s.vsZapSe, hi: s.vsZapCi95?.[1] ?? s.vsZap + 1.96 * s.vsZapSe }
          : null;
      return { id, rates: s ? { trucoRate: s.trucoRate, bluffRate: s.bluffRate, runRate: s.runRate, signalTruth: s.signalTruth } : null, vsZap, bound: false };
    }),
  };
}

/** A finding with no variables (for titles chosen here, outside findings.ts). */
export const plain = (key: Key): Finding => ({ key, vars: {} });
