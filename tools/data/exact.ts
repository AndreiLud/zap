// exact.json: card counts that need no simulation (DATA-SPEC 2.1.2), from the engine's own deck.
//
//   manilha[variant]  p0..p3: chance of holding k manilhas among your 3 cards; atLeastOne = 1 - p0;
//                     team: chance that a team of two holds at least one among its 6 cards.
//                     Paulista: the vira leaves the deck, so 4 manilhas among 39 cards.
//                     Mineiro: 4 fixed manilhas among 40.
//   cards[variant][c] for each strength class c (0 to 9 the plain ranks 4, 5, 6, 7, Q, J, K, A, 2, 3;
//                     10 to 13 the manilhas pica-fumo, espadilha, copas, zap): the shares of the
//                     other unseen cards that a card of that class beats, ties and loses to.
//                     Paulista: every vira (40) and every other card (39), against the other 38.
//                     Mineiro: every card against the other 39.
//
// The counts behind the formulas (deck size, manilhas per hand) come from engine/src/cards.ts, and
// the 3 card chances are also enumerated hand by hand as a check.
//
// Usage: docker compose run --rm -T node node tools/data/exact.ts

import { DECK_SIZE, RANKS, manilhaRankForVira, manilhasOf, strengthTable } from '../../engine/src/cards.ts';
import type { Variant } from '../../engine/src/config.ts';
import { isMain, provenance, writeGenerated, type Provenance } from './lib/provenance.ts';
import { round } from './lib/stats.ts';

const SCRIPT = 'tools/data/exact.ts';
export const VARIANTS: readonly Variant[] = ['paulista', 'mineiro'];
/** Strength classes: 0 to 9 plain ranks, 10 to 13 manilhas. */
export const CLASSES = 14;

export interface ManilhaChances {
  p0: number;
  p1: number;
  p2: number;
  p3: number;
  atLeastOne: number;
  team: number;
}

export interface CardShares {
  beats: number;
  ties: number;
  loses: number;
}

export interface Exact {
  provenance: Provenance;
  /** Rank labels of classes 0 to 9, as the engine names them. */
  rankLabels: string[];
  manilha: Record<Variant, ManilhaChances>;
  cards: Record<Variant, CardShares[]>;
}

export function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

/** Unseen deck of a variant: cards that can be dealt, and how many of them are manilhas. */
function deckCounts(variant: Variant): { cards: number; manilhas: number } {
  if (variant === 'mineiro') return { cards: DECK_SIZE, manilhas: manilhasOf('mineiro', -1).length };
  // Paulista: the vira is turned and leaves the deck; its manilhas are the 4 cards of the next rank.
  const counts = new Set<string>();
  for (let vira = 0; vira < DECK_SIZE; vira++) {
    const mans = manilhasOf('paulista', manilhaRankForVira(vira));
    if (mans.includes(vira)) throw new Error('the vira cannot be a manilha');
    counts.add(`${DECK_SIZE - 1}:${mans.length}`);
  }
  if (counts.size !== 1) throw new Error('paulista deck counts depend on the vira');
  const [cards, manilhas] = [...counts][0].split(':').map(Number);
  return { cards, manilhas };
}

export function manilhaChances(variant: Variant): ManilhaChances {
  const { cards, manilhas } = deckCounts(variant);
  const others = cards - manilhas;
  const hands = choose(cards, 3);
  const p = [0, 1, 2, 3].map((k) => (choose(manilhas, k) * choose(others, 3 - k)) / hands);
  const team = 1 - choose(others, 6) / choose(cards, 6);
  // Check by enumeration: every 3 card hand of every deal of the variant.
  const counted = [0, 0, 0, 0];
  let total = 0;
  const virasOf = variant === 'paulista' ? Array.from({ length: DECK_SIZE }, (_, v) => v) : [-1];
  for (const vira of virasOf) {
    const st = strengthTable(variant, vira < 0 ? -1 : manilhaRankForVira(vira));
    const deck = Array.from({ length: DECK_SIZE }, (_, c) => c).filter((c) => c !== vira);
    for (let a = 0; a < deck.length; a++)
      for (let b = a + 1; b < deck.length; b++)
        for (let c = b + 1; c < deck.length; c++) {
          counted[[deck[a], deck[b], deck[c]].filter((x) => st[x] >= 10).length]++;
          total++;
        }
  }
  for (let k = 0; k < 4; k++) {
    if (Math.abs(counted[k] / total - p[k]) > 1e-12) throw new Error(`${variant}: enumeration and formula disagree for ${k} manilhas`);
  }
  return { p0: round(p[0]), p1: round(p[1]), p2: round(p[2]), p3: round(p[3]), atLeastOne: round(1 - p[0]), team: round(team) };
}

export function cardShares(variant: Variant): CardShares[] {
  const beats = new Array<number>(CLASSES).fill(0);
  const ties = new Array<number>(CLASSES).fill(0);
  const loses = new Array<number>(CLASSES).fill(0);
  const virasOf = variant === 'paulista' ? Array.from({ length: DECK_SIZE }, (_, v) => v) : [-1];
  for (const vira of virasOf) {
    const st = strengthTable(variant, vira < 0 ? -1 : manilhaRankForVira(vira));
    for (let c = 0; c < DECK_SIZE; c++) {
      if (c === vira) continue;
      for (let d = 0; d < DECK_SIZE; d++) {
        if (d === c || d === vira) continue;
        if (st[c] > st[d]) beats[st[c]]++;
        else if (st[c] === st[d]) ties[st[c]]++;
        else loses[st[c]]++;
      }
    }
  }
  return beats.map((b, k) => {
    const n = b + ties[k] + loses[k];
    if (n === 0) throw new Error(`${variant}: no card of class ${k}`);
    return { beats: round(b / n), ties: round(ties[k] / n), loses: round(loses[k] / n) };
  });
}

export function buildExact(): Exact {
  return {
    provenance: provenance(SCRIPT, ['engine/src/cards.ts', SCRIPT]),
    rankLabels: [...RANKS],
    manilha: { paulista: manilhaChances('paulista'), mineiro: manilhaChances('mineiro') },
    cards: { paulista: cardShares('paulista'), mineiro: cardShares('mineiro') },
  };
}

if (isMain(import.meta.url)) {
  const out = writeGenerated('exact.json', buildExact());
  console.log(`wrote ${out}`);
}
