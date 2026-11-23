// Shared pieces of the reading pages (the You page, the legal pages and the data placeholder), in the
// pattern of the prototype's pagina.css: a cover with the title and one line, sections with thin
// rules, and one tile accent per page (a slim strip of generated tiles). Styles: styles/page.css.

import { useMemo } from 'preact/hooks';
import { Module, TILE, panelModules } from '../deck/tiles.tsx';
import '../styles/page.css';

const PALETTE = [
  [TILE.cobalt, TILE.cal],
  [TILE.ochre, TILE.cobalt],
  [TILE.cal, TILE.terra],
  [TILE.cobalt, TILE.ochre],
  ['#FBF8F2', TILE.cobalt],
] as const;

/** The page's one tile moment: a slim strip, the same on every load (seeded per page). */
export function TileStrip({ seed }: { seed: number }) {
  const mods = useMemo(() => panelModules(18, seed, PALETTE), [seed]);
  return (
    <div class="doc__strip" aria-hidden="true">
      {mods.map((m, i) => (
        <Module key={i} m={m} />
      ))}
    </div>
  );
}

/** Two digits for a section number ("01"), set in type beside the section title. */
export function sectionNumber(i: number): string {
  return String(i + 1).padStart(2, '0');
}
