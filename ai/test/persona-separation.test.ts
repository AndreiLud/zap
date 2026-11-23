// Style separation with its interval (ai/bench/persona-stats.ts): the Wilson interval of the
// accuracy over the test windows, and the number of windows it rests on.

import { describe, expect, it } from 'vitest';
import { separation, wilson95, type HandLog } from '../bench/persona-stats.ts';

const hand = (raises: number, ran: number, covers: number): HandLog => ({ raises, faced: 1, ran, accepted: 1 - ran, reraised: 0, covers, shown: [raises ? 10 : 4] });

describe('style separation', () => {
  it('gives the 95% Wilson interval of a share', () => {
    const [lo, hi] = wilson95(80, 100);
    expect(lo).toBeCloseTo(0.7112, 4);
    expect(hi).toBeCloseTo(0.8666, 4);
    expect(wilson95(0, 10)[0]).toBe(0);
    expect(wilson95(10, 10)[1]).toBe(1);
    expect(wilson95(0, 0).every(Number.isNaN)).toBe(true);
  });

  it('reports the accuracy, the test windows and the interval', () => {
    // Two clearly different players, 200 hands each: 10 windows of 20 hands, 5 of them for testing.
    const a = Array.from({ length: 200 }, (_, i) => hand(i % 2, 0, 0));
    const b = Array.from({ length: 200 }, (_, i) => hand(2 + (i % 2), 1, 2));
    const s = separation(a, b);
    expect(s.testWindows).toBe(10);
    expect(s.accuracy).toBe(1);
    expect(s.ci95).toEqual(wilson95(10, 10));
    expect(s.ci95[0]).toBeLessThan(1);
  });
});
