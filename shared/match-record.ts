// The record of one finished match, as the room writes it to R2 (bucket zap-events) at
// matches/v1/YYYY/MM/DD/<matchId>.json (the "v1" there is the key layout). Schema "zap-match/2"
// since milestone 6; records written before it are "zap-match/1" and stay valid. normalizeRecord()
// gives a "zap-match/2" view of either.
//
// "zap-match/2" adds which model version played each AI seat: aiVersion is the version on the AI
// seats that face people, partnerVersion the version of an AI whose partner is a person (and of
// the AI that plays for a person). They differ only during a test of a new version (the candidate
// never sits next to a person); arm says which group a quick play match was in, and test marks
// records of a local test site (Worker var TEST_RECORDS).
//
// The engine is deterministic, so the record keeps only the configuration, the seed and the
// action log; every per-decision view (what a seat saw, its legal moves, the score) is rebuilt by
// replaying the log with the engine. The record never holds anything that points to a person:
// no device id, pseudonym, nickname, IP, cookie or room code. Seats are numbers; the link between
// a seat and a person lives only in D1 (match_seats) and goes away when the person deletes it.

import { DEFAULT_OPTIONS, validateConfig, type MatchConfig } from '../engine/src/config.ts';
import { NUM_ACTIONS, replay, type MatchState } from '../engine/src/engine.ts';
import { PERSONAS, type PersonaId } from '../ai/src/personas.ts';
import type { RoomSettings, TurnSeconds } from './protocol.ts';
import type { MatchAi } from './cycle-formats.ts';

export const MATCH_RECORD_SCHEMA = 'zap-match/2';
/** Records written before milestone 6. */
export const MATCH_RECORD_SCHEMA_V1 = 'zap-match/1';
/** Version of the rules engine that replays the log. */
export const MATCH_RECORD_ENGINE = 1;

/**
 * solo2 and solo1: quick play (2 against 2, 1 against 1); friends: a room where two people are
 * partners and AIs fill the rest; humans: every seat a person; mixed: other rooms with people.
 */
export type MatchKind = 'solo2' | 'solo1' | 'friends' | 'humans' | 'mixed';
export const MATCH_KINDS: readonly MatchKind[] = ['solo2', 'solo1', 'friends', 'humans', 'mixed'];

/** One entry per action in the log, in the same order. */
export interface MoveInfo {
  /** Time the person took, in ms, without pauses for reconnection; null for AIs and automatic moves. */
  ms: number | null;
  /** The AI moved for a person (time out, away or abandoned), or the device sent its own automatic move. */
  auto: boolean;
  /** The AI's estimated chance that its team wins the match; null for people. */
  winProb: number | null;
}

export interface RecordSeatV1 {
  seat: number;
  kind: 'human' | 'ai';
  /** A person who passed the human check within its 2 hours and 10 matches and is not flagged, at the start. */
  verified: boolean;
  persona: PersonaId | null;
}

export interface RecordSeat extends RecordSeatV1 {
  /** The model version that played this AI seat; null for a person's seat. */
  aiVersion: string | null;
}

export interface MatchResult {
  winner: 0 | 1;
  score: [number, number];
  games: [number, number];
}

export interface MatchRecord {
  schema: typeof MATCH_RECORD_SCHEMA;
  engine: typeof MATCH_RECORD_ENGINE;
  matchId: string;
  startedAt: number;
  endedAt: number;
  kind: MatchKind;
  turnSeconds: TurnSeconds;
  /** The version on AI seats that face people (and on every AI seat outside a test). */
  aiVersion: string;
  /** The version on AI seats whose partner was a person at the start, and of the AI that plays for a person. */
  partnerVersion: string;
  /** Quick play during a test: the person's group. Null otherwise. */
  arm: 'candidate' | 'control' | null;
  /** Written by a local test site (TEST_RECORDS), never by production. */
  test: boolean;
  config: MatchConfig;
  seed: string;
  log: number[];
  moves: MoveInfo[];
  seats: RecordSeat[];
  abandoned: number[];
  result: MatchResult;
}

/** A record written before milestone 6. */
export interface MatchRecordV1 {
  schema: typeof MATCH_RECORD_SCHEMA_V1;
  engine: typeof MATCH_RECORD_ENGINE;
  matchId: string;
  startedAt: number;
  endedAt: number;
  kind: MatchKind;
  turnSeconds: TurnSeconds;
  aiVersion: string;
  config: MatchConfig;
  seed: string;
  log: number[];
  moves: MoveInfo[];
  seats: RecordSeatV1[];
  abandoned: number[];
  result: MatchResult;
}

export type AnyMatchRecord = MatchRecord | MatchRecordV1;

/** What a room keeps about its current match (worker/src/room-core.ts stores a superset). */
export interface RecordedMatch {
  /** Random UUID, unrelated to the room code. */
  id: string;
  startedAt: number;
  endedAt: number | null;
  config: MatchConfig;
  seed: string;
  log: number[];
  moves: MoveInfo[];
  seats: RecordSeat[];
  abandoned: number[];
  /** The versions this match plays, fixed at its start (absent in matches stored before milestone 6). */
  ai?: MatchAi;
}

/** The part of a room's state that the record is built from. */
export interface MatchRecordSource {
  settings: Pick<RoomSettings, 'mode' | 'players' | 'turnSeconds'>;
  aiVersion: string;
  match: RecordedMatch | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEED = /^[0-9a-f]{64}$/;
/** A version label: "v1", "v2"..., "heuristic", or an older label. */
export const AI_VERSION = /^[A-Za-z0-9._:-]{1,40}$/;
const PERSONA_IDS = PERSONAS.map((p) => p.id) as readonly string[];
/** A decision longer than a day is not a decision (rooms expire after 24 h without activity). */
const MAX_MS = 24 * 3600_000;
/** 1 January 2026, before the first match. */
const EARLIEST = Date.UTC(2026, 0, 1);

export function isMatchId(s: unknown): s is string {
  return typeof s === 'string' && UUID.test(s);
}

/** The kind of match, from the room mode and who sat where at the start. */
export function matchKind(mode: RoomSettings['mode'], seats: readonly Pick<RecordSeat, 'seat' | 'kind'>[]): MatchKind {
  const humans = seats.filter((s) => s.kind === 'human');
  if (mode === 'solo') return seats.length === 2 ? 'solo1' : 'solo2';
  if (humans.length === seats.length) return 'humans';
  if (seats.length === 4 && humans.length === 2 && (humans[0].seat & 1) === (humans[1].seat & 1)) return 'friends';
  return 'mixed';
}

/** R2 key of a record: by the UTC date of the end, then the match id. */
export function matchRecordKey(rec: Pick<MatchRecord, 'matchId' | 'endedAt'>): string {
  const d = new Date(rec.endedAt);
  const p = (n: number) => String(n).padStart(2, '0');
  return `matches/v1/${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${rec.matchId}.json`;
}

/**
 * The version an AI seat plays under a match's versions: the partners version when the table has
 * four seats and the seat's partner is a person at the start, the opponents version otherwise.
 */
export function seatVersion(ai: MatchAi, seats: readonly { kind: string }[], seat: number): string {
  return seats.length === 4 && seats[seat ^ 2]?.kind === 'human' ? ai.partners : ai.opponents;
}

/**
 * Builds the record of the room's match, which must be over. Pure: it reads the state and
 * returns fresh objects. final: the finished match state, when the caller has it (saves a replay).
 * test: the record comes from a local test site (TEST_RECORDS).
 */
export function buildMatchRecord(src: MatchRecordSource, final?: MatchState, opts: { test?: boolean } = {}): MatchRecord {
  const m = src.match;
  if (!m) throw new Error('no match');
  if (m.endedAt === null) throw new Error('match not over');
  const ms = final ?? replay(m.config, m.seed, m.log);
  if (!ms.over || (ms.winner !== 0 && ms.winner !== 1)) throw new Error('match not over');
  if (m.moves.length !== m.log.length) throw new Error('moves and log differ in length');
  const ai: MatchAi = m.ai ?? { opponents: src.aiVersion, partners: src.aiVersion, arm: null };
  const kind = matchKind(src.settings.mode, m.seats);
  return {
    schema: MATCH_RECORD_SCHEMA,
    engine: MATCH_RECORD_ENGINE,
    matchId: m.id,
    startedAt: m.startedAt,
    endedAt: m.endedAt,
    kind,
    turnSeconds: src.settings.turnSeconds,
    aiVersion: ai.opponents,
    partnerVersion: ai.partners,
    arm: kind === 'solo1' || kind === 'solo2' ? ai.arm : null,
    test: opts.test === true,
    config: { variant: m.config.variant, players: m.config.players, options: { ...m.config.options } },
    seed: m.seed,
    log: [...m.log],
    moves: m.moves.map((x) => ({ ms: x.ms, auto: x.auto, winProb: x.winProb })),
    seats: m.seats.map((s) => ({
      seat: s.seat,
      kind: s.kind,
      verified: s.verified,
      persona: s.persona,
      aiVersion: s.kind === 'ai' ? (s.aiVersion ?? seatVersion(ai, m.seats, s.seat)) : null,
    })),
    abandoned: [...m.abandoned].sort((a, b) => a - b),
    result: { winner: ms.winner as 0 | 1, score: [ms.score[0], ms.score[1]], games: [ms.games[0], ms.games[1]] },
  };
}

/**
 * A "zap-match/2" view of any valid record: a "zap-match/1" record had one version for every AI
 * seat, no test mark and no groups.
 */
export function normalizeRecord(r: AnyMatchRecord): MatchRecord {
  if (r.schema === MATCH_RECORD_SCHEMA) return r;
  return {
    schema: MATCH_RECORD_SCHEMA,
    engine: r.engine,
    matchId: r.matchId,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    kind: r.kind,
    turnSeconds: r.turnSeconds,
    aiVersion: r.aiVersion,
    partnerVersion: r.aiVersion,
    arm: null,
    test: false,
    config: r.config,
    seed: r.seed,
    log: r.log,
    moves: r.moves,
    seats: r.seats.map((s) => ({ ...s, aiVersion: s.kind === 'ai' ? r.aiVersion : null })),
    abandoned: r.abandoned,
    result: r.result,
  };
}

export type ValidationResult = { ok: true; record: AnyMatchRecord } | { ok: false; errors: string[] };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isInt = (x: unknown, lo: number, hi: number): x is number => Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi;

function exactKeys(o: Record<string, unknown>, keys: readonly string[], where: string, errors: string[]): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) errors.push(`${where}: unexpected field ${k}`);
  for (const k of keys) if (!(k in o)) errors.push(`${where}: missing field ${k}`);
}

const TOP_KEYS_V1 = ['schema', 'engine', 'matchId', 'startedAt', 'endedAt', 'kind', 'turnSeconds', 'aiVersion', 'config', 'seed', 'log', 'moves', 'seats', 'abandoned', 'result'] as const;
const TOP_KEYS = [
  'schema',
  'engine',
  'matchId',
  'startedAt',
  'endedAt',
  'kind',
  'turnSeconds',
  'aiVersion',
  'partnerVersion',
  'arm',
  'test',
  'config',
  'seed',
  'log',
  'moves',
  'seats',
  'abandoned',
  'result',
] as const;
const SEAT_KEYS_V1 = ['seat', 'kind', 'verified', 'persona'] as const;
const SEAT_KEYS = [...SEAT_KEYS_V1, 'aiVersion'] as const;

/**
 * Checks a record, "zap-match/1" or "zap-match/2": exact structure (no field outside the schema,
 * so nothing extra can slip in), consistent seats, versions, moves and kind, and a replay of the
 * log with the engine that must reach the stated result.
 */
export function validateMatchRecord(json: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObj(json)) return { ok: false, errors: ['not an object'] };
  const r = json;
  const v2 = r.schema === MATCH_RECORD_SCHEMA;
  if (!v2 && r.schema !== MATCH_RECORD_SCHEMA_V1) return { ok: false, errors: ['schema'] };
  exactKeys(r, v2 ? TOP_KEYS : TOP_KEYS_V1, 'record', errors);
  if (errors.length) return { ok: false, errors };

  if (r.engine !== MATCH_RECORD_ENGINE) errors.push('engine');
  if (!isMatchId(r.matchId)) errors.push('matchId');
  if (!isInt(r.startedAt, EARLIEST, 8.64e15)) errors.push('startedAt');
  if (!isInt(r.endedAt, EARLIEST, 8.64e15) || (typeof r.startedAt === 'number' && (r.endedAt as number) < r.startedAt)) errors.push('endedAt');
  if (!MATCH_KINDS.includes(r.kind as MatchKind)) errors.push('kind');
  if (![15, 30, 60, null].includes(r.turnSeconds as TurnSeconds)) errors.push('turnSeconds');
  if (typeof r.aiVersion !== 'string' || !AI_VERSION.test(r.aiVersion)) errors.push('aiVersion');
  if (v2) {
    if (typeof r.partnerVersion !== 'string' || !AI_VERSION.test(r.partnerVersion)) errors.push('partnerVersion');
    if (r.arm !== null && r.arm !== 'candidate' && r.arm !== 'control') errors.push('arm');
    if (typeof r.test !== 'boolean') errors.push('test');
    if (r.arm !== null && r.kind !== 'solo1' && r.kind !== 'solo2') errors.push('arm: only quick play has a group');
    if (r.arm === 'control' && r.partnerVersion !== r.aiVersion) errors.push('arm: the control group plays one version');
    if (r.arm === 'candidate' && r.partnerVersion === r.aiVersion) errors.push('arm: the candidate group plays two versions');
  }
  if (typeof r.seed !== 'string' || !SEED.test(r.seed)) errors.push('seed');

  // Configuration: the engine's own check, with exactly the known options.
  let config: MatchConfig | null = null;
  if (!isObj(r.config)) errors.push('config');
  else {
    const before = errors.length;
    exactKeys(r.config, ['variant', 'players', 'options'], 'config', errors);
    if (isObj(r.config.options)) exactKeys(r.config.options, Object.keys(DEFAULT_OPTIONS), 'config.options', errors);
    else errors.push('config.options');
    if (errors.length === before) {
      try {
        validateConfig(r.config as unknown as MatchConfig);
        config = r.config as unknown as MatchConfig;
      } catch (e) {
        errors.push(`config: ${(e as Error).message}`);
      }
    }
  }
  const n = config?.players ?? 0;

  // Seats.
  const seats: RecordSeat[] = [];
  if (!Array.isArray(r.seats) || (config && r.seats.length !== n)) errors.push('seats');
  else {
    r.seats.forEach((s: unknown, i: number) => {
      if (!isObj(s)) {
        errors.push(`seats[${i}]`);
        return;
      }
      const before = errors.length;
      exactKeys(s, v2 ? SEAT_KEYS : SEAT_KEYS_V1, `seats[${i}]`, errors);
      if (s.seat !== i) errors.push(`seats[${i}].seat`);
      if (s.kind === 'human') {
        if (typeof s.verified !== 'boolean') errors.push(`seats[${i}].verified`);
        if (s.persona !== null) errors.push(`seats[${i}].persona`);
      } else if (s.kind === 'ai') {
        if (s.verified !== false) errors.push(`seats[${i}].verified`);
        if (typeof s.persona !== 'string' || !PERSONA_IDS.includes(s.persona)) errors.push(`seats[${i}].persona`);
      } else errors.push(`seats[${i}].kind`);
      if (errors.length === before) seats.push(s as unknown as RecordSeat);
    });
  }
  const humans = seats.filter((s) => s.kind === 'human');
  if (v2 && seats.length === n && n > 0 && errors.length === 0) {
    const ai: MatchAi = { opponents: r.aiVersion as string, partners: r.partnerVersion as string, arm: null };
    for (const s of seats) {
      const want = s.kind === 'ai' ? seatVersion(ai, seats, s.seat) : null;
      if (s.aiVersion !== want) errors.push(`seats[${s.seat}].aiVersion: ${want === null ? 'null for a person' : `must be ${want}`}`);
    }
  }
  if (seats.length === n && n > 0) {
    if (humans.length === 0) errors.push('seats: no person at the table');
    const k = r.kind as MatchKind;
    const ok =
      (k === 'solo1' && n === 2 && humans.length === 1) ||
      (k === 'solo2' && n === 4 && humans.length === 1) ||
      (k === 'humans' && humans.length === n) ||
      (k === 'friends' && n === 4 && humans.length === 2 && (humans[0].seat & 1) === (humans[1].seat & 1)) ||
      (k === 'mixed' && humans.length >= 1 && humans.length < n);
    if (!ok) errors.push('kind does not match the seats');
    if (r.turnSeconds === null && humans.length !== n) errors.push('turnSeconds: no limit needs a person in every seat');
  }

  // Log and moves.
  const log: number[] = [];
  if (!Array.isArray(r.log)) errors.push('log');
  else {
    for (const [i, x] of r.log.entries()) {
      if (!isInt(x, 0, 16 * Math.max(n, 1) - 1) || (x & 15) >= NUM_ACTIONS) {
        errors.push(`log[${i}]`);
        break;
      }
      log.push(x);
    }
  }
  if (!Array.isArray(r.moves) || !Array.isArray(r.log) || r.moves.length !== r.log.length) errors.push('moves: not aligned with the log');
  else {
    for (const [i, mv] of r.moves.entries()) {
      if (!isObj(mv)) {
        errors.push(`moves[${i}]`);
        break;
      }
      const before = errors.length;
      exactKeys(mv, ['ms', 'auto', 'winProb'], `moves[${i}]`, errors);
      if (!(mv.ms === null || isInt(mv.ms, 0, MAX_MS))) errors.push(`moves[${i}].ms`);
      if (typeof mv.auto !== 'boolean') errors.push(`moves[${i}].auto`);
      if (!(mv.winProb === null || (typeof mv.winProb === 'number' && mv.winProb >= 0 && mv.winProb <= 1))) errors.push(`moves[${i}].winProb`);
      const seat = Number.isInteger(r.log[i]) ? (r.log[i] as number) >> 4 : -1;
      const who = seats[seat];
      if (mv.auto === true && mv.ms !== null) errors.push(`moves[${i}]: an automatic move has no decision time`);
      if (who?.kind === 'ai' && (mv.ms !== null || mv.auto !== false)) errors.push(`moves[${i}]: an AI seat has no decision time or automatic flag`);
      if (who?.kind === 'human' && mv.auto === false && mv.winProb !== null) errors.push(`moves[${i}]: a person's move has no win estimate`);
      if (errors.length > before) break;
    }
  }

  if (!Array.isArray(r.abandoned) || new Set(r.abandoned).size !== r.abandoned.length || !r.abandoned.every((s) => isInt(s, 0, n - 1) && seats[s]?.kind === 'human')) {
    errors.push('abandoned');
  }

  let result: MatchResult | null = null;
  if (!isObj(r.result)) errors.push('result');
  else {
    const before = errors.length;
    exactKeys(r.result, ['winner', 'score', 'games'], 'result', errors);
    const pair = (x: unknown) => Array.isArray(x) && x.length === 2 && x.every((v) => isInt(v, 0, 1000));
    if (r.result.winner !== 0 && r.result.winner !== 1) errors.push('result.winner');
    if (!pair(r.result.score)) errors.push('result.score');
    if (!pair(r.result.games)) errors.push('result.games');
    if (errors.length === before) result = r.result as unknown as MatchResult;
  }

  if (errors.length) return { ok: false, errors };

  // Replay: every move must be legal in turn and the match must end with the stated result.
  let final: MatchState;
  try {
    final = replay(config!, r.seed as string, log);
  } catch (e) {
    return { ok: false, errors: [`replay: ${(e as Error).message}`] };
  }
  if (!final.over) errors.push('replay: the match does not end');
  else {
    if (final.winner !== result!.winner) errors.push('replay: another winner');
    if (final.score[0] !== result!.score[0] || final.score[1] !== result!.score[1]) errors.push('replay: another score');
    if (final.games[0] !== result!.games[0] || final.games[1] !== result!.games[1]) errors.push('replay: another games count');
  }
  return errors.length ? { ok: false, errors } : { ok: true, record: r as unknown as AnyMatchRecord };
}
