// The data page (DATA-SPEC 4): how Zap works and how it learned, then the reading of the opponent
// during the match, then the plan's four chapters and the closing. Part 1, the reading and the
// closing load with the page; the four chapters load in their own chunk when the reader comes near
// them (parts/chapters-load.ts), and until then each keeps a shell with its anchor and heading.
//
// One poller feeds the cover (live-poll.ts, every minute while visible) and the summary refresh (every
// fifth poll); both reach the parts through DataCtx (load.ts).

import '../styles/data-page.css';
import { useEffect, useLayoutEffect, useMemo } from 'preact/hooks';
import { t, type Key } from '../i18n.ts';
import { useLivePoll } from './live-poll.ts';
import type { AppState } from '../store.ts';
import { fmt } from './format.ts';
import { setTermVars } from './glossary.ts';
import { CURVE, DataCtx, readsNow, servedNow, useSummary, type DataModel } from './load.ts';
import { ChapterNav, goToPart, type Chapter } from './parts/ChapterNav.tsx';
import { aimAt, requestChapters, takeAim, useChapters, type ChaptersModule } from './parts/chapters-load.ts';
import { Closing } from './parts/Closing.tsx';
import { Cover } from './parts/Cover.tsx';
import { Cycle } from './parts/Cycle.tsx';
import { Curve } from './parts/Curve.tsx';
import { Duplicate } from './parts/Duplicate.tsx';
import { Learned } from './parts/Learned.tsx';
import { Reading } from './parts/Reading.tsx';

/** The plan's chapters, in page order: the export of chapters-lazy.ts, its anchor, heading and nav label. */
const LATER: { name: keyof ChaptersModule; id: string; title: Key; label: Key }[] = [
  { name: 'Truco', id: 'truco', title: 'data.truco.h', label: 'data.nav.truco' },
  { name: 'Evolution', id: 'evolucao', title: 'data.evo.h', label: 'data.nav.evolution' },
  { name: 'Plays', id: 'como-joga', title: 'data.plays.h', label: 'data.nav.plays' },
  { name: 'People', id: 'pessoas', title: 'data.people.h', label: 'data.nav.people' },
];

const CHAPTERS: Chapter[] = [
  { id: 'como-funciona', label: 'data.nav.how' },
  { id: 'leitura', label: 'data.nav.reading' },
  ...LATER.map((c) => ({ id: c.id, label: c.label, lazy: true })),
];

/** After the page renders, an address with a hash (#leitura, #termos-dup) lands on its block. */
function useHashLanding() {
  useEffect(() => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) return;
    // A block inside a chapter that has not loaded: load the chapters and land once they are in.
    const el = document.getElementById(id);
    if (!el || el.closest('[data-chapter-shell]')) aimAt(id, false);
    const raf = requestAnimationFrame(() => el?.scrollIntoView({ block: 'start' }));
    return () => cancelAnimationFrame(raf);
  }, []);
}

/** A chapter before its chunk is in: the anchor and the heading, and room for the figures. */
function Shell({ id, title }: { id: string; title: Key }) {
  return (
    <section id={id} class="dp-part chap" aria-labelledby={`${id}-h`} aria-busy="true" data-chapter-shell="">
      <header class="chap__head">
        <h2 id={`${id}-h`} class="dp-part__h chap__title" tabIndex={-1}>
          {t(title)}
        </h2>
      </header>
      <div class="chap-wait chap-wait--lazy" />
    </section>
  );
}

/**
 * The four chapters: shells until the chunk is in, then the chapters. The chunk loads when a shell
 * comes within 800 px of the viewport, or at once for a link into it (chapters-load.ts aimAt).
 */
function LaterChapters() {
  const mod = useChapters();
  useEffect(() => {
    if (mod) return;
    if (typeof IntersectionObserver === 'undefined') {
      void requestChapters().catch(() => {});
      return;
    }
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void requestChapters().catch(() => {}), { rootMargin: '800px 0px' });
    for (const s of document.querySelectorAll('[data-chapter-shell]')) io.observe(s);
    return () => io.disconnect();
  }, [mod]);
  // Once the chapters are in, land where the reader was going (the shells above grew into figures).
  useLayoutEffect(() => {
    if (!mod) return;
    const aim = takeAim();
    if (!aim) return;
    if (aim.focus) goToPart(aim.id, undefined, 'auto');
    else document.getElementById(aim.id)?.scrollIntoView({ block: 'start' });
  }, [mod]);
  // Siblings of the other parts (no wrapper), so ".dp-part + .dp-part" keeps the rules between them.
  return (
    <>
      {LATER.map((c) => {
        const C = mod?.[c.name];
        return C ? <C key={c.id} /> : <Shell key={c.id} id={c.id} title={c.title} />;
      })}
    </>
  );
}

export function DataStory({ s }: { s: AppState }) {
  const live = useLivePoll(true);
  const summary = useSummary(live.polls);
  const f = fmt();
  const model = useMemo<DataModel>(
    () => ({ f, live, summary, served: servedNow(live), reads: readsNow(live) }),
    // The formatter follows the language; the rest follows the answers.
    [s.lang, live.live, live.ok, live.paused, live.polls, summary],
  );
  // The definition of "etapas" names the decisions of one training step (curve.json).
  const row = CURVE.rows[CURVE.rows.length - 1];
  if (row) setTermVars('etapas', { k: f.big(row.decisionsPerIteration) });
  useHashLanding();
  return (
    <DataCtx.Provider value={model}>
      <main id="main" class="data-root dp" data-testid="page-data">
        <Cover />
        <ChapterNav chapters={CHAPTERS} />
        <section id="como-funciona" class="dp-part" aria-labelledby="como-funciona-h">
          <h2 id="como-funciona-h" class="dp-part__h" tabIndex={-1}>
            {t('data.part.how')}
          </h2>
          <Cycle />
          <Learned />
          <Curve />
          <Duplicate />
        </section>
        <Reading />
        <LaterChapters />
        <Closing />
      </main>
    </DataCtx.Provider>
  );
}
