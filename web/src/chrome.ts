// What a page adds to the site chrome (CLIENT-SPEC 9.4), without the header importing page code:
//
// * setSheetGroup: a group of controls at the top of the phone menu sheet. The table registers its
//   tools ("This table": Denunciar, Silenciar, Sair) below 64em and clears them on unmount or when
//   the width crosses 64em; only one instance of those controls may exist at a time.
// * setPageChrome: the short footer and whether the header repeats Código-fonte and Portfólio. Reset
//   on every route change (actions.ts enterRoute) to { shortFooter: false, headerExternal: true };
//   the Start page sets { shortFooter: true, headerExternal: false } on mount (WP1).
//
// Pages use the hooks usePageChrome and useSheetGroup, which set on mount and reset on unmount.

import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Key } from './i18n.ts';

export interface SheetGroup {
  /** Heading of the group in the sheet, for example 'shell.sheet.table'. */
  title: Key;
  /** Rendered only while the sheet is open. `close` closes the sheet; pass `then` to run after it closed. */
  render(close: (then?: () => void) => void): VNode;
}

export interface PageChrome {
  shortFooter: boolean;
  headerExternal: boolean;
}

export const DEFAULT_CHROME: PageChrome = { shortFooter: false, headerExternal: true };

let group: SheetGroup | null = null;
let chrome: PageChrome = DEFAULT_CHROME;
const listeners = new Set<() => void>();

function changed(): void {
  for (const fn of listeners) fn();
}

export function setSheetGroup(g: SheetGroup | null): void {
  if (group === g) return;
  group = g;
  changed();
}

export function sheetGroup(): SheetGroup | null {
  return group;
}

export function setPageChrome(c: PageChrome): void {
  if (c.shortFooter === chrome.shortFooter && c.headerExternal === chrome.headerExternal) return;
  chrome = c;
  changed();
}

export function pageChrome(): PageChrome {
  return chrome;
}

/** Called by the router on every route change. The sheet group belongs to its page, which clears it. */
export function resetPageChrome(): void {
  setPageChrome(DEFAULT_CHROME);
}

/** Re-renders the caller when the chrome or the sheet group changes. */
export function useChrome(): { chrome: PageChrome; group: SheetGroup | null } {
  const [, tick] = useState(0);
  const seen = { chrome, group };
  useEffect(() => {
    const fn = () => tick((x) => x + 1);
    listeners.add(fn);
    // A page rendered before this component may have set its chrome in an effect that ran before
    // this one subscribed (the footer renders after the page): catch up once.
    if (seen.chrome !== chrome || seen.group !== group) fn();
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return { chrome, group };
}

/** For a page: its chrome while it is mounted. */
export function usePageChrome(c: PageChrome): void {
  useEffect(() => {
    setPageChrome(c);
    return () => setPageChrome(DEFAULT_CHROME);
  }, [c.shortFooter, c.headerExternal]);
}

/**
 * For a page: its sheet group while it is mounted and `active` (the table passes "below 64em").
 * Pass a stable object (useMemo): a new object on every render re-registers the group each time.
 */
export function useSheetGroup(g: SheetGroup | null, active = true): void {
  useEffect(() => {
    if (!active || !g) return;
    setSheetGroup(g);
    return () => {
      if (group === g) setSheetGroup(null);
    };
  }, [g, active]);
}
