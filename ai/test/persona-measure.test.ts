// The characters measured on worker threads (ai/bench/persona-measure.ts) give the numbers of the
// sequential measureStyle (ai/bench/persona-stats.ts), whatever the number of threads.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { measureStyles } from '../bench/persona-measure.ts';
import { measureStyle } from '../bench/persona-stats.ts';
import { parseModel } from '../src/mlp.ts';
import { NetAgent, type Knobs } from '../src/net-agent.ts';

const MODEL = 'ai/models/bootstrap/zap-v1.zapw';
const KNOBS = JSON.parse(readFileSync('ai/models/bootstrap/manifest.json', 'utf8')).personas as Record<string, Knobs>;
const SEED = '5a'.repeat(32);

describe('character measurements on threads', () => {
  it('equal the sequential measurement in scores and counts, with 1 or 2 threads', async () => {
    const model = parseModel(readFileSync(MODEL));
    const seq = measureStyle(model, () => new NetAgent(model, KNOBS.bento), 3, SEED);
    const jobs = [
      { key: 'bento', knobs: KNOBS.bento, pairs: 3 },
      { key: 'ravi', knobs: KNOBS.ravi, pairs: 3 },
    ];
    const one = await measureStyles(MODEL, jobs, { threads: 1, stats: 'live', seed: SEED, chunk: 2 });
    const two = await measureStyles(MODEL, jobs, { threads: 2, stats: 'live', seed: SEED, chunk: 2 });
    for (const k of ['trucoRate', 'bluffRate', 'runRate', 'reraiseRate', 'signalTruth', 'vsZap', 'vsZapSe'] as const) expect(one.bento[k]).toBeCloseTo(seq[k] ?? NaN, 12);
    expect(one.bento.logs.length).toBe(seq.logs.length);
    expect(two).toEqual(one);
    expect(one.ravi.vsZap).toBeGreaterThanOrEqual(0);
  }, 120_000);
});
