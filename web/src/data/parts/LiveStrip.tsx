// "Agora no site" (DATA-SPEC 4.0): four counters from GET /api/live and the summary. The values are
// never announced (aria-live off); a hidden line says when they were last updated. The dot pulses
// while the page polls, turns grey when the last request failed (the numbers stay), and after 30
// idle polls the strip says it paused and offers "Atualizar".

import { t } from '../../i18n.ts';
import { useData } from '../load.ts';

export function LiveStrip() {
  const { f, live, summary } = useData();
  const c = live.live;
  const waiting = '…';
  const trained =
    summary.kind === 'ready'
      ? summary.summary.training.finishedAt !== null
        ? f.date(summary.summary.training.finishedAt)
        : t('data.live.never')
      : summary.kind === 'none'
        ? t('data.live.never')
        : waiting;
  const dot = `dp-live__dot${!live.ok ? ' is-stale' : live.paused ? '' : ' is-polling'}`;
  return (
    <section class="dp-live" aria-labelledby="dp-live-h" data-testid="data-live">
      <h2 id="dp-live-h" class="dp-live__h">
        <span class={dot} aria-hidden="true" />
        {t('data.live.title')}
      </h2>
      <dl class="dp-live__list" aria-live="off" aria-busy={c ? undefined : 'true'}>
        <div>
          <dt>{t('data.live.matches')}</dt>
          <dd data-testid="live-matches">{c ? f.int(c.humanMatches) : waiting}</dd>
        </div>
        <div>
          <dt>{t('data.live.decisions')}</dt>
          <dd data-testid="live-decisions">{c ? f.big(c.decisions) : waiting}</dd>
        </div>
        <div>
          <dt>{t('data.live.version')}</dt>
          <dd data-testid="live-version">{c ? c.aiVersion : waiting}</dd>
        </div>
        <div>
          <dt>{t('data.live.trained')}</dt>
          <dd class={summary.kind === 'ready' && summary.summary.training.finishedAt !== null ? undefined : 'is-words'}>{trained}</dd>
        </div>
      </dl>
      {live.paused ? (
        <p class="dp-live__note">
          <span>{t('data.live.paused')}</span>{' '}
          <button type="button" class="dp-live__resume" onClick={live.resume} data-testid="live-resume">
            {t('data.live.resume')}
          </button>
        </p>
      ) : (
        <p class="dp-live__note">{t('data.live.note')}</p>
      )}
      {c ? <p class="sr-only">{t('data.live.updated', { time: f.time(c.updatedAt) })}</p> : null}
    </section>
  );
}
