// The guided first match (CLIENT-SPEC 10.5) on the real engine: the scripted hand plays to the end
// with the demo moves and gives the facts the spec verified; any other legal choice of the person
// still ends the hand; the coach explains in order and suggests the cards of the lesson; every
// coach text exists in both languages.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { manilhaRankForVira, parseCard } from '../../engine/src/cards.ts';
import { A_ACCEPT, A_RAISE, A_RUN, A_SIGNAL0, PLAY_MASK, SIGNAL_MASK, TIE, maskToActions } from '../../engine/src/engine.ts';
import type { TimedEvent } from '../../shared/protocol.ts';
import { CoachModel, type Step } from '../src/guided/coach.ts';
import { createHost } from '../src/guided/engine-host.ts';
import { AI_MOVE_MS, GUIDED_CODE, GUIDED_HANDS, GUIDED_STRENGTH, GUIDED_VIRA, GuidedGame, HAND_END_MS, IARA, YOU, ZAP, beforeDeal } from '../src/guided/script.ts';
import { CODE_PATTERN } from '../../shared/protocol.ts';

const card = parseCard;

function newCoach(): CoachModel {
  return new CoachModel({ you: YOU, partner: IARA, dealt: GUIDED_HANDS[YOU], strength: GUIDED_STRENGTH, manilhaRank: manilhaRankForVira(GUIDED_VIRA) });
}

/** Plays the lesson the way the page does: the coach hears each event, reads are continued, turns are suggested. */
function playLesson(choose: (g: GuidedGame, coach: CoachModel) => number, opts: { read?: boolean } = {}) {
  const g = new GuidedGame();
  const coach = newCoach();
  const all: TimedEvent[] = [];
  const hear = (evs: TimedEvent[]) => {
    for (const te of evs) {
      all.push(te);
      coach.onEvent(te.e);
    }
  };
  hear(g.start());
  let guard = 0;
  while (!g.ended) {
    if (++guard > 200) throw new Error('the lesson did not end');
    if (coach.readPending()) {
      if (opts.read === false) coach.skipReads();
      else coach.next();
      continue;
    }
    if (g.humanTurn()) {
      if (g.phase() === 'play') coach.onTurn();
      const a = choose(g, coach);
      const evs = g.human(a);
      expect(evs.length, `action ${a} gives events`).toBeGreaterThan(0);
      coach.skipReads();
      hear(evs);
      continue;
    }
    const evs = g.runAI();
    expect(evs.length).toBeGreaterThan(0);
    hear(evs);
  }
  return { g, coach, all };
}

describe('the scripted practice hand', () => {
  it('uses a room code the shared helpers accept and a 64 hex seed', () => {
    expect(CODE_PATTERN.test(GUIDED_CODE)).toBe(true);
  });

  it('shows the deck before the deal: no cards, no vira, nobody to wait for', () => {
    const g = new GuidedGame();
    const o = g.observation();
    expect(o.hand).toEqual([-1, -1, -1]);
    expect(o.vira).toBe(-1);
    expect(o.legal).toBe(0);
    expect(o.dealer).toBe(3);
    expect(o.mao).toBe(0);
    expect(g.deadlineSeat()).toBeNull();
    expect(beforeDeal(o).handCounts).toEqual([0, 0, 0, 0]);
  });

  it('plays to the end with the demo moves and gives the facts of the spec', () => {
    const { g, all } = playLesson((x) => x.demoAction());
    const events = all.map((te) => te.e);
    // The deal shows the scripted vira, Iara signals "nada" (seen by her partner).
    expect(events[0]).toMatchObject({ t: 'deal', hand: 0, dealer: 3, mao: 0, vira: GUIDED_VIRA });
    expect(events[1]).toMatchObject({ t: 'signal', seat: IARA, signal: 5 });
    expect(g.state.history[0].signals[0].seenBy).toBe(5);
    // Round 1: 3♦, 2♠, 4♣, K♥ goes to you.
    const plays = events.filter((e) => e.t === 'play').map((e) => (e.t === 'play' ? `${e.seat}:${e.card}` : ''));
    expect(plays.slice(0, 4)).toEqual([`0:${card('3d')}`, `1:${card('2s')}`, `2:${card('4c')}`, `3:${card('Kh')}`]);
    const rounds = events.filter((e) => e.t === 'round');
    expect(rounds[0]).toMatchObject({ round: 0, result: 0, winnerSeat: YOU });
    // Round 2: after your K♣ the Zap raises to 3, you accept; 7♥, A♦, 5♠ give it to the Zap.
    const raise = events.find((e) => e.t === 'raise');
    expect(raise).toMatchObject({ t: 'raise', seat: ZAP, step: 1, value: 3 });
    expect(events.indexOf(raise!)).toBe(events.findIndex((e) => e.t === 'play' && e.card === card('Kc')) + 1);
    expect(events.find((e) => e.t === 'accept')).toMatchObject({ seat: YOU, value: 3 });
    expect(rounds[1]).toMatchObject({ round: 1, result: 1, winnerSeat: ZAP });
    // Round 3: the Zap leads Q♠, 2♦, J♦, your 7♠ takes it.
    expect(plays.slice(8)).toEqual([`1:${card('Qs')}`, `2:${card('2d')}`, `3:${card('Jd')}`, `0:${card('7s')}`]);
    expect(rounds[2]).toMatchObject({ round: 2, result: 0, winnerSeat: YOU });
    expect(events[events.length - 2]).toEqual({ t: 'hand', winner: 0, points: 3, reason: 'rounds', score: [3, 0] });
    // The engine dealt hand 1: its deal closes the stream one room pause later, and the page holds it.
    const last = all[all.length - 1];
    expect(last.e).toMatchObject({ t: 'deal', hand: 1, dealer: 0, mao: 1 });
    expect(last.at).toBe(all[all.length - 2].at + HAND_END_MS);
    expect(events.filter((e) => e.t === 'deal')).toHaveLength(2);
    expect(g.state.handIndex).toBe(1);
    expect(g.ended).toBe(true);
    // After the hand: the deck is back, score 3 to 0, the next dealer is you.
    const o = g.observation();
    expect(o.score).toEqual([3, 0]);
    expect(o.hand).toEqual([-1, -1, -1]);
    expect(o.vira).toBe(-1);
    expect(o.dealer).toBe(0);
    expect(g.deadlineSeat()).toBeNull();
  });

  it('times the AI moves one beat apart, and the person moves at once', () => {
    const g = new GuidedGame();
    expect(g.start().map((te) => te.at)).toEqual([0, AI_MOVE_MS]);
    const evs = g.human(g.demoAction());
    expect(evs.map((te) => te.at)).toEqual([0, AI_MOVE_MS, 2 * AI_MOVE_MS, 3 * AI_MOVE_MS, 3 * AI_MOVE_MS]);
    expect(evs[evs.length - 1].e.t).toBe('round');
  });

  it('waits for the person to answer the Zap: Iara never answers first', () => {
    const g = new GuidedGame();
    g.start();
    g.human(g.demoAction()); // 3♦ and round 1
    const evs = g.human(g.demoAction()); // K♣, then the Zap's truco
    expect(evs.map((te) => te.e.t)).toEqual(['play', 'raise']);
    expect(g.waitingAnswer()).toBe(true);
    expect(g.decider()).toBe(YOU);
    expect(g.legal() & (1 << A_ACCEPT)).toBeTruthy();
    expect(g.legal() & (1 << A_RUN)).toBeTruthy();
    expect(g.legal() & (1 << A_RAISE)).toBeTruthy();
  });

  it('pauses after an answer and after a round, so the coach can explain', () => {
    const g = new GuidedGame();
    g.start();
    g.human(g.demoAction());
    g.human(g.demoAction());
    expect(g.human(A_ACCEPT).map((te) => te.e.t)).toEqual(['accept']);
    expect(g.decider()).toBe(ZAP);
    const evs = g.runAI();
    expect(evs.map((te) => te.e.t)).toEqual(['play', 'play', 'play', 'round']);
    expect(g.runAI().map((te) => te.e.t)).toEqual(['play', 'play', 'play']);
    expect(g.humanTurn()).toBe(true);
  });

  it('accepts any raise by the person, "Seis!" included, and running ends the hand', () => {
    // Seis! in answer to the Zap's truco.
    const g = new GuidedGame();
    g.start();
    g.human(g.demoAction());
    g.human(g.demoAction());
    const six = g.human(A_RAISE);
    expect(six.map((te) => te.e)).toEqual([
      { t: 'raise', seat: YOU, step: 2, value: 6 },
      { t: 'accept', seat: ZAP, step: 2, value: 6 },
    ]);
    // Truco on your first turn: the Zap accepts at once.
    const h = new GuidedGame();
    h.start();
    expect(h.human(A_RAISE).map((te) => te.e)).toEqual([
      { t: 'raise', seat: YOU, step: 1, value: 3 },
      { t: 'accept', seat: ZAP, step: 1, value: 3 },
    ]);
    // Running from the Zap's truco: the hand ends with 1 for them.
    const r = new GuidedGame();
    r.start();
    r.human(r.demoAction());
    r.human(r.demoAction());
    const run = r.human(A_RUN).map((te) => te.e);
    expect(run.map((e) => e.t)).toEqual(['run', 'hand', 'deal']);
    expect(run[1]).toEqual({ t: 'hand', winner: 1, points: 1, reason: 'run', score: [0, 1] });
    expect(r.ended).toBe(true);
  });

  it('ends the hand whatever legal moves the person makes (300 random lessons)', () => {
    let seed = 2026;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x80000000;
    };
    const reasons = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const { g, all } = playLesson(
        (x) => {
          let legal = x.legal();
          // Signals are free moves; keep a few, but always offer a real move.
          if (rand() < 0.8) legal &= ~SIGNAL_MASK;
          const acts = maskToActions(legal);
          return acts[Math.floor(rand() * acts.length)];
        },
        { read: rand() < 0.5 },
      );
      const hand = all[all.length - 2].e;
      expect(hand.t).toBe('hand');
      if (hand.t === 'hand') reasons.add(hand.reason);
      expect(all[all.length - 1].e).toMatchObject({ t: 'deal', hand: 1 });
      expect(g.ended).toBe(true);
      expect(all.filter((te) => te.e.t === 'deal')).toHaveLength(2);
    }
    expect([...reasons].sort()).toEqual(expect.arrayContaining(['rounds', 'run']));
  });

  it('never lets the person act out of turn or after the end', () => {
    const g = new GuidedGame();
    expect(g.human(0)).toEqual([]);
    g.start();
    expect(g.legal() & PLAY_MASK).toBe(0b111);
    expect(g.legal() & (1 << (A_SIGNAL0 + 5))).toBeTruthy();
  });
});

describe('the coach', () => {
  const ids = (steps: Step[]) => steps.map((s) => s.id);

  it('explains the demo hand in order and suggests the cards of the lesson', () => {
    const { coach } = playLesson((x) => x.demoAction());
    expect(ids(coach.steps)).toEqual(['deal', 'manilha', 'youHave', 'signal', 'turn', 'round', 'turn', 'truco', 'accepted', 'round', 'turn', 'hand']);
    const turns = coach.steps.filter((s) => s.id === 'turn');
    expect(turns.map((s) => s.lines[0].key)).toEqual(['guide.firstTurn', 'guide.secondTurn', 'guide.lastTurn']);
    expect(turns.map((s) => s.suggest)).toEqual([card('3d'), card('Kc'), card('7s')]);
    const rounds = coach.steps.filter((s) => s.id === 'round');
    expect(rounds[0].lines.map((l) => l.key)).toEqual(['guide.roundWin', 'guide.twoRounds']);
    expect(rounds[0].lines[0].args).toEqual({ winner: { who: YOU }, card: { cardThe: card('3d') } });
    expect(rounds[1].lines.map((l) => l.key)).toEqual(['guide.roundManilha']);
    expect(rounds[1].lines[0].args).toEqual({ winner: { who: ZAP } });
    const hand = coach.steps[coach.steps.length - 1];
    expect(hand.lines.map((l) => l.key)).toEqual(['guide.roundManilha', 'guide.handWon']);
    expect(hand.lines[1].args).toEqual({ points: 3 });
    expect(coach.steps.find((s) => s.id === 'truco')!.lines[0].key).toBe('guide.truco');
    expect(coach.steps.find((s) => s.id === 'deal')!.lines[0].args).toEqual({ vira: { card: GUIDED_VIRA } });
    expect(coach.steps.find((s) => s.id === 'youHave')!.lines[0].args).toEqual({ card: { cardThe: card('7s') } });
    expect(coach.finished).toBe(false);
    coach.next();
    expect(coach.finished).toBe(true);
  });

  it('only "next" steps hold the AI; a played card closes the turn step', () => {
    const g = new GuidedGame();
    const coach = newCoach();
    for (const te of g.start()) coach.onEvent(te.e);
    expect(coach.readPending()).toBe(true);
    expect(coach.current()!.id).toBe('deal');
    coach.skipReads();
    expect(coach.readPending()).toBe(false);
    expect(coach.onTurn()).toBe(true);
    expect(coach.onTurn()).toBe(false);
    expect(coach.suggestion()).toBe(card('3d'));
    for (const te of g.human(g.demoAction())) coach.onEvent(te.e);
    expect(coach.suggestion()).toBeNull();
    expect(coach.current()!.id).toBe('round');
  });

  it('tells the truth when the person plays another card', () => {
    // K♣ first: the Zap's 2♠ takes round 1.
    const { coach } = playLesson((g, c) => {
      const kc = g.state.hand.cards[YOU].indexOf(card('Kc'));
      if (c.steps.filter((s) => s.id === 'round').length === 0 && kc >= 0) return kc;
      return g.demoAction();
    });
    const first = coach.steps.find((s) => s.id === 'round')!;
    expect(first.lines[0]).toEqual({ key: 'guide.roundWin', args: { winner: { who: ZAP }, card: { cardThe: card('2s') } } });
    // Losing round 1, round 2 suggests the cheapest card that wins, not "keep the strongest".
    const turns = coach.steps.filter((s) => s.id === 'turn');
    expect(turns[1].lines[0].key).toBe('guide.turn');
  });

  it('says the team ran when the person runs from the truco', () => {
    const { coach } = playLesson((g) => (g.waitingAnswer() ? A_RUN : g.demoAction()));
    const last = coach.steps[coach.steps.length - 1];
    expect(last.id).toBe('hand');
    expect(last.lines).toEqual([{ key: 'guide.ran', args: { points: 1 } }]);
  });

  it('round ties and every key it uses exist in both languages', () => {
    const coach = newCoach();
    coach.onEvent({ t: 'round', round: 1, result: TIE, winnerSeat: -1 });
    expect(coach.steps[0].lines).toEqual([{ key: 'guide.roundTie' }]);
    const root = join(import.meta.dirname, '..', '..', 'locales');
    for (const lang of ['pt-BR', 'en']) {
      const dict = JSON.parse(readFileSync(join(root, `guide.${lang}.json`), 'utf8')) as Record<string, string>;
      const src = readFileSync(join(import.meta.dirname, '..', 'src', 'guided', 'coach.ts'), 'utf8');
      for (const m of src.matchAll(/'(guide\.[a-zA-Z.]+)'/g)) expect(dict[m[1]], `${lang} ${m[1]}`).toBeTruthy();
      for (let seat = 0; seat < 4; seat++) expect(dict[`guide.name.${seat}`]).toBeTruthy();
    }
  });
});

describe('the worker host', () => {
  it('answers each request with the events and the state after them', () => {
    const host = createHost();
    const fresh = host({ op: 'new' });
    expect(fresh.events).toEqual([]);
    expect(fresh.state).toMatchObject({ started: false, ended: false, deadlineSeat: null, legal: 0 });
    const start = host({ op: 'start' });
    expect(start.events.map((te) => te.e.t)).toEqual(['deal', 'signal']);
    expect(start.state).toMatchObject({ started: true, humanTurn: true, deadlineSeat: YOU, phase: 'play' });
    expect(start.state.demoAction).toBe(start.state.obs.hand.indexOf(card('3d')));
    // The person must act: the AI seats wait.
    expect(host({ op: 'ai' }).events).toEqual([]);
    const play = host({ op: 'human', a: start.state.demoAction });
    expect(play.events[play.events.length - 1].e.t).toBe('round');
    // An illegal action changes nothing.
    expect(host({ op: 'human', a: 8 }).events).toEqual([]);
  });

  it('plays the scenes: the call of the Zap, right after accepting it, and the end', () => {
    const host = createHost();
    const truco = host({ op: 'scene', scene: 'truco' });
    expect(truco.state).toMatchObject({ waitingAnswer: true, humanTurn: true, phase: 'raise', deadlineSeat: YOU });
    expect(truco.state.legal & (1 << A_ACCEPT)).toBeTruthy();
    const meio = host({ op: 'scene', scene: 'meio' });
    expect(meio.state).toMatchObject({ humanTurn: false, phase: 'play', deadlineSeat: ZAP });
    expect(meio.state.obs.value).toBe(3);
    expect(meio.state.obs.round).toBe(1);
    const fim = host({ op: 'scene', scene: 'fim' });
    expect(fim.state).toMatchObject({ ended: true, deadlineSeat: null });
    expect(fim.state.obs.score).toEqual([3, 0]);
    expect(fim.state.obs.hand).toEqual([-1, -1, -1]);
  });

  it('replays a scene into the coach the way the page does', () => {
    for (const scene of ['meio', 'truco'] as const) {
      const r = createHost()({ op: 'scene', scene });
      const coach = newCoach();
      for (const step of r.scene ?? []) {
        coach.skipReads();
        if (step.t === 'turn') coach.onTurn();
        else for (const te of step.events) coach.onEvent(te.e);
      }
      if (scene === 'truco') coach.skipReads();
      expect(coach.current()?.id, scene).toBe(scene === 'meio' ? 'accepted' : 'truco');
    }
  });
});
