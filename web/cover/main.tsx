// The project cover (project_docs/media/cover.png), 1440 by 900, built from the client's own pieces:
// a wall of azulejo modules (panelModules on the TILE palette) with the site's grout, the six letter
// tiles of TRUCO! as a framed panel set into the wall (as .truco__word), a hand of three cards (the
// zap, 4 of clubs, on top with its manilha star) overlapping the panel's lower edge, and the wordmark
// with one line on the paper at left. tools/media/cover.mjs saves the picture once data-ready is set.

import { render } from 'preact';
import { Card } from '../src/deck/Card.tsx';
import { BrandMark, Module, TILE, panelModules } from '../src/deck/tiles.tsx';
import '../src/styles/tokens.css';
import '../src/styles/base.css';
import '../src/styles/pieces.css';
import './cover.css';
/** The wall's grid: tile pitch P, grout G, the first column at X0 and row 0 at Y0 (CSS px). */
const W = 1440;
const H = 900;
const P = 100;
const G = 4;
const X0 = 560;
const Y0 = 52;
const COLS = Math.ceil((W - X0) / P);
const ROW_FIRST = -Math.ceil(Y0 / P);
const ROW_LAST = Math.ceil((H - Y0) / P) - 1;

/** The TRUCO! panel covers 6 by 4 wall cells from column PC and row PR. */
const PC = 1;
const PR = 1;
const WORD = ['T', 'R', 'U', 'C', 'O', '!'];

/**
 * [ground, shape] pairs from the tile palette, weighted towards cobalt and white (with the glaze
 * white of the TRUCO wall, #FBF8F2) so the colored letter tiles carry the eye; ochre and terra stay
 * as accents.
 */
const GLAZE = '#FBF8F2';
const PALETTE = [
  ...Array<readonly [string, string]>(6).fill([GLAZE, TILE.cobalt]),
  ...Array<readonly [string, string]>(6).fill([TILE.cobalt, TILE.cal]),
  [GLAZE, TILE.ochre],
  [TILE.cal, TILE.terra],
  [TILE.cobalt, TILE.ochre],
] as const;
/** The wall's seed, chosen by eye among a contact sheet of seeds. */
const SEED = 1500;

const px = (n: number) => `${n}px`;

function inPanel(c: number, r: number): boolean {
  return c >= PC && c < PC + 6 && r >= PR && r < PR + 4;
}

/** The hand's box on the wall (CSS px, from .fan in cover.css) with a little room on the right. */
const HAND = { left: 760, top: 505, right: 1200, bottom: 840 };

/**
 * Cells next to the panel or behind the hand keep their shape but take a cobalt and white pair, so
 * no ochre or terra module sits against a letter tile or under the manilha's star.
 */
function quiet(c: number, r: number): boolean {
  const nearPanel = c >= PC - 1 && c <= PC + 6 && r >= PR - 1 && r <= PR + 4;
  const x = X0 + c * P;
  const y = Y0 + r * P;
  const underHand = x < HAND.right && x + P > HAND.left && y < HAND.bottom && y + P > HAND.top;
  return nearPanel || underHand;
}

const CALM: Record<string, readonly [string, string]> = {
  [`${GLAZE},${TILE.ochre}`]: [GLAZE, TILE.cobalt],
  [`${TILE.cal},${TILE.terra}`]: [TILE.cobalt, TILE.cal],
  [`${TILE.cobalt},${TILE.ochre}`]: [TILE.cobalt, TILE.cal],
};

function Wall() {
  const cells: { c: number; r: number }[] = [];
  for (let r = ROW_FIRST; r <= ROW_LAST; r++) for (let c = 0; c < COLS; c++) if (!inPanel(c, r)) cells.push({ c, r });
  const mods = panelModules(cells.length, SEED, PALETTE).map((m, k) => {
    const calm = quiet(cells[k].c, cells[k].r) ? CALM[`${m.bg},${m.fg}`] : undefined;
    return calm ? { ...m, bg: calm[0], fg: calm[1] } : m;
  });
  return (
    <div class="wall" style={{ left: px(X0 - G) }}>
      {cells.map(({ c, r }, k) => (
        <span key={`${c}:${r}`} class="wall__tile" style={{ left: px(G + c * P), top: px(Y0 + r * P), width: px(P - G), height: px(P - G) }}>
          <Module m={mods[k]} />
        </span>
      ))}
    </div>
  );
}

/** The word in letter tiles on a grout-colored frame, over the 6 by 4 cells it replaces. */
function Word() {
  const box = { left: X0 + PC * P, top: Y0 + PR * P, width: 6 * P - G, height: 4 * P - G };
  return (
    <div class="word" style={{ left: px(box.left), top: px(box.top), width: px(box.width), height: px(box.height) }}>
      {WORD.map((ch, i) => (
        <span key={i} class={`letter letter--${i % 4}`}>
          <span>{ch}</span>
        </span>
      ))}
    </div>
  );
}

/** The hand: the 3 of diamonds, the king of hearts, and the zap (4 of clubs) on top with its star. */
function Hand() {
  const hand = [
    { card: 36, manilha: false },
    { card: 26, manilha: false },
    { card: 3, manilha: true },
  ];
  const centre = X0 + PC * P + (6 * P - G) / 2;
  return (
    <div class="fan" style={{ left: px(centre) }}>
      {hand.map((c) => (
        <span key={c.card} class="fan__card">
          <Card card={c.card} manilha={c.manilha} />
        </span>
      ))}
    </div>
  );
}

function Cover() {
  return (
    <div class="cover">
      <Wall />
      <Word />
      <Hand />
      <div class="brand-block">
        <div class="wordmark">
          <span class="wordmark__mark">
            <BrandMark class="wordmark__svg" />
          </span>
          <span class="wordmark__name">Zap</span>
        </div>
        <p class="line">Truco contra uma IA que aprende</p>
      </div>
    </div>
  );
}

const root = document.getElementById('cover')!;
render(<Cover />, root);
void Promise.all([document.fonts.load('800 160px "Bricolage Grotesque"'), document.fonts.load('500 40px "Figtree"')])
  .then(() => document.fonts.ready)
  .then(() => requestAnimationFrame(() => requestAnimationFrame(() => root.setAttribute('data-ready', 'true'))));
