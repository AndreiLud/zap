// Chapter 2 of the plan, how the AI progressed (DATA-SPEC 4.7, F16 to F19): strength by version
// against the fixed rivals, people against Zap, people's data against the twin and the version
// history. F16 and F19 draw from facts.json at once and add what the summary brings; F17 and F18
// live on the summary and show their waiting, empty and unavailable states until it has numbers.

import { t, type Key } from '../../i18n.ts';
import { DotInterval, refEven } from '../charts/DotInterval.tsx';
import { Figure, type FigureState, type LegendItem, type TableData } from '../charts/Figure.tsx';
import { Hero } from '../charts/Hero.tsx';
import { SmallMultiples } from '../charts/SmallMultiples.tsx';
import { stepTicks, widen } from '../charts/scales.ts';
import { historyTitle, peopleTitle, rivalName, rivalsTitleVersions, say, twinTitle } from '../findings.ts';
import { digitsFor, fmt, halfWidth, type Format } from '../format.ts';
import { td } from '../i18n-data.ts';
import { sample, wilson, type Est } from '../words.ts';
import {
  historyItems,
  modeRows,
  modesTitle,
  RIVALS,
  servedVersion,
  summaryOf,
  twinRows,
  versionSeries,
  versionStrengths,
  weekSeries,
  weeksTitle,
  type HistoryItem,
  type ModeRow,
  type Rival,
  type SummaryLoad,
  type VersionStrength,
} from './chapter-data.ts';
import { useData } from '../load.ts';
import { Chapter, FV, pctCells, PlayLink, RULES, tipFor, waitState } from './chapter.tsx';
import type { SummaryV2 } from '../../../../shared/cycle-formats.ts';

const modeLabel = (p: 2 | 4) => t(p === 2 ? 'play.mode.solo' : 'play.mode.dupla');
const variantWord = (v: 'paulista' | 'mineiro') => t(v === 'paulista' ? 'data.variant.paulista' : 'data.variant.mineiro');
const digitsOf = (e: Est) => (digitsFor(halfWidth(e.lo, e.hi)) === 1 ? 1 : 0);

/** The footer of figures read from the summary. */
const summarySource = (f: Format, s: SummaryV2) => t('data.src.summary', { date: f.date(s.generatedAt) });

// ------------------------------------------------------------------------------------------------
// F16 Strength against fixed rivals

function Rivals({ inPlay, summary }: { inPlay: string; summary: SummaryV2 | null }) {
  const f = fmt();
  const versions = versionStrengths(FV, summary);
  const sub = td('data.f16.p', { even: f.pct(0.5, 0) });
  if (versions.length === 0) return <Figure id="forca-versoes" title={t('data.f16.none')} sub={sub} summary={t('data.f16.none')} state={{ kind: 'notMeasured' }} />;
  // facts.json holds v1 and v2 for good, so the spec's day 1 form (one version) cannot come back.
  return <RivalsVersions inPlay={inPlay} sub={sub} versions={versions} />;
}

/** One row per rival, one mark per version (DATA-SPEC F16 "from two versions on"). */
function RivalsVersions({ inPlay, sub, versions }: { inPlay: string; sub: preact.ComponentChildren; versions: VersionStrength[] }) {
  const f = fmt();
  const labels = versions.map((v) => v.version);
  const look = versionSeries(labels, inPlay);
  const current = versions.find((v) => v.version === inPlay) ?? null;
  const found = current ? rivalsTitleVersions({ version: inPlay, rows: RIVALS.flatMap((r) => (current.rows[r] ? [{ id: r, est: current.rows[r]! }] : [])) }, f) : null;
  const title = found ? say(f, found) : t('data.f16.h.noInPlay', { v: inPlay });
  // Newest first inside a row, so the version in play leads.
  const ordered = [...versions].reverse();
  const legend: LegendItem[] = [...ordered].sort((a, b) => Number(b.version === inPlay) - Number(a.version === inPlay)).flatMap((v) => {
    const s = look.get(v.version)!;
    return s.labeled ? [{ label: v.version === inPlay ? t('data.f16.inPlay', { v: v.version }) : v.version, series: s.series, shape: s.shape }] : [];
  });
  const all = versions.flatMap((v) => Object.values(v.rows).flatMap((e) => (e ? [e.lo, e.hi] : [])));
  const domain = widen([0.5, 1], all, 0.1);
  const table: TableData = {
    columns: [{ label: t('data.th.rival') }, ...ordered.flatMap((v) => [{ label: v.version, numeric: true }, { label: t('data.th.versionRange', { v: v.version }), numeric: true }])],
    rows: RIVALS.map((r) => [
      t('data.f16.against', { rival: rivalName(f, r) }),
      ...ordered.flatMap((v) => {
        const e = v.rows[r];
        return e ? pctCells(f, e, 1) : [t('data.lab.noData'), ''];
      }),
    ]),
  };
  const src = current ?? versions[versions.length - 1];
  const source =
    src.source === 'facts'
      ? t('data.src.f16', { pairs: f.int(src.pairs ?? 0), date: f.date(src.measuredAt ?? 0) })
      : t('data.src.f16.gate', { v: src.version, date: f.date(src.measuredAt ?? 0) });
  return (
    <Figure id="forca-versoes" title={title} sub={sub} legend={legend.length > 1 ? legend : undefined} summary={title} source={source} table={table} reserve={360}>
      <DotInterval
        rows={RIVALS.flatMap((r) => {
          const marks = ordered.flatMap((v) => {
            const e = v.rows[r];
            if (!e) return [];
            const s = look.get(v.version)!;
            return [{ series: s.series, shape: s.shape, label: v.version, mean: e.mean, lo: e.lo, hi: e.hi, value: f.pct(e.mean, digitsOf(e)) }];
          });
          return marks.length ? [{ key: r, label: t('data.f16.against', { rival: rivalName(f, r) }), marks }] : [];
        })}
        domain={domain}
        ticks={stepTicks(domain, 0.1)}
        format={(x) => f.pct(x, 0)}
        intervalText={tipFor(f, 1)}
        refs={[refEven()]}
        axisLabel={t('data.f16.axis')}
        smallNote={t('data.f16.small')}
      />
    </Figure>
  );
}

// ------------------------------------------------------------------------------------------------
// F17 People against Zap

function PeopleScore({ load }: { load: SummaryLoad }) {
  const f = fmt();
  const wait = waitState(load);
  const s = summaryOf(load);
  const subOf = (since: number | null) => (since ? t('data.f17.p', { since: f.date(since) }) : t('data.f17.p.always'));
  if (wait || !s) {
    // Before the first summary: when it comes, what goes into it, and a way to take part.
    const state: FigureState = wait ?? {
      kind: 'empty',
      message: `${t('data.f17.wait')} ${t('data.f17.emptyMsg')}`,
      extra: <PlayLink testid="data-f17-play" />,
    };
    const title = t(wait ? 'data.f17.h.wait' : 'data.f17.h.pending');
    return <Figure id="placar-pessoas" title={title} sub={subOf(null)} summary={title} state={state} plain />;
  }
  const h = s.humansVsZap;
  const found = peopleTitle(h, f);
  const title = say(f, found.title);
  if (h.matches <= 0) {
    return (
      <Figure
        id="placar-pessoas"
        title={title}
        sub={subOf(h.since)}
        summary={title}
        state={{ kind: 'empty', message: t('data.f17.emptyMsg'), extra: <PlayLink testid="data-f17-play" /> }}
        source={summarySource(f, s)}
        plain
      />
    );
  }
  const e = wilson(h.humanWins, h.matches);
  return (
    <Figure id="placar-pessoas" title={title} sub={subOf(h.since)} summary={`${title} ${found.reading ?? ''}`} source={summarySource(f, s)} plain>
      <Hero value={f.pct(e.mean, digitsOf(e))} label={t('data.f17.label')} share={e} series={3} detail={found.reading} />
    </Figure>
  );
}

const modeName = (r: ModeRow) =>
  r.partnerVersion
    ? t('data.f17.row.partner', { variant: variantWord(r.variant), mode: modeLabel(r.players), v: r.aiVersion, partner: r.partnerVersion })
    : t('data.f17.row', { variant: variantWord(r.variant), mode: modeLabel(r.players), v: r.aiVersion });

function PeopleByMode({ load }: { load: SummaryLoad }) {
  const f = fmt();
  const wait = waitState(load);
  const s = summaryOf(load);
  const min = s?.minPeople ?? RULES.MIN_PEOPLE;
  const emptyTitle = t('data.f17.modes.h.empty');
  const empty: FigureState = { kind: 'empty', message: t('data.f17.modes.empty', { min: f.int(min) }) };
  if (wait) return <Figure id="placar-modos" title={t('data.f17.modes.h.wait')} sub={t('data.f17.modes.p')} summary={t('data.f17.modes.h.wait')} state={wait} />;
  // No summary yet: the page cannot know how many people each mode has, so it says when it will.
  if (!s) {
    const title = t('data.f17.modes.h.wait');
    return <Figure id="placar-modos" title={title} sub={t('data.f17.modes.p')} summary={title} state={{ kind: 'empty', message: t('data.f17.modes.pending') }} />;
  }
  const rows = modeRows(s);
  if (rows.length === 0) return <Figure id="placar-modos" title={emptyTitle} sub={t('data.f17.modes.p')} summary={emptyTitle} state={empty} source={summarySource(f, s)} />;
  const found = modesTitle(rows);
  const title = t(found.key, found.row ? { mode: modeName(found.row) } : {});
  const table: TableData = {
    columns: [
      { label: t('data.th.mode') },
      { label: t('data.th.peopleWon'), numeric: true },
      { label: t('data.th.interval'), numeric: true },
      { label: t('data.th.matches'), numeric: true },
      { label: t('data.th.people'), numeric: true },
    ],
    rows: rows.map((r) => [modeName(r), ...pctCells(f, r.est, digitsOf(r.est)), f.int(r.matches), f.int(r.people)]),
  };
  return (
    <Figure id="placar-modos" title={title} sub={t('data.f17.modes.p')} summary={title} source={summarySource(f, s)} table={table} reserve={60 + 44 * rows.length}>
      <DotInterval
        rows={rows.map((r) => ({
          key: r.key,
          label: modeName(r),
          marks: [{ series: 3, shape: 'diamond', mean: r.est.mean, lo: r.est.lo, hi: r.est.hi, value: f.pct(r.est.mean, digitsOf(r.est)), detail: [t('data.f17.tipMatches', { m: f.int(r.matches), p: f.int(r.people) })] }],
        }))}
        domain={[0, 1]}
        ticks={stepTicks([0, 1], 0.25)}
        format={(x) => f.pct(x, 0)}
        intervalText={tipFor(f, digitsOf(rows[0].est))}
        refs={[refEven()]}
        axisLabel={t('data.f17.axis')}
      />
    </Figure>
  );
}

/** Week by week, once three weeks of cells exist (DATA-SPEC F17). */
function PeopleByWeek({ summary }: { summary: SummaryV2 }) {
  const f = fmt();
  const { weeks, series } = weekSeries(summary);
  if (weeks.length < 3 || series.length === 0) return null;
  const title = t(weeksTitle(series, weeks));
  // The ISO week's number ("2026-W47" is 47): the axis shows the number, the tooltip says "semana 47".
  const weekNumber = (i: number) => weeks[Math.round(i)]?.replace(/^.*W/, '') ?? '';
  const weekLabel = (i: number) => t('data.f17.week', { w: weekNumber(i) });
  const table: TableData = {
    columns: [{ label: t('data.th.mode') }, { label: t('data.th.week') }, { label: t('data.th.peopleWon'), numeric: true }, { label: t('data.th.interval'), numeric: true }, { label: t('data.th.matches'), numeric: true }],
    rows: series.flatMap((s) => s.points.map((p) => [`${variantWord(s.variant)}, ${modeLabel(s.players)}`, p.week, ...pctCells(f, p.est, 0), f.int(p.matches)])),
  };
  return (
    <Figure id="placar-semanas" title={title} sub={t('data.f17.weeks.p')} summary={title} source={summarySource(f, summary)} table={table} reserve={320}>
      <SmallMultiples
        panels={series.map((s) => ({
          key: s.key,
          title: `${variantWord(s.variant)}, ${modeLabel(s.players)}`,
          lines: [{ key: s.key, label: modeLabel(s.players), series: 3 as const, shape: 'diamond' as const, endLabel: null, points: s.points.map((p) => ({ x: p.index, y: p.est.mean, lo: p.est.lo, hi: p.est.hi, detail: [sample(t, f, p.matches)] })) }],
        }))}
        x={{ domain: [0, weeks.length - 1], ticks: [0, weeks.length - 1], format: weekNumber, label: t('data.f17.weeks.x') }}
        y={{ domain: [0, 1], ticks: [0, 0.5, 1], format: (v) => f.pct(v, 0) }}
        valueFormat={(v) => f.pct(v, 0)}
        xName={weekLabel}
        refs={[refEven()]}
        columns={{ phone: 2, wide: 4 }}
      />
    </Figure>
  );
}

// ------------------------------------------------------------------------------------------------
// F18 People's data against the twin

function Twin({ load }: { load: SummaryLoad }) {
  const f = fmt();
  const wait = waitState(load);
  const s = summaryOf(load);
  const rows = s ? twinRows(s) : [];
  const newest = rows[rows.length - 1] ?? null;
  const title = say(f, twinTitle(newest ? { version: newest.version, est: newest.est } : null));
  const sub = td('data.f18.p');
  if (wait) return <Figure id="gemea" title={t('data.f18.h.wait')} sub={sub} summary={t('data.f18.h.wait')} state={wait} />;
  if (!s || rows.length === 0) {
    return <Figure id="gemea" title={title} sub={sub} summary={title} state={{ kind: 'empty', message: t('data.f18.emptyMsg') }} source={s ? summarySource(f, s) : undefined} />;
  }
  const rms = s.seedNoise?.rms ?? null;
  const min = s.minPeople;
  const behind = (r: (typeof rows)[number]) => (r.people === null ? t('data.f18.few', { m: f.int(r.validMatches), min: f.int(min) }) : t('data.f18.people', { m: f.int(r.validMatches), p: f.int(r.people) }));
  const domain = widen([0.4, 0.6], rows.flatMap((r) => [r.est.lo, r.est.hi]).concat(rms ? [0.5 - rms, 0.5 + rms] : []), 0.05);
  const table: TableData = {
    columns: [{ label: t('data.th.version') }, { label: t('data.th.won'), numeric: true }, { label: t('data.th.interval'), numeric: true }, { label: t('data.th.pairs'), numeric: true }, { label: t('data.th.behind') }],
    rows: rows.map((r) => [r.version, ...pctCells(f, r.est, 1), f.int(r.pairs), behind(r)]),
  };
  return (
    <Figure id="gemea" title={title} sub={sub} summary={title} source={summarySource(f, s)} table={table} reserve={80 + 48 * rows.length}>
      <DotInterval
        rows={rows.map((r) => ({
          key: r.version,
          label: r.version,
          note: behind(r),
          marks: [{ series: 1, mean: r.est.mean, lo: r.est.lo, hi: r.est.hi, value: f.pct(r.est.mean, 1), detail: [sample(t, f, r.pairs)] }],
        }))}
        domain={domain}
        ticks={stepTicks(domain, 0.05)}
        format={(x) => f.pct(x, Math.abs(x * 20 - Math.round(x * 20)) < 1e-9 ? 0 : 1)}
        intervalText={tipFor(f, 1)}
        refs={[refEven()]}
        band={rms ? { from: 0.5 - rms, to: 0.5 + rms, label: t('data.f18.band') } : undefined}
        axisLabel={t('data.f18.axis')}
      />
    </Figure>
  );
}

// ------------------------------------------------------------------------------------------------
// F19 Version history

const RESULT_KEY: Record<HistoryItem['result'], Key> = {
  bootstrap: 'data.f19.result.bootstrap',
  promoted: 'data.f19.result.promoted',
  'rolled-back': 'data.f19.result.rolledBack',
  rejected: 'data.f19.result.rejected',
};

function ResultIcon({ result }: { result: HistoryItem['result'] }) {
  if (result === 'rolled-back') {
    return (
      <svg class="hist__icon" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
        <path d="M8 5L4 9l4 4M4.5 9H12a4 4 0 0 1 0 8H9" />
      </svg>
    );
  }
  if (result === 'bootstrap') {
    return (
      <svg class="hist__icon" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
        <circle cx="10" cy="10" r="4" />
      </svg>
    );
  }
  return (
    <svg class="hist__icon" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
      <path d="M10 16V5M5 9.5L10 4.5l5 5" />
    </svg>
  );
}

function History({ inPlay, load }: { inPlay: string; load: SummaryLoad }) {
  const f = fmt();
  const s = summaryOf(load);
  const items = historyItems(FV, s, inPlay);
  const title = say(f, historyTitle(items.map((i) => ({ version: i.version, data: i.data })), f));
  const min = s?.minPeople ?? RULES.MIN_PEOPLE;
  const people = (i: HistoryItem) => {
    if (!i.data || i.data.validMatches <= 0) return t('data.f19.noPeople');
    if (i.data.people === null) return t('data.f19.fewPeople', { m: f.int(i.data.validMatches), min: f.int(min) });
    return t('data.f19.people', { m: f.int(i.data.validMatches), p: f.int(i.data.people) });
  };
  const ab = (i: HistoryItem) => {
    if (!i.ab) return null;
    if (!i.ab.result) return t('data.f19.ab', { date: f.date(i.ab.until) });
    return t('data.f19.abResult', { drop: f.per100(i.ab.result.drop), range: f.per100Range(i.ab.result.lo, i.ab.result.hi) });
  };
  const source = s ? t('data.src.f19', { date: f.date(s.generatedAt) }) : t('data.src.f19.facts');
  return (
    <Figure id="historico" title={title} sub={t('data.f19.p')} summary={title} source={source} plain>
      <ol class="hist">
        {items.map((i) => (
          <li key={i.version} class={`hist__item hist__item--${i.result}${i.inPlay ? ' is-current' : ''}`}>
            <p class="hist__head">
              <span class="hist__version">{i.version}</span>
              <span class="hist__result">
                <ResultIcon result={i.result} />
                {t(RESULT_KEY[i.result])}
              </span>
              {i.inPlay ? <span class="hist__tag">{t('data.f19.inPlay')}</span> : null}
              {i.date ? <span class="hist__date">{f.date(i.date)}</span> : null}
            </p>
            {i.tuned ? <p class="hist__line">{t('data.f19.tuned', { p: f.pct(i.tuned.mean, digitsOf(i.tuned)), range: f.range(i.tuned.lo, i.tuned.hi, digitsOf(i.tuned)) })}</p> : null}
            <p class="hist__line">{people(i)}</p>
            {ab(i) ? <p class="hist__line">{ab(i)}</p> : null}
          </li>
        ))}
      </ol>
    </Figure>
  );
}

// ------------------------------------------------------------------------------------------------
// The chapter

export function Evolution() {
  const d = useData();
  const s = summaryOf(d.summary);
  const inPlay = servedVersion(d.served, FV.served.version);
  return (
    <Chapter id="evolucao" title={t('data.evo.h')}>
      <Rivals inPlay={inPlay} summary={s} />
      <PeopleScore load={d.summary} />
      <PeopleByMode load={d.summary} />
      {s ? <PeopleByWeek summary={s} /> : null}
      <Twin load={d.summary} />
      <History inPlay={inPlay} load={d.summary} />
    </Chapter>
  );
}

