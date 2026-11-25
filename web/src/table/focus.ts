// Where focus goes at the table (CLIENT-SPEC 12): into the game (the hand, the TRUCO answers, the
// result heading) only when it already is in the game, never out of the header, the menu sheet, the
// side panel or a dialog the person opened.

/** Focus is on the page itself or inside the game area of the table. */
export function inGame(): boolean {
  const a = document.activeElement as HTMLElement | null;
  if (!a || a === document.body || a === document.documentElement) return true;
  if (a.closest('dialog, .site-header, .side-panel, [popover]')) return false;
  return !!a.closest('main.table');
}

/** Focus the card of your hand that holds the Tab stop, or the hand itself. */
export function focusHand(): boolean {
  const el =
    document.querySelector<HTMLElement>('.hand .hand-card[tabindex="0"]') ??
    document.querySelector<HTMLElement>('.hand .hand-card') ??
    document.querySelector<HTMLElement>('#hand');
  if (el && el.offsetParent !== null) {
    el.focus({ preventScroll: true });
    return true;
  }
  return false;
}

/** The skip link: to your cards, or to the first enabled action when the hand has none. */
export function skipToCards(): void {
  if (focusHand()) return;
  document.querySelector<HTMLElement>('.actions button:not([disabled]):not([aria-disabled="true"])')?.focus();
}

/**
 * Moves focus at the next frame, only if focus is still in the game then. A turn's effect decides
 * a frame or two before it acts (Preact runs effects after the next frame); a person who tabbed out
 * to the footer or the header meanwhile must keep their place, or the next key would act on the card.
 */
export function focusLater(get: () => HTMLElement | null | undefined): void {
  requestAnimationFrame(() => {
    if (inGame()) get()?.focus({ preventScroll: true });
  });
}
