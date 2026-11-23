// Uncertainty in words (DATA-SPEC 3.6). Every interval on the data pages is also said in a sentence,
// and every sentence comes from these helpers, so the rule "an interval that contains the
// reference is noise" is written once.

import type { Key } from '../i18n.ts';
import type { Format, TextFn } from './format.ts';

/** A measured value with its 95% interval (shares or differences, as stored). */
export interface Est {
  mean: number;
  lo: number;
  hi: number;
}

/** The interval lies wholly above the reference. */
export function above(e: Pick<Est, 'lo'>, ref = 0): boolean {
  return e.lo > ref;
}

/** The interval lies wholly below the reference. */
export function below(e: Pick<Est, 'hi'>, ref = 0): boolean {
  return e.hi < ref;
}

/** The interval leaves the reference out (either side). */
export function excludes(e: Pick<Est, 'lo' | 'hi'>, ref = 0): boolean {
  return e.lo > ref || e.hi < ref;
}

/** Two intervals do not overlap. */
export function apart(a: Pick<Est, 'lo' | 'hi'>, b: Pick<Est, 'lo' | 'hi'>): boolean {
  return a.lo > b.hi || b.lo > a.hi;
}

/** The sentence key for a difference against a reference: real or within noise. */
export function realOrNoise(e: Pick<Est, 'lo' | 'hi'>, ref = 0): Key {
  return excludes(e, ref) ? 'data.u.real' : 'data.u.noise';
}

/** Wilson 95% interval of a proportion (k successes in n). */
export function wilson(k: number, n: number, z = 1.96): Est {
  if (n <= 0) return { mean: 0, lo: 0, hi: 1 };
  const p = k / n;
  const z2 = z * z;
  const den = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return { mean: p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/** Words for a share: "79,6%, provavelmente entre 78,8% e 80,5%." */
export function likely(text: TextFn, f: Format, e: Est, digits: 0 | 1 = 1): string {
  return text('data.u.likely', { v: f.pct(e.mean, digits), lo: f.pct(e.lo, digits), hi: f.pct(e.hi, digits) });
}

/** The 80% margin of the reading numbers, in words. */
export function likely80(text: TextFn, f: Format, lo: number, hi: number, digits: 0 | 1 = 0): string {
  return text('data.u.likely80', { lo: f.pct(lo, digits), hi: f.pct(hi, digits) });
}

/** The short form for tooltips: "provavelmente entre 78,8% e 80,5%". */
export function tipRange(text: TextFn, lo: string, hi: string): string {
  return text('data.u.tip', { lo, hi });
}

/** "margem de até ±1,5 ponto" style bound, with the margin already formatted. */
export function upTo(text: TextFn, m: string): string {
  return text('data.u.upTo', { m });
}

/** The warning for a figure whose sample is under its minimum, or null. */
export function smallSample(text: TextFn, n: number, min: number): string | null {
  return n < min ? text('data.u.small') : null;
}

/** The sample of a tooltip or a footer: "Amostra: 4.000". */
export function sample(text: TextFn, f: Format, n: number): string {
  return text('data.fig.sample', { n: f.int(n) });
}

/** The quiet note of a row whose interval holds the reference: "within noise". */
export function noiseNote(text: TextFn): string {
  return text('data.lab.noise');
}
