// Heatmap on fixed cut points (DATA-SPEC 3.2 and F15, F21): five steps of one hue, light to strong,
// cells 2 px apart. A label inside a cell wears the ink with the higher contrast on that step and is
// drawn only where it reaches 4.5:1 (palette.ts; the classes hm-l1 to hm-l5 in data.css carry the
// choice per theme). A cell with fewer observations than `minN` gets a 45 degree hatch and says
// "poucos casos". Keyboard moves cell by cell. When the grid needs more room than the chart has, it
// keeps its cell size and scrolls inside its own box.

import './heatmap.css';
import { t } from '../../i18n.ts';
import type { Format } from '../format.ts';
import { useChart } from './Figure.tsx';
import type { Mark } from './keyboard.ts';
import { CUTS, stepOf } from './palette.ts';
import { Txt } from './parts.tsx';
import { r1, textWidth } from './scales.ts';

export interface HeatCell {
  value: number | null;
  n: number;
  /** Extra tooltip lines. */
  detail?: string[];
}

export interface HeatmapProps {
  /** Top to bottom. */
  rows: { key: string; label: string }[];
  /** Left to right. */
  cols: { key: string; label: string }[];
  /** [row][col]. */
  cells: HeatCell[][];
  cuts?: readonly number[];
  /** Cell labels and tooltip values. */
  format: (v: number) => string;
  /** Five legend labels, from stepLabels(). */
  legend: string[];
  /** What the rows and the columns are ("your score", "their score"). */
  rowTitle?: string;
  colTitle?: string;
  /** Tooltip name of a cell ("você 3, eles 7"). */
  cellName?: (row: number, col: number) => string;
  /** Observations under which a cell is hatched (default 200). */
  minN?: number;
}

/** Legend labels of the five steps: "menos de 20%", "de 20% a 35%", ..., "65% ou mais". */
export function stepLabels(f: Format, cuts: readonly number[] = CUTS): string[] {
  const p = (v: number) => f.pct(v, 0);
  const out = [f.text('data.lab.under', { v: p(cuts[0]) })];
  for (let i = 0; i < cuts.length - 1; i++) out.push(f.text('data.fmt.range', { a: p(cuts[i]), b: p(cuts[i + 1]) }));
  out.push(f.text('data.lab.over', { v: p(cuts[cuts.length - 1]) }));
  return out;
}

export function Heatmap(p: HeatmapProps) {
  const { width: W, fs, active, uid, register } = useChart();
  const cuts = p.cuts ?? CUTS;
  const minN = p.minN ?? 200;
  const nr = p.rows.length;
  const nc = p.cols.length;
  const labW = Math.max(...p.rows.map((r) => textWidth(r.label, 12 * fs))) + 10;
  const cs = Math.max(24 * fs, Math.min(60, (W - labW) / Math.max(1, nc)));
  const gridW = labW + cs * nc;
  const SW = Math.max(W, Math.ceil(gridW));
  // Legend: five swatches with their ranges, wrapped to the width; the grid starts under it.
  const nodes: preact.JSX.Element[] = [];
  let lx = 0;
  let ly = 4;
  p.legend.forEach((text, i) => {
    const w = 16 + 6 + textWidth(text, 12 * fs) + 14;
    if (lx + w > SW && lx > 0) {
      lx = 0;
      ly += 18 * fs;
    }
    nodes.push(<rect key={`ls${i}`} class={`hm-s${i + 1}`} x={r1(lx)} y={r1(ly)} width="16" height="12" rx="2" />);
    nodes.push(
      <Txt key={`lt${i}`} x={lx + 22} y={ly + 10.5} cls="legend-text">
        {text}
      </Txt>,
    );
    lx += w;
  });
  const legendH = ly + 26 * fs;
  const titleH = p.colTitle || p.rowTitle ? 18 * fs : 0;
  const colLabH = 18 * fs;
  const gx = labW;
  const gy = legendH + titleH + colLabH;
  const H = Math.ceil(gy + cs * nr + 6);
  const labels = W >= 600 && cs >= 30;
  const hatch = `${uid}-hatch`;

  if (p.colTitle) {
    // Centered over the columns, moved left when it would run past the grid's right edge, never over the row title.
    const w = textWidth(p.colTitle, 12.5 * fs);
    const minX = p.rowTitle ? textWidth(p.rowTitle, 12.5 * fs) + 12 : 0;
    const cx = Math.max(minX, Math.min(gx + (cs * nc) / 2 - w / 2, SW - w));
    nodes.push(
      <Txt key="ct" x={cx} y={legendH + 13 * fs} cls="axis-label">
        {p.colTitle}
      </Txt>,
    );
  }
  if (p.rowTitle) {
    nodes.push(
      <Txt key="rt" x={0} y={legendH + 13 * fs} cls="axis-label">
        {p.rowTitle}
      </Txt>,
    );
  }
  p.cols.forEach((c, j) => {
    nodes.push(
      <Txt key={`c${j}`} x={gx + cs * j + cs / 2} y={gy - 5} anchor="middle" cls="axis-num">
        {c.label}
      </Txt>,
    );
  });
  const marks: Mark[] = [];
  p.rows.forEach((r, i) => {
    const y = gy + cs * i;
    nodes.push(
      <Txt key={`r${i}`} x={labW - 8} y={y + cs / 2 + 4 * fs} anchor="end" cls="axis-num">
        {r.label}
      </Txt>,
    );
    p.cols.forEach((_, j) => {
      const cell = p.cells[i]?.[j] ?? { value: null, n: 0 };
      const x = gx + cs * j;
      const k = i * nc + j;
      const few = cell.value !== null && cell.n < minN;
      const step = cell.value === null ? 0 : stepOf(cell.value, cuts);
      nodes.push(
        <rect
          key={`h${k}`}
          class={`hm-cell ${step ? `hm-s${step}` : 'hm-empty'}${active === k ? ' is-active' : ''}`}
          x={r1(x + 1)}
          y={r1(y + 1)}
          width={r1(cs - 2)}
          height={r1(cs - 2)}
          rx="2"
        />,
      );
      if (few) nodes.push(<rect key={`x${k}`} class="hm-hatch" x={r1(x + 1)} y={r1(y + 1)} width={r1(cs - 2)} height={r1(cs - 2)} rx="2" fill={`url(#${hatch})`} />);
      if (labels && cell.value !== null && !few) {
        nodes.push(
          <Txt key={`v${k}`} x={x + cs / 2} y={y + cs / 2 + 4 * fs} anchor="middle" cls={`hm-label hm-l${step}`}>
            {p.format(cell.value)}
          </Txt>,
        );
      }
      const name = p.cellName ? p.cellName(i, j) : `${r.label}, ${p.cols[j].label}`;
      marks.push({
        x: x + cs / 2,
        y: y + cs / 2,
        hw: cs / 2,
        hh: cs / 2,
        value: cell.value === null ? t('data.lab.noData') : p.format(cell.value),
        label: name,
        detail: [...(few ? [t('data.lab.fewCases')] : []), ...(cell.detail ?? [])],
      });
    });
  });
  register({ marks, mode: 'grid', cols: nc });
  return (
    <div class={SW > W ? 'hm-scroll' : undefined}>
      <svg class="plot" viewBox={`0 0 ${SW} ${H}`} width={SW} height={H} aria-hidden="true" focusable="false" style={{ '--fs': String(fs) }}>
        <defs>
          <pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line class="hatch-line" x1="0" y1="0" x2="0" y2="6" />
          </pattern>
        </defs>
        {nodes}
      </svg>
    </div>
  );
}
