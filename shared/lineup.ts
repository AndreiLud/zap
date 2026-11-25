// Who plays the AI seats of a table (M15): the order of the six characters, the defaults, the
// checks of a requested lineup and the draw behind quick play's random switches. Pure, and with
// only type imports, so the browser can use it without pulling the AI code into its entry chunk.

import type { PersonaId } from '../ai/src/personas.ts';
import type { RoomSettings } from './protocol.ts';

/** The six characters in picker order. Must equal the PERSONAS order in ai/src/personas.ts (worker/test/lineup.test.ts). */
export const PERSONA_ORDER: readonly PersonaId[] = ['otavio', 'bento', 'lia', 'ravi', 'iara', 'zap'];

/** Order for a partner or a free character: the first of these not already at the table. */
export const FILL_ORDER: readonly PersonaId[] = ['iara', 'lia', 'ravi', 'bento', 'otavio', 'zap'];

/** Quick play defaults: Zap alone, or Zap and Iara (the partner is the Play page's business). */
export const DEFAULT_OPPONENTS: Readonly<Record<2 | 4, readonly PersonaId[]>> = { 2: ['zap'], 4: ['zap', 'iara'] };

/** A room's default plan, other team in seat order: the first friend to join takes seat 1 and Zap stays on seat 3. */
export const DEFAULT_ROOM_OPPONENTS: Readonly<Record<2 | 4, readonly PersonaId[]>> = { 2: ['zap'], 4: ['iara', 'zap'] };

export function isPersonaId(x: unknown): x is PersonaId {
  return typeof x === 'string' && (PERSONA_ORDER as readonly string[]).includes(x);
}

/** The first of FILL_ORDER not in `used`. */
export function firstFree(used: Iterable<PersonaId | null>): PersonaId {
  const taken = new Set(used);
  return FILL_ORDER.find((p) => !taken.has(p)) ?? FILL_ORDER[0];
}

/**
 * The lineup of the next quick play match. A side whose switch is on is drawn again, uniformly and
 * independently at every start (repeats across matches allowed); a side whose switch is off keeps
 * the characters it had. The opponents are drawn first and avoid a partner that stays; a drawn
 * partner avoids the opponents. `rand` is called only for what is drawn, so a table with both
 * switches off consumes nothing from the generator the AIs also sample from.
 */
export function drawLineup(
  players: 2 | 4,
  opponents: readonly PersonaId[],
  partner: PersonaId,
  f: { opponents: boolean; partner: boolean },
  rand: () => number,
): { opponents: PersonaId[]; partner: PersonaId } {
  // Math.min keeps a generator that returns exactly 1 inside the pool.
  const take = (pool: PersonaId[]) => pool.splice(Math.min(pool.length - 1, Math.floor(rand() * pool.length)), 1)[0];
  let opp = [...opponents];
  if (f.opponents) {
    const pool = PERSONA_ORDER.filter((p) => players === 2 || f.partner || p !== partner);
    opp = Array.from({ length: players / 2 }, () => take(pool));
  }
  const part = players === 4 && f.partner ? take(PERSONA_ORDER.filter((p) => !opp.includes(p))) : partner;
  return { opponents: opp, partner: part };
}

type LineupFields = Pick<RoomSettings, 'mode' | 'players' | 'opponents' | 'partner' | 'randomOpponents' | 'randomPartner'>;

/**
 * Why a requested lineup cannot be played, or null when it is fine. The values may come straight
 * from a request body, so nothing about their types is assumed.
 */
export function lineupProblem(s: LineupFields): 'opponents' | 'partner' | 'random' | null {
  const opp: unknown = s.opponents;
  if (!Array.isArray(opp) || opp.length !== s.players / 2 || !opp.every(isPersonaId) || new Set(opp).size !== opp.length) return 'opponents';
  // With two players the partner never sits at the table; it only has to be a known character.
  if (!isPersonaId(s.partner) || (s.players === 4 && opp.includes(s.partner))) return 'partner';
  const flags: unknown[] = [s.randomOpponents, s.randomPartner];
  if (!flags.every((x) => x === undefined || typeof x === 'boolean')) return 'random';
  if (s.randomPartner === true && s.players !== 4) return 'random';
  if ((s.randomOpponents === true || s.randomPartner === true) && s.mode !== 'solo') return 'random';
  return null;
}
