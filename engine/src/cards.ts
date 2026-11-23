// Card encoding shared by the browser, the Durable Object and training.
//
// A card is an integer id = rank * 4 + suit, from 0 to 39.
// Ranks follow the natural truco order, weakest first (8, 9 and 10 are not in the deck):
//   0:'4' 1:'5' 2:'6' 3:'7' 4:'Q' 5:'J' 6:'K' 7:'A' 8:'2' 9:'3'
// Suits follow the manilha order, weakest first:
//   0: diamonds (ouros)  1: spades (espadas)  2: hearts (copas)  3: clubs (paus)

import type { Variant } from './config.ts';

export const RANKS = ['4', '5', '6', '7', 'Q', 'J', 'K', 'A', '2', '3'] as const;
export const SUITS = ['d', 's', 'h', 'c'] as const;
export const DECK_SIZE = 40;
export const NUM_RANKS = 10;

export const SUIT_DIAMONDS = 0;
export const SUIT_SPADES = 1;
export const SUIT_HEARTS = 2;
export const SUIT_CLUBS = 3;

export const RANK_4 = 0;
export const RANK_7 = 3;
export const RANK_A = 7;
export const RANK_3 = 9;

/** Strength given to a card played face down: below every real card. */
export const FACE_DOWN_STRENGTH = -1;

export function rankOf(card: number): number {
  return card >> 2;
}

export function suitOf(card: number): number {
  return card & 3;
}

export function makeCard(rank: number, suit: number): number {
  return rank * 4 + suit;
}

export function cardToString(card: number): string {
  return RANKS[rankOf(card)] + SUITS[suitOf(card)];
}

/** Parses '4c', 'Ah', '7d', 'Qs'. Throws on anything else. */
export function parseCard(text: string): number {
  const r = RANKS.indexOf(text.slice(0, -1).toUpperCase() as (typeof RANKS)[number]);
  const s = SUITS.indexOf(text.slice(-1).toLowerCase() as (typeof SUITS)[number]);
  if (r < 0 || s < 0 || text.length !== 2) throw new Error(`bad card: ${text}`);
  return makeCard(r, s);
}

export function parseCards(text: string): number[] {
  return text.trim().split(/\s+/).map(parseCard);
}

/** Mineiro manilhas are fixed: 4 of clubs (zap), 7 of hearts, ace of spades, 7 of diamonds. */
export const MINEIRO_MANILHAS: readonly number[] = [
  makeCard(RANK_7, SUIT_DIAMONDS), // pica-fumo, weakest manilha
  makeCard(RANK_A, SUIT_SPADES), // espadilha
  makeCard(RANK_7, SUIT_HEARTS), // copas
  makeCard(RANK_4, SUIT_CLUBS), // zap, strongest card
];

/** In paulista, the manilha rank is the rank after the vira, wrapping from 3 back to 4. */
export function manilhaRankForVira(vira: number): number {
  return (rankOf(vira) + 1) % NUM_RANKS;
}

/**
 * Strength table for one hand: index by card id. Plain cards use their rank (0 to 9),
 * manilhas use 10 to 13 by suit. Equal strength means a tie.
 */
export function strengthTable(variant: Variant, manilhaRank: number): number[] {
  const table = new Array<number>(DECK_SIZE);
  for (let c = 0; c < DECK_SIZE; c++) table[c] = rankOf(c);
  if (variant === 'paulista') {
    for (let s = 0; s < 4; s++) table[makeCard(manilhaRank, s)] = 10 + s;
  } else {
    for (let i = 0; i < 4; i++) table[MINEIRO_MANILHAS[i]] = 10 + i;
  }
  return table;
}

/** The four manilhas of a hand, weakest first (pica-fumo, espadilha, copas, zap). */
export function manilhasOf(variant: Variant, manilhaRank: number): number[] {
  if (variant === 'mineiro') return MINEIRO_MANILHAS.slice();
  return [0, 1, 2, 3].map((s) => makeCard(manilhaRank, s));
}

export function isManilha(strength: readonly number[], card: number): boolean {
  return strength[card] >= 10;
}
