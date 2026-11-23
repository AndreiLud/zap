// The Worker's own handler (worker/src/cf/index.ts) for a deletion and a recovery, with a stub
// room namespace that records every call: the calls still waiting for older ids of the person go
// out first, and only after they all answered do the calls for the device itself.
//
// The Durable Object class is replaced by a stub (it needs the Workers runtime), and the Worker
// module is imported by a computed path so that this Node project does not type check the
// Workers-only files (worker/tsconfig.json does).

import { describe, expect, it, vi } from 'vitest';
import { deviceCookieName, deviceIdFromSecret, newDeviceSecret } from '../src/auth.ts';
import { newRecoveryCode, normalizeRecoveryCode, recoveryHash } from '../src/privacy.ts';
import { testDb, type TestDb } from './sqlite-db.ts';

vi.mock('../src/cf/room.ts', () => ({ Room: class {} }));

interface Handler {
  fetch(request: Request, env: unknown): Promise<Response>;
}

const ORIGIN = 'http://localhost:8787';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function handler(): Promise<Handler> {
  const path = '../src/cf/index.ts';
  return ((await import(/* @vite-ignore */ path)) as { default: Handler }).default;
}

/** A room namespace whose stubs log each call's start and end; calls about older ids take a while. */
function rooms(slow: Set<string>) {
  const log: string[] = [];
  const ns = {
    idFromName: (code: string) => code,
    get: (code: string) => ({
      forget: async (device: string) => {
        log.push(`start forget ${code} ${device.slice(0, 4)}`);
        if (slow.has(device)) await sleep(30);
        log.push(`end forget ${code} ${device.slice(0, 4)}`);
      },
      rekey: async (from: string[], to: string) => {
        log.push(`start rekey ${code} ${from.map((d) => d.slice(0, 4)).join(',')}>${to.slice(0, 4)}`);
        if (from.some((d) => slow.has(d))) await sleep(30);
        log.push(`end rekey ${code}`);
      },
    }),
  };
  return { ns, log };
}

function env(db: TestDb, ns: unknown) {
  return {
    DB: db,
    ROOM: ns,
    TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
    TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
    TURNSTILE_HOSTNAMES: '',
    SESSION_SECRET: 'test-only-0123456789abcdef0123456789abcdef',
    PUBLIC_ORIGIN: ORIGIN,
  };
}

function post(path: string, body: unknown, cookie = ''): Request {
  const text = JSON.stringify(body);
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', 'content-length': String(text.length), ...(cookie ? { cookie } : {}) },
    body: text,
  });
}

/** Turnstile's siteverify answered locally: the test keys pass everyone. */
function passTurnstile(): void {
  vi.stubGlobal('fetch', async (url: string) => {
    if (!String(url).includes('challenges.cloudflare.com')) throw new Error(`unexpected fetch ${url}`);
    return new Response(JSON.stringify({ success: true }), { headers: { 'content-type': 'application/json' } });
  });
}

const hex = (c: string) => c.repeat(64);

function seed(db: TestDb, device: string, now: number): void {
  db.raw.prepare("INSERT INTO devices (id, created_at, pseudonym, adult_at, last_seen) VALUES (?, ?, ?, ?, ?)").run(device, now, 'f'.repeat(32), now, now);
  for (const code of ['AAAAA', 'BBBBB', 'CCCCC']) db.raw.prepare('INSERT INTO open_rooms (code, device, created_at, expires_at) VALUES (?, ?, ?, ?)').run(code, '', now, now + 86_400_000);
}

describe('Worker: calls for older ids go first', () => {
  it('/api/me/delete forgets the older ids in their rooms, waits, then forgets the device', async () => {
    passTurnstile();
    const db = testDb();
    const now = Date.now();
    const secret = newDeviceSecret();
    const device = await deviceIdFromSecret(secret);
    seed(db, device, now);
    // The device sits in AAAAA and BBBBB; a recovery to it still waits for CCCCC and AAAAA, which know older ids.
    for (const code of ['AAAAA', 'BBBBB']) db.raw.prepare('INSERT INTO room_members (code, device, expires_at) VALUES (?, ?, ?)').run(code, device, now + 86_400_000);
    db.raw.prepare('INSERT INTO room_calls (code, device, to_device, created_at) VALUES (?, ?, ?, ?)').run('CCCCC', hex('a'), device, now);
    db.raw.prepare('INSERT INTO room_calls (code, device, to_device, created_at) VALUES (?, ?, ?, ?)').run('AAAAA', hex('b'), device, now);
    const { ns, log } = rooms(new Set([hex('a'), hex('b')]));
    const res = await (await handler()).fetch(post('/api/me/delete', { token: 'x' }, `${deviceCookieName(false)}=${secret}`), env(db, ns));
    expect(res.status).toBe(200);
    const firstOwn = log.findIndex((l) => l.includes(device.slice(0, 4)));
    const lastOlder = log.map((l) => l.includes('aaaa') || l.includes('bbbb')).lastIndexOf(true);
    expect(log.filter((l) => l.startsWith('start'))).toHaveLength(4);
    expect(lastOlder).toBeGreaterThan(-1);
    expect(firstOwn).toBeGreaterThan(lastOlder);
    expect(log[lastOlder]).toMatch(/^end forget/);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM devices').get()).toEqual({ n: 0 });
    vi.unstubAllGlobals();
  });

  it('/api/recover delivers the waiting recoveries of older ids first, then moves the recovered ids', async () => {
    passTurnstile();
    const db = testDb();
    const now = Date.now();
    const old = hex('c');
    seed(db, old, now);
    const code = newRecoveryCode();
    db.raw.prepare('UPDATE devices SET recovery_hash = ? WHERE id = ?').run(await recoveryHash(normalizeRecoveryCode(code)!), old);
    db.raw.prepare('INSERT INTO room_members (code, device, expires_at) VALUES (?, ?, ?)').run('AAAAA', old, now + 86_400_000);
    db.raw.prepare('INSERT INTO room_members (code, device, expires_at) VALUES (?, ?, ?)').run('BBBBB', old, now + 86_400_000);
    // An earlier recovery to the old id never reached CCCCC, which knows the person by an even older id.
    db.raw.prepare('INSERT INTO room_calls (code, device, to_device, created_at) VALUES (?, ?, ?, ?)').run('CCCCC', hex('d'), old, now);
    const { ns, log } = rooms(new Set([hex('d')]));
    const res = await (await handler()).fetch(post('/api/recover', { code, token: 'x', adult: true }), env(db, ns));
    expect(res.status).toBe(200);
    expect(log[0]).toMatch(/^start rekey CCCCC dddd>/);
    expect(log[1]).toBe('end rekey CCCCC');
    expect(log.slice(2).filter((l) => l.startsWith('start')).map((l) => l.split(' ')[2]).sort()).toEqual(['AAAAA', 'BBBBB']);
    // The waiting call went through and left the queue.
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM room_calls').get()).toEqual({ n: 0 });
    vi.unstubAllGlobals();
  });
});
