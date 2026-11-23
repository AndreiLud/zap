// The quick rules dialog (data-testid="rules-dialog", CLIENT-SPEC 10.6), opened by R, the rules
// button on a table and the under-18 message. It loads on demand (lazy.tsx). It opens in the variant
// being played (a room or the guided match), else the one last chosen on the Play page, and shows
// this hand's manilhas when a vira is on the table, the order of the ten ranks in one line, truco in
// three steps, the keys and a link to the rules page.
//
// Opening it never touches the room connection: it only reads the store. At a table the link to
// the rules page opens in a new tab, so the match stays connected.

import '../styles/rules.css';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Variant } from '../../../engine/src/config.ts';
import { manilhaRankForVira, manilhasOf } from '../../../engine/src/cards.ts';
import { navigate, urlFor } from '../actions.ts';
import { isCard } from '../deck/names.ts';
import { callName, cardName } from '../game-text.ts';
import { t, type Key } from '../i18n.ts';
import { MINEIRO_FIXED, STRONG_FIRST, ladder, viraExample } from '../rules/logic.ts';
import { ManilhaCards, OrderLine, joinWords, orderLabel, tentos } from '../rules/parts.tsx';
import { store, type AppState } from '../store.ts';
import { Icon } from './icons.tsx';
import { KeysSwitch } from './KeysSwitch.tsx';

/** The variant chosen on the Play page, if this browser remembers one (localStorage zap-jogar). */
function rememberedVariant(): Variant | null {
  try {
    const raw = localStorage.getItem('zap-jogar');
    const v = raw ? (JSON.parse(raw) as { variante?: unknown }).variante : null;
    return v === 'paulista' || v === 'mineiro' ? v : null;
  } catch {
    return null;
  }
}

function atTable(s: AppState): boolean {
  return s.route.name === 'room' || s.route.name === 'guided';
}

/** The variant of the match on screen, if there is one. */
function variantInPlay(s: AppState): Variant | null {
  return atTable(s) ? (s.view?.variant ?? s.room?.room.settings.variant ?? null) : null;
}

function Manilhas({ s, variant }: { s: AppState; variant: Variant }) {
  if (variant === 'mineiro') {
    return (
      <section>
        <h3>{t('rulebook.dialog.manilhas.fixed')}</h3>
        <p class="rules-dialog__lead">{t('rulebook.dialog.manilhas.fixedLead')}</p>
        <ManilhaCards cards={MINEIRO_FIXED} size="small" label={t('rulebook.m.list')} />
      </section>
    );
  }
  const vira = variantInPlay(s) === 'paulista' && s.view && isCard(s.view.vira) ? s.view.vira : -1;
  if (vira < 0) {
    // No vira on the table: the rule, with the example of a vira 6.
    const ex = viraExample(2);
    return (
      <section>
        <h3>{t('rulebook.dialog.manilhas.general')}</h3>
        <p class="rules-dialog__lead">{t('rulebook.dialog.manilhas.generalLead')}</p>
        <ManilhaCards cards={ex.manilhas} size="small" label={t('rulebook.m.list')} />
      </section>
    );
  }
  const rank = manilhaRankForVira(vira);
  return (
    <section>
      <h3>{t('rulebook.dialog.manilhas')}</h3>
      <p class="rules-dialog__lead">{t('rulebook.dialog.manilhas.lead', { card: cardName(vira), rank: t(`rank.the.${rank}` as Key) })}</p>
      <ManilhaCards cards={manilhasOf('paulista', rank).reverse()} size="small" label={t('rulebook.m.list')} />
    </section>
  );
}

function Order({ s, variant }: { s: AppState; variant: Variant }) {
  const vira = variant === 'paulista' && variantInPlay(s) === 'paulista' && s.view && isCard(s.view.vira) ? s.view.vira : -1;
  const m = vira >= 0 ? manilhaRankForVira(vira) : null;
  const order = m === null ? STRONG_FIRST : [m, ...STRONG_FIRST.filter((r) => r !== m)];
  return (
    <section>
      <h3>{t('rulebook.dialog.order')}</h3>
      <OrderLine order={order} manilhaRank={m} label={orderLabel(order, m)} />
    </section>
  );
}

function TrucoSteps({ variant }: { variant: Variant }) {
  const values = ladder(variant);
  const later = values.slice(2).map((v, i) => callName(v, i + 2, false));
  return (
    <section>
      <h3>{t('rulebook.dialog.truco')}</h3>
      <ol class="rules-dialog__steps">
        <li>
          <p>
            <b>{t('rulebook.dialog.step1h')}</b> {t('rulebook.dialog.step1p', { from: tentos(values[0]), to: tentos(values[1]) })}
          </p>
        </li>
        <li>
          <p>
            <b>{t('rulebook.dialog.step2h')}</b> {t('rulebook.dialog.step2p', { run: tentos(values[0]), next: callName(values[2], 2, false) })}
          </p>
        </li>
        <li>
          <p>
            <b>{t('rulebook.dialog.step3h')}</b> {t('rulebook.dialog.step3p', { ladder: joinWords(later) })}
          </p>
        </li>
      </ol>
    </section>
  );
}

/** Short rules for the variant in play, with the full page one link away. */
export function RulesDialog({ s }: { s: AppState }) {
  const ref = useRef<HTMLDialogElement>(null);
  const initial = () => variantInPlay(s) ?? rememberedVariant() ?? 'paulista';
  const [variant, setVariant] = useState<Variant>(initial);
  const open = s.rulesOpen;

  useEffect(() => {
    // Light dismiss where the browser supports it; the click handler below covers the rest.
    ref.current?.setAttribute('closedby', 'any');
  }, []);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setVariant(initial());
      d.showModal();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  const close = () => store.set({ rulesOpen: false });
  const table = atTable(s);
  const more = `${urlFor({ name: 'rules' })}${variant === 'mineiro' ? '?variante=mineiro' : ''}`;

  return (
    <dialog
      ref={ref}
      class="modal rules-dialog"
      aria-labelledby="rules-title"
      data-testid="rules-dialog"
      onClose={() => store.get().rulesOpen && close()}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === ref.current) close();
      }}
    >
      {open ? (
        <>
          <div class="modal__top">
            <h2 id="rules-title">{t('rulebook.dialog.title')}</h2>
            <button type="button" class="icon-button" aria-label={t('common.close')} onClick={close}>
              <Icon name="close" />
            </button>
          </div>
          <div class="modal__body">
            <section class="rules-dialog__variant">
              <fieldset class="segmented">
                <legend class="sr-only">{t('field.variant')}</legend>
                {(['paulista', 'mineiro'] as const).map((v) => (
                  <label key={v} class="segmented__option">
                    <input type="radio" name="rules-dialog-variant" value={v} checked={variant === v} onChange={() => setVariant(v)} />
                    <span>{t(`variant.${v}`)}</span>
                  </label>
                ))}
              </fieldset>
            </section>
            <Manilhas s={s} variant={variant} />
            <Order s={s} variant={variant} />
            <TrucoSteps variant={variant} />
            <section class="rules-dialog__keys-section">
              <p class="rules-dialog__keys">{t('rulebook.dialog.keys')}</p>
              <KeysSwitch testid="keys-switch-rules" class="rules-dialog__keys-switch" />
            </section>
            <section>
              <a
                class="btn"
                href={more}
                data-testid="rules-dialog-more"
                target={table ? '_blank' : undefined}
                rel={table ? 'noopener' : undefined}
                onClick={(e) => {
                  if (table || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  close();
                  navigate({ name: 'rules' }, { search: variant === 'mineiro' ? '?variante=mineiro' : '' });
                }}
              >
                {t('rulebook.dialog.more')}
                {table ? <span class="sr-only"> {t('link.newtab')}</span> : null}
              </a>
            </section>
          </div>
        </>
      ) : null}
    </dialog>
  );
}
