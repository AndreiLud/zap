// The matches behind sim.json and replays.json (DATA-SPEC 2.1.5), one chunk at a time. Loaded by
// tools/data/simulate.ts as a worker thread; its functions are also plain exports, so a chunk can
// run in the main thread (tests, one thread).
//
// Players: every seat is personaAgent(story model, id, manifest personas, { stats }) and gets
// agentContext(s) at each decision, as in ai/src/evaluate.ts. Rules: makeConfig(variant, players)
// with the default options. Segment g (0 to 3): paulista-2, paulista-4, mineiro-2, mineiro-4.
// Match i of segment g deals with seriesSeed(seed repeated to 64 characters, g * 1,000,000 + i) and
// draws actions from mulberry32(the same index); run B adds 4,000,000 * (p + 1) for persona p. So a
// rerun gives the same numbers whatever the number of threads.

import { readFileSync } from 'node:fs';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { manilhaRankForVira, strengthTable } from '../../engine/src/cards.ts';
import { MAX_STEP, makeConfig, type MatchConfig } from '../../engine/src/config.ts';
import { A_RAISE, A_RUN, A_ACCEPT, A_SIGNAL0, TIE, applyAction, expectedActor, newMatch, teamOf, type MatchState } from '../../engine/src/engine.ts';
import { observe } from '../../engine/src/observe.ts';
import { mulberry32 } from '../../engine/src/rng.ts';
import { seriesSeed } from '../../engine/src/simulate.ts';
import { agentContext, type Agent } from '../../ai/src/agent.ts';
import { BASE_PARAMS, handEstimate } from '../../ai/src/heuristic.ts';
import { parseModel, type Model } from '../../ai/src/mlp.ts';
import type { NetOptions } from '../../ai/src/net-agent.ts';
import { personaAgent, type CalibratedKnobs, type PersonaId } from '../../ai/src/personas.ts';
import { emptyOutcomeCounts, type OutcomeCounts } from './lib/outcomes.ts';
import { abs } from './lib/provenance.ts';
import { addScore, emptySum, round, type ScoreSum } from './lib/stats.ts';

export const SEGMENTS = ['paulista-2', 'paulista-4', 'mineiro-2', 'mineiro-4'] as const;
export type SegmentId = (typeof SEGMENTS)[number];
/** Run B: each persona as a team against a team of Zap, in this order (p = 0 to 5). */
export const PERSONA_ORDER: readonly PersonaId[] = ['zap', 'otavio', 'bento', 'lia', 'ravi', 'iara'];
/** Replays come from these segments, in this order of preference. */
export const REPLAY_SEGMENTS: readonly SegmentId[] = ['paulista-4', 'paulista-2'];
export const REPLAY_KINDS = ['virada', 'blefe', 'doze', 'onze'] as const;
export type ReplayKind = (typeof REPLAY_KINDS)[number];
/** Strength classes of a card (0 to 13), hand strength bins, score bands and bet steps. */
export const CLASSES = 14;
export const BINS = 9;
export const BANDS = ['<=-6', '-5..-1', '0', '1..5', '>=6'] as const;
export const STEPS = 4;
/** A raise counts as a bluff for the "blefe" replay below this hand estimate. */
export const BLUFF_EST = 0.25;

export interface SimSetup {
  modelPath: string;
  manifestPath: string;
  stats: 'live' | 'empty';
  /** Two hex characters, repeated to the 64 the engine needs. */
  seed: string;
}

export interface GameTask {
  kind: 'game';
  g: number;
  from: number;
  to: number;
}

export interface PersonaTask {
  kind: 'persona';
  p: number;
  g: number;
  from: number;
  to: number;
}

export type SimTask = GameTask | PersonaTask;

export interface ReplayAction {
  /** Position of the action in `log`. */
  i: number;
  seat: number;
  action: number;
  /** Team 0's estimated chance of winning the match: the acting seat's estimate, 1 - p for team 1 seats; null without one. */
  chance: number | null;
}

export interface Replay {
  id: ReplayKind;
  segment: SegmentId;
  config: MatchConfig;
  /** The match seed (64 hex characters): replay(config, seed, log) rebuilds the match. */
  seed: string;
  /** Every action from the start of the match to the end of the hand shown. */
  log: number[];
  handIndex: number;
  /** The actions of the hand shown. */
  actions: ReplayAction[];
  /** Team 0's estimated chance after the hand: the first estimate of the next hand, or 1 or 0 when the match ended. */
  chanceAfter: number | null;
  /**
   * virada: rise (of the winning team's own estimate over the hand) and team; blefe: estimate (the
   * raiser's hand estimate), seat and at (position of the raise in `log`); onze: team on the threshold.
   */
  detail: Record<string, number>;
}

export interface Candidate {
  /** Lexicographic order key: segment preference, match, hand, action. Earlier wins ties. */
  order: number[];
  /** virada: the rise (larger wins); blefe: the estimate (smaller wins); doze and onze: 0. */
  value: number;
  replay: Replay;
}

export interface GameChunk {
  g: number;
  matches: number;
  decisions: number;
  hands: number;
  bestCard: ScoreSum[];
  first: ScoreSum;
  round1: { won: ScoreSum; tied: ScoreSum; lost: ScoreSum };
  outcomes: OutcomeCounts;
  replays: Partial<Record<ReplayKind, Candidate>>;
}

export interface AskCount {
  n: number;
  raised: number;
}

export interface AnswerCount {
  n: number;
  run: number;
  accept: number;
  reraise: number;
}

export interface PersonaChunk {
  p: number;
  g: number;
  matches: number;
  decisions: number;
  /** [bin][band] */
  ask: AskCount[][];
  /** [bin][step - 1] */
  answer: AnswerCount[][];
}

export function segmentConfig(g: number): MatchConfig {
  const seg = SEGMENTS[g];
  if (!seg) throw new Error(`no segment ${g}`);
  const [variant, players] = seg.split('-');
  return makeConfig(variant as 'paulista' | 'mineiro', Number(players) as 2 | 4);
}

/** Seed index of match i of segment g in run A. */
export const gameIndex = (g: number, i: number): number => g * 1_000_000 + i;
/** Seed index of match i of segment g for persona p in run B. */
export const personaIndex = (p: number, g: number, i: number): number => 4_000_000 * (p + 1) + g * 1_000_000 + i;

/** Hand strength bin: floor(9 est), capped at 8, so 1/3 and 2/3 are bin edges. */
export function strengthBin(est: number): number {
  return Math.max(0, Math.min(BINS - 1, Math.floor(BINS * est)));
}

/** Score band of own score minus the other team's: <= -6, -5 to -1, 0, 1 to 5, >= 6. */
export function scoreBand(diff: number): number {
  if (diff <= -6) return 0;
  if (diff < 0) return 1;
  if (diff === 0) return 2;
  if (diff <= 5) return 3;
  return 4;
}

/** Score of a team in a hand: 1 if it took the points, 0 if the other team did, 0.5 if nobody scored. */
export const handScore = (winner: number, team: number): number => (winner < 0 ? 0.5 : winner === team ? 1 : 0);

/** Better candidate for a replay kind: the extreme value, then the earlier order key. */
export function better(kind: ReplayKind, a: Candidate, b: Candidate | undefined): boolean {
  if (!b) return true;
  if (kind === 'virada' && a.value !== b.value) return a.value > b.value;
  if (kind === 'blefe' && a.value !== b.value) return a.value < b.value;
  for (let k = 0; k < Math.max(a.order.length, b.order.length); k++) {
    const x = a.order[k] ?? -1;
    const y = b.order[k] ?? -1;
    if (x !== y) return x < y;
  }
  return false;
}

interface Players {
  model: Model;
  knobs: CalibratedKnobs;
  opts: NetOptions;
}

const playersCache = new Map<string, Players>();
function playersOf(setup: SimSetup): Players {
  const key = `${setup.modelPath}|${setup.manifestPath}|${setup.stats}`;
  let p = playersCache.get(key);
  if (!p) {
    const manifest = JSON.parse(readFileSync(abs(setup.manifestPath), 'utf8')) as { personas?: CalibratedKnobs };
    p = { model: parseModel(readFileSync(abs(setup.modelPath))), knobs: manifest.personas ?? {}, opts: { stats: setup.stats } };
    playersCache.set(key, p);
  }
  return p;
}

const seed64 = (setup: SimSetup): string => {
  if (!/^[0-9a-f]{2}$/.test(setup.seed)) throw new Error('seed takes two hex characters');
  return setup.seed.repeat(32);
};

function agentFor(pl: Players, id: PersonaId): Agent {
  return personaAgent(pl.model, id, pl.knobs, pl.opts);
}

export function emptyGameChunk(g: number): GameChunk {
  return {
    g,
    matches: 0,
    decisions: 0,
    hands: 0,
    bestCard: Array.from({ length: CLASSES }, emptySum),
    first: emptySum(),
    round1: { won: emptySum(), tied: emptySum(), lost: emptySum() },
    outcomes: emptyOutcomeCounts(),
    replays: {},
  };
}

/** Run A: matches from..to-1 of segment g, all seats Zap. */
export function runGameChunk(setup: SimSetup, task: GameTask): GameChunk {
  const pl = playersOf(setup);
  const base = seed64(setup);
  const config = segmentConfig(task.g);
  const segment = SEGMENTS[task.g];
  const prio = REPLAY_SEGMENTS.indexOf(segment);
  const acc = emptyGameChunk(task.g);
  for (let i = task.from; i < task.to; i++) {
    const idx = gameIndex(task.g, i);
    const seed = seriesSeed(base, idx);
    const s = newMatch(config, seed);
    const rand = mulberry32(idx);
    const agents = Array.from({ length: config.players }, () => agentFor(pl, 'zap'));
    const handStart: number[] = [];
    const chance: (number | null)[] = [];
    const raiseEst = new Map<number, number>();
    while (!s.over) {
      if (handStart.length === s.handIndex) handStart.push(s.log.length);
      else if (handStart.length !== s.handIndex + 1) throw new Error('hand index skipped');
      const seat = expectedActor(s);
      const obs = observe(s, seat);
      const d = agents[seat].act(obs, rand, agentContext(s));
      const at = s.log.length;
      chance.push(d.winProb === undefined ? null : teamOf(seat) === 0 ? d.winProb : 1 - d.winProb);
      if (d.action === A_RAISE) raiseEst.set(at, handEstimate(obs, BASE_PARAMS));
      applyAction(s, seat, d.action);
      if (s.log.length !== at + 1) throw new Error('expected one log entry per action');
      acc.decisions++;
      if (acc.decisions > 1e9) throw new Error('runaway');
    }
    acc.matches++;
    tallyGame(acc, s, i, config);
    if (prio >= 0) findReplays(acc, s, i, prio, segment, config, seed, handStart, chance, raiseEst);
  }
  return acc;
}

function tallyGame(acc: GameChunk, s: MatchState, i: number, config: MatchConfig): void {
  const n = s.n;
  acc.hands += s.history.length;
  s.history.forEach((hs, h) => {
    const winner = hs.result.winner;
    if (hs.kind === 'normal') {
      const st = strengthTable(config.variant, config.variant === 'paulista' ? manilhaRankForVira(hs.vira) : -1);
      const observer = (i + h) % n;
      const best = Math.max(...hs.dealt[observer].map((c) => st[c]));
      addScore(acc.bestCard[best], handScore(winner, teamOf(observer)));
      const maoTeam = teamOf(hs.mao);
      const maoScore = handScore(winner, maoTeam);
      addScore(acc.first, maoScore);
      const r1 = hs.rounds[0]?.result ?? -1;
      if (r1 === maoTeam) addScore(acc.round1.won, maoScore);
      else if (r1 === TIE) addScore(acc.round1.tied, maoScore);
      else if (r1 === 1 - maoTeam) addScore(acc.round1.lost, maoScore);
      const o = acc.outcomes;
      o.normalHands++;
      if (winner < 0) o.normalTies++;
      else o.scored[String(hs.result.points)] = (o.scored[String(hs.result.points)] ?? 0) + 1;
    } else if (hs.kind === 'onze') {
      const o = acc.outcomes.onze;
      o.n++;
      if (hs.result.reason === 'onzeRun') o.run++;
      else if (winner === hs.onzeTeam) o.win++;
      else if (winner === 1 - hs.onzeTeam) o.lose++;
      else o.tie++;
    } else {
      acc.outcomes.iron.n++;
      if (winner < 0) acc.outcomes.iron.tie++;
    }
  });
}

function findReplays(
  acc: GameChunk,
  s: MatchState,
  i: number,
  prio: number,
  segment: SegmentId,
  config: MatchConfig,
  seed: string,
  handStart: readonly number[],
  chance: readonly (number | null)[],
  raiseEst: ReadonlyMap<number, number>,
): void {
  const hist = s.history;
  if (hist.length !== handStart.length) throw new Error('every hand that started must have ended');
  const endOf = (h: number) => (h + 1 < handStart.length ? handStart[h + 1] : s.log.length) - 1;
  /** Team 0's chance at the first estimate of hand h, made by any seat or by a seat of `team`. */
  const firstChance = (h: number, team = -1): number | null => {
    for (let j = handStart[h]; j <= endOf(h); j++) if (chance[j] !== null && (team < 0 || teamOf(s.log[j] >> 4) === team)) return chance[j];
    return null;
  };
  /** Team 0's chance after hand h: the next hand's first estimate (by any seat or by `team`), or 1 or 0 at the end. */
  const after = (h: number, team = -1): number | null => (h + 1 < hist.length ? firstChance(h + 1, team) : s.winner === 0 ? 1 : 0);
  const make = (id: ReplayKind, h: number, detail: Record<string, number>): Replay => {
    const start = handStart[h];
    const end = endOf(h);
    const actions: ReplayAction[] = [];
    for (let j = start; j <= end; j++) {
      const c = chance[j];
      actions.push({ i: j, seat: s.log[j] >> 4, action: s.log[j] & 15, chance: c === null ? null : round(c) });
    }
    const next = after(h);
    return { id, segment, config, seed, log: s.log.slice(0, end + 1), handIndex: h, actions, chanceAfter: next === null ? null : round(next), detail };
  };
  const offer = (kind: ReplayKind, order: number[], value: number, build: () => Replay) => {
    const cur = acc.replays[kind];
    const cand: Candidate = { order, value, replay: undefined as unknown as Replay };
    if (better(kind, cand, cur)) {
      cand.replay = build();
      acc.replays[kind] = cand;
    }
  };
  hist.forEach((hs, h) => {
    const winner = hs.result.winner;
    // virada: the winning team lost round 1; the rise of its own estimate (its seats' estimates only,
    // since each seat sees different cards) from its first one in the hand to its first one after it.
    if (winner >= 0 && hs.rounds[0]?.result === 1 - winner) {
      const b = firstChance(h, winner);
      const a = after(h, winner);
      if (b !== null && a !== null) {
        const view = (x: number) => (winner === 0 ? x : 1 - x);
        const rise = view(a) - view(b);
        offer('virada', [prio, i, h], round(rise, 6), () => make('virada', h, { rise: round(rise), team: winner }));
      }
    }
    // blefe: a raise with a weak hand that the other team ran from; the lowest estimate wins.
    for (let j = handStart[h]; j <= endOf(h); j++) {
      const est = raiseEst.get(j);
      if (est === undefined || !(est < BLUFF_EST)) continue;
      const raiser = s.log[j] >> 4;
      for (let k = j + 1; k <= endOf(h); k++) {
        const act = s.log[k] & 15;
        if (act >= A_SIGNAL0) continue;
        if (act === A_RUN && teamOf(s.log[k] >> 4) !== teamOf(raiser)) {
          offer('blefe', [prio, i, h, j], round(est, 6), () => make('blefe', h, { estimate: round(est), seat: raiser, at: j }));
        }
        break;
      }
    }
    if (hs.step === MAX_STEP) offer('doze', [prio, i, h], 0, () => make('doze', h, {}));
    if (hs.kind === 'onze' && winner === hs.onzeTeam && hs.bets.some((b) => b.kind === 'onzePlay')) offer('onze', [prio, i, h], 0, () => make('onze', h, { team: hs.onzeTeam }));
  });
}

export function emptyPersonaChunk(p: number, g: number): PersonaChunk {
  return {
    p,
    g,
    matches: 0,
    decisions: 0,
    ask: Array.from({ length: BINS }, () => Array.from({ length: BANDS.length }, () => ({ n: 0, raised: 0 }))),
    answer: Array.from({ length: BINS }, () => Array.from({ length: STEPS }, () => ({ n: 0, run: 0, accept: 0, reraise: 0 }))),
  };
}

/**
 * Run B: matches from..to-1 of segment g, a team of persona p against a team of Zap, the persona on
 * the even seats in even matches. Logs the persona's decisions that resolve a turn (signals are
 * left out): asking (phase play, normal hand, raise legal) by hand strength and score band, and
 * answering (phase raise) by hand strength and the step being answered.
 */
export function runPersonaChunk(setup: SimSetup, task: PersonaTask): PersonaChunk {
  const pl = playersOf(setup);
  const base = seed64(setup);
  const config = segmentConfig(task.g);
  const id = PERSONA_ORDER[task.p];
  if (!id) throw new Error(`no persona ${task.p}`);
  const acc = emptyPersonaChunk(task.p, task.g);
  for (let i = task.from; i < task.to; i++) {
    const idx = personaIndex(task.p, task.g, i);
    const s = newMatch(config, seriesSeed(base, idx));
    const rand = mulberry32(idx);
    const xTeam = i % 2;
    const agents = Array.from({ length: config.players }, (_, seat) => agentFor(pl, teamOf(seat) === xTeam ? id : 'zap'));
    while (!s.over) {
      const seat = expectedActor(s);
      const obs = observe(s, seat);
      let ask: AskCount | null = null;
      let answer: AnswerCount | null = null;
      if (teamOf(seat) === xTeam) {
        if (obs.phase === 'play' && obs.kind === 'normal' && (obs.legal & (1 << A_RAISE)) !== 0) {
          const team = teamOf(seat);
          ask = acc.ask[strengthBin(handEstimate(obs, BASE_PARAMS))][scoreBand(obs.score[team] - obs.score[1 - team])];
        } else if (obs.phase === 'raise') {
          const step = obs.step + 1;
          if (step < 1 || step > STEPS) throw new Error(`answer to step ${step}`);
          answer = acc.answer[strengthBin(handEstimate(obs, BASE_PARAMS))][step - 1];
        }
      }
      const d = agents[seat].act(obs, rand, agentContext(s));
      if (ask && d.action < A_SIGNAL0) {
        ask.n++;
        if (d.action === A_RAISE) ask.raised++;
      }
      if (answer) {
        if (d.action === A_RUN) answer.run++;
        else if (d.action === A_ACCEPT) answer.accept++;
        else if (d.action === A_RAISE) answer.reraise++;
        else throw new Error(`answer with action ${d.action}`);
        answer.n++;
      }
      applyAction(s, seat, d.action);
      acc.decisions++;
    }
    acc.matches++;
  }
  return acc;
}

export function runTask(setup: SimSetup, task: SimTask): GameChunk | PersonaChunk {
  return task.kind === 'game' ? runGameChunk(setup, task) : runPersonaChunk(setup, task);
}

if (!isMainThread && (workerData as { zapDataSim?: boolean } | null)?.zapDataSim) {
  const setup = (workerData as { setup: SimSetup }).setup;
  parentPort!.on('message', (msg: { index: number; task: SimTask }) => {
    try {
      parentPort!.postMessage({ index: msg.index, ok: true, result: runTask(setup, msg.task) });
    } catch (e) {
      parentPort!.postMessage({ index: msg.index, ok: false, error: (e as Error).stack ?? String(e) });
    }
  });
}
