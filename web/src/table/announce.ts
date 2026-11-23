// What the screen reader hears at the table (CLIENT-SPEC 13): one polite log region holding the last
// six sentences. Sentences said within ANNOUNCE_JOIN ms of the first one waiting are joined into one
// line, which is added once the time is up. A line already in the log is never rewritten, so nothing
// is read twice (the log announces additions only).

import { useEffect, useState } from 'preact/hooks';
import { ANNOUNCE_JOIN } from './timing.ts';

export interface Line {
  id: number;
  text: string;
}

const KEEP = 6;
let lines: Line[] = [];
let pending = '';
let timer: ReturnType<typeof setTimeout> | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function changed(): void {
  for (const fn of [...listeners]) fn();
}

/** The log after adding one line: the last KEEP lines, the lines already there unchanged. */
export function addLine(prev: readonly Line[], text: string, id: number): Line[] {
  const t = text.trim();
  if (!t) return prev.slice();
  return [...prev, { id, text: t }].slice(-KEEP);
}

function flush(): void {
  timer = null;
  const text = pending;
  pending = '';
  if (!text) return;
  lines = addLine(lines, text, nextId++);
  changed();
}

/** Says a sentence: it joins the sentences waiting, or starts a new line ANNOUNCE_JOIN ms from now. */
export function say(text: string): void {
  const t = text.trim();
  if (!t) return;
  pending = pending ? `${pending} ${t}` : t;
  timer ??= setTimeout(flush, ANNOUNCE_JOIN);
}

export function clearAnnouncements(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  pending = '';
  lines = [];
  changed();
}

/** The lines in the log now. */
export function announcements(): readonly Line[] {
  return lines;
}

export function useAnnouncements(): readonly Line[] {
  const [, tick] = useState(0);
  useEffect(() => {
    const fn = () => tick((x) => x + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return lines;
}
