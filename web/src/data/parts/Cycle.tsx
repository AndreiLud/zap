// F1 "Every game becomes a lesson" (DATA-SPEC 4.1): the six steps of the weekly cycle, the stored play
// as step 2's picture, the duel's fork at step 4 and its rules from cycle-rules.json. A line under
// the cycle says, from the summary, whether any version has trained on people's games yet (the
// cycle is built and waits for them; _local/m6/claims.md).
//
// The stored play is an illustration: fixed card ids and a score, not a measurement.

import type { ComponentChildren } from 'preact';
import { Icon } from '../../components/icons.tsx';
import { MiniCard } from '../../deck/Card.tsx';
import { cardName } from '../../game-text.ts';
import { t, type Key } from '../../i18n.ts';
import { tdText, td } from '../i18n-data.ts';
import { FACTS, RULES, useData } from '../load.ts';

/** The illustration: what one seat saw and did. Engine ids (rank * 4 + suit; vira 6 of hearts, so sevens are manilhas). */
const SAMPLE = { hand: [13, 36, 27], manilhas: [13], vira: 10, played: 36, score: [7, 9] as const };

/** The rules file the duel's numbers come from (cycle-rules.json provenance). */
const RULES_FILE = RULES.provenance.inputs.find((i) => i.path.endsWith('.toml'))?.path ?? '';

const S = { fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } as const;

function Glyph({ children }: { children: ComponentChildren }) {
  return (
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

const ICONS: (() => ComponentChildren)[] = [
  () => <Icon name="play" />,
  () => (
    <Glyph>
      <rect x="5" y="3" width="14" height="18" rx="2" {...S} />
      <path d="M8.5 8.5h7M8.5 12.5h7M8.5 16.5h4" {...S} />
    </Glyph>
  ),
  () => (
    <Glyph>
      <g {...S}>
        <circle cx="5" cy="7" r="2" />
        <circle cx="5" cy="17" r="2" />
        <circle cx="12" cy="12" r="2" />
        <circle cx="19" cy="7" r="2" />
        <circle cx="19" cy="17" r="2" />
        <path d="M6.8 8 10.2 11M6.8 16 10.2 13M13.8 11 17.2 8M13.8 13 17.2 16" />
      </g>
    </Glyph>
  ),
  () => (
    <Glyph>
      <path d="M3 5a7 7 0 0 1 0 14Z" fill="currentColor" />
      <path d="M21 5a7 7 0 0 0 0 14Z" fill="currentColor" opacity=".55" />
    </Glyph>
  ),
  () => (
    <Glyph>
      <path d="M5 12.5 10 17.5 19.5 7" {...S} stroke-width="2.6" />
    </Glyph>
  ),
  () => <Icon name="data" />,
];

function Back() {
  return (
    <Glyph>
      <path d="M9 5 4.5 9.5 9 14" {...S} />
      <path d="M5 9.5h9.5a5 5 0 0 1 0 10H11" {...S} />
    </Glyph>
  );
}

/** A card as text and glyph, named for screen readers; a manilha carries the ochre corner. */
export function CardChip({ card, manilha }: { card: number; manilha?: boolean }) {
  const name = manilha ? `${cardName(card)}, ${t('data.cycle.r.manilha')}` : cardName(card);
  return <MiniCard card={card} label={name} class={`dp-card${manilha ? ' dp-card--m' : ''}`} />;
}

function Record() {
  const { f } = useData();
  return (
    <dl class="dp-record">
      <div>
        <dt>{t('data.cycle.r.saw')}</dt>
        <dd>
          {SAMPLE.hand.map((c) => (
            <CardChip key={c} card={c} manilha={SAMPLE.manilhas.includes(c)} />
          ))}
          <span class="dp-record__et">{t('data.cycle.r.vira')}</span>
          <CardChip card={SAMPLE.vira} />
          <span class="dp-record__et">{t('data.cycle.r.score', { score: f.score(SAMPLE.score[0], SAMPLE.score[1]) })}</span>
        </dd>
      </div>
      <div>
        <dt>{t('data.cycle.r.did')}</dt>
        <dd>
          <span class="dp-record__et">{t('data.cycle.r.played')}</span>
          <CardChip card={SAMPLE.played} />
        </dd>
      </div>
      <div class="dp-record__no">
        <dt>{t('data.cycle.r.who')}</dt>
        <dd>
          <Glyph>
            <circle cx="12" cy="8" r="3.5" {...S} />
            <path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5M4 4l16 16" {...S} />
          </Glyph>
          <span>{t('data.cycle.r.none')}</span>
        </dd>
      </div>
    </dl>
  );
}

const STEPS: Key[] = ['data.cycle.s1', 'data.cycle.s2', 'data.cycle.s3', 'data.cycle.s4', 'data.cycle.s5', 'data.cycle.s6'];

/** The duel's rules in words, from training/cycle/config/prod.toml (and the summary's A/B window). */
function DuelRules() {
  const { f, summary } = useData();
  const g = RULES.gate;
  const ab = RULES.ab;
  const seconds = (FACTS.cycle.gate as { seconds: number | null }).seconds;
  const detectable = summary.kind === 'ready' ? (summary.summary.ab?.detectablePoints ?? null) : null;
  return (
    <details class="dp-duel">
      <summary>{t('data.cycle.duel.more')}</summary>
      <ul>
        <li>{t('data.cycle.duel.1', { gain: f.per100(g.p1 - g.p0) })}</li>
        <li>{t('data.cycle.duel.2', { seg: f.per100(g.segment_margin), panel: f.per100(g.panel_margin) })}</li>
        <li>{t('data.cycle.duel.3', { days: f.int(ab.days), share: f.pct(ab.share, 0), people: f.int(RULES.MIN_PEOPLE), drop: f.per100(ab.rollback_drop) })}</li>
        {seconds !== null ? <li>{t('data.cycle.duel.4', { time: f.int(Math.round(seconds / 60)) })}</li> : null}
        {detectable !== null ? <li>{t('data.cycle.duel.5', { d: f.per100(detectable) })}</li> : null}
      </ul>
    </details>
  );
}

/** Whether the cycle has trained a version on people's games yet, and when it runs. */
function CycleState() {
  const { f, summary } = useData();
  if (summary.kind === 'loading' || summary.kind === 'unavailable') return null;
  const versions = summary.kind === 'ready' ? summary.summary.versions : [];
  const withPeople = versions.filter((v) => v.result === 'promoted' && (v.data?.validMatches ?? 0) > 0);
  const last = withPeople[withPeople.length - 1];
  return (
    <p class="dp-note" data-testid="cycle-state">
      {t('data.cycle.when', { n: f.int(RULES.schedule.new_matches) })}{' '}
      {last ? t('data.cycle.people', { v: last.version, m: f.int(last.data!.validMatches) }) : t('data.cycle.waiting')}
    </p>
  );
}

export function Cycle() {
  return (
    <section id="ciclo" class="dp-block" aria-labelledby="ciclo-t">
      <h3 id="ciclo-t" class="figure__title">
        {t('data.cycle.h')}
      </h3>
      <p class="dp-sub">{td('data.cycle.p')}</p>
      <div class="dp-cycle">
        <ol class="dp-cycle__list">
          {STEPS.map((k, i) => (
            <li key={k} class={`dp-cycle__step${i === 3 ? ' is-duel' : ''}${i === 1 ? ' is-record' : ''}`}>
              <span class="dp-cycle__ic" aria-hidden="true">
                {ICONS[i]()}
              </span>
              <div class="dp-cycle__txt">
                <b>{t(k)}</b>
                {i === 1 ? <Record /> : null}
                {i === 3 ? (
                  <span class="dp-cycle__fork">
                    <Back />
                    {t('data.cycle.s4x')}
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
        <p class="dp-cycle__loop">
          <Back />
          <span aria-hidden="true">{t('data.cycle.loop')}</span>
          <span class="sr-only">{t('data.cycle.loopSr')}</span>
        </p>
      </div>
      <DuelRules />
      <CycleState />
      <p class="source source--plain">{tdText('data.src.cycle', { file: RULES_FILE })}</p>
    </section>
  );
}
