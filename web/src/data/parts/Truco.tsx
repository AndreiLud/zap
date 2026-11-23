// Chapter 1 of the plan, the game in numbers (DATA-SPEC 4.6, F10 to F15): exact counts of the deck
// (exact.json) and hands of Zap against Zap (sim.json, run A). One variant control drives F11 to
// F15; it sits in each of those figures' control rows and every copy moves together, so the reader
// never scrolls back to change it. F10 shows both variants.

import { useState } from 'preact/hooks';
import { ladderOf, makeConfig, onzeRunPoints, onzeThreshold, onzeValue } from '../../../../engine/src/config.ts';
import { DECK_SIZE } from '../../../../engine/src/cards.ts';
import { t, type Key } from '../../i18n.ts';
import { DotInterval, refEven } from '../charts/DotInterval.tsx';
import { Figure, Segmented, READY, type TableData } from '../charts/Figure.tsx';
import { Heatmap, stepLabels } from '../charts/Heatmap.tsx';
import { LineBand } from '../charts/LineBand.tsx';
import { stepTicks, widen } from '../charts/scales.ts';
import { Stacked100 } from '../charts/Stacked100.tsx';
import { Waffle } from '../charts/Waffle.tsx';
import { bestCardTitle, breakEvenTitle, cardsTitle, CLASS_THREE, MANILHA_CLASSES, manilhaTitle, pooled, positionTitle, round1Title, say, type ClassRow, type ModeEst } from '../findings.ts';
import { digitsFor, fmt, type Format } from '../format.ts';
import { td } from '../i18n-data.ts';
import { sample } from '../words.ts';
import exactJson from '../generated/exact.json' with { type: 'json' };
import simJson from '../generated/sim.json' with { type: 'json' };
import { breakEvenGrid, reachableScores } from './chapter-data.ts';
import { Chapter, pctCells, tipFor } from './chapter.tsx';

type Variant = 'paulista' | 'mineiro';
type Players = 2 | 4;
const VARIANTS: readonly Variant[] = ['paulista', 'mineiro'];

interface Cell {
  n: number;
  mean: number;
  lo: number;
  hi: number;
}

interface GameSegment {
  matches: number;
  normalHands: number;
  handByBestCard: Cell[];
  firstPlayer: Cell;
  afterRound1: Record<'won' | 'tied' | 'lost', Cell>;
  breakEven: number[][];
}

interface Exact {
  rankLabels: string[];
  manilha: Record<Variant, { p0: number; p1: number; p2: number; p3: number; atLeastOne: number; team: number }>;
  cards: Record<Variant, { beats: number; ties: number; loses: number }[]>;
}

const EXACT = exactJson as unknown as Exact;
const SIM = simJson as unknown as { provenance: { measuredAt: string }; normalHands: number; game: Record<string, GameSegment> };

const seg = (v: Variant, p: Players): GameSegment => SIM.game[`${v}-${p}`];
const simDate = () => Date.parse(SIM.provenance.measuredAt);

/** Hands with a minimum of observations for F12 (DATA-SPEC 4.6). */
const MIN_CLASS_N = 500;

/** The name of a strength class: the rank for 0 to 9, the manilha by suit for 10 to 13. */
export function classLabel(cls: number): string {
  return cls < 10 ? EXACT.rankLabels[cls] : t(`board.manilha.${cls - 10}` as Key);
}

const modeLabel = (p: Players) => t(p === 2 ? 'play.mode.solo' : 'play.mode.dupla');
const variantWord = (v: Variant) => t(v === 'paulista' ? 'data.variant.paulista' : 'data.variant.mineiro');

function VariantControl({ value, onChange }: { value: Variant; onChange: (v: Variant) => void }) {
  return (
    <Segmented
      label={t('data.ctl.variant')}
      value={value}
      options={VARIANTS.map((v) => ({ value: v, label: t(v === 'paulista' ? 'play.v.paulista' : 'play.v.mineiro') }))}
      onChange={onChange}
    />
  );
}

/** The footer of the simulated figures: hands, variant and date. */
function simSource(f: Format, v: Variant): string {
  const hands = seg(v, 2).normalHands + seg(v, 4).normalHands;
  return t('data.src.sim', { hands: f.int(hands), variant: variantWord(v), date: f.date(simDate()) });
}

// ------------------------------------------------------------------------------------------------
// F10 How often you hold a manilha

function Manilha() {
  const f = fmt();
  const m = EXACT.manilha;
  const title = say(f, manilhaTitle({ paulista: { atLeastOne: m.paulista.atLeastOne, team: m.paulista.team }, mineiro: { atLeastOne: m.mineiro.atLeastOne, team: m.mineiro.team } }, f));
  const table: TableData = {
    columns: [
      { label: t('data.th.variant') },
      ...[0, 1, 2, 3].map((k) => ({ label: t('data.f10.th.k', { k: f.int(k) }), numeric: true })),
      { label: t('data.f10.th.team'), numeric: true },
    ],
    rows: VARIANTS.map((v) => [t(v === 'paulista' ? 'play.v.paulista' : 'play.v.mineiro'), f.pct(m[v].p0), f.pct(m[v].p1), f.pct(m[v].p2), f.pct(m[v].p3), f.pct(m[v].team)]),
  };
  const summary = `${title} ${VARIANTS.map((v) => t('data.f10.sum', { variant: variantWord(v), hand: f.pct(m[v].atLeastOne), team: f.pct(m[v].team) })).join(' ')}`;
  return (
    <Figure id="manilha" title={title} sub={td('data.f10.p')} summary={summary} source={t('data.src.exact', { n: f.int(DECK_SIZE) })} table={table} reserve={300}>
      <Waffle
        items={VARIANTS.map((v) => ({
          key: v,
          label: t(v === 'paulista' ? 'play.v.paulista' : 'play.v.mineiro'),
          share: m[v].atLeastOne,
          shareText: f.pct(m[v].atLeastOne),
          shareLabel: t('data.f10.inHand'),
          extra: m[v].team,
          extraText: f.pct(m[v].team),
          extraLabel: t('data.f10.inTeam'),
        }))}
      />
    </Figure>
  );
}

// ------------------------------------------------------------------------------------------------
// F11 How strong each card is

/** A small card shape before a row name; manilhas wear the ochre accent. */
function CardGlyph({ manilha }: { manilha: boolean }) {
  return <rect class={`chap-glyph${manilha ? ' chap-glyph--manilha' : ''}`} x="2" y="2" width="12" height="18" rx="2" />;
}

function CardStrength({ variant, control }: { variant: Variant; control: preact.JSX.Element }) {
  const f = fmt();
  const cards = EXACT.cards[variant];
  const title = say(f, cardsTitle({ beats: cards.map((c) => c.beats), c3: classLabel(CLASS_THREE) }, f));
  const segs = [
    { key: 'beats', label: t('data.f11.beats'), tone: 's1' as const },
    { key: 'ties', label: t('data.f11.ties'), tone: 'neutral' as const },
    { key: 'loses', label: t('data.f11.loses'), tone: 's2' as const },
  ];
  const table: TableData = {
    columns: [{ label: t('data.th.card') }, ...segs.map((s) => ({ label: s.label, numeric: true }))],
    rows: cards.map((c, cls) => [classLabel(cls), f.pct(c.beats), f.pct(c.ties), f.pct(c.loses)]),
  };
  const summary = `${title} ${t('data.f11.sum', { card: classLabel(13), share: f.pct(cards[13].beats) })}`;
  return (
    <Figure
      id="forca-cartas"
      title={title}
      sub={td('data.f11.p')}
      controls={control}
      summary={summary}
      source={t('data.src.f11', { n: f.int(DECK_SIZE), variant: variantWord(variant) })}
      table={table}
      reserve={520}
    >
      <Stacked100
        segments={segs}
        rows={cards.map((c, cls) => ({
          key: `${cls}`,
          label: classLabel(cls),
          values: [c.beats, c.ties, c.loses],
          strong: cls === CLASS_THREE,
          glyph: <CardGlyph manilha={cls >= 10} />,
        }))}
        format={(v) => f.pct(v, 1)}
      />
    </Figure>
  );
}

// ------------------------------------------------------------------------------------------------
// F12 Your three cards and the hand

function classRows(v: Variant, p: Players): ClassRow[] {
  return seg(v, p)
    .handByBestCard.map((c, cls) => ({ cls, n: c.n, mean: c.mean, lo: Math.max(0, c.lo), hi: Math.min(1, c.hi) }))
    .filter((r) => r.n >= MIN_CLASS_N);
}

function BestCard({ variant, control }: { variant: Variant; control: preact.JSX.Element }) {
  const f = fmt();
  const one = classRows(variant, 2);
  const two = classRows(variant, 4);
  const found = bestCardTitle({ one, two, c3: classLabel(CLASS_THREE), mode: modeLabel(2) }, f);
  if (!found) {
    return <Figure id="mao-tres-cartas" title={t('data.f12.none')} sub={td('data.f12.p')} controls={control} summary={t('data.f12.none')} state={{ kind: 'notMeasured' }} />;
  }
  const title = say(f, found.title);
  const classes = [...new Set([...one, ...two].map((r) => r.cls))].sort((a, b) => a - b);
  const toPoint = (r: ClassRow) => ({ x: r.cls, y: r.mean, lo: r.lo, hi: r.hi, detail: [sample(t, f, r.n)] });
  const byCls = (rows: ClassRow[], cls: number) => rows.find((r) => r.cls === cls);
  const table: TableData = {
    columns: [
      { label: t('data.th.card') },
      ...([2, 4] as const).flatMap((p) => [
        { label: t('data.th.modeWon', { mode: modeLabel(p) }), numeric: true },
        { label: t('data.th.modeRange', { mode: modeLabel(p) }), numeric: true },
        { label: t('data.th.modeHands', { mode: modeLabel(p) }), numeric: true },
      ]),
    ],
    rows: [
      ...classes.map((cls) => [
        classLabel(cls),
        ...[one, two].flatMap((rows) => {
          const r = byCls(rows, cls);
          return r ? [...pctCells(f, r, 1), f.int(r.n)] : ['', '', ''];
        }),
      ]),
      // The title's pooled number: every manilha together, per table size.
      [
        t('data.f12.anyManilha'),
        ...[one, two].flatMap((rows) => {
          const man = rows.filter((r) => (MANILHA_CLASSES as readonly number[]).includes(r.cls));
          if (man.length === 0) return ['', '', ''];
          const pm = pooled(man);
          const d = digitsFor(pm.half95);
          return [f.pct(pm.mean, d), f.range(Math.max(0, pm.mean - pm.half95), Math.min(1, pm.mean + pm.half95), d), f.int(pm.n)];
        }),
      ],
    ],
  };
  return (
    <Figure
      id="mao-tres-cartas"
      title={title}
      sub={td('data.f12.p')}
      controls={control}
      legend={[
        { label: modeLabel(2), series: 1, shape: 'circle', line: true },
        { label: modeLabel(4), series: 2, shape: 'square', line: true, dashed: true },
      ]}
      summary={title}
      reading={found.reading ? say(f, found.reading) : undefined}
      source={simSource(f, variant)}
      table={table}
      reserve={340}
    >
      <LineBand
        series={[
          { key: 'one', label: modeLabel(2), series: 1, shape: 'circle', points: one.map(toPoint) },
          { key: 'two', label: modeLabel(4), series: 2, shape: 'square', dashed: true, points: two.map(toPoint) },
        ]}
        x={{ domain: [classes[0], classes[classes.length - 1]], ticks: classes, format: classLabel, label: t('data.f12.x') }}
        y={{ domain: [0, 1], ticks: stepTicks([0, 1], 0.25), format: (v) => f.pct(v, 0) }}
        valueFormat={(v) => f.pct(v, 1)}
        xName={(x) => t('data.f12.point', { card: classLabel(x) })}
        refs={[refEven()]}
        curve="linear"
      />
    </Figure>
  );
}

// ------------------------------------------------------------------------------------------------
// F13 Playing first or last

function Position({ variant, control }: { variant: Variant; control: preact.JSX.Element }) {
  const f = fmt();
  const rows = ([2, 4] as const).map((p) => ({ p, mode: modeLabel(p), ...seg(variant, p).firstPlayer })) as [ModeEst & { p: Players }, ModeEst & { p: Players }];
  const title = say(f, positionTitle(rows, f));
  const domain = widen([0.4, 0.6], rows.flatMap((r) => [r.lo, r.hi]), 0.05);
  const table: TableData = {
    columns: [{ label: t('data.th.mode') }, { label: t('data.th.won'), numeric: true }, { label: t('data.th.interval'), numeric: true }, { label: t('data.th.hands'), numeric: true }],
    rows: rows.map((r) => [modeLabel(r.p), ...pctCells(f, r, 1), f.int(r.n)]),
  };
  return (
    <Figure
      id="posicao"
      title={title}
      sub={td('data.f13.p')}
      controls={control}
      summary={`${title} ${rows.map((r) => `${modeLabel(r.p)}: ${f.pct(r.mean, 1)}.`).join(' ')}`}
      source={simSource(f, variant)}
      table={table}
      reserve={170}
    >
      <DotInterval
        rows={rows.map((r) => ({
          key: `${r.p}`,
          label: modeLabel(r.p),
          marks: [{ series: r.p === 2 ? 1 : 2, shape: r.p === 2 ? 'circle' : 'square', mean: r.mean, lo: r.lo, hi: r.hi, detail: [sample(t, f, r.n)] }],
        }))}
        domain={domain}
        ticks={stepTicks(domain, 0.05)}
        format={(v) => f.pct(v, Math.abs(v * 20 - Math.round(v * 20)) < 1e-9 ? 0 : 1)}
        intervalText={tipFor(f, 1)}
        refs={[{ value: 0.5, label: t('data.f13.ref') }]}
        axisLabel={t('data.f13.axis')}
        smallNote={t('data.f16.small')}
      />
    </Figure>
  );
}

// ------------------------------------------------------------------------------------------------
// F14 The weight of the first round

const ROUND1 = ['won', 'tied', 'lost'] as const;

function FirstRound({ variant, control }: { variant: Variant; control: preact.JSX.Element }) {
  const f = fmt();
  const won = ([2, 4] as const).map((p) => ({ mode: modeLabel(p), ...seg(variant, p).afterRound1.won })) as [ModeEst, ModeEst];
  const title = say(f, round1Title(won, f));
  const table: TableData = {
    columns: [
      { label: t('data.f14.th.round') },
      ...([2, 4] as const).flatMap((p) => [
        { label: t('data.th.modeWon', { mode: modeLabel(p) }), numeric: true },
        { label: t('data.th.modeRange', { mode: modeLabel(p) }), numeric: true },
        { label: t('data.th.modeHands', { mode: modeLabel(p) }), numeric: true },
      ]),
    ],
    rows: ROUND1.map((r) => [
      t(`data.f14.row.${r}` as Key),
      ...([2, 4] as const).flatMap((p) => {
        const c = seg(variant, p).afterRound1[r];
        return [...pctCells(f, c, 1), f.int(c.n)];
      }),
    ]),
  };
  return (
    <Figure
      id="primeira-rodada"
      title={title}
      sub={td('data.f14.p')}
      controls={control}
      legend={[
        { label: modeLabel(2), series: 1, shape: 'circle' },
        { label: modeLabel(4), series: 2, shape: 'square' },
      ]}
      summary={title}
      source={simSource(f, variant)}
      table={table}
      reserve={260}
    >
      <DotInterval
        rows={ROUND1.map((r) => ({
          key: r,
          label: t(`data.f14.row.${r}` as Key),
          marks: ([2, 4] as const).map((p) => {
            const c = seg(variant, p).afterRound1[r];
            return { series: p === 2 ? 1 : 2, shape: p === 2 ? 'circle' : 'square', label: modeLabel(p), mean: c.mean, lo: c.lo, hi: c.hi, value: f.pct(c.mean, 1), detail: [sample(t, f, c.n)] };
          }),
        }))}
        domain={[0, 1]}
        ticks={stepTicks([0, 1], 0.25)}
        format={(v) => f.pct(v, 0)}
        intervalText={tipFor(f, 1)}
        refs={[refEven()]}
        axisLabel={t('data.f14.axis')}
        smallNote={t('data.f16.small')}
      />
    </Figure>
  );
}

// ------------------------------------------------------------------------------------------------
// F15 When accepting a truco pays

function BreakEven({ variant, control }: { variant: Variant; control: preact.JSX.Element }) {
  const f = fmt();
  const [players, setPlayers] = useState<Players>(4);
  const config = makeConfig(variant, players);
  const scores = reachableScores([...ladderOf(config), onzeValue(config), onzeRunPoints(config)], onzeThreshold(config));
  const grid = breakEvenGrid(seg(variant, players).breakEven, scores);
  const found = breakEvenTitle(grid, f);
  const controls = (
    <>
      {control}
      <Segmented
        label={t('data.ctl.players')}
        value={`${players}`}
        options={[
          { value: '2', label: modeLabel(2) },
          { value: '4', label: modeLabel(4) },
        ]}
        onChange={(v) => setPlayers(v === '2' ? 2 : 4)}
      />
    </>
  );
  if (!found) {
    return <Figure id="aceitar-truco" title={t('data.f15.none')} sub={td('data.f15.p')} controls={controls} summary={t('data.f15.none')} state={{ kind: 'notMeasured' }} />;
  }
  const title = say(f, found.title);
  const hands = seg(variant, players).normalHands;
  const table: TableData = {
    columns: [{ label: t('data.f15.th.corner') }, ...scores.map((b) => ({ label: f.int(b), numeric: true }))],
    rows: scores.map((a, i) => [f.int(a), ...grid[i].map((v) => (v === null ? '' : f.pct(v, 0)))]),
  };
  return (
    <Figure
      id="aceitar-truco"
      title={title}
      sub={td('data.f15.p')}
      controls={controls}
      summary={`${title} ${found.reading ? say(f, found.reading) : ''}`}
      state={READY}
      reading={found.reading ? say(f, found.reading) : undefined}
      source={t('data.src.f15', { hands: f.int(hands), variant: variantWord(variant), mode: modeLabel(players) })}
      table={table}
      reserve={480}
    >
      <Heatmap
        rows={scores.map((a) => ({ key: `${a}`, label: f.int(a) }))}
        cols={scores.map((b) => ({ key: `${b}`, label: f.int(b) }))}
        cells={grid.map((row) => row.map((v) => ({ value: v, n: Number.POSITIVE_INFINITY })))}
        format={(v) => f.pct(v, 0)}
        legend={stepLabels(f)}
        rowTitle={t('data.f15.rows')}
        colTitle={t('data.f15.cols')}
        cellName={(i, j) => t('data.f15.cell', { us: f.int(scores[i]), them: f.int(scores[j]) })}
        minN={0}
      />
    </Figure>
  );
}

// ------------------------------------------------------------------------------------------------
// The chapter

export function Truco() {
  const f = fmt();
  const [variant, setVariant] = useState<Variant>('paulista');
  const control = <VariantControl value={variant} onChange={setVariant} />;
  return (
    <Chapter id="truco" title={t('data.truco.h')} lead={td('data.truco.lead', { hands: f.big(SIM.normalHands) })}>
      <Manilha />
      <CardStrength variant={variant} control={control} />
      <BestCard variant={variant} control={control} />
      <Position variant={variant} control={control} />
      <FirstRound variant={variant} control={control} />
      <BreakEven variant={variant} control={control} />
    </Chapter>
  );
}
