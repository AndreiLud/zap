// A small table seen from above (the prototype's "mesinha"): four hands in a cross, for the coach
// of F2 and the two deals of F4. A drawing only (aria-hidden): the figure's captions say what it
// shows. Cards are engine ids (rank * 4 + suit, ranks 4 5 6 7 Q J K A 2 3, suits d s h c).

import { TeamChip } from '../../components/pieces.tsx';
import { Avatar } from '../../components/pieces.tsx';
import { MiniCard } from '../../deck/Card.tsx';

export type Seat = 'n' | 'w' | 'e' | 's';
export type Deal = Record<Seat, readonly number[]>;

/** The hand of the prototype seen from Zap's seat (south); the vira is the 6 of hearts, so sevens are manilhas. */
export const TABLE_DEAL: Deal = { n: [26, 5, 20], w: [13, 36, 27], e: [3, 28, 32], s: [33, 14, 17] };
/** A lopsided deal for the duplicate format: strong cards north and south, weak ones east and west. */
export const DUP_DEAL: Deal = { n: [15, 38, 33], s: [14, 37, 28], w: [0, 7, 18], e: [1, 11, 22] };
/** Sevens are the manilhas of both drawings. */
const MANILHA = new Set([12, 13, 14, 15]);

export function MiniTable(p: { deal: Deal; zapAt?: Seat; backs?: readonly Seat[]; teams?: Partial<Record<Seat, 'us' | 'them'>>; eye?: boolean }) {
  return (
    <div class="dp-table" aria-hidden="true">
      {(['n', 'w', 'e', 's'] as const).map((seat) => {
        const team = p.teams?.[seat];
        return (
          <span key={seat} class={`dp-table__hand dp-table__hand--${seat}${team ? ` is-${team}` : ''}`}>
            {team ? <TeamChip team={team} /> : null}
            {p.zapAt === seat ? <Avatar persona="zap" class="dp-table__av" /> : null}
            {p.deal[seat].map((c, i) =>
              p.backs?.includes(seat) ? (
                <MiniCard key={i} card={-1} label="" class="dp-table__card" />
              ) : (
                <MiniCard key={i} card={c} label="" class={`dp-table__card${MANILHA.has(c) ? ' dp-card--m' : ''}`} />
              ),
            )}
          </span>
        );
      })}
      {p.eye ? (
        <span class="dp-table__eye">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
            <circle cx="12" cy="12" r="3.2" fill="currentColor" />
          </svg>
        </span>
      ) : null}
    </div>
  );
}
