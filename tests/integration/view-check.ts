// Checks, from the outside, that every message a seat receives carries only what that seat may
// see: its own cards, the vira, cards played face up, its own face-down cards, and the partner's
// cards only in a mão de onze for the team on the threshold. It also refuses any key it does not
// know, so a new field must be reviewed here before it can reach the browser.
//
// Problems are collected (not thrown) because messages arrive in socket callbacks.

import { HIDDEN } from '../../engine/src/observe.ts';
import type { ServerMsg } from '../../shared/protocol.ts';
import type { GameMsg } from './helpers.ts';

const DECK = 40;

const GAME_KEYS = ['t', 'now', 'seq', 'matchNo', 'obs', 'events', 'deadline'];
const ROOM_MSG_KEYS = ['t', 'now', 'you', 'owner', 'room'];
const ROOM_KEYS = ['code', 'status', 'settings', 'seats', 'matchNo', 'score', 'games', 'lastWinner', 'aiVersion', 'expiresAt', 'setup', 'ownerAway'];
const SEAT_KEYS = ['seat', 'kind', 'name', 'persona', 'verified', 'connected', 'aiPlaying'];
const OBS_KEYS = [
  'seat', 'players', 'variant', 'options', 'score', 'games', 'handIndex', 'dealer', 'mao', 'vira', 'manilhaRank', 'kind',
  'onzeTeam', 'phase', 'step', 'value', 'lastRaiseTeam', 'raiser', 'turn', 'round', 'rounds', 'hand', 'partnerHand',
  'handCounts', 'signals', 'legal', 'over', 'winner',
];
const ROUND_KEYS = ['leader', 'plays', 'result', 'winnerSeat'];
const PLAY_KEYS = ['seat', 'card', 'faceDown'];
const EVENT_KEYS: Record<string, string[]> = {
  deal: ['t', 'hand', 'dealer', 'mao', 'vira', 'kind', 'onzeTeam'],
  onze: ['t', 'seat', 'play'],
  play: ['t', 'seat', 'card', 'faceDown', 'slot'],
  raise: ['t', 'seat', 'step', 'value'],
  accept: ['t', 'seat', 'step', 'value'],
  run: ['t', 'seat'],
  signal: ['t', 'seat', 'signal', 'seenBy'],
  round: ['t', 'round', 'result', 'winnerSeat'],
  hand: ['t', 'winner', 'points', 'reason', 'score'],
  game: ['t', 'winner', 'games'],
  match: ['t', 'winner'],
};
/** Never in any message: seeds, the deck, other hands, signal truth, logs, device ids, AI estimates. */
const FORBIDDEN_KEYS = new Set(['seed', 'dealt', 'cards', 'truthful', 'log', 'rng', 'strength', 'history', 'device', 'devices', 'winProb', 'auto', 'secret', 'token']);

const isCard = (c: unknown): c is number => Number.isInteger(c) && (c as number) >= 0 && (c as number) < DECK;

export class ViewChecker {
  readonly problems: string[] = [];
  messages = 0;
  games = 0;
  seat: number | null = null;
  /** Cards this seat held, by hand (`matchNo:handIndex`), including the ones it already played. */
  readonly own = new Map<string, Set<number>>();
  /** Every card id this seat saw in a snapshot of each hand, with where it saw it. */
  readonly seen = new Map<string, Map<number, Set<string>>>();
  readonly kinds = new Set<string>();
  private slots = new Map<string, number[]>();

  readonly label: string;

  constructor(label: string) {
    this.label = label;
  }

  private bad(what: string): void {
    if (this.problems.length < 50) this.problems.push(`${this.label}: ${what}`);
  }

  private keys(obj: unknown, allowed: string[], where: string): void {
    if (!obj || typeof obj !== 'object') {
      this.bad(`${where} is not an object`);
      return;
    }
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) this.bad(`unexpected key "${k}" in ${where}`);
  }

  private scan(v: unknown, path: string): void {
    if (Array.isArray(v)) {
      v.forEach((x, i) => this.scan(x, `${path}[${i}]`));
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (FORBIDDEN_KEYS.has(k)) this.bad(`forbidden key "${k}" at ${path}`);
        this.scan(x, `${path}.${k}`);
      }
    }
  }

  private see(key: string, card: number, where: string): void {
    let m = this.seen.get(key);
    if (!m) this.seen.set(key, (m = new Map()));
    let s = m.get(card);
    if (!s) m.set(card, (s = new Set()));
    s.add(where);
  }

  private ownSet(key: string): Set<number> {
    let s = this.own.get(key);
    if (!s) this.own.set(key, (s = new Set()));
    return s;
  }

  check(msg: ServerMsg, raw: string): void {
    this.messages++;
    // Seeds and device ids are 64 hex characters: none may appear anywhere.
    if (/[0-9a-f]{64}/i.test(raw)) this.bad(`a 64-hex value (seed or device id) in a ${msg.t} message`);
    this.scan(msg, msg.t);
    if (msg.t === 'room') {
      this.keys(msg, ROOM_MSG_KEYS, 'room message');
      this.keys(msg.room, ROOM_KEYS, 'room');
      for (const s of msg.room.seats) this.keys(s, SEAT_KEYS, 'seat');
      if (msg.you !== null) {
        if (this.seat !== null && this.seat !== msg.you && msg.room.status !== 'lobby') this.bad(`seat changed from ${this.seat} to ${msg.you} during play`);
        this.seat = msg.you;
      }
    } else if (msg.t === 'game') {
      this.game(msg);
    } else if (msg.t === 'phrase') {
      this.keys(msg, ['t', 'seat', 'key'], 'phrase');
    } else if (msg.t === 'error') {
      this.keys(msg, ['t', 'code'], 'error');
    } else {
      this.bad(`unknown message type ${(msg as { t: string }).t}`);
    }
  }

  private game(g: GameMsg): void {
    this.games++;
    this.keys(g, GAME_KEYS, 'game message');
    const o = g.obs;
    this.keys(o, OBS_KEYS, 'obs');
    const me = o.seat;
    if (this.seat !== null && me !== this.seat) this.bad(`obs.seat ${me} is not this seat ${this.seat}`);
    const key = `${g.matchNo}:${o.handIndex}`;
    this.kinds.add(o.kind);
    const cards: number[] = [];

    // Own hand: exactly three slots, own cards only, hidden in a mão de ferro.
    if (!Array.isArray(o.hand) || o.hand.length !== 3) this.bad(`obs.hand has ${o.hand?.length} slots`);
    const iron = o.kind === 'iron';
    const prev = this.slots.get(key);
    o.hand.forEach((v, i) => {
      if (iron ? v !== -1 && v !== HIDDEN : v !== -1 && !isCard(v)) this.bad(`hand slot ${i} = ${v} in a ${o.kind} hand`);
      if (prev) {
        if (prev[i] === -1 && v !== -1) this.bad(`hand slot ${i} came back after being played`);
        if (isCard(prev[i]) && isCard(v) && prev[i] !== v) this.bad(`hand slot ${i} changed from ${prev[i]} to ${v}`);
      }
      if (isCard(v)) {
        this.ownSet(key).add(v);
        this.see(key, v, 'hand');
        cards.push(v);
      }
    });
    this.slots.set(key, o.hand.slice());
    const held = o.hand.filter((v) => v !== -1).length;
    if (!Array.isArray(o.handCounts) || o.handCounts.length !== o.players) this.bad('handCounts has the wrong length');
    else if (o.handCounts[me] !== held) this.bad(`handCounts[${me}] = ${o.handCounts[me]} but the hand holds ${held}`);

    if (isCard(o.vira)) {
      cards.push(o.vira);
      this.see(key, o.vira, 'vira');
      if (o.variant !== 'paulista') this.bad('a vira outside paulista');
    } else if (o.vira !== -1) this.bad(`vira = ${o.vira}`);

    // Partner's cards: only for the team on the threshold of a mão de onze, in 2 against 2.
    const maySeePartner = o.players === 4 && o.kind === 'onze' && o.options.onzeSeesPartner && (me & 1) === o.onzeTeam && !o.over;
    if (o.partnerHand !== null) {
      if (!maySeePartner) this.bad(`partnerHand sent in a ${o.kind} hand (onzeTeam ${o.onzeTeam}, seat ${me})`);
      if (!Array.isArray(o.partnerHand) || o.partnerHand.length !== 3) this.bad('partnerHand does not have 3 slots');
      for (const v of o.partnerHand ?? []) {
        if (v !== -1 && !isCard(v)) this.bad(`partnerHand value ${v}`);
        if (isCard(v)) {
          cards.push(v);
          this.see(key, v, 'partner');
        }
      }
    }

    // Played cards: other seats' face-down cards are hidden; own cards are always known to the owner.
    for (const r of o.rounds) {
      this.keys(r, ROUND_KEYS, 'round');
      for (const p of r.plays) {
        this.keys(p, PLAY_KEYS, 'play');
        if (p.seat === me) {
          if (!isCard(p.card)) this.bad(`own played card shown as ${p.card}`);
          else {
            // Once this hand was seen before, an own play must be a card seen in the own hand.
            if (!iron && prev && !this.ownSet(key).has(p.card)) this.bad(`own play ${p.card} was not in the own hand`);
            this.ownSet(key).add(p.card);
          }
        } else if (p.faceDown) {
          if (p.card !== -1) this.bad(`seat ${p.seat} face-down card visible as ${p.card}`);
        } else if (!isCard(p.card)) this.bad(`seat ${p.seat} face-up card shown as ${p.card}`);
        if (isCard(p.card)) {
          cards.push(p.card);
          this.see(key, p.card, `play:${p.seat}:${p.faceDown ? 'down' : 'up'}`);
        }
      }
    }

    // A card is in one place only.
    const dup = cards.filter((c, i) => cards.indexOf(c) !== i);
    if (dup.length) this.bad(`card ids repeated in one snapshot: ${dup.join(',')}`);

    for (const s of o.signals) this.keys(s, ['seat', 'signal'], 'obs.signals');
    if (!Number.isInteger(o.legal) || o.legal < 0 || o.legal >= 1 << 15) this.bad(`legal mask ${o.legal}`);

    // Events: face-down cards of others hidden, the catchers of a signal never told.
    for (const te of g.events) {
      this.keys(te, ['at', 'e'], 'timed event');
      const e = te.e;
      const allowed = EVENT_KEYS[e.t];
      if (!allowed) {
        this.bad(`unknown event ${e.t}`);
        continue;
      }
      this.keys(e, allowed, `event ${e.t}`);
      if (e.t === 'play' && e.seat !== me && e.faceDown && e.card !== -1) this.bad(`event shows seat ${e.seat} face-down card ${e.card}`);
      if (e.t === 'signal' && o.options.signals !== 'all' && e.seenBy !== 0) this.bad('signal event tells who caught it');
    }
  }
}

/**
 * Two people in the same match: nothing `a` saw of a hand may be one of `b`'s cards, except the
 * ones `b` played face up, and (when they are partners) `b`'s cards that `a` saw as partnerHand.
 * Every card `a` saw as partnerHand must really be one of `b`'s cards.
 */
export function crossCheck(a: ViewChecker, b: ViewChecker, partners = false): string[] {
  const out: string[] = [];
  if (b.seat === null) return [`${b.label}: seat unknown`];
  let compared = 0;
  for (const [key, cardsOfB] of b.own) {
    const seenByA = a.seen.get(key);
    if (!seenByA) continue;
    compared++;
    for (const c of cardsOfB) {
      for (const where of seenByA.get(c) ?? []) {
        if (where === `play:${b.seat}:up` || (partners && where === 'partner')) continue;
        out.push(`${a.label} saw ${b.label}'s card ${c} in hand ${key} as ${where}`);
      }
    }
    for (const [c, wheres] of seenByA) {
      if (wheres.has('partner') && !cardsOfB.has(c)) out.push(`${a.label} was shown ${c} as the partner's card in hand ${key}, but ${b.label} does not hold it`);
    }
  }
  if (compared === 0) out.push(`${a.label} and ${b.label} share no hand to compare`);
  return out;
}
