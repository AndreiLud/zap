// A new room: the code is reserved in D1's open_rooms (node:sqlite with the real migrations), then
// the room is created through a stand-in for its Durable Object. A code is given up only when the
// room surely holds nothing of the owner, so a deletion or a recovery can always find the room.

import { describe, expect, it } from 'vitest';
import { CODE_ALPHABET, type RoomSettings } from '../../shared/protocol.ts';
import { CODE_ATTEMPTS, MAX_OPEN_ROOMS, createRoom, randomCode, roomExists, type RoomHandle, type RoomOwner } from '../src/room-create.ts';
import { emptyUsage, newRoomBrake, type RoomBrake } from '../src/brake.ts';
import { defaultSettings } from '../src/room-core.ts';
import { roomsOf } from '../src/privacy.ts';
import { testDb, type TestDb } from './sqlite-db.ts';

const NOW = Date.UTC(2026, 10, 21, 12);
const OWNER: RoomOwner = { device: 'a'.repeat(64), verified: true, verifiedUntil: NOW + 7_200_000, name: 'Ana' };
const ROOM = defaultSettings({ mode: 'room', players: 2 });
const SOLO = defaultSettings({ mode: 'solo', players: 2 });

type Answer = { ok: boolean; reason?: string } | 'throw' | 'throw-after-create';

/** Stand-in rooms: each code answers create() and forget() as told, and remembers what it holds. */
class Rooms {
  readonly holds = new Map<string, string>();
  /** The brake's reservation each room was created with (Room.forget answers held while one is open). */
  readonly reservations = new Map<string, RoomBrake>();
  readonly calls: string[] = [];
  private readonly create: (code: string) => Answer;
  private readonly forgets: (code: string) => 'ok' | 'throw';
  constructor(create: (code: string) => Answer, forgets: (code: string) => 'ok' | 'throw' = () => 'ok') {
    this.create = create;
    this.forgets = forgets;
  }
  handle = (code: string): RoomHandle => ({
    create: async (_code: string, _settings: RoomSettings, owner: string, _v: boolean, _u: number, _n: string, _a?: boolean, brake?: RoomBrake) => {
      this.calls.push(`create ${code}`);
      const a = this.create(code);
      if (a === 'throw') throw new Error('network');
      this.holds.set(code, owner);
      if (brake) this.reservations.set(code, brake);
      // The room ran create(), then the answer was lost.
      if (a === 'throw-after-create') throw new Error('connection lost');
      return a;
    },
    forget: async (device: string) => {
      this.calls.push(`forget ${code}`);
      if (this.forgets(code) === 'throw') throw new Error('network');
      if (this.holds.get(code) === device) this.holds.delete(code);
      return { held: Boolean(this.reservations.get(code)?.open) };
    },
  });
}

/** Codes handed out in order. */
const codes = (...list: string[]) => {
  let i = 0;
  return () => list[i++] ?? randomCode();
};

const listed = (db: TestDb) => db.raw.prepare('SELECT code, device, mode FROM open_rooms ORDER BY code').all();

describe('creating a room', () => {
  it('reserves the code, creates the room and keeps the listing', async () => {
    const db = testDb();
    const rooms = new Rooms(() => ({ ok: true }));
    expect(await createRoom(db, rooms.handle, ROOM, OWNER, NOW, codes('ABCDE'))).toEqual({ code: 'ABCDE' });
    expect(listed(db)).toEqual([{ code: 'ABCDE', device: OWNER.device, mode: 'room' }]);
    expect(await roomExists(db, 'ABCDE', NOW)).toBe(true);
    expect(rooms.calls).toEqual(['create ABCDE']);
  });

  it('a room that answers no gives its code up; a code still in use is drawn again', async () => {
    const db = testDb();
    db.raw.prepare("INSERT INTO open_rooms (code, device, created_at, expires_at, mode) VALUES ('TAKEN', ?, ?, ?, 'room')").run('b'.repeat(64), NOW, NOW + 3_600_000);
    const rooms = new Rooms((code) => (code === 'STALE' ? { ok: false, reason: 'exists' } : code === 'BADST' ? { ok: false, reason: 'bad_settings' } : { ok: true }));
    expect(await createRoom(db, rooms.handle, ROOM, OWNER, NOW, codes('TAKEN', 'STALE', 'FGHJK'))).toEqual({ code: 'FGHJK' });
    expect(await createRoom(db, rooms.handle, ROOM, OWNER, NOW, codes('BADST'))).toEqual({ error: 'room_failed', held: false });
    // A clean no needs no forget: the room holds nothing.
    expect(rooms.calls).toEqual(['create STALE', 'create FGHJK', 'create BADST']);
    expect(listed(db)).toEqual([
      { code: 'FGHJK', device: OWNER.device, mode: 'room' },
      { code: 'TAKEN', device: 'b'.repeat(64), mode: 'room' },
    ]);
    const busy = new Rooms(() => ({ ok: false, reason: 'exists' }));
    expect(await createRoom(db, busy.handle, SOLO, OWNER, NOW)).toEqual({ error: 'room_failed', held: false });
    expect(busy.calls).toHaveLength(CODE_ATTEMPTS);
  });

  it('a call that fails after the room was created: the room lets go of the owner before the code is given up', async () => {
    const db = testDb();
    const rooms = new Rooms(() => 'throw-after-create');
    expect(await createRoom(db, rooms.handle, SOLO, OWNER, NOW, codes('QUICK'))).toEqual({ error: 'room_failed', held: false });
    expect(rooms.calls).toEqual(['create QUICK', 'forget QUICK']);
    expect(rooms.holds.size).toBe(0);
    expect(listed(db)).toEqual([]);
  });

  it('when the room does not answer the forget either, the listing stays so a deletion still finds the room', async () => {
    const db = testDb();
    const rooms = new Rooms(() => 'throw-after-create', () => 'throw');
    expect(await createRoom(db, rooms.handle, ROOM, OWNER, NOW, codes('LOSTA'))).toEqual({ error: 'room_failed', held: true });
    expect(rooms.holds.get('LOSTA')).toBe(OWNER.device);
    expect(listed(db)).toEqual([{ code: 'LOSTA', device: OWNER.device, mode: 'room' }]);
    expect(await roomsOf(db, OWNER.device, NOW)).toEqual(['LOSTA']);
    // It counts toward the owner's limit until it expires.
    const ok = new Rooms(() => ({ ok: true }));
    for (let i = 1; i < MAX_OPEN_ROOMS; i++) expect('code' in (await createRoom(db, ok.handle, ROOM, OWNER, NOW))).toBe(true);
    expect(await createRoom(db, ok.handle, ROOM, OWNER, NOW)).toEqual({ error: 'too_many_rooms' });
    // A room that could not be called at all is also told, and the code goes once it answers.
    const db2 = testDb();
    const silent = new Rooms(() => 'throw');
    expect(await createRoom(db2, silent.handle, ROOM, OWNER, NOW, codes('NEVER'))).toEqual({ error: 'room_failed', held: false });
    expect(silent.calls).toEqual(['create NEVER', 'forget NEVER']);
    expect(listed(db2)).toEqual([]);
  });

  it('quick play: a room that ran create() with the brake\'s reservation says it holds it, so the Worker never gives it back too', async () => {
    const reservation = { key: '2026-11-21', est: { ...emptyUsage(), doRowsWritten: 18 } };
    const owner: RoomOwner = { ...OWNER, brake: () => newRoomBrake(null, reservation) };
    const db = testDb();
    const lost = new Rooms(() => 'throw-after-create');
    expect(await createRoom(db, lost.handle, SOLO, owner, NOW, codes('HELDA'))).toEqual({ error: 'room_failed', held: true });
    expect(lost.reservations.get('HELDA')?.open).toEqual(reservation);
    // A room that never ran create() holds nothing: the Worker gives the reservation back.
    const never = new Rooms(() => 'throw');
    expect(await createRoom(db, never.handle, SOLO, owner, NOW, codes('NEVRB'))).toEqual({ error: 'room_failed', held: false });
    // A clean no from the room: nothing held either.
    const no = new Rooms(() => ({ ok: false, reason: 'bad_settings' }));
    expect(await createRoom(db, no.handle, SOLO, owner, NOW, codes('NOPEB'))).toEqual({ error: 'room_failed', held: false });
    // A room that does not answer the forget may hold it: left to that room.
    const silent = new Rooms(() => 'throw-after-create', () => 'throw');
    expect(await createRoom(db, silent.handle, SOLO, owner, NOW, codes('QUIET'))).toEqual({ error: 'room_failed', held: true });
  });

  it('a D1 failure while reserving calls no room and keeps nothing reserved', async () => {
    const db = testDb();
    const rooms = new Rooms(() => ({ ok: true }));
    const failing = { ...db, prepare: (q: string) => (q.startsWith('INSERT') ? { bind: () => ({ run: () => Promise.reject(new Error('D1 down')) }) } : db.prepare(q)) } as unknown as TestDb;
    expect(await createRoom(failing, rooms.handle, ROOM, OWNER, NOW)).toEqual({ error: 'room_failed', held: false });
    expect(rooms.calls).toEqual([]);
    expect(listed(db)).toEqual([]);
  });

  it('room codes use the 31 symbol alphabet', () => {
    for (let i = 0; i < 200; i++) expect(randomCode()).toMatch(new RegExp(`^[${CODE_ALPHABET}]{5}$`));
  });
});
