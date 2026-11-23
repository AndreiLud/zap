// Measures each character's style and difficulty in self-play, against the same panel, for the
// profile cards on the site and for the promotion gate (the difficulty order must hold).
//
//   trucoRate      share of normal hands in which the player asked for truco or raised at least once,
//                  among hands where they had the chance
//   bluffRate      share of raise chances with a weak hand (estimate below 1/3) that became a raise
//   runRate        share of bets faced that the player ran from
//   reraiseRate    share of bets faced that the player raised again
//   signalTruth    share of signals that were true (2 against 2)
//   vsZap          duplicate score of a team of this character against a team of Zap
//   styleSeparation for each pair of characters, accuracy of a nearest-centroid classifier that sees
//                  only public behavior (bets, answers, covered cards, strength of the cards shown)
//                  over windows of 20 hands; the target is 80%. With the number of test windows and
//                  the 95% Wilson interval of the accuracy (the windows counted as independent).
//
// Usage: node ai/bench/persona-stats.ts <model.zapw> [pairs] [--out file.json]

import { readFileSync, writeFileSync } from 'node:fs';
import { strengthTable } from '../../engine/src/cards.ts';
import { makeConfig } from '../../engine/src/config.ts';
import { A_RAISE, A_RUN, A_SIGNAL0 } from '../../engine/src/engine.ts';
import type { Observation } from '../../engine/src/observe.ts';
import type { Agent, AgentContext, Decision } from '../src/agent.ts';
import { duplicateSeries } from '../src/evaluate.ts';
import { BASE_PARAMS, handEstimate } from '../src/heuristic.ts';
import { parseModel, type Model } from '../src/mlp.ts';
import { PERSONAS, personaAgent, type PersonaId } from '../src/personas.ts';

export interface Counts {
  handsWithChance: number;
  handsRaised: number;
  weakChances: number;
  weakRaises: number;
  faced: number;
  ran: number;
  reraised: number;
  signals: number;
  trueSignals: number;
}

/** Public behavior of one character in one hand. */
export interface HandLog {
  raises: number;
  faced: number;
  ran: number;
  accepted: number;
  reraised: number;
  covers: number;
  /** Strength classes of the cards shown face up, and whether the player raised in this hand. */
  shown: number[];
}

const newHandLog = (): HandLog => ({ raises: 0, faced: 0, ran: 0, accepted: 0, reraised: 0, covers: 0, shown: [] });

export const empty = (): Counts => ({ handsWithChance: 0, handsRaised: 0, weakChances: 0, weakRaises: 0, faced: 0, ran: 0, reraised: 0, signals: 0, trueSignals: 0 });

function signalTrue(obs: Observation, sig: number): boolean {
  const st = strengthTable(obs.variant, obs.manilhaRank);
  const cards = obs.hand.filter((c) => c >= 0);
  if (sig <= 3) return cards.some((c) => st[c] === 13 - sig);
  const three = cards.some((c) => c >> 2 === 9 && st[c] < 10);
  if (sig === 4) return three;
  return !three && !cards.some((c) => st[c] >= 10);
}

export class Recorder implements Agent {
  readonly name: string;
  private readonly inner: Agent;
  private readonly c: Counts;
  private readonly logs: HandLog[];
  private lastHand = '';
  private chanceThisHand = false;
  private raisedThisHand = false;
  private log: HandLog | null = null;
  constructor(inner: Agent, c: Counts, logs: HandLog[]) {
    this.inner = inner;
    this.c = c;
    this.logs = logs;
    this.name = inner.name;
  }
  act(obs: Observation, rand: () => number, ctx?: AgentContext): Decision {
    const key = `${obs.handIndex}:${obs.score.join('-')}:${obs.games.join('-')}`;
    if (key !== this.lastHand) {
      this.flushHand();
      this.lastHand = key;
    }
    const d = this.inner.act(obs, rand, ctx);
    if (!this.log) this.log = newHandLog();
    const L = this.log;
    if (d.action === A_RAISE) L.raises++;
    if (obs.phase === 'raise') {
      L.faced++;
      if (d.action === A_RUN) L.ran++;
      else if (d.action === A_RAISE) L.reraised++;
      else L.accepted++;
    }
    if (d.action >= 3 && d.action < 6) L.covers++;
    if (d.action < 3 && obs.hand[d.action] >= 0) L.shown.push(strengthTable(obs.variant, obs.manilhaRank)[obs.hand[d.action]]);
    const canRaise = (obs.legal & (1 << A_RAISE)) !== 0;
    if (obs.phase === 'play' && canRaise && obs.kind === 'normal') {
      this.chanceThisHand = true;
      const weak = handEstimate(obs, BASE_PARAMS) < 1 / 3;
      if (weak) this.c.weakChances++;
      if (d.action === A_RAISE) {
        this.raisedThisHand = true;
        if (weak) this.c.weakRaises++;
      }
    }
    if (obs.phase === 'raise') {
      this.c.faced++;
      if (d.action === A_RUN) this.c.ran++;
      if (d.action === A_RAISE) {
        this.c.reraised++;
        this.raisedThisHand = true;
      }
    }
    if (d.action >= A_SIGNAL0) {
      this.c.signals++;
      if (signalTrue(obs, d.action - A_SIGNAL0)) this.c.trueSignals++;
    }
    return d;
  }
  flushHand(): void {
    if (this.log) this.logs.push(this.log);
    this.log = null;
    if (this.chanceThisHand) {
      this.c.handsWithChance++;
      if (this.raisedThisHand) this.c.handsRaised++;
    }
    this.chanceThisHand = false;
    this.raisedThisHand = false;
  }
}

/** Window features: bets per hand (mean and spread), run/accept/re-raise shares, covers per hand, shown strength when betting and not. */
function windowFeatures(w: HandLog[]): number[] {
  const sum = (f: (h: HandLog) => number) => w.reduce((a, h) => a + f(h), 0);
  const faced = Math.max(1, sum((h) => h.faced));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 6.5);
  const shownBet = w.filter((h) => h.raises > 0).flatMap((h) => h.shown);
  const shownQuiet = w.filter((h) => h.raises === 0).flatMap((h) => h.shown);
  const raises = w.map((h) => h.raises);
  const meanRaises = raises.reduce((a, b) => a + b, 0) / w.length;
  const sdRaises = Math.sqrt(raises.reduce((a, b) => a + (b - meanRaises) ** 2, 0) / w.length);
  return [meanRaises, sdRaises, sum((h) => h.ran) / faced, sum((h) => h.accepted) / faced, sum((h) => h.reraised) / faced, sum((h) => h.covers) / w.length, mean(shownBet) / 13, mean(shownQuiet) / 13];
}

export interface Separation {
  /** Share of the test windows the classifier put on the right character. */
  accuracy: number;
  testWindows: number;
  /** 95% Wilson interval of the accuracy over the test windows. */
  ci95: [number, number];
}

/** 95% Wilson score interval of `right` successes in `n` trials. */
export function wilson95(right: number, n: number): [number, number] {
  if (n <= 0) return [NaN, NaN];
  const z = 1.96;
  const p = right / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/** Nearest-centroid accuracy between two characters, trained on even windows and tested on odd ones. */
export function separation(a: HandLog[], b: HandLog[], size = 20): Separation {
  const windows = (logs: HandLog[]) => {
    const out: number[][] = [];
    for (let i = 0; i + size <= logs.length; i += size) out.push(windowFeatures(logs.slice(i, i + size)));
    return out;
  };
  const wa = windows(a);
  const wb = windows(b);
  const train = [wa.filter((_, i) => i % 2 === 0), wb.filter((_, i) => i % 2 === 0)];
  const test = [wa.filter((_, i) => i % 2 === 1), wb.filter((_, i) => i % 2 === 1)];
  const dims = wa[0]?.length ?? 0;
  const all = [...train[0], ...train[1]];
  const mu = Array.from({ length: dims }, (_, d) => all.reduce((s, x) => s + x[d], 0) / all.length);
  const sd = Array.from({ length: dims }, (_, d) => Math.sqrt(all.reduce((s, x) => s + (x[d] - mu[d]) ** 2, 0) / all.length) || 1);
  const z = (x: number[]) => x.map((v, d) => (v - mu[d]) / sd[d]);
  const centroid = (xs: number[][]) => Array.from({ length: dims }, (_, d) => xs.reduce((s, x) => s + z(x)[d], 0) / xs.length);
  const c = [centroid(train[0]), centroid(train[1])];
  const dist = (x: number[], m: number[]) => z(x).reduce((s, v, d) => s + (v - m[d]) ** 2, 0);
  let right = 0;
  let total = 0;
  test.forEach((xs, label) => {
    for (const x of xs) {
      const guess = dist(x, c[0]) <= dist(x, c[1]) ? 0 : 1;
      if (guess === label) right++;
      total++;
    }
  });
  return { accuracy: total ? right / total : NaN, testWindows: total, ci95: wilson95(right, total) };
}

const handLogs: Record<string, HandLog[]> = {};

export interface StyleMeasure {
  trucoRate: number | null;
  bluffRate: number | null;
  runRate: number | null;
  reraiseRate: number | null;
  signalTruth: number | null;
  vsZap: number;
  vsZapSe: number;
  logs: HandLog[];
}

/** Plays a team of agents built by make() against a team of Zap and measures the style. */
export function measureStyle(model: Model, make: () => Agent, pairs: number, seed = 'c3'.repeat(32)): StyleMeasure {
  const counts = empty();
  const logs: HandLog[] = [];
  let sum = 0;
  let se2 = 0;
  for (const variant of ['paulista', 'mineiro'] as const) {
    for (const players of [2, 4] as const) {
      const recorders: Recorder[] = [];
      const r = duplicateSeries(makeConfig(variant, players), seed, pairs, () => {
        const rec = new Recorder(make(), counts, logs);
        recorders.push(rec);
        return rec;
      }, () => personaAgent(model, 'zap'));
      for (const rec of recorders) rec.flushHand();
      sum += r.mean;
      se2 += r.se * r.se;
    }
  }
  const ratio = (a: number, b: number) => (b ? a / b : null);
  return {
    trucoRate: ratio(counts.handsRaised, counts.handsWithChance),
    bluffRate: ratio(counts.weakRaises, counts.weakChances),
    runRate: ratio(counts.ran, counts.faced),
    reraiseRate: ratio(counts.reraised, counts.faced),
    signalTruth: ratio(counts.trueSignals, counts.signals),
    vsZap: sum / 4,
    vsZapSe: Math.sqrt(se2) / 4,
    logs,
  };
}

export function personaStats(model: Model, pairs: number) {
  const out: Record<string, unknown> = {};
  for (const p of PERSONAS) {
    const counts = empty();
    const logs: HandLog[] = [];
    handLogs[p.id] = logs;
    let vsZapSum = 0;
    let vsZapSe2 = 0;
    const segments: Record<string, number> = {};
    for (const variant of ['paulista', 'mineiro'] as const) {
      for (const players of [2, 4] as const) {
        const config = makeConfig(variant, players);
        const recorders: Recorder[] = [];
        const r = duplicateSeries(
          config,
          'b7'.repeat(32),
          pairs,
          () => {
            const rec = new Recorder(personaAgent(model, p.id as PersonaId), counts, logs);
            recorders.push(rec);
            return rec;
          },
          () => personaAgent(model, 'zap'),
        );
        for (const rec of recorders) rec.flushHand();
        segments[`${variant}-${players === 4 ? '2x2' : '1x1'}`] = r.mean;
        vsZapSum += r.mean;
        vsZapSe2 += r.se * r.se;
      }
    }
    const ratio = (a: number, b: number) => (b ? a / b : null);
    out[p.id] = {
      name: p.name,
      trucoRate: ratio(counts.handsRaised, counts.handsWithChance),
      bluffRate: ratio(counts.weakRaises, counts.weakChances),
      runRate: ratio(counts.ran, counts.faced),
      reraiseRate: ratio(counts.reraised, counts.faced),
      signalTruth: ratio(counts.trueSignals, counts.signals),
      vsZap: vsZapSum / 4,
      vsZapSe: Math.sqrt(vsZapSe2) / 4,
      vsZapSegments: segments,
      sample: counts,
    };
  }
  const ids = PERSONAS.map((p) => p.id);
  const sep: Record<string, Separation> = {};
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) sep[`${ids[i]}-${ids[j]}`] = separation(handLogs[ids[i]], handLogs[ids[j]]);
  }
  out.styleSeparation = sep;
  return out;
}

if (process.argv[1]?.endsWith('persona-stats.ts')) {
  const model = parseModel(readFileSync(process.argv[2]));
  const pairs = Number(process.argv[3] ?? 300);
  const t0 = performance.now();
  const stats = personaStats(model, pairs);
  const report = { measuredAt: new Date().toISOString(), pairsPerSegment: pairs, seconds: (performance.now() - t0) / 1000, personas: stats };
  const i = process.argv.indexOf('--out');
  if (i > 0) writeFileSync(process.argv[i + 1], JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
