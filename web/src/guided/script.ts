// The practice hand of the guided first match (CLIENT-SPEC 10.5), played on the real engine in the
// browser. This module is the "server" of that hand: it deals the scripted cards, plays the three
// scripted AI seats and hands out the events seat 0 may see, with display offsets, so the client
// shows them exactly like a room's. Nothing here touches the DOM or the network.
//
// Seats: you 0 (bottom), Zap 1 (right, opponent), Iara 2 (top, partner), Bento 3 (left, opponent).
// Bento deals and you lead; play goes you, right, top, left. The lesson ends when the hand ends:
// the engine deals the next hand at once; its deal event closes the stream, as in a room, and the
// page holds the playback before it (Playback beforeDeal), so the table gathers the cards, puts the
// deck back on the tile and stops there.

import { makeConfig } from '../../../engine/src/config.ts';
import {
  A_ACCEPT,
  A_PLAY0,
  A_RAISE,
  A_RUN,
  A_SIGNAL0,
  SIGNAL_MASK,
  applyAction,
  expectedActor,
  legalMask,
  newMatch,
  setHandCards,
  type GameEvent,
  type HandPhase,
  type MatchState,
} from '../../../engine/src/engine.ts';
import { eventsFor, observe, type Observation } from '../../../engine/src/observe.ts';
import type { TimedEvent } from '../../../shared/protocol.ts';
import { AI_MOVE_MS, BENTO, GUIDED_HANDS, GUIDED_SEED, GUIDED_VIRA, HAND_END_MS, IARA, PLANS, SIGNAL_NADA, YOU, ZAP } from './constants.ts';

export * from './constants.ts';

function firstLegal(legal: number): number {
  for (let a = 0; a < 15; a++) if (legal & (1 << a)) return a;
  return -1;
}

/**
 * What a seat sees before the deal: the deck on the table, no vira, no cards in any hand, nobody to
 * wait for. Used before "Start" and after the hand, when the lesson stops before the next deal.
 */
export function beforeDeal(o: Observation): Observation {
  return {
    ...o,
    vira: -1,
    manilhaRank: -1,
    phase: 'over',
    step: 0,
    value: 1,
    raiser: -1,
    lastRaiseTeam: -1,
    turn: o.mao,
    round: 0,
    rounds: [{ leader: o.mao, plays: [], result: -1, winnerSeat: -1 }],
    hand: [-1, -1, -1],
    partnerHand: null,
    handCounts: o.handCounts.map(() => 0),
    signals: [],
    legal: 0,
  };
}

export class GuidedGame {
  readonly state: MatchState;
  private started = false;
  private zapRaised = false;
  /** True once the practice hand ended (the next deal stays hidden). */
  ended = false;

  constructor() {
    this.state = newMatch(makeConfig('paulista', 4), GUIDED_SEED, { dealer: BENTO, score: [0, 0] });
    setHandCards(
      this.state,
      GUIDED_HANDS.map((h) => h.slice()),
      GUIDED_VIRA,
    );
  }

  get isStarted(): boolean {
    return this.started;
  }

  /** The deal, then Iara's signal "nada" before the first card (it takes no time on a room's timeline; here it waits one AI beat). */
  start(): TimedEvent[] {
    if (this.started) return [];
    this.started = true;
    const h = this.state.hand;
    const out: TimedEvent[] = [{ at: 0, e: { t: 'deal', hand: h.index, dealer: h.dealer, mao: h.mao, vira: h.vira, kind: h.kind, onzeTeam: h.onzeTeam } }];
    const evs: GameEvent[] = [];
    applyAction(this.state, IARA, A_SIGNAL0 + SIGNAL_NADA, evs);
    this.collect(out, evs, AI_MOVE_MS);
    return out;
  }

  phase(): HandPhase {
    return this.state.hand.phase;
  }

  /**
   * Who the game waits for. As in a room (room-core decider), when a bet waits for our team the
   * person answers: Iara never answers before you.
   */
  decider(): number {
    const h = this.state.hand;
    if (h.phase === 'raise' && (h.raiser & 1) !== (YOU & 1)) return YOU;
    if (h.phase === 'onze' && h.onzeTeam === (YOU & 1)) return YOU;
    return expectedActor(this.state);
  }

  /** The person must act now (play a card, or answer a bet). */
  humanTurn(): boolean {
    return this.started && !this.ended && this.decider() === YOU;
  }

  /** The Zap's call waits for the person's answer. */
  waitingAnswer(): boolean {
    return this.humanTurn() && this.state.hand.phase === 'raise';
  }

  /** Legal actions of the person now (signals, raises and cards, also out of turn where the rules allow). */
  legal(): number {
    return this.started && !this.ended ? legalMask(this.state, YOU) : 0;
  }

  /** The seat the table waits for, or null before the deal and after the hand. */
  deadlineSeat(): number | null {
    return this.started && !this.ended ? this.decider() : null;
  }

  /** What seat 0 sees now (the table before the deal, before "Start" and after the hand). */
  observation(): Observation {
    const o = observe(this.state, YOU);
    return this.started && !this.ended ? o : beforeDeal(o);
  }

  /**
   * The person's action and what follows. After an answer to a bet the lesson pauses (the coach
   * explains the new value); after anything else the AI seats play until the next pause.
   */
  human(a: number): TimedEvent[] {
    if (!(this.legal() & (1 << a))) return [];
    const answer = this.state.hand.phase === 'raise' && (a === A_ACCEPT || a === A_RUN);
    const out: TimedEvent[] = [];
    const evs: GameEvent[] = [];
    applyAction(this.state, YOU, a, evs);
    this.collect(out, evs, 0);
    if (!answer) this.runAI(out);
    return out;
  }

  /**
   * AI moves until the person must act, a round or a bet is settled (the coach explains it before
   * the next card), or the hand ends. Each real move waits AI_MOVE_MS after the one before.
   */
  runAI(out: TimedEvent[] = []): TimedEvent[] {
    let at = out.length ? out[out.length - 1].at : 0;
    while (this.started && !this.ended) {
      const seat = this.decider();
      if (seat === YOU) break;
      if (out.some((te) => te.e.t === 'round' || te.e.t === 'accept' || te.e.t === 'run')) break;
      const a = this.aiAction(seat);
      if (a < 0) break;
      const evs: GameEvent[] = [];
      applyAction(this.state, seat, a, evs);
      if (a < A_SIGNAL0) at += AI_MOVE_MS;
      this.collect(out, evs, at);
    }
    return out;
  }

  /**
   * The scripted seats: an answer to the person's bet is always "accept" (the Zap); the Zap raises
   * once, at its first legal chance in round 2; otherwise the first card of the plan still in hand,
   * else the first legal card.
   */
  aiAction(seat: number): number {
    const s = this.state;
    const h = s.hand;
    const legal = legalMask(s, seat);
    if (h.phase === 'raise' || h.phase === 'onze') return legal & (1 << A_ACCEPT) ? A_ACCEPT : firstLegal(legal);
    if (seat === ZAP && !this.zapRaised && h.round === 1 && legal & (1 << A_RAISE)) {
      this.zapRaised = true;
      return A_RAISE;
    }
    const card = this.planSlot(seat, legal);
    if (card >= 0) return card;
    return firstLegal(legal & ~SIGNAL_MASK);
  }

  /** The move ?demo=1 makes for the person: "Aceito" to a bet, else the next card of the plan. */
  demoAction(): number {
    const legal = this.legal();
    if (this.state.hand.phase === 'raise') return legal & (1 << A_ACCEPT) ? A_ACCEPT : firstLegal(legal);
    const card = this.planSlot(YOU, legal);
    return card >= 0 ? card : firstLegal(legal & ~SIGNAL_MASK);
  }

  private planSlot(seat: number, legal: number): number {
    const cards = this.state.hand.cards[seat];
    for (const c of PLANS[seat]) {
      const slot = cards.indexOf(c);
      if (slot >= 0 && legal & (1 << (A_PLAY0 + slot))) return A_PLAY0 + slot;
    }
    for (let i = 0; i < 3; i++) if (legal & (1 << (A_PLAY0 + i))) return A_PLAY0 + i;
    return -1;
  }

  /**
   * Adds the events seat 0 may see. The hand event ends the lesson; the next hand's deal follows
   * HAND_END_MS later, as a room would send it, and the page never lets the table show it.
   */
  private collect(out: TimedEvent[], evs: GameEvent[], at: number): void {
    for (const e of eventsFor(evs, YOU, this.state.config.options)) {
      if (e.t === 'deal') {
        out.push({ at: at + HAND_END_MS, e });
        this.ended = true;
        return;
      }
      out.push({ at, e });
      if (e.t === 'hand') this.ended = true;
    }
  }
}
