// The chapter nav (DATA-SPEC 4.0): links to the page's parts. Sticky at the top of the page from
// 900 px; on a phone a row of chips that scrolls sideways inside its own box (the page never
// does). aria-current marks the chapter in view. A link scrolls to its part and moves the focus to
// its heading without a new history entry (the router treats a hash change like a new address).

import { useEffect, useState } from 'preact/hooks';
import { t, type Key } from '../../i18n.ts';
import { aimAt, chaptersLoaded, useChapters } from './chapters-load.ts';

export interface Chapter {
  id: string;
  label: Key;
  /** One of the plan's chapters, which load in their own chunk (chapters-load.ts). */
  lazy?: boolean;
}

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Scrolls to a part of the page and gives its heading the focus; the address keeps the hash. */
export function goToPart(id: string, e?: Event, behavior?: ScrollBehavior): void {
  const el = document.getElementById(id);
  if (!el) return;
  e?.preventDefault();
  history.replaceState(history.state, '', `#${id}`);
  el.scrollIntoView({ block: 'start', behavior: behavior ?? (reduced() ? 'auto' : 'smooth') });
  const h = el.querySelector<HTMLElement>('h2, h3') ?? el;
  if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1');
  h.focus({ preventScroll: true });
}

/** The chapter whose part crosses the upper third of the viewport. */
function useCurrent(ids: readonly string[]): string | null {
  const [current, setCurrent] = useState<string | null>(null);
  // The chapters replace their shells when their chunk comes in: observe the new sections then.
  const loaded = useChapters() !== null;
  const key = `${ids.join(' ')}|${loaded}`;
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        setCurrent(ids.find((id) => seen.get(id)) ?? null);
      },
      { rootMargin: '-30% 0px -65% 0px' },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [key]);
  return current;
}

export function ChapterNav({ chapters }: { chapters: readonly Chapter[] }) {
  const current = useCurrent(chapters.map((c) => c.id));
  return (
    <nav class="dp-nav" aria-label={t('data.nav.label')}>
      <ul class="dp-nav__list">
        {chapters.map((c) => (
          <li key={c.id}>
            <a
              href={`#${c.id}`}
              class="dp-nav__link"
              aria-current={current === c.id ? 'true' : undefined}
              onClick={(e) => {
                // A chapter still in its shell: load it, and land on it again once it is in.
                if (c.lazy && !chaptersLoaded()) aimAt(c.id, true);
                goToPart(c.id, e);
              }}
            >
              {t(c.label)}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
