// Style counters of a person (shared/profile.ts): the same hand counts as the in-match
// statistics, the same bluff and signal counts as the persona bench, hands the AI played for the
// person left out, and the math of "How Zap reads you" and of the population priors.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeConfig } from '../../engine/src/config.ts';
import { applyAction, expectedActor, newMatch, type MatchState } from '../../engine/src/engine.ts';
import { observe } from '../../engine/src/observe.ts';
import { publicHistory } from '../../engine/src/public.ts';
import { mulberry32 } from '../../engine/src/rng.ts';
import { seriesSeed } from '../../engine/src/simulate.ts';
import { agentContext, type Agent } from '../../ai/src/agent.ts';
import { HeuristicAgent } from '../../ai/src/heuristic.ts';
import { countHands, SEGMENTS } from '../../ai/src/opponent-stats.ts';
import { PERSONAS } from '../../ai/src/personas.ts';
import { STYLES } from '../../ai/src/personas.ts';
import { Recorder, empty } from '../../ai/bench/persona-stats.ts';
import { validatePriorsFile, validateReading, type PriorsFile } from '../../shared/cycle-formats.ts';
import type { MoveInfo } from '../../shared/match-record.ts';
import { MIN_SHOWN_N, READING_KEYS, SHOWN_WEIGHT, addCounts, capFactors, emptyProfile, fitPriors, observationCounts, profileCounts, readProfile, readingCounts, referenceMeans, type PersonCounts, type ProfileCounts } from '../../shared/profile.ts';

const DEFAULT: PriorsFile = JSON.parse(readFileSync('shared/profile-priors-default.json', 'utf8'));

interface Played {
  config: ReturnType<typeof makeConfig>;
  seed: string;
  log: number[];
  moves: MoveInfo[];
  final: MatchState;
}

/** One match with the given agents; seat 0 thinks `ms(i)` milliseconds at its i-th decision. */
function playOne(i: number, players: 2 | 4, agents: Agent[], ms: (k: number) => number | null = () => 1500): Played {
  const config = makeConfig(i & 1 ? 'mineiro' : 'paulista', players);
  const seed = seriesSeed('7a'.repeat(32), i);
  const s = newMatch(config, seed);
  const rand = mulberry32(i);
  const log: number[] = [];
  const moves: MoveInfo[] = [];
  let k = 0;
  while (!s.over) {
    const seat = expectedActor(s);
    const a = agents[seat].act(observe(s, seat), rand, agentContext(s)).action;
    log.push(seat * 16 + a);
    moves.push(seat === 0 ? { ms: ms(k++), auto: false, winProb: null } : { ms: null, auto: false, winProb: 0.5 });
    applyAction(s, seat, a);
  }
  return { config, seed, log, moves, final: s };
}

const seatsOf = (players: number, human: number[] = [0]) => Array.from({ length: players }, (_, i) => ({ kind: human.includes(i) ? ('human' as const) : ('ai' as const) }));

/** The errors of a check, none when it passed. */
const errorsOf = (r: { ok: true } | { ok: false; errors: string[] }): string[] => (r.ok ? [] : r.errors);

describe('profile counts', () => {
  it('hand counts equal the in-match statistics over the whole public history, last hand included', () => {
    for (let i = 0; i < 6; i++) {
      const players = i < 3 ? 2 : 4;
      const p = playOne(i, players, Array.from({ length: players }, () => new HeuristicAgent()));
      const history = publicHistory(p.final);
      expect(history.current).toBeNull();
      expect(history.hands.length).toBe(p.final.history.length);
      // The hand that ended the match is in the history, with the final score.
      expect(history.hands[history.hands.length - 1].scoreAfter).toEqual([p.final.score[0], p.final.score[1]]);
      const all = countHands(history);
      const out = profileCounts({ ...p, seats: seatsOf(players, [0, 1]) });
      expect(out.map((o) => o.seat)).toEqual([0, 1]);
      for (const o of out) {
        const c = all.seats[o.seat];
        expect({ H: o.counts.H, K: o.counts.K, U: o.counts.U, A: o.counts.A, X: o.counts.X, S: o.counts.S, Q: o.counts.Q, V: o.counts.V, W: o.counts.W }).toEqual({ ...c });
        expect(o.segment).toBe(`${p.config.variant}-${players}`);
        expect(o.counts.matches).toBe(1);
      }
    }
  });

  it('bluff and signal counts equal those of ai/bench/persona-stats.ts on the same decisions', () => {
    let checked = 0;
    for (let i = 0; i < 8; i++) {
      const c = empty();
      const bento = PERSONAS.find((p) => p.id === 'bento')!;
      const style = new HeuristicAgent({ ...STYLES.bluffer, signalTruth: bento.knobs.style!.signalTruth });
      const agents: Agent[] = [new Recorder(style, c, []), new HeuristicAgent(), new HeuristicAgent(), new HeuristicAgent()];
      const p = playOne(10 + i, 4, agents);
      const [o] = profileCounts({ ...p, seats: seatsOf(4) });
      expect(o.counts.BC).toBe(c.weakChances);
      expect(o.counts.BR).toBe(c.weakRaises);
      expect(o.counts.G).toBe(c.signals);
      expect(o.counts.GT).toBe(c.trueSignals);
      checked += c.weakChances + c.signals;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('a hand where the AI moved for the person counts nowhere for them; times are clamped logs', () => {
    const p = playOne(30, 2, [new HeuristicAgent(), new HeuristicAgent()], (k) => [50, 1000, 500_000][k % 3]);
    const full = profileCounts({ ...p, seats: seatsOf(2) })[0].counts;
    // Mark the first move of seat 0 in hand 1 as automatic.
    const replay = newMatch(p.config, p.seed);
    let marked = -1;
    for (let i = 0; i < p.log.length; i++) {
      if (marked < 0 && p.log[i] >> 4 === 0 && replay.handIndex === 1) marked = i;
      applyAction(replay, p.log[i] >> 4, p.log[i] & 15);
    }
    const moves = p.moves.map((m, i) => (i === marked ? { ms: null, auto: true, winProb: 0.5 } : m));
    const cut = profileCounts({ ...p, moves, seats: seatsOf(2) })[0].counts;
    expect(cut.H).toBe(full.H - 1);
    expect(cut.D).toBeLessThan(full.D);
    expect(cut.TN).toBeLessThan(full.TN);
    // Every time is one of ln 100, ln 1000, ln 120000.
    const logs = [Math.log(100), Math.log(1000), Math.log(120_000)];
    expect(full.TN).toBeGreaterThan(0);
    expect(full.TL).toBeGreaterThanOrEqual(full.TN * logs[0] - 1e-9);
    expect(full.TL).toBeLessThanOrEqual(full.TN * logs[2] + 1e-9);
    expect(full.TL2).toBeGreaterThan(0);
    // The AI's seats and a match without people give nothing.
    expect(profileCounts({ ...p, seats: seatsOf(2, []) })).toEqual([]);
  });

  it('adds counts key by key', () => {
    const a = { ...emptyProfile(), matches: 1, H: 3, TL: 1.5 };
    const b = { ...emptyProfile(), matches: 2, H: 4, TL: 0.25 };
    expect(addCounts(a, b)).toEqual({ ...emptyProfile(), matches: 3, H: 7, TL: 1.75 });
  });
});

describe('How Zap reads you', () => {
  const counts = (over: Partial<ProfileCounts>): ProfileCounts => ({ ...emptyProfile(), ...over });

  it('beta posterior per number, shown after 10 observations once the 80% interval is narrower than 30 points', () => {
    const c = counts({ matches: 9, D: 300, H: 120, K: 60, U: 20, A: 30, X: 2, BC: 3, BR: 1 });
    const r = readProfile(c, DEFAULT, { now: 5 });
    expect(errorsOf(validateReading(r))).toEqual([]);
    const raise = r.numbers[0];
    const m = DEFAULT.numbers.raise.mean;
    const a = m * 2 + 60;
    const b = (1 - m) * 2 + 60;
    const mean = a / (a + b);
    const sd = Math.sqrt((mean * (1 - mean)) / (a + b + 1));
    expect(raise).toEqual({ key: 'raise', n: 120, shown: true, value: Math.round(mean * 1000) / 1000, low: Math.round((mean - 1.2815515655 * sd) * 1000) / 1000, high: Math.round((mean + 1.2815515655 * sd) * 1000) / 1000, population: Math.round(m * 1000) / 1000, source: 'selfplay' });
    // Three weak-hand chances say little: hidden.
    expect(r.numbers.find((n) => n.key === 'bluff')).toMatchObject({ n: 3, shown: false, value: null, low: null, high: null });
    expect(r.numbers.find((n) => n.key === 'shown')).toMatchObject({ n: 0, shown: false });
    expect(r.time).toEqual({ n: 0, shown: false, medianMs: null, lowMs: null, highMs: null });
    expect(r).toMatchObject({ generatedAt: 5, matches: 9, decisions: 300, priors: 'selfplay', noAdapt: false });
  });

  it('a strong prior never shows a number after a few observations: at least 10 of the person\'s own', () => {
    // The review's case: priors at the old cap (strength 500) and a reraise mean near 0.
    const strong: PriorsFile = { ...DEFAULT, numbers: { ...DEFAULT.numbers, shown: { mean: 0.56, strength: 50, people: null }, reraise: { mean: 0.001, strength: 50, people: null } } };
    for (let n = 1; n < MIN_SHOWN_N; n++) {
      const r = readProfile(counts({ H: n, K: 0, U: n, Q: n, S: 0.2 * n }), strong);
      expect(r.numbers.find((x) => x.key === 'reraise')!.shown, `reraise after ${n}`).toBe(false);
      expect(r.numbers.find((x) => x.key === 'shown')!.shown, `shown after ${n}`).toBe(false);
      expect(r.numbers.find((x) => x.key === 'raise')!.shown, `raise after ${n}`).toBe(false);
    }
    const ten = readProfile(counts({ U: 10, X: 0 }), strong);
    expect(ten.numbers.find((x) => x.key === 'reraise')).toMatchObject({ n: 10, shown: true });
  });

  it('decision time: normal posterior on log ms, shown after 10 decisions once narrower than 30% of the median', () => {
    const t = Math.log(2000);
    const few = readProfile(counts({ TN: 2, TL: 2 * t, TL2: 2 * t * t }), DEFAULT);
    expect(few.time.shown).toBe(false);
    const tight: PriorsFile = { ...DEFAULT, time: { mu: t, tau: 0.05, sigma: 0.05 } };
    expect(readProfile(counts({ TN: 9, TL: 9 * t, TL2: 9 * t * t }), tight).time.shown).toBe(false);
    expect(readProfile(counts({ TN: 10, TL: 10 * t, TL2: 10 * t * t }), tight).time.shown).toBe(true);
    const many = readProfile(counts({ TN: 200, TL: 200 * t, TL2: 200 * t * t }), DEFAULT);
    expect(many.time.shown).toBe(true);
    expect(Math.abs(many.time.medianMs! - 2000)).toBeLessThan(60);
    expect(many.time.lowMs!).toBeLessThan(many.time.medianMs!);
    expect(validateReading(many).ok).toBe(true);
  });

  it('with "Don\'t adapt to me" nothing is shown and decisions read 0', () => {
    const r = readProfile(counts({ matches: 9, D: 300, H: 120, K: 60, TN: 200, TL: 1500 }), DEFAULT, { noAdapt: true });
    expect(r.noAdapt).toBe(true);
    expect(r.decisions).toBe(0);
    expect(r.numbers.every((n) => !n.shown && n.value === null)).toBe(true);
    expect(r.time.shown).toBe(false);
    expect(validateReading(r).ok).toBe(true);
  });

  it('one shown card counts as about 3.6 yes or no answers; n stays the cards', () => {
    const c = counts({ Q: 12, S: 7.2 });
    expect(observationCounts(c).shown).toEqual({ x: 7.2, n: 12 });
    expect(readingCounts(c).shown.n).toBeCloseTo(12 * SHOWN_WEIGHT, 12);
    expect(readingCounts(c).shown.x / readingCounts(c).shown.n).toBeCloseTo(0.6, 12);
    expect(readProfile(c, DEFAULT).numbers.find((x) => x.key === 'shown')!.n).toBe(12);
  });

  it('reads each person against their own mix of rules segments', () => {
    const p = { ...DEFAULT, segments: { ...DEFAULT.segments, 'paulista-2': { ...DEFAULT.segments['paulista-2'], raise: 0.68 }, 'paulista-4': { ...DEFAULT.segments['paulista-4'], raise: 0.31 } } };
    const solo = counts({ H: 300, K: 204 });
    const ref = referenceMeans({ 'paulista-2': counts({ H: 200, K: 136 }), 'paulista-4': counts({ H: 100, K: 30 }) }, p);
    expect(ref.raise).toBeCloseTo((200 * 0.68 + 100 * 0.31) / 300, 12);
    // Signal truth has no segment values: the pooled one. Bluff reads its own segment values.
    expect(ref.signalTruth).toBe(DEFAULT.numbers.signalTruth.mean);
    expect(ref.bluff).toBe(DEFAULT.numbers.bluff.mean);
    const mix = { 'paulista-2': counts({ BC: 30, BR: 10 }), 'paulista-4': counts({ BC: 10, BR: 1 }) };
    const bluff = (30 * DEFAULT.readingSegments['paulista-2'].bluff + 10 * DEFAULT.readingSegments['paulista-4'].bluff) / 40;
    expect(referenceMeans(mix, p).bluff).toBeCloseTo(bluff, 12);
    // Without per segment counts, or without observations of a number, the pooled value.
    expect(referenceMeans(undefined, p).raise).toBe(DEFAULT.numbers.raise.mean);
    expect(referenceMeans({ 'paulista-2': counts({ U: 5 }) }, p).raise).toBe(DEFAULT.numbers.raise.mean);
    const r = readProfile(solo, p, { perSegment: { 'paulista-2': solo } });
    expect(r.numbers[0].population).toBe(0.68);
  });

  it('bluff: one style at two table mixes reads the same, against the bluff of its own tables', () => {
    // The verification's case: in self-play bluff is about 0.34 at 1 against 1 and 0.09 at 2
    // against 2. People who bluff exactly as the population does at each table read the population
    // value, whatever their mix; the pooled value (0.17) would call one group bluffers and the
    // other careful.
    const rs = DEFAULT.readingSegments;
    const person = (c2: number, c4: number) => {
      const s2 = counts({ BC: c2, BR: c2 * rs['paulista-2'].bluff });
      const s4 = counts({ BC: c4, BR: c4 * rs['paulista-4'].bluff });
      const total = counts({ BC: c2 + c4, BR: s2.BR + s4.BR });
      return readProfile(total, DEFAULT, { perSegment: { 'paulista-2': s2, 'paulista-4': s4 } }).numbers.find((x) => x.key === 'bluff')!;
    };
    for (const [c2, c4] of [[900, 100], [100, 900]]) {
      const b = person(c2, c4);
      expect(b.shown).toBe(true);
      expect(Math.abs(b.value! - b.population)).toBeLessThan(0.002);
    }
    expect(person(900, 100).population).toBeGreaterThan(0.3);
    expect(person(100, 900).population).toBeLessThan(0.12);
  });

  it('each number names its source: people only for the numbers fitted from people', () => {
    const fitted: PriorsFile = { ...DEFAULT, source: 'people', people: 140, numbers: { ...DEFAULT.numbers, raise: { mean: 0.4, strength: 20, people: 140 } } };
    const r = readProfile(counts({ H: 40, K: 16 }), fitted);
    expect(r.priors).toBe('people');
    expect(r.numbers.map((x) => [x.key, x.source])).toEqual(READING_KEYS.map((k) => [k, k === 'raise' ? 'people' : 'selfplay']));
    expect(validateReading(r).ok).toBe(true);
    expect(readProfile(counts({ H: 40, K: 16 }), DEFAULT).numbers.every((x) => x.source === 'selfplay')).toBe(true);
  });
});

describe('population priors from people', () => {
  /** P people whose raise rate is spread around `rate`, with 40 hands each, all in paulista-2. */
  function crowd(P: number, rate: number, seed = 1): PersonCounts[] {
    const rand = mulberry32(seed);
    return Array.from({ length: P }, () => {
      const r = Math.min(0.95, Math.max(0.05, rate + (rand() - 0.5) * 0.3));
      const H = 40;
      let K = 0;
      for (let h = 0; h < H; h++) if (rand() < r) K++;
      const TN = 30;
      const y = Math.log(2500 * (0.6 + rand()));
      const total = { ...emptyProfile(), matches: 5, H, K, U: 10, A: 12, X: 2, S: 6, Q: 12, V: 3, W: 20, BC: 12, BR: 3, G: 12, GT: 10, TN, TL: TN * y, TL2: TN * (y * y + 0.25) };
      return { total, perSegment: { 'paulista-2': total } };
    });
  }

  it('keeps the fallback below minPeople, and fits numbers, time and segments above it', () => {
    const few = crowd(50, 0.3);
    expect(fitPriors(few, DEFAULT, 100)).toEqual(DEFAULT);
    const people = crowd(300, 0.3, 2);
    // 50 of them also played mineiro-4: too few for that segment.
    for (const p of people.slice(0, 50)) p.perSegment['mineiro-4'] = { ...emptyProfile(), H: 12, K: 3 };
    const fit = fitPriors(people, DEFAULT, 100);
    expect(errorsOf(validatePriorsFile(fit))).toEqual([]);
    expect(fit.source).toBe('people');
    expect(fit.people).toBe(300);
    const pooled = people.map((p) => p.total).reduce(addCounts, emptyProfile());
    // 300 people with the same number of hands: the 2% cap changes nothing.
    expect(fit.numbers.raise.mean).toBeCloseTo(pooled.K / pooled.H, 9);
    // The spread between people (a uniform of width 0.3 around 0.3: variance 0.0075) is real, so
    // the strength, 0.21 / 0.0075 - 1 = 27, is well below the cap.
    expect(fit.numbers.raise.strength).toBeGreaterThan(15);
    expect(fit.numbers.raise.strength).toBeLessThan(45);
    expect(Math.exp(fit.time.mu)).toBeGreaterThan(2000);
    expect(Math.exp(fit.time.mu)).toBeLessThan(4000);
    expect(fit.segments['paulista-2'].raise).toBeCloseTo(pooled.K / pooled.H, 9);
    const s = fit.segments['paulista-2'];
    expect(s.run + s.accept + s.reraise).toBeCloseTo(1, 12);
    expect(fit.readingSegments['paulista-2'].bluff).toBeCloseTo(pooled.BR / pooled.BC, 9);
    // Segments with too few people keep the fallback's in-match priors and bluff.
    expect(fit.segments['mineiro-4']).toEqual(DEFAULT.segments['mineiro-4']);
    expect(fit.readingSegments['mineiro-4']).toEqual(DEFAULT.readingSegments['mineiro-4']);
    // Every number came from the 300 people; the fallback's numbers say null.
    for (const k of READING_KEYS) expect(fit.numbers[k].people, k).toBe(300);
    expect(Object.values(DEFAULT.numbers).every((n) => n.people === null)).toBe(true);
  });

  it('never from fewer than 20 people, whatever minPeople says', () => {
    expect(fitPriors(crowd(19, 0.3), DEFAULT, 4)).toEqual(DEFAULT);
    const fit = fitPriors(crowd(20, 0.3), DEFAULT, 4);
    expect(fit.people).toBe(20);
    expect(validatePriorsFile(fit).ok).toBe(true);
  });

  it('no person holds more than 2% of a number: one very active person cannot set the population value', () => {
    const people = crowd(100, 0.3, 3);
    people.push({ total: { ...emptyProfile(), H: 100_000, K: 95_000 }, perSegment: { 'paulista-2': { ...emptyProfile(), H: 100_000, K: 95_000 } } });
    const f = capFactors(people.map((p) => p.total.H));
    const total = people.reduce((s, p, i) => s + f[i] * p.total.H, 0);
    expect((f[100] * 100_000) / total).toBeLessThanOrEqual(0.02 + 1e-9);
    const fit = fitPriors(people, DEFAULT, 100);
    const uncapped = people.reduce((s, p) => s + p.total.K, 0) / people.reduce((s, p) => s + p.total.H, 0);
    expect(uncapped).toBeGreaterThan(0.9);
    expect(fit.numbers.raise.mean).toBeLessThan(0.35);
    expect(capFactors([5, 5, 5])).toEqual([1, 1, 1]);
  });

  /** A Gamma(shape) draw (Marsaglia and Tsang), for Beta draws. */
  function gamma(rand: () => number, shape: number): number {
    if (shape < 1) return gamma(rand, shape + 1) * rand() ** (1 / shape);
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number;
      let v: number;
      do {
        const u1 = rand();
        const u2 = rand();
        x = Math.sqrt(-2 * Math.log(u1 || 1e-12)) * Math.cos(2 * Math.PI * u2);
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = rand();
      if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }
  const beta = (rand: () => number, a: number, b: number) => {
    const x = gamma(rand, a);
    return x / (x + gamma(rand, b));
  };

  it('shown: a known spread of people is recovered, and the 80% interval covers about 80% of them', () => {
    // 1,000 people whose own mean of shown cards follows a Beta with mean 0.56 and strength 20 (in
    // yes or no answers); each card's value has the self-play variance 0.07 around that mean.
    const rand = mulberry32(11);
    const m = 0.56;
    const k = 20;
    const people: PersonCounts[] = [];
    const truth: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const mu = Math.min(0.85, Math.max(0.15, beta(rand, m * k, (1 - m) * k)));
      const c = (mu * (1 - mu)) / 0.07 - 1;
      const Q = 10 + Math.floor(rand() * 50);
      let S = 0;
      for (let j = 0; j < Q; j++) S += beta(rand, mu * c, (1 - mu) * c);
      const total = { ...emptyProfile(), Q, S, H: 40, K: 10 };
      people.push({ total, perSegment: { 'paulista-2': total } });
      truth.push(mu);
    }
    const fit = fitPriors(people, DEFAULT, 100);
    expect(fit.numbers.shown.strength).toBeGreaterThan(0.7 * k);
    expect(fit.numbers.shown.strength).toBeLessThan(1.3 * k);
    let covered = 0;
    let shown = 0;
    people.forEach((p, i) => {
      const x = readProfile(p.total, fit, { perSegment: p.perSegment }).numbers.find((n) => n.key === 'shown')!;
      if (!x.shown) return;
      shown++;
      if (x.low! <= truth[i] && truth[i] <= x.high!) covered++;
    });
    expect(shown).toBeGreaterThan(900);
    expect(covered / shown).toBeGreaterThan(0.75);
    expect(covered / shown).toBeLessThan(0.85);
  });

  it('one style at two mixes of tables reads as one style', () => {
    // People with the same style (raise 0.68 in 1 against 1, 0.31 in 2 against 2), half mostly
    // 1 against 1 and half mostly 2 against 2: their raw rates differ, their readings against their
    // own mix do not.
    const rand = mulberry32(5);
    const draw = (n: number, rate: number) => {
      let k = 0;
      for (let i = 0; i < n; i++) if (rand() < rate) k++;
      return k;
    };
    const people: PersonCounts[] = [];
    for (let i = 0; i < 400; i++) {
      const [h2, h4] = i % 2 ? [200, 600] : [600, 200];
      const two = { ...emptyProfile(), H: h2, K: draw(h2, 0.68) };
      const four = { ...emptyProfile(), H: h4, K: draw(h4, 0.31) };
      people.push({ total: addCounts(two, four), perSegment: { 'paulista-2': two, 'paulista-4': four } });
    }
    const fit = fitPriors(people, DEFAULT, 100);
    expect(fit.segments['paulista-2'].raise).toBeCloseTo(0.68, 1);
    expect(fit.segments['paulista-4'].raise).toBeCloseTo(0.31, 1);
    const rel = (p: PersonCounts) => {
      const x = readProfile(p.total, fit, { perSegment: p.perSegment }).numbers[0];
      return x.value! - x.population;
    };
    const raw = (p: PersonCounts) => p.total.K / p.total.H;
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const a = people.filter((_, i) => i % 2 === 0);
    const b = people.filter((_, i) => i % 2 === 1);
    expect(mean(a.map(raw)) - mean(b.map(raw))).toBeGreaterThan(0.15);
    expect(Math.abs(mean(a.map(rel)) - mean(b.map(rel)))).toBeLessThan(0.02);
  });
});
