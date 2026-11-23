// Part 1, the reading of the opponent during the match (DATA-SPEC 4.5, F5 to F9): what it counts,
// that it starts small and grows with evidence, how much the play changes hand by hand, what it adds
// to the score, and the explorer test with its verdict. Every word about the reading is driven by
// the data (lead's change 2 and _local/m6/claims.md): `reads` picks the "on" or the "test version"
// wording, the explorer criterion decides the verdict, and the gain over the twin is shown apart
// (under F8), next to the reading part, the same network without reading, the distance between two
// twins by chance alone when both trained as long, and the head to head against the twin (claim 6).
// Under F9 the control explorer says how easy the base of the test version is to exploit (claim 9).

import { budget } from '../../../../ai/src/safety.ts';
import { PERSONA_NAMES } from '../../game-text.ts';
import { t, type Key } from '../../i18n.ts';
import { buildBars, type BarDatum } from '../charts/Bars.tsx';
import { Bullet, bulletDomain } from '../charts/Bullet.tsx';
import { DotInterval, refNoGain } from '../charts/DotInterval.tsx';
import { Figure, useChart } from '../charts/Figure.tsx';
import type { Mark } from '../charts/keyboard.ts';
import { buildLines, type Axis, type LineBandProps, type LineSeries } from '../charts/LineBand.tsx';
import { Txt } from '../charts/parts.tsx';
import { niceTicks, stepTicks, symmetricDomain, textWidth, wrapWords } from '../charts/scales.ts';
import { baseFinding, boundNumber, evidenceTitle, explorerTitle, floorTitle, gainTitle, headToHeadTitle, offHeadToHead, readingCurveTitle, say } from '../findings.ts';
import type { Format } from '../format.ts';
import { td } from '../i18n-data.ts';
import { above, excludes, noiseNote, realOrNoise, sample, type Est } from '../words.ts';
import { DERIVED, FACTS, READING, SERVED, ms, upperOf as verdictUpper, useData, type ExplorerVerdict, type Measured, type Span } from '../load.ts';
import { ReadingSimulator } from './ReadingSimulator.tsx';
import { ReadStatus } from './ReadStatus.tsx';

// ------------------------------------------------------------------------------------------------
// Names

const STYLE_IDS = ['raisesAll', 'neverRaises', 'neverRuns', 'runsAll', 'bluffer', 'coversALot', 'trapper', 'coversAll', 'coinFlip', 'rock', 'honest'] as const;

/** A character by name, a scripted style in words, anything else (a version label) as it is. */
export function styleName(id: string): string {
  if (id in PERSONA_NAMES) return PERSONA_NAMES[id as keyof typeof PERSONA_NAMES];
  return (STYLE_IDS as readonly string[]).includes(id) ? t(`data.style.${id}` as Key) : id;
}

const est = (m: Span): Est => ({ mean: m.mean, lo: m.ci95[0], hi: m.ci95[1] });

/** Differences of mean score are said in games per this many (format.ts per100 uses the same base). */
const PER = 100;

/** The confidence of every interval and bound on the page (the glossary's "intervalo de 95%"). */
const CONFIDENCE = 0.95;

/** Signed games per 100 for axes and values: whole numbers without decimals, the rest with one. */
const per100Axis = (f: Format) => (v: number) => f.signed(v, Number.isInteger(v) ? 0 : 1);

// ------------------------------------------------------------------------------------------------
// Panels sharing one x axis (F6, F7): bars or lines, stacked, the plots aligned on the left

type Panel =
  | { kind: 'bars'; title: string; bars: BarDatum[]; y: Axis; height: number; valueFormat: (v: number) => string }
  | ({ kind: 'lines'; title: string; height: number } & Omit<LineBandProps, 'x'>);

function Panels({ panels, x, xName }: { panels: Panel[]; x: Axis; xName?: (x: number) => string }) {
  const { width: W, fs, active, register } = useChart();
  const yLab = (y: Axis) => Math.max(...y.ticks.map((v) => textWidth(y.format(v), 12 * fs))) + 8;
  const left = Math.max(...panels.map((p) => yLab(p.y)));
  // Room on the right for the end labels, at most 30% of the width. A panel that drops a label too
  // wide for that room (its legend names the line) keeps no room for it, only the room the last x
  // label needs past its tick ("12 ou mais" at the right end).
  const ends = panels.flatMap((p) => (p.kind === 'lines' ? p.series.map((s) => ({ text: (s.endLabel === undefined ? s.label : s.endLabel) ?? '', drop: !!p.dropUnfitLabels })) : []));
  const want = (e: { text: string; drop: boolean }) => (e.text ? textWidth(e.text, 12.5 * fs) + 14 : 8);
  const lastX = x.ticks.length ? textWidth(x.format(x.ticks[x.ticks.length - 1]), 12 * fs) / 2 + 2 : 8;
  const right = Math.min(Math.max(8, lastX, ...ends.map((e) => (e.drop && want(e) > W * 0.3 ? 8 : want(e)))), W * 0.3);
  const nodes: preact.JSX.Element[] = [];
  const marks: Mark[] = [];
  let y = 0;
  panels.forEach((p, i) => {
    const last = i === panels.length - 1;
    // Titles and notes wrap to the chart's width: with large text or a long translation they never run out of it.
    for (const [j, line] of wrapWords(p.title, W, 14 * fs).entries()) {
      nodes.push(
        <Txt key={`pt${i}-${j}`} x={0} y={y + 14 * fs} cls="panel-title">
          {line}
        </Txt>,
      );
      y += 18 * fs;
    }
    y += 4 * fs;
    // A band note wider than the plot goes under the panel title instead of inside the plot.
    let panel = p;
    if (p.kind === 'lines' && p.bandNote && textWidth(p.bandNote.text, 12 * fs) > (W - left - right) * 0.8) {
      for (const [j, line] of wrapWords(p.bandNote.text, W, 12 * fs).entries()) {
        nodes.push(
          <Txt key={`pn${i}-${j}`} x={0} y={y + 8 * fs} cls="note">
            {line}
          </Txt>,
        );
        y += 15 * fs;
      }
      y += 1 * fs;
      panel = { ...p, bandNote: undefined };
    }
    const plotH = p.height * Math.max(1, fs * 0.9);
    const h = plotH + 8 + (last ? 20 * fs + (x.label ? 16 * fs : 0) : 4);
    const fx = left - yLab(p.y);
    const frame = { x: fx, y, w: W - fx, h, fs, active, k0: marks.length, yAxis: true, xAxis: last, right, labels: true };
    const out =
      panel.kind === 'bars'
        ? buildBars({ bars: panel.bars, y: panel.y, valueFormat: panel.valueFormat, xLabel: last ? x.label : undefined, allLabels: false }, frame)
        : buildLines({ ...panel, x: { ...x, label: last ? x.label : undefined }, xName }, frame);
    nodes.push(<g key={`p${i}`}>{out.nodes}</g>);
    marks.push(...out.marks.map((m) => ({ ...m, label: `${p.title}, ${m.label}` })));
    y += h + 18 * fs;
  });
  register({ marks, mode: 'xy' });
  const H = Math.ceil(y - 18 * fs + 4);
  return (
    <svg class="plot" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true" focusable="false" style={{ '--fs': String(fs) }}>
      {nodes}
    </svg>
  );
}

// ------------------------------------------------------------------------------------------------
// F6 It starts small and grows with evidence

function Evidence() {
  const { f, reads } = useData();
  const ev = READING.evidence;
  const net = READING.safetyNet;
  const title = net ? say(f, evidenceTitle({ nHalf: net.nHalf, reads }, f)) : t('data.read.f6.h0');
  if (!ev) return <Figure id="leitura-provas" title={title} summary={title} state={{ kind: 'notMeasured' }} />;
  const share = ev.pooled.share;
  const top = share.length - 1;
  const nLabel = (n: number) => (n === top ? t('data.read.orMore', { n: f.int(n) }) : f.int(n));
  const room = (n: number) => (net ? budget(n, net) / net.bmax : 0);
  // In training, the pull back to the play without reading weighs nW / (nW + n): what it leaves free
  // to change grows like the limit at the table, so both lines of the panel rise with evidence.
  const free = (n: number) => n / (ev.nW + n);
  const yTop = Math.max(0.1, Math.ceil(Math.max(...share) * 10) / 10);
  const pct0 = (v: number) => f.pct(v, 0);
  const panels: Panel[] = [
    {
      kind: 'bars',
      title: t('data.read.f6.top'),
      bars: share.map((v, n) => ({ key: `${n}`, label: nLabel(n), value: v, series: 0 })),
      y: { domain: [0, yTop], ticks: stepTicks([0, yTop], 0.1), format: pct0 },
      height: 130,
      valueFormat: (v) => f.pct(v, 1),
    },
  ];
  if (net) {
    panels.push({
      kind: 'lines',
      title: t('data.read.f6.bottom'),
      height: 150,
      series: [
        { key: 'limit', label: t('data.read.f6.limit'), series: 1, points: share.map((_, n) => ({ x: n, y: room(n) })) },
        { key: 'train', label: t('data.read.f6.train'), series: 2, dashed: true, points: share.map((_, n) => ({ x: n, y: free(n) })) },
      ],
      y: { domain: [0, 1], ticks: [0, 0.5, 1], format: pct0 },
      valueFormat: pct0,
      // The legend names both lines; a label with no room on the right would cross the other line.
      dropUnfitLabels: true,
    });
  }
  const reading = [
    t('data.read.f6.read', { zero: f.inTen(share[0]), med: f.int(ev.pooled.medianPositive) }),
    // Claim 8: the allowed change grows with what has been seen, up to a fixed cap.
    net ? t('data.read.f6.grows', { n: f.int(top), p: pct0(room(top)) }) : t('data.state.notMeasured'),
  ].join(' ');
  const who = DERIVED.evidenceModel;
  return (
    <Figure
      id="leitura-provas"
      title={title}
      sub={td('data.read.f6.p')}
      legend={
        net
          ? [
              { label: t('data.read.f6.limit'), series: 1, shape: 'circle', line: true },
              { label: t('data.read.f6.train'), series: 2, shape: 'square', line: true, dashed: true },
            ]
          : undefined
      }
      summary={`${title} ${reading}`}
      reading={reading}
      source={t(who ? 'data.src.f6' : 'data.src.f6.zap', { v: who ?? '', bets: f.int(ev.pooled.betDecisions), date: f.date(ms(ev.measuredAt)) })}
      table={{
        columns: [
          { label: t('data.th.evidence') },
          { label: t('data.th.decShare'), numeric: true },
          ...(net ? [{ label: t('data.read.f6.limit'), numeric: true }, { label: t('data.read.f6.train'), numeric: true }] : []),
        ],
        rows: share.map((v, n) => [nLabel(n), f.pct(v, 1), ...(net ? [pct0(room(n)), pct0(free(n))] : [])]),
      }}
      reserve={420}
    >
      <Panels panels={panels} x={{ domain: [-0.5, top + 0.5], ticks: share.map((_, n) => n), format: nLabel, label: t('data.read.f6.x') }} xName={(n) => t('data.read.f6.xName', { n: nLabel(n) })} />
    </Figure>
  );
}

// ------------------------------------------------------------------------------------------------
// F7 How much its play changes, hand by hand

const HANDS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10+'] as const;

export interface CurveHand {
  hand: number;
  mean: number;
  lo: { id: string; v: number };
  hi: { id: string; v: number };
  meanN: number;
  decisions: number;
}

/** Per hand of the match: the mean over the styles weighted by decisions, and the extremes. Pure. */
export function readingByHand(styles: NonNullable<typeof READING.readingCurve>['styles']): CurveHand[] {
  const ids = Object.keys(styles);
  return HANDS.flatMap((h, i) => {
    const rows = ids.flatMap((id) => (styles[id].bet[h] ? [{ id, ...styles[id].bet[h] }] : []));
    const n = rows.reduce((s, r) => s + r.decisions, 0);
    if (!rows.length || n <= 0) return [];
    const by = [...rows].sort((a, b) => a.changedShare - b.changedShare);
    return [
      {
        hand: i + 1,
        mean: rows.reduce((s, r) => s + r.changedShare * r.decisions, 0) / n,
        lo: { id: by[0].id, v: by[0].changedShare },
        hi: { id: by[by.length - 1].id, v: by[by.length - 1].changedShare },
        meanN: rows.reduce((s, r) => s + r.meanN * r.decisions, 0) / n,
        decisions: n,
      },
    ];
  });
}

function ReadingCurve() {
  const { f, reads } = useData();
  const rc = READING.readingCurve;
  if (!rc) {
    const title = t('data.read.f7.h0');
    return <Figure id="leitura-curva" title={title} summary={title} state={{ kind: 'notMeasured' }} />;
  }
  const rows = readingByHand(rc.styles);
  const k = Object.keys(rc.styles).length;
  const last = rows.length;
  const title = say(f, readingCurveTitle({ values: rows.map((r) => r.mean), decisions: rows.map((r) => r.decisions), reads }, f));
  const handLabel = (h: number) => (h === last && HANDS[h - 1]?.endsWith('+') ? t('data.read.orMore', { n: f.int(h) }) : f.int(h));
  const yMax = Math.max(0.05, Math.ceil(Math.max(...rows.map((r) => r.hi.v)) * 20) / 20);
  const nMax = Math.max(1, Math.ceil(Math.max(...rows.map((r) => r.meanN))));
  const pct = (v: number) => f.pct(v, 1);
  // The band is a spread across styles, measured on few decisions per style in the late hands: say
  // so where a style has fewer than a thousand decisions, so the band is not read as exact.
  const thin = [...rows].sort((a, b) => a.decisions - b.decisions)[0];
  const perStyle = thin ? thin.decisions / k : Infinity;
  const reading = perStyle < 1000 ? t('data.read.f7.few', { h: handLabel(thin.hand), n: f.int(Math.round(perStyle / 10) * 10) }) : undefined;
  const panels: Panel[] = [
    {
      kind: 'lines',
      title: t('data.read.f7.top'),
      height: 170,
      series: [
        {
          key: 'mean',
          label: t('data.read.f7.mean'),
          series: 1,
          points: rows.map((r) => ({
            x: r.hand,
            y: r.mean,
            lo: r.lo.v,
            hi: r.hi.v,
            detail: [t('data.read.f7.ends', { lo: styleName(r.lo.id), hi: styleName(r.hi.id) }), sample(t, f, r.decisions)],
          })),
        },
      ],
      y: { domain: [0, yMax], ticks: stepTicks([0, yMax], yMax > 0.1 ? 0.05 : 0.02), format: (v) => f.pct(v, 0) },
      valueFormat: pct,
      intervalText: (lo, hi) => t('data.read.f7.range', { lo: pct(lo), hi: pct(hi) }),
      bandNote: { x: Math.max(1, last - 2), text: t('data.read.f7.band') },
      // The legend names the line; an end label with no room on the right would cross the band and the axis.
      dropUnfitLabels: true,
    },
    {
      kind: 'lines',
      title: t('data.read.f7.bottom'),
      height: 90,
      series: [{ key: 'n', label: t('data.read.f7.n'), series: 0, endLabel: null, points: rows.map((r) => ({ x: r.hand, y: r.meanN })) }],
      y: { domain: [0, nMax], ticks: niceTicks([0, nMax], 3), format: (v) => f.int(v) },
      valueFormat: (v) => f.num(v, 1),
    },
  ];
  return (
    <Figure
      id="leitura-curva"
      title={title}
      sub={td('data.read.f7.p')}
      legend={[{ label: t('data.read.f7.mean'), series: 1, shape: 'circle', line: true }]}
      summary={reading ? `${title} ${reading}` : title}
      reading={reading}
      source={t('data.src.f7', { matches: f.int(rc.matchesPerSegment), k: f.int(k), date: f.date(ms(rc.measuredAt)) })}
      table={{
        columns: [
          { label: t('data.th.hand') },
          { label: t('data.read.f7.mean'), numeric: true },
          { label: t('data.th.least') },
          { label: t('data.th.most') },
          { label: t('data.read.f7.n'), numeric: true },
          { label: t('data.th.decisions'), numeric: true },
        ],
        rows: rows.map((r) => [handLabel(r.hand), pct(r.mean), `${styleName(r.lo.id)}: ${pct(r.lo.v)}`, `${styleName(r.hi.id)}: ${pct(r.hi.v)}`, f.num(r.meanN, 1), f.int(r.decisions)]),
      }}
      reserve={400}
    >
      <Panels panels={panels} x={{ domain: [1, last], ticks: rows.map((r) => r.hand), format: handLabel, label: t('data.read.f7.x') }} xName={(h) => t('data.read.f7.xName', { h: handLabel(h) })} />
    </Figure>
  );
}

// ------------------------------------------------------------------------------------------------
// F8 What reading adds to the score

function Gain() {
  const { f, reads } = useData();
  const ps = READING.perStyle;
  if (!ps) {
    const title = t('data.read.f8.h0');
    return <Figure id="leitura-ganho" title={title} summary={title} state={{ kind: 'notMeasured' }} />;
  }
  const all = ps.pooled.allStyles;
  const pooledEst = est(all.gainVsAblated);
  const title = say(f, gainTitle({ est: pooledEst, reads }, f));
  const styles = Object.entries(ps.styles).sort((a, b) => b[1].gainVsAblated.mean - a[1].gainVsAblated.mean);
  const ends = styles.flatMap(([, s]) => s.gainVsAblated.ci95.map((v) => v * 100));
  const domain = symmetricDomain(ends, 1, 2);
  const ticks = stepTicks(domain, 1);
  const axis = per100Axis(f);
  const words = t(realOrNoise(pooledEst));
  const readingText = `${t('data.read.f8.read', { range: f.per100Range(pooledEst.lo, pooledEst.hi), words })}${reads ? '' : ` ${t('data.read.f8.candidate')}`}`;
  const twinCell = (m: Span | undefined) => (m ? `${f.signed(m.mean * 100, 1)} (${t('data.fmt.range', { a: f.signed(m.ci95[0] * 100, 1), b: f.signed(m.ci95[1] * 100, 1) })})` : '');
  return (
    <Figure
      id="leitura-ganho"
      title={title}
      sub={td('data.read.f8.p', { base: f.int(PER) })}
      legend={[
        { label: t('data.read.f8.trained'), series: 1, shape: 'circle' },
        { label: t('data.lab.neverSeen'), series: 1, shape: 'diamond' },
        { label: t('data.lab.noise'), series: 1, shape: 'circle', open: true },
      ]}
      summary={`${title} ${readingText}`}
      reading={readingText}
      source={td('data.src.f8', { pairs: f.int(ps.pairsPerSegment), date: f.date(ms(ps.measuredAt)) })}
      table={{
        columns: [
          { label: t('data.th.style') },
          { label: t('data.th.gain'), numeric: true },
          { label: t('data.th.vsTwin'), numeric: true },
          { label: t('data.th.offVsTwin'), numeric: true },
          { label: t('data.th.pairs'), numeric: true },
        ],
        rows: [
          ...styles.map(([id, s]) => [
            `${styleName(id)}${s.heldOut ? ` (${t('data.lab.neverSeen')})` : ''}`,
            twinCell(s.gainVsAblated),
            twinCell(s.gainVsTwin),
            twinCell(s.ablatedVsTwin),
            f.int(s.gainVsAblated.pairs),
          ]),
          [t('data.read.f8.allRow'), twinCell(all.gainVsAblated), twinCell(all.gainVsTwin), twinCell(all.ablatedVsTwin), f.int(all.gainVsAblated.pairs)],
          ...(floorOf() ? [[t('data.read.f8.floorRow'), '', twinCell(floorOf()), '', f.int(floorOf()!.pairs)]] : []),
        ],
      }}
      reserve={560}
    >
      <DotInterval
        rows={styles.map(([id, s]) => {
          const e = est(s.gainVsAblated);
          const noise = !excludes(e);
          const note = [s.heldOut ? t('data.read.f8.newNote') : null, noise ? noiseNote(t) : null].filter((x): x is string => !!x).join(', ');
          return {
            key: id,
            label: styleName(id),
            note: note || undefined,
            marks: [
              {
                series: 1,
                shape: s.heldOut ? 'diamond' : 'circle',
                open: noise,
                mean: e.mean * 100,
                lo: e.lo * 100,
                hi: e.hi * 100,
                value: f.signed(e.mean * 100, 1),
                detail: [t('data.fig.sample', { n: f.int(s.gainVsAblated.pairs) })],
              },
            ],
          };
        })}
        domain={domain}
        ticks={ticks}
        format={axis}
        refs={[refNoGain()]}
        axisLabel={t('data.read.f8.axis', { base: f.int(PER) })}
      />
    </Figure>
  );
}

// ------------------------------------------------------------------------------------------------
// Under F8: the test version against its twin (claim 6). The twin is trained the same way with no
// reading. Against the styles: the gap to the twin, the part of it that is reading, the same network
// without reading, and the seed floor when the two twins trained for as long. Head to head, when it
// measured the same file: whether the test version is stronger than its twin overall.

/** The second twin against the twin is a seed floor only when both twins trained for as long. */
export function floorOf(): Measured | undefined {
  const ps = READING.perStyle;
  const it = ps?.twinIterations;
  return ps?.pooled.allStyles.seedFloor && (!it || it.twin === it.twin2) ? ps.pooled.allStyles.seedFloor : undefined;
}

function Floor() {
  const { f, reads, served } = useData();
  const all = READING.perStyle?.pooled.allStyles;
  if (!all) return null;
  const floor = floorOf();
  const h2h = DERIVED.headToHeadJudged ? READING.headToHead?.rows['adaptive-twin'] : undefined;
  if (!floor && !h2h) return null;
  const rows = [
    { key: 'twin', label: t('data.read.floor.row.twin'), m: all.gainVsTwin },
    { key: 'read', label: t('data.read.floor.row.read'), m: all.gainVsAblated },
    ...(floor ? [{ key: 'floor', label: t('data.read.floor.row.floor'), m: floor }] : []),
  ];
  const noiseFound = floorTitle({ twin: est(all.gainVsTwin), read: est(all.gainVsAblated), rest: est(all.ablatedVsTwin), floor: floor ? est(floor) : null });
  const noise = noiseFound.key === 'data.read.floor.h.noise';
  const found = h2h ? headToHeadTitle(est(h2h), f) : noiseFound;
  const title = say(f, found);
  // "The twin is the version that plays today" only when the build checked that it is the served file.
  const twinInPlay = !reads && DERIVED.twinServed === true && served === FACTS.ai.bootstrapModel.version;
  // The same file with the reading off, head to head against the twin: what an opted out table faces.
  const off = h2h ? READING.headToHead?.rows['ablated-twin'] : undefined;
  const reading = [
    t(twinInPlay ? 'data.read.floor.twin.served' : reads ? 'data.read.floor.twin.on' : 'data.read.floor.twin.test', { v: served, twin: f.per100(all.gainVsTwin.mean) }),
    t(noise ? 'data.read.floor.read.only' : 'data.read.floor.read', { read: f.per100(all.gainVsAblated.mean) }),
    floor ? t(noise ? 'data.read.floor.rest.noise' : 'data.read.floor.rest', { floor: f.per100(floor.mean) }) : '',
    off ? say(f, offHeadToHead(est(off), f)) : '',
  ]
    .filter(Boolean)
    .join(' ');
  const ends = rows.flatMap((r) => r.m.ci95.map((v) => v * 100));
  // Zero stays off the left edge, so its label sits clear of the row names.
  const domain: [number, number] = [Math.min(-0.5, Math.floor(Math.min(...ends))), Math.max(1, Math.ceil(Math.max(...ends)))];
  const cell = (m: Measured) => [f.signed(m.mean * 100, 1), t('data.fmt.range', { a: f.signed(m.ci95[0] * 100, 1), b: f.signed(m.ci95[1] * 100, 1) })];
  return (
    <Figure
      id="leitura-gemea"
      title={title}
      sub={
        <>
          {td('data.read.floor.p', { base: f.int(PER) })}
          {/* The twin of this test is not the served file (checked by the build): say so, so its title is not read as a verdict on the version in play. */}
          {DERIVED.twinServed === false ? ` ${t('data.read.floor.notServed', { v: served })}` : null}
        </>
      }
      summary={`${title} ${reading}`}
      reading={reading}
      source={td('data.src.f8', { pairs: f.int(READING.perStyle!.pairsPerSegment), date: f.date(ms(READING.perStyle!.measuredAt)) })}
      table={{
        columns: [{ label: t('data.th.comparison') }, { label: t('data.th.per100', { base: f.int(PER) }), numeric: true }, { label: t('data.th.interval'), numeric: true }, { label: t('data.th.pairs'), numeric: true }],
        rows: rows.map((r) => [r.label, ...cell(r.m), f.int(r.m.pairs)]),
      }}
      reserve={280}
    >
      <DotInterval
        rows={rows.map((r) => ({
          key: r.key,
          label: r.label,
          strong: r.key === 'read',
          marks: [{ series: 1, mean: r.m.mean * 100, lo: r.m.ci95[0] * 100, hi: r.m.ci95[1] * 100, value: f.signed(r.m.mean * 100, 1), detail: [t('data.fig.sample', { n: f.int(r.m.pairs) })] }],
        }))}
        domain={domain}
        ticks={stepTicks(domain, domain[1] - domain[0] > 4 ? 1 : 0.5)}
        format={per100Axis(f)}
        refs={[refNoGain()]}
        axisLabel={t('data.read.f8.axis', { base: f.int(PER) })}
      />
    </Figure>
  );
}

// ------------------------------------------------------------------------------------------------
// F9 The explorer test

interface Row {
  key: string;
  label: string;
  desc: string;
  v: ExplorerVerdict;
  /** The scripted search it came from. Every verdict judged the same file, so every row has its safety net. */
  attempt?: number;
}

/**
 * a>b@k/partner, or a>b@ek/partner when the switch waits for k pieces of evidence (ai/src/styles.ts
 * explorerLabel). The other shapes (back and forth, three phases, a partner on its own schedule) are
 * not read: their rows keep no description.
 */
export function parseExplorer(s: string): { a: string; b: string; k: number; trigger: 'hand' | 'evidence'; partner: string } | null {
  const m = /^(\w+)>(\w+)@(e?)(\d+)\/(\w+)$/.exec(s);
  return m ? { a: m[1], b: m[2], k: Number(m[4]), trigger: m[3] ? 'evidence' : 'hand', partner: m[5] } : null;
}

/**
 * When an explorer switches style, as the page words it. A hand trigger compares the engine's
 * handIndex, which counts from 0, with k (ai/src/styles.ts phaseAt, x >= k), so the switch comes on
 * hand k + 1 when hands are numbered from 1, as F7 numbers them. An evidence trigger counts pieces
 * of evidence, which need no shift.
 */
export function switchPoint(k: number, trigger: 'hand' | 'evidence'): { key: Key; k: number } {
  return trigger === 'evidence' ? { key: 'data.read.f9.whenEvidence', k } : { key: 'data.read.f9.whenHand', k: k + 1 };
}

function when(f: Format, k: number, trigger: 'hand' | 'evidence'): string {
  const s = switchPoint(k, trigger);
  return t(s.key, { k: f.int(s.k) });
}

function describe(f: Format, explorer: string): string {
  const e = parseExplorer(explorer);
  return e ? t('data.read.f9.desc', { a: styleName(e.a), b: styleName(e.b), when: when(f, e.k, e.trigger) }) : '';
}

/**
 * Under F9, the control explorer (claim 9), outside the rule: how much more an explorer trained
 * against the test version takes from it as served than the control takes from the twin, pair by
 * pair on the same new deals, with what makes the comparison less clean and what the reading costs
 * the trained explorer. Said only when it measured the file the criterion judges.
 */
function controlWords(f: Format): string[] {
  const fr = READING.explorer?.control?.fresh;
  if (!fr || !DERIVED.controlJudged) return [];
  const trained = READING.explorer?.criterion?.verdicts.trained;
  return [
    say(f, baseFinding(est(fr.asServed), f)),
    DERIVED.controlMeasuredOnOwn === false ? t('data.read.f9.base.caveat') : '',
    trained && verdictUpper(trained) < 0 ? t('data.read.f9.base.cost', { cost: f.per100(-trained.adaptationPart.mean) }) : '',
  ];
}

/**
 * The first search of the explorer test, after which the old rule changed: the smallest attempt the
 * facts name, counting the searches that later attempts measured again on a newer file.
 */
export function firstSearch(ex: NonNullable<typeof READING.explorer>): number {
  return Math.min(...ex.attempts.map((a) => a.attempt), ...(ex.criterion?.verdicts.scripted ?? []).map((a) => a.remeasureOf?.attempt ?? a.attempt));
}

function Explorer() {
  const { f, reads, served } = useData();
  const ex = READING.explorer;
  const c = ex?.criterion;
  if (!ex || !c) {
    const title = t('data.read.f9.h0');
    return <Figure id="leitura-explorador" title={title} summary={title} state={{ kind: 'notMeasured' }} />;
  }
  // Claim 9: the trained explorer trained against a file with a larger limit than the one judged.
  const against = ex.trained?.training?.against?.adapt.bmax;
  const judged = c.servedModel?.adapt.bmax;
  const trainedLarger = against !== undefined && judged !== undefined && against > judged;
  const rows: Row[] = [
    ...c.verdicts.scripted.flatMap((a) =>
      a.explorers.map((v, j) => {
        // A search's explorer measured again on a later file keeps the number of the search that found it.
        const found = a.remeasureOf?.attempt ?? a.attempt;
        // "From outside training at the time": the family that search knew. Measured again on a file
        // trained on a larger family, that explorer may now play inside it.
        const label = j > 0 ? 'data.read.f9.row.outside' : a.remeasureOf ? 'data.read.f9.row.again' : 'data.read.f9.row.search';
        return {
          key: `s${a.attempt}-${j}`,
          label: t(label, { a: f.int(found) }),
          desc: describe(f, v.explorer),
          v,
          attempt: found,
        };
      }),
    ),
    ...(c.verdicts.trained ? [{ key: 'trained', label: t('data.read.f9.row.trained'), desc: t(trainedLarger ? 'data.read.f9.desc.trained.larger' : 'data.read.f9.desc.trained'), v: c.verdicts.trained }] : []),
    // Explorers trained for an earlier file, measured against this one.
    ...(c.verdicts.otherTrained ?? []).map((v, i) => {
      const larger = (v.trainedAgainst?.adapt.bmax ?? 0) > (judged ?? Infinity);
      return { key: `other-${i}`, label: t('data.read.f9.row.otherTrained'), desc: t(larger ? 'data.read.f9.desc.trained.larger' : 'data.read.f9.desc.trained'), v };
    }),
    // The label names the bundled file when the build checked the control trained against it (not the twin of this test).
    ...(c.verdicts.control
      ? [{ key: 'control', label: t(DERIVED.controlTrainedOnServed ? 'data.read.f9.row.controlOn' : 'data.read.f9.row.control', { v: FACTS.ai.bootstrapModel.version }), desc: t('data.read.f9.desc.control'), v: c.verdicts.control }]
      : []),
  ];
  const upperOf = (r: Row) => verdictUpper(r.v);
  // The title names the explorer that gets the most out of the reading: the largest one sided bound.
  const worst = [...rows].sort((a, b) => upperOf(b) - upperOf(a))[0];
  // With a reading version in play that this criterion did not judge (a later one the cycle's own
  // explorer step passed), the verdicts below are of the file the criterion judged: say which.
  const other = reads && !(served === SERVED.version && SERVED.judged) && SERVED.criterionSha;
  const title = say(f, explorerTitle({ pass: c.pass, upper95: upperOf(worst), mean: worst.v.adaptationPart.mean, requirement: c.requirement, reads, n: rows.length }, f)) + (other ? ` ${t('data.read.f9.of', { date: f.date(ms(c.measuredAt)), sha: other })}` : '');
  const aimed = rows.filter((r) => r.key !== 'control');
  const failOld = aimed.filter((r) => !r.v.passTwinRule).length;
  const firstAttempt = firstSearch(ex);
  const lastAttempt = ex.attempts[ex.attempts.length - 1]?.attempt ?? firstAttempt;
  // The reading names the scripted explorer that gets the most out of the reading (the title's bound).
  const top = rows.filter((r) => r.attempt !== undefined && parseExplorer(r.v.explorer)).sort((a, b) => upperOf(b) - upperOf(a))[0];
  const oldLim = f.per100(ex.requirement);
  const reading = [
    top ? t('data.read.f9.read', { a: f.int(top.attempt ?? lastAttempt), desc: describe(f, top.v.explorer) }) : '',
    t(failOld === 0 ? 'data.read.f9.history.none' : failOld === 1 ? 'data.read.f9.history.one' : 'data.read.f9.history', { lim: oldLim, first: f.int(firstAttempt), k: f.int(failOld), n: f.int(aimed.length) }),
    ...controlWords(f),
  ]
    .filter(Boolean)
    .join(' ');
  const axis = per100Axis(f);
  const lim = c.requirement * 100;
  // A bound next to the limit keeps two decimals, rounded away from it, so it never reads as the limit.
  const upperText = (r: Row) => boundNumber(f, upperOf(r), c.requirement, true);
  const verdict = (pass: boolean) => t(pass ? 'data.read.f9.pass' : 'data.read.f9.fails');
  const note = (r: Row) => t('data.read.f9.note', { verdict: verdict(r.v.pass), up: upperText(r) });
  const pairs = ex.attempts[ex.attempts.length - 1]?.pairsPerSegment;
  const domain = bulletDomain(rows.map((r) => upperOf(r) * 100), rows.map((r) => r.v.adaptationPart.ci95[0] * 100));
  return (
    <Figure
      id="leitura-explorador"
      title={title}
      sub={td('data.read.f9.p', { n: f.int(ex.grid.size), lim: f.per100(c.requirement) })}
      summary={`${title} ${reading}`}
      reading={reading}
      source={pairs ? td('data.src.f9', { pairs: f.int(pairs), date: f.date(ms(c.measuredAt)) }) : undefined}
      table={{
        columns: [
          { label: t('data.th.explorer') },
          { label: t('data.th.plays') },
          { label: t('data.th.fromReading'), numeric: true },
          { label: t('data.th.atMost'), numeric: true },
          { label: t('data.th.result') },
          { label: t('data.th.oldRule') },
        ],
        rows: rows.map((r) => {
          const a = r.v.adaptationPart;
          return [
            r.label,
            r.desc,
            `${f.signed(a.mean * 100, 1)} (${t('data.fmt.range', { a: f.signed(a.ci95[0] * 100, 1), b: f.signed(a.ci95[1] * 100, 1) })})`,
            upperText(r),
            verdict(r.v.pass),
            `${verdict(r.v.passTwinRule)} (${f.signed(r.v.gainOverTwin.upper95 * 100, 1)})`,
          ];
        }),
      }}
      reserve={460}
    >
      <Bullet
        rows={rows.map((r) => {
          const a = r.v.adaptationPart;
          return {
            key: r.key,
            label: r.label,
            note: note(r),
            series: r.key === 'control' ? 0 : 2,
            mean: a.mean * 100,
            lo: a.ci95[0] * 100,
            hi: a.ci95[1] * 100,
            upper: upperOf(r) * 100,
            upperText: upperText(r),
            detail: r.desc ? [r.desc] : [],
          };
        })}
        domain={domain}
        ticks={stepTicks(domain, 1)}
        format={axis}
        limit={lim}
        zeroLabel={t('data.read.f9.zero')}
        upperKey={t('data.read.f9.atMostKey', { p: f.pct(CONFIDENCE, 0) })}
        axisLabel={t('data.read.f9.axis', { base: f.int(PER) })}
      />
    </Figure>
  );
}

// ------------------------------------------------------------------------------------------------
// The section

export function Reading() {
  const { reads } = useData();
  return (
    <section id="leitura" class="dp-part" aria-labelledby="leitura-h">
      <h2 id="leitura-h" class="dp-part__h" tabIndex={-1}>
        {t(reads ? 'data.read.h' : 'data.read.h.test')}
      </h2>
      <p class="dp-lead dp-part__lead">{t(reads ? 'data.read.lead' : 'data.read.lead.test')}</p>
      <ReadStatus />
      <ReadingSimulator />
      <Evidence />
      <ReadingCurve />
      <Gain />
      <Floor />
      <Explorer />
    </section>
  );
}
