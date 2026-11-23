// The one interface the table talks to (CLIENT-SPEC 11.1). A real room (RoomController, set by
// actions.ts when the route is a room) and the guided first match (LocalController, set by
// pages/Guided.tsx on mount and cleared on unmount) both implement it, and both fill the same store
// fields (room, game, view, feed, bubbles), so table/Table.tsx renders either one unchanged.
//
// The table never imports room.ts or actions.ts to act: it calls currentController().

import type { PhraseKey } from '../../shared/protocol.ts';
import type { Key } from './i18n.ts';

export interface TableController {
  readonly kind: 'room' | 'local';
  /** One engine action (card slot, cover, bet, answer, signal). `auto` marks a move made for the person when time ran out. */
  act(a: number, auto?: boolean): void;
  phrase(key: PhraseKey): void;
  /** "Jogar de novo" after the match ended. */
  rematch(): void;
  /** "Voltar a jogar" while the AI plays the person's seat. */
  resume(): void;
  /** "Leave match": leaves the table and goes to the Play page. */
  leave(): void;
  /** A short toast (data-testid="notice"). */
  notice(key: Key): void;
}

let current: TableController | null = null;

export function currentController(): TableController | null {
  return current;
}

export function setController(c: TableController | null): void {
  current = c;
}
