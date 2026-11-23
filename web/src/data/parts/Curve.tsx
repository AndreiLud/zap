// F3 "The training curve" (DATA-SPEC 4.3): games won against the tuned rules player along the
// training of the version in play, from the start of its lineage (v1, then v2 from v1's step 150).
// The band is the largest possible 95% margin of each point (the metrics keep only the mean), said
// as "margem de até". A parent row is drawn up to the step its child started from: the steps after
// it belong to no version the site serves.

import { t } from '../../i18n.ts';
import { refEven } from '../charts/DotInterval.tsx';
import { Figure } from '../charts/Figure.tsx';
import { LineBand, type LineSeries } from '../charts/LineBand.tsx';
import { niceTicks, stepTicks } from '../charts/scales.ts';
import { curveTitle, say } from '../findings.ts';
import { digitsFor, type Format } from '../format.ts';
import { tdText, td } from '../i18n-data.ts';
import { CURVE, lineage, ms, storyVersion, useData, type CurvePointRow, type CurveRow } from '../load.ts';

export interface StoryPoint extends CurvePointRow {
  version: string;
}

/** The points of each row of the lineage, a parent cut at the step its child started from. */
export function storyRows(rows: readonly CurveRow[]): { row: CurveRow; points: StoryPoint[]; snapshotStep: number }[] {
  return rows.map((row, i) => {
    const child = rows[i + 1];
    const points = row.points.filter((p) => !child || p.step <= child.offset).map((p) => ({ ...p, version: row.version }));
    return { row, points, snapshotStep: row.offset + row.snapshot };
  });
}

const half = (f: Format, m: number) => f.pct(m, 1);

export function Curve() {
  const { f, served } = useData();
  const story = storyVersion(CURVE.rows, served);
  const parts = storyRows(lineage(CURVE.rows, story));
  if (!parts.length) {
    return <Figure id="curva" title={t('data.curve.h0')} summary={t('data.curve.h0')} state={{ kind: 'notMeasured' }} />;
  }
  const all = parts.flatMap((p) => p.points);
  const title = say(f, curveTitle(all.map((p) => ({ iteration: p.step, mean: p.mean, half95: p.half95 })), f));
  const first = all[0];
  const last = parts[parts.length - 1];
  const inPlay = parts.find((p) => p.row.version === served) ?? null;
  const maxHalf = Math.max(...all.map((p) => p.half95));
  const xMax = Math.max(...all.map((p) => p.step), last.snapshotStep);
  const imitation = parts[0].row.offset + parts[0].row.imitationIterations;
  const firstText = f.pct(first.mean, digitsFor(first.half95));
  const readVars: Record<string, string> = inPlay
    ? { first: firstText, v: inPlay.row.version, it: f.int(inPlay.snapshotStep), near: f.pct(inPlay.row.nearSnapshot.mean, digitsFor(inPlay.row.nearSnapshot.half95)) }
    : { first: firstText };
  const after = last.row.iterations > last.row.snapshot;
  // The version in play is the first series (cobalt), the older ones follow (the second dashed).
  const ordered = [...parts].reverse();
  const series: LineSeries[] = ordered.map((p, i) => ({
    key: p.row.version,
    label: p.row.version,
    series: i === 0 ? 1 : 2,
    dashed: i > 0,
    points: p.points.map((q) => ({
      x: q.step,
      y: q.mean,
      lo: q.mean - q.half95,
      hi: q.mean + q.half95,
      detail: [t(q.phase === 'imitation' ? 'data.curve.ph.imit' : 'data.curve.ph.self')],
    })),
  }));
  const noteAt = ordered[0].points[Math.floor(ordered[0].points.length * 0.7)]?.step ?? xMax;
  const runs = new Intl.ListFormat(f.lang === 'en' ? 'en' : 'pt-BR', { type: 'conjunction' }).format(parts.map((p) => p.row.run));
  const reading = (
    <>
      {td(inPlay ? 'data.curve.read' : 'data.curve.read0', readVars)}
      {after ? <> {t('data.curve.after', { it: f.int(last.snapshotStep) })}</> : null}
    </>
  );
  return (
    <Figure
      id="curva"
      title={title}
      sub={td('data.curve.p', { every: f.int(last.row.evalEvery) })}
      legend={series.length > 1 ? series.map((s) => ({ label: s.label, series: s.series, shape: s.series === 1 ? 'circle' : 'square', line: true, dashed: s.dashed })) : undefined}
      summary={`${title} ${tdText(inPlay ? 'data.curve.read' : 'data.curve.read0', readVars)}`}
      reading={reading}
      source={td('data.src.curve', { runs, pairs: f.int(last.row.pairs), date: f.date(ms(last.row.trainedAt)) })}
      table={{
        columns: [{ label: t('data.th.step') }, { label: t('data.th.version') }, { label: t('data.th.phase') }, { label: t('data.th.wins'), numeric: true }, { label: t('data.th.margin'), numeric: true }],
        rows: all.map((p) => [
          f.int(p.step),
          p.version,
          t(p.phase === 'imitation' ? 'data.curve.ph.imit' : 'data.curve.ph.self'),
          f.pct(p.mean, 1),
          t('data.curve.upTo', { m: half(f, p.half95) }),
        ]),
      }}
      reserve={330}
    >
      <LineBand
        series={series}
        x={{ domain: [0, xMax], ticks: niceTicks([0, xMax], 6), format: (v) => f.int(v), label: t('data.curve.x') }}
        y={{ domain: [0.3, 1], ticks: stepTicks([0.3, 1], 0.1), format: (v) => f.pct(v, 0) }}
        valueFormat={(v) => f.pct(v, 1)}
        xName={(x) => t('data.curve.step', { i: f.int(x) })}
        intervalText={(lo, hi) => t('data.curve.upTo', { m: half(f, (hi - lo) / 2) })}
        refs={[refEven()]}
        zones={imitation > 0 ? [{ from: 0, to: imitation, label: t('data.curve.imit') }] : []}
        markers={parts.map((p) => ({
          x: p.snapshotStep,
          label: p.row.version === served ? t('data.curve.inPlay', { v: p.row.version }) : p.row.version,
          strong: p.row.version === served,
        }))}
        bandNote={{ x: noteAt, text: t('data.u.upTo', { m: half(f, maxHalf) }) }}
      />
    </Figure>
  );
}
