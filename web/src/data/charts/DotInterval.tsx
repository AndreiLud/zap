// Dot plot with 95% whiskers (DATA-SPEC 3.2): one row per thing measured, one x axis, a mark per
// series in the row (shape by series, hollow when the interval holds the reference), the value at
// the row's end, reference lines labeled in words. Phone (under 600 px): each row's name sits on its
// own line above its track, so no line crosses a word. Wide: names in a column on the left.
//
// Used by F8, F13, F14, F16, F17, F18, F22 (difficulty strip), F27 and the personal page.

import { t } from '../../i18n.ts';
import { tipRange } from '../words.ts';
import { useChart } from './Figure.tsx';
import type { Mark } from './keyboard.ts';
import { fitText, MARK_R, MarkShape, RefLine, Txt, Whisker } from './parts.tsx';
import { labelStep, linear, r1, SHAPE_OF, textWidth, wrapWords, type Anchor, type Series, type Shape } from './scales.ts';

export interface DotMark {
  series: Series;
  shape?: Shape;
  /** Hollow: the interval contains the reference (say it in the row's note too). */
  open?: boolean;
  mean: number;
  lo?: number;
  hi?: number;
  /** The series name in the tooltip ("1 against 1"). */
  label?: string;
  /** Formatted value; defaults to format(mean). */
  value?: string;
  /** Extra tooltip lines (the sample). */
  detail?: string[];
}

export interface DotRow {
  key: string;
  label: string;
  /** A second, quieter line: "within noise", "never met in training", the sample. */
  note?: string;
  /** Rows with the same group sit under one group heading. */
  group?: string;
  /** Emphasis for the row of the thing the figure is about (Zap, this version). */
  strong?: boolean;
  marks: DotMark[];
}

export interface DotIntervalProps {
  rows: DotRow[];
  domain: [number, number];
  ticks: number[];
  /** Axis numbers and values. */
  format: (v: number) => string;
  /** The interval in words for the tooltip; defaults to "provavelmente entre {lo} e {hi}". */
  intervalText?: (lo: number, hi: number) => string;
  /** Reference lines across every row (50% "empate", 0 "sem ganho"). */
  refs?: { value: number; label: string }[];
  /** A grey band behind the rows (F18: the distance between two twins by chance alone). */
  band?: { from: number; to: number; label: string };
  /** Words under the axis (what the axis counts). */
  axisLabel?: string;
  /** Said under the axis when some interval is hidden by its mark ("The intervals are smaller than the dots."). */
  smallNote?: string;
  /** Show the value at the end of single mark rows (default true). */
  values?: boolean;
}

/** A reference line at 50%, labeled "empate". */
export const refEven = () => ({ value: 0.5, label: t('data.lab.even') });
/** A reference line at zero, labeled "sem ganho". */
export const refNoGain = () => ({ value: 0, label: t('data.lab.noGain') });

export function DotInterval(p: DotIntervalProps) {
  const { width: W, fs, active, register } = useChart();
  const phone = W < 600;
  const showValues = p.values !== false;
  const single = p.rows.every((r) => r.marks.length === 1);
  const valueText = (m: DotMark) => m.value ?? p.format(m.mean);
  const valueW = showValues && single ? Math.max(...p.rows.map((r) => textWidth(valueText(r.marks[0]), 12.5 * fs))) + 14 : 10;
  const labelW = phone ? 0 : Math.min(W * 0.42, Math.max(...p.rows.map((r) => textWidth(r.label, 13 * fs))) + 18);
  const x0 = labelW + 8;
  const x1 = Math.max(x0 + 60, W - valueW - 6);
  const X = linear(p.domain, [x0, x1]);
  const words = p.intervalText ?? ((lo: number, hi: number) => tipRange(t, p.format(lo), p.format(hi)));

  const refTop = (p.refs?.length || p.band) ? 18 * fs : 4;
  const trackH = (phone ? 26 : 32) * fs;
  const labH = phone ? 17 * fs : 0;
  const groupH = 28 * fs;

  const body: preact.JSX.Element[] = [];
  const marks: Mark[] = [];
  let y = refTop;
  let group: string | undefined;
  let hidden = 0;
  let k = 0;
  p.rows.forEach((row, ri) => {
    if (row.group !== undefined && row.group !== group) {
      group = row.group;
      if (ri > 0) y += 8 * fs;
      body.push(
        <Txt key={`g${ri}`} x={0} y={y + 17 * fs} cls="group-label">
          {row.group}
        </Txt>,
      );
      y += groupH;
    }
    if (phone) {
      // Above its track, wrapped to the chart's width (long names, a note, large text).
      const lines = wrapWords(row.note ? `${row.label} · ${row.note}` : row.label, W, 13.5 * fs);
      lines.forEach((line, li) => {
        body.push(
          <Txt key={`l${ri}-${li}`} x={0} y={y + 12 * fs + li * labH} cls={`row-label${row.strong ? ' row-label--strong' : ''}`}>
            {line}
          </Txt>,
        );
      });
      y += labH * lines.length;
    }
    const cy = y + trackH / 2;
    if (!phone) {
      body.push(
        <Txt key={`l${ri}`} x={row.group !== undefined ? 12 * fs : 0} y={row.note ? cy - 2 * fs : cy + 4.5 * fs} cls={`row-label${row.strong ? ' row-label--strong' : ''}`}>
          {row.label}
        </Txt>,
      );
      if (row.note) {
        body.push(
          <Txt key={`n${ri}`} x={row.group !== undefined ? 12 * fs : 0} y={cy + 12 * fs} cls="row-note">
            {row.note}
          </Txt>,
        );
      }
    }
    body.push(<line key={`tr${ri}`} class="track" x1={r1(x0)} x2={r1(x1)} y1={r1(cy)} y2={r1(cy)} />);
    for (const v of p.ticks) body.push(<line key={`tk${ri}-${v}`} class="tick" x1={r1(X(v))} x2={r1(X(v))} y1={r1(cy - 4)} y2={r1(cy + 4)} />);
    const n = row.marks.length;
    row.marks.forEach((m, mi) => {
      const my = cy + (n > 1 ? (mi - (n - 1) / 2) * 9 : 0);
      const hasCi = m.lo !== undefined && m.hi !== undefined;
      if (hasCi) {
        if ((X(m.hi!) - X(m.lo!)) / 2 < MARK_R + 6) hidden++;
        body.push(<Whisker key={`w${ri}-${mi}`} x0={X(m.lo!)} x1={X(m.hi!)} y={my} series={m.series} />);
      }
      body.push(<MarkShape key={`m${ri}-${mi}`} shape={m.shape ?? SHAPE_OF[m.series]} x={X(m.mean)} y={my} series={m.series} open={m.open} active={active === k} k={k} />);
      const detail = [...(hasCi ? [words(m.lo!, m.hi!)] : []), ...(row.note ? [row.note] : []), ...(m.detail ?? [])];
      marks.push({ x: X(m.mean), y: my, value: valueText(m), label: m.label ? `${row.label}, ${m.label}` : row.label, detail });
      k++;
    });
    if (showValues && single) {
      body.push(
        <Txt key={`v${ri}`} x={x1 + 12} y={cy + 4.5 * fs} cls={`val${row.strong ? ' val--strong' : ''}`}>
          {valueText(row.marks[0])}
        </Txt>,
      );
    }
    y += trackH;
  });
  const plotTop = refTop;
  const plotB = y + 4;

  const back: preact.JSX.Element[] = [];
  if (p.band) {
    const bx0 = X(Math.max(p.domain[0], p.band.from));
    const bx1 = X(Math.min(p.domain[1], p.band.to));
    back.push(<rect key="band" class="zone-band" x={r1(bx0)} y={r1(plotTop)} width={r1(Math.max(1, bx1 - bx0))} height={r1(plotB - plotTop)} />);
    back.push(
      <Txt key="bandl" x={(bx0 + bx1) / 2} y={plotTop - 6} cls="note" anchor="middle">
        {p.band.label}
      </Txt>,
    );
  }
  for (const ref of p.refs ?? []) {
    const x = X(ref.value);
    back.push(<RefLine key={`r${ref.value}`} x1={x} x2={x} y1={plotTop - 2} y2={plotB} />);
    if (!p.band) {
      // Keep the label inside the chart: start it at the line when it would run off the left edge.
      const half = textWidth(ref.label, 12 * fs) / 2;
      const edge = x - half < 0;
      back.push(
        <Txt key={`rl${ref.value}`} x={edge ? Math.max(0, x - 4) : x} y={plotTop - 6} cls="ref-label" anchor={edge ? 'start' : 'middle'}>
          {ref.label}
        </Txt>,
      );
    }
  }

  const axis: preact.JSX.Element[] = [];
  // On a phone the first label near the left edge starts at its tick; the thinning counts that.
  const anchorOf = (v: number, i: number): Anchor => (phone && i === 0 && X(v) - x0 < 20 ? 'start' : 'middle');
  const every = labelStep(p.ticks, X, p.format, 12 * fs, 6, anchorOf);
  p.ticks.forEach((v, i) => {
    if (i % every !== 0) return;
    axis.push(
      <Txt key={`a${v}`} x={X(v)} y={plotB + 16 * fs} anchor={anchorOf(v, i)}>
        {p.format(v)}
      </Txt>,
    );
  });
  let H = plotB + 22 * fs;
  if (p.axisLabel) {
    const al = fitText({ key: 'al', text: p.axisLabel, x: (x0 + x1) / 2, y: plotB + 34 * fs, W, px: 12.5 * fs, lineH: 15 * fs, cls: 'axis-label', anchor: 'middle' });
    axis.push(...al.nodes);
    H += 16 * fs + al.extra;
  }
  if (p.smallNote && hidden > 0) {
    const sn = fitText({ key: 'sn', text: p.smallNote, x: phone ? 0 : x0, y: H + 12 * fs, W, px: 12 * fs, lineH: 15 * fs, cls: 'note' });
    axis.push(...sn.nodes);
    H += 22 * fs + sn.extra;
  }

  register({ marks, mode: 'y' });
  const h = Math.ceil(H);
  return (
    <svg class="plot" viewBox={`0 0 ${W} ${h}`} width={W} height={h} aria-hidden="true" focusable="false" style={{ '--fs': String(fs) }}>
      {back}
      {body}
      <g class="axis">{axis}</g>
    </svg>
  );
}
