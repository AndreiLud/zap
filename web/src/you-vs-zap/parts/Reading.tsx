// P3, how Zap reads the person (DATA-SPEC 5.4): GET /api/me/reading, one row per reading number on
// a 0% to 100% track. A number the server shows has its dot, its 80% bar and the reference it
// started from; a hidden one has an empty track and says why (too few observations, or a margin
// still wide). The client never computes a hidden value: the server leaves it out. Under the
// figure, that Zap does not play with these numbers (they are only for this page: adaptation
// across matches is not built), and whether the in-match reading is on now: off at every table of
// a person with "Don't adapt to me" on, else as /api/live says. That line waits for the reading
// answer, which carries the switch, so it never says the AI reads someone who switched it off.

import { useEffect, useState } from 'preact/hooks';
import { MIN_SHOWN_N } from '../../../../shared/profile.ts';
import { api, type Reading as ReadingAnswer } from '../../api.ts';
import { navigate, urlFor } from '../../actions.ts';
import { withCheck } from '../../check.ts';
import { DotInterval, type DotRow } from '../../data/charts/DotInterval.tsx';
import { Figure, READY } from '../../data/charts/Figure.tsx';
import { fmt, type Format } from '../../data/format.ts';
import { td, tdText } from '../../data/i18n-data.ts';
import { likely80 } from '../../data/words.ts';
import { t, type Key } from '../../i18n.ts';
import { inMatchLine } from '../text.ts';

type Num = ReadingAnswer['numbers'][number];
type View = { k: 'loading' } | { k: 'failed' } | { k: 'ready'; r: ReadingAnswer };

/** A number as the page says it: a percent, or "x de 100" for the strength of the cards shown. */
function valueText(f: Format, key: Num['key'], v: number): string {
  return key === 'shown' ? t('reading.scale', { value: f.int(v * 100) }) : f.pct(v, 0);
}

function seconds(f: Format, ms: number): string {
  return t('data.vs.p3.seconds', { v: f.num(ms / 1000, 1) });
}

/** Why a hidden number is hidden: too few of the person's own observations, or a wide margin. */
function hiddenText(f: Format, n: number): string {
  return n < MIN_SHOWN_N ? t('data.vs.p3.wait', { n: f.int(n), min: f.int(MIN_SHOWN_N) }) : t('data.vs.p3.wide');
}

function referenceText(f: Format, x: Num): string {
  return t(x.source === 'people' ? 'reading.reference.people' : 'reading.reference.selfplay', { value: valueText(f, x.key, x.population) });
}

export interface ReadingProps {
  /** The in-match reading is on for the version in play (/api/live adapt; the facts before it answers). */
  inMatch: boolean;
}

export function Reading({ inMatch }: ReadingProps) {
  const f = fmt();
  const [view, setView] = useState<View>({ k: 'loading' });
  const load = async () => {
    setView({ k: 'loading' });
    try {
      setView({ k: 'ready', r: await withCheck(() => api.reading()) });
    } catch {
      setView({ k: 'failed' });
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const r = view.k === 'ready' ? view.r : null;
  const shownNums = r ? r.numbers.filter((x) => x.shown && x.value !== null && x.low !== null && x.high !== null) : [];
  const timeShown = !!r && r.time.shown && r.time.medianMs !== null && r.time.lowMs !== null && r.time.highMs !== null;
  const total = r ? r.numbers.length + 1 : 0;
  const k = shownNums.length + (timeShown ? 1 : 0);
  const titleKey: Key = k > 0 ? 'data.vs.p3.h.some' : 'data.vs.p3.h.none';
  const title = t(titleKey, { k: f.int(k), n: f.int(total) });
  const line = r ? inMatchLine(inMatch, r.noAdapt) : null;

  const rows: DotRow[] = r
    ? r.numbers.map((x) => {
        const name = t(`reading.n.${x.key}` as Key);
        if (!(x.shown && x.value !== null && x.low !== null && x.high !== null)) return { key: x.key, label: name, note: hiddenText(f, x.n), marks: [] };
        return {
          key: x.key,
          label: name,
          marks: [
            { series: 3, mean: x.value, lo: x.low, hi: x.high, label: t('data.lab.you'), value: valueText(f, x.key, x.value), detail: [t(`reading.n.${x.key}.help` as Key)] },
            { series: 0, mean: x.population, label: t('data.vs.p3.ref'), value: valueText(f, x.key, x.population), detail: [referenceText(f, x)] },
          ],
        };
      })
    : [];
  const interval = (x: Num) => (x.key === 'shown' ? t('data.u.likely80', { lo: valueText(f, x.key, x.low!), hi: valueText(f, x.key, x.high!) }) : likely80(t, f, x.low!, x.high!));
  const timeText = r
    ? timeShown
      ? t('data.vs.p3.timeLine', { v: seconds(f, r.time.medianMs!), words: t('data.u.likely80', { lo: seconds(f, r.time.lowMs!), hi: seconds(f, r.time.highMs!) }) })
      : hiddenText(f, r.time.n)
    : '';

  return (
    <section id="vs-leitura" class="doc__section vs-part" aria-labelledby="vs-leitura-t" data-testid="vs-reading" data-state={view.k}>
      <h2 id="vs-leitura-t">{t('reading.title')}</h2>
      {view.k === 'loading' ? <p class="quiet">{t('reading.loading')}</p> : null}
      {view.k === 'failed' ? (
        <>
          <p class="error" role="alert">
            {t('reading.failed')}
          </p>
          <div class="button-row">
            <button type="button" class="btn" onClick={() => void load()}>
              {t('common.retry')}
            </button>
          </div>
        </>
      ) : null}
      {r?.noAdapt ? <p data-testid="vs-reading-off">{t('reading.off')}</p> : null}
      {r && !r.noAdapt ? (
        <Figure
          id="vs-numeros"
          title={title}
          sub={td('data.vs.p3.sub')}
          legend={shownNums.length ? [{ label: t('data.lab.you'), series: 3, shape: 'diamond' }, { label: t('data.vs.p3.ref'), series: 0, shape: 'circle' }] : undefined}
          summary={`${title} ${r.numbers.map((x) => `${t(`reading.n.${x.key}` as Key)}: ${x.shown && x.value !== null ? valueText(f, x.key, x.value) : hiddenText(f, x.n)}`).join('; ')}`}
          state={READY}
          reading={
            <span data-testid="vs-reading-time" data-shown={String(timeShown)}>
              <b>{t('reading.time')}</b>: {timeText}
            </span>
          }
          source={t('data.vs.p3.src', { matches: f.int(r.matches), decisions: f.int(r.decisions) })}
          table={{
            columns: [
              { label: t('data.vs.th.number') },
              { label: t('data.vs.th.value'), numeric: true },
              { label: tdText('data.term.ic80.name') },
              { label: t('data.vs.th.reference'), numeric: true },
              { label: t('data.vs.th.seen'), numeric: true },
            ],
            rows: [
              ...r.numbers.map((x) => {
                const on = x.shown && x.value !== null && x.low !== null && x.high !== null;
                return [t(`reading.n.${x.key}` as Key), on ? valueText(f, x.key, x.value!) : t('data.vs.p3.hidden'), on ? interval(x) : hiddenText(f, x.n), valueText(f, x.key, x.population), f.int(x.n)];
              }),
              [t('reading.time'), timeShown ? seconds(f, r.time.medianMs!) : t('data.vs.p3.hidden'), timeText, '', f.int(r.time.n)],
            ],
          }}
          reserve={60 + r.numbers.length * 44}
        >
          <div data-testid="vs-reading-rows">
            <DotInterval rows={rows} domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} format={(v) => f.pct(v, 0)} axisLabel={t('data.vs.p3.axis')} intervalText={(lo, hi) => likely80(t, f, lo, hi)} />
          </div>
        </Figure>
      ) : null}
      {r && !r.noAdapt ? <p class="hint">{t('data.vs.p3.between')}</p> : null}
      {line ? (
        <p class="vs-inmatch" data-testid="vs-inmatch" data-on={String(line.on)}>
          {t(line.key)}{' '}
          <a
            href={`${urlFor({ name: 'data' })}#leitura`}
            onClick={(e) => {
              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              navigate({ name: 'data' }, { hash: '#leitura' });
            }}
          >
            {t('data.vs.p3.inmatch.link')}
          </a>
        </p>
      ) : null}
    </section>
  );
}
