// Test helpers: rigged hands written as text, and actions by name.

import { makeConfig, parseCard, parseCards, type RuleOptions, type Variant } from '../src/index.ts';
import { applyAction, newMatch, parseAction, setHandCards, type GameEvent, type MatchState } from '../src/engine.ts';

export const SEED = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

export interface RigSpec {
  variant?: Variant;
  players?: 2 | 4;
  options?: Partial<RuleOptions>;
  /** One string of three cards per seat, for example ['4c 7h As', ...]. */
  cards: string[];
  vira?: string;
  score?: [number, number];
  games?: [number, number];
  /** Default: the last seat deals, so seat 0 is the "mão" and opens the hand. */
  dealer?: number;
}

export function rig(spec: RigSpec): MatchState {
  const variant = spec.variant ?? 'paulista';
  const players = spec.players ?? (spec.cards.length as 2 | 4);
  const config = makeConfig(variant, players, spec.options ?? {});
  const s = newMatch(config, SEED, { dealer: spec.dealer ?? players - 1, score: spec.score, games: spec.games });
  setHandCards(s, spec.cards.map(parseCards), spec.vira ? parseCard(spec.vira) : variant === 'paulista' ? parseCard('5d') : -1);
  return s;
}

/** Applies a list of [seat, actionName] pairs and returns the events. */
export function act(s: MatchState, ...steps: [number, string][]): GameEvent[] {
  const ev: GameEvent[] = [];
  for (const [seat, name] of steps) applyAction(s, seat, parseAction(name), ev);
  return ev;
}
