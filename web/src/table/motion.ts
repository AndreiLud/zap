// Motion at the table (CLIENT-SPEC 11.6 and 14). Two parts:
//
// * The scene: a little state the table reads to know where the deck rests, whether a deal or the
//   end of a hand is running and which resolved trick is already gathered. Events change it.
// * Flights: a card (or the "+N" chip) travels in a fixed layer above the page (.flights), from a
//   source box to a target box, with transform and opacity only (Web Animations API). The target
//   stays hidden until the flight lands.
//
// Rules: an animation never delays the next event; when an event arrives while a flight runs, the
// running flights finish at once. Layout is read once per event (or per tap from a cache filled on
// resize and at the start of each turn), never inside a frame loop. With reduced motion nothing
// travels: the target appears after REDUCED_BEAT of the flight time, and no .flight is ever added.

import { useEffect, useState } from 'preact/hooks';
import { mediaMatches, REDUCED_MOTION } from '../media.ts';
import { store } from '../store.ts';
import {
  AI_PLAY_FLIGHT,
  COUNT_FLIGHT,
  COUNT_HOLD_REDUCED,
  DEAL_FLIGHT,
  DEAL_STAGGER,
  GATHER,
  HAND_GATHER,
  HAND_GATHER_AT,
  MY_PLAY_FLIGHT,
  PREDEAL_AT,
  REDUCED_BEAT,
  REVEAL_FLIP,
  ROUND_HOLD,
  ZAP_LINE_MS,
} from './timing.ts';

// -------------------------------------------------------------------------------------------------
// Scene

export interface Scene {
  /** Pieces that mount may play their CSS entrance (off right after a snapshot: drawn in place). */
  motion: boolean;
  /** The deck rests on the medallion although this hand is dealt (during the deal, after the gather). */
  deckOnTable: boolean;
  /** Hand whose deal is running, or -1. */
  dealing: number;
  /** End of a hand: counting, the cards going back to the deck, then gathered. */
  handEnd: 'count' | 'gather' | 'gathered' | null;
  /** The resolved trick already gathered into its round slot ("match:hand:round"). */
  gathered: string;
  /** The "+N" chip on the score while the points are counted. */
  chip: { team: number; points: number; key: number } | null;
  /** The Zap's line under its label at the end of a hand. */
  zapLine: { won: boolean; key: number } | null;
  /** Very large text: the dealer's line has no room under the medallion and shows in the status line. */
  dealerInStatus: boolean;
}

const INITIAL: Scene = { motion: false, deckOnTable: false, dealing: -1, handEnd: null, gathered: '', chip: null, zapLine: null, dealerInStatus: false };
let scene: Scene = INITIAL;
const sceneListeners = new Set<() => void>();

export function getScene(): Scene {
  return scene;
}

export function setScene(patch: Partial<Scene>): void {
  scene = { ...scene, ...patch };
  for (const fn of [...sceneListeners]) fn();
}

/** The scene, re-rendering the caller when it changes. */
export function useScene(): Scene {
  const [, tick] = useState(0);
  useEffect(() => {
    const fn = () => tick((x) => x + 1);
    sceneListeners.add(fn);
    return () => {
      sceneListeners.delete(fn);
    };
  }, []);
  return scene;
}

export function trickKey(matchNo: number, hand: number, round: number): string {
  return `${matchNo}:${hand}:${round}`;
}

// -------------------------------------------------------------------------------------------------
// Flights

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

let layer: HTMLDivElement | null = null;
const running = new Set<Animation>();
const parked = new Set<HTMLElement>();
const hidden = new Set<HTMLElement>();
const timers = new Set<ReturnType<typeof setTimeout>>();
let marked = false;

export function reduced(): boolean {
  return mediaMatches(REDUCED_MOTION);
}

function flightsLayer(): HTMLDivElement {
  if (layer && layer.isConnected) return layer;
  layer = document.createElement('div');
  layer.className = 'flights';
  layer.setAttribute('aria-hidden', 'true');
  document.body.append(layer);
  return layer;
}

/** Removes the flights layer and everything in flight (the table unmounts). */
export function disposeMotion(): void {
  settle();
  layer?.remove();
  layer = null;
}

export function boxOf(el: Element | null | undefined): Box | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** A box of a given size centred on another box (a card leaving an avatar). */
export function centred(b: Box, w: number, h: number): Box {
  return { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h };
}

/**
 * Hides a piece while its copy flies. `soft` keeps it in the page and clickable (opacity only): your
 * cards during the deal, which you may already play (your clock starts with the deal).
 */
export function hide(el: Element | null | undefined, soft = false): void {
  if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) return;
  const h = el as HTMLElement;
  if (soft) h.style.opacity = '0';
  else h.style.visibility = 'hidden';
  hidden.add(h);
}

export function show(el: Element | null | undefined): void {
  if (!el) return;
  const h = el as HTMLElement;
  h.style.visibility = '';
  h.style.opacity = '';
  hidden.delete(h);
}

function later(fn: () => void, ms: number): void {
  const id = setTimeout(() => {
    timers.delete(id);
    fn();
  }, ms);
  timers.add(id);
}

function markStart(): void {
  if (marked) return;
  marked = true;
  performance.mark('zap:anim:start');
}

function markEnd(): void {
  if (!marked || running.size > 0) return;
  marked = false;
  performance.mark('zap:anim:end');
}

/** A copy of a card (or anything) to fly; ids are dropped so the page keeps each id once. */
export function copy(node: Element | null | undefined): Element | null {
  if (!node) return null;
  const c = node.cloneNode(true) as Element;
  c.removeAttribute('id');
  c.querySelectorAll('[id]').forEach((x) => x.removeAttribute('id'));
  c.removeAttribute('data-testid');
  return c;
}

export interface FlightOptions {
  from: Box;
  to: Box;
  /** What flies (a copied card). With `back`, the flight turns from `back` to `face` on the way. */
  face: Element | null;
  back?: Element | null;
  dur: number;
  delay?: number;
  rot0?: number;
  rot1?: number;
  /** Keep the element where it landed (the caller removes it). */
  keep?: boolean;
  /** Extra class on the flight (the "+N" chip). */
  class?: string;
  /** With `back`: fly as the back and turn later (turnOver), not on the way. */
  turnLater?: boolean;
  onLand?: (el: HTMLElement) => void;
}

/** Flies a copy from one box to another. Returns the flight element (null with reduced motion). */
export function fly(o: FlightOptions): HTMLElement | null {
  if (reduced() || !o.face) {
    if (o.onLand) later(() => o.onLand!(document.body), Math.round(o.dur * REDUCED_BEAT) + (o.delay ?? 0));
    return null;
  }
  const el = document.createElement('div');
  el.className = `flight${o.class ? ` ${o.class}` : ''}`;
  el.style.left = `${o.to.x}px`;
  el.style.top = `${o.to.y}px`;
  el.style.width = `${o.to.w}px`;
  el.style.height = `${o.to.h}px`;
  let turner: HTMLElement | null = null;
  if (o.back) {
    turner = document.createElement('div');
    turner.className = 'flight__turn';
    const b = document.createElement('div');
    b.className = 'flight__side';
    b.append(o.back);
    const f = document.createElement('div');
    f.className = 'flight__side flight__side--face';
    f.append(o.face);
    turner.append(b, f);
    el.append(turner);
  } else {
    el.append(o.face);
  }
  flightsLayer().append(el);
  const dx = o.from.x + o.from.w / 2 - (o.to.x + o.to.w / 2);
  const dy = o.from.y + o.from.h / 2 - (o.to.y + o.to.h / 2);
  const s = o.to.w > 0 ? o.from.w / o.to.w : 1;
  const opts: KeyframeAnimationOptions = { duration: o.dur, delay: o.delay ?? 0, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'backwards' };
  const anim = el.animate(
    [{ transform: `translate(${dx}px, ${dy}px) scale(${s}) rotate(${o.rot0 ?? 0}deg)` }, { transform: `rotate(${o.rot1 ?? 0}deg)` }],
    opts,
  );
  track(anim);
  if (turner && !o.turnLater) track(turner.animate([{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(180deg)' }], { ...opts, easing: 'cubic-bezier(.4,.1,.3,1)', fill: 'both' }));
  const done = () => {
    if (o.keep) parked.add(el);
    else el.remove();
    o.onLand?.(el);
  };
  anim.finished.then(done, done);
  return el;
}

function track(a: Animation): void {
  running.add(a);
  markStart();
  const out = () => {
    running.delete(a);
    markEnd();
  };
  a.finished.then(out, out);
}

/** Turns a parked flight over in place (your dealt cards turn face up). */
function turnOver(el: HTMLElement, dur: number, done: () => void): void {
  const turner = el.querySelector<HTMLElement>('.flight__turn');
  if (!turner || reduced()) {
    done();
    return;
  }
  const a = turner.animate([{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(180deg)' }], { duration: dur, easing: 'cubic-bezier(.4,.1,.3,1)', fill: 'both' });
  track(a);
  a.finished.then(done, done);
}

/** Every running flight ends where it would land; every parked one goes. */
export function finishAll(): void {
  for (const a of [...running]) {
    try {
      a.finish();
    } catch {
      a.cancel();
    }
  }
}

/** Back to a still table: flights done, timers cleared, every hidden piece shown again. */
export function settle(): void {
  finishAll();
  for (const id of timers) clearTimeout(id);
  timers.clear();
  for (const el of parked) el.remove();
  parked.clear();
  for (const el of [...hidden]) show(el);
  mine = null;
}

// -------------------------------------------------------------------------------------------------
// The DOM the flights read

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);

function seatAnchor(seat: number): Element | null {
  return q(`[data-seat-anchor="${seat}"] .avatar`) ?? q(`[data-seat-anchor="${seat}"]`);
}

function spotCard(seat: number): Element | null {
  return q(`[data-spot-seat="${seat}"] .trick__card`);
}

function backTemplate(): Element | null {
  return copy(q('.flights-src svg'));
}

function deckTop(): Element | null {
  return q('.deck:not([hidden]) .deck__packet--top') ?? q('.pile__back');
}

const SMALL: [number, number] = [22, 31];

// -------------------------------------------------------------------------------------------------
// Rect cache for the tap (no layout read in the click handler)

const cache = new Map<string, Box>();

/** Reads the boxes a tap needs (hand cards, your trick spot). On resize and at the start of a turn. */
export function cacheRects(you: number): void {
  cache.clear();
  document.querySelectorAll<HTMLElement>('.hand [data-slot]').forEach((b) => {
    const box = boxOf(b);
    if (box) cache.set(`hand:${b.dataset.slot}`, box);
  });
  const spot = boxOf(q(`[data-spot-seat="${you}"]`));
  if (spot) cache.set('spot:mine', spot);
}

// -------------------------------------------------------------------------------------------------
// Your card leaving the hand

let mine: { flight: HTMLElement | null; landed: boolean; card: number } | null = null;

/**
 * The tap on a playable card: the card starts toward your spot at once (cached boxes, no layout
 * read), the button gets data-leaving="true", then the caller sends the move. The flight waits on
 * the spot until the server's play event puts the card on the table.
 */
export function leaveHand(button: HTMLElement, slot: number, card: number): void {
  // A card played while the deal still runs: the deal ends at once.
  if (scene.dealing >= 0) {
    settle();
    setScene({ dealing: -1, deckOnTable: false });
  }
  button.dataset.leaving = 'true';
  const from = cache.get(`hand:${slot}`);
  const to = cache.get('spot:mine');
  const face = button.querySelector('svg');
  hide(button);
  if (!from || !to || !face || reduced()) {
    mine = { flight: null, landed: true, card };
    return;
  }
  const state = { flight: null as HTMLElement | null, landed: false, card };
  mine = state;
  state.flight = fly({
    from,
    to,
    face: copy(face),
    dur: MY_PLAY_FLIGHT,
    keep: true,
    onLand: () => {
      state.landed = true;
      // The server never answered with the card on the table: let the flight go.
      later(() => {
        if (mine === state) {
          state.flight?.remove();
          parked.delete(state.flight!);
          mine = null;
        }
      }, 4000);
    },
  });
}

// -------------------------------------------------------------------------------------------------
// Events

interface Ctx {
  you: number;
  players: number;
  matchNo: number;
}

function after(fn: () => void): void {
  // Runs after Preact drew the change (its render is queued in a microtask) and before the paint.
  requestAnimationFrame(fn);
}

/** The deal: cards fly from the deck to each seat and into your hollows, then yours turn face up. */
export function onDeal(c: Ctx, hand: number, mao: number): void {
  settle();
  setScene({ motion: true, deckOnTable: true, dealing: hand, handEnd: null, chip: null, zapLine: null, gathered: '' });
  after(() => {
    if (reduced()) {
      later(() => setScene({ deckOnTable: false, dealing: -1 }), Math.round((DEAL_FLIGHT + REVEAL_FLIP) * REDUCED_BEAT));
      return;
    }
    const deck = deckTop();
    const from = boxOf(deck);
    const buttons = [...document.querySelectorAll<HTMLElement>('.hand [data-slot]')];
    const packets = [...document.querySelectorAll<HTMLElement>('.deck .deck__packet')];
    if (!from) {
      setScene({ deckOnTable: false, dealing: -1 });
      return;
    }
    for (const b of buttons) hide(b, true);
    const mineFlights: { el: HTMLElement; button: HTMLElement }[] = [];
    let i = 0;
    let stack = 40;
    for (let k = 0; k < 3; k++) {
      for (let j = 0; j < c.players; j++) {
        const seat = (mao + j) % c.players;
        const delay = i * DEAL_STAGGER;
        i++;
        later(() => {
          stack -= 1;
          setDeckDepth(packets, stack);
        }, delay);
        if (seat === c.you) {
          const button = buttons[k];
          const to = boxOf(button);
          if (!button || !to) continue;
          const face = copy(button.querySelector('svg'));
          // Your cards fly as backs and turn face up once the last card of the deal lands.
          const el = fly({ from, to, back: backTemplate(), face, dur: DEAL_FLIGHT, delay, rot0: -4, keep: true, turnLater: true });
          if (el) mineFlights.push({ el, button });
        } else {
          const anchor = boxOf(seatAnchor(seat));
          if (!anchor) continue;
          fly({ from, to: centred(anchor, SMALL[0], SMALL[1]), face: backTemplate(), dur: DEAL_FLIGHT, delay, rot0: -4 });
        }
      }
    }
    const landAll = (i - 1) * DEAL_STAGGER + DEAL_FLIGHT;
    later(() => {
      // Your cards turn face up; the rest of the deck slides to the vira row.
      for (const m of mineFlights) {
        turnOver(m.el, REVEAL_FLIP, () => {
          m.el.remove();
          parked.delete(m.el);
          show(m.button);
        });
      }
      deckToSide();
    }, landAll);
    later(() => {
      for (const b of buttons) show(b);
      setScene({ dealing: -1 });
    }, landAll + REVEAL_FLIP + 20);
  });
}

function deckToSide(): void {
  const from = boxOf(deckTop());
  setScene({ deckOnTable: false });
  after(() => {
    const pile = q('.pile__back');
    const to = boxOf(pile);
    if (!from || !to) return;
    hide(pile);
    fly({ from, to, face: backTemplate(), dur: DEAL_FLIGHT, rot0: -4, rot1: 4, onLand: () => show(pile) });
  });
}

/** Thickness of the deck as card edges, thinning as cards leave it. */
export function deckShadow(stack: number, top: boolean): string {
  const steps = Math.max(1, Math.round(stack / 7));
  const k = top ? Math.ceil(steps / 2) : Math.floor(steps / 2);
  const out: string[] = [];
  for (let i = 1; i <= k; i++) out.push(`0 ${2 * i - 0.75}px 0 0 var(--deck-face)`, `0 ${2 * i}px 0 0 var(--deck-edge)`);
  out.push(top ? '0 1px 2px rgb(23 24 28 / .14)' : `0 ${2 * k + 1}px 1px rgb(23 24 28 / .16), 0 ${2 * k + 9}px 16px -9px rgb(10 20 60 / .45)`);
  return out.join(', ');
}

function setDeckDepth(packets: HTMLElement[], stack: number): void {
  packets.forEach((p) => {
    p.style.boxShadow = deckShadow(stack, p.classList.contains('deck__packet--top'));
  });
}

/** A card played: from the seat's avatar to its spot (an AI's turns face up), or yours from the hand. */
export function onPlay(c: Ctx, seat: number): void {
  // A resolved trick still on the table goes to its round slot before the new card lands.
  gatherTrickNow(c);
  if (seat === c.you) {
    const m = mine;
    mine = null;
    after(() => {
      const target = spotCard(seat);
      if (!m || !m.flight) {
        if (m && reduced() && target) {
          hide(target);
          later(() => show(target), Math.round(MY_PLAY_FLIGHT * REDUCED_BEAT));
        }
        return;
      }
      const flight = m.flight;
      const land = () => {
        flight.remove();
        parked.delete(flight);
        show(target);
      };
      if (m.landed) land();
      else {
        hide(target);
        flight.getAnimations().forEach((a) => a.finished.then(land, land));
      }
    });
    return;
  }
  after(() => {
    const target = spotCard(seat);
    const to = boxOf(target);
    const anchor = boxOf(seatAnchor(seat));
    if (!target || !to) return;
    hide(target);
    if (!anchor) {
      show(target);
      return;
    }
    const isBack = target.querySelector('[data-card="-1"]') !== null;
    fly({
      from: centred(anchor, SMALL[0], SMALL[1]),
      to,
      back: isBack ? null : backTemplate(),
      face: copy(target),
      dur: AI_PLAY_FLIGHT,
      rot0: -10,
      onLand: () => show(target),
    });
  });
}

let holdTimer: ReturnType<typeof setTimeout> | null = null;

function holdThenGather(c: Ctx, hand: number, round: number): void {
  if (holdTimer) clearTimeout(holdTimer);
  const key = trickKey(c.matchNo, hand, round);
  holdTimer = setTimeout(() => {
    holdTimer = null;
    gatherTrick(key, round);
  }, ROUND_HOLD);
}

let pendingGather: { key: string; round: number } | null = null;

function gatherTrickNow(_c: Ctx): void {
  if (!holdTimer || !pendingGather) return;
  clearTimeout(holdTimer);
  holdTimer = null;
  gatherTrick(pendingGather.key, pendingGather.round);
}

function gatherTrick(key: string, round: number): void {
  pendingGather = null;
  if (getScene().gathered === key || getScene().handEnd) return;
  const slot = boxOf(q(`[data-round-slot="${round}"]`));
  if (slot && !reduced()) {
    document.querySelectorAll<HTMLElement>('.trick [data-spot-seat] .trick__card').forEach((card) => {
      const from = boxOf(card);
      if (!from) return;
      fly({ from, to: centred(slot, from.w * 0.4, from.h * 0.4), face: copy(card), dur: GATHER });
    });
  }
  setScene({ gathered: key });
}

/** A round resolved: the trick stays (winner tag) up to ROUND_HOLD, or until the next card, then gathers into its slot. */
export function onRound(c: Ctx, hand: number, round: number): void {
  pendingGather = { key: trickKey(c.matchNo, hand, round), round };
  holdThenGather(c, hand, round);
}

/** The hand ended: count the points, then the cards go back to the deck and the deck to the tile. */
export function onHand(c: Ctx, winnerTeam: number, points: number, zapWon: boolean | null): void {
  if (holdTimer) clearTimeout(holdTimer);
  holdTimer = null;
  pendingGather = null;
  const key = Date.now();
  setScene({ handEnd: 'count', chip: winnerTeam >= 0 && points > 0 ? { team: winnerTeam, points, key } : null, zapLine: null });
  if (winnerTeam >= 0 && points > 0) {
    after(() => {
      const chip = q('.score__chip');
      const to = boxOf(chip);
      const from = boxOf(q('.rounds')) ?? boxOf(q('.play-area'));
      if (!chip || !to || !from || reduced()) return;
      hide(chip);
      const face = document.createElement('div');
      face.className = 'flight__chip';
      face.textContent = `+${points}`;
      fly({ from: centred(from, 40, 40), to, face, dur: COUNT_FLIGHT, rot0: -12, onLand: () => show(chip) });
    });
  }
  if (zapWon !== null) later(() => setScene({ zapLine: { won: zapWon, key } }), COUNT_FLIGHT);
  later(() => handGather(), HAND_GATHER_AT);
  later(() => setScene({ handEnd: 'gathered' }), HAND_GATHER_AT + HAND_GATHER);
  later(() => setScene({ chip: null }), reduced() ? Math.max(COUNT_HOLD_REDUCED, PREDEAL_AT) : PREDEAL_AT);
  later(() => setScene({ zapLine: null }), COUNT_FLIGHT + ZAP_LINE_MS);
}

function handGather(): void {
  // Face-up cards (the trick, the cards still in your hand) turn down on their way to the deck.
  const pieces: { from: Box; face: Element | null }[] = [];
  document.querySelectorAll<HTMLElement>('.trick [data-spot-seat] .trick__card, .hand [data-slot] svg').forEach((el) => {
    const from = boxOf(el);
    if (from) pieces.push({ from, face: copy(el) });
  });
  const pileEl = q('.pile__back');
  const pile = boxOf(pileEl);
  setScene({ handEnd: 'gather', deckOnTable: true });
  if (reduced()) return;
  after(() => {
    const deckEl = q('.deck');
    const to = boxOf(q('.deck .deck__packet--top'));
    if (!deckEl || !to) return;
    hide(deckEl);
    let last = 0;
    pieces.forEach((p, k) => {
      const delay = 40 * (k + 1);
      last = Math.max(last, delay);
      fly({ from: p.from, to, face: backTemplate(), back: p.face, dur: HAND_GATHER - 40, delay, rot1: -4 });
    });
    if (pile) fly({ from: pile, to, face: backTemplate(), dur: HAND_GATHER, rot0: 4, rot1: -4 });
    later(() => show(deckEl), Math.max(HAND_GATHER, last + HAND_GATHER - 40));
  });
}

/** The next hand's "before the deal" state is on screen. */
export function onPredeal(): void {
  setScene({ deckOnTable: false, dealing: -1, handEnd: null, chip: null });
}

/** A state drawn in place (snapshot) or shown at once (a newer message arrived): no motion. */
export function onSnapshot(): void {
  if (holdTimer) clearTimeout(holdTimer);
  holdTimer = null;
  pendingGather = null;
  settle();
  setScene({ ...INITIAL, motion: false, dealerInStatus: scene.dealerInStatus });
}

/** Events shown at once: finish what runs and draw the end state. */
export function onInstant(): void {
  if (holdTimer) clearTimeout(holdTimer);
  holdTimer = null;
  pendingGather = null;
  settle();
  setScene({ ...INITIAL, motion: true, dealerInStatus: scene.dealerInStatus });
}

/** The person's seat and the table size, for the handlers. */
export function ctxNow(): Ctx | null {
  const v = store.get().view;
  return v ? { you: v.seat, players: v.players, matchNo: v.matchNo } : null;
}
