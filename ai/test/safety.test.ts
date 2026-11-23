import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../engine/src/rng.ts';
import { blend, budget, klMasked } from '../src/safety.ts';

function randomCase(rand: () => number) {
  const l0 = Array.from({ length: 15 }, () => (rand() - 0.5) * 6);
  const l1 = l0.map((v) => v + (rand() - 0.5) * 8 * rand());
  let mask = 0;
  while (mask === 0 || (mask & (mask - 1)) === 0) mask = Math.floor(rand() * (1 << 15));
  return { l0, l1, mask };
}

const softmax = (l: number[], mask: number) => {
  const max = Math.max(...l.filter((_, a) => mask & (1 << a)));
  const e = l.map((v, a) => (mask & (1 << a) ? Math.exp(v - max) : 0));
  const s = e.reduce((x, y) => x + y, 0);
  return e.map((v) => v / s);
};

describe('safety net', () => {
  it('budget: 0 without evidence, half of bmax at nHalf, never above bmax', () => {
    const s = { bmax: 0.1, nHalf: 2 };
    expect(budget(0, s)).toBe(0);
    expect(budget(-1, s)).toBe(0);
    expect(budget(2, s)).toBeCloseTo(0.05, 12);
    for (let n = 1; n < 200; n++) expect(budget(n, s)).toBeLessThan(0.1);
    expect(budget(3, { bmax: Infinity, nHalf: 2 })).toBe(Infinity);
    expect(budget(0, { bmax: Infinity, nHalf: 2 })).toBe(0);
  });

  it('lambda is 1 when the KL fits the budget, 0 when the budget is 0', () => {
    const rand = mulberry32(1);
    for (let t = 0; t < 200; t++) {
      const { l0, l1, mask } = randomCase(rand);
      const kl = klMasked(l1, l0, mask);
      expect(blend(l0, l1, mask, kl + 1e-9).lambda).toBe(1);
      const zero = blend(l0, l1, mask, 0);
      if (kl > 0) {
        expect(zero.lambda).toBe(0);
        expect(Array.from(zero.logits)).toEqual(l0);
      }
    }
  });

  it('the result never goes above the budget and is the largest feasible lambda (within 1e-4)', () => {
    const rand = mulberry32(2);
    for (let t = 0; t < 200; t++) {
      const { l0, l1, mask } = randomCase(rand);
      const kl = klMasked(l1, l0, mask);
      const b = kl * rand() * 0.9;
      const r = blend(l0, l1, mask, b);
      expect(klMasked(r.logits, l0, mask)).toBeLessThanOrEqual(b + 1e-9);
      expect(r.kl).toBeLessThanOrEqual(b + 1e-9);
      // Largest feasible lambda on a fine grid.
      let best = 0;
      for (let i = 0; i <= 2000; i++) {
        const lam = i / 2000;
        const l = l0.map((v, a) => v + lam * (l1[a] - v));
        if (klMasked(l, l0, mask) <= b) best = lam;
      }
      expect(Math.abs(r.lambda - best)).toBeLessThanOrEqual(1e-4 + 1 / 2000);
    }
  });

  it('illegal actions stay at 0 probability', () => {
    const rand = mulberry32(3);
    for (let t = 0; t < 50; t++) {
      const { l0, l1, mask } = randomCase(rand);
      const r = blend(l0, l1, mask, 0.01);
      const p = softmax(Array.from(r.logits), mask);
      p.forEach((v, a) => {
        if (!(mask & (1 << a))) expect(v).toBe(0);
      });
      expect(p.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 12);
    }
  });

  it('KL is 0 for identical logits and positive otherwise', () => {
    expect(klMasked([1, 2, 3], [1, 2, 3], 0b111)).toBe(0);
    expect(klMasked([1, 2, 3], [3, 2, 1], 0b111)).toBeGreaterThan(0);
    // Only legal actions count.
    expect(klMasked([1, 2, 30], [1, 2, -30], 0b011)).toBeCloseTo(0, 12);
  });
});
