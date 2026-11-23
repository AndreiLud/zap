// The Zap deck as Preact SVG (prototype deck.js). Cards are physical objects: the face stays light
// in both themes. Every color comes from a class styled in styles/pieces.css through the card
// tokens (--card-face, --suit-red...), so the four-color option is a CSS switch on
// <html data-deck="four"> and no card re-renders (CLIENT-SPEC 7).
//
// Every rendered card carries data-card (the engine id, or -1 for a back) and aria-hidden: the text
// alternative belongs to the button or region around it. The e2e screen audit reads data-card.

import type { ComponentChildren } from 'preact';
import { COURTS, COURT_GAP, COURT_TILE, CORNER_MOTIFS, GLYPHS, INDEX, PIPS, PIP_SIZE, Q_TAIL, SEAL_DISC, SEAL_STAR, type CourtRole, type RankText as Rank, type SuitKey } from './geometry.ts';
import { cardRank, cardSuit, isCard } from './names.ts';
import { Shape } from './tiles.tsx';

/** A suit glyph centred at (cx, cy), `size` units wide, optionally turned 180 degrees. */
function Pip(p: { suit: SuitKey; cx: number; cy: number; size: number; flip?: boolean; class: string }) {
  const k = p.size / 100;
  const rot = p.flip ? ' rotate(180 50 50)' : '';
  return (
    <g class={p.class} transform={`translate(${p.cx - p.size / 2} ${p.cy - p.size / 2}) scale(${k})${rot}`}>
      <GlyphParts suit={p.suit} />
    </g>
  );
}

function GlyphParts({ suit }: { suit: SuitKey }) {
  return (
    <>
      {GLYPHS[suit].map((part, i) => ('d' in part ? <path key={i} d={part.d} /> : <circle key={i} cx={part.cx} cy={part.cy} r={part.r} />))}
    </>
  );
}

/** Corner index: rank in Bricolage (Q drawn with its tail) and the suit pip; a filled tile behind both in four-color mode. */
function CornerIndex({ rank, suit }: { rank: Rank; suit: SuitKey }) {
  const tile = INDEX.tile;
  return (
    <>
      <rect class="card__index-tile" x={tile.x} y={tile.y} width={tile.w} height={tile.h} rx={tile.r} />
      <text class="card__rank card__index" x={INDEX.x} y={INDEX.y} text-anchor="middle">
        {rank === 'Q' ? 'O' : rank}
      </text>
      {rank === 'Q' ? <path class="card__index" d={Q_TAIL} /> : null}
      <Pip suit={suit} cx={INDEX.x} cy={INDEX.pipY} size={INDEX.pipSize} class="card__index" />
    </>
  );
}

const ROLE_CLASS: Record<CourtRole, string> = { S: 'card__role-s', A: 'card__role-a', W: 'card__role-w' };

/** J, Q and K: a 2 by 3 panel of tiles, no portraits. */
function CourtPanel({ rank, suit }: { rank: Rank; suit: SuitKey }) {
  const rows = COURTS[rank];
  if (!rows) return null;
  const T = COURT_TILE;
  const w = T * 2 + COURT_GAP;
  const h = T * 3 + COURT_GAP * 2;
  const x0 = 100 - w / 2;
  const y0 = 140 - h / 2;
  const cells: ComponentChildren[] = [];
  rows.forEach((row, j) =>
    row.forEach(([kind, bg, fg, rot], i) => {
      const x = x0 + i * (T + COURT_GAP);
      const y = y0 + j * (T + COURT_GAP);
      cells.push(<rect key={`b${i}${j}`} class={ROLE_CLASS[bg]} x={x} y={y} width={T} height={T} />);
      if (kind === 'G') cells.push(<Pip key={`g${i}${j}`} suit={suit} cx={x + T / 2} cy={y + T / 2} size={25} class="card__glyph-on" />);
      else cells.push(<Shape key={`s${i}${j}`} kind={kind} x={x} y={y} size={T} rot={rot} class={ROLE_CLASS[fg]} />);
    }),
  );
  return (
    <>
      <rect class="card__court-frame" x={x0 - 3} y={y0 - 3} width={w + 6} height={h + 6} rx="3" />
      {cells}
    </>
  );
}

function Body({ rank, suit }: { rank: Rank; suit: SuitKey }) {
  const pips = PIPS[rank];
  if (pips) return <>{pips.map(([x, y, flip], i) => <Pip key={i} suit={suit} cx={x} cy={y} size={PIP_SIZE} flip={flip} class="card__pip" />)}</>;
  if (rank === 'A') {
    return (
      <>
        <circle class="card__ace-ring" cx="100" cy="140" r="44" />
        <circle class="card__motif" cx="100" cy="140" r="36" />
        <Pip suit={suit} cx={100} cy={140} size={52} class="card__pip" />
      </>
    );
  }
  return <CourtPanel rank={rank} suit={suit} />;
}

export interface CardProps {
  /** Engine card id; anything that is not a card (-1 hidden, -2 unknown) draws the back. */
  card: number;
  /** The card is a manilha of the current hand: the ochre seal with the star, top right. */
  manilha?: boolean;
  class?: string;
}

/** One card face (or its back when `card` is not a real card), 200 by 280 units, sized by its box. */
export function Card({ card, manilha, class: cls }: CardProps) {
  if (!isCard(card)) return <CardBack class={cls} />;
  const rank = cardRank(card);
  const suit = cardSuit(card);
  return (
    <svg class={`card suit-${suit}${cls ? ` ${cls}` : ''}`} viewBox="0 0 200 280" data-card={card} aria-hidden="true" focusable="false">
      <rect class="card__face" x="1" y="1" width="198" height="278" rx="14" />
      <rect class="card__frame" x="7" y="7" width="186" height="266" rx="9" />
      <path class="card__motif" d={CORNER_MOTIFS[0]} />
      <path class="card__motif" d={CORNER_MOTIFS[1]} />
      {manilha ? (
        <>
          <path class="card__seal" d={SEAL_DISC} />
          <path class="card__seal-star" d={SEAL_STAR} />
        </>
      ) : null}
      <CornerIndex rank={rank} suit={suit} />
      <g transform="rotate(180 100 140)">
        <CornerIndex rank={rank} suit={suit} />
      </g>
      <Body rank={rank} suit={suit} />
    </svg>
  );
}

const BACK_TURNS = [
  [2, 3],
  [1, 0],
] as const;

/** The back: a cobalt field of quarter discs turning into circles, ochre in alternate blocks. */
export function CardBack({ class: cls }: { class?: string }) {
  const cell = 40;
  const mods: ComponentChildren[] = [];
  for (let j = 0; j < 6; j++) {
    for (let i = 0; i < 4; i++) {
      const accent = (Math.floor(i / 2) + Math.floor(j / 2)) % 2 === 1;
      mods.push(
        <Shape key={`${i}-${j}`} kind="quarto" x={20 + i * cell} y={20 + j * cell} size={cell} rot={BACK_TURNS[j % 2][i % 2]} class={accent ? 'card__back-accent' : 'card__back-motif'} />,
      );
    }
  }
  return (
    <svg class={`card card--back${cls ? ` ${cls}` : ''}`} viewBox="0 0 200 280" data-card="-1" aria-hidden="true" focusable="false">
      <rect class="card__face" x="1" y="1" width="198" height="278" rx="14" />
      <rect class="card__back-field" x="11" y="11" width="178" height="258" rx="7" />
      {mods}
      <rect class="card__back-rim" x="11" y="11" width="178" height="258" rx="7" />
    </svg>
  );
}

/** A suit glyph for text (1em square), colored by its suit class unless `plain` (then currentColor). */
export function SuitGlyph({ suit, plain, class: cls }: { suit: SuitKey; plain?: boolean; class?: string }) {
  return (
    <svg class={`suit-glyph${plain ? '' : ` suit-${suit}`}${cls ? ` ${cls}` : ''}`} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <GlyphParts suit={suit} />
    </svg>
  );
}

/** A rank as HTML text. The Q gets a drawn tail so it never reads as O or zero; screen readers get "Q". */
export function RankText({ rank }: { rank: Rank }) {
  if (rank !== 'Q') return <>{rank}</>;
  return (
    <>
      <span class="rank-q" aria-hidden="true">
        O
      </span>
      <span class="sr-only">Q</span>
    </>
  );
}

/**
 * The small card of the hand info row (the vira chip): the rank as real text and an 11 px suit glyph.
 * `label` is its accessible name ("vira: 6 de copas").
 */
export function MiniCard({ card, label, class: cls }: { card: number; label: string; class?: string }) {
  if (!isCard(card)) {
    return <span class={`mini-card mini-card--back${cls ? ` ${cls}` : ''}`} role="img" aria-label={label} data-card="-1" />;
  }
  const suit = cardSuit(card);
  return (
    <span class={`mini-card suit-${suit}${cls ? ` ${cls}` : ''}`} role="img" aria-label={label} data-card={card}>
      <span class="mini-card__rank" aria-hidden="true">
        <RankText rank={cardRank(card)} />
      </span>
      <SuitGlyph suit={suit} class="mini-card__suit" />
    </span>
  );
}
