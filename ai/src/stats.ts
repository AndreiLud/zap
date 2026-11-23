// Statistics for comparing players in the duplicate format: a sequential test for the promotion
// gate and bootstrap intervals. A pair scores 1, 0.5 or 0 for the candidate.

import { mulberry32 } from '../../engine/src/rng.ts';

export interface SprtResult {
  decision: 'accept' | 'reject' | 'continue';
  llr: number;
  lower: number;
  upper: number;
  n: number;
  mean: number;
}

/**
 * Sequential probability ratio test on pair scores, with the normal approximation and the
 * variance estimated from the data (a "generalized" SPRT). H0: mean = p0; H1: mean = p1.
 * 'accept' means H1 (the candidate is better by the margin), 'reject' means H0.
 */
export function sprt(scores: readonly number[], p0 = 0.5, p1 = 0.515, alpha = 0.05, beta = 0.05): SprtResult {
  const n = scores.length;
  const lower = Math.log(beta / (1 - alpha));
  const upper = Math.log((1 - beta) / alpha);
  if (n < 2) return { decision: 'continue', llr: 0, lower, upper, n, mean: n ? scores[0] : 0 };
  const mean = scores.reduce((a, b) => a + b, 0) / n;
  const variance = Math.max(1e-6, scores.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const llr = ((p1 - p0) * (2 * mean - p0 - p1) * n) / (2 * variance);
  const decision = llr >= upper ? 'accept' : llr <= lower ? 'reject' : 'continue';
  return { decision, llr, lower, upper, n, mean };
}

/** Percentile bootstrap interval for the mean. */
export function bootstrapMean(scores: readonly number[], iterations = 2000, level = 0.95, seed = 1): [number, number] {
  const n = scores.length;
  if (n === 0) return [NaN, NaN];
  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let b = 0; b < iterations; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += scores[Math.floor(rand() * n)];
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(((1 - level) / 2) * iterations)];
  const hi = means[Math.min(iterations - 1, Math.floor((1 - (1 - level) / 2) * iterations))];
  return [lo, hi];
}

/**
 * Shipping rule for the network: it goes live only if it beats the tuned heuristic by at least
 * 2 percentage points (mean of at least 52%) and the 95% interval stays above 50%.
 */
export function beatsByMargin(mean: number, ci95: [number, number], margin = 0.02): boolean {
  return mean >= 0.5 + margin && ci95[0] > 0.5;
}
