// The characters measured on worker threads: the numbers of measureStyle (persona-stats.ts) for
// several sets of knobs at once. Each measurement is cut into chunks of pairs per segment; the
// deals and policy seeds are those of measureStyle, so scores and counts are the same, and only
// the order of the recorded hands differs a little (each chunk closes its last hands at its end).
// The result does not depend on the number of threads.

import { summarize } from '../src/evaluate.ts';
import type { Knobs } from '../src/net-agent.ts';
import { SEGMENTS } from '../src/opponent-stats.ts';
import { chunks, runTasks, type StyleTask } from './parallel.ts';
import { empty, type Counts, type HandLog, type StyleMeasure } from './persona-stats.ts';

/** The seed of measureStyle. */
export const STYLE_SEED = 'c3'.repeat(32);

export interface StyleJob {
  key: string;
  knobs: Knobs;
  /** Duplicate pairs per segment. */
  pairs: number;
}

export interface MeasureOptions {
  threads: number;
  /** 'live': every player reads the public statistics of the match; 'empty': no evidence (the room with AI_ADAPT off). */
  stats: 'live' | 'empty';
  seed?: string;
  /** First pair: fresh deals for a check after a calibration. */
  offset?: number;
  chunk?: number;
}

function addCounts(a: Counts, b: Counts): void {
  for (const k of Object.keys(a) as (keyof Counts)[]) a[k] += b[k];
}

/** Each job's team against a team of Zap on the same model, the four segments pooled. */
export async function measureStyles(model: string, jobs: StyleJob[], o: MeasureOptions): Promise<Record<string, StyleMeasure>> {
  const seed = o.seed ?? STYLE_SEED;
  const offset = o.offset ?? 0;
  const tasks: StyleTask[] = [];
  for (const j of jobs) {
    for (const segment of SEGMENTS) {
      for (const c of chunks(offset, j.pairs, o.chunk ?? 25)) {
        tasks.push({
          type: 'style',
          key: `${j.key}|${segment}`,
          segment,
          baseSeed: seed,
          offset: c.offset,
          pairs: c.count,
          a: { kind: 'net', model, knobs: j.knobs, name: j.key, opts: { stats: o.stats } },
          b: { kind: 'net', model, knobs: 'zap', name: 'zap', opts: { stats: o.stats } },
        });
      }
    }
  }
  const res = await runTasks(tasks, o.threads);
  const out: Record<string, StyleMeasure> = {};
  for (const j of jobs) {
    const counts = empty();
    const logs: HandLog[] = [];
    let sum = 0;
    let se2 = 0;
    for (const segment of SEGMENTS) {
      const scores: number[] = [];
      tasks.forEach((t, i) => {
        if (t.key !== `${j.key}|${segment}`) return;
        scores.push(...res[i].scores);
        addCounts(counts, res[i].counts);
        for (const h of res[i].logs) logs.push(h);
      });
      const s = summarize(scores);
      sum += s.mean;
      se2 += s.se * s.se;
    }
    const ratio = (a: number, b: number) => (b ? a / b : null);
    out[j.key] = {
      trucoRate: ratio(counts.handsRaised, counts.handsWithChance),
      bluffRate: ratio(counts.weakRaises, counts.weakChances),
      runRate: ratio(counts.ran, counts.faced),
      reraiseRate: ratio(counts.reraised, counts.faced),
      signalTruth: ratio(counts.trueSignals, counts.signals),
      vsZap: sum / SEGMENTS.length,
      vsZapSe: Math.sqrt(se2) / SEGMENTS.length,
      logs,
    };
  }
  return out;
}
