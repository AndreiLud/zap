// What a chart exposes to the pointer and the keyboard (DATA-SPEC 3.3, the prototype's chart()):
// each chart registers its marks, in reading order, with a position and the words of its tooltip.
// Pointer: the nearest mark by x (lines, within 48 px), by y (rows, within 24 px) or the cell under
// the pointer (grids). Keyboard: arrows move between marks (a grid moves by row and column), Home
// and End jump, Escape clears. Pure functions, unit tested.

/** One mark of a chart, in px relative to the chart's plot box. */
export interface Mark {
  x: number;
  y: number;
  /** The big line of the tooltip: the value. */
  value: string;
  /** What the value is: the row, the series, the point. */
  label: string;
  /** More lines: the interval in words, the sample. */
  detail?: string[];
  /** Half sizes of a cell (grids), for the hit test. */
  hw?: number;
  hh?: number;
}

/**
 * x: lines (nearest by x); y: rows (nearest by y, then x); xy: points spread in two dimensions
 * (small multiples; nearest by distance, within 48 px); grid: cells (row major, `cols` wide).
 */
export type MarkMode = 'x' | 'y' | 'xy' | 'grid';

export interface MarkSet {
  marks: Mark[];
  mode: MarkMode;
  cols?: number;
}

/** The sentence the live region reads for a mark. */
export function sayMark(m: Mark): string {
  return [`${m.label}: ${m.value}`, ...(m.detail ?? [])].join('. ') + '.';
}

/** Index of the mark under or nearest to a point, or -1 when none is close enough. */
export function nearestMark(set: MarkSet, px: number, py: number): number {
  const { marks, mode } = set;
  let best = -1;
  let bd = Infinity;
  marks.forEach((m, k) => {
    let d: number;
    if (mode === 'x') d = Math.abs(m.x - px);
    else if (mode === 'xy') d = Math.hypot(m.x - px, m.y - py);
    else if (mode === 'y') {
      const dy = Math.abs(m.y - py);
      d = dy > 24 ? Infinity : dy * 1000 + Math.abs(m.x - px);
    } else {
      const inside = Math.abs(m.x - px) <= (m.hw ?? 12) && Math.abs(m.y - py) <= (m.hh ?? 12);
      d = inside ? 0 : Infinity;
    }
    if (d < bd) {
      bd = d;
      best = k;
    }
  });
  if ((mode === 'x' || mode === 'xy') && bd > 48) return -1;
  return Number.isFinite(bd) ? best : -1;
}

/**
 * The mark a key moves to from `k` (-1: none active yet), 'clear' for Escape, or null when the key
 * is not a chart key (the browser keeps it).
 */
export function nextMark(key: string, k: number, n: number, mode: MarkMode, cols = 1): number | 'clear' | null {
  if (n <= 0) return key === 'Escape' ? 'clear' : null;
  if (key === 'Escape') return 'clear';
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  if (k < 0 && /^Arrow/.test(key)) return 0;
  if (mode === 'grid' && cols > 1) {
    const row = Math.floor(k / cols);
    const col = k % cols;
    if (key === 'ArrowRight') return col < cols - 1 && k + 1 < n ? k + 1 : k;
    if (key === 'ArrowLeft') return col > 0 ? k - 1 : k;
    if (key === 'ArrowDown') return k + cols < n ? k + cols : k;
    if (key === 'ArrowUp') return row > 0 ? k - cols : k;
    return null;
  }
  if (key === 'ArrowRight' || key === 'ArrowDown') return Math.min(n - 1, k + 1);
  if (key === 'ArrowLeft' || key === 'ArrowUp') return Math.max(0, k - 1);
  return null;
}
