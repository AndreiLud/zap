// The coach of the guided first match (CLIENT-SPEC 10.5 and 22.6): what to explain, and when, from
// the events the table shows. It reads the real events, so a card other than the suggested one
// still gets a true explanation: the round winner and the reason (a manilha, or the strongest
// card) come from the hand's strength table.
//
// Steps wait in one of two ways: "next" steps wait for the reader ("Continuar"), and the AI seats
// wait with them; "act" steps wait for the person (a card to play, an answer to the Zap's call).
// No DOM and no text here: Coach.tsx turns each line into words in the current language, so the
// language switch never loses the lesson.

import { TIE, type GameEvent } from '../../../engine/src/engine.ts';
import type { Key } from '../i18n.ts';

export type GuideKey = Extract<Key, `guide.${string}`>;

/** A placeholder value, resolved by Coach.tsx in the current language. */
export type Arg =
  | number
  /** "6 de copas" */
  | { card: number }
  /** "o 3 de ouros" */
  | { cardThe: number }
  /** "You", "Zap", "Iara", "Bento" */
  | { who: number }
  /** "os setes" */
  | { plural: number }
  /** "truco", "seis"... */
  | { call: number; step: number };

export interface Line {
  key: GuideKey;
  args?: Record<string, Arg>;
}

export type StepId = 'deal' | 'manilha' | 'youHave' | 'signal' | 'turn' | 'round' | 'truco' | 'accepted' | 'hand';

export interface Step {
  id: StepId;
  lines: Line[];
  wait: 'next' | 'act';
  /** Card the coach suggests (outline and the tag "suggested" on that card). */
  suggest?: number;
  done: boolean;
}

export interface CoachSetup {
  you: number;
  partner: number;
  /** The person's three cards as dealt. */
  dealt: readonly number[];
  /** Strength of every card in this hand (engine strengthTable): 10 and above are manilhas. */
  strength: readonly number[];
  /** The rank of the manilha, for "os setes". */
  manilhaRank: number;
}

const SIGNAL_NADA = 5;

export class CoachModel {
  readonly steps: Step[] = [];
  private readonly setup: CoachSetup;
  private hand: number[];
  private round = 0;
  private plays: { seat: number; card: number; faceDown: boolean }[] = [];
  private results: number[] = [];
  private ran = false;

  constructor(setup: CoachSetup) {
    this.setup = setup;
    this.hand = setup.dealt.slice();
  }

  private team(seat: number): number {
    return seat & 1;
  }

  private push(id: StepId, lines: Line[], wait: 'next' | 'act', suggest?: number): void {
    this.steps.push({ id, lines, wait, suggest, done: false });
  }

  private finish(id: StepId): void {
    for (const s of this.steps) if (s.id === id && s.wait === 'act') s.done = true;
  }

  /** The step on screen: the first one not done. */
  current(): Step | null {
    return this.steps.find((s) => !s.done) ?? null;
  }

  /** What the card shows: the current step, else the last one (so the card never goes blank). */
  shown(): Step | null {
    return this.current() ?? this.steps[this.steps.length - 1] ?? null;
  }

  /** A step waits for "Continuar" (the AI seats wait too). */
  readPending(): boolean {
    return this.current()?.wait === 'next';
  }

  /** "Continuar". */
  next(): void {
    const c = this.current();
    if (c && c.wait === 'next') c.done = true;
  }

  /** The person acted while the coach was still explaining: the explanations are behind us. */
  skipReads(): void {
    for (const s of this.steps) if (s.wait === 'next') s.done = true;
  }

  /** The hand's result was explained and read: the lesson can close. */
  get finished(): boolean {
    const last = this.steps[this.steps.length - 1];
    return last !== undefined && last.id === 'hand' && last.done;
  }

  /** The card the coach suggests now, if any. */
  suggestion(): number | null {
    const c = this.current();
    return c && c.wait === 'act' && c.suggest !== undefined ? c.suggest : null;
  }

  /** One event, at the moment the table shows it. */
  onEvent(e: GameEvent): void {
    const { you, partner, strength } = this.setup;
    switch (e.t) {
      case 'deal': {
        if (e.hand !== 0) return;
        this.push('deal', [{ key: 'guide.deal', args: { vira: { card: e.vira } } }], 'next');
        this.push('manilha', [{ key: 'guide.manilha', args: { rankpl: { plural: this.setup.manilhaRank } } }], 'next');
        const m = this.strongest(this.hand.filter((c) => strength[c] >= 10));
        if (m !== null) this.push('youHave', [{ key: 'guide.youHave', args: { card: { cardThe: m } } }], 'next');
        return;
      }
      case 'signal':
        if (e.seat === partner && e.signal === SIGNAL_NADA) this.push('signal', [{ key: 'guide.signal' }], 'next');
        return;
      case 'play':
        this.plays.push({ seat: e.seat, card: e.card, faceDown: e.faceDown });
        if (e.seat === you) {
          this.hand = this.hand.filter((c) => c !== e.card);
          this.finish('turn');
        }
        return;
      case 'raise':
        if (this.team(e.seat) === this.team(you)) return;
        // Your team answers: the panel is the action.
        this.finish('turn');
        if (e.step <= 1) this.push('truco', [{ key: 'guide.truco' }], 'act');
        else this.push('truco', [{ key: 'guide.raise', args: { call: { call: e.value, step: e.step }, value: e.value, points: this.valueBefore(e) } }], 'act');
        return;
      case 'accept':
        this.finish('truco');
        this.push('accepted', [{ key: 'guide.accepted', args: { value: e.value } }], 'next');
        return;
      case 'run':
        this.finish('truco');
        if (this.team(e.seat) === this.team(you)) this.ran = true;
        return;
      case 'round':
        this.onRound(e.round, e.result, e.winnerSeat);
        return;
      case 'hand': {
        const mine = this.team(you);
        let line: Line;
        if (this.ran) line = { key: 'guide.ran', args: { points: e.points } };
        else if (e.winner === mine) line = { key: 'guide.handWon', args: { points: e.points } };
        else if (e.winner < 0) line = { key: 'guide.handTie' };
        else line = { key: 'guide.handLost', args: { points: e.points } };
        this.finish('turn');
        this.finish('truco');
        // The round that ended the hand and the hand's result read as one card.
        const last = this.steps[this.steps.length - 1];
        if (last && last.id === 'round' && !last.done) {
          last.id = 'hand';
          last.lines = [last.lines[0], line];
        } else {
          this.push('hand', [line], 'next');
        }
        return;
      }
      default:
        return;
    }
  }

  /** The value the caller's team takes if the person's team runs: the step below the call. */
  private valueBefore(e: Extract<GameEvent, { t: 'raise' }>): number {
    // Raises go 1, 3, 6, 9, 12 in the practice hand (paulista).
    const ladder = [1, 3, 6, 9, 12];
    return ladder[Math.max(0, e.step - 1)];
  }

  private onRound(round: number, result: number, winnerSeat: number): void {
    const { strength } = this.setup;
    this.results[round] = result;
    let line: Line;
    if (result === TIE) {
      line = { key: 'guide.roundTie' };
    } else {
      const play = this.plays.find((p) => p.seat === winnerSeat);
      const card = play ? play.card : -1;
      if (card >= 0 && strength[card] >= 10) line = { key: 'guide.roundManilha', args: { winner: { who: winnerSeat } } };
      else line = { key: 'guide.roundWin', args: { winner: { who: winnerSeat }, card: { cardThe: card } } };
    }
    const lines = [line];
    if (round === 0 && result !== TIE) lines.push({ key: 'guide.twoRounds' });
    this.push('round', lines, 'next');
    this.round = round + 1;
    this.plays = [];
  }

  /**
   * The person must play a card: suggest one. Round 1: the highest card that is not a manilha;
   * round 2: the lowest (after a round for us) or the cheapest card that wins; round 3: the manilha.
   * Returns true when a new step was added.
   */
  onTurn(): boolean {
    if (this.steps.some((s) => s.id === 'turn' && !s.done)) return false;
    if (this.hand.length === 0) return false;
    const { strength } = this.setup;
    const mine = this.team(this.setup.you);
    let key: GuideKey = 'guide.turn';
    let card: number;
    if (this.round === 0) {
      const plain = this.hand.filter((c) => strength[c] < 10);
      const best = this.strongest(plain);
      if (best !== null) {
        key = 'guide.firstTurn';
        card = best;
      } else card = this.cheapestWinner();
    } else if (this.round === 1 && this.results[0] === mine) {
      key = 'guide.secondTurn';
      card = this.weakest(this.hand)!;
    } else if (this.round === 2 && this.hand.some((c) => strength[c] >= 10)) {
      key = 'guide.lastTurn';
      card = this.strongest(this.hand.filter((c) => strength[c] >= 10))!;
    } else {
      card = this.cheapestWinner();
    }
    this.push('turn', [{ key, args: { card: { cardThe: card } } }], 'act', card);
    return true;
  }

  /** The weakest card that beats the other team's best card on the table, else the weakest card. */
  private cheapestWinner(): number {
    const { strength } = this.setup;
    const mine = this.team(this.setup.you);
    const best = (team: number) => Math.max(-1, ...this.plays.filter((p) => this.team(p.seat) === team && !p.faceDown).map((p) => strength[p.card]));
    const them = best(1 - mine);
    const us = best(mine);
    const winners = us > them ? [] : this.hand.filter((c) => strength[c] > them);
    return this.weakest(winners.length ? winners : this.hand)!;
  }

  private strongest(cards: readonly number[]): number | null {
    let out: number | null = null;
    for (const c of cards) if (out === null || this.setup.strength[c] > this.setup.strength[out]) out = c;
    return out;
  }

  private weakest(cards: readonly number[]): number | null {
    let out: number | null = null;
    for (const c of cards) if (out === null || this.setup.strength[c] < this.setup.strength[out]) out = c;
    return out;
  }
}
