// Data and privacy routes as a black box: the age requirement, nicknames, preferences, the match
// record download, recovery on another browser, deletion (also inside the rooms the person is
// in), reports and the retention job.
// Needs a running site: BASE=http://dev:8787.

import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { CLOSE_FORGOTTEN, CLOSE_ROOM_CLOSED, CODE_ALPHABET } from '../../shared/protocol.ts';
import { validateMatchRecord, type MatchRecord } from '../../shared/match-record.ts';
import { BASE, DUMMY_TOKEN, Device, playToEnd, randomCode, sleep, trace } from './helpers.ts';

const UNKNOWN_MATCH = '00000000-0000-4000-8000-000000000000';
const RECOVERY = new RegExp(`^[${CODE_ALPHABET}]{5}( [${CODE_ALPHABET}]{5}){3}$`);

/** A device with no cookie that copies another one's cookies (the same browser, before a change). */
function copyOf(d: Device): Device {
  const c = new Device();
  for (const [k, v] of d.jar) c.jar.set(k, v);
  return c;
}

/** Waits until the finished match shows up in the device's data (the room writes it right after the end). */
async function waitForMatch(d: Device, min = 1): Promise<any> {
  const until = Date.now() + 15_000;
  for (;;) {
    const r = await d.get('/api/me/data');
    expect(r.status).toBe(200);
    if (r.body.matches.length >= min || Date.now() > until) return r.body;
    await sleep(300);
  }
}

/**
 * Fires the Cron Trigger on a local wrangler dev, which answers only to a localhost Host header.
 * Returns the status and body (a failing handler does not answer 200).
 */
function fireLocalCron(cron: string): Promise<{ status: number; body: string }> {
  const u = new URL(BASE);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: u.hostname, port: u.port || 80, path: `/cdn-cgi/local/scheduled?cron=${encodeURIComponent(cron)}`, headers: { host: `localhost:${u.port || 80}` } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** A recovery request as the site sends it: after the age gate, with a fresh human check. */
const recover = (d: Device, code: unknown, extra: Record<string, unknown> = {}) => d.post('/api/recover', { code, token: DUMMY_TOKEN, adult: true, ...extra });

/** Deletes a device's data and records what the storage scan must not find afterwards. */
async function deleteData(d: Device): Promise<void> {
  const pseudonym = (await d.get('/api/me/data')).body?.pseudonym ?? null;
  const id = d.id!;
  const r = await d.post('/api/me/delete', { token: DUMMY_TOKEN });
  expect(r.status).toBe(200);
  trace({ t: 'deleted', id, pseudonym });
}

/** Shared by the tests below, in order: one person plays a match, recovers it elsewhere, deletes it. */
const S: { player?: Device; code?: string; matchId?: string; pseudonym?: string; nickname?: string; fresh?: Device } = {};

describe.skipIf(!BASE)('data and privacy', () => {
  it('the human check needs the 18 or older declaration, and nothing is stored without it', async () => {
    const d = new Device();
    for (const body of [{ token: DUMMY_TOKEN }, { token: DUMMY_TOKEN, adult: 'yes' }, { token: DUMMY_TOKEN, adult: false }, { token: DUMMY_TOKEN, adult: 1 }, { token: DUMMY_TOKEN, year: 1990 }]) {
      const r = await d.post('/api/session', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body).toEqual({ error: 'age_required' });
      expect(r.setCookies).toEqual([]);
    }
    expect((await d.get('/api/me')).body).toMatchObject({ device: false, adult: false });
    const ok = await d.post('/api/session', { token: DUMMY_TOKEN, adult: true });
    expect(ok.status).toBe(200);
    expect((await d.get('/api/me')).body).toMatchObject({ device: true, verified: true, adult: true });
    // The declaration is the only thing about age the server keeps: a timestamp, no year.
    const data = await d.get('/api/me/data');
    expect(typeof data.body.device.adultAt).toBe('number');
    expect(data.text).not.toMatch(/birth|year|idade|nasc/i);
  });

  it('nicknames are filtered, normalized and cleared, and a refusal gives no detail', async () => {
    const d = await new Device().verified();
    const set = (nickname: unknown) => d.post('/api/me/nickname', { nickname });
    let r = await set('  Zé   da Silva ');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ nickname: 'Zé da Silva', nicknameHidden: false });
    expect((await d.get('/api/me')).body.nickname).toBe('Zé da Silva');
    for (const ok of ['王小明', 'Ñandú 77', 'Computador', 'Picafumo']) {
      r = await set(ok);
      expect(r.status, ok).toBe(200);
      expect(r.body.nickname).toBe(ok);
    }
    for (const bad of ['a', 'x'.repeat(21), 'ana_maria', '<b>oi</b>', 'puta', 'P U T A', 'Caralhooo', 'fuck', 'Jogador 2', 12, true, ['Ana'], { a: 1 }]) {
      r = await set(bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body).toEqual({ error: 'bad_nickname' });
    }
    expect((await d.post('/api/me/nickname', {})).status).toBe(400);
    expect((await d.get('/api/me')).body.nickname).toBe('Picafumo');
    r = await set(null);
    expect(r.status).toBe(200);
    expect((await d.get('/api/me')).body.nickname).toBeNull();
  });

  it('the two switches: out of the open data, and do not adapt to me', async () => {
    const d = await new Device().verified();
    expect((await d.get('/api/me')).body.prefs).toEqual({ openDataOptOut: false, noAdapt: false });
    let r = await d.post('/api/me/prefs', { openDataOptOut: true });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ prefs: { openDataOptOut: true, noAdapt: false } });
    r = await d.post('/api/me/prefs', { noAdapt: true, openDataOptOut: false });
    expect(r.body).toEqual({ prefs: { openDataOptOut: false, noAdapt: true } });
    expect((await d.get('/api/me')).body.prefs).toEqual({ openDataOptOut: false, noAdapt: true });
    for (const bad of [{}, { noAdapt: 'yes' }, { noAdapt: 1 }, { other: true }, { noAdapt: true, extra: false }, [true]]) {
      r = await d.post('/api/me/prefs', bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body).toEqual({ error: 'bad_prefs' });
    }
    expect((await d.get('/api/me/data')).body.device.prefs).toEqual({ openDataOptOut: false, noAdapt: true });
  });

  it('after a match, its player downloads the record, which holds no device id, pseudonym, nickname, IP or room code', async () => {
    const p = await new Device().verified();
    const nickname = 'Ximbica Sete';
    expect((await p.post('/api/me/nickname', { nickname })).status).toBe(200);
    trace({ t: 'nickname', value: nickname });
    const code = await p.play({ players: 2, opponents: ['zap'] });
    const conn = await p.connect(code);
    const room = await conn.nextRoom();
    expect(room.room.seats[0].name).toBe(nickname);
    const res = await playToEnd(conn, { paceMs: 300, timeoutMs: 110_000 });
    expect(res.final.obs.over).toBe(true);
    conn.close();

    const data = await waitForMatch(p);
    expect(data.matches).toHaveLength(1);
    const entry = data.matches[0];
    expect(Object.keys(entry).sort()).toEqual(['endedAt', 'kind', 'matchId', 'seat', 'startedAt', 'verified']);
    expect(entry).toMatchObject({ seat: 0, kind: 'solo1', verified: true });
    expect(entry.matchId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(entry.endedAt).toBeGreaterThanOrEqual(entry.startedAt);
    expect(data.pseudonym).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(data)).not.toContain(p.id!);

    const r = await p.get(`/api/me/matches/${entry.matchId}`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['record', 'yourSeat']);
    expect(r.body.yourSeat).toBe(0);
    const v = validateMatchRecord(r.body.record);
    expect(v.ok ? [] : v.errors).toEqual([]);
    const rec = r.body.record as MatchRecord;
    expect(rec.matchId).toBe(entry.matchId);
    expect(rec.kind).toBe('solo1');
    expect(rec.seats.map((s) => s.kind)).toEqual(['human', 'ai']);
    expect(rec.result.winner).toBe(res.final.obs.winner);
    // People's own moves carry their decision time; the AI's carry none.
    const mine = rec.moves.filter((_, i) => rec.log[i] >> 4 === 0 && !rec.moves[i].auto);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((m) => typeof m.ms === 'number' && m.winProb === null)).toBe(true);
    expect(rec.moves.filter((_, i) => rec.log[i] >> 4 === 1).every((m) => m.ms === null && !m.auto)).toBe(true);

    // Nothing in the record points to the person or the room.
    const text = JSON.stringify(rec);
    const secret = p.jar.get('zap_device')!;
    for (const [what, s] of [
      ['device id', p.id!],
      ['device secret', secret],
      ['pseudonym', data.pseudonym],
      ['nickname', nickname],
      ['nickname part', 'Ximbica'],
      ['IP', p.ip],
      ['credential', p.jar.get('zap_cred')!],
    ] as const) {
      expect(text.includes(s), what).toBe(false);
    }
    expect(text).not.toContain(`"${code}"`);
    if (/[A-Z]/.test(code)) expect(text).not.toContain(code);
    expect(text).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    // The only 64-hex string is the seed (a device id would be another one).
    expect(text.match(/[0-9a-f]{64}/g)).toEqual([rec.seed]);
    expect(text).not.toMatch(/device|pseudonym|nickname|cookie|"ip"|room|code/i);

    Object.assign(S, { player: p, code, matchId: entry.matchId, pseudonym: data.pseudonym, nickname });
  }, 140_000);

  it('a stranger, a device without the check, or a bad id cannot read the match', async () => {
    expect(S.matchId, 'needs the match from the previous test').toBeDefined();
    const stranger = await new Device().verified();
    let r = await stranger.get(`/api/me/matches/${S.matchId}`);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'not_found' });
    expect((await stranger.get('/api/me/data')).body.matches).toEqual([]);
    for (const id of [UNKNOWN_MATCH, S.matchId!.toUpperCase(), 'abc', '..%2F..%2Fx', `${S.matchId}x`]) {
      r = await stranger.get(`/api/me/matches/${id}`);
      expect(r.status, id).toBe(404);
    }
    const nobody = new Device();
    r = await nobody.get(`/api/me/matches/${S.matchId}`);
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'check_needed' });
    // The player's own credential on another device id does not open it either.
    const mixed = new Device();
    mixed.jar.set('zap_device', stranger.jar.get('zap_device')!);
    mixed.jar.set('zap_cred', S.player!.jar.get('zap_cred')!);
    expect((await mixed.get(`/api/me/matches/${S.matchId}`)).status).toBe(401);
  });

  it('a recovery code moves the history to a new browser, once; the old browser loses it', async () => {
    const p = S.player!;
    expect(p, 'needs the match from the earlier test').toBeDefined();
    const first = await p.post('/api/me/recovery');
    expect(first.status).toBe(200);
    expect(first.body.code).toMatch(RECOVERY);
    expect((await p.get('/api/me/data')).body.device.hasRecoveryCode).toBe(true);
    const second = await p.post('/api/me/recovery');
    expect(second.body.code).toMatch(RECOVERY);
    expect(second.body.code).not.toBe(first.body.code);
    // The code is never stored in the clear.
    expect((await p.get('/api/me/data')).text).not.toContain(second.body.code.replace(/ /g, ''));

    const fresh = new Device();
    // A new code replaces the old one.
    let r = await recover(fresh, first.body.code);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'bad_code' });
    // Without the 18 or older declaration, a fresh human check, or from another site, nothing
    // happens. (The declarations come from another address: recovery allows 10 tries a minute per address.)
    const elsewhere = new Device();
    for (const adult of [undefined, false, 'true', 1]) {
      r = await recover(elsewhere, second.body.code, { adult });
      expect(r.status, String(adult)).toBe(400);
      expect(r.body).toEqual({ error: 'age_required' });
      expect(r.setCookies).toEqual([]);
    }
    r = await recover(fresh, second.body.code, { token: undefined });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'check_failed' });
    r = await fresh.post('/api/recover', { code: second.body.code, token: DUMMY_TOKEN, adult: true }, { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'bad_origin' });
    for (const bad of ['', 'ABCDE', 'IIIII IIIII IIIII IIIII', 42]) {
      r = await recover(fresh, bad);
      expect(r.status, String(bad)).toBe(400);
    }
    expect(fresh.jar.size).toBe(0);

    const oldId = p.id!;
    // Typed in lower case without spaces, it still works.
    r = await recover(fresh, second.body.code.toLowerCase().replace(/ /g, ''));
    expect(r.status).toBe(200);
    expect(r.body.recovered).toBe(true);
    expect(r.body.verifiedUntil).toBeGreaterThan(Date.now());
    expect(fresh.id).toBeTruthy();
    expect(fresh.id).not.toBe(oldId);
    expect(fresh.jar.get('zap_cred')).toBeTruthy();
    // The new device cookie gets its full lifetime.
    const deviceCookie = r.setCookies.find((c) => c.startsWith('zap_device='))!;
    expect(deviceCookie).toMatch(/;\s*Max-Age=34560000(;|$)/i);
    expect(deviceCookie).toMatch(/;\s*HttpOnly/i);
    trace({ t: 'deleted', id: oldId, pseudonym: null });

    const me = await fresh.get('/api/me');
    expect(me.body).toMatchObject({ device: true, verified: true, adult: true, nickname: S.nickname });
    const data = await fresh.get('/api/me/data');
    expect(data.body.pseudonym).toBe(S.pseudonym);
    expect(data.body.matches.map((m: { matchId: string }) => m.matchId)).toEqual([S.matchId]);
    expect(data.body.device.hasRecoveryCode).toBe(false);
    const rec = await fresh.get(`/api/me/matches/${S.matchId}`);
    expect(rec.status).toBe(200);
    expect(rec.body.yourSeat).toBe(0);

    // The old browser's cookie points to nothing now.
    expect((await p.get('/api/me/data')).status).toBe(401);
    expect((await p.get(`/api/me/matches/${S.matchId}`)).status).toBe(404);
    expect((await p.get('/api/me')).body).toMatchObject({ device: true, verified: false, adult: false, nickname: null });

    // The code worked once.
    r = await recover(new Device(), second.body.code);
    expect(r.status).toBe(400);
    S.fresh = fresh;
  });

  it('deleting removes every link and expires both cookies', async () => {
    const d = S.fresh!;
    expect(d, 'needs the recovered browser from the previous test').toBeDefined();
    let r = await d.post('/api/me/delete', {});
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'check_failed' });
    r = await d.post('/api/me/delete', { token: DUMMY_TOKEN }, { origin: null });
    expect(r.status).toBe(403);
    expect((await d.get('/api/me/data')).status).toBe(200);

    const before = copyOf(d);
    const id = d.id!;
    r = await d.post('/api/me/delete', { token: DUMMY_TOKEN });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ deleted: true });
    trace({ t: 'deleted', id, pseudonym: S.pseudonym! });
    const expired = r.setCookies.filter((c) => /max-age=0/i.test(c)).map((c) => c.split('=')[0]);
    expect(expired.sort()).toEqual(['zap_cred', 'zap_device']);
    expect(d.jar.size).toBe(0);
    expect((await d.get('/api/me')).body).toMatchObject({ device: false });

    // A browser that kept the old cookies finds nothing: no data, no match, no nickname, no rooms.
    expect((await before.get('/api/me')).body).toMatchObject({ device: true, verified: false, adult: false, nickname: null });
    r = await before.get('/api/me/data');
    expect(r.status).toBe(401);
    expect((await before.get(`/api/me/matches/${S.matchId}`)).status).toBe(404);
    expect((await before.post('/api/me/nickname', { nickname: 'Volta' })).status).toBe(401);
    expect((await before.post('/api/me/recovery')).status).toBe(401);
    expect((await before.post('/api/play', {})).status).toBe(401);
    // The room the match was played in no longer opens for that browser.
    expect((await before.get(`/api/rooms/${S.code}`)).status).toBe(404);
    // Deleting again is harmless.
    expect((await before.post('/api/me/delete', { token: DUMMY_TOKEN })).body).toEqual({ deleted: true });

    // The same browser starts over as a new person with no history.
    await d.verified();
    expect(d.id).not.toBe(id);
    const fresh = await d.get('/api/me/data');
    expect(fresh.body.matches).toEqual([]);
    expect(fresh.body.pseudonym).not.toBe(S.pseudonym);
  });

  it('a browser that kept the cookie of a deleted or moved device starts over with a new id on its next check', async () => {
    // Deleted: the old cookie passes a new human check as a new device, never as the deleted one.
    const a = await new Device().verified();
    expect((await a.post('/api/me/nickname', { nickname: 'Volta Nunca' })).status).toBe(200);
    trace({ t: 'nickname', value: 'Volta Nunca' });
    const keptA = copyOf(a);
    const deletedId = a.id!;
    const deletedSecret = a.jar.get('zap_device')!;
    const deletedPseudonym = (await a.get('/api/me/data')).body.pseudonym as string;
    await deleteData(a);
    let r = await keptA.verify();
    expect(r.status).toBe(200);
    const newCookie = r.setCookies.find((c) => c.startsWith('zap_device='));
    expect(newCookie, 'a new device cookie').toBeDefined();
    expect(keptA.jar.get('zap_device')).not.toBe(deletedSecret);
    expect(keptA.id).not.toBe(deletedId);
    let data = (await keptA.get('/api/me/data')).body;
    expect(data.pseudonym).not.toBe(deletedPseudonym);
    expect(data.device.nickname).toBeNull();
    // Its next check keeps that new device.
    const renewed = keptA.id;
    expect((await keptA.verify()).status).toBe(200);
    expect(keptA.id).toBe(renewed);

    // Moved: after a recovery elsewhere, the old browser gets neither its former id nor the moved one.
    const p = await new Device().verified();
    const q = await new Device().verified();
    const game = await q.createRoom({ players: 2, turnSeconds: null });
    const cq = await q.connect(game);
    await cq.nextRoom();
    const cp = await p.connectRaw(game);
    await cp.waitFor((m) => m.t === 'room' && m.you === 1);
    await sleep(300);
    cq.send({ t: 'start' });
    await cq.nextGame();
    const rc = await p.post('/api/me/recovery');
    expect(rc.status).toBe(200);
    const formerId = p.id!;
    const formerSecret = p.jar.get('zap_device')!;
    const n = new Device();
    expect((await recover(n, rc.body.code)).status).toBe(200);
    trace({ t: 'deleted', id: formerId, pseudonym: null });
    expect((await cp.waitClose()).code).toBe(CLOSE_FORGOTTEN);
    r = await p.verify();
    expect(r.status).toBe(200);
    expect(p.jar.get('zap_device')).not.toBe(formerSecret);
    expect(p.id).not.toBe(formerId);
    expect(p.id).not.toBe(n.id);
    data = (await p.get('/api/me/data')).body;
    expect(data.pseudonym).not.toBe((await n.get('/api/me/data')).body.pseudonym);
    expect(data.joinedRooms).toEqual([]);
    // The person's seat stays with the new browser; the old one, now someone else, has no seat to take.
    expect((await p.upgrade(game)).status).toBe(409);
    const cn = await n.connect(game);
    expect(await cn.nextRoom()).toMatchObject({ you: 1 });
    for (const c of [cn, cq]) c.close();
  });

  it('a report hides a nickname at once and in later rooms; only people at the table can report', async () => {
    const a = await new Device().verified();
    const b = await new Device().verified();
    const c = await new Device().verified();
    const nickname = 'Tatu Bola';
    expect((await a.post('/api/me/nickname', { nickname })).status).toBe(200);
    const code = await a.createRoom({ players: 2, turnSeconds: null });
    const ca = await a.connect(code);
    await ca.nextRoom();
    const cb = await b.connect(code);
    const seen = await cb.nextRoom((m) => m.you === 1);
    expect(seen.room.seats.map((s) => s.name)).toEqual([nickname, '']);

    const report = (d: Device, body: Record<string, unknown>) => d.post('/api/report', body);
    let r = await report(c, { code, seat: 0, reason: 'nickname' });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'not_in_room' });
    for (const bad of [
      { code, seat: 1, reason: 'nickname' },
      { code, seat: 5, reason: 'nickname' },
      { code, seat: 0, reason: 'rude' },
      { code, seat: '0', reason: 'nickname' },
      { code: 'AB', seat: 0, reason: 'nickname' },
    ]) {
      r = await report(b, bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body).toEqual({ error: 'bad_report' });
    }
    r = await report(b, { code: randomCode(), seat: 0, reason: 'nickname' });
    expect(r.status).toBe(404);
    r = await report(b, { code, seat: 0, reason: 'nickname' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ reported: true });

    // Everyone at the table sees the default name at once.
    const after = await cb.nextRoom((m) => m.room.seats[0].name === '');
    expect(after.room.seats[0].kind).toBe('human');
    await ca.nextRoom((m) => m.room.seats[0].name === '');
    expect((await a.get('/api/me')).body).toMatchObject({ nickname, nicknameHidden: true });

    // In a new room the reported nickname stays hidden until it is reviewed.
    const code2 = await a.createRoom({ players: 2 });
    const ca2 = await a.connect(code2);
    expect((await ca2.nextRoom()).room.seats[0].name).toBe('');
    // Saving the same one keeps it hidden; a new one shows at once.
    expect((await a.post('/api/me/nickname', { nickname })).body).toEqual({ nickname, nicknameHidden: true });
    expect((await a.post('/api/me/nickname', { nickname: 'Outro Nome' })).body).toEqual({ nickname: 'Outro Nome', nicknameHidden: false });
    expect((await a.get('/api/me')).body).toMatchObject({ nickname: 'Outro Nome', nicknameHidden: false });
    const code3 = await a.createRoom({ players: 2 });
    const ca3 = await a.connect(code3);
    expect((await ca3.nextRoom()).room.seats[0].name).toBe('Outro Nome');
    ca3.close();

    // Each side sees its part: the reporter without the target, the reported person without the reporter.
    const made = (await b.get('/api/me/data')).body.reportsMade;
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ roomCode: code, seat: 0, reason: 'nickname', status: 'open', matchId: null });
    expect(Object.keys(made[0]).sort()).toEqual(['createdAt', 'matchId', 'reason', 'roomCode', 'seat', 'status']);
    // The reported person sees only the day of the report: an exact time could point to the reporter.
    const about = (await a.get('/api/me/data')).body.reportsAboutYou;
    expect(about).toEqual([{ createdAt: Math.floor(made[0].createdAt / 86_400_000) * 86_400_000, reason: 'nickname', status: 'open' }]);
    for (const conn of [ca, cb, ca2]) conn.close();
  });

  it('deleting reaches the rooms: a lobby seat empties, a seat in a match goes to the AI with no name, and the old cookies open nothing', async () => {
    const a = await new Device().verified();
    const b = await new Device().verified();
    expect((await b.post('/api/me/nickname', { nickname: 'Bia Delta' })).status).toBe(200);
    trace({ t: 'nickname', value: 'Bia Delta' });
    const lobby = await a.createRoom({ players: 2, turnSeconds: null });
    const la = await a.connect(lobby);
    await la.nextRoom();
    const lb = await b.connectRaw(lobby);
    await lb.waitFor((m) => m.t === 'room' && m.you === 1);
    await la.nextRoom((m) => m.room.seats[1].name === 'Bia Delta');
    const game = await a.createRoom({ players: 2, turnSeconds: 60 });
    const ga = await a.connect(game);
    await ga.nextRoom();
    const gb = await b.connectRaw(game);
    await gb.waitFor((m) => m.t === 'room' && m.you === 1);
    await sleep(300);
    ga.send({ t: 'start' });
    await ga.nextGame();
    await gb.waitFor((m) => m.t === 'game');
    const joined = (await b.get('/api/me/data')).body.joinedRooms as { code: string; expiresAt: number }[];
    expect(joined.map((r) => r.code).sort()).toEqual([lobby, game].sort());
    // Each membership outlasts its room (the room carries it along while it is used), so a deletion always finds the room.
    for (const r of joined) {
      expect(r.expiresAt, r.code).toBeGreaterThan((await a.get(`/api/rooms/${r.code}`)).body.expiresAt);
      expect(r.expiresAt, r.code).toBeGreaterThan(Date.now() + 24 * 3600_000);
    }

    const old = copyOf(b);
    await deleteData(b);
    // B's connections close for good, in both rooms.
    expect((await lb.waitClose()).code).toBe(CLOSE_FORGOTTEN);
    expect((await gb.waitClose()).code).toBe(CLOSE_FORGOTTEN);
    // In the lobby the seat is free again; in the match it stays a person's seat, with no name, played by the AI.
    await la.nextRoom((m) => m.room.seats[1].kind === 'empty');
    const seen = await ga.nextRoom((m) => m.room.seats[1].aiPlaying);
    expect(seen.room.seats[1]).toMatchObject({ kind: 'human', name: '', connected: false, aiPlaying: true, verified: false });
    // The old cookies (the credential is still validly signed) open no room.
    for (const code of [lobby, game]) expect((await old.upgrade(code)).status, code).toBe(401);
    // The match goes on with the AI in B's seat and ends; A's own record shows A's seat only.
    const res = await playToEnd(ga, { paceMs: 200, timeoutMs: 110_000 });
    expect(res.final.obs.over).toBe(true);
    const data = await waitForMatch(a);
    expect(data.matches.map((m: { seat: number }) => m.seat)).toEqual([0]);
    const rec = (await a.get(`/api/me/matches/${data.matches[0].matchId}`)).body.record as MatchRecord;
    expect(rec.seats.map((x) => x.kind)).toEqual(['human', 'human']);
    for (const c of [la, ga]) c.close();
  }, 140_000);

  it('when the owner deletes, a lobby closes for everyone and a room in play stays open for the others', async () => {
    const owner = await new Device().verified();
    const c = await new Device().verified();
    const lobby = await owner.createRoom({ players: 2 });
    const lo = await owner.connectRaw(lobby);
    await lo.waitFor((m) => m.t === 'room');
    const lc = await c.connectRaw(lobby);
    await lc.waitFor((m) => m.t === 'room' && m.you === 1);
    const game = await c.createRoom({ players: 2, turnSeconds: null });
    // The owner of the second room is C; the person who deletes sits in it and owns the lobby.
    const gc = await c.connect(game);
    await gc.nextRoom();
    const go = await owner.connectRaw(game);
    await go.waitFor((m) => m.t === 'room' && m.you === 1);
    await sleep(300);
    gc.send({ t: 'start' });
    await gc.nextGame();

    await deleteData(owner);
    expect((await lo.waitClose()).code).toBe(CLOSE_FORGOTTEN);
    expect((await lc.waitClose()).code).toBe(CLOSE_ROOM_CLOSED);
    expect((await go.waitClose()).code).toBe(CLOSE_FORGOTTEN);
    await gc.nextRoom((m) => m.room.seats[1].aiPlaying && m.room.seats[1].name === '');
    expect((await c.get(`/api/rooms/${lobby}`)).status).toBe(404);
    gc.close();
    expect((await c.get('/api/me/data')).body.openRooms.map((o: { code: string }) => o.code)).toEqual([game]);
  });

  it('when the owner of a room in play deletes, the room stays reachable for the others and counts for nobody', async () => {
    const owner = await new Device().verified();
    const c = await new Device().verified();
    const game = await owner.createRoom({ players: 2, turnSeconds: null });
    const go = await owner.connect(game);
    await go.nextRoom();
    const gc = await c.connect(game);
    await gc.nextRoom((m) => m.you === 1);
    await sleep(300);
    go.send({ t: 'start' });
    await gc.nextGame();
    expect((await owner.get('/api/me/data')).body.openRooms.map((o: { code: string }) => o.code)).toEqual([game]);

    await deleteData(owner);
    await gc.nextRoom((m) => m.room.seats[0].aiPlaying && m.room.seats[0].name === '');
    // C can still find the room, come back to it and report from it.
    expect((await c.get(`/api/rooms/${game}`)).status).toBe(200);
    gc.close();
    const again = await c.connect(game);
    expect(await again.nextRoom()).toMatchObject({ you: 1, owner: false });
    expect((await c.post('/api/report', { code: game, seat: 0, reason: 'other' })).status).toBe(200);
    expect((await c.get('/api/me/data')).body.openRooms).toEqual([]);
    for (const conn of [again, go]) conn.close();
  });

  it('a recovery takes the seats along: the old browser\'s connections close and its cookies open nothing; the new one sits where it sat', async () => {
    const p = await new Device().verified();
    const q = await new Device().verified();
    // A match P sits in, and a lobby P owns.
    const game = await q.createRoom({ players: 2, turnSeconds: null });
    const cq = await q.connect(game);
    await cq.nextRoom();
    const cp = await p.connectRaw(game);
    await cp.waitFor((m) => m.t === 'room' && m.you === 1);
    await sleep(300);
    cq.send({ t: 'start' });
    await cq.nextGame();
    const lobby = await p.createRoom({ players: 2 });
    const lp = await p.connectRaw(lobby);
    await lp.waitFor((m) => m.t === 'room' && m.you === 0);
    const rc = await p.post('/api/me/recovery');
    expect(rc.status).toBe(200);

    const n = new Device();
    const oldId = p.id!;
    const r = await recover(n, rc.body.code);
    expect(r.status).toBe(200);
    trace({ t: 'deleted', id: oldId, pseudonym: null });
    expect((await cp.waitClose()).code).toBe(CLOSE_FORGOTTEN);
    expect((await lp.waitClose()).code).toBe(CLOSE_FORGOTTEN);
    for (const code of [game, lobby]) expect((await p.upgrade(code)).status, code).toBe(401);
    // The new browser takes P's seat back in the match, and P's lobby, as its owner.
    const cn = await n.connect(game);
    expect(await cn.nextRoom()).toMatchObject({ you: 1, owner: false });
    await cq.nextRoom((m) => m.room.seats[1].connected && !m.room.seats[1].aiPlaying);
    const ln = await n.connect(lobby);
    expect(await ln.nextRoom()).toMatchObject({ you: 0, owner: true });
    const data = (await n.get('/api/me/data')).body;
    expect(data.openRooms.map((o: { code: string }) => o.code)).toEqual([lobby]);
    expect(data.joinedRooms.map((o: { code: string }) => o.code).sort()).toEqual([game, lobby].sort());
    for (const c of [cn, cq, ln]) c.close();
  });

  it('new routes need the human check and, for changes, our own origin', async () => {
    const nobody = new Device();
    for (const [method, path] of [
      ['GET', '/api/me/data'],
      ['GET', `/api/me/matches/${UNKNOWN_MATCH}`],
      ['POST', '/api/me/nickname'],
      ['POST', '/api/me/prefs'],
      ['POST', '/api/me/recovery'],
      ['POST', '/api/me/delete'],
      ['POST', '/api/report'],
    ] as const) {
      const r = await nobody.request(method, path, method === 'POST' ? { body: {} } : {});
      expect(r.status, `${method} ${path}`).toBe(401);
      expect(r.body).toEqual({ error: 'check_needed' });
    }
    const d = await new Device().verified();
    for (const path of ['/api/me/nickname', '/api/me/prefs', '/api/me/recovery', '/api/me/delete', '/api/recover', '/api/report']) {
      for (const origin of [null, 'https://evil.example']) {
        const r = await d.post(path, { nickname: 'Ana', noAdapt: true, token: DUMMY_TOKEN, adult: true }, { origin });
        expect(r.status, `${path} from ${origin}`).toBe(403);
        expect(r.body).toEqual({ error: 'bad_origin' });
      }
    }
    // Nothing changed.
    expect((await d.get('/api/me')).body).toMatchObject({ device: true, verified: true, nickname: null, prefs: { noAdapt: false } });
  });

  it('the daily retention job runs and keeps recent data', async () => {
    const d = await new Device().verified();
    expect((await d.post('/api/me/nickname', { nickname: 'Recente' })).status).toBe(200);
    // wrangler dev exposes the Cron Trigger at this address; a deployed Worker does not.
    const res = await fireLocalCron('0 4 * * *');
    if (res.status === 404) return;
    expect(res).toEqual({ status: 200, body: 'ok' });
    expect((await d.get('/api/me')).body).toMatchObject({ verified: true, nickname: 'Recente' });
  });
});
