// Whole matches over the WebSocket at a human pace, choosing random legal moves, while every
// message is checked for information the seat may not see. Needs a running site:
// BASE=http://dev:8787.

import { describe, expect, it } from 'vitest';
import type { PublicRoom } from '../../shared/protocol.ts';
import { BASE, Device, playToEnd, sleep, type Conn, type PlayResult } from './helpers.ts';
import { ViewChecker, crossCheck } from './view-check.ts';

function watchWith(conn: Conn, label: string): ViewChecker {
  const v = new ViewChecker(label);
  conn.watch((m, raw) => v.check(m, raw));
  return v;
}

function expectFinished(res: PlayResult, conn: Conn): void {
  const room = conn.room!.room;
  expect(res.final.obs.over).toBe(true);
  expect(room.status).toBe('ended');
  expect([0, 1]).toContain(room.lastWinner);
  expect(res.final.obs.winner).toBe(room.lastWinner);
  expect(res.final.deadline).toBeNull();
  expect(res.final.obs.legal).toBe(0);
  const o = res.final.obs;
  if (o.options.bestOf === 3) expect(o.games[room.lastWinner]).toBe(2);
  else expect(o.score[room.lastWinner]).toBeGreaterThanOrEqual(12);
}

describe.skipIf(!BASE)('whole matches', () => {
  it('plays a 2 against 2 solo match, best of three, with random legal moves, and every message shows only what the seat may see', async () => {
    const d = await new Device().verified();
    const code = await d.play({ players: 4, variant: 'paulista', options: { signals: 'p25', bestOf: 3 } });
    const c = await d.connect(code);
    const view = watchWith(c, 'solo 2x2');
    const res = await playToEnd(c, { paceMs: 300, timeoutMs: 100_000 });
    expectFinished(res, c);
    expect(res.moves).toBeGreaterThan(0);
    expect(view.seat).toBe(0);
    expect(view.games).toBeGreaterThanOrEqual(res.moves);
    expect(view.problems).toEqual([]);
    // Best of three: at least two hands were seen.
    expect(view.own.size).toBeGreaterThanOrEqual(2);

    // A move after the end is refused and changes nothing.
    await sleep(300);
    c.skip();
    c.send({ t: 'act', seq: res.final.seq, a: 0 });
    const e = await c.nextError();
    expect(e.code).toBeTruthy();
    expect(c.unread().filter((m) => m.t === 'game')).toEqual([]);
    const info = await d.get(`/api/rooms/${code}`);
    expect(info.body.status).toBe('ended');
    c.close();
  }, 120_000);

  it('plays a 1 against 1 solo match in mineiro, best of three, with face-down cards allowed in the first round', async () => {
    const d = await new Device().verified();
    const code = await d.play({ players: 2, variant: 'mineiro', opponents: ['bento'], options: { bestOf: 3, faceDownFirstRound: true } });
    const c = await d.connect(code);
    const view = watchWith(c, 'solo 1x1 mineiro');
    const res = await playToEnd(c, { paceMs: 300, timeoutMs: 110_000 });
    expectFinished(res, c);
    expect(res.final.obs.variant).toBe('mineiro');
    expect(res.final.obs.vira).toBe(-1);
    expect(view.problems).toEqual([]);
    c.close();
  }, 120_000);

  it('quick play with both random switches on: a valid drawn lineup, and a rematch with them off repeats it', async () => {
    const d = await new Device().verified();
    const code = await d.play({ players: 4, variant: 'paulista', opponents: ['zap', 'iara'], partner: 'lia', randomOpponents: true, randomPartner: true });
    const c = await d.connect(code);
    const view = watchWith(c, 'solo drawn');
    const lineupOf = (room: PublicRoom) => ({ opponents: [room.seats[1].persona, room.seats[3].persona], partner: room.seats[2].persona });
    const first = (await c.nextRoom()).room;
    expect(first.setup).toBeGreaterThanOrEqual(1);
    const drawn = lineupOf(first);
    // Three different characters, and the settings name the ones at the table.
    expect(new Set([...drawn.opponents, drawn.partner]).size).toBe(3);
    expect(first.settings).toMatchObject({ randomOpponents: true, randomPartner: true, ...drawn });
    const res = await playToEnd(c, { paceMs: 200, timeoutMs: 100_000 });
    expectFinished(res, c);

    await sleep(300);
    c.send({ t: 'rematch', randomOpponents: false, randomPartner: false });
    const next = (await c.nextRoom((r) => r.room.matchNo === res.final.matchNo + 1)).room;
    expect(next.status).toBe('playing');
    expect(lineupOf(next)).toEqual(drawn);
    expect(next.settings).toMatchObject({ randomOpponents: false, randomPartner: false, ...drawn });
    expect(view.problems).toEqual([]);
    c.close();
  }, 120_000);

  it('two people in a room by code: lobby rules, a whole match where neither sees the other one\'s cards, and a rematch', async () => {
    const a = await new Device().verified();
    const b = await new Device().verified();
    const code = await a.createRoom({ players: 2, variant: 'paulista', turnSeconds: null });

    const ca = await a.connect(code);
    const ra = await ca.nextRoom();
    expect(ra.you).toBe(0);
    expect(ra.owner).toBe(true);
    expect(ra.room.status).toBe('lobby');

    const info = await b.get(`/api/rooms/${code}`);
    expect(info.body.seats.map((s: { kind: string }) => s.kind)).toEqual(['human', 'empty']);

    const cb = await b.connect(code);
    const rb = await cb.nextRoom();
    expect(rb.you).toBe(1);
    expect(rb.owner).toBe(false);
    const both = await ca.nextRoom((r) => r.room.seats[1].kind === 'human' && r.room.seats[1].connected);
    expect(both.room.seats.map((s) => [s.kind, s.verified])).toEqual([
      ['human', true],
      ['human', true],
    ]);

    // The table is full for a third person.
    const third = await new Device().verified();
    const r3 = await third.upgrade(code);
    expect(r3.status).toBe(409);

    // Only the owner starts; a taken seat stays taken; phrases reach everyone.
    cb.send({ t: 'start' });
    expect((await cb.nextError()).code).toBe('not_owner');
    await sleep(300);
    cb.send({ t: 'sit', seat: 0 });
    expect((await cb.nextError()).code).toBe('seat_taken');
    await sleep(300);
    cb.send({ t: 'phrase', key: 'ola' });
    expect(await ca.next((m) => m.t === 'phrase')).toEqual({ t: 'phrase', seat: 1, key: 'ola' });
    expect(await cb.next((m) => m.t === 'phrase')).toEqual({ t: 'phrase', seat: 1, key: 'ola' });
    // A lobby has no game state.
    expect(ca.game).toBeNull();
    expect(cb.game).toBeNull();

    const va = watchWith(ca, 'person A');
    const vb = watchWith(cb, 'person B');
    ca.send({ t: 'start' });
    const ga = await ca.nextGame();
    const gb = await cb.nextGame();
    expect(ga.seq).toBe(gb.seq);
    expect(ga.obs.seat).toBe(0);
    expect(gb.obs.seat).toBe(1);
    expect(ga.deadline?.at ?? null).toBeNull();
    expect(new Set([...ga.obs.hand, ...gb.obs.hand]).size).toBe(6);

    // The one who is not on turn is refused and gets a fresh state.
    const turn = ga.deadline!.seat;
    const waiting = turn === 0 ? cb : ca;
    const waitingState = turn === 0 ? gb : ga;
    await sleep(300);
    waiting.send({ t: 'act', seq: waitingState.seq, a: 0 });
    expect((await waiting.nextError()).code).toBe('not_your_turn');
    expect((await waiting.nextGame()).seq).toBe(waitingState.seq);

    const [pa, pb] = await Promise.all([playToEnd(ca, { timeoutMs: 100_000 }), playToEnd(cb, { timeoutMs: 100_000 })]);
    expectFinished(pa, ca);
    expectFinished(pb, cb);
    expect(pa.final.seq).toBe(pb.final.seq);
    expect(pa.final.obs.score).toEqual(pb.final.obs.score);
    expect(va.problems).toEqual([]);
    expect(vb.problems).toEqual([]);
    expect(crossCheck(va, vb)).toEqual([]);
    expect(crossCheck(vb, va)).toEqual([]);

    // Rematch: same seats, a new match.
    await sleep(300);
    ca.send({ t: 'rematch' });
    const next = await cb.nextGame((g) => g.matchNo === pa.final.matchNo + 1);
    expect(next.obs.over).toBe(false);
    const room = await ca.nextRoom((r) => r.room.matchNo === pa.final.matchNo + 1);
    expect(room.room.status).toBe('playing');
    expect(room.room.seats.map((s) => s.kind)).toEqual(['human', 'human']);
    expect(va.problems).toEqual([]);
    expect(vb.problems).toEqual([]);
    ca.close();
    cb.close();
  }, 120_000);

  it('two partners in a 2 against 2 room: seats, AI opponents, and the partner\'s cards only in a mão de onze', async () => {
    const a = await new Device().verified();
    const b = await new Device().verified();
    const code = await a.createRoom({ players: 4, variant: 'paulista', turnSeconds: 60, opponents: ['lia', 'ravi'], partner: 'iara', options: { signals: 'secret' } });
    const ca = await a.connect(code);
    expect((await ca.nextRoom()).you).toBe(0);
    const cb = await b.connect(code);
    expect((await cb.nextRoom()).you).toBe(1);

    // B moves to the seat in front of A, to be A's partner.
    cb.send({ t: 'sit', seat: 2 });
    const moved = await cb.nextRoom((r) => r.you === 2);
    expect(moved.room.seats.map((s) => s.kind)).toEqual(['human', 'empty', 'human', 'empty']);
    await sleep(300);
    ca.send({ t: 'sit', seat: 2 });
    expect((await ca.nextError()).code).toBe('seat_taken');

    const va = watchWith(ca, 'partner A');
    const vb = watchWith(cb, 'partner B');
    await sleep(300);
    ca.send({ t: 'start' });
    await ca.nextGame();
    await cb.nextGame();
    const seats = ca.room!.room.seats;
    expect(seats.map((s) => s.kind)).toEqual(['human', 'ai', 'human', 'ai']);
    expect([seats[1].persona, seats[3].persona]).toEqual(['lia', 'ravi']);
    expect(seats[1].name.length).toBeGreaterThan(0);

    const [pa, pb] = await Promise.all([playToEnd(ca, { timeoutMs: 105_000 }), playToEnd(cb, { timeoutMs: 105_000 })]);
    expectFinished(pa, ca);
    expectFinished(pb, cb);
    expect(va.problems).toEqual([]);
    expect(vb.problems).toEqual([]);
    expect(crossCheck(va, vb, true)).toEqual([]);
    expect(crossCheck(vb, va, true)).toEqual([]);
    ca.close();
    cb.close();
  }, 120_000);

  it('the owner arranges a 2 against 2 room, plays, changes the table after the match and lets a late friend in (M15)', async () => {
    const a = await new Device().verified();
    const b = await new Device().verified();
    const c = await new Device().verified();
    const code = await a.createRoom({ players: 4, variant: 'paulista', turnSeconds: 60 });
    const ca = await a.connect(code);
    expect((await ca.nextRoom()).owner).toBe(true);
    const cb = await b.connect(code);
    expect((await cb.nextRoom()).you).toBe(1);
    const va = watchWith(ca, 'owner A');
    const vb = watchWith(cb, 'friend B');

    // A moves B to the seat in front (B's page learns it from the room message) and keeps Lia on seat 1.
    await sleep(300);
    ca.send({ t: 'move', from: 1, to: 2 });
    await cb.nextRoom((r) => r.you === 2);
    await sleep(300);
    ca.send({ t: 'plan', seat: 1, ai: 'lia' });
    const planned = await cb.nextRoom((r) => r.room.seats[1].kind === 'ai');
    expect(planned.room.seats.map((s) => [s.kind, s.persona])).toEqual([
      ['human', null],
      ['ai', 'lia'],
      ['human', null],
      ['empty', 'zap'],
    ]);

    await sleep(300);
    ca.send({ t: 'start' });
    await ca.nextGame();
    await cb.nextGame();
    expect(ca.room!.room.seats.map((s) => [s.kind, s.persona])).toEqual([
      ['human', null],
      ['ai', 'lia'],
      ['human', null],
      ['ai', 'zap'],
    ]);
    const [pa, pb] = await Promise.all([playToEnd(ca, { timeoutMs: 105_000 }), playToEnd(cb, { timeoutMs: 105_000 })]);
    expectFinished(pa, ca);
    expectFinished(pb, cb);

    // While the owner is here only the owner leads.
    await sleep(300);
    cb.send({ t: 'rematch' });
    expect((await cb.nextError()).code).toBe('not_owner');

    // "Mudar a mesa": back to the lobby; nobody gets a game message there, B keeps seat 2.
    await sleep(300);
    const mark = { a: ca.log.length, b: cb.log.length };
    ca.send({ t: 'lobby' });
    const back = await cb.nextRoom((r) => r.room.status === 'lobby');
    expect(back.you).toBe(2);
    expect(back.room.matchNo).toBe(pa.final.matchNo);
    expect(back.room.seats.map((s) => s.kind)).toEqual(['human', 'ai', 'human', 'ai']);
    await sleep(300);
    // A opens seat 3 (Zap stays planned there), and C, who arrives late, lands on it.
    ca.send({ t: 'plan', seat: 3, ai: null });
    const open = await cb.nextRoom((r) => r.room.seats[3].kind === 'empty');
    expect(open.room.seats[3].persona).toBe('zap');
    const cc = await c.connect(code);
    const rc = await cc.nextRoom();
    expect(rc.you).toBe(3);
    expect(rc.owner).toBe(false);
    const sinceLobby = [...ca.log.slice(mark.a), ...cb.log.slice(mark.b), ...cc.log].map((r) => r.msg);
    expect(sinceLobby.filter((m) => m.t === 'game')).toEqual([]);

    await sleep(300);
    ca.send({ t: 'start' });
    const next = pa.final.matchNo + 1;
    await cc.nextGame((g) => g.matchNo === next);
    const room = await ca.nextRoom((r) => r.room.matchNo === next);
    expect(room.room.status).toBe('playing');
    expect(room.room.seats.map((s) => s.kind)).toEqual(['human', 'ai', 'human', 'human']);
    expect(room.room.seats[1].persona).toBe('lia');
    expect((await cb.nextGame((g) => g.matchNo === next)).obs.seat).toBe(2);
    expect(va.problems).toEqual([]);
    expect(vb.problems).toEqual([]);
    for (const conn of [ca, cb, cc]) conn.close();
  }, 120_000);

  it('after a match, with the owner gone, a friend starts the next one and the AI plays the owner\'s seat (M15)', async () => {
    const a = await new Device().verified();
    const b = await new Device().verified();
    const code = await a.createRoom({ players: 2, variant: 'paulista', turnSeconds: 60 });
    const ca = await a.connect(code);
    await ca.nextRoom();
    const cb = await b.connect(code);
    expect((await cb.nextRoom()).you).toBe(1);
    await sleep(300);
    ca.send({ t: 'start' });
    await ca.nextGame();
    await cb.nextGame();
    const [pa, pb] = await Promise.all([playToEnd(ca, { timeoutMs: 105_000 }), playToEnd(cb, { timeoutMs: 105_000 })]);
    expectFinished(pa, ca);
    expectFinished(pb, cb);

    await sleep(300);
    ca.send({ t: 'lobby' });
    await cb.nextRoom((r) => r.room.status === 'lobby');
    ca.close();
    const away = await cb.nextRoom((r) => r.room.ownerAway === true);
    expect(away.room.seats[0]).toMatchObject({ kind: 'human', connected: false });
    await sleep(300);
    cb.send({ t: 'start' });
    const next = pa.final.matchNo + 1;
    // The room message comes before the game message of the same change.
    const room = await cb.nextRoom((r) => r.room.matchNo === next);
    expect(room.room.status).toBe('playing');
    expect(room.room.seats[0]).toMatchObject({ kind: 'human', aiPlaying: true });
    expect(room.room.ownerAway).toBe(true);
    const g = await cb.nextGame((x) => x.matchNo === next);
    expect(g.obs.over).toBe(false);
    cb.close();
  }, 120_000);
});
