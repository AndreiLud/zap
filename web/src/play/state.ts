// The Play page's choice (CLIENT-SPEC 10.2): mode, variant and the opponents of each line up.
// Pure functions, no DOM: the page reads the saved choice and the address once, then keeps the
// choice in component state and saves it on every change.
//
// Saved in localStorage['zap-jogar'] as { modo, variante, contra: { dupla, solo } }; malformed
// values are ignored one by one. Address parameters win over the saved choice:
// ?modo=dupla|solo|sala&variante=paulista|mineiro&contra=id[,id] (ids of the six characters).

import type { PersonaId } from '../../../ai/src/personas.ts';
import type { Variant } from '../../../engine/src/config.ts';
import { PERSONA_IDS } from '../game-text.ts';

export type PlayMode = 'dupla' | 'solo' | 'sala';
/** Which saved line up a choice uses: two opponents (2 against 2) or one (1 against 1). */
export type Lineup = 'dupla' | 'solo';

export interface PlayChoice {
  modo: PlayMode;
  variante: Variant;
  contra: Record<Lineup, PersonaId[]>;
}

export const STORE_KEY = 'zap-jogar';
export const MODES: readonly PlayMode[] = ['dupla', 'solo', 'sala'];
export const VARIANTS: readonly Variant[] = ['paulista', 'mineiro'];
/** Your AI partner in 2 against 2: the first of these that is not an opponent. */
export const PARTNERS: readonly PersonaId[] = ['iara', 'lia', 'ravi', 'bento', 'otavio', 'zap'];
/** Difficulty steps for the four small bars (the level in words is the real cue). */
export const LEVEL_BARS: Record<PersonaId, number> = { otavio: 1, bento: 2, lia: 2, ravi: 2, iara: 3, zap: 4 };

const DEFAULT_DUPLA: readonly PersonaId[] = ['zap', 'bento'];
const DEFAULT_SOLO: readonly PersonaId[] = ['zap'];

export function defaultChoice(): PlayChoice {
  return { modo: 'dupla', variante: 'paulista', contra: { dupla: [...DEFAULT_DUPLA], solo: [...DEFAULT_SOLO] } };
}

function isPersona(x: unknown): x is PersonaId {
  return typeof x === 'string' && (PERSONA_IDS as readonly string[]).includes(x);
}

function isMode(x: unknown): x is PlayMode {
  return typeof x === 'string' && (MODES as readonly string[]).includes(x);
}

function isVariant(x: unknown): x is Variant {
  return typeof x === 'string' && (VARIANTS as readonly string[]).includes(x);
}

/** A saved list of distinct known characters, at most `max` long; null when it is not one. */
function cleanList(x: unknown, max: number): PersonaId[] | null {
  if (!Array.isArray(x) || x.length > max || !x.every(isPersona)) return null;
  return new Set(x).size === x.length ? [...x] : null;
}

/** The saved choice applied over `base`, field by field; anything malformed keeps the base value. */
export function applySaved(base: PlayChoice, raw: string | null): PlayChoice {
  let saved: unknown;
  try {
    saved = raw ? JSON.parse(raw) : null;
  } catch {
    return base;
  }
  if (!saved || typeof saved !== 'object') return base;
  const o = saved as Record<string, unknown>;
  const out: PlayChoice = { ...base, contra: { ...base.contra } };
  if (isMode(o.modo)) out.modo = o.modo;
  if (isVariant(o.variante)) out.variante = o.variante;
  if (o.contra && typeof o.contra === 'object') {
    const c = o.contra as Record<string, unknown>;
    const dupla = cleanList(c.dupla, 2);
    if (dupla) out.contra.dupla = dupla;
    const solo = cleanList(c.solo, 1);
    if (solo && solo.length === 1) out.contra.solo = solo;
  }
  return out;
}

/**
 * The address parameters applied over `base`. ?contra= sets the line up of the chosen mode (the
 * 2 against 2 one for rooms): one id for 1 against 1; for 2 against 2 up to two ids, and a single id
 * is completed with the first default opponent that differs, so a link always starts a full table.
 */
export function applyParams(base: PlayChoice, search: string): PlayChoice {
  const p = new URLSearchParams(search);
  const out: PlayChoice = { ...base, contra: { ...base.contra } };
  const modo = p.get('modo');
  if (isMode(modo)) out.modo = modo;
  const variante = p.get('variante');
  if (isVariant(variante)) out.variante = variante;
  const raw = p.get('contra');
  if (raw !== null) {
    const ids = [...new Set(raw.split(',').map((x) => x.trim().toLowerCase()))].filter(isPersona);
    if (ids.length) {
      if (out.modo === 'solo') out.contra.solo = [ids[0]];
      else {
        const two = ids.slice(0, 2);
        if (two.length === 1) two.push(DEFAULT_DUPLA.find((x) => x !== two[0])!);
        out.contra.dupla = two;
      }
    }
  }
  return out;
}

/** The choice when the page opens: defaults, then the saved choice, then the address. */
export function initialChoice(saved: string | null, search: string): PlayChoice {
  return applyParams(applySaved(defaultChoice(), saved), search);
}

export function serialize(c: PlayChoice): string {
  return JSON.stringify({ modo: c.modo, variante: c.variante, contra: c.contra });
}

/** Players at the table: 2 against 2 and 1 against 1 by mode; a room by its own setting. */
export function playersOf(c: PlayChoice, roomPlayers: 2 | 4): 2 | 4 {
  if (c.modo === 'sala') return roomPlayers;
  return c.modo === 'solo' ? 2 : 4;
}

/** The line up a choice uses: one opponent with two players, two with four. */
export function lineupOf(c: PlayChoice, roomPlayers: 2 | 4): Lineup {
  return playersOf(c, roomPlayers) === 2 ? 'solo' : 'dupla';
}

export function lineupSize(l: Lineup): 1 | 2 {
  return l === 'solo' ? 1 : 2;
}

export function opponentsOf(c: PlayChoice, roomPlayers: 2 | 4): PersonaId[] {
  return c.contra[lineupOf(c, roomPlayers)];
}

/** True when the line up has all its opponents, so the button can start the table. */
export function isComplete(c: PlayChoice, roomPlayers: 2 | 4): boolean {
  const l = lineupOf(c, roomPlayers);
  return c.contra[l].length === lineupSize(l);
}

/** Your AI partner: the first of PARTNERS that is not an opponent. */
export function partnerFor(opponents: readonly PersonaId[]): PersonaId {
  return PARTNERS.find((x) => !opponents.includes(x)) ?? 'iara';
}

/** What changed when a character was ticked or unticked, for the announcement. */
export type PickResult =
  | { kind: 'now'; list: PersonaId[] }
  | { kind: 'swap'; list: PersonaId[]; out: PersonaId; in: PersonaId }
  | { kind: 'missing'; list: PersonaId[] };

/**
 * Ticks or unticks a character in a line up. One opponent: a tick replaces it. Two opponents:
 * first in, first out, so ticking a third drops the one picked first.
 */
export function pick(list: readonly PersonaId[], id: PersonaId, checked: boolean, size: 1 | 2): PickResult {
  if (size === 1) return checked ? { kind: 'now', list: [id] } : { kind: 'now', list: [...list] };
  if (!checked) {
    const rest = list.filter((x) => x !== id);
    return rest.length < size ? { kind: 'missing', list: rest } : { kind: 'now', list: rest };
  }
  const next = list.filter((x) => x !== id);
  next.push(id);
  if (next.length > size) {
    const out = next.shift()!;
    return { kind: 'swap', list: next, out, in: id };
  }
  return { kind: next.length < size ? 'missing' : 'now', list: next };
}

/** The choice with a new line up for the given mode. */
export function withLineup(c: PlayChoice, l: Lineup, list: PersonaId[]): PlayChoice {
  return { ...c, contra: { ...c.contra, [l]: list } };
}

/** The match the button starts: players, variant, the chosen opponents and the partner. */
export function matchOf(c: PlayChoice, roomPlayers: 2 | 4): { players: 2 | 4; variant: Variant; opponents: PersonaId[]; partner: PersonaId } {
  const opponents = [...opponentsOf(c, roomPlayers)];
  return { players: playersOf(c, roomPlayers), variant: c.variante, opponents, partner: partnerFor(opponents) };
}

// Room codes (CLIENT-SPEC 10.2 item 7): digits 2 to 9 and letters without I, L and O.
const CODE_CHAR = /^[2-9A-HJKMNP-Z]$/;
const CODE_AMBIGUOUS = /[0O1IL]/;
export const CODE_LENGTH = 5;

/**
 * What a person typed into the code field, cleaned: uppercase, only the room alphabet, at most five
 * characters, and why anything was dropped ('chars' for 0, O, 1, I and L; 'other' for the rest).
 */
export function cleanCodeInput(raw: string): { code: string; dropped: 'chars' | 'other' | null } {
  let code = '';
  let dropped: 'chars' | 'other' | null = null;
  for (const ch of raw.toUpperCase()) {
    if (CODE_CHAR.test(ch)) code += ch;
    else if (CODE_AMBIGUOUS.test(ch)) dropped = 'chars';
    else if (ch.trim() && ch !== '-') dropped ??= 'other';
  }
  return { code: code.slice(0, CODE_LENGTH), dropped };
}
