// One seat around the play area (CLIENT-SPEC 11.5): a quiet label (avatar, name, the AI mark on every
// AI seat, the team chip, one line), placed by the grid of the play area. The active seat's avatar
// has the ring: a countdown for a person with a deadline, a still ring for an AI. In a mão de onze
// your partner's cards show as small cards under the label.

import type { PublicSeat } from '../../../shared/protocol.ts';
import { SeatLabel, type Ring, type SeatInfo } from '../components/pieces.tsx';
import { cardName, seatAria, seatName } from '../game-text.ts';
import { t } from '../i18n.ts';
import { CardView } from './cards.tsx';
import { isManilha, partnerOf, posOf, type Model } from './model.ts';

export function seatInfo(m: Model, pub: PublicSeat | undefined, seat: number, ring: Ring | null): SeatInfo {
  const team = (seat & 1) === m.team ? 'us' : 'them';
  if (pub?.kind === 'ai') return { kind: 'ai', persona: pub.persona, name: seatName(m.names, seat), team, ring };
  return {
    kind: 'human',
    name: seatName(m.names, seat),
    team,
    verified: pub?.verified ?? false,
    aiPlaying: pub?.aiPlaying ?? false,
    away: pub ? !pub.connected : false,
    ring,
  };
}

export function Seat({ m, seat, ring }: { m: Model; seat: number; ring: Ring | null }) {
  const pub = m.room.seats[seat];
  const v = m.v;
  const active = v.waitingFor === seat && !v.over && v.dealt;
  const partnerCards = v.partnerHand && seat === partnerOf(m) ? v.partnerHand.filter((c) => c >= 0) : [];
  return (
    <div
      class={`seat${active ? ' is-active' : ''}`}
      data-pos={posOf(seat, m.you, m.n)}
      role="group"
      aria-label={seatAria(m.names, pub, seat, active)}
      data-testid={`seat-${seat}`}
      data-kind={pub?.kind ?? 'empty'}
      data-connected={String(pub?.connected ?? false)}
      data-ai-playing={String(pub?.aiPlaying ?? false)}
      data-seat-anchor={seat}
    >
      <SeatLabel seat={seatInfo(m, pub, seat, active ? ring : null)} />
      {partnerCards.length ? (
        <span class="seat__cards" role="img" aria-label={t('seat.partnerCards', { cards: partnerCards.map(cardName).join(', ') })}>
          {partnerCards.map((c) => (
            <CardView key={c} card={c} manilha={isManilha(v, c)} />
          ))}
        </span>
      ) : null}
    </div>
  );
}
