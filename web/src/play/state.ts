// The Play page's choice (CLIENT-SPEC 10.2, M15 spec 5.1): mode, variant, the opponents of each
// line up, your partner in 2 against 2 and the random switches. Pure functions, no DOM: the page
// reads the saved choice and the address once, then keeps the choice in component state.
//
// Saved in localStorage['zap-jogar'] as { modo, variante } only: the line up is not remembered, so
// every visit from the menu starts from the defaults (an older stored `contra` is ignored and the
// page rewrites the value without it). Address parameters win over the saved choice:
// ?modo=dupla|solo|sala&variante=paulista|mineiro&contra=id[,id] (ids of the six characters).

import type { PersonaId } from '../../../ai/src/personas.ts';
import type { Variant } from '../../../engine/src/config.ts';
import { DEFAULT_OPPONENTS, FILL_ORDER, firstFree, isPersonaId } from '../../../shared/lineup.ts';
import type { NewMatch } from '../api.ts';
import type { Key, Vars } from '../i18n.ts';
import { roomOptions, turnSecondsOf, type RoomForm } from './RoomSettings.tsx';

export type PlayMode = 'dupla' | 'solo' | 'sala';
/** Which line up a choice uses: two opponents (2 against 2) or one (1 against 1). */
export type Lineup = 'dupla' | 'solo';

export interface PlayChoice {
  modo: PlayMode;
  variante: Variant;
  /** Manual opponents of each line up (kept in memory while a switch is on, used again when it goes off). */
  contra: Record<Lineup, PersonaId[]>;
  /** Manual partner, 2 against 2. */
  parceiro: PersonaId;
  /** Random switches: "Adversário(s)" per line up, "Time" for 2 against 2. */
  sorteio: { dupla: boolean; solo: boolean; parceiro: boolean };
}

export const STORE_KEY = 'zap-jogar';
export const MODES: readonly PlayMode[] = ['dupla', 'solo', 'sala'];
export const VARIANTS: readonly Variant[] = ['paulista', 'mineiro'];
/** Difficulty steps for the four small bars (the level in words is the real cue). */
export const LEVEL_BARS: Record<PersonaId, number> = { otavio: 1, bento: 2, lia: 2, ravi: 2, iara: 3, zap: 4 };

/** The defaults at every visit from the menu (owner decision D2): Zap; Zap and Iara with a random partner. */
export function defaultChoice(): PlayChoice {
  return {
    modo: 'dupla',
    variante: 'paulista',
    contra: { dupla: [...DEFAULT_OPPONENTS[4]], solo: [...DEFAULT_OPPONENTS[2]] },
    parceiro: firstFree(DEFAULT_OPPONENTS[4]),
    sorteio: { dupla: false, solo: false, parceiro: true },
  };
}

function isMode(x: unknown): x is PlayMode {
  return typeof x === 'string' && (MODES as readonly string[]).includes(x);
}

function isVariant(x: unknown): x is Variant {
  return typeof x === 'string' && (VARIANTS as readonly string[]).includes(x);
}

function parseSaved(raw: string | null): Record<string, unknown> | null {
  try {
    const saved: unknown = raw ? JSON.parse(raw) : null;
    return saved && typeof saved === 'object' ? (saved as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The saved mode and variant applied over `base`; anything else in the stored value is ignored. */
export function applySaved(base: PlayChoice, raw: string | null): PlayChoice {
  const o = parseSaved(raw);
  if (!o) return base;
  const out: PlayChoice = { ...base };
  if (isMode(o.modo)) out.modo = o.modo;
  if (isVariant(o.variante)) out.variante = o.variante;
  return out;
}

/** True when the stored value still holds a line up from before M15, so the page rewrites it without one. */
export function savedHasLineup(raw: string | null): boolean {
  const o = parseSaved(raw);
  return !!o && 'contra' in o;
}

/**
 * The address parameters applied over `base`. ?contra= sets the line up of the chosen mode (the
 * 2 against 2 one for rooms, which ignore it) and turns that line up's random switch off: one id for
 * 1 against 1; for 2 against 2 up to two ids, and a single id is completed with the first default
 * opponent that differs, so a link always starts a full table.
 */
export function applyParams(base: PlayChoice, search: string): PlayChoice {
  const p = new URLSearchParams(search);
  const out: PlayChoice = { ...base, contra: { ...base.contra }, sorteio: { ...base.sorteio } };
  const modo = p.get('modo');
  if (isMode(modo)) out.modo = modo;
  const variante = p.get('variante');
  if (isVariant(variante)) out.variante = variante;
  const raw = p.get('contra');
  if (raw !== null) {
    const ids = [...new Set(raw.split(',').map((x) => x.trim().toLowerCase()))].filter(isPersonaId);
    if (ids.length) {
      if (out.modo === 'solo') {
        out.contra.solo = [ids[0]];
        out.sorteio.solo = false;
      } else {
        const two = ids.slice(0, 2);
        if (two.length === 1) two.push(DEFAULT_OPPONENTS[4].find((x) => x !== two[0])!);
        out.contra.dupla = two;
        out.sorteio.dupla = false;
      }
    }
  }
  return out;
}

/** The choice when the page opens: defaults, then the saved mode and variant, then the address. */
export function initialChoice(saved: string | null, search: string): PlayChoice {
  const c = applyParams(applySaved(defaultChoice(), saved), search);
  return { ...c, parceiro: partnerOf(c) };
}

/** What is stored: the mode and the variant (the quick rules dialog reads the variant). Never a line up. */
export function serialize(c: PlayChoice): string {
  return JSON.stringify({ modo: c.modo, variante: c.variante });
}

/** Players at the table: 2 against 2 and 1 against 1 by mode; a room by its own setting. */
export function playersOf(c: PlayChoice, roomPlayers: 2 | 4): 2 | 4 {
  if (c.modo === 'sala') return roomPlayers;
  return c.modo === 'solo' ? 2 : 4;
}

/** The quick play line up of a choice: one opponent in 1 against 1, two otherwise. */
export function lineupOf(c: PlayChoice): Lineup {
  return c.modo === 'solo' ? 'solo' : 'dupla';
}

export function lineupSize(l: Lineup): 1 | 2 {
  return l === 'solo' ? 1 : 2;
}

/**
 * Your partner: the manual one, unless it is one of the opponents picked by hand (the opponents win a
 * clash). While "Adversários" draws them, the hidden manual list limits nothing: the request then
 * picks opponents around the partner (requestOf).
 */
export function partnerOf(c: PlayChoice): PersonaId {
  return !c.sorteio.dupla && c.contra.dupla.includes(c.parceiro) ? firstFree(c.contra.dupla) : c.parceiro;
}

/** Both sides of 2 against 2 chosen by hand: only then does a character on one side lock it on the other. */
function bothManual(c: PlayChoice): boolean {
  return c.modo === 'dupla' && !c.sorteio.dupla && !c.sorteio.parceiro;
}

/** Characters the partner picker disables because they play against you. */
export function takenByOpponents(c: PlayChoice): PersonaId[] {
  return bothManual(c) ? [...c.contra.dupla] : [];
}

/** Characters the opponents picker disables because they play with you. */
export function takenByPartner(c: PlayChoice): PersonaId[] {
  return bothManual(c) ? [partnerOf(c)] : [];
}

/** True when the button can start: rooms always; a line up drawn at random; else a complete manual list. */
export function isComplete(c: PlayChoice): boolean {
  if (c.modo === 'sala') return true;
  const l = lineupOf(c);
  return c.sorteio[l] || c.contra[l].length === lineupSize(l);
}

/** The quick play request: always valid, even behind a random switch (the server then draws over it). */
export function requestOf(c: PlayChoice): NewMatch & { players: 2 | 4; opponents: PersonaId[] } {
  const l = lineupOf(c);
  const players: 2 | 4 = l === 'solo' ? 2 : 4;
  const list = c.contra[l];
  let opponents = list.length === lineupSize(l) ? [...list] : [...DEFAULT_OPPONENTS[players]];
  if (players === 2) return { players, variant: c.variante, opponents, randomOpponents: c.sorteio.solo };
  if (c.sorteio.dupla && (opponents.includes(c.parceiro) || list.length !== 2)) {
    // The server draws the opponents over these; they only have to leave the chosen partner free.
    opponents = [...new Set([...list, ...DEFAULT_OPPONENTS[4], ...FILL_ORDER])].filter((p) => p !== c.parceiro).slice(0, 2);
  }
  const partner = opponents.includes(c.parceiro) ? firstFree(opponents) : c.parceiro;
  return { players, variant: c.variante, opponents, partner, randomOpponents: c.sorteio.dupla, randomPartner: c.sorteio.parceiro };
}

/** The room request: the table is set up in the room, so it sends no line up. */
export function roomRequestOf(c: PlayChoice, form: RoomForm): NewMatch {
  return { players: form.players, variant: c.variante, options: roomOptions(form, c.variante), turnSeconds: turnSecondsOf(form) };
}

/** The note under the button: what this choice starts. `tr` is i18n's t (injected for the tests). */
export function summaryOf(c: PlayChoice, roomPlayers: 2 | 4, tr: (key: Key, vars?: Vars) => string): string {
  const v = tr(`play.v.${c.variante}`);
  if (c.modo === 'sala') return tr('play.sum.sala', { v, m: tr(`mode.${roomPlayers}`) });
  if (!isComplete(c)) return tr('play.opp.missing');
  const who = (id: PersonaId) => tr(`play.who.${id}`);
  if (c.modo === 'solo') return tr('play.sum.solo', { v, a: c.sorteio.solo ? tr('play.who.drawnOpp1') : who(c.contra.solo[0]) });
  const [a, b] = c.contra.dupla;
  const o = c.sorteio.dupla ? tr('play.who.drawnOpp2') : tr('play.opp.pair', { a: who(a), b: who(b) });
  const p = c.sorteio.parceiro ? tr('play.who.drawnPartner') : who(partnerOf(c));
  return tr('play.sum.dupla', { v, p, o });
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
