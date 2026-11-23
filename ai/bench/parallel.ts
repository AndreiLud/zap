// Runs bench work on several cores with worker_threads. Agents travel as small specs (which
// model file, which knobs, which style), each thread builds them and caches parsed models by
// path. Work is cut into chunks of pairs or matches; results come back in task order, so the same
// command gives the same numbers whatever the number of threads.
//
// Task kinds:
//   pairs   duplicate pairs of team A against team B in one segment (ai/src/evaluate.ts pairScores),
//           with optional diagnostics of the safety net for agents marked `track`, and for an
//           explorer team A with `realized` set, how many of its matches a training draw of that
//           family plays exactly (ai/src/styles.ts explorerMatchInFamily)
//   curve   matches of an adaptive player against one opponent, with per-decision diagnostics
//           grouped by hand number and decision type (the reading curve)
//   priors  matches of v1 Zap against the training league, pooling the public statistics of every
//           seat, hands per match and the evidence at bet decisions (ai/models/opponent-priors.json)
//   style   duplicate pairs of a character's team against a team of Zap in one segment, with the
//           character's public behavior recorded (ai/bench/persona-stats.ts Recorder)

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { makeConfig, type RuleOptions } from '../../engine/src/config.ts';
import { A_RAISE, applyAction, expectedActor, newMatch } from '../../engine/src/engine.ts';
import { observe, type Observation } from '../../engine/src/observe.ts';
import { publicHistory } from '../../engine/src/public.ts';
import { deriveSeed, mulberry32 } from '../../engine/src/rng.ts';
import { RandomAgent, agentContext, type Agent, type AgentContext, type Decision } from '../src/agent.ts';
import { pairScores, type AgentFactory } from '../src/evaluate.ts';
import { BASE_PARAMS, HeuristicAgent } from '../src/heuristic.ts';
import { M6_MIX, seatMatch, type LeagueMix } from '../src/league.ts';
import { NetAgent, type AdaptInfo, type Knobs, type NetOptions } from '../src/net-agent.ts';
import { countHands, decisionEvidence, matchCounts, type SeatCounts } from '../src/opponent-stats.ts';
import { PERSONAS, personaAgent, type PersonaId } from '../src/personas.ts';
import { explorerFactory, explorerMatchInFamily, styleAgent, type ExplorerSpec, type StyleId, type TrainingFamily } from '../src/styles.ts';
import { V1_MODEL, loadModel, segmentConfig, tunedParams, v1Knobs, type Segment } from './bench-util.ts';
import { Recorder, empty as emptyCounts, type Counts, type HandLog } from './persona-stats.ts';

export type AgentSpec =
  /** A network file. knobs: a character id (default knobs of PERSONAS) or explicit knobs; default 'zap'. */
  | { kind: 'net'; model: string; knobs?: PersonaId | Knobs; name?: string; opts?: NetOptions; track?: boolean }
  | { kind: 'heuristic'; params: 'base' | 'tuned' }
  | { kind: 'random' }
  /** An extreme or explorer style on v1. */
  | { kind: 'style'; id: StyleId }
  /** A character on v1 with the v1 manifest knobs ('zap' is v1 Zap). */
  | { kind: 'character'; id: PersonaId }
  | { kind: 'explorer'; spec: ExplorerSpec };

/** Safety net diagnostics of tracked agents, summed over decisions. */
export interface Diag {
  decisions: number;
  twoPass: number;
  lambdaBelow1: number;
  topChanged: number;
  klApplied: number;
  tv: number;
}
export const emptyDiag = (): Diag => ({ decisions: 0, twoPass: 0, lambdaBelow1: 0, topChanged: 0, klApplied: 0, tv: 0 });
function addDiag(d: Diag, a: AdaptInfo): void {
  d.decisions++;
  if (a.passes === 2) d.twoPass++;
  if (a.lambda < 1 && a.passes === 2) d.lambdaBelow1++;
  if (a.topChanged) d.topChanged++;
  if (Number.isFinite(a.klApplied)) d.klApplied += a.klApplied;
  if (Number.isFinite(a.tv)) d.tv += a.tv;
}
export function mergeDiag(a: Diag, b: Diag): Diag {
  return { decisions: a.decisions + b.decisions, twoPass: a.twoPass + b.twoPass, lambdaBelow1: a.lambdaBelow1 + b.lambdaBelow1, topChanged: a.topChanged + b.topChanged, klApplied: a.klApplied + b.klApplied, tv: a.tv + b.tv };
}

function knobsOf(k: PersonaId | Knobs | undefined): Knobs {
  if (k === undefined || typeof k === 'string') return PERSONAS.find((p) => p.id === (k ?? 'zap'))!.knobs;
  return k;
}

/** Records the safety net diagnostics of the wrapped network after each decision. */
class Tracked implements Agent {
  readonly name: string;
  private readonly inner: NetAgent;
  private readonly diag: Diag;
  constructor(inner: NetAgent, diag: Diag) {
    this.inner = inner;
    this.diag = diag;
    this.name = inner.name;
  }
  act(obs: Observation, rand: () => number, ctx?: AgentContext): Decision {
    const d = this.inner.act(obs, rand, ctx);
    if (this.inner.lastAdapt) addDiag(this.diag, this.inner.lastAdapt);
    return d;
  }
}

export function factory(spec: AgentSpec, diag?: Diag): AgentFactory {
  switch (spec.kind) {
    case 'net': {
      const model = loadModel(spec.model);
      const knobs = knobsOf(spec.knobs);
      const name = spec.name ?? (typeof spec.knobs === 'string' ? spec.knobs : 'net');
      return () => {
        const a = new NetAgent(model, knobs, name, spec.opts ?? {});
        return spec.track && diag ? new Tracked(a, diag) : a;
      };
    }
    case 'heuristic': {
      const params = spec.params === 'tuned' ? tunedParams() : BASE_PARAMS;
      return () => new HeuristicAgent(params, spec.params);
    }
    case 'random':
      return () => new RandomAgent();
    case 'style': {
      const v1 = loadModel(V1_MODEL);
      return () => styleAgent(v1, spec.id);
    }
    case 'character': {
      const v1 = loadModel(V1_MODEL);
      const knobs = v1Knobs();
      return () => personaAgent(v1, spec.id, knobs);
    }
    case 'explorer':
      return explorerFactory(loadModel(V1_MODEL), v1Knobs(), spec.spec);
  }
}

// ---------------------------------------------------------------------------------------------
// Tasks

export interface PairTask {
  type: 'pairs';
  key: string;
  segment: Segment;
  baseSeed: string;
  offset: number;
  pairs: number;
  a: AgentSpec;
  b: AgentSpec;
  /** Team A an explorer: count its matches whose realized play a training draw of this family plays exactly. */
  realized?: TrainingFamily;
}
/** Matches of an explorer team, and those a training draw of the family plays exactly (explorerMatchInFamily). */
export interface RealizedCount {
  matches: number;
  inFamily: number;
}
export interface PairResult {
  scores: number[];
  diag: Diag;
  realized?: RealizedCount;
}

export interface CurveTask {
  type: 'curve';
  key: string;
  segment: Segment;
  baseSeed: string;
  offset: number;
  matches: number;
  model: AgentSpec;
  opponent: AgentSpec;
}
/** Per bucket "hand:type" (hand 1 to 9 or 10+, type bet or other): sums over decisions. */
export interface CurveCell {
  decisions: number;
  klApplied: number;
  tv: number;
  changed: number;
  n: number;
  lambdaBelow1: number;
}
export type CurveResult = Record<string, CurveCell>;

export interface PriorsTask {
  type: 'priors';
  segment: Segment;
  baseSeed: string;
  offset: number;
  matches: number;
  randomOptions: number;
  twoStyles: number;
  partnerSwap: number;
  mix?: LeagueMix;
}
export interface PriorsResult {
  counts: SeatCounts;
  handsPerMatch: number[];
  /** Evidence n at bet decisions of the v1 Zap seats: histogram by n (index), and by hand number. */
  evidence: number[];
  evidenceByHand: Record<string, number[]>;
  betDecisions: number;
  labels: Record<string, number>;
}

export interface StyleTask {
  type: 'style';
  key: string;
  segment: Segment;
  baseSeed: string;
  offset: number;
  pairs: number;
  /** The measured character, recorded seat by seat. */
  a: AgentSpec;
  /** The team it plays against (Zap). */
  b: AgentSpec;
}
export interface StyleResult {
  scores: number[];
  counts: Counts;
  logs: HandLog[];
}

export type Task = PairTask | CurveTask | PriorsTask | StyleTask;
type ResultOf<T extends Task> = T extends PairTask ? PairResult : T extends CurveTask ? CurveResult : T extends StyleTask ? StyleResult : PriorsResult;

export function isBetDecision(obs: Observation): boolean {
  return obs.phase === 'raise' || obs.phase === 'onze' || (obs.phase === 'play' && (obs.legal & (1 << A_RAISE)) !== 0 && (obs.legal & 0b111) !== 0);
}

function runPairs(t: PairTask): PairResult {
  const diag = emptyDiag();
  const { variant, players } = segmentConfig(t.segment);
  const family = t.realized;
  if (!family || t.a.kind !== 'explorer') {
    const scores = pairScores(makeConfig(variant, players), t.baseSeed, t.pairs, factory(t.a, diag), factory(t.b, diag), t.offset);
    return { scores, diag };
  }
  const spec = t.a.spec;
  const realized: RealizedCount = { matches: 0, inFamily: 0 };
  const scores = pairScores(makeConfig(variant, players), t.baseSeed, t.pairs, factory(t.a, diag), factory(t.b, diag), t.offset, (state, team) => {
    realized.matches++;
    if (explorerMatchInFamily(spec, publicHistory(state), team, family)) realized.inFamily++;
  });
  return { scores, diag, realized };
}

/** The pairs of measureStyle (persona-stats.ts) from `offset` on: same deals, same policy seeds. */
function runStyle(t: StyleTask): StyleResult {
  const counts = emptyCounts();
  const logs: HandLog[] = [];
  const recorders: Recorder[] = [];
  const make = factory(t.a);
  const { variant, players } = segmentConfig(t.segment);
  const team: AgentFactory = (s) => {
    const r = new Recorder(make(s), counts, logs);
    recorders.push(r);
    return r;
  };
  const scores = pairScores(makeConfig(variant, players), t.baseSeed, t.pairs, team, factory(t.b), t.offset);
  for (const r of recorders) r.flushHand();
  return { scores, counts, logs };
}

function runCurve(t: CurveTask): CurveResult {
  const { variant, players } = segmentConfig(t.segment);
  const config = makeConfig(variant, players);
  const makeModel = factory(t.model);
  const makeOpp = factory(t.opponent);
  const out: CurveResult = {};
  for (let i = t.offset; i < t.offset + t.matches; i++) {
    const seed = deriveSeed(t.baseSeed, 0x63757276, i);
    const modelTeam = i & 1;
    const agents = Array.from({ length: players }, (_, s) => ((s & 1) === modelTeam ? makeModel(s) : makeOpp(s)));
    const s = newMatch(config, seed);
    const rand = mulberry32(i);
    let guard = 0;
    while (!s.over) {
      const seat = expectedActor(s);
      const obs = observe(s, seat);
      const agent = agents[seat];
      const d = agent.act(obs, rand, agentContext(s));
      if ((seat & 1) === modelTeam && agent instanceof NetAgent && agent.lastAdapt) {
        const a = agent.lastAdapt;
        const hand = obs.handIndex + 1;
        const key = `${hand >= 10 ? '10+' : hand}:${isBetDecision(obs) ? 'bet' : 'other'}`;
        const c = (out[key] ??= { decisions: 0, klApplied: 0, tv: 0, changed: 0, n: 0, lambdaBelow1: 0 });
        c.decisions++;
        c.klApplied += Number.isFinite(a.klApplied) ? a.klApplied : 0;
        c.tv += Number.isFinite(a.tv) ? a.tv : 0;
        c.changed += a.topChanged ? 1 : 0;
        c.n += a.n;
        c.lambdaBelow1 += a.passes === 2 && a.lambda < 1 ? 1 : 0;
      }
      applyAction(s, seat, d.action);
      if (++guard > 100_000) throw new Error('match did not end');
    }
  }
  return out;
}

const seedInt = (hex: string) => parseInt(hex.slice(0, 8), 16);

function randomRoomOptions(rand: () => number, variant: 'paulista' | 'mineiro'): Partial<RuleOptions> {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  return {
    ladder: variant === 'mineiro' && rand() < 0.3 ? 'mineiro8' : 'standard',
    raiseAnyTime: rand() < 0.2,
    bestOf: rand() < 0.3 ? 3 : 1,
    onzeSeesPartner: rand() < 0.8,
    onzeTieToOpponents: rand() < 0.2,
    ironHand: rand() < 0.2 ? 'normal' : 'blind',
    faceDownFirstRound: rand() < 0.2,
    allTieToMao: rand() < 0.2,
    signals: pick(['secret', 'p25', 'p25', 'all'] as const),
  };
}
export { randomRoomOptions };

function runPriors(t: PriorsTask): PriorsResult {
  const { variant, players } = segmentConfig(t.segment);
  const v1 = loadModel(V1_MODEL);
  const knobs = v1Knobs();
  const league = { v1, v1Knobs: knobs, tuned: tunedParams(), snapshots: [] };
  const counts: SeatCounts = { H: 0, K: 0, U: 0, A: 0, X: 0, S: 0, Q: 0, V: 0, W: 0 };
  const handsPerMatch: number[] = [];
  const evidence: number[] = [];
  const evidenceByHand: Record<string, number[]> = {};
  const labels: Record<string, number> = {};
  let betDecisions = 0;
  for (let i = t.offset; i < t.offset + t.matches; i++) {
    const setupRand = mulberry32(seedInt(deriveSeed(t.baseSeed, 0x73657475, i)));
    const rand = mulberry32(seedInt(deriveSeed(t.baseSeed, 0x706f6c69, i)));
    const config = makeConfig(variant, players, setupRand() < t.randomOptions ? randomRoomOptions(setupRand, variant) : {});
    const learnTeam = setupRand() < 0.5 ? 0 : 1;
    const setup = seatMatch(players, learnTeam, t.mix ?? M6_MIX, setupRand, league, t.twoStyles, t.partnerSwap);
    for (const l of setup.labels) labels[l] = (labels[l] ?? 0) + 1;
    // The learning seats are v1 Zap with its shipped knobs (no adaptive network exists yet).
    const agents = setup.seats.map((a) => (a === 'learn' ? personaAgent(v1, 'zap', knobs) : a));
    const s = newMatch(config, deriveSeed(t.baseSeed, 0x6d617463, i));
    let guard = 0;
    while (!s.over) {
      const seat = expectedActor(s);
      const obs = observe(s, seat);
      const ctx = agentContext(s);
      if (setup.seats[seat] === 'learn' && isBetDecision(obs)) {
        const n = decisionEvidence(obs, matchCounts(ctx.history), 0);
        evidence[n] = (evidence[n] ?? 0) + 1;
        const hk = String(Math.min(obs.handIndex + 1, 10));
        const row = (evidenceByHand[hk] ??= []);
        row[n] = (row[n] ?? 0) + 1;
        betDecisions++;
      }
      applyAction(s, seat, agents[seat].act(obs, rand, ctx).action);
      if (++guard > 100_000) throw new Error('match did not end');
    }
    handsPerMatch.push(s.history.length);
    const m = countHands(publicHistory(s));
    for (const c of m.seats) for (const k of Object.keys(counts) as (keyof SeatCounts)[]) counts[k] += c[k];
  }
  for (let n = 0; n < evidence.length; n++) evidence[n] ??= 0;
  for (const row of Object.values(evidenceByHand)) for (let n = 0; n < row.length; n++) row[n] ??= 0;
  return { counts, handsPerMatch, evidence, evidenceByHand, betDecisions, labels };
}

export function runTask<T extends Task>(t: T): ResultOf<T> {
  if (t.type === 'pairs') return runPairs(t) as ResultOf<T>;
  if (t.type === 'curve') return runCurve(t) as ResultOf<T>;
  if (t.type === 'style') return runStyle(t) as ResultOf<T>;
  return runPriors(t as PriorsTask) as ResultOf<T>;
}

// ---------------------------------------------------------------------------------------------
// Pool

/** Runs tasks on `threads` worker threads (in this thread when threads <= 1); results in task order. */
export async function runTasks<T extends Task>(tasks: T[], threads: number, onProgress?: (done: number, total: number) => void): Promise<ResultOf<T>[]> {
  const results = new Array<ResultOf<T>>(tasks.length);
  if (threads <= 1) {
    tasks.forEach((t, i) => {
      results[i] = runTask(t);
      onProgress?.(i + 1, tasks.length);
    });
    return results;
  }
  let next = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(threads, tasks.length) }, () => new Worker(new URL(import.meta.url), { workerData: { zapBenchWorker: true } }));
  try {
    await Promise.all(
      workers.map(
        (w) =>
          new Promise<void>((resolve, reject) => {
            const feed = () => {
              if (next >= tasks.length) return resolve();
              const i = next++;
              w.once('message', (msg: { ok: boolean; result?: ResultOf<T>; error?: string }) => {
                if (!msg.ok) return reject(new Error(msg.error));
                results[i] = msg.result!;
                onProgress?.(++done, tasks.length);
                feed();
              });
              w.postMessage(tasks[i]);
            };
            w.once('error', reject);
            feed();
          }),
      ),
    );
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
  return results;
}

/** Cuts `pairs` pairs (from `offset` on) into chunks, so threads share the work evenly. */
export function chunks(offset: number, count: number, size = 25): { offset: number; count: number }[] {
  const out: { offset: number; count: number }[] = [];
  for (let o = offset; o < offset + count; o += size) out.push({ offset: o, count: Math.min(size, offset + count - o) });
  return out;
}

export type PairJob = Omit<PairTask, 'type'>;

/** Duplicate pair scores (and diagnostics) per key, chunks joined in pair order. Jobs with the same key must have consecutive offsets. */
export async function runPairTasks(jobs: PairJob[], threads: number, chunkSize = 25, onProgress?: (done: number, total: number) => void): Promise<Map<string, PairResult>> {
  const tasks: PairTask[] = [];
  for (const j of jobs) for (const c of chunks(j.offset, j.pairs, chunkSize)) tasks.push({ ...j, type: 'pairs', offset: c.offset, pairs: c.count });
  const res = await runTasks(tasks, threads, onProgress);
  const out = new Map<string, PairResult>();
  tasks.forEach((t, i) => {
    const prev = out.get(t.key);
    const r = res[i].realized;
    if (!prev) out.set(t.key, { scores: [...res[i].scores], diag: res[i].diag, ...(r ? { realized: { ...r } } : {}) });
    else {
      prev.scores.push(...res[i].scores);
      prev.diag = mergeDiag(prev.diag, res[i].diag);
      if (r && prev.realized) {
        prev.realized.matches += r.matches;
        prev.realized.inFamily += r.inFamily;
      }
    }
  });
  return out;
}

if (!isMainThread && (workerData as { zapBenchWorker?: boolean } | null)?.zapBenchWorker) {
  parentPort!.on('message', (t: Task) => {
    try {
      parentPort!.postMessage({ ok: true, result: runTask(t) });
    } catch (e) {
      parentPort!.postMessage({ ok: false, error: (e as Error).stack ?? String(e) });
    }
  });
}
