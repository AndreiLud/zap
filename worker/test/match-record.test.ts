// The match record (shared/match-record.ts) as the room builds it: what goes in, what never goes
// in, the per-move decision times, and the validator that replays the log.

import { describe, expect, it } from 'vitest';
import { deriveSeed, mulberry32 } from '../../engine/src/rng.ts';
import { legalMask } from '../../engine/src/engine.ts';
import { HeuristicAgent } from '../../ai/src/heuristic.ts';
import type { Agent } from '../../ai/src/agent.ts';
import {
  MATCH_RECORD_SCHEMA,
  MATCH_RECORD_SCHEMA_V1,
  buildMatchRecord,
  isMatchId,
  matchKind,
  matchRecordKey,
  normalizeRecord,
  validateMatchRecord,
  type MatchRecord,
  type MatchRecordV1,
} from '../../shared/match-record.ts';
import type { MatchAi } from '../../shared/cycle-formats.ts';
import { RoomCore, defaultSettings, type RoomDeps, type StoredRoom } from '../src/room-core.ts';

const ID = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';

/** An AI that also reports a chance of winning, like the network does. */
function agentWithWinProb(): Agent {
  const h = new HeuristicAgent();
  return { name: 'test', act: (obs, rand, ctx) => ({ action: h.act(obs, rand, ctx).action, winProb: 0.61234 }) };
}

function deps(seed: number, clock: { t: number }, ai?: MatchAi): RoomDeps {
  let k = 0;
  return {
    now: () => clock.t,
    randomSeed: () => deriveSeed('cd'.repeat(32), 5, seed * 1000 + k++),
    agentFor: () => agentWithWinProb(),
    rand: mulberry32(seed),
    newMatchId: () => ID,
    ...(ai ? { pickAi: () => ai } : {}),
  };
}

const legal = (mask: number) => [...Array(15).keys()].filter((a) => mask & (1 << a));

/** Plays seat 0 (device dev-a) with random legal moves, thinking `think` ms each time, until the match ends. */
function playSolo(core: RoomCore, clock: { t: number }, think = 4_000, seed = 1): void {
  const rand = mulberry32(seed);
  for (let guard = 0; core.r.status === 'playing' && guard < 3000; guard++) {
    const d = core.r.deadline;
    if (!d || d.seat !== 0) {
      clock.t = Math.max(clock.t, core.nextAlarm() ?? clock.t) + 1;
      core.alarm();
      continue;
    }
    clock.t = Math.max(clock.t, d.since) + think;
    const acts = legal(legalMask(core.match!, 0));
    core.handle('dev-a', { t: 'act', seq: core.r.seq, a: acts[Math.floor(rand() * acts.length)] });
  }
}

function finishedSolo(players: 2 | 4 = 2, seed = 1, ai?: MatchAi, test = false): { core: RoomCore; rec: MatchRecord } {
  const clock = { t: Date.UTC(2026, 10, 21, 12) };
  const core = RoomCore.create('ABCDE', defaultSettings({ players, opponents: players === 2 ? ['zap'] : ['zap', 'lia'] }), 'dev-a', true, 'v1', deps(seed, clock, ai), clock.t + 7_200_000, 'Tatu Bola');
  core.connect('dev-a');
  playSolo(core, clock, 4_000, seed);
  expect(core.r.status).toBe('ended');
  return { core, rec: buildMatchRecord(core.r, core.match!, { test }) };
}

/** The same record as a milestone 5 room wrote it (zap-match/1). */
function asV1(rec: MatchRecord): MatchRecordV1 {
  const { partnerVersion: _p, arm: _a, test: _t, ...rest } = rec;
  return { ...rest, schema: MATCH_RECORD_SCHEMA_V1, seats: rec.seats.map(({ aiVersion: _v, ...s }) => s) };
}

describe('match record', () => {
  it('a finished solo match gives a valid record with config, seed, log and one move entry per action', () => {
    const { core, rec } = finishedSolo(2);
    expect(rec.schema).toBe(MATCH_RECORD_SCHEMA);
    expect(rec.matchId).toBe(ID);
    expect(rec.kind).toBe('solo1');
    expect(rec.turnSeconds).toBe(30);
    expect(rec.aiVersion).toBe('v1');
    expect(rec.config.players).toBe(2);
    expect(rec.seed).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.log).toEqual(core.match!.log);
    expect(rec.moves).toHaveLength(rec.log.length);
    expect(rec.seats).toEqual([
      { seat: 0, kind: 'human', verified: true, persona: null, aiVersion: null },
      { seat: 1, kind: 'ai', verified: false, persona: 'zap', aiVersion: 'v1' },
    ]);
    expect(rec.abandoned).toEqual([]);
    expect(rec.result.winner).toBe(core.match!.winner);
    expect(rec.endedAt).toBeGreaterThanOrEqual(rec.startedAt);
    // Valid as built and after a round trip through JSON.
    expect(validateMatchRecord(rec)).toEqual({ ok: true, record: rec });
    expect(validateMatchRecord(JSON.parse(JSON.stringify(rec))).ok).toBe(true);
  });

  it('people have decision times and no win estimate; AIs have a rounded win estimate and no time', () => {
    const { rec } = finishedSolo(4, 2);
    expect(rec.kind).toBe('solo2');
    let people = 0;
    let ais = 0;
    rec.log.forEach((packed, i) => {
      const mv = rec.moves[i];
      if (packed >> 4 === 0) {
        people++;
        expect(mv.auto).toBe(false);
        expect(mv.winProb).toBeNull();
        // 4 s per action; a signal keeps the clock running, so the move after it counts both.
        expect(mv.ms).not.toBeNull();
        expect(mv.ms! % 4_000).toBe(0);
        expect(mv.ms!).toBeGreaterThanOrEqual(4_000);
      } else {
        ais++;
        expect(mv).toEqual({ ms: null, auto: false, winProb: 0.6123 });
      }
    });
    expect(people).toBeGreaterThan(0);
    expect(ais).toBeGreaterThan(0);
    expect(rec.moves.filter((m) => m.ms === 4_000).length).toBeGreaterThan(0);
  });

  it('never holds a device id, nickname or room code, and the stored room keeps them out of the record', () => {
    const { core, rec } = finishedSolo(2, 3);
    const text = JSON.stringify(rec);
    expect(core.r.seats[0].device).toBe('dev-a');
    expect(core.r.seats[0].name).toBe('Tatu Bola');
    expect(text).not.toContain('dev-a');
    expect(text).not.toContain('Tatu');
    expect(text).not.toContain('ABCDE');
    expect(Object.keys(rec).sort()).toEqual(
      ['abandoned', 'aiVersion', 'arm', 'config', 'endedAt', 'engine', 'kind', 'log', 'matchId', 'moves', 'partnerVersion', 'result', 'schema', 'seats', 'seed', 'startedAt', 'test', 'turnSeconds'].sort(),
    );
    expect(Object.keys(rec.seats[0]).sort()).toEqual(['aiVersion', 'kind', 'persona', 'seat', 'verified']);
  });

  it('each finished match is handed out once, and rematch starts a new match id', () => {
    const clock = { t: Date.UTC(2026, 10, 21, 12) };
    let n = 0;
    const d = { ...deps(4, clock), newMatchId: () => `${ID.slice(0, -1)}${n++}` };
    const core = RoomCore.create('ABCDE', defaultSettings({ players: 2, opponents: ['bento'] }), 'dev-a', true, 'v1', d);
    core.connect('dev-a');
    expect(core.takeFinished()).toBeNull();
    playSolo(core, clock);
    const first = core.takeFinished();
    expect(first?.id).toBe(`${ID.slice(0, -1)}0`);
    expect(core.takeFinished()).toBeNull();
    expect(core.handle('dev-a', { t: 'rematch' }).ok).toBe(true);
    expect(core.r.match!.id).toBe(`${ID.slice(0, -1)}1`);
    expect(core.r.match!.moves).toEqual([]);
    expect(core.takeFinished()).toBeNull();
  });

  it('time away does not count as decision time', () => {
    const clock = { t: Date.UTC(2026, 10, 21, 12) };
    const core = RoomCore.create('QWERT', defaultSettings({ mode: 'room', players: 2, opponents: ['lia'] }), 'p1', true, 'v1', deps(5, clock));
    core.join('p2', true);
    core.connect('p1');
    core.connect('p2');
    core.handle('p1', { t: 'start' });
    const d = core.r.deadline!;
    const device = d.seat === 0 ? 'p1' : 'p2';
    clock.t = Math.max(clock.t, d.since) + 3_000;
    core.disconnect(device);
    clock.t += 10_000;
    core.connect(device);
    clock.t += 2_000;
    const before = core.r.match!.log.length;
    const acts = legal(legalMask(core.match!, d.seat)).filter((a) => a < 9);
    expect(core.handle(device, { t: 'act', seq: core.r.seq, a: acts[0] }).ok).toBe(true);
    expect(core.r.match!.moves[before]).toEqual({ ms: 5_000, auto: false, winProb: null });
  });

  it('moves the AI makes for a person are automatic, and an abandonment is listed', () => {
    const clock = { t: Date.UTC(2026, 10, 21, 12) };
    const core = RoomCore.create('ZXCVB', defaultSettings({ mode: 'room', players: 2, opponents: ['bento'] }), 'p1', true, 'v1', deps(6, clock));
    core.join('p2', true);
    core.connect('p1');
    core.connect('p2');
    core.handle('p1', { t: 'start' });
    // p1 leaves mid-match: abandoned, and the AI plays the seat to the end.
    expect(core.handle('p1', { t: 'leave' }).ok).toBe(true);
    const rand = mulberry32(9);
    for (let guard = 0; core.r.status === 'playing' && guard < 3000; guard++) {
      const mask = legalMask(core.match!, 1);
      if (mask === 0) {
        clock.t = Math.max(clock.t, core.nextAlarm() ?? clock.t) + 1;
        core.alarm();
        continue;
      }
      clock.t += 1_000;
      const acts = legal(mask);
      core.handle('p2', { t: 'act', seq: core.r.seq, a: acts[Math.floor(rand() * acts.length)] });
    }
    expect(core.r.status).toBe('ended');
    const rec = buildMatchRecord(core.r);
    expect(rec.kind).toBe('humans');
    expect(rec.abandoned).toEqual([0]);
    const seat0 = rec.moves.filter((_, i) => rec.log[i] >> 4 === 0);
    expect(seat0.some((m) => m.auto)).toBe(true);
    for (const m of seat0.filter((x) => x.auto)) expect(m.ms).toBeNull();
    expect(validateMatchRecord(rec).ok).toBe(true);
  });

  it('match kinds follow the mode and who sits where', () => {
    const seats = (kinds: string) => [...kinds].map((c, seat) => ({ seat, kind: c === 'h' ? ('human' as const) : ('ai' as const) }));
    expect(matchKind('solo', seats('ha'))).toBe('solo1');
    expect(matchKind('solo', seats('haaa'))).toBe('solo2');
    expect(matchKind('room', seats('hhhh'))).toBe('humans');
    expect(matchKind('room', seats('hh'))).toBe('humans');
    expect(matchKind('room', seats('haha'))).toBe('friends');
    expect(matchKind('room', seats('ahah'))).toBe('friends');
    expect(matchKind('room', seats('hhaa'))).toBe('mixed');
    expect(matchKind('room', seats('hhha'))).toBe('mixed');
    expect(matchKind('room', seats('haaa'))).toBe('mixed');
    expect(matchKind('room', seats('ha'))).toBe('mixed');
  });

  it('the R2 key uses the UTC date of the end', () => {
    expect(matchRecordKey({ matchId: ID, endedAt: Date.UTC(2026, 10, 21, 23, 59) })).toBe(`matches/v1/2026/11/21/${ID}.json`);
    expect(matchRecordKey({ matchId: ID, endedAt: Date.UTC(2027, 0, 1, 0, 0, 1) })).toBe(`matches/v1/2027/01/01/${ID}.json`);
    expect(isMatchId(ID)).toBe(true);
    expect(isMatchId(ID.toUpperCase())).toBe(false);
    expect(isMatchId('../../x')).toBe(false);
  });

  it('the validator refuses extra fields, broken structure and a log that does not reach the result', () => {
    const { rec } = finishedSolo(2, 7);
    const bad = (f: (r: any) => void) => {
      const r = JSON.parse(JSON.stringify(rec));
      f(r);
      return validateMatchRecord(r);
    };
    expect(validateMatchRecord(null).ok).toBe(false);
    expect(validateMatchRecord([]).ok).toBe(false);
    expect(bad((r) => (r.device = 'abc')).ok).toBe(false);
    expect(bad((r) => (r.roomCode = 'ABCDE')).ok).toBe(false);
    expect(bad((r) => delete r.moves).ok).toBe(false);
    expect(bad((r) => (r.seats[0].name = 'Tatu')).ok).toBe(false);
    expect(bad((r) => (r.seats[0].pseudonym = 'f'.repeat(32))).ok).toBe(false);
    expect(bad((r) => (r.config.options.extra = 1)).ok).toBe(false);
    expect(bad((r) => (r.moves[0].ip = '1.2.3.4')).ok).toBe(false);
    expect(bad((r) => (r.schema = 'zap-match/3')).ok).toBe(false);
    // A /2 record keeps its own fields; a /1 record has none of them.
    expect(bad((r) => (r.schema = 'zap-match/1')).ok).toBe(false);
    expect(bad((r) => delete r.test).ok).toBe(false);
    expect(bad((r) => (r.test = 'true')).ok).toBe(false);
    expect(bad((r) => (r.partnerVersion = 'v 2')).ok).toBe(false);
    expect(bad((r) => (r.seats[1].aiVersion = 'v9')).ok).toBe(false);
    expect(bad((r) => (r.seats[0].aiVersion = 'v1')).ok).toBe(false);
    expect(bad((r) => delete r.seats[1].aiVersion).ok).toBe(false);
    expect(bad((r) => (r.matchId = 'ABCDE')).ok).toBe(false);
    expect(bad((r) => (r.seed = 'x'.repeat(64))).ok).toBe(false);
    expect(bad((r) => (r.kind = 'humans')).ok).toBe(false);
    expect(bad((r) => (r.turnSeconds = null)).ok).toBe(false);
    expect(bad((r) => (r.turnSeconds = 45)).ok).toBe(false);
    expect(bad((r) => (r.seats[1].persona = 'nobody')).ok).toBe(false);
    expect(bad((r) => r.moves.pop()).ok).toBe(false);
    expect(bad((r) => (r.moves[r.log.findIndex((x: number) => x >> 4 === 1)].ms = 100)).ok).toBe(false);
    expect(bad((r) => (r.moves[0].winProb = 2)).ok).toBe(false);
    expect(bad((r) => (r.abandoned = [1])).ok).toBe(false);
    expect(bad((r) => (r.endedAt = r.startedAt - 1)).ok).toBe(false);
    // The replay must reach the stated result.
    expect(bad((r) => (r.result.winner = 1 - r.result.winner)).ok).toBe(false);
    expect(bad((r) => (r.result.score = [r.result.score[1], r.result.score[0]])).ok).toBe(false);
    const cut = bad((r) => {
      r.log.pop();
      r.moves.pop();
    });
    expect(cut.ok).toBe(false);
    if (!cut.ok) expect(cut.errors.join(' ')).toMatch(/does not end/);
    const swapped = bad((r) => {
      [r.log[0], r.log[1]] = [r.log[1], r.log[0]];
    });
    expect(swapped.ok).toBe(false);
  });

  it('a room stored before the record fields existed still loads, plays and records', () => {
    const clock = { t: Date.UTC(2026, 10, 21, 12) };
    const core = RoomCore.create('BCDFG', defaultSettings({ players: 2, opponents: ['zap'] }), 'dev-a', true, 'v1', deps(8, clock));
    core.connect('dev-a');
    const acts = legal(legalMask(core.match!, 0));
    core.handle('dev-a', { t: 'act', seq: core.r.seq, a: acts[0] });
    // The M4 shape: only config, seed, log and the indices of automatic moves.
    const old = JSON.parse(JSON.stringify(core.r));
    const m = old.match as Record<string, unknown>;
    for (const k of ['id', 'startedAt', 'endedAt', 'moves', 'seats', 'abandoned', 'recorded']) delete m[k];
    m.auto = [];
    const loaded = new RoomCore(old as StoredRoom, deps(8, clock));
    expect(loaded.r.match!.moves).toHaveLength(loaded.r.match!.log.length);
    expect(isMatchId(loaded.r.match!.id)).toBe(true);
    expect('auto' in loaded.r.match!).toBe(false);
    playSolo(loaded, clock);
    expect(loaded.r.status).toBe('ended');
    expect(validateMatchRecord(buildMatchRecord(loaded.r)).ok).toBe(true);
  });

  it('a nickname shows at the table until it is hidden after a report', () => {
    const clock = { t: 1_000 };
    const core = RoomCore.create('HJKLM', defaultSettings({ mode: 'room', players: 2 }), 'p1', true, 'v1', deps(9, clock), Number.MAX_SAFE_INTEGER, 'Ana');
    core.join('p2', true, Number.MAX_SAFE_INTEGER, true, 'Bia');
    expect(core.publicRoom().seats.map((s) => s.name)).toEqual(['Ana', 'Bia']);
    expect(core.hideName(1)).toBe(true);
    expect(core.hideName(1)).toBe(false);
    expect(core.publicRoom().seats[1].name).toBe('');
    // Coming back passes the name the Worker allows (none while the report waits for review).
    core.join('p2', true, Number.MAX_SAFE_INTEGER, true, '');
    expect(core.publicRoom().seats[1].name).toBe('');
    core.join('p1', true, Number.MAX_SAFE_INTEGER, true, 'Ana Maria');
    expect(core.publicRoom().seats[0].name).toBe('Ana Maria');
  });

  it('zap-match/2: versions per seat, groups and the test mark, checked against each other', () => {
    // No test: one version everywhere, no group.
    const plain = finishedSolo(4, 11).rec;
    expect(plain.aiVersion).toBe('v1');
    expect(plain.partnerVersion).toBe('v1');
    expect(plain.arm).toBeNull();
    expect(plain.test).toBe(false);
    expect(plain.seats.map((s) => s.aiVersion)).toEqual([null, 'v1', 'v1', 'v1']);
    // The candidate group: the partner of the person (seat 2) plays the previous version.
    const cand = finishedSolo(4, 12, { opponents: 'v3', partners: 'v2', arm: 'candidate' }, true).rec;
    expect(validateMatchRecord(cand).ok).toBe(true);
    expect(cand).toMatchObject({ aiVersion: 'v3', partnerVersion: 'v2', arm: 'candidate', test: true });
    expect(cand.seats.map((s) => s.aiVersion)).toEqual([null, 'v3', 'v2', 'v3']);
    // 1 against 1 has no partner: the AI faces the person.
    const solo1 = finishedSolo(2, 13, { opponents: 'v3', partners: 'v2', arm: 'candidate' }).rec;
    expect(solo1.seats.map((s) => s.aiVersion)).toEqual([null, 'v3']);
    const ctrl = finishedSolo(4, 14, { opponents: 'v2', partners: 'v2', arm: 'control' }).rec;
    expect(validateMatchRecord(ctrl).ok).toBe(true);
    const bad = (rec: MatchRecord, f: (r: any) => void) => {
      const r = JSON.parse(JSON.stringify(rec));
      f(r);
      return validateMatchRecord(r).ok;
    };
    expect(bad(cand, (r) => ([r.seats[1].aiVersion, r.seats[2].aiVersion] = ['v2', 'v3']))).toBe(false);
    expect(bad(cand, (r) => (r.arm = 'control'))).toBe(false);
    expect(bad(ctrl, (r) => (r.arm = 'candidate'))).toBe(false);
    expect(bad(cand, (r) => (r.arm = 'other'))).toBe(false);
    // A room with friends has no group, even during a test.
    expect(bad(cand, (r) => (r.kind = 'mixed'))).toBe(false);
    expect(bad(cand, (r) => {
      r.kind = 'mixed';
      r.arm = null;
      r.turnSeconds = 30;
    })).toBe(true);
  });

  it('zap-match/1 records stay valid and normalize to the /2 view', () => {
    const { rec } = finishedSolo(4, 15);
    const old = asV1(rec);
    const v = validateMatchRecord(JSON.parse(JSON.stringify(old)));
    expect(v.ok).toBe(true);
    // A /1 record with a /2 field, or a /2 seat field, is refused.
    expect(validateMatchRecord({ ...old, test: false }).ok).toBe(false);
    expect(validateMatchRecord({ ...old, seats: rec.seats }).ok).toBe(false);
    const n = normalizeRecord(old);
    expect(n).toEqual({ ...rec, test: false, arm: null, partnerVersion: rec.aiVersion });
    expect(validateMatchRecord(n).ok).toBe(true);
    expect(normalizeRecord(rec)).toBe(rec);
  });

  it('a match stored before milestone 6 gets its versions from the room and records them', () => {
    const clock = { t: Date.UTC(2026, 10, 21, 12) };
    const core = RoomCore.create('BCDFH', defaultSettings({ players: 4 }), 'dev-a', true, 'v1', deps(16, clock));
    core.connect('dev-a');
    const old = JSON.parse(JSON.stringify(core.r));
    delete old.match.ai;
    for (const s of old.match.seats) delete s.aiVersion;
    const loaded = new RoomCore(old as StoredRoom, deps(16, clock));
    expect(loaded.r.match!.ai).toEqual({ opponents: 'v1', partners: 'v1', arm: null });
    expect(loaded.r.match!.seats.map((s) => s.aiVersion)).toEqual([null, 'v1', 'v1', 'v1']);
    playSolo(loaded, clock);
    expect(validateMatchRecord(buildMatchRecord(loaded.r)).ok).toBe(true);
  });
});
