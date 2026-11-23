// A new room (the Worker's POST /api/play and POST /api/rooms): the code is reserved in D1's
// open_rooms, then the room's Durable Object is created. The room is reached through a small
// interface, so the unit tests run this with node:sqlite and a stand-in room.

import { CODE_ALPHABET, CODE_LENGTH, type RoomSettings } from '../../shared/protocol.ts';
import type { SqlDb } from './privacy.ts';
import type { RoomBrake } from './brake.ts';
import { ROOM_TTL_MS } from './room-core.ts';

/** Rooms with friends one browser may have open at a time (quick play does not count). */
export const MAX_OPEN_ROOMS = 3;
/** Codes tried before giving up (one taken by a live room is drawn again). */
export const CODE_ATTEMPTS = 6;

/** The calls made here to a room's Durable Object (Room.create and Room.forget). */
export interface RoomHandle {
  create(
    code: string,
    settings: RoomSettings,
    owner: string,
    verified: boolean,
    verifiedUntil: number,
    ownerName: string,
    ownerNoAdapt?: boolean,
    brake?: RoomBrake,
  ): Promise<{ ok: boolean; reason?: string }>;
  /** held: the room keeps a reservation of the brake and gives it back itself (a room on older code answers nothing). */
  forget(device: string): Promise<{ held: boolean } | void>;
}

/**
 * Why no room came out of createRoom. held: a room may keep the brake's reservation made for it
 * (it ran create() and its answer was lost), and gives it back itself, with its match row or when
 * it expires; the caller then gives back only the person's match, never the reservation.
 */
export type CreateFailure = { error: 'too_many_rooms' } | { error: 'room_failed'; held: boolean };

/** Who asks for the room: the device, its seal, its credential's expiry, its nickname and its "Don't adapt to me" choice. */
export interface RoomOwner {
  device: string;
  verified: boolean;
  verifiedUntil: number;
  name: string;
  noAdapt?: boolean;
  /**
   * The brake's start for the room: its test ledger, and for quick play the reservation of the
   * match it deals at once. Made right before the call, so it carries what was spent until then.
   */
  brake?: () => RoomBrake;
}

export function randomCode(): string {
  const b = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(b);
  let s = '';
  // 31 symbols: 248 is the largest multiple of 31 below 256, so draws above it are redrawn.
  for (let i = 0; i < CODE_LENGTH; i++) {
    let x = b[i];
    while (x >= 248) {
      const r = new Uint8Array(1);
      crypto.getRandomValues(r);
      x = r[0];
    }
    s += CODE_ALPHABET[x % CODE_ALPHABET.length];
  }
  return s;
}

/** Whether a room code is live, without waking its Durable Object. */
export async function roomExists(db: SqlDb, code: string, now: number): Promise<boolean> {
  return (await db.prepare('SELECT 1 AS x FROM open_rooms WHERE code = ? AND expires_at > ?').bind(code, now).first()) !== null;
}

/** Gives a reserved code up again, so it counts toward no limit. */
function release(db: SqlDb, code: string, device: string): Promise<unknown> {
  return db
    .prepare('DELETE FROM open_rooms WHERE code = ? AND device = ?')
    .bind(code, device)
    .run()
    .catch(() => undefined);
}

/**
 * Reserves a code in D1 (for rooms with friends, only while the device has fewer than 3 open
 * rooms, checked in the same statement), then creates the room. A code whose room was surely not
 * created is given up again. When the call to the room fails, the room may still have run create()
 * before its answer was lost: it then holds the owner's id (in quick play, with a match dealt), and
 * this listing is the only row that lets a deletion or a recovery find it. So the room is first
 * told to let go of the owner (Room.forget closes a lobby the owner holds and a quick play room
 * left with no person, and its alarm removes the rest). The code is given up only once the room
 * answered; if it does not, the listing stays until it expires, which costs the owner one of the 3
 * rooms for that long but keeps the room reachable.
 *
 * The brake's reservation of a quick play match follows the same reasoning: a room that answers
 * the forget says whether it holds one (held), and a room that does not answer may hold one, so
 * the caller leaves it to that room. At worst the reservation stays until the day ends, which
 * refuses matches a little early but never lets the Zap pass its share.
 */
export async function createRoom(
  db: SqlDb,
  room: (code: string) => RoomHandle,
  settings: RoomSettings,
  owner: RoomOwner,
  now: number,
  nextCode: () => string = randomCode,
): Promise<{ code: string } | CreateFailure> {
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const code = nextCode();
    try {
      const ins = await db
        .prepare(
          `INSERT INTO open_rooms (code, device, created_at, expires_at, mode)
           SELECT ?1, ?2, ?3, ?4, ?5
           WHERE ?5 = 'solo' OR (SELECT COUNT(*) FROM open_rooms WHERE device = ?2 AND mode = 'room' AND expires_at > ?3) < ?6
           ON CONFLICT(code) DO NOTHING`,
        )
        .bind(code, owner.device, now, now + ROOM_TTL_MS, settings.mode, MAX_OPEN_ROOMS)
        .run();
      if (ins.meta.changes === 0) {
        if (settings.mode === 'room' && !(await roomExists(db, code, now))) return { error: 'too_many_rooms' };
        continue;
      }
    } catch {
      // D1 failed (a transient error): the row may have been written all the same, and no room was called.
      await release(db, code, owner.device);
      return { error: 'room_failed', held: false };
    }
    let res: { ok: boolean; reason?: string };
    let held = false;
    try {
      res = await room(code).create(code, settings, owner.device, owner.verified, owner.verifiedUntil, owner.name, owner.noAdapt === true, owner.brake?.());
    } catch {
      try {
        held = (await room(code).forget(owner.device))?.held === true;
      } catch {
        return { error: 'room_failed', held: true };
      }
      res = { ok: false, reason: 'failed' };
    }
    if (res.ok) return { code };
    await release(db, code, owner.device);
    if (res.reason !== 'exists') return { error: 'room_failed', held };
  }
  return { error: 'room_failed', held: false };
}
