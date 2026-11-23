// Style counters of one person (milestone 6): what the room adds to D1 `profiles` at the end of
// each match, how the training cycle fits population priors from many people, and the reading
// "How Zap reads you" shows (GET /api/me/reading). Contract sections 1.12 and 1.13.
//
// Counting replays the match with the engine. Only the person's own decisions count, and a hand
// in which the AI moved for them (a time out, away, abandoned) counts nowhere for them. The hand
// counts (H to W) are those of the in-match statistics (ai/src/opponent-stats.ts countHands over
// the public history), so the profile and the network read the same definitions.

import { strengthTable } from '../engine/src/cards.ts';
import type { MatchConfig } from '../engine/src/config.ts';
import { A_RAISE, A_SIGNAL0, applyAction, newMatch } from '../engine/src/engine.ts';
import { observe, type Observation } from '../engine/src/observe.ts';
import { publicHistory } from '../engine/src/public.ts';
import { BASE_PARAMS, handEstimate } from '../ai/src/heuristic.ts';
import { PRIOR_KEYS, SEGMENTS, countHands, segmentOf, type Segment } from '../ai/src/opponent-stats.ts';
import type { MoveInfo } from './match-record.ts';
import { MIN_PEOPLE, READING_KEYS, READING_SEGMENT_KEYS, SCHEMAS, STRENGTH_RANGE, TIME_MU_RANGE, TIME_SCALE_RANGE, type PriorsFile, type Reading, type ReadingKey } from './cycle-formats.ts';

export { READING_KEYS, type ReadingKey, type Reading };
export type ProfilePriors = PriorsFile;

export interface ProfileCounts {
  /** Matches counted. */
  matches: number;
  /** Own decisions counted (more than one legal action). */
  D: number;
  /** As SeatCounts in ai/src/opponent-stats.ts, over the person's included hands. */
  H: number;
  K: number;
  U: number;
  A: number;
  X: number;
  S: number;
  Q: number;
  V: number;
  W: number;
  /** Raise chances with a weak hand (estimate below 1/3), and raises at them. */
  BC: number;
  BR: number;
  /** Signals sent, and true signals. */
  G: number;
  GT: number;
  /** Decision times: count, sum of ln ms, sum of (ln ms)^2. */
  TN: number;
  TL: number;
  TL2: number;
}

export const COUNT_KEYS = ['matches', 'D', 'H', 'K', 'U', 'A', 'X', 'S', 'Q', 'V', 'W', 'BC', 'BR', 'G', 'GT', 'TN', 'TL', 'TL2'] as const satisfies readonly (keyof ProfileCounts)[];

export const emptyProfile = (): ProfileCounts => ({ matches: 0, D: 0, H: 0, K: 0, U: 0, A: 0, X: 0, S: 0, Q: 0, V: 0, W: 0, BC: 0, BR: 0, G: 0, GT: 0, TN: 0, TL: 0, TL2: 0 });

/** What counting needs from a match record (a zap-match/1 or /2 record fits). */
export interface ProfileInput {
  config: MatchConfig;
  seed: string;
  log: number[];
  moves: MoveInfo[];
  seats: { kind: 'human' | 'ai' }[];
}

/** Decision times are clamped from 100 ms to 120 s before the logarithm. */
export const TIME_CLAMP_MS = [100, 120_000] as const;
/** z of the 80% interval of the reading. */
export const Z80 = 1.2815515655;
/** A number or a time shows once its 80% interval is narrower than this (30 points; 30% of the median for time). */
export const SHOW_WIDTH = 0.3;
/**
 * A number or a time also needs at least this many of the person's own observations (the fitPriors
 * cutoff), so the page never presents the population value as a reading of the person.
 */
export const MIN_SHOWN_N = 10;
/**
 * Variance of one shown card's strength / 13 around the player's own mean, measured in self-play
 * (shared/make-default-priors.ts prints it as shownCardVariance: 0.0709 over 9,272 cards of v1
 * against v1, 200 matches per segment, measured on 2026-11-22). `shown` is a mean of these values,
 * not a share of yes or no answers, so one card carries the information of 0.25 / 0.07, about 3.6,
 * answers: readingCounts weighs it so.
 */
export const SHOWN_CARD_VARIANCE = 0.07;
export const SHOWN_WEIGHT = 0.25 / SHOWN_CARD_VARIANCE;
/** In fitPriors no person counts for more than this share of a number's observations (the cycle's [data] device_cap). */
export const PRIORS_PERSON_CAP = 0.02;

/** A person's counters per rules segment (D1 keeps one row per pseudonym and segment). */
export type SegmentCounts = Partial<Record<Segment, ProfileCounts>>;
/** One person for fitPriors: the total over the segments and the counters of each segment. */
export interface PersonCounts {
  total: ProfileCounts;
  perSegment: SegmentCounts;
}

/** Whether a signal tells the truth about the hand (a copy of ai/bench/persona-stats.ts signalTrue). */
export function signalTrue(obs: Observation, sig: number): boolean {
  const st = strengthTable(obs.variant, obs.manilhaRank);
  const cards = obs.hand.filter((c) => c >= 0);
  if (sig <= 3) return cards.some((c) => st[c] === 13 - sig);
  const three = cards.some((c) => c >> 2 === 9 && st[c] < 10);
  if (sig === 4) return three;
  return !three && !cards.some((c) => st[c] >= 10);
}

const popcount = (x: number) => {
  let n = 0;
  for (let v = x >>> 0; v; v &= v - 1) n++;
  return n;
};

interface Decision {
  hand: number;
  many: boolean;
  weakChance: boolean;
  raise: boolean;
  signal: boolean;
  signalTrue: boolean;
  ms: number | null;
}

/** Counts of every human seat of one match, in seat order (rules in contract 1.12). */
export function profileCounts(r: ProfileInput): { seat: number; segment: Segment; counts: ProfileCounts }[] {
  const n = r.config.players;
  const humans = r.seats.flatMap((s, i) => (s.kind === 'human' ? [i] : []));
  if (humans.length === 0) return [];
  const isHuman = new Set(humans);
  const decisions = new Map<number, Decision[]>(humans.map((s) => [s, []]));
  const excluded = new Map<number, Set<number>>(humans.map((s) => [s, new Set()]));
  const state = newMatch(r.config, r.seed);
  for (let i = 0; i < r.log.length; i++) {
    const seat = r.log[i] >> 4;
    const action = r.log[i] & 15;
    if (isHuman.has(seat)) {
      const hand = state.handIndex;
      const move = r.moves[i];
      if (move?.auto) excluded.get(seat)!.add(hand);
      const obs = observe(state, seat);
      const chance = obs.phase === 'play' && obs.kind === 'normal' && (obs.legal & (1 << A_RAISE)) !== 0;
      const weak = chance && handEstimate(obs, BASE_PARAMS) < 1 / 3;
      decisions.get(seat)!.push({
        hand,
        many: popcount(obs.legal) > 1,
        weakChance: weak,
        raise: action === A_RAISE,
        signal: action >= A_SIGNAL0,
        signalTrue: action >= A_SIGNAL0 && signalTrue(obs, action - A_SIGNAL0),
        ms: move && !move.auto ? move.ms : null,
      });
    }
    applyAction(state, seat, action);
  }
  const history = publicHistory(state);
  const segment = segmentOf(r.config.variant, n);
  return humans.map((seat) => {
    const out = emptyProfile();
    out.matches = 1;
    const skip = excluded.get(seat)!;
    const hands = history.hands.filter((h) => !skip.has(h.index));
    const c = countHands({ ...history, hands }).seats[seat];
    Object.assign(out, { H: c.H, K: c.K, U: c.U, A: c.A, X: c.X, S: c.S, Q: c.Q, V: c.V, W: c.W });
    for (const d of decisions.get(seat)!) {
      if (skip.has(d.hand)) continue;
      if (d.many) out.D++;
      if (d.weakChance) {
        out.BC++;
        if (d.raise) out.BR++;
      }
      if (d.signal) {
        out.G++;
        if (d.signalTrue) out.GT++;
      }
      if (d.many && d.ms !== null) {
        const t = Math.log(Math.min(TIME_CLAMP_MS[1], Math.max(TIME_CLAMP_MS[0], d.ms)));
        out.TN++;
        out.TL += t;
        out.TL2 += t * t;
      }
    }
    return { seat, segment, counts: out };
  });
}

export function addCounts(a: ProfileCounts, b: ProfileCounts): ProfileCounts {
  const out = emptyProfile();
  for (const k of COUNT_KEYS) out[k] = a[k] + b[k];
  return out;
}

/** x over n for each reading number, in observations: hands, answers, cards shown, chances, signals. */
export function observationCounts(c: ProfileCounts): Record<ReadingKey, { x: number; n: number }> {
  const T = c.U + c.A + c.X;
  return {
    raise: { x: c.K, n: c.H },
    run: { x: c.U, n: T },
    accept: { x: c.A, n: T },
    reraise: { x: c.X, n: T },
    shown: { x: c.S, n: c.Q },
    cover: { x: c.V, n: c.W },
    bluff: { x: c.BR, n: c.BC },
    signalTruth: { x: c.GT, n: c.G },
  };
}

/**
 * x over n for each reading number as the beta model reads it: every number counts yes or no
 * answers, except `shown`, whose cards are weighted by SHOWN_WEIGHT (same ratio, the right noise).
 */
export function readingCounts(c: ProfileCounts): Record<ReadingKey, { x: number; n: number }> {
  const out = observationCounts(c);
  out.shown = { x: c.S * SHOWN_WEIGHT, n: c.Q * SHOWN_WEIGHT };
  return out;
}

const clamp01 = (x: number) => Math.min(0.999, Math.max(0.001, x));

/**
 * The reading numbers with a value per rules segment: the six of the in-match priors (segments)
 * and bluff (readingSegments). Signal truth exists only at 2 against 2 and stays pooled.
 */
export const SEGMENTED_KEYS: readonly ReadingKey[] = [...PRIOR_KEYS, ...READING_SEGMENT_KEYS];

/** A segmented number's population value in one rules segment. */
export function segmentValue(p: ProfilePriors, seg: Segment, key: ReadingKey): number {
  if ((READING_SEGMENT_KEYS as readonly string[]).includes(key)) return p.readingSegments[seg][key as (typeof READING_SEGMENT_KEYS)[number]];
  return p.segments[seg][key as (typeof PRIOR_KEYS)[number]];
}

/**
 * The population value each number of a person is read against. The segmented numbers (the six
 * of the in-match statistics and bluff) differ from about two to four times between 1 against 1
 * and 2 against 2, so a pooled value would read the person's mix of tables as style: their value
 * is the segments' values of the priors weighted by the person's own observations in each segment.
 * Signal truth, and a person with no observations of a number, read the pooled value.
 */
export function referenceMeans(perSegment: SegmentCounts | undefined, p: ProfilePriors): Record<ReadingKey, number> {
  const out = {} as Record<ReadingKey, number>;
  for (const key of READING_KEYS) {
    let ref = p.numbers[key].mean;
    if (perSegment && SEGMENTED_KEYS.includes(key)) {
      let num = 0;
      let den = 0;
      for (const seg of SEGMENTS) {
        const c = perSegment[seg];
        if (!c) continue;
        const n = observationCounts(c)[key].n;
        num += n * segmentValue(p, seg, key);
        den += n;
      }
      if (den > 0) ref = num / den;
    }
    out[key] = clamp01(ref);
  }
  return out;
}

/**
 * Factors that scale each person's observations down so nobody holds more than `cap` of the total
 * (at most 20 passes, as the cycle's device cap); with fewer than 1 / cap people the cap is not
 * applied.
 */
export function capFactors(n: number[], cap = PRIORS_PERSON_CAP): number[] {
  const f = n.map(() => 1);
  if (n.length < 1 / cap) return f;
  for (let pass = 0; pass < 20; pass++) {
    const total = n.reduce((s, v, i) => s + v * f[i], 0);
    let changed = false;
    for (let i = 0; i < n.length; i++) {
      if (n[i] * f[i] > cap * total * (1 + 1e-12)) {
        f[i] = (cap * total) / n[i];
        changed = true;
      }
    }
    if (!changed) break;
  }
  return f;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * "How Zap reads you": each number is a beta posterior from the population prior (its mean read
 * against the person's own mix of rules segments, referenceMeans) and the person's counts, shown
 * after at least MIN_SHOWN_N observations when its 80% interval is narrower than 30 points; the
 * decision time is a normal posterior on log ms, shown after MIN_SHOWN_N timed decisions when its
 * interval is narrower than 30% of the median. `n` is the person's observations; `population` is
 * the value the number is read against. perSegment: the person's counters per segment (without
 * them every number reads the pooled value). With noAdapt no profile is kept, so nothing is shown
 * and decisions read 0.
 */
export function readProfile(c: ProfileCounts, p: ProfilePriors, opts: { noAdapt?: boolean; now?: number; perSegment?: SegmentCounts } = {}): Reading {
  const counts = opts.noAdapt ? emptyProfile() : c;
  const rc = readingCounts(counts);
  const seen = observationCounts(counts);
  const ref = referenceMeans(opts.noAdapt ? undefined : opts.perSegment, p);
  const numbers = READING_KEYS.map((key) => {
    const { x, n } = rc[key];
    const m = ref[key];
    const k = p.numbers[key].strength;
    const a = m * k + x;
    const b = (1 - m) * k + n - x;
    const mean = a / (a + b);
    const sd = Math.sqrt((mean * (1 - mean)) / (a + b + 1));
    const low = Math.max(0, mean - Z80 * sd);
    const high = Math.min(1, mean + Z80 * sd);
    const shown = seen[key].n >= MIN_SHOWN_N && high - low < SHOW_WIDTH;
    const source: 'selfplay' | 'people' = p.source === 'people' && p.numbers[key].people !== null ? 'people' : 'selfplay';
    return { key, n: Math.round(seen[key].n), shown, value: shown ? r3(mean) : null, low: shown ? r3(low) : null, high: shown ? r3(high) : null, population: r3(m), source };
  });
  const { mu, tau, sigma } = p.time;
  const prec = 1 / tau ** 2 + counts.TN / sigma ** 2;
  const post = (mu / tau ** 2 + counts.TL / sigma ** 2) / prec;
  const sd = 1 / Math.sqrt(prec);
  const median = Math.exp(post);
  const lowMs = Math.exp(post - Z80 * sd);
  const highMs = Math.exp(post + Z80 * sd);
  const shown = counts.TN >= MIN_SHOWN_N && (highMs - lowMs) / median < SHOW_WIDTH;
  return {
    schema: SCHEMAS.reading,
    generatedAt: opts.now ?? 0,
    noAdapt: opts.noAdapt === true,
    matches: counts.matches,
    decisions: counts.D,
    priors: p.source,
    numbers,
    time: { n: counts.TN, shown, medianMs: shown ? Math.round(median) : null, lowMs: shown ? Math.round(lowMs) : null, highMs: shown ? Math.round(highMs) : null },
  };
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** x over n pooled over people, each person's share capped (capFactors). */
function cappedRate(rows: { x: number; n: number }[]): { rate: number; factors: number[] } {
  const f = capFactors(rows.map((r) => r.n));
  const sx = rows.reduce((s, r, i) => s + f[i] * r.x, 0);
  const sn = rows.reduce((s, r, i) => s + f[i] * r.n, 0);
  return { rate: sn > 0 ? sx / sn : 0.5, factors: f };
}

/**
 * Population priors from people's counts (contract 1.12): every number, the decision time and each
 * segment's in-match priors come from people only when at least minPeople people (never fewer than
 * 20) have enough observations (10); otherwise they keep the fallback's value. No person holds more
 * than 2% of a number's observations (capFactors). For the numbers with segment values
 * (SEGMENTED_KEYS), the spread between people is measured around each person's own segment mix
 * (referenceMeans), so the mix of tables is not taken for style; `shown` uses the weighted counts
 * of readingCounts. Each number from people records how many (numbers[k].people); one that keeps
 * the fallback keeps its null. createdAt and alpha are the fallback's (the caller sets createdAt).
 */
export function fitPriors(people: PersonCounts[], fallback: ProfilePriors, minPeople = 100): ProfilePriors {
  const minP = Math.max(MIN_PEOPLE, minPeople);
  const out: ProfilePriors = JSON.parse(JSON.stringify(fallback));
  let used = 0;
  // Segments first: the numbers read against them.
  for (const seg of SEGMENTS) {
    const rows = people.flatMap((p) => (p.perSegment[seg] && p.perSegment[seg]!.H >= 10 ? [p.perSegment[seg]!] : []));
    if (rows.length < minP) continue;
    const rate = (key: ReadingKey) => clamp01(cappedRate(rows.map((c) => observationCounts(c)[key])).rate);
    let run = rate('run');
    let accept = rate('accept');
    let reraise = rate('reraise');
    const total = run + accept + reraise;
    run /= total;
    accept /= total;
    reraise /= total;
    out.segments[seg] = { raise: rate('raise'), run, accept, reraise, shown: rate('shown'), cover: rate('cover') };
    if (rows.some((c) => c.BC > 0)) out.readingSegments[seg] = { bluff: rate('bluff') };
    used = Math.max(used, rows.length);
  }
  for (const key of READING_KEYS) {
    const rows = people.filter((p) => observationCounts(p.total)[key].n >= 10);
    if (rows.length < minP) continue;
    const P = rows.length;
    const counts = rows.map((p) => readingCounts(p.total)[key]);
    const { rate: m, factors: f } = cappedRate(counts);
    const segmented = SEGMENTED_KEYS.includes(key);
    const ref = rows.map((p) => (segmented ? referenceMeans(p.perSegment, out)[key] : clamp01(m)));
    const sn = counts.reduce((s, r, i) => s + f[i] * r.n, 0);
    const V = counts.reduce((s, r, i) => s + f[i] * r.n * (r.x / r.n - ref[i]) ** 2, 0) / sn;
    const E = counts.reduce((s, _, i) => s + f[i] * ref[i] * (1 - ref[i]), 0) / sn;
    const tau2 = Math.max(V - E, 1e-4);
    out.numbers[key] = { mean: clamp(m, 0.001, 0.999), strength: clamp((m * (1 - m)) / tau2 - 1, STRENGTH_RANGE[0], STRENGTH_RANGE[1]), people: P };
    used = Math.max(used, P);
  }
  const timed = people.map((p) => p.total).filter((c) => c.TN >= 10);
  if (timed.length >= minP) {
    const P = timed.length;
    const ybar = timed.map((c) => c.TL / c.TN);
    const s2 = timed.map((c, i) => Math.max(0, c.TL2 / c.TN - ybar[i] ** 2));
    const sumTN = timed.reduce((s, c) => s + c.TN, 0);
    const sigma2 = timed.reduce((s, c, i) => s + c.TN * s2[i], 0) / sumTN;
    // Each person's mean counts once, however much they play.
    const mu = ybar.reduce((s, y) => s + y, 0) / P;
    // Population variance of the per-person means, less the part their own noise explains.
    const varY = ybar.reduce((s, y) => s + (y - mu) ** 2, 0) / P;
    const noise = timed.reduce((s, c) => s + sigma2 / c.TN, 0) / P;
    const tau2 = Math.max(varY - noise, 0.01);
    out.time = {
      mu: clamp(mu, TIME_MU_RANGE[0], TIME_MU_RANGE[1]),
      tau: clamp(Math.sqrt(tau2), TIME_SCALE_RANGE[0], TIME_SCALE_RANGE[1]),
      sigma: clamp(Math.sqrt(sigma2), TIME_SCALE_RANGE[0], TIME_SCALE_RANGE[1]),
    };
    used = Math.max(used, P);
  }
  if (used > 0) {
    out.source = 'people';
    out.people = used;
  }
  return out;
}
