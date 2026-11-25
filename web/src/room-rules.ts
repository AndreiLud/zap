// What the room code on the other end can do (M15): PublicRoom.setup is the capability level the
// room sends, absent from older room code and from the guided lesson's local room. The page shows a
// feature only when the room says it understands it, so a page newer than its room (a deploy in
// between, rooms keep old code for up to a day) never offers what the room would ignore.
//
// Also the rules the end screen and the lobby share (M15 spec 6.5, 6.6): who leads the next match,
// which refusals deserve a notice, and when the page lets go of a finished match. Pure, in the entry.

import type { ErrorCode, PublicRoom } from '../../shared/protocol.ts';
import type { Key } from './i18n.ts';

/** The room draws quick play line ups and reads the rematch switches. */
export const SETUP_DRAW = 1;
/** The room's owner arranges the table between matches (move, plan, lobby, the owner rule). */
export const SETUP_TABLE = 2;

/** The parts of a room message the rules read. */
export interface RoomView {
  owner: boolean;
  you: number | null;
  room: Pick<PublicRoom, 'status' | 'matchNo' | 'settings' | 'setup' | 'ownerAway'>;
}

export interface Lead {
  /** May start the next match: "Jogar de novo" on the end screen, "Começar partida" in the lobby. */
  lead: boolean;
  /** May change the table: "Mudar a mesa" on the end screen, the seat controls in the lobby. */
  arrange: boolean;
  /** The line for those who wait: play.lobby.waitOwner, play.lobby.back or play.lobby.ownerAway. */
  line: Extract<Key, 'play.lobby.waitOwner' | 'play.lobby.back' | 'play.lobby.ownerAway'> | null;
}

/**
 * Who leads (M15 spec 6.5). Quick play, and rooms whose code predates the arrangement: anyone seated
 * plays again, as before, and in a lobby only the owner starts. Rooms that arrange: the owner leads
 * and arranges; a friend waits for the owner, unless the owner is away after a match, when any
 * seated person may start so the room never gets stuck.
 */
export function leadOf(v: RoomView): Lead {
  const room = v.room;
  const seated = v.you !== null;
  if (room.settings.mode !== 'room' || (room.setup ?? 0) < SETUP_TABLE) {
    if (room.settings.mode === 'room' && room.status === 'lobby' && !v.owner) return { lead: false, arrange: false, line: 'play.lobby.waitOwner' };
    return { lead: seated, arrange: false, line: null };
  }
  if (v.owner) return { lead: true, arrange: true, line: null };
  if (room.matchNo > 0 && room.ownerAway === true && seated) return { lead: true, arrange: false, line: 'play.lobby.ownerAway' };
  return { lead: false, arrange: false, line: room.matchNo > 0 && room.status === 'lobby' ? 'play.lobby.back' : 'play.lobby.waitOwner' };
}

/** The refusals the person reads as a notice (data-testid="notice"); the others need none. */
export const ERROR_NOTICE: Partial<Record<ErrorCode, Key>> = {
  too_fast: 'notice.too_fast',
  not_owner: 'notice.not_owner',
  seat_taken: 'notice.seat_taken',
  room_full: 'notice.room_full',
  not_in_lobby: 'notice.not_in_lobby',
  expired: 'notice.expired',
  needs_people: 'notice.needs_people',
  not_ended: 'notice.not_in_lobby',
};

/**
 * The notice for a refusal, given the room's status in the last room message. `not_ended` speaks
 * only while a match runs ("A partida já começou."): a rematch that lost to the owner's "Mudar a
 * mesa" needs no word, since the page goes to the lobby by itself.
 */
export function noticeFor(code: ErrorCode, status: PublicRoom['status'] | undefined): Key | null {
  if (code === 'not_ended' && status !== 'playing') return null;
  return ERROR_NOTICE[code] ?? null;
}

/**
 * A room message that takes a room back to the lobby after a match ("Mudar a mesa") while the page
 * still holds that match: the page drops it, so no stale end screen or hand is left behind and the
 * next match starts from before its deal (M15 spec 6.6).
 */
export function dropsFinishedMatch(held: { game: unknown }, next: { room: Pick<PublicRoom, 'status' | 'matchNo'> }): boolean {
  return held.game !== null && next.room.status === 'lobby' && next.room.matchNo > 0;
}
