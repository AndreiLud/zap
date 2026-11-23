import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../engine/src/rng.ts';
import { beatsByMargin, bootstrapMean, sprt } from '../src/stats.ts';
import { pairedSummary, pooledPairedSummary } from '../src/evaluate.ts';

function pairs(p: number, n: number, seed: number): number[] {
  // Pair scores from two independent matches won with chance p each.
  const rand = mulberry32(seed);
  return Array.from({ length: n }, () => ((rand() < p ? 1 : 0) + (rand() < p ? 1 : 0)) / 2);
}

describe('sequential test', () => {
  it('accepts a clearly better candidate and rejects an equal one', () => {
    expect(sprt(pairs(0.56, 4000, 1)).decision).toBe('accept');
    expect(sprt(pairs(0.5, 4000, 2)).decision).toBe('reject');
  });

  it('keeps errors near the nominal 5% when the candidate is equal', () => {
    let wrong = 0;
    const runs = 200;
    for (let r = 0; r < runs; r++) {
      const xs = pairs(0.5, 6000, 100 + r);
      // Sequential use: stop at the first boundary crossing, checking every 100 pairs.
      for (let n = 100; n <= xs.length; n += 100) {
        const d = sprt(xs.slice(0, n)).decision;
        if (d === 'accept') wrong++;
        if (d !== 'continue') break;
      }
    }
    expect(wrong / runs).toBeLessThan(0.1);
  });
});

describe('bootstrap and shipping rule', () => {
  it('bootstrap interval covers the mean', () => {
    const xs = pairs(0.55, 2000, 7);
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const [lo, hi] = bootstrapMean(xs);
    expect(lo).toBeLessThan(m);
    expect(hi).toBeGreaterThan(m);
  });

  it('needs 52% and an interval above 50%', () => {
    expect(beatsByMargin(0.53, [0.51, 0.55])).toBe(true);
    expect(beatsByMargin(0.515, [0.505, 0.525])).toBe(false);
    expect(beatsByMargin(0.53, [0.49, 0.57])).toBe(false);
  });
});

describe('pooled paired summary', () => {
  it('counts each deal once across opponents: wider than the naive interval when opponents move together', () => {
    const rand = mulberry32(31);
    const m = 2000;
    // A deal effect shared by every opponent, plus noise of each opponent.
    const deal = Array.from({ length: m }, () => (rand() < 0.5 ? 0.5 : -0.5));
    const groups = Array.from({ length: 6 }, () => {
      const a = deal.map((d) => d + (rand() < 0.5 ? 0.5 : -0.5));
      return { a, b: new Array<number>(m).fill(0) };
    });
    const p = pooledPairedSummary(groups);
    expect(p.pairs).toBe(6 * m);
    expect(p.clusters).toBe(m);
    const naive = pairedSummary(groups.flatMap((g) => g.a), groups.flatMap((g) => g.b));
    expect(p.mean).toBeCloseTo(naive.mean, 12);
    expect(p.naiveSe).toBeCloseTo(naive.se, 12);
    // Cluster variance 0.25 + 0.25 / 6 against 0.5 / 6 per pair pooled: the cluster SE is sqrt(3.5), about 1.87 times the naive one.
    expect(p.se / p.naiveSe).toBeGreaterThan(1.7);
    expect(p.se / p.naiveSe).toBeLessThan(2.05);
  });

  it('equals the naive summary for one opponent and refuses groups of different lengths', () => {
    const a = [1, 0.5, 0, 1, 1];
    const b = [0.5, 0.5, 0.5, 0, 1];
    const p = pooledPairedSummary([{ a, b }]);
    const n = pairedSummary(a, b);
    expect(p.mean).toBeCloseTo(n.mean, 12);
    expect(p.se).toBeCloseTo(n.se, 12);
    expect(() => pooledPairedSummary([{ a, b }, { a: [1], b: [0] }])).toThrow();
  });
});
