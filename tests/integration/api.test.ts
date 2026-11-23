// The Worker's HTTP API as a black box: config, the human check, the device credential, origin
// checks, room creation limits and room info. Needs a running site: BASE=http://dev:8787.

import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { CODE_PATTERN } from '../../shared/protocol.ts';
import { BASE, DUMMY_TOKEN, Device, FOREIGN_ORIGIN, ORIGIN, randomCode, sleep } from './helpers.ts';

const DEVICE_MAX_AGE = 400 * 24 * 3600;

/**
 * The local rate limiter counts in fixed windows of one wall-clock minute: wait for a fresh one
 * when the current window has less than this left, so a test's burst falls in one window.
 */
async function freshMinute(needMs = 20_000): Promise<void> {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < needMs) await sleep(left + 250);
}

/** Cookie attributes, lower-cased names, from one Set-Cookie line. */
function cookieAttrs(line: string): { name: string; value: string; attrs: Map<string, string> } {
  const [kv, ...rest] = line.split(';').map((p) => p.trim());
  const i = kv.indexOf('=');
  const attrs = new Map<string, string>();
  for (const a of rest) {
    const j = a.indexOf('=');
    attrs.set((j < 0 ? a : a.slice(0, j)).toLowerCase(), j < 0 ? '' : a.slice(j + 1));
  }
  return { name: kv.slice(0, i), value: kv.slice(i + 1), attrs };
}

const NO_PREFS = { openDataOptOut: false, noAdapt: false };
/** /api/me for a device that has no row, or no cookie at all. */
const NOBODY = { adult: false, nickname: null, nicknameHidden: false, prefs: NO_PREFS };

/** A device cookie that was never checked: any 22-character secret is a valid device. */
function bareDevice(): Device {
  const d = new Device();
  d.jar.set('zap_device', Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url'));
  return d;
}

/**
 * A request that names another host (the Host header) over plain http. wrangler dev builds the
 * Worker's request URL from that header, as Cloudflare does for a custom domain.
 */
function asHost(host: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown; setCookies: string[] }> {
  const u = new URL(BASE);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: u.hostname,
        port: u.port || 80,
        path,
        method,
        headers: {
          host,
          origin: `http://${host}`,
          ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => {
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, setCookies: [res.headers['set-cookie'] ?? []].flat() });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

describe.skipIf(!BASE)('HTTP API', () => {
  it('the API answers a public host only over https: plain http gets no human check and no cookie', async () => {
    for (const host of ['zap.andreiludescher.com', 'zap.example.workers.dev']) {
      for (const [method, path, body] of [
        ['POST', '/api/session', { token: DUMMY_TOKEN, adult: true }],
        ['POST', '/api/recover', { code: 'ABCDE FGHJK MNPQR STUVW', token: DUMMY_TOKEN, adult: true }],
        ['GET', '/api/config', undefined],
        ['GET', '/api/me', undefined],
      ] as const) {
        const r = await asHost(host, method, path, body);
        expect(r.status, `${host} ${method} ${path}`).toBe(403);
        expect(r.body).toEqual({ error: 'https_required' });
        expect(r.setCookies).toEqual([]);
      }
    }
    // Local development keeps plain http (this suite runs on it).
    expect((await asHost(new URL(BASE).host, 'GET', '/api/config')).status).toBe(200);
  });


  it('GET /api/config returns the public settings and no cookie', async () => {
    const d = new Device();
    const r = await d.get('/api/config', { origin: null });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^application\/json/);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    expect(Object.keys(r.body).sort()).toEqual(['ads', 'adsEnabled', 'hold', 'privacyContact', 'turnstileSiteKey']);
    expect(typeof r.body.turnstileSiteKey).toBe('string');
    expect(r.body.turnstileSiteKey.length).toBeGreaterThan(0);
    expect(typeof r.body.adsEnabled).toBe('boolean');
    // Ads are off on the local site (CLIENT-SPEC 16.2); rooms hold the quick play clock (16.5).
    expect(r.body.ads).toBeNull();
    expect(r.body.adsEnabled).toBe(false);
    expect(r.body.hold).toBe(true);
    expect(r.setCookies).toEqual([]);
  });

  it('the static pages carry the same security headers as the API', async () => {
    for (const path of ['/', '/privacidade', '/en/you']) {
      const r = await new Device().get(path, { origin: null });
      expect(r.status, path).toBe(200);
      expect(r.headers.get('strict-transport-security'), path).toBe('max-age=31536000; includeSubDomains');
      expect(r.headers.get('x-frame-options'), path).toBe('DENY');
      expect(r.headers.get('x-content-type-options'), path).toBe('nosniff');
    }
  });

  it('/api/me before the check, after it, and without the credential', async () => {
    const d = new Device();
    let me = await d.get('/api/me', { origin: null });
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ device: false, verified: false, verifiedUntil: null, ...NOBODY });
    expect(me.setCookies).toEqual([]);

    const t0 = Date.now();
    const s = await d.verify();
    expect(s.status).toBe(200);
    // The credential lasts 2 hours (a few minutes of clock difference are allowed).
    expect(s.body.verifiedUntil).toBeGreaterThan(t0 + 2 * 3600_000 - 300_000);
    expect(s.body.verifiedUntil).toBeLessThan(t0 + 2 * 3600_000 + 300_000);

    me = await d.get('/api/me');
    expect(me.body).toEqual({ device: true, verified: true, verifiedUntil: s.body.verifiedUntil, adult: true, nickname: null, nicknameHidden: false, prefs: NO_PREFS });

    d.jar.delete('zap_cred');
    me = await d.get('/api/me');
    expect(me.body).toEqual({ device: true, verified: false, verifiedUntil: null, adult: true, nickname: null, nicknameHidden: false, prefs: NO_PREFS });
  });

  it('/api/session refuses a missing, empty or oversized token and sets no cookie', async () => {
    const d = new Device();
    for (const body of [{ adult: true }, { token: '', adult: true }, { token: null, adult: true }, { token: 'x'.repeat(3000), adult: true }]) {
      const r = await d.post('/api/session', body);
      expect(r.status, JSON.stringify(body).slice(0, 40)).toBe(403);
      expect(r.body).toEqual({ error: 'check_failed' });
      expect(r.setCookies).toEqual([]);
    }
    // Without a readable body there is no age declaration either.
    const junk = await d.request('POST', '/api/session', { rawBody: 'not json' });
    expect(junk.status).toBe(400);
    expect(junk.body).toEqual({ error: 'age_required' });
    expect(junk.setCookies).toEqual([]);
    expect((await d.get('/api/me')).body.device).toBe(false);
  });

  it('/api/session sets HttpOnly, SameSite and Path on both cookies, and keeps the device on a new check', async () => {
    const d = new Device();
    const s = await d.verify(DUMMY_TOKEN);
    expect(s.status).toBe(200);
    const cookies = s.setCookies.map(cookieAttrs);
    const device = cookies.find((c) => c.name === 'zap_device');
    const cred = cookies.find((c) => c.name === 'zap_cred');
    expect(device, 'zap_device cookie').toBeDefined();
    expect(cred, 'zap_cred cookie').toBeDefined();
    for (const c of [device!, cred!]) {
      expect(c.attrs.has('httponly'), `${c.name} HttpOnly`).toBe(true);
      expect(['lax', 'strict'], `${c.name} SameSite`).toContain(c.attrs.get('samesite')?.toLowerCase());
      expect(c.attrs.get('path'), `${c.name} Path`).toBe('/');
      expect(c.attrs.has('domain'), `${c.name} Domain`).toBe(false);
      if (BASE.startsWith('https:')) expect(c.attrs.has('secure'), `${c.name} Secure`).toBe(true);
    }
    expect(device!.value).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Number(device!.attrs.get('max-age'))).toBe(DEVICE_MAX_AGE);
    expect(Number(cred!.attrs.get('max-age'))).toBe(2 * 3600);
    // The credential is signed, not the device secret, and it does not carry the device id either:
    // it names the device by a keyed hash.
    expect(cred!.value).not.toContain(device!.value);
    const payload = JSON.parse(Buffer.from(cred!.value.split('.')[0], 'base64url').toString('utf8'));
    expect(Object.keys(payload).sort()).toEqual(['d', 'e', 'v']);
    expect(payload.d).toMatch(/^[0-9a-f]{32}$/);
    expect(d.id).not.toContain(payload.d);

    // A second check keeps the same device, renews the credential and sets the same device cookie
    // again for its full lifetime, so a person who keeps playing never loses it.
    const again = await d.verify();
    expect(again.status).toBe(200);
    const renewed = again.setCookies.map(cookieAttrs);
    expect(renewed.map((c) => c.name).sort()).toEqual(['zap_cred', 'zap_device']);
    const sameDevice = renewed.find((c) => c.name === 'zap_device')!;
    expect(sameDevice.value).toBe(device!.value);
    expect(Number(sameDevice.attrs.get('max-age'))).toBe(DEVICE_MAX_AGE);
    expect(sameDevice.attrs.has('httponly')).toBe(true);
    expect(d.jar.get('zap_device')).toBe(device!.value);
    expect((await d.get('/api/me')).body.verified).toBe(true);
  });

  it('refuses POST requests without Origin or from another origin', async () => {
    // Not tested here: the same host with the other scheme. wrangler dev's proxy rewrites any URL
    // with its own host in request headers to its inner origin, scheme included.
    const bad = [null, FOREIGN_ORIGIN, 'null', `${ORIGIN}.evil.example`, 'http://localhost:1', `${FOREIGN_ORIGIN}:8787`];
    const fresh = new Device();
    for (const origin of bad) {
      const r = await fresh.post('/api/session', { token: DUMMY_TOKEN, adult: true }, { origin });
      expect(r.status, `session, origin ${origin}`).toBe(403);
      expect(r.body).toEqual({ error: 'bad_origin' });
      expect(r.setCookies).toEqual([]);
    }

    const d = await new Device().verified();
    for (const origin of bad) {
      for (const path of ['/api/play', '/api/rooms']) {
        const r = await d.post(path, {}, { origin });
        expect(r.status, `${path}, origin ${origin}`).toBe(403);
        expect(r.body).toEqual({ error: 'bad_origin' });
      }
    }
    // Reading needs no Origin, and the refused calls changed nothing.
    const me = await d.get('/api/me', { origin: null });
    expect(me.status).toBe(200);
    expect(me.body.verified).toBe(true);
    expect((await d.post('/api/rooms', {})).status).toBe(200);
  });

  it('/api/play and /api/rooms need the human check', async () => {
    const nobody = new Device();
    for (const path of ['/api/play', '/api/rooms']) {
      const r = await nobody.post(path, {});
      expect(r.status, `${path} without cookies`).toBe(401);
      expect(r.body).toEqual({ error: 'check_needed' });
      expect(r.setCookies).toEqual([]);
    }
    const unchecked = bareDevice();
    for (const path of ['/api/play', '/api/rooms']) {
      const r = await unchecked.post(path, {});
      expect(r.status, `${path} with a device but no check`).toBe(401);
      expect(r.body).toEqual({ error: 'check_needed' });
    }
    const d = await new Device().verified();
    const play = await d.post('/api/play', {});
    expect(play.status).toBe(200);
    expect(play.body.code).toMatch(CODE_PATTERN);
    const room = await d.post('/api/rooms', {});
    expect(room.status).toBe(200);
    expect(room.body.code).toMatch(CODE_PATTERN);
    expect(room.body.code).not.toBe(play.body.code);
  });

  it('a credential works only on the device it was issued to, and a tampered one is refused', async () => {
    const a = await new Device().verified();
    const b = await new Device().verified();
    const credA = a.jar.get('zap_cred')!;

    const mixed = new Device();
    mixed.jar.set('zap_device', b.jar.get('zap_device')!);
    mixed.jar.set('zap_cred', credA);
    expect((await mixed.get('/api/me')).body).toMatchObject({ device: true, verified: false, verifiedUntil: null });
    expect((await mixed.post('/api/play', {})).status).toBe(401);

    const dot = credA.indexOf('.');
    for (const at of [3, dot + 6]) {
      const forged = new Device();
      forged.jar.set('zap_device', a.jar.get('zap_device')!);
      const ch = credA[at] === 'A' ? 'B' : 'A';
      forged.jar.set('zap_cred', credA.slice(0, at) + ch + credA.slice(at + 1));
      expect((await forged.get('/api/me')).body.verified, `changed char ${at}`).toBe(false);
      expect((await forged.post('/api/play', {})).status, `changed char ${at}`).toBe(401);
    }
    // The genuine pair still works.
    expect((await a.post('/api/play', {})).status).toBe(200);
  });

  it('refuses bad room settings without counting a match', async () => {
    const d = await new Device().verified();
    const cases: [string, Record<string, unknown>][] = [
      ['/api/play', { players: 3 }],
      ['/api/play', { players: '4' }],
      ['/api/play', { variant: 'gaucho' }],
      ['/api/play', { turnSeconds: null }],
      ['/api/play', { turnSeconds: 45 }],
      ['/api/play', { opponents: ['nobody'] }],
      ['/api/play', { opponents: [] }],
      ['/api/play', { opponents: ['zap', 'lia', 'bento'] }],
      ['/api/play', { partner: 'nobody' }],
      ['/api/play', { options: { bestOf: 5 } }],
      ['/api/play', { options: { signals: 'loud' } }],
      ['/api/rooms', { players: 5 }],
      ['/api/rooms', { turnSeconds: 0 }],
    ];
    for (const [path, body] of cases) {
      const r = await d.post(path, body);
      expect(r.status, `${path} ${JSON.stringify(body)}`).toBe(400);
      expect(r.body).toEqual({ error: 'bad_settings' });
    }
    // No limit is allowed only in rooms with people.
    const room = await d.post('/api/rooms', { players: 2, turnSeconds: null });
    expect(room.status).toBe(200);
    const info = await d.get(`/api/rooms/${room.body.code}`);
    expect(info.body.settings).toMatchObject({ mode: 'room', players: 2, turnSeconds: null });
    // If the 13 refusals had counted, these would reach the limit of 10 matches per check.
    for (let i = 0; i < 8; i++) expect((await d.post('/api/play', { players: 2 })).status, `play ${i + 2}`).toBe(200);
  });

  it('the room keeps its listing ahead of its own expiry, so its code keeps working while it is in use', async () => {
    const d = await new Device().verified();
    const code = await d.createRoom({ players: 2 });
    const listed = async () => ((await d.get('/api/me/data')).body.openRooms as { code: string; expiresAt: number }[]).find((r) => r.code === code)!.expiresAt;
    const first = await listed();
    expect(first).toBeGreaterThan(Date.now() + 23.9 * 3600_000);
    // Any use after the creation moves the room's expiry, and the listing is written an hour ahead of it.
    const t0 = Date.now();
    const other = await new Device().verified();
    const c = await other.connect(code);
    await c.nextRoom();
    await expect.poll(listed, { timeout: 5_000 }).toBeGreaterThanOrEqual(t0 + 25 * 3600_000);
    c.close();
  });

  it('allows at most 3 open rooms per device', async () => {
    const d = await new Device().verified();
    const codes = [await d.createRoom(), await d.createRoom({ players: 2 }), await d.createRoom({ variant: 'mineiro' })];
    expect(new Set(codes).size).toBe(3);
    const fourth = await d.post('/api/rooms', {});
    expect(fourth.status).toBe(429);
    expect(fourth.body).toEqual({ error: 'too_many_rooms' });
    // Quick play is not an open room.
    expect((await d.post('/api/play', {})).status).toBe(200);
    // Another device is not affected.
    const other = await new Device().verified();
    expect((await other.post('/api/rooms', {})).status).toBe(200);
  });

  it('asks for a new check after 10 matches, and the device can still return to its rooms', async () => {
    const d = await new Device().verified();
    const codes: string[] = [];
    for (let i = 0; i < 10; i++) codes.push(await d.play({ players: 2 }));
    expect(new Set(codes).size).toBe(10);

    for (const path of ['/api/play', '/api/rooms']) {
      const r = await d.post(path, {});
      expect(r.status, `${path} after 10 matches`).toBe(401);
      expect(r.body).toEqual({ error: 'check_needed' });
    }
    const me = await d.get('/api/me');
    expect(me.body.device).toBe(true);
    expect(me.body.verified).toBe(false);

    // Going back to a room it already sits in needs only the credential.
    const conn = await d.connect(codes[0]);
    const room = await conn.nextRoom();
    expect(room.you).toBe(0);
    conn.close();

    // A new check gives 10 more matches.
    expect((await d.verify()).status).toBe(200);
    expect((await d.get('/api/me')).body.verified).toBe(true);
    expect((await d.post('/api/play', {})).status).toBe(200);
  });

  it('a socket opened before the allowance ran out cannot start one more match, and a start counts once', async () => {
    const d = await new Device().verified();
    const code = await d.createRoom({ players: 2, turnSeconds: 15 });
    const c = await d.connect(code);
    await c.nextRoom();
    // The socket opened with 10 matches left; quick play then spends all of them.
    for (let i = 0; i < 10; i++) await d.play({ players: 2 });
    c.send({ t: 'start' });
    expect((await c.nextError()).code).toBe('check_needed');
    expect((await d.get(`/api/rooms/${code}`)).body.status).toBe('lobby');
    // After a new check the same socket starts the match. It takes one match, once: 9 are left.
    expect((await d.verify()).status).toBe(200);
    await sleep(300);
    c.send({ t: 'start' });
    expect((await c.nextGame()).matchNo).toBe(1);
    for (let i = 0; i < 9; i++) expect((await d.post('/api/play', { players: 2 })).status, `play ${i + 1} after the start`).toBe(200);
    expect((await d.post('/api/play', { players: 2 })).status).toBe(401);
    c.close();
  });

  it('limits /api/me per device once it holds a credential, and per IP without one', async () => {
    const d = await new Device().verified();
    await freshMinute();
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await d.get('/api/me')).status);
    expect(statuses.slice(0, 60)).toEqual(Array(60).fill(200));
    expect(statuses[60]).toBe(429);
    expect((await d.get('/api/me')).body).toEqual({ error: 'too_many' });
    // Without a credential, a new device cookie each time (free to make) still counts for the same IP.
    const sameIp = { headers: { 'cf-connecting-ip': bareDevice().ip } };
    await freshMinute();
    const bare: number[] = [];
    for (let i = 0; i < 61; i++) bare.push((await bareDevice().get('/api/me', sameIp)).status);
    expect(bare.slice(0, 60)).toEqual(Array(60).fill(200));
    expect(bare[60]).toBe(429);
    // A visit with no device cookie reads nothing from D1 and is not counted; another IP is not affected.
    expect((await new Device().get('/api/me', sameIp)).body).toMatchObject({ device: false });
    expect((await bareDevice().get('/api/me')).status).toBe(200);
  });

  it('/api/rooms/CODE returns public room info, and 404 for unknown or malformed codes', async () => {
    const d = await new Device().verified();
    const solo = await d.play({ players: 4, variant: 'paulista' });
    const r = await d.get(`/api/rooms/${solo}`, { origin: null });
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(/[0-9a-f]{64}/i);
    const info = r.body;
    expect(info.code).toBe(solo);
    expect(info.status).toBe('playing');
    expect(info.settings.mode).toBe('solo');
    expect(info.matchNo).toBe(1);
    expect(info.seats).toHaveLength(4);
    expect(info.seats[0]).toMatchObject({ seat: 0, kind: 'human', verified: true, persona: null, aiPlaying: false });
    for (const s of info.seats.slice(1)) {
      expect(s.kind).toBe('ai');
      expect(typeof s.persona).toBe('string');
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.verified).toBe(false);
    }
    // Shown to the hour only, so it does not follow each move.
    expect(info.expiresAt % 3600_000).toBe(0);
    expect(info.expiresAt).toBeGreaterThan(Date.now() + 22 * 3600_000);
    expect(info.expiresAt).toBeLessThanOrEqual(Date.now() + 24 * 3600_000);
    expect(typeof info.aiVersion).toBe('string');

    // Codes are case-insensitive.
    const lower = await d.get(`/api/rooms/${solo.toLowerCase()}`);
    expect(lower.status).toBe(200);
    expect(lower.body.code).toBe(solo);

    const lobby = await d.createRoom({ players: 2 });
    const li = (await d.get(`/api/rooms/${lobby}`)).body;
    expect(li.status).toBe('lobby');
    expect(li.settings.mode).toBe('room');
    expect(li.seats.map((s: { kind: string }) => s.kind)).toEqual(['human', 'empty']);

    // Looking at a room needs the human check (so scripts cannot wake rooms for free).
    const stranger = bareDevice();
    expect((await stranger.get(`/api/rooms/${lobby}`)).status).toBe(401);
    const checked = await new Device().verified();
    const seen = await checked.get(`/api/rooms/${lobby}`);
    expect(seen.status).toBe(200);
    expect(seen.body.code).toBe(lobby);

    const unknown = await d.get(`/api/rooms/${randomCode()}`);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: 'not_found' });
    for (const bad of ['AAAA0', 'IIIII', 'OOOOO', 'LLLL2', 'ABCD', 'ABCDEF', 'AB%21CD', 'AB%2FCD']) {
      const res = await d.get(`/api/rooms/${bad}`);
      expect(res.status, bad).toBe(404);
      expect(res.body, bad).toEqual({ error: 'not_found' });
    }
  });

  it('unknown API routes and methods answer 404', async () => {
    const d = await new Device().verified();
    for (const [method, path] of [
      ['GET', '/api/nope'],
      ['GET', '/api/play'],
      ['GET', '/api/session'],
      ['POST', '/api/me'],
      ['DELETE', '/api/rooms'],
    ] as const) {
      const r = await d.request(method, path);
      expect(r.status, `${method} ${path}`).toBe(404);
    }
  });

  it('limits the human check per IP: the 11th try in a minute answers 429', async () => {
    const d = new Device();
    await freshMinute();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await d.post('/api/session', { adult: true })).status);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(403));
    expect(statuses[10]).toBe(429);
    const last = await d.post('/api/session', { token: DUMMY_TOKEN, adult: true });
    expect(last.status).toBe(429);
    expect(last.body).toEqual({ error: 'too_many' });
    expect(last.setCookies).toEqual([]);
    // Another IP is not affected.
    expect((await new Device().verify()).status).toBe(200);
  });
});
