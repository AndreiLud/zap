// The phone menu (below 64em): a modal <dialog id="site-sheet"> that slides in from the right
// (CLIENT-SPEC 9.1). The page behind is inert while it is open; Tab and Shift+Tab wrap inside it;
// Esc, a click on the backdrop and the close button close it. On close, focus returns to the
// hamburger, unless the item chosen opens its own dialog (rules, report), which then takes focus
// and gives it back to the hamburger when it closes (the browser returns focus to the element that
// had it before showModal).
//
// The content is rendered only while the sheet is open, so no testid exists twice in the DOM.

import { useEffect, useRef } from 'preact/hooks';
import { setFourColor, setSoundOn } from '../actions.ts';
import { useChrome } from '../chrome.ts';
import { t } from '../i18n.ts';
import { store, type AppState } from '../store.ts';
import { Icon } from './icons.tsx';
import { KeysSwitch } from './KeysSwitch.tsx';
import { SiteNav } from './SiteNav.tsx';

export const MENU_BUTTON_ID = 'menu-button';

let afterClose: (() => void) | null = null;
let focusButtonOnClose = true;

/**
 * Closes the sheet; `then` runs after it closed and the focus is back on the hamburger. A link that
 * moves to another page passes focusButton false: the new page's title takes the focus instead.
 */
export function closeSheet(then?: () => void, focusButton = true): void {
  if (!store.get().menuOpen) {
    then?.();
    return;
  }
  afterClose = then ?? null;
  focusButtonOnClose = focusButton;
  store.set({ menuOpen: false });
}

export function openSheet(): void {
  store.set({ menuOpen: true });
}

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

export function Sheet({ s }: { s: AppState }) {
  const ref = useRef<HTMLDialogElement>(null);
  const open = s.menuOpen;
  const { group } = useChrome();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    // Light dismiss where the browser supports it; the click handler below covers the rest.
    d.setAttribute('closedby', 'any');
  }, []);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // Start on the current page's link, or on the first item.
      const body = d.querySelector<HTMLElement>('.sheet__body');
      const current = body?.querySelector<HTMLElement>('[aria-current="page"], [aria-current="true"]');
      (current ?? (body ? focusables(body)[0] : null))?.focus();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  const onClose = () => {
    if (store.get().menuOpen) store.set({ menuOpen: false });
    const button = document.getElementById(MENU_BUTTON_ID);
    if (focusButtonOnClose && button && button.offsetParent !== null) button.focus({ preventScroll: true });
    focusButtonOnClose = true;
    const next = afterClose;
    afterClose = null;
    next?.();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !ref.current) return;
    const list = focusables(ref.current);
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const onClick = (e: MouseEvent) => {
    // A click on the backdrop lands on the dialog element itself.
    if (e.target === ref.current) closeSheet();
  };

  return (
    <dialog ref={ref} id="site-sheet" class="sheet" data-testid="site-sheet" aria-labelledby="sheet-title" onClose={onClose} onKeyDown={onKeyDown} onClick={onClick}>
      {open ? (
        <>
          <div class="sheet__top">
            <h2 id="sheet-title">{t('shell.sheet.title')}</h2>
            <button type="button" class="icon-button" aria-label={t('menu.close')} onClick={() => closeSheet()}>
              <Icon name="close" />
            </button>
          </div>
          <div class="sheet__body">
            {group ? (
              <section class="sheet__group" aria-labelledby="sheet-group-title">
                <h3 id="sheet-group-title" class="sheet__group-title">
                  {t(group.title)}
                </h3>
                {group.render(closeSheet)}
              </section>
            ) : null}
            <SiteNav s={s} inSheet />
            <div class="sheet__switches">
              <label class="switch">
                <span>
                  <b>{t('shell.fourColor')}</b>
                  <small>{t('shell.fourColor.hint')}</small>
                </span>
                <input type="checkbox" role="switch" data-testid="four-color-switch" checked={s.fourColor} onChange={(e) => setFourColor(e.currentTarget.checked)} />
              </label>
              <label class="switch">
                <span>
                  <b>{t('shell.sound')}</b>
                  <small>{t('shell.sound.hint')}</small>
                </span>
                <input type="checkbox" role="switch" data-testid="sound-switch" checked={s.soundOn} onChange={(e) => setSoundOn(e.currentTarget.checked)} />
              </label>
              <KeysSwitch testid="keys-switch" />
            </div>
          </div>
        </>
      ) : null}
    </dialog>
  );
}
