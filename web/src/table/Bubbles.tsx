// Speech at the table (CLIENT-SPEC 11.5): phrase bubbles (4 s), your partner's signal ("Only you see this"),
// a signal you caught from an opponent (4 s too), and the Zap's one line at the end of a hand. Bubbles stay
// inside the play area and never cover a seat name or AI mark (placement of the prototype's
// showBubble). On a narrow play area a bubble that would cover a card of the trick docks in the free
// band at the foot of the play area instead, with the seat's name. They are aria-hidden: the
// announcer reads the same sentences. With the others muted, nothing from another seat shows. Before
// the first deal of a match an AI dealer says one line under the medallion (DealerLine); with very
// large text it moves into the status line.

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { PhraseKey } from '../../../shared/protocol.ts';
import { Icon } from '../components/icons.tsx';
import { Avatar } from '../components/pieces.tsx';
import { phraseText, seatName, seatOf, signalName } from '../game-text.ts';
import { t } from '../i18n.ts';
import { partnerOf, posOf, zapOpponent, type Model, type Pos } from './model.ts';
import { getScene, setScene, type Scene } from './motion.ts';
import { BUBBLE_MS } from './timing.ts';

interface Item {
  seat: number;
  pos: Pos;
  key: string;
  text: string;
  private?: boolean;
  /** The seat's name, shown only when the bubble docks away from the seat. */
  who?: string;
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The bubble each other seat shows now (a phrase first, then a signal, then the Zap's line). */
export function bubbleItems(m: Model, bubbles: Record<number, { key: PhraseKey; id: number }>, scene: Scene): Item[] {
  if (m.muted) return [];
  const v = m.v;
  const out: Item[] = [];
  // Signals show from the moment they are made until you play your first card of the hand.
  const signalsOn = v.dealt && v.round === 0 && v.hand.filter((c) => c !== -1).length === 3 && !v.handResult;
  const zap = zapOpponent(m);
  for (let seat = 0; seat < m.n; seat++) {
    if (seat === m.you) continue;
    const pos = posOf(seat, m.you, m.n);
    const b = bubbles[seat];
    const who = seatName(m.names, seat);
    if (b) {
      out.push({ seat, pos, key: `p${b.id}`, text: phraseText(b.key), who });
      continue;
    }
    const sig = signalsOn ? v.signals.find((x) => x.seat === seat) : undefined;
    if (sig) {
      if (seat === partnerOf(m)) out.push({ seat, pos, key: `s${v.handIndex}-${seat}`, text: capital(signalName(sig.signal, false)), private: true, who });
      else out.push({ seat, pos, key: `c${v.matchNo}-${v.handIndex}-${seat}`, text: t('board.signal.caught', { of: seatOf(m.names, seat), signal: signalName(sig.signal, false) }) });
      continue;
    }
    if (scene.zapLine && seat === zap) out.push({ seat, pos, key: `z${scene.zapLine.key}`, text: t(scene.zapLine.won ? 'board.zap.them' : 'board.zap.us'), who });
  }
  return out;
}

interface Placed {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Below this play area width, a bubble that would cover a trick card docks at the foot instead. */
const DOCK_BELOW = 420;
const EDGE = 8;

function meets(a: Placed, b: Placed): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** The cards on the trick now, in play area coordinates (a little larger, so indices stay clear). */
function trickCards(ar: DOMRect): Placed[] {
  return [...document.querySelectorAll('[data-testid="trick"] .trick__spot:not(.is-empty) .trick__card')].map((c) => {
    const r = c.getBoundingClientRect();
    return { top: r.top - ar.top - 4, bottom: r.bottom - ar.top + 4, left: r.left - ar.left - 4, right: r.right - ar.left + 4 };
  });
}

/** Places one bubble in the play area; it moves down below any bubble already placed that it would cover. */
function place(el: HTMLElement, item: Item, placed: Placed[]): Placed | null {
  const area = el.closest('.play-area');
  const label = document.querySelector(`[data-seat-anchor="${item.seat}"] .seat-label`);
  if (!area || !label) return null;
  const ar = area.getBoundingClientRect();
  const r = label.getBoundingClientRect();
  el.style.left = '';
  el.style.right = '';
  el.style.top = '';
  el.style.maxWidth = '';
  el.style.removeProperty('--tail');
  el.dataset.place = '';
  let top: number;
  if (item.pos === 'top' && ar.width >= 420) {
    // Beside the name: the one place no other seat or card uses.
    const left = r.right - ar.left + 14;
    el.dataset.place = 'beside';
    el.style.left = `${left}px`;
    el.style.maxWidth = `${Math.max(88, ar.width - left - 8)}px`;
    top = Math.max(6, r.top - ar.top + r.height / 2 - el.offsetHeight / 2);
  } else if (item.pos === 'top') {
    // Under the name, tail up: between the corner labels when it fits there, else under all labels.
    const side = [...document.querySelectorAll('[data-seat-anchor] .seat-label')].filter((x) => x !== label).map((x) => x.getBoundingClientRect());
    const leftLabel = side.find((x) => x.left - ar.left < ar.width / 2);
    const rightLabel = side.find((x) => x.left - ar.left >= ar.width / 2);
    const cx = r.left + r.width / 2 - ar.left;
    let lo = leftLabel ? leftLabel.right - ar.left + 6 : 8;
    let hi = rightLabel ? rightLabel.left - ar.left - 6 : ar.width - 8;
    top = r.bottom - ar.top + 10;
    el.dataset.place = 'under';
    el.style.maxWidth = `${Math.max(0, hi - lo)}px`;
    if (hi - lo < 96 || el.offsetHeight > 76) {
      lo = 8;
      hi = ar.width - 8;
      top = Math.max(r.bottom, ...side.map((x) => x.bottom)) - ar.top + 10;
      el.style.maxWidth = `${hi - lo}px`;
    }
    const left = Math.min(Math.max(lo, cx - el.offsetWidth / 2), hi - el.offsetWidth);
    el.style.left = `${left}px`;
    el.style.setProperty('--tail', `${Math.round(cx - left)}px`);
  } else {
    el.dataset.place = 'under';
    top = r.bottom - ar.top + 12;
    el.style.maxWidth = `${Math.max(120, ar.width / 2 - 8)}px`;
    if (item.pos === 'right') el.style.right = `${Math.max(8, ar.right - r.right)}px`;
    else el.style.left = `${Math.max(8, r.left - ar.left)}px`;
  }
  // Never on top of another bubble: below the lowest one it would meet.
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const left = el.style.right ? ar.width - parseFloat(el.style.right) - w : parseFloat(el.style.left || '0');
  for (let moved = true; moved; ) {
    moved = false;
    for (const p of placed) {
      if (left < p.right && left + w > p.left && top < p.bottom && top + h > p.top) {
        top = p.bottom + 6;
        moved = true;
      }
    }
  }
  el.style.top = `${top}px`;
  const box = { top, bottom: top + h, left, right: left + w };
  placed.push(box);
  return box;
}

/**
 * Docks the bubbles that would cover a trick card in the free band at the foot of the play area:
 * one centred, two side by side, each with its tail aimed at its seat.
 */
function dock(list: { el: HTMLElement; item: Item }[]): void {
  const area = list[0]?.el.closest('.play-area');
  if (!area) return;
  const ar = area.getBoundingClientRect();
  const width = ar.width - 2 * EDGE;
  const each = list.length > 1 ? (width - EDGE) / 2 : width;
  // The side seats keep their side; the bubble of the seat across goes to the other one.
  const side: Record<Pos, number> = { left: 0, top: 1, bottom: 1, right: 2 };
  const order = [...list].sort((a, b) => side[a.item.pos] - side[b.item.pos]);
  order.forEach(({ el, item }, i) => {
    el.dataset.place = 'dock';
    el.style.right = '';
    el.style.maxWidth = `${each}px`;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = list.length > 1 ? (i === 0 ? EDGE : ar.width - EDGE - w) : (ar.width - w) / 2;
    el.style.left = `${left}px`;
    el.style.top = `${ar.height - EDGE - h}px`;
    const label = document.querySelector(`[data-seat-anchor="${item.seat}"] .seat-label`);
    const cx = label ? label.getBoundingClientRect().left + label.getBoundingClientRect().width / 2 - ar.left : left + w / 2;
    el.style.setProperty('--tail', `${Math.round(Math.min(Math.max(cx - left, 18), w - 18))}px`);
  });
}

function BubbleView({ item, register }: { item: Item; register: (key: string, el: HTMLElement | null) => void }) {
  return (
    <div ref={(el) => register(item.key, el)} class={`bubble bubble--${item.pos}${item.private ? ' bubble--private' : ''}`} aria-hidden="true">
      {item.private ? (
        <small>
          <Icon name="eye" />
          {item.who ? <span class="bubble__who">{t('board.sig.privateFrom', { name: item.who })}</span> : null}
          <span class="bubble__private">{t('board.sig.private')}</span>
        </small>
      ) : item.who ? (
        <b class="bubble__who">{item.who}</b>
      ) : null}
      {item.text}
    </div>
  );
}

/** Re-renders when the play area changes size (rotation, text size), to place the bubbles again. */
function useAreaSize(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const area = document.querySelector('.play-area');
    if (!area || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(() => setTick((x) => x + 1));
    ro.observe(area);
    return () => ro.disconnect();
  }, []);
  return tick;
}

const ORDER: Record<Pos, number> = { top: 0, right: 1, left: 2, bottom: 3 };

/**
 * A signal caught from an opponent shows for BUBBLE_MS, like a phrase, so it does not sit on the
 * table for the whole decision; the hand log and the announcer keep it.
 */
function useCaughtFor(all: Item[]): Item[] {
  const seenAt = useRef(new Map<string, number>());
  const [, setTick] = useState(0);
  const now = performance.now();
  for (const it of all) if (it.key.startsWith('c') && !seenAt.current.has(it.key)) seenAt.current.set(it.key, now);
  for (const [key, at] of seenAt.current) if (now - at > 10 * BUBBLE_MS && !all.some((it) => it.key === key)) seenAt.current.delete(key);
  const left = (it: Item) => BUBBLE_MS - (now - (seenAt.current.get(it.key) ?? now));
  const items = all.filter((it) => !it.key.startsWith('c') || left(it) > 0);
  const next = Math.min(...items.filter((it) => it.key.startsWith('c')).map(left));
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const id = setTimeout(() => setTick((x) => x + 1), next + 20);
    return () => clearTimeout(id);
  }, [next]);
  return items;
}

/** `trick` changes whenever a card lands on or leaves the trick, so the bubbles are placed again. */
export function Bubbles({ items: all, trick }: { items: Item[]; trick: string }) {
  const items = useCaughtFor(all);
  const tick = useAreaSize();
  const els = useRef(new Map<string, HTMLElement>());
  const register = (key: string, el: HTMLElement | null) => {
    if (el) els.current.set(key, el);
    else els.current.delete(key);
  };
  const sig = items.map((i) => `${i.key}:${i.text}`).join('|');
  useLayoutEffect(() => {
    const placed: Placed[] = [];
    const docked: { el: HTMLElement; item: Item }[] = [];
    let cards: Placed[] | null = null;
    for (const it of [...items].sort((a, b) => ORDER[a.pos] - ORDER[b.pos])) {
      const el = els.current.get(it.key);
      if (!el) continue;
      const box = place(el, it, placed);
      const area = el.closest('.play-area');
      if (!box || !area) continue;
      const ar = area.getBoundingClientRect();
      if (ar.width >= DOCK_BELOW) continue;
      cards ??= trickCards(ar);
      if (cards.some((c) => meets(c, box))) {
        placed.splice(placed.indexOf(box), 1);
        docked.push({ el, item: it });
      }
    }
    if (!docked.length) return;
    dock(docked);
    // Where even the foot of the play area meets a card (the four cards of a hand that just ended,
    // before they gather), a line waits for the trick to clear; the trick key places it again then.
    // Your partner's signal always shows: only you see it, and it is the one thing you need now.
    const area = docked[0].el.closest('.play-area');
    if (!area) return;
    const ar = area.getBoundingClientRect();
    cards ??= trickCards(ar);
    for (const { el, item } of docked) {
      if (item.private) continue;
      const r = el.getBoundingClientRect();
      const box = { top: r.top - ar.top, bottom: r.bottom - ar.top, left: r.left - ar.left, right: r.right - ar.left };
      if (cards.some((c) => meets(c, box))) el.dataset.place = 'wait';
    }
  }, [sig, tick, trick]);
  return (
    <>
      {items.map((it) => (
        <BubbleView key={it.key} item={it} register={register} />
      ))}
    </>
  );
}

/** Your own phrase, in your hand region (it belongs to your seat). */
export function OwnBubble({ m, bubbles }: { m: Model; bubbles: Record<number, { key: PhraseKey; id: number }> }) {
  const b = bubbles[m.you];
  if (!b) return null;
  return (
    <p key={b.id} class="bubble bubble--own" aria-hidden="true">
      {phraseText(b.key)}
    </p>
  );
}

/**
 * The AI dealer's line before the deal, set in type under the medallion. One character speaks at a
 * time: while the Zap's line about the hand that ended is up, the dealer stays quiet (the status line
 * already says who deals).
 */
export function DealerLine({ m, scene }: { m: Model; scene: Scene }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const tick = useAreaSize();
  const v = m.v;
  const pub = m.room.seats[v.dealer];
  const on = !v.dealt && !m.muted && !scene.zapLine && v.dealer !== m.you && pub?.kind === 'ai' && !!pub.persona;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      if (getScene().dealerInStatus) setScene({ dealerInStatus: false });
      return;
    }
    // Under the medallion when it fits; with very large text the status line shows it instead and
    // this copy stays for screen readers.
    el.dataset.room = '';
    const med = document.querySelector('.trick__medallion');
    const out = !!med && el.getBoundingClientRect().top < med.getBoundingClientRect().bottom + 4;
    el.dataset.room = out ? 'none' : '';
    if (getScene().dealerInStatus !== out) setScene({ dealerInStatus: out });
  }, [on, v.dealer, v.handIndex, tick]);
  if (!on || !pub?.persona) return null;
  return (
    <p ref={ref} class="dealer-line" data-testid="dealer-line">
      <Avatar persona={pub.persona} />
      <span>
        <b>{seatName(m.names, v.dealer)}</b> {t('board.quote', { text: t(`board.dealer.${pub.persona}`) })}
      </span>
    </p>
  );
}
