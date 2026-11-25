// Messages between the browser and a room (Durable Object). Every message the server sends to a
// seat is built from engine/src/observe.ts (observe and eventsFor), so it carries only what that
// seat may know.

import type { RuleOptions, Variant } from '../engine/src/config.ts';
import type { GameEvent } from '../engine/src/engine.ts';
import type { Observation } from '../engine/src/observe.ts';
import type { PersonaId } from '../ai/src/personas.ts';

export const PROTOCOL_VERSION = 1;

/** Room codes: 5 characters, without 0, O, 1, I or L. */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 5;
export const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

/** Canned phrases: the server relays only the key; each person reads it in their own language. */
export const PHRASES = [
  'boa',
  'boa_parceiro',
  'vamos',
  'calma',
  'confia',
  'agora_vai',
  'quase',
  'que_mao',
  'sorte',
  'jogou_bem',
  'obrigado',
  'desculpa',
  'pensa_bem',
  'to_fraco',
  'to_forte',
  'segura',
  'tchau',
  'revanche',
  'ola',
  'bom_jogo',
] as const;
export type PhraseKey = (typeof PHRASES)[number];

export type RoomMode = 'solo' | 'room';
export type TurnSeconds = 15 | 30 | 60 | null;

export interface RoomSettings {
  mode: RoomMode;
  players: 2 | 4;
  variant: Variant;
  options: Partial<RuleOptions>;
  /**
   * Characters for the AI seats on the other team, in seat order, all different, one per seat. In
   * quick play: the ones the next match uses unless randomOpponents is on, and the ones the last
   * match used (a drawn lineup is written here at the start).
   */
  opponents: PersonaId[];
  /** Character for an AI partner (2 against 2), never one of the opponents. */
  partner: PersonaId;
  /** Seconds per move; null (no limit) only in rooms with people only. */
  turnSeconds: TurnSeconds;
  /** Quick play only: draw the opponents again at every start (M15). Absent in rooms stored before M15. */
  randomOpponents?: boolean;
  /** Quick play, 2 against 2 only: draw the partner again at every start (M15). */
  randomPartner?: boolean;
}

export interface PublicSeat {
  seat: number;
  kind: 'human' | 'ai' | 'empty';
  /** Nickname for people (filtered), character name for AIs. */
  name: string;
  /**
   * The character of an AI seat; in a room with friends also the one that plays a free seat if
   * nobody sits there by the start. Always null for a person.
   */
  persona: PersonaId | null;
  /** Person who passed the human check in the last 2 hours and is not flagged. */
  verified: boolean;
  connected: boolean;
  /** An AI is playing for this person right now (they dropped or timed out). */
  aiPlaying: boolean;
}

/** Room closed by its owner: clients go back home. */
export const CLOSE_ROOM_CLOSED = 4001;
/** The same person opened the room in another tab or device: the older connection closes. */
export const CLOSE_REPLACED = 4000;
/** This browser's data was deleted or moved to another browser: the room no longer knows it. */
export const CLOSE_FORGOTTEN = 4002;

export interface PublicRoom {
  code: string;
  status: 'lobby' | 'playing' | 'ended';
  settings: RoomSettings;
  seats: PublicSeat[];
  matchNo: number;
  score: [number, number];
  games: [number, number];
  /** Winning team of the last finished match, or -1. */
  lastWinner: number;
  aiVersion: string;
  expiresAt: number;
  /**
   * What this room's code can do beyond M14, so a new page never offers what an older room would
   * drop: 1, the lineup draw of quick play and the rematch switches; 2, also the arrangement of a
   * room with friends (move, plan, lobby, ownerAway, the planned character on a free seat, only the
   * owner leading after a match while connected). Absent from older room code and from the guided
   * lesson's local table.
   */
  setup?: number;
  /**
   * Rooms with friends only: the owner has no seat with an open connection, so after a match
   * anyone seated may start the next one. Says nothing about which seat is the owner's.
   */
  ownerAway?: boolean;
}

/** A game event plus when the client should show it, in ms after the message arrives. */
export interface TimedEvent {
  at: number;
  e: GameEvent;
}

export type ServerMsg =
  | { t: 'room'; now: number; you: number | null; owner: boolean; room: PublicRoom }
  | {
      t: 'game';
      now: number;
      seq: number;
      matchNo: number;
      obs: Observation;
      events: TimedEvent[];
      /** Seat that must act and the server time when its time runs out (null: no limit). */
      deadline: { seat: number; at: number | null } | null;
    }
  | { t: 'phrase'; seat: number; key: PhraseKey }
  /** limit: only with limit_reached, which period of the brake ran out and when the next one starts. */
  | { t: 'error'; code: ErrorCode; limit?: LimitInfo };

/**
 * The brake refused a match (worker/src/brake.ts): the limits of the day ran out (Workers Free) or
 * the bill ceiling of the month (Workers Paid). resetAt is when the next period starts, 00:00 UTC
 * (21h in Brasília). The HTTP API answers { error: 'limit_reached', limit } with status 503.
 */
export interface LimitInfo {
  period: 'day' | 'month';
  resetAt: number;
}

export type ClientMsg =
  | { t: 'sit'; seat: number }
  | { t: 'start' }
  | { t: 'act'; seq: number; a: number; auto?: boolean }
  | { t: 'phrase'; key: PhraseKey }
  /** Quick play: a switch the person set on the end screen, kept for this and the next matches; absent keeps the room's. */
  | { t: 'rematch'; randomOpponents?: boolean; randomPartner?: boolean }
  | { t: 'leave' }
  /** Take the seat back from the AI after time outs ("Voltar a jogar"). */
  | { t: 'resume' }
  | { t: 'sync' }
  /** Quick play only: stop (on) or restart (off) the person's clock while an ad shows between hands. */
  | { t: 'hold'; on: boolean }
  /** Room owner, after a match: back to the lobby to change the table ("Mudar a mesa"). */
  | { t: 'lobby' }
  /**
   * Room owner, lobby: move the person on `from` to `to`, swapping with whatever is there; a planned
   * character stays with its seat. seat_taken when `from` no longer holds a person.
   */
  | { t: 'move'; from: number; to: number }
  /** Room owner, lobby: who sits in a seat without a connected person. ai null: open for a friend. */
  | { t: 'plan'; seat: number; ai: string | null };

export type ErrorCode =
  | 'bad_message'
  | 'not_seated'
  | 'not_your_turn'
  | 'illegal'
  | 'stale'
  | 'not_owner'
  | 'seat_taken'
  | 'room_full'
  | 'not_in_lobby'
  | 'not_ended'
  | 'too_fast'
  | 'expired'
  /** A new human check is needed before taking a seat or starting another match. */
  | 'check_needed'
  /** No time limit is only for rooms where every seat is a person. */
  | 'needs_people'
  /** The owner closed the room. */
  | 'closed'
  /** The brake: this match would take the Zap past its share of Cloudflare's limits (see LimitInfo). */
  | 'limit_reached';

export const MAX_MESSAGE_BYTES = 2048;

/** Parses and validates a client message. Returns null for anything malformed. */
export function parseClientMsg(raw: string): ClientMsg | null {
  // Characters are at most 3 bytes in UTF-8 here; the exact byte count is checked by the room first.
  if (raw.length > MAX_MESSAGE_BYTES) return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  const int = (x: unknown, lo: number, hi: number) => Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi;
  switch (o.t) {
    case 'sit':
      return int(o.seat, 0, 3) ? { t: 'sit', seat: o.seat as number } : null;
    case 'start':
    case 'leave':
    case 'resume':
    case 'sync':
    case 'lobby':
      return { t: o.t };
    case 'move':
      return int(o.from, 0, 3) && int(o.to, 0, 3) && o.from !== o.to ? { t: 'move', from: o.from as number, to: o.to as number } : null;
    case 'plan':
      // The room checks the id against the characters it knows; this file imports no AI code.
      if (!int(o.seat, 0, 3) || !(o.ai === null || (typeof o.ai === 'string' && /^[a-z]{2,8}$/.test(o.ai)))) return null;
      return { t: 'plan', seat: o.seat as number, ai: o.ai };
    case 'rematch': {
      // Old pages send no field; a field that is present must be a boolean.
      const out: Extract<ClientMsg, { t: 'rematch' }> = { t: 'rematch' };
      for (const k of ['randomOpponents', 'randomPartner'] as const) {
        const v = o[k];
        if (v === undefined) continue;
        if (typeof v !== 'boolean') return null;
        out[k] = v;
      }
      return out;
    }
    case 'hold':
      return typeof o.on === 'boolean' ? { t: 'hold', on: o.on } : null;
    case 'act':
      if (!int(o.seq, 0, 1e9) || !int(o.a, 0, 14)) return null;
      return { t: 'act', seq: o.seq as number, a: o.a as number, auto: o.auto === true };
    case 'phrase':
      return typeof o.key === 'string' && (PHRASES as readonly string[]).includes(o.key) ? { t: 'phrase', key: o.key as PhraseKey } : null;
    default:
      return null;
  }
}
