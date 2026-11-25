// The logic of one room, without any Cloudflare API: seats, matches, AI in empty seats, turn
// deadlines, drops and returns, abandonment, rematch, the owner's arrangement of a room with
// friends (the seat plan, move, plan, lobby) and expiry. The Durable Object (room.ts) stores the
// state, owns the WebSockets and the alarm, and calls these methods.
//
// Everything that leaves the room for a seat goes through gameMessage(), which uses observe()
// and eventsFor() from the engine, so hidden information never leaves the server.

import { DEFAULT_OPTIONS, makeConfig, type MatchConfig, type RuleOptions } from '../../engine/src/config.ts';
import {
  A_SIGNAL0,
  SIGNAL_MASK,
  applyAction,
  expectedActor,
  isLegal,
  legalMask,
  newMatch,
  replay,
  type GameEvent,
  type MatchState,
} from '../../engine/src/engine.ts';
import { eventsFor, observe, type Observation } from '../../engine/src/observe.ts';
import { agentContext, type Agent } from '../../ai/src/agent.ts';
import { HeuristicAgent } from '../../ai/src/heuristic.ts';
import type { PersonaId } from '../../ai/src/personas.ts';
import { PERSONAS } from '../../ai/src/personas.ts';
import type { ClientMsg, ErrorCode, PhraseKey, PublicRoom, PublicSeat, RoomSettings, ServerMsg, TimedEvent } from '../../shared/protocol.ts';
import { drawLineup, firstFree, isPersonaId, lineupProblem } from '../../shared/lineup.ts';
import { seatVersion, type MoveInfo, type RecordSeat, type RecordedMatch } from '../../shared/match-record.ts';
import type { MatchAi } from '../../shared/cycle-formats.ts';
import type { RoomBrake } from './brake.ts';

export const AI_DELAY_MS = 700;
export const HAND_END_DELAY_MS = 1600;
export const RECONNECT_GRACE_MS = 20_000;
export const ABANDON_AFTER_MS = 120_000;
export const MAX_TIMEOUTS = 3;
export const ROOM_TTL_MS = 24 * 3600_000;
export const PHRASE_INTERVAL_MS = 5_000;
/** Time added to a deadline when the client sends its own automatic move (network slack). */
export const AUTO_SLACK_MS = 1_500;
/** At most this many AI moves (signals aside) in one event, to stay well inside the CPU budget; the rest follow on the alarm. */
export const MAX_AI_MOVES_PER_EVENT = 12;
/** A hold (an ad between solo hands) longer than this counts the rest as decision time. */
export const HOLD_FREE_MS = 150_000;
/**
 * PublicRoom.setup: what this room code can do beyond M14, so a newer page offers only what the
 * room will keep. 1: the quick play lineup draw and the rematch switches. 2: also the owner's
 * arrangement of a room with friends (move, plan, lobby), ownerAway and the owner rule after a
 * match, and the planned character on a free seat.
 */
export const ROOM_SETUP = 2;

/** D1's open_rooms expiry is written this far ahead of the room's own, so an active room rewrites it about once an hour. */
export const LISTING_AHEAD_MS = 3600_000;

/**
 * The expiry to write to D1's open_rooms once the room's own expiry passed the one listed there,
 * or null while the listing still covers it. The Worker refuses a code whose listing expired, so
 * the listing must never fall behind a room that is still in use.
 */
export function listingUpdate(expiresAt: number, listedUntil: number): number | null {
  return expiresAt > listedUntil ? expiresAt + LISTING_AHEAD_MS : null;
}

/**
 * The expiry of a membership row (D1 room_members) written now: never before the listing, and past
 * the room's own expiry even when this moment's activity moves it. The listing rewrite carries every
 * seated person's row along (Room.refreshListing), so a row always outlives the seat it stands for
 * and a deletion or a recovery always finds the room.
 */
export function memberUntil(now: number, listedUntil: number): number {
  return Math.max(listedUntil, now + ROOM_TTL_MS + LISTING_AHEAD_MS);
}

export interface StoredSeat {
  kind: 'human' | 'ai' | 'empty';
  device: string | null;
  name: string;
  /**
   * Quick play: the character of an AI seat, null for the person. Rooms with friends hold a plan
   * on every seat, all different (invariant P1): the character of an AI seat; on a free seat the
   * AI that plays it if nobody sits there by the start (published); on a person's seat a hidden
   * fallback, used only if the seat goes to an AI at a start (never published, never recorded).
   * The plan belongs to the seat position: people move without it, an AI moves with it.
   */
  persona: PersonaId | null;
  verified: boolean;
  /** Until when the "humano verificado" seal holds (the credential's expiry). */
  verifiedUntil: number;
  connected: boolean;
  awaySince: number | null;
  timeouts: number;
  abandoned: boolean;
  /** An AI plays for this person until they come back. */
  takeover: boolean;
  /** The person switched on "Don't adapt to me": the AIs read no statistics about this seat (from the next match on). */
  noAdapt: boolean;
  /**
   * The person was not connected when this match started (from a lobby after a match, or a
   * rematch): the AI plays the seat from the deal and the match never counts them as abandoning
   * it. Cleared when they connect; from then on the usual grace and abandonment apply. Absent:
   * false (rooms stored before M15).
   */
  carried?: boolean;
}

/**
 * The current match: what the record in R2 is built from (shared/match-record.ts). moves[i]
 * belongs to log[i]: the person's decision time, whether the AI moved for them, and the AI's
 * estimated chance of winning.
 */
export interface StoredMatch extends RecordedMatch {
  config: MatchConfig;
  /** Already handed to the Durable Object for writing (each finished match is written once). */
  recorded: boolean;
  /**
   * Bit mask of seats whose public statistics the AIs must read as "no evidence": the people with
   * "Don't adapt to me" on when the match started. Fixed for the whole match; never in the record.
   */
  noStats?: number;
  /**
   * The model versions this match plays, fixed at its start (RoomDeps.pickAi): opponents on AI
   * seats that face people, partners on AI seats next to a person and for the AI that plays for
   * a person. seats[i].aiVersion says what played each AI seat.
   */
  ai: MatchAi;
}

export interface StoredRoom {
  v: 1;
  code: string;
  createdAt: number;
  lastActivity: number;
  settings: RoomSettings;
  owner: string;
  seats: StoredSeat[];
  status: 'lobby' | 'playing' | 'ended';
  matchNo: number;
  match: StoredMatch | null;
  /**
   * The person the game is waiting for, since when, and until when (null at: no limit). The clock
   * keeps running while the person is away. spent: decision time used before the person dropped
   * (time away is not decision time in the record). held: the clock is stopped for an ad between
   * solo hands (hold, CLIENT-SPEC 16.5): since when, the display offset that had not passed yet, and
   * the time that was left (null without a limit); at is null meanwhile.
   */
  deadline: { seat: number; since: number; at: number | null; spent?: number; held?: Held } | null;
  seq: number;
  lastWinner: number;
  /** The partners version of the last match (display only; the record keeps the versions per seat). */
  aiVersion: string;
  /** Last canned phrase per seat. */
  phraseAt: Record<string, number>;
  /** When the AI should go on with moves left over from a long chain (see MAX_AI_MOVES_PER_EVENT). */
  resumeAt: number | null;
  /** The owner closed the room from the lobby. */
  closed: boolean;
  /**
   * The brake's state (worker/src/brake.ts): the reservation of the match being played and what
   * the room spent since its last swap. Kept and changed by the Durable Object (room.ts) only, and
   * stored with the room, so counting costs no extra row. Absent in rooms stored before the brake.
   */
  brake?: RoomBrake;
}

/** A stopped clock (see StoredRoom.deadline). */
export interface Held {
  since: number;
  offsetLeft: number;
  left: number | null;
}

/** One decision, for the training data (M5 writes these as events without the person's identity). */
export interface DecisionRecord {
  matchNo: number;
  handIndex: number;
  seat: number;
  kind: 'human' | 'ai';
  persona: PersonaId | null;
  aiVersion: string;
  /** The move was made by the AI for a person (time out, away or abandoned). */
  auto: boolean;
  obs: Observation;
  action: number;
  /** Time the person took, in ms, from when the decision became theirs; null for AIs. */
  decisionMs: number | null;
  winProb?: number;
}

export interface RoomDeps {
  now(): number;
  /** A fresh 256-bit seed (64 hex chars) from a cryptographic generator. */
  randomSeed(): string;
  /**
   * The AI player for a seat. partnerHuman: the seat's partner is a person (limits signal lies).
   * version: the model version pinned for that seat in this match (StoredMatch.ai).
   */
  agentFor(seat: number, persona: PersonaId, partnerHuman: boolean, version: string): Agent;
  /**
   * The versions of a new match (worker/src/ai-select.ts pick), asked once at its start. Without
   * it every AI seat plays the room's aiVersion.
   */
  pickAi?(solo: boolean): MatchAi;
  /** Deterministic random numbers for the AI's sampling. */
  rand(): number;
  onDecision?(r: DecisionRecord): void;
  onAbandon?(device: string): void;
  /** A match started (also rematches) with these people seated. */
  onMatchStart?(devices: string[]): void;
  /** A new random match id (UUID v4); crypto.randomUUID() when absent. */
  newMatchId?(): string;
  /** Multiplies every waiting time (grace, abandonment, turn time). 1 in production; smaller in end-to-end tests. */
  timeScale?: number;
  /** Only for unit tests: a lower cap than MAX_AI_MOVES_PER_EVENT. */
  maxAiMovesPerEvent?: number;
}

export type OpResult = { ok: true } | { ok: false; code: ErrorCode };

/** What the server knows about the person sending a message (from their credential). */
export interface Sender {
  /** The person may start a new match: valid human check and matches left before the next check. */
  mayStartMatch: boolean;
}

const OK: OpResult = { ok: true };
const fail = (code: ErrorCode): OpResult => ({ ok: false, code });

/**
 * Settings for tests and for the Worker's defaults. The lineup follows the table size (one opponent
 * with two players), a missing partner is the first character not among the opponents, and the
 * random switches stay off unless asked for: API callers, sims and tests stay deterministic.
 */
export function defaultSettings(over: Partial<RoomSettings> = {}): RoomSettings {
  const opponents = over.opponents ?? (over.players === 2 ? ['zap'] : ['zap', 'lia']);
  return {
    mode: 'solo',
    players: 4,
    variant: 'paulista',
    options: {},
    turnSeconds: 30,
    ...over,
    opponents,
    partner: over.partner ?? firstFree(opponents),
    randomOpponents: over.randomOpponents ?? false,
    randomPartner: over.randomPartner ?? false,
  };
}

export function validateSettings(s: RoomSettings): string | null {
  if (s.mode !== 'solo' && s.mode !== 'room') return 'mode';
  if (s.players !== 2 && s.players !== 4) return 'players';
  try {
    makeConfig(s.variant, s.players, s.options);
  } catch {
    return 'options';
  }
  // One different character per AI seat of the other team, a partner who is not one of them, and
  // the random switches only where they mean something (quick play; the partner at 4 players).
  const lineup = lineupProblem(s);
  if (lineup) return lineup;
  if (![15, 30, 60, null].includes(s.turnSeconds)) return 'turnSeconds';
  if (s.turnSeconds === null && s.mode === 'solo') return 'turnSeconds';
  return null;
}

/** Only the known room options are kept; anything else in the request is dropped. */
export function cleanOptions(raw: unknown): Partial<RuleOptions> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of Object.keys(DEFAULT_OPTIONS)) {
    const v = (raw as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<RuleOptions>;
}

function emptySeat(): StoredSeat {
  return {
    kind: 'empty',
    device: null,
    name: '',
    persona: null,
    verified: false,
    verifiedUntil: 0,
    connected: false,
    awaySince: null,
    timeouts: 0,
    abandoned: false,
    takeover: false,
    noAdapt: false,
  };
}

export class RoomCore {
  readonly r: StoredRoom;
  private readonly deps: RoomDeps;
  private ms: MatchState | null = null;
  private agents = new Map<number, Agent>();
  /** Events produced by the last operation, with display offsets; the DO broadcasts and clears them. */
  pending: TimedEvent[] = [];
  /** Phrases produced by the last operation. */
  phrases: { seat: number; key: PhraseKey }[] = [];
  /**
   * Seats to notify after the last operation; null means everyone. A signal is sent only to the
   * seats that see it, so the others cannot tell from the timing that something happened.
   */
  notify: Set<number> | null = null;
  private offset = 0;
  private aiMoves = 0;
  /** Index in pending where the current operation's events start. */
  private opStart = 0;
  private readonly k: number;

  constructor(stored: StoredRoom, deps: RoomDeps) {
    this.k = deps.timeScale ?? 1;
    this.r = stored;
    this.deps = deps;
    if (this.k <= 0) throw new Error('timeScale must be positive');
    // Seats stored before the "Don't adapt to me" flag existed.
    for (const seat of stored.seats) seat.noAdapt ??= false;
    // Rooms stored before the random switches (M15) never draw. The settings are not validated
    // again on load, so an older room with a lineup the new rules refuse still loads and plays.
    stored.settings.randomOpponents ??= false;
    stored.settings.randomPartner ??= false;
    // Rooms with friends stored before the seat plan (M15) get one.
    upgradePlan(stored);
    if (stored.match) {
      upgradeMatch(stored);
      this.ms = replay(stored.match.config, stored.match.seed, stored.match.log);
    }
  }

  static create(
    code: string,
    settings: RoomSettings,
    owner: string,
    ownerVerified: boolean,
    aiVersion: string,
    deps: RoomDeps,
    ownerVerifiedUntil = Number.MAX_SAFE_INTEGER,
    ownerName = '',
    ownerNoAdapt = false,
  ): RoomCore {
    const err = validateSettings(settings);
    if (err) throw new Error(`bad settings: ${err}`);
    const now = deps.now();
    const seats = Array.from({ length: settings.players }, emptySeat);
    if (settings.mode === 'room') {
      // The plan of a new room: the lineup on the seats where today's start would put it when only
      // the owner sits (seat 0), and a free character as the owner's hidden fallback. The owner
      // moves people and changes characters in the lobby (move, plan).
      const o = settings.opponents;
      const plan = settings.players === 4 ? [firstFree([...o, settings.partner]), o[0], settings.partner, o[1]] : [firstFree(o), o[0]];
      seats.forEach((s, i) => (s.persona = plan[i]));
    }
    const r: StoredRoom = {
      v: 1,
      code,
      createdAt: now,
      lastActivity: now,
      // A copy: the room writes the drawn lineup and the switches into its own settings.
      settings: { ...settings, randomOpponents: settings.randomOpponents === true, randomPartner: settings.randomPartner === true },
      owner,
      seats,
      status: 'lobby',
      matchNo: 0,
      match: null,
      deadline: null,
      seq: 0,
      lastWinner: -1,
      aiVersion,
      phraseAt: {},
      resumeAt: null,
      closed: false,
    };
    const core = new RoomCore(r, deps);
    core.seatHuman(0, owner, ownerVerified, ownerVerifiedUntil, ownerName, ownerNoAdapt);
    // Quick play starts at once; the Worker already counted this match for the check.
    if (settings.mode === 'solo') core.start(owner, { mayStartMatch: true }, false);
    return core;
  }

  // ---------------------------------------------------------------------------------------------
  // Queries

  get match(): MatchState | null {
    return this.ms;
  }

  seatOf(device: string): number {
    return this.r.seats.findIndex((s) => s.kind === 'human' && s.device === device);
  }

  /** Every device with a seat here, also people away whose seat an AI keeps for them. */
  seatedDevices(): string[] {
    return this.r.seats.flatMap((s) => (s.kind === 'human' && s.device ? [s.device] : []));
  }

  expiresAt(): number {
    return this.r.closed ? this.r.lastActivity : this.r.lastActivity + ROOM_TTL_MS;
  }

  /**
   * When the Durable Object should wake up next. Only times when something will change count, so
   * a time already handled (a seat already taken over, abandonment while everyone is away) never
   * makes the alarm fire again and again.
   */
  nextAlarm(): number | null {
    const times: number[] = [this.expiresAt()];
    if (this.r.resumeAt !== null) times.push(this.r.resumeAt);
    if (this.r.status === 'playing') {
      const people = this.r.seats.filter((s) => s.kind === 'human');
      const everyoneAway = people.length > 0 && people.every((s) => !s.connected);
      const d = this.r.deadline;
      if (this.deadlineRuns(d)) times.push(d.at);
      for (const s of people) {
        if (s.connected || s.awaySince === null) continue;
        if (!s.takeover) times.push(s.awaySince + RECONNECT_GRACE_MS * this.k);
        // A person carried into this match is never marked as abandoning it: nothing to wake for.
        if (!s.abandoned && !s.carried && !everyoneAway) times.push(s.awaySince + ABANDON_AFTER_MS * this.k);
      }
    }
    return Math.min(...times);
  }

  /** Rooms with friends: the owner has no seat with an open connection (left, away, or forgotten). */
  ownerAway(): boolean {
    const i = this.seatOf(this.r.owner);
    return this.r.owner === '' || i < 0 || !this.r.seats[i].connected;
  }

  /**
   * After a match in a room, the friends wait for an owner the room counts as connected (D6). Only
   * then does the Durable Object check that the owner's connection is really alive (presence.ts).
   */
  waitsForOwner(): boolean {
    const r = this.r;
    return r.settings.mode === 'room' && !r.closed && r.matchNo > 0 && (r.status === 'ended' || r.status === 'lobby') && !this.ownerAway();
  }

  /**
   * Who may start the next match (start, rematch): the owner always; after a match, while the
   * owner is away, any seated person, so a room never gets stuck waiting for someone who left.
   * The first lobby stays the owner's. Quick play has only its one person.
   */
  private mayLead(device: string): boolean {
    if (this.r.settings.mode !== 'room' || this.isOwner(device)) return true;
    return this.r.matchNo > 0 && this.seatOf(device) >= 0 && this.ownerAway();
  }

  publicRoom(): PublicRoom {
    const ms = this.ms;
    const room = this.r.settings.mode === 'room';
    return {
      code: this.r.code,
      status: this.r.status,
      settings: this.r.settings,
      seats: this.r.seats.map((s, i): PublicSeat => ({
        seat: i,
        kind: s.kind,
        name: s.kind === 'ai' ? (PERSONAS.find((p) => p.id === s.persona)?.name ?? 'IA') : s.name,
        // A free seat of a room shows the AI that plays it if nobody sits there; a person's
        // fallback stays hidden.
        persona: s.kind === 'ai' || (room && s.kind === 'empty') ? s.persona : null,
        verified: s.kind === 'human' && s.verified && s.verifiedUntil > this.deps.now(),
        connected: s.kind === 'ai' || s.connected,
        aiPlaying: s.kind === 'human' && s.takeover,
      })),
      matchNo: this.r.matchNo,
      score: ms ? [ms.score[0], ms.score[1]] : [0, 0],
      games: ms ? [ms.games[0], ms.games[1]] : [0, 0],
      lastWinner: this.r.lastWinner,
      aiVersion: this.r.aiVersion,
      // To the hour: the exact time would follow every move and tell when something happened.
      expiresAt: Math.floor(this.expiresAt() / 3600_000) * 3600_000,
      setup: ROOM_SETUP,
      ...(room ? { ownerAway: this.ownerAway() } : {}),
    };
  }

  roomMessage(device: string | null): ServerMsg {
    const you = device ? this.seatOf(device) : -1;
    return { t: 'room', now: this.deps.now(), you: you >= 0 ? you : null, owner: device === this.r.owner, room: this.publicRoom() };
  }

  /** The game snapshot for one seat, with the last operation's events filtered for that seat. */
  gameMessage(seat: number, events: readonly TimedEvent[] = this.pending): ServerMsg | null {
    const ms = this.ms;
    // A lobby after a match keeps the finished match in memory (score, games), but sends no game:
    // after a move a person would get the last hand of the seat they were moved into.
    if (!ms || this.r.status === 'lobby' || seat < 0 || seat >= ms.n) return null;
    const filtered: TimedEvent[] = [];
    for (const te of events) {
      const [e] = eventsFor([te.e], seat, ms.config.options);
      if (e) filtered.push({ at: te.at, e });
    }
    const d = this.r.deadline;
    return {
      t: 'game',
      now: this.deps.now(),
      seq: this.r.seq,
      matchNo: this.r.matchNo,
      obs: observe(ms, seat),
      events: filtered,
      deadline: d ? { seat: d.seat, at: d.at } : null,
    };
  }

  clearPending(): void {
    this.pending = [];
    this.phrases = [];
    this.notify = null;
  }

  /** The match that just ended, if it was not handed out yet; marks it as handed out. */
  takeFinished(): StoredMatch | null {
    const m = this.r.match;
    if (!m || this.r.status !== 'ended' || m.endedAt === null || m.recorded) return null;
    m.recorded = true;
    return m;
  }

  /**
   * A person carried into this match by someone else's start had no matches left before their
   * next human check: they keep playing, without the "humano verificado" seal, in the room and in
   * the match record. Returns whether anything changed.
   */
  unverify(device: string, matchId: string | null): boolean {
    const seat = this.seatOf(device);
    const s = this.r.seats[seat];
    if (!s || !s.verified) return false;
    s.verified = false;
    const m = this.r.match;
    if (m && m.id === matchId && m.seats[seat]) m.seats[seat].verified = false;
    return true;
  }

  /** A reported nickname: the seat shows the default name ("Jogador N") from now on. */
  hideName(seat: number): boolean {
    const s = this.r.seats[seat];
    if (!s || s.kind !== 'human' || s.name === '') return false;
    s.name = '';
    return true;
  }

  /**
   * The versions of the running match after a wake, when one of them could not be loaded again
   * (AiRuntime.ensure answered a fallback): written into the match before any move, so the record
   * says what really played. Returns whether anything changed.
   */
  setMatchAi(ai: MatchAi): boolean {
    const m = this.r.match;
    if (!m || (m.ai.opponents === ai.opponents && m.ai.partners === ai.partners && m.ai.arm === ai.arm)) return false;
    m.ai = ai;
    for (const s of m.seats) s.aiVersion = s.kind === 'ai' ? seatVersion(ai, m.seats, s.seat) : null;
    if (this.r.status === 'playing') this.r.aiVersion = ai.partners;
    this.agents.clear();
    return true;
  }

  /** The version that plays a seat now: its pinned version for an AI seat, the partners version for the AI playing for a person. */
  private versionFor(seat: number): string {
    const m = this.r.match!;
    const s = this.r.seats[seat];
    return (s.kind === 'ai' ? m.seats[seat]?.aiVersion : null) ?? m.ai.partners;
  }

  // ---------------------------------------------------------------------------------------------
  // Seats and connections

  private seatHuman(seat: number, device: string, verified: boolean, verifiedUntil: number, name: string, noAdapt = false): void {
    const s = this.r.seats[seat];
    // The seat's plan stays with it, hidden while a person sits there.
    Object.assign(s, emptySeat(), { persona: s.persona });
    s.kind = 'human';
    s.device = device;
    s.noAdapt = noAdapt;
    // The nickname (already filtered by the Worker); without one, the client shows "Jogador N" /
    // "Player N" in each person's language.
    s.name = name;
    s.verified = verified;
    s.verifiedUntil = verifiedUntil;
    delete this.r.phraseAt[String(seat)];
  }

  /** Frees a seat for a friend; its planned character stays with it (P1 holds). */
  private vacate(seat: number): void {
    this.r.seats[seat] = { ...emptySeat(), persona: this.r.seats[seat].persona };
    delete this.r.phraseAt[String(seat)];
  }

  /**
   * A person arrives (by code or reconnecting). Taking a new seat needs a valid human check with
   * matches left; coming back to your own seat does not.
   */
  join(device: string, verified: boolean, verifiedUntil = Number.MAX_SAFE_INTEGER, mayTakeNewSeat = true, name = '', noAdapt = false): { seat: number } | { error: ErrorCode } {
    const existing = this.seatOf(device);
    if (existing >= 0) {
      const s = this.r.seats[existing];
      s.verified = verified;
      s.verifiedUntil = verifiedUntil;
      s.name = name;
      // Takes effect at the next match start (StoredMatch.noStats is fixed for a match).
      s.noAdapt = noAdapt;
      return { seat: existing };
    }
    const error = this.joinError(device, mayTakeNewSeat);
    if (error) return { error };
    const free = this.r.seats.findIndex((s) => s.kind === 'empty');
    this.seatHuman(free, device, verified, verifiedUntil, name, noAdapt);
    this.touch();
    this.r.seq++;
    return { seat: free };
  }

  /**
   * The person changed "Don't adapt to me" (on the site, in any tab or device). The seat keeps the
   * new value; the running match keeps its mask (StoredMatch.noStats is fixed for a match), so it
   * takes effect at the next match start, reconnection or not. Returns true when the seat changed.
   */
  setNoAdapt(device: string, on: boolean): boolean {
    const seat = this.seatOf(device);
    if (seat < 0 || this.r.seats[seat].noAdapt === on) return false;
    this.r.seats[seat].noAdapt = on;
    return true;
  }

  /** Why join() would refuse this person now, or null when it would seat them. Changes nothing. */
  joinError(device: string, mayTakeNewSeat: boolean): ErrorCode | null {
    if (this.seatOf(device) >= 0) return null;
    if (!mayTakeNewSeat) return 'check_needed';
    if (this.r.status !== 'lobby' || this.r.closed) return 'room_full';
    return this.r.seats.some((s) => s.kind === 'empty') ? null : 'room_full';
  }

  /** A person's first socket opened. Further sockets of the same person change nothing. */
  connect(device: string): boolean {
    const seat = this.seatOf(device);
    if (seat < 0) return false;
    const s = this.r.seats[seat];
    if (s.connected) return false;
    this.opStart = this.pending.length;
    // Quick play deals when the room is made, before the person's socket exists, and the AIs wait
    // for them. Their first connection, with nothing played yet, starts with that deal, so the page
    // shows the table before the deal, the deal itself and then the AI's opening cards.
    const ms = this.ms;
    const opening = ms !== null && this.r.status === 'playing' && s.awaySince === null && ms.handIndex === 0 && this.r.match !== null && this.r.match.log.length === 0;
    s.connected = true;
    s.awaySince = null;
    // The AI gives the seat back; an abandonment stays recorded. Someone carried into this match
    // is from now on like anyone else at the table: a later drop counts as usual.
    s.takeover = false;
    delete s.carried;
    // The clock never stopped (a person who drops and comes back cannot freeze it); only the
    // decision time starts again, since the time away is not decision time.
    const d = this.r.deadline;
    if (d && d.seat === seat) d.since = this.deps.now();
    this.touch();
    this.r.seq++;
    this.offset = 0;
    if (opening) this.pending.push({ at: 0, e: this.dealEvent() });
    this.advance();
    return true;
  }

  /** The last socket of a person closed (whatever close code the client sent). */
  disconnect(device: string): void {
    const seat = this.seatOf(device);
    if (seat < 0) return;
    const s = this.r.seats[seat];
    if (!s.connected) return;
    const now = this.deps.now();
    s.connected = false;
    s.awaySince = now;
    const d = this.r.deadline;
    // A held clock already counted the time spent before the hold.
    if (d && d.seat === seat && !d.held) d.spent = (d.spent ?? 0) + Math.max(0, now - d.since);
    // A friend who drops from the first lobby lets the seat go. After a match they keep it, as
    // during a match: a reload keeps the arranged place, and the owner can free it (plan) or
    // start with the AI playing it (carried).
    if (this.r.status === 'lobby' && this.r.settings.mode === 'room' && device !== this.r.owner && this.r.matchNo === 0) {
      this.vacate(seat);
    }
    this.r.seq++;
  }

  /**
   * A person deleted their data, or moved it to another browser: the room forgets their device.
   * In the lobby the seat empties, and the room closes if it was theirs. Once a match started, the
   * seat stays a person's seat for the record, with no device and no name, and an AI plays it. A
   * room left with no person closes. Returns false when the device has nothing here.
   */
  forget(device: string): boolean {
    const seat = this.seatOf(device);
    const owner = device === this.r.owner;
    if (seat < 0 && !owner) return false;
    this.notify = null;
    this.opStart = this.pending.length;
    if (this.r.status === 'lobby') {
      if (seat >= 0) this.vacate(seat);
      if (owner) this.r.closed = true;
    } else if (seat >= 0) {
      Object.assign(this.r.seats[seat], { device: null, name: '', verified: false, verifiedUntil: 0, connected: false, awaySince: null, takeover: true });
    }
    if (owner) this.r.owner = '';
    // A room with no person left in it closes at once: it has nothing more to keep.
    if (!this.r.seats.some((s) => s.kind === 'human' && s.device)) this.r.closed = true;
    this.touch();
    this.r.seq++;
    this.offset = 0;
    this.advance();
    return true;
  }

  /**
   * The person moved to a new device id (recovery on another browser): the seat and the ownership
   * follow them, and the old id is gone from the room. The old connections are closed by the
   * Durable Object, so the seat counts as away until the new browser connects.
   */
  rekey(from: string, to: string): boolean {
    if (from === to || (this.seatOf(from) < 0 && from !== this.r.owner)) return false;
    if (this.seatOf(to) >= 0) {
      // One seat per person: the new id already sits here, so it keeps the room and the old seat goes.
      if (from === this.r.owner) this.r.owner = to;
      this.forget(from);
      return true;
    }
    this.disconnect(from);
    const seat = this.seatOf(from);
    if (seat >= 0) this.r.seats[seat].device = to;
    if (from === this.r.owner) this.r.owner = to;
    this.r.seq++;
    return true;
  }

  // ---------------------------------------------------------------------------------------------
  // Client messages

  handle(device: string, msg: ClientMsg, sender: Sender = { mayStartMatch: true }): OpResult {
    this.notify = null;
    this.opStart = this.pending.length;
    switch (msg.t) {
      case 'sit':
        return this.sit(device, msg.seat);
      case 'start':
        return this.mayLead(device) ? this.start(device, sender, true) : fail('not_owner');
      case 'act':
        return this.act(device, msg.a, msg.seq, msg.auto === true);
      case 'phrase':
        return this.phrase(device, msg.key);
      case 'rematch':
        return this.rematch(device, sender, msg);
      case 'leave':
        return this.leave(device);
      case 'resume':
        return this.resume(device);
      case 'sync':
        return OK;
      case 'hold':
        return this.hold(device, msg.on);
      case 'lobby':
        return this.toLobby(device);
      case 'move':
        return this.move(device, msg.from, msg.to);
      case 'plan':
        return this.plan(device, msg.seat, msg.ai);
    }
  }

  /**
   * The pause between solo hands (an ad, CLIENT-SPEC 16.5) stops the person's clock. On: the time
   * left and the display offset that had not passed yet are kept, the time already spent counts as
   * decision time, and the deadline has no limit meanwhile. Off: the clock starts again where it
   * was. A second on, an off with nothing held, or a deadline for someone else change nothing. Only
   * in quick play, while a match runs, from a seated person.
   */
  private hold(device: string, on: boolean): OpResult {
    if (this.r.settings.mode !== 'solo' || this.r.status !== 'playing') return fail('bad_message');
    const seat = this.seatOf(device);
    if (seat < 0) return fail('not_seated');
    const d = this.r.deadline;
    if (!d || d.seat !== seat || Boolean(d.held) === on) return OK;
    const now = this.deps.now();
    if (on) {
      d.held = { since: now, offsetLeft: Math.max(0, d.since - now), left: d.at === null ? null : Math.max(0, d.at - Math.max(now, d.since)) };
      d.spent = (d.spent ?? 0) + Math.max(0, now - d.since);
      d.at = null;
    } else {
      this.release(d, now);
    }
    // The deadline changed: the person's page hears of it with the next game message.
    this.r.seq++;
    return OK;
  }

  /** Starts a held clock again; a hold longer than HOLD_FREE_MS adds the rest to the decision time. */
  private release(d: NonNullable<StoredRoom['deadline']>, now: number): void {
    const h = d.held;
    if (!h) return;
    d.spent = (d.spent ?? 0) + Math.max(0, now - h.since - HOLD_FREE_MS * this.k);
    d.since = now + h.offsetLeft;
    d.at = h.left === null ? null : d.since + h.left;
    delete d.held;
  }

  /**
   * Whether a start or rematch from this person would go ahead, apart from the human check. The
   * room asks first, so a refused message never takes a match from the person's allowance.
   */
  preStart(device: string, kind: 'start' | 'rematch'): OpResult {
    // The same order as handle(): start asks who leads first, rematch last.
    if (kind === 'start') {
      if (!this.mayLead(device)) return fail('not_owner');
      if (this.r.status !== 'lobby' || this.r.closed) return fail('not_in_lobby');
      if (this.seatOf(device) < 0) return fail('not_seated');
      if (this.needsPeople()) return fail('needs_people');
      return OK;
    }
    if (this.r.status !== 'ended') return fail('not_ended');
    if (this.seatOf(device) < 0) return fail('not_seated');
    if (!this.mayLead(device)) return fail('not_owner');
    if (this.needsPeople()) return fail('needs_people');
    return OK;
  }

  /**
   * No time limit only when every seat is a person. A seat whose person deleted their data during
   * the match (no device) would go to an AI at the next start, so it does not count as a person.
   */
  private needsPeople(): boolean {
    return this.r.settings.turnSeconds === null && this.r.seats.some((s) => !(s.kind === 'human' && s.device));
  }

  /** "Voltar a jogar": the person takes the seat back from the AI. */
  private resume(device: string): OpResult {
    const seat = this.seatOf(device);
    if (seat < 0) return fail('not_seated');
    const s = this.r.seats[seat];
    if (!s.takeover) return OK;
    s.takeover = false;
    s.timeouts = 0;
    this.touch();
    this.r.seq++;
    this.offset = 0;
    this.advance();
    return OK;
  }

  private sit(device: string, seat: number): OpResult {
    if (this.r.status !== 'lobby') return fail('not_in_lobby');
    if (seat < 0 || seat >= this.r.seats.length) return fail('bad_message');
    const from = this.seatOf(device);
    if (from < 0) return fail('not_seated');
    if (this.r.seats[seat].kind !== 'empty') return fail('seat_taken');
    // The person moves; each seat keeps its planned character.
    this.r.seats[seat] = { ...this.r.seats[from], persona: this.r.seats[seat].persona };
    this.vacate(from);
    this.touch();
    this.r.seq++;
    return OK;
  }

  /** Who may arrange the table now: the owner of a room with friends, in a lobby. */
  private arrangeError(device: string): ErrorCode | null {
    if (this.r.settings.mode !== 'room') return 'bad_message';
    if (!this.isOwner(device)) return 'not_owner';
    if (this.r.status !== 'lobby' || this.r.closed) return 'not_in_lobby';
    return null;
  }

  /** The owner's device; nobody once the owner's data is gone (owner ''). */
  private isOwner(device: string): boolean {
    return this.r.owner !== '' && device === this.r.owner;
  }

  /** "Mudar a mesa": the owner takes a room that just finished a match back to the lobby. */
  private toLobby(device: string): OpResult {
    if (this.r.settings.mode !== 'room') return fail('bad_message');
    if (!this.isOwner(device)) return fail('not_owner');
    if (this.r.status !== 'ended') return fail('not_ended');
    this.r.status = 'lobby';
    this.r.deadline = null;
    this.r.resumeAt = null;
    this.r.seats.forEach((s, i) => {
      if (s.kind !== 'human') return;
      if (!s.device) {
        // A seat whose person deleted their data during the match has nobody left: it is free again.
        this.vacate(i);
        return;
      }
      // Nobody plays in a lobby: someone away is away from the table, not played by the AI.
      // start() sets these again.
      s.takeover = false;
      s.timeouts = 0;
    });
    this.touch();
    this.r.seq++;
    return OK;
  }

  /**
   * The owner moves the person on `from` to `to`, swapping with whatever is there. People move
   * without the planned characters (each position keeps its own); an AI on `to` moves with its
   * character. The page only ever asks to move a person, so a `from` that no longer holds one means
   * the owner chose from an older view (a friend sat elsewhere meanwhile, or an earlier move of the
   * same batch changed the seat): seat_taken, and the page shows the room's values again.
   */
  private move(device: string, from: number, to: number): OpResult {
    const err = this.arrangeError(device);
    if (err) return fail(err);
    const n = this.r.seats.length;
    if (from === to || from < 0 || to < 0 || from >= n || to >= n) return fail('bad_message');
    const a = this.r.seats[from];
    const b = this.r.seats[to];
    if (a.kind !== 'human') return fail('seat_taken');
    if (b.kind === 'ai') {
      this.r.seats[from] = b;
      this.r.seats[to] = a;
    } else {
      this.r.seats[from] = { ...b, persona: a.persona };
      this.r.seats[to] = { ...a, persona: b.persona };
    }
    delete this.r.phraseAt[String(from)];
    delete this.r.phraseAt[String(to)];
    this.touch();
    this.r.seq++;
    return OK;
  }

  /**
   * The owner decides who sits in a seat without a connected person: an AI character, or nobody
   * yet (ai null: free for a friend, the seat keeps its character). A character already planned
   * on another seat swaps with this seat's, so every seat keeps a different one. Someone away
   * after a match can be taken out of their seat; a connected person or the owner cannot.
   */
  private plan(device: string, seat: number, ai: string | null): OpResult {
    const err = this.arrangeError(device);
    if (err) return fail(err);
    if (seat < 0 || seat >= this.r.seats.length) return fail('bad_message');
    if (ai !== null && !isPersonaId(ai)) return fail('bad_message');
    const s = this.r.seats[seat];
    if (s.kind === 'human' && (s.device === this.r.owner || s.connected)) return fail('seat_taken');
    if (ai === null ? s.kind === 'empty' : s.kind === 'ai' && s.persona === ai) return OK;
    if (s.kind === 'human') this.vacate(seat);
    if (ai === null) {
      this.r.seats[seat] = { ...emptySeat(), persona: this.r.seats[seat].persona };
    } else {
      const j = this.r.seats.findIndex((x, i) => i !== seat && x.persona === ai);
      if (j >= 0) this.r.seats[j].persona = this.r.seats[seat].persona;
      this.r.seats[seat] = { ...emptySeat(), kind: 'ai', persona: ai, name: personaName(ai), connected: true };
    }
    this.touch();
    this.r.seq++;
    return OK;
  }

  /** Fills empty seats with AIs and deals a new match. count: report it for the human-check budget. */
  start(device: string, sender: Sender, count: boolean): OpResult {
    if (this.r.status !== 'lobby' || this.r.closed) return fail('not_in_lobby');
    if (this.seatOf(device) < 0) return fail('not_seated');
    if (!sender.mayStartMatch) return fail('check_needed');
    const n = this.r.settings.players;
    if (this.needsPeople()) return fail('needs_people');
    // Nothing below fails, so a refused start never leaves a half drawn lineup or a reset seat.
    if (this.r.matchNo > 0) {
      // A new match after another (a rematch, or a start from the lobby after a match): people who
      // are away are played by the AI from the deal and never counted as abandoning it (carried).
      // Never at the first start: a quick play person is not connected yet when the room is made.
      for (const s of this.r.seats) {
        if (s.kind !== 'human') continue;
        s.timeouts = 0;
        s.abandoned = false;
        s.takeover = !s.connected;
        if (s.connected) delete s.carried;
        else s.carried = true;
      }
    }
    const set = this.r.settings;
    if (set.mode === 'solo' && (set.randomOpponents || set.randomPartner)) {
      // Quick play's switches: drawn with deps.rand, never with the generator of the A/B arm
      // (pickAi) or of the deal (randomSeed), so the lineup tells nothing about either. Written
      // into the settings, so the end screen, a reload and a rematch with the switch off all
      // read the lineup that played.
      const drawn = drawLineup(n, set.opponents, set.partner, { opponents: set.randomOpponents === true, partner: set.randomPartner === true }, this.deps.rand);
      set.opponents = drawn.opponents;
      set.partner = drawn.partner;
    }
    if (set.mode === 'solo') {
      // Quick play: the person sits at seat 0 with the partner across, the opponents in seat order.
      const lead = this.seatOf(this.r.owner);
      const ownerTeam = (lead >= 0 ? lead : this.seatOf(device)) & 1;
      let opp = 0;
      for (let i = 0; i < n; i++) {
        const s = this.r.seats[i];
        if (s.kind === 'human' && s.device) continue;
        const persona = (i & 1) === ownerTeam ? set.partner : set.opponents[opp++ % set.opponents.length];
        this.r.seats[i] = { ...emptySeat(), kind: 'ai', persona, name: personaName(persona), connected: true };
      }
    } else {
      // A room plays the plan: every seat without a person (free, reserved, or whose person's data
      // is gone) goes to its own character. The guard only matters for a room stored before the
      // plan whose AIs shared a character; under P1 it never changes anything.
      const used = new Set(this.r.seats.flatMap((s) => (s.kind === 'human' && s.device && s.persona ? [s.persona] : [])));
      for (let i = 0; i < n; i++) {
        const s = this.r.seats[i];
        if (s.kind === 'human' && s.device) continue;
        const persona = s.persona && !used.has(s.persona) ? s.persona : firstFree([...used, ...this.r.seats.map((x) => x.persona)]);
        used.add(persona);
        this.r.seats[i] = { ...emptySeat(), kind: 'ai', persona, name: personaName(persona), connected: true };
      }
    }
    const config = makeConfig(this.r.settings.variant, n, this.r.settings.options);
    const seed = this.deps.randomSeed();
    const now = this.deps.now();
    // The versions are fixed for the whole match: the candidate of a test only ever faces people.
    const ai = this.deps.pickAi?.(this.r.settings.mode === 'solo') ?? { opponents: this.r.aiVersion, partners: this.r.aiVersion, arm: null };
    this.ms = newMatch(config, seed);
    this.r.aiVersion = ai.partners;
    this.r.match = {
      id: this.deps.newMatchId?.() ?? crypto.randomUUID(),
      startedAt: now,
      endedAt: null,
      config: this.ms.config,
      seed,
      log: [],
      moves: [],
      seats: this.r.seats.map((s, i) => recordSeat(s, i, now, s.kind === 'human' ? null : seatVersion(ai, this.r.seats, i))),
      abandoned: [],
      recorded: false,
      noStats: this.r.seats.reduce((mask, s, i) => (s.kind === 'human' && s.noAdapt ? mask | (1 << i) : mask), 0),
      ai,
    };
    this.r.matchNo++;
    this.r.status = 'playing';
    this.agents.clear();
    this.offset = 0;
    this.pending.push({ at: 0, e: this.dealEvent() });
    this.r.resumeAt = null;
    this.touch();
    this.r.seq++;
    // Only the people at the table spend a match; a seat the AI keeps for someone away does not.
    if (count) this.deps.onMatchStart?.(this.r.seats.filter((s) => s.kind === 'human' && s.device && s.connected && !s.takeover).map((s) => s.device!));
    this.advance();
    return OK;
  }

  /** The deal of the hand being played, as the event that announced it. */
  private dealEvent(): GameEvent {
    const h = this.ms!.hand;
    return { t: 'deal', hand: h.index, dealer: h.dealer, mao: h.mao, vira: h.vira, kind: h.kind, onzeTeam: h.onzeTeam };
  }

  private act(device: string, action: number, seq: number, auto: boolean): OpResult {
    const ms = this.ms;
    if (!ms || this.r.status !== 'playing') return fail('not_in_lobby');
    const seat = this.seatOf(device);
    if (seat < 0) return fail('not_seated');
    if (seq !== this.r.seq) return fail('stale');
    if (!isLegal(ms, seat, action)) return fail(legalMask(ms, seat) === 0 ? 'not_your_turn' : 'illegal');
    const s = this.r.seats[seat];
    const now = this.deps.now();
    const d = this.r.deadline;
    // A move made while the clock was held starts it again first (the page ended its ad early).
    if (d && d.seat === seat && d.held) this.release(d, now);
    // In solo play the device sends its own automatic move when its time runs out; accept it as
    // automatic only if the time really ran out.
    const isAuto = auto && d !== null && d.seat === seat && d.at !== null && now + AUTO_SLACK_MS * this.k >= d.at;
    const tookBack = s.takeover;
    s.takeover = false;
    s.timeouts = isAuto ? s.timeouts + 1 : 0;
    if (s.timeouts >= MAX_TIMEOUTS) this.markAbandoned(seat);
    const decisionMs = d && d.seat === seat ? (d.spent ?? 0) + Math.max(0, now - d.since) : null;
    this.offset = 0;
    this.apply(seat, action, isAuto ? 'auto' : 'human', decisionMs);
    if (action >= A_SIGNAL0 && !tookBack) {
      // A signal changes nobody else's moves and keeps everyone's clock and the room's expiry;
      // only the seats that see it hear of it.
      const rec = ms.hand.signals[ms.hand.signals.length - 1];
      this.notify = new Set([...Array(ms.n).keys()].filter((i) => (rec.seenBy >> i) & 1));
      return OK;
    }
    // A move, or a signal from a person taking the seat back from the AI: the game goes on and
    // everyone hears of it (the seat no longer shows an AI playing).
    if (action < A_SIGNAL0) this.touch();
    this.r.seq++;
    this.advance();
    return OK;
  }

  private phrase(device: string, key: PhraseKey): OpResult {
    const seat = this.seatOf(device);
    if (seat < 0) return fail('not_seated');
    const now = this.deps.now();
    const last = this.r.phraseAt[String(seat)];
    if (last !== undefined && now - last < PHRASE_INTERVAL_MS) return fail('too_fast');
    this.r.phraseAt[String(seat)] = now;
    this.phrases.push({ seat, key });
    return OK;
  }

  private rematch(device: string, sender: Sender, msg: Extract<ClientMsg, { t: 'rematch' }>): OpResult {
    if (this.r.status !== 'ended') return fail('not_ended');
    if (this.seatOf(device) < 0) return fail('not_seated');
    // In a room only the owner leads while connected; anyone seated once the owner is away.
    if (!this.mayLead(device)) return fail('not_owner');
    if (!sender.mayStartMatch) return fail('check_needed');
    // Quick play: the switches of the end screen hold from this match on; a field left out keeps
    // the room's value (old pages send none). Rooms have no switches and ignore them.
    const set = this.r.settings;
    const flags = { randomOpponents: set.randomOpponents, randomPartner: set.randomPartner };
    if (set.mode === 'solo') {
      if (msg.randomOpponents !== undefined) set.randomOpponents = msg.randomOpponents;
      if (msg.randomPartner !== undefined) set.randomPartner = msg.randomPartner && set.players === 4;
    }
    // Everyone keeps their seat; start() gives the seats of people who are away to the AI.
    this.r.status = 'lobby';
    const res = this.start(device, sender, true);
    if (!res.ok) {
      this.r.status = 'ended';
      Object.assign(set, flags);
    }
    return res;
  }

  private leave(device: string): OpResult {
    const seat = this.seatOf(device);
    if (seat < 0) return fail('not_seated');
    if (this.r.status === 'lobby') {
      if (device === this.r.owner) {
        // The owner closes the room: everyone is sent home and the room is deleted soon.
        this.r.closed = true;
        this.touch();
        this.r.seq++;
        return OK;
      }
      this.vacate(seat);
    } else if (this.r.status === 'playing') {
      this.markAbandoned(seat);
      this.r.seats[seat].takeover = true;
      this.advance();
    }
    this.touch();
    this.r.seq++;
    return OK;
  }

  // ---------------------------------------------------------------------------------------------
  // Time

  /** Called by the Durable Object alarm. Returns 'expired' when the room should be deleted. */
  alarm(): 'expired' | 'ok' {
    const now = this.deps.now();
    if (now >= this.expiresAt()) return 'expired';
    this.notify = null;
    this.opStart = this.pending.length;
    let changed = false;
    if (this.r.resumeAt !== null && now >= this.r.resumeAt) {
      this.r.resumeAt = null;
      changed = true;
    }
    // When every person dropped at once (an outage or an update), nobody is marked as abandoning.
    const people = this.r.seats.filter((s) => s.kind === 'human');
    const everyoneAway = people.length > 0 && people.every((s) => !s.connected);
    for (let i = 0; i < this.r.seats.length; i++) {
      const s = this.r.seats[i];
      if (s.kind !== 'human' || s.connected || s.awaySince === null || this.r.status !== 'playing') continue;
      if (!s.takeover && now >= s.awaySince + RECONNECT_GRACE_MS * this.k) {
        s.takeover = true;
        changed = true;
      }
      if (!s.abandoned && !s.carried && !everyoneAway && now >= s.awaySince + ABANDON_AFTER_MS * this.k) {
        this.markAbandoned(i);
        changed = true;
      }
    }
    const d = this.r.deadline;
    if (this.ms && this.deadlineRuns(d) && now >= d.at) {
      // Time ran out: the AI plays this move for the person; it stays out of the human data.
      const s = this.r.seats[d.seat];
      s.timeouts++;
      if (s.timeouts >= MAX_TIMEOUTS) {
        this.markAbandoned(d.seat);
        s.takeover = true;
      }
      this.offset = 0;
      this.aiMoves = 0;
      this.aiMove(d.seat, 'auto', true);
      changed = true;
    }
    if (changed) {
      this.r.seq++;
      this.offset = 0;
      this.advance();
    }
    return 'ok';
  }

  private markAbandoned(seat: number): void {
    const s = this.r.seats[seat];
    if (s.abandoned) return;
    s.abandoned = true;
    const m = this.r.match;
    if (m && this.r.status === 'playing' && !m.abandoned.includes(seat)) m.abandoned.push(seat);
    if (s.device) this.deps.onAbandon?.(s.device);
  }

  private touch(): void {
    this.r.lastActivity = this.deps.now();
  }

  /**
   * The server plays for the person when this deadline passes: only in rooms with friends (in
   * quick play the device sends its own automatic move), whether or not the person is connected,
   * and not while an AI already plays the seat. nextAlarm() and alarm() use this same test, so a
   * deadline the alarm will not act on never schedules one.
   */
  private deadlineRuns(d: StoredRoom['deadline']): d is { seat: number; since: number; at: number; spent?: number } {
    return d !== null && d.at !== null && this.r.status === 'playing' && this.r.settings.mode === 'room' && !this.r.seats[d.seat].takeover;
  }

  // ---------------------------------------------------------------------------------------------
  // Playing

  private isAiSeat(seat: number): boolean {
    const s = this.r.seats[seat];
    return s.kind === 'ai' || (s.kind === 'human' && s.takeover);
  }

  private isActiveHuman(seat: number): boolean {
    const s = this.r.seats[seat];
    return s.kind === 'human' && !s.takeover;
  }

  /**
   * Who the game waits for. When a bet or a mão de onze waits for a team that has a person, the
   * person answers (the AI partner does not answer for them).
   */
  decider(): number {
    const ms = this.ms!;
    const h = ms.hand;
    const n = ms.n;
    if (h.phase === 'raise' || h.phase === 'onze') {
      const team = h.phase === 'raise' ? 1 - (h.raiser & 1) : h.onzeTeam;
      const start = expectedActor(ms);
      for (let k = 0; k < n; k++) {
        const seat = (start + k) % n;
        if ((seat & 1) === team && this.isActiveHuman(seat) && legalMask(ms, seat) !== 0) return seat;
      }
    }
    return expectedActor(ms);
  }

  /** Plays AI moves until a person must act or the match ends, then sets the deadline. */
  private advance(): void {
    // A chain left for later goes on from here; it is set again below if it stops at the cap.
    this.r.resumeAt = null;
    const ms = this.ms;
    if (!ms || this.r.status !== 'playing') {
      this.r.deadline = null;
      return;
    }
    // Without a person at the table the AIs wait: they never play a whole match on their own.
    const someone = this.r.seats.some((s) => s.kind === 'human' && s.connected && !s.takeover);
    if (!someone) {
      this.r.deadline = null;
      return;
    }
    this.aiMoves = 0;
    while (!ms.over) {
      const seat = this.decider();
      if (!this.isAiSeat(seat)) break;
      if (this.aiMoves >= (this.deps.maxAiMovesPerEvent ?? MAX_AI_MOVES_PER_EVENT)) {
        // Go on later, on the alarm, so one event never runs long.
        this.r.resumeAt = this.deps.now() + this.offset;
        this.r.deadline = null;
        return;
      }
      this.aiMove(seat, this.r.seats[seat].kind === 'human' ? 'auto' : 'ai', false);
    }
    if (ms.over) {
      this.r.status = 'ended';
      this.r.match!.endedAt = this.deps.now();
      this.r.lastWinner = ms.winner;
      this.r.deadline = null;
      return;
    }
    const seat = this.decider();
    const now = this.deps.now();
    const since = now + this.offset;
    const t = this.r.settings.turnSeconds;
    const prev = this.r.deadline;
    // Nothing moved for this person (someone else reconnecting, a signal): keep their clock.
    const onlySignals = this.pending.slice(this.opStart).every((te) => te.e.t === 'signal');
    if (prev && prev.seat === seat && prev.since <= now && onlySignals) return;
    this.r.deadline = { seat, since, at: t === null ? null : since + t * 1000 * this.k };
  }

  /**
   * One AI move. A signal takes no time on the shared timeline, so the people who did not see it
   * cannot notice a pause. noSignal: on a time out the AI plays a real move, never only a signal.
   */
  private aiMove(seat: number, kind: 'ai' | 'auto', noSignal: boolean): void {
    const ms = this.ms!;
    const s = this.r.seats[seat];
    const persona: PersonaId = s.kind === 'ai' && s.persona ? s.persona : 'zap';
    let agent = this.agents.get(seat);
    if (!agent || kind === 'auto') {
      const partner = ms.n === 4 ? this.r.seats[(seat + 2) % 4] : null;
      agent = this.deps.agentFor(seat, persona, partner !== null && partner.kind === 'human' && !partner.takeover, this.versionFor(seat));
      if (kind === 'ai') this.agents.set(seat, agent);
    }
    const obs = observe(ms, seat);
    if (noSignal && (obs.legal & ~SIGNAL_MASK) !== 0) obs.legal &= ~SIGNAL_MASK;
    // Public facts of this match only; the seats of people who opted out read as no evidence.
    const ctx = agentContext(ms, this.r.match!.noStats ?? 0);
    let d = agent.act(obs, this.deps.rand, ctx);
    if (!legalIn(obs.legal, d.action)) {
      // Fails closed: a model or knobs that give no legal move (a bad manifest entry) never stop the
      // match. The base heuristic moves instead, else the first legal real move.
      const h = FALLBACK_AGENT.act(obs, this.deps.rand, ctx);
      d = legalIn(obs.legal, h.action) ? { action: h.action } : { action: firstLegal(obs.legal) };
    }
    // Only real moves count toward the cap: hidden signals must not change when the chain pauses.
    if (d.action < A_SIGNAL0) {
      this.offset += AI_DELAY_MS;
      this.aiMoves++;
    }
    this.applyWithObs(seat, d.action, kind, null, obs, d.winProb);
  }

  private apply(seat: number, action: number, kind: 'human' | 'ai' | 'auto', decisionMs: number | null): void {
    this.applyWithObs(seat, action, kind, decisionMs, observe(this.ms!, seat));
  }

  private applyWithObs(seat: number, action: number, kind: 'human' | 'ai' | 'auto', decisionMs: number | null, obs: Observation, winProb?: number): void {
    const ms = this.ms!;
    const handBefore = ms.handIndex;
    const events: GameEvent[] = [];
    applyAction(ms, seat, action, events);
    const m = this.r.match!;
    m.log.push(seat * 16 + action);
    m.moves.push(moveInfo(kind, decisionMs, winProb));
    const s = this.r.seats[seat];
    this.deps.onDecision?.({
      matchNo: this.r.matchNo,
      handIndex: handBefore,
      seat,
      kind: s.kind === 'ai' ? 'ai' : 'human',
      persona: s.kind === 'ai' ? s.persona : null,
      aiVersion: kind === 'human' ? this.r.aiVersion : this.versionFor(seat),
      auto: kind === 'auto',
      obs,
      action,
      decisionMs: kind === 'human' ? decisionMs : null,
      winProb,
    });
    for (const e of events) {
      if (e.t === 'deal' && e.hand !== handBefore) this.offset += HAND_END_DELAY_MS;
      this.pending.push({ at: this.offset, e });
    }
  }
}

/** The AI that moves when a seat's agent answers an action that is not legal. */
const FALLBACK_AGENT = new HeuristicAgent(undefined, 'heuristic:fallback');

/** The name an AI seat shows. */
function personaName(id: PersonaId): string {
  return PERSONAS.find((p) => p.id === id)?.name ?? 'IA';
}

/**
 * A room with friends stored before the seat plan (M15) gets one on load. AI seats keep their
 * characters (a running or finished match never changes); free seats, in seat order, get what the
 * old start() would have given them (the owner's team the partner, the other team the opponents in
 * order, cycling), or the first free character when that one is already placed; people get the
 * first free character as their hidden fallback. Every seat then differs (P1), except two AI seats
 * that older code gave the same character: they keep it until the next start, whose guard fixes it.
 */
function upgradePlan(r: StoredRoom): void {
  const seats = r.seats;
  if (r.settings.mode !== 'room' || seats.every((s) => s.persona !== null)) return;
  const set = r.settings;
  const lead = r.owner === '' ? -1 : seats.findIndex((s) => s.kind === 'human' && s.device === r.owner);
  const ownerTeam = (lead >= 0 ? lead : 0) & 1;
  const placed = () => seats.map((s) => s.persona);
  let opp = 0;
  seats.forEach((s, i) => {
    // The old start() gave a character to every seat without a person's device, in seat order.
    if (s.kind === 'human' && s.device) return;
    const old: PersonaId | undefined = (i & 1) === ownerTeam ? set.partner : set.opponents[opp++ % Math.max(1, set.opponents.length)];
    if (s.kind !== 'empty' || s.persona !== null) return;
    s.persona = old && !placed().includes(old) ? old : firstFree(placed());
  });
  for (const s of seats) if (s.kind === 'human' && s.persona === null) s.persona = firstFree(placed());
}

/** Whether action is one of the legal actions of the mask. */
function legalIn(legal: number, action: number): boolean {
  return Number.isInteger(action) && action >= 0 && action < 31 && ((legal >>> action) & 1) === 1;
}

/** The lowest legal action that is not a signal, else the lowest legal action. */
function firstLegal(legal: number): number {
  const real = legal & ~SIGNAL_MASK;
  const mask = real !== 0 ? real : legal;
  for (let a = 0; a < 31; a++) if ((mask >>> a) & 1) return a;
  return 0;
}

/** The move entry of the match record: decision time only for a person's own move. */
function moveInfo(kind: 'human' | 'ai' | 'auto', decisionMs: number | null, winProb: number | undefined): MoveInfo {
  return {
    ms: kind === 'human' && decisionMs !== null ? Math.round(decisionMs) : null,
    auto: kind === 'auto',
    winProb: kind !== 'human' && typeof winProb === 'number' && Number.isFinite(winProb) ? Math.round(Math.min(1, Math.max(0, winProb)) * 1e4) / 1e4 : null,
  };
}

/** A seat as the match record keeps it: no device, no name. */
function recordSeat(s: StoredSeat, i: number, now: number, aiVersion: string | null): RecordSeat {
  const human = s.kind === 'human';
  return { seat: i, kind: human ? 'human' : 'ai', verified: human && s.verified && s.verifiedUntil > now, persona: human ? null : s.persona, aiVersion: human ? null : aiVersion };
}

/** A match stored before the record fields existed (M4) gets them, so it can still be played and written. */
function upgradeMatch(r: StoredRoom): void {
  const m = r.match as Partial<StoredMatch> & { auto?: number[]; log: number[] };
  if (!Array.isArray(m.moves)) {
    const auto = new Set(m.auto ?? []);
    m.moves = m.log.map((_, i) => ({ ms: null, auto: auto.has(i), winProb: null }));
  }
  delete m.auto;
  m.id ??= crypto.randomUUID();
  m.startedAt ??= r.createdAt;
  m.endedAt ??= r.status === 'ended' ? r.lastActivity : null;
  m.seats ??= r.seats.map((s, i) => recordSeat(s, i, 0, r.aiVersion));
  m.abandoned ??= [];
  m.recorded ??= false;
  // Before milestone 6 one version played every AI seat.
  m.ai ??= { opponents: r.aiVersion, partners: r.aiVersion, arm: null };
  for (const s of m.seats) if (s.aiVersion === undefined) s.aiVersion = s.kind === 'ai' ? r.aiVersion : null;
}
