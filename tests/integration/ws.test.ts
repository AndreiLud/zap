// The room WebSocket as a black box: who may connect, and how the room answers bad, stale,
// illegal, oversized and too many messages. Needs a running site: BASE=http://dev:8787.

import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_BYTES } from '../../shared/protocol.ts';
import { BASE, Conn, Device, FOREIGN_ORIGIN, ORIGIN, WS_BASE, legalActions, myTurn, randomCode, rawUpgrade, sleep, type GameMsg } from './helpers.ts';

/** Pause between messages, below the limit of 4 per second. */
const PACE = 300;

async function soloRoom(settings: Record<string, unknown> = { players: 2 }): Promise<{ d: Device; code: string; c: Conn; g: GameMsg }> {
  const d = await new Device().verified();
  const code = await d.play(settings);
  const c = await d.connect(code);
  const g = await c.nextGame((x) => myTurn(x, new Set()) !== null);
  return { d, code, c, g };
}

describe.skipIf(!BASE)('room WebSocket', () => {
  it('refuses a WebSocket without Origin or from another origin', async () => {
    const d = await new Device().verified();
    const code = await d.play({ players: 2 });
    // The same host with the other scheme is not tested: wrangler dev's proxy rewrites it to its own origin.
    for (const origin of [null, FOREIGN_ORIGIN, 'null', `${ORIGIN}.evil.example`, 'http://localhost:1']) {
      const r = await d.upgrade(code, origin);
      expect(r.status, `origin ${origin}`).toBe(403);
      expect(JSON.parse(r.body)).toEqual({ error: 'bad_origin' });
    }
    await expect(d.connect(code, FOREIGN_ORIGIN)).rejects.toThrow();
    // The same request from our own origin is accepted.
    const ok = await d.connect(code);
    expect((await ok.nextRoom()).you).toBe(0);
    ok.close();
  });

  it('refuses a WebSocket without a valid credential', async () => {
    const d = await new Device().verified();
    const code = await d.play({ players: 2 });

    const r1 = await rawUpgrade(`/api/rooms/${code}/ws`, { origin: ORIGIN });
    expect(r1.status, 'no cookies').toBe(401);
    expect(JSON.parse(r1.body)).toEqual({ error: 'check_needed' });

    // The device secret alone is not enough: the WebSocket takes only the credential.
    const deviceOnly = new Device();
    deviceOnly.jar.set('zap_device', d.jar.get('zap_device')!);
    const r2 = await deviceOnly.upgrade(code);
    expect(r2.status, 'device cookie only').toBe(401);
    expect(JSON.parse(r2.body)).toEqual({ error: 'check_needed' });

    const cred = d.jar.get('zap_cred')!;
    const forged = new Device();
    forged.jar.set('zap_device', d.jar.get('zap_device')!);
    forged.jar.set('zap_cred', cred.slice(0, 10) + (cred[10] === 'A' ? 'B' : 'A') + cred.slice(11));
    expect((await forged.upgrade(code)).status, 'tampered credential').toBe(401);

    const credOnly = new Device();
    credOnly.jar.set('zap_cred', cred);
    expect((await credOnly.upgrade(code)).status, 'credential without its device').toBe(401);

    await expect(Conn.open(`${WS_BASE}/api/rooms/${code}/ws`, { origin: ORIGIN })).rejects.toThrow();
  });

  it('answers 404 for a room that does not exist or a malformed code', async () => {
    const d = await new Device().verified();
    expect((await d.upgrade(randomCode())).status).toBe(404);
    for (const bad of ['AAAA0', 'ABCD', 'IIIII']) expect((await d.upgrade(bad)).status, bad).toBe(404);
  });

  it('a stranger cannot take a seat in a solo match in progress', async () => {
    const owner = await new Device().verified();
    const code = await owner.play({ players: 4 });
    const stranger = await new Device().verified();
    const r = await stranger.upgrade(code);
    expect(r.status).toBe(409);
    expect(r.body).toBe('room_full');
    const info = await owner.get(`/api/rooms/${code}`);
    expect(info.body.seats.filter((s: { kind: string }) => s.kind === 'human')).toHaveLength(1);
  });

  it('a stale seq gives an error and a fresh state, and the move with the right seq is accepted', async () => {
    const { c, g } = await soloRoom();
    const a = legalActions(g.obs.legal)[0];
    for (const seq of [g.seq - 1, g.seq + 1, 0]) {
      c.send({ t: 'act', seq, a });
      const e = await c.nextError();
      expect(e.code, `seq ${seq} against ${g.seq}`).toBe('stale');
      const room = await c.nextRoom();
      expect(room.you).toBe(0);
      const fresh = await c.nextGame();
      expect(fresh.seq).toBe(g.seq);
      expect(fresh.obs.hand).toEqual(g.obs.hand);
      expect(fresh.obs.legal).toBe(g.obs.legal);
      await sleep(PACE);
    }
    c.send({ t: 'act', seq: g.seq, a });
    const after = await c.nextGame();
    expect(after.seq).toBeGreaterThan(g.seq);
    // Sending the same move again is now stale: a move counts once.
    await sleep(PACE);
    c.send({ t: 'act', seq: g.seq, a });
    expect((await c.nextError()).code).toBe('stale');
    c.close();
  });

  it('hold stops the quick play clock and gives back the time that was left (CLIENT-SPEC 16.5)', async () => {
    const { c, g } = await soloRoom();
    expect(g.deadline?.at).not.toBeNull();
    c.send({ t: 'hold', on: true });
    const held = await c.nextGame();
    expect(held.seq).toBe(g.seq + 1);
    expect(held.deadline).toEqual({ seat: g.deadline!.seat, at: null });
    expect(held.events).toEqual([]);
    await sleep(1_200);
    c.send({ t: 'hold', on: false });
    const back = await c.nextGame();
    expect(back.seq).toBe(g.seq + 2);
    // The clock comes back with what was left when the hold began. Each message stamps `now` when
    // it is sent, after the room stored the change, so a few ms may pass after the hold read the
    // clock; the 1.2 s of the hold itself must not come off the time left.
    const leftBefore = g.deadline!.at! - held.now;
    const leftAfter = back.deadline!.at! - back.now;
    expect(Math.abs(leftAfter - leftBefore), `left ${leftBefore} ms before, ${leftAfter} ms after`).toBeLessThanOrEqual(10);
    await sleep(PACE);
    c.send({ t: 'act', seq: back.seq, a: legalActions(back.obs.legal)[0] });
    expect((await c.nextGame()).seq).toBeGreaterThan(back.seq);
    c.close();
  });

  it('refuses an illegal move and keeps the state', async () => {
    const { c, g } = await soloRoom();
    const illegal = [...Array(15).keys()].filter((a) => !(g.obs.legal & (1 << a)));
    expect(illegal.length).toBeGreaterThan(0);
    for (const a of illegal.slice(0, 3)) {
      c.send({ t: 'act', seq: g.seq, a });
      expect((await c.nextError()).code, `action ${a}`).toBe('illegal');
      await sleep(PACE);
    }
    c.send({ t: 'sync' });
    const now = await c.nextGame();
    expect(now.seq).toBe(g.seq);
    expect(now.obs.hand).toEqual(g.obs.hand);
    expect(now.obs.rounds).toEqual(g.obs.rounds);
    c.close();
  });

  it('answers bad_message to malformed JSON, unknown types and out-of-range fields, and stays open', async () => {
    const { c, g } = await soloRoom();
    const bad = [
      'not json',
      '{',
      '[]',
      'null',
      '42',
      '"act"',
      '{}',
      '{"t":"nope"}',
      '{"t":"act","seq":"1","a":0}',
      `{"t":"act","seq":${g.seq},"a":15}`,
      `{"t":"act","seq":${g.seq},"a":-1}`,
      `{"t":"act","seq":${g.seq},"a":0.5}`,
      '{"t":"act","seq":-1,"a":0}',
      '{"t":"sit","seat":9}',
      '{"t":"phrase","key":"palavrao"}',
      '{"t":"phrase"}',
      '{"t":"ACT","seq":1,"a":0}',
      // M15: the switches of a rematch are booleans; the arrangement messages are well formed
      // and, being for rooms with friends only, refused in quick play even when they are.
      '{"t":"rematch","randomOpponents":"yes"}',
      '{"t":"rematch","randomPartner":null}',
      '{"t":"move","from":1,"to":1}',
      '{"t":"move","from":0}',
      '{"t":"plan","seat":3,"ai":"Lia"}',
      '{"t":"plan","seat":3}',
      '{"t":"lobby"}',
      '{"t":"move","from":0,"to":1}',
      '{"t":"plan","seat":1,"ai":"lia"}',
    ];
    for (const raw of bad) {
      c.send(raw);
      const e = await c.nextError();
      expect(e.code, raw).toBe('bad_message');
      await sleep(PACE);
    }
    // Nothing changed, and the connection is still usable.
    c.send({ t: 'sync' });
    expect((await c.nextGame()).seq).toBe(g.seq);
    expect(c.closeInfo).toBeNull();
    c.close();
  });

  it('a message that changes nothing gets no answer', async () => {
    const { c, g } = await soloRoom();
    c.skip();
    // Taking back a seat the AI is not playing.
    c.send({ t: 'resume' });
    await sleep(800);
    expect(c.unread()).toEqual([]);
    c.send({ t: 'sync' });
    expect((await c.nextGame()).seq).toBe(g.seq);
    c.close();
  });

  it('answers keep-alive pings with a pong', async () => {
    const { c } = await soloRoom();
    c.skip();
    c.send('{"t":"ping"}');
    // The pong may come after state messages already on their way.
    let m = await c.next();
    for (let i = 0; i < 5 && (m as { t?: string }).t !== 'pong'; i++) m = await c.next();
    expect(m as unknown).toEqual({ t: 'pong' });
    c.close();
  });

  it('refuses lobby commands during a match', async () => {
    const { c } = await soloRoom({ players: 4 });
    const cases: [object, string][] = [
      [{ t: 'start' }, 'not_in_lobby'],
      [{ t: 'sit', seat: 1 }, 'not_in_lobby'],
      [{ t: 'rematch' }, 'not_ended'],
    ];
    for (const [msg, code] of cases) {
      c.send(JSON.stringify(msg));
      expect((await c.nextError()).code, JSON.stringify(msg)).toBe(code);
      await sleep(PACE);
    }
    c.close();
  });

  it('arranging a room with friends (M15): the owner only, in a lobby only; a free seat shows its planned character', async () => {
    const a = await new Device().verified();
    const b = await new Device().verified();
    const code = await a.createRoom({ players: 4, variant: 'paulista', turnSeconds: 60 });
    const ca = await a.connect(code);
    const cb = await b.connect(code);
    const rb = await cb.nextRoom((r) => r.you === 1);
    // The default plan: Iara, Lia and Zap; B now sits on Iara's seat, which shows no character.
    expect(rb.room).toMatchObject({ setup: 2, ownerAway: false });
    expect(rb.room.seats.map((s) => [s.kind, s.persona])).toEqual([
      ['human', null],
      ['human', null],
      ['empty', 'lia'],
      ['empty', 'zap'],
    ]);
    const friend: [object, string][] = [
      [{ t: 'move', from: 1, to: 2 }, 'not_owner'],
      [{ t: 'plan', seat: 3, ai: 'lia' }, 'not_owner'],
      [{ t: 'lobby' }, 'not_owner'],
    ];
    for (const [m, want] of friend) {
      cb.send(JSON.stringify(m));
      expect((await cb.nextError()).code, `friend ${JSON.stringify(m)}`).toBe(want);
      await sleep(PACE);
    }
    ca.send({ t: 'lobby' });
    expect((await ca.nextError()).code).toBe('not_ended');
    await sleep(PACE);
    ca.send({ t: 'start' });
    await ca.nextGame();
    await sleep(PACE);
    const playing: [object, string][] = [
      [{ t: 'move', from: 1, to: 2 }, 'not_in_lobby'],
      [{ t: 'plan', seat: 3, ai: 'lia' }, 'not_in_lobby'],
      [{ t: 'lobby' }, 'not_ended'],
    ];
    for (const [m, want] of playing) {
      ca.send(JSON.stringify(m));
      expect((await ca.nextError()).code, `owner during a match ${JSON.stringify(m)}`).toBe(want);
      await sleep(PACE);
    }
    ca.close();
    cb.close();
  });

  it('relays canned phrases, at most one every 5 seconds', async () => {
    const { c } = await soloRoom();
    c.send({ t: 'phrase', key: 'boa' });
    const p = await c.next((m) => m.t === 'phrase');
    expect(p).toEqual({ t: 'phrase', seat: 0, key: 'boa' });
    await sleep(PACE);
    c.send({ t: 'phrase', key: 'bom_jogo' });
    expect((await c.nextError()).code).toBe('too_fast');
    c.close();
  });

  it(`closes with 1009 a message over ${MAX_MESSAGE_BYTES} bytes, and accepts one of exactly ${MAX_MESSAGE_BYTES}`, async () => {
    const { c, g } = await soloRoom();
    const head = '{"t":"sync","pad":"';
    const exact = head + 'x'.repeat(MAX_MESSAGE_BYTES - head.length - 2) + '"}';
    expect(Buffer.byteLength(exact)).toBe(MAX_MESSAGE_BYTES);
    c.skip();
    c.send(exact);
    expect((await c.nextGame()).seq).toBe(g.seq);
    await sleep(PACE);
    c.send('x'.repeat(MAX_MESSAGE_BYTES + 1));
    const closed = await c.waitClose();
    expect(closed.code).toBe(1009);
  });

  it(`counts bytes, not characters: accented text over ${MAX_MESSAGE_BYTES} bytes also closes with 1009`, async () => {
    const { c } = await soloRoom();
    // 1100 characters, about 2200 bytes in UTF-8.
    const msg = '{"t":"sync","pad":"' + 'é'.repeat(1080) + '"}';
    expect(msg.length).toBeLessThan(MAX_MESSAGE_BYTES);
    expect(Buffer.byteLength(msg)).toBeGreaterThan(MAX_MESSAGE_BYTES);
    c.send(msg);
    const closed = await c.waitClose(5_000);
    expect(closed.code).toBe(1009);
  });

  it('closes with 1008 after more than 10 quick messages, and the next connection to that room answers 429', async () => {
    const { d, code, c } = await soloRoom();
    c.skip();
    // A burst of 10 is allowed.
    for (let i = 0; i < 10; i++) c.send({ t: 'sync' });
    for (let i = 0; i < 10; i++) await c.nextGame();
    expect(c.closeInfo).toBeNull();
    // More than the bucket holds closes the connection.
    for (let i = 0; i < 12; i++) c.send({ t: 'sync' });
    const closed = await c.waitClose();
    expect(closed.code).toBe(1008);
    const again = await d.upgrade(code);
    expect(again.status).toBe(429);
    await expect(d.connect(code)).rejects.toThrow();
    // Other devices may still connect to their own rooms.
    const other = await soloRoom();
    expect(other.c.closeInfo).toBeNull();
    other.c.close();
  });
});
