// sim.json and replays.json (DATA-SPEC 2.1.5): the story model playing itself and its characters,
// for chapters 1 and 3 of the data page. The matches run in worker threads (tools/data/sim-worker.ts),
// in chunks whose results come back in task order, so the files do not depend on the number of
// threads. Takes minutes: run it only when the story model or the engine changes.
//
// Run A, the game: all seats Zap, matchesPerSegment matches per segment. Per segment:
//   handByBestCard[class]  hand score of the observer's team by the strongest card the observer was
//                          dealt (one observer per hand, seat (match + hand) mod players)
//   firstPlayer            hand score of the team of the seat that played first (the mão)
//   afterRound1[r]         the same, by how round 1 went for that team (only when round 1 finished)
//   outcomes               the OutcomeModel of ai/src/winprob.ts fitted on these hands
//   breakEven[a][b]        the smallest chance of winning the hand for which accepting a truco beats
//                          running, at a to b (tools/data/lib/outcomes.ts)
// Hand scores: 1 when the team took the hand's points, 0 when the other team did, 0.5 when nobody
// scored; mean with the normal 95% interval (sample standard deviation).
//
// Run B, how each character plays: each persona as a team against a team of Zap,
// personaMatchesPerSegment matches per segment, segments pooled. Only the persona's decisions that
// resolve a turn count (a partner signal in 2 against 2 is not a chance to ask):
//   raiseByStrength[persona][bin]  share of chances to ask that became a raise, by hand strength
//                                  (handEstimate with the base rules player's parameters, 9 bins)
//   raiseMap[bin][band]            the same for Zap, by score band
//   answerMap[bin][step]           share of Zap's answers that did not run, by the step answered
//   strongWeak[persona]            asking share with est >= 2/3 (strong) and est < 1/3 (weak)
// Proportions with the Wilson 95% interval.
//
// Replays: from run A in paulista-4, then paulista-2, the first match in seed order on ties:
//   virada  the largest rise of the winning team's own estimate over one hand it won after losing
//           round 1: from its seats' first estimate in the hand to their first one in the next hand,
//           or 1 when the hand ended the match (each seat sees different cards, so the two teams'
//           estimates are never mixed in this rule)
//   blefe   a raise with a hand estimate under 0.25 that the other team ran from; the lowest wins
//   doze    the first hand that reached step 4
//   onze    the first mão de onze the team on the threshold chose to play and won
//
// Usage: docker compose run --rm -T node node tools/data/simulate.ts [--threads N] [--matches N] [--persona-matches N] [--dry]
//   --threads at most 3 (default sources.json sim.threads); --matches and --persona-matches shrink the
//   run for a timing check and imply --dry (nothing is written).

import { readdirSync } from 'node:fs';
import { cpus } from 'node:os';
import { Worker } from 'node:worker_threads';
import { breakEvenTable, emptyOutcomeCounts, fitOutcomes, mergeOutcomeCounts } from './lib/outcomes.ts';
import { abs, isMain, provenance, sha256File, writeGenerated, type Provenance } from './lib/provenance.ts';
import { readSources, SOURCES_PATH, type Sources } from './lib/sources.ts';
import { meanInterval, mergeSum, round, wilson, type MeanInterval, type Proportion } from './lib/stats.ts';
import {
  BANDS,
  BINS,
  CLASSES,
  PERSONA_ORDER,
  REPLAY_KINDS,
  SEGMENTS,
  STEPS,
  better,
  emptyGameChunk,
  emptyPersonaChunk,
  segmentConfig,
  type Candidate,
  type GameChunk,
  type PersonaChunk,
  type Replay,
  type ReplayKind,
  type SegmentId,
  type SimSetup,
  type SimTask,
} from './sim-worker.ts';
import type { OutcomeModel } from '../../ai/src/winprob.ts';
import type { PersonaId } from '../../ai/src/personas.ts';

const SCRIPT = 'tools/data/simulate.ts';
/** Matches per task: small enough to keep every thread busy to the end. */
export const CHUNK = 250;
export const MAX_THREADS = 3;

export interface SegmentGame {
  matches: number;
  decisions: number;
  hands: number;
  normalHands: number;
  handByBestCard: MeanInterval[];
  firstPlayer: MeanInterval;
  afterRound1: { won: MeanInterval; tied: MeanInterval; lost: MeanInterval };
  outcomes: OutcomeModel;
  /** [your score][their score], both from 0 to the threshold minus 1. */
  breakEven: number[][];
}

export interface SimPlay {
  personas: PersonaId[];
  bins: number;
  bands: string[];
  steps: number;
  matchesPerPersona: number;
  decisions: { asking: number; answering: number };
  raiseByStrength: Record<string, Proportion[]>;
  raiseMap: Proportion[][];
  answerMap: Proportion[][];
  strongWeak: Record<string, { strong: Proportion; weak: Proportion }>;
}

export interface SimFile {
  provenance: Provenance;
  segments: SegmentId[];
  /** Normal hands of run A over every segment (the lead of chapter 1). */
  normalHands: number;
  game: Record<SegmentId, SegmentGame>;
  play: SimPlay;
}

export interface ReplaysFile {
  provenance: Provenance;
  replays: Replay[];
}

/** The tasks of a run, game chunks first, in a fixed order. */
export function simTasks(matchesPerSegment: number, personaMatchesPerSegment: number): SimTask[] {
  const tasks: SimTask[] = [];
  for (let g = 0; g < SEGMENTS.length; g++) {
    for (let from = 0; from < matchesPerSegment; from += CHUNK) tasks.push({ kind: 'game', g, from, to: Math.min(matchesPerSegment, from + CHUNK) });
  }
  for (let p = 0; p < PERSONA_ORDER.length; p++) {
    for (let g = 0; g < SEGMENTS.length; g++) {
      for (let from = 0; from < personaMatchesPerSegment; from += CHUNK) tasks.push({ kind: 'persona', p, g, from, to: Math.min(personaMatchesPerSegment, from + CHUNK) });
    }
  }
  return tasks;
}

/** Runs the tasks on `threads` worker threads; results in task order. */
export function runPool(setup: SimSetup, tasks: readonly SimTask[], threads: number, onDone?: (done: number) => void): Promise<(GameChunk | PersonaChunk)[]> {
  return new Promise((resolve, reject) => {
    const results: (GameChunk | PersonaChunk)[] = new Array(tasks.length);
    let next = 0;
    let done = 0;
    let failed = false;
    const workers = Array.from({ length: Math.min(threads, tasks.length) }, () => new Worker(new URL('./sim-worker.ts', import.meta.url), { workerData: { zapDataSim: true, setup } }));
    const stop = () => Promise.all(workers.map((w) => w.terminate()));
    const feed = (w: Worker) => {
      if (next < tasks.length) {
        const index = next++;
        w.postMessage({ index, task: tasks[index] });
      }
    };
    for (const w of workers) {
      w.on('message', (msg: { index: number; ok: boolean; result?: GameChunk | PersonaChunk; error?: string }) => {
        if (failed) return;
        if (!msg.ok) {
          failed = true;
          stop().then(() => reject(new Error(msg.error)));
          return;
        }
        results[msg.index] = msg.result!;
        done++;
        onDone?.(done);
        if (done === tasks.length) stop().then(() => resolve(results));
        else feed(w);
      });
      w.on('error', (e) => {
        if (!failed) {
          failed = true;
          stop().then(() => reject(e));
        }
      });
      feed(w);
    }
  });
}

function roundOutcomes(m: OutcomeModel): OutcomeModel {
  return {
    normal: Object.fromEntries(Object.entries(m.normal).map(([k, v]) => [k, round(v)])),
    normalTie: round(m.normalTie),
    onzeRun: round(m.onzeRun),
    onzeWin: round(m.onzeWin),
    onzeLose: round(m.onzeLose),
    onzeTie: round(m.onzeTie),
    ironTie: round(m.ironTie),
  };
}

/** Merges the chunks of every task into the two files' data (everything but the provenance). */
export function simOutputs(results: readonly (GameChunk | PersonaChunk)[], personaMatchesPerSegment: number): { sim: Omit<SimFile, 'provenance'>; replays: Replay[] } {
  const games = SEGMENTS.map((_, g) => emptyGameChunk(g));
  const personas = PERSONA_ORDER.map((_, p) => emptyPersonaChunk(p, -1));
  const best: Partial<Record<ReplayKind, Candidate>> = {};
  for (const r of results) {
    if ('bestCard' in r) {
      const acc = games[r.g];
      acc.matches += r.matches;
      acc.decisions += r.decisions;
      acc.hands += r.hands;
      r.bestCard.forEach((s, k) => mergeSum(acc.bestCard[k], s));
      mergeSum(acc.first, r.first);
      for (const k of ['won', 'tied', 'lost'] as const) mergeSum(acc.round1[k], r.round1[k]);
      mergeOutcomeCounts(acc.outcomes, r.outcomes);
      for (const kind of REPLAY_KINDS) {
        const c = r.replays[kind];
        if (c && better(kind, c, best[kind])) best[kind] = c;
      }
    } else {
      const acc = personas[r.p];
      acc.matches += r.matches;
      acc.decisions += r.decisions;
      r.ask.forEach((row, b) => row.forEach((c, k) => {
        acc.ask[b][k].n += c.n;
        acc.ask[b][k].raised += c.raised;
      }));
      r.answer.forEach((row, b) => row.forEach((c, k) => {
        const t = acc.answer[b][k];
        t.n += c.n;
        t.run += c.run;
        t.accept += c.accept;
        t.reraise += c.reraise;
      }));
    }
  }
  const game = {} as Record<SegmentId, SegmentGame>;
  let normalHands = 0;
  SEGMENTS.forEach((seg, g) => {
    const acc = games[g];
    const config = segmentConfig(g);
    const outcomes = fitOutcomes(config, acc.outcomes);
    normalHands += acc.outcomes.normalHands;
    game[seg] = {
      matches: acc.matches,
      decisions: acc.decisions,
      hands: acc.hands,
      normalHands: acc.outcomes.normalHands,
      handByBestCard: acc.bestCard.map((s) => meanInterval(s)),
      firstPlayer: meanInterval(acc.first),
      afterRound1: { won: meanInterval(acc.round1.won), tied: meanInterval(acc.round1.tied), lost: meanInterval(acc.round1.lost) },
      outcomes: roundOutcomes(outcomes),
      breakEven: breakEvenTable(config, outcomes).map((row) => row.map((x) => round(x))),
    };
  });
  const sumAsk = (p: number, bins: readonly number[]) => bins.reduce((t, b) => {
    for (const c of personas[p].ask[b]) {
      t.n += c.n;
      t.k += c.raised;
    }
    return t;
  }, { n: 0, k: 0 });
  const raiseByStrength: Record<string, Proportion[]> = {};
  const strongWeak: Record<string, { strong: Proportion; weak: Proportion }> = {};
  let asking = 0;
  let answering = 0;
  PERSONA_ORDER.forEach((id, p) => {
    raiseByStrength[id] = Array.from({ length: BINS }, (_, b) => {
      const t = sumAsk(p, [b]);
      asking += t.n;
      return wilson(t.k, t.n);
    });
    const strong = sumAsk(p, [6, 7, 8]);
    const weak = sumAsk(p, [0, 1, 2]);
    strongWeak[id] = { strong: wilson(strong.k, strong.n), weak: wilson(weak.k, weak.n) };
    for (const row of personas[p].answer) for (const c of row) answering += c.n;
  });
  const zap = personas[PERSONA_ORDER.indexOf('zap')];
  const raiseMap = zap.ask.map((row) => row.map((c) => wilson(c.raised, c.n)));
  const answerMap = zap.answer.map((row) => row.map((c) => wilson(c.n - c.run, c.n)));
  const replays: Replay[] = [];
  for (const kind of REPLAY_KINDS) {
    const c = best[kind];
    if (c) replays.push(c.replay);
  }
  if (BINS !== 9 || STEPS !== 4 || CLASSES !== 14) throw new Error('constants changed: update DATA-SPEC 2.1.5');
  return {
    sim: {
      segments: [...SEGMENTS],
      normalHands,
      game,
      play: {
        personas: [...PERSONA_ORDER],
        bins: BINS,
        bands: [...BANDS],
        steps: STEPS,
        matchesPerPersona: personaMatchesPerSegment * SEGMENTS.length,
        decisions: { asking, answering },
        raiseByStrength,
        raiseMap,
        answerMap,
        strongWeak,
      },
    },
    replays,
  };
}

/** The code the simulation runs: the engine, the AI and these scripts. */
export function simCodeInputs(): string[] {
  const ts = (dir: string) => readdirSync(abs(dir)).filter((f) => f.endsWith('.ts')).map((f) => `${dir}/${f}`);
  return [...ts('engine/src'), ...ts('ai/src'), SCRIPT, 'tools/data/sim-worker.ts', 'tools/data/lib/outcomes.ts', 'tools/data/lib/stats.ts'];
}

/** Taken before the matches start, so the hashes are those of the code and model that ran. */
export function simProvenance(sources: Sources, threads: number): Provenance {
  const m = sources.storyModel;
  return provenance(SCRIPT, [SOURCES_PATH, m.path, m.manifest, ...simCodeInputs()], {
    seed: sources.sim.seed,
    sizes: { matchesPerSegment: sources.sim.matchesPerSegment, personaMatchesPerSegment: sources.sim.personaMatchesPerSegment },
    model: { version: m.version, path: m.path, sha256: sha256File(m.path), manifest: m.manifest, manifestSha256: sha256File(m.manifest), stats: m.stats },
    threads,
    seconds: 0,
  });
}

function argNum(name: string): number | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const v = Number(process.argv[i + 1]);
  if (!Number.isInteger(v) || v <= 0) throw new Error(`--${name} takes a positive integer`);
  return v;
}

async function main(): Promise<void> {
  const sources = readSources();
  const threads = argNum('threads') ?? sources.sim.threads;
  if (threads > MAX_THREADS) throw new Error(`at most ${MAX_THREADS} threads, so other work keeps its cores`);
  if (threads >= cpus().length) console.warn(`warning: ${threads} threads on ${cpus().length} cores`);
  const matches = argNum('matches') ?? sources.sim.matchesPerSegment;
  const personaMatches = argNum('persona-matches') ?? sources.sim.personaMatchesPerSegment;
  const dry = process.argv.includes('--dry') || matches !== sources.sim.matchesPerSegment || personaMatches !== sources.sim.personaMatchesPerSegment;
  const setup: SimSetup = { modelPath: sources.storyModel.path, manifestPath: sources.storyModel.manifest, stats: sources.storyModel.stats, seed: sources.sim.seed };
  const tasks = simTasks(matches, personaMatches);
  const prov = simProvenance(sources, threads);
  const t0 = performance.now();
  let lastLog = 0;
  console.log(`simulate: ${tasks.length} tasks on ${threads} threads (${matches} matches per segment, ${personaMatches} per persona and segment)${dry ? ', dry run' : ''}`);
  const results = await runPool(setup, tasks, threads, (done) => {
    const now = performance.now();
    if (now - lastLog > 30_000 || done === tasks.length) {
      lastLog = now;
      console.log(`simulate: ${done}/${tasks.length} tasks, ${Math.round((now - t0) / 1000)} s`);
    }
  });
  const seconds = (performance.now() - t0) / 1000;
  const { sim, replays } = simOutputs(results, personaMatches);
  const decisions = Object.values(sim.game).reduce((t, g) => t + g.decisions, 0);
  console.log(`simulate: ${Math.round(seconds)} s, ${sim.normalHands} normal hands, ${decisions} decisions in run A, replays ${replays.map((r) => r.id).join(', ')}`);
  if (dry) return;
  prov.seconds = round(seconds, 1);
  prov.measuredAt = new Date().toISOString();
  console.log(`wrote ${writeGenerated('sim.json', { provenance: prov, ...sim } satisfies SimFile)}`);
  console.log(`wrote ${writeGenerated('replays.json', { provenance: prov, replays } satisfies ReplaysFile)}`);
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
