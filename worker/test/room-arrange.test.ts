// The arrangement of a room with friends (M15): the seat plan that stays with each seat position,
// the owner's move, plan and lobby messages, who leads after a match (the owner, or anyone seated
// while the owner is away, presence.ts included), people carried into a match while away, and rooms
// stored before the plan. RoomCore only; the Durable Object passes these messages through as it
// does sit.

import { describe, expect, it } from 'vitest';
import { deriveSeed, mulberry32 } from '../../engine/src/rng.ts';
import { A_SIGNAL0, SIGNAL_MASK, legalMask } from '../../engine/src/engine.ts';
import { HeuristicAgent } from '../../ai/src/heuristic.ts';
import { PERSONAS } from '../../ai/src/personas.ts';
import { parseClientMsg, type ClientMsg, type RoomSettings } from '../../shared/protocol.ts';
import { DEFAULT_ROOM_OPPONENTS, PERSONA_ORDER } from '../../shared/lineup.ts';
import { ABANDON_AFTER_MS, RECONNECT_GRACE_MS, RoomCore, defaultSettings, type RoomDeps, type StoredRoom } from '../src/room-core.ts';
import { CLOSE_SILENT, SILENT_MS, checkOwner, nextOwnerCheck } from '../src/presence.ts';

type TestDeps = RoomDeps & { clock: { t: number }; abandoned: string[]; starts: string[][] };

function deps(seed = 1, clock = { t: 1_000_000 }): TestDeps {
  let k = 0;
  const abandoned: string[] = [];
  const starts: string[][] = [];
  return {
    clock,
    abandoned,
    starts,
    now: () => clock.t,
    randomSeed: () => deriveSeed('ce'.repeat(32), 15, seed * 1000 + k++),
    agentFor: () => new HeuristicAgent(),
    rand: mulberry32(seed),
    onAbandon: (d) => abandoned.push(d),
    onMatchStart: (devices) => starts.push(devices),
  };
}

const dev = (c: string) => c.repeat(64);
const A = dev('a');
const B = dev('b');
const C = dev('c');

/** A room with friends owned by A, connected, in its first lobby. */
function room(over: Partial<RoomSettings> = {}, seed = 1, clock = { t: 1_000_000 }) {
  const d = deps(seed, clock);
  const core = RoomCore.create('ARRNG', defaultSettings({ mode: 'room', ...over }), A, true, 'v1', d);
  core.connect(A);
  return { core, d };
}

/** A and B (connected) in a room; B on seat 1. */
function roomWithB(over: Partial<RoomSettings> = {}, seed = 1, clock = { t: 1_000_000 }) {
  const r = room(over, seed, clock);
  expect(r.core.join(B, true)).toEqual({ seat: 1 });
  r.core.connect(B);
  return r;
}

const stored = (core: RoomCore) => core.r.seats.map((s) => s.persona);
const shown = (core: RoomCore) => core.publicRoom().seats.map((s) => s.persona);
const kinds = (core: RoomCore) => core.r.seats.map((s) => s.kind);
const msg = (core: RoomCore, device: string, m: ClientMsg) => core.handle(device, m);

/** P1: every seat of a room holds a character, all different. */
function expectP1(core: RoomCore): void {
  const p = stored(core);
  expect(p.every((x) => x !== null), JSON.stringify(p)).toBe(true);
  expect(new Set(p).size, JSON.stringify(p)).toBe(p.length);
}

/** Plays random legal moves for the connected people at the table (and lets the alarm act) until the match ends. */
function playOut(core: RoomCore, d: TestDeps, seed = 5): void {
  const rand = mulberry32(seed);
  for (let guard = 0; core.r.status === 'playing' && guard < 5000; guard++) {
    const people = core.r.seats.flatMap((s, i) => (s.kind === 'human' && s.device && s.connected && !s.takeover ? [i] : []));
    const movers = people.filter((i) => (legalMask(core.match!, i) & ~SIGNAL_MASK) !== 0);
    if (movers.length === 0) {
      d.clock.t = Math.max(d.clock.t, core.nextAlarm() ?? d.clock.t) + 1;
      core.alarm();
      continue;
    }
    const i = movers[Math.floor(rand() * movers.length)];
    const acts = [...Array(A_SIGNAL0).keys()].filter((a) => legalMask(core.match!, i) & (1 << a));
    d.clock.t += 500;
    core.handle(core.r.seats[i].device!, { t: 'act', seq: core.r.seq, a: acts[Math.floor(rand() * acts.length)] });
  }
  expect(core.r.status).toBe('ended');
}

/** A and B played a match; A took the room back to the lobby ("Mudar a mesa"). */
function postMatchLobby(over: Partial<RoomSettings> = {}, seed = 1, clock = { t: 1_000_000 }) {
  const r = roomWithB(over, seed, clock);
  expect(msg(r.core, A, { t: 'start' }).ok).toBe(true);
  playOut(r.core, r.d, seed);
  expect(msg(r.core, A, { t: 'lobby' }).ok).toBe(true);
  return r;
}

describe('the seat plan of a room', () => {
  it('a new room plans its seats: Iara, Lia and Zap by default, the owner hiding a free character', () => {
    const four = room({ opponents: [...DEFAULT_ROOM_OPPONENTS[4]], partner: 'lia' }).core;
    expect(stored(four)).toEqual(['ravi', 'iara', 'lia', 'zap']);
    expect(shown(four)).toEqual([null, 'iara', 'lia', 'zap']);
    expect(kinds(four)).toEqual(['human', 'empty', 'empty', 'empty']);
    const two = room({ players: 2, opponents: [...DEFAULT_ROOM_OPPONENTS[2]] }).core;
    expect(stored(two)).toEqual(['iara', 'zap']);
    expect(shown(two)).toEqual([null, 'zap']);
    // An older page still sends a lineup: the plan is what today's start gives the owner alone at seat 0.
    const old = room({ opponents: ['zap', 'bento'], partner: 'iara' }).core;
    expect(stored(old)).toEqual(['lia', 'zap', 'iara', 'bento']);
    expect(msg(old, A, { t: 'start' }).ok).toBe(true);
    expect(stored(old)).toEqual(['lia', 'zap', 'iara', 'bento']);
    expect(kinds(old)).toEqual(['human', 'ai', 'ai', 'ai']);
    for (const core of [four, two, old]) expectP1(core);
  });

  it('people move without the characters: a friend who joins and sits elsewhere leaves the first seat its character', () => {
    // The sequence of tests/integration/match.test.ts "two partners in a 2 against 2 room".
    const { core } = room({ opponents: ['lia', 'ravi'], partner: 'iara' });
    expect(stored(core)).toEqual(['bento', 'lia', 'iara', 'ravi']);
    expect(core.join(B, true)).toEqual({ seat: 1 });
    core.connect(B);
    expect(shown(core)).toEqual([null, null, 'iara', 'ravi']);
    expect(msg(core, B, { t: 'sit', seat: 2 }).ok).toBe(true);
    expect(shown(core)).toEqual([null, 'lia', null, 'ravi']);
    expect(stored(core)).toEqual(['bento', 'lia', 'iara', 'ravi']);
    expect(msg(core, A, { t: 'start' }).ok).toBe(true);
    expect(kinds(core)).toEqual(['human', 'ai', 'human', 'ai']);
    expect([core.r.seats[1].persona, core.r.seats[3].persona]).toEqual(['lia', 'ravi']);
    expect(core.r.seats[1].name).toBe('Lia');
    expectP1(core);
  });

  it('leaving, a drop in the first lobby and a deletion free the seat with its character', () => {
    const { core } = roomWithB();
    const plan = stored(core);
    expect(msg(core, B, { t: 'leave' }).ok).toBe(true);
    expect(stored(core)).toEqual(plan);
    expect(core.join(B, true)).toEqual({ seat: 1 });
    core.connect(B);
    core.disconnect(B);
    expect(core.seatOf(B)).toBe(-1);
    expect(stored(core)).toEqual(plan);
    core.join(B, true);
    expect(core.forget(B)).toBe(true);
    expect(stored(core)).toEqual(plan);
    expect(shown(core)).toEqual([null, ...plan.slice(1)]);
  });
});

describe('move: the owner swaps two seats', () => {
  it('owner only, lobby only, rooms only, seats of the table only', () => {
    const { core, d } = roomWithB({ players: 4 });
    expect(msg(core, B, { t: 'move', from: 0, to: 2 })).toEqual({ ok: false, code: 'not_owner' });
    expect(msg(core, A, { t: 'move', from: 1, to: 1 })).toEqual({ ok: false, code: 'bad_message' });
    expect(msg(core, A, { t: 'start' }).ok).toBe(true);
    expect(msg(core, A, { t: 'move', from: 0, to: 2 })).toEqual({ ok: false, code: 'not_in_lobby' });
    expect(msg(core, B, { t: 'move', from: 0, to: 2 })).toEqual({ ok: false, code: 'not_owner' });
    playOut(core, d);
    expect(msg(core, A, { t: 'move', from: 0, to: 2 })).toEqual({ ok: false, code: 'not_in_lobby' });
    const two = room({ players: 2, opponents: ['zap'] }).core;
    expect(msg(two, A, { t: 'move', from: 0, to: 2 })).toEqual({ ok: false, code: 'bad_message' });
    expect(msg(two, A, { t: 'plan', seat: 3, ai: 'lia' })).toEqual({ ok: false, code: 'bad_message' });
    const solo = RoomCore.create('SOLOM', defaultSettings({ players: 4 }), A, true, 'v1', deps());
    for (const m of [{ t: 'move', from: 0, to: 1 }, { t: 'plan', seat: 1, ai: 'lia' }, { t: 'lobby' }] as ClientMsg[]) {
      expect(solo.handle(A, m), JSON.stringify(m)).toEqual({ ok: false, code: 'bad_message' });
    }
  });

  it('people swap and each position keeps its character; an AI moves with its own', () => {
    const { core } = roomWithB({ opponents: ['zap', 'lia'], partner: 'iara' });
    const plan = stored(core);
    // Person and person.
    expect(msg(core, A, { t: 'move', from: 0, to: 1 }).ok).toBe(true);
    expect([core.seatOf(A), core.seatOf(B)]).toEqual([1, 0]);
    expect(stored(core)).toEqual(plan);
    // Person and free seat.
    expect(msg(core, A, { t: 'move', from: 0, to: 2 }).ok).toBe(true);
    expect(core.seatOf(B)).toBe(2);
    expect(kinds(core)).toEqual(['empty', 'human', 'human', 'empty']);
    expect(stored(core)).toEqual(plan);
    expect(shown(core)).toEqual([plan[0], null, null, plan[3]]);
    // Person and AI: the whole seats swap, the AI keeps its character.
    expect(msg(core, A, { t: 'plan', seat: 3, ai: 'otavio' }).ok).toBe(true);
    const hiddenB = core.r.seats[2].persona;
    expect(msg(core, A, { t: 'move', from: 2, to: 3 }).ok).toBe(true);
    expect(core.seatOf(B)).toBe(3);
    expect(core.r.seats[2]).toMatchObject({ kind: 'ai', persona: 'otavio', name: 'Otávio' });
    expect(core.r.seats[3].persona).toBe(hiddenB);
    // The page moves only people: a move from an AI's seat or a free one changes nothing.
    const before = JSON.stringify(core.r);
    expect(msg(core, A, { t: 'move', from: 2, to: 0 })).toEqual({ ok: false, code: 'seat_taken' });
    expect(msg(core, A, { t: 'move', from: 0, to: 2 })).toEqual({ ok: false, code: 'seat_taken' });
    expect(JSON.stringify(core.r)).toBe(before);
    expectP1(core);
    expect(core.r.owner).toBe(A);
    expect(core.roomMessage(A)).toMatchObject({ you: 1, owner: true });
  });

  it('a move from a seat without a person comes from an older view: seat_taken, and nothing changes', () => {
    const { core } = roomWithB();
    const seq = core.r.seq;
    const before = JSON.stringify(core.r);
    expect(msg(core, A, { t: 'move', from: 2, to: 3 })).toEqual({ ok: false, code: 'seat_taken' });
    expect(core.r.seq).toBe(seq);
    expect(JSON.stringify(core.r)).toBe(before);
    // An effective one bumps the sequence and forgets the phrase timing of both seats.
    expect(msg(core, B, { t: 'phrase', key: 'boa' }).ok).toBe(true);
    expect(msg(core, A, { t: 'move', from: 1, to: 2 }).ok).toBe(true);
    expect(core.r.seq).toBe(seq + 1);
    expect(core.r.phraseAt).toEqual({});
  });

  it('the owner can move themself, also after a match, and a friend away keeps the seat they were moved to', () => {
    const { core } = postMatchLobby();
    core.disconnect(B);
    expect(msg(core, A, { t: 'move', from: 0, to: 3 }).ok).toBe(true);
    expect(msg(core, A, { t: 'move', from: 1, to: 2 }).ok).toBe(true);
    expect([core.seatOf(A), core.seatOf(B)]).toEqual([3, 2]);
    expect(core.r.seats[2].connected).toBe(false);
    expectP1(core);
  });

  it('a friend who sits first wins against the owner\'s move of the same friend (spec 4.6)', () => {
    const { core } = roomWithB();
    // B sits on seat 2; the owner's move of B from seat 1 to seat 2, built before that, lands after.
    expect(msg(core, B, { t: 'sit', seat: 2 }).ok).toBe(true);
    const before = JSON.stringify(core.r);
    expect(msg(core, A, { t: 'move', from: 1, to: 2 })).toEqual({ ok: false, code: 'seat_taken' });
    expect(core.seatOf(B)).toBe(2);
    expect(JSON.stringify(core.r)).toBe(before);
    expectP1(core);
  });

  it('two moves sent together from one view: the second, whose seat changed, moves no AI', () => {
    const { core } = roomWithB({ opponents: ['zap', 'lia'], partner: 'iara' });
    expect(msg(core, A, { t: 'plan', seat: 2, ai: 'bento' }).ok).toBe(true);
    // The owner put B on seat 2 and then on seat 3, both read from B on seat 1.
    expect(msg(core, A, { t: 'move', from: 1, to: 2 }).ok).toBe(true);
    expect(core.r.seats[1]).toMatchObject({ kind: 'ai', persona: 'bento' });
    expect(msg(core, A, { t: 'move', from: 1, to: 3 })).toEqual({ ok: false, code: 'seat_taken' });
    expect(core.seatOf(B)).toBe(2);
    expect(core.r.seats[1]).toMatchObject({ kind: 'ai', persona: 'bento' });
    expect(core.r.seats[3].kind).toBe('empty');
    expectP1(core);
  });
});

describe('plan: the owner chooses who sits in a seat without a connected person', () => {
  it('reserves an AI, opens the seat again keeping the character, and a repeat changes nothing', () => {
    const { core } = roomWithB({ opponents: ['zap', 'lia'], partner: 'iara' });
    expect(msg(core, B, { t: 'plan', seat: 2, ai: 'ravi' })).toEqual({ ok: false, code: 'not_owner' });
    expect(msg(core, A, { t: 'plan', seat: 2, ai: 'bento' }).ok).toBe(true);
    expect(core.r.seats[2]).toMatchObject({ kind: 'ai', persona: 'bento', name: 'Bento', connected: true, device: null });
    expect(core.publicRoom().seats[2]).toMatchObject({ kind: 'ai', persona: 'bento', connected: true });
    const seq = core.r.seq;
    expect(msg(core, A, { t: 'plan', seat: 2, ai: 'bento' })).toEqual({ ok: true });
    expect(core.r.seq).toBe(seq);
    expect(msg(core, A, { t: 'plan', seat: 2, ai: null }).ok).toBe(true);
    expect(core.r.seats[2]).toMatchObject({ kind: 'empty', persona: 'bento' });
    expect(core.r.seq).toBe(seq + 1);
    expect(msg(core, A, { t: 'plan', seat: 2, ai: null })).toEqual({ ok: true });
    expect(core.r.seq).toBe(seq + 1);
    expectP1(core);
  });

  it('a character planned elsewhere swaps with this seat, also a person\'s hidden one', () => {
    const { core } = roomWithB({ opponents: ['zap', 'lia'], partner: 'iara' });
    // ['ravi' (A), 'zap' (B), 'iara', 'lia']
    expect(stored(core)).toEqual(['ravi', 'zap', 'iara', 'lia']);
    expect(msg(core, A, { t: 'plan', seat: 2, ai: 'lia' }).ok).toBe(true);
    expect(stored(core)).toEqual(['ravi', 'zap', 'lia', 'iara']);
    expect(shown(core)).toEqual([null, null, 'lia', 'iara']);
    // Zap is B's hidden fallback: seat 3 takes it, B's seat keeps seat 3's old one, still hidden.
    expect(msg(core, A, { t: 'plan', seat: 3, ai: 'zap' }).ok).toBe(true);
    expect(stored(core)).toEqual(['ravi', 'iara', 'lia', 'zap']);
    expect(shown(core)).toEqual([null, null, 'lia', 'zap']);
    // The owner's own hidden one too.
    expect(msg(core, A, { t: 'plan', seat: 3, ai: 'ravi' }).ok).toBe(true);
    expect(stored(core)).toEqual(['zap', 'iara', 'lia', 'ravi']);
    expectP1(core);
  });

  it('never takes the owner\'s seat or a connected person\'s; an unknown character is a bad message', () => {
    const { core } = roomWithB();
    expect(msg(core, A, { t: 'plan', seat: 0, ai: 'lia' })).toEqual({ ok: false, code: 'seat_taken' });
    expect(msg(core, A, { t: 'plan', seat: 0, ai: null })).toEqual({ ok: false, code: 'seat_taken' });
    expect(msg(core, A, { t: 'plan', seat: 1, ai: 'lia' })).toEqual({ ok: false, code: 'seat_taken' });
    expect(msg(core, A, { t: 'plan', seat: 1, ai: null })).toEqual({ ok: false, code: 'seat_taken' });
    expect(msg(core, A, { t: 'plan', seat: 2, ai: 'nobody' })).toEqual({ ok: false, code: 'bad_message' });
    expect(msg(core, A, { t: 'plan', seat: 4, ai: 'lia' })).toEqual({ ok: false, code: 'bad_message' });
    expect(core.seatOf(B)).toBe(1);
  });

  it('after a match, someone away can be taken out of the seat; their data then finds no seat', () => {
    const { core } = postMatchLobby({ opponents: ['zap', 'lia'], partner: 'iara' });
    core.disconnect(B);
    expect(core.seatOf(B)).toBe(1);
    const hidden = core.r.seats[1].persona;
    expect(msg(core, A, { t: 'plan', seat: 1, ai: null }).ok).toBe(true);
    expect(core.seatOf(B)).toBe(-1);
    expect(core.r.seats[1]).toMatchObject({ kind: 'empty', persona: hidden, device: null });
    expect(core.forget(B)).toBe(false);
    expect(JSON.stringify(core.r)).not.toContain(B);
    // The same with a character.
    const other = postMatchLobby({ opponents: ['zap', 'lia'], partner: 'iara' }, 2).core;
    other.disconnect(B);
    expect(msg(other, A, { t: 'plan', seat: 1, ai: 'otavio' }).ok).toBe(true);
    expect(other.seatOf(B)).toBe(-1);
    expect(other.r.seats[1]).toMatchObject({ kind: 'ai', persona: 'otavio' });
    expectP1(other);
  });

  it('parses only well formed arrangement messages', () => {
    expect(parseClientMsg('{"t":"lobby"}')).toEqual({ t: 'lobby' });
    expect(parseClientMsg('{"t":"lobby","x":1}')).toEqual({ t: 'lobby' });
    expect(parseClientMsg('{"t":"move","from":1,"to":2}')).toEqual({ t: 'move', from: 1, to: 2 });
    expect(parseClientMsg('{"t":"plan","seat":3,"ai":"lia"}')).toEqual({ t: 'plan', seat: 3, ai: 'lia' });
    expect(parseClientMsg('{"t":"plan","seat":3,"ai":null}')).toEqual({ t: 'plan', seat: 3, ai: null });
    for (const bad of [
      '{"t":"move","from":1,"to":1}',
      '{"t":"move","from":1}',
      '{"t":"move","from":-1,"to":2}',
      '{"t":"move","from":1,"to":4}',
      '{"t":"move","from":"1","to":2}',
      '{"t":"move","from":0.5,"to":2}',
      '{"t":"plan","seat":3}',
      '{"t":"plan","seat":4,"ai":"lia"}',
      '{"t":"plan","seat":3,"ai":"Lia"}',
      '{"t":"plan","seat":3,"ai":"l"}',
      '{"t":"plan","seat":3,"ai":"abcdefghi"}',
      '{"t":"plan","seat":3,"ai":1}',
      '{"t":"plan","seat":3,"ai":"li a"}',
    ]) {
      expect(parseClientMsg(bad), bad).toBeNull();
    }
    // Every one of them stays far below the size limit.
    expect(JSON.stringify({ t: 'plan', seat: 3, ai: 'otavio' }).length).toBeLessThan(100);
  });
});

describe('lobby: "Mudar a mesa" after a match', () => {
  it('owner only, only after a match, rooms only', () => {
    const { core, d } = roomWithB();
    expect(msg(core, A, { t: 'lobby' })).toEqual({ ok: false, code: 'not_ended' });
    expect(msg(core, A, { t: 'start' }).ok).toBe(true);
    expect(msg(core, A, { t: 'lobby' })).toEqual({ ok: false, code: 'not_ended' });
    expect(msg(core, B, { t: 'lobby' })).toEqual({ ok: false, code: 'not_owner' });
    playOut(core, d);
    expect(msg(core, B, { t: 'lobby' })).toEqual({ ok: false, code: 'not_owner' });
    const solo = RoomCore.create('SOLOL', defaultSettings({ players: 2, opponents: ['zap'] }), A, true, 'v1', deps());
    expect(solo.handle(A, { t: 'lobby' })).toEqual({ ok: false, code: 'bad_message' });
  });

  it('keeps the seats and the characters, nobody plays, and no game is sent', () => {
    const { core, d } = roomWithB({ opponents: ['zap', 'lia'], partner: 'iara' });
    expect(msg(core, A, { t: 'start' }).ok).toBe(true);
    playOut(core, d);
    // B timed out a couple of times and the AI played for them at the end.
    Object.assign(core.r.seats[1], { timeouts: 2, takeover: true });
    const before = { seats: JSON.stringify(stored(core)), kinds: kinds(core), score: core.publicRoom().score, matchNo: core.r.matchNo, starts: d.starts.length, seq: core.r.seq };
    core.clearPending();
    expect(msg(core, A, { t: 'lobby' }).ok).toBe(true);
    expect(core.r.status).toBe('lobby');
    expect(core.r.seq).toBe(before.seq + 1);
    expect(JSON.stringify(stored(core))).toBe(before.seats);
    expect(kinds(core)).toEqual(before.kinds);
    expect(core.r.seats[1]).toMatchObject({ device: B, takeover: false, timeouts: 0, connected: true });
    expect(core.publicRoom()).toMatchObject({ status: 'lobby', matchNo: before.matchNo, score: before.score });
    expect(core.publicRoom().seats.map((s) => s.aiPlaying)).toEqual([false, false, false, false]);
    expect(core.r.deadline).toBeNull();
    expect(core.r.resumeAt).toBeNull();
    expect(d.starts).toHaveLength(before.starts);
    for (let seat = 0; seat < 4; seat++) expect(core.gameMessage(seat)).toBeNull();
    // Nothing to wake for but the expiry.
    expect(core.nextAlarm()).toBe(core.expiresAt());
    // AI seats come back reserved: nobody can sit there until the owner opens them.
    expect(core.join(C, true)).toEqual({ error: 'room_full' });
    expect(msg(core, A, { t: 'plan', seat: 3, ai: null }).ok).toBe(true);
    expect(core.join(C, true)).toEqual({ seat: 3 });
    expectP1(core);
  });

  it('a seat whose person deleted their data during the match is free again', () => {
    const { core, d } = roomWithB({ opponents: ['zap', 'lia'], partner: 'iara' });
    expect(msg(core, A, { t: 'start' }).ok).toBe(true);
    const hidden = core.r.seats[1].persona;
    expect(core.forget(B)).toBe(true);
    playOut(core, d);
    expect(core.r.seats[1]).toMatchObject({ kind: 'human', device: null });
    expect(msg(core, A, { t: 'lobby' }).ok).toBe(true);
    expect(core.r.seats[1]).toMatchObject({ kind: 'empty', persona: hidden });
    expect(core.publicRoom().seats[1].persona).toBe(hidden);
  });

  it('a lobby after a match survives a restart: the same seats and score, no game, and the plan plays next', () => {
    const { core, d } = postMatchLobby({ opponents: ['zap', 'lia'], partner: 'iara' }, 6);
    core.disconnect(B);
    expect(msg(core, A, { t: 'plan', seat: 3, ai: 'ravi' }).ok).toBe(true);
    const woken = new RoomCore(JSON.parse(JSON.stringify(core.r)) as StoredRoom, deps(16, d.clock));
    expect(woken.r.status).toBe('lobby');
    expect(stored(woken)).toEqual(stored(core));
    expect(woken.publicRoom()).toEqual(core.publicRoom());
    for (let seat = 0; seat < 4; seat++) expect(woken.gameMessage(seat)).toBeNull();
    expect(woken.handle(A, { t: 'start' }).ok).toBe(true);
    expect(woken.r.seats[1]).toMatchObject({ kind: 'human', device: B, carried: true });
    expect([woken.r.seats[2].persona, woken.r.seats[3].persona]).toEqual(['iara', 'ravi']);
    expectP1(woken);
  });

  it('a start from the lobby after a match plays the plan and counts the match once, like a start', () => {
    const { core, d } = postMatchLobby({ opponents: ['zap', 'lia'], partner: 'iara' });
    expect(d.starts).toEqual([[A, B]]);
    expect(msg(core, A, { t: 'plan', seat: 3, ai: 'bento' }).ok).toBe(true);
    expect(msg(core, A, { t: 'move', from: 1, to: 2 }).ok).toBe(true);
    expect(msg(core, A, { t: 'start' }).ok).toBe(true);
    expect(d.starts).toEqual([[A, B], [A, B]]);
    expect(core.r.matchNo).toBe(2);
    expect(kinds(core)).toEqual(['human', 'ai', 'human', 'ai']);
    expect(core.r.seats[3].persona).toBe('bento');
    expect(core.r.match!.seats.map((s) => s.persona)).toEqual([null, core.r.seats[1].persona, null, 'bento']);
    expect(core.gameMessage(core.seatOf(B))).not.toBeNull();
    expectP1(core);
  });
});

describe('who leads after a match', () => {
  it('while the owner is connected a friend\'s rematch and start are refused, also before asking D1', () => {
    const { core, d } = roomWithB();
    expect(msg(core, A, { t: 'start' }).ok).toBe(true);
    playOut(core, d);
    expect(core.publicRoom().ownerAway).toBe(false);
    expect(core.preStart(B, 'rematch')).toEqual({ ok: false, code: 'not_owner' });
    expect(msg(core, B, { t: 'rematch' })).toEqual({ ok: false, code: 'not_owner' });
    expect(core.r.status).toBe('ended');
    expect(msg(core, A, { t: 'lobby' }).ok).toBe(true);
    expect(core.preStart(B, 'start')).toEqual({ ok: false, code: 'not_owner' });
    expect(msg(core, B, { t: 'start' })).toEqual({ ok: false, code: 'not_owner' });
    expect(core.r.status).toBe('lobby');
    expect(d.starts).toHaveLength(1);
  });

  it('while the owner is away anyone seated may rematch or start; the owner still arranges alone', () => {
    const one = roomWithB({}, 3);
    expect(msg(one.core, A, { t: 'start' }).ok).toBe(true);
    playOut(one.core, one.d, 3);
    one.core.disconnect(A);
    expect(one.core.publicRoom().ownerAway).toBe(true);
    expect(one.core.preStart(B, 'rematch')).toEqual({ ok: true });
    expect(msg(one.core, C, { t: 'rematch' })).toEqual({ ok: false, code: 'not_seated' });
    expect(msg(one.core, B, { t: 'lobby' })).toEqual({ ok: false, code: 'not_owner' });
    expect(msg(one.core, B, { t: 'rematch' }).ok).toBe(true);
    expect(one.core.r.matchNo).toBe(2);
    // The owner's seat is played by the AI, and the owner did not spend a match.
    expect(one.core.publicRoom().seats[0].aiPlaying).toBe(true);
    expect(one.d.starts.at(-1)).toEqual([B]);

    const two = postMatchLobby({}, 4);
    two.core.disconnect(A);
    expect(two.core.publicRoom().ownerAway).toBe(true);
    expect(msg(two.core, B, { t: 'move', from: 1, to: 2 })).toEqual({ ok: false, code: 'not_owner' });
    expect(msg(two.core, B, { t: 'plan', seat: 3, ai: 'lia' })).toEqual({ ok: false, code: 'not_owner' });
    expect(two.core.preStart(B, 'start')).toEqual({ ok: true });
    expect(msg(two.core, B, { t: 'start' }).ok).toBe(true);
    expect(two.core.r.seats[0]).toMatchObject({ kind: 'human', device: A, takeover: true, carried: true });
  });

  it('the first lobby stays the owner\'s even while the owner is away', () => {
    const { core } = roomWithB();
    core.disconnect(A);
    expect(core.seatOf(A)).toBe(0);
    expect(core.publicRoom().ownerAway).toBe(true);
    expect(core.preStart(B, 'start')).toEqual({ ok: false, code: 'not_owner' });
    expect(msg(core, B, { t: 'start' })).toEqual({ ok: false, code: 'not_owner' });
  });

  it('an owner whose data is gone leaves the room to the others', () => {
    const { core, d } = roomWithB();
    expect(msg(core, A, { t: 'start' }).ok).toBe(true);
    expect(core.forget(A)).toBe(true);
    expect(core.publicRoom().ownerAway).toBe(true);
    playOut(core, d);
    expect(msg(core, B, { t: 'rematch' }).ok).toBe(true);
    // The seat without a person goes to its planned character.
    expect(core.r.seats[0]).toMatchObject({ kind: 'ai', persona: 'ravi' });
    expectP1(core);
  });

  it('with no time limit, a seat whose person deleted their data is no person: no rematch until a friend takes it', () => {
    const { core, d } = roomWithB({ players: 2, opponents: ['zap'], turnSeconds: null }, 12);
    expect(msg(core, A, { t: 'start' }).ok).toBe(true);
    expect(core.forget(B)).toBe(true);
    playOut(core, d, 12);
    expect(core.preStart(A, 'rematch')).toEqual({ ok: false, code: 'needs_people' });
    expect(msg(core, A, { t: 'rematch' })).toEqual({ ok: false, code: 'needs_people' });
    expect(core.r.status).toBe('ended');
    expect(kinds(core)).toEqual(['human', 'human']);
    // "Mudar a mesa" frees the seat; a new friend takes it and the next match has people only.
    expect(msg(core, A, { t: 'lobby' }).ok).toBe(true);
    expect(kinds(core)).toEqual(['human', 'empty']);
    expect(core.preStart(A, 'start')).toEqual({ ok: false, code: 'needs_people' });
    expect(core.join(C, true)).toEqual({ seat: 1 });
    core.connect(C);
    expect(msg(core, A, { t: 'start' }).ok).toBe(true);
    expect(kinds(core)).toEqual(['human', 'human']);
    // The owner's data gone: the friend leads, and is refused the same way.
    const two = roomWithB({ players: 2, opponents: ['zap'], turnSeconds: null }, 13);
    expect(msg(two.core, A, { t: 'start' }).ok).toBe(true);
    expect(two.core.forget(A)).toBe(true);
    playOut(two.core, two.d, 13);
    expect(two.core.preStart(B, 'rematch')).toEqual({ ok: false, code: 'needs_people' });
    expect(msg(two.core, B, { t: 'rematch' })).toEqual({ ok: false, code: 'needs_people' });
    expect(two.core.r.status).toBe('ended');
  });

  it('ownerAway reads the owner\'s connection only, and only rooms have it', () => {
    const { core } = roomWithB();
    expect(core.publicRoom().ownerAway).toBe(false);
    core.disconnect(B);
    expect(core.publicRoom().ownerAway).toBe(false);
    core.disconnect(A);
    expect(core.publicRoom().ownerAway).toBe(true);
    core.connect(A);
    expect(core.publicRoom().ownerAway).toBe(false);
    const solo = RoomCore.create('SOLOW', defaultSettings({ players: 2, opponents: ['zap'] }), A, true, 'v1', deps());
    expect('ownerAway' in solo.publicRoom()).toBe(false);
  });
});

/** A hibernatable socket as presence.ts reads it: its attachment and its state. */
class FakeSocket {
  readyState = 1;
  closedWith: [number, string] | null = null;
  readonly att: { opened: number; at: number };
  constructor(att: { opened: number; at: number }) {
    this.att = att;
  }
  deserializeAttachment(): unknown {
    return this.att;
  }
  close(code: number, reason: string): void {
    this.closedWith = [code, reason];
    this.readyState = 2;
  }
}

/** The Durable Object's state as presence.ts reads it: sockets by device tag, and the last ping answers. */
function fakeState(sockets: Record<string, FakeSocket[]>, pongs = new Map<FakeSocket, number>()) {
  return {
    getWebSockets: (tag?: string) => (tag === undefined ? Object.values(sockets).flat() : (sockets[tag] ?? [])),
    getWebSocketAutoResponseTimestamp: (ws: FakeSocket) => (pongs.has(ws) ? new Date(pongs.get(ws)!) : null),
  };
}

describe('the owner\'s real presence while friends wait (presence.ts, D6)', () => {
  /** A and B played a match; A's last message was at the end of it. */
  function ended(seed = 21) {
    const r = roomWithB({}, seed);
    expect(msg(r.core, A, { t: 'start' }).ok).toBe(true);
    playOut(r.core, r.d, seed);
    const t0 = r.d.clock.t;
    const a = new FakeSocket({ opened: t0 - 600_000, at: t0 });
    const b = new FakeSocket({ opened: t0 - 600_000, at: t0 });
    return { ...r, t0, a, b };
  }

  it('an owner socket that is open but silent: a friend\'s rematch finds the owner gone and may play', () => {
    const { core, d, t0, a, b } = ended();
    const pongs = new Map([[b, t0 + SILENT_MS]]);
    const ctx = fakeState({ [A]: [a], [B]: [b] }, pongs);
    // Pings answered for B only: A's page died without a close event.
    d.clock.t = t0 + SILENT_MS - 1;
    expect(checkOwner(ctx, core, d.clock.t)).toBe(false);
    expect(core.preStart(B, 'rematch')).toEqual({ ok: false, code: 'not_owner' });
    d.clock.t = t0 + SILENT_MS + 1;
    const seq = core.r.seq;
    expect(checkOwner(ctx, core, d.clock.t)).toBe(true);
    expect(a.closedWith).toEqual([CLOSE_SILENT, 'silent']);
    expect(b.closedWith).toBeNull();
    expect(core.r.seq).toBe(seq + 1);
    expect(core.publicRoom().ownerAway).toBe(true);
    expect(core.preStart(B, 'rematch')).toEqual({ ok: true });
    expect(msg(core, B, { t: 'rematch' }).ok).toBe(true);
    expect(core.r.seats[0]).toMatchObject({ device: A, takeover: true, carried: true });
    // Nothing more to check once the match runs.
    expect(checkOwner(ctx, core, d.clock.t + SILENT_MS)).toBe(false);
  });

  it('pings or messages keep the owner there; a socket that is not open does not', () => {
    const { core, t0, a, b } = ended(22);
    const now = t0 + 10 * SILENT_MS;
    expect(checkOwner(fakeState({ [A]: [a], [B]: [b] }, new Map([[a, now - 25_000]])), core, now)).toBe(false);
    a.att.at = now - 1_000;
    expect(checkOwner(fakeState({ [A]: [a], [B]: [b] }), core, now)).toBe(false);
    expect(core.publicRoom().ownerAway).toBe(false);
    a.readyState = 3;
    expect(checkOwner(fakeState({ [A]: [a], [B]: [b] }), core, now)).toBe(true);
    expect(core.publicRoom().ownerAway).toBe(true);
  });

  it('an owner with no socket: gone at once, unless the room just restarted and the pages are coming back', () => {
    const { core, t0, b } = ended(23);
    // B came back 10 s ago after a restart: the owner still has SILENT_MS from then.
    b.att.opened = t0 - 10_000;
    expect(checkOwner(fakeState({ [B]: [b] }), core, t0)).toBe(false);
    expect(nextOwnerCheck(fakeState({ [B]: [b] }), core, t0)).toBe(t0 - 10_000 + SILENT_MS);
    // B's connection is old: the room did not restart, the owner's close event was lost.
    b.att.opened = t0 - SILENT_MS;
    expect(checkOwner(fakeState({ [B]: [b] }), core, t0)).toBe(true);
    expect(core.publicRoom().ownerAway).toBe(true);
  });

  it('the room checks only while friends wait after a match, and only while a friend is there', () => {
    const { core, t0, a, b } = ended(24);
    const pongs = new Map([[a, t0 + 20_000]]);
    expect(nextOwnerCheck(fakeState({ [A]: [a], [B]: [b] }, pongs), core, t0 + 30_000)).toBe(t0 + 20_000 + SILENT_MS);
    // No friend with a live connection: no alarm for this.
    expect(nextOwnerCheck(fakeState({ [A]: [a] }, pongs), core, t0 + 30_000)).toBeNull();
    expect(nextOwnerCheck(fakeState({ [A]: [a], [B]: [b] }, pongs), core, t0 + SILENT_MS + 1)).toBeNull();
    // The post match lobby waits for the owner too.
    expect(msg(core, A, { t: 'lobby' }).ok).toBe(true);
    expect(nextOwnerCheck(fakeState({ [A]: [a], [B]: [b] }, pongs), core, t0 + 30_000)).toBe(t0 + 20_000 + SILENT_MS);
    // The owner away already, the first lobby, a match running, quick play: nothing to check.
    const silent = t0 + 10 * SILENT_MS;
    core.disconnect(A);
    expect(nextOwnerCheck(fakeState({ [B]: [b] }), core, t0)).toBeNull();
    expect(checkOwner(fakeState({ [B]: [b] }), core, silent)).toBe(false);
    const first = roomWithB({}, 25).core;
    expect(nextOwnerCheck(fakeState({ [A]: [a], [B]: [b] }), first, t0)).toBeNull();
    expect(checkOwner(fakeState({ [A]: [a], [B]: [b] }), first, silent)).toBe(false);
    expect(msg(first, A, { t: 'start' }).ok).toBe(true);
    expect(checkOwner(fakeState({ [A]: [a], [B]: [b] }), first, silent)).toBe(false);
    const solo = RoomCore.create('SOLOP', defaultSettings({ players: 2, opponents: ['zap'] }), A, true, 'v1', deps());
    solo.connect(A);
    expect(checkOwner(fakeState({ [A]: [a] }), solo, silent)).toBe(false);
    expect(a.closedWith).toBeNull();
  });
});

describe('drops after a match, and people carried into a match while away', () => {
  it('after a match a friend who drops keeps the seat; in the first lobby the seat is freed', () => {
    const first = roomWithB().core;
    first.disconnect(B);
    expect(first.seatOf(B)).toBe(-1);
    const { core } = postMatchLobby();
    core.disconnect(B);
    expect(core.seatOf(B)).toBe(1);
    expect(core.publicRoom().seats[1]).toMatchObject({ kind: 'human', connected: false, aiPlaying: false, persona: null });
    // A reload gets the same seat back without a new seat check.
    expect(core.joinError(B, false)).toBeNull();
    expect(core.join(B, true, Number.MAX_SAFE_INTEGER, false)).toEqual({ seat: 1 });
  });

  it('a recovery in the lobby after a match keeps the seat for the new id', () => {
    const { core } = postMatchLobby();
    expect(core.rekey(B, C)).toBe(true);
    expect(core.seatOf(C)).toBe(1);
    expect(core.seatOf(B)).toBe(-1);
    expect(core.r.seats[1].connected).toBe(false);
    expect(JSON.stringify(core.r)).not.toContain(B);
  });

  /** A no time limit room for A and B, so time can pass while the game waits for A without anyone timing out. */
  function carriedCase(seed: number, via: 'lobby' | 'rematch') {
    const clock = { t: Date.UTC(2026, 10, 25, 12) };
    const { core, d } = roomWithB({ players: 2, opponents: ['zap'], turnSeconds: null }, seed, clock);
    expect(msg(core, A, { t: 'start' }).ok).toBe(true);
    playOut(core, d, seed);
    if (via === 'lobby') expect(msg(core, A, { t: 'lobby' }).ok).toBe(true);
    core.disconnect(B);
    clock.t += 5 * 60_000;
    expect(msg(core, A, { t: via === 'lobby' ? 'start' : 'rematch' }).ok).toBe(true);
    return { core, d, clock };
  }

  for (const via of ['lobby', 'rematch'] as const) {
    it(`someone away at a start (${via}) is played by the AI and never counted as abandoning that match`, () => {
      const { core, d, clock } = carriedCase(via === 'lobby' ? 7 : 8, via);
      expect(core.r.seats[1]).toMatchObject({ kind: 'human', device: B, carried: true, takeover: true, connected: false });
      expect(core.publicRoom().seats[1].aiPlaying).toBe(true);
      expect(d.starts.at(-1)).toEqual([A]);
      // Ten minutes of alarms: the game waits for A (no limit), the AI plays B's turns.
      const end = clock.t + 10 * 60_000;
      while (clock.t < end) {
        expect(core.nextAlarm()).toBe(core.r.resumeAt ?? core.expiresAt());
        clock.t += 30_000;
        core.alarm();
      }
      expect(core.r.status).toBe('playing');
      expect(core.r.match!.abandoned).toEqual([]);
      expect(core.r.seats[1].abandoned).toBe(false);
      expect(d.abandoned).toEqual([]);
      // B comes back and drops again: from now on the usual rules apply.
      core.connect(B);
      expect(core.r.seats[1].carried).toBeUndefined();
      expect(core.r.seats[1].takeover).toBe(false);
      core.disconnect(B);
      expect(core.nextAlarm()).toBe(clock.t + RECONNECT_GRACE_MS);
      clock.t += ABANDON_AFTER_MS + 1;
      core.alarm();
      expect(core.r.match!.abandoned).toEqual([1]);
      expect(d.abandoned).toEqual([B]);
    });
  }

  it('the first start of a quick play room never marks its person as away', () => {
    const core = RoomCore.create('SOLOF', defaultSettings({ players: 4 }), A, true, 'v1', deps());
    expect(core.r.seats[0]).toMatchObject({ kind: 'human', connected: false, takeover: false });
    expect(core.r.seats[0].carried).toBeUndefined();
    expect(core.publicRoom().seats[0].aiPlaying).toBe(false);
    // Quick play seats hold no plan: the person's seat has no character.
    expect(core.r.seats[0].persona).toBeNull();
  });
});

describe('invariant P1 and the public view under random use', () => {
  it('1,000 random operations over 20 seeds: every seat keeps a different character, and no person shows one', () => {
    const devices = 'abcdefghjk'.split('').map(dev);
    let plays = 0;
    let arranged = 0;
    /** Effective arrangements in a lobby after a match. */
    let afterMatch = 0;
    for (let seed = 0; seed < 20; seed++) {
      const rand = mulberry32(900 + seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
      const clock = { t: 5_000_000 };
      const make = () => {
        const players = rand() < 0.3 ? 2 : 4;
        const opponents = players === 2 ? [pick(PERSONA_ORDER)] : [...PERSONA_ORDER].sort(() => rand() - 0.5).slice(0, 2);
        const r = room({ players, opponents, partner: PERSONA_ORDER.find((p) => !opponents.includes(p))! }, seed, clock);
        return r;
      };
      let { core, d } = make();
      for (let op = 0; op < 1000; op++) {
        if (core.r.closed) ({ core, d } = make());
        const seated = core.seatedDevices();
        const n = core.r.seats.length;
        const who = pick(devices);
        const owner = core.r.owner;
        const r = rand();
        const ok = (done: boolean) => {
          if (done && core.r.matchNo > 0) afterMatch++;
          return Number(done);
        };
        if (r < 0.12) core.join(who, true);
        else if (r < 0.2) core.connect(who);
        else if (r < 0.27 && seated.length > 0) core.disconnect(pick(seated));
        else if (r < 0.32 && seated.length > 0) core.handle(pick(seated), { t: 'leave' });
        else if (r < 0.4 && seated.length > 0) core.handle(pick(seated), { t: 'sit', seat: Math.floor(rand() * n) });
        else if (r < 0.55) arranged += ok(core.handle(rand() < 0.9 ? owner : who, { t: 'move', from: Math.floor(rand() * n), to: Math.floor(rand() * n) }).ok);
        else if (r < 0.7) arranged += ok(core.handle(rand() < 0.9 ? owner : who, { t: 'plan', seat: Math.floor(rand() * n), ai: rand() < 0.3 ? null : pick(PERSONA_ORDER) }).ok);
        else if (r < 0.73 && seated.length > 0) core.forget(rand() < 0.2 ? owner : pick(seated));
        else if (r < 0.76 && seated.length > 0) core.rekey(pick(seated), who);
        else if (r < 0.84) core.handle(rand() < 0.8 ? owner : who, { t: 'start' });
        else if (r < 0.9) core.handle(rand() < 0.8 ? owner : pick(seated.length ? seated : [who]), { t: 'rematch' });
        else if (r < 0.95) core.handle(owner, { t: 'lobby' });
        else if (core.r.status === 'playing') {
          // Somebody must be at the table, playing their own seat, for the AIs to play on.
          const active = () => core.r.seats.some((s) => s.kind === 'human' && s.device && s.connected && !s.takeover);
          const back = core.seatedDevices()[0];
          if (!active() && back) {
            core.connect(back);
            core.handle(back, { t: 'resume' });
          }
          if (active()) {
            playOut(core, d, op);
            plays++;
          }
        }
        if (core.r.closed) continue;
        expectP1(core);
        const pub = core.publicRoom();
        expect(pub.setup).toBe(2);
        expect(pub.ownerAway).toBe(core.r.owner === '' || core.seatOf(core.r.owner) < 0 || !core.r.seats[core.seatOf(core.r.owner)].connected);
        for (const s of pub.seats) {
          if (s.kind === 'human') expect(s.persona).toBeNull();
          else expect(PERSONAS.some((p) => p.id === s.persona)).toBe(true);
        }
        if (core.r.status === 'lobby') for (let seat = 0; seat < n; seat++) expect(core.gameMessage(seat)).toBeNull();
      }
    }
    expect(plays).toBeGreaterThan(100);
    expect(arranged).toBeGreaterThan(500);
    expect(afterMatch).toBeGreaterThan(50);
  }, 120_000);
});

describe('rooms stored before the seat plan', () => {
  /** The stored JSON of a room as code before M15 wrote it: no character on free seats or people. */
  function legacy(core: RoomCore): StoredRoom {
    const r = JSON.parse(JSON.stringify(core.r)) as StoredRoom;
    for (const s of r.seats) if (s.kind !== 'ai') s.persona = null;
    return r;
  }

  it('a lobby gets the plan the old start would play, and a hidden character for each person', () => {
    const { core } = roomWithB({ opponents: ['zap', 'bento'], partner: 'iara' });
    const old = legacy(core);
    const loaded = new RoomCore(old, deps());
    // Seat 2 is on the owner's team (the partner), seat 3 the first opponent: what the old start gave them.
    expect(stored(loaded)).toEqual(['lia', 'ravi', 'iara', 'zap']);
    expect(shown(loaded)).toEqual([null, null, 'iara', 'zap']);
    expectP1(loaded);
    expect(loaded.handle(A, { t: 'start' }).ok).toBe(true);
    expect([loaded.r.seats[2].persona, loaded.r.seats[3].persona]).toEqual(['iara', 'zap']);
    // The owner on seat 1 makes seat 1's team the owner's.
    const moved = room({ opponents: ['zap', 'bento'], partner: 'iara' }).core;
    expect(moved.handle(A, { t: 'sit', seat: 1 }).ok).toBe(true);
    const again = new RoomCore(legacy(moved), deps());
    expect(stored(again)).toEqual(['zap', 'lia', 'bento', 'iara']);
    expectP1(again);
  });

  it('a finished match keeps its AI characters; people get hidden ones', () => {
    const { core, d } = roomWithB({ opponents: ['zap', 'bento'], partner: 'iara' });
    expect(core.handle(B, { t: 'sit', seat: 2 }).ok).toBe(true);
    expect(core.handle(A, { t: 'start' }).ok).toBe(true);
    playOut(core, d);
    const loaded = new RoomCore(legacy(core), deps(2, d.clock));
    expect(stored(loaded)).toEqual(['iara', 'zap', 'lia', 'bento']);
    expectP1(loaded);
    expect(loaded.handle(A, { t: 'rematch' }).ok).toBe(true);
    expect(kinds(loaded)).toEqual(['human', 'ai', 'human', 'ai']);
    expect([loaded.r.seats[1].persona, loaded.r.seats[3].persona]).toEqual(['zap', 'bento']);
  });

  it('two AIs that older code gave one character keep it until the next start, which gives the second another', () => {
    const { core, d } = room({ opponents: ['zap', 'bento'], partner: 'iara' });
    expect(core.handle(A, { t: 'start' }).ok).toBe(true);
    playOut(core, d);
    const old = legacy(core);
    old.settings.opponents = ['zap'];
    old.seats[3].persona = 'zap';
    const loaded = new RoomCore(old, deps(3, d.clock));
    expect(stored(loaded)).toEqual(['lia', 'zap', 'iara', 'zap']);
    expect(loaded.handle(A, { t: 'rematch' }).ok).toBe(true);
    expect(stored(loaded)).toEqual(['lia', 'zap', 'iara', 'ravi']);
    expectP1(loaded);
  });

  it('a quick play room gains no plan, and a stored seat without carried reads false', () => {
    const solo = RoomCore.create('SOLOU', defaultSettings({ players: 4 }), A, true, 'v1', deps());
    const r = JSON.parse(JSON.stringify(solo.r)) as StoredRoom;
    delete r.settings.randomOpponents;
    delete r.settings.randomPartner;
    const loaded = new RoomCore(r, deps());
    expect(stored(loaded)).toEqual([null, 'zap', 'iara', 'lia']);
    expect(loaded.r.seats.every((s) => !s.carried)).toBe(true);
    // Stored and loaded again, a carried seat stays carried.
    const { core } = carriedCase2();
    const back = new RoomCore(JSON.parse(JSON.stringify(core.r)), deps(5, { t: core.r.lastActivity }));
    expect(back.r.seats[1].carried).toBe(true);
    expect(back.nextAlarm()).toBe(core.nextAlarm());
  });
});

/** B away at a rematch: B's seat is carried (for the storage round trip above). */
function carriedCase2() {
  const clock = { t: 3_000_000 };
  const { core, d } = roomWithB({ players: 2, opponents: ['zap'], turnSeconds: null }, 11, clock);
  expect(core.handle(A, { t: 'start' }).ok).toBe(true);
  playOut(core, d, 11);
  core.disconnect(B);
  expect(core.handle(A, { t: 'rematch' }).ok).toBe(true);
  return { core, d };
}
