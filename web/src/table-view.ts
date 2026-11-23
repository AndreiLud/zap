// What the table shows. The server sends, for each change, the seat's observation after the change
// (obs), the events that led there with display offsets (at, in ms after arrival) and the deadline.
// The client starts from what it showed before, applies each event at its offset (so the AI cards
// land one by one), and when the last event is shown it switches to the server's observation.
// Nothing here decides the game: it only replays what the server already decided.
//
// Every event the playback shows also goes out on tableBus, which the table's motion, sound and
// announcements listen to (table/events.ts). Between two hands the playback shows the next hand's
// "before the deal" state (dealt false) once the cards of the last hand are back in the deck.

import { manilhaRankForVira } from '../../engine/src/cards.ts';
import { ladderOf, onzeValue, type RuleOptions, type Variant } from '../../engine/src/config.ts';
import { handWinner, TIE, type GameEvent, type HandEndReason, type HandKind, type HandPhase } from '../../engine/src/engine.ts';
import type { Observation, PublicRound } from '../../engine/src/observe.ts';
import type { ServerMsg, TimedEvent } from '../../shared/protocol.ts';
import { PREDEAL_AT } from './table/timing.ts';

export type GameMsg = Extract<ServerMsg, { t: 'game' }>;
export type DealEvent = Extract<GameEvent, { t: 'deal' }>;

/** A card slot whose card this client does not know (a hand that passed while it was away). */
export const UNKNOWN = -3;

/** One finished hand, for the side panel's score history. */
export interface HandRecord {
  matchNo: number;
  handIndex: number;
  /** Winning team, or -1 when nobody scored. */
  winner: number;
  points: number;
}

export interface TableView {
  matchNo: number;
  seat: number;
  players: number;
  variant: Variant;
  options: RuleOptions;
  score: [number, number];
  games: [number, number];
  handIndex: number;
  dealer: number;
  mao: number;
  vira: number;
  manilhaRank: number;
  kind: HandKind;
  onzeTeam: number;
  phase: HandPhase;
  step: number;
  value: number;
  /** Value proposed by the pending raise (0 when none). */
  proposed: number;
  raiser: number;
  lastRaiseTeam: number;
  turn: number;
  round: number;
  rounds: PublicRound[];
  hand: number[];
  partnerHand: number[] | null;
  handCounts: number[];
  signals: { seat: number; signal: number }[];
  /** Legal actions for this seat; 0 while events are still being shown. */
  legal: number;
  over: boolean;
  winner: number;
  /** Seat the table is waiting for (-1 between hands). */
  waitingFor: number;
  handResult: { winner: number; points: number; reason: HandEndReason } | null;
  /** The cards of this hand are dealt. False in the "before the deal" state (deck on the table). */
  dealt: boolean;
  /** Hands of this match seen since the page opened, oldest first. */
  history: HandRecord[];
}

export function ladderFor(v: { variant: Variant; players: number; options: RuleOptions }): readonly number[] {
  return ladderOf({ variant: v.variant, players: v.players as 2 | 4, options: v.options });
}

export function fromObs(msg: GameMsg, history: readonly HandRecord[] = []): TableView {
  const o: Observation = msg.obs;
  const ladder = ladderFor(o);
  return {
    matchNo: msg.matchNo,
    seat: o.seat,
    players: o.players,
    variant: o.variant,
    options: o.options,
    score: [o.score[0], o.score[1]],
    games: [o.games[0], o.games[1]],
    handIndex: o.handIndex,
    dealer: o.dealer,
    mao: o.mao,
    vira: o.vira,
    manilhaRank: o.manilhaRank,
    kind: o.kind,
    onzeTeam: o.onzeTeam,
    phase: o.phase,
    step: o.step,
    value: o.value,
    proposed: o.phase === 'raise' ? (ladder[o.step + 1] ?? 0) : 0,
    raiser: o.raiser,
    lastRaiseTeam: o.lastRaiseTeam,
    turn: o.turn,
    round: o.round,
    rounds: o.rounds.map((r) => ({ ...r, plays: r.plays.map((p) => ({ ...p })) })),
    hand: o.hand.slice(),
    partnerHand: o.partnerHand ? o.partnerHand.slice() : null,
    handCounts: o.handCounts.slice(),
    signals: o.signals.map((s) => ({ ...s })),
    legal: o.legal,
    over: o.over,
    winner: o.winner,
    waitingFor: msg.deadline ? msg.deadline.seat : -1,
    handResult: null,
    dealt: true,
    history: history.filter((h) => h.matchNo === msg.matchNo),
  };
}

function cloneView(v: TableView): TableView {
  return {
    ...v,
    score: [v.score[0], v.score[1]],
    games: [v.games[0], v.games[1]],
    rounds: v.rounds.map((r) => ({ ...r, plays: r.plays.map((p) => ({ ...p })) })),
    hand: v.hand.slice(),
    partnerHand: v.partnerHand ? v.partnerHand.slice() : null,
    handCounts: v.handCounts.slice(),
    signals: v.signals.map((s) => ({ ...s })),
    history: v.history.slice(),
  };
}

/**
 * The table before a deal: the deck back on the table, nothing dealt, the vira and the manilha still
 * to come, and the value the coming hand starts at. Used between hands (the playback), for the first
 * deal of a match, and by the guided match for its "before the deal" scene.
 */
export function predealFrom(v: TableView, deal: Pick<DealEvent, 'hand' | 'dealer' | 'mao' | 'kind' | 'onzeTeam'>): TableView {
  const n = v.players;
  const ladder = ladderFor(v);
  // A game of a best of three just ended: the next deal starts the next game at 0 to 0.
  const score: [number, number] = v.score[0] >= 12 || v.score[1] >= 12 ? [0, 0] : [v.score[0], v.score[1]];
  return {
    ...cloneView(v),
    score,
    handIndex: deal.hand,
    dealer: deal.dealer,
    mao: deal.mao,
    vira: -1,
    manilhaRank: -1,
    kind: deal.kind,
    onzeTeam: deal.onzeTeam,
    phase: 'over',
    step: 0,
    value: deal.kind === 'onze' ? onzeValue({ variant: v.variant, players: n as 2 | 4, options: v.options }) : ladder[0],
    proposed: 0,
    raiser: -1,
    lastRaiseTeam: -1,
    turn: deal.mao,
    round: 0,
    rounds: [],
    hand: [-1, -1, -1],
    partnerHand: null,
    handCounts: new Array<number>(n).fill(0),
    signals: [],
    legal: 0,
    waitingFor: -1,
    handResult: null,
    dealt: false,
  };
}

/** Seat that acts in an event, or -1 for events that are results. */
export function actorOf(e: GameEvent): number {
  switch (e.t) {
    case 'play':
    case 'raise':
    case 'accept':
    case 'run':
    case 'onze':
    case 'signal':
      return e.seat;
    default:
      return -1;
  }
}

/**
 * Cards of one seat at the start of a hand that the final observation shows: the final slots plus
 * the cards that seat plays later in this same batch of events.
 */
function handAtDeal(finalHand: number[], seat: number, later: readonly TimedEvent[], blind: boolean): number[] {
  const out = finalHand.slice();
  for (const te of later) {
    if (te.e.t === 'deal') break;
    if (te.e.t === 'play' && te.e.seat === seat && te.e.slot >= 0 && te.e.slot < out.length) out[te.e.slot] = blind ? -2 : te.e.card;
  }
  return out;
}

/** Applies one event to the view (in place). `later` are the events after it in the same message. */
export function applyEvent(v: TableView, e: GameEvent, final: GameMsg, later: readonly TimedEvent[]): void {
  const ladder = ladderFor(v);
  const n = v.players;
  switch (e.t) {
    case 'deal': {
      if (v.score[0] >= 12 || v.score[1] >= 12) v.score = [0, 0];
      v.handIndex = e.hand;
      v.dealer = e.dealer;
      v.mao = e.mao;
      v.vira = e.vira;
      v.manilhaRank = v.variant === 'paulista' && e.vira >= 0 ? manilhaRankForVira(e.vira) : -1;
      v.kind = e.kind;
      v.onzeTeam = e.onzeTeam;
      v.phase = e.kind === 'onze' ? 'onze' : 'play';
      v.step = 0;
      v.value = e.kind === 'onze' ? onzeValue({ variant: v.variant, players: n as 2 | 4, options: v.options }) : ladder[0];
      v.proposed = 0;
      v.raiser = -1;
      v.lastRaiseTeam = -1;
      v.turn = e.mao;
      v.round = 0;
      v.rounds = [{ leader: e.mao, plays: [], result: -1, winnerSeat: -1 }];
      v.handCounts = new Array<number>(n).fill(3);
      v.signals = [];
      v.handResult = null;
      v.dealt = true;
      const sameHand = e.hand === final.obs.handIndex && final.matchNo === v.matchNo;
      const blind = e.kind === 'iron';
      v.hand = sameHand ? handAtDeal(final.obs.hand, v.seat, later, blind) : [UNKNOWN, UNKNOWN, UNKNOWN];
      v.partnerHand = sameHand && final.obs.partnerHand ? handAtDeal(final.obs.partnerHand, (v.seat + 2) % 4, later, false) : null;
      break;
    }
    case 'onze':
      v.phase = e.play ? 'play' : 'over';
      break;
    case 'play': {
      const r = v.rounds[v.round];
      if (r) r.plays.push({ seat: e.seat, card: e.card, faceDown: e.faceDown });
      if (v.handCounts[e.seat] > 0) v.handCounts[e.seat]--;
      if (e.seat === v.seat) v.hand[e.slot] = -1;
      if (v.partnerHand && e.seat === (v.seat + 2) % 4) v.partnerHand[e.slot] = -1;
      v.turn = (e.seat + 1) % n;
      break;
    }
    case 'raise':
      if (v.phase === 'raise') {
        // A raise in answer to a raise accepts the step below the one it proposes.
        v.step = e.step - 1;
        v.value = ladder[e.step - 1];
        v.lastRaiseTeam = v.raiser & 1;
      }
      v.phase = 'raise';
      v.raiser = e.seat;
      v.proposed = e.value;
      break;
    case 'accept':
      v.phase = 'play';
      v.step = e.step;
      v.value = e.value;
      v.lastRaiseTeam = v.raiser >= 0 ? v.raiser & 1 : v.lastRaiseTeam;
      v.raiser = -1;
      v.proposed = 0;
      break;
    case 'run':
      v.phase = 'over';
      break;
    case 'signal':
      v.signals.push({ seat: e.seat, signal: e.signal });
      break;
    case 'round': {
      const r = v.rounds[e.round];
      if (!r) break;
      r.result = e.result;
      r.winnerSeat = e.winnerSeat;
      if (handWinner(v.rounds) === -2) {
        const leader = e.result === TIE ? r.leader : e.winnerSeat;
        v.rounds.push({ leader, plays: [], result: -1, winnerSeat: -1 });
        v.round = e.round + 1;
        v.turn = leader;
      }
      break;
    }
    case 'hand':
      v.phase = 'over';
      v.raiser = -1;
      v.proposed = 0;
      v.score = [e.score[0], e.score[1]];
      v.handResult = { winner: e.winner, points: e.points, reason: e.reason };
      if (!v.history.some((h) => h.matchNo === v.matchNo && h.handIndex === v.handIndex)) {
        v.history.push({ matchNo: v.matchNo, handIndex: v.handIndex, winner: e.winner, points: e.winner < 0 ? 0 : e.points });
      }
      break;
    case 'game':
      v.games = [e.games[0], e.games[1]];
      break;
    case 'match':
      v.over = true;
      v.winner = e.winner;
      break;
  }
}

/**
 * The events of the first message a page gets, with the deal of the first hand put back in front
 * when the server left it out: only when that message holds everything played since the deal (no
 * card on the table and no bet that its events do not show), so replaying it from the table before
 * the deal ends exactly on the observation.
 */
export function withOpeningDeal(msg: GameMsg): TimedEvent[] {
  const o = msg.obs;
  const events = msg.events;
  if (events.length === 0 || events[0].e.t === 'deal' || o.handIndex !== 0) return events;
  if (events.some((te) => te.e.t === 'deal' || te.e.t === 'hand')) return events;
  const shown = o.rounds.reduce((n, r) => n + r.plays.length, 0);
  const played = events.filter((te) => te.e.t === 'play').length;
  if (shown !== played) return events;
  const raised = events.some((te) => te.e.t === 'raise');
  if (!raised && (o.step > 0 || o.phase === 'raise')) return events;
  const deal: DealEvent = { t: 'deal', hand: 0, dealer: o.dealer, mao: o.mao, vira: o.vira, kind: o.kind, onzeTeam: o.onzeTeam };
  return [{ at: 0, e: deal }, ...events];
}

// -------------------------------------------------------------------------------------------------
// The bus: one place where the table hears what the playback shows

export type BusItem =
  /** One event shown. `instant`: shown at once with others (a newer message arrived), no motion. */
  | { kind: 'event'; e: GameEvent; msg: GameMsg; instant: boolean }
  /** The state was drawn in place (first message, reconnect, sync): no animation. */
  | { kind: 'snapshot'; msg: GameMsg }
  /** The next hand's "before the deal" state is on screen. */
  | { kind: 'predeal'; hand: number };

type BusListener = (b: BusItem) => void;
const busListeners = new Set<BusListener>();
const recent: { at: number; b: BusItem }[] = [];

export const tableBus = {
  /**
   * Listens to what the playback shows. `replayMs`: also hear the items of the last few ms (the
   * table mounts just after the first message of a match, whose deal it should still show).
   */
  on(fn: BusListener, replayMs = 0): () => void {
    busListeners.add(fn);
    if (replayMs > 0) {
      const now = performance.now();
      for (const r of recent.slice()) if (now - r.at <= replayMs) fn(r.b);
    }
    return () => {
      busListeners.delete(fn);
    };
  },
  emit(b: BusItem): void {
    recent.push({ at: performance.now(), b });
    if (recent.length > 24) recent.shift();
    for (const fn of [...busListeners]) fn(b);
  },
};

// -------------------------------------------------------------------------------------------------
// Playback

export interface PlaybackOutput {
  view(v: TableView, playing: boolean, msg: GameMsg): void;
  event(e: GameEvent, msg: GameMsg): void;
}

export interface PlaybackOptions {
  /**
   * Called when the next event to show is the deal of a hand above the first. A returned promise
   * pauses the queue until it settles (the solo ads pause point, CLIENT-SPEC 16.4).
   */
  beforeDeal?: (hand: number) => Promise<unknown> | void;
}

/** Shows the events of each game message at their offsets, then the server's final observation. */
export class Playback {
  private v: TableView | null = null;
  private target: GameMsg | null = null;
  private queue: TimedEvent[] = [];
  private startedAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pausedAt: number | null = null;
  private pauseToken = 0;
  /** When (ms after the message arrived) to show the next hand's "before the deal" state. */
  private predeal: { at: number; deal: DealEvent } | null = null;
  /** The deal beforeDeal was last asked about, so it is asked once. */
  private asked = '';
  private readonly out: PlaybackOutput;
  private readonly opts: PlaybackOptions;

  constructor(out: PlaybackOutput, opts: PlaybackOptions = {}) {
    this.out = out;
    this.opts = opts;
  }

  get playing(): boolean {
    return this.queue.length > 0;
  }

  get paused(): boolean {
    return this.pausedAt !== null;
  }

  get view(): TableView | null {
    return this.v;
  }

  get message(): GameMsg | null {
    return this.target;
  }

  push(msg: GameMsg): void {
    if (this.playing) {
      if (msg.events.length === 0 && this.target && msg.matchNo === this.target.matchNo) {
        // Nothing moved (someone reconnected, a phrase): keep showing, just aim at the new snapshot.
        this.target = msg;
        return;
      }
      this.flush();
    }
    this.target = msg;
    // A server that did not send the deal of a match nothing was played in yet (the deal happened
    // before this page connected): the deal is shown anyway, rebuilt from the observation.
    const events = !this.v ? withOpeningDeal(msg) : msg.events;
    const first = events[0]?.e;
    if (!this.v && first?.t === 'deal' && first.hand === 0) {
      // The first message of a match on a page that showed nothing yet: start from the table before
      // the deal, so the deal itself shows.
      const base = fromObs(msg);
      base.score = [0, 0];
      base.games = [0, 0];
      base.over = false;
      base.winner = -1;
      this.v = predealFrom(base, first);
    }
    if (events.length === 0 || !this.v) {
      this.v = fromObs(msg, this.v?.history ?? []);
      tableBus.emit({ kind: 'snapshot', msg });
      this.out.view(this.v, false, msg);
      return;
    }
    const base = cloneView(this.v);
    if (msg.matchNo !== base.matchNo) {
      base.matchNo = msg.matchNo;
      base.score = [0, 0];
      base.games = [0, 0];
      base.over = false;
      base.winner = -1;
      base.history = [];
    }
    base.legal = 0;
    this.v = base;
    this.queue = events.slice();
    this.startedAt = performance.now();
    this.pausedAt = null;
    this.predeal = null;
    this.run();
  }

  /** Changes the shown hand without telling the server anything (a card the person just tapped). */
  local(change: (v: TableView) => void): void {
    if (!this.v || !this.target) return;
    const v = cloneView(this.v);
    change(v);
    this.v = v;
    this.out.view(v, this.playing, this.target);
  }

  /** Shows every pending event at once. */
  flush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pausedAt = null;
    this.pauseToken++;
    this.run(true);
  }

  /** Stops the queue where it is (an ad shows); resume() goes on, shifted by the time paused. */
  pause(): void {
    if (this.pausedAt !== null) return;
    this.pausedAt = performance.now();
    this.pauseToken++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  resume(): void {
    if (this.pausedAt === null) return;
    this.startedAt += performance.now() - this.pausedAt;
    this.pausedAt = null;
    if (this.playing) this.run();
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
    this.v = null;
    this.target = null;
    this.pausedAt = null;
    this.pauseToken++;
    this.predeal = null;
  }

  private run(all = false): void {
    this.timer = null;
    if (this.pausedAt !== null && !all) return;
    const msg = this.target;
    if (!msg || !this.v) return;
    const elapsed = performance.now() - this.startedAt;
    let v = cloneView(this.v);
    while (this.queue.length > 0 && (all || this.queue[0].at <= elapsed)) {
      const te = this.queue[0];
      const e = te.e;
      if (!all && e.t === 'deal' && e.hand > 0 && this.opts.beforeDeal) {
        const key = `${msg.matchNo}:${e.hand}`;
        if (this.asked !== key) {
          this.asked = key;
          const wait = this.opts.beforeDeal(e.hand);
          if (wait && typeof (wait as Promise<unknown>).then === 'function') {
            this.v = v;
            this.pause();
            const token = this.pauseToken;
            const go = () => {
              if (token === this.pauseToken) this.resume();
            };
            (wait as Promise<unknown>).then(go, go);
            return;
          }
        }
      }
      this.queue.shift();
      applyEvent(v, e, msg, this.queue);
      if (e.t === 'hand') {
        const next = this.queue.find((x) => x.e.t === 'deal');
        this.predeal = next && next.e.t === 'deal' && !all ? { at: te.at + PREDEAL_AT, deal: next.e } : null;
      } else if (e.t === 'deal') {
        this.predeal = null;
      }
      tableBus.emit({ kind: 'event', e, msg, instant: all });
      this.out.event(e, msg);
    }
    if (this.queue.length === 0) {
      this.v = fromObs(msg, v.history);
      this.predeal = null;
      this.out.view(this.v, false, msg);
      return;
    }
    const next = this.queue[0];
    const actor = actorOf(next.e);
    v.waitingFor = next.e.t === 'deal' ? -1 : actor >= 0 ? actor : v.waitingFor;
    if (this.predeal && elapsed >= this.predeal.at && next.e === this.predeal.deal) {
      v = predealFrom(v, this.predeal.deal);
      this.predeal = null;
      tableBus.emit({ kind: 'predeal', hand: v.handIndex });
    }
    this.v = v;
    this.out.view(v, true, msg);
    const wake = this.predeal ? Math.min(next.at, this.predeal.at) : next.at;
    this.timer = setTimeout(() => this.run(), Math.max(0, wake - elapsed));
  }
}
