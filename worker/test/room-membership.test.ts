// A room's members in D1 (room_members) outlive their seats, however long the room lives: the
// pure room logic and the real SQL on node:sqlite, with the same writes the Room Durable Object
// makes (room.ts): the membership row on a join, every seated person's row on a match start, and
// the listing with every seated person's row whenever the room's expiry passes it.

import { describe, expect, it } from 'vitest';
import { mulberry32, deriveSeed } from '../../engine/src/rng.ts';
import { A_SIGNAL0, SIGNAL_MASK, legalMask } from '../../engine/src/engine.ts';
import { HeuristicAgent } from '../../ai/src/heuristic.ts';
import { roomListingStatements, roomMemberStatement, roomsOf, runRetention } from '../src/privacy.ts';
import { ROOM_TTL_MS, RoomCore, defaultSettings, listingUpdate, memberUntil, type RoomDeps } from '../src/room-core.ts';
import { testDb, type TestDb } from './sqlite-db.ts';

const HOUR = 3600_000;
const dev = (c: string) => c.repeat(64);
const A = dev('a');
const B = dev('b');
const C = dev('c');

/** The room and the D1 writes its Durable Object makes, run in order. */
class Room {
  readonly db: TestDb;
  readonly core: RoomCore;
  readonly clock: { t: number };
  private listed: number;
  private writes: Promise<unknown>[] = [];

  constructor(db: TestDb, code: string, owner: string, settings: Parameters<typeof defaultSettings>[0]) {
    this.db = db;
    this.clock = { t: Date.UTC(2026, 10, 21, 12) };
    let k = 0;
    const deps: RoomDeps = {
      now: () => this.clock.t,
      randomSeed: () => deriveSeed('cd'.repeat(32), 5, k++),
      agentFor: () => new HeuristicAgent(),
      rand: mulberry32(9),
      // Room.countMatch: everyone seated, also people away whose seat an AI keeps.
      onMatchStart: () => this.writeMembers(this.core.seatedDevices()),
    };
    const t = this.clock.t;
    for (const d of [A, B, C]) db.raw.prepare('INSERT INTO devices (id, created_at, pseudonym, adult_at, last_seen) VALUES (?, ?, ?, ?, ?)').run(d, t, d.slice(0, 32), t, t);
    // The Worker lists the room for 24 h when it reserves the code.
    db.raw.prepare("INSERT INTO open_rooms (code, device, created_at, expires_at, mode) VALUES (?, ?, ?, ?, 'room')").run(code, owner, this.clock.t, this.clock.t + ROOM_TTL_MS);
    this.core = RoomCore.create(code, defaultSettings({ mode: 'room', ...settings }), owner, true, 'v1', deps);
    this.listed = this.core.expiresAt();
  }

  private writeMembers(devices: string[]): void {
    const until = memberUntil(this.clock.t, this.listed);
    this.writes.push(this.db.batch(devices.map((d) => roomMemberStatement(this.db, this.core.r.code, d, until))));
  }

  /** Room.fetch: the membership row first, then the seat and the connection. */
  async join(device: string): Promise<void> {
    this.writeMembers([device]);
    expect('seat' in this.core.join(device, true)).toBe(true);
    this.core.connect(device);
    await this.save();
  }

  /** Room.save: the listing moves (with every seated person's row) once the room's expiry passed it. */
  async save(): Promise<void> {
    const until = listingUpdate(this.core.expiresAt(), this.listed);
    if (until !== null) {
      this.listed = until;
      this.writes.push(this.db.batch(roomListingStatements(this.db, this.core.r.code, until, this.core.seatedDevices())));
    }
    await Promise.all(this.writes.splice(0));
  }

  async handle(device: string, msg: Parameters<RoomCore['handle']>[1]): Promise<void> {
    expect(this.core.handle(device, msg).ok).toBe(true);
    await this.save();
  }

  /** Random legal moves for the people present (the AI plays the others) until the match ends. */
  async playOut(people: string[], seed: number): Promise<void> {
    const rand = mulberry32(seed);
    const core = this.core;
    for (let guard = 0; core.r.status === 'playing' && guard < 5000; guard++) {
      const movers = people.filter((p) => core.seatOf(p) >= 0 && (legalMask(core.match!, core.seatOf(p)) & ~SIGNAL_MASK) !== 0);
      if (movers.length === 0) {
        this.clock.t = Math.max(this.clock.t, core.nextAlarm() ?? this.clock.t) + 1;
        core.alarm();
      } else {
        const p = movers[Math.floor(rand() * movers.length)];
        const acts = [...Array(A_SIGNAL0).keys()].filter((a) => legalMask(core.match!, core.seatOf(p)) & (1 << a));
        core.handle(p, { t: 'act', seq: core.r.seq, a: acts[Math.floor(rand() * acts.length)] });
      }
      await this.save();
    }
    expect(core.r.status).toBe('ended');
  }

  /** Every seated person's row lasts at least as long as the room, and the room is listed for them. */
  async checkMembers(): Promise<void> {
    const code = this.core.r.code;
    for (const d of this.core.seatedDevices()) {
      const row = this.db.raw.prepare('SELECT expires_at FROM room_members WHERE code = ? AND device = ?').get(code, d) as { expires_at: number } | undefined;
      expect(row?.expires_at ?? 0, d.slice(0, 1)).toBeGreaterThanOrEqual(this.core.expiresAt());
      expect(await roomsOf(this.db, d, this.clock.t), d.slice(0, 1)).toContain(code);
    }
  }
}

describe('room members in D1 outlive their seats', () => {
  it('someone who left after the first match stays findable through 40 hours of rematches by the others', async () => {
    const room = new Room(testDb(), 'PQRST', A, { players: 2, opponents: ['lia'], turnSeconds: 15 });
    await room.join(A);
    await room.join(B);
    await room.handle(A, { t: 'start' });
    await room.playOut([A, B], 1);
    // B closes the tab; the AI keeps B's seat (with B's device and name) through every rematch.
    room.core.disconnect(B);
    await room.save();
    for (let m = 0; m < 5; m++) {
      room.clock.t += 8 * HOUR;
      // The daily retention job runs in between, by each row's own expiry.
      await runRetention(room.db, room.clock.t);
      await room.checkMembers();
      await room.handle(A, { t: 'rematch' });
      await room.playOut([A], 10 + m);
      await room.checkMembers();
    }
    expect(room.core.seatOf(B)).toBeGreaterThanOrEqual(0);
    // At the end of the room's life the rows are still there for a deletion or a recovery to use.
    room.clock.t = room.core.expiresAt() - 1;
    await runRetention(room.db, room.clock.t);
    await room.checkMembers();
  });

  it('someone who stays connected in a lobby for more than a day without any action of their own stays findable', async () => {
    const room = new Room(testDb(), 'LBBYS', A, { players: 4, turnSeconds: null });
    await room.join(A);
    await room.join(B);
    await room.join(C);
    // Only the owner's comings and goings keep the room alive, for 30 hours.
    for (let i = 0; i < 30 * 4; i++) {
      room.clock.t += HOUR / 4;
      room.core.disconnect(A);
      room.core.connect(A);
      await room.save();
      if (i % 16 === 0) await runRetention(room.db, room.clock.t);
      await room.checkMembers();
    }
  });
});
