// 100% stacked horizontal bars (DATA-SPEC F11): one bar per row, segments in a fixed order with
// 2 px surface gaps, colored by what they mean (wins in series 1, ties in a neutral grey that
// still reaches 3:1, losses in series 2), named directly above the first bar, and every row named on
// the left (with an optional small glyph). One mark per row; the tooltip lists every segment.

import './shares.css';
import { useChart } from './Figure.tsx';
import type { Mark } from './keyboard.ts';
import { Txt } from './parts.tsx';
import { r1, textWidth } from './scales.ts';

export interface StackSegment {
  key: string;
  label: string;
  /** s1, neutral or s2: the meaning keeps its color in every row. */
  tone: 's1' | 'neutral' | 's2';
}

export interface StackRow {
  key: string;
  label: string;
  /** Shares in the order of the segments; they add up to 1. */
  values: number[];
  /** A small SVG drawn before the label (16 by 22 at scale 1), such as a card glyph. */
  glyph?: preact.JSX.Element;
  strong?: boolean;
}

export interface Stacked100Props {
  segments: StackSegment[];
  rows: StackRow[];
  format: (v: number) => string;
}

export function Stacked100(p: Stacked100Props) {
  const { width: W, fs, active, register } = useChart();
  const glyphW = p.rows.some((r) => r.glyph) ? 20 : 0;
  const labW = Math.min(W * 0.36, Math.max(...p.rows.map((r) => textWidth(r.label, 12.5 * fs))) + 12) + glyphW;
  const x0 = labW;
  const x1 = W - 2;
  const span = x1 - x0;
  const barH = 18 * fs;
  const rowH = 26 * fs;
  let top = 22 * fs;
  const nodes: preact.JSX.Element[] = [];
  const marks: Mark[] = [];

  // Segment names: directly above the first bar when every segment there is wide enough to hold
  // its word; otherwise a key in the same lane (a small swatch before each name), so a segment the
  // first row lacks (the 4 never wins) is still named.
  const first = p.rows[0];
  const wide = (v: number, i: number) => span * v >= Math.max(18, textWidth(p.segments[i].label, 12 * fs) + 6);
  if (first && first.values.every((v, i) => wide(v, i))) {
    let acc = 0;
    first.values.forEach((v, i) => {
      nodes.push(
        <Txt key={`sl${i}`} x={x0 + span * (acc + v / 2)} y={top - 7 * fs} anchor="middle" cls="note">
          {p.segments[i].label}
        </Txt>,
      );
      acc += v;
    });
  } else {
    // The key starts over the bars and wraps to a new line (from the left edge) when it runs out of width.
    const keyH = 16 * fs;
    const items = p.segments.map((s) => ({ s, w: 17 + textWidth(s.label, 12 * fs) }));
    const rows: (typeof items)[] = [[]];
    let lx = x0;
    for (const it of items) {
      const start = rows.at(-1)!.length === 0;
      if (!start && lx + it.w > W) {
        rows.push([]);
        lx = 0;
      }
      rows.at(-1)!.push(it);
      lx += it.w + 16;
    }
    top += (rows.length - 1) * keyH;
    rows.forEach((row, ki) => {
      let kx = ki === 0 ? x0 : 0;
      const ky = top - (rows.length - 1 - ki) * keyH;
      for (const { s, w } of row) {
        const i = p.segments.indexOf(s);
        nodes.push(<rect key={`sk${i}`} class={`seg-${s.tone}`} x={r1(kx)} y={r1(ky - 16 * fs)} width="12" height="10" rx="2" />);
        nodes.push(
          <Txt key={`sl${i}`} x={kx + 17} y={ky - 7 * fs} cls="note">
            {s.label}
          </Txt>,
        );
        kx += w + 16;
      }
    });
  }

  p.rows.forEach((row, ri) => {
    const y = top + ri * rowH;
    const cy = y + barH / 2;
    if (row.glyph) {
      nodes.push(
        <g key={`gl${ri}`} transform={`translate(0 ${r1(cy - 11)})`}>
          {row.glyph}
        </g>,
      );
    }
    nodes.push(
      <Txt key={`l${ri}`} x={glyphW} y={cy + 4.5 * fs} cls={`row-label${row.strong ? ' row-label--strong' : ''}`}>
        {row.label}
      </Txt>,
    );
    let acc = 0;
    row.values.forEach((v, si) => {
      const sx = x0 + span * acc;
      const w = Math.max(0, span * v - 2);
      if (w > 0) {
        nodes.push(<rect key={`s${ri}-${si}`} class={`seg-${p.segments[si].tone}${active === ri ? ' is-active' : ''}`} x={r1(sx + 1)} y={r1(y)} width={r1(w)} height={r1(barH)} rx="2" />);
      }
      acc += v;
    });
    const winsEnd = x0 + span * (row.values[0] ?? 0);
    marks.push({
      x: Math.min(x1, Math.max(x0, winsEnd)),
      y: cy,
      value: p.format(row.values[0] ?? 0),
      label: `${row.label}: ${p.segments[0].label}`,
      detail: p.segments.slice(1).map((s, i) => `${s.label}: ${p.format(row.values[i + 1] ?? 0)}`),
    });
  });
  register({ marks, mode: 'y' });
  const H = Math.ceil(top + p.rows.length * rowH + 4);
  return (
    <svg class="plot" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true" focusable="false" style={{ '--fs': String(fs) }}>
      {nodes}
    </svg>
  );
}
