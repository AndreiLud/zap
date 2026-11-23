// Pieces the four chapters of the plan and the closing block share (DATA-SPEC 4.6 to 4.10, WP6):
// the chapter's section and heading, the waiting states of figures that read the run time summary,
// the typed views of the generated files, and the table helpers. The data shaping lives in
// chapter-data.ts (pure, unit tested); this file only renders.

import './chapters.css';
import './chapter-figures.css';
import type { ComponentChildren } from 'preact';
import { Link } from '../../components/common.tsx';
import { t, type Key } from '../../i18n.ts';
import type { FigureState } from '../charts/Figure.tsx';
import type { Format } from '../format.ts';
import { tipRange, type Est } from '../words.ts';
import factsView from '../generated/facts-view.json' with { type: 'json' };
import cycleRules from '../generated/cycle-rules.json' with { type: 'json' };
import type { FactsView, SummaryLoad, Thresholds } from './chapter-data.ts';

/** facts-view.json as the chapters read it (tools/data/facts-view.ts). */
export const FV = factsView as unknown as FactsView;

/** cycle-rules.json: the public minimum of people and the layers' marks (tools/data/cycle-rules.ts). */
export const RULES = cycleRules as unknown as { MIN_PEOPLE: number; thresholds: Thresholds };

/**
 * A chapter: its section with the stable anchor (the chapter nav links it), the h2 and one lead
 * line. It wears the page's part classes (dp-part, data-page.css of WP5) and its own (chapters.css).
 */
export function Chapter(p: { id: string; title: string; lead?: ComponentChildren; extra?: ComponentChildren; children: ComponentChildren; class?: string }) {
  return (
    <section id={p.id} class={`dp-part chap${p.class ? ` ${p.class}` : ''}`} aria-labelledby={`${p.id}-h`}>
      <header class="chap__head">
        <h2 id={`${p.id}-h`} class="dp-part__h chap__title" tabIndex={-1}>
          {p.title}
        </h2>
        {p.lead ? <p class="chap__lead">{p.lead}</p> : null}
        {p.extra}
      </header>
      {p.children}
    </section>
  );
}

/**
 * The state of a figure that needs the summary and cannot draw yet: loading keeps a quiet line,
 * a failed request is the "unavailable" state. Null when the figure can draw (or decides itself
 * what "no summary yet" looks like).
 */
export function waitState(load: SummaryLoad): FigureState | null {
  if (load.kind === 'loading') return { kind: 'empty', message: t('data.state.loading') };
  if (load.kind === 'unavailable') return { kind: 'unavailable' };
  return null;
}

/** A share with its interval for a table cell: "79,6%" and "de 78,8% a 80,5%". */
export function pctCells(f: Format, e: Est, digits: 0 | 1 = 1): [string, string] {
  return [f.pct(e.mean, digits), f.range(e.lo, e.hi, digits)];
}

/** The interval of a tooltip in words, with the decimals of the values it goes with. */
export function tipFor(f: Format, digits: 0 | 1 = 1): (lo: number, hi: number) => string {
  return (lo, hi) => tipRange(t, f.pct(lo, digits), f.pct(hi, digits));
}

/** A lock before a line (the privacy rule of chapter 4). */
export function LockLine({ children }: { children: ComponentChildren }) {
  return (
    <p class="chap__rule">
      <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
        <rect x="4.5" y="9" width="11" height="8" rx="1.5" />
        <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
      </svg>
      <span>{children}</span>
    </p>
  );
}

/** The way to take part, under the people figures that are still empty (F17, F24). */
export function PlayLink({ testid }: { testid: string }) {
  return (
    <Link to={{ name: 'play' }} class="btn btn--primary chap__play" testid={testid}>
      {t('data.f17.play')}
    </Link>
  );
}

/** Text of a key, for places that take a string. */
export const tx = (key: Key, vars?: Record<string, string | number>) => t(key, vars);
