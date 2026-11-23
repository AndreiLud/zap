// From an engine card id to what the deck draws. Engine card id: rank * 4 + suit, ranks weakest
// first (4 5 6 7 Q J K A 2 3), suits d s h c (ouros, espadas, copas, paus). The suit order is also
// the manilha order, weakest first: pica-fumo, espadilha, copas, zap. Spoken names ("7 de copas")
// stay in game-text.ts (cardName), which reads the locales.

import { rankOf, suitOf } from '../../../engine/src/cards.ts';
import { RANK_TEXTS, SUIT_KEYS, type RankText, type SuitKey } from './geometry.ts';

/** A real card id (0 to 39); anything else (-1 hidden, -2 unknown) draws as a back. */
export function isCard(c: number): boolean {
  return Number.isInteger(c) && c >= 0 && c < 40;
}

export function cardRank(c: number): RankText {
  return RANK_TEXTS[rankOf(c)];
}

export function cardSuit(c: number): SuitKey {
  return SUIT_KEYS[suitOf(c)];
}

/** Glossary ids of the four manilhas, by suit index (weakest first). */
export const MANILHA_IDS = ['picafumo', 'espadilha', 'copas', 'zap'] as const;
export type ManilhaId = (typeof MANILHA_IDS)[number];

/** The manilha name of a card's suit (its glossary id), for "7 de espadas, manilha espadilha". */
export function manilhaId(c: number): ManilhaId {
  return MANILHA_IDS[suitOf(c)];
}
