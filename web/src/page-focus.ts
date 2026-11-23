// Moves the focus to the page title after a move inside the site (not on the first load), so a
// screen reader starts reading the new page from its title.

import { useEffect, useRef } from 'preact/hooks';
import { movedInSite } from './actions.ts';

export function usePageFocus(key: string) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (movedInSite()) ref.current?.focus();
  }, [key]);
  return ref;
}
