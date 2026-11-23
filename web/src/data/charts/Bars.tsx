// Vertical bars on one y axis (F6 top panel, F25 panels, F26 when it arrives): thin bars with a
// 4 px rounded end anchored to the baseline, 2 px apart at least, an optional 95% whisker and an
// optional tick across the bar (the population value). One mark per bar, nearest by x.
//
// buildBars() draws into any frame, so SmallMultiples reuses it.

import { t } from '../../i18n.ts';
import { tipRange } from '../words.ts';
import { useChart } from './Figure.tsx';
import type { Mark } from './keyboard.ts';
import type { Axis, Frame } from './LineBand.tsx';
import { RefLine, Txt, VWhisker } from './parts.tsx';
import { r1, textWidth, type Series } from './scales.ts';

export interface BarDatum {
  key: string;
  /** The bar's name under the axis ("0", "1", "12 ou mais", "pede truco"). */
  label: string;
  value: number;
  lo?: number;
  hi?: number;
  /** A reference value drawn across the bar (the population value). */
  tick?: number;
  detail?: string[];
  /** A different series for this bar (default: the chart's). */
  series?: Series;
}

export interface BarsProps {
  bars: BarDatum[];
  y: Axis;
  valueFormat: (v: number) => string;
  /** Words under the bars (what x counts). */
  xLabel?: string;
  /** What the tick across a bar is, for the tooltip ("population value"). */
  tickLabel?: string;
  series?: Series;
  refs?: { value: number; label: string }[];
  intervalText?: (lo: number, hi: number) => string;
  /** Plot height at text scale 1 (default 180). */
  height?: number;
  /** Show every bar label even when they crowd (default: thin them). */
  allLabels?: boolean;
}

/** A bar with a 4 px rounded top and a square foot on the baseline. */
export function barPath(x: number, y: number, w: number, base: number, r = 4): string {
  const h = base - y;
  if (h <= 0 || w <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${r1(x)} ${r1(base)}V${r1(y + rr)}Q${r1(x)} ${r1(y)} ${r1(x + rr)} ${r1(y)}H${r1(x + w - rr)}Q${r1(x + w)} ${r1(y)} ${r1(x + w)} ${r1(y + rr)}V${r1(base)}Z`;
}

export function buildBars(p: BarsProps, f: Frame): { nodes: preact.JSX.Element[]; marks: Mark[] } {
  const fs = f.fs;
  const yLabW = f.yAxis ? Math.max(...p.y.ticks.map((v) => textWidth(p.y.format(v), 12 * fs))) + 8 : 0;
  const top = f.y + 8;
  const bottom = f.y + f.h - (f.xAxis ? 20 * fs + (p.xLabel ? 16 * fs : 0) : 4);
  const left = f.x + yLabW + 4;
  const right = f.x + f.w - (f.right ?? 0);
  const n = Math.max(1, p.bars.length);
  const band = (right - left) / n;
  // Thin marks: at most 28 px wide (scaled with the text), never closer than 2 px.
  const bw = Math.max(2, Math.min(band - 2, band * 0.62, 28 * fs));
  const Y = (v: number) => bottom - ((v - p.y.domain[0]) / (p.y.domain[1] - p.y.domain[0] || 1)) * (bottom - top);
  const nodes: preact.JSX.Element[] = [];
  const key = (s: string) => `${f.k0}-${s}`;
  for (const v of p.y.ticks) {
    nodes.push(<line key={key(`g${v}`)} class="grid" x1={r1(left - 4)} x2={r1(right)} y1={r1(Y(v))} y2={r1(Y(v))} />);
    if (f.yAxis) {
      nodes.push(
        <Txt key={key(`ty${v}`)} x={left - 10} y={Y(v) + 4 * fs} anchor="end" cls="axis-num">
          {p.y.format(v)}
        </Txt>,
      );
    }
  }
  for (const r of p.refs ?? []) {
    nodes.push(<RefLine key={key(`r${r.value}`)} x1={left - 4} x2={right} y1={Y(r.value)} y2={Y(r.value)} />);
    nodes.push(
      <Txt key={key(`rl${r.value}`)} x={right} y={Y(r.value) - 5} anchor="end" cls="ref-label">
        {r.label}
      </Txt>,
    );
  }
  const words = p.intervalText ?? ((lo: number, hi: number) => tipRange(t, p.valueFormat(lo), p.valueFormat(hi)));
  const labelGap = Math.max(...p.bars.map((b) => textWidth(b.label, 12 * fs))) + 6;
  const every = p.allLabels ? 1 : Math.max(1, Math.ceil(labelGap / band));
  const marks: Mark[] = [];
  p.bars.forEach((b, i) => {
    const x = left + band * i + (band - bw) / 2;
    const cx = x + bw / 2;
    const s = b.series ?? p.series ?? 1;
    const isActive = f.active === f.k0 + i;
    nodes.push(<path key={key(`b${i}`)} class={`bar bar--s${s}${isActive ? ' is-active' : ''}`} d={barPath(x, Y(Math.max(p.y.domain[0], b.value)), bw, Y(p.y.domain[0]))} />);
    if (b.lo !== undefined && b.hi !== undefined) nodes.push(<VWhisker key={key(`w${i}`)} x={cx} y0={Y(b.lo)} y1={Y(b.hi)} series={0} />);
    if (b.tick !== undefined) nodes.push(<line key={key(`t${i}`)} class="bar-tick" x1={r1(x - 2)} x2={r1(x + bw + 2)} y1={r1(Y(b.tick))} y2={r1(Y(b.tick))} />);
    if (f.xAxis && (i % every === 0 || i === p.bars.length - 1)) {
      nodes.push(
        <Txt key={key(`x${i}`)} x={cx} y={bottom + 16 * fs} anchor="middle" cls="axis-num">
          {b.label}
        </Txt>,
      );
    }
    marks.push({
      x: cx,
      y: Y(b.value),
      value: p.valueFormat(b.value),
      label: b.label,
      detail: [
        ...(b.lo !== undefined && b.hi !== undefined ? [words(b.lo, b.hi)] : []),
        ...(b.tick !== undefined && p.tickLabel ? [`${p.tickLabel}: ${p.valueFormat(b.tick)}`] : []),
        ...(b.detail ?? []),
      ],
    });
  });
  if (f.xAxis && p.xLabel) {
    nodes.push(
      <Txt key={key('xl')} x={(left + right) / 2} y={bottom + 32 * fs} anchor="middle" cls="axis-label">
        {p.xLabel}
      </Txt>,
    );
  }
  return { nodes, marks };
}

export function Bars(p: BarsProps) {
  const { width: W, fs, active, register } = useChart();
  const plotH = (p.height ?? 180) * Math.max(1, fs * 0.9);
  const H = Math.ceil(plotH + 8 + 20 * fs + (p.xLabel ? 16 * fs : 0));
  const { nodes, marks } = buildBars(p, { x: 0, y: 0, w: W, h: H, fs, active, k0: 0, yAxis: true, xAxis: true });
  register({ marks, mode: 'x' });
  return (
    <svg class="plot" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true" focusable="false" style={{ '--fs': String(fs) }}>
      {nodes}
    </svg>
  );
}
