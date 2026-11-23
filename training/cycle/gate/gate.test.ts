// One real gate run with tiny sizes and one thread: v1 against itself, so the sequential test
// cannot accept and the gate must fail, with every field of zap-gate/1 in place.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runGate, type GateSpec } from './gate.ts';
import { SEGMENTS } from './gate-core.ts';

const V1 = 'ai/models/bootstrap/zap-v1.zapw';

describe('gate on real pairs', () => {
  it('runs 8 pairs on 1 thread and refuses a candidate equal to the current version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zap-gate-'));
    const personas = join(dir, 'personas.json');
    writeFileSync(personas, JSON.stringify({ order: { otavioEasiest: true, iaraHardestAfterZap: true } }));
    const sha = createHash('sha256').update(readFileSync(V1)).digest('hex');
    const spec: GateSpec = {
      candidate: { version: 'v2', file: V1, sha256: sha },
      current: { version: 'v1', file: V1, sha256: sha },
      panel: [
        { member: 'random', agent: { kind: 'random' } },
        { member: 'v1', agent: { kind: 'net', model: V1, knobs: 'zap' } },
      ],
      seed: 'ab'.repeat(32),
      threads: 1,
      stats: 'empty',
      sprt: { p0: 0.5, p1: 0.515, alpha: 0.05, beta: 0.05, batchPairs: 8, capPairs: 8 },
      segments: { pairs: 1, margin: 0.015 },
      panelTest: { pairs: 1, margin: 0.01 },
      personas: { file: personas },
    };
    const t0 = performance.now();
    const r = await runGate(spec);
    expect(performance.now() - t0).toBeLessThan(60_000);
    expect(r.schema).toBe('zap-gate/1');
    expect(r.sprt.pairs).toBe(8);
    expect(r.sprt.decision).not.toBe('accept');
    expect(r.pass).toBe(false);
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(Object.keys(r.segments)).toEqual([...SEGMENTS]);
    expect(r.panel.map((p) => p.member)).toEqual(['random', 'v1']);
    expect(r.panel[0].pairs).toBe(4);
    // The same network on the same deals scores the same against every member.
    expect(r.panel[1].diff.mean).toBe(0);
    expect(r.personas.orderHolds).toBe(true);
  });

  it('refuses a file that does not match its hash', async () => {
    const spec = {
      candidate: { version: 'v2', file: V1, sha256: '0'.repeat(64) },
      current: { version: 'v1', file: V1, sha256: '0'.repeat(64) },
      panel: [],
      seed: 'ab'.repeat(32),
      threads: 1,
      stats: 'empty',
      sprt: { p0: 0.5, p1: 0.515, alpha: 0.05, beta: 0.05, batchPairs: 8, capPairs: 8 },
      segments: { pairs: 1, margin: 0.015 },
      panelTest: { pairs: 1, margin: 0.01 },
      personas: { file: 'none' },
    } as GateSpec;
    await expect(runGate(spec)).rejects.toThrow(/SHA-256/);
  });
});

describe('twin comparison', () => {
  it('pools duplicate pairs of two files over the four segments', async () => {
    const { compare } = await import('./compare.ts');
    const r = await compare(V1, V1, 1, 'cd'.repeat(32), 1, 'empty');
    expect(r.pairs).toBe(4);
    expect(r.lo).toBeLessThanOrEqual(r.mean);
    expect(r.hi).toBeGreaterThanOrEqual(r.mean);
    await expect(compare(V1, V1, 1, 'xyz', 1, 'empty')).rejects.toThrow(/64 hex/);
  });
});
