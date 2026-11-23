// P2, the rating (DATA-SPEC 5.3): the person's band on one scale with the six characters of the
// version in play at their anchors, and under it the band over the person's games. Computed on the
// device from the person's quick games once every record is in (rating.ts); the characters' places
// come from what was measured (facts-view.json, and /api/summary for versions the cycle promoted).

import { useMemo, useState } from 'preact/hooks';
import type { TeamSize } from '../../../../shared/rating.ts';
import { Figure, Segmented, READY } from '../../data/charts/Figure.tsx';
import { LineBand } from '../../data/charts/LineBand.tsx';
import { RatingBand, ratingDomain } from '../../data/charts/RatingBand.tsx';
import { niceTicks } from '../../data/charts/scales.ts';
import { ratingTitle } from '../../data/findings.ts';
import { fmt } from '../../data/format.ts';
import facts from '../../data/generated/facts-view.json';
import { tdText, td } from '../../data/i18n-data.ts';
import { tipRange } from '../../data/words.ts';
import { t, type Key } from '../../i18n.ts';
import type { PersonMatch } from '../history.ts';
import { anchorBook, rateMatches, REF_VERSION, type AnchorFacts, type AnchorSummary, type CastMember } from '../rating.ts';

const FACTS = facts as unknown as AnchorFacts & { served?: { version?: string } };

/** The character nearest a level (ties to the lower one). */
function nearest(cast: readonly CastMember[], v: number): CastMember {
  return [...cast].sort((a, b) => Math.abs(a.mu - v) - Math.abs(b.mu - v) || a.mu - b.mu)[0];
}

/** When the characters of a version were measured, from the facts (null for versions of the cycle). */
function measuredAt(version: string): number | null {
  const at = FACTS.ai.personasByVersion?.[version]?.measuredAt;
  const ms = at ? Date.parse(at) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

export interface RatingProps {
  matches: readonly PersonMatch[];
  complete: boolean;
  /** The version on the AI seats now (/api/live, or the facts' served version). */
  version: string;
  summary: AnchorSummary | null;
}

export function Rating({ matches, complete, version, summary }: RatingProps) {
  const f = fmt();
  const book = useMemo(() => anchorBook(FACTS, summary), [summary]);
  const ratings = useMemo(() => (complete ? rateMatches(matches, book) : null), [complete, matches, book]);
  const sizes = ratings ? ([1, 2] as TeamSize[]).filter((s) => ratings[s].points.length > 0) : [];
  const [pick, setPick] = useState<TeamSize | null>(null);
  const size: TeamSize | null = pick !== null && sizes.includes(pick) ? pick : sizes.length ? [...sizes].sort((a, b) => ratings![b].points.length - ratings![a].points.length)[0] : null;

  // The characters of the version in play; a version without anchors falls back to the shipped one.
  const castVersion = (s: TeamSize) => [version, FACTS.served?.version ?? '', REF_VERSION].find((v) => v && book.cast(v, s)) ?? REF_VERSION;
  const unrated = ratings ? ratings[1].unrated + ratings[2].unrated : 0;
  const unratedText = unrated > 0 ? t(unrated === 1 ? 'data.vs.p2.unrated.one' : 'data.vs.p2.unrated', { n: f.int(unrated) }) : null;
  const sizeName = (s: TeamSize) => t(`mode.${s === 1 ? 2 : 4}` as Key);

  const head = (
    <>
      <h2 id="vs-rating-t">{t('data.vs.p2.title')}</h2>
    </>
  );

  if (!ratings || size === null) {
    const message = !complete ? t('data.vs.p2.wait') : t('data.vs.p2.empty');
    return (
      <section id="vs-rating" class="doc__section vs-part" aria-labelledby="vs-rating-t">
        {head}
        <p class="quiet" data-testid="vs-rating-empty">
          {message}
        </p>
        {unratedText ? <p class="quiet">{unratedText}</p> : null}
      </section>
    );
  }

  const r = ratings[size];
  const cv = castVersion(size);
  const cast = book.cast(cv, size) ?? [];
  const now = r.now;
  const lo = now.mu - 2 * now.sigma;
  const hi = now.mu + 2 * now.sigma;
  const finding = ratingTitle({ n: r.points.length, mu: now.mu, sigma: now.sigma, anchors: cast }, f);
  const title = finding ? tdText(finding.key, finding.vars as Record<string, string>) : t('data.vs.p2.title');
  const bandWords = cast.length ? tipRange(t, nearest(cast, lo).name, nearest(cast, hi).name) : tipRange(t, f.num(lo, 1), f.num(hi, 1));
  const bandNumbers = t('data.fmt.range', { a: f.num(lo, 1), b: f.num(hi, 1) });
  const when = measuredAt(cv);
  const source = when !== null ? t('data.vs.p2.src', { v: cv, date: f.date(when) }) : t('data.vs.p2.src.nodate', { v: cv });
  const tableRows = sizes.map((s) => {
    const x = ratings[s];
    const c = book.cast(castVersion(s), s) ?? [];
    return [sizeName(s), f.int(x.points.length), f.num(x.now.mu, 1), t('data.fmt.range', { a: f.num(x.now.mu - 2 * x.now.sigma, 1), b: f.num(x.now.mu + 2 * x.now.sigma, 1) }), c.length ? nearest(c, x.now.mu).name : ''];
  });

  const pts = r.points.map((p) => ({ x: p.n, y: p.mu, lo: p.mu - 2 * p.sigma, hi: p.mu + 2 * p.sigma }));
  const yDom = ratingDomain([...pts.map((p) => p.lo), ...pts.map((p) => p.hi)], null);
  const xMax = Math.max(2, r.points.length);
  const lineTitle = t('data.vs.p2.line.h');

  return (
    <section id="vs-rating" class="doc__section vs-part" aria-labelledby="vs-rating-t">
      {head}
      <Figure
        id="vs-faixa"
        title={title}
        sub={td('data.vs.p2.sub')}
        controls={
          sizes.length > 1 ? (
            <Segmented label={t('data.vs.p2.size')} value={String(size)} options={sizes.map((s) => ({ value: String(s), label: sizeName(s) }))} onChange={(v) => setPick(Number(v) as TeamSize)} />
          ) : undefined
        }
        summary={`${title} ${t('data.vs.p2.aria', { mu: f.num(now.mu, 1), band: bandNumbers })} ${cast.map((c) => `${c.name} ${f.num(c.mu, 1)}`).join(', ')}`}
        state={READY}
        reading={unratedText ?? undefined}
        source={source}
        table={{
          columns: [
            { label: t('data.vs.th.table') },
            { label: t('data.vs.th.games'), numeric: true },
            { label: t('data.vs.th.level'), numeric: true },
            { label: t('data.vs.th.band') },
            { label: t('data.vs.th.nearest') },
          ],
          rows: tableRows,
        }}
        reserve={150}
      >
        <RatingBand anchors={cast} you={now} domain={ratingDomain(cast.map((c) => c.mu), now)} format={(v) => f.num(v, 1)} bandText={bandWords} />
      </Figure>
      {r.points.length < 2 ? null : (
      <Figure
        id="vs-faixa-linha"
        level={4}
        title={lineTitle}
        summary={`${lineTitle}: ${r.points.map((p) => f.num(p.mu, 1)).join(', ')}`}
        source={source}
        table={{
          columns: [{ label: t('data.vs.th.games') }, { label: t('data.vs.th.level'), numeric: true }, { label: t('data.vs.th.band') }],
          rows: r.points.map((p) => [f.int(p.n), f.num(p.mu, 1), t('data.fmt.range', { a: f.num(p.mu - 2 * p.sigma, 1), b: f.num(p.mu + 2 * p.sigma, 1) })]),
        }}
        reserve={220}
      >
        <LineBand
          series={[{ key: 'you', label: t('data.lab.you'), series: 3, shape: 'diamond', points: pts }]}
          x={{ domain: [1, xMax], ticks: niceTicks([1, xMax], 5).filter((v) => Number.isInteger(v)), format: (v) => f.int(v), label: t('data.vs.p2.line.x') }}
          y={{ domain: yDom, ticks: niceTicks(yDom, 4), format: (v) => f.num(v, 0) }}
          valueFormat={(v) => f.num(v, 1)}
          xName={(x) => t('data.vs.p2.line.at', { n: f.int(x) })}
          intervalText={(a, b) => tipRange(t, f.num(a, 1), f.num(b, 1))}
          height={150}
        />
      </Figure>
      )}
    </section>
  );
}
