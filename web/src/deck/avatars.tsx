// The characters' avatars (prototype tiles.js AVATARS): each one a small tile composition on a
// 2 by 2 grid, never a face. They keep their tile colors in both themes, like glazed tiles.

import type { PersonaId } from '../../../ai/src/personas.ts';
import { Shape, TILE, Tile } from './tiles.tsx';

const T = TILE;

const ART: Record<PersonaId, () => preact.JSX.Element> = {
  // Zap: a pinwheel of quarter discs, ink and ochre, like the logo turned to night.
  zap: () => (
    <>
      <rect width="2" height="2" fill={T.ink} />
      <Shape kind="quarto" x={0} y={0} size={1} rot={0} fill={T.ochre} />
      <Shape kind="quarto" x={1} y={0} size={1} rot={1} fill={T.cal} />
      <Shape kind="quarto" x={1} y={1} size={1} rot={2} fill={T.ochre} />
      <Shape kind="quarto" x={0} y={1} size={1} rot={3} fill={T.cal} />
    </>
  ),
  // Iara, calculating: four quarter rings closing into a circle, a point at the centre.
  iara: () => (
    <>
      <rect width="2" height="2" fill={T.cobalt} />
      <Shape kind="arco" x={0} y={0} size={1} rot={2} fill={T.cal} />
      <Shape kind="arco" x={1} y={0} size={1} rot={3} fill={T.cal} />
      <Shape kind="arco" x={0} y={1} size={1} rot={1} fill={T.cal} />
      <Shape kind="arco" x={1} y={1} size={1} rot={0} fill={T.cal} />
      <circle cx="1" cy="1" r=".2" fill={T.ochre} />
    </>
  ),
  // Bento, the bluffer: a half hidden disc behind a diagonal.
  bento: () => (
    <>
      <rect width="2" height="2" fill={T.terra} />
      <Shape kind="tri" x={0} y={0} size={2} rot={0} fill={T.cal} />
      <circle cx="1.35" cy="1.35" r=".38" fill={T.ink} />
      <circle cx=".62" cy=".62" r=".22" fill={T.terra} />
    </>
  ),
  // Otávio, cautious: a low sun that stays near the horizon.
  otavio: () => (
    <>
      <rect width="2" height="2" fill={T.ochre} />
      <Shape kind="meia" x={0} y={0} size={2} rot={2} fill={T.cobalt} />
      <circle cx="1" cy=".72" r=".26" fill={T.cal} />
    </>
  ),
  // Lia, aggressive: teeth on top, a cut corner below.
  lia: () => (
    <>
      <rect width="2" height="2" fill={T.cobalt} />
      <Shape kind="tri" x={0} y={0} size={2} rot={2} fill={T.terra} />
      <Shape kind="dentes" x={0} y={0} size={2} rot={0} fill={T.cal} />
    </>
  ),
  // Ravi, unpredictable: four different modules that never agree.
  ravi: () => (
    <>
      <Tile kind="truchet" x={0} y={0} size={1} rot={0} bg={T.cobalt} fg={T.cal} />
      <Tile kind="quarto" x={1} y={0} size={1} rot={1} bg={T.ochre} fg={T.cobalt} />
      <Tile kind="tri" x={0} y={1} size={1} rot={2} bg={T.cal} fg={T.terra} />
      <Tile kind="meia" x={1} y={1} size={1} rot={3} bg={T.ink} fg={T.ochre} />
    </>
  ),
};

/** A character's avatar tile as an SVG filling its box. */
export function AvatarArt({ id }: { id: PersonaId }) {
  const draw = ART[id];
  return (
    <svg class="avatar__art" viewBox="0 0 2 2" aria-hidden="true" focusable="false">
      {draw ? draw() : null}
    </svg>
  );
}
