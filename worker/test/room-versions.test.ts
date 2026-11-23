// A room plays each match with the versions fixed at its start (StoredMatch.ai): a new manifest,
// a rollback or a wake from hibernation never changes them in the middle of a match, and during a
// test the candidate only sits in opponent seats. RoomCore with the real runtime over a fake
// bucket (worker/src/ai-select.ts, worker/src/model-store.ts).

import { describe, expect, it } from 'vitest';
import { legalMask } from '../../engine/src/engine.ts';
import { deriveSeed, mulberry32 } from '../../engine/src/rng.ts';
import { BASE_PARAMS } from '../../ai/src/heuristic.ts';
import { buildMatchRecord, validateMatchRecord } from '../../shared/match-record.ts';
import type { MatchAi } from '../../shared/cycle-formats.ts';
import { createRuntime, type AiRuntime } from '../src/ai-select.ts';
import { ModelStore } from '../src/model-store.ts';
import { RoomCore, defaultSettings, type RoomDeps, type StoredRoom } from '../src/room-core.ts';
import { MemBucket, bundled, bundledEntry, entryOf, manifest, smallModel } from './model-fixtures.ts';

const T0 = Date.UTC(2026, 10, 22, 12);
const TTL = 300_000;

interface Call {
  seat: number;
  version: string;
  partnerHuman: boolean;
}

function bucketWithTest(): MemBucket {
  const b = new MemBucket();
  const v2 = smallModel(12, 'v1');
  const v3 = smallModel(13, 'v2');
  b.putModel('v2', v2);
  b.putModel('v3', v3);
  b.putManifest(manifest({ v1: bundledEntry(), v2: entryOf(v2), v3: entryOf(v3) }, { current: 'v3', control: 'v2', controlShare: 0.3, controlUntil: T0 + 14 * 86_400_000 }));
  return b;
}

function isolate(bucket: MemBucket, clock: { t: number }): AiRuntime {
  return createRuntime(new ModelStore(bucket, bundled(), { ttlMs: TTL }), { heuristic: BASE_PARAMS, now: () => clock.t });
}

function deps(rt: AiRuntime, clock: { t: number }, calls: Call[], seed: number, draw: () => number): RoomDeps {
  let k = 0;
  return {
    now: () => clock.t,
    randomSeed: () => deriveSeed('9e'.repeat(32), 3, seed * 1000 + k++),
    agentFor: (seat, persona, partnerHuman, version) => {
      calls.push({ seat, version, partnerHuman });
      return rt.agentFor(version, seat, persona, partnerHuman);
    },
    pickAi: (solo) => rt.pick(solo, draw),
    rand: mulberry32(seed),
  };
}

/** Plays the person's seat with random legal moves for at most `moves` moves (all of them by default). */
function play(core: RoomCore, clock: { t: number }, device: string, seed: number, moves = Infinity): void {
  const rand = mulberry32(seed);
  const legal = (mask: number) => [...Array(15).keys()].filter((a) => mask & (1 << a));
  for (let n = 0, guard = 0; core.r.status === 'playing' && n < moves && guard < 5000; guard++) {
    const seat = core.seatOf(device);
    const d = core.r.deadline;
    if (!d || d.seat !== seat) {
      clock.t = Math.max(clock.t, core.nextAlarm() ?? clock.t) + 1;
      core.alarm();
      continue;
    }
    clock.t = Math.max(clock.t, d.since) + 900;
    const acts = legal(legalMask(core.match!, seat));
    core.handle(device, { t: 'act', seq: core.r.seq, a: acts[Math.floor(rand() * acts.length)] });
    n++;
  }
}

describe('versions per match in a room', () => {
  it('keep their versions across a manifest change, a hibernation wake and a rollback', async () => {
    const clock = { t: T0 };
    const bucket = bucketWithTest();
    let rt = isolate(bucket, clock);
    await rt.refresh(clock.t);
    const calls: Call[] = [];
    // The candidate group (draw above the share).
    const core = RoomCore.create('VRSNA', defaultSettings({ players: 4 }), 'dev-a', true, rt.label, deps(rt, clock, calls, 1, () => 0.9));
    core.connect('dev-a');
    const pinned: MatchAi = { opponents: 'v3', partners: 'v2', arm: 'candidate' };
    expect(core.r.match!.ai).toEqual(pinned);
    expect(core.r.match!.seats.map((s) => s.aiVersion)).toEqual([null, 'v3', 'v2', 'v3']);
    play(core, clock, 'dev-a', 1, 6);

    // Rollback: the manifest now says v2, no test. The running match does not change.
    const m = JSON.parse(new TextDecoder().decode(bucket.objects.get('manifest.json')!.bytes));
    bucket.putManifest({ ...m, current: 'v2', control: null, controlUntil: null, updatedAt: clock.t });
    clock.t += TTL + 1;
    await rt.refresh(clock.t);
    expect(rt.pick(true, () => 0.9)).toEqual({ opponents: 'v2', partners: 'v2', arm: null });
    play(core, clock, 'dev-a', 2, 6);
    expect(core.r.match!.ai).toEqual(pinned);

    // Hibernation: a new isolate, a new runtime, the room rebuilt from storage. The pinned versions load again.
    const stored = JSON.parse(JSON.stringify(core.r)) as StoredRoom;
    rt = isolate(bucket, clock);
    const fixed = await rt.ensure(stored.match!.ai);
    expect(fixed).toBe(stored.match!.ai);
    const woken = new RoomCore(stored, deps(rt, clock, calls, 3, () => 0.9));
    expect(woken.setMatchAi(fixed)).toBe(false);
    play(woken, clock, 'dev-a', 3);
    expect(woken.r.status).toBe('ended');

    // Every AI move of the match used its pinned version; the candidate only in opponent seats.
    for (const c of calls) {
      if (c.seat === 2 || c.seat === 0) expect(c.version, `seat ${c.seat}`).toBe('v2');
      else expect(c.version, `seat ${c.seat}`).toBe('v3');
    }
    const rec = buildMatchRecord(woken.r, woken.match!);
    expect(validateMatchRecord(rec).ok).toBe(true);
    expect(rec).toMatchObject({ aiVersion: 'v3', partnerVersion: 'v2', arm: 'candidate' });

    // The next match takes the rolled-back manifest.
    await rt.refresh(clock.t);
    woken.handle('dev-a', { t: 'rematch' });
    expect(woken.r.match!.ai).toEqual({ opponents: 'v2', partners: 'v2', arm: null });
  });

  it('a pinned version that cannot be loaded after a wake is replaced before any move, and the record says so', async () => {
    const clock = { t: T0 };
    const bucket = bucketWithTest();
    const rt = isolate(bucket, clock);
    await rt.refresh(clock.t);
    const calls: Call[] = [];
    const core = RoomCore.create('VRSNB', defaultSettings({ players: 2, opponents: ['zap'] }), 'dev-a', true, rt.label, deps(rt, clock, calls, 4, () => 0.9));
    core.connect('dev-a');
    expect(core.r.match!.ai.opponents).toBe('v3');
    const stored = JSON.parse(JSON.stringify(core.r)) as StoredRoom;
    bucket.putModel('v3', new Uint8Array(64));
    const rt2 = isolate(bucket, clock);
    const fixed = await rt2.ensure(stored.match!.ai);
    expect(fixed).toEqual({ opponents: 'v1', partners: 'v2', arm: null });
    const woken = new RoomCore(stored, deps(rt2, clock, calls, 4, () => 0.9));
    expect(woken.setMatchAi(fixed)).toBe(true);
    calls.length = 0;
    play(woken, clock, 'dev-a', 4);
    expect(calls.every((c) => c.version === 'v1')).toBe(true);
    const rec = buildMatchRecord(woken.r, woken.match!);
    expect(validateMatchRecord(rec).ok).toBe(true);
    expect(rec).toMatchObject({ aiVersion: 'v1', partnerVersion: 'v2', arm: null });
    expect(rec.seats[1].aiVersion).toBe('v1');
  });

  it('the candidate never sits next to a person: quick play, rooms with friends, and the AI that plays for a person', async () => {
    const clock = { t: T0 };
    const rt = isolate(bucketWithTest(), clock);
    await rt.refresh(clock.t);
    const draw = mulberry32(77);
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const calls: Call[] = [];
      const solo = i < 4;
      const settings = solo ? defaultSettings({ players: 4 }) : defaultSettings({ mode: 'room', players: 4 });
      const core = RoomCore.create(`VRS${i}C`.slice(0, 5), settings, 'dev-a', true, rt.label, deps(rt, clock, calls, 10 + i, draw));
      if (!solo) {
        // Two friends as partners (seats 0 and 2): the candidate faces both. Friend b never moves,
        // so the AI plays for them at each time out, with the partners version.
        core.join('dev-b', true);
        core.handle('dev-b', { t: 'sit', seat: 2 });
        core.connect('dev-b');
        core.handle('dev-a', { t: 'start' });
      }
      core.connect('dev-a');
      const ai = core.r.match!.ai;
      seen.add(ai.arm ?? 'room');
      play(core, clock, 'dev-a', 20 + i, 40);
      if (!solo) expect(calls.some((c) => c.seat === 2)).toBe(true);
      for (const c of calls) {
        const human = core.r.seats[c.seat].kind === 'human';
        const nextToPerson = core.r.seats[c.seat ^ 2]?.kind === 'human';
        if (human || nextToPerson || c.partnerHuman) expect(c.version, `seat ${c.seat} in ${ai.arm ?? 'room'}`).toBe('v2');
      }
      expect(calls.some((c) => c.version === 'v3')).toBe(ai.arm !== 'control');
    }
    expect(seen.has('candidate') || seen.has('control')).toBe(true);
    expect(seen.has('room')).toBe(true);
  });
});
