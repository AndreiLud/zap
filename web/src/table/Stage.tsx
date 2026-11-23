// The play area (CLIENT-SPEC 11.2): a surface card holding the seat labels, laid out by a grid, and
// the trick cross over the line medallion, with the deck on the medallion before the deal. Seats
// step down with large text (container queries in styles/table.css) and the area grows instead of
// clipping. Bubbles and the dealer's line sit inside it.

import { useMemo } from 'preact/hooks';
import type { PhraseKey } from '../../../shared/protocol.ts';
import type { Ring } from '../components/pieces.tsx';
import { t } from '../i18n.ts';
import { serverNow } from '../store.ts';
import { bubbleItems, Bubbles, DealerLine } from './Bubbles.tsx';
import { MedallionView } from './cards.tsx';
import { Deck } from './Deck.tsx';
import { turnSeconds, type Model } from './model.ts';
import type { Scene } from './motion.ts';
import { Seat } from './Seat.tsx';
import { Trick } from './Trick.tsx';

type Deadline = { seat: number; at: number | null } | null;

/** The ring of the active seat: a countdown for a person with a deadline, a still ring otherwise. */
function useRing(m: Model, deadline: Deadline): Ring | null {
  const seat = m.v.waitingFor;
  const pub = seat >= 0 ? m.room.seats[seat] : undefined;
  const secs = turnSeconds(m.room);
  const at = deadline && deadline.seat === seat ? deadline.at : null;
  const person = pub?.kind === 'human' && !pub.aiPlaying;
  // Computed once per deadline, so a re-render never moves the countdown.
  return useMemo<Ring | null>(() => {
    if (seat < 0 || !pub) return null;
    if (!person || at === null || !secs) return 'static';
    return { durationMs: secs * 1000, elapsedMs: Math.max(0, secs * 1000 - (at - serverNow())) };
  }, [seat, at, person, secs]);
}

export function PlayArea({ m, scene, bubbles, deadline }: { m: Model; scene: Scene; bubbles: Record<number, { key: PhraseKey; id: number }>; deadline: Deadline }) {
  const v = m.v;
  const ring = useRing(m, deadline);
  const others = Array.from({ length: m.n }, (_, i) => i).filter((s) => s !== m.you);
  const deckShown = !v.dealt || scene.deckOnTable;
  const backAfterHand = scene.handEnd === 'gather' || scene.handEnd === 'gathered' || (!v.dealt && v.history.length > 0);
  return (
    <section class="table-area" aria-labelledby="table-area-title">
      <h2 id="table-area-title" class="sr-only">
        {t('board.area')}
      </h2>
      <div class="play-area">
        <div class="play-area__grid">
          {others.map((seat) => (
            <Seat key={seat} m={m} seat={seat} ring={ring} />
          ))}
          <div class="trick" data-testid="trick">
            <MedallionView class="medallion-line trick__medallion" />
            {deckShown ? <Deck m={m} ended={backAfterHand && scene.handEnd !== null} shuffle={scene.motion && !v.dealt} /> : null}
            <Trick m={m} scene={scene} />
          </div>
        </div>
        <Bubbles items={bubbleItems(m, bubbles, scene)} trick={`${v.matchNo}:${v.handIndex}:${v.round}:${v.rounds[v.round]?.plays.length ?? 0}:${scene.handEnd ?? ''}:${scene.gathered}`} />
        <DealerLine m={m} scene={scene} />
      </div>
    </section>
  );
}

/** The play area while a room opens: the deck on the medallion, no seats yet. */
export function OpeningArea() {
  return (
    <section class="table-area">
      <div class="play-area">
        <div class="play-area__grid">
          <div class="trick">
            <MedallionView class="medallion-line trick__medallion" />
            <Deck m={null} ended={false} shuffle />
          </div>
        </div>
      </div>
    </section>
  );
}
