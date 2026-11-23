// Intervals for the generated files of the data page (DATA-SPEC 2.1): Wilson for proportions, and
// the normal interval with the sample standard deviation for scores in {0, 0.5, 1}.

export const Z95 = 1.959963984540054;

/** Rounds to d decimals; keeps integers as they are. */
export function round(x: number, d = 4): number {
  if (!Number.isFinite(x) || Number.isInteger(x)) return x;
  const f = 10 ** d;
  const r = Math.round(x * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

/** A proportion with its 95% interval; p, lo and hi are null without observations. */
export interface Proportion {
  n: number;
  p: number | null;
  lo: number | null;
  hi: number | null;
}

/** Wilson score interval for k successes in n trials. */
export function wilson(k: number, n: number, z = Z95, digits = 4): Proportion {
  if (!(n > 0)) return { n: 0, p: null, lo: null, hi: null };
  if (k < 0 || k > n) throw new Error(`wilson: ${k} successes in ${n} trials`);
  const p = k / n;
  const z2 = z * z;
  const den = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / den;
  const half = (z / den) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { n, p: round(p, digits), lo: round(Math.max(0, centre - half), digits), hi: round(Math.min(1, centre + half), digits) };
}

/** Running sums of a score. */
export interface ScoreSum {
  n: number;
  sum: number;
  sumSq: number;
}

export const emptySum = (): ScoreSum => ({ n: 0, sum: 0, sumSq: 0 });

export function addScore(acc: ScoreSum, x: number): void {
  acc.n++;
  acc.sum += x;
  acc.sumSq += x * x;
}

export function mergeSum(into: ScoreSum, from: ScoreSum): void {
  into.n += from.n;
  into.sum += from.sum;
  into.sumSq += from.sumSq;
}

/** A mean score with its 95% interval; null fields without enough observations. */
export interface MeanInterval {
  n: number;
  mean: number | null;
  lo: number | null;
  hi: number | null;
}

/** Mean and normal 95% interval with the sample standard deviation. */
export function meanInterval(acc: ScoreSum, z = Z95, digits = 4): MeanInterval {
  const { n, sum, sumSq } = acc;
  if (n < 2) return { n, mean: n === 1 ? round(sum, digits) : null, lo: null, hi: null };
  const mean = sum / n;
  const variance = Math.max(0, (sumSq - n * mean * mean) / (n - 1));
  const half = z * Math.sqrt(variance / n);
  return { n, mean: round(mean, digits), lo: round(mean - half, digits), hi: round(mean + half, digits) };
}
