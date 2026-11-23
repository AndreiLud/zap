// The row about this hand (CLIENT-SPEC 11.8): the vira (a mini card with real text, or a dashed spot
// before the deal, with the rest of the deck as a small back pile once dealt), the manilha (an ochre
// tile, a dashed spot, or "fixas" in mineiro), what the hand is worth, and the three round slots.
// "vira", "manilha" and "tentos" are glossary terms. In the first real match on a device (not the
// guided one, whose coach explains them), a one line hint explains them once (localStorage
// 'zap-terms-seen'). While a raise waits, the value shows "1 → 3 tentos", the proposed value in outline.

import { useEffect, useState } from 'preact/hooks';
import { TIE } from '../../../engine/src/engine.ts';
import { Term } from '../components/Term.tsx';
import { currentController } from '../controller.ts';
import { MiniCard, RankText } from '../deck/Card.tsx';
import { RANK_TEXTS } from '../deck/geometry.ts';
import { cardName, seatName } from '../game-text.ts';
import { t, type Key } from '../i18n.ts';
import { mediaMatches } from '../media.ts';
import type { Model } from './model.ts';
import type { Scene } from './motion.ts';

const SEEN_KEY = 'zap-terms-seen';
const SHORT_PHONE = '(max-width: 63.99em) and (max-height: 700px)';

function readSeen(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function addSeen(ids: string[]): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...new Set([...readSeen(), ...ids])]));
  } catch {
    // Storage blocked: the hint may show again next time.
  }
}

/** Which first-time hint this hand shows, decided once per hand. */
function useFirstHint(m: Model): 'vira' | 'tentos' | null {
  const v = m.v;
  const [hint, setHint] = useState<{ key: string; id: 'vira' | 'tentos' | null }>({ key: '', id: null });
  const key = `${v.matchNo}:${v.handIndex}:${v.dealt ? 'd' : 'p'}:${v.handResult ? 'e' : ''}`;
  useEffect(() => {
    if (hint.key === key) return;
    const seen = readSeen();
    let id: 'vira' | 'tentos' | null = hint.id;
    // Short phones have no room for the line (the table must not scroll); the terms stay tappable.
    // The guided match's coach explains these words itself, so the hint waits for a real match.
    if (!v.dealt || mediaMatches(SHORT_PHONE) || currentController()?.kind !== 'room') id = null;
    else if (v.handResult && !seen.includes('tento')) {
      id = 'tentos';
      addSeen(['tento']);
    } else if (!v.handResult && v.variant === 'paulista' && v.vira >= 0 && !seen.includes('vira')) {
      id = 'vira';
      addSeen(['vira', 'manilha']);
    } else if (!v.handResult && hint.id === 'tentos') id = null;
    setHint({ key, id });
  }, [key]);
  return hint.key === key ? hint.id : null;
}

export function HandInfo({ m, scene }: { m: Model; scene: Scene }) {
  const v = m.v;
  // After the hand the vira stays in the row, alone, as a record of the hand that ended.
  const pile = v.dealt && !scene.deckOnTable;
  const paulista = v.variant === 'paulista';
  const viraShown = v.dealt && paulista && v.vira >= 0;
  const hint = useFirstHint(m);
  // The value proposed by a pending raise shows in outline next to the value.
  const proposed = v.phase === 'raise' && v.proposed > 0 ? v.proposed : 0;
  const rounds = v.dealt ? v.rounds : [];
  const roundWho = (r: { result: number; winnerSeat: number }) =>
    r.result === TIE ? t('board.round.tie') : m.n === 4 ? t(r.result === m.team ? 'board.team.us' : 'board.team.them') : seatName(m.names, r.winnerSeat);
  return (
    <>
      <section class="hand-info" data-testid="hand-info" aria-labelledby="hand-info-title">
        <h2 id="hand-info-title" class="sr-only">
          {t('board.info.title')}
        </h2>
        <div class="hand-info__cell hand-info__cell--vira">
          <span class="hand-info__label">{paulista ? <Term id="vira">{t('board.c.vira')}</Term> : t('board.c.deck')}</span>
          <span class="hand-info__value">
            <span class={`pile${pile && viraShown ? '' : ' pile--alone'}`}>
              {pile ? <span class="pile__back mini-card mini-card--back" aria-hidden="true" data-card="-1" /> : null}
              {!paulista ? null : viraShown ? (
                <MiniCard key={`vira-${v.matchNo}-${v.handIndex}`} card={v.vira} label={`${t('board.c.vira')}: ${cardName(v.vira)}`} class="pile__vira" />
              ) : (
                <span class="mini-card mini-card--slot" role="img" aria-label={`${t('board.c.vira')}: ${t('board.c.vira.wait')}`} />
              )}
            </span>
          </span>
        </div>
        <div class="hand-info__cell">
          <span class="hand-info__label">
            <Term id="manilha">{t('board.c.manilha')}</Term>
          </span>
          <span class="hand-info__value">
            {!paulista ? (
              <span class="hand-info__fixed">{t('board.c.fixed')}</span>
            ) : viraShown && v.manilhaRank >= 0 ? (
              <span class="manilha-tile" key={`m-${v.matchNo}-${v.handIndex}`} role="img" aria-label={`${t('board.c.manilha')}: ${t(`rank.${v.manilhaRank}` as Key)}`}>
                <span aria-hidden="true">
                  <RankText rank={RANK_TEXTS[v.manilhaRank]} />
                </span>
              </span>
            ) : (
              <span class="manilha-tile is-empty" role="img" aria-label={`${t('board.c.manilha')}: ${t('board.c.manilha.wait')}`} />
            )}
          </span>
        </div>
        <div class="hand-info__cell hand-info__cell--value">
          <span class="hand-info__label">{t('board.c.value')}</span>
          <span class={`hand-info__value${proposed ? ' has-proposed' : ''}`}>
            <span class="hand-info__num" key={`v-${v.value}`}>
              {v.value}
            </span>
            {proposed ? (
              <span class="hand-info__proposed">
                <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
                  <path d="M1.5 6h8M6.5 2.8 9.7 6l-3.2 3.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <b aria-hidden="true">{proposed}</b>
                <span class="sr-only">{t('board.c.proposed', { value: proposed })}</span>
              </span>
            ) : null}
            <small>
              <Term id="tento">{t((proposed || v.value) === 1 ? 'board.c.tento' : 'board.c.tentos')}</Term>
            </small>
          </span>
        </div>
        <div class="hand-info__cell hand-info__cell--rounds">
          <span class="hand-info__label">{t('board.c.rounds')}</span>
          <span class="hand-info__value">
            <ol class="rounds">
              {[0, 1, 2].map((i) => {
                const r = rounds[i];
                const done = r && r.result >= 0;
                const who = done ? (r.result === TIE ? 'tie' : r.result === m.team ? 'us' : 'them') : undefined;
                const now = v.dealt && !v.handResult && i === v.round && !done && (v.phase === 'play' || v.phase === 'raise');
                return (
                  <li key={i} data-round-slot={i} data-r={who} class={now ? 'is-now' : undefined}>
                    <i aria-hidden="true">{who === 'tie' ? '=' : i + 1}</i>
                    <span class="sr-only">{done ? t('board.round.result', { n: i + 1, who: roundWho(r) }) : t('board.round.n', { n: i + 1 })}</span>
                  </li>
                );
              })}
            </ol>
          </span>
        </div>
      </section>
      {hint ? <p class="first-hint">{t(hint === 'vira' ? 'board.first.vira' : 'board.first.tentos')}</p> : null}
    </>
  );
}
