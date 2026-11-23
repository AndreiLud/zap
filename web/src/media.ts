// Media queries read from code, kept in step with the CSS breakpoints (CLIENT-SPEC 5.4).

import { useEffect, useState } from 'preact/hooks';

/** Desktop header, side panel and inline navigation from 64em (1024 px at the default text size). */
export const DESKTOP = '(min-width: 64em)';
/** Wide header labels from 80em. */
export const WIDE = '(min-width: 80em)';
export const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
/** A keyboard and a mouse: <kbd> hints show only here. */
export const FINE_POINTER = '(hover: hover) and (pointer: fine)';

function matches(query: string): boolean {
  return typeof matchMedia === 'function' && matchMedia(query).matches;
}

/** The current answer of a media query, outside components (event handlers, motion code). */
export function mediaMatches(query: string): boolean {
  return matches(query);
}

/** The answer of a media query, re-rendering the component when it changes. */
export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => matches(query));
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(query);
    const update = () => setOn(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [query]);
  return on;
}
