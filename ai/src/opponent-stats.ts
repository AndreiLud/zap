// Public statistics of each player in the current match, the inputs of features v2.
//
// Only finished hands count (the current hand is already in the v1 inputs), so the numbers
// change once per hand. Every rate is shrunk towards population priors measured in self-play
// (ai/models/opponent-priors.json, written by ai/bench/opponent-priors.ts), and the network also
// sees how many observations stand behind each rate, so it can weigh small samples.
//
// This module reads only the public history of the match (engine/src/public.ts) and the seat's
// Observation: no hidden card can reach it.
//
// Seat priors (off): encodeStats can take, per seat, a prior that replaces the population prior for
// that seat, so a person's profile from earlier matches could become the starting point of the
// in-match statistics. No harness passes one: the networks were trained with the population prior
// only, and the room builds its context with agentContext(s, noStats). Switching it on needs
// training with simulated profiles first (per player adaptation as a network input).

import { strengthTable } from '../../engine/src/cards.ts';
import type { Variant } from '../../engine/src/config.ts';
import type { Observation } from '../../engine/src/observe.ts';
import type { PublicHand, PublicHistory } from '../../engine/src/public.ts';

export type Segment = 'paulista-2' | 'paulista-4' | 'mineiro-2' | 'mineiro-4';
/** Segment order used everywhere a list of segments is indexed (also by the learner). */
export const SEGMENTS: readonly Segment[] = ['paulista-2', 'paulista-4', 'mineiro-2', 'mineiro-4'];

export interface SegmentPriors {
  raise: number;
  run: number;
  accept: number;
  reraise: number;
  shown: number;
  cover: number;
}

export interface Priors {
  version: 1;
  alpha: number;
  segments: Record<Segment, SegmentPriors>;
}

/**
 * Counts for one seat over the finished hands of the match.
 * H: normal hands. K: normal hands in which the seat asked for truco or raised (not in answer).
 * U, A, X: answers to a pending raise (run, accept, raise again).
 * S, Q: over hands in which the seat raised: sum of strength / 13 and number of the cards it showed.
 * V, W: plays covered, and plays where covering was allowed.
 */
export interface SeatCounts {
  H: number;
  K: number;
  U: number;
  A: number;
  X: number;
  S: number;
  Q: number;
  V: number;
  W: number;
}

export interface MatchCounts {
  /** Finished hands counted. */
  hands: number;
  seats: SeatCounts[];
}

export const STATS_SLOTS = 3;
export const STATS_PER_SLOT = 10;
export const STATS_SIZE = 30;
export const PRIOR_KEYS = ['raise', 'run', 'accept', 'reraise', 'shown', 'cover'] as const;

export function segmentOf(variant: Variant, players: number): Segment {
  return `${variant}-${players === 4 ? 4 : 2}` as Segment;
}

/** Throws unless every value is in (0, 1) and run + accept + reraise = 1 within 1e-6. Returns a clean copy. */
export function validateSegmentPriors(x: unknown, label = 'priors'): SegmentPriors {
  const p = x as Partial<SegmentPriors> | null;
  if (!p || typeof p !== 'object') throw new Error(`${label} missing`);
  const clean = {} as SegmentPriors;
  for (const k of PRIOR_KEYS) {
    const v = p[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v >= 1) throw new Error(`${label}.${k} must be in (0, 1)`);
    clean[k] = v;
  }
  if (Math.abs(clean.run + clean.accept + clean.reraise - 1) > 1e-6) throw new Error(`${label} answers must add up to 1`);
  return clean;
}

/** Throws on a bad shape: four segments, values in (0, 1), run + accept + reraise = 1 within 1e-6, alpha > 0. Returns a clean copy. */
export function validatePriors(x: unknown): Priors {
  const o = x as Partial<Priors> | null;
  if (!o || typeof o !== 'object') throw new Error('priors: not an object');
  if (o.version !== 1) throw new Error('priors: version must be 1');
  if (typeof o.alpha !== 'number' || !Number.isFinite(o.alpha) || o.alpha <= 0) throw new Error('priors: alpha must be positive');
  if (!o.segments || typeof o.segments !== 'object') throw new Error('priors: segments missing');
  const segments = {} as Record<Segment, SegmentPriors>;
  for (const seg of SEGMENTS) {
    const p = (o.segments as Record<string, Partial<SegmentPriors>>)[seg];
    if (!p || typeof p !== 'object') throw new Error(`priors: segment ${seg} missing`);
    segments[seg] = validateSegmentPriors(p, `priors: ${seg}`);
  }
  return { version: 1, alpha: o.alpha, segments };
}

export const emptyCounts = (): SeatCounts => ({ H: 0, K: 0, U: 0, A: 0, X: 0, S: 0, Q: 0, V: 0, W: 0 });

const strengthCache = new Map<string, number[]>();
function strengthOf(variant: Variant, manilhaRank: number): number[] {
  const key = `${variant}:${manilhaRank}`;
  let t = strengthCache.get(key);
  if (!t) {
    t = strengthTable(variant, manilhaRank);
    strengthCache.set(key, t);
  }
  return t;
}

/** Adds one finished hand to the counts of every seat. */
function addHand(h: PublicHistory, hand: PublicHand, seats: SeatCounts[]): void {
  const n = h.players;
  const normal = hand.kind === 'normal';
  const strength = strengthOf(h.variant, hand.manilhaRank);
  const faceDownFirst = h.options.faceDownFirstRound;
  let raisedMask = 0;
  let askedMask = 0;
  for (const b of hand.bets) {
    const c = seats[b.seat];
    if (b.kind === 'raise') {
      raisedMask |= 1 << b.seat;
      if (!b.answer) askedMask |= 1 << b.seat;
      else c.X++;
    } else if (b.kind === 'accept') c.A++;
    else if (b.kind === 'run') c.U++;
  }
  for (let seat = 0; seat < n; seat++) {
    if (normal) {
      seats[seat].H++;
      if ((askedMask >> seat) & 1) seats[seat].K++;
    }
  }
  for (let ri = 0; ri < hand.rounds.length; ri++) {
    for (const p of hand.rounds[ri].plays) {
      const c = seats[p.seat];
      if (hand.kind !== 'iron' && (ri > 0 || (faceDownFirst && p.seat !== hand.mao))) {
        c.W++;
        if (p.faceDown) c.V++;
      }
      if (!p.faceDown && p.card >= 0 && (raisedMask >> p.seat) & 1) {
        c.Q++;
        c.S += strength[p.card] / 13;
      }
    }
  }
}

/** Counts from scratch, without the cache (for tests and checks). */
export function countHands(h: PublicHistory): MatchCounts {
  const seats = Array.from({ length: h.players }, emptyCounts);
  for (const hand of h.hands) addHand(h, hand, seats);
  return { hands: h.hands.length, seats };
}

const cache = new WeakMap<readonly PublicHand[], MatchCounts>();

/**
 * Counts per absolute seat. Cached per list of finished hands (the public history keeps one list
 * per match and only appends to it), so each hand is processed once. Read only.
 */
export function matchCounts(h: PublicHistory): MatchCounts {
  let m = cache.get(h.hands);
  if (!m) {
    m = { hands: 0, seats: Array.from({ length: h.players }, emptyCounts) };
    cache.set(h.hands, m);
  }
  for (; m.hands < h.hands.length; m.hands++) addHand(h, h.hands[m.hands], m.seats);
  return m;
}

/** Betting evidence about one seat: hands in which it raised, plus raises it answered. */
export function seatEvidence(c: SeatCounts): number {
  return c.K + c.U + c.A + c.X;
}

/**
 * Evidence behind a decision: about the raiser when answering a raise, otherwise the least known
 * opponent. Seats in the noStats mask count as no evidence.
 */
export function decisionEvidence(obs: Observation, m: MatchCounts | null, noStats: number): number {
  if (!m) return 0;
  const E = (seat: number) => ((noStats >> seat) & 1 || !m.seats[seat] ? 0 : seatEvidence(m.seats[seat]));
  if (obs.phase === 'raise' && obs.raiser >= 0) return E(obs.raiser);
  let best = Infinity;
  for (let seat = 0; seat < obs.players; seat++) if ((seat & 1) !== (obs.seat & 1)) best = Math.min(best, E(seat));
  return Number.isFinite(best) ? best : 0;
}

const LOG33 = Math.log(33);
/** Observation count on a 0 to 1 scale: 0 for none, 0.5 near 5, 1 from 32 on. */
export function encodeCount(n: number): number {
  return Math.min(1, Math.log(1 + n) / LOG33);
}

function writeEmpty(out: Float32Array, base: number, p: SegmentPriors): void {
  out[base] = p.raise;
  out[base + 1] = p.run;
  out[base + 2] = p.accept;
  out[base + 3] = p.reraise;
  out[base + 4] = p.shown;
  out[base + 5] = p.cover;
  out[base + 6] = 0;
  out[base + 7] = 0;
  out[base + 8] = 0;
  out[base + 9] = 0;
}

function writeLive(out: Float32Array, base: number, c: SeatCounts, p: SegmentPriors, a: number): void {
  const T = c.U + c.A + c.X;
  out[base] = (c.K + a * p.raise) / (c.H + a);
  out[base + 1] = (c.U + a * p.run) / (T + a);
  out[base + 2] = (c.A + a * p.accept) / (T + a);
  out[base + 3] = (c.X + a * p.reraise) / (T + a);
  out[base + 4] = (c.S + a * p.shown) / (c.Q + a);
  out[base + 5] = (c.V + a * p.cover) / (c.W + a);
  out[base + 6] = encodeCount(c.H);
  out[base + 7] = encodeCount(T);
  out[base + 8] = encodeCount(c.Q);
  out[base + 9] = encodeCount(c.W);
}

/**
 * Writes the 30 statistics at out[offset]: for the next seat, the partner and the previous seat
 * (relative to obs.seat), 10 numbers each. In 1 against 1 only the first slot is filled; empty
 * slots, seats in noStats and m null read the population priors and four zero counts.
 *
 * seatPriors (off, no harness passes it): per absolute seat, a prior for obs's segment that replaces
 * the population prior of that seat's live slot, with the same weight priors.alpha; null or absent
 * keeps the population prior. Before any finished hand the slot then reads that prior with zero
 * counts. The no-evidence block (m null, a masked seat, an empty slot) never uses it, and the
 * evidence n of the safety net counts only the match itself, so with a safety net a seat prior
 * changes nothing at n = 0.
 */
export function encodeStats(
  out: Float32Array,
  offset: number,
  obs: Observation,
  m: MatchCounts | null,
  noStats: number,
  priors: Priors,
  seatPriors?: readonly (SegmentPriors | null | undefined)[],
): void {
  const n = obs.players;
  const p = priors.segments[segmentOf(obs.variant, n)];
  for (let r = 1; r <= STATS_SLOTS; r++) {
    const base = offset + (r - 1) * STATS_PER_SLOT;
    const seat = (obs.seat + r) % n;
    if (!m || (n === 2 && r > 1) || (noStats >> seat) & 1 || !m.seats[seat]) writeEmpty(out, base, p);
    else writeLive(out, base, m.seats[seat], seatPriors?.[seat] ?? p, priors.alpha);
  }
}
