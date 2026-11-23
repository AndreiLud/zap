// The explorer test as a bullet chart (DATA-SPEC F9): one horizontal scale in games per 100, each
// row a measured gain, a whisker from its 95% lower end to its one sided 95% upper bound, that bound
// as a tick (data.lab.atMost, "at most": with 95% certainty, no more than this), and the limit as a dashed line
// across every row ("limite"). The rule judges the one sided bound, so the whisker ends there and
// never runs past the tick. Zero is labeled "sem ganho" unless the figure names it. Whether a row
// passes is said in its note, never by color alone.

import { t } from '../../i18n.ts';
import { useChart } from './Figure.tsx';
import type { Mark } from './keyboard.ts';
import { fitText, MarkShape, RefLine, Txt, Whisker } from './parts.tsx';
import { labelStep, linear, r1, SHAPE_OF, textWidth, wrapWords, type Series, type Shape } from './scales.ts';

export interface BulletRow {
  key: string;
  label: string;
  /** data.read.f9.pass / data.read.f9.fails ("passes" / "fails"), or the explorer's attempt; shown under the label. */
  note?: string;
  mean: number;
  lo: number;
  hi: number;
  /** One sided 95% upper bound. */
  upper: number;
  /** The bound as shown (default format(upper)): a bound next to the limit keeps two decimals. */
  upperText?: string;
  series?: Series;
  shape?: Shape;
  detail?: string[];
}

export interface BulletProps {
  rows: BulletRow[];
  domain: [number, number];
  ticks: number[];
  /** Axis numbers and values (signed games per 100). */
  format: (v: number) => string;
  limit: number;
  axisLabel?: string;
  /** Label of the zero line (default "sem ganho"). */
  zeroLabel?: string;
  /** Words of the key under the axis for the upper bound tick (default data.lab.atMost). */
  upperKey?: string;
}

/** The domain of DATA-SPEC F9: from −2 to the larger of 3 and the largest upper bound plus 1. */
export function bulletDomain(uppers: readonly number[], lows: readonly number[] = []): [number, number] {
  const lo = Math.min(-2, ...lows.map((v) => Math.floor(v - 0.5)));
  return [lo, Math.max(3, Math.ceil(Math.max(...uppers, 0) + 1))];
}

export function Bullet(p: BulletProps) {
  const { width: W, fs, active, register } = useChart();
  const phone = W < 600;
  const labW = phone ? 0 : Math.min(W * 0.36, Math.max(...p.rows.map((r) => textWidth(r.label, 13 * fs))) + 16);
  const x0 = labW + 8;
  const x1 = W - 10;
  const X = linear(p.domain, [x0, x1]);
  const top = 22 * fs;
  const labH = phone ? 30 * fs : 0;
  const trackH = 40 * fs;
  const nodes: preact.JSX.Element[] = [];
  const marks: Mark[] = [];
  let y = top;
  p.rows.forEach((row, i) => {
    // Wide: the name wraps inside its column; a row grows when its name and note need more lines.
    const wideLines = phone ? [] : wrapWords(row.label, labW - 10, 13 * fs);
    const rowH = phone ? trackH : Math.max(trackH, (wideLines.length + (row.note ? 1 : 0)) * 15 * fs + 10 * fs);
    if (phone) {
      // Above its track, each line wrapped to the chart's width (long names, large text).
      const labels = wrapWords(row.label, W, 13.5 * fs);
      const notes = row.note ? wrapWords(row.note, W, 12 * fs) : [];
      labels.forEach((line, li) =>
        nodes.push(
          <Txt key={`l${i}-${li}`} x={0} y={y + 12 * fs + li * 15 * fs} cls="row-label">
            {line}
          </Txt>,
        ),
      );
      notes.forEach((line, li) =>
        nodes.push(
          <Txt key={`n${i}-${li}`} x={0} y={y + 26 * fs + (labels.length - 1 + li) * 15 * fs} cls="row-note">
            {line}
          </Txt>,
        ),
      );
      y += labH + (labels.length - 1 + Math.max(0, notes.length - 1)) * 15 * fs;
    }
    const cy = y + rowH / 2;
    if (!phone) {
      // The block of name lines and note, centered on the track.
      const lines = wideLines.length + (row.note ? 1 : 0);
      const first = cy - ((lines - 1) * 15 * fs) / 2 + 4.5 * fs;
      wideLines.forEach((line, li) =>
        nodes.push(
          <Txt key={`l${i}-${li}`} x={0} y={first + li * 15 * fs} cls="row-label">
            {line}
          </Txt>,
        ),
      );
      if (row.note) {
        nodes.push(
          <Txt key={`n${i}`} x={0} y={first + wideLines.length * 15 * fs} cls="row-note">
            {row.note}
          </Txt>,
        );
      }
    }
    nodes.push(<rect key={`tr${i}`} class="bullet-track" x={r1(x0)} y={r1(cy - 4)} width={r1(x1 - x0)} height="8" rx="4" />);
    const s = row.series ?? 2;
    nodes.push(<Whisker key={`w${i}`} x0={X(row.lo)} x1={X(Math.max(row.lo, row.upper))} y={cy} series={s} />);
    const ux = X(row.upper);
    nodes.push(<line key={`u${i}`} class="upper" x1={r1(ux)} x2={r1(ux)} y1={r1(cy - 11)} y2={r1(cy + 11)} />);
    nodes.push(<MarkShape key={`m${i}`} shape={row.shape ?? SHAPE_OF[s]} x={X(row.mean)} y={cy} series={s} active={active === i} />);
    marks.push({
      x: X(row.mean),
      y: cy,
      value: p.format(row.mean),
      label: row.label,
      detail: [`${t('data.lab.atMost')}: ${row.upperText ?? p.format(row.upper)}`, ...(row.note ? [row.note] : []), ...(row.detail ?? [])],
    });
    y += rowH;
  });
  const plotB = y + 2;
  const lx = X(p.limit);
  // Reference lines go under the rows, so the halo of a row label keeps its words clear.
  const refs = [<RefLine key="lim" x1={lx} x2={lx} y1={top - 4} y2={plotB} cls="ref--limit" />];
  nodes.push(
    <Txt key="liml" x={lx} y={top - 8} anchor="middle" cls="ref-label">
      {t('data.lab.limit')}
    </Txt>,
  );
  const zx = X(0);
  refs.push(<RefLine key="zero" x1={zx} x2={zx} y1={top - 4} y2={plotB} />);
  // Centered on the zero line, kept inside the chart when it is wider than the room on a side.
  const zeroText = p.zeroLabel ?? t('data.lab.noGain');
  const zw = textWidth(zeroText, 12 * fs);
  const zxText = Math.max(zw / 2, Math.min(W - zw / 2, zx));
  nodes.push(
    <Txt key="zl" x={zxText} y={plotB + 32 * fs} anchor="middle" cls="ref-label">
      {zeroText}
    </Txt>,
  );
  const every = labelStep(p.ticks, X, p.format, 12 * fs);
  for (const [i, v] of p.ticks.entries()) {
    if (i % every !== 0) continue;
    nodes.push(
      <Txt key={`a${v}`} x={X(v)} y={plotB + 16 * fs} anchor="middle" cls="axis-num">
        {p.format(v)}
      </Txt>,
    );
  }
  // The key of the upper bound tick, under the axis: a tick and what it means, wrapped to the width.
  const ky = plotB + 52 * fs;
  nodes.push(<line key="uk" class="upper" x1={r1(x0)} x2={r1(x0)} y1={r1(ky - 10)} y2={r1(ky + 4)} />);
  const keyLines = wrapWords(p.upperKey ?? t('data.lab.atMost'), W - x0 - 8, 12 * fs);
  keyLines.forEach((line, li) =>
    nodes.push(
      <Txt key={`ukl${li}`} x={x0 + 8} y={ky + li * 15 * fs} cls="note">
        {line}
      </Txt>,
    ),
  );
  let H = ky + 12 * fs + (keyLines.length - 1) * 15 * fs;
  if (p.axisLabel) {
    const al = fitText({ key: 'al', text: p.axisLabel, x: (x0 + x1) / 2, y: H + 10 * fs, W, px: 12.5 * fs, lineH: 15 * fs, cls: 'axis-label', anchor: 'middle' });
    nodes.push(...al.nodes);
    H += 16 * fs + al.extra;
  }
  register({ marks, mode: 'y' });
  const h = Math.ceil(H);
  return (
    <svg class="plot" viewBox={`0 0 ${W} ${h}`} width={W} height={h} aria-hidden="true" focusable="false" style={{ '--fs': String(fs) }}>
      {refs}
      {nodes}
    </svg>
  );
}
