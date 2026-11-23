// The plan's four chapters load in their own chunk (chapters-lazy.ts) once the reader comes within
// 800 px of them, follows a link into them, or opens the page on an address inside them: the first
// screen does not wait for their code, sim.json and their styles (DATA-SPEC 1.3, the budget of the
// page as it opens; the same rule as replays.json and F23's viewer). Until then the page keeps a
// shell per chapter with its anchor and heading (DataPage.tsx), so the chapter nav, headings
// navigation and links work at once.
//
// Where the reader was going (a nav link, a deep link) is kept, and once the chapters are in the
// page lands there again: the shells above grew into their figures and moved it.

import { useEffect, useState } from 'preact/hooks';

export type ChaptersModule = typeof import('./chapters-lazy.ts');

let mod: ChaptersModule | null = null;
let loading: Promise<ChaptersModule> | null = null;
const waiting = new Set<(m: ChaptersModule) => void>();
let target: { id: string; focus: boolean } | null = null;

/** Starts loading the chapters once; a failed load can be asked for again. */
export function requestChapters(): Promise<ChaptersModule> {
  loading ??= import('./chapters-lazy.ts').then(
    (m) => {
      mod = m;
      for (const fn of waiting) fn(m);
      return m;
    },
    (e: unknown) => {
      loading = null;
      throw e;
    },
  );
  return loading;
}

/** The chapters' module once it is in, null before. */
export function useChapters(): ChaptersModule | null {
  const [m, set] = useState<ChaptersModule | null>(mod);
  useEffect(() => {
    if (mod) {
      set(mod);
      return;
    }
    waiting.add(set);
    return () => void waiting.delete(set);
  }, []);
  return m;
}

/** True once the chapters' module is in. */
export const chaptersLoaded = () => mod !== null;

/** Remembers where the reader is going while the chapters load (focus: a nav link moves the focus). */
export function aimAt(id: string, focus: boolean): void {
  target = mod ? null : { id, focus };
  if (!mod) void requestChapters().catch(() => {});
}

/** The aim kept while the chapters loaded, once (DataPage lands on it after they render). */
export function takeAim(): { id: string; focus: boolean } | null {
  const t = target;
  target = null;
  return t;
}
