// The table chooser of the Play page (CLIENT-SPEC 10.2, prototype jogar.html and jogar.js): the
// three mode tiles, the variant switch with its manilha hint, and the opponents picker. Native
// radios and checkboxes inside labels, so arrow keys, Space and screen readers work as usual; the
// testids sit on the labels.

import type { PersonaId } from '../../../ai/src/personas.ts';
import type { Variant } from '../../../engine/src/config.ts';
import { AiMark, Avatar } from '../components/pieces.tsx';
import { Term } from '../components/Term.tsx';
import { MiniCard, RankText } from '../deck/Card.tsx';
import { PERSONA_IDS, PERSONA_NAMES, cardName } from '../game-text.ts';
import { t, type Key } from '../i18n.ts';
import { CheckMark, MODE_SPOTS, MiniTable } from './drawings.tsx';
import { Rich } from './rich.tsx';
import { LEVEL_BARS, MODES, VARIANTS, type PlayMode } from './state.ts';

const MODE_TESTID: Record<PlayMode, string> = { dupla: 'mode-2x2', solo: 'mode-1x1', sala: 'mode-room' };

export function ModePicker({ value, onChange, labelledBy }: { value: PlayMode; onChange(m: PlayMode): void; labelledBy: string }) {
  return (
    <div class="modes" role="radiogroup" aria-labelledby={labelledBy}>
      {MODES.map((m) => {
        const on = m === value;
        return (
          <label key={m} class={`mode${on ? ' is-chosen' : ''}`} data-testid={MODE_TESTID[m]}>
            <input type="radio" name="play-mode" value={m} checked={on} onChange={() => onChange(m)} />
            <MiniTable spots={MODE_SPOTS[m]} class="mode__table" />
            <b>{t(`play.mode.${m}`)}</b>
            {on ? <CheckMark class="mode__check" /> : null}
          </label>
        );
      })}
    </div>
  );
}

// Card ids (rank * 4 + suit; ranks 4 5 6 7 Q J K A 2 3, suits d s h c) for the hint chips.
const SIX_OF_HEARTS = 10;
/** The four fixed manilhas of mineiro, strongest first: 4 of clubs, 7 of hearts, ace of spades, 7 of diamonds. */
const MINEIRO_MANILHAS = [3, 14, 29, 12];

/** The variant switch, and under it what the variant means for the manilha. */
export function VariantPicker({ value, onChange }: { value: Variant; onChange(v: Variant): void }) {
  return (
    <div class="variant">
      <span class="variant__label" id="variant-label">
        {t('play.variant')}
      </span>
      <div class="segmented" role="radiogroup" aria-labelledby="variant-label">
        {VARIANTS.map((v) => (
          <label key={v} class={v === value ? 'is-chosen' : undefined} data-testid={`variant-${v}`}>
            <input type="radio" name="play-variant" value={v} checked={v === value} aria-describedby="variant-hint" onChange={() => onChange(v)} />
            <span>{t(`play.v.${v}`)}</span>
          </label>
        ))}
      </div>
      <p class="variant__hint" id="variant-hint">
        {value === 'paulista' ? (
          <>
            <span class="variant__chips" aria-hidden="true">
              <MiniCard card={SIX_OF_HEARTS} label={cardName(SIX_OF_HEARTS)} />
              <svg class="variant__arrow" viewBox="0 0 16 10" focusable="false">
                <path d="M1 5h12M9.5 1.5 13 5 9.5 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <span class="mini-card mini-card--rank mini-card--manilha">
                <span class="mini-card__rank">
                  <RankText rank="7" />
                </span>
              </span>
            </span>
            <span>
              <Rich k="play.v.paulista.tip" parts={{ manilha: <Term id="manilha" />, vira: <Term id="vira" /> }} />
              <span class="sr-only"> {t('play.v.paulista.sr')}</span>
            </span>
          </>
        ) : (
          <>
            <span class="variant__chips" aria-hidden="true">
              {MINEIRO_MANILHAS.map((c) => (
                <MiniCard key={c} card={c} label={cardName(c)} class="mini-card--manilha" />
              ))}
            </span>
            <span>
              <Rich k="play.v.mineiro.tip" parts={{ manilhas: <Term id="manilha">{t('play.v.manilhas')}</Term> }} />
              <span class="sr-only"> {t('play.v.mineiro.sr')}</span>
            </span>
          </>
        )}
      </p>
    </div>
  );
}

/** "Zap e Bento", "Zap", or "falta escolher". */
export function namesOf(ids: readonly PersonaId[]): string {
  if (ids.length === 0) return t('play.opp.none');
  if (ids.length === 1) return PERSONA_NAMES[ids[0]];
  return t('play.opp.pair', { a: PERSONA_NAMES[ids[0]], b: PERSONA_NAMES[ids[1]] });
}

function styleLine(id: PersonaId): string {
  const style = t(`persona.${id}.style`);
  const level = t(`persona.${id}.level`);
  return style === level ? style : t('play.opp.line', { style, level });
}

/**
 * Who you face: a quiet summary row (avatars, names, "Trocar") that folds out the six characters.
 * One opponent uses radios; two use checkboxes, first in first out. `label` names the row
 * ("Opponents", or "AI in empty seats" for a room).
 */
export function OpponentPicker(props: {
  list: readonly PersonaId[];
  size: 1 | 2;
  label: Key;
  open: boolean;
  onOpen(open: boolean): void;
  onPick(id: PersonaId, checked: boolean): void;
}) {
  const { list, size } = props;
  return (
    <details class="opponents" open={props.open} onToggle={(e) => props.onOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary data-testid="opponents-toggle">
        <span class="opponents__stack">
          {list.map((id) => (
            <Avatar key={id} persona={id} />
          ))}
        </span>
        <span class="opponents__text">
          <span class="opponents__label">{t(props.label)}</span>
          <span class="opponents__who">{namesOf(list)}</span>
        </span>
        <span class="opponents__change">
          <span>{t('play.opp.change')}</span>
          <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
            <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
      </summary>
      <fieldset class="opponents__list">
        <legend>{t(size === 1 ? 'play.opp.legend1' : 'play.opp.legend2')}</legend>
        {size === 2 ? <p class="play__note">{t('play.opp.fifo')}</p> : null}
        <div class="characters">
          {PERSONA_IDS.map((id) => (
            <label key={id} class={`character${list.includes(id) ? ' is-chosen' : ''}`} data-testid={`opponent-${id}`}>
              <input
                type={size === 1 ? 'radio' : 'checkbox'}
                name="play-opponents"
                value={id}
                checked={list.includes(id)}
                onChange={(e) => props.onPick(id, e.currentTarget.checked)}
              />
              <Avatar persona={id} />
              <span class="character__text">
                <span class="character__name">
                  <span>{PERSONA_NAMES[id]}</span>
                  <AiMark />
                </span>
                <span class="character__line">{styleLine(id)}</span>
              </span>
              <span class="level" aria-hidden="true">
                {[1, 2, 3, 4].map((k) => (
                  <i key={k} class={k <= LEVEL_BARS[id] ? 'is-on' : undefined} />
                ))}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    </details>
  );
}
