// The trick in a cross (CLIENT-SPEC 11.3): north and south at 0.58 of a card height from the centre,
// east and west about one card width, so the cards meet only at the corners and every index shows.
// A resolved round outlines the winner in ochre with its tag ("Zap leva") and dims the others; a tie
// says "Empate" in the middle. The trick stays until the next card or ROUND_HOLD, then gathers into
// its round slot (motion.ts). Every seat keeps an empty spot, so the spots can be measured.

import { TIE } from '../../../engine/src/engine.ts';
import type { PublicRound } from '../../../engine/src/observe.ts';
import { cardName, isKnownCard, seatName } from '../game-text.ts';
import { t } from '../i18n.ts';
import { BackView, CardView } from './cards.tsx';
import { isManilha, posOf, type Model } from './model.ts';
import { trickKey, type Scene } from './motion.ts';

/** The round the cross shows now, or null (nothing on the table). */
export function shownRound(m: Model, scene: Scene): { round: PublicRound; index: number } | null {
  const v = m.v;
  if (!v.dealt || scene.handEnd === 'gather' || scene.handEnd === 'gathered') return null;
  const cur = v.rounds[v.round];
  if (cur && cur.plays.length > 0) return { round: cur, index: v.round };
  if (v.round > 0) {
    const prev = v.rounds[v.round - 1];
    if (prev && prev.plays.length > 0 && trickKey(v.matchNo, v.handIndex, v.round - 1) !== scene.gathered) return { round: prev, index: v.round - 1 };
  }
  return null;
}

export function Trick({ m, scene }: { m: Model; scene: Scene }) {
  const v = m.v;
  const shown = shownRound(m, scene);
  const plays = shown?.round.plays ?? [];
  const resolved = !!shown && shown.round.result >= 0;
  const tie = resolved && shown.round.result === TIE;
  const winnerSeat = resolved && !tie ? shown.round.winnerSeat : -1;
  const label = plays.length ? plays.map((p) => `${seatName(m.names, p.seat)}: ${p.faceDown ? t('card.facedown') : cardName(p.card)}`).join('; ') : t('table.trickEmpty');
  const seats = Array.from({ length: m.n }, (_, i) => i);
  return (
    <div class={`trick__cards${resolved ? ' is-resolved' : ''}`} role="img" aria-label={t('table.trickAria', { plays: label })}>
      {seats.map((seat) => {
        const p = plays.find((x) => x.seat === seat);
        const wins = seat === winnerSeat;
        return (
          <div key={seat} class={`trick__spot${wins ? ' wins' : ''}${p ? '' : ' is-empty'}`} data-pos={posOf(seat, m.you, m.n)} data-spot-seat={seat}>
            {p ? (
              <div class="trick__card" key={`${v.matchNo}-${v.handIndex}-${shown!.index}-${seat}`}>
                {p.faceDown || !isKnownCard(p.card) ? <BackView /> : <CardView card={p.card} manilha={isManilha(v, p.card)} />}
              </div>
            ) : null}
            {p?.faceDown ? <span class="trick__tag">{t('card.facedownShort')}</span> : null}
            {wins ? <span class="win-tag">{seat === m.you ? t('board.win.tag.you') : t('board.win.tag', { name: seatName(m.names, seat) })}</span> : null}
          </div>
        );
      })}
      {tie ? (
        <p class="trick__notice" aria-hidden="true">
          {t('board.tie.tag')}
        </p>
      ) : null}
    </div>
  );
}
