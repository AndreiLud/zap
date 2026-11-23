import { describe, expect, it } from 'vitest';
import { SEGMENTS, decide, orderFromCalibration, panelTest, runSprt, segmentTest, sprtPlan, type Segment, type SprtSpec } from './gate-core.ts';

const SPEC: SprtSpec = { p0: 0.5, p1: 0.515, alpha: 0.05, beta: 0.05, batchPairs: 400, capPairs: 40000 };

/** Repeats a pattern of pair scores (1, 0.5 or 0) to n entries. */
const pattern = (p: number[], n: number, shift = 0) => Array.from({ length: n }, (_, i) => p[(i + shift) % p.length]);
const perSeg = (f: (g: Segment, n: number, offset: number) => number[]) => async (_r: number, offset: number, n: number) =>
  Object.fromEntries(SEGMENTS.map((g) => [g, f(g, n, offset)])) as Record<Segment, number[]>;

describe('sequential test', () => {
  it('plans rounds of a quarter of the batch per segment up to the cap', () => {
    expect(sprtPlan(SPEC)).toEqual({ perSegment: 100, rounds: 100 });
    expect(sprtPlan({ ...SPEC, batchPairs: 8, capPairs: 32 })).toEqual({ perSegment: 2, rounds: 4 });
  });

  it('accepts a clearly better candidate', async () => {
    // Mean 0.6: well above the 1.5 point gain the test looks for.
    const out = await runSprt(SPEC, perSeg((_g, n, off) => pattern([1, 0.5, 0.5, 0.5, 0.5], n, off)));
    expect(out.decision).toBe('accept');
    expect(out.pairs).toBe(400);
    expect(out.llr).toBeGreaterThanOrEqual(out.upper);
    expect(out.perSegment['mineiro-4'].pairs).toBe(100);
  });

  it('stops for H0 when the candidate is equal', async () => {
    const out = await runSprt(SPEC, perSeg((_g, n, off) => pattern([1, 0, 0.5, 0.5], n, off)));
    expect(out.decision).toBe('reject');
    expect(out.llr).toBeLessThanOrEqual(out.lower);
    expect(out.mean).toBeCloseTo(0.5, 6);
    expect(out.pairs).toBeLessThan(SPEC.capPairs);
  });

  it('is inconclusive at the cap when the mean sits between H0 and H1', async () => {
    // 0.5075 is halfway: the log likelihood ratio stays near 0.
    const spec = { ...SPEC, capPairs: 800 };
    // 203 wins in 400 pairs, spread evenly over the pattern.
    const mid = Array.from({ length: 400 }, (_, i) => Math.floor(((i + 1) * 203) / 400) - Math.floor((i * 203) / 400));
    const out = await runSprt(spec, perSeg((_g, n, off) => pattern(mid, n, off)));
    expect(out.decision).toBe('inconclusive');
    expect(out.pairs).toBe(800);
  });
});

describe('segments, panel and the decision', () => {
  it('passes an equal segment and fails one clearly worse', () => {
    const equal = segmentTest(pattern([1, 0, 0.5, 0.5], 2500), 0.015);
    expect(equal.pass).toBe(true);
    const worse = segmentTest(pattern([1, 0, 0, 0.5, 0.5], 2500), 0.015);
    expect(worse.mean).toBeCloseTo(0.4, 6);
    expect(worse.pass).toBe(false);
    expect(worse.lo95).toBeLessThan(-0.015);
  });

  it('fails a panel member the candidate plays worse against', () => {
    const cur = Object.fromEntries(SEGMENTS.map((g) => [g, pattern([1, 0.5, 1, 0.5], 1000)])) as Record<Segment, number[]>;
    const same = panelTest('base', cur, cur, 0.01);
    expect(same.pass).toBe(true);
    expect(same.diff.mean).toBe(0);
    // The candidate drops half a point on one pair in four: 12.5 points worse.
    const worse = Object.fromEntries(SEGMENTS.map((g) => [g, cur[g].map((x, i) => (i % 4 === 0 ? x - 0.5 : x))])) as Record<Segment, number[]>;
    const bad = panelTest('base', worse, cur, 0.01);
    expect(bad.pass).toBe(false);
    expect(bad.diff.mean).toBeCloseTo(-0.125, 6);
    expect(bad.pairs).toBe(4000);
  });

  it('passes only when every rule passes, with one sentence per failed rule', async () => {
    const sprtOk = await runSprt(SPEC, perSeg((_g, n, off) => pattern([1, 0.5, 0.5, 0.5, 0.5], n, off)));
    const seg = Object.fromEntries(SEGMENTS.map((g) => [g, segmentTest(pattern([1, 0.5, 0.5], 400), 0.015)])) as ReturnType<typeof Object.fromEntries>;
    const cur = Object.fromEntries(SEGMENTS.map((g) => [g, pattern([1, 0.5], 100)])) as Record<Segment, number[]>;
    const panel = [panelTest('random', cur, cur, 0.01), panelTest('v1', cur, cur, 0.01)];
    expect(decide(sprtOk, seg, panel, true, SPEC, 0.015, 0.01)).toEqual({ pass: true, reasons: [] });

    const badSeg = { ...seg, 'paulista-4': segmentTest(pattern([0, 0.5], 400), 0.015) };
    const r1 = decide(sprtOk, badSeg, panel, true, SPEC, 0.015, 0.01);
    expect(r1.pass).toBe(false);
    expect(r1.reasons).toHaveLength(1);
    expect(r1.reasons[0]).toContain('paulista-4');

    const worse = Object.fromEntries(SEGMENTS.map((g) => [g, cur[g].map((x) => x - 0.25)])) as Record<Segment, number[]>;
    const r2 = decide(sprtOk, seg, [panel[0], panelTest('v1', worse, cur, 0.01)], true, SPEC, 0.015, 0.01);
    expect(r2.pass).toBe(false);
    expect(r2.reasons).toEqual([expect.stringContaining('Against v1')]);

    const r3 = decide(sprtOk, seg, panel, false, SPEC, 0.015, 0.01);
    expect(r3.pass).toBe(false);
    expect(r3.reasons[0]).toContain('difficulty order');

    const sprtEq = await runSprt(SPEC, perSeg((_g, n, off) => pattern([1, 0, 0.5, 0.5], n, off)));
    const r4 = decide(sprtEq, seg, panel, true, SPEC, 0.015, 0.01);
    expect(r4.pass).toBe(false);
    expect(r4.reasons[0]).toContain('no gain');
  });

  it('reads the order of the characters from the calibration file', () => {
    expect(orderFromCalibration({ order: { otavioEasiest: true, iaraHardestAfterZap: true } })).toBe(true);
    expect(orderFromCalibration({ order: { otavioEasiest: true, iaraHardestAfterZap: false } })).toBe(false);
    expect(orderFromCalibration({ order: { otavioEasiest: false, iaraHardestAfterZap: true } })).toBe(false);
    expect(orderFromCalibration({})).toBe(false);
    expect(orderFromCalibration(null)).toBe(false);
  });
});
