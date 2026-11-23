// Playing with the keyboard (CLIENT-SPEC 12): 1, 2 and 3 play the cards still in hand from left to
// right (face down with the cover toggle on), T raises, A accepts, C runs, E toggles "Jogar
// coberta". R (rules) is the app's; Esc belongs to the popovers and dialogs. keyAction is pure.
// Single keys act only while focus is on the page or in the game area of the table, never from the
// header, the footer, the side panel or a popover, and the switch "Single key shortcuts" turns them
// off (WCAG 2.1.4).

import { useEffect } from 'preact/hooks';
import { A_ACCEPT, A_COVER0, A_RAISE, A_RUN, COVER_MASK } from '../../../engine/src/engine.ts';
import { store } from '../store.ts';
import { inGame } from './focus.ts';
import { handSlots } from './model.ts';

export type KeyResult = { kind: 'act'; a: number; slot?: number } | { kind: 'cover' } | null;

/** The action a key asks for in this state, or null when the key does nothing now. */
export function keyAction(v: { hand: number[] }, key: string, st: { legal: number; cover: boolean }): KeyResult {
  const k = key.toLowerCase();
  const legal = st.legal;
  const ok = (a: number) => (legal & (1 << a)) !== 0;
  if (k === '1' || k === '2' || k === '3') {
    const slot = handSlots(v)[Number(k) - 1];
    if (slot === undefined) return null;
    const cover = st.cover && (legal & COVER_MASK) !== 0;
    const a = cover ? A_COVER0 + slot : slot;
    return ok(a) ? { kind: 'act', a, slot } : null;
  }
  if (k === 't') return ok(A_RAISE) ? { kind: 'act', a: A_RAISE } : null;
  if (k === 'a') return ok(A_ACCEPT) ? { kind: 'act', a: A_ACCEPT } : null;
  if (k === 'c') return ok(A_RUN) ? { kind: 'act', a: A_RUN } : null;
  if (k === 'e') return (legal & COVER_MASK) !== 0 ? { kind: 'cover' } : null;
  return null;
}

/**
 * A key the table should leave alone: shortcuts turned off, with a modifier, repeated, typed in a
 * field, under a dialog, or with focus outside the game area.
 */
export function ignoredKey(e: KeyboardEvent): boolean {
  if (!store.get().keysOn) return true;
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return true;
  const el = e.target as HTMLElement | null;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return true;
  if (document.querySelector('dialog[open]') !== null) return true;
  return !inGame();
}

/** Listens for the table keys while the table is mounted. */
export function useTableKeys(handle: (r: NonNullable<KeyResult>, e: KeyboardEvent) => void, read: () => { v: { hand: number[] } | null; legal: number; cover: boolean }): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (ignoredKey(e)) return;
      const st = read();
      if (!st.v) return;
      const r = keyAction(st.v, e.key, st);
      if (!r) return;
      e.preventDefault();
      handle(r, e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
