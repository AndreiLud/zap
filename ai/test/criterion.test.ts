// The explorer criterion judges the file that would be served (ai/bench/criterion.ts): only the
// measurements against that file count, the others are history, and with none against it the
// criterion does not pass. An explorer that failed against an earlier file must be measured again
// against the served file before the criterion can pass.

import { describe, expect, it } from 'vitest';
import { judgeServed, verdictOf, type Diff, type Measured } from '../bench/criterion.ts';

const d = (mean: number, upper95: number): Diff => ({ mean, se: 0.002, ci95: [mean - 0.004, mean + 0.004], upper95, pairs: 8000 });
const REQ = 0.01;
const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);
const scripted = (attempt: number, sha: string, adaptationUpper: number, explorer = `e${attempt}`): Measured => ({
  kind: 'scripted',
  file: `eval/explorer-fresh-${attempt}.json`,
  model: { path: 'export/zap-v2.zapw', sha256: sha },
  adapt: { bmax: sha === OLD ? 0.5 : 0.2, nHalf: 1 },
  attempt,
  searchRankedBy: 'ablated',
  explorers: [verdictOf(explorer, d(0, 0.005), { adaptationPart: d(adaptationUpper - 0.003, adaptationUpper), basePart: d(0, 0.004) }, REQ)],
});

describe('judgeServed', () => {
  it('counts only the measurements against the served file and keeps the others as history', () => {
    // e1 failed against the older file and was measured again against the served one (attempt 3).
    const all = [scripted(1, OLD, 0.011), scripted(2, NEW, 0.008), scripted(3, NEW, 0.009, 'e1')];
    const j = judgeServed(all, NEW);
    expect(j.current.map((m) => m.attempt)).toEqual([2, 3]);
    expect(j.history.map((m) => m.attempt)).toEqual([1]);
    expect(j.pendingRemeasure).toEqual([]);
    expect(j.pass).toBe(true);
    // The same results judged against the older file: its failing verdict counts there.
    expect(judgeServed(all, OLD).pass).toBe(false);
  });

  it('does not pass while an explorer that failed against an earlier file was not measured against the served file', () => {
    const j = judgeServed([scripted(2, OLD, 0.011), scripted(5, NEW, 0.006)], NEW);
    expect(j.verdicts.map((v) => v.pass)).toEqual([true]);
    expect(j.pendingRemeasure).toEqual(['e2']);
    expect(j.pass).toBe(false);
    expect(j.passTwinRule).toBe(false);
    // Once e2 is measured again against the served file and passes, nothing is pending.
    const k = judgeServed([scripted(2, OLD, 0.011), scripted(5, NEW, 0.006), scripted(6, NEW, 0.0095, 'e2')], NEW);
    expect(k.pendingRemeasure).toEqual([]);
    expect(k.pass).toBe(true);
    // Measured again but failing again: nothing pending, and the criterion fails on that verdict.
    const f = judgeServed([scripted(2, OLD, 0.011), scripted(5, NEW, 0.006), scripted(6, NEW, 0.0105, 'e2')], NEW);
    expect(f.pendingRemeasure).toEqual([]);
    expect(f.pass).toBe(false);
  });

  it('fails when any verdict against the served file fails', () => {
    const j = judgeServed([scripted(3, NEW, 0.0077), scripted(4, NEW, 0.0105)], NEW);
    expect(j.verdicts.map((v) => v.pass)).toEqual([true, false]);
    expect(j.pass).toBe(false);
  });

  it('does not pass with no measurement against the served file', () => {
    const j = judgeServed([scripted(1, OLD, -0.003)], NEW);
    expect(j.verdicts).toEqual([]);
    expect(j.pass).toBe(false);
    expect(j.passTwinRule).toBe(false);
  });

  it('applies the 1 point bound to the adaptation part, and the old rule to the gain over the twin', () => {
    const v = verdictOf('x', d(0.012, 0.015), { adaptationPart: d(0.009, 0.01), basePart: d(0.003, 0.006) }, REQ);
    expect(v.pass).toBe(true);
    expect(v.passTwinRule).toBe(false);
  });
});
