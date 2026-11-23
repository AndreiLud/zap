// What the guided match adds to the table, without the table importing the guided code (or the
// engine moves behind it): the coach card, the suggested card and the table's title. The guided
// page sets these; table/Table.tsx reads them with useTableExtras() and places them where
// CLIENT-SPEC 10.5 says: the coach under the hand info row on phones and at the top of the side
// panel from 64em, the outline and the "suggested" tag on the suggested hand card, and the title
// "Practice hand" in place of the room code.

import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Key } from '../i18n.ts';

export interface TableExtras {
  /** Title of the table for screen readers, in place of the room code. */
  title: Key;
  /** Renders the coach card (it re-renders itself when the lesson moves). */
  coach(): VNode;
  /** Hand slot (0 to 2, as hand-card-N) of the card the coach suggests, or null. */
  suggestSlot: number | null;
  /** The visible tag of the suggested card ("suggested"). */
  suggestTag: Key;
}

let extras: TableExtras | null = null;
const listeners = new Set<() => void>();

function changed(): void {
  for (const fn of listeners) fn();
}

function useChanges(): void {
  const [, tick] = useState(0);
  useEffect(() => {
    const fn = () => tick((x) => x + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
}

/** For the guided page: what the table should add, or null when the page goes away. */
export function setTableExtras(x: TableExtras | null): void {
  if (extras === x) return;
  if (extras && x && extras.title === x.title && extras.coach === x.coach && extras.suggestSlot === x.suggestSlot && extras.suggestTag === x.suggestTag) return;
  extras = x;
  changed();
}

/** For the table: the guided extras (null in a room). */
export function useTableExtras(): TableExtras | null {
  useChanges();
  return extras;
}
