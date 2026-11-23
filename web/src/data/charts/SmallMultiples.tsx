// Small multiples with shared axes (DATA-SPEC 3.2: more than 3 series become panels): one SVG, a
// grid of panels (2 columns on a phone, 3 from 600 px by default), each a line chart or a bar chart
// drawn by the same builders as LineBand and Bars. The y numbers sit on the first column only, the
// x numbers on the bottom panel of each column, and the x axis title once under the grid. When a
// panel is too narrow to keep its first and last x labels apart (a phone with the text at 200%),
// the grid takes fewer columns. A reference series (Zap in grey) can be repeated in every panel.
// One tab stop for the whole grid; arrows walk the panels in reading order.

import { useChart } from './Figure.tsx';
import { buildBars, type BarDatum } from './Bars.tsx';
import type { Mark } from './keyboard.ts';
import { buildLines, xLabelGap, type Axis, type LineSeries } from './LineBand.tsx';
import { fitText, Txt } from './parts.tsx';
import { linear, textWidth, type CurveName } from './scales.ts';

export interface Panel {
  key: string;
  title: string;
  /** A second, quieter line under the title ("Tipo 1: 23% das pessoas" or a sample). */
  note?: string;
  lines?: LineSeries[];
  bars?: BarDatum[];
}

export interface SmallMultiplesProps {
  panels: Panel[];
  x: Axis;
  y: Axis;
  valueFormat: (v: number) => string;
  xName?: (x: number) => string;
  intervalText?: (lo: number, hi: number) => string;
  /** Drawn in every line panel, grey and quiet (out of the tooltip). */
  reference?: LineSeries | null;
  refs?: { value: number; label: string }[];
  zones?: { from: number; to: number; label: string }[];
  /** Columns on a phone and from 600 px. */
  columns?: { phone: number; wide: number };
  /** Plot height of a panel at text scale 1 (default 130). */
  panelHeight?: number;
  curve?: CurveName;
  tickLabel?: string;
}

export function SmallMultiples(p: SmallMultiplesProps) {
  const { width: W, fs, active, register } = useChart();
  const gapX = 14;
  // The narrowest plot is in the first column, next to the y numbers (buildLines: yLabW, 4 px each side).
  const yLabW = Math.max(...p.y.ticks.map((v) => textWidth(p.y.format(v), 12 * fs))) + 8;
  const xGap = xLabelGap(p.x, fs);
  const ends = p.x.ticks.length > 1 ? [p.x.ticks[0], p.x.ticks[p.x.ticks.length - 1]] : [];
  const fits = (c: number) => {
    const X = linear(p.x.domain, [0, (W - gapX * (c - 1)) / c - yLabW - 8]);
    return ends.length < 2 || Math.abs(X(ends[1]) - X(ends[0])) >= xGap;
  };
  let cols = Math.max(1, Math.min(p.panels.length, W < 600 ? (p.columns?.phone ?? 2) : (p.columns?.wide ?? 3)));
  while (cols > 1 && p.panels.some((q) => q.lines) && !fits(cols)) cols--;
  const rows = Math.ceil(p.panels.length / cols);
  const gapY = 10 * fs;
  const titleH = (p.panels.some((q) => q.note) ? 34 : 20) * fs;
  const plotH = (p.panelHeight ?? 130) * Math.max(1, fs * 0.9);
  const axisH = 20 * fs;
  const extraTop = p.zones?.length ? 20 * fs : 8;
  const panelW = (W - gapX * (cols - 1)) / cols;
  const nodes: preact.JSX.Element[] = [];
  const marks: Mark[] = [];
  let y = 0;
  for (let r = 0; r < rows; r++) {
    // A row is as tall as its tallest panel: one with x numbers (nothing below it) needs the axis band.
    const rowHasAxis = Array.from({ length: cols }, (_, c) => r * cols + c).some((i) => p.panels[i] && !p.panels[i + cols]);
    const h = extraTop + plotH + (rowHasAxis ? axisH : 4);
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const panel = p.panels[i];
      if (!panel) continue;
      const below = p.panels[i + cols];
      const x = c * (panelW + gapX);
      nodes.push(
        <Txt key={`pt${i}`} x={x} y={y + 14 * fs} cls="panel-title">
          {panel.title}
        </Txt>,
      );
      if (panel.note) {
        nodes.push(
          <Txt key={`pn${i}`} x={x} y={y + 29 * fs} cls="note">
            {panel.note}
          </Txt>,
        );
      }
      // Every plot of a row ends at the same baseline, with or without its own x numbers.
      const frame = { x, y: y + titleH, w: panelW, h: extraTop + plotH + (below ? 4 : axisH), fs, active, k0: marks.length, yAxis: c === 0, xAxis: !below, right: 4, labels: i === 0 };
      if (panel.bars) {
        const out = buildBars({ bars: panel.bars, y: p.y, valueFormat: p.valueFormat, tickLabel: p.tickLabel, refs: p.refs, intervalText: p.intervalText }, frame);
        nodes.push(<g key={`pb${i}`}>{out.nodes}</g>);
        marks.push(...out.marks.map((m) => ({ ...m, label: `${panel.title}, ${m.label}` })));
      } else {
        const series = [...(p.reference ? [{ ...p.reference, key: `ref-${p.reference.key}`, series: 0 as const, quiet: true, endLabel: null, dots: false }] : []), ...(panel.lines ?? [])];
        const out = buildLines(
          { series, x: { ...p.x, label: undefined }, y: p.y, valueFormat: p.valueFormat, xName: p.xName, intervalText: p.intervalText, refs: p.refs, zones: p.zones, curve: p.curve },
          frame,
        );
        nodes.push(<g key={`pl${i}`}>{out.nodes}</g>);
        marks.push(...out.marks.map((m) => ({ ...m, label: `${panel.title}, ${m.label}` })));
      }
    }
    y += titleH + h + gapY;
  }
  // One x axis title for every column, under the last row (two columns would print it twice, side by side).
  let bottom = y;
  if (p.x.label && rows > 0) {
    const base = y - gapY;
    const xl = fitText({ key: 'xl', text: p.x.label, x: W / 2, y: base + 12 * fs, W, px: 12.5 * fs, lineH: 15 * fs, cls: 'axis-label', anchor: 'middle' });
    nodes.push(...xl.nodes);
    bottom = base + 18 * fs + xl.extra;
  }
  register({ marks, mode: 'xy' });
  const H = Math.ceil(bottom);
  return (
    <svg class="plot" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true" focusable="false" style={{ '--fs': String(fs) }}>
      {nodes}
    </svg>
  );
}
