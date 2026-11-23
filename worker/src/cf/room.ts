// One Durable Object per room: the authoritative server for its matches. It keeps the room in
// SQLite storage (one key), accepts WebSockets with the hibernation API (idle rooms cost
// nothing), uses one alarm for deadlines, returns and expiry, and never uses timers.
//
// The AI model versions come from R2 through ai-runtime.ts: the room reads the manifest (cached
// for 5 minutes) before each match start and pins the versions for the whole match; after a wake
// from hibernation it loads the pinned versions again before any move (ensure).
//
// When a match ends, the room writes its record (shared/match-record.ts, no person in it) to R2
// and the match and seat rows to D1, where the seats are linked to pseudonyms looked up by device
// id inside D1. The pending write is kept in storage until both succeed, and retried on the alarm.
//
// The brake (worker/src/brake.ts): a start or a rematch reserves the match's typical cost in D1
// together with the starter's allowance, and is refused when the brake says no. The room counts
// what it really receives and writes (requests, WebSocket messages, rows written in its storage and
// in D1, and the time its handlers run, brake.ts BusyClock) in its stored state, and when the match ends it
// swaps the reservation for that spend, in the same D1 batch as the match row. What the room
// spends after its last swap (the record's writes, closing sockets, its expiry) is
// written when it expires: one more ledger row per room.
//
// When a person deletes their data or moves it to another browser, the Worker calls forget() or
// rekey() on every room they are in (D1 room_members and open_rooms), so no room keeps their id.
// A call that could not get through waits in D1 room_calls; the room looks for its own there while
// it is used (settleWaitingCalls). The room keeps every seated person's room_members row valid at
// least as long as itself.

import { DurableObject } from 'cloudflare:workers';
import {
  CLOSE_FORGOTTEN,
  CLOSE_REPLACED,
  CLOSE_ROOM_CLOSED,
  MAX_MESSAGE_BYTES,
  parseClientMsg,
  type PublicRoom,
  type RoomSettings,
  type ServerMsg,
} from '../../../shared/protocol.ts';
import { buildMatchRecord, matchRecordKey, validateMatchRecord } from '../../../shared/match-record.ts';
import { profileCounts } from '../../../shared/profile.ts';
import { MATCHES_PER_CHECK, admitMatch, refundAdmission, type Admission } from '../allowance.ts';
import {
  BusyClock,
  METERS,
  REFUSAL_FROM_ROOM,
  addUsage,
  brakeConfig,
  emptyUsage,
  expirySettlement,
  logBrakeProblems,
  meteredDb,
  newRoomBrake,
  settleStatement,
  type BrakeConfig,
  type Reservation,
  type RoomBrake,
  type Settlement,
  type Usage,
} from '../brake.ts';
import { cleanNickname } from '../nickname.ts';
import { roomListingStatements, roomMemberStatement, type SqlDb } from '../privacy.ts';
import type { SeatProfile } from '../profiles.ts';
import { RECORD_PREFIX, RECORD_RETRY_MS, flushPending, moveRecordSeats, pendingCount, type PendingRecord } from '../pending-records.ts';
import { settleWaitingCalls } from '../room-calls.ts';
import { ROOM_TTL_MS, RoomCore, listingUpdate, memberUntil, type OpResult, type RoomDeps } from '../room-core.ts';
import { aiRuntime, type AiRuntime } from './ai-runtime.ts';
import type { Env } from './env.ts';

interface Attachment {
  device: string;
  verified: boolean;
  /** Credential expiry: after it, the person must pass the human check again to start matches. */
  verifiedUntil: number;
  /** Matches this device may still start before the next human check. */
  matchesLeft: number;
  /** Token bucket for flood control: refills 4 per second up to 10. */
  tokens: number;
  at: number;
}

const BUCKET = 10;
const REFILL_PER_S = 4;
const BLOCK_MS = 15 * 60_000;
const CLOSE_POLICY = 1008;
const CLOSE_TOO_BIG = 1009;
/** New connections per device per minute. */
const MAX_CONNECTS_PER_MINUTE = 6;
const encoder = new TextEncoder();

/** Storage key of the expiry last written to D1's open_rooms. */
const LISTED_KEY = 'listed';
/** While the room is used, it looks for calls waiting for it in D1 room_calls at most this often. */
const WAITING_CALLS_EVERY_MS = 5 * 60_000;
/** Storage key of the last time it looked (kept in storage, so a room that hibernates does not look on every wake). */
const CALLS_CHECKED_KEY = 'callsCheckedAt';

/** The room's synchronous storage as used here (ctx.storage.kv), counted for the brake. */
interface RoomKv {
  get(key: string): unknown;
  put(key: string, value: unknown): void;
  delete(key: string): boolean;
  list(options?: { prefix?: string }): Iterable<[string, unknown]>;
}

/** What starts one of the room's events, for the brake's meter. */
type RoomEvent = 'call' | 'upgrade' | 'message' | 'close' | 'alarm';

export type ReportAnswer = { ok: true; matchId: string | null; target: string | null } | { ok: false; reason: 'not_found' | 'not_in_room' | 'bad_report' };

/** The nickname the Worker passed (URI-encoded in a header), checked again; '' for none. */
function nameFrom(header: string | null): string {
  if (!header) return '';
  try {
    return cleanNickname(decodeURIComponent(header)) ?? '';
  } catch {
    return '';
  }
}

/** A uniform number in [0, 1) from the cryptographic generator (the control group draw). */
function cryptoRandom(): number {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return b[0] / 2 ** 32;
}

function randomSeed(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export class Room extends DurableObject<Env> {
  private core: RoomCore | null = null;
  private ai!: AiRuntime;
  private alarmAt: number | null = null;
  /** Recent connection times per device (memory only; a fresh object starts empty). */
  private connects = new Map<string, number[]>();
  /** Finished matches not yet written (kept in storage under rec:). */
  private pendingRecords = 0;
  /** A write failed (or the object restarted with records waiting): try again on an alarm. */
  private retryRecords = false;
  private flushing: Promise<void> | null = null;
  /** The expiry D1's open_rooms holds for this room (the Worker refuses the code once it passes). */
  private listedUntil = 0;
  /** The device that already took the match being started from its allowance (see webSocketMessage). */
  private reservedFor: string | null = null;
  /** When the room last looked for calls waiting for it in D1 (see settleCalls). */
  private callsCheckedAt = 0;
  /** The storage, counting every row it writes (spend). */
  private readonly kv: RoomKv;
  /** D1, counting the rows D1 says each statement wrote and read (spend). */
  private readonly db: SqlDb;
  /** The brake's settings (the Worker's variables). */
  private readonly brakeCfg: BrakeConfig;
  /** The time this instance's handlers run, for the brake (BusyClock). */
  private readonly clock = new BusyClock();
  /** The brake's meter as last stored with the room (see storeRoom). */
  private storedMeter = '';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const kv = ctx.storage.kv;
    this.kv = {
      get: (key) => kv.get(key),
      put: (key, value) => {
        kv.put(key, value);
        this.spend({ doRowsWritten: 1 });
      },
      delete: (key) => {
        const gone = kv.delete(key);
        if (gone) this.spend({ doRowsWritten: 1 });
        return gone;
      },
      list: (options) => kv.list(options),
    };
    this.db = meteredDb(env.DB, (written, read) => this.spend({ d1RowsWritten: written, d1RowsRead: read }));
    this.brakeCfg = brakeConfig(env);
    logBrakeProblems(this.brakeCfg);
    // Keep-alive pings are answered by the platform without waking the room.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    // The constructor of a new or woken instance is billed like any invocation (loading the
    // models after a wake may read R2): it goes on the clock until its setup settles.
    this.clock.enter(Date.now(), true);
    ctx.blockConcurrencyWhile(async () => {
      this.ai = aiRuntime(env);
      const raw = ctx.storage.kv.get('room') as string | undefined;
      if (raw) this.core = new RoomCore(JSON.parse(raw), this.deps());
      if (this.core) {
        const b = this.core.r.brake;
        // Rooms stored before a meter was renamed carry its old key: keep only the current meters.
        if (b) this.core.r.brake = newRoomBrake(b.ledger, b.open ? { key: b.open.key, est: addUsage(emptyUsage(), b.open.est) } : null, b.meter);
        else this.core.r.brake = newRoomBrake(null);
      }
      this.storedMeter = JSON.stringify(this.core?.r.brake?.meter ?? null);
      // A match in progress keeps its versions; one that cannot be loaded again is replaced (and
      // the record says so) before any move.
      const m = this.core?.r.match;
      if (this.core && m && this.core.r.status === 'playing') {
        const fixed = await this.ai.ensure(m.ai);
        if (this.core.setMatchAi(fixed)) this.storeRoom();
      }
      this.pendingRecords = pendingCount(ctx.storage.kv);
      this.retryRecords = this.pendingRecords > 0;
      this.listedUntil = (ctx.storage.kv.get(LISTED_KEY) as number | undefined) ?? 0;
      this.callsCheckedAt = (ctx.storage.kv.get(CALLS_CHECKED_KEY) as number | undefined) ?? 0;
      this.alarmAt = await ctx.storage.getAlarm();
    }).finally(() => this.clock.leave(Date.now()));
  }

  /** Runs one invocation of the room (a request, an RPC call, an event) on the brake's clock. */
  private async timed<T>(run: () => Promise<T> | T): Promise<T> {
    this.clock.enter(Date.now(), true);
    try {
      return await run();
    } finally {
      this.clock.leave(Date.now());
    }
  }

  /** ctx.waitUntil, with the promise on the brake's clock: until it settles the room cannot hibernate. */
  private keep(p: Promise<unknown>): void {
    this.clock.enter(Date.now(), false);
    this.ctx.waitUntil(p.finally(() => this.clock.leave(Date.now())));
  }

  private deps(): RoomDeps {
    return {
      now: () => Date.now(),
      randomSeed,
      agentFor: (seat, persona, partnerHuman, version) => this.ai.agentFor(version, seat, persona, partnerHuman),
      pickAi: (solo) => this.ai.pick(solo, cryptoRandom),
      rand: Math.random,
      timeScale: Math.min(1, Math.max(0.01, Number(this.env.ROOM_TIME_SCALE || '1') || 1)),
      onMatchStart: (devices) => this.countMatch(devices),
      onAbandon: (device) => {
        this.keep(this.db.prepare('UPDATE devices SET abandons = abandons + 1 WHERE id = ?').bind(device).run().then(() => undefined));
      },
    };
  }

  /**
   * Builds the record of a match that just ended and keeps it for writing (see flushRecords), with
   * the brake's swap of its reservation for what the room spent. A match whose record cannot be
   * built still gets its swap, written alone.
   */
  private takeRecord(): void {
    const core = this.core;
    const m = core?.takeFinished();
    if (!core || !m) return;
    const swap = this.takeSwap();
    let pending: PendingRecord;
    try {
      const rec = buildMatchRecord(core.r, core.match ?? undefined, { test: this.env.TEST_RECORDS === 'true' });
      // Never write a record the engine cannot replay to its result.
      if (!validateMatchRecord(rec).ok) {
        this.settleAlone(swap);
        return;
      }
      const seats = rec.seats.flatMap((s) => {
        const device = s.kind === 'human' ? core.r.seats[s.seat]?.device : null;
        return device ? [{ seat: s.seat, device, verified: s.verified }] : [];
      });
      // The style counters of each linked person (shared/profile.ts), added to D1 with the seat link.
      // None for a person with "Don't adapt to me" on (D1 checks it again when it writes); a
      // counting error only loses the counters.
      let profiles: SeatProfile[] = [];
      try {
        const counting = seats.filter((s) => !core.r.seats[s.seat]?.noAdapt);
        const counted = counting.length > 0 ? profileCounts(rec) : [];
        profiles = counting.flatMap((s) => {
          const c = counted.find((x) => x.seat === s.seat);
          return c ? [{ seat: s.seat, device: s.device, segment: c.segment, counts: c.counts }] : [];
        });
      } catch {
        profiles = [];
      }
      pending = {
        body: JSON.stringify(rec),
        row: {
          matchId: rec.matchId,
          startedAt: rec.startedAt,
          endedAt: rec.endedAt,
          kind: rec.kind,
          variant: rec.config.variant,
          players: rec.config.players,
          aiVersion: rec.aiVersion,
          recordKey: matchRecordKey(rec),
          seats,
          profiles,
          // The public counters (GET /api/live): moves people made themselves, automatic ones out.
          humanDecisions: rec.moves.filter((m) => m.ms !== null).length,
          ...(swap ? { brake: swap } : {}),
        },
      };
    } catch {
      this.settleAlone(swap);
      return;
    }
    this.kv.put(RECORD_PREFIX + pending.row.matchId, JSON.stringify(pending));
    this.pendingRecords++;
  }

  // -------------------------------------------------------------------------------------------
  // The brake's meter

  /** Adds to what the room spent since the last swap (memory first; stored with the room's next save). */
  private spend(part: Partial<Usage>): void {
    const b = this.core?.r.brake;
    if (b) b.meter = addUsage(b.meter, part);
  }

  /** Takes a cost the ledger already holds out of the meter (never below zero), so it is not counted twice. */
  private unspend(part: Partial<Usage>): void {
    const b = this.core?.r.brake;
    if (!b) return;
    const out = { ...b.meter };
    for (const m of METERS) out[m] = Math.max(0, out[m] - (part[m] ?? 0));
    b.meter = out;
  }

  /** One event of the room: its request, and the time its handlers ran since the clock was last read. */
  private event(kind: RoomEvent): void {
    this.spend({
      doActiveMs: this.clock.take(Date.now()),
      doRequests: kind === 'message' ? 0 : 1,
      doWsMessages: kind === 'message' ? 1 : 0,
      // Calls and upgrades come from a request to the Worker; alarms, messages and closes do not.
      workerRequests: kind === 'call' || kind === 'upgrade' ? 1 : 0,
    });
  }

  /** The rows deleteAll() is about to delete: every key and the alarm. */
  private storedRows(): number {
    return [...this.kv.list()].length + (this.alarmAt !== null ? 1 : 0);
  }

  /** Whether the brake counts this room's spend: the brake is on, or the room keeps a test ledger. */
  private brakeOn(b: RoomBrake): boolean {
    return this.brakeCfg.mode !== 'off' || b.ledger !== null;
  }

  /**
   * The swap for the match that just ended: its reservation and everything the room spent since
   * the last swap (the lobby or the time between matches included). Null when the match started
   * without a reservation (the brake was off, or the room is older than the brake): the spend then
   * goes with the next swap or the room's expiry, or nowhere while the brake is off. The meter
   * starts again from zero; what follows (the record's own writes included) goes with the next
   * swap, or with the expiry (alarm).
   */
  private takeSwap(): Settlement | null {
    const b = this.core?.r.brake;
    if (!b) return null;
    if (!b.open) {
      if (!this.brakeOn(b)) b.meter = emptyUsage();
      return null;
    }
    const swap: Settlement = { key: b.open.key, reserved: b.open.est, spent: b.meter };
    b.open = null;
    b.meter = emptyUsage();
    return swap;
  }

  /** A swap written on its own (the match had no record to write it with). */
  private settleAlone(swap: Settlement | null): void {
    if (!swap) return;
    this.keep(settleStatement(this.db, swap, Date.now()).run().then(() => undefined, () => undefined));
  }

  /**
   * A match started with this reservation. One still open (a match that ended without a swap,
   * which should not happen) is swapped first with what was counted until now.
   */
  private openReservation(r: Reservation | null): void {
    const b = this.core?.r.brake;
    if (!b || !r) return;
    if (b.open) this.settleAlone(this.takeSwap());
    b.open = r;
  }

  /** People at the table for a start or a rematch: everyone connected (a rematch gives the seats of the others to the AI). */
  private peopleForStart(core: RoomCore): number {
    return Math.max(1, core.r.seats.filter((s) => s.kind === 'human' && s.connected).length);
  }

  /** Writes every pending record (see flushPending); one flush at a time. */
  private flushRecords(): Promise<void> {
    if (this.pendingRecords === 0) return Promise.resolve();
    this.flushing ??= (async () => {
      const put = (key: string, body: string) => this.env.EVENTS.put(key, body, { httpMetadata: { contentType: 'application/json' } });
      await flushPending(this.kv, this.db, put, Date.now);
      this.pendingRecords = pendingCount(this.kv);
      this.retryRecords = this.pendingRecords > 0;
      if (this.retryRecords) this.schedule();
      // The flush spent after the state was stored (the match row batch in D1, the rec: delete):
      // the state is stored once more, so that spend survives a hibernation until the next swap
      // or the expiry writes it. A room that expired is not stored again (its alarm writes it).
      const core = this.core;
      const b = core?.r.brake;
      if (core && b && this.brakeOn(b) && Date.now() < core.expiresAt() && JSON.stringify(b.meter) !== this.storedMeter) this.storeRoom();
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /**
   * Each match started counts toward the 10 matches allowed per human check, for everyone at the
   * table except the person who started it (they spent it in D1 before the start). Someone who had
   * none left still plays, without the verified seal (unverify). Everyone seated, also people away
   * whose seat an AI keeps, stays listed as a member of this room for as long as it lasts.
   */
  private countMatch(devices: string[]): void {
    const core = this.core;
    if (!core) return;
    const now = Date.now();
    const db = this.db;
    const matchId = core.r.match?.id ?? null;
    const others = devices.filter((d) => d !== this.reservedFor);
    const until = memberUntil(now, this.listedUntil);
    const stmts = [
      ...others.map((d) =>
        db.prepare('UPDATE devices SET matches_since_verify = matches_since_verify + 1, last_seen = ?1 WHERE id = ?2 RETURNING matches_since_verify AS n').bind(now, d),
      ),
      ...core.seatedDevices().map((d) => roomMemberStatement(db, core.r.code, d, until)),
    ];
    if (stmts.length === 0) return;
    this.keep(
      db.batch(stmts).then(
        (res) => {
          const spent = (i: number) => ((res[i].results?.[0] as { n?: number } | undefined)?.n ?? 0) > MATCHES_PER_CHECK;
          this.unverify(others.filter((_, i) => spent(i)), matchId);
        },
        () => undefined,
      ),
    );
    for (const d of others) this.adjustMatchesLeft(d, (left) => Math.max(0, left - 1));
  }

  /** Takes the verified seal from people who had no matches left (RoomCore.unverify); everyone sees the change. */
  private unverify(devices: string[], matchId: string | null): void {
    const core = this.core;
    if (!core) return;
    let changed = false;
    for (const d of devices) changed = core.unverify(d, matchId) || changed;
    if (!changed) return;
    this.save();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att) this.send(ws, core.roomMessage(att.device));
    }
  }

  private adjustMatchesLeft(device: string, f: (left: number) => number): void {
    for (const ws of this.ctx.getWebSockets(device)) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att) continue;
      att.matchesLeft = f(att.matchesLeft);
      ws.serializeAttachment(att);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Calls from the Worker (RPC)

  create(
    code: string,
    settings: RoomSettings,
    owner: string,
    verified: boolean,
    verifiedUntil: number,
    ownerName = '',
    ownerNoAdapt = false,
    brake?: RoomBrake,
  ): Promise<{ ok: boolean; reason?: string }> {
    return this.timed(() => this.createRoom(code, settings, owner, verified, verifiedUntil, ownerName, ownerNoAdapt, brake));
  }

  private async createRoom(
    code: string,
    settings: RoomSettings,
    owner: string,
    verified: boolean,
    verifiedUntil: number,
    ownerName: string,
    ownerNoAdapt: boolean,
    brake: RoomBrake | undefined,
  ): Promise<{ ok: boolean; reason?: string }> {
    if (this.core && Date.now() < this.core.expiresAt()) {
      this.event('call');
      return { ok: false, reason: 'exists' };
    }
    // A reused code starts clean (no old blocks or state); a record still waiting goes out first.
    await this.flushRecords();
    const cleared = this.storedRows();
    await this.ctx.storage.deleteAll();
    this.pendingRecords = 0;
    this.alarmAt = null;
    this.connects.clear();
    // Quick play starts its match at once: the manifest first (cached for 5 minutes).
    await this.ai.refresh(Date.now());
    try {
      this.core = RoomCore.create(code, settings, owner, verified, this.ai.label, this.deps(), verifiedUntil, cleanNickname(ownerName) ?? '', ownerNoAdapt === true);
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
    this.core.clearPending();
    // The brake: the Worker's test ledger and, for quick play, the reservation of the match just
    // dealt, with what the Worker spent in D1 for this room; then this call itself.
    this.core.r.brake = brake ? newRoomBrake(brake.ledger, brake.open, brake.meter) : newRoomBrake(null);
    this.spend({ doRowsWritten: cleared });
    this.event('call');
    // The Worker listed the room with this expiry when it reserved the code.
    this.listedUntil = this.core.expiresAt();
    this.kv.put(LISTED_KEY, this.listedUntil);
    // Nobody could call a room that did not exist yet.
    this.callsCheckedAt = Date.now();
    this.kv.put(CALLS_CHECKED_KEY, this.callsCheckedAt);
    this.save();
    this.schedule();
    return { ok: true };
  }

  info(): Promise<PublicRoom | null> {
    return this.timed(() => this.readInfo());
  }

  private readInfo(): PublicRoom | null {
    this.event('call');
    if (!this.core || Date.now() >= this.core.expiresAt()) return null;
    return this.core.publicRoom();
  }

  /**
   * A report from a person seated here about another seat. Answers the current (or last) match id
   * and the reported person's device id (null for an AI), which the Worker turns into pseudonyms
   * inside D1. hide: a nickname report hides the name at once for everyone at the table.
   */
  report(device: string, seat: number, hide: boolean): Promise<ReportAnswer> {
    return this.timed(() => this.takeReport(device, seat, hide));
  }

  private takeReport(device: string, seat: number, hide: boolean): ReportAnswer {
    this.event('call');
    const core = this.core;
    if (!core || Date.now() >= core.expiresAt()) return { ok: false, reason: 'not_found' };
    const me = core.seatOf(device);
    if (me < 0) return { ok: false, reason: 'not_in_room' };
    const s = core.r.seats[seat];
    if (!Number.isInteger(seat) || !s || seat === me || s.kind === 'empty') return { ok: false, reason: 'bad_report' };
    if (hide && core.hideName(seat)) {
      this.save();
      for (const ws of this.ctx.getWebSockets()) {
        const att = ws.deserializeAttachment() as Attachment | null;
        if (att) this.send(ws, core.roomMessage(att.device));
      }
    }
    return { ok: true, matchId: core.r.match?.id ?? null, target: s.kind === 'human' ? s.device : null };
  }

  /** The person changed "Don't adapt to me": the seat follows from the next match (RoomCore.setNoAdapt). */
  setNoAdapt(device: string, on: boolean): Promise<void> {
    return this.timed(() => this.noAdapt(device, on));
  }

  private noAdapt(device: string, on: boolean): void {
    this.event('call');
    const core = this.core;
    if (!core || Date.now() >= core.expiresAt()) return;
    if (core.setNoAdapt(device, on)) this.save();
  }

  /**
   * The device's data was deleted: the room lets go of it (see RoomCore.forget). held: the room had
   * a reservation open, which it gives back itself (with the match row if the match ended, or when
   * it expires): a Worker whose create() answer was lost must not give it back too (room-create.ts).
   */
  forget(device: string): Promise<{ held: boolean }> {
    return this.timed(() => {
      this.event('call');
      const held = Boolean(this.core?.r.brake?.open);
      this.letGo(device, null);
      return { held };
    });
  }

  /** The person recovered their data in a new browser: their seat here follows the new device id. */
  rekey(from: string[], to: string): Promise<void> {
    return this.timed(() => {
      this.event('call');
      for (const device of from) this.letGo(device, to);
    });
  }

  /**
   * Removes a device id from everything this room keeps: its connections (closed with
   * CLOSE_FORGOTTEN), its flood block, the match records waiting to be written and the room
   * state. With to, the seat, the block and the records move to that id instead.
   */
  private letGo(device: string, to: string | null): void {
    for (const ws of this.ctx.getWebSockets(device)) ws.close(CLOSE_FORGOTTEN, 'forgotten');
    this.connects.delete(device);
    const block = this.kv.get(`block:${device}`) as number | undefined;
    if (block !== undefined) {
      this.kv.delete(`block:${device}`);
      if (to) this.kv.put(`block:${to}`, block);
    }
    // A record waiting for this seat's device goes out at once with the new id (or without it).
    if (moveRecordSeats(this.kv, device, to)) this.keep(this.flushRecords());
    const core = this.core;
    if (!core || !(to ? core.rekey(device, to) : core.forget(device))) return;
    this.takeRecord();
    this.save();
    if (core.r.closed) {
      core.clearPending();
      for (const ws of this.ctx.getWebSockets()) ws.close(CLOSE_ROOM_CLOSED, 'closed');
    } else {
      this.broadcast(true);
    }
    this.schedule();
    this.keep(this.flushRecords());
  }

  // -------------------------------------------------------------------------------------------
  // WebSocket upgrade, forwarded by the Worker after it checked the origin and the credential.

  fetch(request: Request): Promise<Response> {
    return this.timed(() => this.upgrade(request));
  }

  private async upgrade(request: Request): Promise<Response> {
    this.event('upgrade');
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected a WebSocket', { status: 426 });
    const device = request.headers.get('X-Zap-Device');
    const verified = request.headers.get('X-Zap-Verified') === '1';
    const verifiedUntil = Number(request.headers.get('X-Zap-Verified-Until') ?? '0');
    const matchesLeft = Number(request.headers.get('X-Zap-Matches-Left') ?? '0');
    const name = nameFrom(request.headers.get('X-Zap-Name'));
    const noAdapt = request.headers.get('X-Zap-No-Adapt') === '1';
    if (!device || !/^[0-9a-f]{64}$/.test(device)) return new Response('no device', { status: 400 });
    const now = Date.now();
    const core = this.core;
    if (!core || now >= core.expiresAt()) return new Response('room not found', { status: 404 });
    const blocked = this.kv.get(`block:${device}`) as number | undefined;
    if (blocked && blocked > now) return new Response('blocked', { status: 429 });
    const recent = (this.connects.get(device) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= MAX_CONNECTS_PER_MINUTE) return new Response('too many connections', { status: 429 });
    recent.push(now);
    this.connects.set(device, recent);
    const mayTakeNewSeat = verifiedUntil > now && matchesLeft > 0;
    const refused = core.joinError(device, mayTakeNewSeat);
    if (refused) return new Response(refused, { status: refused === 'check_needed' ? 401 : 409 });
    // The membership row is written before the seat is given, and only while D1 still has the
    // device, so a deletion or a recovery always finds this room. Nothing else runs in the room
    // until the seat is settled: a forget() or rekey() that arrives meanwhile waits for it.
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const listed = await roomMemberStatement(this.db, core.r.code, device, memberUntil(now, this.listedUntil)).run();
        // Deleted, or moved to another browser, since the Worker looked it up.
        if (listed.meta.changes === 0) return new Response('check_needed', { status: 401 });
        return this.admit(core, device, { verified, verifiedUntil, matchesLeft, mayTakeNewSeat, name, noAdapt }, now);
      } catch {
        // An error here must not reset the room (blockConcurrencyWhile would): the person tries again.
        return new Response('try again', { status: 503 });
      }
    });
  }

  /** Seats the person (joinError already said yes) and opens their connection. */
  private admit(
    core: RoomCore,
    device: string,
    who: { verified: boolean; verifiedUntil: number; matchesLeft: number; mayTakeNewSeat: boolean; name: string; noAdapt: boolean },
    now: number,
  ): Response {
    const joined = core.join(device, who.verified, who.verifiedUntil, who.mayTakeNewSeat, who.name, who.noAdapt);
    if ('error' in joined) return new Response(joined.error, { status: joined.error === 'check_needed' ? 401 : 409 });
    // One connection per person: a new tab replaces the old one (and its flood budget).
    for (const old of this.ctx.getWebSockets(device)) old.close(CLOSE_REPLACED, 'replaced');
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [device]);
    const att: Attachment = { device, verified: who.verified, verifiedUntil: who.verifiedUntil, matchesLeft: who.matchesLeft, tokens: BUCKET, at: now };
    server.serializeAttachment(att);
    core.connect(device);
    this.takeRecord();
    this.save();
    // Everyone hears about the arrival, and the new connection gets the full state.
    this.broadcast(true);
    this.schedule();
    this.keep(this.flushRecords());
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    return this.timed(() => this.message(ws, message));
  }

  private async message(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.event('message');
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att || !this.core) {
      ws.close(CLOSE_POLICY, 'gone');
      return;
    }
    const size = typeof message === 'string' ? encoder.encode(message).byteLength : message.byteLength;
    if (size > MAX_MESSAGE_BYTES) {
      ws.close(CLOSE_TOO_BIG, 'too big');
      return;
    }
    // Flood control, checked before reading the message.
    const now = Date.now();
    att.tokens = Math.min(BUCKET, att.tokens + ((now - att.at) / 1000) * REFILL_PER_S);
    att.at = now;
    if (att.tokens < 1) {
      // Too many messages: this device's connections to this room close, this room refuses it for
      // 15 min, and so does the Worker for every room and new match (devices.blocked_until).
      // Connections it already has to other rooms stay open.
      this.kv.put(`block:${att.device}`, now + BLOCK_MS);
      this.keep(this.db.prepare('UPDATE devices SET blocked_until = ? WHERE id = ?').bind(now + BLOCK_MS, att.device).run().then(() => undefined));
      for (const s of this.ctx.getWebSockets(att.device)) s.close(CLOSE_POLICY, 'too fast');
      return;
    }
    att.tokens -= 1;
    ws.serializeAttachment(att);

    const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);
    const msg = parseClientMsg(raw);
    if (!msg) {
      this.send(ws, { t: 'error', code: 'bad_message' });
      return;
    }
    if (msg.t === 'sync') {
      this.sendState(ws, att.device);
      return;
    }
    // A new match takes one from the person's allowance in D1 before it starts, and the brake
    // reserves its typical cost in the same batch (allowance.ts admitMatch). The count kept on the
    // socket is only a first filter: other sockets and quick play spend the same allowance.
    let admitted: Extract<Admission, { ok: true }> | null = null;
    if (msg.t === 'start' || msg.t === 'rematch') {
      const pre = this.core.preStart(att.device, msg.t);
      if (!pre.ok) {
        this.send(ws, { t: 'error', code: pre.code });
        return;
      }
      if (!(att.verifiedUntil > now && att.matchesLeft > 0)) {
        this.send(ws, { t: 'error', code: 'check_needed' });
        return;
      }
      const ans = await admitMatch(this.db, this.brakeCfg, att.device, this.peopleForStart(this.core), Date.now(), this.core.r.brake?.ledger ?? null, REFUSAL_FROM_ROOM);
      if (!ans.ok) {
        // The brake said no: the match does not start, and the person reads when to come back. The
        // refusal's own cost went to the ledger with it, so the meter lets go of it.
        if (ans.code === 'limit_reached') this.unspend(REFUSAL_FROM_ROOM);
        this.send(ws, ans.code === 'limit_reached' ? { t: 'error', code: 'limit_reached', limit: ans.limit } : { t: 'error', code: 'check_needed' });
        return;
      }
      admitted = ans;
      // The versions of the new match come from the manifest (cached for 5 minutes).
      await this.ai.refresh(Date.now());
    }
    const core = this.core;
    if (!core) {
      // The room expired while D1 answered.
      if (admitted) this.keep(refundAdmission(this.db, att.device, admitted.reservation, Date.now()));
      ws.close(CLOSE_POLICY, 'gone');
      return;
    }
    // Every other message, the solo hold included ({ t: 'hold' }, CLIENT-SPEC 16.5), goes to the
    // room's rules; a change bumps the sequence and is stored and sent below.
    const before = { seq: core.r.seq, pending: core.pending.length, phrases: core.phrases.length };
    let res: OpResult;
    this.reservedFor = admitted ? att.device : null;
    try {
      res = core.handle(att.device, msg, { mayStartMatch: admitted !== null });
    } finally {
      this.reservedFor = null;
    }
    if (admitted) {
      // The start happened: the socket learns what is left, and the reservation belongs to the
      // match until its swap. It did not (the room changed while D1 answered): both go back.
      const remaining = admitted.left;
      if (res.ok) {
        this.adjustMatchesLeft(att.device, () => remaining);
        this.openReservation(admitted.reservation);
      } else {
        this.keep(refundAdmission(this.db, att.device, admitted.reservation, Date.now()));
      }
    }
    if (!res.ok) {
      this.send(ws, { t: 'error', code: res.code });
      if (res.code === 'stale' || res.code === 'not_your_turn') this.sendState(ws, att.device);
      return;
    }
    if (msg.t === 'leave') ws.close(1000, 'left');
    // Nothing happened (taking back a seat the AI was not playing): nothing to store or send.
    if (core.r.seq === before.seq && core.pending.length === before.pending && core.phrases.length === before.phrases) return;
    this.takeRecord();
    this.save();
    if (core.r.closed) {
      for (const s of this.ctx.getWebSockets()) s.close(CLOSE_ROOM_CLOSED, 'closed');
    } else {
      this.broadcast();
    }
    this.schedule();
    await this.flushRecords();
  }

  webSocketClose(ws: WebSocket, code: number): Promise<void> {
    return this.timed(() => this.closed(ws, code));
  }

  webSocketError(ws: WebSocket): Promise<void> {
    return this.timed(() => this.closed(ws, 1011));
  }

  private closed(ws: WebSocket, code: number): void {
    this.event('close');
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att || !this.core) return;
    void code;
    const others = this.ctx.getWebSockets(att.device).filter((w) => w !== ws && w.readyState === WebSocket.OPEN);
    if (others.length > 0) return;
    // The close code comes from the client and is never trusted.
    this.core.disconnect(att.device);
    this.save();
    this.broadcast();
    this.schedule();
  }

  alarm(): Promise<void> {
    return this.timed(() => this.onAlarm());
  }

  private async onAlarm(): Promise<void> {
    this.alarmAt = null;
    this.event('alarm');
    await this.flushRecords();
    if (!this.core) {
      await this.ctx.storage.deleteAll();
      this.pendingRecords = 0;
      return;
    }
    if (this.core.alarm() === 'expired') {
      const code = this.core.r.code;
      const closed = this.core.r.closed;
      for (const ws of this.ctx.getWebSockets()) ws.close(closed ? CLOSE_ROOM_CLOSED : 1000, closed ? 'closed' : 'expired');
      // The brake: what the room spent since its last swap (the last record's writes, closing
      // sockets, this expiry and its deleted storage, the time it all ran) is written now, with
      // the reservation of a match nobody finished, if any: one ledger row per room.
      this.spend({ doRowsWritten: this.storedRows(), doActiveMs: this.clock.take(Date.now()) });
      const b = this.core.r.brake ?? null;
      const now = Date.now();
      this.core = null;
      await this.ctx.storage.deleteAll();
      this.pendingRecords = 0;
      // The room is gone, and so are its listing, its members and any call still waiting for it.
      // Those deletes are counted too (b is no longer the room's, so they are added to it here).
      const counted = b && (b.open || this.brakeOn(b)) ? b : null;
      const db = counted
        ? meteredDb(this.env.DB, (written, read) => {
            counted.meter = addUsage(counted.meter, { d1RowsWritten: written, d1RowsRead: read });
          })
        : this.env.DB;
      const cleanup = ['open_rooms', 'room_members', 'room_calls'].map((table) => db.prepare(`DELETE FROM ${table} WHERE code = ?1`).bind(code));
      try {
        await db.batch(cleanup);
      } finally {
        // The time since the state was dropped (deleteAll and the batch above) goes with it too.
        if (counted) counted.meter = addUsage(counted.meter, { doActiveMs: this.clock.take(Date.now()) });
        const left = counted ? expirySettlement(counted, this.brakeOn(counted), now) : null;
        if (left) await settleStatement(this.env.DB, left, now).run();
      }
      return;
    }
    this.takeRecord();
    // Forget flood blocks that ran out.
    const now = Date.now();
    for (const [key, until] of this.kv.list({ prefix: 'block:' })) {
      if ((until as number) <= now) this.kv.delete(key);
    }
    this.save();
    this.broadcast();
    this.schedule();
    await this.flushRecords();
  }

  // -------------------------------------------------------------------------------------------

  /**
   * Stores the room. The listing, the calls check and the alarm go first, so the rows they write
   * are in the meter stored with the room (a room may hibernate right after, and its memory is
   * lost then). Calling schedule() here again later in the same event changes nothing.
   */
  private save(): void {
    if (!this.core) return;
    this.refreshListing();
    this.settleCalls();
    this.schedule();
    this.storeRoom();
  }

  /** Writes the room's state, its own row and the time its handlers ran until now counted in the meter it stores. */
  private storeRoom(): void {
    const core = this.core;
    if (!core) return;
    this.spend({ doRowsWritten: 1, doActiveMs: this.clock.take(Date.now()) });
    this.ctx.storage.kv.put('room', JSON.stringify(core.r));
    this.storedMeter = JSON.stringify(core.r.brake?.meter ?? null);
  }

  /**
   * Local test sites only (TEST_RECORDS "true" and a room on a test ledger, see brake.ts
   * TestLedger): the room expires now, as it would 24 hours after its last event, so a test or a
   * measurement reads what the expiry writes. The call is not counted as a request (a real expiry
   * has no call); its time on the clock stands for the constructor of the instance that a real
   * expiry wakes from hibernation.
   */
  expireForTest(): Promise<boolean> {
    return this.timed(async () => {
      const core = this.core;
      if (this.env.TEST_RECORDS !== 'true' || !core?.r.brake?.ledger) return false;
      core.r.lastActivity = Date.now() - ROOM_TTL_MS;
      this.ctx.storage.kv.put('room', JSON.stringify(core.r));
      this.alarmAt = Date.now();
      await this.ctx.storage.setAlarm(this.alarmAt);
      return true;
    });
  }

  /**
   * A deletion or a recovery whose call did not get through left it in D1 room_calls. While the
   * room is used, it looks for its own there at most every WAITING_CALLS_EVERY_MS and applies them
   * (letGo), so the old id's connections close and its seat moves within minutes, not at the
   * daily job. A failed look is tried again after the same interval.
   */
  private settleCalls(): void {
    const code = this.core?.r.code;
    const now = Date.now();
    if (!code || now - this.callsCheckedAt < WAITING_CALLS_EVERY_MS) return;
    this.callsCheckedAt = now;
    this.kv.put(CALLS_CHECKED_KEY, now);
    this.keep(
      settleWaitingCalls(this.db, code, (c) => {
        for (const device of c.from) this.letGo(device, c.to);
      }).then(
        () => undefined,
        () => undefined,
      ),
    );
  }

  /**
   * Keeps D1's open_rooms expiry at or after the room's own (see listingUpdate), so the Worker
   * never refuses the code of a room that is still in use, and every seated person's room_members
   * row along with it, so a deletion or a recovery finds the room for as long as it keeps the seat.
   * A room that expires deletes its rows itself (alarm).
   */
  private refreshListing(): void {
    const core = this.core;
    if (!core || core.r.closed) return;
    const until = listingUpdate(core.expiresAt(), this.listedUntil);
    if (until === null) return;
    const before = this.listedUntil;
    this.listedUntil = until;
    this.kv.put(LISTED_KEY, until);
    const db = this.db;
    this.keep(
      db
        .batch(roomListingStatements(db, core.r.code, until, core.seatedDevices()))
        .then(
          () => undefined,
          () => {
            // Tried again on the next change.
            if (this.listedUntil !== until) return;
            this.listedUntil = before;
            this.kv.put(LISTED_KEY, before);
          },
        ),
    );
  }

  /** One alarm, at the earliest time the room needs; an earlier pending alarm is kept. */
  private schedule(): void {
    let next = this.core?.nextAlarm() ?? null;
    if (this.retryRecords && this.pendingRecords > 0) next = Math.min(next ?? Infinity, Date.now() + RECORD_RETRY_MS);
    if (next === null) return;
    // Never closer than 250 ms: a safety net against any loop of alarms.
    const t = Math.max(next, Date.now() + 250);
    if (this.alarmAt !== null && this.alarmAt <= t) return;
    this.alarmAt = t;
    void this.ctx.storage.setAlarm(t);
    this.spend({ doRowsWritten: 1 });
  }

  private send(ws: WebSocket, msg: ServerMsg): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // The socket is closing; its close handler takes care of the seat.
    }
  }

  private sendState(ws: WebSocket, device: string): void {
    const core = this.core!;
    this.send(ws, core.roomMessage(device));
    const g = core.gameMessage(core.seatOf(device), []);
    if (g) this.send(ws, g);
  }

  /** Sends every connected seat its own view of what just happened (only the seats concerned, for a signal). */
  private broadcast(everyone = false): void {
    const core = this.core;
    if (!core) return;
    for (const ws of this.ctx.getWebSockets()) {
      // A connection being closed (a forgotten device, a replaced tab) gets nothing more.
      if (ws.readyState !== WebSocket.OPEN) continue;
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att) continue;
      const seat = core.seatOf(att.device);
      if (!everyone && core.notify && !core.notify.has(seat)) continue;
      this.send(ws, core.roomMessage(att.device));
      const g = core.gameMessage(seat);
      if (g) this.send(ws, g);
      for (const p of core.phrases) this.send(ws, { t: 'phrase', seat: p.seat, key: p.key });
    }
    core.clearPending();
  }
}
