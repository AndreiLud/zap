// F2 "Como o Zap aprendeu" (DATA-SPEC 4.2): four illustrated steps (copied rules; played itself and
// older versions; scores when the chance goes up; in training a coach sees every card, at the
// table only its own), then what the network is made of, as one row of facts from the model file.
// The pictures are drawings, not measurements; every number in the text comes from the generated
// files (curve.json for the hands, facts-view.json for the model and its timing).

import type { ComponentChildren } from 'preact';
import { Avatar } from '../../components/pieces.tsx';
import { t, type Key } from '../../i18n.ts';
import { td } from '../i18n-data.ts';
import { CURVE, FACTS, READING, lineage, ms, storyVersion, useData } from '../load.ts';
import { MiniTable, TABLE_DEAL } from './MiniTable.tsx';

function Rules() {
  return (
    <span class="dp-ill dp-ill--rules">
      <span class="dp-ill__note">
        <i />
        <i />
        <i />
        <i />
      </span>
      <svg class="dp-ill__arrow" viewBox="0 0 24 12" aria-hidden="true" focusable="false">
        <path d="M1 6h19M15 1.5 20.5 6 15 10.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <Avatar persona="zap" />
    </span>
  );
}

function SelfPlay() {
  return (
    <span class="dp-ill dp-ill--self">
      {(['n', 'w', 'e', 's'] as const).map((p) => (
        <span key={p} class={`dp-ill__seat dp-ill__seat--${p}`}>
          <Avatar persona="zap" />
        </span>
      ))}
      <svg class="dp-ill__turn" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M19 12a7 7 0 1 1-2.05-4.95" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        <path d="M19.5 4v4h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </span>
  );
}

function Reward() {
  return (
    <span class="dp-ill dp-ill--reward">
      <span class="dp-ill__cap">{t('data.learn.chance')}</span>
      <span class="dp-ill__row">
        <span>{t('data.learn.before')}</span>
        <i>
          <b />
        </i>
        <em />
      </span>
      <span class="dp-ill__row">
        <span>{t('data.learn.after')}</span>
        <i>
          <b />
          <b class="is-gain" />
        </i>
        <em>+</em>
      </span>
    </span>
  );
}

/** A step; its number is the list's own (a CSS counter), so no digit is typed here. */
function Step({ h, p, fig }: { h: Key; p: ComponentChildren; fig: ComponentChildren }) {
  return (
    <li class="dp-step">
      <div class="dp-step__fig" aria-hidden="true">
        {fig}
      </div>
      <div class="dp-step__txt">
        <h4>
          <span class="dp-step__n" aria-hidden="true" />
          <span>{t(h)}</span>
        </h4>
        <p>{p}</p>
      </div>
    </li>
  );
}

export function Learned() {
  const { f, served, reads } = useData();
  const story = storyVersion(CURVE.rows, served);
  // A row's hands already count its whole lineage: tools/data/curve.ts adds the parent's hands up
  // to the snapshot it started from (v2: the twin's own hands plus v1's), so the last
  // row of the lineage is the total, never a sum of rows.
  const row = lineage(CURVE.rows, story).at(-1);
  const hands = row ? row.hands : null;
  const model = FACTS.model;
  const cards = TABLE_DEAL.n.length;
  const seats = Object.keys(TABLE_DEAL).length;
  // The adaptive network times its own decisions; the twin and v1 have ai.decisionTime.
  const time = model.features === 'v2' && reads && READING.decisionTime ? READING.decisionTime : FACTS.ai.decisionTime;
  return (
    <section id="aprendeu" class="dp-block" aria-labelledby="aprendeu-t">
      <h3 id="aprendeu-t" class="figure__title">
        {t('data.learn.h')}
      </h3>
      <ol class="dp-steps">
        <Step h="data.learn.1h" p={td('data.learn.1p')} fig={<Rules />} />
        <Step h="data.learn.2h" p={hands !== null ? td(hands >= 1_000_000 ? 'data.learn.2pM' : 'data.learn.2p', { hands: f.big(hands) }) : td('data.learn.2p0')} fig={<SelfPlay />} />
        <Step h="data.learn.3h" p={td('data.learn.3p')} fig={<Reward />} />
        <li class="dp-step dp-step--wide">
          <div class="dp-step__txt">
            <h4>
              <span class="dp-step__n" aria-hidden="true" />
              <span>{t('data.learn.4h')}</span>
            </h4>
            <p>{td('data.learn.4p')}</p>
          </div>
          <div class="dp-contrast">
            <figure class="dp-mini">
              <MiniTable deal={TABLE_DEAL} zapAt="s" eye />
              <figcaption>
                <b>{t('data.learn.4a')}</b>
                <span>{t('data.learn.4as', { n: f.int(cards * seats) })}</span>
              </figcaption>
            </figure>
            <figure class="dp-mini">
              <MiniTable deal={TABLE_DEAL} zapAt="s" backs={['n', 'e', 'w']} />
              <figcaption>
                <b>{t('data.learn.4b')}</b>
                <span>{t('data.learn.4bs', { k: f.int(cards) })}</span>
              </figcaption>
            </figure>
          </div>
        </li>
      </ol>
      <div class="dp-net">
        <p class="dp-net__h">{td('data.learn.net')}</p>
        <dl class="dp-facts">
          <div>
            <dt>{t('data.learn.f.in')}</dt>
            <dd>{f.int(model.inputs)}</dd>
          </div>
          <div>
            <dt>{td('data.learn.f.w')}</dt>
            <dd>{f.big(model.weights)}</dd>
          </div>
          <div>
            <dt>{t('data.learn.f.kb')}</dt>
            <dd>{f.kb(model.bytes)}</dd>
          </div>
          {time ? (
            <div>
              <dt>{t('data.learn.f.ms')}</dt>
              <dd>{f.ms(time.decisionMs.p50)}</dd>
            </div>
          ) : null}
        </dl>
      </div>
      <p class="source source--plain">
        {time ? t('data.src.learn', { version: model.version, date: f.date(ms(time.measuredAt)) }) : t('data.src.learn0', { version: model.version })}
      </p>
    </section>
  );
}
