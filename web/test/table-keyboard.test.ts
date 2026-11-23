// Keyboard play at the table (CLIENT-SPEC 12): keyAction is pure.

import { describe, expect, it } from 'vitest';
import { A_ACCEPT, A_COVER0, A_RAISE, A_RUN, COVER_MASK } from '../../engine/src/engine.ts';
import { keyAction } from '../src/table/keyboard.ts';
import { handSlots } from '../src/table/model.ts';

const bit = (...as: number[]) => as.reduce((m, a) => m | (1 << a), 0);

describe('keyAction', () => {
  const full = { hand: [12, 30, 7] };

  it('1, 2 and 3 play the cards still in hand, left to right', () => {
    const legal = bit(0, 1, 2);
    expect(keyAction(full, '1', { legal, cover: false })).toEqual({ kind: 'act', a: 0, slot: 0 });
    expect(keyAction(full, '3', { legal, cover: false })).toEqual({ kind: 'act', a: 2, slot: 2 });
    // The middle card is gone: 2 plays the third slot, 3 does nothing.
    const two = { hand: [12, -1, 7] };
    expect(handSlots(two)).toEqual([0, 2]);
    expect(keyAction(two, '2', { legal: bit(0, 2), cover: false })).toEqual({ kind: 'act', a: 2, slot: 2 });
    expect(keyAction(two, '3', { legal: bit(0, 2), cover: false })).toBeNull();
  });

  it('a card that is not legal now does nothing', () => {
    expect(keyAction(full, '2', { legal: bit(0), cover: false })).toBeNull();
    expect(keyAction(full, '1', { legal: 0, cover: false })).toBeNull();
  });

  it('with the cover toggle on, the card goes face down when that is legal', () => {
    const legal = bit(0, 1, 2) | COVER_MASK;
    expect(keyAction(full, '2', { legal, cover: true })).toEqual({ kind: 'act', a: A_COVER0 + 1, slot: 1 });
    // Covering not legal (first round): the toggle is ignored and the card is played face up.
    expect(keyAction(full, '2', { legal: bit(0, 1, 2), cover: true })).toEqual({ kind: 'act', a: 1, slot: 1 });
  });

  it('T raises, A accepts, C runs, E toggles the cover, each only when legal', () => {
    expect(keyAction(full, 't', { legal: bit(A_RAISE), cover: false })).toEqual({ kind: 'act', a: A_RAISE });
    expect(keyAction(full, 'T', { legal: bit(A_RAISE), cover: false })).toEqual({ kind: 'act', a: A_RAISE });
    expect(keyAction(full, 't', { legal: bit(0), cover: false })).toBeNull();
    expect(keyAction(full, 'a', { legal: bit(A_ACCEPT, A_RUN), cover: false })).toEqual({ kind: 'act', a: A_ACCEPT });
    expect(keyAction(full, 'c', { legal: bit(A_ACCEPT, A_RUN), cover: false })).toEqual({ kind: 'act', a: A_RUN });
    expect(keyAction(full, 'a', { legal: bit(0), cover: false })).toBeNull();
    expect(keyAction(full, 'e', { legal: COVER_MASK, cover: false })).toEqual({ kind: 'cover' });
    expect(keyAction(full, 'e', { legal: bit(0), cover: false })).toBeNull();
  });

  it('other keys do nothing (R belongs to the app, Esc to the popovers)', () => {
    for (const k of ['r', 'Escape', 'x', '4', ' ', 'Enter']) expect(keyAction(full, k, { legal: -1 >>> 0, cover: false })).toBeNull();
  });
});
