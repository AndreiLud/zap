// The Open Graph images (CLIENT-SPEC 21.1, WP6): one 1200 by 630 page per route and language,
// built from the client's own pieces (deck, tiles, avatars), so a link preview looks like the site.
// tools/og/shoot.mjs opens index.html?route=<route>&lang=<pt|en> and saves a PNG once the root
// carries data-ready (fonts loaded, the title fitted to its line). Not part of the site build.
//
// Each image: the brand mark and "Zap" top left, the page title in Bricolage on one line, the
// address, and the page's art on the right.

import { render, type ComponentChildren } from 'preact';
import { Card } from '../src/deck/Card.tsx';
import { BrandMark, Medallion, MedallionLine, Module, TILE, panelModules } from '../src/deck/tiles.tsx';
import { Avatar, HumanSeal, AiMark } from '../src/components/pieces.tsx';
import { MiniTable, MODE_SPOTS } from '../src/play/drawings.tsx';
import { applyLang, t, type Key } from '../src/i18n.ts';
import { CURVE, SERVED, lineage, storyVersion, type CurvePointRow } from '../src/data/load.ts';
import '../src/styles/tokens.css';
import '../src/styles/base.css';
import '../src/styles/pieces.css';
import './og.css';

/** The 10 images: the nine pages with a file of their own, and the room invite (worker/src/cf/index.ts). */
export const OG_ROUTES = ['start', 'play', 'guided', 'rules', 'data', 'you', 'privacy', 'terms', 'verify', 'room'] as const;
export type OgRoute = (typeof OG_ROUTES)[number];

/** The title on each image: the page's own name, as the navigation says it. */
const TITLE: Record<OgRoute, Key> = {
  start: 'start.h1',
  play: 'shell.nav.play',
  guided: 'shell.nav.guided',
  rules: 'shell.nav.rules',
  data: 'shell.nav.data',
  you: 'shell.nav.you',
  privacy: 'shell.nav.privacy',
  terms: 'shell.nav.terms',
  verify: 'shell.nav.verify',
  room: 'shell.og.room',
};

const STRIP = panelModules(10, 31, [
  [TILE.cobalt, TILE.cal],
  [TILE.cal, TILE.cobalt],
  [TILE.ochre, TILE.cobalt],
  [TILE.cal, TILE.terra],
  [TILE.terra, TILE.cal],
]);

/** Start: your three cards dealt into a fan on the medallion tile (as on the start page). */
function StartArt() {
  const hand = [
    { card: 36, manilha: false },
    { card: 13, manilha: true },
    { card: 27, manilha: false },
  ];
  return (
    <div class="og-art og-start">
      <Medallion class="medallion og-start__tile" />
      <div class="og-fan">
        {hand.map((c) => (
          <span key={c.card} class="og-fan__card">
            <Card card={c.card} manilha={c.manilha} />
          </span>
        ))}
      </div>
    </div>
  );
}

/** Play: the three mode drawings over a strip of tiles. */
function PlayArt() {
  const modes = [
    { spots: MODE_SPOTS.dupla, label: 'play.mode.dupla' as const },
    { spots: MODE_SPOTS.solo, label: 'play.mode.solo' as const },
    { spots: MODE_SPOTS.sala, label: 'play.mode.sala' as const },
  ];
  return (
    <div class="og-art og-play">
      <div class="og-modes">
        {modes.map((m, i) => (
          <div key={m.label} class={`og-mode${i === 0 ? ' is-chosen' : ''}`}>
            <MiniTable spots={m.spots} class="og-mode__table" />
            <span>{t(m.label)}</span>
          </div>
        ))}
      </div>
      <div class="og-strip">
        {STRIP.map((m, i) => (
          <Module key={i} m={m} class="og-strip__tile" />
        ))}
      </div>
    </div>
  );
}

/** Guided: a hand of three with the coach's "suggested" tag on the card to play. */
function GuidedArt() {
  const hand = [8, 33, 22];
  return (
    <div class="og-art og-guided">
      <MedallionLine class="medallion-line og-guided__table" />
      <div class="og-hand">
        {hand.map((c, i) => (
          <span key={c} class={`og-hand__card${i === 1 ? ' is-suggested' : ''}`}>
            {i === 1 ? <span class="og-tag">{t('guide.suggest')}</span> : null}
            <Card card={c} />
          </span>
        ))}
      </div>
    </div>
  );
}

/** Rules: the ten ranks as a ladder, weakest to strongest, and the zap above them with its star. */
function RulesArt() {
  const suits = [1, 2, 0, 3, 1, 2, 0, 3, 1, 2];
  return (
    <div class="og-art og-rules">
      <div class="og-ladder">
        {suits.map((suit, rank) => (
          <span key={rank} class="og-ladder__card" style={{ '--i': String(rank) }}>
            <Card card={rank * 4 + suit} />
          </span>
        ))}
      </div>
      <span class="og-ladder__zap">
        <Card card={3} manilha />
        <svg class="og-star" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 0l2.2 5.8L16 8l-5.8 2.2L8 16l-2.2-5.8L0 8l5.8-2.2Z" />
        </svg>
      </span>
    </div>
  );
}

/**
 * Data: the curve of F3 ("The training curve", data/parts/Curve.tsx), no numbers: games won against
 * the tuned rules player along the training of the version in play (curve.json, made by
 * tools/data/curve.ts), with its 95% band. As in F3, a parent version is drawn up to the step its
 * child started from (storyRows), dashed, and the version in play solid, ending on an ochre dot.
 * The dashed grey line is an even score.
 */
function DataArt() {
  const rows = lineage(CURVE.rows, storyVersion(CURVE.rows, SERVED.version));
  const parts = rows.map((row, i) => ({ row, points: row.points.filter((p) => !rows[i + 1] || p.step <= rows[i + 1].offset) }));
  const all = parts.flatMap((p) => p.points);
  if (!all.length) return <div class="og-art og-data" />;
  const xMax = Math.max(...all.map((p) => p.step));
  // The plot inside the 500 by 400 box; scores from 30% to 100%, as F3's axis.
  const x = (step: number) => 30 + (step / xMax) * 440;
  const y = (v: number) => 370 - ((Math.min(1, Math.max(0.3, v)) - 0.3) / 0.7) * 330;
  const line = (pts: CurvePointRow[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.step).toFixed(1)} ${y(p.mean).toFixed(1)}`).join('');
  const band = (pts: CurvePointRow[]) =>
    `${pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.step).toFixed(1)} ${y(p.mean + p.half95).toFixed(1)}`).join('')}${[...pts]
      .reverse()
      .map((p) => `L${x(p.step).toFixed(1)} ${y(p.mean - p.half95).toFixed(1)}`)
      .join('')}Z`;
  const last = parts[parts.length - 1].points[parts[parts.length - 1].points.length - 1];
  return (
    <div class="og-art og-data">
      <svg viewBox="0 0 500 400" aria-hidden="true">
        {[0.4, 0.6, 0.8, 1].map((v) => (
          <line key={v} class="og-data__grid" x1="20" x2="480" y1={y(v)} y2={y(v)} />
        ))}
        <line class="og-data__even" x1="20" x2="480" y1={y(0.5)} y2={y(0.5)} />
        {parts.map((p, i) => (
          <path key={`b${p.row.version}`} class={`og-data__band${i < parts.length - 1 ? ' is-old' : ''}`} d={band(p.points)} />
        ))}
        {parts.map((p, i) => (
          <path key={`l${p.row.version}`} class={`og-data__line${i < parts.length - 1 ? ' is-old' : ''}`} d={line(p.points)} />
        ))}
        <circle class="og-data__last" cx={x(last.step)} cy={y(last.mean)} r="13" />
      </svg>
    </div>
  );
}

/** You and the legal pages: one corner of the medallion tile, in a color per page. */
function CornerArt({ route }: { route: OgRoute }) {
  return (
    <div class={`og-art og-corner og-corner--${route}`}>
      <Medallion class="medallion og-corner__tile" />
    </div>
  );
}

/** Room invite: a table seen from above with four seats, the people with their seal. */
function RoomArt() {
  return (
    <div class="og-art og-room">
      <MedallionLine class="medallion-line og-room__table" />
      <div class="og-seat og-seat--top">
        <Avatar initial="B" />
        <HumanSeal />
      </div>
      <div class="og-seat og-seat--left">
        <Avatar persona="iara" />
        <AiMark />
      </div>
      <div class="og-seat og-seat--right">
        <Avatar initial="C" />
        <HumanSeal />
      </div>
      <div class="og-seat og-seat--bottom">
        <Avatar initial="A" />
      </div>
    </div>
  );
}

function Art({ route }: { route: OgRoute }): ComponentChildren {
  switch (route) {
    case 'start':
      return <StartArt />;
    case 'play':
      return <PlayArt />;
    case 'guided':
      return <GuidedArt />;
    case 'rules':
      return <RulesArt />;
    case 'data':
      return <DataArt />;
    case 'room':
      return <RoomArt />;
    default:
      return <CornerArt route={route} />;
  }
}

function OgImage({ route }: { route: OgRoute }) {
  return (
    <div class={`og og--${route}`}>
      <div class="og-brand">
        <BrandMark class="og-brand__mark" />
        <span>Zap</span>
      </div>
      <h1 class="og-title">{t(TITLE[route])}</h1>
      <p class="og-site">zap.andreiludescher.com</p>
      <Art route={route} />
    </div>
  );
}

/** Shrinks the title until it fits its one line. */
function fitTitle(root: HTMLElement): void {
  const h = root.querySelector<HTMLElement>('.og-title');
  if (!h) return;
  let size = parseFloat(getComputedStyle(h).fontSize);
  while (h.scrollWidth > h.clientWidth && size > 40) {
    size -= 2;
    h.style.fontSize = `${size}px`;
  }
}

const params = new URLSearchParams(location.search);
const route = (OG_ROUTES as readonly string[]).includes(params.get('route') ?? '') ? (params.get('route') as OgRoute) : 'start';
applyLang(params.get('lang') === 'en' ? 'en' : 'pt', false);
const root = document.getElementById('og')!;
render(<OgImage route={route} />, root);
// Load both faces before measuring: fonts.ready alone may settle before layout asks for them.
void Promise.all([document.fonts.load('800 92px "Bricolage Grotesque"'), document.fonts.load('700 26px "Figtree"')])
  .then(() => document.fonts.ready)
  .then(() => {
    fitTitle(root);
    requestAnimationFrame(() => root.setAttribute('data-ready', 'true'));
  });
