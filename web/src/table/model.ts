// What every region of the table derives from the store: the view, the room, who you are and
// what you may do now. Pure functions, no DOM.

import { A_ACCEPT, A_RAISE, A_RUN, COVER_MASK, PLAY_MASK } from '../../../engine/src/engine.ts';
import type { PublicRoom } from '../../../shared/protocol.ts';
import { isManilhaOf, seatName, type Names } from '../game-text.ts';
import { ladderFor, type TableView } from '../table-view.ts';

export type Pos = 'bottom' | 'right' | 'top' | 'left';

/** Where a seat sits on screen: you at the bottom, play going counterclockwise (you, right, top, left). */
export function posOf(seat: number, you: number, n: number): Pos {
  const d = (((seat - you) % n) + n) % n;
  if (n === 2) return d === 0 ? 'bottom' : 'top';
  return (['bottom', 'right', 'top', 'left'] as const)[d];
}

export interface Model {
  v: TableView;
  room: PublicRoom;
  you: number;
  n: number;
  /** Your team (0 or 1). */
  team: number;
  names: Names;
  /** Legal actions now (0 while a move is on its way to the server). */
  legal: number;
  coverLegal: boolean;
  /** The next card goes face down. */
  cover: boolean;
  /** The match is over on screen (the playback reached the end). */
  ended: boolean;
  muted: boolean;
}

export function makeModel(v: TableView, room: PublicRoom, o: { sending: boolean; cover: boolean; playing: boolean; muted: boolean; online?: boolean }): Model {
  // Reconnecting or offline: nothing can be sent, so every card and button is aria-disabled.
  const legal = o.sending || o.online === false ? 0 : v.legal;
  const coverLegal = (legal & COVER_MASK) !== 0;
  return {
    v,
    room,
    you: v.seat,
    n: v.players,
    team: v.seat & 1,
    names: { you: v.seat, players: v.players, room, variant: v.variant },
    legal,
    coverLegal,
    cover: o.cover && coverLegal,
    // The room says "ended" as soon as the server finishes; the table shows it when the playback gets there.
    ended: v.over || (room.status === 'ended' && !o.playing),
    muted: o.muted,
  };
}

export function can(m: Model, a: number): boolean {
  return (m.legal & (1 << a)) !== 0;
}

/** Legal card slots in a mask (face up or face down). */
export function legalCardMask(legal: number, cover: boolean): number {
  return cover ? (legal >> 3) & PLAY_MASK : legal & PLAY_MASK;
}

/** Visible slots of the hand in order: keys 1, 2, 3 follow this order. */
export function handSlots(v: { hand: number[] }): number[] {
  const out: number[] = [];
  v.hand.forEach((c, slot) => {
    if (c !== -1) out.push(slot);
  });
  return out;
}

/** Next bet this seat could call: in play the next step, while answering the one after. */
export function nextCall(v: TableView): { value: number; step: number } | null {
  const ladder = ladderFor(v);
  const step = v.phase === 'raise' ? v.step + 2 : v.step + 1;
  return step < ladder.length ? { value: ladder[step], step } : null;
}

/** A raise against your team that you answer now: the TRUCO panel. */
export function answeringRaise(m: Model): boolean {
  // The view's own mask: a short reconnect keeps the panel up (its buttons wait, aria-disabled).
  const legal = m.v.legal;
  return m.v.phase === 'raise' && m.v.raiser >= 0 && (m.v.raiser & 1) !== m.team && (legal & ((1 << A_ACCEPT) | (1 << A_RUN))) !== 0;
}

export function isManilha(v: TableView, c: number): boolean {
  return isManilhaOf(v, c);
}

/** Your partner's seat (2 against 2), or -1. */
export function partnerOf(m: Model): number {
  return m.n === 4 ? (m.you + 2) % 4 : -1;
}

/** The Zap's seat when it plays on the other team (its line at the end of a hand), or -1. */
export function zapOpponent(m: Model): number {
  return m.room.seats.findIndex((s) => s.kind === 'ai' && s.persona === 'zap' && (s.seat & 1) !== m.team);
}

/** "you" in a sentence that starts with another word; the name otherwise. */
export function nameOf(m: Model, seat: number): string {
  return seatName(m.names, seat);
}

/** The bet button applies: your turn in play and a raise is legal. */
export function canBet(m: Model): boolean {
  return m.v.phase === 'play' && can(m, A_RAISE);
}

/** Seconds per move of this room, or null without a limit. */
export function turnSeconds(room: PublicRoom): number | null {
  const t = room.settings.turnSeconds;
  return typeof t === 'number' ? t : null;
}
