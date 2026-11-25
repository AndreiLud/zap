// Your hand (CLIENT-SPEC 11.3, 12): only the cards you hold, centred in a gentle fan. The region is
// your seat (data-testid seat-<you>): you have no label card, the hand is you. Cards use
// aria-disabled (not disabled) so focus stays on them between turns; the hand is one Tab stop and
// the arrows move between cards (roving tabindex). A card leaves on click (pointer up, WCAG 2.5.2);
// the pressed state shows on pointerdown. Before the deal and after the gather, three soft hollows
// show where the cards will land.

import { useEffect, useRef, useState } from 'preact/hooks';
import { A_COVER0, COVER_MASK } from '../../../engine/src/engine.ts';
import { Icon } from '../components/icons.tsx';
import { currentController } from '../controller.ts';
import { handCardLabel, isKnownCard, manilhaName } from '../game-text.ts';
import { t } from '../i18n.ts';
import { store } from '../store.ts';
import type { PhraseKey } from '../../../shared/protocol.ts';
import { OwnBubble } from './Bubbles.tsx';
import { BackView, CardView } from './cards.tsx';
import { focusHand, focusLater, inGame } from './focus.ts';
import { handSlots, isManilha, legalCardMask, type Model } from './model.ts';
import { cacheRects, leaveHand, type Scene } from './motion.ts';
import { ResumeBanner, TurnBar } from './Actions.tsx';

/** Plays the card of a slot from its button: the card starts toward the table, then the move goes out. */
export function playFromButton(button: HTMLElement | null, slot: number): boolean {
  const s = store.get();
  const v = s.view;
  if (!v) return false;
  // Offline or reconnecting nothing can reach the room: the card stays in the hand (as readKeys).
  const legal = s.sending || s.conn !== 'online' ? 0 : v.legal;
  const cover = s.cover && (legal & COVER_MASK) !== 0;
  const mask = legalCardMask(legal, cover);
  if (!(mask & (1 << slot))) return false;
  if (button) leaveHand(button, slot, v.hand[slot]);
  currentController()?.act(cover ? A_COVER0 + slot : slot);
  return true;
}

export function HandArea(props: {
  m: Model;
  scene: Scene;
  bubbles: Record<number, { key: PhraseKey; id: number }>;
  clock: { at: number; total: number } | null;
  resume: boolean;
  /** The guided match's suggested card: its slot and the tag ("suggested"). */
  suggest?: { slot: number; tag: string } | null;
}) {
  const { m, scene } = props;
  const v = m.v;
  const pub = m.room.seats[m.you];
  const hollows = !v.dealt || scene.handEnd === 'gather' || scene.handEnd === 'gathered';
  const slots = hollows ? [] : handSlots(v);
  const yourTurn = v.dealt && v.waitingFor === m.you && v.phase === 'play' && !v.over;
  const mask = legalCardMask(m.legal, m.cover);
  const [rov, setRov] = useState(-1);
  const roving = slots.includes(rov) ? rov : (slots.find((s) => mask & (1 << s)) ?? slots[0] ?? -1);
  const list = useRef<HTMLUListElement>(null);

  // Your turn: cache the boxes a tap needs, and bring focus to the first playable card when it is in the game.
  const turnKey = yourTurn && m.legal ? `${v.matchNo}:${v.handIndex}:${v.round}:${v.rounds[v.round]?.plays.length ?? 0}:${v.phase}` : '';
  useEffect(() => {
    requestAnimationFrame(() => cacheRects(m.you));
    if (!turnKey || !inGame()) return;
    const first = slots.find((s) => mask & (1 << s));
    if (first !== undefined) {
      setRov(first);
      focusLater(() => list.current?.querySelector<HTMLElement>(`[data-slot="${first}"]`));
    }
  }, [turnKey]);
  useEffect(() => {
    const onResize = () => cacheRects(m.you);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [m.you]);

  const onKeyDown = (e: KeyboardEvent) => {
    const k = e.key;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(k) || !slots.length) return;
    e.preventDefault();
    let p = Math.max(0, slots.indexOf(roving));
    if (k === 'Home') p = 0;
    else if (k === 'End') p = slots.length - 1;
    else p = (p + (k === 'ArrowRight' ? 1 : slots.length - 1)) % slots.length;
    setRov(slots[p]);
    list.current?.querySelector<HTMLElement>(`[data-slot="${slots[p]}"]`)?.focus();
  };

  return (
    <section
      class={`hand-area${yourTurn ? ' is-your-turn' : ''}`}
      id="hand-area"
      aria-labelledby="hand-title"
      data-testid={`seat-${m.you}`}
      data-kind={pub?.kind ?? 'human'}
      data-connected={String(pub?.connected ?? false)}
      data-ai-playing={String(pub?.aiPlaying ?? false)}
    >
      <h2 id="hand-title" class="sr-only">
        {t('board.hand.title')}
      </h2>
      {props.resume ? <ResumeBanner /> : null}
      {props.clock ? <TurnBar at={props.clock.at} total={props.clock.total} /> : <div class="turn-bar turn-bar--off" aria-hidden="true" />}
      <ul class={`hand${yourTurn ? ' is-your-turn' : ''}${m.cover ? ' is-covering' : ''}`} id="hand" ref={list} tabIndex={-1} onKeyDown={onKeyDown}>
        {hollows
          ? [0, 1, 2].map((i) => (
              <li key={`h${i}`} class="hand__hollow" aria-hidden="true">
                <div class="hand__hollow-card" />
                <span class="hand__legend" />
              </li>
            ))
          : slots.map((slot, i) => {
              const c = v.hand[slot];
              const known = isKnownCard(c);
              const manilha = known && isManilha(v, c);
              const ok = (mask & (1 << slot)) !== 0;
              const key = String(i + 1);
              return (
                <li key={`${v.matchNo}-${v.handIndex}-${slot}`}>
                  <button
                    type="button"
                    class="hand-card"
                    data-slot={slot}
                    data-testid={`hand-card-${slot}`}
                    data-suggest={props.suggest && props.suggest.slot === slot ? props.suggest.tag : undefined}
                    aria-disabled={ok ? undefined : 'true'}
                    tabIndex={slot === roving ? 0 : -1}
                    aria-keyshortcuts={key}
                    aria-label={handCardLabel(c, i + 1, manilha, m.cover)}
                    onPointerDown={(e) => (e.currentTarget.dataset.pressed = 'true')}
                    onPointerUp={(e) => delete e.currentTarget.dataset.pressed}
                    onPointerLeave={(e) => delete e.currentTarget.dataset.pressed}
                    onPointerCancel={(e) => delete e.currentTarget.dataset.pressed}
                    onFocus={() => slot !== roving && setRov(slot)}
                    onClick={(e) => {
                      delete e.currentTarget.dataset.pressed;
                      playFromButton(e.currentTarget, slot);
                    }}
                  >
                    {known ? <CardView card={c} manilha={manilha} /> : <BackView />}
                  </button>
                  <span class="hand__legend">
                    <kbd class="kbd-only" aria-hidden="true">
                      {key}
                    </kbd>
                    {manilha ? (
                      <span class="hand__manilha" aria-hidden="true">
                        <small>{t('card.manilha')}</small>
                        <b>
                          <Icon name="star" />
                          {manilhaName(c)}
                        </b>
                      </span>
                    ) : null}
                  </span>
                </li>
              );
            })}
      </ul>
      <OwnBubble m={m} bubbles={props.bubbles} />
    </section>
  );
}

export { focusHand };
