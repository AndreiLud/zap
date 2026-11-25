// The owner's table controls in the lobby of a room with friends (M15 spec 6.4): one native select
// per seat, "Quem senta na cadeira N", always in the same place of the seat's row, so a change sent
// to the room never takes the select (and the focus) away. The choices go through ArrangeQueue
// (arrange.ts); while one waits or travels, its select shows it. Imported only by pages/Lobby.tsx.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { PublicRoom } from '../../../shared/protocol.ts';
import { currentRoom } from '../actions.ts';
import { t, type Key } from '../i18n.ts';
import { store, type RoomMsg } from '../store.ts';
import { ArrangeQueue, messageFor, seatOptions, seatValue } from './arrange.ts';

export interface Arranger {
  /** What a seat's select shows: a choice waiting or on its way, else the room's state. */
  valueOf(seat: number): string;
  choose(seat: number, value: string): void;
  /** Sends every waiting choice now ("Começar partida" calls it first). */
  flush(): void;
}

/** The owner's choices, from the select to the room. `notice` is the store's: a refusal puts the room's values back. */
export function useArranger(r: RoomMsg, notice: Key | null): Arranger {
  const [, tick] = useState(0);
  // Sent and not answered yet, with the room message it was sent against: the next room message
  // (a new object) shows the room's value again.
  const sent = useRef(new Map<number, { value: string; room: PublicRoom }>());
  const queue = useRef<ArrangeQueue | null>(null);
  queue.current ??= new ArrangeQueue((seat, value) => {
    const now = store.get().room;
    const msg = now ? messageFor(now.room, seat, value) : null;
    const room = currentRoom();
    if (now && msg && room) {
      if (msg.t === 'move') room.move(msg.from, msg.to);
      else room.plan(msg.seat, msg.ai);
      sent.current.set(seat, { value, room: now.room });
    }
    tick((x) => x + 1);
  });
  useEffect(() => () => queue.current?.dispose(), []);
  useEffect(() => {
    if (!notice) return;
    sent.current.clear();
    tick((x) => x + 1);
  }, [notice]);

  const shown = (seat: number): string => {
    const f = sent.current.get(seat);
    return f && f.room === r.room ? f.value : seatValue(r.room.seats[seat]);
  };
  return {
    valueOf: (seat) => queue.current!.pending(seat) ?? shown(seat),
    choose: (seat, value) => {
      queue.current!.set(seat, value, shown(seat));
      tick((x) => x + 1);
    },
    flush: () => queue.current!.flush(),
  };
}

/** One seat's select, with its visible label. */
export function ArrangeSelect({ r, seat, arranger }: { r: RoomMsg; seat: number; arranger: Arranger }) {
  const id = `arrange-${seat}`;
  const value = arranger.valueOf(seat);
  return (
    <div class="lobby__ctl">
      <label class="lobby__ctl-label" for={id}>
        {t('play.arrange.who', { n: seat + 1 })}
      </label>
      <select id={id} class="lobby__select" data-testid={id} value={value} onChange={(e) => arranger.choose(seat, e.currentTarget.value)}>
        {seatOptions(r.room, r.you, seat, t).map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
