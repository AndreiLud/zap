// Shared geometry for the chart kit: a linear scale, ticks (d3-array), paths (d3-shape), the text
// scale that follows the reader's font size, a rough text width for layout, and the series and
// shape vocabulary (DATA-SPEC 3.2). No DOM writes here; components render JSX.
//
// The linear scale is written here instead of d3-scale's scaleLinear: that one brings
// d3-interpolate, d3-color and d3-format (about 8 KB gzip) for a mapping of two lines, and the kit
// never interpolates colors or formats numbers with it (format.ts does, with Intl).

import { ticks as d3ticks } from 'd3-array';
import { area, curveLinear, curveMonotoneX, curveStepAfter, line, type CurveFactory } from 'd3-shape';

/** Series colors: 1 Zap (cobalt), 2 others (terracotta), 3 people (green), 0 muted grey (reference). */
export type Series = 0 | 1 | 2 | 3;

/** Shapes keep series apart without color: Zap a circle, others a square, people a diamond. */
export type Shape = 'circle' | 'square' | 'diamond';

/** Default shape of each series. */
export const SHAPE_OF: Record<Series, Shape> = { 0: 'circle', 1: 'circle', 2: 'square', 3: 'diamond' };

/** Root font size over 16, capped at 1.6 (the prototype's fsScale): axis text follows the reader. */
export function fsScale(): number {
  if (typeof document === 'undefined') return 1;
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return Math.min(1.6, Math.max(1, px / 16));
}

/**
 * A rough width of a text in px at a font size (Figtree averages about 0.56 em per character). The
 * charts set tabular figures, so every digit, 1 included, is as wide as the others.
 */
export function textWidth(s: string, px: number): number {
  let w = 0;
  for (const ch of s) w += /[ilI.,:;'|! ]/.test(ch) ? 0.3 : /[mwMW@%]/.test(ch) ? 0.86 : /[A-Z0-9]/.test(ch) ? 0.64 : 0.54;
  return w * px;
}

/** Words of a text in lines no wider than `max` px (a single word longer than that keeps its own line). */
export function wrapWords(s: string, max: number, px: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of s.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && textWidth(next, px) > max) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** A linear scale: call it with a value to get px; invert() goes back; domain() and range() read. */
export interface Linear {
  (v: number): number;
  invert(px: number): number;
  domain(): [number, number];
  range(): [number, number];
}

/** A linear scale (no clamping, like d3's default). A zero width domain maps to the range start. */
export function linear(domain: readonly [number, number], range: readonly [number, number]): Linear {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  const f = ((v: number) => r0 + (v - d0) * k) as Linear;
  f.invert = (px: number) => (k === 0 ? d0 : d0 + (px - r0) / k);
  f.domain = () => [d0, d1];
  f.range = () => [r0, r1];
  return f;
}

/** Nice ticks inside a domain, at most `count` of them. */
export function niceTicks(domain: readonly [number, number], count: number): number[] {
  return d3ticks(domain[0], domain[1], Math.max(2, count));
}

/** Ticks every `step` from the domain start (for percent axes: every 10 or 25 points). */
export function stepTicks(domain: readonly [number, number], step: number): number[] {
  const out: number[] = [];
  const start = Math.ceil(domain[0] / step - 1e-9) * step;
  for (let v = start; v <= domain[1] + 1e-9; v += step) out.push(Math.round(v / step) * step || 0);
  return out;
}

/** A symmetric domain around zero that holds every value, rounded up to a whole unit (at least `min`). */
export function symmetricDomain(values: readonly number[], unit: number, min: number): [number, number] {
  const m = Math.max(min, ...values.map((v) => Math.ceil(Math.abs(v) / unit - 1e-9) * unit));
  return [-m, m];
}

/** A domain that holds [lo, hi] and every value, widened to whole steps. */
export function widen(domain: readonly [number, number], values: readonly number[], step: number): [number, number] {
  const lo = Math.min(domain[0], ...values);
  const hi = Math.max(domain[1], ...values);
  return [Math.floor(lo / step + 1e-9) * step, Math.ceil(hi / step - 1e-9) * step];
}

export type CurveName = 'linear' | 'monotone' | 'step';
const CURVES: Record<CurveName, CurveFactory> = { linear: curveLinear, monotone: curveMonotoneX, step: curveStepAfter };

/** The path of a line through points in px. */
export function linePath(pts: readonly { x: number; y: number }[], curve: CurveName = 'linear'): string {
  return (
    line<{ x: number; y: number }>()
      .x((p) => p.x)
      .y((p) => p.y)
      .curve(CURVES[curve])(pts as { x: number; y: number }[]) ?? ''
  );
}

/** The path of a band between two y values per x, in px. */
export function bandPath(pts: readonly { x: number; y0: number; y1: number }[], curve: CurveName = 'linear'): string {
  return (
    area<{ x: number; y0: number; y1: number }>()
      .x((p) => p.x)
      .y0((p) => p.y0)
      .y1((p) => p.y1)
      .curve(CURVES[curve])(pts as { x: number; y0: number; y1: number }[]) ?? ''
  );
}

/** Rounds a px value for SVG attributes (keeps the markup short and stable). */
export const r1 = (v: number) => Math.round(v * 10) / 10;

/** Clamp. */
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export type Anchor = 'start' | 'middle' | 'end';

/** The left and right edge in px of a label of width `w` drawn at `x` with an anchor. */
export function labelSpan(x: number, w: number, anchor: Anchor = 'middle'): [number, number] {
  return anchor === 'start' ? [x, x + w] : anchor === 'end' ? [x - w, x] : [x - w / 2, x + w / 2];
}

/**
 * Which tick labels to draw on a horizontal axis: every k-th one, k as small as keeps neighbours
 * from touching (a gap of `gap` px). With the text at 200% on a phone, ten percent labels no longer
 * fit side by side; the ticks stay, every other label goes. `anchorOf` gives the anchor a label is
 * drawn with (by its value and its index in `ticks`), so a first label anchored at its start counts
 * its whole width to the right. When no k keeps two labels apart, only the first label is drawn.
 */
export function labelStep(ticks: readonly number[], x: (v: number) => number, label: (v: number) => string, px: number, gap = 6, anchorOf?: (v: number, i: number) => Anchor): number {
  const span = (v: number, i: number) => labelSpan(x(v), textWidth(label(v), px), anchorOf?.(v, i) ?? 'middle');
  for (let k = 1; k < ticks.length; k++) {
    const shown = ticks.map((v, i) => span(v, i)).filter((_, i) => i % k === 0);
    if (shown.every((s, j) => j === 0 || Math.max(s[0] - shown[j - 1][1], shown[j - 1][0] - s[1]) >= gap)) return k;
  }
  return Math.max(1, ticks.length);
}
