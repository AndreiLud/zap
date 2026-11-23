// Data driven titles (DATA-SPEC 3.8 and section 4). One pure function per title: it reads the data
// and its uncertainty and returns the locale key of the variant that the data supports, with its
// variables already formatted. No title may claim a direction that its interval does not support:
// "rises", "beats", "more" and "less" need the interval to leave the reference out, otherwise the
// function picks the "within noise" variant. web/test/data-findings.test.ts checks every variant
// and, with random inputs, that rule.
//
// Inputs are plain numbers shaped by the pages from facts-view.json, the generated files and the
// run time answers, so the rules here do not depend on where a number was stored. Shares are in
// 0 to 1; differences of mean score are in score units (0.01 is one game in every 100).
//
// The reading of the opponent (F6 to F9) has two sets of words: `reads` true when the version in
// play reads during the match (live.adapt, or facts' AI_ADAPT before /api/live answers), false
// when it does not; then the titles speak of "the test version" and never of the Zap that plays.

import type { Key, Vars } from '../i18n.ts';
import { digitsFor, halfWidth, type Digits, type Format } from './format.ts';
import { above, apart, below, likely, wilson, type Est } from './words.ts';

export interface Finding {
  key: Key;
  vars: Vars;
}

const fd = (key: Key, vars: Vars = {}): Finding => ({ key, vars });

/** Fills a finding with its text lookup. */
export function say(f: Format, x: Finding): string {
  return f.text(x.key, x.vars);
}

/** Pooled mean of rows weighted by their observations, with a binomial bound for the half width. */
export function pooled(rows: readonly { n: number; mean: number }[]): { mean: number; n: number; half95: number } {
  const n = rows.reduce((s, r) => s + r.n, 0);
  if (n <= 0) return { mean: 0, n: 0, half95: 1 };
  const mean = rows.reduce((s, r) => s + r.n * r.mean, 0) / n;
  return { mean, n, half95: 1.96 * Math.sqrt(Math.max(0, mean * (1 - mean)) / n) };
}

const dig = (e: Pick<Est, 'lo' | 'hi'>): Digits => digitsFor(halfWidth(e.lo, e.hi));
const wholeOrOne = (f: Format, v: number) => (Number.isInteger(v) ? f.int(v) : f.num(v, 1));

// ------------------------------------------------------------------------------------------------
// Cover

export interface SummaryVersionsLike {
  versions: readonly { result: string; data: { validMatches: number } | null }[];
}

/** H1: "now it learns from people" only once a promoted version was trained with people's games. */
export function h1Title(summary: SummaryVersionsLike | null): Finding {
  const people = summary?.versions.some((v) => v.result === 'promoted' && (v.data?.validMatches ?? 0) > 0) ?? false;
  return fd(people ? 'data.h1.people' : 'data.h1.selfplay');
}

// ------------------------------------------------------------------------------------------------
// F3 the training curve

export interface CurvePoint {
  iteration: number;
  mean: number;
  /** Largest possible 95% half width of the point (DATA-SPEC 2.1.3). */
  half95: number;
}

const noise2 = (a: CurvePoint, b: CurvePoint) => Math.sqrt(a.half95 ** 2 + b.half95 ** 2);

/**
 * Fast then slow when the first third of the points climbs at least 3 times faster per step than
 * the rest; a climb is said only when it is larger than the margins of its two ends.
 */
export function curveTitle(points: readonly CurvePoint[], f: Format): Finding {
  const p = [...points].sort((a, b) => a.iteration - b.iteration);
  if (p.length === 0) return fd('data.curve.h.flat', { a: f.pct(0, 0) });
  const first = p[0];
  const last = p[p.length - 1];
  const d = digitsFor(Math.max(first.half95, last.half95));
  const total = last.mean - first.mean;
  if (p.length < 2 || Math.abs(total) <= noise2(first, last)) {
    const avg = p.reduce((s, x) => s + x.mean, 0) / p.length;
    return fd('data.curve.h.flat', { a: f.pct(avg, d) });
  }
  if (total < 0) return fd('data.curve.h.fell', { a: f.pct(first.mean, d), b: f.pct(last.mean, d) });
  const b = Math.max(1, Math.ceil(p.length / 3) - 1);
  if (b < p.length - 1) {
    const pivot = p[b];
    const slopeFirst = (pivot.mean - first.mean) / Math.max(1, pivot.iteration - first.iteration);
    const slopeRest = (last.mean - pivot.mean) / Math.max(1, last.iteration - pivot.iteration);
    if (slopeFirst > 0 && slopeFirst >= 3 * Math.max(0, slopeRest) && pivot.mean - first.mean > noise2(first, pivot)) {
      const rest = last.mean - pivot.mean;
      if (rest > noise2(pivot, last)) return fd('data.curve.h.fastThenSlow');
      if (rest >= -noise2(pivot, last)) return fd('data.curve.h.fastThenFlat');
    }
  }
  return fd('data.curve.h.steady', { a: f.pct(first.mean, d), b: f.pct(last.mean, d) });
}

// ------------------------------------------------------------------------------------------------
// F6 to F9, the reading

/** F6: the budget is 0 without evidence and half of its cap at nHalf pieces of evidence. */
export function evidenceTitle(x: { nHalf: number; reads: boolean }, f: Format): Finding {
  const one = x.nHalf === 1;
  const key = x.reads ? (one ? 'data.read.f6.h.one' : 'data.read.f6.h') : one ? 'data.read.f6.h.test.one' : 'data.read.f6.h.test';
  return fd(key, { nHalf: wholeOrOne(f, x.nHalf) });
}

/**
 * F7: share of truco decisions whose most likely choice changed, by hand of the match (index 0 is
 * hand 1). "Grows" needs nothing at hand 1 (under half a percent) and more at hand H than at hand 2.
 */
export function readingCurveTitle(x: { values: readonly number[]; decisions?: readonly number[]; reads: boolean }, f: Format, H = 6): Finding {
  const v = x.values;
  const grows = v.length >= H && v[0] < 0.005 && v[H - 1] > v[1];
  if (!grows) return fd(x.reads ? 'data.read.f7.h.flat' : 'data.read.f7.h.flat.test');
  const n = x.decisions?.[H - 1];
  const half = n ? 1.96 * Math.sqrt((v[H - 1] * (1 - v[H - 1])) / n) : 1;
  return fd(x.reads ? 'data.read.f7.h.grows' : 'data.read.f7.h.grows.test', { h: f.int(H), p: f.pct(v[H - 1], digitsFor(half)) });
}

/** F8: what reading adds, the same network with and without it (difference of mean score). */
export function gainTitle(x: { est: Est; reads: boolean }, f: Format): Finding {
  if (above(x.est)) return fd(x.reads ? 'data.read.f8.h.gain' : 'data.read.f8.h.gain.test', { g: f.per100(x.est.mean) });
  if (below(x.est)) return fd(x.reads ? 'data.read.f8.h.loss' : 'data.read.f8.h.loss.test', { g: f.per100(Math.abs(x.est.mean)) });
  return fd(x.reads ? 'data.read.f8.h.noise' : 'data.read.f8.h.noise.test');
}

/**
 * Decimals of a bound said next to its limit (games per 100): two when one decimal would round it
 * onto the limit, so a bound of 1.046 against a limit of 1 reads "1,05" and never "1".
 */
export function boundDigits(v: number, limit: number): 1 | 2 {
  return Math.abs(v - limit) < 0.001 ? 2 : 1;
}

/**
 * A bound in games per 100 as it is shown next to its limit. Far from the limit, one decimal to
 * the nearest. Near it (boundDigits 2), two decimals rounded away from the limit, so a bound above
 * the limit never shows as the limit (1.0001 is "1,01") and one below never does either.
 */
export function boundValue(v: number, limit: number): { value: number; digits: 1 | 2 } {
  const digits = boundDigits(v, limit);
  const k = 10 ** digits;
  const x = v * 100 * k;
  const r = digits === 1 || v === limit ? Math.round(x) : v > limit ? Math.ceil(x - 1e-9) : Math.floor(x + 1e-9);
  return { value: r / k, digits };
}

/** A difference of mean score as a bare number of games per 100 ("1,05", "1"). */
export function per100Number(f: Format, v: number): string {
  const x = Math.round(v * 1000) / 10;
  return Number.isInteger(x) ? f.int(x) : f.num(x, 1);
}

/** A bound next to its limit as a bare number of games per 100, never equal to the limit unless it is. */
export function boundNumber(f: Format, v: number, limit: number, signed = false): string {
  const b = boundValue(v, limit);
  const digits = b.digits === 2 && Math.round(b.value * 10) / 10 !== b.value ? 2 : Number.isInteger(b.value) ? 0 : 1;
  return signed ? f.signed(b.value, digits) : f.num(b.value, digits);
}

/**
 * F9: the explorer test. `upper95` is the largest one sided 95% upper bound among the explorers
 * the criterion judges (what an explorer gets out of the reading), `mean` that explorer's mean,
 * `requirement` the limit of the criterion and `pass` its verdict. "Gets nothing" only when even
 * that bound is at or below zero. The bound keeps two decimals when one would round it onto the
 * limit (boundDigits), so a failing bound never reads as equal to the limit.
 */
export function explorerTitle(x: { pass: boolean; upper95: number; mean: number; requirement: number; reads: boolean; n: number }, f: Format): Finding {
  const b = boundValue(x.upper95, x.requirement);
  // A pass speaks of the n explorers measured, never of every possible player.
  if (x.pass) return x.upper95 <= 0 ? fd('data.read.f9.h.passNone', { n: f.int(x.n) }) : fd('data.read.f9.h.pass', { n: f.int(x.n), up: f.per100(b.value / 100, b.digits) });
  const lim = per100Number(f, x.requirement);
  // A mean that rounds to zero or below is not "takes on average": say the bound alone, with its unit.
  if (Math.round(x.mean * 1000) <= 0) return fd(x.reads ? 'data.read.f9.h.failOn.bound' : 'data.read.f9.h.fail.bound', { up: f.per100(b.value / 100, b.digits), lim });
  return fd(x.reads ? 'data.read.f9.h.failOn' : 'data.read.f9.h.fail', { mean: f.per100(x.mean), up: boundNumber(f, x.upper95, x.requirement), lim });
}

/**
 * Under F8: where the gap to the twin comes from. "Mostly chance between two runs" only when the
 * reading part is under half of the gap's lower end and the part that is not reading (the same
 * network without it, against the twin) cannot be told apart from a second twin landing by chance.
 */
export function floorTitle(x: { twin: Est; read: Est; rest: Est; floor: Est | null }): Finding {
  if (x.floor && x.twin.lo > 0 && x.read.hi < x.twin.lo / 2 && !apart(x.rest, x.floor)) return fd('data.read.floor.h.noise');
  return fd('data.read.floor.h');
}

/**
 * Under F8, when the head to head against the twin measured the same file: whether the reading
 * network is stronger than its twin overall (a share of the mean score, 0.5 is even). "Beats" needs
 * the whole interval above 50%; otherwise it is "not stronger", which holds below 50% and within noise.
 */
export function headToHeadTitle(h2h: Est, f: Format): Finding {
  const d = dig(h2h);
  const p = f.pct(h2h.mean, d);
  const range = f.range(h2h.lo, h2h.hi, d);
  return fd(above(h2h, 0.5) ? 'data.read.floor.h.ahead' : 'data.read.floor.h.notAhead', { p, range });
}

/**
 * Under F8, when the head to head measured the same file: the same network with the reading off
 * against the twin (a share of the mean score). That is what a table with "Don't adapt to me" faces
 * while the reading network plays (ai.adaptation.ablation.offPolicy.headToHead).
 */
export function offHeadToHead(h2h: Est, f: Format): Finding {
  const d = dig(h2h);
  return fd('data.read.floor.off', { p: f.pct(h2h.mean, d), range: f.range(h2h.lo, h2h.hi, d) });
}

/**
 * Under F9, the control explorer: the trained explorer's score against the reading network as served
 * minus the control's score against the twin (difference of mean score). "Easier to exploit" needs
 * the interval above zero; otherwise it "takes no more", which holds below zero and within noise.
 */
export function baseFinding(d: Est, f: Format): Finding {
  const range = f.per100Range(d.lo, d.hi);
  return above(d) ? fd('data.read.f9.base.more', { d: f.per100(d.mean), range }) : fd('data.read.f9.base.notMore', { range });
}

// ------------------------------------------------------------------------------------------------
// Chapter 1, the game in numbers

export interface ManilhaOdds {
  /** Chance of at least one manilha in 3 cards. */
  atLeastOne: number;
  /** Chance that a team of 2 holds at least one in its 6 cards. */
  team: number;
}

/** F10: "Quase 3 de cada 10" when both variants are below k/10; "metade" when both teams round to 50%. */
export function manilhaTitle(x: { paulista: ManilhaOdds; mineiro: ManilhaOdds }, f: Format): Finding {
  const hi = Math.max(x.paulista.atLeastOne, x.mineiro.atLeastOne);
  const k = Math.ceil(hi * 10 - 1e-12);
  const almost = x.paulista.atLeastOne < k / 10 && x.mineiro.atLeastOne < k / 10;
  const half = Math.round(x.paulista.team * 100) === 50 && Math.round(x.mineiro.team * 100) === 50;
  const team = half ? f.text('data.f10.half') : f.text('data.f10.teamBoth', { p: f.pct(x.paulista.team, 1), m: f.pct(x.mineiro.team, 1) });
  return fd(almost ? 'data.f10.h' : 'data.f10.h2', { share: f.tenths(k), team });
}

/** Strength classes: 0 to 9 the plain ranks (4 to 3), 10 to 13 the manilhas. */
export const CLASS_THREE = 9;
export const MANILHA_CLASSES = [10, 11, 12, 13] as const;

/** F11: the 3 against any unseen card, and the floor of every manilha (exact counts, so 1 decimal). */
export function cardsTitle(x: { beats: readonly number[]; c3: string }, f: Format): Finding {
  const least = Math.min(...MANILHA_CLASSES.map((c) => x.beats[c]));
  // Floor to a whole percent, strictly below the value, so "more than" stays true.
  const floor = (Math.ceil(least * 100 - 1e-9) - 1) / 100;
  return fd('data.f11.h', { card: x.c3, share: f.pct(x.beats[CLASS_THREE], 1), pm: f.pct(floor, 0) });
}

export interface ClassRow {
  cls: number;
  n: number;
  mean: number;
  lo: number;
  hi: number;
}

/**
 * F12: hands won by the best card in 1 against 1 (`mode` names it), the manilhas pooled; the table
 * shows that pooled row too (manilhaRows). The reading only when 2 against 2 sits below at every class.
 */
export function bestCardTitle(x: { one: readonly ClassRow[]; two: readonly ClassRow[]; c3: string; mode: string }, f: Format): { title: Finding; reading: Finding | null } | null {
  const three = x.one.find((r) => r.cls === CLASS_THREE);
  const man = x.one.filter((r) => (MANILHA_CLASSES as readonly number[]).includes(r.cls));
  if (!three || man.length === 0) return null;
  const pm = pooled(man);
  const title = fd('data.f12.h', { mode: x.mode, pm: f.pct(pm.mean, digitsFor(pm.half95)), card: x.c3, share: f.pct(three.mean, dig(three)) });
  const shared = x.one.filter((r) => x.two.some((s) => s.cls === r.cls));
  const lower = shared.length > 0 && shared.every((r) => {
    const s = x.two.find((q) => q.cls === r.cls)!;
    return s.hi < r.lo;
  });
  return { title, reading: lower ? fd('data.f12.read') : null };
}

export interface CountedEst extends Est {
  n: number;
}

/** A table size's row of F13 and F14: its label ("1 against 1") with its estimate. */
export interface ModeEst extends CountedEst {
  mode: string;
}

/**
 * F13: an edge for the mão only when both table sizes have their interval above 50%, an edge for
 * the last player only when both are below. The title quotes the share of the side that plays
 * first in each table size, the numbers the chart and the table show.
 */
export function positionTitle(rows: readonly [ModeEst, ModeEst], f: Format): Finding {
  const vars = () => ({ m1: rows[0].mode, a: f.pct(rows[0].mean, dig(rows[0])), m2: rows[1].mode, b: f.pct(rows[1].mean, dig(rows[1])) });
  if (rows.every((r) => above(r, 0.5))) return fd('data.f13.h.first', vars());
  if (rows.every((r) => below(r, 0.5))) return fd('data.f13.h.last', vars());
  return fd('data.f13.h.none');
}

/** F14: the side that leads and wins round 1, per table size (the "won" row of the chart). */
export function round1Title(won: readonly [ModeEst, ModeEst], f: Format): Finding {
  return fd('data.f14.h', { m1: won[0].mode, a: f.pct(won[0].mean, dig(won[0])), m2: won[1].mode, b: f.pct(won[1].mean, dig(won[1])) });
}

/**
 * F15: the break even chance at 0 to 0 and the range over the grid ([your score][their score]).
 * A model output without an interval of its own, so whole percents.
 */
export function breakEvenTitle(grid: readonly (readonly (number | null)[])[], f: Format): { title: Finding; reading: Finding | null } | null {
  const start = grid[0]?.[0];
  if (start === null || start === undefined) return null;
  let min = { v: Infinity, a: 0, b: 0 };
  let max = { v: -Infinity, a: 0, b: 0 };
  grid.forEach((row, a) =>
    row.forEach((v, b) => {
      if (v === null) return;
      if (v < min.v) min = { v, a, b };
      if (v > max.v) max = { v, a, b };
    }),
  );
  const title = fd('data.f15.h', { score: f.score(0, 0), p: f.pct(start, 0) });
  const reading =
    max.v > min.v
      ? fd('data.f15.read', { min: f.pct(min.v, 0), minUs: f.int(min.a), minThem: f.int(min.b), max: f.pct(max.v, 0), maxUs: f.int(max.a), maxThem: f.int(max.b) })
      : null;
  return { title, reading };
}

// ------------------------------------------------------------------------------------------------
// Chapter 2, how the AI progressed

/** A rival's name with its article: a fixed player, or a version label ("a v1" / "v1"). */
export function rivalName(f: Format, id: string): string {
  if (id === 'random' || id === 'heuristic' || id === 'tuned') return f.text(`data.rival.${id}`);
  return f.text('data.rival.version', { v: id });
}

/** F16, from two versions: the version in play against the rival that holds out best. */
export function rivalsTitleVersions(x: { version: string; rows: readonly { id: string; est: Est }[] }, f: Format): Finding | null {
  const toughest = [...x.rows].sort((a, b) => a.est.mean - b.est.mean)[0];
  if (!toughest) return null;
  const rival = rivalName(f, toughest.id);
  if (above(toughest.est, 0.5)) return fd('data.f16.h.versions', { v: x.version, share: f.inTen(toughest.est.mean), rival });
  if (below(toughest.est, 0.5)) return fd('data.f16.h.versions.below', { v: x.version, share: f.inTen(toughest.est.mean), rival });
  return fd('data.f16.h.versions.even', { v: x.version, rival });
}

/** F17: people against Zap since day one, with the Wilson interval in words. */
export function peopleTitle(x: { matches: number; humanWins: number }, f: Format): { title: Finding; reading: string | null } {
  if (x.matches <= 0) return { title: fd('data.f17.h.empty'), reading: null };
  const key = x.matches === 1 ? 'data.f17.h.one' : 'data.f17.h';
  const e = wilson(x.humanWins, x.matches);
  return { title: fd(key, { w: f.int(x.humanWins), m: f.int(x.matches) }), reading: likely(f.text, f, e, dig(e) === 1 ? 1 : 0) };
}

/** F18: the newest version trained with people's games against its twin; null when there is none. */
export function twinTitle(newest: { version: string; est: Est } | null): Finding {
  if (!newest) return fd('data.f18.empty');
  if (above(newest.est, 0.5)) return fd('data.f18.h.up', { v: newest.version });
  if (below(newest.est, 0.5)) return fd('data.f18.h.down', { v: newest.version });
  return fd('data.f18.h.even', { v: newest.version });
}

/** F19: how many versions so far; "trained only against itself" only when it has no people's data. */
export function historyTitle(versions: readonly { version: string; data: { validMatches: number } | null }[], f: Format): Finding {
  if (versions.length === 1) {
    const v = versions[0];
    return (v.data?.validMatches ?? 0) > 0 ? fd('data.f19.h.oneOnly', { v: v.version }) : fd('data.f19.h.one', { v: v.version });
  }
  return fd('data.f19.h.many', { n: f.int(versions.length) });
}

// ------------------------------------------------------------------------------------------------
// Chapter 3, how the AI plays

export interface StrongWeak {
  /** Character name as shown (PERSONA_NAMES). */
  name: string;
  isZap: boolean;
  strong: Est;
  weak: Est;
}

/** F20: Zap's truco rate on strong and weak hands, and who bluffs most (two names when it is a tie). */
export function bluffTitle(rows: readonly StrongWeak[], f: Format): { title: Finding; reading: Finding | null } | null {
  const zap = rows.find((r) => r.isZap);
  if (!zap) return null;
  const title = fd('data.f20.h', { strong: f.pct(zap.strong.mean, dig(zap.strong)), weak: f.pct(zap.weak.mean, dig(zap.weak)) });
  const ranked = [...rows].sort((a, b) => b.weak.mean - a.weak.mean);
  if (ranked.length < 2) return { title, reading: null };
  const [a, b] = ranked;
  const reading = apart(a.weak, b.weak)
    ? fd('data.f20.read', { name: a.name, p: f.pct(a.weak.mean, dig(a.weak)) })
    : fd('data.f20.read.two', { a: a.name, b: b.name, p: f.pct(a.weak.mean, dig(a.weak)), q: f.pct(b.weak.mean, dig(b.weak)) });
  return { title, reading };
}

/**
 * F21, "Pedir" view: the raise rate of middle hands (bins 3 to 5) well behind against well ahead.
 * Each side pools its cells by observations; the difference needs its 95% interval off zero.
 */
export function mapTitle(x: { behind: readonly { n: number; p: number }[]; ahead: readonly { n: number; p: number }[] }): Finding {
  const side = (cells: readonly { n: number; p: number }[]) => {
    const n = cells.reduce((s, c) => s + c.n, 0);
    const p = n > 0 ? cells.reduce((s, c) => s + c.n * c.p, 0) / n : 0;
    return { n, p, se2: n > 0 ? (p * (1 - p)) / n : Infinity };
  };
  const b = side(x.behind);
  const a = side(x.ahead);
  const diff = b.p - a.p;
  const half = 1.96 * Math.sqrt(b.se2 + a.se2);
  if (diff - half > 0) return fd('data.f21.h.behind');
  if (diff + half < 0) return fd('data.f21.h.ahead');
  return fd('data.f21.h.same');
}

/** F22: who gets closest to Zap (two names when the top two intervals overlap); the control check. */
export function charactersTitle(x: { chars: readonly { name: string; est: Est }[]; control: Est | null }, f: Format): { title: Finding; reading: Finding | null } | null {
  const ranked = [...x.chars].sort((a, b) => b.est.mean - a.est.mean);
  if (ranked.length === 0) return null;
  const [a, b] = ranked;
  const title = b && !apart(a.est, b.est) ? fd('data.f22.h.two', { a: a.name, b: b.name }) : fd('data.f22.h', { name: a.name });
  const c = x.control;
  const reading = c && c.lo <= 0.5 && c.hi >= 0.5 ? fd('data.f22.read', { c: f.pct(c.mean, dig(c)) }) : null;
  return { title, reading };
}

// ------------------------------------------------------------------------------------------------
// Chapter 4, how people play

/** F24: how many layers are on. */
export function layersTitle(x: { on: number; total: number }, f: Format): Finding {
  if (x.on <= 0) return fd('data.f24.h.none');
  return fd('data.f24.h.some', { k: f.int(x.on), n: f.int(x.total) });
}

/** F25: the player types, or the empty message with the people needed. */
export function typesTitle(x: { types: number | null; need: number }, f: Format): Finding {
  if (x.types === null || x.types <= 0) return fd('data.f25.empty', { need: f.int(x.need) });
  return fd('data.f25.h', { k: f.int(x.types) });
}

/** F27: paulista against mineiro, people's wins pooled over weeks; Wilson intervals must be apart. */
export function variantsTitle(x: { paulista: { wins: number; n: number } | null; mineiro: { wins: number; n: number } | null; min: number }, f: Format): Finding {
  if (!x.paulista || !x.mineiro || x.paulista.n <= 0 || x.mineiro.n <= 0) return fd('data.f27.empty', { min: f.int(x.min) });
  const p = wilson(x.paulista.wins, x.paulista.n);
  const m = wilson(x.mineiro.wins, x.mineiro.n);
  if (!apart(p, m)) return fd('data.f27.h.same');
  return fd(p.mean > m.mean ? 'data.f27.h.paulista' : 'data.f27.h.mineiro');
}

// ------------------------------------------------------------------------------------------------
// Personal page

export type AnchorId = 'otavio' | 'bento' | 'lia' | 'ravi' | 'iara' | 'zap';

export interface RatingAnchor {
  id: AnchorId;
  name: string;
  mu: number;
}

/**
 * P2: with fewer than 10 rated games, or a band (mu ± 2 sigma) that covers 3 or more characters, the
 * band is "still wide" between the characters nearest its ends; otherwise the nearest character.
 */
export function ratingTitle(x: { n: number; mu: number; sigma: number; anchors: readonly RatingAnchor[] }, f: Format): Finding | null {
  if (x.anchors.length === 0) return null;
  const lo = x.mu - 2 * x.sigma;
  const hi = x.mu + 2 * x.sigma;
  const nearest = (v: number) => [...x.anchors].sort((a, b) => Math.abs(a.mu - v) - Math.abs(b.mu - v) || a.mu - b.mu)[0];
  const covered = x.anchors.filter((a) => a.mu >= lo && a.mu <= hi).length;
  if (x.n < 10 || covered >= 3) {
    return fd(x.n === 1 ? 'data.vs.p2.h.early.one' : 'data.vs.p2.h.early', { n: f.int(x.n), a: nearest(lo).name, b: nearest(hi).name });
  }
  return fd('data.vs.p2.h', { who: f.text(`data.vs.who.${nearest(x.mu).id}`) });
}
