import { describe, expect, it } from 'vitest';
import { mulberry32, deriveSeed } from '../../engine/src/rng.ts';
import { A_SIGNAL0, SIGNAL_MASK, legalMask, expectedActor, type MatchState } from '../../engine/src/engine.ts';
import { agentContext, type Agent } from '../../ai/src/agent.ts';
import { buildMatchRecord } from '../../shared/match-record.ts';
import { HeuristicAgent } from '../../ai/src/heuristic.ts';
import type { RoomSettings, ServerMsg } from '../../shared/protocol.ts';
import { parseClientMsg } from '../../shared/protocol.ts';
import { DEFAULT_OPPONENTS } from '../../shared/lineup.ts';
import {
  ABANDON_AFTER_MS,
  LISTING_AHEAD_MS,
  MAX_TIMEOUTS,
  RECONNECT_GRACE_MS,
  ROOM_TTL_MS,
  RoomCore,
  defaultSettings,
  listingUpdate,
  memberUntil,
  validateSettings,
  type DecisionRecord,
  type RoomDeps,
} from '../src/room-core.ts';

function deps(seed = 1, clock = { t: 1_000_000 }): RoomDeps & { clock: { t: number }; decisions: DecisionRecord[]; abandoned: string[] } {
  const rand = mulberry32(seed);
  let k = 0;
  const decisions: DecisionRecord[] = [];
  const abandoned: string[] = [];
  return {
    clock,
    decisions,
    abandoned,
    now: () => clock.t,
    randomSeed: () => deriveSeed('ab'.repeat(32), 77, seed * 1000 + k++),
    agentFor: () => new HeuristicAgent(),
    rand,
    onDecision: (r) => decisions.push(r),
    onAbandon: (d) => abandoned.push(d),
  };
}

/** Cards a seat may know right now (same rule as the engine property tests). */
function allowedCards(s: MatchState, seat: number): Set<number> {
  const h = s.hand;
  const ok = new Set<number>();
  if (h.vira >= 0) ok.add(h.vira);
  if (h.kind !== 'iron') for (const c of h.cards[seat]) if (c >= 0) ok.add(c);
  for (const r of h.rounds) for (const p of r.plays) if (!p.faceDown || p.seat === seat) ok.add(p.card);
  if (s.n === 4 && h.kind === 'onze' && s.config.options.onzeSeesPartner && (seat & 1) === h.onzeTeam) {
    for (const c of h.cards[(seat + 2) % 4]) if (c >= 0) ok.add(c);
  }
  return ok;
}

/** Checks one outgoing message for a seat: no hidden card, seed or signal truth inside. */
function checkMessage(core: RoomCore, seat: number, msg: ServerMsg | null, previousHand: Set<number>): void {
  if (!msg || msg.t !== 'game') return;
  const ms = core.match!;
  const json = JSON.stringify(msg);
  expect(json).not.toContain(ms.seed);
  expect(json).not.toContain(ms.hand.seed);
  expect(json).not.toContain('truthful');
  expect(json).not.toContain('"dealt"');
  const ok = allowedCards(ms, seat);
  const o = msg.obs;
  for (const c of [o.vira, ...o.hand, ...(o.partnerHand ?? []), ...o.rounds.flatMap((r) => r.plays.map((p) => p.card))]) {
    if (c >= 0) expect(ok.has(c)).toBe(true);
  }
  // Events may show cards of the hand that just ended (they were played face up), never face-down cards of others.
  for (const te of msg.events) {
    const e = te.e;
    if (e.t === 'play' && e.faceDown && e.seat !== seat) expect(e.card).toBe(-1);
    if (e.t === 'play' && !e.faceDown) previousHand.add(e.card);
    if (e.t === 'signal') expect((ms.n === 4 && [seat, (seat + 2) % 4].includes(e.seat)) || ms.config.options.signals !== 'secret').toBe(true);
  }
}

describe('room core', () => {
  it('quick play deals at once with AIs in every other seat', () => {
    const d = deps();
    const core = RoomCore.create('ABCDE', defaultSettings(), 'dev-a', true, 'v1', d);
    expect(core.r.status).toBe('playing');
    expect(core.r.seats.map((s) => s.kind)).toEqual(['human', 'ai', 'ai', 'ai']);
    expect(core.publicRoom().seats.filter((s) => s.kind === 'ai').every((s) => s.persona)).toBe(true);
    // The AIs wait for the person; once they arrive, the AIs play until it is the person's turn.
    core.connect('dev-a');
    expect(core.decider()).toBe(0);
    expect(core.r.deadline?.seat).toBe(0);
  });

  it('rejects stale and illegal moves and moves of other seats', () => {
    const d = deps(2);
    const core = RoomCore.create('ABCDE', defaultSettings({ players: 2, opponents: ['zap'] }), 'dev-a', true, 'v1', d);
    const ms = core.match!;
    const seq = core.r.seq;
    const mask = legalMask(ms, 0);
    const illegal = [...Array(15).keys()].find((a) => !(mask & (1 << a)))!;
    expect(core.handle('dev-a', { t: 'act', seq: seq - 1, a: [...Array(15).keys()].find((a) => mask & (1 << a))! })).toEqual({ ok: false, code: 'stale' });
    expect(core.handle('dev-a', { t: 'act', seq, a: illegal }).ok).toBe(false);
    expect(core.handle('dev-x', { t: 'act', seq, a: 0 })).toEqual({ ok: false, code: 'not_seated' });
  });

  it('a room waits in the lobby, seats people by code, and fills the rest with AIs on start', () => {
    const d = deps(3);
    const core = RoomCore.create('QWERT', defaultSettings({ mode: 'room' }), 'owner', true, 'v1', d);
    expect(core.r.status).toBe('lobby');
    expect(core.join('friend', false)).toEqual({ seat: 1 });
    expect(core.handle('friend', { t: 'sit', seat: 2 }).ok).toBe(true);
    expect(core.seatOf('friend')).toBe(2);
    // The plan stays with the seats: seat 1 is free again with its character, the friend hides seat 2's.
    expect(core.publicRoom().seats.map((s) => s.persona)).toEqual([null, 'zap', null, 'lia']);
    expect(core.handle('friend', { t: 'start' })).toEqual({ ok: false, code: 'not_owner' });
    expect(core.handle('owner', { t: 'start' }).ok).toBe(true);
    expect(core.r.seats.map((s) => s.kind)).toEqual(['human', 'ai', 'human', 'ai']);
    // The default plan on seats 1, 2 and 3 (Zap, Iara, Lia): the AIs take the free seats' characters.
    expect(core.r.seats.map((s) => s.persona)).toEqual(['ravi', 'zap', 'iara', 'lia']);
    expect(core.publicRoom().seats.map((s) => s.persona)).toEqual([null, 'zap', null, 'lia']);
    expect(core.join('late', true)).toEqual({ error: 'room_full' });
  });

  it('time out in a room: the AI plays for the person, three in a row count as abandonment', () => {
    const clock = { t: 5_000_000 };
    const d = deps(4, clock);
    const core = RoomCore.create('ZXCVB', defaultSettings({ mode: 'room', players: 2, opponents: ['bento'] }), 'p1', true, 'v1', d);
    core.join('p2', true);
    core.connect('p1');
    core.connect('p2');
    core.handle('p1', { t: 'start' });
    let timeouts = 0;
    for (let i = 0; i < 40 && core.r.status === 'playing' && timeouts < MAX_TIMEOUTS; i++) {
      const dl = core.r.deadline!;
      if (dl.seat === 0) {
        clock.t = dl.at! + 1;
        core.alarm();
        timeouts++;
      } else {
        const ms = core.match!;
        const mask = legalMask(ms, 1);
        core.handle('p2', { t: 'act', seq: core.r.seq, a: [...Array(15).keys()].find((a) => mask & (1 << a))! });
      }
    }
    expect(timeouts).toBe(MAX_TIMEOUTS);
    expect(core.r.seats[0].abandoned).toBe(true);
    expect(d.abandoned).toContain('p1');
    const autoMoves = d.decisions.filter((r) => r.seat === 0 && r.auto).length;
    expect(autoMoves).toBeGreaterThanOrEqual(MAX_TIMEOUTS);
    expect(d.decisions.filter((r) => r.seat === 0 && r.auto).every((r) => r.decisionMs === null)).toBe(true);
  });

  it('a person who drops keeps the seat for 20 s, then the AI plays, and gives it back on return', () => {
    const clock = { t: 9_000_000 };
    const d = deps(5, clock);
    const core = RoomCore.create('MNBVC', defaultSettings({ mode: 'room', players: 2, opponents: ['lia'] }), 'p1', true, 'v1', d);
    core.join('p2', true);
    core.connect('p1');
    core.connect('p2');
    core.handle('p1', { t: 'start' });
    const waiting = core.r.deadline!.seat;
    const device = waiting === 0 ? 'p1' : 'p2';
    core.disconnect(device);
    expect(core.nextAlarm()).toBe(clock.t + RECONNECT_GRACE_MS);
    clock.t += RECONNECT_GRACE_MS + 1;
    const before = core.match!.log.length;
    core.alarm();
    expect(core.r.seats[waiting].takeover).toBe(true);
    expect(core.match!.log.length).toBeGreaterThan(before);
    expect(core.publicRoom().seats[waiting].aiPlaying).toBe(true);
    core.connect(device);
    expect(core.r.seats[waiting].takeover).toBe(false);
    expect(core.r.seats[waiting].abandoned).toBe(false);
  });

  it('away for more than 120 s counts as abandonment, but not when everyone dropped at once', () => {
    const clock = { t: 1_000 };
    const d = deps(6, clock);
    const core = RoomCore.create('PLKJH', defaultSettings({ mode: 'room', players: 2, opponents: ['lia'] }), 'p1', true, 'v1', d);
    core.join('p2', true);
    core.connect('p1');
    core.connect('p2');
    core.handle('p1', { t: 'start' });
    core.disconnect('p1');
    core.disconnect('p2');
    clock.t += ABANDON_AFTER_MS + 5;
    core.alarm();
    expect(core.r.seats[0].abandoned).toBe(false);
    expect(core.r.seats[1].abandoned).toBe(false);
    core.connect('p1');
    core.connect('p2');
    core.disconnect('p2');
    clock.t += ABANDON_AFTER_MS + 5;
    core.alarm();
    expect(core.r.seats[1].abandoned).toBe(true);
  });

  it('a second socket of the same person does not restart the clock', () => {
    const clock = { t: 50_000 };
    const d = deps(11, clock);
    const core = RoomCore.create('KLMNP', defaultSettings({ mode: 'room', players: 2, opponents: ['lia'] }), 'p1', true, 'v1', d);
    core.join('p2', true);
    core.connect('p1');
    core.connect('p2');
    core.handle('p1', { t: 'start' });
    const before = { ...core.r.deadline! };
    const seq = core.r.seq;
    clock.t += 5_000;
    const device = before.seat === 0 ? 'p1' : 'p2';
    expect(core.connect(device)).toBe(false);
    expect(core.r.deadline).toEqual(before);
    expect(core.r.seq).toBe(seq);
    // Dropping and coming back neither restarts nor stops the clock: the deadline stays put.
    core.disconnect(device);
    clock.t += 3_000;
    core.connect(device);
    expect(core.r.deadline!.at).toBe(before.at);
  });

  it('with nobody at the table the AIs wait instead of playing the match alone', () => {
    const clock = { t: 70_000 };
    const d = deps(12, clock);
    const core = RoomCore.create('NPQRS', defaultSettings(), 'p1', true, 'v1', d);
    core.connect('p1');
    core.handle('p1', { t: 'leave' });
    expect(core.r.status).toBe('playing');
    expect(core.match!.over).toBe(false);
    expect(core.r.deadline).toBeNull();
  });

  it('a timed-out person can take the seat back with resume', () => {
    const clock = { t: 90_000 };
    const d = deps(13, clock);
    const core = RoomCore.create('QRSTV', defaultSettings({ mode: 'room', players: 2, opponents: ['lia'] }), 'p1', true, 'v1', d);
    core.join('p2', true);
    core.connect('p1');
    core.connect('p2');
    core.handle('p1', { t: 'start' });
    core.r.seats[0].takeover = true;
    expect(core.handle('p1', { t: 'resume' }).ok).toBe(true);
    expect(core.r.seats[0].takeover).toBe(false);
  });

  it('no time limit needs people in every seat; a new match needs the human check', () => {
    const d = deps(14);
    const core = RoomCore.create('RSTVW', defaultSettings({ mode: 'room', players: 2, opponents: ['lia'], turnSeconds: null }), 'p1', true, 'v1', d);
    expect(core.handle('p1', { t: 'start' })).toEqual({ ok: false, code: 'needs_people' });
    core.join('p2', true);
    expect(core.handle('p1', { t: 'start' }, { mayStartMatch: false })).toEqual({ ok: false, code: 'check_needed' });
    expect(core.handle('p1', { t: 'start' }).ok).toBe(true);
    expect(core.join('p3', true, Date.now() + 1000, false)).toEqual({ error: 'check_needed' });
  });

  it('the next alarm is never a time that was already handled (no alarm storms)', () => {
    const clock = { t: 200_000 };
    const d = deps(15, clock);
    const core = RoomCore.create('STVWX', defaultSettings({ mode: 'room', players: 2, opponents: ['lia'] }), 'p1', true, 'v1', d);
    core.join('p2', true);
    core.connect('p1');
    core.connect('p2');
    core.handle('p1', { t: 'start' });
    const waiting = core.r.deadline!.seat;
    core.disconnect(waiting === 0 ? 'p1' : 'p2');
    // Grace passes: the AI takes the seat; the next alarm must be in the future.
    clock.t += RECONNECT_GRACE_MS + 1;
    core.alarm();
    expect(core.nextAlarm()!).toBeGreaterThan(clock.t);
    // Everyone drops: no abandonment is pending, so no alarm before the room expires.
    core.disconnect(waiting === 0 ? 'p2' : 'p1');
    clock.t += RECONNECT_GRACE_MS + 1;
    core.alarm();
    expect(core.nextAlarm()!).toBeGreaterThan(clock.t);
    clock.t += ABANDON_AFTER_MS + 1;
    core.alarm();
    expect(core.nextAlarm()!).toBeGreaterThan(clock.t);
  });

  it('rematch keeps the seats and deals a new match with a new seed', () => {
    const d = deps(7);
    const core = RoomCore.create('HJKLM', defaultSettings({ players: 2, opponents: ['otavio'] }), 'p1', true, 'v1', d);
    core.connect('p1');
    const rand = mulberry32(3);
    const firstSeed = core.r.match!.seed;
    let guard = 0;
    while (core.r.status === 'playing' && guard++ < 2000) {
      const mask = legalMask(core.match!, 0);
      const acts = [...Array(15).keys()].filter((a) => mask & (1 << a));
      core.handle('p1', { t: 'act', seq: core.r.seq, a: acts[Math.floor(rand() * acts.length)] });
    }
    expect(core.r.status).toBe('ended');
    expect(core.handle('p1', { t: 'rematch' }).ok).toBe(true);
    expect(core.r.status).toBe('playing');
    expect(core.r.matchNo).toBe(2);
    expect(core.r.match!.seed).not.toBe(firstSeed);
    expect(core.r.seats[1].persona).toBe('otavio');
  });

  it('an AI that answers no legal move (bad knobs in a manifest) never stops the match', () => {
    for (const bad of [Number.NaN, -1, 15, 2.5, 99]) {
      const d = deps(8);
      let asked = 0;
      d.agentFor = (): Agent => ({
        name: 'broken',
        act: () => {
          asked++;
          return { action: bad };
        },
      });
      const core = RoomCore.create('BROKE', defaultSettings({ players: 2, opponents: ['zap'] }), 'p1', true, 'v1', d);
      core.connect('p1');
      const rand = mulberry32(4);
      let guard = 0;
      while (core.r.status === 'playing' && guard++ < 2000) {
        const mask = legalMask(core.match!, 0);
        const acts = [...Array(15).keys()].filter((a) => mask & (1 << a));
        expect(core.handle('p1', { t: 'act', seq: core.r.seq, a: acts[Math.floor(rand() * acts.length)] }).ok).toBe(true);
      }
      expect(core.r.status, String(bad)).toBe('ended');
      expect(asked).toBeGreaterThan(10);
      const aiMoves = core.r.match!.log.filter((x) => x >> 4 === 1).map((x) => x & 15);
      expect(aiMoves.length).toBeGreaterThan(10);
    }
  });

  it('phrases are limited to one every 5 s and must be known keys', () => {
    const clock = { t: 0 };
    const d = deps(8, clock);
    const core = RoomCore.create('RTYUP', defaultSettings(), 'p1', true, 'v1', d);
    expect(core.handle('p1', { t: 'phrase', key: 'boa' }).ok).toBe(true);
    expect(core.handle('p1', { t: 'phrase', key: 'vamos' })).toEqual({ ok: false, code: 'too_fast' });
    clock.t += 5_000;
    expect(core.handle('p1', { t: 'phrase', key: 'vamos' }).ok).toBe(true);
    expect(parseClientMsg('{"t":"phrase","key":"qualquer coisa"}')).toBeNull();
    expect(parseClientMsg('x'.repeat(3000))).toBeNull();
  });

  it('the room expires after 24 h without activity', () => {
    const clock = { t: 0 };
    const d = deps(9, clock);
    const core = RoomCore.create('WXYZA', defaultSettings({ mode: 'room' }), 'p1', true, 'v1', d);
    expect(core.nextAlarm()).toBe(ROOM_TTL_MS);
    clock.t = ROOM_TTL_MS;
    expect(core.alarm()).toBe('expired');
  });

  it('state survives a restart (stored JSON rebuilt by replay)', () => {
    const d = deps(10);
    const core = RoomCore.create('BCDFG', defaultSettings(), 'p1', true, 'v1', d);
    const mask = legalMask(core.match!, 0);
    core.handle('p1', { t: 'act', seq: core.r.seq, a: [...Array(15).keys()].find((a) => mask & (1 << a))! });
    const copy = new RoomCore(JSON.parse(JSON.stringify(core.r)), d);
    expect(JSON.stringify(copy.match)).toBe(JSON.stringify(core.match));
    expect(expectedActor(copy.match!)).toBe(expectedActor(core.match!));
  });
});

describe('no hidden information leaves the room', () => {
  it('10,000 matches: every message to every person shows only what that seat may see', () => {
    const variants = ['paulista', 'mineiro'] as const;
    const signals = ['secret', 'p25', 'all'] as const;
    let messages = 0;
    for (let m = 0; m < 10_000; m++) {
      const d = deps(100 + m);
      const players = m % 3 === 0 ? 2 : 4;
      const settings = defaultSettings({
        mode: 'room',
        players,
        variant: variants[m % 2],
        opponents: players === 2 ? ['zap'] : ['zap', 'bento'],
        options: { signals: signals[m % 3], faceDownFirstRound: m % 5 === 0, raiseAnyTime: m % 7 === 0 },
      });
      const people = ['h0', 'h1', 'h2', 'h3'].slice(0, players === 2 ? 2 : 1 + (m % 4));
      const core = RoomCore.create(`T${(m % 100000).toString(36).toUpperCase().padStart(4, '2')}`.slice(0, 5), settings, people[0], true, 'v1', d);
      for (const p of people.slice(1)) core.join(p, true);
      for (const p of people) core.connect(p);
      core.handle(people[0], { t: 'start' });
      const rand = mulberry32(m);
      const seen = new Set<number>();
      const playChecked = () => {
        let guard = 0;
        while (core.r.status === 'playing' && guard++ < 3000) {
          for (const p of people) {
            const seat = core.seatOf(p);
            checkMessage(core, seat, core.gameMessage(seat), seen);
            messages++;
          }
          core.clearPending();
          // Some person with a legal move acts (in turn or out of turn).
          const movers = people.filter((p) => legalMask(core.match!, core.seatOf(p)) !== 0);
          if (movers.length === 0) {
            // Waiting for the alarm (a person's time running out, or AI moves left for later).
            d.clock.t = Math.max(d.clock.t, core.nextAlarm() ?? d.clock.t) + 1;
            core.alarm();
            continue;
          }
          const p = movers[Math.floor(rand() * movers.length)];
          const mask = legalMask(core.match!, core.seatOf(p));
          const acts = [...Array(15).keys()].filter((a) => mask & (1 << a));
          core.handle(p, { t: 'act', seq: core.r.seq, a: acts[Math.floor(rand() * acts.length)] });
        }
        expect(core.r.status).toBe('ended');
      };
      playChecked();
      if (m % 8 === 0) {
        // A trip through the lobby after the match (M15 "Mudar a mesa"): the owner moves people
        // and AIs around; no seat hears anything of the finished match meanwhile, and the next
        // match shows each person only their new seat's cards.
        expect(core.handle(people[0], { t: 'lobby' }).ok).toBe(true);
        for (let k = 0; k < 1 + (m % 3); k++) {
          // The owner moves a person (an AI moves when a person takes its seat).
          const held = core.r.seats.flatMap((s, i) => (s.kind === 'human' ? [i] : []));
          const from = held[Math.floor(rand() * held.length)];
          const to = (from + 1 + Math.floor(rand() * (players - 1))) % players;
          expect(core.handle(people[0], { t: 'move', from, to }).ok).toBe(true);
          for (let seat = 0; seat < players; seat++) expect(core.gameMessage(seat)).toBeNull();
        }
        core.clearPending();
        expect(core.handle(people[0], { t: 'start' }).ok).toBe(true);
        playChecked();
      }
    }
    expect(messages).toBeGreaterThan(100_000);
  }, 600_000);
});

const dev = (c: string) => c.repeat(64);

/** The lowest action in a mask. */
const first = (mask: number) => [...Array(15).keys()].find((a) => mask & (1 << a))!;

/** Two people in a room with friends, connected, match started. */
function roomOfTwo(seed: number, clock: { t: number }, over: Parameters<typeof defaultSettings>[0] = {}) {
  const d = deps(seed, clock);
  const starts: string[][] = [];
  d.onMatchStart = (devices) => starts.push(devices);
  const core = RoomCore.create('PQRST', defaultSettings({ mode: 'room', players: 2, opponents: ['lia'], ...over }), dev('a'), true, 'v1', d);
  core.join(dev('b'), true);
  core.connect(dev('a'));
  core.connect(dev('b'));
  expect(core.handle(dev('a'), { t: 'start' }).ok).toBe(true);
  return { core, d, starts };
}

/** Plays random legal moves for the people in the room (and lets the alarm act) until the match ends. */
function playOut(core: RoomCore, d: ReturnType<typeof deps>, people: string[], seed = 5): void {
  const rand = mulberry32(seed);
  for (let guard = 0; core.r.status === 'playing' && guard < 5000; guard++) {
    const movers = people.filter((p) => core.seatOf(p) >= 0 && (legalMask(core.match!, core.seatOf(p)) & ~SIGNAL_MASK) !== 0);
    if (movers.length === 0) {
      d.clock.t = Math.max(d.clock.t, core.nextAlarm() ?? d.clock.t) + 1;
      core.alarm();
      continue;
    }
    const p = movers[Math.floor(rand() * movers.length)];
    const acts = [...Array(A_SIGNAL0).keys()].filter((a) => legalMask(core.match!, core.seatOf(p)) & (1 << a));
    core.handle(p, { t: 'act', seq: core.r.seq, a: acts[Math.floor(rand() * acts.length)] });
  }
  expect(core.r.status).toBe('ended');
}

describe('room core: clocks, signals and new matches', () => {
  it('the clock keeps running while a person is away: dropping and coming back cannot freeze it', () => {
    const clock = { t: 300_000 };
    const { core, d } = roomOfTwo(21, clock, { turnSeconds: 15 });
    const dl = { ...core.r.deadline! };
    const device = dl.seat === 0 ? dev('a') : dev('b');
    // Away: the alarm still comes at the deadline (15 s, before the 20 s grace ends).
    core.disconnect(device);
    expect(core.nextAlarm()).toBe(dl.at);
    for (let i = 0; i < 5; i++) {
      clock.t += 1_000;
      core.connect(device);
      expect(core.r.deadline!.at).toBe(dl.at);
      core.disconnect(device);
      expect(core.nextAlarm()).toBe(dl.at);
    }
    const moves = core.match!.log.length;
    clock.t = dl.at!;
    core.alarm();
    // Time ran out while the person was away: the AI played the move for them, as a time out.
    expect(core.match!.log.length).toBeGreaterThan(moves);
    expect(core.match!.log[moves] >> 4).toBe(dl.seat);
    expect(core.r.seats[dl.seat].timeouts).toBe(1);
    expect(d.decisions.find((r) => r.seat === dl.seat)).toMatchObject({ auto: true, decisionMs: null });
  });

  it('a signal keeps the room expiry, which is shown only to the hour; clearing the events clears who hears of them', () => {
    const clock = { t: 7 * 3600_000 + 1234 };
    const { core } = roomOfTwo(22, clock, { players: 4, opponents: ['lia', 'ravi'], options: { signals: 'all' } });
    clock.t += 60_000;
    const seat = core.seatOf(dev('b'));
    expect(legalMask(core.match!, seat) & SIGNAL_MASK).not.toBe(0);
    const last = core.r.lastActivity;
    const seq = core.r.seq;
    core.clearPending();
    expect(core.handle(dev('b'), { t: 'act', seq, a: A_SIGNAL0 }).ok).toBe(true);
    expect(core.r.lastActivity).toBe(last);
    expect(core.r.seq).toBe(seq);
    expect(core.notify).not.toBeNull();
    core.clearPending();
    expect(core.notify).toBeNull();
    const shown = core.publicRoom().expiresAt;
    expect(shown % 3600_000).toBe(0);
    expect(shown).toBeLessThanOrEqual(core.expiresAt());
    expect(shown).toBeGreaterThan(core.expiresAt() - 3600_000);
    // A real move does move the expiry.
    clock.t += 60_000;
    const g = core.decider();
    const mover = core.r.seats[g].device!;
    core.handle(mover, { t: 'act', seq: core.r.seq, a: first(legalMask(core.match!, g) & ~SIGNAL_MASK) });
    expect(core.r.lastActivity).toBe(clock.t);
  });

  it('hidden AI signals do not count toward the moves played in one event', () => {
    // AIs that signal whenever they may, and a cap of 2 moves per event so the chain pauses often.
    const signaller: Agent = { name: 'signaller', act: (obs) => ({ action: first(obs.legal & SIGNAL_MASK ? obs.legal & SIGNAL_MASK : obs.legal) }) };
    const d = { ...deps(23), agentFor: () => signaller, maxAiMovesPerEvent: 2 };
    const core = RoomCore.create('SGNLA', defaultSettings({ players: 4, options: { signals: 'all' } }), dev('a'), true, 'v1', d);
    let pauses = 0;
    let signals = 0;
    for (let i = 0; i < 300 && core.r.status === 'playing'; i++) {
      core.clearPending();
      if (i === 0) core.connect(dev('a'));
      else if (core.r.resumeAt !== null) {
        d.clock.t = core.r.resumeAt;
        core.alarm();
      } else {
        const mask = legalMask(core.match!, 0) & ~SIGNAL_MASK;
        expect(mask, 'the person must be able to move when the AIs wait').not.toBe(0);
        core.handle(dev('a'), { t: 'act', seq: core.r.seq, a: first(mask) });
      }
      const aiMoves = core.pending.filter((te) => 'seat' in te.e && te.e.seat !== 0 && te.e.t !== 'signal').length;
      signals += core.pending.filter((te) => te.e.t === 'signal' && te.e.seat !== 0).length;
      if (core.r.resumeAt !== null) {
        expect(aiMoves).toBe(2);
        pauses++;
      } else {
        expect(aiMoves).toBeLessThanOrEqual(2);
      }
    }
    expect(pauses).toBeGreaterThan(5);
    expect(signals).toBeGreaterThan(5);
  });

  it('a chain left for later is not resumed twice: any new turn clears it', () => {
    const clock = { t: 500_000 };
    const { core } = roomOfTwo(24, clock);
    core.r.resumeAt = clock.t + 60_000;
    const g = core.decider();
    core.handle(core.r.seats[g].device!, { t: 'act', seq: core.r.seq, a: first(legalMask(core.match!, g) & ~SIGNAL_MASK) });
    expect(core.r.resumeAt).toBeNull();
  });

  it('a person the AI plays for who sends a signal takes the seat back, and the game goes on', () => {
    const clock = { t: 600_000 };
    const { core } = roomOfTwo(25, clock, { players: 4, opponents: ['lia', 'ravi'], options: { signals: 'all' } });
    const b = core.seatOf(dev('b'));
    expect(legalMask(core.match!, b) & SIGNAL_MASK).not.toBe(0);
    // The AI plays for B (three time outs), and A drops past the grace: nobody is left to play,
    // so the AIs wait.
    core.r.seats[b].takeover = true;
    core.disconnect(dev('a'));
    clock.t += RECONNECT_GRACE_MS + 1;
    core.alarm();
    expect(core.r.deadline).toBeNull();
    expect(legalMask(core.match!, b) & SIGNAL_MASK).not.toBe(0);
    const seq = core.r.seq;
    core.clearPending();
    expect(core.handle(dev('b'), { t: 'act', seq, a: A_SIGNAL0 }).ok).toBe(true);
    // Everyone hears of it (the seat no longer shows an AI), and the game waits for B again.
    expect(core.r.seats[b].takeover).toBe(false);
    expect(core.notify).toBeNull();
    expect(core.r.seq).toBeGreaterThan(seq);
    expect(core.r.deadline?.seat).toBe(b);
  });

  it('a new match only from the lobby or a rematch, and only the people at the table spend one', () => {
    const clock = { t: 700_000 };
    const { core, d, starts } = roomOfTwo(26, clock, { turnSeconds: 15 });
    expect(starts).toEqual([[dev('a'), dev('b')]]);
    playOut(core, d, [dev('a'), dev('b')]);
    // A finished match is not started again with start: only a rematch deals a new one.
    expect(core.handle(dev('a'), { t: 'start' })).toEqual({ ok: false, code: 'not_in_lobby' });
    expect(core.preStart(dev('a'), 'start')).toEqual({ ok: false, code: 'not_in_lobby' });
    expect(core.preStart(dev('b'), 'start')).toEqual({ ok: false, code: 'not_owner' });
    expect(core.preStart(dev('x'), 'rematch')).toEqual({ ok: false, code: 'not_seated' });
    // While the owner is connected only the owner leads; once the owner is away, anyone seated may.
    expect(core.preStart(dev('b'), 'rematch')).toEqual({ ok: false, code: 'not_owner' });
    core.disconnect(dev('a'));
    expect(core.preStart(dev('b'), 'rematch')).toEqual({ ok: true });
    core.connect(dev('a'));
    expect(core.preStart(dev('b'), 'rematch')).toEqual({ ok: false, code: 'not_owner' });
    // B left the table: the rematch counts only A.
    core.disconnect(dev('b'));
    expect(core.handle(dev('a'), { t: 'rematch' }).ok).toBe(true);
    expect(starts).toEqual([[dev('a'), dev('b')], [dev('a')]]);
    expect(core.preStart(dev('a'), 'rematch')).toEqual({ ok: false, code: 'not_ended' });
    expect(core.preStart(dev('a'), 'start')).toEqual({ ok: false, code: 'not_in_lobby' });
  });

  it('the listing in D1 never falls behind the room, and is rewritten about once an hour of use', () => {
    const clock = { t: 650_000 };
    const d = deps(28, clock);
    const core = RoomCore.create('LSTNG', defaultSettings({ mode: 'room', players: 2, opponents: ['lia'], turnSeconds: null }), dev('a'), true, 'v1', d);
    let listed = core.expiresAt();
    let writes = 0;
    // Five hours of the owner coming back every minute.
    for (let i = 0; i < 300; i++) {
      clock.t += 60_000;
      core.connect(dev('a'));
      core.disconnect(dev('a'));
      const next = listingUpdate(core.expiresAt(), listed);
      if (next !== null) {
        expect(next).toBe(core.expiresAt() + LISTING_AHEAD_MS);
        listed = next;
        writes++;
      }
      expect(listed).toBeGreaterThanOrEqual(core.expiresAt());
    }
    expect(writes).toBe(5);
    expect(listingUpdate(1000, 1000)).toBeNull();
  });

  it('a membership row written now outlives the room and never comes before the listing', () => {
    const clock = { t: 640_000 };
    const d = deps(29, clock);
    const core = RoomCore.create('MMBRS', defaultSettings({ mode: 'room', players: 2, opponents: ['lia'], turnSeconds: null }), dev('a'), true, 'v1', d);
    const listed = core.expiresAt();
    expect(memberUntil(clock.t, listed)).toBe(clock.t + ROOM_TTL_MS + LISTING_AHEAD_MS);
    // Activity right after the write moves the room's expiry, still before the row's.
    clock.t += 1000;
    const until = memberUntil(clock.t, listed);
    core.connect(dev('a'));
    expect(until).toBeGreaterThan(core.expiresAt());
    expect(memberUntil(0, listed + 7 * ROOM_TTL_MS)).toBe(listed + 7 * ROOM_TTL_MS);
  });

  it('who sits here: people with a seat, also away ones an AI plays for; nobody once their data is gone', () => {
    const clock = { t: 630_000 };
    const { core, d } = roomOfTwo(30, clock, { turnSeconds: 15 });
    expect(core.seatedDevices()).toEqual([dev('a'), dev('b')]);
    core.disconnect(dev('b'));
    playOut(core, d, [dev('a')]);
    expect(core.seatedDevices()).toEqual([dev('a'), dev('b')]);
    core.forget(dev('b'));
    expect(core.seatedDevices()).toEqual([dev('a')]);
  });

  it('joinError says beforehand what join would do, and changes nothing', () => {
    const d = deps(31);
    const core = RoomCore.create('JNERR', defaultSettings({ mode: 'room', players: 2, opponents: ['lia'], turnSeconds: 15 }), dev('a'), true, 'v1', d);
    const before = JSON.stringify(core.r);
    expect(core.joinError(dev('a'), false)).toBeNull();
    expect(core.joinError(dev('b'), false)).toBe('check_needed');
    expect(core.joinError(dev('b'), true)).toBeNull();
    expect(JSON.stringify(core.r)).toBe(before);
    core.join(dev('b'), true);
    expect(core.joinError(dev('c'), true)).toBe('room_full');
    expect(core.join(dev('c'), true)).toEqual({ error: 'room_full' });
    expect(core.joinError(dev('b'), false)).toBeNull();
    expect(core.handle(dev('a'), { t: 'start' }).ok).toBe(true);
    core.forget(dev('b'));
    expect(core.joinError(dev('c'), true)).toBe('room_full');
  });

  it('someone carried into a match with no matches left keeps playing without the verified seal, in the room and the record', () => {
    const clock = { t: 620_000 };
    const { core } = roomOfTwo(32, clock, { turnSeconds: 15 });
    const id = core.r.match!.id;
    expect(core.publicRoom().seats[1].verified).toBe(true);
    expect(core.unverify(dev('b'), id)).toBe(true);
    expect(core.publicRoom().seats[1].verified).toBe(false);
    expect(core.r.match!.seats[1].verified).toBe(false);
    expect(core.r.match!.seats[0].verified).toBe(true);
    // Twice, or for someone not seated, changes nothing; an answer about an older match leaves the current record alone.
    expect(core.unverify(dev('b'), id)).toBe(false);
    expect(core.unverify(dev('x'), id)).toBe(false);
    expect(core.unverify(dev('a'), 'another-match')).toBe(true);
    expect(core.r.match!.seats[0].verified).toBe(true);
    expect(core.publicRoom().seats[0].verified).toBe(false);
  });

  it('the owner asks before a start whether it would go ahead', () => {
    const d = deps(27);
    const core = RoomCore.create('PRSTA', defaultSettings({ mode: 'room', players: 2, opponents: ['lia'], turnSeconds: null }), dev('a'), true, 'v1', d);
    expect(core.preStart(dev('a'), 'start')).toEqual({ ok: false, code: 'needs_people' });
    core.join(dev('b'), true);
    expect(core.preStart(dev('b'), 'start')).toEqual({ ok: false, code: 'not_owner' });
    expect(core.preStart(dev('a'), 'rematch')).toEqual({ ok: false, code: 'not_ended' });
    expect(core.preStart(dev('a'), 'start')).toEqual({ ok: true });
    // Asking changes nothing.
    expect(core.r.status).toBe('lobby');
  });
});

describe('room core: a person deletes their data or moves it', () => {
  it('in the lobby the seat empties, and the room closes when it was the owner\'s', () => {
    const clock = { t: 800_000 };
    const d = deps(31, clock);
    const core = RoomCore.create('FGTAB', defaultSettings({ mode: 'room' }), dev('a'), true, 'v1', d);
    core.join(dev('b'), true);
    core.connect(dev('a'));
    core.connect(dev('b'));
    expect(core.forget(dev('z'))).toBe(false);
    expect(core.forget(dev('b'))).toBe(true);
    expect(core.r.seats.map((s) => s.kind)).toEqual(['human', 'empty', 'empty', 'empty']);
    expect(core.r.closed).toBe(false);
    expect(core.forget(dev('a'))).toBe(true);
    expect(core.r.closed).toBe(true);
    expect(JSON.stringify(core.r)).not.toContain(dev('a'));
    expect(JSON.stringify(core.r)).not.toContain(dev('b'));
    expect(core.alarm()).toBe('expired');
  });

  it('during a match the seat stays a person\'s seat with no device and no name, an AI plays it, and a rematch gives it to an AI', () => {
    const clock = { t: 900_000 };
    const { core, d, starts } = roomOfTwo(32, clock, { players: 4, opponents: ['lia', 'ravi'] });
    core.join(dev('b'), true, Number.MAX_SAFE_INTEGER, true, 'Bia');
    expect(core.forget(dev('b'))).toBe(true);
    const b = 1;
    expect(core.r.seats[b]).toMatchObject({ kind: 'human', device: null, name: '', takeover: true, connected: false, verified: false });
    expect(core.publicRoom().seats[b]).toMatchObject({ kind: 'human', name: '', aiPlaying: true, connected: false, verified: false });
    expect(JSON.stringify(core.r)).not.toContain(dev('b'));
    expect(core.r.closed).toBe(false);
    // A plays on; the AI plays B's seat; the match ends.
    playOut(core, d, [dev('a')]);
    expect(core.r.match!.seats[b].kind).toBe('human');
    expect(core.handle(dev('a'), { t: 'rematch' }).ok).toBe(true);
    expect(core.r.seats[b].kind).toBe('ai');
    // The seat's planned character plays it (opponents Lia and Ravi: Lia on seat 1).
    expect(core.r.seats[b].persona).toBe('lia');
    expect(starts.at(-1)).toEqual([dev('a')]);
  });

  it('the owner leaving mid-match keeps the room for the others; a room with no person left closes', () => {
    const clock = { t: 1_000_000 };
    const { core, d } = roomOfTwo(33, clock);
    expect(core.forget(dev('a'))).toBe(true);
    expect(core.r.owner).toBe('');
    expect(core.r.closed).toBe(false);
    expect(core.roomMessage(dev('b'))).toMatchObject({ owner: false, you: 1 });
    playOut(core, d, [dev('b')]);
    // Anyone still seated may ask for a rematch.
    expect(core.handle(dev('b'), { t: 'rematch' }).ok).toBe(true);
    expect(core.forget(dev('b'))).toBe(true);
    expect(core.r.closed).toBe(true);
    expect(core.alarm()).toBe('expired');

    const solo = RoomCore.create('SOLOA', defaultSettings({ players: 2, opponents: ['zap'] }), dev('c'), true, 'v1', deps(34, clock));
    solo.connect(dev('c'));
    expect(solo.forget(dev('c'))).toBe(true);
    expect(solo.r.closed).toBe(true);
    expect(JSON.stringify(solo.r)).not.toContain(dev('c'));
  });

  it('a recovery moves the seat and the room to the new id; the old id is gone', () => {
    const clock = { t: 1_100_000 };
    const { core } = roomOfTwo(35, clock);
    expect(core.rekey(dev('z'), dev('n'))).toBe(false);
    expect(core.rekey(dev('a'), dev('n'))).toBe(true);
    expect(core.seatOf(dev('n'))).toBe(0);
    expect(core.r.owner).toBe(dev('n'));
    // The old browser's connection is closed: the seat waits for the new one.
    expect(core.r.seats[0].connected).toBe(false);
    expect(JSON.stringify(core.r)).not.toContain(dev('a'));
    expect(core.connect(dev('n'))).toBe(true);
    expect(core.roomMessage(dev('n'))).toMatchObject({ you: 0, owner: true });
    // Both browsers sat here: the new id keeps its own seat and the room, the other seat goes.
    expect(core.rekey(dev('n'), dev('b'))).toBe(true);
    expect(core.r.owner).toBe(dev('b'));
    expect(core.seatOf(dev('b'))).toBe(1);
    expect(core.r.seats[0]).toMatchObject({ kind: 'human', device: null, takeover: true });
  });

  it('a recovery in the lobby moves the owner; a friend who moved joins again', () => {
    const d = deps(36);
    const core = RoomCore.create('RKYAB', defaultSettings({ mode: 'room', players: 2, opponents: ['lia'] }), dev('a'), true, 'v1', d);
    core.join(dev('b'), true);
    core.connect(dev('a'));
    core.connect(dev('b'));
    expect(core.rekey(dev('a'), dev('n'))).toBe(true);
    expect(core.roomMessage(dev('n'))).toMatchObject({ you: 0, owner: true });
    // A friend's lobby seat is let go when their connection closes, as on any drop.
    expect(core.rekey(dev('b'), dev('m'))).toBe(true);
    expect(core.seatOf(dev('m'))).toBe(-1);
    expect(core.join(dev('m'), true)).toEqual({ seat: 1 });
  });
});


describe('room core: the public match context given to the AIs', () => {
  /** An AI that checks its context against agentContext(match, noStats) before every move. */
  function spyDeps(seed: number, clock: { t: number }, get: () => RoomCore) {
    const d = deps(seed, clock);
    const seen: string[] = [];
    d.agentFor = (): Agent => ({
      name: 'spy',
      act: (obs, rand, ctx) => {
        const core = get();
        expect(ctx).toBeDefined();
        const json = JSON.stringify(ctx);
        expect(json).toBe(JSON.stringify(agentContext(core.match!, core.r.match!.noStats ?? 0)));
        // Public facts only: no dealt cards, no seeds, no signal truth.
        expect(json).not.toContain('"dealt"');
        expect(json).not.toContain('truthful');
        expect(json).not.toContain(core.match!.seed);
        for (const h of core.match!.history) expect(json).not.toContain(h.seed);
        expect(json).not.toContain(core.match!.hand.seed);
        seen.push(json);
        return new HeuristicAgent().act(obs, rand);
      },
    });
    return { d, seen };
  }

  it('every AI move gets the public history and the noStats mask fixed at the start; the record never holds the mask', () => {
    const clock = { t: 400_000 };
    let core!: RoomCore;
    const { d, seen } = spyDeps(31, clock, () => core);
    core = RoomCore.create('CTXAB', defaultSettings({ mode: 'room', players: 4, opponents: ['zap', 'lia'] }), dev('a'), true, 'v1', d, Number.MAX_SAFE_INTEGER, '', true);
    core.join(dev('b'), true, Number.MAX_SAFE_INTEGER, true, '', false);
    core.connect(dev('a'));
    core.connect(dev('b'));
    expect(core.handle(dev('a'), { t: 'start' }).ok).toBe(true);
    expect(core.r.match!.noStats).toBe(1 << core.seatOf(dev('a')));
    playOut(core, d, [dev('a'), dev('b')]);
    expect(seen.length).toBeGreaterThan(10);
    expect(seen.some((j) => j.includes('"bets":[{'))).toBe(true);
    const record = JSON.stringify(buildMatchRecord(core.r));
    expect(record).not.toContain('noStats');
    expect(record).not.toContain('noAdapt');
  });

  it('a room restored from storage gives the AIs the same context', () => {
    const clock = { t: 500_000 };
    let core!: RoomCore;
    const { d } = spyDeps(32, clock, () => core);
    core = RoomCore.create('CTXCD', defaultSettings({ mode: 'room', players: 2, opponents: ['bento'] }), dev('a'), true, 'v1', d, Number.MAX_SAFE_INTEGER, '', true);
    core.join(dev('b'), true);
    core.connect(dev('a'));
    core.connect(dev('b'));
    core.handle(dev('a'), { t: 'start' });
    const rand = mulberry32(4);
    for (let i = 0; i < 400 && core.match!.history.length < 2 && core.r.status === 'playing'; i++) {
      const movers = [dev('a'), dev('b')].filter((p) => (legalMask(core.match!, core.seatOf(p)) & ~SIGNAL_MASK) !== 0);
      if (!movers.length) break;
      const p = movers[0];
      const acts = [...Array(A_SIGNAL0).keys()].filter((a) => legalMask(core.match!, core.seatOf(p)) & (1 << a));
      core.handle(p, { t: 'act', seq: core.r.seq, a: acts[Math.floor(rand() * acts.length)] });
    }
    expect(core.match!.history.length).toBeGreaterThan(0);
    const copy = new RoomCore(JSON.parse(JSON.stringify(core.r)), d);
    expect(copy.r.match!.noStats).toBe(core.r.match!.noStats);
    expect(JSON.stringify(agentContext(copy.match!, copy.r.match!.noStats ?? 0))).toBe(JSON.stringify(agentContext(core.match!, core.r.match!.noStats ?? 0)));
  });

  it('a change of "Don\'t adapt to me" takes effect at the next match', () => {
    const clock = { t: 600_000 };
    const { core, d } = roomOfTwo(33, clock);
    expect(core.r.match!.noStats).toBe(0);
    // The person switches it on and comes back: the seat remembers it, the match keeps its mask.
    core.join(dev('b'), true, Number.MAX_SAFE_INTEGER, true, '', true);
    expect(core.r.seats[core.seatOf(dev('b'))].noAdapt).toBe(true);
    expect(core.r.match!.noStats).toBe(0);
    playOut(core, d, [dev('a'), dev('b')]);
    expect(core.handle(dev('a'), { t: 'rematch' }).ok).toBe(true);
    expect(core.r.match!.noStats).toBe(1 << core.seatOf(dev('b')));
  });

  it('a change of "Don\'t adapt to me" made elsewhere reaches the seat without a reconnect, from the next match', () => {
    const clock = { t: 650_000 };
    const { core, d } = roomOfTwo(35, clock);
    expect(core.r.match!.noStats).toBe(0);
    // The person changes it in another tab: the Worker tells the room (Room.setNoAdapt).
    expect(core.setNoAdapt(dev('b'), true)).toBe(true);
    expect(core.setNoAdapt(dev('b'), true)).toBe(false);
    expect(core.setNoAdapt(dev('z'), true)).toBe(false);
    expect(core.r.seats[core.seatOf(dev('b'))].noAdapt).toBe(true);
    // The running match keeps its mask.
    expect(core.r.match!.noStats).toBe(0);
    playOut(core, d, [dev('a'), dev('b')]);
    expect(core.handle(dev('a'), { t: 'rematch' }).ok).toBe(true);
    expect(core.r.match!.noStats).toBe(1 << core.seatOf(dev('b')));
    // And switched off again the same way.
    expect(core.setNoAdapt(dev('b'), false)).toBe(true);
    playOut(core, d, [dev('a'), dev('b')]);
    expect(core.handle(dev('a'), { t: 'rematch' }).ok).toBe(true);
    expect(core.r.match!.noStats).toBe(0);
  });

  it('seats stored before the flag existed read noAdapt false', () => {
    const d = deps(34);
    const core = RoomCore.create('CTXEF', defaultSettings(), 'p1', true, 'v1', d);
    const stored = JSON.parse(JSON.stringify(core.r));
    for (const seat of stored.seats) delete seat.noAdapt;
    delete stored.match.noStats;
    const copy = new RoomCore(stored, d);
    expect(copy.r.seats.every((s) => s.noAdapt === false)).toBe(true);
  });
});

describe('the solo hold between hands (CLIENT-SPEC 16.5)', () => {
  /** A quick play 1 against 1, connected, waiting for the person's move (seat 0). */
  function soloWaiting(seed: number, clock: { t: number }) {
    const d = deps(seed, clock);
    const core = RoomCore.create('ABCDE', defaultSettings({ players: 2, opponents: ['zap'] }), 'dev-a', true, 'v1', d);
    core.connect('dev-a');
    expect(core.r.deadline?.seat).toBe(0);
    return { core, d };
  }
  /** The person's first legal move now (a card, or an answer when a bet waits for them). */
  const card = (core: RoomCore) => first(legalMask(core.match!, 0));

  it('the decision time of the next move leaves out the held time, and the clock comes back with the time that was left', () => {
    const clock = { t: 1_000_000 };
    const { core, d } = soloWaiting(41, clock);
    const dl = { ...core.r.deadline! };
    // Four seconds of thinking, then an ad of a minute.
    clock.t = Math.max(clock.t, dl.since) + 4_000;
    const left = dl.at! - clock.t;
    const seq = core.r.seq;
    expect(core.handle('dev-a', { t: 'hold', on: true })).toEqual({ ok: true });
    expect(core.r.seq).toBe(seq + 1);
    expect(core.r.deadline!.at).toBeNull();
    expect(core.gameMessage(0)).toMatchObject({ seq: seq + 1, deadline: { seat: 0, at: null } });
    // A second "on" changes nothing.
    expect(core.handle('dev-a', { t: 'hold', on: true })).toEqual({ ok: true });
    expect(core.r.seq).toBe(seq + 1);
    clock.t += 60_000;
    expect(core.handle('dev-a', { t: 'hold', on: false })).toEqual({ ok: true });
    expect(core.r.seq).toBe(seq + 2);
    expect(core.r.deadline!.at! - clock.t).toBe(left);
    expect(core.gameMessage(0)).toMatchObject({ deadline: { seat: 0, at: clock.t + left } });
    // An "off" with nothing held changes nothing.
    expect(core.handle('dev-a', { t: 'hold', on: false })).toEqual({ ok: true });
    expect(core.r.seq).toBe(seq + 2);
    clock.t += 2_000;
    expect(core.handle('dev-a', { t: 'act', seq: core.r.seq, a: card(core) }).ok).toBe(true);
    expect(d.decisions.find((r) => r.seat === 0)).toMatchObject({ auto: false, decisionMs: 6_000 });
  });

  it('a hold while the display offset still runs keeps that offset; past 150 s the rest counts as decision time', () => {
    const clock = { t: 2_000_000 };
    const { core, d } = soloWaiting(42, clock);
    // The person's clock starts 1.6 s from now (the next hand is still being shown).
    core.r.deadline = { seat: 0, since: clock.t + 1_600, at: clock.t + 1_600 + 30_000 };
    expect(core.handle('dev-a', { t: 'hold', on: true }).ok).toBe(true);
    clock.t += 200_000;
    expect(core.handle('dev-a', { t: 'hold', on: false }).ok).toBe(true);
    expect(core.r.deadline).toMatchObject({ seat: 0, since: clock.t + 1_600, at: clock.t + 1_600 + 30_000 });
    clock.t += 1_600 + 1_000;
    expect(core.handle('dev-a', { t: 'act', seq: core.r.seq, a: card(core) }).ok).toBe(true);
    // 50 s of the hold past the free 150 s, plus 1 s of thinking.
    expect(d.decisions.find((r) => r.seat === 0)?.decisionMs).toBe(51_000);
  });

  it('a move made while held starts the clock again first; dropping meanwhile adds nothing', () => {
    const clock = { t: 3_000_000 };
    const { core, d } = soloWaiting(43, clock);
    const dl = { ...core.r.deadline! };
    clock.t = Math.max(clock.t, dl.since) + 3_000;
    expect(core.handle('dev-a', { t: 'hold', on: true }).ok).toBe(true);
    clock.t += 10_000;
    core.disconnect('dev-a');
    clock.t += 5_000;
    core.connect('dev-a');
    expect(core.r.deadline!.held).toBeDefined();
    clock.t += 5_000;
    expect(core.handle('dev-a', { t: 'act', seq: core.r.seq, a: card(core) }).ok).toBe(true);
    expect(d.decisions.find((r) => r.seat === 0)?.decisionMs).toBe(3_000);
  });

  it('hold outside quick play answers bad_message; only a seated person may hold', () => {
    const clock = { t: 4_000_000 };
    const { core } = roomOfTwo(44, clock, { turnSeconds: 30 });
    expect(core.handle(dev('a'), { t: 'hold', on: true })).toEqual({ ok: false, code: 'bad_message' });
    const solo = soloWaiting(45, clock).core;
    expect(solo.handle('dev-x', { t: 'hold', on: true })).toEqual({ ok: false, code: 'not_seated' });
  });

  it('the message carries a boolean "on"', () => {
    expect(parseClientMsg('{"t":"hold","on":true}')).toEqual({ t: 'hold', on: true });
    expect(parseClientMsg('{"t":"hold","on":false}')).toEqual({ t: 'hold', on: false });
    expect(parseClientMsg('{"t":"hold"}')).toBeNull();
    expect(parseClientMsg('{"t":"hold","on":"yes"}')).toBeNull();
  });
});


describe("quick play's first connection (the deal made with the room)", () => {
  for (const players of [2, 4] as const) {
    it(`${players} players: the first game message starts with the deal, then the AI's opening moves`, () => {
      for (let seed = 60; seed < 66; seed++) {
        const core = RoomCore.create('SOLOD', defaultSettings({ players, opponents: [...DEFAULT_OPPONENTS[players]] }), 'dev-a', true, 'v1', deps(seed));
        // The Durable Object drops what the creation produced: nobody was connected to hear it.
        core.clearPending();
        expect(core.connect('dev-a')).toBe(true);
        const msg = core.gameMessage(0);
        if (!msg || msg.t !== 'game') throw new Error('no game message');
        expect(msg.events[0]).toEqual({ at: 0, e: expect.objectContaining({ t: 'deal', hand: 0, vira: core.match!.hand.vira }) });
        expect(msg.events.filter((te) => te.e.t === 'deal')).toHaveLength(1);
        for (const te of msg.events.slice(1)) {
          if (te.e.t !== 'signal') expect(te.at).toBeGreaterThanOrEqual(700);
        }
        // The deadline counts from the last offset shown, so the person's turn starts with the whole time.
        if (core.r.deadline?.seat === 0) expect(core.r.deadline.since).toBe(core.r.lastActivity + (msg.events.at(-1)?.at ?? 0));
        core.clearPending();
        // Coming back later never deals again.
        core.disconnect('dev-a');
        core.connect('dev-a');
        expect(core.pending.some((te) => te.e.t === 'deal')).toBe(false);
      }
    });
  }

  it('a person who connects after the first move gets no deal', () => {
    const core = RoomCore.create('SOLOE', defaultSettings({ players: 2, opponents: ['zap'] }), 'dev-a', true, 'v1', deps(61));
    core.clearPending();
    core.r.match!.log.push(0);
    core.connect('dev-a');
    expect(core.pending.some((te) => te.e.t === 'deal')).toBe(false);
  });
});

describe('quick play lineups and the random switches (M15)', () => {
  /** Plays the person's seat (dev-a, seat 0) with random legal moves until the match ends. */
  function finish(core: RoomCore, clock: { t: number }, seed: number): void {
    const rand = mulberry32(seed);
    for (let guard = 0; core.r.status === 'playing' && guard < 5000; guard++) {
      const d = core.r.deadline;
      if (!d || d.seat !== 0) {
        clock.t = Math.max(clock.t, core.nextAlarm() ?? clock.t) + 1;
        core.alarm();
        continue;
      }
      clock.t = Math.max(clock.t, d.since) + 500;
      const mask = legalMask(core.match!, 0);
      const acts = [...Array(15).keys()].filter((a) => mask & (1 << a));
      core.handle('dev-a', { t: 'act', seq: core.r.seq, a: acts[Math.floor(rand() * acts.length)] });
    }
    expect(core.r.status).toBe('ended');
  }

  const lineupOf = (core: RoomCore) => core.r.seats.map((s) => s.persona).join(',');

  /** The characters at the table are the settings' lineup: opponents on seats 1 and 3, the partner on seat 2. */
  function expectLineup(core: RoomCore): void {
    const s = core.r.settings;
    expect(validateSettings(s)).toBeNull();
    const p = core.r.seats.map((x) => x.persona);
    if (s.players === 2) expect(p).toEqual([null, ...s.opponents]);
    else expect(p).toEqual([null, s.opponents[0], s.partner, s.opponents[1]]);
  }

  it('validateSettings refuses lineups a table cannot play and switches where they mean nothing', () => {
    const cases: [Partial<RoomSettings>, string][] = [
      [{ players: 4, opponents: ['zap'] }, 'opponents'],
      [{ players: 2, opponents: ['zap', 'lia'] }, 'opponents'],
      [{ opponents: ['zap', 'zap'] }, 'opponents'],
      [{ opponents: ['zap', 'iara'], partner: 'iara' }, 'partner'],
      [{ players: 2, randomPartner: true }, 'random'],
      [{ mode: 'room', randomOpponents: true }, 'random'],
      [{ mode: 'room', randomPartner: true }, 'random'],
      [{ randomOpponents: 'yes' as unknown as boolean }, 'random'],
    ];
    for (const [over, err] of cases) {
      expect(validateSettings(defaultSettings(over)), JSON.stringify(over)).toBe(err);
      expect(() => RoomCore.create('BADST', defaultSettings(over), 'dev-a', true, 'v1', deps())).toThrow(`bad settings: ${err}`);
    }
  });

  it('defaultSettings fits the table size, keeps both switches off and never seats the partner among the opponents', () => {
    for (const s of [defaultSettings(), defaultSettings({ players: 2 }), defaultSettings({ mode: 'room' }), defaultSettings({ mode: 'room', players: 2 })]) {
      expect(validateSettings(s)).toBeNull();
      expect([s.randomOpponents, s.randomPartner]).toEqual([false, false]);
    }
    expect(defaultSettings({ players: 2 }).opponents).toEqual(['zap']);
    expect(defaultSettings()).toMatchObject({ opponents: ['zap', 'lia'], partner: 'iara' });
    expect(defaultSettings({ opponents: ['zap', 'iara'] }).partner).toBe('lia');
  });

  it('with both switches off the room plays the lineup it was given', () => {
    const core = RoomCore.create('SWOFF', defaultSettings({ opponents: ['bento', 'ravi'], partner: 'otavio' }), 'dev-a', true, 'v1', deps(70));
    expect(core.r.settings).toMatchObject({ randomOpponents: false, randomPartner: false, opponents: ['bento', 'ravi'], partner: 'otavio' });
    expect(lineupOf(core)).toBe(',bento,otavio,ravi');
  });

  it('"Time" on at creation draws the partner for the first deal: never an opponent, the opponents as chosen', () => {
    const partners = new Set<string>();
    for (let seed = 0; seed < 20; seed++) {
      const settings = defaultSettings({ opponents: ['zap', 'iara'], partner: 'lia', randomPartner: true });
      const core = RoomCore.create('DRAWP', settings, 'dev-a', true, 'v1', deps(100 + seed));
      expectLineup(core);
      expect(core.r.settings.opponents).toEqual(['zap', 'iara']);
      expect(['otavio', 'bento', 'lia', 'ravi']).toContain(core.r.seats[2].persona);
      // The room draws into its own copy; the caller's settings stay as they were.
      expect(settings.partner).toBe('lia');
      partners.add(core.r.settings.partner);
    }
    expect(partners.size).toBeGreaterThan(1);
  });

  it('a rematch with both switches on draws a valid lineup each time, and the lineup changes', () => {
    let changed = 0;
    for (let seed = 0; seed < 20; seed++) {
      const clock = { t: 1_000_000 };
      const core = RoomCore.create('DRAWB', defaultSettings({ opponents: ['zap', 'iara'] }), 'dev-a', true, 'v1', deps(200 + seed, clock));
      core.connect('dev-a');
      const before = lineupOf(core);
      finish(core, clock, seed);
      expect(core.handle('dev-a', { t: 'rematch', randomOpponents: true, randomPartner: true }).ok).toBe(true);
      expect(core.r.settings).toMatchObject({ randomOpponents: true, randomPartner: true });
      expect(core.r.matchNo).toBe(2);
      expectLineup(core);
      if (lineupOf(core) !== before) changed++;
    }
    expect(changed).toBeGreaterThan(0);
  });

  it('switches off at the rematch repeat the lineup just played, also a drawn one, and an older page keeps them off', () => {
    const clock = { t: 1_000_000 };
    const core = RoomCore.create('REPEA', defaultSettings({ opponents: ['zap', 'iara'], randomOpponents: true, randomPartner: true }), 'dev-a', true, 'v1', deps(300, clock));
    core.connect('dev-a');
    expectLineup(core);
    const played = { opponents: [...core.r.settings.opponents], partner: core.r.settings.partner };
    const seats = lineupOf(core);
    finish(core, clock, 1);
    expect(core.handle('dev-a', { t: 'rematch', randomOpponents: false, randomPartner: false }).ok).toBe(true);
    expect(core.r.settings).toMatchObject({ ...played, randomOpponents: false, randomPartner: false });
    expect(lineupOf(core)).toBe(seats);
    finish(core, clock, 2);
    expect(core.handle('dev-a', { t: 'rematch' }).ok).toBe(true);
    expect(core.r.settings).toMatchObject({ ...played, randomOpponents: false, randomPartner: false });
    expect(lineupOf(core)).toBe(seats);
    expect(core.r.matchNo).toBe(3);
  });

  it('a rematch without fields keeps the switches that are on', () => {
    const clock = { t: 1_000_000 };
    const core = RoomCore.create('KEEPS', defaultSettings({ players: 2, opponents: ['zap'], randomOpponents: true }), 'dev-a', true, 'v1', deps(310, clock));
    core.connect('dev-a');
    const seen = new Set([core.r.settings.opponents[0]]);
    for (let i = 0; i < 6; i++) {
      finish(core, clock, 10 + i);
      expect(core.handle('dev-a', { t: 'rematch' }).ok).toBe(true);
      expect(core.r.settings.randomOpponents).toBe(true);
      expectLineup(core);
      seen.add(core.r.settings.opponents[0]);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('"Time" sent with two players is stored off', () => {
    const clock = { t: 1_000_000 };
    const core = RoomCore.create('TWOPL', defaultSettings({ players: 2, opponents: ['lia'] }), 'dev-a', true, 'v1', deps(320, clock));
    core.connect('dev-a');
    finish(core, clock, 3);
    expect(core.handle('dev-a', { t: 'rematch', randomOpponents: false, randomPartner: true }).ok).toBe(true);
    expect(core.r.settings).toMatchObject({ randomOpponents: false, randomPartner: false, opponents: ['lia'] });
    expect(validateSettings(core.r.settings)).toBeNull();
  });

  it('a refused rematch leaves the settings, the switches and the status as they were', () => {
    const clock = { t: 1_000_000 };
    const core = RoomCore.create('REFUS', defaultSettings({ opponents: ['zap', 'iara'] }), 'dev-a', true, 'v1', deps(330, clock));
    core.connect('dev-a');
    finish(core, clock, 4);
    const before = JSON.stringify(core.r.settings);
    const msg = { t: 'rematch', randomOpponents: true, randomPartner: true } as const;
    expect(core.handle('dev-a', msg, { mayStartMatch: false })).toEqual({ ok: false, code: 'check_needed' });
    expect(JSON.stringify(core.r.settings)).toBe(before);
    expect(core.r.status).toBe('ended');
    // A start refused after the switches were written (forced here: quick play has no such case
    // today) puts them back with the status.
    core.r.closed = true;
    expect(core.handle('dev-a', msg)).toEqual({ ok: false, code: 'not_in_lobby' });
    expect(JSON.stringify(core.r.settings)).toBe(before);
    expect(core.r.status).toBe('ended');
    expect(core.r.matchNo).toBe(1);
  });

  it('a quick play room stored before the switches loads with both off, as does one with a lineup the new rules refuse', () => {
    const clock = { t: 1_000_000 };
    const core = RoomCore.create('OLDSW', defaultSettings({ opponents: ['zap', 'bento'] }), 'dev-a', true, 'v1', deps(340, clock));
    const stored = JSON.parse(JSON.stringify(core.r));
    delete stored.settings.randomOpponents;
    delete stored.settings.randomPartner;
    const loaded = new RoomCore(stored, deps(340, clock));
    expect(loaded.r.settings).toMatchObject({ randomOpponents: false, randomPartner: false });
    loaded.connect('dev-a');
    finish(loaded, clock, 5);
    expect(loaded.handle('dev-a', { t: 'rematch' }).ok).toBe(true);
    expect(lineupOf(loaded)).toBe(',zap,iara,bento');
    // Older code took one opponent for both seats; such a room still loads and plays its rematch.
    const legacy = JSON.parse(JSON.stringify(loaded.r));
    delete legacy.settings.randomOpponents;
    delete legacy.settings.randomPartner;
    legacy.settings.opponents = ['zap'];
    const old = new RoomCore(legacy, deps(341, clock));
    finish(old, clock, 6);
    expect(old.handle('dev-a', { t: 'rematch' }).ok).toBe(true);
    expect(lineupOf(old)).toBe(',zap,iara,zap');
  });

  it('rooms with friends ignore the switches of a rematch', () => {
    const clock = { t: 1_000_000 };
    const core = RoomCore.create('ROOMS', defaultSettings({ mode: 'room', players: 2, opponents: ['lia'] }), 'dev-a', true, 'v1', deps(350, clock));
    core.connect('dev-a');
    expect(core.handle('dev-a', { t: 'start' }).ok).toBe(true);
    finish(core, clock, 7);
    expect(core.handle('dev-a', { t: 'rematch', randomOpponents: true, randomPartner: true }).ok).toBe(true);
    expect(core.r.settings).toMatchObject({ randomOpponents: false, randomPartner: false, opponents: ['lia'] });
    // The person's seat holds a hidden fallback in a room (M15 seat plan); the table shows none.
    expect(core.publicRoom().seats.map((s) => s.persona)).toEqual([null, 'lia']);
  });

  it('every room says what its code can do: setup 2', () => {
    expect(RoomCore.create('SETUP', defaultSettings(), 'dev-a', true, 'v1', deps()).publicRoom().setup).toBe(2);
    expect(RoomCore.create('SETUQ', defaultSettings({ mode: 'room' }), 'dev-a', true, 'v1', deps()).publicRoom().setup).toBe(2);
  });

  it('the rematch message keeps boolean switches, drops unknown fields and refuses anything else', () => {
    expect(parseClientMsg('{"t":"rematch"}')).toEqual({ t: 'rematch' });
    expect(parseClientMsg('{"t":"rematch","randomOpponents":true,"randomPartner":false}')).toEqual({ t: 'rematch', randomOpponents: true, randomPartner: false });
    expect(parseClientMsg('{"t":"rematch","randomPartner":true,"extra":1}')).toEqual({ t: 'rematch', randomPartner: true });
    expect(parseClientMsg('{"t":"rematch","randomOpponents":"yes"}')).toBeNull();
    expect(parseClientMsg('{"t":"rematch","randomPartner":null}')).toBeNull();
    expect(parseClientMsg('{"t":"rematch","randomOpponents":1}')).toBeNull();
    expect(parseClientMsg('{"t":"start","randomOpponents":true}')).toEqual({ t: 'start' });
  });
});
