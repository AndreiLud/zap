// The rules page (/regras, /en/rules; CLIENT-SPEC 10.6). Port of the prototype regras.html with
// every rule the engine implements (project_docs/rules.md): a numbered section per idea, each with
// one picture or example. The variant switch at the top (mirrored in ?variante=) changes the
// sections that differ between paulista and mineiro. The glossary anchors (#glossario-<id>) are
// where the Term popovers lead: the page scrolls to the hash on every move here.

import '../styles/rules.css';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Variant } from '../../../engine/src/config.ts';
import { SIGNALS } from '../../../engine/src/engine.ts';
import { ExternalLink, Link } from '../components/common.tsx';
import { Term } from '../components/Term.tsx';
import { Card, CardBack } from '../deck/Card.tsx';
import { Medallion } from '../deck/tiles.tsx';
import { callName } from '../game-text.ts';
import { t, type Key } from '../i18n.ts';
import { usePageFocus } from '../page-focus.ts';
import { Glossary, SOURCES } from '../rules/glossary.tsx';
import { FixedManilhas, Ladder, OrderDuel, OrderLadder, RoundsTable, TrucoDemo, ViraLab } from '../rules/examples.tsx';
import { ladder, onzeFacts, searchForVariant, variantFromSearch } from '../rules/logic.ts';
import { Star, joinWords, tentos, tx } from '../rules/parts.tsx';
import type { AppState } from '../store.ts';

/** The three cards of the cover art: 3 of diamonds, 7 of clubs (with the manilha seal), king of hearts. */
const COVER_FAN = [36, 15, 26];

function Section(p: { n: number; id: string; title: string; lead?: ComponentChildren; more?: ComponentChildren; children?: ComponentChildren; testid?: string }) {
  return (
    <section class="section" aria-labelledby={`r-${p.id}`} data-testid={p.testid}>
      <div class="section__head section__head--num">
        <span class="section__num" aria-hidden="true">
          {p.n}
        </span>
        <h2 id={`r-${p.id}`}>{p.title}</h2>
        {p.lead ? <p>{p.lead}</p> : null}
        {p.more ? <p>{p.more}</p> : null}
      </div>
      {p.children}
    </section>
  );
}

function VariantSwitch({ variant, onChange }: { variant: Variant; onChange(v: Variant): void }) {
  return (
    <fieldset class="rules-variant">
      <legend class="sr-only">{t('rulebook.variant')}</legend>
      <div class="segmented">
        {(['paulista', 'mineiro'] as const).map((v) => (
          <label key={v} class="segmented__option" data-testid={`rules-variant-${v}`}>
            <input type="radio" name="rules-variant" value={v} checked={variant === v} onChange={() => onChange(v)} />
            <span>{t(`variant.${v}`)}</span>
          </label>
        ))}
      </div>
      <p class="rules-variant__hint">{t(variant === 'paulista' ? 'rulebook.variant.paulista' : 'rulebook.variant.mineiro')}</p>
    </fieldset>
  );
}

function TrucoSteps({ variant }: { variant: Variant }) {
  const values = ladder(variant);
  const words = values.slice(1).map((v, i) => callName(v, i + 1, false));
  return (
    <ol class="truco-steps">
      <li>
        <span class="truco-steps__n" aria-hidden="true">
          1
        </span>
        <h3>{t('rulebook.t.s1h')}</h3>
        <p>{t('rulebook.t.s1p', { from: tentos(values[0]), to: tentos(values[1]) })}</p>
        <div class="truco-steps__picture" aria-hidden="true">
          <span class="mini-btn mini-btn--bet">{t('call.truco')}</span>
          <span class="truco-steps__arrow">
            {values[0]} → {values[1]}
          </span>
        </div>
      </li>
      <li>
        <span class="truco-steps__n" aria-hidden="true">
          2
        </span>
        <h3>{t('rulebook.t.s2h')}</h3>
        <p>{t('rulebook.t.s2p', { to: tentos(values[1]), run: tentos(values[0]), next: callName(values[2], 2, false) })}</p>
        <div class="truco-steps__picture" aria-hidden="true">
          <span class="mini-btn mini-btn--accept">{t('rulebook.demo.accept')}</span>
          <span class="mini-btn">{t('rulebook.demo.run')}</span>
          <span class="mini-btn mini-btn--alert">{callName(values[2], 2, true)}</span>
        </div>
      </li>
      <li>
        <span class="truco-steps__n" aria-hidden="true">
          3
        </span>
        <h3>{t('rulebook.t.s3h')}</h3>
        <p>{t('rulebook.t.s3p', { ladder: joinWords(words) })}</p>
        <div class="truco-steps__picture">
          <Ladder values={values} on={1} />
        </div>
      </li>
    </ol>
  );
}

function OnzeSection({ n, variant }: { n: number; variant: Variant }) {
  const f = onzeFacts(variant);
  return (
    <Section
      n={n}
      id="onze"
      title={t(variant === 'paulista' ? 'rulebook.onze.h.paulista' : 'rulebook.onze.h.mineiro')}
      lead={t('rulebook.onze.p', { n: f.threshold, value: tentos(f.value), run: tentos(f.run) })}
      more={t('rulebook.ferro.p', { n: f.threshold })}
    >
      <div class="onze-picture" aria-hidden="true">
        <span class="onze-picture__score">{t('rulebook.onze.score', { us: f.threshold, them: 7 })}</span>
        <span class="mini-btn mini-btn--accept">{t('rulebook.onze.play', { value: f.value })}</span>
        <span class="mini-btn">{t('rulebook.onze.run', { points: f.run })}</span>
      </div>
    </Section>
  );
}

function TimeRing() {
  return (
    <figure class="time-ring">
      <svg viewBox="0 0 40 40" aria-hidden="true" focusable="false">
        <circle class="time-ring__track" cx="20" cy="20" r="17" />
        <circle class="time-ring__bar" cx="20" cy="20" r="17" pathLength="100" />
      </svg>
      <span class="time-ring__label" aria-hidden="true">
        30 s
      </span>
      <figcaption class="sr-only">{t('rulebook.time.ring')}</figcaption>
    </figure>
  );
}

const KEYS: { keys: string[]; text: Key }[] = [
  { keys: ['1', '2', '3'], text: 'rulebook.keys.cards' },
  { keys: ['T'], text: 'rulebook.keys.t' },
  { keys: ['A'], text: 'rulebook.keys.a' },
  { keys: ['C'], text: 'rulebook.keys.c' },
  { keys: ['E'], text: 'rulebook.keys.e' },
  { keys: ['R'], text: 'rulebook.keys.r' },
  { keys: ['Esc'], text: 'rulebook.keys.esc' },
  { keys: ['←', '→'], text: 'rulebook.keys.arrows' },
];

const HOUSE: { key: Key; mineiroOnly?: boolean }[] = [
  { key: 'rulebook.house.bestOf' },
  { key: 'rulebook.house.raiseAnyTime' },
  { key: 'rulebook.house.faceDown' },
  { key: 'rulebook.house.allTie' },
  { key: 'rulebook.house.iron' },
  { key: 'rulebook.house.ladder8', mineiroOnly: true },
  { key: 'rulebook.house.signals' },
  { key: 'rulebook.house.time' },
];

/** Scrolls to the glossary term of the address (#glossario-<id>) and puts the focus on it. */
function scrollToHash(): void {
  const id = decodeURIComponent(location.hash.slice(1));
  if (!id) return;
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ block: 'start' });
  if (el.tabIndex === -1) el.focus({ preventScroll: true });
}

export function RulesPage({ s }: { s: AppState }) {
  const [variant, setVariant] = useState<Variant>(() => variantFromSearch(location.search));
  const h1 = usePageFocus('page-rules');
  // A Term link (/regras#glossario-vira) lands here: after the router scrolled to the top, go to the term.
  useEffect(() => {
    scrollToHash();
  }, [s.route]);

  const pick = (v: Variant) => {
    setVariant(v);
    history.replaceState(history.state, '', location.pathname + searchForVariant(location.search, v) + location.hash);
  };

  let n = 0;
  const next = () => ++n;
  return (
    <main id="main" class="rules-page" data-testid="page-rules">
      <header class="cover cover--art">
        <div class="cover__text">
          <p class="kicker">{t('rulebook.kicker')}</p>
          <h1 ref={h1} tabIndex={-1}>
            {t('rulebook.h1')}
          </h1>
          <p class="cover__lead">{t('rulebook.lead')}</p>
        </div>
        <div class="cover__art" aria-hidden="true">
          <Medallion class="medallion rules-medallion" />
          <div class="cover__fan">
            {COVER_FAN.map((c) => (
              <span key={c}>
                <Card card={c} manilha={c === 15} />
              </span>
            ))}
          </div>
        </div>
      </header>

      <VariantSwitch variant={variant} onChange={pick} />

      <Section n={next()} id="order" title={t('rulebook.order.h')} lead={t('rulebook.order.p')}>
        <OrderLadder />
        <p class="manilha-note">
          <Star />
          <span>
            {tx(variant === 'paulista' ? 'rulebook.order.note.paulista' : 'rulebook.order.note.mineiro', {
              manilhas: <Term id="manilha">{t('rulebook.word.manilhas')}</Term>,
            })}
          </span>
        </p>
        <OrderDuel />
      </Section>

      {variant === 'paulista' ? (
        <Section n={next()} id="manilha" title={t('rulebook.m.h')} lead={t('rulebook.m.p')}>
          <ViraLab />
        </Section>
      ) : (
        <Section n={next()} id="manilha" title={t('rulebook.m.h.mineiro')} lead={t('rulebook.m.p.mineiro')}>
          <FixedManilhas />
        </Section>
      )}

      <Section n={next()} id="rounds" title={t('rulebook.rounds.h')} lead={t('rulebook.rounds.p')}>
        <RoundsTable />
      </Section>

      <Section n={next()} id="truco" title={t('rulebook.t.h')} lead={tx('rulebook.t.p', { truco: <Term id="truco">{t('rulebook.word.truco')}</Term> })}>
        <TrucoSteps variant={variant} />
        {variant === 'mineiro' ? <p class="rules-note">{t('rulebook.t.ladder8')}</p> : null}
        <TrucoDemo key={variant} variant={variant} />
      </Section>

      <OnzeSection n={next()} variant={variant} />

      <Section n={next()} id="cover" title={t('rulebook.cover.h')} lead={t('rulebook.cover.p')}>
        <figure class="cover-card">
          <div class="cover-card__pair" aria-hidden="true">
            <span class="cover-card__card">
              <CardBack />
              <small>{t('rulebook.cover.down')}</small>
            </span>
            <span class="cover-card__vs">&lt;</span>
            <span class="cover-card__card">
              <Card card={0} />
              <small>{t('rulebook.cover.up')}</small>
            </span>
          </div>
          <figcaption>{t('rulebook.cover.caption')}</figcaption>
        </figure>
      </Section>

      <Section n={next()} id="signals" title={t('rulebook.signals.h')} lead={t('rulebook.signals.p')}>
        <ul class="signal-chips" aria-label={t('rulebook.signals.list')}>
          {SIGNALS.map((x) => (
            <li key={x}>{t(`signal.${x}` as Key)}</li>
          ))}
        </ul>
      </Section>

      <Section n={next()} id="time" title={t('rulebook.time.h')} lead={t('rulebook.time.p')}>
        <div class="time-row">
          <TimeRing />
          <p>{t('rulebook.time.rooms')}</p>
        </div>
      </Section>

      <Section
        n={next()}
        id="match"
        title={t('rulebook.match.h')}
        lead={tx('rulebook.match.p', {
          tentos: <Term id="tento">{t('rulebook.word.tentos')}</Term>,
          queda: <Term id="queda">{t('rulebook.word.queda')}</Term>,
        })}
      >
        <figure class="score-marks-picture">
          <span class="score-marks-picture__marks" aria-hidden="true">
            {Array.from({ length: 12 }, (_, i) => (
              <i key={i} />
            ))}
          </span>
          <figcaption>{t('rulebook.match.marks')}</figcaption>
        </figure>
      </Section>

      <Section n={next()} id="house" title={t('rulebook.house.h')} lead={t('rulebook.house.p')}>
        <ul class="house-list">
          {HOUSE.filter((h) => !h.mineiroOnly || variant === 'mineiro').map((h) => (
            <li key={h.key}>{t(h.key)}</li>
          ))}
        </ul>
      </Section>

      <Section n={next()} id="keys" title={t('rulebook.keys.h')} lead={t('rulebook.keys.p')}>
        <dl class="keys-list">
          {KEYS.map((k) => (
            <div key={k.text} class="keys-list__row">
              <dt>
                {k.keys.map((x) => (
                  <kbd key={x}>{x}</kbd>
                ))}
                {k.keys[0] === '←' ? <span class="sr-only">{t('rulebook.keys.arrowsName')}</span> : null}
              </dt>
              <dd>{t(k.text)}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section n={next()} id="glossary" title={t('rulebook.glossary.h')} lead={t('rulebook.glossary.p')}>
        <Glossary />
      </Section>

      <Section n={next()} id="sources" title={t('rulebook.sources.h')} lead={t('rulebook.sources.p')}>
        <ul class="sources-list">
          {SOURCES.map((src) => (
            <li key={src.key}>
              <ExternalLink href={src.href}>{t(src.key)}</ExternalLink>
            </li>
          ))}
        </ul>
      </Section>

      <section class="section section--cta" aria-labelledby="r-cta">
        <h2 id="r-cta" class="sr-only">
          {t('rulebook.cta.h')}
        </h2>
        <div class="cta-row">
          <Link to={{ name: 'play' }} class="btn btn--primary btn--big">
            {t('rulebook.cta.play')}
          </Link>
          <Link to={{ name: 'guided' }} class="btn btn--outline">
            {t('rulebook.cta.guided')}
          </Link>
          <Link to={{ name: 'data' }} class="btn btn--outline">
            {t('rulebook.cta.data')}
          </Link>
        </div>
      </section>
    </main>
  );
}
