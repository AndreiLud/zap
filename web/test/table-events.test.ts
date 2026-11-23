// What the table hears (CLIENT-SPEC 11.1 and 11.6): the cues of each event (sound, shout, vibration)
// and the playback that shows the events at their offsets, with the "before the deal" state between
// hands, the pause for the solo ads point, and a newer message that shows pending events at once.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCard, parseCard, RANK_4, SUIT_CLUBS } from '../../engine/src/cards.ts';
import { makeConfig } from '../../engine/src/config.ts';
import { applyAction, expectedActor, legalMask, newMatch, type GameEvent } from '../../engine/src/engine.ts';
import { observe } from '../../engine/src/observe.ts';
import type { TimedEvent } from '../../shared/protocol.ts';
import { Playback, predealFrom, tableBus, type BusItem, type GameMsg, type TableView } from '../src/table-view.ts';
import { cuesFor, panOf } from '../src/table/events.ts';
import { PREDEAL_AT } from '../src/table/timing.ts';

const ctx4 = { you: 0, players: 4, variant: 'paulista' as const, manilhaRank: 3 };

describe('cues of each event', () => {
  it('pans by seat: left -0.6, right 0.6, top and bottom 0', () => {
    expect(panOf(1, 0, 4)).toBe(0.6);
    expect(panOf(2, 0, 4)).toBe(0);
    expect(panOf(3, 0, 4)).toBe(-0.6);
    expect(panOf(0, 0, 4)).toBe(0);
    expect(panOf(1, 0, 2)).toBe(0);
  });

  it('a deal: one deal sound per card, a riffle first after the first hand', () => {
    const first = cuesFor({ t: 'deal', hand: 0, dealer: 3, mao: 0, vira: 5, kind: 'normal', onzeTeam: -1 }, ctx4);
    expect(first.sfx).toEqual([{ name: 'deal', pan: 0, count: 12, gap: 30, delay: 0 }]);
    const next = cuesFor({ t: 'deal', hand: 1, dealer: 0, mao: 1, vira: 5, kind: 'normal', onzeTeam: -1 }, { ...ctx4, players: 2 });
    expect(next.sfx.map((s) => [s.name, s.count])).toEqual([
      ['shuffle', 1],
      ['deal', 6],
    ]);
  });

  it('a card: your own sound, panned for the others; ZAP! for the zap played face up', () => {
    const zap = makeCard(3, SUIT_CLUBS);
    expect(cuesFor({ t: 'play', seat: 0, card: 12, faceDown: false, slot: 0 }, ctx4).sfx[0].name).toBe('playMine');
    const right = cuesFor({ t: 'play', seat: 1, card: zap, faceDown: false, slot: 0 }, ctx4);
    expect(right.sfx[0]).toMatchObject({ name: 'play', pan: 0.6 });
    expect(right.shout).toEqual({ name: 'zap', pan: 0.6 });
    expect(cuesFor({ t: 'play', seat: 1, card: zap, faceDown: true, slot: 0 }, ctx4).shout).toBeNull();
    const mineiro = { ...ctx4, variant: 'mineiro' as const, manilhaRank: -1 };
    expect(cuesFor({ t: 'play', seat: 3, card: parseCard('4c'), faceDown: false, slot: 0 }, mineiro).shout).toEqual({ name: 'zap', pan: -0.6 });
    expect(cuesFor({ t: 'play', seat: 3, card: parseCard('7c'), faceDown: false, slot: 0 }, mineiro).shout).toBeNull();
    expect(cuesFor({ t: 'play', seat: 3, card: makeCard(RANK_4, SUIT_CLUBS), faceDown: false, slot: 0 }, ctx4).shout).toBeNull();
  });

  it('calls shout their word; a raise against you vibrates and turns the tiles', () => {
    const call = (value: number, step: number) => cuesFor({ t: 'raise', seat: 2, step, value }, ctx4).shout?.name;
    expect([call(3, 1), call(6, 2), call(8, 3), call(9, 3), call(10, 4), call(12, 4)]).toEqual(['truco', 'seis', 'oito', 'nove', 'dez', 'doze']);
    const against = cuesFor({ t: 'raise', seat: 1, step: 1, value: 3 }, ctx4);
    expect(against.shout).toEqual({ name: 'truco', pan: 0.6 });
    expect(against.vibrate).toEqual([40, 60, 40]);
    expect(against.sfx.map((s) => s.name)).toEqual(['tiles']);
    const ours = cuesFor({ t: 'raise', seat: 2, step: 2, value: 6 }, ctx4);
    expect(ours.shout?.name).toBe('seis');
    expect(ours.vibrate).toBeNull();
  });

  it('answers: DESCE! on accept, CORRO! on a run (also from a mão de onze)', () => {
    expect(cuesFor({ t: 'accept', seat: 1, step: 1, value: 3 }, ctx4).shout?.name).toBe('desce');
    expect(cuesFor({ t: 'run', seat: 3 }, ctx4).shout).toEqual({ name: 'corro', pan: -0.6 });
    expect(cuesFor({ t: 'onze', seat: 3, play: false }, ctx4).shout?.name).toBe('corro');
    expect(cuesFor({ t: 'onze', seat: 3, play: true }, ctx4).shout).toBeNull();
  });

  it('a round gathers, a hand counts one tento per point, a won match vibrates', () => {
    expect(cuesFor({ t: 'round', round: 0, result: 0, winnerSeat: 0 }, ctx4).sfx[0].name).toBe('gather');
    expect(cuesFor({ t: 'hand', winner: 0, points: 3, reason: 'rounds', score: [3, 0] }, ctx4).sfx[0]).toMatchObject({ name: 'tento', count: 3 });
    expect(cuesFor({ t: 'hand', winner: -1, points: 0, reason: 'tie', score: [0, 0] }, ctx4).sfx).toEqual([]);
    expect(cuesFor({ t: 'match', winner: 0 }, ctx4).vibrate).toEqual([30, 50, 30, 50, 80]);
    expect(cuesFor({ t: 'match', winner: 1 }, ctx4).vibrate).toBeNull();
    expect(cuesFor({ t: 'signal', seat: 2, signal: 0, seenBy: 5 }, ctx4)).toEqual({ sfx: [], shout: null, vibrate: null });
  });
});

// -------------------------------------------------------------------------------------------------
// Playback

/** A 1 against 1 match from the engine, played with the first legal card, as the server would send it. */
function messages(): GameMsg[] {
  const events: GameEvent[] = [];
  const s = newMatch(makeConfig('paulista', 2), 'b'.repeat(64), { dealer: 1 }, events);
  let seq = 1;
  const msg = (evs: TimedEvent[]): GameMsg => ({ t: 'game', now: 0, seq: seq++, matchNo: 1, obs: observe(s, 0), events: evs, deadline: { seat: expectedActor(s), at: null } });
  const out: GameMsg[] = [msg(events.map((e) => ({ at: 0, e })))];
  // Then one message per move of seat 0 with everything that follows until seat 0 moves again.
  while (!s.over && s.handIndex < 1) {
    const evs: TimedEvent[] = [];
    let offset = 0;
    const hand = s.handIndex;
    do {
      const seat = expectedActor(s);
      const legal = legalMask(s, seat);
      const a = [0, 1, 2].find((x) => legal & (1 << x)) ?? [7, 8].find((x) => legal & (1 << x))!;
      if (seat !== 0) offset += 700;
      const got: GameEvent[] = [];
      applyAction(s, seat, a, got);
      for (const e of got) {
        if (e.t === 'deal' && e.hand !== hand) offset += 1600;
        evs.push({ at: offset, e });
      }
    } while (!s.over && expectedActor(s) !== 0 && s.handIndex === hand);
    out.push(msg(evs));
  }
  return out;
}

describe('playback', () => {
  let bus: BusItem[] = [];
  let off: () => void = () => {};
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    bus = [];
    off = tableBus.on((b) => bus.push(b));
  });
  afterEach(() => {
    off();
    vi.useRealTimers();
  });

  function run(opts = {}) {
    const views: { v: TableView; playing: boolean }[] = [];
    const pb = new Playback({ view: (v, playing) => views.push({ v, playing }), event: () => {} }, opts);
    return { pb, views };
  }

  it('the first message of a match shows its deal from the table before the deal', () => {
    const [first] = messages();
    const { pb, views } = run();
    pb.push(first);
    expect(bus[0]).toMatchObject({ kind: 'event', instant: false, e: { t: 'deal', hand: 0 } });
    expect(views.at(-1)!.v.dealt).toBe(true);
    expect(views.at(-1)!.v.hand.filter((c) => c >= 0)).toHaveLength(3);
  });

  it('a first message without the deal (the AI opened before the page connected) still shows the deal', () => {
    const s = newMatch(makeConfig('paulista', 2), 'c'.repeat(64), { dealer: 0 });
    expect(expectedActor(s)).toBe(1);
    const got: GameEvent[] = [];
    applyAction(s, 1, [0, 1, 2].find((x) => legalMask(s, 1) & (1 << x))!, got);
    const msg: GameMsg = { t: 'game', now: 0, seq: 2, matchNo: 1, obs: observe(s, 0), events: got.map((e) => ({ at: 700, e })), deadline: { seat: 0, at: null } };
    const { pb, views } = run();
    pb.push(msg);
    expect(bus[0]).toMatchObject({ kind: 'event', instant: false, e: { t: 'deal', hand: 0, mao: 1, vira: s.hand.vira } });
    expect(views[0].v.dealt).toBe(true);
    expect(views[0].v.rounds[0].plays).toHaveLength(0);
    expect(views[0].v.hand.filter((c) => c >= 0)).toHaveLength(3);
    vi.advanceTimersByTime(700);
    expect(bus.map((b) => (b.kind === 'event' ? b.e.t : b.kind))).toEqual(['deal', 'play']);
    expect(views.at(-1)!.playing).toBe(false);
    expect(views.at(-1)!.v.rounds[0].plays).toHaveLength(1);
    // A page opened after a card it did not see the deal of: drawn in place, as before.
    const later = new Playback({ view: () => {}, event: () => {} });
    bus = [];
    later.push({ ...msg, events: [] });
    later.stop();
    const again = new Playback({ view: () => {}, event: () => {} });
    bus = [];
    again.push({ ...msg, events: [{ at: 700, e: { t: 'signal', seat: 1, signal: 0, seenBy: 2 } }] });
    expect(bus[0]).toMatchObject({ kind: 'snapshot' });
  });

  it('a message with no events is a snapshot drawn in place', () => {
    const [first] = messages();
    const { pb, views } = run();
    pb.push({ ...first, events: [] });
    expect(bus).toEqual([{ kind: 'snapshot', msg: expect.anything() }]);
    expect(views[0].playing).toBe(false);
  });

  it('between hands it shows the next hand before the deal, then the deal', () => {
    const msgs = messages();
    const { pb, views } = run();
    pb.push(msgs[0]);
    const last = msgs.at(-1)!;
    for (const m of msgs.slice(1, -1)) {
      pb.push(m);
      vi.advanceTimersByTime(10_000);
    }
    bus = [];
    pb.push(last);
    const handAt = last.events.find((x) => x.e.t === 'hand')!.at;
    const dealAt = last.events.find((x) => x.e.t === 'deal')!.at;
    expect(dealAt - handAt).toBe(1600);
    vi.advanceTimersByTime(handAt + PREDEAL_AT - 1);
    expect(views.at(-1)!.v.dealt).toBe(true);
    expect(views.at(-1)!.v.handResult).not.toBeNull();
    expect(views.at(-1)!.v.history).toHaveLength(1);
    vi.advanceTimersByTime(2);
    const pre = views.at(-1)!.v;
    expect(pre.dealt).toBe(false);
    expect(pre.handIndex).toBe(1);
    expect(pre.vira).toBe(-1);
    expect(pre.hand).toEqual([-1, -1, -1]);
    expect(pre.history).toHaveLength(1);
    expect(bus.some((b) => b.kind === 'predeal')).toBe(true);
    vi.advanceTimersByTime(dealAt);
    expect(views.at(-1)!.v.dealt).toBe(true);
    expect(views.at(-1)!.v.handIndex).toBe(1);
    expect(views.at(-1)!.v.history[0]).toMatchObject({ matchNo: 1, handIndex: 0 });
  });

  it('a newer message shows the pending events at once, marked instant', () => {
    const msgs = messages();
    const withAi = msgs.slice(1).find((m) => m.events.some((x) => x.at > 0))!;
    const { pb } = run();
    pb.push(msgs[0]);
    const idx = msgs.indexOf(withAi);
    for (const m of msgs.slice(1, idx)) {
      pb.push(m);
      vi.advanceTimersByTime(10_000);
    }
    bus = [];
    pb.push(withAi);
    expect(pb.playing).toBe(true);
    pb.push({ ...msgs[idx + 1], events: [{ at: 0, e: { t: 'signal', seat: 1, signal: 0, seenBy: 0 } }] });
    expect(bus.filter((b) => b.kind === 'event' && b.instant).length).toBeGreaterThan(0);
  });

  it('beforeDeal pauses the queue until its promise settles', async () => {
    const msgs = messages();
    let release: () => void = () => {};
    const asked: number[] = [];
    const { pb, views } = run({
      beforeDeal: (hand: number) => {
        asked.push(hand);
        return new Promise<void>((r) => (release = r));
      },
    });
    pb.push(msgs[0]);
    for (const m of msgs.slice(1)) {
      pb.push(m);
      vi.advanceTimersByTime(10_000);
    }
    expect(asked).toEqual([1]);
    expect(pb.paused).toBe(true);
    expect(views.at(-1)!.v.dealt).toBe(false);
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(pb.paused).toBe(false);
    vi.advanceTimersByTime(10);
    expect(views.at(-1)!.v.dealt).toBe(true);
    expect(views.at(-1)!.v.handIndex).toBe(1);
  });

  it('predealFrom: nothing dealt, the next dealer and mão, the starting value', () => {
    const [first] = messages();
    const { pb, views } = run();
    pb.push({ ...first, events: [] });
    const v = predealFrom(views[0].v, { hand: 4, dealer: 0, mao: 1, kind: 'normal', onzeTeam: -1 });
    expect(v).toMatchObject({ dealt: false, handIndex: 4, dealer: 0, mao: 1, vira: -1, value: 1, waitingFor: -1, legal: 0 });
    expect(predealFrom({ ...v, score: [12, 5] }, { hand: 5, dealer: 1, mao: 0, kind: 'normal', onzeTeam: -1 }).score).toEqual([0, 0]);
    expect(predealFrom(v, { hand: 5, dealer: 1, mao: 0, kind: 'onze', onzeTeam: 0 }).value).toBe(3);
  });
});
