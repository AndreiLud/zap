// The person's matches as the personal page reads them (DATA-SPEC 5.2, 5.5, 5.6): pure functions
// over the match records, no DOM and no network, so the unit tests run them on fixtures.
//
// A match counts against Zap when it is quick play (kinds solo1 and solo2): matches with other
// people are listed but stay out of the score and the rating. The person won when their team
// (teamOf(yourSeat)) is the record's winner and they did not abandon it; an abandoned match counts
// as lost. Each hand of a match is found by replaying the log with the engine (the record keeps
// only the configuration, the seed and the moves).

import { MAX_STEP } from '../../../engine/src/config.ts';
import { A_RAISE, applyAction, newMatch, teamOf, type HandSummary } from '../../../engine/src/engine.ts';
import { observe } from '../../../engine/src/observe.ts';
import { BASE_PARAMS, handEstimate } from '../../../ai/src/heuristic.ts';
import type { PersonaId } from '../../../ai/src/personas.ts';
import { normalizeRecord, type AnyMatchRecord, type MatchKind, type MatchRecord } from '../../../shared/match-record.ts';
import type { ReplayData } from '../data/ReplayViewer.tsx';

/** One match of this device: its record (as "zap-match/2") and the seat that was the person's. */
export interface PersonMatch {
  matchId: string;
  yourSeat: number;
  record: MatchRecord;
}

export type Variant = 'paulista' | 'mineiro';
export type Players = 2 | 4;
/** A mode of play: variant and table size ("paulista-2" is paulista 1 against 1). */
export type ModeKey = `${Variant}-${Players}`;
export const MODES: readonly ModeKey[] = ['paulista-2', 'paulista-4', 'mineiro-2', 'mineiro-4'];

/** Quick play against the AI: the only kinds that count in the score and the rating. */
export const SOLO_KINDS: readonly MatchKind[] = ['solo1', 'solo2'];

/** A hand's estimate under this is weak: asking for truco with it is a bluff (shared/profile.ts BC). */
export const WEAK_HAND = 1 / 3;

export function toPersonMatch(c: { yourSeat: number; record: AnyMatchRecord }): PersonMatch {
  const record = normalizeRecord(c.record);
  return { matchId: record.matchId, yourSeat: c.yourSeat, record };
}

export function isSolo(m: PersonMatch): boolean {
  return SOLO_KINDS.includes(m.record.kind);
}

export function modeOf(r: Pick<MatchRecord, 'config'>): ModeKey {
  return `${r.config.variant}-${r.config.players === 4 ? 4 : 2}`;
}

export function abandonedBy(m: PersonMatch): boolean {
  return m.record.abandoned.includes(m.yourSeat);
}

/** The win rule of the page: the person's team won and the person did not leave. */
export function personWon(m: PersonMatch): boolean {
  return m.record.result.winner === teamOf(m.yourSeat) && !abandonedBy(m);
}

/** Newest first, by end time then match id (a stable order for ties). */
export function newestFirst(a: PersonMatch, b: PersonMatch): number {
  return b.record.endedAt - a.record.endedAt || (a.matchId < b.matchId ? 1 : a.matchId > b.matchId ? -1 : 0);
}

// ------------------------------------------------------------------------------------------------
// The score against Zap

export interface WinCount {
  wins: number;
  matches: number;
}

/** Wins over quick play matches, in total and per mode (modes without games are left out). */
export function soloScore(matches: readonly PersonMatch[]): { total: WinCount; modes: { mode: ModeKey; wins: number; matches: number }[] } {
  const total: WinCount = { wins: 0, matches: 0 };
  const by = new Map<ModeKey, WinCount>();
  for (const m of matches) {
    if (!isSolo(m)) continue;
    const w = personWon(m) ? 1 : 0;
    total.matches++;
    total.wins += w;
    const key = modeOf(m.record);
    const c = by.get(key) ?? { wins: 0, matches: 0 };
    c.matches++;
    c.wins += w;
    by.set(key, c);
  }
  return { total, modes: MODES.filter((k) => by.has(k)).map((mode) => ({ mode, ...by.get(mode)! })) };
}

// ------------------------------------------------------------------------------------------------
// A row of the history table

export interface SeatInfo {
  seat: number;
  kind: 'human' | 'ai';
  /** The character an AI seat played (Zap when the record has none). */
  persona: PersonaId | null;
  version: string | null;
}

export type Mark = 'abandoned' | 'friends' | 'people';

export interface MatchRow {
  matchId: string;
  endedAt: number;
  mode: ModeKey;
  kind: MatchKind;
  opponents: SeatInfo[];
  /** The person's partner in 2 against 2; null in 1 against 1. */
  partner: SeatInfo | null;
  won: boolean;
  /** Points of the last game: the person's team first. */
  us: number;
  them: number;
  marks: Mark[];
}

function seatInfo(r: MatchRecord, seat: number): SeatInfo {
  const s = r.seats.find((x) => x.seat === seat);
  if (!s || s.kind === 'human') return { seat, kind: 'human', persona: null, version: null };
  return { seat, kind: 'ai', persona: s.persona ?? 'zap', version: s.aiVersion ?? r.aiVersion };
}

export function matchRow(m: PersonMatch): MatchRow {
  const r = m.record;
  const team = teamOf(m.yourSeat);
  const n = r.config.players;
  const opponents: SeatInfo[] = [];
  for (let seat = 0; seat < n; seat++) if (teamOf(seat) !== team) opponents.push(seatInfo(r, seat));
  const partner = n === 4 ? seatInfo(r, (m.yourSeat + 2) % 4) : null;
  const marks: Mark[] = [];
  if (abandonedBy(m)) marks.push('abandoned');
  if (r.kind === 'friends') marks.push('friends');
  if (r.kind === 'humans' || r.kind === 'mixed') marks.push('people');
  return {
    matchId: m.matchId,
    endedAt: r.endedAt,
    mode: modeOf(r),
    kind: r.kind,
    opponents,
    partner,
    won: personWon(m),
    us: r.result.score[team],
    them: r.result.score[1 - team],
    marks,
  };
}

// ------------------------------------------------------------------------------------------------
// Hands of a match

export interface HandSpan {
  /** Hand number in the match, from 0. */
  index: number;
  /** First and last index of the hand's moves in the log. */
  start: number;
  end: number;
  summary: HandSummary;
  /** The last raise of the hand: who made it and, for the person's own raise, the hand's estimate then. */
  lastRaise: { seat: number; est: number | null } | null;
}

/**
 * Replays a record once and returns every finished hand with its moves' span. The person's raises
 * carry the estimate of handEstimate() (ai/src/heuristic.ts) from what the person saw, so the page
 * can tell a bluff from a strong call.
 */
export function walkMatch(r: MatchRecord, yourSeat: number): HandSpan[] {
  const s = newMatch(r.config, r.seed);
  const spans: HandSpan[] = [];
  let current: { index: number; start: number; lastRaise: HandSpan['lastRaise'] } | null = null;
  for (let i = 0; i < r.log.length; i++) {
    if (s.over) break;
    const seat = r.log[i] >> 4;
    const action = r.log[i] & 15;
    if (!current || current.index !== s.handIndex) current = { index: s.handIndex, start: i, lastRaise: null };
    if (action === A_RAISE) current.lastRaise = { seat, est: seat === yourSeat ? handEstimate(observe(s, seat), BASE_PARAMS) : null };
    const before = s.history.length;
    applyAction(s, seat, action);
    if (s.history.length > before) {
      spans.push({ index: current.index, start: current.start, end: i, summary: s.history[s.history.length - 1], lastRaise: current.lastRaise });
      current = null;
    }
  }
  return spans;
}

/** Tags of a hand from the person's side (DATA-SPEC 5.6). */
export type HandTag = 'virada' | 'blefe' | 'doze' | 'onze';

export function handTags(span: HandSpan, yourSeat: number): HandTag[] {
  const mine = teamOf(yourSeat);
  const h = span.summary;
  const tags: HandTag[] = [];
  if (h.rounds[0] && h.rounds[0].result === 1 - mine && h.result.winner === mine) tags.push('virada');
  const lr = span.lastRaise;
  if (h.result.reason === 'run' && h.result.winner === mine && lr && lr.seat === yourSeat && lr.est !== null && lr.est < WEAK_HAND) tags.push('blefe');
  if (h.step >= MAX_STEP) tags.push('doze');
  if (h.kind === 'onze') tags.push('onze');
  return tags;
}

/**
 * One hand of a record for the replay viewer (data/ReplayViewer.tsx): the log up to the hand's end
 * and the hand's moves, each with team 0's estimated chance to win the match after it (the acting
 * AI's own estimate, turned around for team 1; null for a person's move).
 */
export function replayOf(r: MatchRecord, span: HandSpan): ReplayData {
  const actions: ReplayData['actions'] = [];
  for (let i = span.start; i <= span.end; i++) {
    const seat = r.log[i] >> 4;
    const p = r.moves[i]?.winProb ?? null;
    actions.push({ i, seat, action: r.log[i] & 15, chance: p === null ? null : teamOf(seat) === 0 ? p : 1 - p });
  }
  return { id: `${r.matchId}-${span.index}`, config: r.config, seed: r.seed, log: r.log.slice(0, span.end + 1), handIndex: span.index, actions };
}
