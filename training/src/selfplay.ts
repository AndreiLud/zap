// Self-play worker: plays matches with the current network against the training league
// (ai/src/league.ts) and writes one training record per decision of the learning seats.
//
// Usage: node training/src/selfplay.ts --config <job.json>
// The job file says which model to use, where to write, how many decisions to collect, the
// seed, the league and the mix of opponents. See training/learner.py for the reader.
//
// Two random streams come from the job seed: one for the setup of each match (rules, learning
// team, opponents and their parameters, whether the match is played blind) and one for every
// action. Two runs with the same seeds (the adaptive network and its twin) therefore meet the same
// sequence of setups and deals; only the actions differ.
//
// Blind matches (noStatsShare of them): the learning seats read no evidence about anyone for the
// whole match (every other seat in their noStats mask), so the network also trains its
// no-evidence policy after hand 1. That policy is what it plays at n = 0, while AI_ADAPT is off
// and at a table with a person who opted out, and it is the comparator of every measurement.

import { readFileSync, writeFileSync } from 'node:fs';
import { makeConfig, type MatchConfig, type RuleOptions } from '../../engine/src/config.ts';
import { applyAction, expectedActor, newMatch, type MatchState } from '../../engine/src/engine.ts';
import { observe } from '../../engine/src/observe.ts';
import { deriveSeed, mulberry32 } from '../../engine/src/rng.ts';
import { agentContext } from '../../ai/src/agent.ts';
import { NUM_CRITIC_EXTRA, STATS_OFFSET, encoderFor, toCanonicalAction } from '../../ai/src/features.ts';
import { HeuristicAgent, vectorToParams, type HeuristicParams } from '../../ai/src/heuristic.ts';
import { M6_MIX, checkMix, parseMix, seatMatch, type LeagueMix, type LeaguePlayers } from '../../ai/src/league.ts';
import { parseModel, sample, type Model } from '../../ai/src/mlp.ts';
import { NEUTRAL_KNOBS, policy } from '../../ai/src/net-agent.ts';
import { STATS_SIZE } from '../../ai/src/opponent-stats.ts';
import type { CalibratedKnobs } from '../../ai/src/personas.ts';
import { defaultOutcomes, matchTable, type OutcomeModel } from '../../ai/src/winprob.ts';

export interface Job {
  model: string;
  out: string;
  decisions: number;
  seed: string;
  /** Recent snapshots of the run, then the fixed league files (train.py --league-fixed), used by the 'snapshots' kind. */
  league: string[];
  /** Shares of opponent kinds per match (ai/src/league.ts), as an object or as "current=0.3,..."; default M6_MIX. */
  mix?: LeagueMix | string;
  /** 2 against 2: chance that the second opponent is the same player as the first. */
  twoStyles?: number;
  /** Chance that one partner of the learning team is not the current network (2 against 2). */
  partnerSwap: number;
  /** Chance of 2 against 2 (else 1 against 1), of mineiro (else paulista), of random room options. */
  fourPlayers: number;
  mineiro: number;
  randomOptions: number;
  /** Parameters of the tuned heuristic (league member and imitation teacher): a HeuristicParams object, or a vector. */
  heuristicParams?: HeuristicParams | number[];
  /** v1 network and its manifest (characters, extremes and the v1 panel member). */
  v1Model: string;
  v1Manifest: string;
  /** Hands before a switching player changes style: from the first to the second number. */
  switchHands?: [number, number];
  /** 'feints' kind: hands of the first phase (switch by hand) and betting events before the switch (by evidence). Defaults [1, 8] and [2, 8]. */
  feintHands?: [number, number];
  feintEvidence?: [number, number];
  /** The training cycle's human behaviour model (a features v1 file), for the 'human' kind of the mix. */
  human?: string;
  /** 'heuristic': the learning seats play the tuned heuristic, for the imitation warm start. */
  teacher?: 'heuristic';
  /** Share of matches in which the learning seats read no statistics (blind matches). Default 0. */
  noStatsShare?: number;
  /** Play the league files ('snapshots' kind) as the room serves them: Zap knobs, statistics live, the file's safety net. */
  leagueAsServed?: boolean;
  /**
   * 'hand' (default): one episode per seat per hand, ended by the hand's reward. 'match': one
   * episode per seat per match; every hand's reward is added to the seat's latest decision and only
   * the match end closes the episode, so credit flows across hands (the trained explorer, whose
   * play in early hands shapes what the opponent reads later).
   */
  episode?: 'hand' | 'match';
  outcomes?: Record<string, OutcomeModel>;
}

/** Record tail: mask u16, action u8, flags u8, logp f32, reward f32, episode u32, evidence u8, 3 pad bytes. */
export const RECORD_EXTRA = 20;
export function recordSize(model: Model): number {
  return encoderFor(model.header).size + NUM_CRITIC_EXTRA + RECORD_EXTRA;
}

const FLAG_DONE = 1;
const FLAG_MATCH_WON = 2;
const FLAG_FOUR = 4;

/** Domains of the two random streams (ASCII "setu" and "poli"). */
const DOMAIN_SETUP = 0x73657475;
const DOMAIN_POLICY = 0x706f6c69;

export function streamFrom(seed: string, domain: number): () => number {
  return mulberry32(parseInt(deriveSeed(seed, domain, 0).slice(0, 8), 16));
}

function randomOptions(rand: () => number, variant: 'paulista' | 'mineiro'): Partial<RuleOptions> {
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

/** Writes the hidden cards of the other seats (strongest first) for the training critic. */
function criticExtra(s: MatchState, seat: number, out: Uint8Array, offset: number): void {
  const strength = s.hand.strength;
  for (let r = 1; r < 4; r++) {
    if (r >= s.n) break;
    const other = (seat + r) % s.n;
    const cards = s.hand.cards[other].filter((c) => c >= 0).sort((a, b) => strength[b] - strength[a]);
    cards.forEach((c, i) => {
      const base = offset + (r - 1) * 45 + i * 15;
      out[base + strength[c]] = 255;
      out[base + 14] = 255;
    });
  }
}

interface Pending {
  /** Record index in the buffer. */
  index: number;
  seat: number;
}

export interface JobResult {
  decisions: number;
  hands: number;
  matches: number;
  /** Matches per opponent kind and label (first draw, second opponent, partner swap). */
  setups: Record<string, number>;
  /** Mean decision evidence n of the recorded decisions. */
  meanEvidence: number;
  /** Matches played blind (no statistics for the learning seats). */
  blindMatches: number;
}

export interface JobHooks {
  /** Called once per match with its rules and the drawn opponents, before it is played. */
  onMatch?(config: MatchConfig, labels: string[]): void;
}

export function runJob(job: Job, hooks: JobHooks = {}): JobResult {
  const model: Model = parseModel(readFileSync(job.model));
  const enc = encoderFor(model.header);
  const F = enc.size;
  const RECORD_SIZE = F + NUM_CRITIC_EXTRA + RECORD_EXTRA;
  const snapshots: Model[] = job.league.map((p) => parseModel(readFileSync(p)));
  const hp = job.heuristicParams;
  const tunedParams = hp ? (Array.isArray(hp) ? vectorToParams(hp) : hp) : undefined;
  const teacher = new HeuristicAgent(tunedParams);
  const v1 = parseModel(readFileSync(job.v1Model));
  const v1Knobs = (JSON.parse(readFileSync(job.v1Manifest, 'utf8')).personas ?? {}) as CalibratedKnobs;
  const human = job.human ? parseModel(readFileSync(job.human)) : undefined;
  const players: LeaguePlayers = { v1, v1Knobs, tuned: teacher.params, snapshots, switchHands: job.switchHands, feintHands: job.feintHands, feintEvidence: job.feintEvidence, human, snapshotsAsServed: job.leagueAsServed ?? false };
  const matchEpisodes = job.episode === 'match';
  if (job.episode !== undefined && job.episode !== 'hand' && !matchEpisodes) throw new Error(`episode must be 'hand' or 'match', not ${String(job.episode)}`);
  const mix = typeof job.mix === 'string' ? parseMix(job.mix) : (job.mix ?? M6_MIX);
  checkMix(mix);
  const setupRand = streamFrom(job.seed, DOMAIN_SETUP);
  const rand = streamFrom(job.seed, DOMAIN_POLICY);
  const buf = new Uint8Array(job.decisions * RECORD_SIZE + RECORD_SIZE * 4096);
  const dv = new DataView(buf.buffer);
  const x = new Float32Array(F);
  const x0 = new Float32Array(F);
  const phiCache = new Map<string, ReturnType<typeof matchTable>>();
  const setups: Record<string, number> = {};
  let count = 0;
  let hands = 0;
  let matches = 0;
  let episode = 0;
  let evidenceSum = 0;
  let blindMatches = 0;

  while (count < job.decisions) {
    const four = setupRand() < job.fourPlayers;
    const variant = setupRand() < job.mineiro ? 'mineiro' : 'paulista';
    const config: MatchConfig = makeConfig(variant, four ? 4 : 2, setupRand() < job.randomOptions ? randomOptions(setupRand, variant) : {});
    const key = JSON.stringify(config);
    let phi = phiCache.get(key);
    if (!phi) {
      phi = matchTable(config, job.outcomes?.[`${variant}-${config.players}`] ?? defaultOutcomes(config));
      phiCache.set(key, phi);
    }
    const n = config.players;
    const learnTeam = setupRand() < 0.5 ? 0 : 1;
    // Who sits where: 'learn' seats use the current network and are recorded. The imitation
    // warm start plays the network against itself only.
    const setup = job.teacher
      ? { seats: new Array(n).fill('learn') as 'learn'[], labels: ['current:current'] }
      : seatMatch(n, learnTeam, mix, setupRand, players, job.twoStyles ?? 0.5, job.partnerSwap);
    for (const l of setup.labels) {
      const kind = l.startsWith('partner:') ? l.split(':').slice(0, 2).join(':') : l.split(':')[0];
      setups[kind] = (setups[kind] ?? 0) + 1;
    }
    // Drawn from the setup stream, so runs with the same seeds stay aligned whatever the model.
    const blind = setupRand() < (job.noStatsShare ?? 0);
    if (blind) blindMatches++;
    const blindMask = (seat: number) => ((1 << n) - 1) & ~(1 << seat);
    hooks.onMatch?.(config, setup.labels);
    const seats = setup.seats;
    const s = newMatch(config, deriveSeed(job.seed, 0x73656c66, matches));
    matches++;
    let pending: Pending[] = [];
    const matchRecords: Pending[] = [];
    /** Match episodes: the latest decision of each learning seat in this match. */
    const latest = new Map<number, Pending>();
    let handIndex = s.handIndex;
    let before: [number, number] = [s.score[0], s.score[1]];
    let gamesBefore: [number, number] = [s.games[0], s.games[1]];
    const handEpisode = new Map<number, number>();
    const episodeFor = (seat: number) => {
      let e = handEpisode.get(seat);
      if (e === undefined) {
        e = episode++;
        handEpisode.set(seat, e);
      }
      return e;
    };
    while (!s.over) {
      const seat = expectedActor(s);
      const obs = observe(s, seat);
      const who = seats[seat];
      if (who === 'learn') {
        // The learning seats sample the raw network (no safety net), so the recorded log
        // probability is on-policy. In a blind match they read no evidence at all (x equals x0).
        const ctx = agentContext(s, blind ? blindMask(seat) : 0);
        const out = policy(model, obs, x, NEUTRAL_KNOBS, 0, ctx, { safety: 'off' }, x0);
        const a = job.teacher === 'heuristic' ? toCanonicalAction(teacher.act(obs, rand).action, out.canonical) : sample(out.probs, rand);
        const base = count * RECORD_SIZE;
        for (let i = 0; i < F; i++) buf[base + i] = Math.round(x[i] * 255);
        criticExtra(s, seat, buf, base + F);
        const tail = base + F + NUM_CRITIC_EXTRA;
        dv.setUint16(tail, out.canonical.mask, true);
        buf[tail + 2] = a;
        buf[tail + 3] = n === 4 ? FLAG_FOUR : 0;
        dv.setFloat32(tail + 4, Math.log(Math.max(out.probs[a], 1e-12)), true);
        dv.setFloat32(tail + 8, 0, true);
        dv.setUint32(tail + 12, episodeFor(seat), true);
        buf[tail + 16] = Math.min(255, out.n);
        evidenceSum += out.n;
        const p = { index: count, seat };
        pending.push(p);
        matchRecords.push(p);
        latest.set(seat, p);
        count++;
        applyActionCanonical(s, seat, a, out.canonical.slotOf);
      } else {
        applyAction(s, seat, who.act(obs, rand, agentContext(s)).action);
      }
      if (s.over || s.handIndex !== handIndex) {
        // The hand ended: reward every recorded seat with the change in its team's chance of winning.
        const last = s.history[s.history.length - 1];
        const after = last.scoreAfter;
        const gamesAfter = last.gamesAfter;
        const value = (team: number, sc: [number, number], gs: [number, number]) => {
          if (s.over) return s.winner === team ? 1 : 0;
          const reset = gs[0] + gs[1] > gamesBefore[0] + gamesBefore[1];
          const a = reset ? 0 : sc[team];
          const b = reset ? 0 : sc[1 - team];
          return phi!(a, b, gs[team], gs[1 - team]);
        };
        const lastOfSeat = new Map<number, Pending>();
        if (matchEpisodes) for (const [seat2, p] of latest) lastOfSeat.set(seat2, p);
        else for (const p of pending) lastOfSeat.set(p.seat, p);
        for (const [seat2, p] of lastOfSeat) {
          const team = seat2 & 1;
          const r = value(team, after, gamesAfter) - phi!(before[team], before[1 - team], gamesBefore[team], gamesBefore[1 - team]);
          const tail = p.index * RECORD_SIZE + F + NUM_CRITIC_EXTRA;
          if (!matchEpisodes || s.over) buf[tail + 3] |= FLAG_DONE;
          dv.setFloat32(tail + 8, matchEpisodes ? dv.getFloat32(tail + 8, true) + r : r, true);
        }
        pending = [];
        if (!matchEpisodes) handEpisode.clear();
        hands++;
        handIndex = s.handIndex;
        before = [s.score[0], s.score[1]];
        gamesBefore = [s.games[0], s.games[1]];
      }
    }
    for (const p of matchRecords) {
      if ((p.seat & 1) === s.winner) buf[p.index * RECORD_SIZE + F + NUM_CRITIC_EXTRA + 3] |= FLAG_MATCH_WON;
    }
  }
  writeFileSync(job.out, buf.subarray(0, count * RECORD_SIZE));
  const meta = {
    records: count,
    recordSize: RECORD_SIZE,
    features: F,
    featureVersion: enc.version,
    critic: NUM_CRITIC_EXTRA,
    extra: RECORD_EXTRA,
    statsOffset: enc.size > STATS_OFFSET ? STATS_OFFSET : null,
    statsSize: enc.size > STATS_OFFSET ? STATS_SIZE : 0,
    hands,
    matches,
  };
  writeFileSync(job.out + '.json', JSON.stringify(meta));
  return { decisions: count, hands, matches, setups, meanEvidence: count ? evidenceSum / count : 0, blindMatches };
}

function applyActionCanonical(s: MatchState, seat: number, a: number, slotOf: number[]): void {
  const action = a < 3 ? slotOf[a] : a < 6 ? 3 + slotOf[a - 3] : a;
  applyAction(s, seat, action);
}

if (process.argv[1] && process.argv[1].endsWith('selfplay.ts')) {
  const i = process.argv.indexOf('--config');
  if (i < 0) throw new Error('usage: selfplay.ts --config job.json');
  const job = JSON.parse(readFileSync(process.argv[i + 1], 'utf8')) as Job;
  const t0 = performance.now();
  const r = runJob(job);
  const sec = (performance.now() - t0) / 1000;
  console.log(JSON.stringify({ ...r, seconds: sec, decisionsPerSecond: Math.round(r.decisions / sec), handsPerSecond: Math.round(r.hands / sec) }));
}
