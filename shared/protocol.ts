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
  /** Characters for the AI seats on the other team, in seat order. */
  opponents: PersonaId[];
  /** Character for an AI partner (2 against 2). */
  partner: PersonaId;
  /** Seconds per move; null (no limit) only in rooms with people only. */
  turnSeconds: TurnSeconds;
}

export interface PublicSeat {
  seat: number;
  kind: 'human' | 'ai' | 'empty';
  /** Nickname for people (filtered), character name for AIs. */
  name: string;
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
  | { t: 'rematch' }
  | { t: 'leave' }
  /** Take the seat back from the AI after time outs ("Voltar a jogar"). */
  | { t: 'resume' }
  | { t: 'sync' }
  /** Quick play only: stop (on) or restart (off) the person's clock while an ad shows between hands. */
  | { t: 'hold'; on: boolean };

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
    case 'rematch':
    case 'leave':
    case 'resume':
    case 'sync':
      return { t: o.t };
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
