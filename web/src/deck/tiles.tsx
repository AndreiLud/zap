// Azulejo modules (prototype tiles.js) as Preact SVG: a few shapes on a unit square, turned in
// quarter turns, so neighbours join into larger figures the way modular tile walls do. Used by the
// logo, the court cards, the card back, the avatars, the medallion and the TRUCO wall.
//
// Colors: fixed tile colors go in the fill attribute (they are the same in both themes, like glazed
// tiles); anything that follows the theme uses a class styled in pieces.css. Never a style string.

import type { ComponentChildren } from 'preact';

/** Deterministic pseudo random numbers (mulberry32): a panel looks the same on every load. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Shape paths in a unit square. Each touches a corner or an edge. */
export const SHAPES = {
  /** Quarter disc anchored at the top left corner. */
  quarto: 'M0 0H1A1 1 0 0 1 0 1Z',
  /** Half disc hanging from the top edge. */
  meia: 'M0 0H1A.5 .5 0 0 1 0 0Z',
  /** Triangle, half of the square. */
  tri: 'M0 0H1L0 1Z',
  /** Two small quarter discs on opposite corners (a Truchet module). */
  truchet: 'M0 0H.5A.5 .5 0 0 1 0 .5ZM1 1H.5A.5 .5 0 0 1 1 .5Z',
  /** Quarter ring. */
  arco: 'M0 .45A.45 .45 0 0 0 .45 0H.8A.8 .8 0 0 1 0 .8Z',
  /** Centred disc. */
  disco: 'M.5 .22A.28 .28 0 1 1 .5 .78A.28 .28 0 1 1 .5 .22Z',
  /** Band across the diagonal. */
  faixa: 'M0 .62L.62 0H1V.38L.38 1H0Z',
  /** Small square in the corner. */
  quadra: 'M0 0H.5V.5H0Z',
  /** Stepped teeth along the top edge. */
  dentes: 'M0 0H1V.42L.75 .16L.5 .42L.25 .16L0 .42Z',
} as const;
export type ShapeKind = keyof typeof SHAPES;

/** The palette of the tiles, the same in both themes. */
export const TILE = { cobalt: '#1D3B9A', cal: '#F2EDE2', ochre: '#E3A72F', terra: '#CF5B37', ink: '#17181C' } as const;

function transform(x: number, y: number, size: number, rot: number): string {
  const r = ((rot % 4) + 4) % 4;
  return `translate(${x} ${y}) scale(${size}) rotate(${r * 90} .5 .5)`;
}

/** One shape at (x, y), `size` units wide, turned `rot` quarter turns. */
export function Shape(p: { kind: ShapeKind; x: number; y: number; size: number; rot: number; class?: string; fill?: string }) {
  return <path d={SHAPES[p.kind]} transform={transform(p.x, p.y, p.size, p.rot)} class={p.class} fill={p.fill} />;
}

/** A full tile: a background square plus one shape. */
export function Tile(p: { kind: ShapeKind; x: number; y: number; size: number; rot: number; bg: string; fg: string }) {
  return (
    <>
      <rect x={p.x} y={p.y} width={p.size} height={p.size} fill={p.bg} />
      <Shape kind={p.kind} x={p.x} y={p.y} size={p.size} rot={p.rot} fill={p.fg} />
    </>
  );
}

/** The logo: four quarter discs turning around the centre (a pinwheel). */
export function BrandMark(p: { class?: string }) {
  return (
    <svg class={p.class ?? 'brand-mark'} viewBox="0 0 2 2" aria-hidden="true" focusable="false">
      <rect width="2" height="2" fill={TILE.cobalt} />
      <Shape kind="quarto" x={0} y={0} size={1} rot={0} fill={TILE.cal} />
      <Shape kind="quarto" x={1} y={0} size={1} rot={1} fill={TILE.ochre} />
      <Shape kind="quarto" x={1} y={1} size={1} rot={2} fill={TILE.cal} />
      <Shape kind="quarto" x={0} y={1} size={1} rot={3} fill={TILE.ochre} />
    </svg>
  );
}

export interface PanelModule {
  kind: ShapeKind;
  rot: number;
  bg: string;
  fg: string;
}

/** A seeded panel of modules for the TRUCO wall and the tile strips: [background, shape] pairs from the palette. */
export function panelModules(count: number, seed: number, palette: readonly (readonly [string, string])[]): PanelModule[] {
  const r = rng(seed);
  const kinds: ShapeKind[] = ['quarto', 'meia', 'tri', 'truchet', 'arco', 'faixa', 'quarto', 'meia'];
  const out: PanelModule[] = [];
  for (let k = 0; k < count; k++) {
    const pair = palette[Math.floor(r() * palette.length)];
    out.push({ kind: kinds[Math.floor(r() * kinds.length)], rot: Math.floor(r() * 4), bg: pair[0], fg: pair[1] });
  }
  return out;
}

/** One module as its own square SVG (it stretches to its box). */
export function Module(p: { m: PanelModule; class?: string }) {
  return (
    <svg class={p.class} viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <rect width="1" height="1" fill={p.m.bg} />
      <Shape kind={p.m.kind} x={0} y={0} size={1} rot={p.m.rot} fill={p.m.fg} />
    </svg>
  );
}

const RING_TURNS = [
  [2, 3],
  [1, 0],
] as const;

/**
 * The full inlaid tile: four quarter rings meeting in a circle, quarter discs in the corners and a
 * point in the middle. Classes .medallion__ground, .medallion__ring and .medallion__point take their
 * colors from CSS (pieces.css), so it follows the theme; a page can recolor it with custom properties.
 */
export function Medallion(p: { class?: string; children?: ComponentChildren }) {
  const rings: ComponentChildren[] = [];
  for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) rings.push(<Shape key={`r${i}${j}`} kind="arco" x={i} y={j} size={1} rot={RING_TURNS[j][i]} class="medallion__ring" />);
  return (
    <svg class={p.class ?? 'medallion'} viewBox="0 0 2 2" aria-hidden="true" focusable="false">
      <rect class="medallion__ground" width="2" height="2" rx=".1" />
      {rings}
      <Shape kind="quarto" x={0} y={0} size={0.34} rot={0} class="medallion__ring" />
      <Shape kind="quarto" x={1.66} y={0} size={0.34} rot={1} class="medallion__ring" />
      <Shape kind="quarto" x={1.66} y={1.66} size={0.34} rot={2} class="medallion__ring" />
      <Shape kind="quarto" x={0} y={1.66} size={0.34} rot={3} class="medallion__ring" />
      <circle class="medallion__point" cx="1" cy="1" r=".2" />
      {p.children}
    </svg>
  );
}

const LINE_CORNERS = 'M1 1H23A22 22 0 0 1 1 23Z M99 1V23A22 22 0 0 1 77 1Z M99 99H77A22 22 0 0 1 99 77Z M1 99V77A22 22 0 0 1 23 99Z';

/**
 * The same tile drawn as line work, for the table under the trick: a thin frame, two rings, quarter
 * discs in the corners and a point. Lines keep their width at any size (vector-effect in CSS).
 */
export function MedallionLine(p: { class?: string }) {
  return (
    <svg class={p.class ?? 'medallion-line'} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <path class="medallion-line__disc" d={LINE_CORNERS} />
      <rect class="medallion-line__line" x="1" y="1" width="98" height="98" rx="4" />
      <circle class="medallion-line__line" cx="50" cy="50" r="38" />
      <circle class="medallion-line__line" cx="50" cy="50" r="30" />
      <circle class="medallion-line__point" cx="50" cy="50" r="4.5" />
    </svg>
  );
}
