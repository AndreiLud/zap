// Small SVG pieces every chart of the kit draws the same way (DATA-SPEC 3.2): marks by shape and
// series, whiskers with 6 px caps, reference lines labeled in words, axis text. Colors come from
// classes in styles/data.css; positions from SVG attributes. No style strings.

import type { ComponentChildren } from 'preact';
import { r1, textWidth, wrapWords, type Series, type Shape } from './scales.ts';

/** Mark radius: markers are at least 8 px across (10 px here), the active one grows. */
export const MARK_R = 5;

export function MarkShape(p: { shape: Shape; x: number; y: number; series: Series; open?: boolean; active?: boolean; r?: number; k?: number }) {
  const r = p.r ?? MARK_R;
  const cls = `mk mk--s${p.series}${p.open ? ' mk--open' : ''}${p.active ? ' is-active' : ''}`;
  const x = r1(p.x);
  const y = r1(p.y);
  if (p.shape === 'square') {
    const h = r * 0.9;
    return <rect class={cls} x={r1(x - h)} y={r1(y - h)} width={r1(2 * h)} height={r1(2 * h)} rx="1" data-k={p.k} />;
  }
  if (p.shape === 'diamond') {
    const h = r * 1.15;
    return <path class={cls} d={`M${x} ${r1(y - h)}L${r1(x + h)} ${y}L${x} ${r1(y + h)}L${r1(x - h)} ${y}Z`} data-k={p.k} />;
  }
  return <circle class={cls} cx={x} cy={y} r={r} data-k={p.k} />;
}

/** An interval as a whisker: a line from lo to hi with 6 px caps. */
export function Whisker(p: { x0: number; x1: number; y: number; series: Series }) {
  const y = r1(p.y);
  return (
    <g class={`whisker whisker--s${p.series}`}>
      <line x1={r1(p.x0)} x2={r1(p.x1)} y1={y} y2={y} />
      <line x1={r1(p.x0)} x2={r1(p.x0)} y1={y - 3} y2={y + 3} />
      <line x1={r1(p.x1)} x2={r1(p.x1)} y1={y - 3} y2={y + 3} />
    </g>
  );
}

/** A vertical whisker (lines and bars): lo and hi in px, caps 6 px wide. */
export function VWhisker(p: { x: number; y0: number; y1: number; series: Series }) {
  const x = r1(p.x);
  return (
    <g class={`whisker whisker--s${p.series}`}>
      <line x1={x} x2={x} y1={r1(p.y0)} y2={r1(p.y1)} />
      <line x1={x - 3} x2={x + 3} y1={r1(p.y0)} y2={r1(p.y0)} />
      <line x1={x - 3} x2={x + 3} y1={r1(p.y1)} y2={r1(p.y1)} />
    </g>
  );
}

/** Text in the chart: axis numbers, labels, notes. `cls` picks the weight and color. */
export function Txt(p: { x: number; y: number; cls?: string; anchor?: 'start' | 'middle' | 'end'; children: ComponentChildren }) {
  return (
    <text class={p.cls} x={r1(p.x)} y={r1(p.y)} text-anchor={p.anchor && p.anchor !== 'start' ? p.anchor : undefined}>
      {p.children}
    </text>
  );
}

/**
 * A label under a chart (axis name, a note) that must stay inside the chart's width: placed as asked
 * when it fits, moved inside when it would run off an edge, wrapped into lines from the left edge
 * when it is wider than the chart (long translations, large text). `extra` is the height the
 * wrapped lines add below the first.
 */
export function fitText(o: { key: string; text: string; x: number; y: number; W: number; px: number; lineH: number; cls: string; anchor?: 'start' | 'middle' | 'end' }): { nodes: preact.JSX.Element[]; extra: number } {
  const w = textWidth(o.text, o.px);
  if (w > o.W) {
    const lines = wrapWords(o.text, o.W, o.px);
    const nodes = lines.map((line, i) => (
      <Txt key={`${o.key}-${i}`} x={0} y={o.y + i * o.lineH} cls={o.cls}>
        {line}
      </Txt>
    ));
    return { nodes, extra: (lines.length - 1) * o.lineH };
  }
  const anchor = o.anchor ?? 'start';
  const left = anchor === 'middle' ? o.x - w / 2 : anchor === 'end' ? o.x - w : o.x;
  const x = left < 0 ? 0 : left + w > o.W ? o.W - w : left;
  return {
    nodes: [
      <Txt key={o.key} x={x} y={o.y} cls={o.cls}>
        {o.text}
      </Txt>,
    ],
    extra: 0,
  };
}

/** A reference line (50%, zero, a limit): 1 px dashed, labeled in words. */
export function RefLine(p: { x1: number; x2: number; y1: number; y2: number; cls?: string }) {
  return <line class={`ref${p.cls ? ` ${p.cls}` : ''}`} x1={r1(p.x1)} x2={r1(p.x2)} y1={r1(p.y1)} y2={r1(p.y2)} />;
}

/** The legend key of a series: its shape, and a short line (dashed when the series is). */
export function LegendKey(p: { series: Series; shape: Shape; dashed?: boolean; line?: boolean; open?: boolean }) {
  return (
    <svg class="legend__key" viewBox="0 0 28 14" width="28" height="14" aria-hidden="true" focusable="false">
      {p.line ? <line class={`ln ln--s${p.series}${p.dashed ? ' ln--dashed' : ''}`} x1="1" x2="27" y1="7" y2="7" /> : null}
      <MarkShape shape={p.shape} x={14} y={7} series={p.series} open={p.open} r={4.5} />
    </svg>
  );
}
