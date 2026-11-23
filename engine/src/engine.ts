// The truco rules engine: one source of truth for the browser, the Durable Object and training.
//
// The state is a plain object (arrays, numbers and strings) so it can be cloned with
// structuredClone, stored as JSON and replayed. Actions are small integers so the AI can use
// them directly as policy outputs.

import { DECK_SIZE, FACE_DOWN_STRENGTH, RANK_3, manilhaRankForVira, rankOf, strengthTable } from './cards.ts';
import {
  MAX_STEP,
  TARGET_POINTS,
  ladderOf,
  onzeRunPoints,
  onzeThreshold,
  onzeValue,
  validateConfig,
  type MatchConfig,
} from './config.ts';
import { createStream, deriveSeed, randInt, shuffledRange, type ChaChaStream } from './rng.ts';

// ---------------------------------------------------------------------------------------------
// Actions

/** Play the card in hand slot 0, 1 or 2 face up. */
export const A_PLAY0 = 0;
/** Play the card in hand slot 0, 1 or 2 face down (worth nothing). */
export const A_COVER0 = 3;
/** Ask for truco, or raise the pending bet to the next step. */
export const A_RAISE = 6;
/** Accept the pending bet, or play the mão de onze. */
export const A_ACCEPT = 7;
/** Run from the pending bet, or from the mão de onze. */
export const A_RUN = 8;
/** Signal to the partner "I have X". Six signals, see SIGNALS. */
export const A_SIGNAL0 = 9;
export const NUM_ACTIONS = 15;

export const SIGNALS = ['zap', 'copas', 'espadilha', 'picafumo', 'tres', 'nada'] as const;
export type SignalName = (typeof SIGNALS)[number];
export const SIGNAL_MASK = 0b111111 << A_SIGNAL0;
export const PLAY_MASK = 0b111;
export const COVER_MASK = 0b111 << A_COVER0;

export function actionName(a: number): string {
  if (a >= 0 && a < 3) return `play${a}`;
  if (a >= 3 && a < 6) return `cover${a - 3}`;
  if (a === A_RAISE) return 'raise';
  if (a === A_ACCEPT) return 'accept';
  if (a === A_RUN) return 'run';
  if (a >= A_SIGNAL0 && a < NUM_ACTIONS) return `signal:${SIGNALS[a - A_SIGNAL0]}`;
  return `invalid(${a})`;
}

export function parseAction(name: string): number {
  for (let a = 0; a < NUM_ACTIONS; a++) if (actionName(a) === name) return a;
  throw new Error(`bad action: ${name}`);
}

export function maskToActions(mask: number): number[] {
  const out: number[] = [];
  for (let a = 0; a < NUM_ACTIONS; a++) if (mask & (1 << a)) out.push(a);
  return out;
}

// ---------------------------------------------------------------------------------------------
// State

export type HandKind = 'normal' | 'onze' | 'iron';
/** 'onze': waiting for the team on the threshold to play or run. 'raise': a bet is waiting for an answer. */
export type HandPhase = 'onze' | 'play' | 'raise' | 'over';
export type HandEndReason = 'rounds' | 'run' | 'onzeRun' | 'tie';

/** Round result: 0 or 1 is the winning team, 2 is a tie, -1 is not finished. */
export const TIE = 2;

export interface Play {
  seat: number;
  card: number;
  faceDown: boolean;
}

export interface Round {
  leader: number;
  plays: Play[];
  result: number;
  /** First seat that played the winning card, -1 on a tie or while unfinished. */
  winnerSeat: number;
}

export interface SignalRecord {
  seat: number;
  signal: number;
  truthful: boolean;
  /** Bit mask of the seats that saw the signal. */
  seenBy: number;
}

export type BetKind = 'raise' | 'accept' | 'run' | 'onzePlay' | 'onzeRun';

/**
 * One public betting event of a hand, in order. Everyone at the table sees these, so they are
 * part of the public history of the match (public.ts).
 */
export interface BetRecord {
  seat: number;
  kind: BetKind;
  /** raise: step proposed (1 to 4). accept: step accepted. run: step that was proposed and refused. onze: 0. */
  step: number;
  /** True for an answer to a pending raise (accept, run, or raise again). */
  answer: boolean;
  /** Round (0 to 2) and number of cards already on the table in that round when it happened. */
  round: number;
  played: number;
}

export interface HandResult {
  /** Winning team, or -1 when nobody scores. */
  winner: number;
  points: number;
  reason: HandEndReason;
}

export interface HandState {
  index: number;
  seed: string;
  dealer: number;
  /** First player of the hand, to the right of the dealer. */
  mao: number;
  /** Paulista: the turned card. Mineiro: -1. */
  vira: number;
  /** Paulista: the manilha rank for this hand. Mineiro: -1. */
  manilhaRank: number;
  strength: number[];
  dealt: number[][];
  /** Cards still in hand per seat, by slot; -1 once played. */
  cards: number[][];
  kind: HandKind;
  /** Team on the threshold in a mão de onze or de dez, otherwise -1. */
  onzeTeam: number;
  phase: HandPhase;
  /** Accepted step on the ladder (0 = starting value). */
  step: number;
  /** Current hand value. */
  value: number;
  /** Team that made the last accepted raise; the next raise must come from the other team. */
  lastRaiseTeam: number;
  /** Seat whose raise is waiting for an answer, -1 if none. The proposal is step + 1. */
  raiser: number;
  turn: number;
  round: number;
  rounds: Round[];
  signals: SignalRecord[];
  /** Public betting events of this hand, in order. */
  bets: BetRecord[];
  /** Bit masks of seats that already signaled / already played a card in this hand. */
  signaled: number;
  playedAny: number;
  rng: ChaChaStream;
  result: HandResult | null;
}

export interface HandSummary {
  index: number;
  seed: string;
  dealer: number;
  mao: number;
  vira: number;
  kind: HandKind;
  onzeTeam: number;
  dealt: number[][];
  rounds: Round[];
  signals: SignalRecord[];
  bets: BetRecord[];
  step: number;
  result: HandResult;
  scoreAfter: [number, number];
  gamesAfter: [number, number];
}

export interface MatchState {
  config: MatchConfig;
  seed: string;
  n: number;
  /** Points in the current game (queda). */
  score: [number, number];
  /** Games (quedas) won, for best of three. */
  games: [number, number];
  handIndex: number;
  dealer: number;
  hand: HandState;
  over: boolean;
  winner: number;
  /** Every action taken, packed as seat * 16 + action, in order. Replaying it rebuilds the match. */
  log: number[];
  history: HandSummary[];
}

export interface MatchInit {
  dealer?: number;
  score?: [number, number];
  games?: [number, number];
}

// ---------------------------------------------------------------------------------------------
// Events, for animations and for the Durable Object. Filter with eventsFor() before sending.

export type GameEvent =
  | { t: 'deal'; hand: number; dealer: number; mao: number; vira: number; kind: HandKind; onzeTeam: number }
  | { t: 'onze'; seat: number; play: boolean }
  | { t: 'play'; seat: number; card: number; faceDown: boolean; slot: number }
  | { t: 'raise'; seat: number; step: number; value: number }
  | { t: 'accept'; seat: number; step: number; value: number }
  | { t: 'run'; seat: number }
  | { t: 'signal'; seat: number; signal: number; seenBy: number }
  | { t: 'round'; round: number; result: number; winnerSeat: number }
  | { t: 'hand'; winner: number; points: number; reason: HandEndReason; score: [number, number] }
  | { t: 'game'; winner: number; games: [number, number] }
  | { t: 'match'; winner: number };

export class IllegalActionError extends Error {
  override name = 'IllegalActionError';
}

const DOMAIN_HAND = 0x68616e64; // "hand"
const DOMAIN_DEALER = 0x6465616c; // "deal"

export function teamOf(seat: number): number {
  return seat & 1;
}

export function partnerOf(state: MatchState, seat: number): number {
  return state.n === 4 ? (seat + 2) % 4 : -1;
}

// ---------------------------------------------------------------------------------------------
// Match lifecycle

export function newMatch(config: MatchConfig, seed: string, init: MatchInit = {}, events?: GameEvent[]): MatchState {
  validateConfig(config);
  if (!/^[0-9a-f]{64}$/.test(seed)) throw new Error('seed must be 64 lowercase hex chars');
  // The rules are fixed when the match is created: later changes to the caller's object do nothing.
  config = structuredClone(config);
  const n = config.players;
  validateInit(config, init);
  const dealer = init.dealer ?? randInt(createStream(deriveSeed(seed, DOMAIN_DEALER, 0)), n);
  const s: MatchState = {
    config,
    seed,
    n,
    score: init.score ? [init.score[0], init.score[1]] : [0, 0],
    games: init.games ? [init.games[0], init.games[1]] : [0, 0],
    handIndex: 0,
    dealer,
    hand: undefined as unknown as HandState,
    over: false,
    winner: -1,
    log: [],
    history: [],
  };
  s.hand = dealHand(s, events);
  return s;
}

function validateInit(config: MatchConfig, init: MatchInit): void {
  const n = config.players;
  const need = config.options.bestOf === 3 ? 2 : 1;
  const intIn = (x: unknown, lo: number, hi: number) => Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi;
  if (init.dealer !== undefined && !intIn(init.dealer, 0, n - 1)) throw new Error('init.dealer must be a seat');
  if (init.score !== undefined && !(init.score.length === 2 && init.score.every((x) => intIn(x, 0, TARGET_POINTS - 1)))) {
    throw new Error('init.score must be two integers from 0 to 11');
  }
  if (init.games !== undefined && !(init.games.length === 2 && init.games.every((x) => intIn(x, 0, need - 1)))) {
    throw new Error('init.games must not decide the match already');
  }
}

function dealHand(s: MatchState, events?: GameEvent[]): HandState {
  const c = s.config;
  const n = s.n;
  const seed = deriveSeed(s.seed, DOMAIN_HAND, s.handIndex);
  const rng = createStream(seed);
  const deck = shuffledRange(rng, DECK_SIZE);
  const mao = (s.dealer + 1) % n;
  const cards: number[][] = [];
  for (let i = 0; i < n; i++) cards.push([0, 0, 0]);
  for (let i = 0; i < n; i++) {
    const seat = (mao + i) % n;
    cards[seat] = [deck[3 * i], deck[3 * i + 1], deck[3 * i + 2]];
  }
  const vira = c.variant === 'paulista' ? deck[3 * n] : -1;
  const manilhaRank = c.variant === 'paulista' ? manilhaRankForVira(vira) : -1;

  const thr = onzeThreshold(c);
  const a = s.score[0] >= thr;
  const b = s.score[1] >= thr;
  let kind: HandKind = 'normal';
  let onzeTeam = -1;
  if (a && b) kind = c.options.ironHand === 'blind' ? 'iron' : 'normal';
  else if (a || b) {
    kind = 'onze';
    onzeTeam = a ? 0 : 1;
  }
  const ladder = ladderOf(c);
  const h: HandState = {
    index: s.handIndex,
    seed,
    dealer: s.dealer,
    mao,
    vira,
    manilhaRank,
    strength: strengthTable(c.variant, manilhaRank),
    dealt: cards.map((x) => x.slice()),
    cards,
    kind,
    onzeTeam,
    phase: kind === 'onze' ? 'onze' : 'play',
    step: 0,
    value: kind === 'onze' ? onzeValue(c) : ladder[0],
    lastRaiseTeam: -1,
    raiser: -1,
    turn: mao,
    round: 0,
    rounds: [{ leader: mao, plays: [], result: -1, winnerSeat: -1 }],
    signals: [],
    bets: [],
    signaled: 0,
    playedAny: 0,
    rng,
    result: null,
  };
  events?.push({ t: 'deal', hand: h.index, dealer: h.dealer, mao, vira, kind, onzeTeam });
  return h;
}

/**
 * Replaces the cards of the current hand before anyone acts. For tests and for analysis
 * (for example, the chance of winning a hand with given cards). Never used in real games.
 */
export function setHandCards(s: MatchState, cards: number[][], vira = -1): void {
  const h = s.hand;
  const fresh =
    h.playedAny === 0 && h.signaled === 0 && h.step === 0 && h.raiser === -1 && h.bets.length === 0 && h.phase === (h.kind === 'onze' ? 'onze' : 'play');
  if (!fresh) {
    throw new Error('setHandCards: the hand already started');
  }
  if (cards.length !== s.n || cards.some((x) => x.length !== 3)) throw new Error('setHandCards: need 3 cards per seat');
  const all = cards.flat();
  if (s.config.variant === 'paulista') {
    if (vira < 0) throw new Error('setHandCards: paulista needs a vira');
    all.push(vira);
  } else if (vira !== -1) {
    throw new Error('setHandCards: mineiro has no vira');
  }
  if (!all.every((x) => Number.isInteger(x))) throw new Error('setHandCards: cards must be integers');
  if (new Set(all).size !== all.length || all.some((x) => x < 0 || x >= DECK_SIZE)) throw new Error('setHandCards: repeated or invalid card');
  h.cards = cards.map((x) => x.slice());
  h.dealt = cards.map((x) => x.slice());
  if (s.config.variant === 'paulista') {
    h.vira = vira;
    h.manilhaRank = manilhaRankForVira(vira);
  }
  h.strength = strengthTable(s.config.variant, h.manilhaRank);
}

// ---------------------------------------------------------------------------------------------
// Legal actions

/** Bit mask of the actions this seat may take now (bit a set means action a is legal). */
export function legalMask(s: MatchState, seat: number): number {
  if (s.over || !Number.isInteger(seat) || seat < 0 || seat >= s.n) return 0;
  const h = s.hand;
  const team = seat & 1;
  if (h.phase === 'onze') {
    return team === h.onzeTeam ? (1 << A_ACCEPT) | (1 << A_RUN) : 0;
  }
  if (h.phase === 'raise') {
    if (team === (h.raiser & 1)) return 0;
    let m = (1 << A_ACCEPT) | (1 << A_RUN);
    if (h.step + 2 <= MAX_STEP) m |= 1 << A_RAISE;
    return m;
  }
  // phase 'play'
  const o = s.config.options;
  let m = 0;
  if (seat === h.turn) {
    const cards = h.cards[seat];
    const coverOk = h.kind !== 'iron' && (h.round > 0 || (o.faceDownFirstRound && seat !== h.mao));
    for (let i = 0; i < 3; i++) {
      if (cards[i] >= 0) {
        m |= 1 << i;
        if (coverOk) m |= 1 << (A_COVER0 + i);
      }
    }
  }
  if (h.kind === 'normal' && h.step < MAX_STEP && team !== h.lastRaiseTeam && (seat === h.turn || o.raiseAnyTime)) {
    m |= 1 << A_RAISE;
  }
  if (s.n === 4 && h.kind !== 'iron' && ((h.signaled | h.playedAny) & (1 << seat)) === 0) {
    m |= SIGNAL_MASK;
  }
  return m;
}

export function legalActions(s: MatchState, seat: number): number[] {
  return maskToActions(legalMask(s, seat));
}

export function isLegal(s: MatchState, seat: number, action: number): boolean {
  return Number.isInteger(action) && action >= 0 && action < NUM_ACTIONS && (legalMask(s, seat) & (1 << action)) !== 0;
}

/**
 * The seat expected to act next. Other seats may also have legal actions (the partner can
 * answer a bet, anyone can signal before their first card, raises with raiseAnyTime), but
 * the game never waits for them: this seat's action moves the game forward.
 */
export function expectedActor(s: MatchState): number {
  if (s.over) return -1;
  const h = s.hand;
  if (h.phase === 'onze') return (h.mao & 1) === h.onzeTeam ? h.mao : (h.mao + 1) % s.n;
  if (h.phase === 'raise') return (h.raiser + 1) % s.n;
  return h.turn;
}

/** Seats that have at least one legal action now. */
export function actingSeats(s: MatchState): number[] {
  const out: number[] = [];
  for (let seat = 0; seat < s.n; seat++) if (legalMask(s, seat) !== 0) out.push(seat);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Applying actions

/** Applies an action. Throws IllegalActionError and leaves the state untouched if it is not legal. */
export function applyAction(s: MatchState, seat: number, action: number, events?: GameEvent[]): void {
  if (!isLegal(s, seat, action)) {
    throw new IllegalActionError(`illegal action ${actionName(action)} by seat ${seat}`);
  }
  s.log.push(seat * 16 + action);
  const h = s.hand;
  if (h.phase === 'onze') {
    if (action === A_ACCEPT) {
      recordBet(h, seat, 'onzePlay', 0, false);
      h.phase = 'play';
      events?.push({ t: 'onze', seat, play: true });
    } else {
      recordBet(h, seat, 'onzeRun', 0, false);
      events?.push({ t: 'onze', seat, play: false });
      finishHand(s, 1 - h.onzeTeam, onzeRunPoints(s.config), 'onzeRun', events);
    }
    return;
  }
  if (h.phase === 'raise') {
    const ladder = ladderOf(s.config);
    if (action === A_ACCEPT) {
      recordBet(h, seat, 'accept', h.step + 1, true);
      h.step += 1;
      h.value = ladder[h.step];
      h.lastRaiseTeam = h.raiser & 1;
      h.raiser = -1;
      h.phase = 'play';
      events?.push({ t: 'accept', seat, step: h.step, value: h.value });
    } else if (action === A_RUN) {
      recordBet(h, seat, 'run', h.step + 1, true);
      const winner = h.raiser & 1;
      events?.push({ t: 'run', seat });
      finishHand(s, winner, h.value, 'run', events);
    } else {
      // A raise in answer to a raise accepts the pending step and proposes the next one.
      recordBet(h, seat, 'raise', h.step + 2, true);
      h.step += 1;
      h.value = ladder[h.step];
      h.lastRaiseTeam = h.raiser & 1;
      h.raiser = seat;
      events?.push({ t: 'raise', seat, step: h.step + 1, value: ladder[h.step + 1] });
    }
    return;
  }
  // phase 'play'
  if (action < A_RAISE) {
    playCard(s, seat, action % 3, action >= A_COVER0, events);
  } else if (action === A_RAISE) {
    recordBet(h, seat, 'raise', h.step + 1, false);
    h.raiser = seat;
    h.phase = 'raise';
    events?.push({ t: 'raise', seat, step: h.step + 1, value: ladderOf(s.config)[h.step + 1] });
  } else {
    signal(s, seat, action - A_SIGNAL0, events);
  }
}

function recordBet(h: HandState, seat: number, kind: BetKind, step: number, answer: boolean): void {
  h.bets.push({ seat, kind, step, answer, round: h.round, played: h.rounds[h.round].plays.length });
}

function playCard(s: MatchState, seat: number, slot: number, faceDown: boolean, events?: GameEvent[]): void {
  const h = s.hand;
  const card = h.cards[seat][slot];
  h.cards[seat][slot] = -1;
  h.playedAny |= 1 << seat;
  const round = h.rounds[h.round];
  round.plays.push({ seat, card, faceDown });
  events?.push({ t: 'play', seat, card, faceDown, slot });
  if (round.plays.length < s.n) {
    h.turn = (seat + 1) % s.n;
    return;
  }
  // Round complete: the strongest card wins; equal strength across teams is a tie.
  let best = -2;
  let teams = 0;
  let winnerSeat = -1;
  for (const p of round.plays) {
    const st = p.faceDown ? FACE_DOWN_STRENGTH : h.strength[p.card];
    if (st > best) {
      best = st;
      teams = 1 << (p.seat & 1);
      winnerSeat = p.seat;
    } else if (st === best) {
      teams |= 1 << (p.seat & 1);
    }
  }
  round.result = teams === 3 ? TIE : teams === 1 ? 0 : 1;
  round.winnerSeat = round.result === TIE ? -1 : winnerSeat;
  events?.push({ t: 'round', round: h.round, result: round.result, winnerSeat: round.winnerSeat });

  const winner = handWinner(h.rounds);
  if (winner === -2) {
    const leader = round.result === TIE ? round.leader : round.winnerSeat;
    h.round += 1;
    h.rounds.push({ leader, plays: [], result: -1, winnerSeat: -1 });
    h.turn = leader;
    return;
  }
  if (winner >= 0) {
    finishHand(s, winner, h.value, 'rounds', events);
    return;
  }
  // All three rounds tied.
  const o = s.config.options;
  if (h.kind === 'onze' && o.onzeTieToOpponents) finishHand(s, 1 - h.onzeTeam, h.value, 'tie', events);
  else if (o.allTieToMao) finishHand(s, h.mao & 1, h.value, 'tie', events);
  else finishHand(s, -1, 0, 'tie', events);
}

/**
 * Hand winner from the round results so far: a team (0 or 1), -1 when all three rounds tied,
 * or -2 when the hand goes on.
 *  First round tied: the second decides; first and second tied: the third decides.
 *  Second or third tied: the winner of the first takes the hand.
 */
export function handWinner(rounds: readonly Round[]): number {
  const results = rounds.filter((r) => r.result >= 0).map((r) => r.result);
  if (results.length < 2) return -2;
  const [r0, r1] = results;
  // Decided after two rounds: the third round, even if given, cannot change it.
  if (r0 === TIE && r1 !== TIE) return r1;
  if (r0 !== TIE && (r1 === TIE || r1 === r0)) return r0;
  if (results.length < 3) return -2;
  const r2 = results[2];
  if (r0 === TIE) return r2 === TIE ? -1 : r2; // first and second tied: the third decides
  return r2 === TIE ? r0 : r2; // one round each: the third decides, a tie goes to the first round's winner
}

function signal(s: MatchState, seat: number, sig: number, events?: GameEvent[]): void {
  const h = s.hand;
  const truthful = signalIsTruthful(h, seat, sig);
  let seenBy = (1 << seat) | (1 << ((seat + 2) % 4));
  const mode = s.config.options.signals;
  for (const opp of [(seat + 1) % 4, (seat + 3) % 4]) {
    if (mode === 'all' || (mode === 'p25' && randInt(h.rng, 4) === 0)) seenBy |= 1 << opp;
  }
  h.signals.push({ seat, signal: sig, truthful, seenBy });
  h.signaled |= 1 << seat;
  events?.push({ t: 'signal', seat, signal: sig, seenBy });
}

/**
 * Whether "I have X" is true for the cards the seat was dealt.
 *  zap, copas, espadilha, picafumo: the manilha of clubs, hearts, spades, diamonds
 *  (mineiro: 4 of clubs, 7 of hearts, ace of spades, 7 of diamonds).
 *  tres: a 3 that is not a manilha. nada: no manilha and no 3.
 */
export function signalIsTruthful(h: HandState, seat: number, sig: number): boolean {
  const cards = h.dealt[seat];
  // Manilha strengths are 10 (pica-fumo) to 13 (zap) in both variants.
  if (sig <= 3) return cards.some((c) => h.strength[c] === 13 - sig);
  const hasThree = cards.some((c) => rankOf(c) === RANK_3 && h.strength[c] < 10);
  if (sig === 4) return hasThree;
  return !hasThree && !cards.some((c) => h.strength[c] >= 10);
}

function finishHand(s: MatchState, winner: number, points: number, reason: HandEndReason, events?: GameEvent[]): void {
  const h = s.hand;
  h.result = { winner, points, reason };
  h.raiser = -1;
  h.phase = 'over';
  if (winner >= 0) s.score[winner] += points;
  events?.push({ t: 'hand', winner, points, reason, score: [s.score[0], s.score[1]] });
  let gameWon = false;
  if (winner >= 0 && s.score[winner] >= TARGET_POINTS) {
    s.games[winner] += 1;
    gameWon = true;
    events?.push({ t: 'game', winner, games: [s.games[0], s.games[1]] });
    const need = s.config.options.bestOf === 3 ? 2 : 1;
    if (s.games[winner] >= need) {
      s.over = true;
      s.winner = winner;
      events?.push({ t: 'match', winner });
    }
  }
  s.history.push({
    index: h.index,
    seed: h.seed,
    dealer: h.dealer,
    mao: h.mao,
    vira: h.vira,
    kind: h.kind,
    onzeTeam: h.onzeTeam,
    dealt: h.dealt,
    rounds: h.rounds,
    signals: h.signals,
    bets: h.bets,
    step: h.step,
    result: h.result,
    scoreAfter: [s.score[0], s.score[1]],
    gamesAfter: [s.games[0], s.games[1]],
  });
  if (s.over) return;
  if (gameWon) s.score = [0, 0];
  s.handIndex += 1;
  s.dealer = (s.dealer + 1) % s.n;
  s.hand = dealHand(s, events);
}

// ---------------------------------------------------------------------------------------------
// Replay and cloning

/** Rebuilds a match from its configuration, seed, initial state (if any) and action log. */
export function replay(config: MatchConfig, seed: string, log: readonly number[], init: MatchInit = {}): MatchState {
  const s = newMatch(config, seed, init);
  for (const packed of log) applyAction(s, packed >> 4, packed & 15);
  return s;
}

export function cloneMatch(s: MatchState): MatchState {
  return structuredClone(s);
}
