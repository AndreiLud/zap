// The parts of the Play page below the chooser (CLIENT-SPEC 10.2 items 7 to 11): what a room looks
// like, the "So far" strip (the milestone 7 hook; nothing renders without data), the learning
// loop teaser and the source code.

import type { Variant } from '../../../engine/src/config.ts';
import { ExternalLink, Link, SOURCE_URL } from '../components/common.tsx';
import { Icon } from '../components/icons.tsx';
import { Avatar, SeatLabel, TeamChip } from '../components/pieces.tsx';
import { t } from '../i18n.ts';
import type { Lang } from '../i18n.ts';
import type { LiveCounters } from '../live.ts';
import { LoopGlyph } from './drawings.tsx';

/** "What a room looks like": the seals on Ana and Caio, the AI mark on the Zap. A picture, not a real room. */
export function RoomSample({ variant }: { variant: Variant }) {
  return (
    <figure class="room-sample">
      <figcaption>
        <b>{t('play.room.ex.h')}</b>
        <span>{t('play.room.ex.p')}</span>
      </figcaption>
      <div class="room-sample__table">
        <p class="room-sample__top">
          <span>{t('play.room.ex.code')}</span>
          <b class="room-sample__code">K7QXM</b>
          <span>{t(`play.v.${variant}`)}</span>
        </p>
        <ul class="room-sample__seats">
          <li>
            <span class="seat-label" data-team="us">
              <Avatar initial={t('play.room.you')} />
              <span class="seat-label__name">
                <span>{t('play.room.you')}</span>
                <TeamChip team="us" />
              </span>
              <span class="seat-label__line">{t('play.room.you.line')}</span>
            </span>
          </li>
          <li>
            <SeatLabel seat={{ kind: 'human', name: 'Ana', team: 'us', verified: true }} />
          </li>
          <li>
            <SeatLabel seat={{ kind: 'human', name: 'Caio', team: 'them', verified: true }} />
          </li>
          <li>
            <SeatLabel seat={{ kind: 'ai', persona: 'zap', team: 'them' }} />
          </li>
        </ul>
      </div>
    </figure>
  );
}

/** "So far": rendered only with counters from the milestone 7 hook, so no number shows without a source. */
export function LiveStrip({ live, lang }: { live: LiveCounters; lang: Lang }) {
  const nf = new Intl.NumberFormat(lang === 'en' ? 'en' : 'pt-BR');
  const vs = live.humansVsZap;
  return (
    <section class="live-strip" aria-labelledby="live-title">
      <h2 class="play__kicker" id="live-title">
        {t('play.live.h')}
      </h2>
      <dl class="live-strip__numbers">
        <div class="live-strip__item">
          <dt>{t('play.live.matches')}</dt>
          <dd>
            <b>{nf.format(live.humanMatches)}</b>
            <small>{t('play.live.matches.sub')}</small>
          </dd>
        </div>
        <div class="live-strip__item">
          <dt>{t('play.live.vs')}</dt>
          <dd>
            <b>{t('play.live.vs.val', { a: nf.format(vs.humanWins), b: nf.format(Math.max(0, vs.matches - vs.humanWins)) })}</b>
            <small>{t('play.live.vs.sub')}</small>
          </dd>
        </div>
        <div class="live-strip__item">
          <dt>{t('play.live.version')}</dt>
          <dd>
            <b>{live.aiVersion}</b>
            {live.trainingHands !== null ? <small>{t('play.live.version.sub', { n: nf.format(live.trainingHands) })}</small> : null}
          </dd>
        </div>
      </dl>
    </section>
  );
}

const LOOP_STEPS = [1, 2, 3, 4] as const;

/** "Every match is a lesson.": one line, the four step loop and a link to the data page. */
export function LessonTeaser() {
  return (
    <section class="lesson" aria-labelledby="lesson-title">
      <div class="lesson__text">
        <h2 id="lesson-title">{t('play.loop.h')}</h2>
        <p>{t('play.loop.p')}</p>
        <Link to={{ name: 'data' }} class="lesson__link">
          <span>{t('play.loop.link')}</span>
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M2 8h11M9 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </Link>
      </div>
      <figure class="loop">
        <div class="loop__back" aria-hidden="true">
          <span>{t('play.loop.back')}</span>
        </div>
        <ol class="loop__steps">
          {LOOP_STEPS.map((n) => (
            <li key={n} class={`loop__step${n === 4 ? ' loop__step--duel' : ''}`}>
              <span class="loop__node" aria-hidden="true">
                <LoopGlyph step={n} />
              </span>
              <span class="loop__label">{t(`play.loop.s${n}`)}</span>
            </li>
          ))}
        </ol>
        <figcaption class="sr-only">{t('play.loop.sr')}</figcaption>
      </figure>
    </section>
  );
}

/** "Open source": one line and the GitHub button (a new tab; a match in another tab stays connected). */
export function OpenSource() {
  return (
    <section class="open-source" aria-labelledby="open-source-title">
      <div>
        <h2 id="open-source-title">{t('play.src.h')}</h2>
        <p>{t('play.src.p')}</p>
      </div>
      <ExternalLink href={SOURCE_URL} class="btn open-source__link" testid="play-source">
        <Icon name="code" />
        <span>{t('play.src.link')}</span>
        <Icon name="arrow" />
      </ExternalLink>
    </section>
  );
}
