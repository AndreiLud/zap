// Geometry of the Zap deck (Azulejo design, prototype deck.js): suit glyphs, pip layouts, the
// court card tile panels and the drawn tail of the Q. Pure data, no DOM; Card.tsx draws it.
//
// Cards live in a 200 by 280 view box. Suit glyphs live in a 100 by 100 box centred near (50, 50).

/** Suit letters in engine order (suit index 0 to 3): ouros, espadas, copas, paus. */
export const SUIT_KEYS = ['d', 's', 'h', 'c'] as const;
export type SuitKey = (typeof SUIT_KEYS)[number];

/** Rank texts in engine order (rank index 0 to 9), weakest first. */
export const RANK_TEXTS = ['4', '5', '6', '7', 'Q', 'J', 'K', 'A', '2', '3'] as const;
export type RankText = (typeof RANK_TEXTS)[number];

/** One shape of a suit glyph: a path or a circle, in the 100 by 100 glyph box. */
export type GlyphPart = { d: string } | { cx: number; cy: number; r: number };

/** Suit glyphs built from circles, squares and triangles, so the shape tells the suits apart. */
export const GLYPHS: Record<SuitKey, readonly GlyphPart[]> = {
  // A diamond.
  d: [{ d: 'M50 4L85 50L50 96L15 50Z' }],
  // A square turned 45 degrees with two discs on its upper edges.
  h: [{ d: 'M50 21L84 55L50 89L16 55Z' }, { cx: 33, cy: 38, r: 24 }, { cx: 67, cy: 38, r: 24 }],
  // The heart turned over, on a stem.
  s: [{ d: 'M50 6L84 40L50 74L16 40Z' }, { cx: 33, cy: 57, r: 23 }, { cx: 67, cy: 57, r: 23 }, { d: 'M50 58L63 96H37Z' }],
  // Three discs on a stem.
  c: [{ cx: 50, cy: 27, r: 20 }, { cx: 27, cy: 59, r: 20 }, { cx: 73, cy: 59, r: 20 }, { d: 'M50 38L68 62H32Z' }, { d: 'M50 56L63 96H37Z' }],
};

/**
 * Pip layouts of the number cards: [x, y, turned]. The centre column is x 100; the two columns at
 * x 82 and 118 keep clear of the big corner indices. Turned pips point down (lower half).
 */
const L = 82;
const R = 118;
const M = 100;
export const PIPS: Partial<Record<RankText, readonly (readonly [number, number, boolean])[]>> = {
  '2': [[M, 82, false], [M, 198, true]],
  '3': [[M, 74, false], [M, 140, false], [M, 206, true]],
  '4': [[L, 88, false], [R, 88, false], [L, 192, true], [R, 192, true]],
  '5': [[L, 84, false], [R, 84, false], [M, 140, false], [L, 196, true], [R, 196, true]],
  '6': [[L, 78, false], [R, 78, false], [L, 140, false], [R, 140, false], [L, 202, true], [R, 202, true]],
  '7': [[L, 74, false], [R, 74, false], [M, 106, false], [L, 140, false], [R, 140, false], [L, 206, true], [R, 206, true]],
};
export const PIP_SIZE = 31;

/** Tile shapes of tiles.tsx used by the court panels. */
export type CourtShape = 'dentes' | 'quarto' | 'tri' | 'meia' | 'disco' | 'faixa';
/**
 * Roles of a court tile: S the suit colour, A the accent (ochre, or cobalt when the suit itself is
 * ochre), W the card face, G a tile holding the suit glyph.
 */
export type CourtRole = 'S' | 'A' | 'W';
export type CourtCell = readonly [shape: CourtShape | 'G', bg: CourtRole, fg: CourtRole, quarterTurns: number];

/** Court compositions: 2 columns by 3 rows. K leans on teeth and blocks, Q on arcs and discs, J on diagonals. */
export const COURTS: Partial<Record<RankText, readonly (readonly CourtCell[])[]>> = {
  K: [
    [['dentes', 'W', 'S', 0], ['dentes', 'W', 'S', 0]],
    [['G', 'S', 'W', 0], ['quarto', 'A', 'S', 2]],
    [['tri', 'S', 'A', 1], ['tri', 'S', 'A', 0]],
  ],
  Q: [
    [['meia', 'W', 'S', 2], ['meia', 'W', 'S', 2]],
    [['disco', 'A', 'S', 0], ['G', 'S', 'W', 0]],
    [['quarto', 'W', 'S', 1], ['quarto', 'W', 'S', 0]],
  ],
  J: [
    [['tri', 'A', 'S', 0], ['faixa', 'W', 'S', 1]],
    [['faixa', 'W', 'S', 0], ['G', 'S', 'W', 0]],
    [['tri', 'W', 'S', 2], ['tri', 'A', 'S', 3]],
  ],
};
/** Court panel: tile side and gap, centred on the card. */
export const COURT_TILE = 37;
export const COURT_GAP = 3;

/**
 * The display face's Q has a short flat tail that reads as an underlined O or a zero at card size.
 * The index draws the face's O plus this tail across the bowl, in the index's own units (font size
 * 60, baseline 64, centre x 34).
 */
export const Q_TAIL = 'M36.5 55.5L43.5 49.5L55 63.8L48 69.8Z';

/** Corner index: rank text centre and baseline, the pip under it, and the four-color tile behind both. */
export const INDEX = { x: 34, y: 64, pipY: 88, pipSize: 30, tile: { x: 12, y: 13, w: 44, h: 100, r: 6 } } as const;

/** Quarter disc ornaments on the two corners free of indices. */
export const CORNER_MOTIFS = ['M193 34A27 27 0 0 1 166 7H184A9 9 0 0 1 193 16Z', 'M7 246A27 27 0 0 1 34 273H16A9 9 0 0 1 7 264Z'] as const;
/** Manilha seal: an ochre quarter disc and a four point ink star, top right. */
export const SEAL_DISC = 'M193 50A43 43 0 0 1 150 7H184A9 9 0 0 1 193 16Z';
export const SEAL_STAR = 'M178 14L181 22L189 25L181 28L178 36L175 28L167 25L175 22Z';
