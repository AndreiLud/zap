// The coach card of the guided first match (data-testid="coach", CLIENT-SPEC 10.5): one or two
// sentences about what just happened or what to do, and "Continuar" (coach-next) where the lesson
// waits for the reader. Before the deal it is the intro card ("Start", "Pular e escolher uma
// mesa"); after the hand, the outro card. The text is built here, in the current language, from
// the coach's steps (coach.ts), so switching languages keeps the lesson where it is.

import { useEffect, useRef, useState } from 'preact/hooks';
import { rankOf, suitOf } from '../../../engine/src/cards.ts';
import { movedInSite, navigate, urlFor } from '../actions.ts';
import { Link } from '../components/common.tsx';
import { callName, cardName } from '../game-text.ts';
import { t, type Key } from '../i18n.ts';
import { useStoreSelect } from '../store.ts';
import type { Arg, Line } from './coach.ts';
import type { LocalController } from './LocalController.ts';

/** The address of the outro's first button: a solo match against Otávio. */
export const OUTRO_SEARCH = '?modo=solo&contra=otavio';

function arg(a: Arg): string | number {
  if (typeof a === 'number') return a;
  if ('card' in a) return cardName(a.card);
  if ('cardThe' in a) return t('card.of', { rank: t(`rank.the.${rankOf(a.cardThe)}` as Key), suit: t(`suit.${suitOf(a.cardThe)}` as Key) });
  if ('who' in a) return t(`guide.name.${a.who}` as Key);
  if ('plural' in a) return t(`rulebook.pl.${a.plural}` as Key);
  return callName(a.call, a.step, false);
}

export function lineText(line: Line): string {
  const vars: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(line.args ?? {})) vars[k] = arg(v);
  return t(line.key, vars);
}

/** Re-renders the caller when the lesson moves. */
export function useLesson(ctl: LocalController): void {
  const [, tick] = useState(0);
  useEffect(() => ctl.subscribe(() => tick((x) => x + 1)), [ctl]);
}

function Intro({ ctl }: { ctl: LocalController }) {
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (movedInSite()) title.current?.focus();
  }, []);
  return (
    <section class="coach coach--intro" aria-labelledby="guided-intro-title">
      <h2 id="guided-intro-title" ref={title} tabIndex={-1}>
        {t('guide.title')}
      </h2>
      <p>{t('guide.intro')}</p>
      <div class="coach__buttons">
        <button type="button" class="btn btn--primary" data-testid="guided-start" onClick={() => ctl.start()}>
          {t('guide.start')}
        </button>
        <Link to={{ name: 'play' }} class="btn btn--quiet" testid="guided-skip">
          {t('guide.skip')}
        </Link>
      </div>
    </section>
  );
}

function Outro({ ctl }: { ctl: LocalController }) {
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // The lesson's last card takes the focus, unless the person is elsewhere (the menu, a dialog).
    const a = document.activeElement;
    if (!a || a === document.body || a.closest('.coach, [data-testid^="hand-card-"]')) title.current?.focus();
  }, []);
  const href = `${urlFor({ name: 'play' })}${OUTRO_SEARCH}`;
  return (
    <section class="coach coach--outro" aria-labelledby="guided-outro-title">
      <h2 id="guided-outro-title" ref={title} tabIndex={-1}>
        {t('guide.outro.title')}
      </h2>
      <p>{t('guide.outro.text')}</p>
      <div class="coach__buttons">
        <a
          class="btn btn--primary"
          href={href}
          data-testid="guided-outro-play"
          onClick={(e) => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            navigate({ name: 'play' }, { search: OUTRO_SEARCH });
          }}
        >
          {t('guide.outro.play')}
        </a>
        <button type="button" class="btn" onClick={() => ctl.restart()}>
          {t('guide.outro.again')}
        </button>
        <Link to={{ name: 'rules' }} class="btn btn--quiet">
          {t('guide.outro.rules')}
        </Link>
      </div>
    </section>
  );
}

function Lesson({ ctl }: { ctl: LocalController }) {
  const step = ctl.coach.shown();
  const waiting = step !== null && !step.done && step.wait === 'next';
  const button = useRef<HTMLButtonElement>(null);
  const seen = useRef<unknown>(null);
  useEffect(() => {
    // A new step that waits for the reader takes the focus when the focus was on the lesson
    // ("Start", the last "Continue", a card just played) or nowhere.
    if (!waiting || seen.current === step) return;
    seen.current = step;
    const a = document.activeElement;
    if (!a || a === document.body || a.closest('.coach')) button.current?.focus({ preventScroll: true });
  });
  return (
    <section class="coach" data-testid="coach" aria-label={t('guide.coach')}>
      <p class="coach__text" aria-live="polite">
        {step ? step.lines.map(lineText).join(' ') : ''}
      </p>
      {waiting ? (
        <button type="button" ref={button} class="btn btn--primary coach__next" data-testid="coach-next" onClick={() => ctl.next()}>
          {t('guide.next')}
        </button>
      ) : null}
    </section>
  );
}

/** The card for the current phase of the lesson, in the current language. */
export function CoachCard({ ctl }: { ctl: LocalController }) {
  useLesson(ctl);
  useStoreSelect((s) => s.lang);
  if (ctl.phase === 'intro') return <Intro ctl={ctl} />;
  if (ctl.phase === 'outro') return <Outro ctl={ctl} />;
  return <Lesson ctl={ctl} />;
}
