// Chapter 4 of the plan, how people play (DATA-SPEC 4.9, F24 to F27). Today nobody's numbers are
// public yet, so this chapter is mostly its empty states: each part shows how far it is from the
// mark that turns it on (summary.layers), and no number comes from a group of fewer people than
// the public minimum. Every figure here reads the run time summary.

import { t, type Key } from '../../i18n.ts';
import { Link } from '../../components/common.tsx';
import { DotInterval, refEven } from '../charts/DotInterval.tsx';
import { Figure, type FigureState, type TableData } from '../charts/Figure.tsx';
import { Meter } from '../charts/Meter.tsx';
import { stepTicks } from '../charts/scales.ts';
import { layersTitle, say, typesTitle, variantsTitle } from '../findings.ts';
import { digitsFor, fmt, halfWidth, type Format } from '../format.ts';
import { wilson, type Est } from '../words.ts';
import { layerStates, summaryOf, typesAverage, TYPE_KEYS, variantCells, type LayerState, type PublicLayer, type SummaryLoad } from './chapter-data.ts';
import { useData } from '../load.ts';
import { Chapter, LockLine, pctCells, PlayLink, RULES, tipFor, waitState } from './chapter.tsx';
import type { SummaryV2 } from '../../../../shared/cycle-formats.ts';

const digitsOf = (e: Est) => (digitsFor(halfWidth(e.lo, e.hi)) === 1 ? 1 : 0);
const modeLabel = (p: 2 | 4) => t(p === 2 ? 'play.mode.solo' : 'play.mode.dupla');
const summarySource = (f: Format, s: SummaryV2) => t('data.src.summary', { date: f.date(s.generatedAt) });

const LAYER_TITLE: Record<PublicLayer, Key> = {
  humanModel: 'data.f24.humanModel',
  priors: 'data.f24.priors',
  playerTypes: 'data.f24.playerTypes',
  ranking: 'data.f24.ranking',
  openData: 'data.f24.openData',
};

/**
 * The meters of one layer: the first as a titled Meter (lock or check, name, state), any further
 * count of the same layer as a bar under it. Without a summary nothing is counted yet; a people
 * count under the public minimum stays hidden and is said in words.
 */
function LayerMeters({ layer, f, min, known }: { layer: LayerState; f: Format; min: number; known: boolean }) {
  const state = t(layer.on ? 'data.meter.on' : 'data.meter.waiting');
  const words = (m: LayerState['meters'][number], first = true) => {
    // Before the first summary: the first meter says when the count comes, the others their mark.
    if (!known) return first ? t('data.meter.pending') : t(m.unit === 'people' ? 'data.meter.goal.people' : 'data.meter.goal.matches', { need: f.int(m.needed) });
    if (m.value === null) return m.unit === 'people' ? t('data.meter.under', { min: f.int(min) }) : t('data.meter.pending');
    if (layer.key === 'ranking' && layer.each) return t('data.meter.ranking', { v: f.int(m.value), need: f.int(layer.each.people), each: f.int(layer.each.matches) });
    return t(m.unit === 'people' ? 'data.meter.people' : 'data.meter.matches', { v: f.int(m.value), need: f.int(m.needed) });
  };
  const [first, ...rest] = layer.meters;
  const title = t(LAYER_TITLE[layer.key]);
  return (
    <>
      <Meter label={title} value={known ? first.value : null} needed={first.needed} on={layer.on} state={state} text={words(first)} nullText={words(first)} />
      {rest.map((m, i) => {
        const value = known ? m.value : null;
        const share = value === null || m.needed <= 0 ? 0 : Math.max(0, Math.min(1, value / m.needed));
        return (
          <div key={i} class="marks__more">
            <div
              class="meter__track"
              role={value === null ? 'img' : 'meter'}
              aria-label={`${title}: ${words(m, false)}`}
              aria-valuemin={value === null ? undefined : 0}
              aria-valuemax={value === null ? undefined : m.needed}
              aria-valuenow={value === null ? undefined : Math.min(value, m.needed)}
              aria-valuetext={value === null ? undefined : words(m, false)}
            >
              {share > 0 ? <span class="meter__fill" style={{ width: `${(share * 100).toFixed(1)}%` }} /> : null}
            </div>
            <p class="meter__text">{words(m, false)}</p>
          </div>
        );
      })}
    </>
  );
}

// ------------------------------------------------------------------------------------------------
// F24 What turns on, and when

function Marks({ load }: { load: SummaryLoad }) {
  const f = fmt();
  const s = summaryOf(load);
  const wait = waitState(load);
  const min = s?.minPeople ?? RULES.MIN_PEOPLE;
  const layers = layerStates(s, RULES.thresholds);
  const on = layers.filter((l) => l.on).length;
  const title = wait ? t('data.f24.h.wait') : say(f, layersTitle({ on, total: layers.length }, f));
  const source = s ? summarySource(f, s) : t('data.src.rules');
  return (
    <Figure id="marcas" title={title} sub={t('data.f24.p')} summary={title} state={wait ?? undefined} source={source} plain>
      <ul class="marks">
        {layers.map((l) => (
          <li key={l.key} class="marks__item">
            <LayerMeters layer={l} f={f} min={min} known={!!s} />
          </li>
        ))}
        <li class="marks__item marks__item--you">
          <p class="marks__you-title">{t('data.f24.you.h')}</p>
          <Link to={{ name: 'vs' }} class="marks__you-link" testid="data-f24-you">
            {t('data.f24.you.link')}
          </Link>
          <PlayLink testid="data-f24-play" />
        </li>
      </ul>
    </Figure>
  );
}

// ------------------------------------------------------------------------------------------------
// F25 Player types

function Types({ load }: { load: SummaryLoad }) {
  const f = fmt();
  const s = summaryOf(load);
  const wait = waitState(load);
  const layer = layerStates(s, RULES.thresholds).find((l) => l.key === 'playerTypes')!;
  const need = layer.meters[0].needed;
  const pt = s?.playerTypes ?? null;
  const min = s?.minPeople ?? RULES.MIN_PEOPLE;
  const meter = <LayerMeters layer={layer} f={f} min={min} known={!!s} />;
  if (wait || !pt || pt.types.length === 0) {
    const title = wait ? t('data.f25.h.wait') : say(f, typesTitle({ types: null, need }, f));
    const state: FigureState = wait ?? { kind: 'empty', message: t('data.f25.emptyMsg'), extra: meter };
    return <Figure id="tipos" title={title} sub={t('data.f25.p')} summary={title} state={state} source={s ? summarySource(f, s) : undefined} />;
  }
  if (pt.types.length === 1) {
    const title = t('data.f25.h.one');
    return <Figure id="tipos" title={title} sub={t('data.f25.p')} summary={title} state={{ kind: 'empty', message: t('data.f25.oneMsg') }} source={summarySource(f, s!)} />;
  }
  const title = say(f, typesTitle({ types: pt.types.length, need }, f));
  const avg = typesAverage(pt.types);
  const name = (k: string) => t(`reading.n.${k}` as Key);
  const table: TableData = {
    columns: [{ label: t('data.th.type') }, { label: t('data.th.share'), numeric: true }, ...TYPE_KEYS.map((k) => ({ label: name(k), numeric: true }))],
    rows: [
      ...pt.types.map((ty, i) => [t('data.f25.type', { i: f.int(i + 1), share: f.pct(ty.share, 0) }), f.pct(ty.share, 0), ...TYPE_KEYS.map((k) => f.pct(ty.center[k] ?? 0, 0))]),
      [t('data.f25.tick'), '', ...TYPE_KEYS.map((k) => f.pct(avg[k], 0))],
    ],
  };
  return (
    <Figure id="tipos" title={title} sub={t('data.f25.p')} summary={title} source={summarySource(f, s!)} table={table} reserve={420} plain>
      <ul class="types" aria-label={title}>
        {pt.types.map((ty, i) => {
          const head = t('data.f25.type', { i: f.int(i + 1), share: f.pct(ty.share, 0) });
          return (
            <li key={i} class="types__card">
              <p class="types__head">{head}</p>
              <dl class="cast__rates">
                {TYPE_KEYS.map((k) => {
                  const v = Math.max(0, Math.min(1, ty.center[k] ?? 0));
                  return (
                    <div key={k} class="cast__rate">
                      <dt>{name(k)}</dt>
                      <dd>
                        <span class="cast__bar" aria-hidden="true">
                          <span class="cast__fill cast__fill--s3" style={{ width: `${(v * 100).toFixed(1)}%` }} />
                          <span class="cast__tick" style={{ left: `${(avg[k] * 100).toFixed(1)}%` }} />
                        </span>
                        <span class="cast__value">{f.pct(v, 0)}</span>
                        <span class="sr-only">{t('data.f25.avg', { p: f.pct(avg[k], 0) })}</span>
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </li>
          );
        })}
      </ul>
    </Figure>
  );
}

// ------------------------------------------------------------------------------------------------
// F26 Where people disagree with Zap (the empty state; the measure waits for the owner)

function Disagreements({ load }: { load: SummaryLoad }) {
  const f = fmt();
  const s = summaryOf(load);
  const wait = waitState(load);
  const min = s?.minPeople ?? RULES.MIN_PEOPLE;
  const layer = layerStates(s, RULES.thresholds).find((l) => l.key === 'humanModel')!;
  const title = t('data.f26.h');
  const state: FigureState = wait ?? { kind: 'empty', message: t('data.f26.empty'), extra: <LayerMeters layer={layer} f={f} min={min} known={!!s} /> };
  return <Figure id="discordancias" title={title} sub={t('data.f26.p')} summary={title} state={state} source={s ? summarySource(f, s) : undefined} />;
}

// ------------------------------------------------------------------------------------------------
// F27 Paulista against mineiro

function Variants({ load }: { load: SummaryLoad }) {
  const f = fmt();
  const s = summaryOf(load);
  const wait = waitState(load);
  const min = s?.minPeople ?? RULES.MIN_PEOPLE;
  const cells = s ? variantCells(s) : null;
  const found = variantsTitle({ paulista: cells?.paulista.all ?? null, mineiro: cells?.mineiro.all ?? null, min }, f);
  const title = say(f, found);
  if (wait || !cells || found.key === 'data.f27.empty') {
    const state: FigureState = wait ?? { kind: 'empty', message: t('data.f27.emptyMsg') };
    const head = wait ? t('data.f27.h.wait') : title;
    return <Figure id="variantes" title={head} sub={t('data.f27.p')} summary={head} state={state} source={s ? summarySource(f, s) : undefined} />;
  }
  const variants = ['paulista', 'mineiro'] as const;
  const rows = variants.map((v) => ({
    v,
    marks: ([2, 4] as const).flatMap((p) => {
      const c = p === 2 ? cells[v].two : cells[v].four;
      return c ? [{ p, c, e: wilson(c.wins, c.n) }] : [];
    }),
  }));
  const table: TableData = {
    columns: [{ label: t('data.th.variant') }, { label: t('data.th.mode') }, { label: t('data.th.peopleWon'), numeric: true }, { label: t('data.th.interval'), numeric: true }, { label: t('data.th.matches'), numeric: true }],
    rows: rows.flatMap((r) => r.marks.map((m) => [t(r.v === 'paulista' ? 'play.v.paulista' : 'play.v.mineiro'), modeLabel(m.p), ...pctCells(f, m.e, digitsOf(m.e)), f.int(m.c.n)])),
  };
  return (
    <Figure
      id="variantes"
      title={title}
      sub={t('data.f27.p')}
      legend={[
        { label: modeLabel(2), series: 3, shape: 'diamond' },
        { label: modeLabel(4), series: 2, shape: 'square' },
      ]}
      summary={title}
      source={summarySource(f, s!)}
      table={table}
      reserve={200}
    >
      <DotInterval
        rows={rows.map((r) => ({
          key: r.v,
          label: t(r.v === 'paulista' ? 'play.v.paulista' : 'play.v.mineiro'),
          marks: r.marks.map((m) => ({
            series: m.p === 2 ? (3 as const) : (2 as const),
            shape: m.p === 2 ? ('diamond' as const) : ('square' as const),
            label: modeLabel(m.p),
            mean: m.e.mean,
            lo: m.e.lo,
            hi: m.e.hi,
            value: f.pct(m.e.mean, digitsOf(m.e)),
          })),
        }))}
        domain={[0, 1]}
        ticks={stepTicks([0, 1], 0.25)}
        format={(x) => f.pct(x, 0)}
        intervalText={tipFor(f, 0)}
        refs={[refEven()]}
        axisLabel={t('data.f27.axis')}
      />
    </Figure>
  );
}

// ------------------------------------------------------------------------------------------------
// The chapter

export function People() {
  const d = useData();
  const f = fmt();
  const s = summaryOf(d.summary);
  const min = s?.minPeople ?? RULES.MIN_PEOPLE;
  return (
    <Chapter id="pessoas" title={t('data.people.h')} extra={<LockLine>{t('data.people.rule', { min: f.int(min) })}</LockLine>}>
      <Marks load={d.summary} />
      <Types load={d.summary} />
      <Disagreements load={d.summary} />
      <Variants load={d.summary} />
    </Chapter>
  );
}
