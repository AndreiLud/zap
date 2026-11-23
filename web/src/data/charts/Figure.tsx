// The anatomy of every figure on the data pages (DATA-SPEC 3.3), its states (3.9), its motion (3.7)
// and its interaction (the prototype's chart(), ported to Preact):
//
//   <figure id aria-labelledby="{id}-t">
//     <h3 id="{id}-t">title</h3>
//     <p class="sub">subtitle</p>
//     [controls row] [legend row]
//     <div class="chart" tabindex="0" role="img" aria-label="{summary}" aria-describedby="{id}-src">svg + tooltip</div>
//     <p class="reading">one reading line</p>
//     <p class="source__line" id="{id}-src">Fonte…</p>
//     <details class="source"><summary><b>Ver os números</b></summary><div class="source__scroll" tabindex="0" role="region">table</div></details>
//     <p class="sr-only" aria-live="polite" id="{id}-live"></p>
//   </figure>
//
// The source line sits before <details>, never inside <summary>: it may hold tap terms (buttons),
// and a button inside a summary's own button role is a nested control (WCAG 4.1.2).
//
// The chart inside is any component of charts/*.tsx: it reads the plot width, the text scale and
// the active mark from useChart(), draws its SVG and registers its marks. The figure handles the
// pointer (nearest mark, tap pins, Esc clears), the keyboard (one tab stop; arrows, Home, End,
// Esc), the tooltip and the live region. Charts render once the figure comes within 600 px of the
// viewport (one IntersectionObserver for the page); until then the figure keeps its height.

import '../../styles/data.css';
import { createContext, type ComponentChildren } from 'preact';
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { t } from '../../i18n.ts';
import { nearestMark, nextMark, sayMark, type MarkSet } from './keyboard.ts';
import { LegendKey } from './parts.tsx';
import { fsScale, type Series, type Shape } from './scales.ts';

// ------------------------------------------------------------------------------------------------
// The chart context

export interface ChartContext {
  /** Width of the plot box in px. */
  width: number;
  /** Text scale (root font size / 16, from 1 to 1.6). */
  fs: number;
  /** Index of the active mark, -1 for none. */
  active: number;
  /** A prefix for ids inside the SVG (patterns), unique per figure. */
  uid: string;
  /** Registers the marks of this render, in reading order. */
  register(set: MarkSet): void;
}

const ChartCtx = createContext<ChartContext | null>(null);

/** The context of the figure around a chart. Outside a figure it gives a fixed 640 px box. */
export function useChart(): ChartContext {
  return useContext(ChartCtx) ?? { width: 640, fs: 1, active: -1, uid: 'chart', register() {} };
}

// ------------------------------------------------------------------------------------------------
// Types of the figure

/** What the figure shows instead of a chart when the data is not ready (DATA-SPEC 3.9). */
export type FigureState =
  | { kind: 'ready' }
  | { kind: 'empty'; message: ComponentChildren; extra?: ComponentChildren }
  | { kind: 'notMeasured' }
  | { kind: 'unavailable' };

export const READY: FigureState = { kind: 'ready' };

/** The numbers behind a chart: values already formatted like the chart. */
export interface TableData {
  columns: { label: string; numeric?: boolean }[];
  rows: string[][];
}

/** A legend entry (2 or 3 series): shape, series, and a line sample for lines. */
export interface LegendItem {
  label: string;
  series: Series;
  shape: Shape;
  line?: boolean;
  dashed?: boolean;
  open?: boolean;
}

export interface FigureProps {
  id: string;
  /** The finding, as text (it is also the table caption). */
  title: string;
  /** One line saying what is measured; may hold tap terms (td()). */
  sub?: ComponentChildren;
  /** One row of segmented buttons (Segmented). */
  controls?: ComponentChildren;
  /** Legend row above the plot, for 2 or 3 series. */
  legend?: LegendItem[];
  /** The chart's accessible summary: the finding plus its key values. */
  summary: string;
  state?: FigureState;
  /** At most one reading line. */
  reading?: ComponentChildren;
  /** Source, date and sample size, in one line. */
  source?: ComponentChildren;
  /** The full numbers (data.fig.numbers, "See the numbers"). Every chart has one when ready. */
  table?: TableData | null;
  /** Height kept before the chart renders, in px (defaults by kind). */
  reserve?: number;
  /** A figure that is not one picture (meters, a hero number, the replay viewer): no tab stop, no role img. */
  plain?: boolean;
  /** Extra class on the figure (the page's own layout). */
  class?: string;
  /** Heading level of the title (h3 by default). */
  level?: 3 | 4;
  children?: ComponentChildren;
}

// ------------------------------------------------------------------------------------------------
// Page wide observers: near the viewport (render), and seen after a scroll (draw-in)

type Watch = (seen: boolean) => void;
let nearIo: IntersectionObserver | null = null;
let seenIo: IntersectionObserver | null = null;
const nearWatch = new Map<Element, Watch>();
const seenWatch = new Map<Element, { first: boolean; fn: Watch }>();
let scrolled = false;
if (typeof window !== 'undefined') addEventListener('scroll', () => (scrolled = true), { passive: true, once: true });

function watchNear(el: Element, fn: Watch): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    fn(true);
    return () => {};
  }
  nearIo ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        nearWatch.get(e.target)?.(true);
        nearWatch.delete(e.target);
        nearIo?.unobserve(e.target);
      }
    },
    { rootMargin: '600px 0px' },
  );
  nearWatch.set(el, fn);
  nearIo.observe(el);
  return () => {
    nearWatch.delete(el);
    nearIo?.unobserve(el);
  };
}

const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Draw-in once: when the figure is first seen at load, or later after the reader scrolled. */
function watchSeen(el: Element, fn: Watch): () => void {
  if (typeof IntersectionObserver === 'undefined' || reducedMotion()) return () => {};
  seenIo ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const w = seenWatch.get(e.target);
        if (!w) continue;
        const atLoad = w.first;
        w.first = false;
        if (!e.isIntersecting || (!atLoad && !scrolled)) continue;
        seenWatch.delete(e.target);
        seenIo?.unobserve(e.target);
        w.fn(true);
      }
    },
    { threshold: 0.35 },
  );
  seenWatch.set(el, { first: true, fn });
  seenIo.observe(el);
  return () => {
    seenWatch.delete(el);
    seenIo?.unobserve(el);
  };
}

/** Length of the draw-in (DATA-SPEC 3.7). */
export const DRAW_MS = 600;

// ------------------------------------------------------------------------------------------------
// Pieces

/** The segmented control row: buttons with aria-pressed; color follows the entity, not the view. */
export function Segmented<T extends string>(p: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div class="seg" role="group" aria-label={p.label}>
      {p.options.map((o) => (
        <button key={o.value} type="button" class="seg__btn" aria-pressed={o.value === p.value} onClick={() => p.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <ul class="legend" aria-label={t('data.fig.legend')}>
      {items.map((it) => (
        <li key={it.label}>
          <LegendKey series={it.series} shape={it.shape} line={it.line} dashed={it.dashed} open={it.open} />
          <span>{it.label}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The table view: caption = the figure title, column headers, the first cell of a row as its header.
 * On a phone a wide table scrolls inside its box, which takes the keyboard focus (a named region),
 * so the right hand columns are reachable where browsers do not focus scrollers by themselves.
 */
export function TableView({ caption, data }: { caption: string; data: TableData }) {
  return (
    <div class="source__scroll" tabIndex={0} role="region" aria-label={caption}>
      <table>
        <caption class="sr-only">{caption}</caption>
        <thead>
          <tr>
            {data.columns.map((c, i) => (
              <th key={i} scope="col" class={c.numeric ? 'num' : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) =>
                j === 0 ? (
                  <th key={j} scope="row">
                    {cell}
                  </th>
                ) : (
                  <td key={j} class={data.columns[j]?.numeric ? 'num' : undefined}>
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The tooltip, rendered after the chart so it reads the marks of this render. */
function ChartTip({ set, active }: { set: { current: MarkSet }; active: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const m = active >= 0 ? set.current.marks[active] : undefined;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !m) return;
    const box = el.parentElement;
    const bw = box?.clientWidth ?? 0;
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    // The SVG may sit lower (a heatmap legend) or scroll sideways inside the plot box.
    const svg = box?.querySelector('svg.plot');
    const br = box?.getBoundingClientRect();
    const sr = svg?.getBoundingClientRect();
    const dx = br && sr ? sr.left - br.left : 0;
    const dy = br && sr ? sr.top - br.top : 0;
    const x = Math.max(0, Math.min(bw - tw, m.x + dx - tw / 2));
    let y = m.y + dy - th - 14;
    if (y < 0) y = m.y + dy + 16;
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
  });
  if (!m) return null;
  return (
    <div class="chart-tip" ref={ref} aria-hidden="true">
      <b>{m.value}</b>
      <span>{m.label}</span>
      {(m.detail ?? []).map((d, i) => (
        <small key={i}>{d}</small>
      ))}
    </div>
  );
}

const RESERVE: Record<string, number> = { plain: 120, chart: 280 };

// ------------------------------------------------------------------------------------------------
// The figure

export function Figure(p: FigureProps) {
  const state = p.state ?? READY;
  const ready = state.kind === 'ready';
  const figRef = useRef<HTMLElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const marks = useRef<MarkSet>({ marks: [], mode: 'x' });
  const [near, setNear] = useState(false);
  const [box, setBox] = useState({ width: 0, fs: 1 });
  const [active, setActive] = useState(-1);
  const [live, setLive] = useState('');
  const [drawing, setDrawing] = useState(false);

  useEffect(() => {
    const el = figRef.current;
    if (!el) return;
    const stopNear = watchNear(el, () => setNear(true));
    const stopSeen = watchSeen(el, () => {
      setDrawing(true);
      setTimeout(() => setDrawing(false), DRAW_MS + 200);
    });
    return () => {
      stopNear();
      stopSeen();
    };
  }, []);

  useLayoutEffect(() => {
    const el = plotRef.current;
    if (!el || !near) return;
    const measure = () => {
      const width = Math.round(el.clientWidth);
      const fs = fsScale();
      setBox((b) => (b.width === width && b.fs === fs ? b : { width, fs }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [near, ready]);

  const ctx = useMemo<ChartContext>(
    () => ({ width: box.width, fs: box.fs, active, uid: p.id, register: (s) => void (marks.current = s) }),
    [box.width, box.fs, active, p.id],
  );

  // The handlers read these refs, so a focus that follows a tap never sees a stale active mark.
  const activeRef = useRef(-1);
  const pinnedRef = useRef(false);
  const byPointer = useRef(false);
  const show = (k: number, speak: boolean) => {
    activeRef.current = k;
    setActive(k);
    const m = marks.current.marks[k];
    if (speak && m) setLive(sayMark(m));
    // A chart wider than its box (a heatmap on a narrow phone) scrolls the active mark into view.
    const sc = plotRef.current?.querySelector<HTMLElement>('.hm-scroll');
    if (sc && m) {
      const pad = (m.hw ?? 12) + 8;
      if (m.x - pad < sc.scrollLeft) sc.scrollLeft = Math.max(0, m.x - pad);
      else if (m.x + pad > sc.scrollLeft + sc.clientWidth) sc.scrollLeft = m.x + pad - sc.clientWidth;
    }
  };
  const pin = (on: boolean) => {
    pinnedRef.current = on;
  };
  const clear = () => {
    show(-1, false);
    pin(false);
  };
  // Marks are in the coordinates of the chart's first SVG, which may scroll inside its box.
  const point = (e: PointerEvent) => {
    const svg = plotRef.current?.querySelector('svg.plot') ?? plotRef.current;
    const r = svg?.getBoundingClientRect();
    if (!r) return -1;
    return nearestMark(marks.current, e.clientX - r.left, e.clientY - r.top);
  };

  const interactive = ready && !p.plain;
  const level = p.level ?? 3;
  const H = level === 4 ? 'h4' : 'h3';
  const hasTable = ready && !!p.table && p.table.rows.length > 0;
  const reserve = p.reserve ?? (p.plain ? RESERVE.plain : RESERVE.chart);

  return (
    <figure
      id={p.id}
      ref={figRef}
      class={`figure${drawing ? ' is-drawing' : ''}${p.class ? ` ${p.class}` : ''}`}
      aria-labelledby={`${p.id}-t`}
    >
      <H id={`${p.id}-t`} class="figure__title">
        {p.title}
      </H>
      {p.sub ? <p class="sub">{p.sub}</p> : null}
      {p.controls ? <div class="figure__controls">{p.controls}</div> : null}
      {ready && p.legend && p.legend.length > 1 ? <Legend items={p.legend} /> : null}
      {ready ? (
        <div
          class={`chart${p.plain ? ' chart--plain' : ''}`}
          tabIndex={interactive ? 0 : undefined}
          role={interactive ? 'img' : undefined}
          aria-label={interactive ? p.summary : undefined}
          aria-describedby={interactive && hasTable && p.source ? `${p.id}-src` : undefined}
          onPointerMove={
            interactive
              ? (e) => {
                  if (e.pointerType !== 'mouse' || pinnedRef.current) return;
                  const k = point(e);
                  if (k !== activeRef.current) show(k, false);
                }
              : undefined
          }
          onPointerDown={
            interactive
              ? (e) => {
                  byPointer.current = true;
                  const k = point(e);
                  if (k < 0) return clear();
                  show(k, false);
                  pin(e.pointerType !== 'mouse');
                }
              : undefined
          }
          onPointerLeave={
            interactive
              ? (e) => {
                  if (e.pointerType === 'mouse' && !pinnedRef.current && document.activeElement !== e.currentTarget) show(-1, false);
                }
              : undefined
          }
          onFocus={
            interactive
              ? () => {
                  // Keyboard focus shows the first mark; a tap or a click already chose one.
                  if (!byPointer.current && activeRef.current < 0) show(0, true);
                  byPointer.current = false;
                }
              : undefined
          }
          onBlur={interactive ? clear : undefined}
          onKeyDown={
            interactive
              ? (e) => {
                  const s = marks.current;
                  const next = nextMark(e.key, activeRef.current, s.marks.length, s.mode, s.cols);
                  if (next === null) return;
                  if (next === 'clear') {
                    if (activeRef.current < 0 && !pinnedRef.current) return;
                    e.preventDefault();
                    return clear();
                  }
                  e.preventDefault();
                  show(next, true);
                }
              : undefined
          }
        >
          <div class="chart__plot" ref={plotRef} style={near && box.width ? undefined : { minHeight: `${reserve}px` }}>
            {near && box.width > 0 ? (
              <ChartCtx.Provider value={ctx}>
                {p.children}
                {interactive ? <ChartTip set={marks} active={active} /> : null}
              </ChartCtx.Provider>
            ) : null}
          </div>
        </div>
      ) : (
        <div class={`chart chart--state chart--${state.kind}`}>
          <p class="chart__msg">
            {state.kind === 'empty' ? state.message : t(state.kind === 'notMeasured' ? 'data.state.notMeasured' : 'data.state.unavailable')}
          </p>
          {state.kind === 'empty' && state.extra ? <div class="chart__extra">{state.extra}</div> : null}
        </div>
      )}
      {ready && p.reading ? <p class="reading">{p.reading}</p> : null}
      {hasTable ? (
        <>
          {p.source ? (
            <p class="source__line" id={`${p.id}-src`}>
              {p.source}
            </p>
          ) : null}
          <details class="source">
            <summary>
              <b>{t('data.fig.numbers')}</b>
            </summary>
            <TableView caption={p.title} data={p.table!} />
          </details>
        </>
      ) : p.source && state.kind !== 'notMeasured' && state.kind !== 'unavailable' ? (
        <p class="source source--plain">{p.source}</p>
      ) : null}
      <p class="sr-only" aria-live="polite" id={`${p.id}-live`}>
        {live}
      </p>
    </figure>
  );
}
