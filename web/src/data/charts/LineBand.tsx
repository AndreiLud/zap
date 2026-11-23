// Lines with an uncertainty band (DATA-SPEC 3.2): one y axis, up to three series (the second one
// dashed), bands at 18% of the series color, reference lines and vertical markers labeled in words,
// shaded zones (the imitation phase, the weak hands), each series labeled at its end. The pointer
// and the keyboard move by x; the tooltip lists every series at that x.
//
// buildLines() draws into any frame, so SmallMultiples and the replay viewer reuse it.
// Used by F3, F6 (bottom), F7, F12, F20 panels, the replay chance line and the personal rating.

import { t } from '../../i18n.ts';
import { tipRange } from '../words.ts';
import { useChart } from './Figure.tsx';
import type { Mark } from './keyboard.ts';
import { MarkShape, RefLine, Txt } from './parts.tsx';
import { bandPath, linear, linePath, r1, SHAPE_OF, textWidth, wrapWords, type CurveName, type Series, type Shape } from './scales.ts';

export interface LinePoint {
  x: number;
  y: number;
  lo?: number;
  hi?: number;
  /** Extra tooltip lines for this point (the sample). */
  detail?: string[];
}

export interface LineSeries {
  key: string;
  label: string;
  series: Series;
  shape?: Shape;
  dashed?: boolean;
  points: LinePoint[];
  /** Draw a marker at every point (default: when there are 40 points or fewer); the last one always. */
  dots?: boolean;
  /** Text at the end of the line; null for none (a reference line repeated in a panel). */
  endLabel?: string | null;
  /** Leave the series out of the tooltip and the keyboard (a grey reference). */
  quiet?: boolean;
}

export interface Axis {
  domain: [number, number];
  ticks: number[];
  format: (v: number) => string;
  /** Words under (x) or above (y) the axis. */
  label?: string;
}

export interface LineBandProps {
  series: LineSeries[];
  x: Axis;
  y: Axis;
  /** Values in the tooltip. */
  valueFormat: (v: number) => string;
  /** The tooltip's name of an x ("etapa 120"); defaults to x.format. */
  xName?: (x: number) => string;
  intervalText?: (lo: number, hi: number) => string;
  /** Horizontal reference lines (50% "empate"). */
  refs?: { value: number; label: string }[];
  /** Vertical markers ("v1, em jogo"); strong for the version in play. */
  markers?: { x: number; label: string; strong?: boolean }[];
  /** Shaded x ranges ("imitation", "aqui, pedir é blefe"). */
  zones?: { from: number; to: number; label: string }[];
  /** Says once, inside the plot, what the band is ("margem de até ±1,5"). */
  bandNote?: { x: number; text: string };
  /** Leave out an end label that has no room on the right (a legend above names the series). */
  dropUnfitLabels?: boolean;
  /** Plot height at text scale 1, without the axes (default 260, 220 on a phone). */
  height?: number;
  curve?: CurveName;
  /** An x to ring on every series (the replay's current move). */
  current?: number | null;
}

export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
  fs: number;
  active: number;
  /** Index of the first mark of this frame in the chart's mark list. */
  k0: number;
  /** Draw the y axis numbers and the x axis numbers (small multiples share them). */
  yAxis: boolean;
  xAxis: boolean;
  /** Room on the right for end labels (px); computed by LineBand, given by SmallMultiples. */
  right?: number;
  /** Write the labels of zones and markers (small multiples write them in the first panel only). */
  labels?: boolean;
}

/**
 * Thins ticks so that the centers of their labels keep at least `gap` px apart: every step-th one,
 * step as small as fits. When not even the first and the last fit (a narrow panel with the text at
 * 200%), only the first is labeled.
 */
export function thinTicks(ticks: number[], toPx: (v: number) => number, gap: number): number[] {
  if (ticks.length < 2) return ticks;
  const span = (s: number) => Math.abs(toPx(ticks[s]) - toPx(ticks[0]));
  for (let step = 1; step < ticks.length; step++) if (span(step) >= gap) return ticks.filter((_, i) => i % step === 0);
  return ticks.slice(0, 1);
}

/** The gap thinTicks keeps between x labels: the widest label and 10 px, at least 36 px. */
export function xLabelGap(x: Axis, fs: number): number {
  return Math.max(36, ...x.ticks.map((v) => textWidth(x.format(v), 12 * fs) + 10));
}

/** Draws lines, bands and their furniture into a frame; returns the nodes and the marks. */
/** A label over the plot: its x span decides its row, so neighbours never print over each other. */
interface TopLabel {
  key: string;
  x: number;
  anchor: 'start' | 'middle' | 'end';
  w: number;
  row: number;
}

/** Rows for the zone and marker labels: each takes the first row where it touches no other (4 px apart). */
function labelRows(labels: Omit<TopLabel, 'row'>[]): TopLabel[] {
  const span = (l: Omit<TopLabel, 'row'>) => {
    const a = l.anchor === 'start' ? l.x : l.anchor === 'end' ? l.x - l.w : l.x - l.w / 2;
    return [a - 4, a + l.w + 4] as const;
  };
  const placed: TopLabel[] = [];
  for (const l of labels) {
    const [a, b] = span(l);
    let row = 0;
    while (placed.some((q) => q.row === row && span(q)[0] < b && a < span(q)[1])) row++;
    placed.push({ ...l, row });
  }
  return placed;
}

export function buildLines(p: LineBandProps, f: Frame): { nodes: preact.JSX.Element[]; marks: Mark[]; xs: number[] } {
  const fs = f.fs;
  const yLabW = f.yAxis ? Math.max(...p.y.ticks.map((v) => textWidth(p.y.format(v), 12 * fs))) + 8 : 0;
  const bottom = f.y + f.h - (f.xAxis ? 20 * fs + (p.x.label ? 16 * fs : 0) : 4);
  const left = f.x + yLabW;
  const right = f.x + f.w - (f.right ?? 0);
  const X = linear(p.x.domain, [left + 4, right]);
  // Zone and marker labels over the plot; with large text two of them may collide ("imitation" and
  // "v1"), and the later one moves up a row, the plot giving up that row's height.
  const tops = f.labels === false ? [] : labelRows([
    ...(p.zones ?? []).map((z) => ({ key: `z${z.from}`, x: X(Math.max(p.x.domain[0], z.from)) + 4, anchor: 'start' as const, w: textWidth(z.label, 12 * fs) })),
    ...(p.markers ?? []).map((m) => {
      const x = X(m.x);
      const w = textWidth(m.label, 12 * fs);
      return { key: `m${m.x}`, x, anchor: x + w / 2 > right ? ('end' as const) : x - w / 2 < left ? ('start' as const) : ('middle' as const), w };
    }),
  ]);
  const rows = Math.max(0, ...tops.map((l) => l.row));
  const top = f.y + ((p.markers?.length || p.zones?.length) ? 20 * fs + rows * 15 * fs : 8);
  const Y = linear(p.y.domain, [bottom, top]);
  const rowY = (key: string) => top - 6 * fs - (tops.find((l) => l.key === key)?.row ?? 0) * 15 * fs;
  const nodes: preact.JSX.Element[] = [];
  const key = (s: string) => `${f.k0}-${s}`;

  // Grid and y axis
  for (const v of p.y.ticks) {
    nodes.push(<line key={key(`gy${v}`)} class="grid" x1={r1(left)} x2={r1(right)} y1={r1(Y(v))} y2={r1(Y(v))} />);
    if (f.yAxis) {
      nodes.push(
        <Txt key={key(`ty${v}`)} x={left - 6} y={Y(v) + 4 * fs} anchor="end" cls="axis-num">
          {p.y.format(v)}
        </Txt>,
      );
    }
  }
  if (f.yAxis && p.y.label) {
    nodes.push(
      <Txt key={key('yl')} x={f.x} y={top - 8 * fs} cls="axis-label">
        {p.y.label}
      </Txt>,
    );
  }
  // Zones and markers
  for (const z of p.zones ?? []) {
    const x0 = X(Math.max(p.x.domain[0], z.from));
    const x1 = X(Math.min(p.x.domain[1], z.to));
    nodes.push(<rect key={key(`z${z.from}`)} class="zone" x={r1(x0)} y={r1(top)} width={r1(Math.max(1, x1 - x0))} height={r1(bottom - top)} />);
    if (f.labels !== false) nodes.push(
      <Txt key={key(`zl${z.from}`)} x={x0 + 4} y={rowY(`z${z.from}`)} cls="zone-label">
        {z.label}
      </Txt>,
    );
  }
  for (const m of p.markers ?? []) {
    const x = X(m.x);
    const w = textWidth(m.label, 12 * fs);
    const anchor = x + w / 2 > right ? 'end' : x - w / 2 < left ? 'start' : 'middle';
    nodes.push(<line key={key(`vm${m.x}`)} class={`vmark${m.strong ? ' vmark--strong' : ''}`} x1={r1(x)} x2={r1(x)} y1={r1(top - 2)} y2={r1(bottom)} />);
    if (f.labels !== false) nodes.push(
      <Txt key={key(`vml${m.x}`)} x={x} y={rowY(`m${m.x}`)} anchor={anchor} cls={m.strong ? 'note note--strong' : 'note'}>
        {m.label}
      </Txt>,
    );
  }
  // Reference lines
  for (const r of p.refs ?? []) {
    nodes.push(<RefLine key={key(`r${r.value}`)} x1={left} x2={right} y1={Y(r.value)} y2={Y(r.value)} />);
    nodes.push(
      <Txt key={key(`rl${r.value}`)} x={right} y={Y(r.value) - 5} anchor="end" cls="ref-label">
        {r.label}
      </Txt>,
    );
  }
  // x axis
  if (f.xAxis) {
    const shown = thinTicks(p.x.ticks, (v) => X(v), xLabelGap(p.x, fs));
    for (const v of shown) {
      nodes.push(
        <Txt key={key(`tx${v}`)} x={X(v)} y={bottom + 16 * fs} anchor="middle" cls="axis-num">
          {p.x.format(v)}
        </Txt>,
      );
    }
    if (p.x.label) {
      nodes.push(
        <Txt key={key('xl')} x={(left + right) / 2} y={bottom + 32 * fs} anchor="middle" cls="axis-label">
          {p.x.label}
        </Txt>,
      );
    }
  }

  // Bands first, then lines, then markers on top
  const curve = p.curve ?? 'linear';
  p.series.forEach((s) => {
    const withBand = s.points.filter((q) => q.lo !== undefined && q.hi !== undefined);
    if (withBand.length > 1) {
      nodes.push(<path key={key(`b${s.key}`)} class={`band band--s${s.series}`} d={bandPath(withBand.map((q) => ({ x: X(q.x), y0: Y(q.lo!), y1: Y(q.hi!) })), curve)} />);
    }
  });
  if (p.bandNote && p.series[0]) {
    const s0 = p.series[0].points;
    const near = [...s0].sort((a, b) => Math.abs(a.x - p.bandNote!.x) - Math.abs(b.x - p.bandNote!.x))[0];
    if (near) {
      const lowY = Y(near.lo ?? near.y);
      const x = X(near.x);
      // Centered under its point, moved inside the frame when it would run off either side; wrapped
      // to the frame's width when it is wider (large text on a narrow phone).
      const lines = wrapWords(p.bandNote.text, right - left, 12 * fs);
      nodes.push(<line key={key('bnl')} class="leader" x1={r1(x)} x2={r1(x)} y1={r1(lowY + 2)} y2={r1(lowY + 12 * fs)} />);
      lines.forEach((line, li) => {
        const w = textWidth(line, 12 * fs);
        const tx = Math.max(left, Math.min(x - w / 2, f.x + f.w - w));
        nodes.push(
          <Txt key={key(`bn${li}`)} x={tx} y={lowY + 25 * fs + li * 15 * fs} cls="note">
            {line}
          </Txt>,
        );
      });
    }
  }
  p.series.forEach((s) => {
    const pts = s.points.map((q) => ({ x: X(q.x), y: Y(q.y) }));
    if (pts.length > 1) {
      nodes.push(
        <path
          key={key(`l${s.key}`)}
          class={`ln ln--s${s.series}${s.dashed ? ' ln--dashed' : ' ln--draw'}`}
          d={linePath(pts, curve)}
          pathLength={s.dashed ? undefined : 1}
        />,
      );
    }
  });

  // Marks: one per x shared by the series (quiet series stay out)
  const loud = p.series.filter((s) => !s.quiet);
  const xs = [...new Set(loud.flatMap((s) => s.points.map((q) => q.x)))].sort((a, b) => a - b);
  const words = p.intervalText ?? ((lo: number, hi: number) => tipRange(t, p.valueFormat(lo), p.valueFormat(hi)));
  const marks: Mark[] = xs.map((x) => {
    const at = loud.map((s) => ({ s, q: s.points.find((q) => q.x === x) })).filter((a) => a.q) as { s: LineSeries; q: LinePoint }[];
    const first = at[0];
    const line = (a: { s: LineSeries; q: LinePoint }) =>
      `${loud.length > 1 ? `${a.s.label}: ` : ''}${p.valueFormat(a.q.y)}${a.q.lo !== undefined && a.q.hi !== undefined ? `, ${words(a.q.lo, a.q.hi)}` : ''}`;
    const detail = loud.length > 1 ? [...at.map(line), ...(first.q.detail ?? [])] : [
      ...(first.q.lo !== undefined && first.q.hi !== undefined ? [words(first.q.lo, first.q.hi)] : []),
      ...(first.q.detail ?? []),
    ];
    return { x: X(x), y: Y(first.q.y), value: p.valueFormat(first.q.y), label: loud.length > 1 ? (p.xName ?? p.x.format)(x) : `${first.s.label}, ${(p.xName ?? p.x.format)(x)}`, detail };
  });
  const activeLocal = f.active - f.k0;
  const activeX = activeLocal >= 0 && activeLocal < xs.length ? xs[activeLocal] : null;
  if (activeX !== null) {
    nodes.push(<line key={key('cross')} class="crosshair" x1={r1(X(activeX))} x2={r1(X(activeX))} y1={r1(top)} y2={r1(bottom)} />);
  }

  // Point markers and end labels
  const ends: { y: number; text: string; s: LineSeries; x: number }[] = [];
  p.series.forEach((s) => {
    const dots = s.dots ?? s.points.length <= 40;
    s.points.forEach((q, i) => {
      const last = i === s.points.length - 1;
      const isActive = activeX !== null && q.x === activeX && !s.quiet;
      const isCurrent = p.current !== undefined && p.current !== null && q.x === p.current;
      if (!(dots || last || isActive || isCurrent)) return;
      nodes.push(
        <MarkShape
          key={key(`p${s.key}-${i}`)}
          shape={s.shape ?? SHAPE_OF[s.series]}
          x={X(q.x)}
          y={Y(q.y)}
          series={s.series}
          r={isActive || isCurrent ? 6 : last ? 5 : 3.5}
          active={isActive || isCurrent}
        />,
      );
    });
    const lastP = s.points[s.points.length - 1];
    const text = s.endLabel === undefined ? s.label : s.endLabel;
    if (lastP && text) ends.push({ y: Y(lastP.y), text, s, x: X(lastP.x) });
  });
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14 * fs) ends[i].y = ends[i - 1].y + 14 * fs;
  ends.forEach((e, i) => {
    const room = f.x + f.w - e.x - 8;
    const fits = textWidth(e.text, 12.5 * fs) <= room;
    // A label with no room on the right goes over its end point; the lowest of two or more goes
    // under it instead, so no other line crosses its words.
    const under = !fits && ends.length > 1 && i === ends.length - 1;
    if (!fits && p.dropUnfitLabels) return;
    nodes.push(
      <Txt key={key(`e${e.s.key}`)} x={fits ? e.x + 9 : e.x} y={fits ? e.y + 4 * fs : under ? e.y + 20 * fs : e.y - 10 * fs} anchor={fits ? 'start' : 'end'} cls={`end-label${e.s.series === 1 ? ' end-label--strong' : ''}`}>
        {e.text}
      </Txt>,
    );
  });
  return { nodes, marks, xs };
}

export function LineBand(p: LineBandProps) {
  const { width: W, fs, active, register } = useChart();
  const phone = W < 560;
  const ends = p.series.map((s) => (s.endLabel === undefined ? s.label : s.endLabel)).filter((s): s is string => !!s);
  const want = ends.length ? Math.max(...ends.map((s) => textWidth(s, 12.5 * fs))) + 14 : 8;
  const right = Math.min(want, W * (phone ? 0.22 : 0.3));
  const plotH = (p.height ?? (phone ? 220 : 260)) * Math.max(1, fs * 0.9);
  const H = Math.ceil(plotH + 20 * fs + (p.x.label ? 16 * fs : 0) + ((p.markers?.length || p.zones?.length) ? 20 * fs : 8));
  // A band note that would take more than one line inside the plot (large text, a narrow phone)
  // goes under the chart, where it crosses no line and no label.
  const noteLines = p.bandNote && textWidth(p.bandNote.text, 12 * fs) > (W - right) * 0.8 ? wrapWords(p.bandNote.text, W, 12 * fs) : [];
  const { nodes, marks } = buildLines(noteLines.length ? { ...p, bandNote: undefined } : p, { x: 0, y: 0, w: W, h: H, fs, active, k0: 0, yAxis: true, xAxis: true, right });
  noteLines.forEach((line, li) =>
    nodes.push(
      <Txt key={`bnu${li}`} x={0} y={H + 14 * fs + li * 15 * fs} cls="note">
        {line}
      </Txt>,
    ),
  );
  const total = Math.ceil(H + (noteLines.length ? 8 * fs + noteLines.length * 15 * fs : 0));
  register({ marks, mode: 'x' });
  return (
    <svg class="plot" viewBox={`0 0 ${W} ${total}`} width={W} height={total} aria-hidden="true" focusable="false" style={{ '--fs': String(fs) }}>
      {nodes}
    </svg>
  );
}
